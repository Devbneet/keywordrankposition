import {
  importKeywordsFromBaselineRows,
  parseKeywordCsvInput,
  parseKeywordTextInput,
} from "../modules/jobs/keyword-queue.js";
import { isActiveJobState, isFailedTaskStatus, JOB_STATES, TASK_STATUSES } from "../modules/jobs/job-state.js";
import {
  getCountryPreset,
  parseCoordinatePair,
} from "../modules/location/coordinate-validator.js";
import {
  GOOGLE_LOCATION_STATUSES,
  LOCATION_STATES,
} from "../modules/location/location-state.js";
import {
  computeBulkProgressMetrics,
  exportBulkResultsCsv,
  filterBulkTasks,
} from "../modules/ranking/bulk-results.js";
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
import {
  exportComparisonCsv,
  exportComparisonJson,
} from "../modules/validation/comparison-exporter.js";
import { MESSAGE_TYPES } from "../utils/messages.js";

const versionEl = document.getElementById("dash-version");
const pillEl = document.getElementById("dash-health-pill");
const messageEl = document.getElementById("dash-health-message");
const workerEl = document.getElementById("detail-worker");
const storageEl = document.getElementById("detail-storage");
const timestampEl = document.getElementById("detail-timestamp");
const runHealthBtn = document.getElementById("dash-run-health-btn");

// Shared location form controls
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

// Location buttons
const applyLocationBtn = document.getElementById("btn-apply-location");
const testLocationBtn = document.getElementById("btn-test-location");
const openTestTabBtn = document.getElementById("btn-open-test-tab");
const resetLocationBtn = document.getElementById("btn-reset-location");
const applyGoogleBtn = document.getElementById("btn-apply-google-location");
const verifyGoogleBtn = document.getElementById("btn-verify-google-location");
const openGoogleBtn = document.getElementById("btn-open-google-search");

// Location Verification Dashboard elements
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

// Single Keyword Ranking controls (Phase 4)
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

// Ranking Accuracy Lab controls (Phase 5)
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

// Bulk Keyword Checker controls (Phase 6)
const bulkJobPillEl = document.getElementById("bulk-job-pill");
const bulkCtxDomainEl = document.getElementById("bulk-ctx-domain");
const bulkCtxLocationEl = document.getElementById("bulk-ctx-location");
const bulkCtxLocaleEl = document.getElementById("bulk-ctx-locale");
const bulkCtxModeEl = document.getElementById("bulk-ctx-mode");
const bulkDeviceSelect = document.getElementById("bulk-device");
const bulkCsvFileInput = document.getElementById("bulk-csv-file");
const bulkTxtFileInput = document.getElementById("bulk-txt-file");
const bulkImportLabBtn = document.getElementById("btn-bulk-import-lab");
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

let latestLocationState = null;
let latestRankingState = null;
let latestBulkState = { job: null, tasks: [], isBusy: false };
let bulkPollTimer = null;
let parsedBulkQueueInput = null;
let activeClientWorkspace = null;
let clientOverviewsCache = [];

// Clients UI controls (Phase 7)
const activeClientPillEl = document.getElementById("active-client-pill");
const clientSearchInput = document.getElementById("client-search-input");
const clientShowArchivedChk = document.getElementById("client-show-archived");
const clientNewBtn = document.getElementById("btn-client-new");
const clientImportFileInput = document.getElementById("client-import-file");
const clientExportBtn = document.getElementById("btn-client-export");
const clientFeedbackEl = document.getElementById("client-feedback");
const clientCardsGridEl = document.getElementById("client-cards-grid");

const clientEditorPanel = document.getElementById("client-editor-panel");
const clientEditorTitleEl = document.getElementById("client-editor-title");
const clientEditorForm = document.getElementById("client-editor-form");
const cliIdInput = document.getElementById("cli-id");
const cliNameInput = document.getElementById("cli-name");
const cliDomainInput = document.getElementById("cli-domain");
const cliStatusSelect = document.getElementById("cli-status");
const cliUrlInput = document.getElementById("cli-url");
const cliNotesInput = document.getElementById("cli-notes");
const cliSheetUrlInput = document.getElementById("cli-sheet-url");
const cliSheetIdInput = document.getElementById("cli-sheet-id");
const cliWsNameInput = document.getElementById("cli-ws-name");
const cliWsIdInput = document.getElementById("cli-ws-id");
const cliColKwInput = document.getElementById("cli-col-kw");
const cliColVolInput = document.getElementById("cli-col-vol");
const cliColCompInput = document.getElementById("cli-col-comp");
const cliColLpInput = document.getElementById("cli-col-lp");
const cliColSerpInput = document.getElementById("cli-col-serp");
const cliColDateInput = document.getElementById("cli-col-date");
const clientCancelBtn = document.getElementById("btn-client-cancel");

const activeClientWorkspaceEl = document.getElementById("active-client-workspace");
const wsClientHeadingEl = document.getElementById("ws-client-heading");
const clientBackupBtn = document.getElementById("btn-client-backup");
const clientLoadBulkBtn = document.getElementById("btn-client-load-bulk");
const cliLocationsListEl = document.getElementById("cli-locations-list");
const cliLocNameInput = document.getElementById("cli-loc-name");
const cliLocCoordsInput = document.getElementById("cli-loc-coords");
const cliLocStateInput = document.getElementById("cli-loc-state");
const cliLocWsInput = document.getElementById("cli-loc-ws");
const cliLocColInput = document.getElementById("cli-loc-col");
const cliAddLocBtn = document.getElementById("btn-cli-add-loc");
const cliKwCountEl = document.getElementById("cli-kw-count");
const cliKwPasteInput = document.getElementById("cli-kw-paste");
const cliAddKwsBtn = document.getElementById("btn-cli-add-kws");
const cliKwCsvFileInput = document.getElementById("cli-kw-csv-file");
const cliKeywordsListEl = document.getElementById("cli-keywords-list");
const cliHistoryTbody = document.getElementById("cli-history-tbody");

// Google Sheets Integration controls (Phase 8 — Read-Only)
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
const bulkImportSheetsBtn = document.getElementById("btn-bulk-import-sheets");

let latestSheetReadResult = null;
let excludedSheetRows = new Set();
let validationState = {
  tolerance: 1,
  deviceType: "Desktop",
  baselineRows: [],
  comparisonReport: null,
};

function getDashboardStorage() {
  return createStorageClient(chrome.storage.local);
}

function setHealthBadge(state, text) {
  pillEl.className = "pill";
  if (state === "healthy") {
    pillEl.classList.add("pill-healthy");
    pillEl.textContent = "Healthy";
  } else if (state === "error") {
    pillEl.classList.add("pill-error");
    pillEl.textContent = "Error";
  } else {
    pillEl.classList.add("pill-pending");
    pillEl.textContent = "Checking...";
  }
  messageEl.textContent = text;
}

function showBanner(el, kind, message) {
  if (!message) {
    el.className = "feedback-banner hidden";
    el.textContent = "";
    return;
  }
  el.className = `feedback-banner ${kind}`;
  el.textContent = message;
}

function applyStatePillStyle(state) {
  locStatePillEl.className = "pill";
  locStatePillEl.textContent = state || LOCATION_STATES.NOT_CONFIGURED;

  if (state === LOCATION_STATES.GPS_VERIFIED || state === LOCATION_STATES.GOOGLE_MATCHED) {
    locStatePillEl.classList.add("pill-healthy");
  } else if (
    state === LOCATION_STATES.PERMISSION_DENIED ||
    state === LOCATION_STATES.LOCATION_MISMATCH ||
    state === LOCATION_STATES.GOOGLE_MISMATCH ||
    state === LOCATION_STATES.SEARCH_BLOCKED ||
    state === LOCATION_STATES.VERIFICATION_FAILED
  ) {
    locStatePillEl.classList.add("pill-error");
  } else if (
    state === LOCATION_STATES.GPS_APPLIED ||
    state === LOCATION_STATES.GOOGLE_UNAVAILABLE ||
    state === LOCATION_STATES.DEBUGGER_DISCONNECTED
  ) {
    locStatePillEl.classList.add("pill-pending");
  } else {
    locStatePillEl.classList.add("pill-neutral");
  }
}

function getLocationPayload() {
  return {
    locationName: locNameInput.value,
    targetCity: locCityInput.value,
    latitude: locLatInput.value,
    longitude: locLngInput.value,
    accuracy: locAccuracyInput.value,
    country: locCountrySelect.value,
    language: locLanguageSelect.value,
    googleDomain: locGoogleDomainSelect.value,
    testPageUrl: locTestUrlInput.value,
    clickUpdateLocation: Boolean(chkUpdateLocation.checked),
  };
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

  if (latestLocationState?.googleDetectedLocation) {
    rankCtxGoogleEl.textContent = `${latestLocationState.googleDetectedLocation} (${latestLocationState.googleLocationStatus})`;
  } else {
    rankCtxGoogleEl.textContent = latestLocationState?.googleLocationStatus || "Unverified";
  }
}

function renderLocationState(locState, { populateInputs = false } = {}) {
  if (!locState) return;
  latestLocationState = locState;
  applyStatePillStyle(locState.state);
  renderSharedContextSummaries();

  if (locState.config) {
    const c = locState.config;
    const labelParts = [c.locationName, c.targetCity, c.country, c.googleDomain].filter(Boolean);
    statusTargetLocationEl.textContent = labelParts.join(" · ") || "Configured";
    statusConfiguredCoordsEl.textContent = `${c.latitude}, ${c.longitude} (±${c.accuracy} m)`;

    if (populateInputs) {
      locNameInput.value = c.locationName || "";
      locCityInput.value = c.targetCity || "";
      locLatInput.value = String(c.latitude);
      locLngInput.value = String(c.longitude);
      locAccuracyInput.value = String(c.accuracy);
      if (c.country) locCountrySelect.value = c.country;
      if (c.language) locLanguageSelect.value = c.language;
      if (c.googleDomain) locGoogleDomainSelect.value = c.googleDomain;
      if (c.testPageUrl) locTestUrlInput.value = c.testPageUrl;
    }
  } else {
    statusTargetLocationEl.textContent = "Not configured";
    statusConfiguredCoordsEl.textContent = "Not configured";
  }

  if (locState.reportedCoords) {
    statusReportedCoordsEl.textContent = `${locState.reportedCoords.latitude}, ${locState.reportedCoords.longitude} (±${locState.reportedCoords.accuracy} m)`;
  } else {
    statusReportedCoordsEl.textContent = "Not tested";
  }

  const debuggerText = locState.debuggerAttached ? "Debugger connected" : "Debugger not connected";
  statusBrowserGpsEl.textContent = `${locState.browserGpsStatus || locState.state} (${debuggerText}, permission: ${locState.permissionStatus || "unknown"})`;

  statusGoogleDetectedEl.textContent = locState.googleDetectedLocation || "-";
  statusGoogleSourceEl.textContent = locState.googleLocationSource
    ? `${locState.googleLocationSource}${locState.googleMatchType ? ` [${locState.googleMatchType}]` : ""}`
    : "-";
  statusGoogleLocationEl.textContent =
    locState.googleLocationStatus || GOOGLE_LOCATION_STATUSES.UNVERIFIED;

  if (locState.tabId !== null && locState.tabId !== undefined) {
    statusTabIdEl.textContent = locState.tabUrl
      ? `Tab #${locState.tabId} (${locState.tabUrl})`
      : `Tab #${locState.tabId}`;
  } else {
    statusTabIdEl.textContent = "None";
  }

  const timeParts = [];
  if (locState.lastVerifiedAt) {
    timeParts.push(`GPS: ${new Date(locState.lastVerifiedAt).toLocaleString()}`);
  }
  if (locState.googleLastVerifiedAt) {
    timeParts.push(`Google: ${new Date(locState.googleLastVerifiedAt).toLocaleString()}`);
  }
  statusLastVerifiedEl.textContent = timeParts.length > 0 ? timeParts.join(" | ") : "-";

  const msgParts = [locState.lastError, locState.warningMessage].filter(Boolean);
  statusErrorsWarningsEl.textContent = msgParts.length > 0 ? msgParts.join(" — ") : "None";
}

function setRankingPillStyle(statusText) {
  rankStatusPillEl.className = "pill";
  rankStatusPillEl.textContent = statusText || "Ready";

  if (statusText === RANKING_STATUSES.RANKED) {
    rankStatusPillEl.classList.add("pill-healthy");
  } else if (
    statusText === RANKING_STATUSES.NOT_FOUND ||
    statusText === RANKING_STATUSES.INCOMPLETE_SEARCH ||
    statusText === RANKING_STATUSES.STOPPED_BY_USER ||
    statusText === "Checking..."
  ) {
    rankStatusPillEl.classList.add("pill-pending");
  } else if (!statusText || statusText === "Ready") {
    rankStatusPillEl.classList.add("pill-neutral");
  } else {
    rankStatusPillEl.classList.add("pill-error");
  }
}

function renderRankingResult(result) {
  if (!result) {
    rankResultPanel.classList.add("hidden");
    setRankingPillStyle("Ready");
    rankResultsTbody.textContent = "";
    return;
  }

  rankResultPanel.classList.remove("hidden");
  setRankingPillStyle(result.status);

  const isManual = result.sourceMode === "manual_html";
  resSourceBadgeEl.className = `pill ${
    isManual ? "pill-pending" : result.isLiveVerified ? "pill-healthy" : "pill-error"
  }`;
  resSourceBadgeEl.textContent = isManual
    ? "Manual SERP HTML (Not Live Verified)"
    : result.isLiveVerified
      ? "Live Verified"
      : "Unverified / Incomplete";
  resSourceLabelEl.textContent = result.sourceLabel || "-";

  resStatusEl.textContent = result.invalidatedByLocationChange
    ? `${result.status} (Invalidated: ${result.invalidationReason || "Location changed"})`
    : result.status;
  resKeywordEl.textContent = result.keyword || "-";
  resWebsiteEl.textContent = result.targetWebsite || "-";
  resPositionEl.textContent =
    result.status === RANKING_STATUSES.RANKED && result.position !== null
      ? `#${result.position}`
      : result.status === RANKING_STATUSES.NOT_FOUND
        ? "NA (not found within checked depth)"
        : "Not available";
  resUrlEl.textContent = result.rankingUrl || "-";
  resDepthCountEl.textContent = `${result.checkedResults} / ${result.requestedDepth}`;
  resGpsStatusEl.textContent = result.browserGpsStatus || "-";
  resGoogleStatusEl.textContent = result.googleLocationStatus || "-";
  resGoogleSourceEl.textContent = result.googleLocationSource || "-";
  resCheckedAtEl.textContent = result.checkedAt ? new Date(result.checkedAt).toLocaleString() : "-";
  resDurationEl.textContent = `${result.durationMs} ms`;
  resErrorEl.textContent = result.errorDetails || "None";

  rankResultsTbody.textContent = "";
  const tableRows = Array.isArray(result.resultsTable) ? result.resultsTable : [];
  if (tableRows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.textContent = "No genuine organic results extracted.";
    tr.appendChild(td);
    rankResultsTbody.appendChild(tr);
    return;
  }

  for (const row of tableRows) {
    const tr = document.createElement("tr");
    if (row.isTargetMatch) {
      tr.classList.add("target-match-row");
    }
    const posTd = document.createElement("td");
    posTd.textContent = row.isTargetMatch ? `#${row.position} (Match)` : String(row.position);
    const titleTd = document.createElement("td");
    titleTd.textContent = row.title || "-";
    const urlTd = document.createElement("td");
    urlTd.textContent = row.url;

    tr.append(posTd, titleTd, urlTd);
    rankResultsTbody.appendChild(tr);
  }
}

function renderBaselineTable() {
  accBaselineTbody.textContent = "";
  if (validationState.baselineRows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.textContent = "No baseline rows yet. Import a GS Location Changer CSV or sync keywords above.";
    tr.appendChild(td);
    accBaselineTbody.appendChild(tr);
    return;
  }

  validationState.baselineRows.forEach((row, index) => {
    const tr = document.createElement("tr");

    const kwTd = document.createElement("td");
    kwTd.textContent = row.keyword;

    const rankTd = document.createElement("td");
    const rankInput = document.createElement("input");
    rankInput.className = "inline-input";
    rankInput.value = row.manualRanking === null || row.manualRanking === undefined ? "" : String(row.manualRanking);
    rankInput.placeholder = "e.g. 3 or NA";
    rankInput.addEventListener("change", async () => {
      validationState.baselineRows[index].manualRanking = normalizeManualRank(rankInput.value);
      await saveValidationState(getDashboardStorage(), validationState);
    });
    rankTd.appendChild(rankInput);

    const urlTd = document.createElement("td");
    const urlInput = document.createElement("input");
    urlInput.className = "inline-input";
    urlInput.value = row.manualRankingUrl || "";
    urlInput.placeholder = "https://...";
    urlInput.addEventListener("change", async () => {
      validationState.baselineRows[index].manualRankingUrl = urlInput.value.trim();
      await saveValidationState(getDashboardStorage(), validationState);
    });
    urlTd.appendChild(urlInput);

    const devTd = document.createElement("td");
    const devInput = document.createElement("input");
    devInput.className = "inline-input";
    devInput.value = row.device || accDeviceSelect.value;
    devInput.addEventListener("change", async () => {
      validationState.baselineRows[index].device = devInput.value.trim() || "Desktop";
      await saveValidationState(getDashboardStorage(), validationState);
    });
    devTd.appendChild(devInput);

    const dateTd = document.createElement("td");
    const dateInput = document.createElement("input");
    dateInput.className = "inline-input";
    dateInput.value = row.checkedAt || "";
    dateInput.placeholder = "YYYY-MM-DD";
    dateInput.addEventListener("change", async () => {
      validationState.baselineRows[index].checkedAt = dateInput.value.trim();
      await saveValidationState(getDashboardStorage(), validationState);
    });
    dateTd.appendChild(dateInput);

    tr.append(kwTd, rankTd, urlTd, devTd, dateTd);
    accBaselineTbody.appendChild(tr);
  });
}

function renderComparisonReport(report) {
  if (!report) {
    accReportPanel.classList.add("hidden");
    accComparisonTbody.textContent = "";
    accStatusPillEl.className = "pill pill-neutral";
    accStatusPillEl.textContent = "Pending Validation";
    return;
  }

  accReportPanel.classList.remove("hidden");
  const m = report.metrics;
  metTotalEl.textContent = String(m.totalKeywordsTested);
  metComparableEl.textContent = `${m.comparableKeywords} (${m.coveragePercentage ?? 0}% coverage)`;
  metExactPctEl.textContent = `${m.exactMatchPercentage}%`;
  metTolPctEl.textContent = `${m.withinTolerancePercentage}%`;
  metUrlPctEl.textContent = `${m.urlMatchPercentage}%`;
  metAvgDiffEl.textContent = m.averageAbsoluteDifference !== null ? String(m.averageAbsoluteDifference) : "-";
  metLocMismatchEl.textContent = String(m.locationMismatchCount);
  metBlockedEl.textContent = String(m.blockedSearchCount);
  metIncompleteEl.textContent = String(m.incompleteSearchCount);

  accStatusPillEl.className = "pill";
  if (m.comparableKeywords === 0) {
    accStatusPillEl.classList.add("pill-pending");
    accStatusPillEl.textContent = "No Comparable Results";
  } else if (m.withinTolerancePercentage >= 90 && m.urlMatchPercentage >= 90) {
    accStatusPillEl.classList.add("pill-healthy");
    accStatusPillEl.textContent = `${m.withinTolerancePercentage}% Within ±${m.tolerance}`;
  } else {
    accStatusPillEl.classList.add("pill-pending");
    accStatusPillEl.textContent = `${m.withinTolerancePercentage}% Within ±${m.tolerance}`;
  }

  accComparisonTbody.textContent = "";
  for (const row of report.rows) {
    const tr = document.createElement("tr");
    const cells = [
      row.keyword,
      row.manualRanking,
      row.extensionRanking,
      row.rankingDifference ?? "-",
      row.manualRankingUrl || "-",
      row.extensionRankingUrl || "-",
      row.urlMatchStatus,
      row.browserGpsStatus,
      row.googleLocationStatus,
      row.googleLocationSource,
      row.comparisonStatus,
    ];
    for (const val of cells) {
      const td = document.createElement("td");
      td.textContent = String(val);
      tr.appendChild(td);
    }
    accComparisonTbody.appendChild(tr);
  }
}

function formatDurationMs(ms) {
  if (ms === null || ms === undefined) return "-";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${secs}s`;
}

function renderBulkJobState(bulkState) {
  latestBulkState = bulkState || { job: null, tasks: [], isBusy: false };
  const { job, tasks } = latestBulkState;
  const state = job?.state || JOB_STATES.READY;

  bulkJobPillEl.className = "pill";
  bulkJobPillEl.textContent = state;
  if (state === JOB_STATES.COMPLETED) {
    bulkJobPillEl.classList.add("pill-healthy");
  } else if (
    state === JOB_STATES.SEARCH_BLOCKED ||
    state === JOB_STATES.LOCATION_VERIFICATION_FAILED
  ) {
    bulkJobPillEl.classList.add("pill-error");
  } else if (
    isActiveJobState(state) ||
    state === JOB_STATES.PAUSED ||
    state === JOB_STATES.COMPLETED_WITH_ERRORS ||
    state === JOB_STATES.RECOVERY_REQUIRED ||
    state === JOB_STATES.INTERRUPTED
  ) {
    bulkJobPillEl.classList.add("pill-pending");
  } else {
    bulkJobPillEl.classList.add("pill-neutral");
  }

  const metrics = computeBulkProgressMetrics(job, tasks);
  bulkMTotalEl.textContent = String(metrics.totalKeywords);
  bulkMCompletedEl.textContent = String(metrics.completedKeywords);
  bulkMPendingEl.textContent = String(metrics.pendingKeywords);
  bulkMRankedEl.textContent = String(metrics.rankedKeywords);
  bulkMNaEl.textContent = String(metrics.notFoundKeywords);
  bulkMFailedEl.textContent = String(metrics.failedKeywords);
  bulkMCurrentEl.textContent = metrics.currentKeyword || "-";
  bulkMTimeEl.textContent = `${formatDurationMs(metrics.elapsedMs)} / ${formatDurationMs(metrics.estimatedRemainingMs)}`;

  bulkProgressLabelEl.textContent =
    state === JOB_STATES.RUNNING && metrics.currentKeyword
      ? `Processing: ${metrics.currentKeyword}`
      : job?.interruptionReason || job?.lastError || state;
  bulkProgressPctEl.textContent = `${metrics.progressPercentage}%`;
  bulkProgressFillEl.style.width = `${metrics.progressPercentage}%`;

  const running = isActiveJobState(state) || Boolean(latestBulkState.isBusy);
  const hasPending = tasks.some((t) => t.status === TASK_STATUSES.PENDING);
  const hasFailed = tasks.some((t) => isFailedTaskStatus(t.status));
  const canResume =
    !running &&
    hasPending &&
    (state === JOB_STATES.PAUSED ||
      state === JOB_STATES.RECOVERY_REQUIRED ||
      state === JOB_STATES.INTERRUPTED ||
      state === JOB_STATES.LOCATION_VERIFICATION_FAILED ||
      state === JOB_STATES.SEARCH_BLOCKED);

  bulkStartBtn.disabled = running;
  bulkPauseBtn.disabled = !running;
  bulkResumeBtn.disabled = !canResume;
  bulkStopBtn.disabled =
    !running && state !== JOB_STATES.PAUSED && state !== JOB_STATES.RECOVERY_REQUIRED;
  bulkRetryBtn.disabled = running || !hasFailed;
  bulkExportBtn.disabled = tasks.length === 0;
  bulkClearBtn.disabled = running;

  renderBulkResultsTable(tasks);
  syncBulkPolling(running);
}

function renderBulkResultsTable(tasks) {
  bulkResultsTbody.textContent = "";
  const filtered = filterBulkTasks(tasks || [], {
    searchQuery: bulkSearchInput.value,
    filterMode: bulkFilterSelect.value,
  });

  if (filtered.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 10;
    td.textContent = tasks.length === 0
      ? "No bulk job results yet. Import or paste keywords above and click Start Ranking Check."
      : "No results match the current search/filter.";
    tr.appendChild(td);
    bulkResultsTbody.appendChild(tr);
    return;
  }

  for (const task of filtered) {
    const tr = document.createElement("tr");
    if (task.status === TASK_STATUSES.RANKED) {
      tr.classList.add("target-match-row");
    }
    const posText =
      task.status === TASK_STATUSES.RANKED
        ? `#${task.position}`
        : task.status === TASK_STATUSES.NOT_FOUND
          ? "NA"
          : "-";

    const cells = [
      task.rowPosition,
      task.keyword,
      posText,
      task.rankingUrl || "-",
      task.checkedResults ?? 0,
      task.googleDetectedLocation || "-",
      task.locationVerificationStatus || "-",
      task.status,
      task.checkedAt ? new Date(task.checkedAt).toLocaleString() : "-",
      task.errorDetails || "-",
    ];
    for (const val of cells) {
      const td = document.createElement("td");
      td.textContent = String(val);
      tr.appendChild(td);
    }
    bulkResultsTbody.appendChild(tr);
  }
}

function syncBulkPolling(shouldPoll) {
  if (shouldPoll && !bulkPollTimer) {
    bulkPollTimer = setInterval(() => {
      refreshBulkStatus();
    }, 1000);
  } else if (!shouldPoll && bulkPollTimer) {
    clearInterval(bulkPollTimer);
    bulkPollTimer = null;
  }
}

function downloadTextFile(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function setLocationButtonsDisabled(disabled) {
  applyLocationBtn.disabled = disabled;
  testLocationBtn.disabled = disabled;
  openTestTabBtn.disabled = disabled;
  resetLocationBtn.disabled = disabled;
  applyGoogleBtn.disabled = disabled;
  verifyGoogleBtn.disabled = disabled;
  openGoogleBtn.disabled = disabled;
}

function setRankingRunningUi(running) {
  checkRankingBtn.disabled = running;
  stopRankingBtn.disabled = !running;
  clearRankingBtn.disabled = running;
}

function handleCoordinatePasteIfCombined(rawInput) {
  if (!rawInput || !rawInput.includes(",")) {
    return;
  }
  const parsed = parseCoordinatePair(rawInput);
  if (parsed.valid) {
    locLatInput.value = String(parsed.latitude);
    locLngInput.value = String(parsed.longitude);
    showBanner(locFeedbackEl, "success", "Split pasted coordinates into Latitude and Longitude.");
  }
}

locLatInput.addEventListener("input", () => {
  handleCoordinatePasteIfCombined(locLatInput.value);
});

locCountrySelect.addEventListener("change", () => {
  const preset = getCountryPreset(locCountrySelect.value);
  locGoogleDomainSelect.value = preset.googleDomain;
  locLanguageSelect.value = preset.defaultLanguage;
  renderSharedContextSummaries();
});

rankDomainInput.addEventListener("input", renderSharedContextSummaries);
rankDepthSelect.addEventListener("change", renderSharedContextSummaries);
bulkDeviceSelect.addEventListener("change", renderSharedContextSummaries);

rankUseManualHtmlChk.addEventListener("change", () => {
  if (rankUseManualHtmlChk.checked) {
    rankManualPanel.classList.remove("hidden");
  } else {
    rankManualPanel.classList.add("hidden");
  }
});

rankManualFileInput.addEventListener("change", async () => {
  const file = rankManualFileInput.files?.[0];
  if (!file) return;
  rankManualHtmlInput.value = await file.text();
});

accCsvFileInput.addEventListener("change", async () => {
  const file = accCsvFileInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  const parsed = parseBaselineCsv(text);
  if (!parsed.ok) {
    showBanner(accFeedbackEl, "error", parsed.error);
    return;
  }
  validationState.baselineRows = parsed.rows;
  accKeywordsInput.value = parsed.rows.map((r) => r.keyword).join("\n");
  await saveValidationState(getDashboardStorage(), validationState);
  renderBaselineTable();
  showBanner(accFeedbackEl, "success", `Imported ${parsed.rows.length} manual baseline row(s).`);
});

accSyncKeywordsBtn.addEventListener("click", async () => {
  const keywords = accKeywordsInput.value
    .split(/\r?\n/)
    .map((k) => k.trim())
    .filter(Boolean);

  if (keywords.length === 0) {
    showBanner(accFeedbackEl, "error", "Enter at least one keyword to sync to the baseline table.");
    return;
  }

  const existingQueues = new Map();
  for (const row of validationState.baselineRows) {
    const key = row.keyword.toLowerCase();
    if (!existingQueues.has(key)) existingQueues.set(key, []);
    existingQueues.get(key).push(row);
  }

  const cfg = latestLocationState?.config;
  validationState.baselineRows = keywords.map((kw, idx) => {
    const existing = existingQueues.get(kw.toLowerCase())?.shift();
    if (existing) {
      return { ...existing, rowIndex: idx, keyword: kw };
    }
    return {
      rowIndex: idx,
      keyword: kw,
      manualRanking: null,
      manualRankingUrl: "",
      targetLocation: cfg?.targetCity || cfg?.locationName || "",
      latitude: cfg?.latitude ?? null,
      longitude: cfg?.longitude ?? null,
      device: accDeviceSelect.value,
      checkedAt: "",
    };
  });

  await saveValidationState(getDashboardStorage(), validationState);
  renderBaselineTable();
  showBanner(accFeedbackEl, "success", `Synced ${keywords.length} keyword(s) into the baseline table.`);
});

accCompareBtn.addEventListener("click", async () => {
  showBanner(accFeedbackEl, null, "");
  const keywords = accKeywordsInput.value
    .split(/\r?\n/)
    .map((k) => k.trim())
    .filter(Boolean);

  const extResults = latestRankingState?.recentResults || [];
  const cfg = latestLocationState?.config || {};

  const report = compareRankingWithBaseline({
    keywords,
    extensionResults: extResults,
    baselineRows: validationState.baselineRows,
    tolerance: Number(accToleranceSelect.value),
    settings: {
      websiteDomain: rankDomainInput.value.trim(),
      targetLocation: cfg.targetCity || cfg.locationName || "",
      latitude: cfg.latitude,
      longitude: cfg.longitude,
      country: cfg.country || locCountrySelect.value,
      language: cfg.language || locLanguageSelect.value,
      searchDepth: Number(rankDepthSelect.value),
      deviceType: accDeviceSelect.value,
    },
  });

  validationState.tolerance = Number(accToleranceSelect.value);
  validationState.deviceType = accDeviceSelect.value;
  validationState.comparisonReport = report;
  await saveValidationState(getDashboardStorage(), validationState);
  renderComparisonReport(report);
});

accExportCsvBtn.addEventListener("click", () => {
  if (!validationState.comparisonReport) {
    showBanner(accFeedbackEl, "error", "Run an accuracy comparison before exporting.");
    return;
  }
  const csv = exportComparisonCsv(validationState.comparisonReport);
  downloadTextFile("ranking-accuracy-comparison.csv", csv, "text/csv;charset=utf-8");
});

accExportJsonBtn.addEventListener("click", () => {
  if (!validationState.comparisonReport) {
    showBanner(accFeedbackEl, "error", "Run an accuracy comparison before exporting.");
    return;
  }
  const json = exportComparisonJson(validationState.comparisonReport);
  downloadTextFile("ranking-accuracy-comparison.json", json, "application/json;charset=utf-8");
});

accClearBtn.addEventListener("click", async () => {
  validationState = await clearValidationState(getDashboardStorage());
  accKeywordsInput.value = "";
  accCsvFileInput.value = "";
  renderBaselineTable();
  renderComparisonReport(null);
  showBanner(accFeedbackEl, "success", "Cleared comparison baseline and report data.");
});

// Bulk Keyword Checker event handlers
bulkKeywordsInput.addEventListener("input", () => {
  parsedBulkQueueInput = null;
});

bulkCsvFileInput.addEventListener("change", async () => {
  const file = bulkCsvFileInput.files?.[0];
  if (!file) return;
  const entries = parseKeywordCsvInput(await file.text());
  if (entries.length === 0) {
    showBanner(bulkFeedbackEl, "error", "No keywords found in CSV file.");
    return;
  }
  parsedBulkQueueInput = entries;
  bulkKeywordsInput.value = entries.map((e) => e.keyword).join("\n");
  showBanner(bulkFeedbackEl, "success", `Loaded ${entries.length} keyword(s) from CSV.`);
});

bulkTxtFileInput.addEventListener("change", async () => {
  const file = bulkTxtFileInput.files?.[0];
  if (!file) return;
  const entries = parseKeywordTextInput(await file.text());
  if (entries.length === 0) {
    showBanner(bulkFeedbackEl, "error", "No keywords found in TXT file.");
    return;
  }
  parsedBulkQueueInput = entries;
  bulkKeywordsInput.value = entries.map((e) => e.keyword).join("\n");
  showBanner(bulkFeedbackEl, "success", `Loaded ${entries.length} keyword(s) from TXT.`);
});

bulkImportLabBtn.addEventListener("click", () => {
  const entries = importKeywordsFromBaselineRows(validationState.baselineRows);
  if (entries.length === 0) {
    const labTextEntries = parseKeywordTextInput(accKeywordsInput.value);
    if (labTextEntries.length === 0) {
      showBanner(bulkFeedbackEl, "error", "No keywords available in Accuracy Lab to import.");
      return;
    }
    parsedBulkQueueInput = labTextEntries;
    bulkKeywordsInput.value = labTextEntries.map((e) => e.keyword).join("\n");
    showBanner(bulkFeedbackEl, "success", `Imported ${labTextEntries.length} keyword(s) from Accuracy Lab.`);
    return;
  }
  parsedBulkQueueInput = entries;
  bulkKeywordsInput.value = entries.map((e) => e.keyword).join("\n");
  showBanner(bulkFeedbackEl, "success", `Imported ${entries.length} keyword(s) from Accuracy Lab baseline.`);
});

bulkSearchInput.addEventListener("input", () => {
  renderBulkResultsTable(latestBulkState.tasks);
});

bulkFilterSelect.addEventListener("change", () => {
  renderBulkResultsTable(latestBulkState.tasks);
});

bulkStartBtn.addEventListener("click", async () => {
  showBanner(bulkFeedbackEl, null, "");
  const entries = parsedBulkQueueInput || parseKeywordTextInput(bulkKeywordsInput.value);
  if (entries.length === 0) {
    showBanner(bulkFeedbackEl, "error", "Enter or import at least one keyword first.");
    return;
  }

  bulkStartBtn.disabled = true;
  syncBulkPolling(true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.BULK_START,
      payload: {
        clientId: activeClientWorkspace?.client?.clientId || null,
        locationId: activeClientWorkspace?.selectedLocation?.locationId || null,
        websiteDomain: rankDomainInput.value,
        keywords: entries,
        searchDepth: Number(rankDepthSelect.value),
        deviceType: bulkDeviceSelect.value,
      },
    });
    if (response?.job) {
      renderBulkJobState({ job: response.job, tasks: response.tasks || [], isBusy: false });
    }
    if (!response?.ok) {
      showBanner(bulkFeedbackEl, "error", response?.error || "Bulk job stopped with errors.");
    } else {
      showBanner(bulkFeedbackEl, "success", `Bulk job finished (${response.job?.state}).`);
    }
  } catch (error) {
    showBanner(bulkFeedbackEl, "error", error instanceof Error ? error.message : "Bulk job failed.");
  } finally {
    await refreshBulkStatus();
    await refreshClientsOverview({ preserveWorkspace: true });
  }
});

bulkPauseBtn.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BULK_PAUSE });
  showBanner(bulkFeedbackEl, "warning", res?.message || res?.error || "Pause requested.");
});

bulkResumeBtn.addEventListener("click", async () => {
  showBanner(bulkFeedbackEl, null, "");
  syncBulkPolling(true);
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BULK_RESUME });
  if (res?.job) {
    renderBulkJobState({ job: res.job, tasks: res.tasks || [], isBusy: false });
  }
  if (!res?.ok) {
    showBanner(bulkFeedbackEl, "error", res?.error || "Unable to resume bulk job.");
  }
  await refreshBulkStatus();
  await refreshClientsOverview({ preserveWorkspace: true });
});

bulkStopBtn.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BULK_STOP });
  showBanner(bulkFeedbackEl, "warning", res?.message || "Bulk job stopped.");
  await refreshBulkStatus();
});

bulkRetryBtn.addEventListener("click", async () => {
  showBanner(bulkFeedbackEl, null, "");
  syncBulkPolling(true);
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BULK_RETRY_FAILED });
  if (res?.job) {
    renderBulkJobState({ job: res.job, tasks: res.tasks || [], isBusy: false });
  }
  if (!res?.ok) {
    showBanner(bulkFeedbackEl, "error", res?.error || "Retry failed.");
  }
  await refreshBulkStatus();
  await refreshClientsOverview({ preserveWorkspace: true });
});

bulkExportBtn.addEventListener("click", () => {
  if (!latestBulkState.tasks || latestBulkState.tasks.length === 0) {
    showBanner(bulkFeedbackEl, "error", "No bulk results available to export.");
    return;
  }
  const csv = exportBulkResultsCsv(latestBulkState.job, latestBulkState.tasks);
  downloadTextFile("bulk-keyword-rankings.csv", csv, "text/csv;charset=utf-8");
});

bulkClearBtn.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BULK_CLEAR });
  if (!res?.ok) {
    showBanner(bulkFeedbackEl, "error", res?.error || "Failed clearing bulk results.");
    return;
  }
  parsedBulkQueueInput = null;
  renderBulkJobState({ job: null, tasks: [], isBusy: false });
  showBanner(bulkFeedbackEl, "success", "Cleared bulk ranking results.");
});

async function runDashboardHealthCheck() {
  setHealthBadge("pending", "Running background worker and chrome.storage.local test...");
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.HEALTH_CHECK,
    });
    if (response?.ok) {
      setHealthBadge("healthy", "Background service worker and chrome.storage.local passed.");
      workerEl.textContent = "Connected";
      storageEl.textContent = response.storageOk ? "Read/Write OK" : "Failed";
      timestampEl.textContent = new Date(response.checkedAt).toLocaleString();
    } else {
      setHealthBadge("error", response?.error || "Health check failed.");
      workerEl.textContent = "Error";
      storageEl.textContent = "Error";
      timestampEl.textContent = "-";
    }
  } catch (error) {
    setHealthBadge(
      "error",
      error instanceof Error ? error.message : "Failed to communicate with service worker."
    );
    workerEl.textContent = "Disconnected";
    storageEl.textContent = "Unavailable";
    timestampEl.textContent = "-";
  }
}

async function refreshLocationStatus({ populateInputs = false } = {}) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.LOCATION_GET_STATUS,
    });
    if (response?.ok) {
      renderLocationState(response.state, { populateInputs });
    }
  } catch (error) {
    showBanner(
      locFeedbackEl,
      "error",
      error instanceof Error ? error.message : "Unable to load location status."
    );
  }
}

async function refreshRankingState() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.RANKING_GET_STATE,
    });
    if (response?.ok && response.state) {
      latestRankingState = response.state;
      setRankingRunningUi(Boolean(response.state.isRunning));
      if (response.state.lastResult) {
        renderRankingResult(response.state.lastResult);
      }
    }
  } catch {
    // Ignore initial load errors.
  }
}

async function refreshValidationState() {
  try {
    validationState = await loadValidationState(getDashboardStorage());
    accToleranceSelect.value = String(validationState.tolerance ?? 1);
    accDeviceSelect.value = validationState.deviceType || "Desktop";
    if (validationState.baselineRows.length > 0) {
      accKeywordsInput.value = validationState.baselineRows.map((r) => r.keyword).join("\n");
    }
    renderBaselineTable();
    renderComparisonReport(validationState.comparisonReport);
  } catch {
    // Ignore initial validation load errors.
  }
}

async function refreshBulkStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.BULK_GET_STATUS,
    });
    if (response?.ok) {
      renderBulkJobState(response);
      if (response.recovered) {
        showBanner(
          bulkFeedbackEl,
          "warning",
          response.job?.interruptionReason || "Interrupted bulk job recovered. Re-verify location and click Resume."
        );
      }
    }
  } catch {
    // Ignore initial bulk status errors.
  }
}

async function sendLocationAction(type, payload = undefined) {
  handleCoordinatePasteIfCombined(locLatInput.value);
  showBanner(locFeedbackEl, null, "");
  setLocationButtonsDisabled(true);

  try {
    const response = await chrome.runtime.sendMessage({ type, payload });
    if (response?.state) {
      renderLocationState(response.state);
    }

    if (response?.errors) {
      showBanner(locFeedbackEl, "error", response.errors.join(" "));
      return;
    }

    if (response?.ok) {
      if (type === MESSAGE_TYPES.LOCATION_RESET) {
        showBanner(locFeedbackEl, "success", "Location override cleared and debugger detached.");
      } else if (
        type === MESSAGE_TYPES.LOCATION_OPEN_TEST_TAB ||
        type === MESSAGE_TYPES.GOOGLE_LOCATION_OPEN_SEARCH
      ) {
        showBanner(locFeedbackEl, "warning", "Dedicated tab opened. Use Apply/Verify controls to verify.");
      } else if (
        type === MESSAGE_TYPES.GOOGLE_LOCATION_APPLY ||
        type === MESSAGE_TYPES.GOOGLE_LOCATION_VERIFY
      ) {
        showBanner(locFeedbackEl, "success", "Browser GPS and Google Search location matched target.");
      } else {
        showBanner(locFeedbackEl, "success", "Browser GPS verified on dedicated tab.");
      }
    } else {
      const msg =
        response?.error ||
        response?.state?.lastError ||
        response?.state?.warningMessage ||
        "Verification did not match or was incomplete.";
      const kind =
        response?.state?.googleLocationStatus === GOOGLE_LOCATION_STATUSES.UNAVAILABLE
          ? "warning"
          : "error";
      showBanner(locFeedbackEl, kind, msg);
    }
  } catch (error) {
    showBanner(
      locFeedbackEl,
      "error",
      error instanceof Error ? error.message : "Failed to run location action."
    );
  } finally {
    setLocationButtonsDisabled(false);
    await refreshRankingState();
  }
}

locationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendLocationAction(MESSAGE_TYPES.LOCATION_APPLY, getLocationPayload());
});

testLocationBtn.addEventListener("click", async () => {
  await sendLocationAction(MESSAGE_TYPES.LOCATION_TEST);
});

openTestTabBtn.addEventListener("click", async () => {
  await sendLocationAction(MESSAGE_TYPES.LOCATION_OPEN_TEST_TAB, {
    testPageUrl: locTestUrlInput.value,
  });
});

resetLocationBtn.addEventListener("click", async () => {
  await sendLocationAction(MESSAGE_TYPES.LOCATION_RESET);
});

applyGoogleBtn.addEventListener("click", async () => {
  await sendLocationAction(MESSAGE_TYPES.GOOGLE_LOCATION_APPLY, getLocationPayload());
});

verifyGoogleBtn.addEventListener("click", async () => {
  await sendLocationAction(MESSAGE_TYPES.GOOGLE_LOCATION_VERIFY, {
    clickUpdateLocation: Boolean(chkUpdateLocation.checked),
  });
});

openGoogleBtn.addEventListener("click", async () => {
  await sendLocationAction(MESSAGE_TYPES.GOOGLE_LOCATION_OPEN_SEARCH, getLocationPayload());
});

rankingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showBanner(rankFeedbackEl, null, "");
  setRankingRunningUi(true);
  setRankingPillStyle("Checking...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.RANKING_CHECK,
      payload: {
        websiteDomain: rankDomainInput.value,
        keyword: rankKeywordInput.value,
        searchDepth: Number(rankDepthSelect.value),
        useManualHtml: Boolean(rankUseManualHtmlChk.checked),
        manualSerpHtml: rankManualHtmlInput.value,
        deviceType: accDeviceSelect.value,
      },
    });

    if (response?.error && !response?.result) {
      showBanner(rankFeedbackEl, "error", response.error);
      setRankingPillStyle("Ready");
      return;
    }

    if (response?.state) {
      latestRankingState = response.state;
    }

    if (response?.result) {
      renderRankingResult(response.result);
      if (response.result.status === RANKING_STATUSES.RANKED) {
        showBanner(
          rankFeedbackEl,
          "success",
          `Target website ranked at organic position #${response.result.position}.`
        );
      } else if (response.result.status === RANKING_STATUSES.NOT_FOUND) {
        showBanner(
          rankFeedbackEl,
          "warning",
          `Not found within verified search depth (${response.result.checkedResults} results checked).`
        );
      } else {
        showBanner(
          rankFeedbackEl,
          "error",
          `${response.result.status}: ${response.result.errorDetails || "Check stopped."}`
        );
      }
    }
  } catch (error) {
    showBanner(
      rankFeedbackEl,
      "error",
      error instanceof Error ? error.message : "Ranking check failed."
    );
    setRankingPillStyle("Ready");
  } finally {
    setRankingRunningUi(false);
  }
});

stopRankingBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RANKING_STOP });
  showBanner(rankFeedbackEl, "warning", "Stop requested. Waiting for current step to halt...");
});

clearRankingBtn.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RANKING_CLEAR });
  latestRankingState = res?.state || null;
  showBanner(rankFeedbackEl, null, "");
  renderRankingResult(null);
});

function formatClientTimestamp(iso) {
  if (!iso) return "No data";
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? "No data" : dt.toLocaleString();
}

function populateClientEditorForm(client = null) {
  cliIdInput.value = client?.clientId || "";
  cliNameInput.value = client?.clientName || "";
  cliDomainInput.value = client?.websiteDomain || "";
  cliStatusSelect.value = client?.status || "active";
  cliUrlInput.value = client?.websiteUrl || "";
  cliNotesInput.value = client?.notes || "";
  const sc = client?.sheetConfig || {};
  cliSheetUrlInput.value = sc.sheetUrl || "";
  cliSheetIdInput.value = sc.spreadsheetId || "";
  cliWsNameInput.value = sc.worksheetName || "Keywords";
  cliWsIdInput.value = sc.worksheetId || "";
  cliColKwInput.value = sc.keywordColumn || "C";
  cliColVolInput.value = sc.searchVolumeColumn || "D";
  cliColCompInput.value = sc.competitionColumn || "E";
  cliColLpInput.value = sc.landingPageColumn || "F";
  cliColSerpInput.value = sc.serpColumn || "G";
  cliColDateInput.value = sc.latestDateColumn || "H";
  clientEditorTitleEl.textContent = client ? `Edit Client: ${client.clientName}` : "Add Client";
}

function applyLocationRecordToInputs(loc) {
  if (!loc) return;
  locNameInput.value = loc.locationName || "";
  locCityInput.value = loc.targetCity || loc.locationName || "";
  locLatInput.value = String(loc.latitude ?? "");
  locLngInput.value = String(loc.longitude ?? "");
  locAccuracyInput.value = String(loc.accuracy ?? 20);
  if (loc.country) locCountrySelect.value = loc.country;
  if (loc.language) locLanguageSelect.value = loc.language;
  if (loc.googleDomain) locGoogleDomainSelect.value = loc.googleDomain;
  if (loc.searchDepth) rankDepthSelect.value = String(loc.searchDepth);
  if (loc.deviceType) bulkDeviceSelect.value = loc.deviceType;
  renderSharedContextSummaries();
}

function renderClientWorkspace(workspace) {
  activeClientWorkspace = workspace;
  const hasClient = Boolean(workspace?.client);
  clientExportBtn.disabled = !hasClient;

  if (!hasClient) {
    activeClientPillEl.className = "pill pill-neutral";
    activeClientPillEl.textContent = "No Active Client";
    activeClientWorkspaceEl.classList.add("hidden");
    sheetsCtxClientEl.textContent = "No Active Client";
    return;
  }

  const { client, locations = [], selectedLocation = null, keywords = [], results = [] } = workspace;
  activeClientPillEl.className = "pill pill-healthy";
  activeClientPillEl.textContent = `Active: ${client.clientName}`;
  wsClientHeadingEl.textContent = `${client.clientName} (${client.websiteDomain})`;
  activeClientWorkspaceEl.classList.remove("hidden");

  sheetsCtxClientEl.textContent = client.sheetConfig?.spreadsheetId
    ? `${client.clientName} (${client.sheetConfig.worksheetName || "Select tab"})`
    : `${client.clientName} (No Sheet URL configured)`;
  if (client.sheetConfig?.sheetUrl) {
    sheetsUrlInput.value = client.sheetConfig.sheetUrl;
  }
  if (client.sheetConfig?.spreadsheetId) {
    sheetsIdInput.value = client.sheetConfig.spreadsheetId;
  }

  rankDomainInput.value = client.websiteDomain || "";
  if (selectedLocation) {
    applyLocationRecordToInputs(selectedLocation);
  } else {
    renderSharedContextSummaries();
  }

  cliLocationsListEl.replaceChildren();
  if (locations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No client locations saved yet.";
    cliLocationsListEl.appendChild(empty);
  } else {
    for (const loc of locations) {
      const item = document.createElement("div");
      item.className = "mini-list-item";
      const label = document.createElement("span");
      const activeTag = selectedLocation?.locationId === loc.locationId ? " [Active]" : "";
      const sheetInfo = loc.worksheetName || loc.reportingRange
        ? ` · Sheet ${loc.worksheetName || "-"}${loc.reportingRange ? ` (${loc.reportingRange})` : ""}`
        : "";
      label.textContent = `${loc.locationName}${loc.stateRegion ? ` (${loc.stateRegion})` : ""} · ${loc.latitude}, ${loc.longitude}${sheetInfo}${activeTag}`;

      const btns = document.createElement("div");
      btns.className = "actions";
      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "btn-outline btn-compact";
      useBtn.textContent = "Use";
      useBtn.addEventListener("click", () => handleSelectClient(client.clientId, loc.locationId));

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-outline btn-compact";
      delBtn.textContent = "Remove";
      delBtn.addEventListener("click", async () => {
        const res = await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.CLIENT_DELETE_LOCATION,
          payload: { locationId: loc.locationId },
        });
        if (res?.ok) {
          await refreshClientWorkspace(client.clientId);
          await refreshClientsOverview();
        }
      });

      btns.append(useBtn, delBtn);
      item.append(label, btns);
      cliLocationsListEl.appendChild(item);
    }
  }

  cliKwCountEl.textContent = String(keywords.length);
  cliKeywordsListEl.replaceChildren();
  if (keywords.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No keywords saved for this client yet.";
    cliKeywordsListEl.appendChild(empty);
  } else {
    for (const kw of keywords) {
      const item = document.createElement("div");
      item.className = "mini-list-item";
      const label = document.createElement("span");
      label.textContent = `${kw.keyword} [${kw.keywordGroup || "Default"} · Row ${kw.rowPosition || "-"}]${kw.active === false ? " (Inactive)" : ""}`;

      const btns = document.createElement("div");
      btns.className = "actions";
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "btn-outline btn-compact";
      toggleBtn.textContent = kw.active === false ? "Enable" : "Disable";
      toggleBtn.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.CLIENT_UPDATE_KEYWORD,
          payload: {
            clientId: client.clientId,
            keywordId: kw.keywordId,
            updates: { active: kw.active === false },
          },
        });
        await refreshClientWorkspace(client.clientId);
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-outline btn-compact";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.CLIENT_DELETE_KEYWORD,
          payload: { keywordId: kw.keywordId },
        });
        await refreshClientWorkspace(client.clientId);
        await refreshClientsOverview();
      });

      btns.append(toggleBtn, delBtn);
      item.append(label, btns);
      cliKeywordsListEl.appendChild(item);
    }
  }

  cliHistoryTbody.replaceChildren();
  if (results.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "muted";
    td.textContent = "No stored ranking results for this client yet.";
    tr.appendChild(td);
    cliHistoryTbody.appendChild(tr);
  } else {
    for (const row of results.slice(0, 50)) {
      const tr = document.createElement("tr");
      const vals = [
        row.keyword || "-",
        typeof row.position === "number" ? String(row.position) : "-",
        row.status || "-",
        row.rankingUrl || "-",
        row.checkedAt ? new Date(row.checkedAt).toLocaleString() : "-",
        row.googleLocation || "-",
      ];
      for (const val of vals) {
        const td = document.createElement("td");
        td.textContent = val;
        tr.appendChild(td);
      }
      cliHistoryTbody.appendChild(tr);
    }
  }
}

function getClientInitials(name) {
  const parts = String(name || "DM").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function renderClientCards(overviews = []) {
  clientOverviewsCache = overviews;
  clientCardsGridEl.replaceChildren();
  const activeId = activeClientWorkspace?.client?.clientId || null;

  if (overviews.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No clients match the filter. Click + Add Client to create one.";
    clientCardsGridEl.appendChild(empty);
    return;
  }

  for (const ov of overviews) {
    const card = document.createElement("div");
    card.className = `client-overview-card${ov.clientId === activeId ? " active-card" : ""}`;

    const head = document.createElement("div");
    head.className = "client-card-head";

    const identity = document.createElement("div");
    identity.className = "client-card-identity";
    const avatar = document.createElement("div");
    avatar.className = "client-avatar";
    avatar.textContent = getClientInitials(ov.clientName);

    const titleWrap = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = ov.clientName;
    const domainDiv = document.createElement("div");
    domainDiv.className = "muted";
    domainDiv.textContent = ov.websiteDomain;
    titleWrap.append(strong, domainDiv);
    identity.append(avatar, titleWrap);

    const rightHead = document.createElement("div");
    rightHead.className = "actions";
    if (ov.status !== "active") {
      const statusPill = document.createElement("span");
      statusPill.className = `pill ${ov.status === "archived" ? "pill-neutral" : "pill-pending"}`;
      statusPill.textContent = ov.status;
      rightHead.appendChild(statusPill);
    }
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "btn-outline btn-compact";
    moreBtn.title = "Client actions";
    moreBtn.textContent = "···";
    rightHead.appendChild(moreBtn);
    head.append(identity, rightHead);

    const kpiRow = document.createElement("div");
    kpiRow.className = "client-kpis-row";

    const kpiDefs = [
      { label: "Keywords", value: String(ov.keywordCount), good: false },
      { label: "Locations", value: String(ov.locationCount), good: false },
      {
        label: "Top 10",
        value: ov.hasRankingData ? String(ov.top10Count) : "No data",
        good: Boolean(ov.hasRankingData && ov.top10Count > 0),
      },
    ];
    for (const kpi of kpiDefs) {
      const box = document.createElement("div");
      const lbl = document.createElement("span");
      lbl.className = "client-kpi-label";
      lbl.textContent = kpi.label;
      const val = document.createElement("span");
      val.className = `client-kpi-value${kpi.good ? " kpi-good" : ""}`;
      val.textContent = kpi.value;
      box.append(lbl, val);
      kpiRow.appendChild(box);
    }

    const locLine = document.createElement("div");
    locLine.className = "client-card-locations";
    const locSummary =
      Array.isArray(ov.locationNames) && ov.locationNames.length > 0
        ? ov.locationNames.join(", ")
        : "No locations configured";
    locLine.textContent = `⌖ ${locSummary}`;

    const primaryActions = document.createElement("div");
    primaryActions.className = "client-card-primary-actions";

    const manageBtn = document.createElement("button");
    manageBtn.type = "button";
    manageBtn.className = "btn-outline";
    manageBtn.textContent = ov.clientId === activeId ? "Managing Client" : "Manage Client";
    manageBtn.addEventListener("click", async () => {
      await handleSelectClient(ov.clientId);
      activeClientWorkspaceEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    const startCheckBtn = document.createElement("button");
    startCheckBtn.type = "button";
    startCheckBtn.className = "btn-navy";
    startCheckBtn.textContent = "Start Ranking Check";
    startCheckBtn.addEventListener("click", async () => {
      await handleSelectClient(ov.clientId);
      if ((activeClientWorkspace?.keywords || []).length > 0) {
        clientLoadBulkBtn.click();
      }
      bulkKeywordsInput.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    primaryActions.append(manageBtn, startCheckBtn);

    const overflowMenu = document.createElement("div");
    overflowMenu.className = "client-card-menu hidden";
    moreBtn.addEventListener("click", () => {
      overflowMenu.classList.toggle("hidden");
    });

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn-outline btn-compact";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", async () => {
      const ws = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.CLIENT_GET_WORKSPACE,
        payload: { clientId: ov.clientId },
      });
      if (ws?.ok) {
        populateClientEditorForm(ws.client);
        clientEditorPanel.classList.remove("hidden");
      }
    });

    const dupBtn = document.createElement("button");
    dupBtn.type = "button";
    dupBtn.className = "btn-outline btn-compact";
    dupBtn.textContent = "Duplicate";
    dupBtn.addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.CLIENT_DUPLICATE,
        payload: { clientId: ov.clientId },
      });
      if (res?.ok) {
        showBanner(clientFeedbackEl, "success", `Duplicated '${ov.clientName}'.`);
        await refreshClientsOverview();
      } else {
        showBanner(clientFeedbackEl, "error", res?.error || "Duplicate failed.");
      }
    });

    const archBtn = document.createElement("button");
    archBtn.type = "button";
    archBtn.className = "btn-outline btn-compact";
    archBtn.textContent = ov.status === "archived" ? "Archived" : "Archive";
    archBtn.disabled = ov.status === "archived";
    archBtn.addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.CLIENT_ARCHIVE,
        payload: { clientId: ov.clientId },
      });
      if (res?.ok) {
        await refreshClientsOverview({ preserveWorkspace: true });
      }
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-outline btn-compact";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      const confirmed = window.confirm(
        `Permanently delete '${ov.clientName}' and all isolated locations, keywords, and ranking history?`
      );
      if (!confirmed) return;
      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.CLIENT_DELETE,
        payload: { clientId: ov.clientId, confirmed: true },
      });
      if (res?.ok) {
        if (activeClientWorkspace?.client?.clientId === ov.clientId) {
          renderClientWorkspace(null);
        }
        showBanner(clientFeedbackEl, "success", `Deleted '${ov.clientName}'.`);
        await refreshClientsOverview();
      } else {
        showBanner(clientFeedbackEl, "error", res?.error || "Delete failed.");
      }
    });

    overflowMenu.append(editBtn, dupBtn, archBtn, delBtn);
    card.append(head, kpiRow, locLine, primaryActions, overflowMenu);
    clientCardsGridEl.appendChild(card);
  }
}

async function refreshClientWorkspace(clientId, locationId = null) {
  if (!clientId) {
    renderClientWorkspace(null);
    return;
  }
  const ws = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.CLIENT_GET_WORKSPACE,
    payload: { clientId, locationId },
  });
  if (ws?.ok) {
    renderClientWorkspace(ws);
  }
}

async function refreshClientsOverview({ preserveWorkspace = false } = {}) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CLIENT_LIST_OVERVIEWS,
      payload: {
        query: clientSearchInput.value,
        includeArchived: Boolean(clientShowArchivedChk.checked),
      },
    });
    if (res?.ok) {
      if (res.active?.clientId && (!activeClientWorkspace || preserveWorkspace)) {
        await refreshClientWorkspace(res.active.clientId, res.active.locationId);
      }
      renderClientCards(res.overviews || []);
    }
  } catch {
    // Ignore initial load errors.
  }
}

async function handleSelectClient(clientId, locationId = null) {
  showBanner(clientFeedbackEl, null, "");
  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.CLIENT_SELECT,
    payload: { clientId, locationId },
  });
  if (!res?.ok) {
    showBanner(clientFeedbackEl, "error", res?.error || "Unable to select client.");
    return;
  }
  renderClientWorkspace(res);
  renderClientCards(clientOverviewsCache);
  await refreshLocationStatus({ populateInputs: false });
  showBanner(
    clientFeedbackEl,
    "warning",
    `Switched to '${res.client.clientName}'. Previous location verification was reset — verify location before running checks.`
  );
}

clientSearchInput.addEventListener("input", () => {
  refreshClientsOverview();
});

clientShowArchivedChk.addEventListener("change", () => {
  refreshClientsOverview();
});

clientNewBtn.addEventListener("click", () => {
  populateClientEditorForm(null);
  clientEditorPanel.classList.remove("hidden");
});

clientCancelBtn.addEventListener("click", () => {
  clientEditorPanel.classList.add("hidden");
});

cliSheetUrlInput.addEventListener("input", () => {
  const match = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(cliSheetUrlInput.value.trim());
  if (match && !cliSheetIdInput.value.trim()) {
    cliSheetIdInput.value = match[1];
  }
});

clientEditorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showBanner(clientFeedbackEl, null, "");
  const clientId = cliIdInput.value.trim();
  const payloadData = {
    clientName: cliNameInput.value,
    websiteDomain: cliDomainInput.value,
    websiteUrl: cliUrlInput.value,
    status: cliStatusSelect.value,
    notes: cliNotesInput.value,
    sheetConfig: {
      sheetUrl: cliSheetUrlInput.value,
      spreadsheetId: cliSheetIdInput.value,
      worksheetName: cliWsNameInput.value,
      worksheetId: cliWsIdInput.value,
      keywordColumn: cliColKwInput.value,
      searchVolumeColumn: cliColVolInput.value,
      competitionColumn: cliColCompInput.value,
      landingPageColumn: cliColLpInput.value,
      serpColumn: cliColSerpInput.value,
      latestDateColumn: cliColDateInput.value,
    },
  };

  const res = clientId
    ? await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.CLIENT_UPDATE,
        payload: { clientId, updates: payloadData },
      })
    : await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.CLIENT_CREATE,
        payload: payloadData,
      });

  if (!res?.ok) {
    showBanner(
      clientFeedbackEl,
      "error",
      res?.errors?.join(" ") || res?.error || "Failed to save client."
    );
    return;
  }

  clientEditorPanel.classList.add("hidden");
  showBanner(clientFeedbackEl, "success", `Saved client '${res.client.clientName}'.`);
  await handleSelectClient(res.client.clientId);
  await refreshClientsOverview({ preserveWorkspace: true });
});

cliAddLocBtn.addEventListener("click", async () => {
  if (!activeClientWorkspace?.client) return;
  showBanner(clientFeedbackEl, null, "");
  const coordsText = cliLocCoordsInput.value.trim();
  const parsed = parseCoordinatePair(coordsText);
  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.CLIENT_ADD_LOCATION,
    payload: {
      clientId: activeClientWorkspace.client.clientId,
      locationName: cliLocNameInput.value,
      stateRegion: cliLocStateInput.value,
      latitude: parsed ? parsed.latitude : "",
      longitude: parsed ? parsed.longitude : "",
      accuracy: Number(locAccuracyInput.value) || 20,
      country: locCountrySelect.value,
      language: locLanguageSelect.value,
      googleDomain: locGoogleDomainSelect.value,
      deviceType: bulkDeviceSelect.value,
      searchDepth: Number(rankDepthSelect.value) || 50,
      worksheetName: cliLocWsInput.value,
      reportingRange: cliLocColInput.value,
    },
  });
  if (!res?.ok) {
    showBanner(
      clientFeedbackEl,
      "error",
      res?.errors?.join(" ") || res?.error || "Unable to add client location."
    );
    return;
  }
  cliLocNameInput.value = "";
  cliLocCoordsInput.value = "";
  cliLocStateInput.value = "";
  cliLocWsInput.value = "";
  cliLocColInput.value = "";
  await refreshClientWorkspace(activeClientWorkspace.client.clientId, res.location.locationId);
  await refreshClientsOverview();
  showBanner(clientFeedbackEl, "success", `Added location '${res.location.locationName}'.`);
});

cliAddKwsBtn.addEventListener("click", async () => {
  if (!activeClientWorkspace?.client) return;
  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.CLIENT_IMPORT_KEYWORDS_TEXT,
    payload: {
      clientId: activeClientWorkspace.client.clientId,
      rawText: cliKwPasteInput.value,
      defaultLocationId: activeClientWorkspace.selectedLocation?.locationId || null,
    },
  });
  if (!res?.ok) {
    showBanner(clientFeedbackEl, "error", res?.error || "Unable to add keywords.");
    return;
  }
  cliKwPasteInput.value = "";
  await refreshClientWorkspace(activeClientWorkspace.client.clientId);
  await refreshClientsOverview();
  showBanner(clientFeedbackEl, "success", `Saved ${res.added.length} keyword(s) to client.`);
});

cliKwCsvFileInput.addEventListener("change", async () => {
  const file = cliKwCsvFileInput.files?.[0];
  if (!file || !activeClientWorkspace?.client) return;
  const csvText = await file.text();
  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.CLIENT_IMPORT_KEYWORDS_CSV,
    payload: {
      clientId: activeClientWorkspace.client.clientId,
      csvText,
      defaultLocationId: activeClientWorkspace.selectedLocation?.locationId || null,
    },
  });
  cliKwCsvFileInput.value = "";
  if (!res?.ok) {
    showBanner(clientFeedbackEl, "error", res?.error || "CSV import failed.");
    return;
  }
  await refreshClientWorkspace(activeClientWorkspace.client.clientId);
  await refreshClientsOverview();
  showBanner(clientFeedbackEl, "success", `Imported ${res.added.length} keyword(s) from CSV.`);
});

clientLoadBulkBtn.addEventListener("click", () => {
  if (!activeClientWorkspace?.client) return;
  const activeKeywords = (activeClientWorkspace.keywords || []).filter((k) => k.active !== false);
  if (activeKeywords.length === 0) {
    showBanner(clientFeedbackEl, "error", "No active keywords saved for this client.");
    return;
  }
  parsedBulkQueueInput = activeKeywords.map((k) => ({
    keyword: k.keyword,
    keywordId: k.keywordId,
    keywordGroup: k.keywordGroup,
    rowPosition: k.rowPosition,
    rowNumber: k.rowNumber ?? k.rowPosition,
    spreadsheetId: k.spreadsheetId || null,
    worksheetId: k.worksheetId || null,
    worksheetName: k.worksheetName || null,
    landingPage: k.landingPage,
    searchVolume: k.searchVolume,
    competition: k.competition,
  }));
  bulkKeywordsInput.value = parsedBulkQueueInput.map((k) => k.keyword).join("\n");
  showBanner(
    clientFeedbackEl,
    "success",
    `Loaded ${parsedBulkQueueInput.length} keyword(s) from '${activeClientWorkspace.client.clientName}' into Bulk Keyword Checker.`
  );
});

bulkImportSheetsBtn.addEventListener("click", () => {
  if (!activeClientWorkspace?.client) {
    showBanner(bulkFeedbackEl, "error", "Select a client first to load Google Sheets keywords.");
    return;
  }
  const sheetKeywords = (activeClientWorkspace.keywords || []).filter(
    (k) => k.source === "google_sheets" && k.active !== false && !k.excluded
  );
  if (sheetKeywords.length === 0) {
    showBanner(
      bulkFeedbackEl,
      "error",
      "No imported Google Sheets keywords found for this client. Use Google Sheets Integration -> Preview & Confirm Import first."
    );
    return;
  }
  parsedBulkQueueInput = sheetKeywords.map((k) => ({
    keyword: k.keyword,
    keywordId: k.keywordId,
    keywordGroup: k.keywordGroup,
    rowPosition: k.rowNumber ?? k.rowPosition,
    rowNumber: k.rowNumber ?? k.rowPosition,
    spreadsheetId: k.spreadsheetId,
    worksheetId: k.worksheetId,
    worksheetName: k.worksheetName,
    landingPage: k.landingPage,
    searchVolume: k.searchVolume,
    competition: k.competition,
  }));
  bulkKeywordsInput.value = parsedBulkQueueInput.map((k) => k.keyword).join("\n");
  showBanner(
    bulkFeedbackEl,
    "success",
    `Loaded ${parsedBulkQueueInput.length} Google Sheet keyword(s) with row anchors into Bulk Keyword Checker.`
  );
});

// Phase 8 Google Sheets Integration (Read-Only) UI handlers
async function refreshGoogleAuthStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_GET_AUTH_STATUS });
    if (!res?.ok) return;
    sheetsOauthStatusEl.textContent = res.oauthConfigured
      ? "Configured (spreadsheets.readonly)"
      : "OAuth Client ID not configured";
    sheetsAuthStatusEl.textContent = res.status || "Disconnected";
    sheetsLastConnectedEl.textContent = res.lastConnectedAt
      ? new Date(res.lastConnectedAt).toLocaleString()
      : "Never";

    sheetsAuthPillEl.className = "pill";
    if (res.status === "Connected") {
      sheetsAuthPillEl.classList.add("pill-healthy");
    } else if (res.status === "OAuth not configured" || res.status === "Disconnected") {
      sheetsAuthPillEl.classList.add("pill-neutral");
    } else {
      sheetsAuthPillEl.classList.add("pill-error");
    }
    sheetsAuthPillEl.textContent = res.status || "Disconnected";

    if (res.lastError) {
      showBanner(sheetsFeedbackEl, res.oauthConfigured ? "warning" : "error", res.lastError);
    } else {
      showBanner(sheetsFeedbackEl, null, "");
    }
  } catch {
    // Ignore initial auth check errors.
  }
}

sheetsConnectBtn.addEventListener("click", async () => {
  showBanner(sheetsFeedbackEl, null, "");
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_CONNECT });
  await refreshGoogleAuthStatus();
  if (res?.ok) {
    showBanner(sheetsFeedbackEl, "success", "Google account connected (strictly read-only scope).");
  } else {
    showBanner(sheetsFeedbackEl, "error", res?.error || "Unable to connect Google account.");
  }
});

sheetsDisconnectBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SHEETS_DISCONNECT });
  await refreshGoogleAuthStatus();
  showBanner(sheetsFeedbackEl, "warning", "Disconnected Google account token from Chrome cache.");
});

sheetsTestBtn.addEventListener("click", async () => {
  showBanner(sheetsFeedbackEl, null, "");
  const spreadsheetId = sheetsIdInput.value.trim();
  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.SHEETS_TEST_CONNECTION,
    payload: { spreadsheetId },
  });
  await refreshGoogleAuthStatus();
  if (res?.ok) {
    showBanner(
      sheetsFeedbackEl,
      "success",
      res.spreadsheetTitle
        ? `Connected! Verified read access to '${res.spreadsheetTitle}'.`
        : res.message || "Google OAuth connection verified."
    );
  } else {
    showBanner(sheetsFeedbackEl, "error", res?.error || "Google Sheets connection test failed.");
  }
});

sheetsUrlInput.addEventListener("input", () => {
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(sheetsUrlInput.value.trim());
  if (m) {
    sheetsIdInput.value = m[1];
  }
});

sheetsLoadWsBtn.addEventListener("click", async () => {
  showBanner(sheetsFeedbackEl, null, "");
  const sheetUrlOrId = sheetsUrlInput.value.trim() || sheetsIdInput.value.trim();
  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.SHEETS_LIST_WORKSHEETS,
    payload: { sheetUrlOrId },
  });
  if (!res?.ok) {
    showBanner(sheetsFeedbackEl, "error", res?.error || "Failed loading worksheets.");
    return;
  }
  sheetsIdInput.value = res.spreadsheetId;
  sheetsWsSelect.replaceChildren();
  for (const ws of res.worksheets || []) {
    const opt = document.createElement("option");
    opt.value = ws.sheetId;
    opt.textContent = `${ws.title} (gid=${ws.sheetId})`;
    if (res.urlGid && ws.sheetId === res.urlGid) {
      opt.selected = true;
    } else if (
      activeClientWorkspace?.client?.sheetConfig?.worksheetId &&
      ws.sheetId === activeClientWorkspace.client.sheetConfig.worksheetId
    ) {
      opt.selected = true;
    }
    sheetsWsSelect.appendChild(opt);
  }
  showBanner(
    sheetsFeedbackEl,
    "success",
    `Loaded ${res.worksheets.length} worksheet(s) from '${res.spreadsheetTitle}'.`
  );
});

function renderSpreadsheetPreview(readRes) {
  latestSheetReadResult = readRes;
  const p = readRes.preview;
  excludedSheetRows = new Set(
    (readRes.importedKeywords || []).filter((k) => k.excluded).map((k) => k.rowNumber)
  );

  sheetsPreviewPanel.classList.remove("hidden");
  sheetsPreviewHeadingEl.textContent = `${p.spreadsheetTitle || p.spreadsheetId} — ${p.worksheetName} (${p.locale || "locale ?"})`;
  shMTotalEl.textContent = String(p.totalKeywordRows);
  shMGroupsEl.textContent = p.detectedGroups.length > 0 ? `${p.detectedGroups.length} (${p.detectedGroups.join(", ")})` : "None";
  shMHeadersEl.textContent = p.headerRows.join(", ") || "None";
  shMSeparatorsEl.textContent = p.separatorRows.join(", ") || "None";
  shMLatestDateEl.textContent = p.latestRankingDate || "-";
  shMHistoryColsEl.textContent = String((p.historicalColumns || []).length);
  shMMetaEl.textContent = `${p.formulaCellCount} / ${p.mergedRangeCount}`;
  shMWarningsEl.textContent = `${p.skippedRows.length} / ${p.warnings.length}`;

  if (p.isAmbiguous) {
    sheetsAmbiguousConfirmRow.classList.remove("hidden");
    sheetsAmbiguousConfirmChk.checked = false;
  } else {
    sheetsAmbiguousConfirmRow.classList.add("hidden");
    sheetsAmbiguousConfirmChk.checked = true;
  }

  const diff = readRes.syncDiff;
  if (diff && !diff.isInitialImport) {
    const parts = [
      `Added: ${diff.added.length}`,
      `Removed: ${diff.removed.length}`,
      `Edited: ${diff.editedKeywords.length}`,
      `Moved Rows: ${diff.movedRows.length}`,
      `Landing Page Changes: ${diff.changedLandingPages.length}`,
      diff.structureChanged ? "STRUCTURE CHANGED!" : "Structure matched",
    ];
    showBanner(
      sheetsSyncDiffBannerEl,
      diff.hasChanges || diff.structureChanged ? "warning" : "success",
      `Sync Diff vs Saved Keywords — ${parts.join(" · ")}`
    );
  } else {
    showBanner(sheetsSyncDiffBannerEl, null, "");
  }

  sheetsPreviewTbody.replaceChildren();
  for (const row of p.previewRows || []) {
    const tr = document.createElement("tr");
    const chkTd = document.createElement("td");
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = Boolean(row.excluded);
    chk.addEventListener("change", () => {
      if (chk.checked) {
        excludedSheetRows.add(row.rowNumber);
      } else {
        excludedSheetRows.delete(row.rowNumber);
      }
    });
    chkTd.appendChild(chk);
    tr.appendChild(chkTd);

    const cells = [
      String(row.rowNumber),
      row.keyword,
      row.searchVolume || "-",
      row.competition || "-",
      row.landingPage || "-",
      row.serpUrl || "-",
      row.latestRank || "-",
      row.keywordGroup || "-",
    ];
    for (const val of cells) {
      const td = document.createElement("td");
      td.textContent = val;
      tr.appendChild(td);
    }
    sheetsPreviewTbody.appendChild(tr);
  }

  sheetsConfirmImportBtn.disabled = (p.previewRows || []).length === 0;
}

async function runSheetPreviewRead() {
  showBanner(sheetsFeedbackEl, null, "");
  if (!activeClientWorkspace?.client) {
    showBanner(sheetsFeedbackEl, "error", "Select an active client before reading a Google Sheet.");
    return;
  }
  const selectedOpt = sheetsWsSelect.options[sheetsWsSelect.selectedIndex];
  const wsTitleClean = selectedOpt?.value
    ? selectedOpt.textContent.replace(/\s*\(gid=.*\)$/, "")
    : activeClientWorkspace.client.sheetConfig?.worksheetName || "";

  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.SHEETS_PREVIEW_AND_READ,
    payload: {
      clientId: activeClientWorkspace.client.clientId,
      locationId: activeClientWorkspace.selectedLocation?.locationId || null,
      sheetUrlOrId: sheetsUrlInput.value.trim() || sheetsIdInput.value.trim(),
      worksheetId: sheetsWsSelect.value || activeClientWorkspace.client.sheetConfig?.worksheetId || "",
      worksheetName: wsTitleClean,
      excludedRowNumbers: [...excludedSheetRows],
    },
  });

  if (!res?.ok) {
    showBanner(sheetsFeedbackEl, "error", res?.error || "Failed reading Google Sheet.");
    return;
  }

  renderSpreadsheetPreview(res);
  showBanner(
    sheetsFeedbackEl,
    res.preview.warnings.length > 0 ? "warning" : "success",
    `Read ${res.preview.totalKeywordRows} keyword row(s) from '${res.worksheet.title}' cleanly (read-only).`
  );
}

sheetsPreviewBtn.addEventListener("click", runSheetPreviewRead);
sheetsRefreshBtn.addEventListener("click", runSheetPreviewRead);

sheetsConfirmImportBtn.addEventListener("click", async () => {
  if (!latestSheetReadResult || !activeClientWorkspace?.client) return;
  if (latestSheetReadResult.preview.isAmbiguous && !sheetsAmbiguousConfirmChk.checked) {
    showBanner(
      sheetsFeedbackEl,
      "error",
      "Check the ambiguous-structure confirmation box before importing."
    );
    return;
  }

  const finalKeywords = (latestSheetReadResult.importedKeywords || []).map((k) => {
    const isExcluded = excludedSheetRows.has(k.rowNumber);
    return { ...k, excluded: isExcluded, active: !isExcluded };
  });

  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.SHEETS_APPLY_CONFIRMED_SYNC,
    payload: {
      clientId: activeClientWorkspace.client.clientId,
      incomingKeywords: finalKeywords,
      snapshot: latestSheetReadResult.snapshot,
      confirmed: true,
    },
  });
  if (!res?.ok) {
    showBanner(sheetsFeedbackEl, "error", res?.error || "Failed saving imported sheet keywords.");
    return;
  }

  await refreshClientWorkspace(activeClientWorkspace.client.clientId);
  await refreshClientsOverview();
  showBanner(
    sheetsFeedbackEl,
    "success",
    `Saved ${res.savedCount} Google Sheet keyword row(s) and structure snapshot locally.`
  );
});

clientExportBtn.addEventListener("click", async () => {
  if (!activeClientWorkspace?.client) return;
  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.CLIENT_EXPORT_CONFIG,
    payload: { clientId: activeClientWorkspace.client.clientId },
  });
  if (!res?.ok) {
    showBanner(clientFeedbackEl, "error", res?.error || "Export failed.");
    return;
  }
  const safeName = activeClientWorkspace.client.websiteDomain.replace(/[^a-z0-9.-]+/gi, "-");
  downloadTextFile(`${safeName}-client-config.json`, res.json, "application/json;charset=utf-8");
});

clientImportFileInput.addEventListener("change", async () => {
  const file = clientImportFileInput.files?.[0];
  if (!file) return;
  const json = await file.text();
  clientImportFileInput.value = "";
  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.CLIENT_IMPORT_CONFIG,
    payload: { json },
  });
  if (!res?.ok) {
    showBanner(
      clientFeedbackEl,
      "error",
      res?.errors?.join(" ") || res?.error || "Client JSON import failed."
    );
    return;
  }
  await handleSelectClient(res.client.clientId);
  await refreshClientsOverview({ preserveWorkspace: true });
  showBanner(clientFeedbackEl, "success", `Imported client '${res.client.clientName}'.`);
});

clientBackupBtn.addEventListener("click", async () => {
  if (!activeClientWorkspace?.client) return;
  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.CLIENT_BACKUP_CREATE,
    payload: { clientId: activeClientWorkspace.client.clientId },
  });
  if (!res?.ok) {
    showBanner(clientFeedbackEl, "error", res?.error || "Backup creation failed.");
    return;
  }
  showBanner(clientFeedbackEl, "success", `Created local backup snapshot (${res.backup.backupId}).`);
});

runHealthBtn.addEventListener("click", () => {
  runDashboardHealthCheck();
});

document.addEventListener("DOMContentLoaded", () => {
  versionEl.textContent = chrome.runtime.getManifest().version || "0.1.0";
  runDashboardHealthCheck();
  refreshClientsOverview({ preserveWorkspace: true });
  refreshGoogleAuthStatus();
  refreshLocationStatus({ populateInputs: true });
  refreshRankingState();
  refreshValidationState();
  refreshBulkStatus();
});
