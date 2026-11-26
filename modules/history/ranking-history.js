/**
 * Historical keyword grouping, two-date comparisons, and chart trend series builders.
 * Failed/blocked checks stay clearly marked as missing data — never plotted as position 0.
 */

import { TASK_STATUSES } from "../jobs/job-state.js";
import { calculateRankingMovement, isValidComparableResult, MOVEMENT_TYPES } from "./ranking-comparison.js";

function recordGroupKey(rec) {
  const rowAnchor = rec.spreadsheetRowRef?.rowNumber ? `r${rec.spreadsheetRowRef.rowNumber}` : "";
  const kwKey = rec.keywordId || `${rec.keywordText.toLowerCase()}::${rowAnchor}`;
  return `${rec.clientId}::${rec.locationId || "default"}::${rec.deviceType || "Desktop"}::${kwKey}`;
}

export function buildCurrentAndPreviousSnapshots(historyRecords = []) {
  const liveOnly = historyRecords
    .filter((r) => r.sourceMode !== "manual_html")
    .slice()
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));

  const grouped = new Map();
  for (const rec of liveOnly) {
    const key = recordGroupKey(rec);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(rec);
  }

  const rows = [];
  for (const entries of grouped.values()) {
    const current = entries[0];
    // Find latest valid comparable prior baseline strictly older than current
    let previous = null;
    for (let i = 1; i < entries.length; i += 1) {
      const candidate = entries[i];
      if (isValidComparableResult(candidate)) {
        previous = candidate;
        break;
      }
    }

    const movement = calculateRankingMovement(previous, current);
    rows.push({
      key: recordGroupKey(current),
      clientId: current.clientId,
      locationId: current.locationId,
      locationName: current.locationName,
      keywordId: current.keywordId,
      keywordText: current.keywordText,
      keywordGroup: current.keywordGroup || "Default",
      searchVolume: current.searchVolume ?? "",
      competition: current.competition || "",
      landingPage: current.landingPage || "",
      spreadsheetRowRef: current.spreadsheetRowRef || null,
      previousRank: previous
        ? previous.resultStatus === TASK_STATUSES.RANKED
          ? previous.rankingPosition
          : "NA"
        : "No history",
      currentRank:
        current.resultStatus === TASK_STATUSES.RANKED
          ? current.rankingPosition
          : current.resultStatus === TASK_STATUSES.NOT_FOUND
            ? "NA"
            : "-",
      movementType: movement.movementType,
      delta: movement.delta,
      movementLabel: movement.label,
      rankingUrl: current.rankingUrl || "",
      verificationStatus: current.googleLocationVerification || current.browserGpsVerification || "Unverified",
      timestamp: current.timestamp,
      resultStatus: current.resultStatus,
      requestedDepth: current.requestedDepth,
      currentRecord: current,
      previousRecord: previous,
    });
  }

  return rows;
}

export function compareTwoReportingDates({
  historyRecords = [],
  dateA,
  dateB,
  clientId = null,
  locationId = null,
}) {
  const byKeyDate = new Map();
  for (const rec of historyRecords) {
    if (rec.sourceMode === "manual_html") continue;
    if (clientId && rec.clientId !== clientId) continue;
    if (locationId && rec.locationId !== locationId) continue;
    const day = String(rec.timestamp || "").slice(0, 10);
    if (day !== dateA && day !== dateB) continue;

    const kKey = recordGroupKey(rec);
    if (!byKeyDate.has(kKey)) byKeyDate.set(kKey, { keywordText: rec.keywordText, rowRef: rec.spreadsheetRowRef });
    const entry = byKeyDate.get(kKey);
    if (day === dateA && !entry.recA) entry.recA = rec;
    if (day === dateB && !entry.recB) entry.recB = rec;
  }

  const comparisons = [];
  for (const [kKey, pair] of byKeyDate.entries()) {
    const mov = calculateRankingMovement(pair.recA || null, pair.recB || null);
    comparisons.push({
      key: kKey,
      keywordText: pair.keywordText,
      spreadsheetRowRef: pair.rowRef,
      dateA,
      dateB,
      rankA:
        pair.recA?.resultStatus === TASK_STATUSES.RANKED
          ? pair.recA.rankingPosition
          : pair.recA?.resultStatus === TASK_STATUSES.NOT_FOUND
            ? "NA"
            : "Missing",
      rankB:
        pair.recB?.resultStatus === TASK_STATUSES.RANKED
          ? pair.recB.rankingPosition
          : pair.recB?.resultStatus === TASK_STATUSES.NOT_FOUND
            ? "NA"
            : pair.recB?.resultStatus || "Missing",
      movementType: mov.movementType,
      delta: mov.delta,
      movementLabel: mov.label,
      urlB: pair.recB?.rankingUrl || "",
    });
  }
  return comparisons;
}

/**
 * Build chronological trend series for a keyword. Failed/missing points use null
 * position with explicit markers so charts never render them as rank #0.
 */
export function buildKeywordTrendSeries({
  historyRecords = [],
  clientId,
  locationId = null,
  keywordId = null,
  keywordText = "",
} = {}) {
  const qKw = String(keywordText || "").trim().toLowerCase();
  const matching = historyRecords
    .filter((r) => {
      if (r.sourceMode === "manual_html") return false;
      if (clientId && r.clientId !== clientId) return false;
      if (locationId && r.locationId !== locationId) return false;
      if (keywordId) return r.keywordId === keywordId;
      return qKw ? String(r.keywordText || "").toLowerCase() === qKw : true;
    })
    .slice()
    .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));

  return matching.map((r) => {
    const isRanked = r.resultStatus === TASK_STATUSES.RANKED && typeof r.rankingPosition === "number";
    const isNotFound = r.resultStatus === TASK_STATUSES.NOT_FOUND;
    const isFailed = !isRanked && !isNotFound;
    return {
      resultId: r.resultId,
      dateLabel: String(r.timestamp || "").slice(0, 10),
      timestamp: r.timestamp,
      position: isRanked ? r.rankingPosition : null,
      isRanked,
      isNotFound,
      isFailed,
      status: r.resultStatus,
      rankingUrl: r.rankingUrl || "",
    };
  });
}

export { MOVEMENT_TYPES };

