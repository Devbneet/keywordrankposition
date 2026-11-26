/**
 * Downloadable SEO CSV Reports page controller (Phase 10).
 */

import { downloadTextFile, setBanner } from "../components/status-indicator.js";
import { MESSAGE_TYPES } from "../../utils/messages.js";

export function createReportsPage({ getAccuracyComparisons }) {
  const clientFilterEl = document.getElementById("rep-client-filter");
  const feedbackEl = document.getElementById("rep-feedback");
  const buttons = document.querySelectorAll("[data-report-type]");

  function refreshClients(clients = []) {
    const prev = clientFilterEl.value;
    clientFilterEl.replaceChildren(new Option("All Clients", ""));
    for (const c of clients) {
      clientFilterEl.appendChild(new Option(c.clientName, c.clientId));
    }
    if (prev) clientFilterEl.value = prev;
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      setBanner(feedbackEl, null, "");
      const reportType = btn.dataset.reportType;
      const accuracyComparisons =
        reportType === "accuracy_comparison" && getAccuracyComparisons ? getAccuracyComparisons() : [];
      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.REPORTS_GENERATE,
        payload: {
          reportType,
          clientId: clientFilterEl.value || null,
          accuracyComparisons,
        },
      });
      if (!res?.ok) {
        setBanner(feedbackEl, "error", res?.error || "Failed generating CSV report.");
        return;
      }
      if (!res.csv || res.rowCount === 0) {
        setBanner(feedbackEl, "warning", `Report '${res.filename}' currently has 0 rows of real data.`);
        return;
      }
      downloadTextFile(res.filename, res.csv, "text/csv;charset=utf-8");
      setBanner(feedbackEl, "success", `Downloaded ${res.filename} (${res.rowCount} row(s); CSV formula-injection sanitized).`);
    });
  });

  return { refreshClients };
}

