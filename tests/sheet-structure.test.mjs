import assert from "node:assert/strict";
import test from "node:test";
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

test("detectSheetStructure identifies stats rows, multiple groups, repeated headers, separators, duplicate rows, formulas, merges, and formatting", () => {
  const structure = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    spreadsheetTitle: SAMPLE_METADATA_RESPONSE.properties.title,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    locale: "en_AU",
    timeZone: "Australia/Sydney",
    displayRows: SAMPLE_DISPLAY_ROWS,
    formulaRows: SAMPLE_FORMULA_ROWS,
    merges: SAMPLE_METADATA_RESPONSE.sheets[1].merges,
    protectedRanges: SAMPLE_METADATA_RESPONSE.sheets[1].protectedRanges,
    hasFilter: true,
    gridSheet: SAMPLE_GRID_DETAILS.sheets[0],
  });

  assert.equal(structure.isAmbiguous, false);
  assert.deepEqual(structure.headerRowNumbers, [6, 13]);
  assert.deepEqual(structure.blankSeparatorRowNumbers, [10, 11]);
  assert.equal(structure.websiteStatsRows.length, 3);
  assert.equal(structure.latestDateColumn, "H");
  assert.equal(structure.latestDateHeader, "23-November");
  assert.deepEqual(
    structure.historicalDateColumns.map((c) => c.header),
    ["16-November", "09-November"]
  );

  // Only 4 real keyword rows (row 9 Total summary & banners excluded!)
  assert.equal(structure.keywordRows.length, 4);
  assert.equal(structure.keywordRows[0].rowNumber, 7);
  assert.equal(structure.keywordRows[0].keywordGroup, "Primary Plumbing Keywords");
  assert.equal(structure.keywordRows[0].serpUrl, "https://apexservices.example.com/emergency");
  assert.deepEqual(structure.keywordRows[0].historicalRankings, {
    "16-November": "3",
    "09-November": "4",
  });

  // Duplicate keyword in Row 14 preserved under Hot Water Keywords
  assert.equal(structure.keywordRows[2].rowNumber, 14);
  assert.equal(structure.keywordRows[2].keyword, "emergency plumber sydney");
  assert.equal(structure.keywordRows[2].keywordGroup, "Hot Water Keywords");

  // Formulas, merges, filter, and navy/green/yellow fills detected
  assert.ok(structure.formulaCells.some((f) => f.a1 === "G7"));
  assert.equal(structure.mergedRanges.length, 2);
  assert.equal(structure.hasFilter, true);
  assert.ok(structure.formattingMetadata.detectedColors.includes("navy"));
  assert.ok(structure.formattingMetadata.detectedColors.includes("green"));
  assert.ok(structure.formattingMetadata.detectedColors.includes("yellow"));
});

test("detectSheetStructure supports custom column mappings and warns on ambiguous headerless sheets", () => {
  const customDisplay = [
    ["Keyword", "Monthly Searches", "Comp", "Target URL", "Ranking URL", "30-Nov", "23-Nov"],
    ["custom roofing melbourne", "720", "Low", "/roofing", "https://roof.example.com/roofing", "4", "6"],
  ];

  const customStruct = detectSheetStructure({
    spreadsheetId: "s_custom",
    worksheetId: "1",
    worksheetName: "Custom",
    displayRows: customDisplay,
    columnConfig: {
      keywordColumn: "A",
      searchVolumeColumn: "B",
      competitionColumn: "C",
      landingPageColumn: "D",
      serpColumn: "E",
      latestDateColumn: "F",
    },
  });

  assert.equal(customStruct.isAmbiguous, false);
  assert.equal(customStruct.keywordRows.length, 1);
  assert.equal(customStruct.keywordRows[0].searchVolume, "720");
  assert.deepEqual(customStruct.keywordRows[0].historicalRankings, { "23-Nov": "6" });

  const ambiguous = detectSheetStructure({
    spreadsheetId: "s_ambig",
    worksheetId: "2",
    worksheetName: "NoHeaders",
    displayRows: [["", "", "just random text"]],
  });
  assert.equal(ambiguous.isAmbiguous, true);
  assert.ok(ambiguous.warnings.length > 0);
});

