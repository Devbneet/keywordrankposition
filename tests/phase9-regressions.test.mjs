import assert from "node:assert/strict";
import test from "node:test";
import { TASK_STATUSES } from "../modules/jobs/job-state.js";
import { createClientManager } from "../modules/clients/client-manager.js";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createKeywordManager } from "../modules/clients/keyword-manager.js";
import { createLocationManager } from "../modules/clients/location-manager.js";
import { createGoogleAuthClient, READONLY_SHEETS_SCOPE } from "../modules/sheets/google-auth.js";
import {
  buildRestoreBatchUpdateRequests,
  createSheetBackupManager,
} from "../modules/sheets/sheet-backup-manager.js";
import { createSheetReader } from "../modules/sheets/sheet-reader.js";
import { detectSheetStructure } from "../modules/sheets/sheet-structure-detector.js";
import { buildSheetUpdatePlan } from "../modules/sheets/sheet-update-planner.js";
import { createSheetUpdater } from "../modules/sheets/sheet-updater.js";
import { createSheetsApiClient } from "../modules/sheets/sheets-api-client.js";
import { UPDATE_MODES } from "../modules/sheets/sheets-write-client.js";
import { verifyPostUpdateSpreadsheet } from "../modules/sheets/update-verifier.js";
import {
  FICTIONAL_SPREADSHEET_ID,
  FICTIONAL_WORKSHEET_ID,
  FICTIONAL_WORKSHEET_NAME,
  SAMPLE_DISPLAY_ROWS,
  SAMPLE_FORMULA_ROWS,
  SAMPLE_GRID_DETAILS,
  SAMPLE_METADATA_RESPONSE,
} from "./fixtures/sample-sheets.js";

function createInMemoryStorage() {
  const map = new Map();
  return {
    async get(keys) {
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (map.has(k)) out[k] = structuredClone(map.get(k));
        return out;
      }
      if (typeof keys === "string") {
        return map.has(keys) ? { [keys]: structuredClone(map.get(keys)) } : {};
      }
      return Object.fromEntries([...map.entries()].map(([k, v]) => [k, structuredClone(v)]));
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

test("Phase 9 regression: backup content integrity hash, binding checks, and recoverable restoration requests work cleanly", async () => {
  const storageClient = createInMemoryStorage();
  const mockApi = {
    getSpreadsheetMetadata: async () => ({ ok: true, data: SAMPLE_METADATA_RESPONSE }),
    getSpreadsheetGridDetails: async () => ({ ok: true, data: SAMPLE_GRID_DETAILS }),
    batchGetValues: async (_id, _r, opts) => ({
      ok: true,
      data: {
        valueRanges: [{ values: opts.valueRenderOption === "FORMULA" ? SAMPLE_FORMULA_ROWS : SAMPLE_DISPLAY_ROWS }],
      },
    }),
  };

  let restoreWrites = 0;
  const mockWriteClient = {
    async executeBatchUpdate({ requests }) {
      restoreWrites += 1;
      assert.ok(requests.some((r) => r.updateCells && r.updateCells.fields.includes("userEnteredFormat")));
      assert.ok(requests.some((r) => r.mergeCells));
      assert.ok(requests.some((r) => r.setBasicFilter));
      return { ok: true, data: { replies: [{}] } };
    },
  };

  const bkpMgr = createSheetBackupManager({
    sheetsApiClient: mockApi,
    sheetsWriteClient: mockWriteClient,
    storageClient,
    idbFactory: null,
  });

  const created = await bkpMgr.createAndVerifyBackup({
    clientId: "cli_apex",
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    approvedPlanFingerprint: "plan_expected_123",
  });
  assert.equal(created.ok, true);
  assert.ok(created.backup.contentIntegrityHash);

  // Mismatched planFingerprint rejected
  const wrongPlan = bkpMgr.verifyBackupIntegrity(created.backup, FICTIONAL_SPREADSHEET_ID, FICTIONAL_WORKSHEET_ID, {
    expectedClientId: "cli_apex",
    expectedPlanFingerprint: "plan_different_999",
  });
  assert.equal(wrongPlan.valid, false);

  // Corrupted backup fails hash integrity check
  const tampered = structuredClone(created.backup);
  tampered.snapshotData.displayValues[6][2] = "tampered keyword";
  const tamperCheck = bkpMgr.verifyBackupIntegrity(tampered, FICTIONAL_SPREADSHEET_ID, FICTIONAL_WORKSHEET_ID);
  assert.equal(tamperCheck.valid, false);
  assert.match(tamperCheck.error, /integrity/i);

  // Recovery batchUpdate generation + dry-run + confirmed sandbox restore work cleanly
  const restoreReq = buildRestoreBatchUpdateRequests(created.backup);
  assert.ok(restoreReq.length >= 4);
  const dryRes = await bkpMgr.restoreFromBackup({ backupRecord: created.backup, dryRun: true });
  assert.equal(dryRes.ok, true);
  assert.equal(dryRes.dryRun, true);
  assert.equal(restoreWrites, 0);

  const liveRestore = await bkpMgr.restoreFromBackup({
    backupRecord: created.backup,
    mode: "sandbox",
    dryRun: false,
    confirmedByUser: true,
  });
  assert.equal(liveRestore.ok, true);
  assert.equal(restoreWrites, 1);
});

test("Phase 9 regression: post-update verifier catches older historical tampering, Volume/Comp edits, merge/filter/CF shifts, and formatting drift", () => {
  const preStruct = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    locale: "en_AU",
    timeZone: "Australia/Sydney",
    displayRows: SAMPLE_DISPLAY_ROWS,
    formulaRows: SAMPLE_FORMULA_ROWS,
    merges: [{ startRowIndex: 0, endRowIndex: 1, startColumnIndex: 2, endColumnIndex: 8 }],
    basicFilter: { range: { startRowIndex: 5, endRowIndex: 14, startColumnIndex: 2, endColumnIndex: 10 } },
    hasFilter: true,
    conditionalFormats: [{ booleanRule: {}, ranges: [{ startRowIndex: 6, endRowIndex: 9, startColumnIndex: 7, endColumnIndex: 9 }] }],
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

  const postDisplay = SAMPLE_DISPLAY_ROWS.map((row) => {
    const r = [...row];
    if (r.length > 7) r.splice(7, 0, "");
    return r;
  });
  postDisplay[5][7] = "30-November";
  postDisplay[12][7] = "30-November";
  postDisplay[6][7] = "1";
  // Corrupt OLDER historical value under 09-November (now shifted to index 10!)
  postDisplay[6][10] = "999";
  // Also tamper search volume in row 7 col D
  postDisplay[6][3] = "0";

  const badPostStruct = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    displayRows: postDisplay,
    formulaRows: SAMPLE_FORMULA_ROWS,
    // Merge failed to expand after column insert
    merges: [{ startRowIndex: 0, endRowIndex: 1, startColumnIndex: 2, endColumnIndex: 8 }],
    basicFilter: { range: { startRowIndex: 5, endRowIndex: 14, startColumnIndex: 2, endColumnIndex: 10 } },
    hasFilter: true,
    conditionalFormats: [{ booleanRule: {}, ranges: [{ startRowIndex: 6, endRowIndex: 9, startColumnIndex: 7, endColumnIndex: 9 }] }],
  });

  const verifyFail = verifyPostUpdateSpreadsheet({
    plan: planRes.plan,
    preUpdateStructure: preStruct,
    preUpdateDisplayRows: SAMPLE_DISPLAY_ROWS,
    postUpdateStructure: badPostStruct,
    postUpdateDisplayRows: postDisplay,
  });

  assert.equal(verifyFail.verified, false);
  assert.ok(verifyFail.issues.some((i) => /09-November/i.test(i)));
  assert.ok(verifyFail.issues.some((i) => /Volume/i.test(i)));
  assert.ok(verifyFail.issues.some((i) => /merged cell ranges/i.test(i)));
  assert.ok(verifyFail.issues.some((i) => /filter range/i.test(i)));
  assert.ok(verifyFail.issues.some((i) => /Conditional formatting/i.test(i)));
});

test("Phase 9 regression: journal persistence failure blocks initiating a live write", async () => {
  const storageClient = createInMemoryStorage();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });
  const locationManager = createLocationManager({ clientStorage });
  const keywordManager = createKeywordManager({ clientStorage });
  const clientManager = createClientManager({ clientStorage, locationManager, keywordManager });

  await clientManager.createClient({
    clientId: "cli_apex",
    clientName: "Apex Plumbing",
    websiteDomain: "apexservices.example.com",
    sheetConfig: { spreadsheetId: FICTIONAL_SPREADSHEET_ID, worksheetId: FICTIONAL_WORKSHEET_ID, worksheetName: FICTIONAL_WORKSHEET_NAME },
  });

  const mockFetch = async (url) => {
    if (url.includes("includeGridData=true")) return { ok: true, json: async () => SAMPLE_GRID_DETAILS };
    if (url.includes("valueRenderOption=FORMULA")) return { ok: true, json: async () => ({ valueRanges: [{ values: SAMPLE_FORMULA_ROWS }] }) };
    if (url.includes("valueRenderOption=FORMATTED_VALUE")) return { ok: true, json: async () => ({ valueRanges: [{ values: SAMPLE_DISPLAY_ROWS }] }) };
    return { ok: true, json: async () => SAMPLE_METADATA_RESPONSE };
  };

  const authClient = createGoogleAuthClient({
    identityApi: { getAuthToken: (_o, cb) => cb("tok"), removeCachedAuthToken: (_o, cb) => cb() },
    runtimeApi: { getManifest: () => ({ oauth2: { client_id: "123.apps.googleusercontent.com", scopes: [READONLY_SHEETS_SCOPE] } }) },
    storageClient,
    fetchImpl: mockFetch,
  });
  await authClient.enableWriteAccess({ userConfirmed: true });

  const sheetsApiClient = createSheetsApiClient({ authClient, fetchImpl: mockFetch });
  const sheetReader = createSheetReader({ sheetsApiClient, clientStorage });
  const backupManager = createSheetBackupManager({ sheetsApiClient, storageClient, idbFactory: null });

  let writeAttempted = false;
  const failingJournal = {
    createOperationId: () => "op_fail_test",
    acquireSpreadsheetLock: () => ({ acquired: true }),
    releaseSpreadsheetLock: () => {},
    hasSuccessfulDuplicateUpdate: async () => ({ duplicate: false }),
    recordOperation: async () => ({ ok: false, error: "Simulated journal write error" }),
  };

  const updater = createSheetUpdater({
    authClient,
    sheetReader,
    sheetsApiClient,
    sheetsWriteClient: {
      executeBatchUpdate: async () => {
        writeAttempted = true;
        return { ok: true };
      },
    },
    backupManager,
    updateJournal: failingJournal,
    clientStorage,
    locationManager,
  });

  const tasks = [
    {
      taskId: "t7",
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
  ];
  const prev = await updater.generatePreview({ clientId: "cli_apex", job: { jobId: "j1", clientId: "cli_apex" }, tasks, reportingDate: "2026-11-30" });
  const bkp = await backupManager.createAndVerifyBackup({
    clientId: "cli_apex",
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    approvedPlanFingerprint: prev.preview.planFingerprint,
    preWriteSnapshotFingerprint: prev.snapshot?.structureFingerprint || null,
  });
  const res = await updater.executeApprovedUpdate({
    clientId: "cli_apex",
    job: { jobId: "j1", clientId: "cli_apex" },
    tasks,
    approvedPreview: prev.preview,
    approvalConfirmation: true,
    backupId: bkp.backup.backupId,
    reportingDate: "2026-11-30",
    mode: UPDATE_MODES.SANDBOX,
    dryRun: false,
  });

  assert.equal(res.ok, false);
  assert.match(res.error, /Journal persistence failed/i);
  assert.equal(writeAttempted, false);
});

