/**
 * Inspect Google Search's displayed footer location, source indicator, and CAPTCHA/block state.
 */

import { getCountryPreset } from "./coordinate-validator.js";
import { GOOGLE_LOCATION_STATUSES } from "./location-state.js";

export const GOOGLE_LOCATION_LIMITATION_NOTE =
  "A city-level match on Google's location footer indicates Google's displayed region only and does not prove exact GPS-level ranking accuracy.";

const BLOCK_INDICATORS = [
  "unusual traffic from your computer network",
  "our systems have detected unusual traffic",
  "/sorry/index",
  "g-recaptcha",
  "captcha-form",
  "detected unusual traffic",
];

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildGoogleLocationCheckUrl({
  googleDomain = "google.com.au",
  country = "Australia",
  language = "en-AU",
} = {}) {
  const preset = getCountryPreset(country);
  const domain = String(googleDomain || preset.googleDomain).trim().toLowerCase();
  const hl = encodeURIComponent(String(language || preset.defaultLanguage).trim() || "en");
  const gl = encodeURIComponent(preset.code);
  return `https://www.${domain.replace(/^www\./, "")}/search?q=local+services&hl=${hl}&gl=${gl}`;
}

export function detectGoogleBlock({ html = "", pageUrl = "" } = {}) {
  const lowerUrl = String(pageUrl || "").toLowerCase();
  if (lowerUrl.includes("/sorry/")) {
    return "Google returned a /sorry/ verification page.";
  }

  const lowerHtml = String(html || "").toLowerCase();
  for (const indicator of BLOCK_INDICATORS) {
    if (lowerHtml.includes(indicator)) {
      return `Google CAPTCHA or access restriction detected (${indicator}).`;
    }
  }
  return null;
}

function classifyLocationSource(rawText) {
  const lower = rawText.toLowerCase();
  if (lower.includes("from your device") || lower.includes("precise location")) {
    return { label: "From your device", type: "device" };
  }
  if (lower.includes("from your ip") || lower.includes("based on your ip") || lower.includes("internet address")) {
    return { label: "From your IP address", type: "ip" };
  }
  if (lower.includes("from your places") || lower.includes("past activity")) {
    return { label: "From your places / activity", type: "places" };
  }
  return { label: "Not specified", type: "unknown" };
}

function extractFooterLocationAndSource(html) {
  const sourcePatterns = [
    /<span[^>]*class="[^"]*Q8LRLc[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*id="Wprf1b"[^>]*>([\s\S]*?)<\/div>/i,
    /<span[^>]*id="swml"[^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*id="swml"[^>]*>([\s\S]*?)<\/div>/i,
  ];

  let locationText = null;
  for (const pattern of sourcePatterns) {
    const match = pattern.exec(html);
    if (match) {
      const cleaned = stripTags(match[1]);
      if (cleaned) {
        locationText = cleaned;
        break;
      }
    }
  }

  // Check surrounding footer/swml container for source text ("From your device", "From your IP address", etc.)
  const footerMatch = /<footer[\s\S]*?<\/footer>/i.exec(html) || /<div[^>]*id="footcnt"[\s\S]*?<\/div>/i.exec(html);
  const contextText = stripTags(footerMatch ? footerMatch[0] : html);

  if (!locationText) {
    // Fallback: look for "Results for <Location> - From your ..." or "<Location> - Based on your IP address"
    const inlineMatch = /(?:Results for\s+)?([A-Za-z0-9 ,.'-]{2,60})\s*[-–—]\s*(From your device|From your IP address|Based on your IP address|From your internet address|From your places[^<\n]*)/i.exec(
      contextText
    );
    if (inlineMatch) {
      locationText = inlineMatch[1].trim();
    }
  }

  if (!locationText) {
    return { detectedLocation: null, locationSource: null, locationSourceType: null };
  }

  // Strip trailing source text if embedded inside the same element (e.g. "Sydney NSW - From your device")
  const combinedText = `${locationText} ${contextText}`;
  const sourceInfo = classifyLocationSource(combinedText);
  const cleanedLocation = locationText
    .replace(/\s*[-–—]\s*(From your device|From your IP address|Based on your IP address|From your internet address|From your places.*|Update location.*|Use precise location.*)$/i, "")
    .trim();

  return {
    detectedLocation: cleanedLocation || locationText,
    locationSource: sourceInfo.label,
    locationSourceType: sourceInfo.type,
  };
}

function locationMatchesTarget({ detectedLocation, targetCity, targetCountry }) {
  const lowerDetected = String(detectedLocation || "").toLowerCase();
  const city = String(targetCity || "").trim().toLowerCase();
  const country = String(targetCountry || "").trim().toLowerCase();

  if (city) {
    return {
      matched: lowerDetected.includes(city),
      matchedBy: "city",
    };
  }
  if (country) {
    return {
      matched: lowerDetected.includes(country),
      matchedBy: "country",
    };
  }
  return { matched: false, matchedBy: "none" };
}

/**
 * Pure parser for Google Search HTML (used by both live tab inspection and unit tests).
 */
export function inspectGoogleSearchHtml({
  html,
  pageUrl = "",
  targetCity = "",
  targetCountry = "",
}) {
  const checkedAt = new Date().toISOString();
  const blockReason = detectGoogleBlock({ html, pageUrl });

  if (blockReason) {
    return {
      status: GOOGLE_LOCATION_STATUSES.SEARCH_BLOCKED,
      detectedLocation: null,
      locationSource: null,
      locationSourceType: null,
      matchedBy: null,
      checkedAt,
      pageUrl,
      error: blockReason,
      warning: "Google Search access was restricted. Verification stopped without bypassing.",
    };
  }

  const { detectedLocation, locationSource, locationSourceType } = extractFooterLocationAndSource(html);
  if (!detectedLocation) {
    return {
      status: GOOGLE_LOCATION_STATUSES.UNAVAILABLE,
      detectedLocation: null,
      locationSource: null,
      locationSourceType: null,
      matchedBy: null,
      checkedAt,
      pageUrl,
      error: null,
      warning: "Google did not display a location footer on this page.",
    };
  }

  const comparison = locationMatchesTarget({
    detectedLocation,
    targetCity,
    targetCountry,
  });

  let warning = null;
  if (locationSourceType === "ip") {
    warning = "Google reported location from IP address rather than browser GPS device location.";
  } else if (comparison.matched && comparison.matchedBy === "country") {
    warning = "Matched country only (no target city specified). Does not prove city-level accuracy.";
  } else if (comparison.matched) {
    warning = GOOGLE_LOCATION_LIMITATION_NOTE;
  }

  return {
    status: comparison.matched ? GOOGLE_LOCATION_STATUSES.MATCHED : GOOGLE_LOCATION_STATUSES.MISMATCH,
    detectedLocation,
    locationSource,
    locationSourceType,
    matchedBy: comparison.matchedBy,
    checkedAt,
    pageUrl,
    error: comparison.matched
      ? null
      : `Google displayed '${detectedLocation}', which does not match target '${targetCity || targetCountry}'.`,
    warning,
  };
}

function buildGoogleInspectionExpression({ clickUpdateLocation = false } = {}) {
  return `(async () => {
    let triggeredUpdateControl = false;
    if (${Boolean(clickUpdateLocation)}) {
      const candidates = Array.from(document.querySelectorAll("a, button, span[role='button'], div[role='button']"));
      const control = candidates.find((el) => {
        const txt = (el.textContent || "").trim().toLowerCase();
        return txt === "update location" || txt === "use precise location";
      });
      if (control && typeof control.click === "function") {
        control.click();
        triggeredUpdateControl = true;
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }
    return {
      html: document.documentElement ? document.documentElement.outerHTML : "",
      pageUrl: window.location.href,
      triggeredUpdateControl
    };
  })()`;
}

/**
 * Inspect Google's displayed location inside the attached Google Search tab.
 */
export async function verifyGoogleSearchLocation({
  tabId,
  targetCity = "",
  targetCountry = "",
  clickUpdateLocation = false,
  chromeApi = globalThis.chrome,
}) {
  const checkedAt = new Date().toISOString();
  let evalResponse;

  try {
    evalResponse = await chromeApi.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: buildGoogleInspectionExpression({ clickUpdateLocation }),
      awaitPromise: true,
      returnByValue: true,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const detached = /detach|target closed|no tab|not attached/i.test(msg);
    return {
      status: detached
        ? GOOGLE_LOCATION_STATUSES.DEBUGGER_DISCONNECTED
        : GOOGLE_LOCATION_STATUSES.VERIFICATION_FAILED,
      detectedLocation: null,
      locationSource: null,
      locationSourceType: null,
      matchedBy: null,
      checkedAt,
      pageUrl: null,
      error: msg,
      warning: null,
    };
  }

  const payload = evalResponse?.result?.value;
  if (!payload || typeof payload.html !== "string") {
    return {
      status: GOOGLE_LOCATION_STATUSES.VERIFICATION_FAILED,
      detectedLocation: null,
      locationSource: null,
      locationSourceType: null,
      matchedBy: null,
      checkedAt,
      pageUrl: null,
      error: "Unable to read Google page content from active tab.",
      warning: null,
    };
  }

  const parsed = inspectGoogleSearchHtml({
    html: payload.html,
    pageUrl: payload.pageUrl,
    targetCity,
    targetCountry,
  });

  return {
    ...parsed,
    triggeredUpdateControl: Boolean(payload.triggeredUpdateControl),
  };
}

