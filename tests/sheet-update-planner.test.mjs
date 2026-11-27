import assert from "node:assert/strict";
import test from "node:test";
import { TASK_STATUSES } from "../modules/jobs/job-state.js";
import { validateCrossClientSheetConfigurations } from "../modules/sheets/sheet-range-validator.js";
import { buildSheetUpdatePlan } from "../modules/sheets/sheet-update-planner.js";
import { detectSheetStructure } from "../modules/sheets/sheet-structure-detector.js";
import { resolveTargetWorksheet } from "../modules/sheets/spreadsheet-validator.js";
import {
  FICTIONAL_SPREADSHEET_ID,
  FICTIONAL_WORKSHEET_ID,
  FICTIONAL_WORKSHEET_NAME,
  SAMPLE_DISPLAY_ROWS,
  SAMPLE_FORMULA_ROWS,
  SAMPLE_METADATA_RESPONSE,
} from "./fixtures/sample-sheets.js";

test("worksheet ID 0 and case-sensitive spreadsheet IDs + cross-client collisions are handled accurately", () => {
  // Worksheet ID 0 resolution
  const wsZero = resolveTargetWorksheet(SAMPLE_METADATA_RESPONSE.sheets, { worksheetId: 0 });
  assert.equal(wsZero.ok, true);
  assert.equal(wsZero.worksheet.sheetId, "0");
  assert.equal(wsZero.worksheet.title, "Overview");

  // Case-sensitive spreadsheet IDs: 1AbC !== 1abc
  const diffCase = validateCrossClientSheetConfigurations({
    clients: [
      { clientId: "c1", clientName: "C1", sheetConfig: { spreadsheetId: "1AbCdEfGhIjK", worksheetName: "SEO", latestDateColumn: "H" } },
      { clientId: "c2", clientName: "C2", sheetConfig: { spreadsheetId: "1abcdefghijk", worksheetName: "SEO", latestDateColumn: "H" } },
    ],
  });
  assert.equal(diffCase.valid, true);

  // Same exact spreadsheetId + same worksheet across two different clients -> BLOCKED
  const sameSheetCrossClient = validateCrossClientSheetConfigurations({
    clients: [
      { clientId: "c1", clientName: "C1", sheetConfig: { spreadsheetId: "1AbCdEfGhIjK", worksheetName: "SEO", latestDateColumn: "H" } },
      { clientId: "c2", clientName: "C2", sheetConfig: { spreadsheetId: "1AbCdEfGhIjK", worksheetName: "SEO", latestDateColumn: "I" } },
    ],
  });
  assert.equal(sameSheetCrossClient.valid, false);
  assert.match(sameSheetCrossClient.collisions[0], /Separate clients/i);
});

test("update planner handles valid rankings, SERP updates, confirmed NA, CAPTCHA/incomplete exclusions, duplicate rows, and manual HTML rejection", () => {
  const structure = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    spreadsheetTitle: SAMPLE_METADATA_RESPONSE.properties.title,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    locale: "en_AU",
    timeZone: "Australia/Sydney",
    displayRows: SAMPLE_DISPLAY_ROWS,
    formulaRows: SAMPLE_FORMULA_ROWS,
  });

  const client = {
    clientId: "cli_apex",
    clientName: "Apex Plumbing",
    sheetConfig: {
      spreadsheetId: FICTIONAL_SPREADSHEET_ID,
      worksheetId: FICTIONAL_WORKSHEET_ID,
      worksheetName: FICTIONAL_WORKSHEET_NAME,
    },
  };
  const job = { jobId: "job_1", clientId: "cli_apex", locationId: "loc_1" };

  // Test rejection of Manual SERP HTML / non-live tasks in plan
  const tasks = [
    {
      taskId: "t_row7",
      rowNumber: 7,
      rowPosition: 7,
      keyword: "emergency plumber sydney",
      status: TASK_STATUSES.RANKED,
      position: 1,
      rankingUrl: "https://apexservices.example.com/emergency",
      sourceMode: "live_bulk",
      browserGpsStatus: "GPS verified",
      googleLocationStatus: "Google location matched",
      googleLocationSourceType: "device",
      isLiveVerified: true,
    },
    {
      taskId: "t_row8",
      rowNumber: 8,
      rowPosition: 8,
      keyword: "blocked drains sydney",
      status: TASK_STATUSES.NOT_FOUND,
      checkedResults: 50,
      actualVerifiedDepth: 50,
      requestedDepth: 50,
      sourceMode: "live_bulk",
      browserGpsStatus: "GPS verified",
      googleLocationStatus: "Google location matched",
      googleLocationSourceType: "device",
      isLiveVerified: true,
    },
    {
      taskId: "t_row14",
      rowNumber: 14,
      rowPosition: 14,
      keyword: "emergency plumber sydney", // duplicate keyword row 14
      status: TASK_STATUSES.SEARCH_BLOCKED,
      isLiveVerified: false,
    },
    {
      taskId: "t_row15",
      rowNumber: 15,
      rowPosition: 15,
      keyword: "hot water repair",
      status: TASK_STATUSES.RANKED,
      position: 4,
      rankingUrl: "https://apexservices.example.com/hot-water",
      source: "manual_html", // must be rejected
      isLiveVerified: false,
    },
  ];

  const planRes = buildSheetUpdatePlan({
    client,
    location: { locationId: "loc_1", locationName: "Sydney" },
    job,
    tasks,
    liveStructure: structure,
    displayRows: SAMPLE_DISPLAY_ROWS,
    reportingDate: "2026-11-30",
  });

  assert.equal(planRes.ok, true);
  assert.equal(planRes.plan.validRankingUpdates, 1);
  assert.equal(planRes.plan.confirmedNaUpdates, 1);
  assert.equal(planRes.plan.skippedOrFailedCount, 2); // CAPTCHA row 14 + Manual HTML row 15 skipped!
  assert.equal(planRes.plan.rankUpdates.length, 2);
  assert.equal(planRes.plan.rankUpdates[0].rowNumber, 7);
  assert.equal(planRes.plan.rankUpdates[0].newRank, 1);
  assert.equal(planRes.plan.rankUpdates[1].rowNumber, 8);
  assert.equal(planRes.plan.rankUpdates[1].newRank, "NA");
  assert.equal(planRes.plan.serpUpdates.length, 1); // Only row 7 confirmed rank updates SERP!
});

