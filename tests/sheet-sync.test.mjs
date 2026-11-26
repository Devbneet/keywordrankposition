import assert from "node:assert/strict";
import test from "node:test";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { buildImportedKeywords } from "../modules/sheets/keyword-importer.js";
import { compareSnapshotWithStructure, createSheetSnapshot } from "../modules/sheets/sheet-snapshot.js";
import { detectSheetStructure } from "../modules/sheets/sheet-structure-detector.js";
import { applyConfirmedSheetSync, computeSheetSyncDiff } from "../modules/sheets/sheet-sync.js";
import {
  FICTIONAL_SPREADSHEET_ID,
  FICTIONAL_WORKSHEET_ID,
  FICTIONAL_WORKSHEET_NAME,
  SAMPLE_DISPLAY_ROWS,
  SAMPLE_FORMULA_ROWS,
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

test("sheetSync detects added, removed, edited, moved rows, landing page edits, structure drift, and requires confirmation without wiping history", async () => {
  const storageClient = createInMemoryStorage();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });

  await clientStorage.saveClient({ clientId: "c1", clientName: "Apex", websiteDomain: "apex.example.com", status: "active" });
  await clientStorage.saveClient({ clientId: "c2", clientName: "Other", websiteDomain: "other.example.com", status: "active" });
  await clientStorage.saveResultsBatch([
    { taskId: "t_hist_1", jobId: "job_prev", clientId: "c1", keyword: "emergency plumber sydney", status: "Confirmed ranking", position: 2 },
  ]);

  const initialStruct = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    displayRows: SAMPLE_DISPLAY_ROWS,
    formulaRows: SAMPLE_FORMULA_ROWS,
  });
  const initialKws = buildImportedKeywords({ clientId: "c1", structure: initialStruct });
  const initialSnap = createSheetSnapshot({ clientId: "c1", structure: initialStruct });

  // Unconfirmed sync MUST be rejected
  const unconfirmed = await applyConfirmedSheetSync({
    clientStorage,
    clientId: "c1",
    incomingKeywords: initialKws,
    snapshot: initialSnap,
    confirmed: false,
  });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.requiresConfirmation, true);

  const confirmed1 = await applyConfirmedSheetSync({
    clientStorage,
    clientId: "c1",
    incomingKeywords: initialKws,
    snapshot: initialSnap,
    confirmed: true,
  });
  assert.equal(confirmed1.ok, true);

  // Now simulate sheet modifications:
  // - Row 7 landing page changed
  // - Row 8 keyword edited
  // - Row 15 moved to row 16 ("hot water repair") & added row 17 ("gas fitter sydney")
  const modifiedRows = structuredClone(SAMPLE_DISPLAY_ROWS);
  modifiedRows[6][5] = "/emergency-v2"; // row 7 LP changed
  modifiedRows[7][2] = "drain unblocking sydney"; // row 8 keyword edited
  modifiedRows.splice(14, 1, [], modifiedRows[14], ["", "", "gas fitter sydney", "590", "Low", "/gas", "", "NA", "", ""]);

  const modifiedStruct = detectSheetStructure({
    spreadsheetId: FICTIONAL_SPREADSHEET_ID,
    worksheetId: FICTIONAL_WORKSHEET_ID,
    worksheetName: FICTIONAL_WORKSHEET_NAME,
    displayRows: modifiedRows,
  });
  const modifiedKws = buildImportedKeywords({ clientId: "c1", structure: modifiedStruct });
  const savedC1Kws = await clientStorage.listKeywordsByClient("c1");

  const diff = computeSheetSyncDiff({
    previousSnapshot: initialSnap,
    savedKeywords: savedC1Kws,
    incomingKeywords: modifiedKws,
    currentStructure: modifiedStruct,
  });

  assert.equal(diff.hasChanges, true);
  assert.equal(diff.changedLandingPages.length, 1);
  assert.equal(diff.editedKeywords.length, 1);
  assert.equal(diff.movedRows.length, 1);
  assert.equal(diff.movedRows[0].previousRow, 15);
  assert.equal(diff.movedRows[0].newRow, 16);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.structureChanged, true);

  const driftCheck = compareSnapshotWithStructure(initialSnap, modifiedStruct);
  assert.equal(driftCheck.safeToUpdate, false);

  // Apply confirmed sync and verify ranking history & other clients remain untouched
  const confirmed2 = await applyConfirmedSheetSync({
    clientStorage,
    clientId: "c1",
    incomingKeywords: modifiedKws,
    snapshot: createSheetSnapshot({ clientId: "c1", structure: modifiedStruct }),
    confirmed: true,
  });
  assert.equal(confirmed2.ok, true);
  assert.equal((await clientStorage.listResultsByClient("c1")).length, 1);
  assert.equal((await clientStorage.listKeywordsByClient("c2")).length, 0);
});

