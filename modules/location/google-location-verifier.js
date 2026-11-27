/**
 * Inspect Google Search's displayed footer location, source indicator, and CAPTCHA/block state.
 */

import { getCountryPreset, SUPPORTED_COUNTRIES } from "./coordinate-validator.js";
import {
  GOOGLE_LOCATION_SOURCES,
  GOOGLE_LOCATION_STATUSES,
  GOOGLE_MATCH_CLASSIFICATIONS,
} from "./location-state.js";

export const GOOGLE_LOCATION_LIMITATION_NOTE =
  "A device-based city match on Google's location footer indicates Google's displayed region only and does not prove exact coordinate-level GPS ranking accuracy.";

const BLOCK_INDICATORS = [
  "unusual traffic from your computer network",
  "our systems have detected unusual traffic",
  "/sorry/index",
  "g-recaptcha",
  "captcha-form",
  "detected unusual traffic",
];

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  const lower = String(rawText || "").toLowerCase();
  if (
    lower.includes("from your device") ||
    lower.includes("based on your device") ||
    lower.includes("precise location")
  ) {
    return { label: "From your device", type: GOOGLE_LOCATION_SOURCES.DEVICE };
  }
  if (
    lower.includes("from your ip") ||
    lower.includes("based on your ip") ||
    lower.includes("internet address")
  ) {
    return { label: "From your IP address", type: GOOGLE_LOCATION_SOURCES.IP };
  }
  if (lower.includes("from your places") || lower.includes("saved places")) {
    return { label: "From your places", type: GOOGLE_LOCATION_SOURCES.PLACES };
  }
  if (lower.includes("past activity") || lower.includes("previous activity") || lower.includes("your activity")) {
    return { label: "From your previous activity", type: GOOGLE_LOCATION_SOURCES.ACTIVITY };
  }
  return { label: "Unknown location source", type: GOOGLE_LOCATION_SOURCES.UNKNOWN };
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

  const footerMatch =
    /<footer[\s\S]*?<\/footer>/i.exec(html) || /<div[^>]*id="footcnt"[\s\S]*?<\/div>/i.exec(html);
  const contextText = stripTags(footerMatch ? footerMatch[0] : html);

  if (!locationText) {
    const inlineMatch =
      /(?:Results for\s+)?([A-Za-z0-9 ,.'-]{2,60})\s*[-–—]\s*(From your device|From your IP address|Based on your IP address|From your internet address|From your places[^<\n]*)/i.exec(
        contextText
      );
    if (inlineMatch) {
      locationText = inlineMatch[1].trim();
    }
  }

  if (!locationText) {
    return { detectedLocation: null, locationSource: null, locationSourceType: null };
  }

  const combinedText = `${locationText} ${contextText}`;
  const sourceInfo = classifyLocationSource(combinedText);
  const cleanedLocation = locationText
    .replace(
      /\s*[-–—]\s*(From your device|From your IP address|Based on your IP address|From your internet address|From your places.*|Update location.*|Use precise location.*)$/i,
      ""
    )
    .trim();

  return {
    detectedLocation: cleanedLocation || locationText,
    locationSource: sourceInfo.label,
    locationSourceType: sourceInfo.type,
  };
}

/**
 * Match target city against Google's comma-separated location segments without
 * partial-name false positives (e.g. "York" must not match "New York" or "Yorkshire").
 */
function segmentMatchesExactCity(segment, targetCity) {
  const cleanedSegment = segment.trim().replace(/\s+/g, " ");
  const cityPattern = new RegExp(`^${escapeRegExp(targetCity)}(?:\\s+[A-Z]{2,3})?$`, "i");
  if (cityPattern.test(cleanedSegment)) {
    // Verify trailing suffix, if any, was actually an uppercase region code (e.g. "Sydney NSW")
    const remainder = cleanedSegment.slice(targetCity.length).trim();
    return remainder === "" || /^[A-Z]{2,3}$/.test(remainder);
  }
  return false;
}

function segmentMatchesWordBoundary(text, target) {
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(target)}(?:$|[^a-z0-9])`, "i");
  return pattern.test(text);
}

const KNOWN_COUNTRY_NAMES = Object.keys(SUPPORTED_COUNTRIES).concat([
  "USA",
  "UK",
  "Great Britain",
  "England",
  "Germany",
  "France",
  "Spain",
  "Italy",
  "Japan",
  "Singapore",
  "Ireland",
]);

function detectConflictingCountry(rawDetected, targetCountry) {
  const target = String(targetCountry || "").trim().toLowerCase();
  if (!target || !rawDetected) return null;
  for (const countryName of KNOWN_COUNTRY_NAMES) {
    const cLower = countryName.toLowerCase();
    if (cLower === target) continue;
    if ((target === "united states" && cLower === "usa") || (target === "united kingdom" && (cLower === "uk" || cLower === "great britain" || cLower === "england"))) {
      continue;
    }
    if (segmentMatchesWordBoundary(rawDetected, countryName)) {
      return countryName;
    }
  }
  return null;
}

export function locationMatchesTarget({
  detectedLocation,
  targetCity,
  targetState = "",
  targetCountry,
  locationSourceType = GOOGLE_LOCATION_SOURCES.UNKNOWN,
}) {
  const rawDetected = String(detectedLocation || "").trim();
  const city = String(targetCity || "").trim();
  const state = String(targetState || "").trim();
  const country = String(targetCountry || "").trim();
  const segments = rawDetected.split(",").map((s) => s.trim()).filter(Boolean);

  // Guard against identical city names in different countries (e.g. Sydney, Canada vs Sydney, Australia)
  const conflictingCountry = detectConflictingCountry(rawDetected, country);
  if (conflictingCountry) {
    return {
      matched: false,
      strictEligible: false,
      matchedBy: "none",
      matchType: "mismatch",
      classification: GOOGLE_MATCH_CLASSIFICATIONS.MISMATCH,
      conflictReason: `Detected country '${conflictingCountry}' conflicts with target '${country}'.`,
    };
  }

  if (city) {
    const cityMatched = segments.some((seg) => segmentMatchesExactCity(seg, city));
    if (cityMatched) {
      // If targetState is provided and detected text includes a different 2-3 letter state code, treat as ambiguous/mismatch
      if (state) {
        const hasTargetState = segmentMatchesWordBoundary(rawDetected, state);
        const stateCodeMatch = new RegExp(`^${escapeRegExp(city)}\\s+([A-Z]{2,3})$`, "i").exec(segments[0] || "");
        if (stateCodeMatch && state.length <= 3 && stateCodeMatch[1].toUpperCase() !== state.toUpperCase() && !hasTargetState) {
          return {
            matched: false,
            strictEligible: false,
            matchedBy: "none",
            matchType: "mismatch",
            classification: GOOGLE_MATCH_CLASSIFICATIONS.MISMATCH,
            conflictReason: `Detected region '${stateCodeMatch[1]}' conflicts with target state '${state}'.`,
          };
        }
      }

      if (locationSourceType === GOOGLE_LOCATION_SOURCES.DEVICE) {
        return {
          matched: true,
          strictEligible: true,
          matchedBy: "city",
          matchType: "device_city",
          classification: GOOGLE_MATCH_CLASSIFICATIONS.DEVICE_CITY,
        };
      }
      if (locationSourceType === GOOGLE_LOCATION_SOURCES.IP) {
        return {
          matched: false,
          strictEligible: false,
          matchedBy: "city_ip_only",
          matchType: "ip_city",
          classification: GOOGLE_MATCH_CLASSIFICATIONS.IP_CITY,
        };
      }
      if (locationSourceType === GOOGLE_LOCATION_SOURCES.PLACES) {
        return {
          matched: false,
          strictEligible: false,
          matchedBy: "city_places_only",
          matchType: "places_city",
          classification: GOOGLE_MATCH_CLASSIFICATIONS.PLACES_CITY,
        };
      }
      if (locationSourceType === GOOGLE_LOCATION_SOURCES.ACTIVITY) {
        return {
          matched: false,
          strictEligible: false,
          matchedBy: "city_activity_only",
          matchType: "activity_city",
          classification: GOOGLE_MATCH_CLASSIFICATIONS.ACTIVITY_CITY,
        };
      }
      return {
        matched: false,
        strictEligible: false,
        matchedBy: "city_unknown_source",
        matchType: "ambiguous",
        classification: GOOGLE_MATCH_CLASSIFICATIONS.AMBIGUOUS,
      };
    }
    return {
      matched: false,
      strictEligible: false,
      matchedBy: "none",
      matchType: "mismatch",
      classification: GOOGLE_MATCH_CLASSIFICATIONS.MISMATCH,
    };
  }

  if (state && segmentMatchesWordBoundary(rawDetected, state) && locationSourceType === GOOGLE_LOCATION_SOURCES.DEVICE) {
    return {
      matched: true,
      strictEligible: true,
      matchedBy: "region",
      matchType: "device_region",
      classification: GOOGLE_MATCH_CLASSIFICATIONS.DEVICE_REGION,
    };
  }

  if (country && segmentMatchesWordBoundary(rawDetected, country)) {
    return {
      matched: false,
      strictEligible: false,
      matchedBy: "country",
      matchType: "country_only",
      classification: GOOGLE_MATCH_CLASSIFICATIONS.COUNTRY_ONLY,
    };
  }

  return {
    matched: false,
    strictEligible: false,
    matchedBy: "none",
    matchType: "mismatch",
    classification: GOOGLE_MATCH_CLASSIFICATIONS.MISMATCH,
  };
}

/**
 * Pure parser for Google Search HTML (used by both live tab inspection and unit tests).
 */
export function inspectGoogleSearchHtml({
  html,
  pageUrl = "",
  targetCity = "",
  targetState = "",
  targetCountry = "",
  configuredCoords = null,
  browserGps = null,
}) {
  const checkedAt = new Date().toISOString();
  const blockReason = detectGoogleBlock({ html, pageUrl });

  if (blockReason) {
    return {
      status: GOOGLE_LOCATION_STATUSES.SEARCH_BLOCKED,
      detectedLocation: null,
      locationSource: null,
      locationSourceType: GOOGLE_LOCATION_SOURCES.UNAVAILABLE,
      matchedBy: null,
      matchType: "none",
      matchClassification: GOOGLE_MATCH_CLASSIFICATIONS.UNVERIFIED,
      strictRankingEligible: false,
      dimensions: {
        configuredCoords,
        browserGps,
        googleDisplayedLocation: null,
        googleLocationSource: GOOGLE_LOCATION_SOURCES.UNAVAILABLE,
        geographicMatchGranularity: GOOGLE_MATCH_CLASSIFICATIONS.UNVERIFIED,
        rankingEligibility: { eligible: false, reason: blockReason },
      },
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
      locationSourceType: GOOGLE_LOCATION_SOURCES.UNAVAILABLE,
      matchedBy: null,
      matchType: "none",
      matchClassification: GOOGLE_MATCH_CLASSIFICATIONS.UNVERIFIED,
      strictRankingEligible: false,
      dimensions: {
        configuredCoords,
        browserGps,
        googleDisplayedLocation: null,
        googleLocationSource: GOOGLE_LOCATION_SOURCES.UNAVAILABLE,
        geographicMatchGranularity: GOOGLE_MATCH_CLASSIFICATIONS.UNVERIFIED,
        rankingEligibility: { eligible: false, reason: "Google did not display a location footer on this page." },
      },
      checkedAt,
      pageUrl,
      error: null,
      warning: "Google did not display a location footer on this page.",
    };
  }

  const comparison = locationMatchesTarget({
    detectedLocation,
    targetCity,
    targetState,
    targetCountry,
    locationSourceType,
  });

  let status = GOOGLE_LOCATION_STATUSES.MISMATCH;
  let warning = null;
  let error = null;

  if (comparison.strictEligible) {
    status = GOOGLE_LOCATION_STATUSES.MATCHED;
    warning = GOOGLE_LOCATION_LIMITATION_NOTE;
  } else if (comparison.matchType === "ip_city") {
    status = GOOGLE_LOCATION_STATUSES.NON_DEVICE_MATCH;
    warning = "Google reported location from IP address rather than browser GPS device location. Not eligible for strict live ranking verification.";
    error = `Google location '${detectedLocation}' is IP-based (${locationSource}), not device-based GPS.`;
  } else if (comparison.matchType === "places_city" || comparison.matchType === "activity_city") {
    status = GOOGLE_LOCATION_STATUSES.NON_DEVICE_MATCH;
    warning = `Google reported location from ${locationSource} rather than device GPS. Not eligible for strict live ranking verification.`;
    error = `Google location '${detectedLocation}' came from ${locationSource}, not device-based GPS.`;
  } else if (comparison.matchType === "country_only") {
    status = GOOGLE_LOCATION_STATUSES.AMBIGUOUS;
    warning = "Country-only match (no target city verified). Does not prove city-level or GPS accuracy.";
    error = `Google displayed country-level '${detectedLocation}', which does not verify target city '${targetCity || targetCountry}'.`;
  } else if (comparison.matchType === "ambiguous") {
    status = GOOGLE_LOCATION_STATUSES.AMBIGUOUS;
    warning = "Google location source could not be confirmed as device-based.";
    error = `Google location '${detectedLocation}' has an unconfirmed source (${locationSource}).`;
  } else {
    status = GOOGLE_LOCATION_STATUSES.MISMATCH;
    error =
      comparison.conflictReason ||
      `Google displayed '${detectedLocation}', which does not match target '${targetCity || targetCountry}'.`;
    if (locationSourceType === GOOGLE_LOCATION_SOURCES.IP) {
      warning = "Google reported location from IP address rather than browser GPS device location.";
    }
  }

  return {
    status,
    detectedLocation,
    locationSource,
    locationSourceType,
    matchedBy: comparison.matchedBy,
    matchType: comparison.matchType,
    matchClassification: comparison.classification,
    strictRankingEligible: Boolean(comparison.strictEligible),
    dimensions: {
      configuredCoords,
      browserGps,
      googleDisplayedLocation: detectedLocation,
      googleLocationSource: locationSourceType,
      geographicMatchGranularity: comparison.classification,
      rankingEligibility: {
        eligible: Boolean(comparison.strictEligible),
        reason: comparison.strictEligible ? "Device-based Google location matched target." : error || warning,
      },
    },
    checkedAt,
    pageUrl,
    error,
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
      matchType: "none",
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
      matchType: "none",
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
