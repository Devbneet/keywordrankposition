/**
 * Content-script helpers for capturing the current SERP DOM snapshot safely.
 */
export const CONTENT_SCRIPT_VERSION = "0.2.0";

export function readPageSerpSnapshot(doc = globalThis.document, win = globalThis.window) {
  return {
    html: doc?.documentElement ? doc.documentElement.outerHTML : "",
    pageUrl: win?.location ? win.location.href : "",
  };
}
