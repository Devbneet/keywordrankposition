/**
 * Keyword input parsers and row-anchored queue builder for bulk ranking jobs.
 */

import { TASK_STATUSES } from "./job-state.js";

function parseCsvRow(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Parse newline-separated keywords from pasted text or TXT files.
 * Preserves duplicate keywords and exact row order.
 */
export function parseKeywordTextInput(rawText) {
  return String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((keyword, idx) => ({
      keyword,
      rowPosition: idx + 1,
    }));
}

/**
 * Parse keywords from CSV content, preserving duplicates and row numbers.
 * Supports either a 'Keyword' header column or a single-column keyword list.
 */
export function parseKeywordCsvInput(csvText) {
  const lines = String(csvText || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim() !== "");

  if (lines.length === 0) {
    return [];
  }

  const firstCells = parseCsvRow(lines[0]);
  const kwColIdx = firstCells.findIndex((c) => c.toLowerCase() === "keyword");
  const rowColIdx = firstCells.findIndex((c) =>
    ["row", "rowposition", "row_number", "rownumber"].includes(c.toLowerCase().replace(/\s+/g, ""))
  );

  const hasHeader = kwColIdx !== -1;
  const startIdx = hasHeader ? 1 : 0;
  const targetCol = hasHeader ? kwColIdx : 0;

  const entries = [];
  for (let i = startIdx; i < lines.length; i += 1) {
    const cells = parseCsvRow(lines[i]);
    const keyword = String(cells[targetCol] || "").trim();
    if (!keyword) continue;

    let rowPosition = entries.length + 1;
    if (rowColIdx !== -1 && cells[rowColIdx]) {
      const parsedRow = Number(cells[rowColIdx]);
      if (Number.isInteger(parsedRow) && parsedRow > 0) {
        rowPosition = parsedRow;
      }
    }
    entries.push({ keyword, rowPosition });
  }
  return entries;
}

/**
 * Import keywords from existing Accuracy Lab baseline rows.
 */
export function importKeywordsFromBaselineRows(baselineRows = []) {
  return (baselineRows || [])
    .filter((r) => String(r?.keyword || "").trim() !== "")
    .map((r, idx) => ({
      keyword: String(r.keyword).trim(),
      rowPosition: Number.isInteger(r.rowIndex) ? r.rowIndex + 1 : idx + 1,
    }));
}

/**
 * Build an ordered queue of unique keyword tasks preserving duplicates and row positions.
 */
export function buildKeywordQueue({
  jobId,
  keywords,
  clientDomain,
  locationConfig,
  searchDepth = 50,
}) {
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return [];
  }

  return keywords
    .map((entry, idx) => {
      const isObj = entry && typeof entry === "object";
      const keyword = String(isObj ? entry.keyword : entry || "").trim();
      if (!keyword) return null;
      const rowPosition = isObj && Number.isInteger(entry.rowPosition) ? entry.rowPosition : idx + 1;
      const rowNumber = isObj && Number.isInteger(entry.rowNumber) ? entry.rowNumber : rowPosition;

      return {
        taskId: `${jobId}_t${idx + 1}_r${rowPosition}`,
        jobId,
        sequenceIndex: idx,
        rowPosition,
        rowNumber,
        keywordId: isObj ? entry.keywordId || null : null,
        spreadsheetId: isObj ? entry.spreadsheetId || null : null,
        worksheetId: isObj ? entry.worksheetId || null : null,
        worksheetName: isObj ? entry.worksheetName || null : null,
        keywordGroup: isObj ? entry.keywordGroup || null : null,
        keyword,
        clientDomain,
        locationConfig: locationConfig ? { ...locationConfig } : null,
        requestedDepth: Number(searchDepth) || 50,
        status: TASK_STATUSES.PENDING,
        position: null,
        rankingUrl: null,
        checkedResults: 0,
        googleDetectedLocation: null,
        locationVerificationStatus: null,
        googleLocationSource: null,
        isLiveVerified: false,
        durationMs: null,
        checkedAt: null,
        errorDetails: null,
      };
    })
    .filter(Boolean);
}

