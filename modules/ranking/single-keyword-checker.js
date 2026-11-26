/**
 * Single Keyword Organic Ranking Checker combining Phase 2/3 location verification,
 * authorized SERP fetching (with pagination) or manual SERP HTML, and Stop support.
 */

import { getCountryPreset } from "../location/coordinate-validator.js";
import { GOOGLE_LOCATION_STATUSES, LOCATION_STATES } from "../location/location-state.js";
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

function buildResultRecord({
  keyword,
  targetWebsite,
  requestedDepth,
  locationState,
  status,
  position = null,
  rankingUrl = null,
  checkedResults = 0,
  resultsTable = [],
  errorDetails = null,
  startedAtMs,
}) {
  return {
    keyword: String(keyword || "").trim(),
    targetWebsite: String(targetWebsite || "").trim(),
    position,
    rankingUrl,
    checkedResults,
    requestedDepth,
    browserGpsStatus: locationState?.browserGpsStatus || LOCATION_STATES.NOT_CONFIGURED,
    googleLocationStatus: locationState?.googleLocationStatus || GOOGLE_LOCATION_STATUSES.UNVERIFIED,
    googleLocationSource: locationState?.googleLocationSource || null,
    googleDetectedLocation: locationState?.googleDetectedLocation || null,
    checkedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    status,
    errorDetails,
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

  // In-memory cancellation registry so Stop button cancels active async loops immediately.
  const activeJobs = new Map();

  async function isStopRequested(jobId) {
    if (activeJobs.get(jobId)?.stopRequested) return true;
    const state = await loadRankingState(storageClient);
    return Boolean(state.stopRequested || state.activeJobId !== jobId);
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

    const currentLocation = locationController
      ? await locationController.getStatus({ reverifyGps: false })
      : null;

    await saveRankingState(storageClient, {
      isRunning: true,
      activeJobId: jobId,
      stopRequested: false,
      lastResult: null,
    });

    try {
      // Mode 1: Manually supplied SERP HTML (1 or more pages)
      if (useManualHtml || (Array.isArray(manualSerpPages) && manualSerpPages.length > 0)) {
        const htmlPages = Array.isArray(manualSerpPages) && manualSerpPages.length > 0
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
            startedAtMs,
          });
          const saved = await saveRankingState(storageClient, {
            isRunning: false,
            activeJobId: null,
            stopRequested: false,
            lastResult: result,
          });
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
              startedAtMs,
            });
            const saved = await saveRankingState(storageClient, {
              isRunning: false,
              activeJobId: null,
              stopRequested: false,
              lastResult: stopped,
            });
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
          startedAtMs,
        });
        const saved = await saveRankingState(storageClient, {
          isRunning: false,
          activeJobId: null,
          stopRequested: false,
          lastResult: result,
        });
        return { ok: result.status === RANKING_STATUSES.RANKED, result, state: saved };
      }

      // Mode 2: Live authorized Google Search tab — require verified location first!
      const liveLocation = locationController
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
      }

      if (gateStatus) {
        const blockedResult = buildResultRecord({
          keyword: cleanKeyword,
          targetWebsite: cleanDomain,
          requestedDepth: depth,
          locationState: liveLocation,
          status: gateStatus,
          errorDetails: gateError,
          startedAtMs,
        });
        const saved = await saveRankingState(storageClient, {
          isRunning: false,
          activeJobId: null,
          stopRequested: false,
          lastResult: blockedResult,
        });
        return { ok: false, result: blockedResult, state: saved };
      }

      const tabId = liveLocation.tabId;
      const cfg = liveLocation.config;
      const parsedPages = [];
      let nextUrl = buildKeywordSearchUrl({
        keyword: cleanKeyword,
        googleDomain: cfg.googleDomain,
        country: cfg.country,
        language: cfg.language,
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
            startedAtMs,
          });
          const saved = await saveRankingState(storageClient, {
            isRunning: false,
            activeJobId: null,
            stopRequested: false,
            lastResult: stopped,
          });
          return { ok: false, result: stopped, state: saved };
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
            startedAtMs,
          });
          const saved = await saveRankingState(storageClient, {
            isRunning: false,
            activeJobId: null,
            stopRequested: false,
            lastResult: errResult,
          });
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
            startedAtMs,
          });
          const saved = await saveRankingState(storageClient, {
            isRunning: false,
            activeJobId: null,
            stopRequested: false,
            lastResult: stopped,
          });
          return { ok: false, result: stopped, state: saved };
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
            startedAtMs,
          });
          const saved = await saveRankingState(storageClient, {
            isRunning: false,
            activeJobId: null,
            stopRequested: false,
            lastResult: errResult,
          });
          return { ok: false, result: errResult, state: saved };
        }

        const snapshot = evalResponse?.result?.value;
        const parsed = parseGoogleSerpHtml({
          html: snapshot?.html || "",
          pageUrl: snapshot?.pageUrl || nextUrl,
        });

        if (parsed.blocked || parsed.parsingError) {
          parsedPages.push({ ...parsed, pageNumber });
          break;
        }

        parsedPages.push({ ...parsed, pageNumber });
        collectedCount += parsed.results.length;

        // Early check: if target already ranked on this page, stop paginating immediately
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
            startedAtMs,
          });
          const saved = await saveRankingState(storageClient, {
            isRunning: false,
            activeJobId: null,
            stopRequested: false,
            lastResult: result,
          });
          return { ok: true, result, state: saved };
        }

        if (collectedCount < depth && !parsed.nextPageUrl && !parsed.confirmedEmpty) {
          // If fewer results were returned than requested and there is no next page,
          // mark incomplete only if Google returned 0 results without confirmedEmpty.
          if (parsed.results.length === 0) {
            incompleteReason = "Google returned zero extractable organic results.";
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
        startedAtMs,
      });

      const saved = await saveRankingState(storageClient, {
        isRunning: false,
        activeJobId: null,
        stopRequested: false,
        lastResult: finalResult,
      });
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
