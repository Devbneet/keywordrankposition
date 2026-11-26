/**
 * Clean SaaS Client Overview Card component.
 */

function getInitials(name) {
  const parts = String(name || "DM").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

export function createClientOverviewCard({
  overview,
  isActive,
  onSelectManage,
  onStartCheck,
  onEdit,
  onDuplicate,
  onArchive,
  onDelete,
}) {
  const card = document.createElement("div");
  card.className = `client-overview-card${isActive ? " active-card" : ""}`;

  const head = document.createElement("div");
  head.className = "client-card-head";

  const identity = document.createElement("div");
  identity.className = "client-card-identity";
  const avatar = document.createElement("div");
  avatar.className = "client-avatar";
  avatar.textContent = getInitials(overview.clientName);

  const titleWrap = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = overview.clientName;
  const domainDiv = document.createElement("div");
  domainDiv.className = "muted";
  domainDiv.textContent = overview.websiteDomain;
  titleWrap.append(strong, domainDiv);
  identity.append(avatar, titleWrap);

  const rightHead = document.createElement("div");
  rightHead.className = "actions";
  if (overview.status !== "active") {
    const statusPill = document.createElement("span");
    statusPill.className = `pill ${overview.status === "archived" ? "pill-neutral" : "pill-pending"}`;
    statusPill.textContent = overview.status;
    rightHead.appendChild(statusPill);
  }
  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "btn-outline btn-compact";
  moreBtn.title = "Client actions";
  moreBtn.textContent = "···";
  rightHead.appendChild(moreBtn);
  head.append(identity, rightHead);

  const kpiRow = document.createElement("div");
  kpiRow.className = "client-kpis-row";
  for (const kpi of [
    { label: "Keywords", value: String(overview.keywordCount), good: false },
    { label: "Locations", value: String(overview.locationCount), good: false },
    {
      label: "Top 10",
      value: overview.hasRankingData ? String(overview.top10Count) : "No data",
      good: Boolean(overview.hasRankingData && overview.top10Count > 0),
    },
  ]) {
    const box = document.createElement("div");
    const lbl = document.createElement("span");
    lbl.className = "client-kpi-label";
    lbl.textContent = kpi.label;
    const val = document.createElement("span");
    val.className = `client-kpi-value${kpi.good ? " kpi-good" : ""}`;
    val.textContent = kpi.value;
    box.append(lbl, val);
    kpiRow.appendChild(box);
  }

  const locLine = document.createElement("div");
  locLine.className = "client-card-locations";
  const locSummary =
    Array.isArray(overview.locationNames) && overview.locationNames.length > 0
      ? overview.locationNames.join(", ")
      : "No locations configured";
  locLine.textContent = `⌖ ${locSummary}`;

  const primaryActions = document.createElement("div");
  primaryActions.className = "client-card-primary-actions";

  const manageBtn = document.createElement("button");
  manageBtn.type = "button";
  manageBtn.className = "btn-outline";
  manageBtn.textContent = isActive ? "Client Dashboard" : "Manage Client";
  manageBtn.addEventListener("click", () => onSelectManage(overview.clientId));

  const startCheckBtn = document.createElement("button");
  startCheckBtn.type = "button";
  startCheckBtn.className = "btn-navy";
  startCheckBtn.textContent = "Start Ranking Check";
  startCheckBtn.addEventListener("click", () => onStartCheck(overview.clientId));
  primaryActions.append(manageBtn, startCheckBtn);

  const overflowMenu = document.createElement("div");
  overflowMenu.className = "client-card-menu hidden";
  moreBtn.addEventListener("click", () => overflowMenu.classList.toggle("hidden"));

  const mkBtn = (label, handler, disabled = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-outline btn-compact";
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener("click", () => handler(overview.clientId, overview));
    return b;
  };
  overflowMenu.append(
    mkBtn("Edit", onEdit),
    mkBtn("Duplicate", onDuplicate),
    mkBtn(overview.status === "archived" ? "Archived" : "Archive", onArchive, overview.status === "archived"),
    mkBtn("Delete", onDelete)
  );

  card.append(head, kpiRow, locLine, primaryActions, overflowMenu);
  return card;
}

