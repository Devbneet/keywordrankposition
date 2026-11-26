/**
 * Shared UI helpers for status pills, feedback banners, formatting, and file downloads.
 */

export function setBanner(el, kind, message) {
  if (!el) return;
  if (!message) {
    el.className = "feedback-banner hidden";
    el.textContent = "";
    return;
  }
  el.className = `feedback-banner ${kind || "info"}`;
  el.textContent = message;
}

export function setPill(el, kind, text) {
  if (!el) return;
  el.className = `pill pill-${kind || "neutral"}`;
  el.textContent = text || "-";
}

export function formatShortDate(iso) {
  if (!iso) return "No data";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "No data";
  return dt.toLocaleString();
}

export function downloadTextFile(filename, content, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

