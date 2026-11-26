/**
 * Calculate accuracy metrics exclusively from valid comparable results,
 * keeping excluded/failed checks separate so accuracy is never artificially inflated.
 */

import { COMPARISON_STATUSES } from "./accuracy-comparator.js";

function roundPct(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

export function computeAccuracyMetrics({ rows = [], tolerance = 1 } = {}) {
  const comparableStatuses = new Set([
    COMPARISON_STATUSES.EXACT_MATCH,
    COMPARISON_STATUSES.WITHIN_TOLERANCE,
    COMPARISON_STATUSES.RANKING_MISMATCH,
    COMPARISON_STATUSES.URL_MISMATCH,
  ]);

  let exactMatches = 0;
  let withinToleranceOnly = 0;
  let rankingMismatches = 0;
  let urlMismatches = 0;

  let locationMismatchCount = 0;
  let blockedSearchCount = 0;
  let incompleteSearchCount = 0;
  let missingBaselineCount = 0;
  let notComparableCount = 0;

  const comparableRows = [];
  const urlComparableRows = [];
  const numericDiffs = [];

  for (const row of rows) {
    if (comparableStatuses.has(row.comparisonStatus)) {
      comparableRows.push(row);
      if (row.comparisonStatus === COMPARISON_STATUSES.EXACT_MATCH) exactMatches += 1;
      else if (row.comparisonStatus === COMPARISON_STATUSES.WITHIN_TOLERANCE) withinToleranceOnly += 1;
      else if (row.comparisonStatus === COMPARISON_STATUSES.RANKING_MISMATCH) rankingMismatches += 1;
      else if (row.comparisonStatus === COMPARISON_STATUSES.URL_MISMATCH) urlMismatches += 1;

      if (typeof row.rankingDifference === "number" && Number.isFinite(row.rankingDifference)) {
        numericDiffs.push(row.rankingDifference);
      }
      if (row.urlMatchStatus === "Match" || row.urlMatchStatus === "Matched (NA)" || row.urlMatchStatus === "Mismatch") {
        urlComparableRows.push(row);
      }
    } else if (row.comparisonStatus === COMPARISON_STATUSES.LOCATION_MISMATCH) {
      locationMismatchCount += 1;
    } else if (row.comparisonStatus === COMPARISON_STATUSES.SEARCH_BLOCKED) {
      blockedSearchCount += 1;
    } else if (row.comparisonStatus === COMPARISON_STATUSES.INCOMPLETE_SEARCH) {
      incompleteSearchCount += 1;
    } else if (row.comparisonStatus === COMPARISON_STATUSES.MISSING_BASELINE) {
      missingBaselineCount += 1;
    } else if (row.comparisonStatus === COMPARISON_STATUSES.NOT_COMPARABLE) {
      notComparableCount += 1;
    }
  }

  const comparableKeywords = comparableRows.length;
  const withinToleranceTotal = exactMatches + withinToleranceOnly;
  const urlMatchedCount = urlComparableRows.filter(
    (r) => r.urlMatchStatus === "Match" || r.urlMatchStatus === "Matched (NA)"
  ).length;

  const averageAbsoluteDifference =
    numericDiffs.length > 0
      ? Number((numericDiffs.reduce((sum, d) => sum + d, 0) / numericDiffs.length).toFixed(2))
      : null;

  return {
    totalKeywordsTested: rows.length,
    comparableKeywords,
    tolerance,
    exactMatches,
    withinToleranceOnly,
    withinToleranceTotal,
    rankingMismatches,
    urlMismatches,
    exactMatchPercentage: roundPct(exactMatches, comparableKeywords),
    withinTolerancePercentage: roundPct(withinToleranceTotal, comparableKeywords),
    urlMatchPercentage: roundPct(urlMatchedCount, urlComparableRows.length),
    averageAbsoluteDifference,
    locationMismatchCount,
    blockedSearchCount,
    incompleteSearchCount,
    missingBaselineCount,
    notComparableCount,
  };
}

