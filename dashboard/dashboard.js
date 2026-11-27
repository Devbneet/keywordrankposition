/**
 * Digital Minds Rank Tracker — Thin SaaS Dashboard Orchestrator (Phase 10).
 * Composes modular page controllers, sidebar navigation, quick client switcher,
 * and Phase 2–9 service worker handlers without mixing page logic into one file.
 */

import { initSidebarNavigation } from "./components/sidebar.js";
import { downloadTextFile, setBanner, setPill } from "./components/status-indicator.js";
import { createActivityLogsPage } from "./pages/activity-logs.js";
import { createClientsPage } from "./pages/clients.js";
import { createJobsHistoryPage } from "./pages/jobs.js";
import { createKeywordRankingsPage } from "./pages/keyword-rankings.js";
import { createOverviewPage } from "./pages/overview.js";
import { createRankingHistoryPage } from "./pages/ranking-history.js";
import { createReportsPage } from "./pages/reports.js";
import { createScheduledChecksPage } from "./pages/scheduled-checks.js";
import { createSettingsPage } from "./pages/settings.js";

import {
  importKeywordsFromBaselineRows,
  parseKeywordCsvInput,
  parseKeywordTextInput,
} from "../modules/jobs/keyword-queue.js";
import { isActiveJobState, isFailedTaskStatus, JOB_STATES, TASK_STATUSES } from "../modules/jobs/job-state.js";
import { getCountryPreset, parseCoordinatePair } from "../modules/location/coordinate-validator.js";
import { GOOGLE_LOCATION_STATUSES, LOCATION_STATES } from "../modules/location/location-state.js";
import { computeBulkProgressMetrics, exportBulkResultsCsv, filterBulkTasks } from "../modules/ranking/bulk-results.js";
import { RANKING_STATUSES } from "../modules/ranking/ranking-state.js";
import { createStorageClient } from "../modules/storage/storage.js";
import { compareRankingWithBaseline } from "../modules/validation/accuracy-comparator.js";
import {
  clearValidationState,
  loadValidationState,
  normalizeManualRank,
  parseBaselineCsv,
  saveValidationState,
} from "../modules/validation/baseline-manager.js";
import { exportComparisonCsv, exportComparisonJson } from "../modules/validation/comparison-exporter.js";
import { MESSAGE_TYPES } from "../utils/messages.js";

const versionEl = document.getElementById("dash-version");
const topbarClientSelect = document.getElementById("topbar-client-select");
const pillEl = document.getElementById("dash-health-pill");
const messageEl = document.getElementById("dash-health-message");
const workerEl = document.getElementById("detail-worker");
const storageEl = document.getElementById("detail-storage");
const timestampEl = document.getElementById("detail-timestamp");
const runHealthBtn = document.getElementById("dash-run-health-btn");

// Shared Location / Verification Controls
const locationForm = document.getElementById("location-form");
const locNameInput = document.getElementById("loc-name");
const locCityInput = document.getElementById("loc-city");
const locLatInput = document.getElementById("loc-lat");
const locLngInput = document.getElementById("loc-lng");
const locAccuracyInput = document.getElementById("loc-accuracy");
const locCountrySelect = document.getElementById("loc-country");
const locLanguageSelect = document.getElementById("loc-language");
const locGoogleDomainSelect = document.getElementById("loc-google-domain");
const locTestUrlInput = document.getElementById("loc-test-url");
const chkUpdateLocation = document.getElementById("chk-update-location");
const locFeedbackEl = document.getElementById("loc-feedback");

const applyLocationBtn = document.getElementById("btn-apply-location");
const testLocationBtn = document.getElementById("btn-test-location");
const openTestTabBtn = document.getElementById("btn-open-test-tab");
const resetLocationBtn = document.getElementById("btn-reset-location");
const applyGoogleBtn = document.getElementById("btn-apply-google-location");
const verifyGoogleBtn = document.getElementById("btn-verify-google-location");
const openGoogleBtn = document.getElementById("btn-open-google-search");

const locStatePillEl = document.getElementById("loc-state-pill");
const statusTargetLocationEl = document.getElementById("status-target-location");
const statusConfiguredCoordsEl = document.getElementById("status-configured-coords");
const statusReportedCoordsEl = document.getElementById("status-reported-coords");
const statusBrowserGpsEl = document.getElementById("status-browser-gps");
const statusGoogleDetectedEl = document.getElementById("status-google-detected");
const statusGoogleSourceEl = document.getElementById("status-google-source");
const statusGoogleLocationEl = document.getElementById("status-google-location");
const statusTabIdEl = document.getElementById("status-tab-id");
const statusLastVerifiedEl = document.getElementById("status-last-verified");
const statusErrorsWarningsEl = document.getElementById("status-errors-warnings");

// Single Keyword Ranking Controls (in Advanced Tools)
const rankingForm = document.getElementById("ranking-form");
const rankStatusPillEl = document.getElementById("rank-status-pill");
const rankCtxLocationEl = document.getElementById("rank-ctx-location");
const rankCtxCoordsEl = document.getElementById("rank-ctx-coords");
const rankCtxGoogleEl = document.getElementById("rank-ctx-google");
const rankCtxLocaleEl = document.getElementById("rank-ctx-locale");
const rankDomainInput = document.getElementById("rank-domain");
const rankKeywordInput = document.getElementById("rank-keyword");
const rankDepthSelect = document.getElementById("rank-depth");
const rankUseManualHtmlChk = document.getElementById("rank-use-manual-html");
const rankAuthorizedChk = document.getElementById("rank-authorized");
const rankManualPanel = document.getElementById("rank-manual-panel");
const rankManualFileInput = document.getElementById("rank-manual-file");
const rankManualHtmlInput = document.getElementById("rank-manual-html");
const rankFeedbackEl = document.getElementById("rank-feedback");
const checkRankingBtn = document.getElementById("btn-check-ranking");
const stopRankingBtn = document.getElementById("btn-stop-ranking");
const clearRankingBtn = document.getElementById("btn-clear-ranking");
const rankResultPanel = document.getElementById("rank-result-panel");
const resSourceBadgeEl = document.getElementById("res-source-badge");
const resSourceLabelEl = document.getElementById("res-source-label");
const resStatusEl = document.getElementById("res-status");
const resKeywordEl = document.getElementById("res-keyword");
const resWebsiteEl = document.getElementById("res-website");
const resPositionEl = document.getElementById("res-position");
const resUrlEl = document.getElementById("res-url");
const resDepthCountEl = document.getElementById("res-depth-count");
const resGpsStatusEl = document.getElementById("res-gps-status");
const resGoogleStatusEl = document.getElementById("res-google-status");
const resGoogleSourceEl = document.getElementById("res-google-source");
const resCheckedAtEl = document.getElementById("res-checked-at");
const resDurationEl = document.getElementById("res-duration");
const resErrorEl = document.getElementById("res-error");
const rankResultsTbody = document.getElementById("rank-results-tbody");

// Accuracy Lab Controls
const accCtxDomainEl = document.getElementById("acc-ctx-domain");
const accCtxLocationEl = document.getElementById("acc-ctx-location");
const accCtxLocaleEl = document.getElementById("acc-ctx-locale");
const accCtxDepthEl = document.getElementById("acc-ctx-depth");
const accDeviceSelect = document.getElementById("acc-device");
const accToleranceSelect = document.getElementById("acc-tolerance");
const accCsvFileInput = document.getElementById("acc-csv-file");
const accKeywordsInput = document.getElementById("acc-keywords");
const accFeedbackEl = document.getElementById("acc-feedback");
const accStatusPillEl = document.getElementById("acc-status-pill");
const accBaselineTbody = document.getElementById("acc-baseline-tbody");
const accReportPanel = document.getElementById("acc-report-panel");
const accComparisonTbody = document.getElementById("acc-comparison-tbody");
const accSyncKeywordsBtn = document.getElementById("btn-acc-sync-keywords");
const accCompareBtn = document.getElementById("btn-acc-compare");
const accExportCsvBtn = document.getElementById("btn-acc-export-csv");
const accExportJsonBtn = document.getElementById("btn-acc-export-json");
const accClearBtn = document.getElementById("btn-acc-clear");
const metTotalEl = document.getElementById("met-total");
const metComparableEl = document.getElementById("met-comparable");
const metExactPctEl = document.getElementById("met-exact-pct");
const metTolPctEl = document.getElementById("met-tol-pct");
const metUrlPctEl = document.getElementById("met-url-pct");
const metAvgDiffEl = document.getElementById("met-avg-diff");
const metLocMismatchEl = document.getElementById("met-loc-mismatch");
const metBlockedEl = document.getElementById("met-blocked");
const metIncompleteEl = document.getElementById("met-incomplete");

// Bulk Keyword Checker Controls
const bulkJobPillEl = document.getElementById("bulk-job-pill");
const bulkCtxDomainEl = document.getElementById("bulk-ctx-domain");
const bulkCtxLocationEl = document.getElementById("bulk-ctx-location");
const bulkCtxLocaleEl = document.getElementById("bulk-ctx-locale");
const bulkCtxModeEl = document.getElementById("bulk-ctx-mode");
const bulkDeviceSelect = document.getElementById("bulk-device");
const bulkCsvFileInput = document.getElementById("bulk-csv-file");
const bulkTxtFileInput = document.getElementById("bulk-txt-file");
const bulkImportLabBtn = document.getElementById("btn-bulk-import-lab");
const bulkImportSheetsBtn = document.getElementById("btn-bulk-import-sheets");
const bulkFirst3Btn = document.getElementById("btn-bulk-first-3");
const bulkFirst5Btn = document.getElementById("btn-bulk-first-5");
const bulkFirst10Btn = document.getElementById("btn-bulk-first-10");
const bulkSelectAllBtn = document.getElementById("btn-bulk-select-all");
const bulkDeselectAllBtn = document.getElementById("btn-bulk-deselect-all");
const bulkSelectedCountEl = document.getElementById("bulk-selected-count");
const bulkKwSearchInput = document.getElementById("bulk-kw-search");
const bulkGroupFilterSelect = document.getElementById("bulk-group-filter");
const bulkAuthorizedChk = document.getElementById("bulk-authorized");
const bulkKeywordsInput = document.getElementById("bulk-keywords");
const bulkFeedbackEl = document.getElementById("bulk-feedback");
const bulkStartBtn = document.getElementById("btn-bulk-start");
const bulkPauseBtn = document.getElementById("btn-bulk-pause");
const bulkResumeBtn = document.getElementById("btn-bulk-resume");
const bulkStopBtn = document.getElementById("btn-bulk-stop");
const bulkRetryBtn = document.getElementById("btn-bulk-retry");
const bulkExportBtn = document.getElementById("btn-bulk-export");
const bulkClearBtn = document.getElementById("btn-bulk-clear");
const bulkMTotalEl = document.getElementById("bulk-m-total");
const bulkMCompletedEl = document.getElementById("bulk-m-completed");
const bulkMPendingEl = document.getElementById("bulk-m-pending");
const bulkMRankedEl = document.getElementById("bulk-m-ranked");
const bulkMNaEl = document.getElementById("bulk-m-na");
const bulkMFailedEl = document.getElementById("bulk-m-failed");
const bulkMCurrentEl = document.getElementById("bulk-m-current");
const bulkMTimeEl = document.getElementById("bulk-m-time");
const bulkProgressLabelEl = document.getElementById("bulk-progress-label");
const bulkProgressPctEl = document.getElementById("bulk-progress-pct");
const bulkProgressFillEl = document.getElementById("bulk-progress-fill");
const bulkSearchInput = document.getElementById("bulk-search-input");
const bulkFilterSelect = document.getElementById("bulk-filter-select");
const bulkResultsTbody = document.getElementById("bulk-results-tbody");

// Google Sheets Read & Write Controls
const sheetsAuthPillEl = document.getElementById("sheets-auth-pill");
const sheetsOauthStatusEl = document.getElementById("sheets-oauth-status");
const sheetsAuthStatusEl = document.getElementById("sheets-auth-status");
const sheetsLastConnectedEl = document.getElementById("sheets-last-connected");
const sheetsCtxClientEl = document.getElementById("sheets-ctx-client");
const sheetsConnectBtn = document.getElementById("btn-sheets-connect");
const sheetsDisconnectBtn = document.getElementById("btn-sheets-disconnect");
const sheetsTestBtn = document.getElementById("btn-sheets-test");
const sheetsFeedbackEl = document.getElementById("sheets-feedback");
const sheetsUrlInput = document.getElementById("sheets-url-input");
const sheetsIdInput = document.getElementById("sheets-id-input");
const sheetsWsSelect = document.getElementById("sheets-ws-select");
const sheetsLoadWsBtn = document.getElementById("btn-sheets-load-ws");
const sheetsPreviewBtn = document.getElementById("btn-sheets-preview");
const sheetsRefreshBtn = document.getElementById("btn-sheets-refresh");
const sheetsConfirmImportBtn = document.getElementById("btn-sheets-confirm-import");
const sheetsPreviewPanel = document.getElementById("sheets-preview-panel");
const sheetsPreviewHeadingEl = document.getElementById("sheets-preview-heading");
const shMTotalEl = document.getElementById("sh-m-total");
const shMGroupsEl = document.getElementById("sh-m-groups");
const shMHeadersEl = document.getElementById("sh-m-headers");
const shMSeparatorsEl = document.getElementById("sh-m-separators");
const shMLatestDateEl = document.getElementById("sh-m-latest-date");
const shMHistoryColsEl = document.getElementById("sh-m-history-cols");
const shMMetaEl = document.getElementById("sh-m-meta");
const shMWarningsEl = document.getElementById("sh-m-warnings");
const sheetsSyncDiffBannerEl = document.getElementById("sheets-sync-diff-banner");
const sheetsAmbiguousConfirmRow = document.getElementById("sheets-ambiguous-confirm-row");
const sheetsAmbiguousConfirmChk = document.getElementById("sheets-ambiguous-confirm-chk");
const sheetsPreviewTbody = document.getElementById("sheets-preview-tbody");

const updStatusPillEl = document.getElementById("upd-status-pill");
const updClientSelect = document.getElementById("upd-client-select");
const updLocationSelect = document.getElementById("upd-location-select");
const updJobSelect = document.getElementById("upd-job-select");
const updDateInput = document.getElementById("upd-date-input");
const updModeSelect = document.getElementById("upd-mode-select");
const updWriteAccessBadgeEl = document.getElementById("upd-write-access-badge");
const updEnableWriteBtn = document.getElementById("btn-upd-enable-write");
const updFeedbackEl = document.getElementById("upd-feedback");
const updPreviewBtn = document.getElementById("btn-upd-preview");
const updBackupBtn = document.getElementById("btn-upd-backup");
const updExecuteBtn = document.getElementById("btn-upd-execute");
const updVerifyBtn = document.getElementById("btn-upd-verify");
const updHistoryBtn = document.getElementById("btn-upd-history");
const updOpenSheetBtn = document.getElementById("btn-upd-open-sheet");
const updViewBackupBtn = document.getElementById("btn-upd-view-backup");
const updConfirmChk = document.getElementById("upd-confirm-chk");
const updPreviewPanel = document.getElementById("upd-preview-panel");
const updMTargetEl = document.getElementById("upd-m-target");
const updMDatePlanEl = document.getElementById("upd-m-date-plan");
const updMCountsEl = document.getElementById("upd-m-counts");
const updMSerpHdrEl = document.getElementById("upd-m-serp-hdr");
const updMBackupEl = document.getElementById("upd-m-backup");
const updMStructureEl = document.getElementById("upd-m-structure");
const updPreviewTbody = document.getElementById("upd-preview-tbody");
const updJournalPanel = document.getElementById("upd-journal-panel");
const updJournalTbody = document.getElementById("upd-journal-tbody");

let latestLocationState = null;
let latestRankingState = null;
let latestBulkState = { job: null, tasks: [], isBusy: false };
let bulkPollTimer = null;
let parsedBulkQueueInput = null;
let latestSheetReadResult = null;
let excludedSheetRows = new Set();
let latestUpdatePreviewState = null;
let latestVerifiedBackup = null;
let writeAccessEnabledState = false;
let validationState = { tolerance: 1, deviceType: "Desktop", baselineRows: [], comparisonReport: null };

let navCtrl;
let clientsPage;
let overviewPage;
let keywordRankingsPage;
let rankingHistoryPage;
let reportsPage;
let activityLogsPage;
let settingsPage;
let scheduledChecksPage;
let jobsHistoryPage;

function getDashboardStorage() {
  return createStorageClient(chrome.storage.local);
}

function renderSharedContextSummaries() {
  const cfg = latestLocationState?.config;
  const domainVal = rankDomainInput.value.trim() || "-";
  const depthVal = rankDepthSelect.value;
  if (cfg) {
    const locTitle = [cfg.locationName, cfg.targetCity].filter(Boolean).join(" / ") || "Configured";
    rankCtxLocationEl.textContent = locTitle;
    rankCtxCoordsEl.textContent = `${cfg.latitude}, ${cfg.longitude}`;
    rankCtxLocaleEl.textContent = `${cfg.country} (${cfg.language})`;
    accCtxLocationEl.textContent = `${locTitle} (${cfg.latitude}, ${cfg.longitude})`;
    accCtxLocaleEl.textContent = `${cfg.country} (${cfg.language})`;
    bulkCtxLocationEl.textContent = `${locTitle} (${cfg.latitude}, ${cfg.longitude})`;
    bulkCtxLocaleEl.textContent = `${cfg.country} (${cfg.language})`;
  } else {
    rankCtxLocationEl.textContent = "Not configured";
    rankCtxCoordsEl.textContent = "-";
    rankCtxLocaleEl.textContent = `${locCountrySelect.value} (${locLanguageSelect.value})`;
    accCtxLocationEl.textContent = "Not configured";
    accCtxLocaleEl.textContent = `${locCountrySelect.value} (${locLanguageSelect.value})`;
    bulkCtxLocationEl.textContent = "Not configured";
    bulkCtxLocaleEl.textContent = `${locCountrySelect.value} (${locLanguageSelect.value})`;
  }
  accCtxDomainEl.textContent = domainVal;
  accCtxDepthEl.textContent = depthVal;
  bulkCtxDomainEl.textContent = domainVal;
  bulkCtxModeEl.textContent = `${bulkDeviceSelect.value} · Depth ${depthVal}`;
  rankCtxGoogleEl.textContent = latestLocationState?.googleDetectedLocation
    ? `${latestLocationState.googleDetectedLocation} (${latestLocationState.googleLocationStatus})`
    : latestLocationState?.googleLocationStatus || "Unverified";
}

function renderLocationState(state, { populateInputs = false } = {}) {
  latestLocationState = state;
  if (populateInputs && state?.config) {
    locNameInput.value = state.config.locationName || "";
    locCityInput.value = state.config.targetCity || "";
    locLatInput.value = state.config.latitude ?? "";
    locLngInput.value = state.config.longitude ?? "";
    locAccuracyInput.value = state.config.accuracy ?? 20;
    if (state.config.country) locCountrySelect.value = state.config.country;
    if (state.config.language) locLanguageSelect.value = state.config.language;
    if (state.config.googleDomain) locGoogleDomainSelect.value = state.config.googleDomain;
    if (state.config.testPageUrl) locTestUrlInput.value = state.config.testPageUrl;
  }
  const s = state?.state || LOCATION_STATES.NOT_CONFIGURED;
  setPill(
    locStatePillEl,
    s === LOCATION_STATES.GPS_VERIFIED || s === LOCATION_STATES.GOOGLE_MATCHED
      ? "healthy"
      : s === LOCATION_STATES.GPS_APPLIED || s === LOCATION_STATES.GOOGLE_UNAVAILABLE
        ? "pending"
        : s === LOCATION_STATES.NOT_CONFIGURED
          ? "neutral"
          : "error",
    s
  );
  statusTargetLocationEl.textContent = state?.config
    ? `${[state.config.locationName, state.config.targetCity].filter(Boolean).join(" / ")} · ${state.config.country} (${state.config.googleDomain})`
    : "Not configured";
  statusConfiguredCoordsEl.textContent = state?.config
    ? `${state.config.latitude}, ${state.config.longitude} (±${state.config.accuracy}m)`
    : "Not configured";
  statusReportedCoordsEl.textContent = state?.reportedGps
    ? `${state.reportedGps.latitude}, ${state.reportedGps.longitude} (±${state.reportedGps.accuracy}m)`
    : "Not tested";
  statusBrowserGpsEl.textContent = state?.browserGpsStatus || LOCATION_STATES.NOT_CONFIGURED;
  statusGoogleDetectedEl.textContent = state?.googleDetectedLocation || "-";
  statusGoogleSourceEl.textContent = state?.googleLocationSource || "-";
  statusGoogleLocationEl.textContent = state?.googleLocationStatus || GOOGLE_LOCATION_STATUSES.UNVERIFIED;
  statusTabIdEl.textContent = state?.tabId !== null && state?.tabId !== undefined ? `Tab #${state.tabId}` : "None";
  statusLastVerifiedEl.textContent = state?.lastVerifiedAt ? new Date(state.lastVerifiedAt).toLocaleString() : "-";
  statusErrorsWarningsEl.textContent = state?.lastError || state?.warningMessage || "None";
  renderSharedContextSummaries();
}

function renderRankingResult(result) {
  if (!result) {
    rankResultPanel.classList.add("hidden");
    setPill(rankStatusPillEl, "neutral", "Ready");
    return;
  }
  rankResultPanel.classList.remove("hidden");
  setPill(
    rankStatusPillEl,
    result.status === RANKING_STATUSES.RANKED ? "healthy" : result.status === RANKING_STATUSES.NOT_FOUND ? "pending" : "error",
    result.status
  );
  setPill(resSourceBadgeEl, result.isLiveVerified ? "healthy" : "pending", result.isLiveVerified ? "Live Verified" : "Manual / Unverified");
  resSourceLabelEl.textContent = result.useManualHtml ? "Manual SERP HTML" : "Visible Chrome Google Tab";
  resStatusEl.textContent = result.status;
  resKeywordEl.textContent = result.keyword;
  resWebsiteEl.textContent = result.websiteDomain;
  resPositionEl.textContent = result.position !== null ? `#${result.position}` : result.status === RANKING_STATUSES.NOT_FOUND ? "Not Found" : "-";
  resUrlEl.textContent = result.rankingUrl || "-";
  resDepthCountEl.textContent = `${result.checkedResults} / ${result.requestedDepth}`;
  resGpsStatusEl.textContent = result.gpsStatus || "-";
  resGoogleStatusEl.textContent = result.googleLocationStatus || "-";
  resGoogleSourceEl.textContent = result.googleLocationSource || "-";
  resCheckedAtEl.textContent = result.checkedAt ? new Date(result.checkedAt).toLocaleString() : "-";
  resDurationEl.textContent = `${result.durationMs} ms`;
  resErrorEl.textContent = result.errorDetails || "None";

  rankResultsTbody.replaceChildren();
  for (const row of result.resultsTable || []) {
    const tr = document.createElement("tr");
    if (row.isTargetMatch) tr.classList.add("target-match-row");
    for (const val of [row.isTargetMatch ? `#${row.position} (Match)` : String(row.position), row.title || "-", row.url]) {
      const td = document.createElement("td");
      td.textContent = val;
      tr.appendChild(td);
    }
    rankResultsTbody.appendChild(tr);
  }
}

function renderBulkJobState(bulkState) {
  latestBulkState = bulkState || { job: null, tasks: [], isBusy: false };
  const { job, tasks } = latestBulkState;
  const state = job?.state || JOB_STATES.READY;
  setPill(
    bulkJobPillEl,
    state === JOB_STATES.COMPLETED ? "healthy" : state === JOB_STATES.SEARCH_BLOCKED || state === JOB_STATES.LOCATION_VERIFICATION_FAILED ? "error" : isActiveJobState(state) || state === JOB_STATES.PAUSED ? "pending" : "neutral",
    state
  );

  const metrics = computeBulkProgressMetrics(job, tasks);
  bulkMTotalEl.textContent = String(metrics.totalKeywords);
  bulkMCompletedEl.textContent = String(metrics.completedKeywords);
  bulkMPendingEl.textContent = String(metrics.pendingKeywords);
  bulkMRankedEl.textContent = String(metrics.rankedKeywords);
  bulkMNaEl.textContent = String(metrics.notFoundKeywords);
  bulkMFailedEl.textContent = String(metrics.failedKeywords);
  bulkMCurrentEl.textContent = metrics.currentKeyword || "-";
  bulkMTimeEl.textContent = `${Math.round((metrics.elapsedMs || 0) / 1000)}s / ${metrics.estimatedRemainingMs ? `${Math.round(metrics.estimatedRemainingMs / 1000)}s` : "-"}`;
  bulkProgressLabelEl.textContent = job?.interruptionReason || job?.lastError || state;
  bulkProgressPctEl.textContent = `${metrics.progressPercentage}%`;
  bulkProgressFillEl.style.width = `${metrics.progressPercentage}%`;

  const running = isActiveJobState(state) || Boolean(latestBulkState.isBusy);
  const hasPending = tasks.some((t) => t.status === TASK_STATUSES.PENDING);
  const hasFailed = tasks.some((t) => isFailedTaskStatus(t.status));
  bulkStartBtn.disabled = running;
  bulkPauseBtn.disabled = !running;
  bulkResumeBtn.disabled = running || !hasPending;
  bulkStopBtn.disabled = !running && state !== JOB_STATES.PAUSED && state !== JOB_STATES.RECOVERY_REQUIRED;
  bulkRetryBtn.disabled = running || !hasFailed;
  bulkExportBtn.disabled = tasks.length === 0;
  bulkClearBtn.disabled = running;

  bulkResultsTbody.replaceChildren();
  const filtered = filterBulkTasks(tasks || [], { searchQuery: bulkSearchInput.value, filterMode: bulkFilterSelect.value });
  for (const t of filtered) {
    const tr = document.createElement("tr");
    const pos = t.status === TASK_STATUSES.RANKED ? `#${t.position}` : t.status === TASK_STATUSES.NOT_FOUND ? "NA" : "-";
    for (const val of [t.rowPosition, t.keyword, pos, t.rankingUrl || "-", t.checkedResults ?? 0, t.googleDetectedLocation || "-", t.locationVerificationStatus || "-", t.status, t.checkedAt ? new Date(t.checkedAt).toLocaleString() : "-", t.errorDetails || "-"]) {
      const td = document.createElement("td");
      td.textContent = String(val);
      tr.appendChild(td);
    }
    bulkResultsTbody.appendChild(tr);
  }
  if (running && !bulkPollTimer) bulkPollTimer = setInterval(refreshBulkStatus, 1000);
  else if (!running && bulkPollTimer) {
    clearInterval(bulkPollTimer);
    bulkPollTimer = null;
  }
}

function syncTopbarClientDropdown(overviews = [], activeClientId = null) {
  topbarClientSelect.replaceChildren(new Option("Select client...", ""));
  for (const ov of overviews) {
    const opt = new Option(`${ov.clientName} (${ov.websiteDomain})`, ov.clientId);
    if (ov.clientId === activeClientId) opt.selected = true;
    topbarClientSelect.appendChild(opt);
  }
}

function applyWorkspaceToSharedInputs(workspace) {
  const client = workspace?.client;
  if (!client) {
    sheetsCtxClientEl.textContent = "No Active Client";
    return;
  }
  rankDomainInput.value = client.websiteDomain || "";
  if (workspace.selectedLocation) {
    const l = workspace.selectedLocation;
    locNameInput.value = l.locationName || "";
    locCityInput.value = l.targetCity || l.locationName || "";
    locLatInput.value = String(l.latitude ?? "");
    locLngInput.value = String(l.longitude ?? "");
    locAccuracyInput.value = String(l.accuracy ?? 20);
    if (l.country) locCountrySelect.value = l.country;
    if (l.language) locLanguageSelect.value = l.language;
    if (l.googleDomain) locGoogleDomainSelect.value = l.googleDomain;
    if (l.searchDepth) rankDepthSelect.value = String(l.searchDepth);
  }
  renderSharedContextSummaries();
  sheetsCtxClientEl.textContent = client.sheetConfig?.spreadsheetId ? `${client.clientName} (${client.sheetConfig.worksheetName || "Tab"})` : client.clientName;
  if (client.sheetConfig?.sheetUrl) sheetsUrlInput.value = client.sheetConfig.sheetUrl;
  if (client.sheetConfig?.spreadsheetId) sheetsIdInput.value = client.sheetConfig.spreadsheetId;

  updClientSelect.replaceChildren(new Option(`${client.clientName} (${client.websiteDomain})`, client.clientId));
  updLocationSelect.replaceChildren();
  for (const l of workspace.locations || []) {
    const opt = new Option(l.locationName, l.locationId);
    if (workspace.selectedLocation?.locationId === l.locationId) opt.selected = true;
    updLocationSelect.appendChild(opt);
  }
  updJobSelect.replaceChildren();
  const jobs = workspace.jobs || [];
  if (jobs.length === 0) updJobSelect.appendChild(new Option("No completed jobs yet", ""));
  else jobs.forEach((j) => updJobSelect.appendChild(new Option(`${j.jobId} · ${j.state}`, j.jobId)));
  if (!updDateInput.value) updDateInput.value = new Date().toISOString().slice(0, 10);
  latestUpdatePreviewState = null;
  latestVerifiedBackup = null;
  updConfirmChk.checked = false;
  updPreviewPanel.classList.add("hidden");
  syncUpdateButtons();
}

function syncUpdateButtons() {
  const hasClient = Boolean(updClientSelect.value);
  const hasSheet = Boolean(clientsPage?.getActiveWorkspace()?.client?.sheetConfig?.spreadsheetId);
  updPreviewBtn.disabled = !hasClient || !updJobSelect.value || !hasSheet;
  updBackupBtn.disabled = !hasClient || !hasSheet;
  updOpenSheetBtn.disabled = !hasSheet;
  updViewBackupBtn.disabled = !latestVerifiedBackup?.backupId;
  updVerifyBtn.disabled = !latestUpdatePreviewState?.planFingerprint;
  updExecuteBtn.disabled = !latestUpdatePreviewState || !latestVerifiedBackup || !updConfirmChk.checked || !writeAccessEnabledState || updModeSelect.value === "dry-run";
}

async function refreshGoogleAuthStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_GET_AUTH_STATUS });
    if (!res?.ok) return;
    writeAccessEnabledState = Boolean(res.writeAccessEnabled);
    setPill(updWriteAccessBadgeEl, writeAccessEnabledState ? "healthy" : "neutral", writeAccessEnabledState ? "Write access enabled" : "Read-only access");
    updEnableWriteBtn.textContent = writeAccessEnabledState ? "Disable Write Access" : "Enable Write Access";
    sheetsOauthStatusEl.textContent = res.oauthConfigured ? "Configured (spreadsheets.readonly)" : "OAuth Client ID not configured";
    sheetsAuthStatusEl.textContent = res.status || "Disconnected";
    sheetsLastConnectedEl.textContent = res.lastConnectedAt ? new Date(res.lastConnectedAt).toLocaleString() : "Never";
    setPill(sheetsAuthPillEl, res.status === "Connected" ? "healthy" : res.oauthConfigured ? "neutral" : "error", res.status);
    syncUpdateButtons();
  } catch {}
}

async function refreshLocationStatus({ populateInputs = false } = {}) {
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.LOCATION_GET_STATUS });
  if (res?.ok) renderLocationState(res.state, { populateInputs });
}
async function refreshRankingState() {
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RANKING_GET_STATE });
  if (res?.ok && res.state) {
    latestRankingState = res.state;
    if (res.state.lastResult) renderRankingResult(res.state.lastResult);
  }
}
async function refreshBulkStatus() {
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BULK_GET_STATUS });
  if (res?.ok) renderBulkJobState(res);
}
async function runHealthCheck() {
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.HEALTH_CHECK });
  if (res?.ok) {
    setPill(pillEl, "healthy", "Healthy");
    messageEl.textContent = "Service worker and local storage passed.";
    workerEl.textContent = "Connected";
    storageEl.textContent = res.storageOk ? "Read/Write OK" : "Failed";
    timestampEl.textContent = new Date(res.checkedAt).toLocaleString();
  }
}

// Accuracy Lab events
function renderBaselineTable() {
  accBaselineTbody.replaceChildren();
  validationState.baselineRows.forEach((row, idx) => {
    const tr = document.createElement("tr");
    const kwTd = document.createElement("td");
    kwTd.textContent = row.keyword;
    const mkIn = (val, ph, onChg) => {
      const i = document.createElement("input");
      i.className = "inline-input";
      i.value = val ?? "";
      i.placeholder = ph;
      i.addEventListener("change", () => onChg(i.value));
      const td = document.createElement("td");
      td.appendChild(i);
      return td;
    };
    tr.append(
      kwTd,
      mkIn(row.manualRanking ?? "", "Rank or NA", async (v) => { validationState.baselineRows[idx].manualRanking = normalizeManualRank(v); await saveValidationState(getDashboardStorage(), validationState); }),
      mkIn(row.manualRankingUrl || "", "https://...", async (v) => { validationState.baselineRows[idx].manualRankingUrl = v.trim(); await saveValidationState(getDashboardStorage(), validationState); }),
      mkIn(row.device || accDeviceSelect.value, "Desktop", async (v) => { validationState.baselineRows[idx].device = v.trim() || "Desktop"; await saveValidationState(getDashboardStorage(), validationState); }),
      mkIn(row.checkedAt || "", "YYYY-MM-DD", async (v) => { validationState.baselineRows[idx].checkedAt = v.trim(); await saveValidationState(getDashboardStorage(), validationState); })
    );
    accBaselineTbody.appendChild(tr);
  });
}

function renderComparisonReport(report) {
  if (!report) {
    accReportPanel.classList.add("hidden");
    return;
  }
  accReportPanel.classList.remove("hidden");
  const m = report.metrics;
  metTotalEl.textContent = String(m.totalKeywordsTested);
  metComparableEl.textContent = `${m.comparableKeywords} (${m.coveragePercentage ?? 0}%)`;
  metExactPctEl.textContent = `${m.exactMatchPercentage}%`;
  metTolPctEl.textContent = `${m.withinTolerancePercentage}%`;
  metUrlPctEl.textContent = `${m.urlMatchPercentage}%`;
  metAvgDiffEl.textContent = m.averageAbsoluteDifference ?? "-";
  metLocMismatchEl.textContent = String(m.locationMismatchCount);
  metBlockedEl.textContent = String(m.blockedSearchCount);
  metIncompleteEl.textContent = String(m.incompleteSearchCount);
  setPill(accStatusPillEl, m.withinTolerancePercentage >= 90 ? "healthy" : "pending", `${m.withinTolerancePercentage}% Within ±${m.tolerance}`);
  accComparisonTbody.replaceChildren();
  for (const r of report.rows) {
    const tr = document.createElement("tr");
    for (const v of [r.keyword, r.manualRanking, r.extensionRanking, r.rankingDifference ?? "-", r.manualRankingUrl || "-", r.extensionRankingUrl || "-", r.urlMatchStatus, r.browserGpsStatus, r.googleLocationStatus, r.googleLocationSource, r.comparisonStatus]) {
      const td = document.createElement("td");
      td.textContent = String(v);
      tr.appendChild(td);
    }
    accComparisonTbody.appendChild(tr);
  }
}

// Event Listeners
async function sendLocationAction(type, payload) {
  setBanner(locFeedbackEl, null, "");
  const res = await chrome.runtime.sendMessage({ type, payload });
  if (res?.state) renderLocationState(res.state);
  setBanner(locFeedbackEl, res?.ok ? "success" : "error", res?.errors?.join(" ") || res?.error || (res?.ok ? "Location action succeeded." : "Verification incomplete."));
}
locationForm.addEventListener("submit", (e) => { e.preventDefault(); sendLocationAction(MESSAGE_TYPES.LOCATION_APPLY, { locationName: locNameInput.value, targetCity: locCityInput.value, latitude: locLatInput.value, longitude: locLngInput.value, accuracy: locAccuracyInput.value, country: locCountrySelect.value, language: locLanguageSelect.value, googleDomain: locGoogleDomainSelect.value, testPageUrl: locTestUrlInput.value }); });
testLocationBtn.addEventListener("click", () => sendLocationAction(MESSAGE_TYPES.LOCATION_TEST));
openTestTabBtn.addEventListener("click", () => sendLocationAction(MESSAGE_TYPES.LOCATION_OPEN_TEST_TAB, { testPageUrl: locTestUrlInput.value }));
resetLocationBtn.addEventListener("click", () => sendLocationAction(MESSAGE_TYPES.LOCATION_RESET));
applyGoogleBtn.addEventListener("click", () => sendLocationAction(MESSAGE_TYPES.GOOGLE_LOCATION_APPLY, { locationName: locNameInput.value, targetCity: locCityInput.value, latitude: locLatInput.value, longitude: locLngInput.value, accuracy: locAccuracyInput.value, country: locCountrySelect.value, language: locLanguageSelect.value, googleDomain: locGoogleDomainSelect.value }));
verifyGoogleBtn.addEventListener("click", () => sendLocationAction(MESSAGE_TYPES.GOOGLE_LOCATION_VERIFY, { clickUpdateLocation: chkUpdateLocation.checked }));
openGoogleBtn.addEventListener("click", () => sendLocationAction(MESSAGE_TYPES.GOOGLE_LOCATION_OPEN_SEARCH, { locationName: locNameInput.value, targetCity: locCityInput.value, latitude: locLatInput.value, longitude: locLngInput.value, country: locCountrySelect.value, language: locLanguageSelect.value, googleDomain: locGoogleDomainSelect.value }));
locLatInput.addEventListener("input", () => { const p = parseCoordinatePair(locLatInput.value); if (p.valid) { locLatInput.value = String(p.latitude); locLngInput.value = String(p.longitude); } });
locCountrySelect.addEventListener("change", () => { const p = getCountryPreset(locCountrySelect.value); locGoogleDomainSelect.value = p.googleDomain; locLanguageSelect.value = p.defaultLanguage; renderSharedContextSummaries(); });

rankingForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const isManual = rankUseManualHtmlChk.checked;
  if (!isManual && !rankAuthorizedChk?.checked) {
    return setBanner(rankFeedbackEl, "error", "Confirm authorized search access before running a live ranking check.");
  }
  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.RANKING_CHECK,
    payload: {
      websiteDomain: rankDomainInput.value,
      keyword: rankKeywordInput.value,
      searchDepth: Number(rankDepthSelect.value),
      useManualHtml: isManual,
      manualSerpHtml: rankManualHtmlInput.value,
      deviceType: accDeviceSelect.value,
      isAuthorized: Boolean(rankAuthorizedChk?.checked),
    },
  });
  if (res?.result) renderRankingResult(res.result);
  else if (res?.error) setBanner(rankFeedbackEl, "error", res.error);
});
stopRankingBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RANKING_STOP }));
clearRankingBtn.addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RANKING_CLEAR }); renderRankingResult(null); });
rankUseManualHtmlChk.addEventListener("change", () => rankManualPanel.classList.toggle("hidden", !rankUseManualHtmlChk.checked));
rankManualFileInput.addEventListener("change", async () => { const f = rankManualFileInput.files?.[0]; if (f) rankManualHtmlInput.value = await f.text(); });

let loadedBulkSourceKeywords = [];
function updateBulkSelectionUi(entries) {
  parsedBulkQueueInput = Array.isArray(entries) && entries.length > 0 ? entries : null;
  const list = entries || [];
  bulkKeywordsInput.value = list.map((k) => k.keyword).join("\n");
  if (bulkSelectedCountEl) bulkSelectedCountEl.textContent = String(list.length);
}
function populateBulkGroupOptions(entries = []) {
  if (!bulkGroupFilterSelect) return;
  const groups = [...new Set(entries.map((e) => e.keywordGroup).filter(Boolean))];
  bulkGroupFilterSelect.replaceChildren(new Option("All Keyword Groups", ""));
  for (const g of groups) bulkGroupFilterSelect.appendChild(new Option(g, g));
}
function applyBulkSubsetFilter(limit = null) {
  const q = (bulkKwSearchInput?.value || "").trim().toLowerCase();
  const grp = bulkGroupFilterSelect?.value || "";
  const base = loadedBulkSourceKeywords.length > 0 ? loadedBulkSourceKeywords : parseKeywordTextInput(bulkKeywordsInput.value);
  let filtered = base.filter((k) => {
    if (q && !String(k.keyword || "").toLowerCase().includes(q)) return false;
    if (grp && k.keywordGroup !== grp) return false;
    return true;
  });
  if (typeof limit === "number" && limit > 0) filtered = filtered.slice(0, limit);
  updateBulkSelectionUi(filtered);
}

bulkCsvFileInput.addEventListener("change", async () => { const f = bulkCsvFileInput.files?.[0]; if (!f) return; loadedBulkSourceKeywords = parseKeywordCsvInput(await f.text()); populateBulkGroupOptions(loadedBulkSourceKeywords); updateBulkSelectionUi(loadedBulkSourceKeywords); });
bulkTxtFileInput.addEventListener("change", async () => { const f = bulkTxtFileInput.files?.[0]; if (!f) return; loadedBulkSourceKeywords = parseKeywordTextInput(await f.text()); populateBulkGroupOptions(loadedBulkSourceKeywords); updateBulkSelectionUi(loadedBulkSourceKeywords); });
bulkImportLabBtn.addEventListener("click", () => { loadedBulkSourceKeywords = importKeywordsFromBaselineRows(validationState.baselineRows); populateBulkGroupOptions(loadedBulkSourceKeywords); updateBulkSelectionUi(loadedBulkSourceKeywords); });
bulkImportSheetsBtn.addEventListener("click", () => {
  const ws = clientsPage.getActiveWorkspace();
  const kws = (ws?.keywords || []).filter((k) => k.source === "google_sheets" && k.active !== false && !k.excluded);
  if (kws.length === 0) return setBanner(bulkFeedbackEl, "error", "Import Google Sheets keywords for this client first.");
  loadedBulkSourceKeywords = kws;
  populateBulkGroupOptions(loadedBulkSourceKeywords);
  updateBulkSelectionUi(kws);
});
bulkFirst3Btn?.addEventListener("click", () => applyBulkSubsetFilter(3));
bulkFirst5Btn?.addEventListener("click", () => applyBulkSubsetFilter(5));
bulkFirst10Btn?.addEventListener("click", () => applyBulkSubsetFilter(10));
bulkSelectAllBtn?.addEventListener("click", () => applyBulkSubsetFilter(null));
bulkDeselectAllBtn?.addEventListener("click", () => updateBulkSelectionUi([]));
bulkKwSearchInput?.addEventListener("input", () => applyBulkSubsetFilter(null));
bulkGroupFilterSelect?.addEventListener("change", () => applyBulkSubsetFilter(null));
bulkKeywordsInput.addEventListener("input", () => {
  parsedBulkQueueInput = null;
  if (bulkSelectedCountEl) bulkSelectedCountEl.textContent = String(parseKeywordTextInput(bulkKeywordsInput.value).length);
});
bulkStartBtn.addEventListener("click", async () => {
  if (!bulkAuthorizedChk?.checked) {
    return setBanner(bulkFeedbackEl, "error", "Confirm authorized search access before starting a bulk ranking check.");
  }
  const entries = parsedBulkQueueInput || parseKeywordTextInput(bulkKeywordsInput.value);
  if (entries.length === 0) return setBanner(bulkFeedbackEl, "error", "Enter at least one keyword.");
  const ws = clientsPage.getActiveWorkspace();
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BULK_START, payload: { clientId: ws?.client?.clientId || null, locationId: ws?.selectedLocation?.locationId || null, websiteDomain: rankDomainInput.value, keywords: entries, searchDepth: Number(rankDepthSelect.value), deviceType: bulkDeviceSelect.value, isAuthorized: Boolean(bulkAuthorizedChk.checked) } });
  if (res?.job) renderBulkJobState({ job: res.job, tasks: res.tasks || [], isBusy: false });
  if (!res?.ok) setBanner(bulkFeedbackEl, "error", res?.error || "Bulk check stopped.");
  await clientsPage.refreshOverviews({ preserveWorkspace: true });
  await jobsHistoryPage.refresh();
});
bulkPauseBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BULK_PAUSE }));
bulkResumeBtn.addEventListener("click", async () => { const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BULK_RESUME }); if (res?.job) renderBulkJobState({ job: res.job, tasks: res.tasks || [], isBusy: false }); });
bulkStopBtn.addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BULK_STOP }); refreshBulkStatus(); });
bulkRetryBtn.addEventListener("click", async () => { const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BULK_RETRY_FAILED }); if (res?.job) renderBulkJobState({ job: res.job, tasks: res.tasks || [], isBusy: false }); });
bulkExportBtn.addEventListener("click", () => { if (latestBulkState.tasks?.length) downloadTextFile("bulk-keyword-rankings.csv", exportBulkResultsCsv(latestBulkState.job, latestBulkState.tasks), "text/csv;charset=utf-8"); });
bulkClearBtn.addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BULK_CLEAR }); renderBulkJobState({ job: null, tasks: [], isBusy: false }); });

// Google Sheets Events
sheetsConnectBtn.addEventListener("click", async () => { const r = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_CONNECT }); await refreshGoogleAuthStatus(); setBanner(sheetsFeedbackEl, r.ok ? "success" : "error", r.ok ? "Connected." : r.error); });
sheetsDisconnectBtn.addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_DISCONNECT }); await refreshGoogleAuthStatus(); });
sheetsTestBtn.addEventListener("click", async () => { const r = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_TEST_CONNECTION, payload: { spreadsheetId: sheetsIdInput.value.trim() } }); setBanner(sheetsFeedbackEl, r.ok ? "success" : "error", r.spreadsheetTitle ? `Verified '${r.spreadsheetTitle}'` : r.message || r.error); });
sheetsUrlInput.addEventListener("input", () => { const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(sheetsUrlInput.value.trim()); if (m) sheetsIdInput.value = m[1]; });
sheetsLoadWsBtn.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_LIST_WORKSHEETS, payload: { sheetUrlOrId: sheetsUrlInput.value.trim() || sheetsIdInput.value.trim() } });
  if (!res?.ok) return setBanner(sheetsFeedbackEl, "error", res?.error || "Load failed.");
  sheetsIdInput.value = res.spreadsheetId;
  sheetsWsSelect.replaceChildren();
  (res.worksheets || []).forEach((ws) => sheetsWsSelect.appendChild(new Option(`${ws.title} (gid=${ws.sheetId})`, ws.sheetId)));
});
async function runSheetPreviewRead() {
  const ws = clientsPage.getActiveWorkspace();
  if (!ws?.client) return setBanner(sheetsFeedbackEl, "error", "Select a client first.");
  const selOpt = sheetsWsSelect.options[sheetsWsSelect.selectedIndex];
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_PREVIEW_AND_READ, payload: { clientId: ws.client.clientId, locationId: ws.selectedLocation?.locationId || null, sheetUrlOrId: sheetsUrlInput.value.trim() || sheetsIdInput.value.trim(), worksheetId: sheetsWsSelect.value || ws.client.sheetConfig?.worksheetId || "", worksheetName: selOpt?.value ? selOpt.textContent.replace(/\s*\(gid=.*\)$/, "") : ws.client.sheetConfig?.worksheetName || "", excludedRowNumbers: [...excludedSheetRows] } });
  if (!res?.ok) return setBanner(sheetsFeedbackEl, "error", res?.error || "Read failed.");
  latestSheetReadResult = res;
  sheetsPreviewPanel.classList.remove("hidden");
  const p = res.preview;
  sheetsPreviewHeadingEl.textContent = `${p.spreadsheetTitle || p.spreadsheetId} — ${p.worksheetName}`;
  shMTotalEl.textContent = String(p.totalKeywordRows);
  shMGroupsEl.textContent = p.detectedGroups.join(", ") || "None";
  shMHeadersEl.textContent = p.headerRows.join(", ") || "None";
  shMSeparatorsEl.textContent = p.separatorRows.join(", ") || "None";
  shMLatestDateEl.textContent = p.latestRankingDate || "-";
  shMHistoryColsEl.textContent = String((p.historicalColumns || []).length);
  shMMetaEl.textContent = `${p.formulaCellCount} / ${p.mergedRangeCount}`;
  shMWarningsEl.textContent = `${p.skippedRows.length} / ${p.warnings.length}`;
  sheetsAmbiguousConfirmRow.classList.toggle("hidden", !p.isAmbiguous);
  sheetsAmbiguousConfirmChk.checked = !p.isAmbiguous;
  sheetsPreviewTbody.replaceChildren();
  for (const r of p.previewRows || []) {
    const tr = document.createElement("tr");
    const tdC = document.createElement("td");
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = Boolean(r.excluded);
    c.addEventListener("change", () => (c.checked ? excludedSheetRows.add(r.rowNumber) : excludedSheetRows.delete(r.rowNumber)));
    tdC.appendChild(c);
    tr.appendChild(tdC);
    for (const v of [String(r.rowNumber), r.keyword, r.searchVolume || "-", r.competition || "-", r.landingPage || "-", r.serpUrl || "-", r.latestRank || "-", r.keywordGroup || "-"]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    }
    sheetsPreviewTbody.appendChild(tr);
  }
  sheetsConfirmImportBtn.disabled = (p.previewRows || []).length === 0;
}
sheetsPreviewBtn.addEventListener("click", runSheetPreviewRead);
sheetsRefreshBtn.addEventListener("click", runSheetPreviewRead);
sheetsConfirmImportBtn.addEventListener("click", async () => {
  const ws = clientsPage.getActiveWorkspace();
  if (!latestSheetReadResult || !ws?.client) return;
  const kws = (latestSheetReadResult.importedKeywords || []).map((k) => ({ ...k, excluded: excludedSheetRows.has(k.rowNumber), active: !excludedSheetRows.has(k.rowNumber) }));
  const r = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_APPLY_CONFIRMED_SYNC, payload: { clientId: ws.client.clientId, incomingKeywords: kws, snapshot: latestSheetReadResult.snapshot, confirmed: true } });
  if (r?.ok) {
    await clientsPage.refreshWorkspace(ws.client.clientId);
    setBanner(sheetsFeedbackEl, "success", `Saved ${r.savedCount} keyword(s) locally.`);
  }
});

// Phase 9 Update Events
updEnableWriteBtn.addEventListener("click", async () => {
  if (writeAccessEnabledState) {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_DISABLE_WRITE });
  } else {
    if (!window.confirm("Enable Google Sheets write scope (https://www.googleapis.com/auth/spreadsheets)?")) return;
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_ENABLE_WRITE, payload: { userConfirmed: true } });
  }
  await refreshGoogleAuthStatus();
});
updModeSelect.addEventListener("change", syncUpdateButtons);
updConfirmChk.addEventListener("change", syncUpdateButtons);
  updBackupBtn.addEventListener("click", async () => {
    const c = clientsPage.getActiveWorkspace()?.client;
    if (!c?.sheetConfig?.spreadsheetId) return;
    if (!latestUpdatePreviewState?.planFingerprint) {
      return setBanner(updFeedbackEl, "error", "Generate the Google Sheet preview first so the recoverable backup binds to the approved write plan.");
    }
    const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_BACKUP_CREATE, payload: { clientId: c.clientId, spreadsheetId: c.sheetConfig.spreadsheetId, worksheetId: c.sheetConfig.worksheetId, worksheetName: c.sheetConfig.worksheetName, jobId: updJobSelect.value || null, approvedPlanFingerprint: latestUpdatePreviewState.planFingerprint, preWriteSnapshotFingerprint: latestUpdatePreviewState.preWriteSnapshotFingerprint || null } });
    if (res?.ok) { latestVerifiedBackup = res.backup; setPill(updStatusPillEl, "healthy", "Backup verified"); updMBackupEl.textContent = `Verified (${res.backup.backupId})`; syncUpdateButtons(); }
    else setBanner(updFeedbackEl, "error", res?.error || "Backup failed.");
  });
  updPreviewBtn.addEventListener("click", async () => {
    const c = clientsPage.getActiveWorkspace()?.client;
    if (!c || !updJobSelect.value) return;
    const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_UPDATE_PREVIEW, payload: { clientId: c.clientId, locationId: updLocationSelect.value || null, jobId: updJobSelect.value, reportingDate: updDateInput.value, backupId: latestVerifiedBackup?.backupId || null } });
    if (!res?.ok) return setBanner(updFeedbackEl, "error", res?.errors?.join(" ") || res?.error || "Preview failed.");
    latestUpdatePreviewState = {
      ...res.preview,
      preWriteSnapshotFingerprint: res.snapshot?.structureFingerprint || null,
    };
  updPreviewPanel.classList.remove("hidden");
  updMTargetEl.textContent = `${res.preview.spreadsheetTitle} / ${res.preview.worksheetName}`;
  updMDatePlanEl.textContent = `${res.preview.willInsertColumn ? "Insert" : "Reuse"} Col ${res.preview.targetColumnLetter}: '${res.preview.reportingDate}'`;
  updMCountsEl.textContent = `${res.preview.validRankingUpdates} / ${res.preview.confirmedNaUpdates} / ${res.preview.skippedOrFailedCount}`;
  updMSerpHdrEl.textContent = `${res.preview.serpUrlsToUpdate} / ${res.preview.dateHeadersToUpdate}`;
  updMBackupEl.textContent = res.preview.backupStatus;
  updMStructureEl.textContent = res.preview.structureStatus;
  updPreviewTbody.replaceChildren();
  for (const r of res.preview.beforeAfterRows || []) {
    const tr = document.createElement("tr");
    for (const v of [String(r.rowNumber), r.keyword, r.previousRank, r.newRank, r.previousSerpUrl, r.newSerpUrl, r.updateStatus]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    }
    updPreviewTbody.appendChild(tr);
  }
  setPill(updStatusPillEl, "pending", res.preview.backupVerified ? "Awaiting confirmation" : "Backup required");
  syncUpdateButtons();
});
updExecuteBtn.addEventListener("click", async () => {
  const c = clientsPage.getActiveWorkspace()?.client;
  if (!c || !latestUpdatePreviewState || !latestVerifiedBackup) return;
  const mode = updModeSelect.value;
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_UPDATE_EXECUTE, payload: { clientId: c.clientId, locationId: updLocationSelect.value || null, jobId: updJobSelect.value, approvedPreview: latestUpdatePreviewState, approvalConfirmation: updConfirmChk.checked, backupId: latestVerifiedBackup.backupId, reportingDate: updDateInput.value, mode, dryRun: mode === "dry-run" } });
  setPill(updStatusPillEl, res?.ok ? "healthy" : "error", res?.operationStatus || "Update failed");
  setBanner(updFeedbackEl, res?.ok ? "success" : "error", res?.ok ? `Updated & verified (${res.operationId}).` : res?.error || "Update failed.");
});
updVerifyBtn.addEventListener("click", () => updPreviewBtn.click());
updOpenSheetBtn.addEventListener("click", () => { const u = clientsPage.getActiveWorkspace()?.client?.sheetConfig?.sheetUrl; if (u) window.open(u, "_blank", "noopener"); });
updViewBackupBtn.addEventListener("click", () => { if (latestVerifiedBackup) downloadTextFile(`${latestVerifiedBackup.backupId}.json`, JSON.stringify(latestVerifiedBackup, null, 2), "application/json"); });
updHistoryBtn.addEventListener("click", async () => {
  const c = clientsPage.getActiveWorkspace()?.client;
  if (!c) return;
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_UPDATE_JOURNAL_LIST, payload: { clientId: c.clientId } });
  updJournalPanel.classList.remove("hidden");
  updJournalTbody.replaceChildren();
  for (const op of res?.journal || []) {
    const tr = document.createElement("tr");
    for (const v of [op.operationId, op.targetDate || "-", op.worksheetName || op.worksheetId, op.mode || "dry-run", op.status, op.backupId || "-"]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    }
    updJournalTbody.appendChild(tr);
  }
});

// Accuracy Lab quick buttons
accCsvFileInput.addEventListener("change", async () => { const f = accCsvFileInput.files?.[0]; if (!f) return; const p = parseBaselineCsv(await f.text()); if (p.ok) { validationState.baselineRows = p.rows; accKeywordsInput.value = p.rows.map((r) => r.keyword).join("\n"); await saveValidationState(getDashboardStorage(), validationState); renderBaselineTable(); } });
accSyncKeywordsBtn.addEventListener("click", async () => { const kws = accKeywordsInput.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); validationState.baselineRows = kws.map((k, i) => ({ rowIndex: i, keyword: k, manualRanking: null, manualRankingUrl: "", device: accDeviceSelect.value, checkedAt: "" })); await saveValidationState(getDashboardStorage(), validationState); renderBaselineTable(); });
accCompareBtn.addEventListener("click", async () => { const kws = accKeywordsInput.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); validationState.comparisonReport = compareRankingWithBaseline({ keywords: kws, extensionResults: latestRankingState?.recentResults || [], baselineRows: validationState.baselineRows, tolerance: Number(accToleranceSelect.value), settings: { websiteDomain: rankDomainInput.value.trim(), searchDepth: Number(rankDepthSelect.value), deviceType: accDeviceSelect.value } }); await saveValidationState(getDashboardStorage(), validationState); renderComparisonReport(validationState.comparisonReport); });
accExportCsvBtn.addEventListener("click", () => { if (validationState.comparisonReport) downloadTextFile("ranking-accuracy-comparison.csv", exportComparisonCsv(validationState.comparisonReport), "text/csv;charset=utf-8"); });
accExportJsonBtn.addEventListener("click", () => { if (validationState.comparisonReport) downloadTextFile("ranking-accuracy-comparison.json", exportComparisonJson(validationState.comparisonReport), "application/json"); });
accClearBtn.addEventListener("click", async () => { validationState = await clearValidationState(getDashboardStorage()); accKeywordsInput.value = ""; renderBaselineTable(); renderComparisonReport(null); });
runHealthBtn.addEventListener("click", runHealthCheck);

document.addEventListener("DOMContentLoaded", async () => {
  versionEl.textContent = chrome.runtime.getManifest().version || "0.1.0";

  clientsPage = createClientsPage({
    getLocationDefaults: () => ({ accuracy: Number(locAccuracyInput.value) || 20, country: locCountrySelect.value, language: locLanguageSelect.value, googleDomain: locGoogleDomainSelect.value }),
    getRankingDefaults: () => ({ deviceType: bulkDeviceSelect.value, searchDepth: Number(rankDepthSelect.value) || 50 }),
    onClientSelected: (ws) => applyWorkspaceToSharedInputs(ws),
    onOverviewsUpdated: (ovs, activeId) => syncTopbarClientDropdown(ovs, activeId),
    onStartCheckFlow: (ws) => {
      if ((ws?.keywords || []).length > 0) clientsPage.clientLoadBulkBtn.click();
      navCtrl.navigateTo("jobs");
    },
    onNavigate: (pageId) => navCtrl.navigateTo(pageId),
    onViewClientHistory: (clientId) => {
      navCtrl.navigateTo("ranking-history");
      rankingHistoryPage.loadHistory({ preselectClientId: clientId });
    },
  });

  overviewPage = createOverviewPage({
    onNavigate: (pageId) => navCtrl.navigateTo(pageId),
    onOpenRankingWorkflow: () => navCtrl.navigateTo("jobs"),
  });
  keywordRankingsPage = createKeywordRankingsPage({
    onInspectHistoryKeyword: (row) => {
      navCtrl.navigateTo("ranking-history");
      rankingHistoryPage.loadHistory({ preselectClientId: row.clientId, preselectKeyword: row.keywordText });
    },
  });
  rankingHistoryPage = createRankingHistoryPage();
  reportsPage = createReportsPage({ getAccuracyComparisons: () => validationState.comparisonReport?.rows || [] });
  activityLogsPage = createActivityLogsPage();
  settingsPage = createSettingsPage();
  scheduledChecksPage = createScheduledChecksPage({
    onOpenSheetsForClient: async (clientId) => {
      await clientsPage.selectClient(clientId);
      syncTopbarClientDropdown(clientsPage.getOverviews(), clientId);
      navCtrl.navigateTo("google-sheets");
      await refreshGoogleAuthStatus();
    },
  });
  jobsHistoryPage = createJobsHistoryPage({ onResumeBulk: () => bulkResumeBtn.click() });

  navCtrl = initSidebarNavigation({
    sidebarEl: document.getElementById("app-sidebar"),
    toggleBtn: document.getElementById("btn-sidebar-toggle"),
    navButtons: document.querySelectorAll("#sidebar-nav [data-nav]"),
    pages: document.querySelectorAll(".pages-host > .page-view"),
    onNavigate: async (pageId) => {
      const ovs = clientsPage.getOverviews();
      if (pageId === "overview") await overviewPage.refresh();
      else if (pageId === "clients") await clientsPage.refreshOverviews({ preserveWorkspace: true });
      else if (pageId === "keyword-rankings") await keywordRankingsPage.refresh({ clients: ovs });
      else if (pageId === "ranking-history") { await rankingHistoryPage.refreshClientsDropdown(ovs); await rankingHistoryPage.loadHistory(); }
      else if (pageId === "jobs") { await jobsHistoryPage.refresh(); await refreshBulkStatus(); }
      else if (pageId === "reports") reportsPage.refreshClients(ovs);
      else if (pageId === "activity-logs") await activityLogsPage.refresh(ovs);
      else if (pageId === "settings") { await settingsPage.refresh(); await runHealthCheck(); }
      else if (pageId === "scheduled-checks") await scheduledChecksPage.refresh(ovs);
      else if (pageId === "google-sheets") await refreshGoogleAuthStatus();
    },
  });

  topbarClientSelect.addEventListener("change", async () => {
    if (!topbarClientSelect.value) return;
    await clientsPage.selectClient(topbarClientSelect.value);
    syncTopbarClientDropdown(clientsPage.getOverviews(), topbarClientSelect.value);
  });

  const ovRes = await clientsPage.refreshOverviews({ preserveWorkspace: true });
  syncTopbarClientDropdown(ovRes?.overviews || [], ovRes?.active?.clientId || null);
  validationState = await loadValidationState(getDashboardStorage());
  renderBaselineTable();
  renderComparisonReport(validationState.comparisonReport);

  await Promise.all([
    overviewPage.refresh(),
    scheduledChecksPage.refresh(ovRes?.overviews || []),
    refreshGoogleAuthStatus(),
    refreshLocationStatus({ populateInputs: true }),
    refreshRankingState(),
    refreshBulkStatus(),
    runHealthCheck(),
  ]);
});
