/**
 * Persistent state and job interruption control for Single Keyword Ranking checks.
 */

export const CANONICAL_RESULT_SCHEMA_VERSION = 2;

export const RANKING_STATUSES = Object.freeze({
  RANKED: "Ranked",
  NOT_FOUND: "Not found within verified search depth",
  INCOMPLETE_SEARCH: "Incomplete search",
  LOCATION_UNVERIFIED: "Location unverified",
  LOCATION_MISMATCH: "Location mismatch",
  SEARCH_BLOCKED: "Search blocked",
  CAPTCHA_DETECTED: "CAPTCHA detected",
  PERMISSION_DENIED: "Permission denied",
  PARSING_ERROR: "Parsing error",
  NETWORK_ERROR: "Network error",
  AUTHENTICATION_REQUIRED: "Authentication required",
  DEBUGGER_DISCONNECTED: "Debugger disconnected",
  TAB_CLOSED: "Tab closed",
  STORAGE_FAILURE: "Storage failure",
  PENDING: "Pending",
  RUNNING: "Running",
  PAUSED: "Paused",
  STOPPED_BY_USER: "Stopped by user",
  INTERRUPTED: "Interrupted",
  RECOVERY_REQUIRED: "Recovery required",
});

/**
 * Strict positive verification check (never defaults missing/undefined to verified).
 */
export function isCanonicalLiveVerified(record) {
  if (!record || typeof record !== "object") return false;
  if (record.sourceMode === "manual_html" || record.source === "manual_html" || record.useManualHtml) {
    return false;
  }
  if (record.isMock || record.isAccuracyFixture) return false;
  if (record.invalidatedByLocationChange) return false;
  return Boolean(
    record.isLiveVerified === true &&
      record.verificationEligibility === true &&
      record.browserGpsStatus === "GPS verified" &&
      record.googleLocationStatus === "Google location matched" &&
      record.googleLocationSourceType === "device"
  );
}

/**
 * Canonical ranking result schema shared across single, bulk, scheduler, history, and Sheets.
 */
export function createCanonicalRankingResult(input = {}) {
  const sourceMode = input.sourceMode || input.source || "live_google";
  const actualVerifiedDepth = Number(
    input.actualVerifiedDepth ?? input.checkedResults ?? input.checkedResultsCount ?? input.actualResultsChecked ?? 0
  );
  const verifiedEndOfResults = Boolean(input.verifiedEndOfResults ?? input.endOfResultsVerified);
  const isManual = sourceMode === "manual_html";
  const hasPositiveLocation =
    !isManual &&
    !input.isMock &&
    !input.isAccuracyFixture &&
    input.browserGpsStatus === "GPS verified" &&
    input.googleLocationStatus === "Google location matched" &&
    input.googleLocationSourceType === "device" &&
    !input.invalidatedByLocationChange;

  const isLiveVerified = Boolean(
    hasPositiveLocation &&
      input.isLiveVerified === true &&
      (input.status === RANKING_STATUSES.RANKED || input.status === RANKING_STATUSES.NOT_FOUND)
  );

  return {
    schemaVersion: CANONICAL_RESULT_SCHEMA_VERSION,
    resultId: input.resultId || null,
    clientId: input.clientId || null,
    locationId: input.locationId || null,
    keywordId: input.keywordId || null,
    jobId: input.jobId || null,
    taskId: input.taskId || null,
    spreadsheetId: input.spreadsheetId || null,
    worksheetId: input.worksheetId ?? null,
    rowPosition: input.rowPosition ?? null,
    keyword: String(input.keyword || input.keywordText || "").trim(),
    targetDomain: String(input.targetDomain || input.targetWebsite || "").trim(),
    position: typeof input.position === "number" ? input.position : null,
    rankingUrl: input.rankingUrl || null,
    requestedDepth: Number(input.requestedDepth) || 50,
    actualVerifiedDepth,
    checkedResults: actualVerifiedDepth,
    verifiedEndOfResults,
    endOfResultsEvidence: input.endOfResultsEvidence || (verifiedEndOfResults ? "verified" : "none"),
    browserGpsStatus: input.browserGpsStatus || null,
    googleLocationStatus: input.googleLocationStatus || null,
    googleLocationSource: input.googleLocationSource || null,
    googleLocationSourceType: input.googleLocationSourceType || null,
    googleMatchType: input.googleMatchType || "none",
    googleDetectedLocation: input.googleDetectedLocation || null,
    locationFingerprint: input.locationFingerprint || null,
    deviceType: input.deviceType || "Desktop",
    country: input.country || null,
    language: input.language || null,
    googleDomain: input.googleDomain || null,
    sourceMode,
    verificationEligibility: isLiveVerified,
    isLiveVerified,
    status: input.status || RANKING_STATUSES.INCOMPLETE_SEARCH,
    checkedAt: input.checkedAt || new Date().toISOString(),
    errorCode: input.errorCode || null,
    errorDetails: input.errorDetails || null,
    invalidatedByLocationChange: Boolean(input.invalidatedByLocationChange),
  };
}

export const SUPPORTED_SEARCH_DEPTHS = Object.freeze([10, 20, 30, 50, 100]);

export const RANKING_STORAGE_KEY = "dm_last_ranking_result";

export function createDefaultRankingState() {
  return {
    isRunning: false,
    activeJobId: null,
    stopRequested: false,
    lastResult: null,
    recentResults: [],
  };
}

export async function loadRankingState(storageClient) {
  const res = await storageClient.get(RANKING_STORAGE_KEY);
  const saved = res?.[RANKING_STORAGE_KEY];
  if (!saved || typeof saved !== "object") {
    return createDefaultRankingState();
  }
  return {
    ...createDefaultRankingState(),
    ...saved,
    recentResults: Array.isArray(saved.recentResults) ? saved.recentResults : [],
  };
}

export async function saveRankingState(storageClient, nextState) {
  const normalized = {
    ...createDefaultRankingState(),
    ...nextState,
    recentResults: Array.isArray(nextState?.recentResults) ? nextState.recentResults : [],
  };
  await storageClient.set({ [RANKING_STORAGE_KEY]: normalized });
  return normalized;
}

export async function clearRankingState(storageClient) {
  return saveRankingState(storageClient, createDefaultRankingState());
}

/**
 * Mark saved live ranking results as invalidated if location changes unexpectedly.
 */
export async function invalidateRankingResultsOnLocationChange(storageClient, reason) {
  const current = await loadRankingState(storageClient);
  if (!current.lastResult && current.recentResults.length === 0) {
    return current;
  }

  const markInvalid = (item) => {
    if (!item || item.sourceMode === "manual_html") return item;
    return {
      ...item,
      invalidatedByLocationChange: true,
      invalidationReason: reason || "Location session changed or detached.",
    };
  };

  return saveRankingState(storageClient, {
    ...current,
    lastResult: markInvalid(current.lastResult),
    recentResults: current.recentResults.map(markInvalid),
  });
}
