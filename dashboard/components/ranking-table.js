/**
 * Paginated, sortable keyword ranking table component.
 */

export function renderPaginatedRankingTable({
  tbodyEl,
  paginationEl,
  rows = [],
  page = 1,
  pageSize = 25,
  onPageChange,
  onSelectKeyword,
}) {
  tbodyEl.replaceChildren();
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);

  if (slice.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 14;
    td.className = "muted";
    td.textContent = "No matching keyword rankings found. Adjust filters or run a ranking check.";
    tr.appendChild(td);
    tbodyEl.appendChild(tr);
  } else {
    slice.forEach((r, idx) => {
      const tr = document.createElement("tr");
      const serial = start + idx + 1;
      const cols = [
        String(serial),
        r.keywordText,
        r.keywordGroup || "-",
        r.searchVolume || "-",
        r.competition || "-",
        r.landingPage || "-",
        String(r.previousRank ?? "-"),
        String(r.currentRank ?? "-"),
        r.movementLabel || "-",
        r.rankingUrl || "-",
        r.locationName || "-",
        r.verificationStatus || "-",
        r.timestamp ? new Date(r.timestamp).toLocaleDateString() : "-",
        r.resultStatus || "-",
      ];
      cols.forEach((val, colIdx) => {
        const td = document.createElement("td");
        td.textContent = val;
        if (colIdx === 8) {
          if (r.movementType === "Improved" || r.movementType === "New ranking") td.className = "txt-good";
          else if (r.movementType === "Declined" || r.movementType === "Lost ranking") td.className = "txt-bad";
        }
        tr.appendChild(td);
      });
      if (onSelectKeyword) {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", () => onSelectKeyword(r));
      }
      tbodyEl.appendChild(tr);
    });
  }

  if (paginationEl) {
    paginationEl.replaceChildren();
    const info = document.createElement("span");
    info.className = "muted";
    info.textContent = `Showing ${rows.length === 0 ? 0 : start + 1}–${start + slice.length} of ${rows.length} (Page ${safePage}/${totalPages})`;

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "btn-outline btn-compact";
    prevBtn.textContent = "Previous";
    prevBtn.disabled = safePage <= 1;
    prevBtn.addEventListener("click", () => onPageChange(safePage - 1));

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "btn-outline btn-compact";
    nextBtn.textContent = "Next";
    nextBtn.disabled = safePage >= totalPages;
    nextBtn.addEventListener("click", () => onPageChange(safePage + 1));

    paginationEl.append(info, prevBtn, nextBtn);
  }
}

