/**
 * Persistent idempotent execution queue for scheduled ranking runs.
 * - Guarantees duplicate Chrome alarms or overlapping browser triggers cannot execute the same
 *   scheduled occurrence twice (deduplicated via deterministic executionKey = scheduleId::scheduledForAt).
 * - Defers cleanly when manual checks, client switches, backups, or Sheet writes are active.
 * - Strictly runs at most one scheduled execution at a time (sequential execution only).
 */

import { buildExecutionKey } from "./schedule-storage.js";
import { EXECUTION_STATES } from "./scheduler-state.js";

export function createExecutionQueue({
  scheduleStorage,
  alarmController = null,
  hasActiveConflictFn = null,
} = {}) {
  let drainingPromise = null;

  async function enqueueOccurrence({
    schedule,
    scheduledForAt,
    triggerSource = "alarm",
    now = new Date(),
    metadata = {},
  } = {}) {
    if (!schedule?.scheduleId) {
      return { ok: false, error: "schedule with scheduleId is required." };
    }
    const slotIso = scheduledForAt || schedule.nextScheduledRunAt || now.toISOString();
    const executionKey =
      triggerSource === "manual_run_now"
        ? `${schedule.scheduleId}::manual_${now.getTime()}`
        : buildExecutionKey(schedule.scheduleId, slotIso);

    const existing = await scheduleStorage.getExecutionByKey(executionKey);
    if (existing) {
      return {
        ok: true,
        deduplicated: true,
        execution: existing,
      };
    }

    const nowIso = now.toISOString();
    const executionId = `exec_${schedule.scheduleId}_${now.getTime()}_${Math.random().toString(36).slice(2, 6)}`;
    const record = {
      executionId,
      executionKey,
      scheduleId: schedule.scheduleId,
      scheduleName: schedule.name || schedule.clientName || schedule.scheduleId,
      clientId: schedule.scopeType === "agency_batch" ? "__agency_batch__" : schedule.clientId,
      scopeType: schedule.scopeType || "single_client",
      triggerSource,
      scheduledForAt: slotIso,
      queuedAt: nowIso,
      startedAt: null,
      completedAt: null,
      status: EXECUTION_STATES.QUEUED,
      deferredReason: null,
      clientReports: [],
      summary: {
        totalClients: schedule.scopeType === "agency_batch" ? (schedule.clientConfigs || []).length : 1,
        completedClients: 0,
        failedClients: 0,
        totalKeywords: 0,
        completedKeywords: 0,
        failedKeywords: 0,
        previewReadyCount: 0,
      },
      metadata,
    };

    const saveRes = await scheduleStorage.saveExecution(record);
    if (!saveRes.ok) return saveRes;
    return { ok: true, deduplicated: false, execution: record };
  }

  async function listQueuedExecutions() {
    const queued = await scheduleStorage.listExecutions({ status: EXECUTION_STATES.QUEUED, limit: 100 });
    // FIFO by queuedAt
    return queued.slice().sort((a, b) => String(a.queuedAt || "").localeCompare(String(b.queuedAt || "")));
  }

  async function checkConflict(lockOwnerId = null) {
    const persistedLock = await scheduleStorage.getExecutionLock();
    if (persistedLock && persistedLock.expiresAtMs > Date.now() && persistedLock.ownerId !== lockOwnerId) {
      return {
        conflict: true,
        reason: `Active ${persistedLock.lockType} (${persistedLock.description || persistedLock.ownerId}) is in progress.`,
        lock: persistedLock,
      };
    }
    if (typeof hasActiveConflictFn === "function") {
      const ext = await hasActiveConflictFn();
      if (ext?.conflict) {
        return {
          conflict: true,
          reason: ext.reason || "Active manual ranking operation or Google Sheet write is in progress.",
          lock: ext,
        };
      }
    }
    return { conflict: false };
  }

  async function drainQueue({ jobRunner, onConflict = null } = {}) {
    if (drainingPromise) {
      return drainingPromise;
    }

    drainingPromise = (async () => {
      const processed = [];
      let deferredCount = 0;

      while (true) {
        const queued = await listQueuedExecutions();
        if (queued.length === 0) break;

        const nextExec = queued[0];
        const conflictCheck = await checkConflict(nextExec.executionId);
        if (conflictCheck.conflict) {
          deferredCount += 1;
          nextExec.deferredReason = conflictCheck.reason;
          await scheduleStorage.saveExecution(nextExec);
          if (typeof onConflict === "function") {
            await onConflict({ execution: nextExec, conflict: conflictCheck });
          }
          if (alarmController) {
            await alarmController.scheduleQueueDrain(15000);
          }
          break;
        }

        if (!jobRunner || typeof jobRunner.runExecution !== "function") {
          return { ok: false, error: "jobRunner.runExecution is required to drain queue." };
        }

        const result = await jobRunner.runExecution(nextExec);
        processed.push(result);
      }

      return {
        ok: true,
        processedCount: processed.length,
        deferredCount,
        processed,
      };
    })();

    try {
      return await drainingPromise;
    } finally {
      drainingPromise = null;
    }
  }

  return {
    enqueueOccurrence,
    listQueuedExecutions,
    checkConflict,
    drainQueue,
  };
}

