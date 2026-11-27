import assert from "node:assert/strict";
import test from "node:test";
import { createClientManager } from "../modules/clients/client-manager.js";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createKeywordManager } from "../modules/clients/keyword-manager.js";
import { createLocationManager } from "../modules/clients/location-manager.js";
import { TASK_STATUSES } from "../modules/jobs/job-state.js";
import { createGoogleAuthClient, READONLY_SHEETS_SCOPE } from "../modules/sheets/google-auth.js";
import { createSheetBackupManager } from "../modules/sheets/sheet-backup-manager.js";
import { createSheetReader } from "../modules/sheets/sheet-reader.js";
import { compareSnapshotWithStructure, createSheetSnapshot } from "../modules/sheets/sheet-snapshot.js";
import { detectSheetStructure } from "../modules/sheets/sheet-structure-detector.js";
import { createSheetUpdater } from "../modules/sheets/sheet-updater.js";
import { createSheetsApiClient } from "../modules/sheets/sheets-api-client.js";
import { createSheetsWriteClient, UPDATE_MODES } from "../modules/sheets/sheets-write-client.js";
import { createUpdateJournal, OPERATION_STATES } from "../modules/sheets/update-journal.js";
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

test("Phase 8 regression: snapshot detects protectedRanges, filters, conditionalFormats, and formatting drift", () => {
  const baseStruct = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    displayRows: SAMPLE_DISPLAY_ROWS,
    formulaRows: SAMPLE_FORMULA_ROWS,
    merges: SAMPLE_METADATA_RESPONSE.sheets[1].merges,
    protectedRanges: [{ description: "Stats", range: { startRowIndex: 0 } }],
    hasFilter: true,
    conditionalFormats: [{ booleanRule: {} }],
  });
  const snap = createSheetSnapshot({ clientId: "c1", structure: baseStruct });

  const changedStruct = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    displayRows: SAMPLE_DISPLAY_ROWS,
    formulaRows: SAMPLE_FORMULA_ROWS,
    merges: SAMPLE_METADATA_RESPONSE.sheets[1].merges,
    protectedRanges: [], // protected range removed!
    hasFilter: false, // filter removed!
    conditionalFormats: [], // conditional format removed!
  });

  const drift = compareSnapshotWithStructure(snap, changedStruct);
  assert.equal(drift.safeToUpdate, false);
  assert.ok(drift.issues.some((i) => /protected ranges/i.test(i)));
  assert.ok(drift.issues.some((i) => /filters/i.test(i)));
  assert.ok(drift.issues.some((i) => /conditional formatting/i.test(i)));
});

test("end-to-end sheetUpdater enforces dry-run/sandbox, backup, structure drift guard, atomic batchUpdate, and post-update verification", async () => {
  const storageClient = createInMemoryStorage();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });
  const locationManager = createLocationManager({ clientStorage });
  const keywordManager = createKeywordManager({ clientStorage });
  const clientManager = createClientManager({ clientStorage, locationManager, keywordManager });

  await clientManager.createClient({
    clientId: "cli_apex",
    clientName: "Apex Plumbing",
    websiteDomain: "apexservices.example.com",
    sheetConfig: {
      spreadsheetId: FICTIONAL_SPREADSHEET_ID,
      worksheetId: FICTIONAL_WORKSHEET_ID,
      worksheetName: FICTIONAL_WORKSHEET_NAME,
    },
  });

  // Live stateful mock Google Sheets server
  let liveDisplay = structuredClone(SAMPLE_DISPLAY_ROWS);
  let liveFormulas = structuredClone(SAMPLE_FORMULA_ROWS);
  let liveMeta = structuredClone(SAMPLE_METADATA_RESPONSE);
  let liveGrid = structuredClone(SAMPLE_GRID_DETAILS);
  let batchUpdateCallCount = 0;

  const mockFetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    if (method === "POST" && url.includes(":batchUpdate")) {
      batchUpdateCallCount += 1;
      const body = JSON.parse(init.body);
      for (const req of body.requests) {
        if (req.insertDimension) {
          const idx = req.insertDimension.range.startIndex;
          liveDisplay = liveDisplay.map((r) => {
            const copy = [...r];
            if (copy.length > idx) copy.splice(idx, 0, "");
            return copy;
          });
          liveFormulas = liveFormulas.map((r) => {
            const copy = [...r];
            if (copy.length > idx) copy.splice(idx, 0, "");
            return copy;
          });
          liveFormulas[8][8] = "=AVERAGE(I7:I8)";
          for (const sh of [liveMeta.sheets[1], liveGrid.sheets[0]]) {
            if (sh.merges) {
              sh.merges = sh.merges.map((m) => ({
                ...m,
                endColumnIndex: m.endColumnIndex > idx ? m.endColumnIndex + 1 : m.endColumnIndex,
              }));
            }
            if (sh.basicFilter?.range && sh.basicFilter.range.endColumnIndex > idx) {
              sh.basicFilter.range.endColumnIndex += 1;
            }
          }
          liveGrid.sheets[0].data[0].rowData.forEach((rowObj) => {
            if (rowObj.values.length > idx) {
              rowObj.values.splice(idx, 0, structuredClone(rowObj.values[idx]));
            }
          });
        }
        if (req.updateCells) {
          const { rowIndex, columnIndex } = req.updateCells.start;
          const cell = req.updateCells.rows[0].values[0].userEnteredValue;
          const val = cell.numberValue !== undefined ? String(cell.numberValue) : cell.stringValue;
          liveDisplay[rowIndex][columnIndex] = val;
        }
      }
      return { ok: true, json: async () => ({ replies: [{}] }) };
    }

    if (url.includes("includeGridData=true")) {
      return { ok: true, json: async () => structuredClone(liveGrid) };
    }
    if (url.includes("valueRenderOption=FORMULA")) {
      return { ok: true, json: async () => ({ valueRanges: [{ values: structuredClone(liveFormulas) }] }) };
    }
    if (url.includes("valueRenderOption=FORMATTED_VALUE")) {
      return { ok: true, json: async () => ({ valueRanges: [{ values: structuredClone(liveDisplay) }] }) };
    }
    return { ok: true, json: async () => structuredClone(liveMeta) };
  };

  const authClient = createGoogleAuthClient({
    identityApi: {
      getAuthToken(_o, cb) {
        cb("tok_live_mock");
      },
      removeCachedAuthToken(_o, cb) {
        cb();
      },
    },
    runtimeApi: {
      getManifest: () => ({
        oauth2: { client_id: "123.apps.googleusercontent.com", scopes: [READONLY_SHEETS_SCOPE] },
      }),
    },
    storageClient,
    fetchImpl: mockFetch,
  });

  const sheetsApiClient = createSheetsApiClient({ authClient, fetchImpl: mockFetch });
  const sheetsWriteClient = createSheetsWriteClient({
    authClient,
    fetchImpl: mockFetch,
    sandboxSpreadsheetIds: [FICTIONAL_SPREADSHEET_ID],
  });
  const sheetReader = createSheetReader({ sheetsApiClient, clientStorage });
  const backupManager = createSheetBackupManager({ sheetsApiClient, storageClient, idbFactory: null });
  const updateJournal = createUpdateJournal({ clientStorage });
  const updater = createSheetUpdater({
    authClient,
    sheetReader,
    sheetsApiClient,
    sheetsWriteClient,
    backupManager,
    updateJournal,
    clientStorage,
    locationManager,
  });

  const job = { jobId: "job_live_1", clientId: "cli_apex" };
  const tasks = [
    {
      taskId: "t_7",
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

  // Enable opt-in write access & follow Preview -> Verified Backup -> Execute workflow
  await authClient.enableWriteAccess({ userConfirmed: true });

  const prevRes = await updater.generatePreview({
    clientId: "cli_apex",
    job,
    tasks,
    reportingDate: "2026-11-30",
  });
  assert.equal(prevRes.ok, true);
  assert.equal(prevRes.preview.willInsertColumn, true);

  const bkp = await backupManager.createAndVerifyBackup({
    clientId: "cli_apex",
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    jobId: job.jobId,
    approvedPlanFingerprint: prevRes.preview.planFingerprint,
    preWriteSnapshotFingerprint: prevRes.snapshot?.structureFingerprint || null,
  });
  assert.equal(bkp.ok, true);

  // Dry-run mode refuses HTTP writes!
  const dryBlocked = await updater.executeApprovedUpdate({
    clientId: "cli_apex",
    job,
    tasks,
    approvedPreview: prevRes.preview,
    approvalConfirmation: true,
    backupId: bkp.backup.backupId,
    reportingDate: "2026-11-30",
    mode: UPDATE_MODES.DRY_RUN,
    dryRun: true,
  });
  assert.equal(dryBlocked.ok, false);
  assert.equal(batchUpdateCallCount, 0);

  // Execute in authorized Sandbox mode -> atomic batchUpdate + post-update verification succeeds!
  const execOk = await updater.executeApprovedUpdate({
    clientId: "cli_apex",
    job,
    tasks,
    approvedPreview: prevRes.preview,
    approvalConfirmation: true,
    backupId: bkp.backup.backupId,
    reportingDate: "2026-11-30",
    mode: UPDATE_MODES.SANDBOX,
    dryRun: false,
  });
  assert.equal(execOk.ok, true, JSON.stringify({ error: execOk.error, issues: execOk.issues, status: execOk.operationStatus }));
  assert.equal(execOk.operationStatus, OPERATION_STATES.UPDATE_SUCCESSFUL);
  assert.equal(batchUpdateCallCount, 1);
  assert.equal(liveDisplay[5][7], "30-November");
  assert.equal(liveDisplay[6][7], "1");
  assert.equal(liveDisplay[6][8], "2"); // Previous 23-November rank preserved safely in I!

  // Duplicate re-submission with same approved plan is blocked cleanly
  const dupBlocked = await updater.executeApprovedUpdate({
    clientId: "cli_apex",
    job,
    tasks,
    approvedPreview: prevRes.preview,
    approvalConfirmation: true,
    backupId: bkp.backup.backupId,
    reportingDate: "2026-11-30",
    mode: UPDATE_MODES.SANDBOX,
    dryRun: false,
  });
  assert.equal(dupBlocked.ok, false);
  assert.equal(dupBlocked.duplicatePrevented, true);
});

