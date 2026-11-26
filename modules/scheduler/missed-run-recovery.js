/**
 * Missed Schedule Detection & Recovery controller.
 * Evaluates due schedules when Chrome restarts or extension wakes up:
 * - ask_user (default): logs awaiting Missed execution, notifies user, advances future schedule slot.
 * - run_latest: enqueues only the latest missed slot safely (zero burst flood), skips older ones.
 * - skip: records Skipped status cleanly for audit trail and advances nextScheduledRunAt.
 * - resume_next: resets cleanly to next upcoming occurrence without noise.
 */

import { detectMissedOccurrences, formatTime12Hour } from "./schedule-calculator.js";
import { buildExecutionKey } from "./schedule-storage.js";
import { EXECUTION_STATES, MISSED_RUN_POLICIES, SCHEDULE_STATES } from "./scheduler-state.js";

export const NOTIFICATION_EVENT_MISSED = "onMissedRun";

export function createMissedRunRecovery({
  scheduleStorage,
  alarmController = null,
  executionQueue = null,
  notificationManager = null,
} = {}) {
  async function checkAndHandleMissedRuns({ now = new Date(), settings = null } = {}) {
    const effectiveSettings = settings || (await scheduleStorage.loadSchedulerSettings());
    const graceMinutes = Number(effectiveSettings?.missedRunGraceMinutes ?? 15);
    const schedules = await scheduleStorage.listSchedules({ enabledOnly: true });

    const handled = [];
    const nowIso = now.toISOString();

    for (const sched of schedules) {
      const detection = detectMissedOccurrences({ schedule: sched, now, graceMinutes });
      if (!detection.hasMissed) continue;

      const policy =
        sched.missedRunPolicy ||
        effectiveSettings?.defaultMissedRunPolicy ||
        MISSED_RUN_POLICIES.ASK_USER;

      const latestSlot = detection.latestMissedAt;
      const executionKey = buildExecutionKey(sched.scheduleId, latestSlot);
      const existing = await scheduleStorage.getExecutionByKey(executionKey);

      const updatedSchedule = {
        ...sched,
        nextScheduledRunAt: detection.nextUpcoming,
        updatedAt: nowIso,
      };

      if (!existing) {
        if (policy === MISSED_RUN_POLICIES.ASK_USER) {
          const missedExec = {
            executionId: `exec_missed_${sched.scheduleId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            executionKey,
            scheduleId: sched.scheduleId,
            scheduleName: sched.name || sched.clientName || sched.scheduleId,
            clientId: sched.scopeType === "agency_batch" ? "__agency_batch__" : sched.clientId,
            scopeType: sched.scopeType || "single_client",
            triggerSource: "missed_startup_check",
            scheduledForAt: latestSlot,
            missedOccurrences: detection.missedOccurrences,
            missedCount: detection.missedCount,
            queuedAt: nowIso,
            status: EXECUTION_STATES.MISSED_PENDING,
            resolutionRequired: true,
            clientReports: [],
          };
          await scheduleStorage.saveExecution(missedExec);
          updatedSchedule.status = SCHEDULE_STATES.MISSED;
          updatedSchedule.lastMissedAt = latestSlot;

          if (notificationManager) {
            await notificationManager.notify(NOTIFICATION_EVENT_MISSED, {
              scheduleName: sched.name || sched.clientName,
              clientId: sched.clientId,
              scheduledLabel: `${latestSlot.slice(0, 10)} ${formatTime12Hour(sched.timeOfDay)}`,
            });
          }
          handled.push({ scheduleId: sched.scheduleId, policy, action: "asked_user", execution: missedExec });
        } else if (policy === MISSED_RUN_POLICIES.RUN_LATEST && executionQueue) {
          const enq = await executionQueue.enqueueOccurrence({
            schedule: sched,
            scheduledForAt: latestSlot,
            triggerSource: "missed_run_latest",
            now,
            metadata: {
              skippedEarlierMissedCount: Math.max(0, detection.missedCount - 1),
              missedOccurrences: detection.missedOccurrences,
            },
          });
          updatedSchedule.status = SCHEDULE_STATES.ENABLED;
          updatedSchedule.lastMissedAt = latestSlot;
          handled.push({ scheduleId: sched.scheduleId, policy, action: "enqueued_latest", execution: enq.execution });
        } else if (policy === MISSED_RUN_POLICIES.SKIP) {
          const skippedExec = {
            executionId: `exec_skip_${sched.scheduleId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            executionKey,
            scheduleId: sched.scheduleId,
            scheduleName: sched.name || sched.clientName || sched.scheduleId,
            clientId: sched.scopeType === "agency_batch" ? "__agency_batch__" : sched.clientId,
            scopeType: sched.scopeType || "single_client",
            triggerSource: "missed_auto_skip",
            scheduledForAt: latestSlot,
            missedOccurrences: detection.missedOccurrences,
            queuedAt: nowIso,
            completedAt: nowIso,
            status: EXECUTION_STATES.SKIPPED,
            resolutionRequired: false,
            clientReports: [],
          };
          await scheduleStorage.saveExecution(skippedExec);
          updatedSchedule.status = SCHEDULE_STATES.ENABLED;
          handled.push({ scheduleId: sched.scheduleId, policy, action: "skipped", execution: skippedExec });
        } else {
          updatedSchedule.status = SCHEDULE_STATES.ENABLED;
          handled.push({ scheduleId: sched.scheduleId, policy, action: "resumed_next" });
        }
      }

      await scheduleStorage.saveSchedule(updatedSchedule);
      if (alarmController) {
        await alarmController.syncScheduleAlarm(updatedSchedule, { nowMs: now.getTime() });
      }
    }

    return {
      ok: true,
      missedHandledCount: handled.length,
      handled,
    };
  }

  async function resolveMissedExecution({ executionId, action = "skip", now = new Date() } = {}) {
    if (!executionId) return { ok: false, error: "executionId is required." };
    const exec = await scheduleStorage.getExecution(executionId);
    if (!exec) return { ok: false, error: `Execution '${executionId}' not found.` };
    if (exec.status !== EXECUTION_STATES.MISSED_PENDING) {
      return { ok: false, error: `Execution '${executionId}' is already '${exec.status}'.` };
    }

    const sched = await scheduleStorage.getSchedule(exec.scheduleId);
    const nowIso = now.toISOString();

    if (action === "run_now") {
      exec.status = EXECUTION_STATES.QUEUED;
      exec.triggerSource = "missed_user_run_now";
      exec.resolutionRequired = false;
      exec.resolvedAt = nowIso;
      exec.queuedAt = nowIso;
      await scheduleStorage.saveExecution(exec);
      if (sched) {
        sched.status = sched.enabled ? SCHEDULE_STATES.ENABLED : SCHEDULE_STATES.DISABLED;
        sched.updatedAt = nowIso;
        await scheduleStorage.saveSchedule(sched);
      }
      return { ok: true, action: "queued_for_run", execution: exec };
    }

    exec.status = EXECUTION_STATES.SKIPPED;
    exec.resolutionRequired = false;
    exec.resolvedAt = nowIso;
    exec.completedAt = nowIso;
    await scheduleStorage.saveExecution(exec);

    if (sched) {
      sched.status = sched.enabled ? SCHEDULE_STATES.ENABLED : SCHEDULE_STATES.DISABLED;
      sched.updatedAt = nowIso;
      await scheduleStorage.saveSchedule(sched);
    }

    return { ok: true, action: "skipped", execution: exec };
  }

  return {
    checkAndHandleMissedRuns,
    resolveMissedExecution,
  };
}

