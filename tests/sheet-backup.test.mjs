import assert from "node:assert/strict";
import test from "node:test";
import { createSheetBackupManager } from "../modules/sheets/sheet-backup-manager.js";
import { createGoogleAuthClient, READONLY_SHEETS_SCOPE } from "../modules/sheets/google-auth.js";
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

test("backup manager creates full recoverable backup with grid/formulas/merges/widths and fails if grid incomplete", async () => {
  const storageClient = createInMemoryStorage();
  const mockApi = {
    getSpreadsheetMetadata: async () => ({ ok: true, data: SAMPLE_METADATA_RESPONSE }),
    getSpreadsheetGridDetails: async () => ({ ok: true, data: SAMPLE_GRID_DETAILS }),
    batchGetValues: async (_id, _r, opts) => ({
      ok: true,
      data: {
        valueRanges: [
          { values: opts.valueRenderOption === "FORMULA" ? SAMPLE_FORMULA_ROWS : SAMPLE_DISPLAY_ROWS },
        ],
      },
    }),
  };

  const backupManager = createSheetBackupManager({
    sheetsApiClient: mockApi,
    storageClient,
    idbFactory: null,
  });

  const created = await backupManager.createAndVerifyBackup({
    clientId: "cli_apex",
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    jobId: "job_1",
  });
  assert.equal(created.ok, true);
  assert.equal(created.backup.verificationStatus, "VERIFIED");
  assert.ok(created.backup.snapshotData.formulaValues.length > 0);
  assert.ok(created.backup.snapshotData.merges.length > 0);
  assert.ok(created.backup.snapshotData.gridData);

  const check = backupManager.verifyBackupIntegrity(
    created.backup,
    FICTIONAL_SPREADSHEET_ID,
    FICTIONAL_WORKSHEET_ID
  );
  assert.equal(check.valid, true);

  // Missing / shallow CSV-style backup fails integrity verification!
  const shallowBad = backupManager.verifyBackupIntegrity(
    { ...created.backup, snapshotData: { displayValues: SAMPLE_DISPLAY_ROWS } },
    FICTIONAL_SPREADSHEET_ID,
    FICTIONAL_WORKSHEET_ID
  );
  assert.equal(shallowBad.valid, false);
});

test("write scope requires explicit opt-in and authorization confirmation", async () => {
  const storageClient = createInMemoryStorage();
  const auth = createGoogleAuthClient({
    identityApi: {
      getAuthToken(_opts, cb) {
        cb("ephemeral-write-tok");
      },
      removeCachedAuthToken(_opts, cb) {
        cb();
      },
    },
    runtimeApi: {
      getManifest: () => ({
        oauth2: { client_id: "123456.apps.googleusercontent.com", scopes: [READONLY_SHEETS_SCOPE] },
      }),
    },
    storageClient,
  });

  const before = await auth.getStatus();
  assert.equal(before.writeAccessEnabled, false);

  // Blocked without userConfirmed
  const unconfirmedWrite = await auth.enableWriteAccess({ userConfirmed: false });
  assert.equal(unconfirmedWrite.ok, false);

  // Allowed when user confirms opt-in
  const enabledWrite = await auth.enableWriteAccess({ userConfirmed: true });
  assert.equal(enabledWrite.ok, true);
  assert.equal((await auth.getStatus()).writeAccessEnabled, true);
});

