/**
 * IndexedDB schema versioning and safe store migrations for Digital Minds Rank Tracker.
 */

export const DATABASE_NAME = "dm_rank_tracker_db";
export const CURRENT_SCHEMA_VERSION = 2;

export const STORES = Object.freeze({
  CLIENTS: "clients",
  LOCATIONS: "locations",
  KEYWORDS: "keywords",
  JOBS: "jobs",
  RESULTS: "results",
  BACKUPS: "backups",
  SHEET_SNAPSHOTS: "sheet_snapshots",
});

/**
 * Apply incremental IndexedDB schema migrations safely.
 */
export function applyIdbMigrations(db, oldVersion, _newVersion) {
  if (oldVersion < 1) {
    if (!db.objectStoreNames.contains(STORES.CLIENTS)) {
      const clientStore = db.createObjectStore(STORES.CLIENTS, { keyPath: "clientId" });
      clientStore.createIndex("by_status", "status", { unique: false });
      clientStore.createIndex("by_name", "clientName", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORES.LOCATIONS)) {
      const locStore = db.createObjectStore(STORES.LOCATIONS, { keyPath: "locationId" });
      locStore.createIndex("by_client", "clientId", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORES.KEYWORDS)) {
      const kwStore = db.createObjectStore(STORES.KEYWORDS, { keyPath: "keywordId" });
      kwStore.createIndex("by_client", "clientId", { unique: false });
      kwStore.createIndex("by_location", "locationId", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORES.JOBS)) {
      const jobStore = db.createObjectStore(STORES.JOBS, { keyPath: "jobId" });
      jobStore.createIndex("by_client", "clientId", { unique: false });
      jobStore.createIndex("by_location", "locationId", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORES.RESULTS)) {
      const resStore = db.createObjectStore(STORES.RESULTS, { keyPath: "recordKey" });
      resStore.createIndex("by_job", "jobId", { unique: false });
      resStore.createIndex("by_client", "clientId", { unique: false });
      resStore.createIndex("by_location", "locationId", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORES.BACKUPS)) {
      const backupStore = db.createObjectStore(STORES.BACKUPS, { keyPath: "backupId" });
      backupStore.createIndex("by_client", "clientId", { unique: false });
    }
  }
  if (oldVersion < 2) {
    if (!db.objectStoreNames.contains(STORES.SHEET_SNAPSHOTS)) {
      const snapStore = db.createObjectStore(STORES.SHEET_SNAPSHOTS, { keyPath: "snapshotKey" });
      snapStore.createIndex("by_client", "clientId", { unique: false });
      snapStore.createIndex("by_spreadsheet", "spreadsheetId", { unique: false });
    }
  }
}

export const DB_SCHEMA_KEY = "dm_db_schema_version";
export const DB_FALLBACK_KEY = "dm_db_fallback_stores";

/**
 * Migrate chrome.storage.local fallback stores cleanly between schema versions.
 */
export async function ensureFallbackSchema(storageClient, targetVersion = CURRENT_SCHEMA_VERSION) {
  const res = await storageClient.get([DB_SCHEMA_KEY, DB_FALLBACK_KEY]);
  const currentVersion = Number(res?.[DB_SCHEMA_KEY] || 0);
  let data = res?.[DB_FALLBACK_KEY];

  if (!data || typeof data !== "object") {
    data = {};
  }

  if (currentVersion < 2) {
    for (const storeName of Object.values(STORES)) {
      if (!data[storeName] || typeof data[storeName] !== "object") {
        data[storeName] = {};
      }
    }
  }

  if (currentVersion !== targetVersion) {
    await storageClient.set({
      [DB_SCHEMA_KEY]: targetVersion,
      [DB_FALLBACK_KEY]: data,
    });
  }

  return { schemaVersion: targetVersion, data };
}

