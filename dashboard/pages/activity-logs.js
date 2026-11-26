/**
 * Sanitized Activity Logs page controller.
 */

import { downloadTextFile, formatShortDate } from "../components/status-indicator.js";
import { MESSAGE_TYPES } from "../../utils/messages.js";

export function createActivityLogsPage() {
  const catSelect = document.getElementById("log-category-filter");
  const levelSelect = document.getElementById("log-level-filter");
  const clientSelect = document.getElementById("log-client-filter");
  const refreshBtn = document.getElementById("btn-log-refresh");
  const exportBtn = document.getElementById("btn-log-export");
  const tbodyEl = document.getElementById("log-tbody");

  async function refresh(clients = []) {
    if (clients.length > 0) {
      const prev = clientSelect.value;
      clientSelect.replaceChildren(new Option("All Clients", ""));
      for (const c of clients) {
        clientSelect.appendChild(new Option(c.clientName, c.clientId));
      }
      if (prev) clientSelect.value = prev;
    }

    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.ACTIVITY_LIST,
      payload: {
        category: catSelect.value,
        level: levelSelect.value,
        clientId: clientSelect.value,
        limit: 300,
      },
    });
    tbodyEl.replaceChildren();
    const logs = res?.logs || [];
    if (logs.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "muted";
      td.textContent = "No activity logs match the filter.";
      tr.appendChild(td);
      tbodyEl.appendChild(tr);
      return;
    }
    for (const l of logs) {
      const tr = document.createElement("tr");
      for (const val of [
        formatShortDate(l.timestamp),
        l.category,
        l.level,
        l.clientId || "-",
        l.message,
      ]) {
        const td = document.createElement("td");
        td.textContent = val;
        tr.appendChild(td);
      }
      tbodyEl.appendChild(tr);
    }
  }

  exportBtn?.addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.ACTIVITY_EXPORT_CSV,
      payload: {
        category: catSelect.value,
        level: levelSelect.value,
        clientId: clientSelect.value,
      },
    });
    if (res?.ok) {
      downloadTextFile(res.filename, res.csv, "text/csv;charset=utf-8");
    }
  });

  [catSelect, levelSelect, clientSelect].forEach((el) => el?.addEventListener("change", () => refresh()));
  refreshBtn?.addEventListener("click", () => refresh());

  return { refresh };
}

