/**
 * Keyword Rankings page controller (14-column sortable/searchable/paginated table).
 */

import { renderPaginatedRankingTable } from "../components/ranking-table.js";
import { MESSAGE_TYPES } from "../../utils/messages.js";

export function createKeywordRankingsPage({ onInspectHistoryKeyword }) {
  const searchEl = document.getElementById("kr-search");
  const clientFilterEl = document.getElementById("kr-client-filter");
  const locFilterEl = document.getElementById("kr-location-filter");
  const groupFilterEl = document.getElementById("kr-group-filter");
  const dateFilterEl = document.getElementById("kr-date-filter");
  const posFilterEl = document.getElementById("kr-pos-filter");
  const movFilterEl = document.getElementById("kr-movement-filter");
  const sortEl = document.getElementById("kr-sort");
  const tbodyEl = document.getElementById("kr-tbody");
  const paginationEl = document.getElementById("kr-pagination");
  const refreshBtn = document.getElementById("btn-kr-refresh");

  let allSnapshots = [];
  let currentPage = 1;

  function applyFiltersAndRender() {
    const q = searchEl.value.trim().toLowerCase();
    const cid = clientFilterEl.value;
    const lid = locFilterEl.value;
    const grp = groupFilterEl.value;
    const dt = dateFilterEl.value;
    const band = posFilterEl.value;
    const mov = movFilterEl.value;

    let rows = allSnapshots.filter((r) => {
      if (q && !r.keywordText.toLowerCase().includes(q) && !String(r.rankingUrl || "").toLowerCase().includes(q)) {
        return false;
      }
      if (cid && r.clientId !== cid) return false;
      if (lid && r.locationId !== lid) return false;
      if (grp && r.keywordGroup !== grp) return false;
      if (dt && !String(r.timestamp || "").startsWith(dt)) return false;
      if (mov && r.movementType !== mov) return false;

      if (band === "top3") return typeof r.currentRank === "number" && r.currentRank <= 3;
      if (band === "top10") return typeof r.currentRank === "number" && r.currentRank <= 10;
      if (band === "top20") return typeof r.currentRank === "number" && r.currentRank <= 20;
      if (band === "top100") return typeof r.currentRank === "number" && r.currentRank <= 100;
      if (band === "na") return r.currentRank === "NA";
      return true;
    });

    const sortMode = sortEl.value;
    rows = rows.slice().sort((a, b) => {
      if (sortMode === "rank_asc") {
        const va = typeof a.currentRank === "number" ? a.currentRank : 9999;
        const vb = typeof b.currentRank === "number" ? b.currentRank : 9999;
        return va - vb;
      }
      if (sortMode === "rank_desc") {
        const va = typeof a.currentRank === "number" ? a.currentRank : -1;
        const vb = typeof b.currentRank === "number" ? b.currentRank : -1;
        return vb - va;
      }
      if (sortMode === "keyword_asc") return a.keywordText.localeCompare(b.keywordText);
      if (sortMode === "change_desc") return (b.delta ?? -999) - (a.delta ?? -999);
      return String(b.timestamp || "").localeCompare(String(a.timestamp || ""));
    });

    renderPaginatedRankingTable({
      tbodyEl,
      paginationEl,
      rows,
      page: currentPage,
      pageSize: 25,
      onPageChange: (nextPage) => {
        currentPage = nextPage;
        applyFiltersAndRender();
      },
      onSelectKeyword: (row) => {
        if (onInspectHistoryKeyword) onInspectHistoryKeyword(row);
      },
    });
  }

  async function refresh({ clients = [] } = {}) {
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.HISTORY_QUERY,
      payload: { includeManual: false, limit: 5000 },
    });
    if (!res?.ok) return;
    allSnapshots = res.snapshots || [];

    const prevCid = clientFilterEl.value;
    clientFilterEl.replaceChildren(new Option("All Clients", ""));
    for (const c of clients) {
      clientFilterEl.appendChild(new Option(c.clientName, c.clientId));
    }
    if (prevCid) clientFilterEl.value = prevCid;

    const groups = [...new Set(allSnapshots.map((s) => s.keywordGroup).filter(Boolean))].sort();
    const prevGrp = groupFilterEl.value;
    groupFilterEl.replaceChildren(new Option("All Groups", ""));
    for (const g of groups) {
      groupFilterEl.appendChild(new Option(g, g));
    }
    if (prevGrp) groupFilterEl.value = prevGrp;

    const locs = new Map();
    for (const s of allSnapshots) {
      if (s.locationId) locs.set(s.locationId, s.locationName || s.locationId);
    }
    locFilterEl.replaceChildren(new Option("All Locations", ""));
    for (const [id, name] of locs.entries()) {
      locFilterEl.appendChild(new Option(name, id));
    }

    currentPage = 1;
    applyFiltersAndRender();
  }

  [searchEl, clientFilterEl, locFilterEl, groupFilterEl, dateFilterEl, posFilterEl, movFilterEl, sortEl].forEach((el) => {
    el?.addEventListener("input", () => {
      currentPage = 1;
      applyFiltersAndRender();
    });
    el?.addEventListener("change", () => {
      currentPage = 1;
      applyFiltersAndRender();
    });
  });
  refreshBtn?.addEventListener("click", () => refresh());

  return { refresh };
}

