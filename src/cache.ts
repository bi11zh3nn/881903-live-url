import type { Channel } from "./stream-utils.js";
import { fetchStreamUrl, type StreamFetchResult } from "./stream-service.js";

const getEnvNumber = (name: string, fallback: number) => {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const CACHE_TTL_MS = getEnvNumber("STREAM_CACHE_TTL_MS", 10 * 60 * 1000);
const STREAM_FETCH_TIMEOUT_MS = getEnvNumber("STREAM_FETCH_TIMEOUT_MS", 25 * 1000);
const KEEPALIVE_INTERVAL_MS = getEnvNumber("KEEPALIVE_INTERVAL_MS", 2 * 60 * 1000);
const KEEPALIVE_IDLE_MS = getEnvNumber("KEEPALIVE_IDLE_MS", 15 * 60 * 1000);
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

export type CacheEntry = {
  url: string;
  cookieHeader: string;
  fetchedAtMs: number;
  expiresAtMs: number;
  referer: string;
  userAgent: string;
  cached: boolean;
};

const cache = new Map<Channel, CacheEntry>();
const inflight = new Map<Channel, { promise: Promise<CacheEntry>; startedAtMs: number }>();
const lastActiveAtMs = new Map<Channel, number>();
const keepaliveTimers = new Map<Channel, ReturnType<typeof setInterval>>();
const refreshVersions = new Map<Channel, number>();
let nextRefreshVersion = 0;

const logCache = (message: string, details: Record<string, unknown>) => {
  console.log(`[cache] ${message}`, JSON.stringify(details));
};

const logCacheDebug = (message: string, details: Record<string, unknown>) => {
  if (LOG_LEVEL === "debug") {
    logCache(message, details);
  }
};

const buildEntry = (result: StreamFetchResult, cached: boolean): CacheEntry => {
  return {
    url: result.url,
    cookieHeader: result.cookieHeader,
    fetchedAtMs: result.fetchedAtMs,
    expiresAtMs: result.fetchedAtMs + CACHE_TTL_MS,
    referer: result.referer,
    userAgent: result.userAgent,
    cached
  };
};

const isFresh = (entry: CacheEntry) => entry.expiresAtMs > Date.now();

export const markStreamActive = (channel: Channel) => {
  lastActiveAtMs.set(channel, Date.now());
  ensureKeepalive(channel);
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Stream fetch timed out.")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

export const getStreamCache = (channel: Channel): CacheEntry | null => {
  const entry = cache.get(channel);
  if (!entry) {
    return null;
  }
  return isFresh(entry) ? { ...entry, cached: true } : null;
};

export const getStreamCacheEntry = (channel: Channel): CacheEntry | null => {
  return cache.get(channel) ?? null;
};

export const getStreamUrlCached = async (channel: Channel): Promise<CacheEntry> => {
  markStreamActive(channel);

  const existing = getStreamCache(channel);
  if (existing) {
    logCacheDebug("hit", { channel, expiresAtMs: existing.expiresAtMs });
    return existing;
  }

  try {
    return await waitForRefresh(channel, "refresh");
  } catch (error) {
    const stale = getStreamCacheEntry(channel);
    const message = error instanceof Error ? error.message : "Unknown error";
    if (stale) {
      logCache("refresh-failed-use-stale", { channel, error: message });
      return { ...stale, cached: true };
    }
    logCache("refresh-failed", { channel, error: message });
    throw error;
  }
};

const startRefresh = (channel: Channel, reason: "refresh" | "keepalive-refresh") => {
  const existingInflight = inflight.get(channel);
  if (existingInflight) {
    const ageMs = Date.now() - existingInflight.startedAtMs;
    if (ageMs <= STREAM_FETCH_TIMEOUT_MS) {
      logCacheDebug(`${reason}-join-inflight`, { channel });
      return existingInflight;
    }
    inflight.delete(channel);
    logCache("drop-stale-inflight", { channel, ageMs });
  }

  const startedAtMs = Date.now();
  const refreshVersion = ++nextRefreshVersion;
  refreshVersions.set(channel, refreshVersion);
  const promise = (async () => {
    logCache(`${reason}-start`, { channel });
    try {
      const result = await fetchStreamUrl(channel);
      const entry = buildEntry(result, false);
      if (refreshVersions.get(channel) !== refreshVersion) {
        logCache("refresh-result-ignored", { channel, reason });
        return entry;
      }
      cache.set(channel, entry);
      logCache(`${reason}-complete`, {
        channel,
        fetchedAtMs: entry.fetchedAtMs,
        expiresAtMs: entry.expiresAtMs,
        hasCookie: Boolean(entry.cookieHeader)
      });
      return entry;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logCache(`${reason}-failed`, { channel, error: message });
      throw error;
    }
  })().finally(() => {
    const currentInflight = inflight.get(channel);
    if (currentInflight?.promise === promise) {
      inflight.delete(channel);
      refreshVersions.delete(channel);
    }
  });

  const entry = { promise, startedAtMs };
  inflight.set(channel, entry);
  return entry;
};

const waitForRefresh = async (
  channel: Channel,
  reason: "refresh" | "keepalive-refresh"
): Promise<CacheEntry> => {
  const request = startRefresh(channel, reason);
  const elapsedMs = Date.now() - request.startedAtMs;
  const timeoutMs = Math.max(1000, STREAM_FETCH_TIMEOUT_MS - elapsedMs);
  return await withTimeout(request.promise, timeoutMs);
};

export const refreshStreamUrlCached = async (channel: Channel): Promise<CacheEntry> => {
  return await waitForRefresh(channel, "refresh");
};

function ensureKeepalive(channel: Channel) {
  if (keepaliveTimers.has(channel)) {
    return;
  }

  logCache("keepalive-start", { channel });
  const timer = setInterval(() => {
    const lastActive = lastActiveAtMs.get(channel) ?? 0;
    const idleMs = Date.now() - lastActive;
    if (idleMs > KEEPALIVE_IDLE_MS) {
      clearInterval(timer);
      keepaliveTimers.delete(channel);
      lastActiveAtMs.delete(channel);
      logCache("keepalive-stop-idle", { channel, idleMs });
      return;
    }

    const entry = cache.get(channel);
    const shouldRefresh = !entry || entry.expiresAtMs - Date.now() < KEEPALIVE_INTERVAL_MS * 2;
    if (!shouldRefresh) {
      logCacheDebug("keepalive-skip-fresh", { channel, expiresAtMs: entry.expiresAtMs });
      return;
    }

    waitForRefresh(channel, "keepalive-refresh").catch(() => {
      // Error details are logged inside refreshStreamUrl.
    });
  }, KEEPALIVE_INTERVAL_MS);
  keepaliveTimers.set(channel, timer);
  timer.unref?.();
}
