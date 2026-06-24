import type { Page } from "playwright";

export const extractM3u8FromScript = async (page: Page, scriptText: string) => {
  return page.evaluate((text) => {
    const global = globalThis as typeof globalThis & Record<string, unknown>;
    const before = new Set(Object.keys(global));
    const m3u8Regex = /https?:\/\/[^\s'"\\]+\.m3u8[^\s'"\\]*/;
    const findM3u8 = (value: unknown) => {
      if (typeof value !== "string") {
        return null;
      }
      const match = value.match(m3u8Regex);
      return match ? match[0] : null;
    };

    const directMatch = findM3u8(text);
    if (directMatch) {
      return directMatch;
    }

    try {
      global.eval(text);
    } catch {
      return null;
    }

    for (const key of Object.keys(global)) {
      if (before.has(key)) {
        continue;
      }

      const value = global[key];
      const valueMatch = findM3u8(value);
      if (valueMatch) {
        return valueMatch;
      }

      if (typeof value !== "function") {
        continue;
      }

      try {
        const returned = value();
        const returnedMatch = findM3u8(returned);
        if (returnedMatch) {
          return returnedMatch;
        }
      } catch {
        // Ignore unrelated globals created by the remote script.
      }
    }

    return null;
  }, scriptText);
};
