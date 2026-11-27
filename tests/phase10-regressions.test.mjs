import assert from "node:assert/strict";
import test from "node:test";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createLocationManager } from "../modules/clients/location-manager.js";
import { createHistoryStorage, normalizeHistoryRecord } from "../modules/history/history-storage.js";
import {
  calculateRankingMovement,
  isValidComparableResult,
  MOVEMENT_TYPES,
} from "../modules/history/ranking-comparison.js";
import { buildCurrentAndPreviousSnapshots } from "../modules/history/ranking-history.js";
import { computeAgencyOverviewMetrics } from "../modules/history/ranking-metrics.js";
import { TASK_STATUSES } from "../modules/jobs/job-state.js";
import { createGoogleAuthClient } from "../modules/sheets/google-auth.js";
import { createSheetBackupManager } from "../modules/sheets/sheet-backup-manager.js";
import { createSheetReader } from "../modules/sheets/sheet-reader.js";
import { createSheetUpdater } from "../modules/sheets/sheet-updater.js";
import { createSheetsApiClient } from "../modules/sheets/sheets-api-client.js";
import { UPDATE_MODES } from "../modules/sheets/sheets-write-client.js";
import { createUpdateJournal } from "../modules/sheets/update-journal.js";
import {
  FICTIONAL_SPREADSHEET_ID,
  FICTIONAL_WORKSHEET_ID,
  FICTIONAL_WORKSHEET_NAME,
  SAMPLE_DISPLAY_ROWS,
  SAMPLE_FORMULA_ROWS,
  SAMPLE_GRID_DETAILS,
  SAMPLE_METADATA_RESPONSE,
} from "./fixtures/sample-sheets.js";

const FICTIONAL_SPREADSHEET_URL = `https://docs.google.com/spreadsheets/d/${FICTIONAL_SPREADSHEET_ID}/edit#gid=${FICTIONAL_WORKSHEET_ID}`;

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

test("Phase 10 fix: backup verification requires contentIntegrityHash, non-null preWriteSnapshotFingerprint, and bound approvedPlanFingerprint", async () => {
  const storageClient = createInMemoryStorage();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });
  const locationManager = createLocationManager({ clientStorage });

  await clientStorage.saveClient({
    clientId: "cli_apex",
    clientName: "Apex Home Services",
    websiteDomain: "apexservices.example.com",
    sheetConfig: {
      sheetUrl: FICTIONAL_SPREADSHEET_URL,
      spreadsheetId: FICTIONAL_SPREADSHEET_ID,
      worksheetId: FICTIONAL_WORKSHEET_ID,
      worksheetName: FICTIONAL_WORKSHEET_NAME,
      headerRow: 6,
      keywordColumn: "C",
      serpUrlColumn: "G",
      latestDateColumn: "H",
    },
  });
  await clientStorage.saveLocation({
    locationId: "loc_syd",
    clientId: "cli_apex",
    locationName: "Sydney, NSW, Australia",
    country: "Australia",
    language: "en",
  });

  const authClient = createGoogleAuthClient({
    identityApi: { getAuthToken: (_o, cb) => cb("tok"), removeCachedAuthToken: (_o, cb) => cb() },
    runtimeApi: {
      getManifest: () => ({
        oauth2: { client_id: "c", scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] },
      }),
    },
    storageClient,
  });
  await authClient.enableWriteAccess({ userConfirmed: true });

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("values:batchGet")) {
      const vals = u.includes("FORMULA") ? SAMPLE_FORMULA_ROWS : SAMPLE_DISPLAY_ROWS;
      return { ok: true, status: 200, json: async () => ({ valueRanges: [{ values: vals }] }) };
    }
    if (u.includes("includeGridData=true")) {
      return { ok: true, status: 200, json: async () => SAMPLE_GRID_DETAILS };
    }
    return { ok: true, status: 200, json: async () => SAMPLE_METADATA_RESPONSE };
  };

  const sheetsApiClient = createSheetsApiClient({ authClient, fetchImpl: mockFetch });
  const sheetReader = createSheetReader({ sheetsApiClient, clientStorage });
  const backupManager = createSheetBackupManager({ sheetsApiClient, storageClient, idbFactory: null });
  const updater = createSheetUpdater({
    authClient,
    sheetReader,
    sheetsApiClient,
    sheetsWriteClient: { executeBatchUpdate: async () => ({ ok: true }) },
    backupManager,
    updateJournal: createUpdateJournal({ clientStorage }),
    clientStorage,
    locationManager,
  });

  const job = { jobId: "job_p10_1", clientId: "cli_apex" };
  const tasks = [
    {
      taskId: "t_7",
      rowNumber: 7,
      rowPosition: 7,
      keyword: "emergency plumber sydney",
      status: TASK_STATUSES.RANKED,
      position: 2,
      rankingUrl: "https://apexservices.example.com/emergency",
      sourceMode: "live_bulk",
      browserGpsStatus: "GPS verified",
      googleLocationStatus: "Google location matched",
      googleLocationSourceType: "device",
      isLiveVerified: true,
    },
  ];
  const prevRes = await updater.generatePreview({ clientId: "cli_apex", job, tasks, reportingDate: "2026-11-30" });
  assert.equal(prevRes.ok, true, JSON.stringify({ error: prevRes.error, errors: prevRes.errors }));

  const bkpRes = await backupManager.createAndVerifyBackup({
    clientId: "cli_apex",
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    jobId: job.jobId,
    approvedPlanFingerprint: prevRes.preview.planFingerprint,
    preWriteSnapshotFingerprint: prevRes.snapshot.structureFingerprint,
  });
  assert.equal(bkpRes.ok, true);
  assert.ok(bkpRes.backup.contentIntegrityHash);
  assert.ok(bkpRes.backup.approvedPlanFingerprint);
  assert.ok(bkpRes.backup.preWriteSnapshotFingerprint);

  // Strip contentIntegrityHash -> rejected
  const noHash = { ...bkpRes.backup, contentIntegrityHash: null };
  assert.equal(
    backupManager.verifyBackupIntegrity(noHash, FICTIONAL_SPREADSHEET_ID, FICTIONAL_WORKSHEET_ID).valid,
    false
  );

  // Strip preWriteSnapshotFingerprint -> rejected (do not bypass when null!)
  const noPreWrite = { ...bkpRes.backup, preWriteSnapshotFingerprint: null };
  assert.equal(
    backupManager.verifyBackupIntegrity(noPreWrite, FICTIONAL_SPREADSHEET_ID, FICTIONAL_WORKSHEET_ID, {
      expectedPreWriteFingerprint: prevRes.snapshot.structureFingerprint,
    }).valid,
    false
  );

  // Create an unbound backup (null approvedPlanFingerprint) and attempt executeApprovedUpdate -> rejected!
  const unboundBackup = await backupManager.createAndVerifyBackup({
    clientId: "cli_apex",
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    approvedPlanFingerprint: null,
  });
  const blockedExec = await updater.executeApprovedUpdate({
    clientId: "cli_apex",
    job,
    tasks,
    approvedPreview: prevRes.preview,
    approvalConfirmation: true,
    backupId: unboundBackup.backup.backupId,
    reportingDate: "2026-11-30",
    mode: UPDATE_MODES.SANDBOX,
    dryRun: false,
  });
  assert.equal(blockedExec.ok, false);
  assert.match(blockedExec.error, /approvedPlanFingerprint/i);
});

test("Phase 10 fix: stateful fictional sheet restoreFromBackup actually restores values, formulas, merges and basicFilter", async () => {
  const storageClient = createInMemoryStorage();
  const stateSheet = {
    displayRows: structuredClone(SAMPLE_DISPLAY_ROWS),
    formulaRows: structuredClone(SAMPLE_FORMULA_ROWS),
    merges: structuredClone(SAMPLE_GRID_DETAILS.sheets[0].merges),
    basicFilter: structuredClone(SAMPLE_GRID_DETAILS.sheets[0].basicFilter),
  };

  const mockApi = {
    getSpreadsheetMetadata: async () => ({ ok: true, data: SAMPLE_METADATA_RESPONSE }),
    getSpreadsheetGridDetails: async () => ({ ok: true, data: SAMPLE_GRID_DETAILS }),
    batchGetValues: async (_id, _r, opts) => ({
      ok: true,
      data: {
        valueRanges: [
          {
            values: structuredClone(
              opts.valueRenderOption === "FORMULA" ? stateSheet.formulaRows : stateSheet.displayRows
            ),
          },
        ],
      },
    }),
  };

  const statefulWriteClient = {
    async executeBatchUpdate({ requests }) {
      const nextMerges = [];
      for (const req of requests) {
        if (req.updateCells) {
          const { startRowIndex, startColumnIndex } = req.updateCells.range;
          req.updateCells.rows.forEach((rowObj, rOffset) => {
            const rIdx = startRowIndex + rOffset;
            if (!stateSheet.displayRows[rIdx]) stateSheet.displayRows[rIdx] = [];
            if (!stateSheet.formulaRows[rIdx]) stateSheet.formulaRows[rIdx] = [];
            rowObj.values.forEach((cellObj, cOffset) => {
              const cIdx = startColumnIndex + cOffset;
              const v = cellObj.userEnteredValue || {};
              if (v.formulaValue !== undefined) {
                stateSheet.formulaRows[rIdx][cIdx] = v.formulaValue;
                stateSheet.displayRows[rIdx][cIdx] = v.formulaValue;
              } else if (v.numberValue !== undefined) {
                stateSheet.formulaRows[rIdx][cIdx] = String(v.numberValue);
                stateSheet.displayRows[rIdx][cIdx] = String(v.numberValue);
              } else {
                stateSheet.formulaRows[rIdx][cIdx] = v.stringValue ?? "";
                stateSheet.displayRows[rIdx][cIdx] = v.stringValue ?? "";
              }
            });
          });
        }
        if (req.mergeCells) {
          nextMerges.push(req.mergeCells.range);
        }
        if (req.setBasicFilter) {
          stateSheet.basicFilter = req.setBasicFilter.filter;
        }
      }
      if (nextMerges.length > 0) stateSheet.merges = nextMerges;
      return { ok: true, data: { replies: [{}] } };
    },
  };

  const bkpMgr = createSheetBackupManager({
    sheetsApiClient: mockApi,
    sheetsWriteClient: statefulWriteClient,
    storageClient,
    idbFactory: null,
  });

  const created = await bkpMgr.createAndVerifyBackup({
    clientId: "cli_apex",
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    approvedPlanFingerprint: "plan_restore_fixture",
  });
  assert.equal(created.ok, true);

  // Corrupt the live stateful worksheet fixture (values, formula in row 3/index 2, merges, and filter)
  stateSheet.displayRows[6][2] = "CORRUPTED KEYWORD";
  stateSheet.displayRows[6][7] = "999";
  stateSheet.formulaRows[2][3] = "0";
  stateSheet.merges = [];
  stateSheet.basicFilter = null;

  const restoreRes = await bkpMgr.restoreFromBackup({
    backupRecord: created.backup,
    mode: "sandbox",
    dryRun: false,
    confirmedByUser: true,
  });
  assert.equal(restoreRes.ok, true, restoreRes.error);
  assert.equal(stateSheet.displayRows[6][2], SAMPLE_DISPLAY_ROWS[6][2]);
  assert.equal(stateSheet.displayRows[6][7], SAMPLE_DISPLAY_ROWS[6][7]);
  assert.equal(stateSheet.formulaRows[2][3], SAMPLE_FORMULA_ROWS[2][3]);
  assert.equal(stateSheet.merges.length, SAMPLE_GRID_DETAILS.sheets[0].merges.length);
  assert.ok(stateSheet.basicFilter?.range);
});

test("Phase 10 fix: historyStorage generates deterministic resultIds on recovery and comparison rejects mock/unverified/manual sources", async () => {
  const storageClient = createInMemoryStorage();
  const historyStorage = createHistoryStorage({ storageClient, idbFactory: null });

  const baseRaw = {
    clientId: "cli_apex",
    locationId: "loc_syd",
    jobId: "job_rec_1",
    taskId: "task_row_7",
    keywordId: "kw_7",
    keywordText: "emergency plumber sydney",
    status: TASK_STATUSES.RANKED,
    position: 4,
    isLiveVerified: true,
    timestamp: "2026-11-30T08:00:00.000Z",
  };

  const firstNorm = normalizeHistoryRecord(baseRaw);
  const secondNorm = normalizeHistoryRecord(baseRaw);
  assert.equal(firstNorm.resultId, secondNorm.resultId);

  // Saving the same recovered job task twice keeps count === 1 (idempotent upsert)
  await historyStorage.saveRankingHistoryBatch([baseRaw]);
  await historyStorage.saveRankingHistoryBatch([{ ...baseRaw, timestamp: "2026-11-30T08:01:00.000Z" }]);
  const stored = await historyStorage.queryRankingHistory({ clientId: "cli_apex", jobId: "job_rec_1" });
  assert.equal(stored.length, 1);

  // Comparison rejects manual_html, mock, and isLiveVerified=false results
  const verifiedPrev = {
    clientId: "cli_apex",
    locationId: "loc_syd",
    deviceType: "Desktop",
    requestedDepth: 50,
    resultStatus: TASK_STATUSES.RANKED,
    rankingPosition: 8,
    sourceMode: "live_bulk",
    isLiveVerified: true,
  };
  const mockResult = normalizeHistoryRecord({
    ...baseRaw,
    resultId: "r_mock",
    sourceMode: "mock",
    isMock: true,
    isLiveVerified: true,
  });
  assert.equal(mockResult.isLiveVerified, false);
  assert.equal(isValidComparableResult(mockResult), false);
  assert.equal(isValidComparableResult({ ...verifiedPrev, isLiveVerified: false }), false);
  assert.equal(calculateRankingMovement(verifiedPrev, mockResult).movementType, MOVEMENT_TYPES.FAILED_EXCLUDED);
  assert.equal(
    calculateRankingMovement(verifiedPrev, { ...verifiedPrev, isLiveVerified: false }).movementType,
    MOVEMENT_TYPES.FAILED_EXCLUDED
  );

  // Overview KPIs & snapshot builders keep mock/unverified/manual out of live metrics
  const metrics = computeAgencyOverviewMetrics({
    clients: [{ clientId: "cli_apex", status: "active" }],
    historyRecords: [
      { ...firstNorm, timestamp: "2026-11-30T08:00:00.000Z" },
      mockResult,
      normalizeHistoryRecord({ ...baseRaw, resultId: "r_unverified", isLiveVerified: false }),
    ],
    todayIso: "2026-11-30",
  });
  assert.equal(metrics.keywordsCheckedToday, 1);
  assert.equal(buildCurrentAndPreviousSnapshots([mockResult]).length, 0);
});
