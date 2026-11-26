/**
 * Automatic Google Sheet structure detector for agency client rank sheets.
 * Recognizes stats blocks, repeated keyword headers, multiple keyword groups,
 * blank separator rows, formulas, merged cells, historical date columns, and
 * formatting metadata strictly read-only without modifying the sheet.
 */

import { DEFAULT_SHEET_COLUMNS, normalizeColumnLetter } from "../clients/client-validator.js";
import { columnLettersToIndex, indexToColumnLetters } from "./sheet-range-validator.js";
import { normalizeWorksheetId } from "./spreadsheet-validator.js";

export const DEFAULT_HEADER_ALIASES = Object.freeze({
  keyword: ["keyword", "keywords", "search query", "query", "target keyword"],
  searchVolume: ["search volume", "volume", "avg monthly searches", "avg. monthly searches", "monthly searches", "msv"],
  competition: ["competition", "comp", "kd", "keyword difficulty", "difficulty"],
  landingPage: ["landing page", "target landing page", "target url", "url", "page"],
  serp: ["serp", "serp url", "ranking url", "ranked url", "actual ranking url", "actual url", "live url"],
});

const NON_KEYWORD_CELL_VALUES = new Set([
  "keyword",
  "keywords",
  "search query",
  "website statistics",
  "website stats",
  "semrush authority score",
  "authority score",
  "backlinks",
  "referring domains",
  "moz da",
  "moz pa",
  "domain authority",
  "page authority",
  "domain rating",
  "organic traffic",
  "total",
  "totals",
  "average",
  "summary",
  "metric",
  "metrics",
]);

function normalizeCellText(val) {
  return String(val ?? "").trim();
}

function normalizeHeaderText(val) {
  return String(val ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function matchesAlias(cellText, aliases) {
  const norm = normalizeHeaderText(cellText);
  if (!norm) return false;
  return aliases.some((alias) => norm === alias);
}

function extractUrlFromHyperlinkFormula(formulaText) {
  const raw = String(formulaText || "");
  const m = /^=\s*HYPERLINK\s*\(\s*"([^"]+)"/i.exec(raw);
  return m ? m[1].trim() : "";
}

function isNonKeywordMetricLabel(text) {
  const norm = normalizeHeaderText(text);
  if (!norm) return true;
  if (NON_KEYWORD_CELL_VALUES.has(norm)) return true;
  if (/^(semrush|moz\s*(da|pa)|authority\s*score|backlink|referring\s*domain|total\b|average\b|summary\b)/i.test(norm)) {
    return true;
  }
  return false;
}

function rgbColorLabel(color) {
  if (!color || typeof color !== "object") return null;
  const r = Math.round((color.red ?? 1) * 255);
  const g = Math.round((color.green ?? 1) * 255);
  const b = Math.round((color.blue ?? 1) * 255);
  if (r < 75 && g < 100 && b >= 65 && b > r + 20) return "navy";
  if (r > 215 && g > 195 && b < 200 && r - b >= 25) return "yellow";
  if (g >= 180 && g >= r + 15 && g >= b + 15) return "green";
  if (r >= 248 && g >= 248 && b >= 248) return "white";
  return `rgb(${r},${g},${b})`;
}

export function resolveColumnMappings({ columnConfig = {}, headerRowValues = [] } = {}) {
  const base = {
    keywordColumn: normalizeColumnLetter(columnConfig.keywordColumn, DEFAULT_SHEET_COLUMNS.keywordColumn),
    searchVolumeColumn: normalizeColumnLetter(columnConfig.searchVolumeColumn, DEFAULT_SHEET_COLUMNS.searchVolumeColumn),
    competitionColumn: normalizeColumnLetter(columnConfig.competitionColumn, DEFAULT_SHEET_COLUMNS.competitionColumn),
    landingPageColumn: normalizeColumnLetter(columnConfig.landingPageColumn, DEFAULT_SHEET_COLUMNS.landingPageColumn),
    serpColumn: normalizeColumnLetter(columnConfig.serpColumn, DEFAULT_SHEET_COLUMNS.serpColumn),
    latestDateColumn: normalizeColumnLetter(columnConfig.latestDateColumn, DEFAULT_SHEET_COLUMNS.latestDateColumn),
  };

  // Auto-detect only when explicit overrides weren't locked and row contains clear aliases
  const detectedFromHeader = {};
  headerRowValues.forEach((cell, idx) => {
    const letter = indexToColumnLetters(idx + 1);
    if (!columnConfig.keywordColumn && matchesAlias(cell, DEFAULT_HEADER_ALIASES.keyword)) {
      detectedFromHeader.keywordColumn = letter;
    } else if (!columnConfig.searchVolumeColumn && matchesAlias(cell, DEFAULT_HEADER_ALIASES.searchVolume)) {
      detectedFromHeader.searchVolumeColumn = letter;
    } else if (!columnConfig.competitionColumn && matchesAlias(cell, DEFAULT_HEADER_ALIASES.competition)) {
      detectedFromHeader.competitionColumn = letter;
    } else if (!columnConfig.landingPageColumn && matchesAlias(cell, DEFAULT_HEADER_ALIASES.landingPage)) {
      detectedFromHeader.landingPageColumn = letter;
    } else if (!columnConfig.serpColumn && matchesAlias(cell, DEFAULT_HEADER_ALIASES.serp)) {
      detectedFromHeader.serpColumn = letter;
    }
  });

  const merged = { ...base, ...detectedFromHeader };
  return {
    ...merged,
    keywordIdx: (columnLettersToIndex(merged.keywordColumn) || 3) - 1,
    volumeIdx: (columnLettersToIndex(merged.searchVolumeColumn) || 4) - 1,
    competitionIdx: (columnLettersToIndex(merged.competitionColumn) || 5) - 1,
    landingPageIdx: (columnLettersToIndex(merged.landingPageColumn) || 6) - 1,
    serpIdx: (columnLettersToIndex(merged.serpColumn) || 7) - 1,
    latestDateIdx: (columnLettersToIndex(merged.latestDateColumn) || 8) - 1,
  };
}

function isKeywordTableHeaderRow(row, colMap) {
  if (!Array.isArray(row)) return false;
  const kwCell = row[colMap.keywordIdx] ?? "";
  if (matchesAlias(kwCell, DEFAULT_HEADER_ALIASES.keyword)) {
    const neighborScore = [
      matchesAlias(row[colMap.volumeIdx], DEFAULT_HEADER_ALIASES.searchVolume),
      matchesAlias(row[colMap.competitionIdx], DEFAULT_HEADER_ALIASES.competition),
      matchesAlias(row[colMap.landingPageIdx], DEFAULT_HEADER_ALIASES.landingPage),
      matchesAlias(row[colMap.serpIdx], DEFAULT_HEADER_ALIASES.serp),
      Boolean(normalizeCellText(row[colMap.latestDateIdx])),
    ].filter(Boolean).length;
    return neighborScore >= 1;
  }

  // Fallback header scan anywhere on row when custom layout wasn't preset
  const hasKeywordCol = row.some((c) => matchesAlias(c, DEFAULT_HEADER_ALIASES.keyword));
  const hasSecondaryCol = row.some(
    (c) =>
      matchesAlias(c, DEFAULT_HEADER_ALIASES.searchVolume) ||
      matchesAlias(c, DEFAULT_HEADER_ALIASES.landingPage) ||
      matchesAlias(c, DEFAULT_HEADER_ALIASES.serp)
  );
  return hasKeywordCol && hasSecondaryCol;
}

export function detectSheetStructure({
  spreadsheetId = "",
  spreadsheetTitle = "",
  worksheetId = "",
  worksheetName = "",
  locale = "",
  timeZone = "",
  displayRows = [],
  formulaRows = [],
  merges = [],
  protectedRanges = [],
  hasFilter = false,
  basicFilter = null,
  filterViewsCount = 0,
  conditionalFormats = null,
  gridSheet = null,
  columnConfig = {},
} = {}) {
  const warnings = [];
  let activeColMap = resolveColumnMappings({ columnConfig });

  const firstHeaderCandidateIdx = displayRows.findIndex((r) => isKeywordTableHeaderRow(r, activeColMap));
  if (firstHeaderCandidateIdx !== -1) {
    activeColMap = resolveColumnMappings({
      columnConfig,
      headerRowValues: displayRows[firstHeaderCandidateIdx],
    });
  } else {
    warnings.push(
      `No standard keyword table header row detected (expected '${activeColMap.keywordColumn}' = Keyword + metric/URL headers). Please review preview rows carefully before importing.`
    );
  }

  const mergedRanges = (merges || []).map((m) => ({
    startRow: (m.startRowIndex ?? 0) + 1,
    endRow: m.endRowIndex ?? 0,
    startCol: indexToColumnLetters((m.startColumnIndex ?? 0) + 1),
    endCol: indexToColumnLetters(m.endColumnIndex ?? 0),
    startRowIndex: m.startRowIndex ?? 0,
    endRowIndex: m.endRowIndex ?? 0,
    startColumnIndex: m.startColumnIndex ?? 0,
    endColumnIndex: m.endColumnIndex ?? 0,
  }));

  const isCellMerged = (rIdx, cIdx) =>
    mergedRanges.some(
      (m) =>
        rIdx >= m.startRowIndex &&
        rIdx < m.endRowIndex &&
        cIdx >= m.startColumnIndex &&
        cIdx < m.endColumnIndex
    );

  const gridDataBlock = gridSheet?.data?.[0];
  const rowGridMeta = gridDataBlock?.rowData || [];
  const rowHeightsCount = (gridDataBlock?.rowMetadata || []).filter((m) => m?.pixelSize).length;
  const colWidthsCount = (gridDataBlock?.columnMetadata || []).filter((m) => m?.pixelSize).length;

  const headerRowNumbers = [];
  const blankSeparatorRowNumbers = [];
  const websiteStatsRows = [];
  const formulaCells = [];
  const keywordRows = [];
  const skippedRows = [];
  const groups = [];
  const detectedColors = new Set();

  let currentGroup = "Default Group";
  let currentDateHeaders = {}; // colIndex -> dateLabel
  let latestDateHeader = "";
  const allHistoricalHeaders = new Map(); // colLetter -> headerLabel

  // First pass: detect formulas, colors, headers, groups, stats rows, blank rows, and keyword rows
  for (let rIdx = 0; rIdx < displayRows.length; rIdx += 1) {
    const rowNumber = rIdx + 1;
    const row = Array.isArray(displayRows[rIdx]) ? displayRows[rIdx] : [];
    const fRow = Array.isArray(formulaRows[rIdx]) ? formulaRows[rIdx] : [];
    const gCells = rowGridMeta[rIdx]?.values || [];

    // Record formulas & formatting metadata without modifying
    const maxLen = Math.max(row.length, fRow.length);
    for (let cIdx = 0; cIdx < maxLen; cIdx += 1) {
      const fVal = fRow[cIdx];
      if (typeof fVal === "string" && fVal.startsWith("=")) {
        const colLetter = indexToColumnLetters(cIdx + 1);
        formulaCells.push({
          rowNumber,
          colIndex: cIdx,
          columnLetter: colLetter,
          a1: `${colLetter}${rowNumber}`,
          formula: fVal,
        });
      }
      const bg = rgbColorLabel(gCells[cIdx]?.effectiveFormat?.backgroundColor);
      if (bg) detectedColors.add(bg);
    }

    const isBlank = row.every((c) => normalizeCellText(c) === "");
    if (isBlank) {
      if (headerRowNumbers.length > 0) {
        blankSeparatorRowNumbers.push(rowNumber);
      }
      continue;
    }

    if (isKeywordTableHeaderRow(row, activeColMap)) {
      headerRowNumbers.push(rowNumber);

      // Update group if the row immediately above this repeated header looks like a group banner
      const prevRow = rIdx > 0 ? displayRows[rIdx - 1] || [] : [];
      const prevNonEmpty = prevRow.map(normalizeCellText).filter(Boolean);
      const prevKw = normalizeCellText(prevRow[activeColMap.keywordIdx]);
      const candidateGroupLabel =
        prevKw && !isNonKeywordMetricLabel(prevKw) && !isKeywordTableHeaderRow(prevRow, activeColMap)
          ? prevKw
          : prevNonEmpty.length === 1 && !isNonKeywordMetricLabel(prevNonEmpty[0])
            ? prevNonEmpty[0]
            : "";

      if (candidateGroupLabel && !websiteStatsRows.some((s) => s.rowNumber === rowNumber - 1)) {
        currentGroup = candidateGroupLabel;
      }

      if (!groups.some((g) => g.groupName === currentGroup && g.headerRowNumber === rowNumber)) {
        groups.push({ groupName: currentGroup, headerRowNumber: rowNumber });
      }

      // Parse latest ranking date + historical ranking date columns from this header row
      currentDateHeaders = {};
      const dateHeaderCandidate = normalizeCellText(row[activeColMap.latestDateIdx]);
      if (dateHeaderCandidate && !latestDateHeader) {
        latestDateHeader = dateHeaderCandidate;
      }

      for (let cIdx = activeColMap.latestDateIdx; cIdx < row.length; cIdx += 1) {
        const hdr = normalizeCellText(row[cIdx]);
        if (!hdr) continue;
        const colLetter = indexToColumnLetters(cIdx + 1);
        currentDateHeaders[cIdx] = hdr;
        if (cIdx > activeColMap.latestDateIdx && !allHistoricalHeaders.has(colLetter)) {
          allHistoricalHeaders.set(colLetter, hdr);
        }
      }
      continue;
    }

    const kwCell = normalizeCellText(row[activeColMap.keywordIdx]);

    // Check if next row is a table header -> treat this row as group banner, not stats or keyword!
    const nextRow = rIdx + 1 < displayRows.length ? displayRows[rIdx + 1] : null;
    if (nextRow && isKeywordTableHeaderRow(nextRow, activeColMap)) {
      const label = kwCell || row.map(normalizeCellText).find(Boolean) || "";
      if (label && !isNonKeywordMetricLabel(label)) {
        currentGroup = label;
        skippedRows.push({ rowNumber, reason: `Group title banner ('${label}')`, rawText: label });
        continue;
      }
    }

    // Check if pre-header Website Statistics section
    if (headerRowNumbers.length === 0) {
      const joined = row.map(normalizeCellText).filter(Boolean).join(" | ");
      websiteStatsRows.push({ rowNumber, text: joined });
      continue;
    }

    // Check if keyword column is blank (e.g. group label only in col A/B or subtotal row)
    if (!kwCell) {
      const nonEmptyText = row.map(normalizeCellText).filter(Boolean);
      const colACell = normalizeCellText(row[0]);
      const colBCell = normalizeCellText(row[1]);
      if (nonEmptyText.length === 1 && (colACell || colBCell) && !isNonKeywordMetricLabel(nonEmptyText[0])) {
        currentGroup = nonEmptyText[0];
        skippedRows.push({ rowNumber, reason: `Group label row ('${nonEmptyText[0]}')`, rawText: nonEmptyText[0] });
      } else {
        skippedRows.push({ rowNumber, reason: "Empty keyword cell", rawText: nonEmptyText.join(" | ") });
      }
      continue;
    }

    // Exclude stats / summary / header-like labels inside keyword column
    const volumeCell = normalizeCellText(row[activeColMap.volumeIdx]);
    const competitionCell = normalizeCellText(row[activeColMap.competitionIdx]);
    const landingPageCell = normalizeCellText(row[activeColMap.landingPageIdx]);
    const serpFormula = fRow[activeColMap.serpIdx];
    const serpDisplay = normalizeCellText(row[activeColMap.serpIdx]);
    const serpUrl = extractUrlFromHyperlinkFormula(serpFormula) || serpDisplay;

    const mergedRow = isCellMerged(rIdx, activeColMap.keywordIdx);
    const hasDataCols = Boolean(volumeCell || competitionCell || landingPageCell || serpUrl || normalizeCellText(row[activeColMap.latestDateIdx]));

    if (isNonKeywordMetricLabel(kwCell)) {
      skippedRows.push({ rowNumber, reason: "Heading or metric summary row", rawText: kwCell });
      continue;
    }

    // Detect standalone group title row (keyword cell filled or merged, all metric/URL/date cells empty, followed by table/keywords)
    const boldCell = Boolean(gCells[activeColMap.keywordIdx]?.effectiveFormat?.textFormat?.bold);
    if (!hasDataCols && (mergedRow || boldCell)) {
      currentGroup = kwCell;
      skippedRows.push({ rowNumber, reason: `Group section banner ('${kwCell}')`, rawText: kwCell });
      continue;
    }

    const latestRankRaw = normalizeCellText(row[activeColMap.latestDateIdx]);
    const latestHeaderForGroup = currentDateHeaders[activeColMap.latestDateIdx] || latestDateHeader;

    const historicalRankings = {};
    for (const [colIdxStr, headerLabel] of Object.entries(currentDateHeaders)) {
      const colIdx = Number(colIdxStr);
      if (colIdx <= activeColMap.latestDateIdx) continue;
      historicalRankings[headerLabel] = normalizeCellText(row[colIdx]);
    }

    const rowHasFormula = formulaCells.some((f) => f.rowNumber === rowNumber);

    keywordRows.push({
      rowNumber,
      keyword: kwCell,
      searchVolume: volumeCell,
      competition: competitionCell,
      landingPage: landingPageCell,
      serpUrl,
      latestRank: latestRankRaw,
      latestRankingDate: latestHeaderForGroup,
      keywordGroup: currentGroup,
      historicalRankings,
      hasFormula: rowHasFormula,
      merged: mergedRow,
    });
  }

  // Fallback check if sheet had NO header row anywhere (ambiguous): inspect remaining rows carefully
  const isAmbiguous = headerRowNumbers.length === 0;
  if (isAmbiguous && displayRows.length > 0 && keywordRows.length === 0) {
    for (let rIdx = 0; rIdx < displayRows.length; rIdx += 1) {
      const row = displayRows[rIdx] || [];
      const rowNumber = rIdx + 1;
      const kwCell = normalizeCellText(row[activeColMap.keywordIdx]);
      if (!kwCell || isNonKeywordMetricLabel(kwCell)) continue;
      keywordRows.push({
        rowNumber,
        keyword: kwCell,
        searchVolume: normalizeCellText(row[activeColMap.volumeIdx]),
        competition: normalizeCellText(row[activeColMap.competitionIdx]),
        landingPage: normalizeCellText(row[activeColMap.landingPageIdx]),
        serpUrl: normalizeCellText(row[activeColMap.serpIdx]),
        latestRank: normalizeCellText(row[activeColMap.latestDateIdx]),
        latestRankingDate: "",
        keywordGroup: "Unconfirmed Group",
        historicalRankings: {},
        hasFormula: false,
        merged: isCellMerged(rIdx, activeColMap.keywordIdx),
      });
    }
  }

  const effectiveConditionalFormats = conditionalFormats || gridSheet?.conditionalFormats || [];
  const effectiveBasicFilter = basicFilter || gridSheet?.basicFilter || null;
  const columnWidths = (gridDataBlock?.columnMetadata || []).map((m, idx) => ({
    colIndex: idx,
    columnLetter: indexToColumnLetters(idx + 1),
    pixelSize: m?.pixelSize ?? null,
  })).filter((c) => c.pixelSize !== null);
  const rowHeights = (gridDataBlock?.rowMetadata || []).map((m, idx) => ({
    rowNumber: idx + 1,
    pixelSize: m?.pixelSize ?? null,
  })).filter((r) => r.pixelSize !== null);

  return {
    spreadsheetId,
    spreadsheetTitle,
    worksheetId: normalizeWorksheetId(worksheetId),
    worksheetName,
    locale: locale || "",
    timeZone: timeZone || "",
    columnMappings: {
      keywordColumn: activeColMap.keywordColumn,
      searchVolumeColumn: activeColMap.searchVolumeColumn,
      competitionColumn: activeColMap.competitionColumn,
      landingPageColumn: activeColMap.landingPageColumn,
      serpColumn: activeColMap.serpColumn,
      latestDateColumn: activeColMap.latestDateColumn,
    },
    latestDateColumn: activeColMap.latestDateColumn,
    latestDateHeader,
    historicalDateColumns: [...allHistoricalHeaders.entries()].map(([columnLetter, header]) => ({
      columnLetter,
      header,
    })),
    headerRowNumbers,
    blankSeparatorRowNumbers,
    websiteStatsRows,
    groups,
    keywordRows,
    skippedRows,
    mergedRanges,
    formulaCells,
    protectedRanges: (protectedRanges || []).map((p) => ({
      description: p.description || "",
      range: p.range || null,
    })),
    hasFilter: Boolean(hasFilter || effectiveBasicFilter || filterViewsCount > 0),
    filterSummary: {
      hasBasicFilter: Boolean(hasFilter || effectiveBasicFilter),
      basicFilterRange: effectiveBasicFilter?.range || null,
      filterViewsCount: Number(filterViewsCount || (gridSheet?.filterViews || []).length || 0),
    },
    conditionalFormats: effectiveConditionalFormats,
    conditionalFormatsCount: effectiveConditionalFormats.length,
    formattingMetadata: {
      detectedColors: [...detectedColors],
      customRowHeightsCount: rowHeightsCount,
      customColumnWidthsCount: colWidthsCount,
      columnWidths,
      rowHeightsCount: rowHeights.length,
      templateHeaderFormat:
        firstHeaderCandidateIdx !== -1
          ? rowGridMeta[firstHeaderCandidateIdx]?.values?.[activeColMap.latestDateIdx]?.userEnteredFormat ||
            rowGridMeta[firstHeaderCandidateIdx]?.values?.[activeColMap.latestDateIdx]?.effectiveFormat ||
            null
          : null,
      templateDataFormat:
        keywordRows[0]
          ? rowGridMeta[keywordRows[0].rowNumber - 1]?.values?.[activeColMap.latestDateIdx]?.userEnteredFormat ||
            rowGridMeta[keywordRows[0].rowNumber - 1]?.values?.[activeColMap.latestDateIdx]?.effectiveFormat ||
            null
          : null,
    },
    isAmbiguous,
    warnings,
  };
}

