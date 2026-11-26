/**
 * Chrome Alarms API integration for Phase 11 Weekly Scheduling.
 * Never uses long-lived background setTimeout/setInterval timers; always persists schedule state
 * and schedules exact next wall-clock alarm triggers recalculated via IANA timezone math.
 */

export const SCHEDULE_ALARM_PREFIX = "dm_sched::";
export const QUEUE_DRAIN_ALARM_NAME = "dm_queue_drain";

export function alarmNameForSchedule(scheduleId) {
  return `${SCHEDULE_ALARM_PREFIX}${scheduleId}`;
}

export function scheduleIdFromAlarmName(alarmName) {
  if (!alarmName || !String(alarmName).startsWith(SCHEDULE_ALARM_PREFIX)) return null;
  return String(alarmName).slice(SCHEDULE_ALARM_PREFIX.length) || null;
}

export function createAlarmController({
  alarmsApi = globalThis.chrome?.alarms || null,
} = {}) {
  function createAlarm(name, alarmInfo) {
    if (!alarmsApi || typeof alarmsApi.create !== "function") {
      return Promise.resolve({ ok: false, unavailable: true });
    }
    return new Promise((resolve) => {
      try {
        const res = alarmsApi.create(name, alarmInfo);
        if (res && typeof res.then === "function") {
          res.then(() => resolve({ ok: true, name, alarmInfo })).catch((err) => resolve({ ok: false, error: err?.message }));
        } else {
          resolve({ ok: true, name, alarmInfo });
        }
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  function clearAlarm(name) {
    if (!alarmsApi || typeof alarmsApi.clear !== "function") {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      try {
        if (alarmsApi.clear.length >= 2) {
          alarmsApi.clear(name, (wasCleared) => resolve(Boolean(wasCleared)));
        } else {
          Promise.resolve(alarmsApi.clear(name))
            .then((wasCleared) => resolve(Boolean(wasCleared)))
            .catch(() => resolve(false));
        }
      } catch {
        resolve(false);
      }
    });
  }

  function getAllAlarms() {
    if (!alarmsApi || typeof alarmsApi.getAll !== "function") {
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      try {
        if (alarmsApi.getAll.length >= 1) {
          alarmsApi.getAll((alarms) => resolve(Array.isArray(alarms) ? alarms : []));
        } else {
          Promise.resolve(alarmsApi.getAll())
            .then((alarms) => resolve(Array.isArray(alarms) ? alarms : []))
            .catch(() => resolve([]));
        }
      } catch {
        resolve([]);
      }
    });
  }

  async function syncScheduleAlarm(schedule, { nowMs = Date.now() } = {}) {
    if (!schedule?.scheduleId) {
      return { ok: false, error: "scheduleId is required." };
    }
    const alarmName = alarmNameForSchedule(schedule.scheduleId);

    if (!schedule.enabled || !schedule.nextScheduledRunAt) {
      await clearAlarm(alarmName);
      return { ok: true, action: "cleared", alarmName };
    }

    const parsedWhen = Date.parse(schedule.nextScheduledRunAt);
    if (!Number.isFinite(parsedWhen)) {
      return { ok: false, error: `Invalid nextScheduledRunAt timestamp '${schedule.nextScheduledRunAt}'.` };
    }

    // Chrome Alarms minimum realistic delay floor when catchup is immediate is +500ms
    const when = Math.max(nowMs + 500, parsedWhen);
    const created = await createAlarm(alarmName, { when });
    return {
      ...created,
      action: "scheduled",
      alarmName,
      when,
      scheduledForIso: new Date(when).toISOString(),
    };
  }

  async function scheduleQueueDrain(delayMs = 15000, { nowMs = Date.now() } = {}) {
    const when = nowMs + Math.max(1000, delayMs);
    return createAlarm(QUEUE_DRAIN_ALARM_NAME, { when });
  }

  async function reconcileAlarms({ scheduleStorage, nowMs = Date.now() } = {}) {
    if (!scheduleStorage) return { ok: false, error: "scheduleStorage required." };
    const schedules = await scheduleStorage.listSchedules();
    const byAlarmName = new Map(
      schedules
        .filter((s) => s.enabled && s.nextScheduledRunAt)
        .map((s) => [alarmNameForSchedule(s.scheduleId), s])
    );

    const existingAlarms = await getAllAlarms();
    const existingByName = new Map(existingAlarms.map((a) => [a.name, a]));

    const synced = [];
    const cleared = [];

    for (const alarm of existingAlarms) {
      if (String(alarm.name || "").startsWith(SCHEDULE_ALARM_PREFIX) && !byAlarmName.has(alarm.name)) {
        await clearAlarm(alarm.name);
        cleared.push(alarm.name);
      }
    }

    for (const [alarmName, sched] of byAlarmName.entries()) {
      const targetWhen = Math.max(nowMs + 500, Date.parse(sched.nextScheduledRunAt));
      const existing = existingByName.get(alarmName);
      if (!existing || Math.abs((existing.scheduledTime || 0) - targetWhen) > 5000) {
        await syncScheduleAlarm(sched, { nowMs });
        synced.push(sched.scheduleId);
      }
    }

    return { ok: true, syncedCount: synced.length, clearedCount: cleared.length, synced, cleared };
  }

  return {
    syncScheduleAlarm,
    clearAlarm,
    getAllAlarms,
    scheduleQueueDrain,
    reconcileAlarms,
  };
}

