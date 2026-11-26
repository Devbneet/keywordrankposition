/**
 * SaaS KPI metric card component rendered safely via DOM nodes.
 */

export function createStatisticsCard({ label, value, tone = "default", subtext = "" }) {
  const card = document.createElement("div");
  card.className = "kpi-card";

  const lbl = document.createElement("span");
  lbl.className = "kpi-label";
  lbl.textContent = label;

  const val = document.createElement("strong");
  val.className = `kpi-value tone-${tone}`;
  val.textContent = value;

  card.append(lbl, val);
  if (subtext) {
    const sub = document.createElement("span");
    sub.className = "kpi-subtext";
    sub.textContent = subtext;
    card.appendChild(sub);
  }
  return card;
}

