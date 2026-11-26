/**
 * Generates downloadable CSV reports across all 10 agency SEO reporting categories.
 */

import { isFailedTaskStatus } from "../jobs/job-state.js";
import { MOVEMENT_TYPES } from "../history/ranking-comparison.js";
import { buildCurrentAndPreviousSnapshots } from "../history/ranking-history.js";
import { computeClientDashboardMetrics } from "../history/ranking-metrics.js";
import { serializeRowsToCsv } from "./csv-exporter.js";

export const REPORT_TYPES = Object.freeze({
  CURRENT_RANKINGS: "current_rankings",
  HISTORICAL_COMPARISON: "historical_comparison",
  IMPROVEMENTS: "improvements",
  DECLINES: "declines",
  NEW_RANKINGS: "new_rankings",
  LOST_RANKINGS: "lost_rankings",
  FAILED_CHECKS: "failed_checks",
  CLIENT_SUMMARY: "client_summary",
  SHEET_UPDATE_HISTORY: "sheet_update_history",
  ACCURACY_COMPARISON: "accuracy_comparison",
});

export function generateAgencyCsvReport({
  reportType,
  clients = [],
  locationsByClient = {},
  keywordsByClient = {},
  historyRecords = [],
  jobs = [],
  journalEntries = [],
  accuracyComparisons = [],
} = {}) {
  const clientNameById = new Map(clients.map((c) => [c.clientId, c.clientName]));
  const snapshots = buildCurrentAndPreviousSnapshots(historyRecords);

  switch (reportType) {
    case REPORT_TYPES.CURRENT_RANKINGS: {
      const headers = [
        "Client",
        "Location",
        "Keyword",
        "Group",
        "Search Volume",
        "Competition",
        "Landing Page",
        "Previous Rank",
        "Current Rank",
        "Movement",
        "Ranking URL",
        "Verification",
        "Last Checked",
        "Status",
      ];
      const rows = snapshots.map((s) => [
        clientNameById.get(s.clientId) || s.clientId,
        s.locationName || "-",
        s.keywordText,
        s.keywordGroup,
        s.searchVolume,
        s.competition,
        s.landingPage,
        s.previousRank,
        s.currentRank,
        s.movementLabel,
        s.rankingUrl,
        s.verificationStatus,
        s.timestamp,
        s.resultStatus,
      ]);
      return { filename: "current-keyword-rankings.csv", csv: serializeRowsToCsv(headers, rows), rowCount: rows.length };
    }

    case REPORT_TYPES.IMPROVEMENTS:
    case REPORT_TYPES.DECLINES:
    case REPORT_TYPES.NEW_RANKINGS:
    case REPORT_TYPES.LOST_RANKINGS: {
      const filterMap = {
        [REPORT_TYPES.IMPROVEMENTS]: MOVEMENT_TYPES.IMPROVED,
        [REPORT_TYPES.DECLINES]: MOVEMENT_TYPES.DECLINED,
        [REPORT_TYPES.NEW_RANKINGS]: MOVEMENT_TYPES.NEW_RANKING,
        [REPORT_TYPES.LOST_RANKINGS]: MOVEMENT_TYPES.LOST_RANKING,
      };
      const target = filterMap[reportType];
      const matched = snapshots.filter((s) => s.movementType === target);
      const headers = ["Client", "Location", "Keyword", "Previous Rank", "Current Rank", "Change", "URL", "Checked At"];
      const rows = matched.map((s) => [
        clientNameById.get(s.clientId) || s.clientId,
        s.locationName || "-",
        s.keywordText,
        s.previousRank,
        s.currentRank,
        s.movementLabel,
        s.rankingUrl,
        s.timestamp,
      ]);
      return { filename: `${reportType}.csv`, csv: serializeRowsToCsv(headers, rows), rowCount: rows.length };
    }

    case REPORT_TYPES.FAILED_CHECKS: {
      const failed = historyRecords.filter(
        (r) => r.sourceMode !== "manual_html" && isFailedTaskStatus(r.resultStatus)
      );
      const headers = ["Client", "Location", "Keyword", "Status", "Error Details", "Job ID", "Timestamp"];
      const rows = failed.map((r) => [
        clientNameById.get(r.clientId) || r.clientId,
        r.locationName || "-",
        r.keywordText,
        r.resultStatus,
        r.errorDetails || "",
        r.jobId || "-",
        r.timestamp,
      ]);
      return { filename: "failed-ranking-checks.csv", csv: serializeRowsToCsv(headers, rows), rowCount: rows.length };
    }

    case REPORT_TYPES.HISTORICAL_COMPARISON: {
      const headers = ["Client", "Location", "Keyword", "Spreadsheet Row", "Rank", "Status", "Ranking URL", "Timestamp", "Verification"];
      const rows = historyRecords
        .filter((r) => r.sourceMode !== "manual_html")
        .map((r) => [
          clientNameById.get(r.clientId) || r.clientId,
          r.locationName || "-",
          r.keywordText,
          r.spreadsheetRowRef?.rowNumber ?? "-",
          r.rankingPosition ?? r.resultStatus,
          r.resultStatus,
          r.rankingUrl || "",
          r.timestamp,
          r.googleLocationVerification || "",
        ]);
      return { filename: "historical-ranking-log.csv", csv: serializeRowsToCsv(headers, rows), rowCount: rows.length };
    }

    case REPORT_TYPES.CLIENT_SUMMARY: {
      const headers = ["Client", "Domain", "Locations", "Active Keywords", "Top 3", "Top 10", "Top 20", "Improved", "Declined", "Last Check", "Last Sheet Update"];
      const rows = clients.map((c) => {
        const m = computeClientDashboardMetrics({
          client: c,
          locations: locationsByClient[c.clientId] || [],
          keywords: keywordsByClient[c.clientId] || [],
          historyRecords,
          jobs,
          journalEntries,
        });
        return [
          c.clientName,
          c.websiteDomain,
          m.totalConfiguredLocations,
          m.totalTrackedKeywords,
          m.top3Count,
          m.top10Count,
          m.top20Count,
          m.improvedCount,
          m.declinedCount,
          m.lastRankingCheck || "No data",
          m.lastSheetUpdate || "No data",
        ];
      });
      return { filename: "client-ranking-summaries.csv", csv: serializeRowsToCsv(headers, rows), rowCount: rows.length };
    }

    case REPORT_TYPES.SHEET_UPDATE_HISTORY: {
      const headers = ["Operation ID", "Client", "Spreadsheet ID", "Worksheet", "Target Date", "Mode", "Status", "Backup ID", "Updated At"];
      const rows = journalEntries.map((e) => [
        e.operationId,
        clientNameById.get(e.clientId) || e.clientId,
        e.spreadsheetId,
        e.worksheetName || e.worksheetId,
        e.targetDate || "",
        e.mode || "dry-run",
        e.status,
        e.backupId || "",
        e.updatedAt || e.createdAt,
      ]);
      return { filename: "google-sheet-update-history.csv", csv: serializeRowsToCsv(headers, rows), rowCount: rows.length };
    }

    case REPORT_TYPES.ACCURACY_COMPARISON: {
      const headers = ["Keyword", "Baseline Rank", "Extension Rank", "Diff", "Classification", "Baseline URL", "Extension URL"];
      const rows = accuracyComparisons.map((r) => [
        r.keyword,
        r.baselineRank ?? "-",
        r.extensionRank ?? "-",
        r.rankDiff ?? "-",
        r.classification || r.status || "-",
        r.baselineUrl || "",
        r.extensionUrl || "",
      ]);
      return { filename: "ranking-accuracy-comparison.csv", csv: serializeRowsToCsv(headers, rows), rowCount: rows.length };
    }

    default:
      return { filename: "report.csv", csv: "", rowCount: 0 };
  }
}

