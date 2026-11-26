/**
 * Single Keyword Organic Ranking Checker combining Phase 2/3 location verification,
 * live GPS + Google location re-verification during checks, authorized SERP fetching
 * (with pagination) or manual SERP HTML, and Stop support.
 */

import { getCountryPreset } from "../location/coordinate-validator.js";
import { verifyBrowserGeolocation } from "../location/geolocation-verifier.js";
import { inspectGoogleSearchHtml } from "../location/google-location-verifier.js";
import {
  GOOGLE_LOCATION_STATUSES,
  hasConfigChanged,
  LOCATION_STATES,
} from "../location/location-state.js";
import { normalizeDomain } from "./domain-matcher.js";
import { parseGoogleSerpHtml } from "./organic-parser.js";
import { calculateOrganicRanking } from "./ranking-calculator.js";
import {
  clearRankingState,
  loadRankingState,
  RANKING_STATUSES,
  saveRankingState,
  SUPPORTED_SEARCH_DEPTHS,
} from "./ranking-state.js";

const DEFAULT_MAX_LOCATION_AGE_MS = 15 * 60 * 1000;

function buildKeywordSearchUrl({
  keyword,
  googleDomain = "google.com.au",
  country = "Australia",
  language = "en-AU",
}) {
  const preset = getCountryPreset(country);
  const domain = String(googleDomain || preset.googleDomain).trim().toLowerCase().replace(/^www\./, "");
  const q = encodeURIComponent(String(keyword).trim());
  const hl = encodeURIComponent(String(language || preset.defaultLanguage).trim() || "en");
  const gl = encodeURIComponent(preset.code);
  return `https://www.${domain}/search?q=${q}&hl=${hl}&gl=${gl}`;
}

function isLocationVerificationStale(locationState, maxAgeMs = DEFAULT_MAX_LOCATION_AGE_MS) {
  if (!locationState?.googleLastVerifiedAt || !locationState?.lastVerifiedAt) {
    return true;
  }
  const googleTime = Date.parse(locationState.googleLastVerifiedAt);
  const gpsTime = Date.parse(locationState.lastVerifiedAt);
  if (!Number.isFinite(googleTime) || !Number.isFinite(gpsTime)) {
    return true;
  }
  const now = Date.now();
  return now - googleTime > maxAgeMs || now - gpsTime > maxAgeMs;
}

function buildResultRecord({
  keyword,
  targetWebsite,
  requestedDepth,
  locationState,
  status,
  position = null,
  rankingUrl = null,
  checkedResults = 0,
  verifiedEndOfResults = false,
  resultsTable = [],
  errorDetails = null,
  sourceMode = "live_google",
  deviceType = "Desktop",
  startedAtMs,
}) {
  const isManual = sourceMode === "manual_html";
  return {
    keyword: String(keyword || "").trim(),
    targetWebsite: String(targetWebsite || "").trim(),
    position,
    rankingUrl,
    checkedResults,
    requestedDepth,
    verifiedEndOfResults,
    sourceMode,
    isLiveVerified: !isManual && status !== RANKING_STATUSES.LOCATION_UNVERIFIED && status !== RANKING_STATUSES.LOCATION_MISMATCH,
    sourceLabel: isManual ? "Manual SERP HTML (Not Live Verified)" : "Live Google Search (Authorized)",
    deviceType,
    configSnapshot: locationState?.config ? { ...locationState.config } : null,
    browserGpsStatus: isManual
      ? "Not used (Manual SERP HTML)"
      : locationState?.browserGpsStatus || LOCATION_STATES.NOT_CONFIGURED,
    googleLocationStatus: isManual
      ? "Not verified (Manual SERP HTML)"
      : locationState?.googleLocationStatus || GOOGLE_LOCATION_STATUSES.UNVERIFIED,
    googleLocationSource: isManual ? "Manual HTML upload/paste" : locationState?.googleLocationSource || null,
    googleLocationSourceType: isManual ? "manual" : locationState?.googleLocationSourceType || null,
    googleMatchType: isManual ? "none" : locationState?.googleMatchType || "none",
    googleDetectedLocation: isManual ? null : locationState?.googleDetectedLocation || null,
    checkedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    status,
    errorDetails,
    invalidatedByLocationChange: false,
    resultsTable,
  };
}

async function waitForTabComplete({ tabId, chromeApi, timeoutMs = 12000 }) {
  try {
    const tab = await chromeApi.tabs.get(tabId);
    if (tab?.status === "complete") return;
  } catch {
    return;
  }
  if (!chromeApi?.tabs?.onUpdated?.addListener) return;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chromeApi.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chromeApi.tabs.onUpdated.addListener(onUpdated);
  });
}

export function createSingleKeywordChecker({
  chromeApi = globalThis.chrome,
  storageClient,
  locationController,
}) {
  if (!storageClient) {
    throw new Error("storageClient is required for createSingleKeywordChecker.");
  }

  const activeJobs = new Map();

  async function isStopRequested(jobId) {
    if (activeJobs.get(jobId)?.stopRequested) return true;
    const state = await loadRankingState(storageClient);
    return Boolean(state.stopRequested || state.activeJobId !== jobId);
  }

  async function persistFinalResult(result) {
    const existing = await loadRankingState(storageClient);
    const nextRecent = [result, ...existing.recentResults].slice(0, 50);
    return saveRankingState(storageClient, {
      isRunning: false,
      activeJobId: null,
      stopRequested: false,
      lastResult: result,
      recentResults: nextRecent,
    });
  }

  async function getState() {
    return loadRankingState(storageClient);
  }

  async function clearResults() {
    const cleared = await clearRankingState(storageClient);
    return { ok: true, state: cleared };
  }

  async function stopCheck() {
    for (const entry of activeJobs.values()) {
      entry.stopRequested = true;
    }
    const current = await loadRankingState(storageClient);
    const next = await saveRankingState(storageClient, {
      ...current,
      stopRequested: true,
    });
    return { ok: true, state: next };
  }

  async function checkRanking({
    websiteDomain,
    keyword,
    searchDepth = 50,
    manualSerpHtml = "",
    manualSerpPages = null,
    useManualHtml = false,
    deviceType = "Desktop",
    maxLocationAgeMs = DEFAULT_MAX_LOCATION_AGE_MS,
  } = {}) {
    const startedAtMs = Date.now();
    const depth = Number(searchDepth) || 50;
    const cleanDomain = normalizeDomain(websiteDomain);
    const cleanKeyword = String(keyword || "").trim();

    if (!cleanDomain) {
      return {
        ok: false,
        error: "Please enter a valid target website domain (e.g. example.com).",
      };
    }
    if (!cleanKeyword) {
      return {
        ok: false,
        error: "Please enter a target keyword.",
      };
    }
    if (!SUPPORTED_SEARCH_DEPTHS.includes(depth)) {
      return {
        ok: false,
        error: `Search depth must be one of ${SUPPORTED_SEARCH_DEPTHS.join(", ")}.`,
      };
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    activeJobs.set(jobId, { stopRequested: false });

    const existingRankingState = await loadRankingState(storageClient);
    const currentLocation = locationController
      ? await locationController.getStatus({ reverifyGps: false })
      : null;

    await saveRankingState(storageClient, {
      ...existingRankingState,
      isRunning: true,
      activeJobId: jobId,
      stopRequested: false,
      lastResult: null,
    });

    try {
      // Mode 1: Manually supplied SERP HTML (explicitly marked as non-live-verified)
      if (useManualHtml || (Array.isArray(manualSerpPages) && manualSerpPages.length > 0)) {
        const htmlPages =
          Array.isArray(manualSerpPages) && manualSerpPages.length > 0
            ? manualSerpPages
            : [String(manualSerpHtml || "")];

        if (htmlPages.every((h) => !String(h || "").trim())) {
          const result = buildResultRecord({
            keyword: cleanKeyword,
            targetWebsite: cleanDomain,
            requestedDepth: depth,
            locationState: currentLocation,
            status: RANKING_STATUSES.PARSING_ERROR,
            errorDetails: "Manual SERP HTML is empty.",
            sourceMode: "manual_html",
            deviceType,
            startedAtMs,
          });
          const saved = await persistFinalResult(result);
          return { ok: false, result, state: saved };
        }

        const parsedPages = [];
        for (let i = 0; i < htmlPages.length; i += 1) {
          if (await isStopRequested(jobId)) {
            const stopped = buildResultRecord({
              keyword: cleanKeyword,
              targetWebsite: cleanDomain,
              requestedDepth: depth,
              locationState: currentLocation,
              status: RANKING_STATUSES.STOPPED_BY_USER,
              errorDetails: "Ranking check was stopped by user.",
              sourceMode: "manual_html",
              deviceType,
              startedAtMs,
            });
            const saved = await persistFinalResult(stopped);
            return { ok: false, result: stopped, state: saved };
          }
          const parsed = parseGoogleSerpHtml({ html: htmlPages[i] });
          parsedPages.push({ ...parsed, pageNumber: i + 1 });
        }

        const hasUnconfirmedEmpty = parsedPages.some(
          (p) => !p.blocked && !p.parsingError && p.results.length === 0 && !p.confirmedEmpty
        );
        const calc = calculateOrganicRanking({
          pages: parsedPages,
          targetDomain: cleanDomain,
          requestedDepth: depth,
          incompleteReason: hasUnconfirmedEmpty
            ? "SERP HTML yielded zero extractable organic results."
            : null,
        });

        const result = buildResultRecord({
          keyword: cleanKeyword,
          targetWebsite: cleanDomain,
          requestedDepth: depth,
          locationState: currentLocation,
          ...calc,
          sourceMode: "manual_html",
          deviceType,
          startedAtMs,
        });
        const saved = await persistFinalResult(result);
        return { ok: result.status === RANKING_STATUSES.RANKED, result, state: saved };
      }

      // Mode 2: Live authorized Google Search tab — enforce fresh location verification gate!
      let liveLocation = locationController
        ? await locationController.getStatus({ reverifyGps: true })
        : null;

      let gateStatus = null;
      let gateError = null;

      if (!liveLocation || !liveLocation.config || !liveLocation.debuggerAttached || liveLocation.tabId === null) {
        gateStatus = RANKING_STATUSES.LOCATION_UNVERIFIED;
        gateError = "Active location session is required. Apply and verify Google location first.";
      } else if (liveLocation.browserGpsStatus === LOCATION_STATES.PERMISSION_DENIED) {
        gateStatus = RANKING_STATUSES.PERMISSION_DENIED;
        gateError = liveLocation.lastError || "Browser geolocation permission was denied.";
      } else if (liveLocation.browserGpsStatus === LOCATION_STATES.LOCATION_MISMATCH) {
        gateStatus = RANKING_STATUSES.LOCATION_MISMATCH;
        gateError = liveLocation.lastError || "Browser GPS coordinates do not match configured location.";
      } else if (liveLocation.browserGpsStatus !== LOCATION_STATES.GPS_VERIFIED) {
        gateStatus = RANKING_STATUSES.LOCATION_UNVERIFIED;
        gateError = liveLocation.lastError || "Browser GPS is not verified.";
      } else if (liveLocation.googleLocationStatus === GOOGLE_LOCATION_STATUSES.SEARCH_BLOCKED) {
        gateStatus = RANKING_STATUSES.SEARCH_BLOCKED;
        gateError = liveLocation.lastError || "Google Search returned a CAPTCHA or access restriction.";
      } else if (liveLocation.googleLocationStatus === GOOGLE_LOCATION_STATUSES.MISMATCH) {
        gateStatus = RANKING_STATUSES.LOCATION_MISMATCH;
        gateError = liveLocation.lastError || "Google-detected location does not match target location.";
      } else if (liveLocation.googleLocationStatus !== GOOGLE_LOCATION_STATUSES.MATCHED) {
        gateStatus = RANKING_STATUSES.LOCATION_UNVERIFIED;
        gateError = "Google search location is not verified. Click Verify Google Location first.";
      } else if (isLocationVerificationStale(liveLocation, maxLocationAgeMs)) {
        gateStatus = RANKING_STATUSES.LOCATION_UNVERIFIED;
        gateError = "Location verification is stale. Re-verify Google location before checking rankings.";
      }

      if (gateStatus) {
        const blockedResult = buildResultRecord({
          keyword: cleanKeyword,
          targetWebsite: cleanDomain,
          requestedDepth: depth,
          locationState: liveLocation,
          status: gateStatus,
          errorDetails: gateError,
          sourceMode: "live_google",
          deviceType,
          startedAtMs,
        });
        const saved = await persistFinalResult(blockedResult);
        return { ok: false, result: blockedResult, state: saved };
      }

      const initialConfig = { ...liveLocation.config };
      const tabId = liveLocation.tabId;
      const parsedPages = [];
      let nextUrl = buildKeywordSearchUrl({
        keyword: cleanKeyword,
        googleDomain: initialConfig.googleDomain,
        country: initialConfig.country,
        language: initialConfig.language,
      });
      let collectedCount = 0;
      let pageNumber = 1;
      let incompleteReason = null;

      while (nextUrl && collectedCount < depth) {
        if (await isStopRequested(jobId)) {
          const stopped = buildResultRecord({
            keyword: cleanKeyword,
            targetWebsite: cleanDomain,
            requestedDepth: depth,
            locationState: liveLocation,
            status: RANKING_STATUSES.STOPPED_BY_USER,
            checkedResults: collectedCount,
            errorDetails: "Ranking check was stopped by user.",
            sourceMode: "live_google",
            deviceType,
            startedAtMs,
          });
          const saved = await persistFinalResult(stopped);
          return { ok: false, result: stopped, state: saved };
        }

        // Detect unexpected config change mid-job
        if (locationController) {
          const latestStatus = await locationController.getStatus({ reverifyGps: false });
          if (!latestStatus.config || hasConfigChanged(initialConfig, latestStatus.config)) {
            const invalidated = buildResultRecord({
              keyword: cleanKeyword,
              targetWebsite: cleanDomain,
              requestedDepth: depth,
              locationState: latestStatus,
              status: RANKING_STATUSES.LOCATION_UNVERIFIED,
              checkedResults: collectedCount,
              errorDetails: "Location configuration changed during ranking check.",
              sourceMode: "live_google",
              deviceType,
              startedAtMs,
            });
            const saved = await persistFinalResult(invalidated);
            return { ok: false, result: invalidated, state: saved };
          }
        }

        try {
          await chromeApi.tabs.update(tabId, { url: nextUrl, active: true });
          await waitForTabComplete({ tabId, chromeApi });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const status =
            parsedPages.length > 0
              ? RANKING_STATUSES.INCOMPLETE_SEARCH
              : RANKING_STATUSES.NETWORK_ERROR;
          const partialCalc =
            parsedPages.length > 0
              ? calculateOrganicRanking({
                  pages: parsedPages,
                  targetDomain: cleanDomain,
                  requestedDepth: depth,
                  incompleteReason: `Failed loading page ${pageNumber}: ${msg}`,
                })
              : null;

          const errResult = buildResultRecord({
            keyword: cleanKeyword,
            targetWebsite: cleanDomain,
            requestedDepth: depth,
            locationState: liveLocation,
            ...(partialCalc || {}),
            status,
            errorDetails: `Failed loading search page ${pageNumber}: ${msg}`,
            sourceMode: "live_google",
            deviceType,
            startedAtMs,
          });
          const saved = await persistFinalResult(errResult);
          return { ok: false, result: errResult, state: saved };
        }

        if (await isStopRequested(jobId)) {
          const stopped = buildResultRecord({
            keyword: cleanKeyword,
            targetWebsite: cleanDomain,
            requestedDepth: depth,
            locationState: liveLocation,
            status: RANKING_STATUSES.STOPPED_BY_USER,
            checkedResults: collectedCount,
            errorDetails: "Ranking check was stopped by user.",
            sourceMode: "live_google",
            deviceType,
            startedAtMs,
          });
          const saved = await persistFinalResult(stopped);
          return { ok: false, result: stopped, state: saved };
        }

        // Re-verify browser GPS during the ranking check on the loaded SERP page
        const midGpsCheck = await verifyBrowserGeolocation({
          tabId,
          expectedLatitude: initialConfig.latitude,
          expectedLongitude: initialConfig.longitude,
          chromeApi,
        });
        if (midGpsCheck.state !== LOCATION_STATES.GPS_VERIFIED) {
          const status =
            midGpsCheck.state === LOCATION_STATES.PERMISSION_DENIED
              ? RANKING_STATUSES.PERMISSION_DENIED
              : midGpsCheck.state === LOCATION_STATES.LOCATION_MISMATCH
                ? RANKING_STATUSES.LOCATION_MISMATCH
                : RANKING_STATUSES.LOCATION_UNVERIFIED;
          const gpsFailResult = buildResultRecord({
            keyword: cleanKeyword,
            targetWebsite: cleanDomain,
            requestedDepth: depth,
            locationState: { ...liveLocation, browserGpsStatus: midGpsCheck.state },
            status,
            checkedResults: collectedCount,
            errorDetails:
              midGpsCheck.state === LOCATION_STATES.DEBUGGER_DISCONNECTED
                ? `Debugger disconnected: ${midGpsCheck.lastError}`
                : midGpsCheck.lastError || `Browser GPS check returned '${midGpsCheck.state}'.`,
            sourceMode: "live_google",
            deviceType,
            startedAtMs,
          });
          const saved = await persistFinalResult(gpsFailResult);
          return { ok: false, result: gpsFailResult, state: saved };
        }

        let evalResponse;
        try {
          evalResponse = await chromeApi.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: `({ html: document.documentElement ? document.documentElement.outerHTML : "", pageUrl: window.location.href })`,
            returnByValue: true,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const detached = /detach|target closed|no tab|not attached/i.test(msg);
          const calc =
            parsedPages.length > 0
              ? calculateOrganicRanking({
                  pages: parsedPages,
                  targetDomain: cleanDomain,
                  requestedDepth: depth,
                  incompleteReason: msg,
                })
              : null;

          const errResult = buildResultRecord({
            keyword: cleanKeyword,
            targetWebsite: cleanDomain,
            requestedDepth: depth,
            locationState: liveLocation,
            ...(calc || {}),
            status: detached ? RANKING_STATUSES.LOCATION_UNVERIFIED : RANKING_STATUSES.INCOMPLETE_SEARCH,
            errorDetails: detached ? `Debugger disconnected: ${msg}` : msg,
            sourceMode: "live_google",
            deviceType,
            startedAtMs,
          });
          const saved = await persistFinalResult(errResult);
          return { ok: false, result: errResult, state: saved };
        }

        const snapshot = evalResponse?.result?.value;
        const pageHtml = snapshot?.html || "";
        const pageHref = snapshot?.pageUrl || nextUrl;

        // Parse SERP first so CAPTCHA/block stops immediately
        const parsed = parseGoogleSerpHtml({ html: pageHtml, pageUrl: pageHref });
        if (parsed.blocked) {
          parsedPages.push({ ...parsed, pageNumber });
          break;
        }
        if (parsed.parsingError) {
          parsedPages.push({ ...parsed, pageNumber });
          break;
        }

        // Re-verify Google's displayed location on this SERP page if footer location is present
        const googleFooterCheck = inspectGoogleSearchHtml({
          html: pageHtml,
          pageUrl: pageHref,
          targetCity: initialConfig.targetCity || initialConfig.locationName,
          targetCountry: initialConfig.country,
        });
        if (googleFooterCheck.status === GOOGLE_LOCATION_STATUSES.MISMATCH) {
          const mismatchResult = buildResultRecord({
            keyword: cleanKeyword,
            targetWebsite: cleanDomain,
            requestedDepth: depth,
            locationState: {
              ...liveLocation,
              googleLocationStatus: googleFooterCheck.status,
              googleDetectedLocation: googleFooterCheck.detectedLocation,
              googleLocationSource: googleFooterCheck.locationSource,
              googleLocationSourceType: googleFooterCheck.locationSourceType,
              googleMatchType: googleFooterCheck.matchType,
            },
            status: RANKING_STATUSES.LOCATION_MISMATCH,
            checkedResults: collectedCount,
            errorDetails: googleFooterCheck.error,
            sourceMode: "live_google",
            deviceType,
            startedAtMs,
          });
          const saved = await persistFinalResult(mismatchResult);
          return { ok: false, result: mismatchResult, state: saved };
        }
        if (googleFooterCheck.status === GOOGLE_LOCATION_STATUSES.MATCHED) {
          liveLocation = {
            ...liveLocation,
            googleLocationStatus: googleFooterCheck.status,
            googleDetectedLocation: googleFooterCheck.detectedLocation,
            googleLocationSource: googleFooterCheck.locationSource,
            googleLocationSourceType: googleFooterCheck.locationSourceType,
            googleMatchType: googleFooterCheck.matchType,
          };
        }

        parsedPages.push({ ...parsed, pageNumber });
        collectedCount += parsed.results.length;

        const interim = calculateOrganicRanking({
          pages: parsedPages,
          targetDomain: cleanDomain,
          requestedDepth: depth,
        });
        if (interim.status === RANKING_STATUSES.RANKED) {
          const result = buildResultRecord({
            keyword: cleanKeyword,
            targetWebsite: cleanDomain,
            requestedDepth: depth,
            locationState: liveLocation,
            ...interim,
            sourceMode: "live_google",
            deviceType,
            startedAtMs,
          });
          const saved = await persistFinalResult(result);
          return { ok: true, result, state: saved };
        }

        if (collectedCount < depth && !parsed.nextPageUrl) {
          if (!parsed.endOfResultsVerified) {
            incompleteReason = "Search ended before reaching requested depth without verified end of results.";
          }
          break;
        }

        nextUrl = parsed.nextPageUrl;
        pageNumber += 1;
      }

      const finalCalc = calculateOrganicRanking({
        pages: parsedPages,
        targetDomain: cleanDomain,
        requestedDepth: depth,
        incompleteReason,
      });

      const finalResult = buildResultRecord({
        keyword: cleanKeyword,
        targetWebsite: cleanDomain,
        requestedDepth: depth,
        locationState: liveLocation,
        ...finalCalc,
        sourceMode: "live_google",
        deviceType,
        startedAtMs,
      });

      const saved = await persistFinalResult(finalResult);
      return { ok: finalResult.status === RANKING_STATUSES.RANKED, result: finalResult, state: saved };
    } finally {
      activeJobs.delete(jobId);
    }
  }

  return {
    getState,
    clearResults,
    stopCheck,
    checkRanking,
  };
}
