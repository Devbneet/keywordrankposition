/**
 * Unified IndexedDB database layer with safe schema migrations, quota error handling,
 * and automatic fallback to chrome.storage.local when IndexedDB is unavailable.
 */

import {
  applyIdbMigrations,
  CURRENT_SCHEMA_VERSION,
  DATABASE_NAME,
  DB_FALLBACK_KEY,
  ensureFallbackSchema,
  STORES,
} from "./migrations.js";

export { STORES };

function isQuotaError(error) {
  if (!error) return false;
  const name = String(error.name || "");
  const msg = String(error.message || error);
  return name === "QuotaExceededError" || /quota|storage.*full/i.test(msg);
}

function getKeyFieldForStore(storeName) {
  switch (storeName) {
    case STORES.CLIENTS:
      return "clientId";
    case STORES.LOCATIONS:
      return "locationId";
    case STORES.KEYWORDS:
      return "keywordId";
    case STORES.JOBS:
      return "jobId";
    case STORES.RESULTS:
      return "recordKey";
    case STORES.BACKUPS:
      return "backupId";
    case STORES.SHEET_SNAPSHOTS:
      return "snapshotKey";
    case STORES.UPDATE_JOURNAL:
      return "operationId";
    default:
      return "id";
  }
}

function openIndexedDb(idbFactory, version = CURRENT_SCHEMA_VERSION) {
  return new Promise((resolve, reject) => {
    const req = idbFactory.open(DATABASE_NAME, version);
    req.onupgradeneeded = (event) => {
      applyIdbMigrations(req.result, event.oldVersion || 0, version);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB."));
  });
}

function runTx(db, storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let out;
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
    out = fn(tx);
  });
}

export function createDatabase({
  storageClient,
  idbFactory = globalThis.indexedDB || null,
  schemaVersion = CURRENT_SCHEMA_VERSION,
} = {}) {
  if (!storageClient) {
    throw new Error("storageClient is required for createDatabase.");
  }

  let fallbackWriteChain = Promise.resolve();
  function serializeFallbackWrite(fn) {
    const next = fallbackWriteChain.then(fn, fn);
    fallbackWriteChain = next.catch(() => {});
    return next;
  }

  async function getAll(storeName) {
    if (idbFactory) {
      const db = await openIndexedDb(idbFactory, schemaVersion);
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction([storeName], "readonly");
          const req = tx.objectStore(storeName).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error || new Error(`Failed reading ${storeName}.`));
        });
      } finally {
        db.close();
      }
    }

    const { data } = await ensureFallbackSchema(storageClient, schemaVersion);
    return Object.values(data[storeName] || {});
  }

  async function getByKey(storeName, key) {
    if (!key) return null;
    if (idbFactory) {
      const db = await openIndexedDb(idbFactory, schemaVersion);
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction([storeName], "readonly");
          const req = tx.objectStore(storeName).get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error || new Error(`Failed getting key from ${storeName}.`));
        });
      } finally {
        db.close();
      }
    }

    const { data } = await ensureFallbackSchema(storageClient, schemaVersion);
    return data[storeName]?.[key] || null;
  }

  async function getByIndex(storeName, indexName, indexValue) {
    if (indexValue === undefined || indexValue === null) return [];
    if (idbFactory) {
      const db = await openIndexedDb(idbFactory, schemaVersion);
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction([storeName], "readonly");
          const idx = tx.objectStore(storeName).index(indexName);
          const req = idx.getAll(indexValue);
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error || new Error(`Failed querying ${storeName}.${indexName}.`));
        });
      } finally {
        db.close();
      }
    }

    const all = await getAll(storeName);
    const fieldMap = {
      by_client: "clientId",
      by_location: "locationId",
      by_job: "jobId",
      by_status: "status",
      by_name: "clientName",
      by_spreadsheet: "spreadsheetId",
    };
    const field = fieldMap[indexName] || indexName;
    return all.filter((item) => item?.[field] === indexValue);
  }

  async function putMany(storeName, records) {
    const keyField = getKeyFieldForStore(storeName);
    try {
      if (idbFactory) {
        const db = await openIndexedDb(idbFactory, schemaVersion);
        try {
          await runTx(db, [storeName], "readwrite", (tx) => {
            const store = tx.objectStore(storeName);
            for (const rec of records) {
              store.put(rec);
            }
          });
        } finally {
          db.close();
        }
        return { ok: true, count: records.length };
      }

      return await serializeFallbackWrite(async () => {
        const { data } = await ensureFallbackSchema(storageClient, schemaVersion);
        if (!data[storeName]) data[storeName] = {};
        for (const rec of records) {
          const key = rec?.[keyField];
          if (!key) {
            return { ok: false, error: `Missing primary key '${keyField}' for ${storeName}.` };
          }
          data[storeName][key] = structuredClone(rec);
        }
        await storageClient.set({ [DB_FALLBACK_KEY]: data });
        return { ok: true, count: records.length };
      });
    } catch (error) {
      return {
        ok: false,
        quotaExceeded: isQuotaError(error),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function putOne(storeName, record) {
    return putMany(storeName, [record]);
  }

  async function deleteMany(storeName, keys) {
    try {
      if (idbFactory) {
        const db = await openIndexedDb(idbFactory, schemaVersion);
        try {
          await runTx(db, [storeName], "readwrite", (tx) => {
            const store = tx.objectStore(storeName);
            for (const key of keys) {
              store.delete(key);
            }
          });
        } finally {
          db.close();
        }
        return { ok: true };
      }

      return await serializeFallbackWrite(async () => {
        const { data } = await ensureFallbackSchema(storageClient, schemaVersion);
        if (data[storeName]) {
          for (const key of keys) {
            delete data[storeName][key];
          }
        }
        await storageClient.set({ [DB_FALLBACK_KEY]: data });
        return { ok: true };
      });
    } catch (error) {
      return {
        ok: false,
        quotaExceeded: isQuotaError(error),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function getSchemaInfo() {
    if (idbFactory) {
      const db = await openIndexedDb(idbFactory, schemaVersion);
      const info = { backend: "indexedDB", version: db.version, stores: [...db.objectStoreNames] };
      db.close();
      return info;
    }
    const { schemaVersion: ver, data } = await ensureFallbackSchema(storageClient, schemaVersion);
    return { backend: "chrome.storage.local", version: ver, stores: Object.keys(data) };
  }

  return {
    getAll,
    getByKey,
    getByIndex,
    putOne,
    putMany,
    deleteMany,
    getSchemaInfo,
  };
}

