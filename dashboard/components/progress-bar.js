/**
 * Lightweight accessible progress bar helper.
 */

export function updateProgressBar(fillEl, labelEl, completed, total) {
  const safeTotal = Number(total) || 0;
  const safeDone = Number(completed) || 0;
  const pct = safeTotal > 0 ? Math.min(100, Math.round((safeDone / safeTotal) * 100)) : 0;
  if (fillEl) fillEl.style.width = `${pct}%`;
  if (labelEl) labelEl.textContent = `${pct}%`;
  return pct;
}

