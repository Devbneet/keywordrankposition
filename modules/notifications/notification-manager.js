/**
 * Chrome Notifications API controller for scheduled ranking reports, missed run alerts,
 * authentication prompts, and CAPTCHA/location pauses. Respects user preferences cleanly.
 */

import { DEFAULT_NOTIFICATION_PREFERENCES } from "../scheduler/scheduler-state.js";

export const NOTIFICATION_EVENTS = Object.freeze({
  COMPLETED: "onCompleted",
  COMPLETED_WITH_ERRORS: "onCompletedWithErrors",
  MISSED_RUN: "onMissedRun",
  AUTH_REQUIRED: "onAuthRequired",
  CAPTCHA_BLOCKED: "onCaptchaBlocked",
  LOCATION_FAILED: "onLocationFailed",
  SHEET_PREVIEW_READY: "onSheetPreviewReady",
});

export function buildNotificationContent(eventType, details = {}) {
  const scheduleName = details.scheduleName || details.clientName || "Scheduled check";
  switch (eventType) {
    case NOTIFICATION_EVENTS.COMPLETED:
      return {
        title: `Completed: ${scheduleName}`,
        message: `Checked ${details.totalKeywords ?? 0} keywords cleanly. ${
          details.previewReady ? "Google Sheet preview ready for review." : "Ranking history saved."
        }`,
      };
    case NOTIFICATION_EVENTS.COMPLETED_WITH_ERRORS:
      return {
        title: `Completed with errors: ${scheduleName}`,
        message: `${details.completedKeywords ?? 0}/${details.totalKeywords ?? 0} checked; ${
          details.errorCount ?? 0
        } error(s). Review report in Scheduled Checks.`,
      };
    case NOTIFICATION_EVENTS.MISSED_RUN:
      return {
        title: `Missed schedule: ${scheduleName}`,
        message: `Scheduled check for ${details.scheduledLabel || "recent slot"} was missed while Chrome was closed. Open dashboard to run or skip.`,
      };
    case NOTIFICATION_EVENTS.AUTH_REQUIRED:
      return {
        title: `Google auth required: ${scheduleName}`,
        message: "Scheduled check could not verify Google Sheets access. Re-authenticate in Google Sheets Sync.",
      };
    case NOTIFICATION_EVENTS.CAPTCHA_BLOCKED:
      return {
        title: `Search blocked / CAPTCHA: ${scheduleName}`,
        message: "Google Search returned a CAPTCHA or rate-limit block. Automated run stopped safely without evasion.",
      };
    case NOTIFICATION_EVENTS.LOCATION_FAILED:
      return {
        title: `Location verification failed: ${scheduleName}`,
        message: details.reason || "GPS or Google Search location verification failed. Ranking check aborted safely.",
      };
    case NOTIFICATION_EVENTS.SHEET_PREVIEW_READY:
      return {
        title: `Sheet update ready: ${scheduleName}`,
        message: `${details.validCount ?? 0} ranking updates prepared for review. Approve inside Google Sheets Sync.`,
      };
    default:
      return {
        title: `Digital Minds Rank Tracker: ${scheduleName}`,
        message: details.message || "Scheduled ranking status updated.",
      };
  }
}

export function createNotificationManager({
  notificationsApi = globalThis.chrome?.notifications || null,
  scheduleStorage = null,
  activityLogger = null,
} = {}) {
  async function notify(eventType, details = {}, overridePreferences = null) {
    const settings = scheduleStorage ? await scheduleStorage.loadSchedulerSettings() : null;
    const prefs = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      ...(settings?.notificationPreferences || {}),
      ...(overridePreferences || {}),
    };

    if (!prefs.enabled || prefs[eventType] === false) {
      return { ok: true, suppressed: true, eventType };
    }

    const { title, message } = buildNotificationContent(eventType, details);
    const notificationId = `dm_sched_${eventType}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    if (activityLogger) {
      await activityLogger({
        category: "scheduler_notification",
        clientId: details.clientId || null,
        title,
        message,
        eventType,
      }).catch(() => {});
    }

    if (!notificationsApi || typeof notificationsApi.create !== "function") {
      return {
        ok: true,
        delivered: false,
        reason: "notifications API unavailable in current runtime",
        notificationId,
        title,
        message,
      };
    }

    const createdId = await new Promise((resolve) => {
      try {
        const res = notificationsApi.create(
          notificationId,
          {
            type: "basic",
            iconUrl: details.iconUrl || "icons/icon128.png",
            title,
            message,
            priority: eventType === NOTIFICATION_EVENTS.CAPTCHA_BLOCKED || eventType === NOTIFICATION_EVENTS.MISSED_RUN ? 2 : 1,
          },
          (id) => resolve(id || notificationId)
        );
        if (res && typeof res.then === "function") {
          res.then((id) => resolve(id || notificationId)).catch(() => resolve(null));
        }
      } catch {
        resolve(null);
      }
    });

    return {
      ok: Boolean(createdId),
      delivered: Boolean(createdId),
      notificationId: createdId || notificationId,
      title,
      message,
    };
  }

  return {
    notify,
  };
}

