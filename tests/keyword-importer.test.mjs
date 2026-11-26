import assert from "node:assert/strict";
import test from "node:test";
import { buildKeywordQueue } from "../modules/jobs/keyword-queue.js";
import {
  buildBulkQueueFromImported,
  buildImportedKeywords,
  buildSpreadsheetPreview,
} from "../modules/sheets/keyword-importer.js";
import { validateLocationWorksheetIsolation } from "../modules/sheets/sheet-range-validator.js";
import { detectSheetStructure } from "../modules/sheets/sheet-structure-detector.js";
import {
  FICTIONAL_SPREADSHEET_ID,
  FICTIONAL_WORKSHEET_ID,
  FICTIONAL_WORKSHEET_NAME,
  SAMPLE_DISPLAY_ROWS,
  SAMPLE_FORMULA_ROWS,
  SAMPLE_METADATA_RESPONSE,
} from "./fixtures/sample-sheets.js";

test("keyword-importer preserves row numbers, duplicate keywords, exclusions, and bulk queue spreadsheet anchors", () => {
  const structure = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    spreadsheetTitle: SAMPLE_METADATA_RESPONSE.properties.title,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    displayRows: SAMPLE_DISPLAY_ROWS,
    formulaRows: SAMPLE_FORMULA_ROWS,
  });

  const imported = buildImportedKeywords({
    clientId: "cli_apex",
    locationId: "loc_syd",
    structure,
    excludedRowNumbers: [8],
  });

  assert.equal(imported.length, 4);
  assert.equal(imported[0].rowNumber, 7);
  assert.equal(imported[2].rowNumber, 14);
  assert.notEqual(imported[0].keywordId, imported[2].keywordId); // duplicate keyword keeps distinct row ID
  assert.equal(imported[1].excluded, true);

  const preview = buildSpreadsheetPreview({ structure, importedRecords: imported });
  assert.equal(preview.includedKeywordCount, 3);
  assert.equal(preview.excludedKeywordCount, 1);

  const bulkEntries = buildBulkQueueFromImported(imported);
  assert.equal(bulkEntries.length, 3);
  const queue = buildKeywordQueue({
    jobId: "job_sheets_1",
    keywords: bulkEntries,
    clientDomain: "apexservices.example.com",
    locationConfig: { locationName: "Sydney" },
  });
  assert.equal(queue[1].rowNumber, 14);
  assert.equal(queue[1].spreadsheetId, FICTIONAL_SPREADSHEET_ID);
  assert.equal(queue[1].worksheetId, FICTIONAL_WORKSHEET_ID);
});

test("validateLocationWorksheetIsolation catches overlapping column ranges and same-worksheet collisions cleanly", () => {
  const overlapRes = validateLocationWorksheetIsolation({
    sheetConfig: { spreadsheetId: FICTIONAL_SPREADSHEET_ID, worksheetName: "Rankings", latestDateColumn: "H" },
    locations: [
      { locationId: "l1", locationName: "Sydney", worksheetName: "Rankings", reportingRange: "G:J" },
      { locationId: "l2", locationName: "Melbourne", worksheetName: "Rankings", reportingRange: "H2:H50" },
    ],
  });
  assert.equal(overlapRes.valid, false);
  assert.match(overlapRes.collisions[0], /overlap/i);

  const sameTabNoStrategy = validateLocationWorksheetIsolation({
    sheetConfig: { spreadsheetId: FICTIONAL_SPREADSHEET_ID },
    locations: [
      { locationId: "l1", locationName: "Sydney", worksheetName: "Rankings", reportingRange: "H" },
      { locationId: "l2", locationName: "Melbourne", worksheetName: "Rankings", reportingRange: "Z" },
    ],
  });
  assert.equal(sameTabNoStrategy.valid, false);

  const separatedTabs = validateLocationWorksheetIsolation({
    sheetConfig: { spreadsheetId: FICTIONAL_SPREADSHEET_ID },
    locations: [
      { locationId: "l1", locationName: "Sydney", worksheetName: "Sydney SEO", reportingRange: "H" },
      { locationId: "l2", locationName: "Melbourne", worksheetName: "Melbourne SEO", reportingRange: "H" },
    ],
  });
  assert.equal(separatedTabs.valid, true);
});

