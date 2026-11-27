/**
 * Client-isolated persistence layer built on modules/storage/database.js.
 * Guarantees unique identifiers, client isolation, cascade cleanup, and backup/restore.
 */

import { createDatabase, STORES } from "../storage/database.js";

export const ACTIVE_CLIENT_KEY = "dm_active_client_selection";

export function createClientStorage({
  storageClient,
  idbFactory = globalThis.indexedDB || null,
} = {}) {
  const db = createDatabase({ storageClient, idbFactory });

  async function saveClient(client) {
    if (!client?.clientId) {
      return { ok: false, error: "clientId is required." };
    }
    return db.putOne(STORES.CLIENTS, client);
  }

  async function getClient(clientId) {
    return db.getByKey(STORES.CLIENTS, clientId);
  }

  async function listClients() {
    const clients = await db.getAll(STORES.CLIENTS);
    return clients.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  }

  async function saveLocation(location) {
    if (!location?.locationId || !location?.clientId) {
      return { ok: false, error: "locationId and clientId are required." };
    }
    return db.putOne(STORES.LOCATIONS, location);
  }

  async function listLocationsByClient(clientId) {
    const rows = await db.getByIndex(STORES.LOCATIONS, "by_client", clientId);
    return rows.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  }

  async function deleteLocation(locationId) {
    return db.deleteMany(STORES.LOCATIONS, [locationId]);
  }

  async function saveKeyword(keywordRecord) {
    if (!keywordRecord?.keywordId || !keywordRecord?.clientId) {
      return { ok: false, error: "keywordId and clientId are required." };
    }
    return db.putOne(STORES.KEYWORDS, keywordRecord);
  }

  async function saveKeywordsBulk(keywordRecords) {
    return db.putMany(STORES.KEYWORDS, keywordRecords);
  }

  async function listKeywordsByClient(clientId) {
    const rows = await db.getByIndex(STORES.KEYWORDS, "by_client", clientId);
    return rows.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }

  async function deleteKeyword(keywordId) {
    return db.deleteMany(STORES.KEYWORDS, [keywordId]);
  }

  async function saveJobRecord(job) {
    if (!job?.jobId || !job?.clientId) {
      return { ok: false, error: "jobId and clientId are required." };
    }
    return db.putOne(STORES.JOBS, job);
  }

  async function getJobRecord(jobId) {
    if (!jobId) return null;
    return db.getByKey(STORES.JOBS, jobId);
  }

  async function listJobsByClient(clientId) {
    const rows = await db.getByIndex(STORES.JOBS, "by_client", clientId);
    return rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  async function saveResultsBatch(results) {
    const clean = results.map((r) => {
      const { rawHtml: _discard, ...rest } = r;
      return {
        ...rest,
        recordKey: rest.recordKey || `${rest.clientId}::${rest.jobId}::${rest.taskId}`,
      };
    });
    return db.putMany(STORES.RESULTS, clean);
  }

  async function listResultsByClient(clientId) {
    const rows = await db.getByIndex(STORES.RESULTS, "by_client", clientId);
    return rows.sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0));
  }

  async function deleteClientCascade(clientId) {
    const locations = await listLocationsByClient(clientId);
    const keywords = await listKeywordsByClient(clientId);
    const jobs = await listJobsByClient(clientId);
    const results = await listResultsByClient(clientId);
    const snapshots = await listSheetSnapshotsByClient(clientId);

    const steps = [
      () => db.deleteMany(STORES.LOCATIONS, locations.map((l) => l.locationId)),
      () => db.deleteMany(STORES.KEYWORDS, keywords.map((k) => k.keywordId)),
      () => db.deleteMany(STORES.JOBS, jobs.map((j) => j.jobId)),
      () => db.deleteMany(STORES.RESULTS, results.map((r) => r.recordKey)),
      () => db.deleteMany(STORES.SHEET_SNAPSHOTS, snapshots.map((s) => s.snapshotKey)),
      () => db.deleteMany(STORES.CLIENTS, [clientId]),
    ];

    for (const step of steps) {
      const res = await step();
      if (!res.ok) return res;
    }
    return { ok: true };
  }

  async function createClientBackup(clientId) {
    const client = await getClient(clientId);
    if (!client) {
      return { ok: false, error: `Client '${clientId}' not found.` };
    }
    const backup = {
      backupId: `bkp_${clientId}_${Date.now()}`,
      clientId,
      createdAt: new Date().toISOString(),
      client,
      locations: await listLocationsByClient(clientId),
      keywords: await listKeywordsByClient(clientId),
      jobs: await listJobsByClient(clientId),
      results: await listResultsByClient(clientId),
    };
    const res = await db.putOne(STORES.BACKUPS, backup);
    if (!res.ok) return res;
    return { ok: true, backup };
  }

  async function listClientBackups(clientId) {
    const rows = await db.getByIndex(STORES.BACKUPS, "by_client", clientId);
    return rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  async function restoreClientBackup(backup) {
    if (!backup?.client?.clientId) {
      return { ok: false, error: "Invalid client backup payload." };
    }
    const clientId = backup.client.clientId;
    const clearRes = await deleteClientCascade(clientId);
    if (!clearRes.ok) return clearRes;

    const steps = [
      () => saveClient(backup.client),
      () => (backup.locations?.length ? db.putMany(STORES.LOCATIONS, backup.locations) : { ok: true }),
      () => (backup.keywords?.length ? db.putMany(STORES.KEYWORDS, backup.keywords) : { ok: true }),
      () => (backup.jobs?.length ? db.putMany(STORES.JOBS, backup.jobs) : { ok: true }),
      () => (backup.results?.length ? saveResultsBatch(backup.results) : { ok: true }),
    ];
    for (const step of steps) {
      const res = await step();
      if (!res.ok) return res;
    }
    return { ok: true, clientId };
  }

  async function setActiveSelection({ clientId = null, locationId = null } = {}) {
    try {
      await storageClient.set({
        [ACTIVE_CLIENT_KEY]: { clientId, locationId, updatedAt: new Date().toISOString() },
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function getActiveSelection() {
    const res = await storageClient.get(ACTIVE_CLIENT_KEY);
    return res?.[ACTIVE_CLIENT_KEY] || { clientId: null, locationId: null };
  }

  async function saveSheetSnapshot(snapshot) {
    if (!snapshot?.snapshotKey || !snapshot?.clientId) {
      return { ok: false, error: "snapshotKey and clientId are required." };
    }
    return db.putOne(STORES.SHEET_SNAPSHOTS, snapshot);
  }

  async function listSheetSnapshotsByClient(clientId) {
    const rows = await db.getByIndex(STORES.SHEET_SNAPSHOTS, "by_client", clientId);
    return rows.sort((a, b) => String(b.importedAt || "").localeCompare(String(a.importedAt || "")));
  }

  async function saveUpdateJournalEntry(entry) {
    if (!entry?.operationId) {
      return { ok: false, error: "operationId is required." };
    }
    return db.putOne(STORES.UPDATE_JOURNAL, entry);
  }

  async function listUpdateJournalByClient(clientId) {
    const rows = await db.getByIndex(STORES.UPDATE_JOURNAL, "by_client", clientId);
    return rows.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  }

  async function listUpdateJournalBySpreadsheet(spreadsheetId) {
    const rows = await db.getByIndex(STORES.UPDATE_JOURNAL, "by_spreadsheet", spreadsheetId);
    return rows.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  }

  return {
    getSchemaInfo: db.getSchemaInfo,
    saveClient,
    getClient,
    listClients,
    saveLocation,
    listLocationsByClient,
    deleteLocation,
    saveKeyword,
    saveKeywordsBulk,
    listKeywordsByClient,
    deleteKeyword,
    saveJobRecord,
    getJobRecord,
    listJobsByClient,
    saveResultsBatch,
    listResultsByClient,
    saveSheetSnapshot,
    listSheetSnapshotsByClient,
    saveUpdateJournalEntry,
    listUpdateJournalByClient,
    listUpdateJournalBySpreadsheet,
    deleteClientCascade,
    createClientBackup,
    listClientBackups,
    restoreClientBackup,
    setActiveSelection,
    getActiveSelection,
  };
}

