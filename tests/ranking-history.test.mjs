import assert from "node:assert/strict";
import test from "node:test";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createHistoryStorage } from "../modules/history/history-storage.js";
import { calculateRankingMovement, MOVEMENT_TYPES } from "../modules/history/ranking-comparison.js";
import {
  buildCurrentAndPreviousSnapshots,
  buildKeywordTrendSeries,
  compareTwoReportingDates,
} from "../modules/history/ranking-history.js";
import { computeAgencyOverviewMetrics, computeClientDashboardMetrics } from "../modules/history/ranking-metrics.js";
import { TASK_STATUSES } from "../modules/jobs/job-state.js";

function createInMemoryStorage() {
  const map = new Map();
  return {
    async get(keys) {
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (map.has(k)) out[k] = structuredClone(map.get(k));
        return out;
      }
      if (typeof keys === "string") {
        return map.has(keys) ? { [keys]: structuredClone(map.get(keys)) } : {};
      }
      return Object.fromEntries([...map.entries()].map(([k, v]) => [k, structuredClone(v)]));
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

test("calculateRankingMovement computes Improved, Declined, Unchanged, New, Lost, excludes failed checks, and prevents incompatible comparisons", () => {
  const base = { clientId: "c1", locationId: "l1", deviceType: "Desktop", requestedDepth: 50 };

  assert.equal(
    calculateRankingMovement(
      { ...base, resultStatus: TASK_STATUSES.RANKED, rankingPosition: 12 },
      { ...base, resultStatus: TASK_STATUSES.RANKED, rankingPosition: 5 }
    ).movementType,
    MOVEMENT_TYPES.IMPROVED
  );
  assert.equal(
    calculateRankingMovement(
      { ...base, resultStatus: TASK_STATUSES.RANKED, rankingPosition: 3 },
      { ...base, resultStatus: TASK_STATUSES.RANKED, rankingPosition: 8 }
    ).delta,
    -5
  );
  assert.equal(
    calculateRankingMovement(
      { ...base, resultStatus: TASK_STATUSES.RANKED, rankingPosition: 4 },
      { ...base, resultStatus: TASK_STATUSES.RANKED, rankingPosition: 4 }
    ).movementType,
    MOVEMENT_TYPES.UNCHANGED
  );
  assert.equal(
    calculateRankingMovement(
      { ...base, resultStatus: TASK_STATUSES.NOT_FOUND },
      { ...base, resultStatus: TASK_STATUSES.RANKED, rankingPosition: 15 }
    ).movementType,
    MOVEMENT_TYPES.NEW_RANKING
  );
  assert.equal(
    calculateRankingMovement(
      { ...base, resultStatus: TASK_STATUSES.RANKED, rankingPosition: 8 },
      { ...base, resultStatus: TASK_STATUSES.NOT_FOUND }
    ).movementType,
    MOVEMENT_TYPES.LOST_RANKING
  );

  // Blocked / CAPTCHA NEVER treated as Lost ranking!
  const blocked = calculateRankingMovement(
    { ...base, resultStatus: TASK_STATUSES.RANKED, rankingPosition: 8 },
    { ...base, resultStatus: TASK_STATUSES.SEARCH_BLOCKED }
  );
  assert.equal(blocked.movementType, MOVEMENT_TYPES.FAILED_EXCLUDED);

  // Missing baseline distinct from Not found
  const noHist = calculateRankingMovement(null, { ...base, resultStatus: TASK_STATUSES.NOT_FOUND });
  assert.equal(noHist.movementType, MOVEMENT_TYPES.MISSING_HISTORY);

  // Incompatible client/location/depth rejected
  const diffDepth = calculateRankingMovement(
    { ...base, resultStatus: TASK_STATUSES.RANKED, rankingPosition: 8, requestedDepth: 20 },
    { ...base, resultStatus: TASK_STATUSES.RANKED, rankingPosition: 5, requestedDepth: 50 }
  );
  assert.equal(diffDepth.movementType, MOVEMENT_TYPES.INCOMPATIBLE);
});

test("historyStorage migrates legacy client_results idempotently, preserves history, separates manual HTML, builds trend series & overview KPIs", async () => {
  const storageClient = createInMemoryStorage();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });
  const historyStorage = createHistoryStorage({ storageClient, idbFactory: null });

  await clientStorage.saveClient({ clientId: "c1", clientName: "Acme", websiteDomain: "acme.com", status: "active" });
  await clientStorage.saveClient({ clientId: "c2", clientName: "Bella", websiteDomain: "bella.com", status: "active" });
  await clientStorage.saveLocation({ locationId: "loc1", clientId: "c1", locationName: "Sydney" });
  await clientStorage.saveKeywordsBulk([
    { keywordId: "k1", clientId: "c1", keyword: "powder coating", active: true },
    { keywordId: "k2", clientId: "c1", keyword: "metal finishing", active: true },
  ]);

  // Seed a legacy result & migrate
  await clientStorage.saveResultsBatch([
    {
      taskId: "t_old",
      jobId: "j_1",
      clientId: "c1",
      locationId: "loc1",
      keywordId: "k1",
      keyword: "powder coating",
      status: TASK_STATUSES.RANKED,
      position: 12,
      rankingUrl: "https://acme.com/powder",
      checkedAt: "2026-11-23T05:00:00.000Z",
      isLiveVerified: true,
    },
  ]);

  const clients = await clientStorage.listClients();
  const mig1 = await historyStorage.migrateLegacyResultsToHistory({ clients, clientStorage });
  assert.equal(mig1.ok, true);
  assert.equal(mig1.migratedCount, 1);

  // Re-running migration stays idempotent (0 duplicates)
  const mig2 = await historyStorage.migrateLegacyResultsToHistory({ clients, clientStorage });
  assert.equal(mig2.migratedCount, 0);

  // Add second reporting date + a failed check + a manual HTML result
  await historyStorage.saveRankingHistoryBatch([
    {
      resultId: "r_nov30_k1",
      clientId: "c1",
      locationId: "loc1",
      keywordId: "k1",
      keywordText: "powder coating",
      resultStatus: TASK_STATUSES.RANKED,
      rankingPosition: 5,
      rankingUrl: "https://acme.com/powder",
      isLiveVerified: true,
      sourceMode: "live_bulk",
      timestamp: "2026-11-30T05:00:00.000Z",
    },
    {
      resultId: "r_nov25_fail",
      clientId: "c1",
      locationId: "loc1",
      keywordId: "k2",
      keywordText: "metal finishing",
      resultStatus: TASK_STATUSES.SEARCH_BLOCKED,
      isLiveVerified: false,
      sourceMode: "live_bulk",
      timestamp: "2026-11-25T05:00:00.000Z",
    },
    {
      resultId: "r_manual",
      clientId: "c1",
      locationId: "loc1",
      keywordId: "k2",
      keywordText: "metal finishing",
      resultStatus: TASK_STATUSES.RANKED,
      rankingPosition: 1,
      sourceMode: "manual_html",
      timestamp: "2026-11-30T06:00:00.000Z",
    },
  ]);

  const liveOnly = await historyStorage.queryRankingHistory({ includeManual: false });
  assert.equal(liveOnly.length, 3); // manual HTML excluded!

  // Trend series for k1 & failed k2 never plots failed checks as position 0
  const k2Series = buildKeywordTrendSeries({
    historyRecords: liveOnly,
    clientId: "c1",
    keywordId: "k2",
  });
  assert.equal(k2Series.length, 1);
  assert.equal(k2Series[0].position, null);
  assert.equal(k2Series[0].isFailed, true);

  // Date comparison between 2026-11-23 and 2026-11-30
  const dateComp = compareTwoReportingDates({
    historyRecords: liveOnly,
    clientId: "c1",
    dateA: "2026-11-23",
    dateB: "2026-11-30",
  });
  assert.equal(dateComp.length, 1);
  assert.equal(dateComp[0].delta, 7);

  // Agency overview metrics & per-client overview metrics calculated accurately
  const snaps = buildCurrentAndPreviousSnapshots(liveOnly);
  assert.equal(snaps[0].keywordText, "powder coating");

  const agency = computeAgencyOverviewMetrics({
    clients,
    locations: [{ locationId: "loc1", clientId: "c1" }],
    keywords: [
      { keywordId: "k1", clientId: "c1", active: true },
      { keywordId: "k2", clientId: "c1", active: true },
    ],
    historyRecords: liveOnly,
    jobs: [{ jobId: "j_1", clientId: "c1", state: "Completed", completedAt: "2026-11-30T05:00:00.000Z" }],
    todayIso: "2026-11-30",
  });
  assert.equal(agency.totalActiveClients, 2);
  assert.equal(agency.totalTrackedKeywords, 2);
  assert.equal(agency.keywordsCheckedToday, 1);
  assert.equal(agency.top10Count, 1);
  assert.equal(agency.improvedCount, 1);
  assert.equal(agency.failedChecksCount, 1);
  assert.equal(agency.pendingSheetUpdatesCount, 1);

  const clientDash = computeClientDashboardMetrics({
    client: clients[0],
    locations: [{ locationId: "loc1", clientId: "c1" }],
    keywords: [{ keywordId: "k1", active: true }],
    historyRecords: liveOnly,
    jobs: [],
  });
  assert.equal(clientDash.improvedCount, 1);
});

