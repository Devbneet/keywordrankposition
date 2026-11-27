/**
 * Schedule lifecycle CRUD manager, summary aggregator, and Chrome alarm synchronization.
 * Supports both single-client weekly checks and agency-wide sequential multi-client schedules.
 */

import {
  calculateNextRunAt,
  formatScheduleFrequencyLabel,
} from "./schedule-calculator.js";
import { validateScheduleInput } from "./schedule-validator.js";
import {
  AUTOMATION_MODES,
  EXECUTION_STATES,
  MISSED_RUN_POLICIES,
  RETRY_CONFIG,
  SCHEDULE_FREQUENCIES,
  SCHEDULE_STATES,
} from "./scheduler-state.js";

export function createScheduleManager({
  scheduleStorage,
  alarmController = null,
  clientStorage = null,
  locationManager = null,
  activityLogger = null,
} = {}) {
  async function loadClientValidationMaps() {
    if (!clientStorage) return { clientsById: null, locationsByClient: null };
    const clients = await clientStorage.listClients();
    const clientsById = new Map(clients.map((c) => [c.clientId, c]));
    const locationsByClient = new Map();
    if (locationManager) {
      for (const c of clients) {
        locationsByClient.set(c.clientId, await locationManager.listLocations(c.clientId));
      }
    }
    return { clientsById, locationsByClient };
  }

  async function createSchedule(input = {}, { now = new Date() } = {}) {
    const [{ clientsById, locationsByClient }, schedulerSettings] = await Promise.all([
      loadClientValidationMaps(),
      scheduleStorage.loadSchedulerSettings(),
    ]);

    const validation = validateScheduleInput(input, { clientsById, locationsByClient, schedulerSettings });
    if (!validation.valid) {
      return { ok: false, errors: validation.errors, error: validation.errors[0] };
    }

    const enabled = input.enabled !== false;
    const norm = validation.normalized;
    const nextRun = calculateNextRunAt({
      dayOfWeek: norm.dayOfWeek,
      timeOfDay: norm.timeOfDay,
      timezone: norm.timezone,
      frequency: norm.frequency,
      afterDate: now,
    });

    const primaryClient = clientsById?.get(input.clientId) || null;
    const scheduleId =
      input.scheduleId || `sched_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const nowIso = now.toISOString();

    const record = {
      scheduleId,
      name:
        String(input.name || "").trim() ||
        (norm.scopeType === "agency_batch"
          ? `Agency Weekly Batch (${(input.clientConfigs || []).length} clients)`
          : primaryClient?.clientName || "Client Weekly Check"),
      scopeType: norm.scopeType,
      clientId: norm.scopeType === "agency_batch" ? "__agency_batch__" : input.clientId,
      clientName: primaryClient?.clientName || input.clientName || "",
      locationId: input.locationId || null,
      locationName: input.locationName || "",
      clientConfigs:
        norm.scopeType === "agency_batch"
          ? (input.clientConfigs || []).map((c) => ({
              clientId: c.clientId,
              locationId: c.locationId || null,
              sheetUrlOrId: c.sheetUrlOrId || null,
            }))
          : [],
      frequency: norm.frequency || SCHEDULE_FREQUENCIES.WEEKLY,
      dayOfWeek: norm.dayOfWeek,
      timeOfDay: norm.timeOfDay,
      timezone: norm.timezone,
      enabled,
      status: enabled ? SCHEDULE_STATES.ENABLED : SCHEDULE_STATES.DISABLED,
      automationMode: norm.automationMode || AUTOMATION_MODES.MODE_A_REVIEW,
      sandboxMode: Boolean(input.sandboxMode),
      isAuthorized: Boolean(input.isAuthorized),
      missedRunPolicy: norm.missedRunPolicy || MISSED_RUN_POLICIES.ASK_USER,
      syncSheetBeforeRun: input.syncSheetBeforeRun !== false,
      searchDepth: norm.searchDepth,
      delayBetweenKeywordsMs: norm.delayBetweenKeywordsMs ?? RETRY_CONFIG.defaultDelayBetweenKeywordsMs,
      delayBetweenClientsMs: Number(
        input.delayBetweenClientsMs ?? schedulerSettings.delayBetweenClientsMs ?? RETRY_CONFIG.defaultDelayBetweenClientsMs
      ),
      retryPolicy: {
        maxKeywordRetries: Number(input.retryPolicy?.maxKeywordRetries ?? RETRY_CONFIG.maxKeywordRetries),
        stopOnCaptcha: true,
        stopOnLocationMismatch: true,
      },
      expectedKeywordCount: Number(input.expectedKeywordCount || 0),
      nextScheduledRunAt: enabled ? nextRun.iso : null,
      lastRunAt: null,
      lastStatus: null,
      lastExecutionId: null,
      lastError: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const saveRes = await scheduleStorage.saveSchedule(record);
    if (!saveRes.ok) return saveRes;

    let alarmResult = null;
    if (alarmController) {
      alarmResult = await alarmController.syncScheduleAlarm(record, { nowMs: now.getTime() });
    }
    if (activityLogger) {
      await activityLogger({
        category: "schedule_created",
        clientId: record.clientId,
        title: `Schedule created: ${record.name}`,
        message: `${formatScheduleFrequencyLabel(record)} (${record.timezone})`,
      }).catch(() => {});
    }

    return { ok: true, schedule: record, alarm: alarmResult, warnings: validation.warnings };
  }

  async function updateSchedule(scheduleId, updates = {}, { now = new Date() } = {}) {
    const existing = await scheduleStorage.getSchedule(scheduleId);
    if (!existing) return { ok: false, error: `Schedule '${scheduleId}' not found.` };

    const merged = { ...existing, ...updates, scheduleId };
    const [{ clientsById, locationsByClient }, schedulerSettings] = await Promise.all([
      loadClientValidationMaps(),
      scheduleStorage.loadSchedulerSettings(),
    ]);

    const validation = validateScheduleInput(merged, { clientsById, locationsByClient, schedulerSettings });
    if (!validation.valid) {
      return { ok: false, errors: validation.errors, error: validation.errors[0] };
    }

    const norm = validation.normalized;
    const enabled = merged.enabled !== false;
    const nextRun = enabled
      ? calculateNextRunAt({
          dayOfWeek: norm.dayOfWeek,
          timeOfDay: norm.timeOfDay,
          timezone: norm.timezone,
          frequency: norm.frequency,
          afterDate: now,
          lastScheduledRunAt: existing.lastRunAt,
        })
      : null;

    const updated = {
      ...merged,
      ...norm,
      isAuthorized: Boolean(merged.isAuthorized),
      enabled,
      status: enabled
        ? merged.status === SCHEDULE_STATES.DISABLED
          ? SCHEDULE_STATES.ENABLED
          : merged.status || SCHEDULE_STATES.ENABLED
        : SCHEDULE_STATES.DISABLED,
      nextScheduledRunAt: enabled ? nextRun.iso : null,
      updatedAt: now.toISOString(),
    };

    const saveRes = await scheduleStorage.saveSchedule(updated);
    if (!saveRes.ok) return saveRes;

    if (alarmController) {
      await alarmController.syncScheduleAlarm(updated, { nowMs: now.getTime() });
    }
    return { ok: true, schedule: updated };
  }

  async function setScheduleEnabled(scheduleId, enabled, { now = new Date() } = {}) {
    return updateSchedule(scheduleId, { enabled: Boolean(enabled) }, { now });
  }

  async function deleteSchedule(scheduleId) {
    const existing = await scheduleStorage.getSchedule(scheduleId);
    if (!existing) return { ok: false, error: `Schedule '${scheduleId}' not found.` };
    if (alarmController) {
      await alarmController.syncScheduleAlarm({ ...existing, enabled: false });
    }
    const delRes = await scheduleStorage.deleteSchedule(scheduleId);
    return { ...delRes, deletedScheduleId: scheduleId };
  }

  async function getDashboardSummary({ now = new Date() } = {}) {
    const [schedules, executions, settings] = await Promise.all([
      scheduleStorage.listSchedules(),
      scheduleStorage.listExecutions({ limit: 150 }),
      scheduleStorage.loadSchedulerSettings(),
    ]);

    const activeSchedules = schedules.filter((s) => s.enabled);
    const missedExecutions = executions.filter((e) => e.status === EXECUTION_STATES.MISSED_PENDING);
    const failedSchedules = schedules.filter(
      (s) => s.status === SCHEDULE_STATES.FAILED || s.status === SCHEDULE_STATES.NEEDS_ATTENTION || s.lastStatus === EXECUTION_STATES.FAILED
    );
    const needsAttentionIds = new Set([
      ...missedExecutions.map((e) => e.scheduleId),
      ...failedSchedules.map((s) => s.scheduleId),
      ...schedules.filter((s) => s.status === SCHEDULE_STATES.MISSED).map((s) => s.scheduleId),
    ]);

    const sevenDaysMs = now.getTime() + 7 * 24 * 3600 * 1000;
    const upcomingRuns = activeSchedules.filter((s) => {
      const ts = Date.parse(s.nextScheduledRunAt);
      return Number.isFinite(ts) && ts >= now.getTime() && ts <= sevenDaysMs;
    });

    const lock = await scheduleStorage.getExecutionLock();

    return {
      ok: true,
      kpis: {
        activeSchedulesCount: activeSchedules.length,
        upcomingCount: upcomingRuns.length,
        needsAttentionCount: needsAttentionIds.size,
      },
      schedules,
      upcomingRuns,
      missedExecutions,
      failedSchedules,
      recentExecutions: executions.slice(0, 50),
      settings,
      activeLock: lock && lock.expiresAtMs > Date.now() ? lock : null,
    };
  }

  return {
    createSchedule,
    updateSchedule,
    setScheduleEnabled,
    deleteSchedule,
    getDashboardSummary,
    listSchedules: scheduleStorage.listSchedules.bind(scheduleStorage),
    listExecutions: scheduleStorage.listExecutions.bind(scheduleStorage),
  };
}

