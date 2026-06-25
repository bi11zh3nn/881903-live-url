import type { CacheEntry } from "./cache.js";
import type { Channel } from "./stream-utils.js";

const M3U8_CONTENT_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl"
]);

type ResourceEntry = {
  channel: Channel;
  url: string;
  expiresAtMs: number;
};

const resourceCache = new Map<string, ResourceEntry>();
const urlTokens = new Map<string, string>();

const buildTokenKey = (channel: Channel, targetUrl: string) => `${channel}\n${targetUrl}`;

const createResourceToken = (channel: Channel, targetUrl: string, expiresAtMs: number) => {
  const key = buildTokenKey(channel, targetUrl);
  const existing = urlTokens.get(key);
  if (existing) {
    const existingEntry = resourceCache.get(existing);
    if (existingEntry && existingEntry.expiresAtMs > Date.now()) {
      existingEntry.expiresAtMs = Math.max(existingEntry.expiresAtMs, expiresAtMs);
      return existing;
    }
  }

  const token = crypto.randomUUID();
  resourceCache.set(token, { channel, url: targetUrl, expiresAtMs });
  urlTokens.set(key, token);
  return token;
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
  expiresAtMs: number,
  fallbackExtension: string
) => {
  const token = createResourceToken(channel, targetUrl, expiresAtMs);
  const url = new URL(`/hls/${channel}/${token}${getProxyExtension(targetUrl, fallbackExtension)}`, requestUrl);
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
  expiresAtMs: number
) => {
  return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
    const targetUrl = new URL(uri, baseUrl).toString();
    return `URI="${buildProxyUrl(requestUrl, channel, targetUrl, expiresAtMs, ".key")}"`;
  });
};

const rewritePlaylist = (
  body: string,
  baseUrl: string,
  requestUrl: string,
  channel: Channel,
  expiresAtMs: number
) => {
  let nextResourceExtension = ".m3u8";

  return body.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      nextResourceExtension = ".m3u8";
      return rewriteUriAttributes(line, baseUrl, requestUrl, channel, expiresAtMs);
    }
    if (trimmed.startsWith("#EXTINF")) {
      nextResourceExtension = ".aac";
      return rewriteUriAttributes(line, baseUrl, requestUrl, channel, expiresAtMs);
    }

    const targetUrl = resolvePlaylistUrl(line, baseUrl);
    if (targetUrl) {
      const rewritten = buildProxyUrl(
        requestUrl,
        channel,
        targetUrl,
        expiresAtMs,
        nextResourceExtension
      );
      nextResourceExtension = ".m3u8";
      return rewritten;
    }
    return rewriteUriAttributes(line, baseUrl, requestUrl, channel, expiresAtMs);
  }).join("\n");
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
  const resource = resourceCache.get(token);
  if (!resource || resource.channel !== channel) {
    return null;
  }

  if (resource.expiresAtMs <= Date.now()) {
    resourceCache.delete(token);
    urlTokens.delete(buildTokenKey(resource.channel, resource.url));
    return null;
  }

  return resource;
};

export const proxyStreamResource = async (
  request: Request,
  channel: Channel,
  entry: CacheEntry,
  targetUrl: string
) => {
  const response = await fetch(targetUrl, {
    headers: buildRemoteHeaders(entry),
    redirect: "follow"
  });

  const contentType = getContentType(response, response.url || targetUrl);
  if (!response.ok) {
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: buildProxyHeaders(contentType)
    });
  }

  if (isPlaylistResponse(response, response.url || targetUrl)) {
    const body = await response.text();
    const rewritten = rewritePlaylist(
      body,
      response.url || targetUrl,
      request.url,
      channel,
      entry.expiresAtMs
    );
    return new Response(rewritten, {
      headers: buildProxyHeaders("application/vnd.apple.mpegurl; charset=utf-8")
    });
  }

  return new Response(response.body, {
    headers: buildProxyHeaders(contentType)
  });
};

export const proxyLivePlaylist = async (request: Request, channel: Channel, entry: CacheEntry) => {
  return proxyStreamResource(request, channel, entry, entry.url);
};

export const proxyTokenResource = async (
  request: Request,
  channel: Channel,
  entry: CacheEntry,
  token: string
) => {
  const resource = getResource(channel, token);
  if (!resource) {
    return new Response(`Stream resource expired. Refresh /live/${channel}.`, {
      status: 410,
      headers: buildProxyHeaders("text/plain; charset=utf-8")
    });
  }

  return proxyStreamResource(request, channel, entry, resource.url);
};
