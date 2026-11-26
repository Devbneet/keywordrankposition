/**
 * Builds narrow, format-preserving Google Sheets API v4 BatchUpdate requests:
 * InsertDimensionRequest -> CopyPasteRequest (PASTE_FORMAT only) ->
 * UpdateDimensionPropertiesRequest (column width) -> UpdateCellsRequest (date headers + ranks + SERP URLs).
 */

import { columnLettersToIndex } from "./sheet-range-validator.js";

function toCellValue(val) {
  if (val === null || val === undefined || val === "") {
    return { userEnteredValue: { stringValue: "" } };
  }
  if (typeof val === "number" && Number.isFinite(val)) {
    return { userEnteredValue: { numberValue: val } };
  }
  return { userEnteredValue: { stringValue: String(val) } };
}

export function buildAtomicBatchUpdateRequests({
  worksheetId,
  structure,
  displayRows = [],
  datePlan,
  rankUpdates = [],
  serpUpdates = [],
}) {
  const sheetIdNum = Number(worksheetId);
  if (!Number.isInteger(sheetIdNum) || sheetIdNum < 0) {
    throw new Error(`Invalid numeric worksheetId '${worksheetId}' for Sheets batchUpdate.`);
  }

  const requests = [];
  const totalRows = Math.max(displayRows.length, 1);

  if (datePlan.action === "INSERT_NEW_COLUMN") {
    const insertIdx = datePlan.insertColIndex;
    const templateShiftedIdx = insertIdx + 1;

    // 1. Insert 1 physical column right after SERP column
    requests.push({
      insertDimension: {
        range: {
          sheetId: sheetIdNum,
          dimension: "COLUMNS",
          startIndex: insertIdx,
          endIndex: insertIdx + 1,
        },
        inheritFromBefore: false,
      },
    });

    // 2. Copy FORMAT ONLY from the shifted previous latest date column into the newly inserted column.
    // Preserves background colors, font family/size/bold/color, borders, alignments, wrapping, and number formats
    // WITHOUT copying old ranking values or formulas.
    const firstHeaderRowIdx = Math.max(0, (structure.headerRowNumbers?.[0] ?? 1) - 1);
    requests.push({
      copyPaste: {
        source: {
          sheetId: sheetIdNum,
          startRowIndex: firstHeaderRowIdx,
          endRowIndex: totalRows,
          startColumnIndex: templateShiftedIdx,
          endColumnIndex: templateShiftedIdx + 1,
        },
        destination: {
          sheetId: sheetIdNum,
          startRowIndex: firstHeaderRowIdx,
          endRowIndex: totalRows,
          startColumnIndex: insertIdx,
          endColumnIndex: insertIdx + 1,
        },
        pasteType: "PASTE_FORMAT",
        pasteOrientation: "NORMAL",
      },
    });

    // 3. Preserve column width if explicitly recorded on the template column
    const templateWidth = (structure.formattingMetadata?.columnWidths || []).find(
      (c) => c.colIndex === insertIdx
    );
    if (templateWidth?.pixelSize) {
      requests.push({
        updateDimensionProperties: {
          range: {
            sheetId: sheetIdNum,
            dimension: "COLUMNS",
            startIndex: insertIdx,
            endIndex: insertIdx + 1,
          },
          properties: {
            pixelSize: templateWidth.pixelSize,
          },
          fields: "pixelSize",
        },
      });
    }

    // 4. Update all repeated table header rows (and any top stats row using same date header)
    const headerRowIndicesToUpdate = [...(structure.headerRowNumbers || [])].map((r) => r - 1);
    for (const statsRow of structure.websiteStatsRows || []) {
      const rIdx = statsRow.rowNumber - 1;
      const cellText = String(displayRows[rIdx]?.[insertIdx] || "").trim();
      if (cellText && structure.latestDateHeader && cellText === structure.latestDateHeader) {
        headerRowIndicesToUpdate.push(rIdx);
      }
    }

    const uniqueHeaderRows = [...new Set(headerRowIndicesToUpdate)].sort((a, b) => a - b);
    for (const rIdx of uniqueHeaderRows) {
      requests.push({
        updateCells: {
          start: {
            sheetId: sheetIdNum,
            rowIndex: rIdx,
            columnIndex: insertIdx,
          },
          rows: [{ values: [{ userEnteredValue: { stringValue: datePlan.targetDateLabel } }] }],
          fields: "userEnteredValue",
        },
      });
    }
  }

  // 5. Write validated ranking values into target date column (single cell updates with narrow fields mask)
  const targetColIdx = datePlan.targetColIndex;
  for (const item of rankUpdates) {
    requests.push({
      updateCells: {
        start: {
          sheetId: sheetIdNum,
          rowIndex: item.rowNumber - 1,
          columnIndex: targetColIdx,
        },
        rows: [{ values: [toCellValue(item.newRank)] }],
        fields: "userEnteredValue",
      },
    });
  }

  // 6. Write verified ranking URLs into SERP column for confirmed ranked results only
  const serpColIdx = Math.max(
    0,
    (columnLettersToIndex(structure.columnMappings?.serpColumn || "G") || 7) - 1
  );
  for (const item of serpUpdates) {
    requests.push({
      updateCells: {
        start: {
          sheetId: sheetIdNum,
          rowIndex: item.rowNumber - 1,
          columnIndex: serpColIdx,
        },
        rows: [{ values: [toCellValue(item.newSerpUrl)] }],
        fields: "userEnteredValue",
      },
    });
  }

  return requests;
}

