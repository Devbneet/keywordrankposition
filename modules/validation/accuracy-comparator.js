/**
 * Compare extension organic ranking results against manually verified
 * GS Location Changer baselines, validating setting comparability first.
 */

import { RANKING_STATUSES } from "../ranking/ranking-state.js";
import { computeAccuracyMetrics } from "./accuracy-metrics.js";
import { normalizeManualRank } from "./baseline-manager.js";

export const COMPARISON_STATUSES = Object.freeze({
  EXACT_MATCH: "Exact match",
  WITHIN_TOLERANCE: "Within tolerance",
  RANKING_MISMATCH: "Ranking mismatch",
  URL_MISMATCH: "URL mismatch",
  LOCATION_MISMATCH: "Location mismatch",
  SEARCH_BLOCKED: "Search blocked",
  INCOMPLETE_SEARCH: "Incomplete search",
  MISSING_BASELINE: "Missing baseline",
  NOT_COMPARABLE: "Not comparable",
});

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "srsltid",
  "gclid",
  "fbclid",
]);

export function normalizeComparableUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/, "");
    const keptParams = [];
    for (const [key, val] of parsed.searchParams.entries()) {
      if (!TRACKING_PARAMS.has(key.toLowerCase())) {
        keptParams.push(`${key}=${val}`);
      }
    }
    const query = keptParams.length > 0 ? `?${keptParams.sort().join("&")}` : "";
    return `${host}${pathname}${query}`;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, "");
  }
}

function normalizeKeywordKey(keyword) {
  return String(keyword || "").trim().toLowerCase();
}

/**
 * Validate that extension run settings and manual baseline settings are comparable.
 */
export function validateComparisonSettings({ extensionResult, baselineRow, settings = {} }) {
  const incompatibilities = [];
  const warnings = [];

  const extDomain = String(extensionResult?.targetWebsite || settings.websiteDomain || "").trim().toLowerCase();
  if (!extDomain) {
    incompatibilities.push("Target website domain is missing.");
  }

  const extSnapshot = extensionResult?.configSnapshot || settings;
  const extLat = extSnapshot?.latitude !== undefined && extSnapshot?.latitude !== "" ? Number(extSnapshot.latitude) : null;
  const extLng = extSnapshot?.longitude !== undefined && extSnapshot?.longitude !== "" ? Number(extSnapshot.longitude) : null;

  if (
    baselineRow?.latitude !== null &&
    baselineRow?.latitude !== undefined &&
    extLat !== null &&
    Number.isFinite(extLat)
  ) {
    if (Math.abs(baselineRow.latitude - extLat) > 0.01) {
      incompatibilities.push(
        `Latitude differs (baseline ${baselineRow.latitude} vs extension ${extLat}).`
      );
    }
  }

  if (
    baselineRow?.longitude !== null &&
    baselineRow?.longitude !== undefined &&
    extLng !== null &&
    Number.isFinite(extLng)
  ) {
    if (Math.abs(baselineRow.longitude - extLng) > 0.01) {
      incompatibilities.push(
        `Longitude differs (baseline ${baselineRow.longitude} vs extension ${extLng}).`
      );
    }
  }

  const extDevice = String(extensionResult?.deviceType || settings.deviceType || "Desktop").trim().toLowerCase();
  const baseDevice = String(baselineRow?.device || "").trim().toLowerCase();
  if (baseDevice && extDevice && baseDevice !== extDevice) {
    incompatibilities.push(`Device mismatch (baseline '${baselineRow.device}' vs extension '${extensionResult?.deviceType || settings.deviceType}').`);
  }

  const baseLocation = String(baselineRow?.targetLocation || "").trim().toLowerCase();
  const extCity = String(extSnapshot?.targetCity || extSnapshot?.locationName || settings.targetLocation || "")
    .trim()
    .toLowerCase();
  if (baseLocation && extCity && !baseLocation.includes(extCity) && !extCity.includes(baseLocation)) {
    incompatibilities.push(
      `Target location differs (baseline '${baselineRow.targetLocation}' vs extension '${extSnapshot?.targetCity || settings.targetLocation}').`
    );
  }

  const requestedDepth = Number(extensionResult?.requestedDepth || settings.searchDepth || 50);
  const manualRank = normalizeManualRank(baselineRow?.manualRanking);
  if (typeof manualRank === "number" && Number.isFinite(requestedDepth) && manualRank > requestedDepth) {
    incompatibilities.push(
      `Baseline rank (#${manualRank}) exceeds extension search depth (${requestedDepth}).`
    );
  }

  if (extensionResult?.invalidatedByLocationChange) {
    incompatibilities.push("Extension ranking result was invalidated after location changed.");
  }

  if (extensionResult?.sourceMode === "manual_html") {
    warnings.push("Extension result came from Manual SERP HTML, not live Google Search.");
  }

  if (baselineRow?.checkedAt && extensionResult?.checkedAt) {
    const baseTime = Date.parse(baselineRow.checkedAt);
    const extTime = Date.parse(extensionResult.checkedAt);
    if (Number.isFinite(baseTime) && Number.isFinite(extTime)) {
      const diffHours = Math.abs(extTime - baseTime) / (1000 * 60 * 60);
      if (diffHours > 48) {
        warnings.push(`Checked timestamps are ${Math.round(diffHours / 24)} day(s) apart.`);
      }
    }
  }

  return {
    comparable: incompatibilities.length === 0,
    incompatibilities,
    warnings,
  };
}

/**
 * Match extension results against baseline rows (preserving duplicate keywords in order)
 * and compute row-level comparison outcomes + aggregate accuracy metrics.
 */
export function compareRankingWithBaseline({
  keywords = [],
  extensionResults = [],
  baselineRows = [],
  settings = {},
  tolerance = 1,
}) {
  const safeTolerance = Math.min(5, Math.max(0, Number.isFinite(Number(tolerance)) ? Number(tolerance) : 1));

  // Build ordered queues per normalized keyword so duplicate keywords pair deterministically.
  const extQueues = new Map();
  for (const res of extensionResults) {
    const key = normalizeKeywordKey(res.keyword);
    if (!extQueues.has(key)) extQueues.set(key, []);
    extQueues.get(key).push(res);
  }

  const baseQueues = new Map();
  for (const row of baselineRows) {
    const key = normalizeKeywordKey(row.keyword);
    if (!baseQueues.has(key)) baseQueues.set(key, []);
    baseQueues.get(key).push(row);
  }

  // Determine ordered list of keyword entries to compare:
  // If explicit keywords list is provided, follow it; otherwise combine baselineRows + any extra extension results.
  const workItems = [];
  if (Array.isArray(keywords) && keywords.length > 0) {
    for (const kw of keywords) {
      const key = normalizeKeywordKey(kw);
      if (!key) continue;
      const ext = extQueues.get(key)?.shift() || null;
      const base = baseQueues.get(key)?.shift() || null;
      workItems.push({ keyword: String(kw).trim(), ext, base });
    }
  } else {
    for (const base of baselineRows) {
      const key = normalizeKeywordKey(base.keyword);
      baseQueues.get(key)?.shift();
      const ext = extQueues.get(key)?.shift() || null;
      workItems.push({ keyword: base.keyword, ext, base });
    }
    for (const queue of extQueues.values()) {
      for (const leftoverExt of queue) {
        workItems.push({ keyword: leftoverExt.keyword, ext: leftoverExt, base: null });
      }
    }
  }

  const comparedRows = workItems.map(({ keyword, ext, base }) => {
    const manualRank = normalizeManualRank(base?.manualRanking);
    const manualUrl = base?.manualRankingUrl || "";
    const extStatus = ext?.status || null;
    const extPositionDisplay =
      extStatus === RANKING_STATUSES.RANKED
        ? ext.position
        : extStatus === RANKING_STATUSES.NOT_FOUND
          ? "NA"
          : extStatus || "Not checked";

    if (!ext) {
      return {
        keyword,
        manualRanking: manualRank ?? "-",
        extensionRanking: "Not checked",
        rankingDifference: null,
        manualRankingUrl: manualUrl,
        extensionRankingUrl: "",
        urlMatchStatus: "Not comparable",
        browserGpsStatus: "-",
        googleLocationStatus: "-",
        googleLocationSource: "-",
        comparisonStatus: COMPARISON_STATUSES.INCOMPLETE_SEARCH,
        notes: ["No extension ranking result available for this keyword."],
      };
    }

    if (extStatus === RANKING_STATUSES.SEARCH_BLOCKED) {
      return {
        keyword,
        manualRanking: manualRank ?? "-",
        extensionRanking: "Blocked",
        rankingDifference: null,
        manualRankingUrl: manualUrl,
        extensionRankingUrl: "",
        urlMatchStatus: "Not comparable",
        browserGpsStatus: ext.browserGpsStatus || "-",
        googleLocationStatus: ext.googleLocationStatus || "-",
        googleLocationSource: ext.googleLocationSource || "-",
        comparisonStatus: COMPARISON_STATUSES.SEARCH_BLOCKED,
        notes: [ext.errorDetails || "Search blocked by CAPTCHA or access restriction."],
      };
    }

    if (
      extStatus === RANKING_STATUSES.LOCATION_MISMATCH ||
      extStatus === RANKING_STATUSES.LOCATION_UNVERIFIED ||
      extStatus === RANKING_STATUSES.PERMISSION_DENIED
    ) {
      return {
        keyword,
        manualRanking: manualRank ?? "-",
        extensionRanking: extStatus,
        rankingDifference: null,
        manualRankingUrl: manualUrl,
        extensionRankingUrl: "",
        urlMatchStatus: "Not comparable",
        browserGpsStatus: ext.browserGpsStatus || "-",
        googleLocationStatus: ext.googleLocationStatus || "-",
        googleLocationSource: ext.googleLocationSource || "-",
        comparisonStatus: COMPARISON_STATUSES.LOCATION_MISMATCH,
        notes: [ext.errorDetails || `Extension stopped due to ${extStatus}.`],
      };
    }

    if (
      extStatus === RANKING_STATUSES.INCOMPLETE_SEARCH ||
      extStatus === RANKING_STATUSES.PARSING_ERROR ||
      extStatus === RANKING_STATUSES.NETWORK_ERROR ||
      extStatus === RANKING_STATUSES.STOPPED_BY_USER
    ) {
      return {
        keyword,
        manualRanking: manualRank ?? "-",
        extensionRanking: extStatus,
        rankingDifference: null,
        manualRankingUrl: manualUrl,
        extensionRankingUrl: "",
        urlMatchStatus: "Not comparable",
        browserGpsStatus: ext.browserGpsStatus || "-",
        googleLocationStatus: ext.googleLocationStatus || "-",
        googleLocationSource: ext.googleLocationSource || "-",
        comparisonStatus: COMPARISON_STATUSES.INCOMPLETE_SEARCH,
        notes: [ext.errorDetails || `Extension check incomplete (${extStatus}).`],
      };
    }

    if (!base || manualRank === null) {
      return {
        keyword,
        manualRanking: "-",
        extensionRanking: extPositionDisplay,
        rankingDifference: null,
        manualRankingUrl: manualUrl,
        extensionRankingUrl: ext.rankingUrl || "",
        urlMatchStatus: "Missing baseline",
        browserGpsStatus: ext.browserGpsStatus || "-",
        googleLocationStatus: ext.googleLocationStatus || "-",
        googleLocationSource: ext.googleLocationSource || "-",
        comparisonStatus: COMPARISON_STATUSES.MISSING_BASELINE,
        notes: ["Manual GS Location Changer baseline is missing for this keyword."],
      };
    }

    const compat = validateComparisonSettings({
      extensionResult: ext,
      baselineRow: base,
      settings,
    });
    if (!compat.comparable) {
      return {
        keyword,
        manualRanking: manualRank,
        extensionRanking: extPositionDisplay,
        rankingDifference: null,
        manualRankingUrl: manualUrl,
        extensionRankingUrl: ext.rankingUrl || "",
        urlMatchStatus: "Not comparable",
        browserGpsStatus: ext.browserGpsStatus || "-",
        googleLocationStatus: ext.googleLocationStatus || "-",
        googleLocationSource: ext.googleLocationSource || "-",
        comparisonStatus: COMPARISON_STATUSES.NOT_COMPARABLE,
        notes: [...compat.incompatibilities, ...compat.warnings],
      };
    }

    // Comparable valid results: both are Ranked or confirmed NA.
    const extIsNa = extStatus === RANKING_STATUSES.NOT_FOUND;
    const manIsNa = manualRank === "NA";

    if (extIsNa && manIsNa) {
      return {
        keyword,
        manualRanking: "NA",
        extensionRanking: "NA",
        rankingDifference: 0,
        manualRankingUrl: manualUrl,
        extensionRankingUrl: "",
        urlMatchStatus: "Matched (NA)",
        browserGpsStatus: ext.browserGpsStatus || "-",
        googleLocationStatus: ext.googleLocationStatus || "-",
        googleLocationSource: ext.googleLocationSource || "-",
        comparisonStatus: COMPARISON_STATUSES.EXACT_MATCH,
        notes: compat.warnings,
      };
    }

    if (extIsNa || manIsNa) {
      return {
        keyword,
        manualRanking: manualRank,
        extensionRanking: extPositionDisplay,
        rankingDifference: null,
        manualRankingUrl: manualUrl,
        extensionRankingUrl: ext.rankingUrl || "",
        urlMatchStatus: "Mismatch",
        browserGpsStatus: ext.browserGpsStatus || "-",
        googleLocationStatus: ext.googleLocationStatus || "-",
        googleLocationSource: ext.googleLocationSource || "-",
        comparisonStatus: COMPARISON_STATUSES.RANKING_MISMATCH,
        notes: ["One method found a ranking while the other reported NA.", ...compat.warnings],
      };
    }

    const diff = Math.abs(ext.position - manualRank);
    const hasBothUrls = Boolean(manualUrl && ext.rankingUrl);
    const urlMatches = hasBothUrls
      ? normalizeComparableUrl(manualUrl) === normalizeComparableUrl(ext.rankingUrl)
      : !manualUrl && !ext.rankingUrl;

    const urlMatchStatus = !manualUrl
      ? "No baseline URL"
      : urlMatches
        ? "Match"
        : "Mismatch";

    let comparisonStatus;
    if (diff === 0) {
      comparisonStatus =
        manualUrl && !urlMatches
          ? COMPARISON_STATUSES.URL_MISMATCH
          : COMPARISON_STATUSES.EXACT_MATCH;
    } else if (diff <= safeTolerance) {
      comparisonStatus = COMPARISON_STATUSES.WITHIN_TOLERANCE;
    } else {
      comparisonStatus = COMPARISON_STATUSES.RANKING_MISMATCH;
    }

    return {
      keyword,
      manualRanking: manualRank,
      extensionRanking: ext.position,
      rankingDifference: diff,
      manualRankingUrl: manualUrl,
      extensionRankingUrl: ext.rankingUrl || "",
      urlMatchStatus,
      browserGpsStatus: ext.browserGpsStatus || "-",
      googleLocationStatus: ext.googleLocationStatus || "-",
      googleLocationSource: ext.googleLocationSource || "-",
      comparisonStatus,
      notes: compat.warnings,
    };
  });

  const metrics = computeAccuracyMetrics({
    rows: comparedRows,
    tolerance: safeTolerance,
  });

  return {
    generatedAt: new Date().toISOString(),
    tolerance: safeTolerance,
    settings,
    metrics,
    rows: comparedRows,
  };
}

