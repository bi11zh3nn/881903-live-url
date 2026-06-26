import { chromium } from "playwright";
import { extractM3u8FromScript } from "./browser-utils.js";
import { extractLiveJsUrl, extractM3u8Url, LIVE_URLS, type Channel } from "./stream-utils.js";

export type StreamFetchResult = {
  url: string;
  cookieHeader: string;
  fetchedAtMs: number;
  referer: string;
  userAgent: string;
};

const buildCookieHeader = (cookies: Array<{ name: string; value: string }>) => {
  if (!cookies.length) {
    return "";
  }
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
};

const PAGE_GOTO_TIMEOUT_MS = 20 * 1000;
const PLAYLIST_REQUEST_TIMEOUT_MS = 15 * 1000;
const BROWSER_LAUNCH_TIMEOUT_MS = 15 * 1000;

const fetchPlaylistJs = async (page: import("playwright").Page, liveUrl: string) => {
  const html = await page.content();
  const liveJsUrl = extractLiveJsUrl(html);

  if (!liveJsUrl) {
    console.error("[fetchPlaylistJs] Failed to extract liveJsUrl. HTML length:", html.length);
    console.error("[fetchPlaylistJs] HTML snippet:", html.substring(0, 500));
    throw new Error("Failed to find liveJsUrl in page HTML.");
  }

  const userAgent = await page.evaluate(() => navigator.userAgent);
  const response = await page.request.get(liveJsUrl, {
    timeout: PLAYLIST_REQUEST_TIMEOUT_MS,
    headers: {
      Referer: liveUrl,
      Origin: "https://www.881903.com",
      "User-Agent": userAgent,
      "Sec-Fetch-Dest": "script",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "same-site"
    }
  });

  if (!response.ok()) {
    throw new Error(`Failed to fetch playlist.js (${response.status()}).`);
  }

  return response.text();
};

export const fetchStreamUrl = async (channel: Channel): Promise<StreamFetchResult> => {
  const liveUrl = LIVE_URLS[channel];
  console.log("[fetchStreamUrl] Starting for channel", channel, "URL:", liveUrl);

  const browser = await chromium.launch({
    headless: true,
    timeout: BROWSER_LAUNCH_TIMEOUT_MS
  });
  const page = await browser.newPage();

  try {
    const playlistResponsePromise = page.waitForResponse(
      (response) => response.url().includes("playlist.js") && response.ok(),
      { timeout: 15000 }
    ).catch(() => null);
    const m3u8ResponsePromise = page.waitForResponse(
      (response) => response.url().includes(".m3u8") && response.ok(),
      { timeout: 15000 }
    ).catch(() => null);

    await page.goto(liveUrl, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_GOTO_TIMEOUT_MS
    });

    const m3u8Response = await m3u8ResponsePromise;
    if (m3u8Response) {
      const m3u8Url = m3u8Response.url();
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const cookies = await page.context().cookies();
      return {
        url: m3u8Url,
        cookieHeader: buildCookieHeader(cookies),
        fetchedAtMs: Date.now(),
        referer: liveUrl,
        userAgent
      };
    }

    let playlistJs = "";
    const playlistResponse = await playlistResponsePromise;
    if (playlistResponse) {
      playlistJs = await playlistResponse.text();
    } else {
      playlistJs = await fetchPlaylistJs(page, liveUrl);
    }

    const m3u8Url = extractM3u8Url(playlistJs) ?? await extractM3u8FromScript(page, playlistJs);
    if (!m3u8Url) {
      throw new Error("Failed to extract .m3u8 URL from playlist.js.");
    }

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const cookies = await page.context().cookies();

    return {
      url: m3u8Url,
      cookieHeader: buildCookieHeader(cookies),
      fetchedAtMs: Date.now(),
      referer: liveUrl,
      userAgent
    };
  } finally {
    if (browser.isConnected()) {
      await browser.close();
    }
  }
};
