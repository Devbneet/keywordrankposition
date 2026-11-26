/**
 * Agency Ranking Jobs History & Unified Check Workflow page controller.
 */

import { formatShortDate } from "../components/status-indicator.js";
import { MESSAGE_TYPES } from "../../utils/messages.js";

export function createJobsHistoryPage({ onResumeBulk }) {
  const tbodyEl = document.getElementById("jobs-history-tbody");
  const refreshBtn = document.getElementById("btn-jobs-refresh");

  async function refresh() {
    const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.JOBS_LIST_ALL });
    tbodyEl.replaceChildren();
    const jobs = res?.jobs || [];
    if (jobs.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 10;
      td.className = "muted";
      td.textContent = "No ranking jobs recorded yet.";
      tr.appendChild(td);
      tbodyEl.appendChild(tr);
      return;
    }

    for (const j of jobs) {
      const tr = document.createElement("tr");
      const durSec =
        j.completedAt && j.createdAt
          ? `${Math.max(0, Math.round((Date.parse(j.completedAt) - Date.parse(j.createdAt)) / 1000))}s`
          : "-";
      const cells = [
        j.jobId,
        j.clientName || j.clientId || "-",
        j.locationConfig?.locationName || "-",
        String(j.totalKeywords || 0),
        j.state || "-",
        formatShortDate(j.createdAt),
        j.completedAt ? formatShortDate(j.completedAt) : "-",
        durSec,
        j.interruptionReason || j.lastError || "-",
      ];
      for (const val of cells) {
        const td = document.createElement("td");
        td.textContent = val;
        tr.appendChild(td);
      }

      const actionTd = document.createElement("td");
      if (j.state === "Paused" || j.state === "Recovery required" || j.state === "Interrupted") {
        const resumeBtn = document.createElement("button");
        resumeBtn.type = "button";
        resumeBtn.className = "btn-outline btn-compact";
        resumeBtn.textContent = "Resume";
        resumeBtn.addEventListener("click", () => onResumeBulk && onResumeBulk());
        actionTd.appendChild(resumeBtn);
      } else {
        actionTd.textContent = "-";
      }
      tr.appendChild(actionTd);
      tbodyEl.appendChild(tr);
    }
  }

  refreshBtn?.addEventListener("click", refresh);

  return { refresh };
}

