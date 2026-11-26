import {
  getCountryPreset,
  parseCoordinatePair,
} from "../modules/location/coordinate-validator.js";
import {
  GOOGLE_LOCATION_STATUSES,
  LOCATION_STATES,
} from "../modules/location/location-state.js";
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

// Buttons
const applyLocationBtn = document.getElementById("btn-apply-location");
const testLocationBtn = document.getElementById("btn-test-location");
const openTestTabBtn = document.getElementById("btn-open-test-tab");
const resetLocationBtn = document.getElementById("btn-reset-location");
const applyGoogleBtn = document.getElementById("btn-apply-google-location");
const verifyGoogleBtn = document.getElementById("btn-verify-google-location");
const openGoogleBtn = document.getElementById("btn-open-google-search");

// Verification Dashboard status panel elements
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

function showLocationFeedback(kind, message) {
  if (!message) {
    locFeedbackEl.className = "feedback-banner hidden";
    locFeedbackEl.textContent = "";
    return;
  }
  locFeedbackEl.className = `feedback-banner ${kind}`;
  locFeedbackEl.textContent = message;
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

function renderLocationState(locState, { populateInputs = false } = {}) {
  if (!locState) return;
  applyStatePillStyle(locState.state);

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

function setLocationButtonsDisabled(disabled) {
  applyLocationBtn.disabled = disabled;
  testLocationBtn.disabled = disabled;
  openTestTabBtn.disabled = disabled;
  resetLocationBtn.disabled = disabled;
  applyGoogleBtn.disabled = disabled;
  verifyGoogleBtn.disabled = disabled;
  openGoogleBtn.disabled = disabled;
}

function handleCoordinatePasteIfCombined(rawInput) {
  if (!rawInput || !rawInput.includes(",")) {
    return;
  }
  const parsed = parseCoordinatePair(rawInput);
  if (parsed.valid) {
    locLatInput.value = String(parsed.latitude);
    locLngInput.value = String(parsed.longitude);
    showLocationFeedback("success", "Split pasted coordinates into Latitude and Longitude.");
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
    showLocationFeedback(
      "error",
      error instanceof Error ? error.message : "Unable to load location status."
    );
  }
}

async function sendLocationAction(type, payload = undefined) {
  handleCoordinatePasteIfCombined(locLatInput.value);
  showLocationFeedback(null, "");
  setLocationButtonsDisabled(true);

  try {
    const response = await chrome.runtime.sendMessage({ type, payload });
    if (response?.state) {
      renderLocationState(response.state);
    }

    if (response?.errors) {
      showLocationFeedback("error", response.errors.join(" "));
      return;
    }

    if (response?.ok) {
      if (type === MESSAGE_TYPES.LOCATION_RESET) {
        showLocationFeedback("success", "Location override cleared and debugger detached.");
      } else if (type === MESSAGE_TYPES.LOCATION_OPEN_TEST_TAB || type === MESSAGE_TYPES.GOOGLE_LOCATION_OPEN_SEARCH) {
        showLocationFeedback("warning", "Dedicated tab opened. Use Apply/Verify controls to verify.");
      } else if (type === MESSAGE_TYPES.GOOGLE_LOCATION_APPLY || type === MESSAGE_TYPES.GOOGLE_LOCATION_VERIFY) {
        showLocationFeedback("success", "Browser GPS and Google Search location matched target.");
      } else {
        showLocationFeedback("success", "Browser GPS verified on dedicated tab.");
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
      showLocationFeedback(kind, msg);
    }
  } catch (error) {
    showLocationFeedback(
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

runHealthBtn.addEventListener("click", () => {
  runDashboardHealthCheck();
});

document.addEventListener("DOMContentLoaded", () => {
  versionEl.textContent = chrome.runtime.getManifest().version || "0.1.0";
  runDashboardHealthCheck();
  refreshLocationStatus({ populateInputs: true });
});
