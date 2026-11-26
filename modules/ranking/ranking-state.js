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
  };
}

export async function saveRankingState(storageClient, nextState) {
  const normalized = {
    ...createDefaultRankingState(),
    ...nextState,
  };
  await storageClient.set({ [RANKING_STORAGE_KEY]: normalized });
  return normalized;
}

export async function clearRankingState(storageClient) {
  return saveRankingState(storageClient, createDefaultRankingState());
}
