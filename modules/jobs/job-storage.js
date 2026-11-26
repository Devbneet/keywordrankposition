/**
 * Persistent job metadata (chrome.storage.local) and large task collection storage
 * (IndexedDB with safe fallback to chrome.storage.local when IndexedDB is unavailable).
 */

export const JOB_METADATA_KEYS = Object.freeze({
  ACTIVE_JOB: "dm_bulk_active_job",
  JOB_HISTORY: "dm_bulk_job_history",
  TASK_FALLBACK_PREFIX: "dm_bulk_tasks_",
});

const IDB_NAME = "dm_rank_tracker_jobs";
const IDB_VERSION = 1;
const TASKS_STORE = "tasks";
const JOBS_STORE = "jobs";

function isQuotaError(error) {
  if (!error) return false;
  const name = String(error.name || "");
  const msg = String(error.message || error);
  return name === "QuotaExceededError" || /quota|storage.*full/i.test(msg);
}

function openTasksDb(idbFactory) {
  return new Promise((resolve, reject) => {
    const req = idbFactory.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TASKS_STORE)) {
        const taskStore = db.createObjectStore(TASKS_STORE, { keyPath: "recordKey" });
        taskStore.createIndex("by_job", "jobId", { unique: false });
      }
      if (!db.objectStoreNames.contains(JOBS_STORE)) {
        db.createObjectStore(JOBS_STORE, { keyPath: "jobId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB."));
  });
}

function runIdbTransaction(db, storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
    result = fn(tx);
  });
}

export function createJobStorage({
  storageClient,
  idbFactory = globalThis.indexedDB || null,
} = {}) {
  if (!storageClient) {
    throw new Error("storageClient is required for createJobStorage.");
  }

  async function saveJobMetadata(job) {
    try {
      await storageClient.set({ [JOB_METADATA_KEYS.ACTIVE_JOB]: job });

      const histRes = await storageClient.get(JOB_METADATA_KEYS.JOB_HISTORY);
      const history = Array.isArray(histRes?.[JOB_METADATA_KEYS.JOB_HISTORY])
        ? histRes[JOB_METADATA_KEYS.JOB_HISTORY]
        : [];
      const filtered = history.filter((h) => h.jobId !== job.jobId);
      const nextHistory = [job, ...filtered].slice(0, 20);
      await storageClient.set({ [JOB_METADATA_KEYS.JOB_HISTORY]: nextHistory });

      if (idbFactory) {
        const db = await openTasksDb(idbFactory);
        try {
          await runIdbTransaction(db, [JOBS_STORE], "readwrite", (tx) => {
            tx.objectStore(JOBS_STORE).put(job);
          });
        } finally {
          db.close();
        }
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        quotaExceeded: isQuotaError(error),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function loadActiveJob() {
    const res = await storageClient.get(JOB_METADATA_KEYS.ACTIVE_JOB);
    return res?.[JOB_METADATA_KEYS.ACTIVE_JOB] || null;
  }

  async function loadJobHistory() {
    const res = await storageClient.get(JOB_METADATA_KEYS.JOB_HISTORY);
    return Array.isArray(res?.[JOB_METADATA_KEYS.JOB_HISTORY])
      ? res[JOB_METADATA_KEYS.JOB_HISTORY]
      : [];
  }

  async function saveTaskBatch(jobId, tasks) {
    // Strip any accidental large HTML fields before storing.
    const cleanTasks = tasks.map((t) => {
      const { rawHtml: _discard, ...rest } = t;
      return {
        ...rest,
        recordKey: `${jobId}::${t.taskId}`,
      };
    });

    try {
      if (idbFactory) {
        const db = await openTasksDb(idbFactory);
        try {
          await runIdbTransaction(db, [TASKS_STORE], "readwrite", (tx) => {
            const store = tx.objectStore(TASKS_STORE);
            for (const item of cleanTasks) {
              store.put(item);
            }
          });
        } finally {
          db.close();
        }
        return { ok: true };
      }

      // Fallback when IndexedDB is unavailable (e.g. Node.js unit tests without IDB mock)
      const fallbackKey = `${JOB_METADATA_KEYS.TASK_FALLBACK_PREFIX}${jobId}`;
      const existingRes = await storageClient.get(fallbackKey);
      const existingMap = new Map(
        (Array.isArray(existingRes?.[fallbackKey]) ? existingRes[fallbackKey] : []).map((t) => [
          t.taskId,
          t,
        ])
      );
      for (const item of cleanTasks) {
        existingMap.set(item.taskId, item);
      }
      const ordered = [...existingMap.values()].sort(
        (a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0)
      );
      await storageClient.set({ [fallbackKey]: ordered });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        quotaExceeded: isQuotaError(error),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function saveTaskResult(task) {
    return saveTaskBatch(task.jobId, [task]);
  }

  async function loadTasksForJob(jobId) {
    if (!jobId) return [];
    if (idbFactory) {
      const db = await openTasksDb(idbFactory);
      try {
        const items = await new Promise((resolve, reject) => {
          const tx = db.transaction([TASKS_STORE], "readonly");
          const index = tx.objectStore(TASKS_STORE).index("by_job");
          const req = index.getAll(jobId);
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error || new Error("Failed loading tasks."));
        });
        return items.sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0));
      } finally {
        db.close();
      }
    }

    const fallbackKey = `${JOB_METADATA_KEYS.TASK_FALLBACK_PREFIX}${jobId}`;
    const res = await storageClient.get(fallbackKey);
    const items = Array.isArray(res?.[fallbackKey]) ? res[fallbackKey] : [];
    return items.sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0));
  }

  async function clearActiveJob() {
    const active = await loadActiveJob();
    await storageClient.remove(JOB_METADATA_KEYS.ACTIVE_JOB);
    if (active?.jobId) {
      const fallbackKey = `${JOB_METADATA_KEYS.TASK_FALLBACK_PREFIX}${active.jobId}`;
      await storageClient.remove(fallbackKey);
      if (idbFactory) {
        const db = await openTasksDb(idbFactory);
        try {
          const existing = await loadTasksForJob(active.jobId);
          await runIdbTransaction(db, [TASKS_STORE, JOBS_STORE], "readwrite", (tx) => {
            const tStore = tx.objectStore(TASKS_STORE);
            for (const item of existing) {
              tStore.delete(`${active.jobId}::${item.taskId}`);
            }
            tx.objectStore(JOBS_STORE).delete(active.jobId);
          });
        } finally {
          db.close();
        }
      }
    }
    return { ok: true };
  }

  return {
    saveJobMetadata,
    loadActiveJob,
    loadJobHistory,
    saveTaskBatch,
    saveTaskResult,
    loadTasksForJob,
    clearActiveJob,
  };
}

