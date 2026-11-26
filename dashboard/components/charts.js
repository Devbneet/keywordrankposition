/**
 * Lightweight native SVG chart renderers (no external libraries).
 * Keyword trend plots Position #1 at top; failed/missing points show clean gaps.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

export function renderDistributionBars(containerEl, distribution = {}) {
  containerEl.replaceChildren();
  const buckets = [
    { label: "Top 3", count: distribution.top3 || 0, color: "#16a34a" },
    { label: "4–10", count: distribution.pos4To10 || 0, color: "#2563eb" },
    { label: "11–20", count: distribution.pos11To20 || 0, color: "#60a5fa" },
    { label: "21–100", count: distribution.pos21To100 || 0, color: "#94a3b8" },
    { label: "Not found", count: distribution.notFound || 0, color: "#cbd5e1" },
  ];
  const max = Math.max(1, ...buckets.map((b) => b.count));

  for (const b of buckets) {
    const row = document.createElement("div");
    row.className = "dist-row";

    const lbl = document.createElement("span");
    lbl.className = "dist-label";
    lbl.textContent = b.label;

    const track = document.createElement("div");
    track.className = "dist-track";
    const fill = document.createElement("div");
    fill.className = "dist-fill";
    fill.style.width = `${b.count > 0 ? Math.max(4, Math.round((b.count / max) * 100)) : 0}%`;
    fill.style.background = b.color;
    track.appendChild(fill);

    const num = document.createElement("span");
    num.className = "dist-count";
    num.textContent = String(b.count);

    row.append(lbl, track, num);
    containerEl.appendChild(row);
  }
}

export function renderKeywordTrendChart(containerEl, series = []) {
  containerEl.replaceChildren();
  if (!series || series.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No historical observations for the selected keyword/context.";
    containerEl.appendChild(empty);
    return;
  }

  const width = 680;
  const height = 220;
  const padL = 44;
  const padR = 20;
  const padT = 22;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const rankedPositions = series.filter((p) => typeof p.position === "number").map((p) => p.position);
  const maxPos = Math.max(20, ...rankedPositions);

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "trend-svg",
    role: "img",
    "aria-label": "Keyword ranking position trend chart (Position 1 at top)",
  });

  // Grid lines: #1, #10, #20, max
  const yForPos = (pos) => padT + ((pos - 1) / Math.max(1, maxPos - 1)) * plotH;
  for (const tick of [1, 10, 20, maxPos]) {
    if (tick > maxPos) continue;
    const y = yForPos(tick);
    svg.appendChild(svgEl("line", { x1: padL, y1: y, x2: width - padR, y2: y, stroke: "#e2e8f0", "stroke-width": 1 }));
    const lbl = svgEl("text", { x: 6, y: y + 4, fill: "#64748b", "font-size": 11 });
    lbl.textContent = `#${tick}`;
    svg.appendChild(lbl);
  }

  const xForIdx = (i) =>
    series.length === 1 ? padL + plotW / 2 : padL + (i / (series.length - 1)) * plotW;

  // Draw polyline segments only across consecutive ranked points (breaks on failed / NA!)
  let currentPath = "";
  series.forEach((pt, idx) => {
    const x = xForIdx(idx);
    if (typeof pt.position === "number") {
      const y = yForPos(pt.position);
      currentPath += `${currentPath ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)} `;
    } else if (currentPath) {
      svg.appendChild(
        svgEl("path", {
          d: currentPath.trim(),
          fill: "none",
          stroke: "#2563eb",
          "stroke-width": 2.5,
        })
      );
      currentPath = "";
    }
  });
  if (currentPath) {
    svg.appendChild(
      svgEl("path", { d: currentPath.trim(), fill: "none", stroke: "#2563eb", "stroke-width": 2.5 })
    );
  }

  // Draw markers: blue circle for ranked, amber hollow marker at bottom for Confirmed NA, red X for failed/missing
  series.forEach((pt, idx) => {
    const x = xForIdx(idx);
    const dateLbl = svgEl("text", { x: x - 20, y: height - 8, fill: "#64748b", "font-size": 10 });
    dateLbl.textContent = pt.dateLabel.slice(5);
    svg.appendChild(dateLbl);

    if (typeof pt.position === "number") {
      const y = yForPos(pt.position);
      const circle = svgEl("circle", { cx: x, cy: y, r: 4.5, fill: "#2563eb", stroke: "#ffffff", "stroke-width": 1.5 });
      const title = svgEl("title");
      title.textContent = `${pt.dateLabel}: #${pt.position}`;
      circle.appendChild(title);
      svg.appendChild(circle);
    } else if (pt.isNotFound) {
      const y = height - padB - 6;
      const rect = svgEl("rect", { x: x - 4, y: y - 4, width: 8, height: 8, fill: "#f59e0b", rx: 2 });
      const title = svgEl("title");
      title.textContent = `${pt.dateLabel}: Confirmed Not Found (NA)`;
      rect.appendChild(title);
      svg.appendChild(rect);
    } else {
      const y = height - padB - 6;
      const dot = svgEl("circle", { cx: x, cy: y, r: 3.5, fill: "#ef4444" });
      const title = svgEl("title");
      title.textContent = `${pt.dateLabel}: Missing / Failed (${pt.status})`;
      dot.appendChild(title);
      svg.appendChild(dot);
    }
  });

  containerEl.appendChild(svg);
}

