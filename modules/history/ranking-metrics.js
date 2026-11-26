/**
 * Agency-wide and per-client SEO overview KPI calculations strictly derived
 * from actual persisted storage records (zero fabricated stats).
 */

import { isFailedTaskStatus, JOB_STATES, TASK_STATUSES } from "../jobs/job-state.js";
import { MOVEMENT_TYPES } from "./ranking-comparison.js";
import { buildCurrentAndPreviousSnapshots } from "./ranking-history.js";

export function computeAgencyOverviewMetrics({
  clients = [],
  locations = [],
  keywords = [],
  historyRecords = [],
  jobs = [],
  journalEntries = [],
  todayIso = new Date().toISOString().slice(0, 10),
} = {}) {
  const activeClients = clients.filter((c) => c.status === "active");
  const liveHistory = historyRecords.filter(
    (r) =>
      r.sourceMode !== "manual_html" &&
      r.sourceMode !== "mock" &&
      !r.isMock &&
      (isFailedTaskStatus(r.resultStatus || r.status) || r.isLiveVerified === true)
  );
  const snapshots = buildCurrentAndPreviousSnapshots(liveHistory);

  let top3Count = 0;
  let pos4To10Count = 0;
  let pos11To20Count = 0;
  let pos21To100Count = 0;
  let confirmedNotFoundCount = 0;
  let failedChecksCount = 0;
  let improvedCount = 0;
  let declinedCount = 0;
  let unchangedCount = 0;
  let newRankingsCount = 0;
  let lostRankingsCount = 0;

  for (const row of snapshots) {
    const cur = row.currentRecord;
    const st = cur.resultStatus;
    const pos = cur.rankingPosition;

    if (st === TASK_STATUSES.RANKED && typeof pos === "number") {
      if (pos <= 3) top3Count += 1;
      else if (pos <= 10) pos4To10Count += 1;
      else if (pos <= 20) pos11To20Count += 1;
      else if (pos <= 100) pos21To100Count += 1;
    } else if (st === TASK_STATUSES.NOT_FOUND) {
      confirmedNotFoundCount += 1;
    } else if (isFailedTaskStatus(st)) {
      failedChecksCount += 1;
    }

    if (row.movementType === MOVEMENT_TYPES.IMPROVED) improvedCount += 1;
    else if (row.movementType === MOVEMENT_TYPES.DECLINED) declinedCount += 1;
    else if (row.movementType === MOVEMENT_TYPES.UNCHANGED) unchangedCount += 1;
    else if (row.movementType === MOVEMENT_TYPES.NEW_RANKING) newRankingsCount += 1;
    else if (row.movementType === MOVEMENT_TYPES.LOST_RANKING) lostRankingsCount += 1;
  }

  const keywordsCheckedToday = liveHistory.filter((r) => String(r.timestamp || "").startsWith(todayIso)).length;

  const updatedJobIds = new Set(
    journalEntries
      .filter((e) => e.status === "Update successful")
      .map((e) => e.jobId)
  );
  const completedJobs = jobs.filter(
    (j) => j.state === JOB_STATES.COMPLETED || j.state === JOB_STATES.COMPLETED_WITH_ERRORS
  );
  const pendingSheetUpdatesCount = completedJobs.filter(
    (j) => j.clientId && !updatedJobIds.has(j.jobId)
  ).length;

  const sortedCompleted = completedJobs
    .slice()
    .sort((a, b) => String(b.completedAt || b.createdAt || "").localeCompare(String(a.completedAt || a.createdAt || "")));

  const recentMovements = snapshots
    .filter(
      (s) =>
        s.movementType === MOVEMENT_TYPES.IMPROVED ||
        s.movementType === MOVEMENT_TYPES.DECLINED ||
        s.movementType === MOVEMENT_TYPES.UNCHANGED ||
        s.movementType === MOVEMENT_TYPES.NEW_RANKING ||
        s.movementType === MOVEMENT_TYPES.LOST_RANKING
    )
    .slice(0, 15);

  return {
    hasData: snapshots.length > 0,
    totalActiveClients: activeClients.length,
    totalTrackedKeywords: keywords.filter((k) => k.active !== false).length,
    totalConfiguredLocations: locations.length,
    keywordsCheckedToday,
    top3Count,
    top10Count: top3Count + pos4To10Count,
    top20Count: top3Count + pos4To10Count + pos11To20Count,
    top100Count: top3Count + pos4To10Count + pos11To20Count + pos21To100Count,
    improvedCount,
    declinedCount,
    unchangedCount,
    newRankingsCount,
    lostRankingsCount,
    confirmedNotFoundCount,
    failedChecksCount,
    pendingSheetUpdatesCount,
    lastSuccessfulJob: sortedCompleted[0] || null,
    distribution: {
      top3: top3Count,
      pos4To10: pos4To10Count,
      pos11To20: pos11To20Count,
      pos21To100: pos21To100Count,
      notFound: confirmedNotFoundCount,
    },
    recentMovements,
  };
}

export function computeClientDashboardMetrics({
  client,
  locations = [],
  keywords = [],
  historyRecords = [],
  jobs = [],
  journalEntries = [],
} = {}) {
  const overview = computeAgencyOverviewMetrics({
    clients: client ? [client] : [],
    locations,
    keywords,
    historyRecords: historyRecords.filter((r) => !client || r.clientId === client.clientId),
    jobs: jobs.filter((j) => !client || j.clientId === client.clientId),
    journalEntries: journalEntries.filter((e) => !client || e.clientId === client.clientId),
  });

  const successfulUpdates = journalEntries
    .filter((e) => (!client || e.clientId === client.clientId) && e.status === "Update successful")
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  return {
    ...overview,
    clientId: client?.clientId || null,
    clientName: client?.clientName || "",
    websiteDomain: client?.websiteDomain || "",
    lastRankingCheck: client?.lastCheckedAt || overview.lastSuccessfulJob?.completedAt || null,
    lastSheetUpdate: successfulUpdates[0]?.updatedAt || null,
    sheetConnectionStatus: client?.sheetConfig?.spreadsheetId ? "Configured" : "Not configured",
    recentJobs: jobs.slice(0, 10),
  };
}

