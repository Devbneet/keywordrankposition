import assert from "node:assert/strict";
import test from "node:test";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createUpdateJournal, OPERATION_STATES } from "../modules/sheets/update-journal.js";

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

test("updateJournal prevents concurrent spreadsheet locks, blocks duplicate plans, and reconciles lost API responses without duplicate inserts", async () => {
  const clientStorage = createClientStorage({ storageClient: createInMemoryStorage(), idbFactory: null });
  const journal = createUpdateJournal({ clientStorage });

  // Concurrent lock enforcement
  const lock1 = journal.acquireSpreadsheetLock("sheet_1", "op_a");
  assert.equal(lock1.acquired, true);
  const lock2 = journal.acquireSpreadsheetLock("sheet_1", "op_b");
  assert.equal(lock2.acquired, false);
  journal.releaseSpreadsheetLock("sheet_1", "op_a");
  assert.equal(journal.acquireSpreadsheetLock("sheet_1", "op_b").acquired, true);

  // Record successful operation -> duplicate check rejects re-execution
  await journal.recordOperation({
    operationId: "op_done",
    clientId: "c1",
    jobId: "j1",
    spreadsheetId: "sheet_1",
    worksheetId: "0",
    planFingerprint: "plan_abc_123",
    status: OPERATION_STATES.UPDATE_SUCCESSFUL,
  });
  const dup = await journal.hasSuccessfulDuplicateUpdate({
    spreadsheetId: "sheet_1",
    worksheetId: "0",
    planFingerprint: "plan_abc_123",
  });
  assert.equal(dup.duplicate, true);

  // Lost response reconciliation: live sheet already has 30-November & rank=1 -> reconciles as UPDATE_SUCCESSFUL
  const reconciledHit = await journal.reconcileLostWriteResponse({
    sheetReader: {
      readAndAnalyzeSheet: async () => ({
        ok: true,
        structure: {
          latestDateHeader: "30-November",
          keywordRows: [{ rowNumber: 7, latestRank: "1" }],
        },
      }),
    },
    operationEntry: {
      operationId: "op_lost_1",
      clientId: "c1",
      jobId: "j1",
      spreadsheetId: "sheet_1",
      worksheetId: "0",
      backupId: "bkp_1",
    },
    plan: {
      spreadsheetId: "sheet_1",
      worksheetId: "0",
      targetDateLabel: "30-November",
      rankUpdates: [{ rowNumber: 7, newRank: 1 }],
    },
  });
  assert.equal(reconciledHit.applied, true);
  assert.equal(reconciledHit.status, OPERATION_STATES.UPDATE_SUCCESSFUL);

  // Lost response reconciliation when write never reached sheet -> safe UPDATE_FAILED without retry
  const reconciledMiss = await journal.reconcileLostWriteResponse({
    sheetReader: {
      readAndAnalyzeSheet: async () => ({
        ok: true,
        structure: {
          latestDateHeader: "23-November",
          keywordRows: [{ rowNumber: 7, latestRank: "2" }],
        },
      }),
    },
    operationEntry: {
      operationId: "op_lost_2",
      clientId: "c1",
      jobId: "j1",
      spreadsheetId: "sheet_1",
      worksheetId: "0",
      backupId: "bkp_1",
    },
    plan: {
      spreadsheetId: "sheet_1",
      worksheetId: "0",
      targetDateLabel: "30-November",
      rankUpdates: [{ rowNumber: 7, newRank: 1 }],
    },
  });
  assert.equal(reconciledMiss.applied, false);
  assert.equal(reconciledMiss.status, OPERATION_STATES.UPDATE_FAILED);
});

