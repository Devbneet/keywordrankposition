/**
 * Export accuracy comparison reports to CSV and JSON.
 */

function escapeCsv(value) {
  const str = value === undefined || value === null ? "" : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportComparisonCsv(report) {
  const headers = [
    "Keyword",
    "Manual Ranking",
    "Extension Ranking",
    "Ranking Difference",
    "Manual Ranking URL",
    "Extension Ranking URL",
    "URL Match Status",
    "Browser GPS Status",
    "Google Location Status",
    "Google Location Source",
    "Comparison Status",
    "Notes",
  ];

  const lines = [headers.join(",")];
  for (const row of report?.rows || []) {
    lines.push(
      [
        row.keyword,
        row.manualRanking,
        row.extensionRanking,
        row.rankingDifference ?? "",
        row.manualRankingUrl,
        row.extensionRankingUrl,
        row.urlMatchStatus,
        row.browserGpsStatus,
        row.googleLocationStatus,
        row.googleLocationSource,
        row.comparisonStatus,
        Array.isArray(row.notes) ? row.notes.join("; ") : "",
      ]
        .map(escapeCsv)
        .join(",")
    );
  }
  return lines.join("\n");
}

export function exportComparisonJson(report) {
  return JSON.stringify(report, null, 2);
}

