import { MESSAGE_TYPES } from "../utils/messages.js";

const versionEl = document.getElementById("extension-version");
const healthPillEl = document.getElementById("health-pill");
const healthDetailEl = document.getElementById("health-detail");
const openDashboardBtn = document.getElementById("open-dashboard-btn");
const recheckHealthBtn = document.getElementById("recheck-health-btn");

function renderVersion() {
  const manifest = chrome.runtime.getManifest();
  versionEl.textContent = manifest.version || "0.1.0";
}

function setHealthState(state, detailText) {
  healthPillEl.className = "pill";
  if (state === "healthy") {
    healthPillEl.classList.add("pill-healthy");
    healthPillEl.textContent = "Healthy";
  } else if (state === "error") {
    healthPillEl.classList.add("pill-error");
    healthPillEl.textContent = "Error";
  } else {
    healthPillEl.classList.add("pill-pending");
    healthPillEl.textContent = "Checking...";
  }
  healthDetailEl.textContent = detailText;
}

async function runHealthCheck() {
  setHealthState("pending", "Contacting background service worker...");
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.HEALTH_CHECK,
    });
    if (response?.ok) {
      setHealthState(
        "healthy",
        `Service worker & local storage verified (${new Date(response.checkedAt).toLocaleTimeString()}).`
      );
    } else {
      setHealthState("error", response?.error || "Health check failed.");
    }
  } catch (error) {
    setHealthState(
      "error",
      error instanceof Error ? error.message : "Unable to reach service worker."
    );
  }
}

openDashboardBtn.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OPEN_DASHBOARD });
    window.close();
  } catch (error) {
    setHealthState(
      "error",
      error instanceof Error ? error.message : "Failed to open dashboard."
    );
  }
});

recheckHealthBtn.addEventListener("click", () => {
  runHealthCheck();
});

document.addEventListener("DOMContentLoaded", () => {
  renderVersion();
  runHealthCheck();
});

