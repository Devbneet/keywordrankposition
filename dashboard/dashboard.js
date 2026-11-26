import {
  getCountryPreset,
  parseCoordinatePair,
} from "../modules/location/coordinate-validator.js";
import {
  GOOGLE_LOCATION_STATUSES,
  LOCATION_STATES,
} from "../modules/location/location-state.js";
import { RANKING_STATUSES } from "../modules/ranking/ranking-state.js";
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

  if (
    state === LOCATION_STATES.GPS_VERIFIED ||
    state === LOCATION_STATES.GOOGLE_MATCHED
  ) {
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

function renderLocationContextSummary(locState) {
  const cfg = locState?.config;
  if (cfg) {
    rankCtxLocationEl.textContent =
      [cfg.locationName, cfg.targetCity].filter(Boolean).join(" / ") || "Configured";
    rankCtxCoordsEl.textContent = `${cfg.latitude}, ${cfg.longitude}`;
    rankCtxLocaleEl.textContent = `${cfg.country} (${cfg.language})`;
  } else {
    rankCtxLocationEl.textContent = "Not configured";
    rankCtxCoordsEl.textContent = "-";
    rankCtxLocaleEl.textContent = `${locCountrySelect.value} (${locLanguageSelect.value})`;
  }

  if (locState?.googleDetectedLocation) {
    rankCtxGoogleEl.textContent = `${locState.googleDetectedLocation} (${locState.googleLocationStatus})`;
  } else {
    rankCtxGoogleEl.textContent = locState?.googleLocationStatus || "Unverified";
  }
}

function renderLocationState(locState, { populateInputs = false } = {}) {
  if (!locState) return;
  applyStatePillStyle(locState.state);
  renderLocationContextSummary(locState);

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
  statusGoogleSourceEl.textContent = locState.googleLocationSource || "-";
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

  resStatusEl.textContent = result.status;
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
});

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
      setRankingRunningUi(Boolean(response.state.isRunning));
      if (response.state.lastResult) {
        renderRankingResult(response.state.lastResult);
      }
    }
  } catch {
    // Ignore initial load errors.
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
      },
    });

    if (response?.error && !response?.result) {
      showBanner(rankFeedbackEl, "error", response.error);
      setRankingPillStyle("Ready");
      return;
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
  await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RANKING_CLEAR });
  showBanner(rankFeedbackEl, null, "");
  renderRankingResult(null);
});

runHealthBtn.addEventListener("click", () => {
  runDashboardHealthCheck();
});

document.addEventListener("DOMContentLoaded", () => {
  versionEl.textContent = chrome.runtime.getManifest().version || "0.1.0";
  runDashboardHealthCheck();
  refreshLocationStatus({ populateInputs: true });
  refreshRankingState();
});
