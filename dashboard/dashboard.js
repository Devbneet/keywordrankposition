import { parseCoordinatePair } from "../modules/location/coordinate-validator.js";
import { LOCATION_STATES } from "../modules/location/location-state.js";
import { MESSAGE_TYPES } from "../utils/messages.js";

const versionEl = document.getElementById("dash-version");
const pillEl = document.getElementById("dash-health-pill");
const messageEl = document.getElementById("dash-health-message");
const workerEl = document.getElementById("detail-worker");
const storageEl = document.getElementById("detail-storage");
const timestampEl = document.getElementById("detail-timestamp");
const runHealthBtn = document.getElementById("dash-run-health-btn");

// Location form & controls
const locationForm = document.getElementById("location-form");
const locNameInput = document.getElementById("loc-name");
const locLatInput = document.getElementById("loc-lat");
const locLngInput = document.getElementById("loc-lng");
const locAccuracyInput = document.getElementById("loc-accuracy");
const locCountrySelect = document.getElementById("loc-country");
const locLanguageSelect = document.getElementById("loc-language");
const locTestUrlInput = document.getElementById("loc-test-url");
const locFeedbackEl = document.getElementById("loc-feedback");

const applyLocationBtn = document.getElementById("btn-apply-location");
const testLocationBtn = document.getElementById("btn-test-location");
const openTestTabBtn = document.getElementById("btn-open-test-tab");
const resetLocationBtn = document.getElementById("btn-reset-location");

// Location status panel elements
const locStatePillEl = document.getElementById("loc-state-pill");
const statusConfiguredCoordsEl = document.getElementById("status-configured-coords");
const statusReportedCoordsEl = document.getElementById("status-reported-coords");
const statusReportedAccuracyEl = document.getElementById("status-reported-accuracy");
const statusTabIdEl = document.getElementById("status-tab-id");
const statusDebuggerEl = document.getElementById("status-debugger");
const statusPermissionEl = document.getElementById("status-permission");
const statusLastVerifiedEl = document.getElementById("status-last-verified");
const statusGoogleLocationEl = document.getElementById("status-google-location");

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

  if (state === LOCATION_STATES.GPS_VERIFIED) {
    locStatePillEl.classList.add("pill-healthy");
  } else if (
    state === LOCATION_STATES.PERMISSION_DENIED ||
    state === LOCATION_STATES.LOCATION_MISMATCH ||
    state === LOCATION_STATES.VERIFICATION_FAILED
  ) {
    locStatePillEl.classList.add("pill-error");
  } else if (
    state === LOCATION_STATES.GPS_APPLIED ||
    state === LOCATION_STATES.DEBUGGER_DETACHED
  ) {
    locStatePillEl.classList.add("pill-pending");
  } else {
    locStatePillEl.classList.add("pill-neutral");
  }
}

function renderLocationState(locState, { populateInputs = false } = {}) {
  if (!locState) return;
  applyStatePillStyle(locState.state);

  if (locState.config) {
    statusConfiguredCoordsEl.textContent = `${locState.config.latitude}, ${locState.config.longitude}`;
    if (populateInputs) {
      locNameInput.value = locState.config.locationName || "";
      locLatInput.value = String(locState.config.latitude);
      locLngInput.value = String(locState.config.longitude);
      locAccuracyInput.value = String(locState.config.accuracy);
      if (locState.config.country) locCountrySelect.value = locState.config.country;
      if (locState.config.language) locLanguageSelect.value = locState.config.language;
      if (locState.config.testPageUrl) locTestUrlInput.value = locState.config.testPageUrl;
    }
  } else {
    statusConfiguredCoordsEl.textContent = "Not configured";
  }

  if (locState.reportedCoords) {
    statusReportedCoordsEl.textContent = `${locState.reportedCoords.latitude}, ${locState.reportedCoords.longitude}`;
    statusReportedAccuracyEl.textContent = `${locState.reportedCoords.accuracy} m`;
  } else {
    statusReportedCoordsEl.textContent = "Not tested";
    statusReportedAccuracyEl.textContent = "-";
  }

  statusTabIdEl.textContent = locState.tabId !== null && locState.tabId !== undefined ? String(locState.tabId) : "None";
  statusDebuggerEl.textContent = locState.debuggerAttached ? "Connected" : "Not connected";
  statusPermissionEl.textContent = locState.permissionStatus || "unknown";
  statusLastVerifiedEl.textContent = locState.lastVerifiedAt
    ? new Date(locState.lastVerifiedAt).toLocaleString()
    : "-";
  statusGoogleLocationEl.textContent = locState.googleLocationStatus || "Unverified";

  if (locState.lastError) {
    showLocationFeedback("error", locState.lastError);
  }
}

function setLocationButtonsDisabled(disabled) {
  applyLocationBtn.disabled = disabled;
  testLocationBtn.disabled = disabled;
  openTestTabBtn.disabled = disabled;
  resetLocationBtn.disabled = disabled;
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

locationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  handleCoordinatePasteIfCombined(locLatInput.value);
  showLocationFeedback(null, "");
  setLocationButtonsDisabled(true);

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.LOCATION_APPLY,
      payload: {
        locationName: locNameInput.value,
        latitude: locLatInput.value,
        longitude: locLngInput.value,
        accuracy: locAccuracyInput.value,
        country: locCountrySelect.value,
        language: locLanguageSelect.value,
        testPageUrl: locTestUrlInput.value,
      },
    });

    if (response?.state) {
      renderLocationState(response.state);
    }

    if (response?.ok) {
      showLocationFeedback(
        "success",
        "Browser GPS override applied and verified on the dedicated test tab."
      );
    } else if (response?.errors) {
      showLocationFeedback("error", response.errors.join(" "));
    } else {
      showLocationFeedback(
        "error",
        response?.error || response?.state?.lastError || "Location override could not be verified."
      );
    }
  } catch (error) {
    showLocationFeedback(
      "error",
      error instanceof Error ? error.message : "Failed to apply location."
    );
  } finally {
    setLocationButtonsDisabled(false);
  }
});

testLocationBtn.addEventListener("click", async () => {
  showLocationFeedback(null, "");
  setLocationButtonsDisabled(true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.LOCATION_TEST,
    });
    if (response?.state) {
      renderLocationState(response.state);
    }
    if (response?.ok) {
      showLocationFeedback("success", "Browser GPS verified on the dedicated test tab.");
    } else {
      showLocationFeedback(
        "error",
        response?.error || response?.state?.lastError || "Browser GPS test failed."
      );
    }
  } catch (error) {
    showLocationFeedback(
      "error",
      error instanceof Error ? error.message : "Failed to test location."
    );
  } finally {
    setLocationButtonsDisabled(false);
  }
});

openTestTabBtn.addEventListener("click", async () => {
  showLocationFeedback(null, "");
  setLocationButtonsDisabled(true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.LOCATION_OPEN_TEST_TAB,
      payload: { testPageUrl: locTestUrlInput.value },
    });
    if (response?.state) {
      renderLocationState(response.state);
    }
    if (response?.ok) {
      showLocationFeedback(
        "warning",
        "Dedicated test tab opened. Click Apply Location to attach the debugger and simulate coordinates."
      );
    }
  } catch (error) {
    showLocationFeedback(
      "error",
      error instanceof Error ? error.message : "Failed to open test tab."
    );
  } finally {
    setLocationButtonsDisabled(false);
  }
});

resetLocationBtn.addEventListener("click", async () => {
  showLocationFeedback(null, "");
  setLocationButtonsDisabled(true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.LOCATION_RESET,
    });
    if (response?.state) {
      renderLocationState(response.state);
    }
    showLocationFeedback(
      "success",
      "Location override cleared, debugger detached, and normal browser geolocation restored."
    );
  } catch (error) {
    showLocationFeedback(
      "error",
      error instanceof Error ? error.message : "Failed to reset location."
    );
  } finally {
    setLocationButtonsDisabled(false);
  }
});

runHealthBtn.addEventListener("click", () => {
  runDashboardHealthCheck();
});

document.addEventListener("DOMContentLoaded", () => {
  versionEl.textContent = chrome.runtime.getManifest().version || "0.1.0";
  runDashboardHealthCheck();
  refreshLocationStatus({ populateInputs: true });
});
