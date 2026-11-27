import assert from "node:assert/strict";
import test from "node:test";
import { TASK_STATUSES } from "../modules/jobs/job-state.js";
import { detectSheetStructure } from "../modules/sheets/sheet-structure-detector.js";
import { buildSheetUpdatePlan } from "../modules/sheets/sheet-update-planner.js";
import { buildRecoveryPlan } from "../modules/sheets/update-recovery.js";
import { verifyPostUpdateSpreadsheet } from "../modules/sheets/update-verifier.js";
import {
  FICTIONAL_SPREADSHEET_ID,
  FICTIONAL_WORKSHEET_ID,
  FICTIONAL_WORKSHEET_NAME,
  SAMPLE_DISPLAY_ROWS,
  SAMPLE_FORMULA_ROWS,
  SAMPLE_METADATA_RESPONSE,
} from "./fixtures/sample-sheets.js";

test("verifyPostUpdateSpreadsheet verifies shifted columns, date headers, ranks, SERP URLs, stats, formulas, merges, and detects tampering", () => {
  const preStruct = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    locale: "en_AU",
    timeZone: "Australia/Sydney",
    displayRows: SAMPLE_DISPLAY_ROWS,
    formulaRows: SAMPLE_FORMULA_ROWS,
    merges: SAMPLE_METADATA_RESPONSE.sheets[1].merges,
    hasFilter: true,
    conditionalFormats: [{ booleanRule: {} }],
  });

  const planRes = buildSheetUpdatePlan({
    client: { clientId: "c1", clientName: "Apex", sheetConfig: { spreadsheetId: FICTIONAL_SPREADSHEET_ID } },
    job: { jobId: "j1", clientId: "c1" },
    tasks: [
      {
        taskId: "t1",
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
    ],
    liveStructure: preStruct,
    displayRows: SAMPLE_DISPLAY_ROWS,
    reportingDate: "2026-11-30",
  });

  // Construct valid post-update rows matching exact single-column shift at index 7 (Col H)
  const postDisplay = SAMPLE_DISPLAY_ROWS.map((row) => {
    const r = [...row];
    if (r.length > 7) r.splice(7, 0, "");
    return r;
  });
  postDisplay[5][7] = "30-November";
  postDisplay[12][7] = "30-November";
  postDisplay[6][7] = "1";
  postDisplay[6][6] = "https://apexservices.example.com/emergency";

  const postFormulas = SAMPLE_FORMULA_ROWS.map((row) => {
    const r = [...row];
    if (r.length > 7) r.splice(7, 0, "");
    return r;
  });
  // Simulated Google Sheets automatic relative formula shift H7:H8 -> I7:I8
  postFormulas[8][8] = "=AVERAGE(I7:I8)";

  const shiftedMerges = SAMPLE_METADATA_RESPONSE.sheets[1].merges.map((m) => ({
    ...m,
    endColumnIndex: m.endColumnIndex > 7 ? m.endColumnIndex + 1 : m.endColumnIndex,
  }));

  const postStruct = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    locale: "en_AU",
    timeZone: "Australia/Sydney",
    displayRows: postDisplay,
    formulaRows: postFormulas,
    merges: shiftedMerges,
    hasFilter: true,
    conditionalFormats: [{ booleanRule: {} }],
  });

  const okVerify = verifyPostUpdateSpreadsheet({
    plan: planRes.plan,
    preUpdateStructure: preStruct,
    preUpdateDisplayRows: SAMPLE_DISPLAY_ROWS,
    postUpdateStructure: postStruct,
    postUpdateDisplayRows: postDisplay,
  });
  assert.equal(okVerify.verified, true);
  assert.deepEqual(okVerify.issues, []);

  // Tamper with historical ranking in shifted Col I (row 7 old rank 2 -> 99) -> MUST FAIL VERIFICATION
  const corruptedDisplay = structuredClone(postDisplay);
  corruptedDisplay[6][8] = "99";
  const badStruct = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    displayRows: corruptedDisplay,
    formulaRows: postFormulas,
    merges: SAMPLE_METADATA_RESPONSE.sheets[1].merges,
    hasFilter: true,
    conditionalFormats: [{ booleanRule: {} }],
  });
  const failVerify = verifyPostUpdateSpreadsheet({
    plan: planRes.plan,
    preUpdateStructure: preStruct,
    preUpdateDisplayRows: SAMPLE_DISPLAY_ROWS,
    postUpdateStructure: badStruct,
    postUpdateDisplayRows: corruptedDisplay,
  });
  assert.equal(failVerify.verified, false);
  assert.ok(failVerify.issues.length > 0);

  const recovery = buildRecoveryPlan({
    operationEntry: { operationId: "op_1" },
    backupRecord: { backupId: "sbkp_1", verificationStatus: "VERIFIED", createdAt: "2026-11-26" },
    verificationIssues: failVerify.issues,
  });
  assert.equal(recovery.automaticRollbackAllowed, false);
  assert.equal(recovery.backupAvailable, true);
});

