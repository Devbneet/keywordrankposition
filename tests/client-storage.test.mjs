import assert from "node:assert/strict";
import test from "node:test";
import { createClientStorage } from "../modules/clients/client-storage.js";
import { createJobStorage, JOB_METADATA_KEYS } from "../modules/jobs/job-storage.js";
import { createDatabase } from "../modules/storage/database.js";
import {
  applyIdbMigrations,
  CURRENT_SCHEMA_VERSION,
  ensureFallbackSchema,
  STORES,
} from "../modules/storage/migrations.js";

function createMockStorageClient() {
  const store = new Map();
  let triggerQuota = false;
  return {
    setFailQuota(flag) {
      triggerQuota = flag;
    },
    async get(keys) {
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) {
          if (store.has(k)) out[k] = structuredClone(store.get(k));
        }
        return out;
      }
      if (typeof keys === "string") {
        return store.has(keys) ? { [keys]: structuredClone(store.get(keys)) } : {};
      }
      return Object.fromEntries([...store.entries()].map(([k, v]) => [k, structuredClone(v)]));
    },
    async set(obj) {
      if (triggerQuota) {
        triggerQuota = false;
        const err = new Error("QUOTA_BYTES quota exceeded");
        err.name = "QuotaExceededError";
        throw err;
      }
      for (const [k, v] of Object.entries(obj)) {
        store.set(k, structuredClone(v));
      }
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) store.delete(k);
    },
  };
}

test("ensureFallbackSchema upgrades version 0 fallback state to CURRENT_SCHEMA_VERSION cleanly", async () => {
  const storageClient = createMockStorageClient();
  const upgraded = await ensureFallbackSchema(storageClient);
  assert.equal(upgraded.schemaVersion, CURRENT_SCHEMA_VERSION);
  for (const storeName of Object.values(STORES)) {
    assert.ok(upgraded.data[storeName]);
  }
});

test("applyIdbMigrations creates all stores and indexes on a mocked IDB database", () => {
  const createdStores = [];
  const mockDb = {
    objectStoreNames: {
      contains: () => false,
    },
    createObjectStore(name, opts) {
      const indexes = [];
      createdStores.push({ name, opts, indexes });
      return {
        indexNames: { contains: () => false },
        createIndex(idxName, keyPath, idxOpts) {
          indexes.push({ idxName, keyPath, idxOpts });
        },
      };
    },
  };

  applyIdbMigrations(mockDb, 0, CURRENT_SCHEMA_VERSION);
  const storeNames = createdStores.map((s) => s.name);
  assert.deepEqual(storeNames.sort(), Object.values(STORES).sort());
  const keywordsStore = createdStores.find((s) => s.name === STORES.KEYWORDS);
  assert.ok(keywordsStore.indexes.some((i) => i.idxName === "by_client"));
});

test("clientStorage isolates data per client, supports backup/restore, and cascades deletes safely", async () => {
  const storageClient = createMockStorageClient();
  const clientStorage = createClientStorage({ storageClient, idbFactory: null });

  await clientStorage.saveClient({ clientId: "c1", clientName: "Alpha", websiteDomain: "alpha.com", status: "active" });
  await clientStorage.saveClient({ clientId: "c2", clientName: "Beta", websiteDomain: "beta.com", status: "active" });
  await clientStorage.saveLocation({ locationId: "l1", clientId: "c1", locationName: "Sydney" });
  await clientStorage.saveLocation({ locationId: "l2", clientId: "c2", locationName: "Melbourne" });
  await clientStorage.saveKeywordsBulk([{ keywordId: "k1", clientId: "c1", keyword: "plumber" }]);
  await clientStorage.saveKeywordsBulk([{ keywordId: "k2", clientId: "c2", keyword: "dentist" }]);
  await clientStorage.saveJobRecord({ jobId: "j1", clientId: "c1", state: "Completed" });
  await clientStorage.saveResultsBatch([
    { taskId: "t1", jobId: "j1", clientId: "c1", keyword: "plumber", position: 2, status: "Ranked" },
  ]);

  const backupRes = await clientStorage.createClientBackup("c1");
  assert.equal(backupRes.ok, true);
  assert.equal(backupRes.backup.client.clientName, "Alpha");
  assert.equal(backupRes.backup.keywords.length, 1);

  await clientStorage.deleteClientCascade("c1");
  assert.equal(await clientStorage.getClient("c1"), null);
  assert.equal((await clientStorage.listKeywordsByClient("c1")).length, 0);
  // Ensure client 2 data was untouched
  assert.ok(await clientStorage.getClient("c2"));
  assert.equal((await clientStorage.listKeywordsByClient("c2")).length, 1);

  const restoreRes = await clientStorage.restoreClientBackup(backupRes.backup);
  assert.equal(restoreRes.ok, true);
  assert.equal((await clientStorage.getClient("c1")).clientName, "Alpha");
  assert.equal((await clientStorage.listResultsByClient("c1")).length, 1);
});

test("database returns structured QuotaExceededError failure when storage quota is exceeded", async () => {
  const storageClient = createMockStorageClient();
  const db = createDatabase({ storageClient, idbFactory: null });
  storageClient.setFailQuota(true);

  const res = await db.putOne(STORES.CLIENTS, { clientId: "c_quota", clientName: "Quota Test" });
  assert.equal(res.ok, false);
  assert.equal(res.quotaExceeded, true);
  assert.match(res.error, /quota/i);
});

test("clearActiveJob preserves JOB_HISTORY by default and removes only active job metadata", async () => {
  const storageClient = createMockStorageClient();
  const jobStorage = createJobStorage({ storageClient, idbFactory: null });
  await storageClient.set({
    [JOB_METADATA_KEYS.ACTIVE_JOB]: { jobId: "j_active", state: "Completed" },
    [JOB_METADATA_KEYS.JOB_HISTORY]: [{ jobId: "j_old", completedAt: "2026-01-01T00:00:00Z" }],
  });

  const keepRes = await jobStorage.clearActiveJob({ preserveHistory: true });
  assert.equal(keepRes.ok, true);
  const afterKeep = await storageClient.get([
    JOB_METADATA_KEYS.ACTIVE_JOB,
    JOB_METADATA_KEYS.JOB_HISTORY,
  ]);
  assert.equal(afterKeep[JOB_METADATA_KEYS.ACTIVE_JOB], undefined);
  assert.equal(afterKeep[JOB_METADATA_KEYS.JOB_HISTORY].length, 1);
});
