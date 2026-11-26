/**
 * Agency Overview page controller (Phase 10).
 * Displays 15+ real stored KPIs, ranking distribution, recent movements,
 * and quick launchers for the 12-Step Ranking Workflow & Google Sheets.
 */

import { renderDistributionBars } from "../components/charts.js";
import { createStatisticsCard } from "../components/statistics-card.js";
import { formatShortDate } from "../components/status-indicator.js";
import { MESSAGE_TYPES } from "../../utils/messages.js";

export function createOverviewPage({ onNavigate, onOpenRankingWorkflow }) {
  const kpiGridEl = document.getElementById("ov-kpi-grid");
  const secondaryGridEl = document.getElementById("ov-secondary-kpi-grid");
  const distContainerEl = document.getElementById("ov-distribution-chart");
  const movTbodyEl = document.getElementById("ov-movements-tbody");
  const emptyNoticeEl = document.getElementById("ov-empty-notice");
  const startCheckBtn = document.getElementById("btn-ov-start-check");
  const openSheetsBtn = document.getElementById("btn-ov-google-sheets");
  const refreshBtn = document.getElementById("btn-ov-refresh");

  async function refresh() {
    const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.DASHBOARD_AGENCY_OVERVIEW });
    if (!res?.ok) return;
    const m = res.metrics;

    kpiGridEl.replaceChildren(
      createStatisticsCard({ label: "Active Clients", value: String(m.totalActiveClients) }),
      createStatisticsCard({ label: "Tracked Keywords", value: String(m.totalTrackedKeywords) }),
      createStatisticsCard({ label: "Top 10 Keywords", value: m.hasData ? String(m.top10Count) : "0" }),
      createStatisticsCard({
        label: "Improved Rankings",
        value: m.hasData ? String(m.improvedCount) : "0",
        tone: m.improvedCount > 0 ? "good" : "default",
      })
    );

    secondaryGridEl.replaceChildren(
      createStatisticsCard({ label: "Configured Locations", value: String(m.totalConfiguredLocations) }),
      createStatisticsCard({ label: "Checked Today", value: String(m.keywordsCheckedToday) }),
      createStatisticsCard({ label: "Top 3", value: String(m.top3Count), tone: "good" }),
      createStatisticsCard({ label: "Top 20", value: String(m.top20Count) }),
      createStatisticsCard({ label: "Top 100", value: String(m.top100Count) }),
      createStatisticsCard({ label: "Declined", value: String(m.declinedCount), tone: m.declinedCount > 0 ? "bad" : "default" }),
      createStatisticsCard({ label: "Unchanged", value: String(m.unchangedCount) }),
      createStatisticsCard({ label: "Confirmed Not Found", value: String(m.confirmedNotFoundCount) }),
      createStatisticsCard({ label: "Failed Checks", value: String(m.failedChecksCount), tone: m.failedChecksCount > 0 ? "warn" : "default" }),
      createStatisticsCard({ label: "Pending Sheet Updates", value: String(m.pendingSheetUpdatesCount), tone: m.pendingSheetUpdatesCount > 0 ? "warn" : "default" }),
      createStatisticsCard({
        label: "Last Successful Job",
        value: m.lastSuccessfulJob ? m.lastSuccessfulJob.clientDomain || m.lastSuccessfulJob.jobId : "No data",
        subtext: m.lastSuccessfulJob ? formatShortDate(m.lastSuccessfulJob.completedAt || m.lastSuccessfulJob.createdAt) : "",
      })
    );

    renderDistributionBars(distContainerEl, m.distribution);
    emptyNoticeEl.classList.toggle("hidden", m.hasData);

    movTbodyEl.replaceChildren();
    if (!m.recentMovements || m.recentMovements.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "muted";
      td.textContent = "No ranking movement recorded yet. Run a bulk or single live ranking check first.";
      tr.appendChild(td);
      movTbodyEl.appendChild(tr);
    } else {
      for (const row of m.recentMovements) {
        const tr = document.createElement("tr");
        const cells = [
          row.keywordText,
          String(row.previousRank),
          String(row.currentRank),
          row.movementLabel,
        ];
        cells.forEach((val, idx) => {
          const td = document.createElement("td");
          td.textContent = val;
          if (idx === 3) {
            if (row.movementType === "Improved" || row.movementType === "New ranking") td.className = "txt-good";
            else if (row.movementType === "Declined" || row.movementType === "Lost ranking") td.className = "txt-bad";
          }
          tr.appendChild(td);
        });
        movTbodyEl.appendChild(tr);
      }
    }
  }

  startCheckBtn?.addEventListener("click", () => {
    if (onOpenRankingWorkflow) onOpenRankingWorkflow();
    else onNavigate("jobs");
  });
  openSheetsBtn?.addEventListener("click", () => onNavigate("google-sheets"));
  refreshBtn?.addEventListener("click", refresh);

  return { refresh };
}

