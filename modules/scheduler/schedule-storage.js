/**
 * Persistent storage repository for recurring ranking schedules, idempotent execution
 * occurrence logs, scheduler settings, and active execution lock state.
 */

import { createDatabase, STORES } from "../storage/database.js";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_SCHEDULER_SETTINGS,
  EXECUTION_STATES,
} from "./scheduler-state.js";

const SCHEDULER_SETTINGS_KEY = "scheduler_settings";
const SCHEDULER_LOCK_KEY = "scheduler_active_lock";

export function buildExecutionKey(scheduleId, scheduledForIso) {
  return `${scheduleId}::${scheduledForIso || "manual"}`;
}

export function createScheduleStorage({
  storageClient,
  idbFactory = globalThis.indexedDB || null,
} = {}) {
  const db = createDatabase({ storageClient, idbFactory });

  async function saveSchedule(schedule) {
    if (!schedule?.scheduleId) {
      return { ok: false, error: "scheduleId is required." };
    }
    const res = await db.putOne(STORES.SCHEDULES, schedule);
    if (!res.ok) return res;
    return { ok: true, schedule };
  }

  async function getSchedule(scheduleId) {
    return db.getByKey(STORES.SCHEDULES, scheduleId);
  }

  async function listSchedules({ clientId = null, enabledOnly = false } = {}) {
    let rows = clientId
      ? await db.getByIndex(STORES.SCHEDULES, "by_client", clientId)
      : await db.getAll(STORES.SCHEDULES);
    if (enabledOnly) {
      rows = rows.filter((s) => Boolean(s.enabled));
    }
    return rows.sort((a, b) =>
      String(a.nextScheduledRunAt || "9999").localeCompare(String(b.nextScheduledRunAt || "9999"))
    );
  }

  async function deleteSchedule(scheduleId) {
    if (!scheduleId) return { ok: false, error: "scheduleId is required." };
    return db.deleteMany(STORES.SCHEDULES, [scheduleId]);
  }

  async function saveExecution(execution) {
    if (!execution?.executionId) {
      return { ok: false, error: "executionId is required." };
    }
    const res = await db.putOne(STORES.SCHEDULE_EXECUTIONS, execution);
    if (!res.ok) return res;
    return { ok: true, execution };
  }

  async function claimExecution(executionId, ownerId) {
    if (!executionId) return { ok: false, error: "executionId is required." };
    const exec = await getExecution(executionId);
    if (!exec) return { ok: false, error: `Execution '${executionId}' not found.` };
    if (exec.status !== EXECUTION_STATES.QUEUED) {
      return {
        ok: false,
        alreadyClaimed: true,
        error: `Execution '${executionId}' is in state '${exec.status}', not Queued.`,
      };
    }
    const claimed = {
      ...exec,
      status: EXECUTION_STATES.RUNNING,
      claimedBy: ownerId || executionId,
      claimedAt: new Date().toISOString(),
    };
    const saveRes = await saveExecution(claimed);
    if (!saveRes.ok) return saveRes;
    return { ok: true, execution: claimed };
  }

  async function getExecution(executionId) {
    return db.getByKey(STORES.SCHEDULE_EXECUTIONS, executionId);
  }

  async function getExecutionByKey(executionKey) {
    if (!executionKey) return null;
    const rows = await db.getByIndex(STORES.SCHEDULE_EXECUTIONS, "by_executionKey", executionKey);
    return rows[0] || null;
  }

  async function listExecutions({ scheduleId = null, clientId = null, status = null, limit = 200 } = {}) {
    let rows;
    if (scheduleId) {
      rows = await db.getByIndex(STORES.SCHEDULE_EXECUTIONS, "by_schedule", scheduleId);
    } else if (clientId) {
      rows = await db.getByIndex(STORES.SCHEDULE_EXECUTIONS, "by_client", clientId);
    } else if (status) {
      rows = await db.getByIndex(STORES.SCHEDULE_EXECUTIONS, "by_status", status);
    } else {
      rows = await db.getAll(STORES.SCHEDULE_EXECUTIONS);
    }

    const filtered = rows.filter((r) => {
      if (scheduleId && r.scheduleId !== scheduleId) return false;
      if (clientId && r.clientId !== clientId) return false;
      if (status && r.status !== status) return false;
      return true;
    });

    filtered.sort((a, b) =>
      String(b.startedAt || b.queuedAt || b.scheduledForAt || "").localeCompare(
        String(a.startedAt || a.queuedAt || a.scheduledForAt || "")
      )
    );
    return limit > 0 ? filtered.slice(0, limit) : filtered;
  }

  async function listMissedExecutions() {
    return listExecutions({ status: EXECUTION_STATES.MISSED_PENDING });
  }

  async function loadSchedulerSettings() {
    const saved = await db.getByKey(STORES.SETTINGS, SCHEDULER_SETTINGS_KEY);
    const val = saved?.value || {};
    return {
      ...DEFAULT_SCHEDULER_SETTINGS,
      ...val,
      notificationPreferences: {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        ...(val.notificationPreferences || {}),
      },
    };
  }

  async function saveSchedulerSettings(updates = {}) {
    const prev = await loadSchedulerSettings();
    const merged = {
      ...prev,
      ...updates,
      notificationPreferences: {
        ...prev.notificationPreferences,
        ...(updates.notificationPreferences || {}),
      },
    };
    const res = await db.putOne(STORES.SETTINGS, {
      key: SCHEDULER_SETTINGS_KEY,
      value: merged,
      updatedAt: new Date().toISOString(),
    });
    if (!res.ok) return res;
    return { ok: true, settings: merged };
  }

  async function getExecutionLock() {
    const rec = await db.getByKey(STORES.SETTINGS, SCHEDULER_LOCK_KEY);
    return rec?.value || null;
  }

  async function acquireExecutionLock({ lockType, ownerId, description = "", ttlMs = 30 * 60000 } = {}) {
    const current = await getExecutionLock();
    const nowMs = Date.now();
    if (current && current.expiresAtMs && current.expiresAtMs > nowMs && current.ownerId !== ownerId) {
      return {
        acquired: false,
        conflictLock: current,
        error: `Active ${current.lockType} operation ('${current.ownerId}') is currently running.`,
      };
    }

    const nextLock = {
      lockType,
      ownerId,
      description,
      acquiredAt: new Date(nowMs).toISOString(),
      expiresAtMs: nowMs + ttlMs,
    };
    await db.putOne(STORES.SETTINGS, {
      key: SCHEDULER_LOCK_KEY,
      value: nextLock,
      updatedAt: new Date(nowMs).toISOString(),
    });
    return { acquired: true, lock: nextLock };
  }

  async function releaseExecutionLock(ownerId = null) {
    const current = await getExecutionLock();
    if (!current) return { ok: true, released: false };
    if (ownerId && current.ownerId !== ownerId) {
      return { ok: false, released: false, error: "Lock owned by a different operation." };
    }
    await db.deleteMany(STORES.SETTINGS, [SCHEDULER_LOCK_KEY]);
    return { ok: true, released: true };
  }

  return {
    saveSchedule,
    getSchedule,
    listSchedules,
    deleteSchedule,
    saveExecution,
    claimExecution,
    getExecution,
    getExecutionByKey,
    listExecutions,
    listMissedExecutions,
    loadSchedulerSettings,
    saveSchedulerSettings,
    getExecutionLock,
    acquireExecutionLock,
    releaseExecutionLock,
  };
}

