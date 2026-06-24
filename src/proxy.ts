import type { CacheEntry } from "./cache.js";
import type { Channel } from "./stream-utils.js";

const M3U8_CONTENT_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl"
]);

const ALLOWED_PROXY_HOSTS = new Set([
  "live-s.881903.com",
  "live2-s.881903.com"
]);

const buildProxyUrl = (requestUrl: string, channel: Channel, targetUrl: string) => {
  const url = new URL(`/proxy/${channel}`, requestUrl);
  url.searchParams.set("url", targetUrl);
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
  channel: Channel
) => {
  return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
    const targetUrl = new URL(uri, baseUrl).toString();
    return `URI="${buildProxyUrl(requestUrl, channel, targetUrl)}"`;
  });
};

const rewritePlaylist = (body: string, baseUrl: string, requestUrl: string, channel: Channel) => {
  return body.split("\n").map((line) => {
    const targetUrl = resolvePlaylistUrl(line, baseUrl);
    if (targetUrl) {
      return buildProxyUrl(requestUrl, channel, targetUrl);
    }
    return rewriteUriAttributes(line, baseUrl, requestUrl, channel);
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

export const getInitialProxyUrl = (requestUrl: string, channel: Channel, entry: CacheEntry) => {
  return buildProxyUrl(requestUrl, channel, entry.url);
};

export const proxyStreamResource = async (
  request: Request,
  channel: Channel,
  entry: CacheEntry,
  targetUrl: string
) => {
  const parsedTargetUrl = new URL(targetUrl);
  if (!ALLOWED_PROXY_HOSTS.has(parsedTargetUrl.hostname)) {
    return new Response("Forbidden", { status: 403 });
  }

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
    const rewritten = rewritePlaylist(body, response.url || targetUrl, request.url, channel);
    return new Response(rewritten, {
      headers: buildProxyHeaders("application/vnd.apple.mpegurl; charset=utf-8")
    });
  }

  return new Response(response.body, {
    headers: buildProxyHeaders(contentType)
  });
};
