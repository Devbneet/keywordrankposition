/**
 * Sequential Assisted Ranking Workflow (1 keyword at a time on 1 dedicated tab).
 * Supports user-controlled Google searches/scrolling/pagination as well as
 * authorized automated navigation, stopping immediately on target match or CAPTCHA,
 * persisting each keyword immediately, and reusing the same reporting date column
 * when updating the client Google Sheet.
 */

import { getCountryPreset } from "../location/coordinate-validator.js";
import { verifyBrowserGeolocation } from "../location/geolocation-verifier.js";
import { inspectGoogleSearchHtml } from "../location/google-location-verifier.js";
import { GOOGLE_LOCATION_STATUSES, LOCATION_STATES } from "../location/location-state.js";
import { normalizeDomain } from "../ranking/domain-matcher.js";
import { parseGoogleSerpHtml } from "../ranking/organic-parser.js";
import { calculateOrganicRanking } from "../ranking/ranking-calculator.js";
import { createCanonicalRankingResult, RANKING_STATUSES } from "../ranking/ranking-state.js";
import { TASK_STATUSES } from "./job-state.js";

export const ASSISTED_STORAGE_KEY = "dm_sequential_assisted_session";

export const ASSISTED_STATES = Object.freeze({
  IDLE: "Idle",
  AWAITING_USER_SEARCH: "Awaiting search / page inspection",
  TARGET_FOUND: "Target website found",
  KEYWORD_COMPLETED: "Keyword completed",
  PAUSED: "Paused",
  CAPTCHA_PAUSED: "Paused (CAPTCHA / traffic block)",
  COMPLETED: "Completed",
  STOPPED: "Stopped",
});

function buildGoogleSearchUrl({ keyword, googleDomain = "google.com.au", country = "Australia", language = "en-AU" }) {
  const preset = getCountryPreset(country);
  const domain = String(googleDomain || preset.googleDomain).trim().toLowerCase().replace(/^www\./, "");
  const q = encodeURIComponent(String(keyword || "").trim());
  const hl = encodeURIComponent(String(language || preset.defaultLanguage).trim() || "en");
  const gl = encodeURIComponent(preset.code);
  return `https://www.${domain}/search?q=${q}&hl=${hl}&gl=${gl}`;
}

export function createSequentialAssistedRunner({
  chromeApi = globalThis.chrome,
  storageClient,
  locationController,
  clientStorage,
  historyStorage = null,
  sheetUpdater = null,
  sheetBackupManager = null,
  searchLock = null,
} = {}) {
  if (!storageClient) {
    throw new Error("storageClient is required for createSequentialAssistedRunner.");
  }

  async function loadSession() {
    const res = await storageClient.get(ASSISTED_STORAGE_KEY);
    return res?.[ASSISTED_STORAGE_KEY] || null;
  }

  async function saveSession(session) {
    await storageClient.set({ [ASSISTED_STORAGE_KEY]: session });
    return session;
  }

  async function getStatus() {
    const session = await loadSession();
    return { ok: true, session };
  }

  function releaseSearchLock() {
    if (searchLock && searchLock.owner === "assisted") {
      searchLock.owner = null;
    }
  }

  async function verifyActiveLocation() {
    if (!locationController) {
      return { ok: false, error: "Location controller is unavailable." };
    }
    const loc = await locationController.getStatus({ reverifyGps: true });
    if (!loc || !loc.config || !loc.debuggerAttached || loc.tabId === null) {
      return { ok: false, error: "Dedicated verified tab and debugger session are required.", locationState: loc };
    }
    if (loc.browserGpsStatus !== LOCATION_STATES.GPS_VERIFIED) {
      return {
        ok: false,
        error: loc.lastError || `Browser GPS is '${loc.browserGpsStatus}', expected GPS verified.`,
        locationState: loc,
      };
    }
    if (
      loc.googleLocationStatus !== GOOGLE_LOCATION_STATUSES.MATCHED ||
      loc.googleLocationSourceType !== "device" ||
      loc.strictRankingEligible === false
    ) {
      return {
        ok: false,
        error: loc.lastError || "Google Search location must be verified as a device-based match.",
        locationState: loc,
      };
    }
    return { ok: true, locationState: loc };
  }

  async function getActiveDebuggerLocation() {
    if (!locationController) {
      return { ok: false, error: "Location controller is unavailable." };
    }
    const loc = await locationController.getStatus({ reverifyGps: false });
    if (!loc || !loc.config || !loc.debuggerAttached || loc.tabId === null) {
      return { ok: false, error: "Dedicated verified tab and debugger session are required.", locationState: loc };
    }
    return { ok: true, locationState: loc };
  }

  async function startSession({
    clientId,
    locationId,
    keywords = [],
    searchDepth = 50,
    reportingDate = null,
    autoUpdateSheet = false,
    sheetMode = "dry-run",
    isAuthorized = false,
  } = {}) {
    if (searchLock && searchLock.owner) {
      return { ok: false, error: `Cannot start assisted workflow while '${searchLock.owner}' is active.` };
    }
    const existing = await loadSession();
    if (existing && (existing.status === ASSISTED_STATES.AWAITING_USER_SEARCH || existing.status === ASSISTED_STATES.TARGET_FOUND)) {
      return { ok: false, error: "An assisted sequential ranking session is already active. Pause or stop it first." };
    }

    const client = clientId && clientStorage ? await clientStorage.getClient(clientId) : null;
    if (!client) {
      return { ok: false, error: "Valid clientId is required to start sequential assisted workflow." };
    }
    const clientLocs = clientStorage ? await clientStorage.listLocationsByClient(clientId) : [];
    const location = locationId
      ? clientLocs.find((l) => l.locationId === locationId) || null
      : clientLocs.length === 1
        ? clientLocs[0]
        : null;
    if (!location) {
      return { ok: false, error: "Explicit target location is required for sequential assisted workflow." };
    }

    const cleanDomain = normalizeDomain(client.websiteDomain);
    if (!cleanDomain) {
      return { ok: false, error: "Client has an invalid website domain." };
    }

    const queue = (Array.isArray(keywords) ? keywords : [])
      .map((k, idx) => {
        const kwText = typeof k === "string" ? k.trim() : String(k?.keyword || "").trim();
        if (!kwText) return null;
        return {
          taskId: `ast_${idx + 1}_${k?.keywordId || idx}`,
          keywordId: k?.keywordId || null,
          keyword: kwText,
          keywordGroup: k?.keywordGroup || "Default",
          rowNumber: k?.rowNumber ?? k?.rowPosition ?? null,
          rowPosition: k?.rowPosition ?? k?.rowNumber ?? null,
          spreadsheetId: k?.spreadsheetId || client.sheetConfig?.spreadsheetId || null,
          worksheetId: k?.worksheetId ?? client.sheetConfig?.worksheetId ?? null,
          status: TASK_STATUSES.PENDING,
          position: null,
          rankingUrl: null,
          checkedResults: 0,
          verifiedEndOfResults: false,
          sheetUpdateStatus: "Pending",
        };
      })
      .filter(Boolean);

    if (queue.length === 0) {
      return { ok: false, error: "At least one keyword is required." };
    }

    const locCheck = await verifyActiveLocation();
    if (!locCheck.ok) {
      return { ok: false, error: locCheck.error, locationState: locCheck.locationState };
    }

    if (searchLock) searchLock.owner = "assisted";

    const depth = Math.min(50, Math.max(10, Number(searchDepth) || 50));
    const sessionId = `assist_${clientId}_${Date.now()}`;
    const resolvedReportingDate = reportingDate || new Date().toISOString().slice(0, 10);

    const session = {
      sessionId,
      clientId: client.clientId,
      clientName: client.clientName,
      targetDomain: cleanDomain,
      locationId: location.locationId,
      locationName: location.locationName,
      tabId: locCheck.locationState.tabId,
      searchDepth: depth,
      reportingDate: resolvedReportingDate,
      reusedDateColumnLabel: null,
      autoUpdateSheet: Boolean(autoUpdateSheet),
      sheetMode,
      isAuthorized: Boolean(isAuthorized),
      status: ASSISTED_STATES.AWAITING_USER_SEARCH,
      currentIndex: 0,
      currentPageNumber: 1,
      accumulatedPages: [],
      checkedResults: 0,
      currentPosition: null,
      currentRankingUrl: null,
      locationStatusLabel: `${locCheck.locationState.browserGpsStatus} / ${locCheck.locationState.googleLocationStatus}`,
      sheetUpdateStatus: autoUpdateSheet ? "Ready (will update on keyword completion)" : "Preview / disabled",
      lastError: null,
      manualInstruction: isAuthorized
        ? "Authorized search ready. Inspect current page or navigate to next page."
        : "Perform the Google search in the dedicated Chrome tab, then click 'Inspect Current Page'.",
      queue,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (session.isAuthorized && chromeApi?.tabs?.update) {
      const searchUrl = buildGoogleSearchUrl({
        keyword: queue[0].keyword,
        googleDomain: location.googleDomain || locCheck.locationState.config?.googleDomain,
        country: location.country || locCheck.locationState.config?.country,
        language: location.language || locCheck.locationState.config?.language,
      });
      await chromeApi.tabs.update(session.tabId, { url: searchUrl, active: true }).catch(() => {});
    }

    await saveSession(session);
    return { ok: true, session };
  }

  async function maybeUpdateGoogleSheetForTask(session, completedTask) {
    if (!session.autoUpdateSheet || !sheetUpdater) {
      return { status: "Skipped (auto-update disabled)" };
    }
    if (
      completedTask.status !== TASK_STATUSES.RANKED &&
      completedTask.status !== TASK_STATUSES.NOT_FOUND
    ) {
      return { status: "Skipped (result not eligible for Sheet write)" };
    }
    if (!completedTask.rowPosition) {
      return { status: "Skipped (no spreadsheet row reference)" };
    }

    const jobStub = {
      jobId: session.sessionId,
      clientId: session.clientId,
      locationId: session.locationId,
    };

    const prevRes = await sheetUpdater.generatePreview({
      clientId: session.clientId,
      locationId: session.locationId,
      job: jobStub,
      tasks: [completedTask],
      reportingDate: session.reportingDate,
      explicitHeaderLabel: session.reusedDateColumnLabel || "",
    });
    if (!prevRes?.ok) {
      return { status: `Preview failed: ${prevRes?.error || "Unknown error"}` };
    }

    // Reuse the same reporting date column header for all subsequent keywords in this session
    if (!session.reusedDateColumnLabel && prevRes.preview?.dateHeaderLabel) {
      session.reusedDateColumnLabel = prevRes.preview.dateHeaderLabel;
    }

    if (session.sheetMode === "dry-run") {
      return {
        status: `Preview ready (col ${prevRes.preview?.targetDateColumn || "H"} · ${prevRes.preview?.dateAction || "REUSE"})`,
        preview: prevRes.preview,
      };
    }

    if (!sheetBackupManager) {
      return { status: "Blocked: backup manager unavailable" };
    }

    const bkpRes = await sheetBackupManager.createAndVerifyBackup({
      clientId: session.clientId,
      spreadsheetId: prevRes.preview.spreadsheetId,
      worksheetId: prevRes.preview.worksheetId,
      worksheetName: prevRes.preview.worksheetName,
      jobId: session.sessionId,
      approvedPlanFingerprint: prevRes.preview.planFingerprint,
      preWriteSnapshotFingerprint: prevRes.snapshot?.structureFingerprint || null,
    });
    if (!bkpRes?.ok) {
      return { status: `Backup failed: ${bkpRes?.error || "Unknown error"}` };
    }

    const execRes = await sheetUpdater.executeApprovedUpdate({
      clientId: session.clientId,
      locationId: session.locationId,
      job: jobStub,
      tasks: [completedTask],
      approvedPreview: prevRes.preview,
      approvalConfirmation: true,
      backupId: bkpRes.backup.backupId,
      reportingDate: session.reportingDate,
      explicitHeaderLabel: session.reusedDateColumnLabel || "",
      mode: session.sheetMode,
      dryRun: false,
    });

    if (!execRes?.ok) {
      return { status: `Sheet update blocked/failed: ${execRes?.error || "Unknown error"}` };
    }
    return {
      status: `Updated row ${completedTask.rowPosition} in col ${prevRes.preview.targetDateColumn} (${prevRes.preview.dateAction})`,
    };
  }

  async function inspectCurrentTabPage({ htmlOverride = null, pageUrlOverride = null } = {}) {
    const session = await loadSession();
    if (!session) {
      return { ok: false, error: "No active sequential assisted session." };
    }
    if (
      session.status === ASSISTED_STATES.PAUSED ||
      session.status === ASSISTED_STATES.CAPTCHA_PAUSED ||
      session.status === ASSISTED_STATES.COMPLETED ||
      session.status === ASSISTED_STATES.STOPPED
    ) {
      return { ok: false, error: `Session is '${session.status}'. Resume or start a new session.`, session };
    }

    const currentTask = session.queue[session.currentIndex];
    if (!currentTask) {
      session.status = ASSISTED_STATES.COMPLETED;
      releaseSearchLock();
      await saveSession(session);
      return { ok: true, session };
    }

    const locCheck = await getActiveDebuggerLocation();
    if (!locCheck.ok) {
      session.status = ASSISTED_STATES.PAUSED;
      session.lastError = locCheck.error;
      session.locationStatusLabel = locCheck.error;
      await saveSession(session);
      return { ok: false, error: locCheck.error, session };
    }

    let pageHtml = htmlOverride;
    let pageUrl = pageUrlOverride;
    if (typeof pageHtml !== "string") {
      const evalRes = await chromeApi.debugger.sendCommand({ tabId: session.tabId }, "Runtime.evaluate", {
        expression: `({ html: document.documentElement ? document.documentElement.outerHTML : "", pageUrl: window.location.href })`,
        returnByValue: true,
      });
      pageHtml = evalRes?.result?.value?.html || "";
      pageUrl = evalRes?.result?.value?.pageUrl || "";
    }

    const gpsCheck = await verifyBrowserGeolocation({
      tabId: session.tabId,
      expectedLatitude: locCheck.locationState.config.latitude,
      expectedLongitude: locCheck.locationState.config.longitude,
      chromeApi,
    });
    if (gpsCheck.state !== LOCATION_STATES.GPS_VERIFIED) {
      session.status = ASSISTED_STATES.PAUSED;
      session.lastError = gpsCheck.lastError || "Browser GPS verification failed on current page.";
      session.locationStatusLabel = gpsCheck.state;
      await saveSession(session);
      return { ok: false, error: session.lastError, session };
    }

    const parsed = parseGoogleSerpHtml({ html: pageHtml, pageUrl });
    if (parsed.blocked) {
      session.status = ASSISTED_STATES.CAPTCHA_PAUSED;
      session.lastError = parsed.blockReason || "CAPTCHA or unusual traffic detected.";
      session.manualInstruction =
        "Google displayed a CAPTCHA or traffic warning. No automatic retry will run. Resolve access in Chrome manually, then click Resume.";
      await saveSession(session);
      return { ok: false, captchaPaused: true, error: session.lastError, session };
    }

    const googleFooter = inspectGoogleSearchHtml({
      html: pageHtml,
      pageUrl,
      targetCity: locCheck.locationState.config.targetCity || locCheck.locationState.config.locationName,
      targetState: locCheck.locationState.config.targetState || "",
      targetCountry: locCheck.locationState.config.country,
    });
    if (googleFooter.status !== GOOGLE_LOCATION_STATUSES.MATCHED || !googleFooter.strictRankingEligible) {
      session.status = ASSISTED_STATES.PAUSED;
      session.lastError = googleFooter.error || googleFooter.warning || "Google location mismatch/unavailable on search page.";
      session.locationStatusLabel = googleFooter.status;
      await saveSession(session);
      return { ok: false, error: session.lastError, session };
    }

    session.locationStatusLabel = `GPS verified / ${googleFooter.detectedLocation} (${googleFooter.locationSourceType})`;
    if (locationController?.recordLiveCheckVerification) {
      await locationController.recordLiveCheckVerification({
        tabId: session.tabId,
        pageUrl,
        gpsCheck,
        googleFooterCheck: googleFooter,
      });
    }

    const pageEntry = { ...parsed, pageNumber: session.currentPageNumber, pageUrl };
    session.accumulatedPages.push(pageEntry);

    const calc = calculateOrganicRanking({
      pages: session.accumulatedPages,
      targetDomain: session.targetDomain,
      requestedDepth: session.searchDepth,
    });

    session.checkedResults = calc.checkedResults;

    // Stop checking current keyword immediately once target is found OR full depth/end-of-results is verified
    if (calc.status === RANKING_STATUSES.RANKED || calc.status === RANKING_STATUSES.NOT_FOUND) {
      const isRanked = calc.status === RANKING_STATUSES.RANKED;
      currentTask.status = isRanked ? TASK_STATUSES.RANKED : TASK_STATUSES.NOT_FOUND;
      currentTask.position = isRanked ? calc.position : null;
      currentTask.rankingUrl = isRanked ? calc.rankingUrl : null;
      currentTask.checkedResults = calc.checkedResults;
      currentTask.actualVerifiedDepth = calc.checkedResults;
      currentTask.verifiedEndOfResults = Boolean(calc.verifiedEndOfResults);
      currentTask.sourceMode = "live_google";
      currentTask.browserGpsStatus = "GPS verified";
      currentTask.googleLocationStatus = "Google location matched";
      currentTask.googleLocationSourceType = "device";
      currentTask.isLiveVerified = true;
      currentTask.clientId = session.clientId;
      currentTask.locationId = session.locationId;
      currentTask.jobId = session.sessionId;
      currentTask.targetDomain = session.targetDomain;
      currentTask.checkedAt = new Date().toISOString();

      // Persist completed keyword immediately
      const resultRec = createCanonicalRankingResult({
        ...currentTask,
        resultId: `${session.sessionId}::${currentTask.taskId}`,
      });
      if (clientStorage?.saveResultsBatch) {
        await clientStorage.saveResultsBatch([{ ...resultRec, recordKey: resultRec.resultId }]);
      }
      if (historyStorage?.saveRankingHistoryBatch) {
        await historyStorage.saveRankingHistoryBatch([resultRec]);
      }

      const sheetRes = await maybeUpdateGoogleSheetForTask(session, currentTask);
      currentTask.sheetUpdateStatus = sheetRes.status;
      session.sheetUpdateStatus = sheetRes.status;
      session.currentPosition = currentTask.position;
      session.currentRankingUrl = currentTask.rankingUrl;
      session.status = isRanked ? ASSISTED_STATES.TARGET_FOUND : ASSISTED_STATES.KEYWORD_COMPLETED;
      session.lastError = null;
      session.manualInstruction = isRanked
        ? `Target found at organic position #${currentTask.position}. Click 'Next Keyword' to proceed.`
        : `Confirmed Not Found within ${calc.checkedResults} verified results. Click 'Next Keyword' to proceed.`;
      session.updatedAt = new Date().toISOString();
      await saveSession(session);
      return { ok: true, keywordFinished: true, result: currentTask, session };
    }

    // Not found yet and depth not yet reached -> wait for next page navigation / inspection
    session.currentPageNumber += 1;
    session.status = ASSISTED_STATES.AWAITING_USER_SEARCH;
    session.manualInstruction = parsed.nextPageUrl
      ? `Checked ${calc.checkedResults}/${session.searchDepth} organic results. Navigate to page ${session.currentPageNumber} and click 'Inspect Current Page'.`
      : `Checked ${calc.checkedResults}/${session.searchDepth} organic results (no next-page link detected). Scroll/navigate or click 'Next Keyword' if search ended.`;
    session.updatedAt = new Date().toISOString();
    await saveSession(session);
    return { ok: true, keywordFinished: false, session };
  }

  async function nextKeyword() {
    const session = await loadSession();
    if (!session) return { ok: false, error: "No active sequential assisted session." };

    const cur = session.queue[session.currentIndex];
    if (cur && cur.status === TASK_STATUSES.PENDING) {
      return {
        ok: false,
        error: "Complete or pause the current keyword before advancing to the next keyword.",
        session,
      };
    }

    const nextIdx = session.currentIndex + 1;
    if (nextIdx >= session.queue.length) {
      session.status = ASSISTED_STATES.COMPLETED;
      session.manualInstruction = "All keywords in the sequential assisted queue are completed.";
      session.updatedAt = new Date().toISOString();
      releaseSearchLock();
      await saveSession(session);
      return { ok: true, completed: true, session };
    }

    session.currentIndex = nextIdx;
    session.currentPageNumber = 1;
    session.accumulatedPages = [];
    session.checkedResults = 0;
    session.currentPosition = null;
    session.currentRankingUrl = null;
    session.status = ASSISTED_STATES.AWAITING_USER_SEARCH;
    session.lastError = null;
    session.manualInstruction = session.isAuthorized
      ? `Navigated to keyword '${session.queue[nextIdx].keyword}'. Click 'Inspect Current Page'.`
      : `Search '${session.queue[nextIdx].keyword}' in the dedicated Chrome tab, then click 'Inspect Current Page'.`;
    session.updatedAt = new Date().toISOString();

    if (session.isAuthorized && chromeApi?.tabs?.update) {
      const loc = await locationController?.getStatus({ reverifyGps: false });
      const searchUrl = buildGoogleSearchUrl({
        keyword: session.queue[nextIdx].keyword,
        googleDomain: loc?.config?.googleDomain,
        country: loc?.config?.country,
        language: loc?.config?.language,
      });
      await chromeApi.tabs.update(session.tabId, { url: searchUrl, active: true }).catch(() => {});
    }

    await saveSession(session);
    return { ok: true, completed: false, session };
  }

  async function pauseSession() {
    const session = await loadSession();
    if (!session) return { ok: false, error: "No active sequential assisted session." };
    session.status = ASSISTED_STATES.PAUSED;
    session.updatedAt = new Date().toISOString();
    await saveSession(session);
    return { ok: true, session };
  }

  async function resumeSession() {
    const session = await loadSession();
    if (!session) return { ok: false, error: "No active sequential assisted session." };
    const locCheck = await verifyActiveLocation();
    if (!locCheck.ok) {
      return { ok: false, error: locCheck.error, session };
    }
    if (searchLock && !searchLock.owner) searchLock.owner = "assisted";
    session.status = ASSISTED_STATES.AWAITING_USER_SEARCH;
    session.lastError = null;
    session.locationStatusLabel = `${locCheck.locationState.browserGpsStatus} / ${locCheck.locationState.googleLocationStatus}`;
    session.updatedAt = new Date().toISOString();
    await saveSession(session);
    return { ok: true, session };
  }

  async function stopSession() {
    const session = await loadSession();
    if (!session) return { ok: true, session: null };
    session.status = ASSISTED_STATES.STOPPED;
    session.updatedAt = new Date().toISOString();
    releaseSearchLock();
    await saveSession(session);
    return { ok: true, session };
  }

  return {
    getStatus,
    startSession,
    inspectCurrentTabPage,
    nextKeyword,
    pauseSession,
    resumeSession,
    stopSession,
  };
}

