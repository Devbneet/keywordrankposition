import assert from "node:assert/strict";
import test from "node:test";
import { formatDateForSheet, planDateColumnOperation } from "../modules/sheets/date-column-manager.js";
import { buildAtomicBatchUpdateRequests } from "../modules/sheets/sheet-format-manager.js";
import { detectSheetStructure } from "../modules/sheets/sheet-structure-detector.js";
import {
  FICTIONAL_SPREADSHEET_ID,
  FICTIONAL_WORKSHEET_ID,
  FICTIONAL_WORKSHEET_NAME,
  SAMPLE_DISPLAY_ROWS,
  SAMPLE_FORMULA_ROWS,
  SAMPLE_GRID_DETAILS,
  SAMPLE_METADATA_RESPONSE,
} from "./fixtures/sample-sheets.js";

test("formatDateForSheet matches template style in spreadsheet timezone and handles insert vs same-date reuse vs inconsistencies", () => {
  assert.equal(
    formatDateForSheet({
      dateInput: "2026-11-30",
      locale: "en_AU",
      timeZone: "Australia/Sydney",
      existingHeaderPattern: "23-November",
    }),
    "30-November"
  );
  assert.equal(
    formatDateForSheet({
      dateInput: "2026-11-30",
      locale: "en_AU",
      timeZone: "Australia/Sydney",
      existingHeaderPattern: "23-Nov",
    }),
    "30-Nov"
  );
  assert.equal(
    formatDateForSheet({
      dateInput: "2026-11-30",
      timeZone: "UTC",
      existingHeaderPattern: "2026-11-23",
    }),
    "2026-11-30"
  );

  const structure = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    spreadsheetTitle: SAMPLE_METADATA_RESPONSE.properties.title,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    locale: "en_AU",
    timeZone: "Australia/Sydney",
    displayRows: SAMPLE_DISPLAY_ROWS,
    formulaRows: SAMPLE_FORMULA_ROWS,
    gridSheet: SAMPLE_GRID_DETAILS.sheets[0],
  });

  // New date 30-November -> INSERT_NEW_COLUMN at index 7 (Col H)
  const insertPlan = planDateColumnOperation({
    structure,
    displayRows: SAMPLE_DISPLAY_ROWS,
    reportingDate: "2026-11-30",
  });
  assert.equal(insertPlan.ok, true);
  assert.equal(insertPlan.action, "INSERT_NEW_COLUMN");
  assert.equal(insertPlan.willInsertColumn, true);
  assert.equal(insertPlan.targetColumnLetter, "H");

  // Same date 23-November -> REUSE_EXISTING_COLUMN (prevents duplicate column)
  const reusePlan = planDateColumnOperation({
    structure,
    displayRows: SAMPLE_DISPLAY_ROWS,
    reportingDate: "2026-11-23",
  });
  assert.equal(reusePlan.ok, true);
  assert.equal(reusePlan.action, "REUSE_EXISTING_COLUMN");
  assert.equal(reusePlan.willInsertColumn, false);

  // Historical date 16-November -> blocked to protect historical data
  const histBlocked = planDateColumnOperation({
    structure,
    displayRows: SAMPLE_DISPLAY_ROWS,
    reportingDate: "2026-11-16",
  });
  assert.equal(histBlocked.ok, false);
  assert.match(histBlocked.error, /historical/i);

  // Inconsistent repeated headers -> blocked
  const badRows = structuredClone(SAMPLE_DISPLAY_ROWS);
  badRows[12][7] = "16-November";
  const inconsistent = planDateColumnOperation({
    structure,
    displayRows: badRows,
    reportingDate: "2026-11-30",
  });
  assert.equal(inconsistent.ok, false);
});

test("buildAtomicBatchUpdateRequests emits format-only InsertDimension, CopyPaste(PASTE_FORMAT), width, and multi-header updates", () => {
  const structure = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    locale: "en_AU",
    timeZone: "Australia/Sydney",
    displayRows: SAMPLE_DISPLAY_ROWS,
    formulaRows: SAMPLE_FORMULA_ROWS,
    gridSheet: {
      ...SAMPLE_GRID_DETAILS.sheets[0],
      data: [
        {
          ...SAMPLE_GRID_DETAILS.sheets[0].data[0],
          columnMetadata: Array.from({ length: 10 }, (_, idx) => ({ pixelSize: idx === 7 ? 115 : 100 })),
        },
      ],
    },
  });

  const datePlan = planDateColumnOperation({
    structure,
    displayRows: SAMPLE_DISPLAY_ROWS,
    reportingDate: "2026-11-30",
  });

  const requests = buildAtomicBatchUpdateRequests({
    worksheetId: FICTIONAL_WORKSHEET_ID,
    structure,
    displayRows: SAMPLE_DISPLAY_ROWS,
    datePlan,
    rankUpdates: [{ rowNumber: 7, newRank: 1 }],
    serpUpdates: [{ rowNumber: 7, newSerpUrl: "https://apexservices.example.com/emergency" }],
  });

  const insertReq = requests.find((r) => r.insertDimension);
  assert.ok(insertReq);
  assert.equal(insertReq.insertDimension.range.startIndex, 7);
  assert.equal(insertReq.insertDimension.inheritFromBefore, false);

  const copyReq = requests.find((r) => r.copyPaste);
  assert.ok(copyReq);
  assert.equal(copyReq.copyPaste.pasteType, "PASTE_FORMAT");
  assert.equal(copyReq.copyPaste.source.startColumnIndex, 8); // Shifted old H
  assert.equal(copyReq.copyPaste.destination.startColumnIndex, 7); // New H

  const widthReq = requests.find((r) => r.updateDimensionProperties);
  assert.ok(widthReq);
  assert.equal(widthReq.updateDimensionProperties.properties.pixelSize, 115);

  // Repeated header rows (rows 6 & 13 -> 0-based 5 & 12) both updated cleanly
  const headerCellUpdates = requests.filter(
    (r) => r.updateCells && r.updateCells.rows[0].values[0].userEnteredValue.stringValue === "30-November"
  );
  assert.deepEqual(headerCellUpdates.map((u) => u.updateCells.start.rowIndex), [5, 12]);
});

