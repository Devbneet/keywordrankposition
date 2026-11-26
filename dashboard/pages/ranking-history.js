/**
 * Ranking History & Two-Date Comparison page controller with native SVG trend chart.
 */

import { renderKeywordTrendChart } from "../components/charts.js";
import { downloadTextFile, formatShortDate } from "../components/status-indicator.js";
import { MESSAGE_TYPES } from "../../utils/messages.js";

export function createRankingHistoryPage() {
  const clientSelect = document.getElementById("rh-client-select");
  const locationSelect = document.getElementById("rh-location-select");
  const keywordInput = document.getElementById("rh-keyword-input");
  const fromInput = document.getElementById("rh-date-from");
  const toInput = document.getElementById("rh-date-to");
  const loadBtn = document.getElementById("btn-rh-load");
  const exportBtn = document.getElementById("btn-rh-export");

  const trendContainerEl = document.getElementById("rh-trend-chart");
  const tbodyEl = document.getElementById("rh-history-tbody");

  const dateAInput = document.getElementById("rh-compare-a");
  const dateBInput = document.getElementById("rh-compare-b");
  const compareBtn = document.getElementById("btn-rh-compare-dates");
  const compareTbodyEl = document.getElementById("rh-compare-tbody");

  let latestRecords = [];

  async function loadHistory({ preselectClientId = null, preselectKeyword = "" } = {}) {
    if (preselectClientId) clientSelect.value = preselectClientId;
    if (preselectKeyword) keywordInput.value = preselectKeyword;

    const clientId = clientSelect.value || null;
    const locationId = locationSelect.value || null;
    const keywordText = keywordInput.value.trim();

    const [histRes, trendRes] = await Promise.all([
      chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.HISTORY_QUERY,
        payload: {
          clientId,
          locationId,
          keywordText,
          dateFrom: fromInput.value,
          dateTo: toInput.value,
          includeManual: false,
          limit: 500,
        },
      }),
      chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.HISTORY_TREND,
        payload: { clientId, locationId, keywordText },
      }),
    ]);

    if (trendRes?.ok) {
      renderKeywordTrendChart(trendContainerEl, trendRes.series || []);
    }

    latestRecords = histRes?.records || [];
    tbodyEl.replaceChildren();
    if (latestRecords.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 8;
      td.className = "muted";
      td.textContent = "No historical observations found for the chosen filter.";
      tr.appendChild(td);
      tbodyEl.appendChild(tr);
      return;
    }

    for (const r of latestRecords) {
      const tr = document.createElement("tr");
      for (const val of [
        formatShortDate(r.timestamp),
        r.keywordText,
        r.rankingPosition !== null ? `#${r.rankingPosition}` : r.resultStatus,
        r.rankingUrl || "-",
        r.locationName || "-",
        r.googleLocationVerification || r.browserGpsVerification || "-",
        r.sourceMode || "-",
        r.resultStatus,
      ]) {
        const td = document.createElement("td");
        td.textContent = val;
        tr.appendChild(td);
      }
      tbodyEl.appendChild(tr);
    }
  }

  async function refreshClientsDropdown(clients = []) {
    const prev = clientSelect.value;
    clientSelect.replaceChildren(new Option("All Clients", ""));
    for (const c of clients) {
      clientSelect.appendChild(new Option(c.clientName, c.clientId));
    }
    if (prev) clientSelect.value = prev;
  }

  compareBtn?.addEventListener("click", async () => {
    if (!dateAInput.value || !dateBInput.value) return;
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.HISTORY_COMPARE_DATES,
      payload: {
        clientId: clientSelect.value || null,
        locationId: locationSelect.value || null,
        dateA: dateAInput.value,
        dateB: dateBInput.value,
      },
    });
    compareTbodyEl.replaceChildren();
    const list = res?.comparisons || [];
    if (list.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "muted";
      td.textContent = "No comparable records found on both selected reporting dates.";
      tr.appendChild(td);
      compareTbodyEl.appendChild(tr);
      return;
    }
    for (const c of list) {
      const tr = document.createElement("tr");
      for (const val of [c.keywordText, String(c.rankA), String(c.rankB), c.movementLabel, c.urlB || "-"]) {
        const td = document.createElement("td");
        td.textContent = val;
        tr.appendChild(td);
      }
      compareTbodyEl.appendChild(tr);
    }
  });

  exportBtn?.addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.REPORTS_GENERATE,
      payload: { reportType: "historical_comparison", clientId: clientSelect.value || null },
    });
    if (res?.ok && res.csv) {
      downloadTextFile(res.filename, res.csv, "text/csv;charset=utf-8");
    }
  });

  loadBtn?.addEventListener("click", () => loadHistory());

  return {
    refreshClientsDropdown,
    loadHistory,
  };
}

