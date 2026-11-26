/**
 * Centralized Agency Settings & Diagnostics page controller.
 */

import { setBanner } from "../components/status-indicator.js";
import { MESSAGE_TYPES } from "../../utils/messages.js";

export function createSettingsPage() {
  const depthInput = document.getElementById("set-depth");
  const accInput = document.getElementById("set-accuracy");
  const countryInput = document.getElementById("set-country");
  const langInput = document.getElementById("set-language");
  const tolInput = document.getElementById("set-tolerance");
  const tzInput = document.getElementById("set-timezone");
  const dateFmtInput = document.getElementById("set-date-format");
  const saveBtn = document.getElementById("btn-set-save");
  const feedbackEl = document.getElementById("set-feedback");

  const diagVersionEl = document.getElementById("diag-version");
  const diagDbBackendEl = document.getElementById("diag-db-backend");
  const diagSchemaEl = document.getElementById("diag-schema-version");
  const diagStorageEl = document.getElementById("diag-storage-estimate");

  async function refresh() {
    const [setRes, diagRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SETTINGS_GET }),
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.DIAGNOSTICS_INFO }),
    ]);

    if (setRes?.ok && setRes.settings) {
      const s = setRes.settings;
      depthInput.value = String(s.defaultSearchDepth || 50);
      accInput.value = String(s.defaultAccuracyMetres || 20);
      countryInput.value = s.defaultCountry || "Australia";
      langInput.value = s.defaultLanguage || "en";
      tolInput.value = String(s.comparisonTolerance ?? 1);
      tzInput.value = s.reportingTimezone || "Australia/Sydney";
      dateFmtInput.value = s.dateFormat || "DD-MMMM";
    }

    if (diagRes?.ok) {
      diagVersionEl.textContent = diagRes.version || "-";
      diagDbBackendEl.textContent = diagRes.databaseBackend || "-";
      diagSchemaEl.textContent = `v${diagRes.schemaVersion || "-"} (${(diagRes.stores || []).length} stores)`;
    }

    if (navigator.storage?.estimate) {
      try {
        const est = await navigator.storage.estimate();
        const usedMb = ((est.usage || 0) / (1024 * 1024)).toFixed(2);
        diagStorageEl.textContent = `${usedMb} MB used`;
      } catch {
        diagStorageEl.textContent = "Unavailable";
      }
    }
  }

  saveBtn?.addEventListener("click", async () => {
    setBanner(feedbackEl, null, "");
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.SETTINGS_SAVE,
      payload: {
        defaultSearchDepth: Number(depthInput.value) || 50,
        defaultAccuracyMetres: Number(accInput.value) || 20,
        defaultCountry: countryInput.value,
        defaultLanguage: langInput.value,
        comparisonTolerance: Number(tolInput.value) ?? 1,
        reportingTimezone: tzInput.value.trim() || "UTC",
        dateFormat: dateFmtInput.value,
      },
    });
    if (res?.ok) {
      setBanner(feedbackEl, "success", "Agency default settings saved locally.");
    } else {
      setBanner(feedbackEl, "error", res?.error || "Failed saving settings.");
    }
  });

  return { refresh };
}

