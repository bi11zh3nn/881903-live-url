import { refreshStreamUrlCached, type CacheEntry } from "./cache.js";
import type { Channel } from "./stream-utils.js";

const M3U8_CONTENT_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl"
]);

type ResourceKind = "playlist" | "segment" | "key";
type PlaylistRole = "master" | "media";

type ResourceEntry = {
  channel: Channel;
  url: string;
  expiresAtMs: number;
  kind: ResourceKind;
  playlistRole?: PlaylistRole;
};

type ResourceTokenOptions = {
  kind: ResourceKind;
  playlistRole?: PlaylistRole;
};

type RewriteTarget = ResourceTokenOptions & {
  fallbackExtension: string;
};

type FetchResult = {
  response: Response;
  contentType: string;
  resolvedUrl: string;
  durationMs: number;
};

const getEnvNumber = (name: string, fallback: number) => {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const RESOURCE_TTL_MS = getEnvNumber("HLS_RESOURCE_TTL_MS", 30 * 60 * 1000);
const RESOURCE_PRUNE_INTERVAL_MS = getEnvNumber("HLS_RESOURCE_PRUNE_INTERVAL_MS", 5 * 60 * 1000);
const MAX_HLS_RESOURCES = getEnvNumber("MAX_HLS_RESOURCES", 1000);
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

const resourceCache = new Map<string, ResourceEntry>();
const urlTokens = new Map<string, string>();
let lastResourcePruneAtMs = 0;

const shouldDebug = () => LOG_LEVEL === "debug";

const logInfo = (message: string, details: Record<string, unknown> = {}) => {
  console.log(`[proxy] ${message}`, JSON.stringify(details));
};

const logDebug = (message: string, details: Record<string, unknown> = {}) => {
  if (shouldDebug()) {
    logInfo(message, details);
  }
};

const redactUrl = (targetUrl: string) => {
  const url = new URL(targetUrl);
  return `${url.origin}${url.pathname}`;
};

const buildTokenKey = (channel: Channel, targetUrl: string, options: ResourceTokenOptions) => {
  return `${channel}\n${options.kind}\n${options.playlistRole ?? ""}\n${targetUrl}`;
};

const getResourceExpiresAtMs = () => Date.now() + RESOURCE_TTL_MS;

const pruneExpiredResources = () => {
  const now = Date.now();
  if (now - lastResourcePruneAtMs < RESOURCE_PRUNE_INTERVAL_MS) {
    return;
  }

  lastResourcePruneAtMs = now;
  let pruned = 0;
  for (const [token, resource] of resourceCache) {
    if (resource.expiresAtMs > now) {
      continue;
    }
    resourceCache.delete(token);
    urlTokens.delete(buildTokenKey(resource.channel, resource.url, resource));
    pruned += 1;
  }

  if (pruned > 0) {
    logInfo("resource-pruned", {
      pruned,
      resources: resourceCache.size,
      urlTokens: urlTokens.size
    });
  }
};

const pruneResourceOverflow = () => {
  if (resourceCache.size <= MAX_HLS_RESOURCES) {
    return;
  }

  const targetSize = Math.floor(MAX_HLS_RESOURCES * 0.8);
  const resources = [...resourceCache.entries()].sort(([, a], [, b]) => {
    return a.expiresAtMs - b.expiresAtMs;
  });
  let pruned = 0;

  for (const [token, resource] of resources) {
    if (resourceCache.size <= targetSize) {
      break;
    }
    resourceCache.delete(token);
    urlTokens.delete(buildTokenKey(resource.channel, resource.url, resource));
    pruned += 1;
  }

  logInfo("resource-pruned-overflow", {
    pruned,
    resources: resourceCache.size,
    urlTokens: urlTokens.size,
    maxResources: MAX_HLS_RESOURCES
  });
};

const createResourceToken = (
  channel: Channel,
  targetUrl: string,
  options: ResourceTokenOptions
) => {
  pruneExpiredResources();

  const key = buildTokenKey(channel, targetUrl, options);
  const existing = urlTokens.get(key);
  if (existing) {
    const existingEntry = resourceCache.get(existing);
    if (existingEntry && existingEntry.expiresAtMs > Date.now()) {
      existingEntry.expiresAtMs = getResourceExpiresAtMs();
      return existing;
    }
    urlTokens.delete(key);
  }

  const token = crypto.randomUUID();
  resourceCache.set(token, {
    channel,
    url: targetUrl,
    expiresAtMs: getResourceExpiresAtMs(),
    kind: options.kind,
    playlistRole: options.playlistRole
  });
  urlTokens.set(key, token);
  pruneResourceOverflow();
  logDebug("resource-token-created", {
    channel,
    token,
    kind: options.kind,
    playlistRole: options.playlistRole,
    target: redactUrl(targetUrl)
  });
  return token;
};

const updateResourceUrl = (token: string, resource: ResourceEntry, targetUrl: string) => {
  if (resource.url === targetUrl) {
    return;
  }

  urlTokens.delete(buildTokenKey(resource.channel, resource.url, resource));
  resource.url = targetUrl;
  resource.expiresAtMs = getResourceExpiresAtMs();
  urlTokens.set(buildTokenKey(resource.channel, targetUrl, resource), token);
};

const getLastPathSegment = (targetUrl: string) => {
  return new URL(targetUrl).pathname.split("/").filter(Boolean).pop() ?? "";
};

const getPathExtension = (targetUrl: string) => {
  const pathname = new URL(targetUrl).pathname;
  const lastSegment = pathname.split("/").pop() ?? "";
  const match = lastSegment.match(/\.([A-Za-z0-9]+)$/);
  return match ? `.${match[1]}` : "";
};

const getProxyExtension = (targetUrl: string, fallbackExtension: string) => {
  return getPathExtension(targetUrl) || fallbackExtension;
};

const buildProxyUrl = (
  requestUrl: string,
  channel: Channel,
  targetUrl: string,
  target: RewriteTarget
) => {
  const token = createResourceToken(channel, targetUrl, target);
  const url = new URL(`/hls/${channel}/${token}${getProxyExtension(targetUrl, target.fallbackExtension)}`, requestUrl);
  return url.toString();
};

const resolvePlaylistUrl = (line: string, baseUrl: string) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  return new URL(trimmed, baseUrl).toString();
};

const rewriteUriAttributes = (
  line: string,
  baseUrl: string,
  requestUrl: string,
  channel: Channel,
  target: RewriteTarget
) => {
  return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
    const targetUrl = new URL(uri, baseUrl).toString();
    return `URI="${buildProxyUrl(requestUrl, channel, targetUrl, target)}"`;
  });
};

const getAttributeRewriteTarget = (line: string): RewriteTarget => {
  const trimmed = line.trim();
  if (trimmed.startsWith("#EXT-X-KEY")) {
    return { kind: "key", fallbackExtension: ".key" };
  }
  if (trimmed.startsWith("#EXT-X-MAP")) {
    return { kind: "segment", fallbackExtension: ".mp4" };
  }
  return { kind: "playlist", playlistRole: "media", fallbackExtension: ".m3u8" };
};

const rewritePlaylist = (
  body: string,
  baseUrl: string,
  requestUrl: string,
  channel: Channel
) => {
  let nextTarget: RewriteTarget = {
    kind: "playlist",
    playlistRole: "media",
    fallbackExtension: ".m3u8"
  };

  return body.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      nextTarget = { kind: "playlist", playlistRole: "media", fallbackExtension: ".m3u8" };
      return rewriteUriAttributes(line, baseUrl, requestUrl, channel, getAttributeRewriteTarget(line));
    }
    if (trimmed.startsWith("#EXTINF")) {
      nextTarget = { kind: "segment", fallbackExtension: ".aac" };
      return rewriteUriAttributes(line, baseUrl, requestUrl, channel, getAttributeRewriteTarget(line));
    }

    const targetUrl = resolvePlaylistUrl(line, baseUrl);
    if (targetUrl) {
      const rewritten = buildProxyUrl(
        requestUrl,
        channel,
        targetUrl,
        nextTarget
      );
      nextTarget = { kind: "playlist", playlistRole: "media", fallbackExtension: ".m3u8" };
      return rewritten;
    }
    return rewriteUriAttributes(line, baseUrl, requestUrl, channel, getAttributeRewriteTarget(line));
  }).join("\n");
};

const getPlaylistUris = (body: string, baseUrl: string) => {
  return body.split("\n").flatMap((line) => {
    const targetUrl = resolvePlaylistUrl(line, baseUrl);
    return targetUrl ? [targetUrl] : [];
  });
};

const isMediaPlaylist = (body: string) => {
  return body.split("\n").some((line) => line.trim().startsWith("#EXTINF"));
};

const fetchUpstream = async (entry: CacheEntry, targetUrl: string): Promise<FetchResult> => {
  const startedAtMs = Date.now();
  const response = await fetch(targetUrl, {
    headers: buildRemoteHeaders(entry),
    redirect: "follow"
  });
  const resolvedUrl = response.url || targetUrl;

  return {
    response,
    contentType: getContentType(response, resolvedUrl),
    resolvedUrl,
    durationMs: Date.now() - startedAtMs
  };
};

const fetchTextOk = async (entry: CacheEntry, targetUrl: string) => {
  const result = await fetchUpstream(entry, targetUrl);
  if (!result.response.ok) {
    const body = await result.response.text();
    throw new Error(`Upstream ${result.response.status} for ${redactUrl(targetUrl)}: ${body.slice(0, 120)}`);
  }

  return {
    body: await result.response.text(),
    resolvedUrl: result.resolvedUrl
  };
};

const resolveCurrentMediaPlaylistUrl = async (entry: CacheEntry) => {
  const master = await fetchTextOk(entry, entry.url);
  if (isMediaPlaylist(master.body)) {
    return master.resolvedUrl;
  }

  return getPlaylistUris(master.body, master.resolvedUrl)[0] ?? null;
};

const resolveLatestSegmentUrl = async (entry: CacheEntry, previousSegmentUrl: string) => {
  const mediaPlaylistUrl = await resolveCurrentMediaPlaylistUrl(entry);
  if (!mediaPlaylistUrl) {
    return null;
  }

  const media = await fetchTextOk(entry, mediaPlaylistUrl);
  const segmentUrls = getPlaylistUris(media.body, media.resolvedUrl).filter((url) => {
    return !new URL(url).pathname.endsWith(".m3u8");
  });

  if (!segmentUrls.length) {
    return null;
  }

  const previousName = getLastPathSegment(previousSegmentUrl);
  const exactMatch = segmentUrls.find((url) => getLastPathSegment(url) === previousName);
  return exactMatch ?? segmentUrls[segmentUrls.length - 1];
};

const getContentType = (response: Response, targetUrl: string) => {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType) {
    return contentType;
  }
  return new URL(targetUrl).pathname.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : "application/octet-stream";
};

const isPlaylistResponse = (response: Response, targetUrl: string) => {
  const contentType = getContentType(response, targetUrl).split(";")[0].trim().toLowerCase();
  return M3U8_CONTENT_TYPES.has(contentType) || new URL(targetUrl).pathname.endsWith(".m3u8");
};

const buildRemoteHeaders = (entry: CacheEntry) => {
  const headers: Record<string, string> = {
    Referer: entry.referer,
    "User-Agent": entry.userAgent
  };

  if (entry.cookieHeader) {
    headers.Cookie = entry.cookieHeader;
  }

  return headers;
};

const buildProxyHeaders = (contentType: string) => {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  };
};

export const getLiveUrl = (requestUrl: string, channel: Channel) => {
  return new URL(`/live/${channel}`, requestUrl).toString();
};

const getResource = (channel: Channel, token: string) => {
  pruneExpiredResources();

  const resource = resourceCache.get(token);
  if (!resource || resource.channel !== channel) {
    return null;
  }

  if (resource.expiresAtMs <= Date.now()) {
    resourceCache.delete(token);
    urlTokens.delete(buildTokenKey(resource.channel, resource.url, resource));
    logInfo("resource-token-expired", { channel, token, target: redactUrl(resource.url) });
    return null;
  }

  resource.expiresAtMs = getResourceExpiresAtMs();
  return resource;
};

const retryWithRetargetedMediaPlaylist = async (
  request: Request,
  token: string,
  resource: ResourceEntry
) => {
  const refreshed = await refreshStreamUrlCached(resource.channel);
  const currentMediaPlaylistUrl = await resolveCurrentMediaPlaylistUrl(refreshed);
  if (!currentMediaPlaylistUrl) {
    return null;
  }

  const previousUrl = resource.url;
  updateResourceUrl(token, resource, currentMediaPlaylistUrl);
  logInfo("playlist-token-retargeted", {
    channel: resource.channel,
    from: redactUrl(previousUrl),
    to: redactUrl(currentMediaPlaylistUrl)
  });

  return proxyStreamResource(request, resource.channel, refreshed, resource.url, {
    resource,
    token,
    retryPlaylistRefresh: false,
    retrySegmentRefresh: false
  });
};

const retryWithLatestSegment = async (
  request: Request,
  token: string,
  resource: ResourceEntry
) => {
  const refreshed = await refreshStreamUrlCached(resource.channel);
  const latestSegmentUrl = await resolveLatestSegmentUrl(refreshed, resource.url);
  if (!latestSegmentUrl) {
    return null;
  }

  const previousUrl = resource.url;
  updateResourceUrl(token, resource, latestSegmentUrl);
  logInfo("segment-token-retargeted", {
    channel: resource.channel,
    from: redactUrl(previousUrl),
    to: redactUrl(latestSegmentUrl)
  });

  return proxyStreamResource(request, resource.channel, refreshed, resource.url, {
    resource,
    token,
    retryPlaylistRefresh: false,
    retrySegmentRefresh: false
  });
};

export const proxyStreamResource = async (
  request: Request,
  channel: Channel,
  entry: CacheEntry,
  targetUrl: string,
  options: {
    retryPlaylistRefresh?: boolean;
    retrySegmentRefresh?: boolean;
    resource?: ResourceEntry;
    token?: string;
  } = {}
): Promise<Response> => {
  logDebug("upstream-fetch-start", { channel, target: redactUrl(targetUrl) });

  const { response, contentType, resolvedUrl, durationMs } = await fetchUpstream(entry, targetUrl);

  if (!response.ok) {
    const body = await response.text();
    if (
      options.retryPlaylistRefresh &&
      response.status === 403 &&
      isPlaylistResponse(response, resolvedUrl)
    ) {
      logInfo("playlist-refresh-retry", {
        channel,
        status: response.status,
        target: redactUrl(targetUrl)
      });

      if (
        options.resource?.kind === "playlist" &&
        options.resource.playlistRole === "media" &&
        options.token
      ) {
        const retargeted = await retryWithRetargetedMediaPlaylist(request, options.token, options.resource);
        if (retargeted) {
          return retargeted;
        }
      }

      const refreshed = await refreshStreamUrlCached(channel);
      return proxyStreamResource(request, channel, refreshed, refreshed.url, {
        retryPlaylistRefresh: false
      });
    }

    if (
      options.retrySegmentRefresh &&
      response.status === 403 &&
      options.resource?.kind === "segment" &&
      options.token
    ) {
      const retargeted = await retryWithLatestSegment(request, options.token, options.resource);
      if (retargeted) {
        return retargeted;
      }
    }

    logInfo("upstream-fetch-failed", {
      channel,
      status: response.status,
      target: redactUrl(targetUrl),
      durationMs
    });
    return new Response(body, {
      status: response.status,
      headers: buildProxyHeaders(contentType)
    });
  }

  if (isPlaylistResponse(response, resolvedUrl)) {
    const body = await response.text();
    const rewritten = rewritePlaylist(
      body,
      resolvedUrl,
      request.url,
      channel
    );
    logDebug("playlist-rewritten", {
      channel,
      target: redactUrl(resolvedUrl),
      durationMs
    });
    return new Response(rewritten, {
      headers: buildProxyHeaders("application/vnd.apple.mpegurl; charset=utf-8")
    });
  }

  logDebug("segment-proxied", {
    channel,
    contentType,
    target: redactUrl(resolvedUrl),
    durationMs
  });
  return new Response(response.body, {
    headers: buildProxyHeaders(contentType)
  });
};

export const proxyLivePlaylist = async (request: Request, channel: Channel, entry: CacheEntry) => {
  return proxyStreamResource(request, channel, entry, entry.url, { retryPlaylistRefresh: true });
};

export const proxyTokenResource = async (
  request: Request,
  channel: Channel,
  entry: CacheEntry,
  token: string
) => {
  const resource = getResource(channel, token);
  if (!resource) {
    logInfo("resource-token-missing", { channel, token });
    return new Response(`Stream resource expired. Refresh /live/${channel}.`, {
      status: 410,
      headers: buildProxyHeaders("text/plain; charset=utf-8")
    });
  }

  return proxyStreamResource(request, channel, entry, resource.url, {
    resource,
    token,
    retryPlaylistRefresh: resource.kind === "playlist",
    retrySegmentRefresh: resource.kind === "segment"
  });
};
