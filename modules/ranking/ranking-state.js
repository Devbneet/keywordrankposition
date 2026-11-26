/**
 * Persistent state and job interruption control for Single Keyword Ranking checks.
 */

export const RANKING_STATUSES = Object.freeze({
  RANKED: "Ranked",
  NOT_FOUND: "Not found within verified search depth",
  INCOMPLETE_SEARCH: "Incomplete search",
  LOCATION_UNVERIFIED: "Location unverified",
  LOCATION_MISMATCH: "Location mismatch",
  SEARCH_BLOCKED: "Search blocked",
  PERMISSION_DENIED: "Permission denied",
  PARSING_ERROR: "Parsing error",
  NETWORK_ERROR: "Network error",
  STOPPED_BY_USER: "Stopped by user",
});

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
