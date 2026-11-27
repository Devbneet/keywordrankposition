/**
 * End-to-end Sequential Scheduled Job Runner for Phase 11.
 * Orchestrates weekly automated workflows by reusing existing modules strictly:
 * 1. Acquire exclusive execution lock (preventing parallel searches / manual conflicts)
 * 2. Step sequentially through target client(s)
 * 3. Verify Google Sheets auth & optionally import fresh keywords cleanly
 * 4. Verify browser GPS simulation & Google Search location verification (via verifyLocationForClient)
 * 5. Create persistent bulk ranking job & execute keywords sequentially with conservative throttling
 *    and transient retry (stopping immediately on CAPTCHA or location mismatch without masking errors)
 * 6. Save verified results cleanly to ranking history (deterministic IDs -> zero duplicates)
 * 7. Prepare Mode A Google Sheet dry-run preview (or Mode B only in explicit verified sandbox)
 * 8. Recompute next IANA wall-clock occurrence, sync Chrome alarm, release lock, send summary notification
 */

import { isFailedTaskStatus, JOB_STATES, TASK_STATUSES } from "../jobs/job-state.js";
import { NOTIFICATION_EVENTS } from "../notifications/notification-manager.js";
import { UPDATE_MODES } from "../sheets/sheets-write-client.js";
import { calculateNextRunAt } from "./schedule-calculator.js";
import {
  AUTOMATION_MODES,
  EXECUTION_STATES,
  LOCK_TYPES,
  RETRY_CONFIG,
  SCHEDULE_FAILURE_CODES,
  SCHEDULE_STATES,
} from "./scheduler-state.js";

function delayMs(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDateInTimezone(date, timeZone = "Australia/Sydney") {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }
}

export function createScheduledJobRunner({
  scheduleStorage,
  alarmController = null,
  clientStorage,
  locationManager,
  keywordManager = null,
  googleAuthClient = null,
  sheetReader = null,
  sheetUpdater = null,
  sheetBackupManager = null,
  historyStorage = null,
  notificationManager = null,
  verifyLocationForClient,
  runKeywordCheck,
  activityLogger = null,
} = {}) {
  async function executeSingleClientStep({
    schedule,
    entryConfig,
    execution,
    now,
  }) {
    const client = await clientStorage.getClient(entryConfig.clientId);
    if (!client) {
      return {
        ok: false,
        clientId: entryConfig.clientId,
        failureCode: SCHEDULE_FAILURE_CODES.MISSING_CLIENT,
        error: `Client '${entryConfig.clientId}' no longer exists.`,
      };
    }

    if (schedule.isAuthorized !== true) {
      return {
        ok: false,
        clientId: entryConfig.clientId,
        failureCode: SCHEDULE_FAILURE_CODES.AUTH_EXPIRED,
        error: "Explicit authorized search access (isAuthorized: true) is required before scheduled searches.",
      };
    }

    const clientLocs = await locationManager.listLocations(client.clientId);
    const location = entryConfig.locationId
      ? clientLocs.find((l) => l.locationId === entryConfig.locationId) || null
      : clientLocs[0] || null;
    if (!location) {
      return {
        ok: false,
        clientId: client.clientId,
        clientName: client.clientName,
        failureCode: SCHEDULE_FAILURE_CODES.MISSING_LOCATION,
        error: entryConfig.locationId
          ? `Configured location '${entryConfig.locationId}' no longer exists for '${client.clientName}'.`
          : `No target location configured for '${client.clientName}'.`,
      };
    }

    // Optional Google Sheet auth check & keyword sync (preserving location-specific sheet mappings)
    const targetSheetConfig = location.sheetConfig || client.sheetConfig || {};
    const sheetUrlOrId =
      entryConfig.sheetUrlOrId || targetSheetConfig.sheetUrl || targetSheetConfig.spreadsheetId || null;
    let importedFromSheet = false;
    let sheetSyncWarning = null;

    if (schedule.syncSheetBeforeRun !== false && sheetUrlOrId && sheetReader) {
      if (googleAuthClient && typeof googleAuthClient.getAuthStatus === "function") {
        const authStatus = await googleAuthClient.getAuthStatus();
        if (!authStatus?.connected) {
          return {
            ok: false,
            clientId: client.clientId,
            clientName: client.clientName,
            failureCode: SCHEDULE_FAILURE_CODES.AUTH_EXPIRED,
            error: `Google Sheets authorization required or expired for '${client.clientName}'.`,
          };
        }
      }

      const readRes = await sheetReader.readAndAnalyzeSheet({
        clientId: client.clientId,
        locationId: location.locationId,
        sheetUrlOrId,
        worksheetId: targetSheetConfig.worksheetId ?? "",
        worksheetName: targetSheetConfig.worksheetName ?? "",
        columnConfig: targetSheetConfig,
      });

      if (!readRes.ok) {
        if (/auth|401|403|token|oauth/i.test(String(readRes.error || ""))) {
          return {
            ok: false,
            clientId: client.clientId,
            clientName: client.clientName,
            failureCode: SCHEDULE_FAILURE_CODES.AUTH_EXPIRED,
            error: `Google Sheets auth failure: ${readRes.error}`,
          };
        }
        sheetSyncWarning = `Google Sheet read failed (${readRes.error}); falling back to saved keywords if available.`;
      } else if (
        readRes.syncDiff?.hasBreakingDrift ||
        ((readRes.syncDiff?.addedCount > 0 || readRes.syncDiff?.removedCount > 0) &&
          !schedule.autoApproveSheetKeywordChanges)
      ) {
        return {
          ok: false,
          clientId: client.clientId,
          clientName: client.clientName,
          failureCode: SCHEDULE_FAILURE_CODES.SHEET_STRUCTURE_DRIFT,
          error: `Spreadsheet structure or keyword list changed unexpectedly for '${client.clientName}': ${
            readRes.syncDiff.driftReasons?.join("; ") || "Manual approval required before syncing changes"
          }`,
        };
      } else if (Array.isArray(readRes.importedKeywords) && readRes.importedKeywords.length > 0) {
        if (keywordManager) {
          await keywordManager.saveKeywordsBulk(client.clientId, readRes.importedKeywords);
        } else {
          await clientStorage.saveKeywordsBulk(readRes.importedKeywords);
        }
        if (readRes.snapshot) {
          await clientStorage.saveSheetSnapshot(readRes.snapshot);
        }
        importedFromSheet = true;
      }
    }

    // Load active client keywords
    const allClientKeywords = await clientStorage.listKeywordsByClient(client.clientId);
    const activeKeywords = allClientKeywords.filter(
      (k) =>
        k.active !== false &&
        (!k.locationId || k.locationId === location.locationId)
    );
    if (activeKeywords.length === 0) {
      return {
        ok: false,
        clientId: client.clientId,
        clientName: client.clientName,
        failureCode: SCHEDULE_FAILURE_CODES.MISSING_KEYWORDS,
        error: `No active keywords found for '${client.clientName}'.`,
      };
    }

    // Mandatory pre-search GPS + Google location verification
    if (typeof verifyLocationForClient === "function") {
      const locCheck = await verifyLocationForClient({ client, location, execution });
      if (!locCheck?.ok) {
        const isGoogle = locCheck?.stage === "google_location";
        return {
          ok: false,
          clientId: client.clientId,
          clientName: client.clientName,
          failureCode: isGoogle
            ? SCHEDULE_FAILURE_CODES.GOOGLE_LOCATION_FAILED
            : SCHEDULE_FAILURE_CODES.GPS_LOCATION_FAILED,
          error: locCheck?.error || "Location verification failed before scheduled keyword checks.",
        };
      }
    }

    const jobId = `sjob_${execution.executionId}_${client.clientId}`;
    const existingJob =
      typeof clientStorage.getJobRecord === "function" ? await clientStorage.getJobRecord(jobId) : null;
    const jobRecord = existingJob
      ? {
          ...existingJob,
          state: JOB_STATES.RUNNING,
          isAuthorized: Boolean(schedule.isAuthorized),
        }
      : {
          jobId,
          clientId: client.clientId,
          locationId: location.locationId,
          locationName: location.locationName,
          scheduleId: schedule.scheduleId,
          executionId: execution.executionId,
          websiteDomain: client.websiteDomain,
          searchDepth: schedule.searchDepth || 50,
          deviceType: location.deviceType || "Desktop",
          isAuthorized: Boolean(schedule.isAuthorized),
          state: JOB_STATES.RUNNING,
          createdAt: now.toISOString(),
          tasks: activeKeywords.map((kw, idx) => ({
            taskId: `stask_${idx + 1}_${kw.keywordId || idx}`,
            jobId,
            clientId: client.clientId,
            locationId: location.locationId,
            locationName: location.locationName,
            keywordId: kw.keywordId || null,
            keyword: kw.keyword,
            keywordGroup: kw.keywordGroup || "Default",
            searchVolume: kw.searchVolume ?? "",
            competition: kw.competition || "",
            landingPage: kw.landingPage || "",
            rowNumber: kw.rowPosition ?? null,
            rowPosition: kw.rowPosition ?? null,
            spreadsheetId: kw.spreadsheetId || client.sheetConfig?.spreadsheetId || null,
            worksheetId: kw.worksheetId ?? client.sheetConfig?.worksheetId ?? null,
            worksheetName: kw.worksheetName || client.sheetConfig?.worksheetName || null,
            status: TASK_STATUSES.PENDING,
            position: null,
            rankingUrl: null,
            isLiveVerified: false,
          })),
        };
    await clientStorage.saveJobRecord(jobRecord);

    const maxRetries = Number(schedule.retryPolicy?.maxKeywordRetries ?? RETRY_CONFIG.maxKeywordRetries);
    const delayBetweenKeywords = Math.max(
      RETRY_CONFIG.minDelayBetweenKeywordsMs,
      Number(schedule.delayBetweenKeywordsMs ?? RETRY_CONFIG.defaultDelayBetweenKeywordsMs)
    );

    let haltedByCaptcha = false;
    let haltedByLocation = false;
    let haltedByStorage = false;
    let haltError = null;

    try {
    for (let i = 0; i < jobRecord.tasks.length; i += 1) {
      const task = jobRecord.tasks[i];
      if (task.status === TASK_STATUSES.RANKED || task.status === TASK_STATUSES.NOT_FOUND) {
        continue; // Recover interrupted scheduled jobs without repeating completed keywords
      }
      if (i > 0) {
        await delayMs(schedule.testFastDelayMs ?? delayBetweenKeywords);
      }

      let attempt = 0;
      let outcome = null;

      while (attempt <= maxRetries) {
        attempt += 1;
        outcome = await runKeywordCheck({
          client,
          location,
          task,
          job: jobRecord,
          attempt,
        });

        const st = outcome?.status;
        if (st === TASK_STATUSES.RANKED || st === TASK_STATUSES.NOT_FOUND) {
          break;
        }
        if (st === TASK_STATUSES.SEARCH_BLOCKED || outcome?.captchaDetected) {
          haltedByCaptcha = true;
          haltError = outcome?.errorDetails || outcome?.error || "CAPTCHA / unusual traffic detected.";
          break;
        }
        if (
          st === TASK_STATUSES.LOCATION_MISMATCH ||
          st === TASK_STATUSES.LOCATION_UNVERIFIED ||
          outcome?.locationMismatch ||
          outcome?.permissionDenied ||
          outcome?.debuggerDisconnected
        ) {
          haltedByLocation = true;
          haltError = outcome?.errorDetails || outcome?.error || "Location/debugger verification failed during scheduled check.";
          break;
        }
        if (attempt <= maxRetries && outcome?.transient !== false) {
          await delayMs(schedule.testFastDelayMs ?? RETRY_CONFIG.keywordRetryDelayMs);
        } else {
          break;
        }
      }

      if (typeof scheduleStorage.renewExecutionLock === "function") {
        await scheduleStorage.renewExecutionLock(execution.executionId);
      }

      task.status = outcome?.status || TASK_STATUSES.NETWORK_ERROR;
      task.position = typeof outcome?.position === "number" ? outcome.position : null;
      task.rankingUrl = outcome?.rankingUrl || null;
      task.checkedAt = new Date().toISOString();
      task.isLiveVerified = Boolean(outcome?.isLiveVerified);
      task.requestedDepth = jobRecord.searchDepth;
      const verifiedDepth = Number(outcome?.actualVerifiedDepth ?? outcome?.actualResultsChecked ?? 0);
      task.actualResultsChecked = verifiedDepth;
      task.actualVerifiedDepth = verifiedDepth;
      task.verifiedEndOfResults = Boolean(outcome?.verifiedEndOfResults);
      task.browserGpsVerification = outcome?.browserGpsVerification || null;
      task.googleLocationVerification = outcome?.googleLocationVerification || null;
      task.googleLocationSource = outcome?.googleLocationSource || null;
      task.googleLocationSourceType = outcome?.googleLocationSourceType || null;
      task.sourceMode = outcome?.sourceMode || "live_bulk";
      task.targetDomain = client.websiteDomain;
      task.errorDetails = outcome?.errorDetails || outcome?.error || null;

      // Persist each ranking result immediately after every completed keyword
      const singleResultRecord = {
        ...task,
        recordKey: `${jobRecord.jobId}::${task.taskId}`,
        timestamp: task.checkedAt,
        sourceMode: "live_bulk",
      };
      const saveSingleRes = await clientStorage.saveResultsBatch([singleResultRecord]);
      if (!saveSingleRes?.ok) {
        haltedByStorage = true;
        haltError = saveSingleRes?.error || "Storage write failed while persisting keyword result.";
        break;
      }
      if (historyStorage) {
        const histRes = await historyStorage.saveRankingHistoryBatch([singleResultRecord]);
        if (!histRes?.ok) {
          haltedByStorage = true;
          haltError = histRes?.error || "History storage write failed.";
          break;
        }
      }
      const jobSaveRes = await clientStorage.saveJobRecord(jobRecord);
      if (jobSaveRes && jobSaveRes.ok === false) {
        haltedByStorage = true;
        haltError = jobSaveRes.error || "Job checkpoint storage write failed.";
        break;
      }

      if (haltedByCaptcha || haltedByLocation) {
        await clientStorage.saveJobRecord({ ...jobRecord, state: JOB_STATES.PAUSED });
        break;
      }
    }
    } catch (unexpectedErr) {
      haltedByStorage = true;
      haltError = unexpectedErr instanceof Error ? unexpectedErr.message : String(unexpectedErr);
    }

    const errorCount = jobRecord.tasks.filter((t) => isFailedTaskStatus(t.status)).length;
    const unfinishedCount = jobRecord.tasks.filter((t) => t.status === TASK_STATUSES.PENDING).length;
    jobRecord.state = haltedByStorage
      ? JOB_STATES.INTERRUPTED
      : haltedByCaptcha || haltedByLocation
        ? JOB_STATES.PAUSED
        : errorCount > 0 || unfinishedCount > 0
          ? JOB_STATES.COMPLETED_WITH_ERRORS
          : JOB_STATES.COMPLETED;
    jobRecord.storageFailure = haltedByStorage;
    jobRecord.lastError = haltError || null;
    jobRecord.completedAt = haltedByStorage ? null : new Date().toISOString();
    const finalJobSave = await clientStorage.saveJobRecord(jobRecord);
    if (finalJobSave && finalJobSave.ok === false) {
      haltedByStorage = true;
      haltError = finalJobSave.error || "Failed saving final job state.";
      jobRecord.state = JOB_STATES.INTERRUPTED;
    }

    // Persist verified & failed task logs cleanly into client results & unified history storage
    if (!haltedByStorage) {
      const resultRecords = jobRecord.tasks
        .filter((t) => t.status !== TASK_STATUSES.PENDING)
        .map((t) => ({
          ...t,
          recordKey: `${jobRecord.jobId}::${t.taskId}`,
          timestamp: t.checkedAt || jobRecord.completedAt,
          sourceMode: "live_bulk",
        }));
      if (resultRecords.length > 0) {
        await clientStorage.saveResultsBatch(resultRecords);
        if (historyStorage) {
          await historyStorage.saveRankingHistoryBatch(resultRecords);
        }
      }
    }

    // Step: Prepare Google Sheet Update Preview (Mode A) or verified sandbox write (Mode B)
    let sheetPreview = null;
    let sheetPreviewError = null;
    let autoWriteResult = null;
    const completedCleanCount = jobRecord.tasks.filter(
      (t) => t.status === TASK_STATUSES.RANKED || t.status === TASK_STATUSES.NOT_FOUND
    ).length;

    if (!haltedByStorage && !haltedByCaptcha && !haltedByLocation && completedCleanCount > 0 && sheetUrlOrId && sheetUpdater) {
      const reportingTimezone =
        location.reportingTimezone || schedule.timezone || client.sheetConfig?.timeZone || "Australia/Sydney";
      const reportingDate = formatDateInTimezone(now, reportingTimezone);
      const prevRes = await sheetUpdater.generatePreview({
        clientId: client.clientId,
        locationId: location.locationId,
        job: jobRecord,
        tasks: jobRecord.tasks,
        reportingDate,
      });

      if (!prevRes.ok) {
        sheetPreviewError = prevRes.errors?.join("; ") || prevRes.error;
      } else {
        sheetPreview = prevRes.preview;
        const settings = await scheduleStorage.loadSchedulerSettings();

        if (
          schedule.automationMode === AUTOMATION_MODES.MODE_B_AUTO_SHEET &&
          (schedule.sandboxMode || settings.unattendedProdSheetWritesEnabled) &&
          sheetBackupManager
        ) {
          const bkpRes = await sheetBackupManager.createAndVerifyBackup({
            clientId: client.clientId,
            spreadsheetId: sheetPreview.spreadsheetId,
            worksheetId: sheetPreview.worksheetId,
            worksheetName: sheetPreview.worksheetName,
            jobId: jobRecord.jobId,
            approvedPlanFingerprint: sheetPreview.planFingerprint,
            preWriteSnapshotFingerprint: prevRes.snapshot?.structureFingerprint || null,
          });
          if (bkpRes.ok) {
            autoWriteResult = await sheetUpdater.executeApprovedUpdate({
              clientId: client.clientId,
              locationId: location.locationId,
              job: jobRecord,
              tasks: jobRecord.tasks,
              approvedPreview: sheetPreview,
              approvalConfirmation: true,
              backupId: bkpRes.backup.backupId,
              reportingDate,
              mode: schedule.sandboxMode ? UPDATE_MODES.SANDBOX : UPDATE_MODES.PRODUCTION,
              dryRun: false,
              productionApproved: Boolean(schedule.productionApproved && settings.unattendedProdSheetWritesEnabled),
            });
          } else {
            sheetPreviewError = bkpRes.error;
          }
        }
      }
    }

    return {
      ok: !haltedByStorage && !haltedByCaptcha && !haltedByLocation && errorCount === 0,
      storageFailure: haltedByStorage,
      clientId: client.clientId,
      clientName: client.clientName,
      locationName: location.locationName,
      jobId: jobRecord.jobId,
      importedFromSheet,
      sheetSyncWarning,
      totalKeywords: jobRecord.tasks.length,
      completedKeywords: completedCleanCount,
      failedKeywords: errorCount,
      haltedByCaptcha,
      haltedByLocation,
      failureCode: haltedByCaptcha
        ? SCHEDULE_FAILURE_CODES.CAPTCHA_BLOCKED
        : haltedByLocation
          ? SCHEDULE_FAILURE_CODES.GOOGLE_LOCATION_FAILED
          : sheetPreviewError
            ? SCHEDULE_FAILURE_CODES.SHEET_PREVIEW_FAILED
            : null,
      error: haltError || sheetPreviewError || null,
      sheetPreview,
      autoWriteResult,
    };
  }

  async function runExecution(execution, { now = new Date() } = {}) {
    const schedule = await scheduleStorage.getSchedule(execution.scheduleId);
    if (!schedule) {
      return { ok: false, error: `Schedule '${execution.scheduleId}' not found.` };
    }

    const lockRes = await scheduleStorage.acquireExecutionLock({
      lockType: LOCK_TYPES.SCHEDULED_JOB,
      ownerId: execution.executionId,
      description: `Scheduled check: ${schedule.name || schedule.clientName}`,
    });
    if (!lockRes.acquired) {
      execution.deferredReason = lockRes.error;
      await scheduleStorage.saveExecution(execution);
      return { ok: false, deferred: true, error: lockRes.error };
    }

    const startedAt = now.toISOString();
    execution.status = EXECUTION_STATES.RUNNING;
    execution.startedAt = startedAt;
    execution.deferredReason = null;
    await scheduleStorage.saveExecution(execution);
    await scheduleStorage.saveSchedule({ ...schedule, status: SCHEDULE_STATES.RUNNING, updatedAt: startedAt });

    const clientEntries =
      schedule.scopeType === "agency_batch"
        ? schedule.clientConfigs || []
        : [{ clientId: schedule.clientId, locationId: schedule.locationId }];

    const clientReports = [];
    let haltedGloballyByCaptcha = false;

    try {
      for (let idx = 0; idx < clientEntries.length; idx += 1) {
        if (idx > 0) {
          await delayMs(schedule.testFastDelayMs ?? schedule.delayBetweenClientsMs ?? RETRY_CONFIG.defaultDelayBetweenClientsMs);
        }
        const report = await executeSingleClientStep({
          schedule,
          entryConfig: clientEntries[idx],
          execution,
          now,
        });
        clientReports.push(report);
        if (report.haltedByCaptcha) {
          haltedGloballyByCaptcha = true;
          break;
        }
      }

      const summary = {
        totalClients: clientEntries.length,
        completedClients: clientReports.filter((r) => r.completedKeywords > 0 || r.ok).length,
        failedClients: clientReports.filter((r) => !r.ok).length,
        totalKeywords: clientReports.reduce((acc, r) => acc + (r.totalKeywords || 0), 0),
        completedKeywords: clientReports.reduce((acc, r) => acc + (r.completedKeywords || 0), 0),
        failedKeywords: clientReports.reduce((acc, r) => acc + (r.failedKeywords || 0), 0),
        previewReadyCount: clientReports.filter((r) => Boolean(r.sheetPreview)).length,
      };

      const anyCaptcha = clientReports.some((r) => r.haltedByCaptcha);
      const anyLocationFail = clientReports.some(
        (r) =>
          r.haltedByLocation ||
          r.failureCode === SCHEDULE_FAILURE_CODES.GPS_LOCATION_FAILED ||
          r.failureCode === SCHEDULE_FAILURE_CODES.GOOGLE_LOCATION_FAILED
      );
      const anyAuthFail = clientReports.some((r) => r.failureCode === SCHEDULE_FAILURE_CODES.AUTH_EXPIRED);
      const anyStorageFail = clientReports.some((r) => r.storageFailure);
      const allFailed = clientReports.length > 0 && clientReports.every((r) => !r.ok && (r.completedKeywords === 0 || r.storageFailure));
      const hasAnyError = clientReports.some((r) => !r.ok || r.failedKeywords > 0 || Boolean(r.error));

      const finalExecStatus = anyStorageFail || allFailed || anyCaptcha || anyLocationFail || anyAuthFail
        ? anyStorageFail || anyCaptcha || allFailed
          ? EXECUTION_STATES.FAILED
          : EXECUTION_STATES.COMPLETED_WITH_ERRORS
        : summary.previewReadyCount > 0
          ? EXECUTION_STATES.SHEET_PREVIEW_READY
          : hasAnyError
            ? EXECUTION_STATES.COMPLETED_WITH_ERRORS
            : EXECUTION_STATES.COMPLETED;

      const completedAt = new Date().toISOString();
      execution.status = finalExecStatus;
      execution.completedAt = completedAt;
      execution.clientReports = clientReports;
      execution.summary = summary;
      execution.haltedByCaptcha = haltedGloballyByCaptcha;
      execution.firstError = clientReports.find((r) => r.error)?.error || null;
      await scheduleStorage.saveExecution(execution);

      const nextCalc = schedule.enabled
        ? calculateNextRunAt({
            dayOfWeek: schedule.dayOfWeek,
            timeOfDay: schedule.timeOfDay,
            timezone: schedule.timezone,
            frequency: schedule.frequency,
            afterDate: new Date(Date.parse(completedAt)),
            lastScheduledRunAt: execution.scheduledForAt,
          })
        : null;

      const nextSchedStatus = !schedule.enabled
        ? SCHEDULE_STATES.DISABLED
        : anyStorageFail || anyCaptcha || anyLocationFail || anyAuthFail || allFailed
          ? SCHEDULE_STATES.NEEDS_ATTENTION
          : SCHEDULE_STATES.ENABLED;

      const updatedSchedule = {
        ...schedule,
        status: nextSchedStatus,
        lastRunAt: completedAt,
        lastStatus: finalExecStatus,
        lastExecutionId: execution.executionId,
        lastError: execution.firstError,
        nextScheduledRunAt: nextCalc ? nextCalc.iso : null,
        updatedAt: completedAt,
      };
      await scheduleStorage.saveSchedule(updatedSchedule);
      if (alarmController) {
        await alarmController.syncScheduleAlarm(updatedSchedule);
      }

      if (notificationManager) {
        if (anyCaptcha) {
          await notificationManager.notify(NOTIFICATION_EVENTS.CAPTCHA_BLOCKED, {
            scheduleName: schedule.name || schedule.clientName,
            clientId: schedule.clientId,
          });
        } else if (anyAuthFail) {
          await notificationManager.notify(NOTIFICATION_EVENTS.AUTH_REQUIRED, {
            scheduleName: schedule.name || schedule.clientName,
            clientId: schedule.clientId,
          });
        } else if (anyLocationFail) {
          await notificationManager.notify(NOTIFICATION_EVENTS.LOCATION_FAILED, {
            scheduleName: schedule.name || schedule.clientName,
            clientId: schedule.clientId,
            reason: execution.firstError,
          });
        } else if (hasAnyError) {
          await notificationManager.notify(NOTIFICATION_EVENTS.COMPLETED_WITH_ERRORS, {
            scheduleName: schedule.name || schedule.clientName,
            clientId: schedule.clientId,
            completedKeywords: summary.completedKeywords,
            totalKeywords: summary.totalKeywords,
            errorCount: summary.failedKeywords || summary.failedClients,
          });
        } else {
          await notificationManager.notify(NOTIFICATION_EVENTS.COMPLETED, {
            scheduleName: schedule.name || schedule.clientName,
            clientId: schedule.clientId,
            totalKeywords: summary.totalKeywords,
            previewReady: summary.previewReadyCount > 0,
          });
        }
      }

      if (activityLogger) {
        await activityLogger({
          category: "schedule_execution",
          clientId: schedule.clientId,
          title: `Scheduled check ${finalExecStatus}: ${schedule.name || schedule.clientName}`,
          message: `${summary.completedKeywords}/${summary.totalKeywords} keywords verified; previews ready: ${summary.previewReadyCount}.`,
        }).catch(() => {});
      }

      return { ok: !anyStorageFail, storageFailure: anyStorageFail, execution, schedule: updatedSchedule };
    } finally {
      await scheduleStorage.releaseExecutionLock(execution.executionId);
    }
  }

  return {
    runExecution,
  };
}

