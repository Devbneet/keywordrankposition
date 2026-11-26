/**
 * Bulk ranking table filtering, progress metrics calculation, and safe CSV export
 * with spreadsheet formula-injection protection.
 */

import { isFailedTaskStatus, TASK_STATUSES } from "../jobs/job-state.js";

/**
 * Protect against CSV/spreadsheet formula injection (=, +, -, @, tab, CR)
 * while preserving legitimate negative numbers (e.g. -33.8688).
 */
export function sanitizeCsvCell(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  const str = String(value);
  if (/^-?\d+(?:\.\d+)?$/.test(str.trim())) {
    return str;
  }
  const neutralized = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  if (/[",\n\r]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

export function computeBulkProgressMetrics(job, tasks = [], nowMs = Date.now()) {
  const totalKeywords = tasks.length || job?.totalKeywords || 0;
  let rankedKeywords = 0;
  let notFoundKeywords = 0;
  let failedKeywords = 0;
  let pendingKeywords = 0;
  const durations = [];

  for (const task of tasks) {
    if (task.status === TASK_STATUSES.RANKED) {
      rankedKeywords += 1;
    } else if (task.status === TASK_STATUSES.NOT_FOUND) {
      notFoundKeywords += 1;
    } else if (task.status === TASK_STATUSES.PENDING || task.status === TASK_STATUSES.RUNNING) {
      pendingKeywords += 1;
    } else if (isFailedTaskStatus(task.status)) {
      failedKeywords += 1;
    }

    if (typeof task.durationMs === "number" && Number.isFinite(task.durationMs) && task.durationMs >= 0) {
      durations.push(task.durationMs);
    }
  }

  const completedKeywords = rankedKeywords + notFoundKeywords + failedKeywords;
  const progressPercentage =
    totalKeywords > 0 ? Math.round((completedKeywords / totalKeywords) * 100) : 0;

  let elapsedMs = 0;
  if (job?.createdAt) {
    const startMs = Date.parse(job.createdAt);
    const endMs = job.completedAt ? Date.parse(job.completedAt) : nowMs;
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      elapsedMs = Math.max(0, endMs - startMs);
    }
  }

  // Only show ETA once at least 3 keywords have genuine processing duration data.
  let estimatedRemainingMs = null;
  if (durations.length >= 3 && pendingKeywords > 0) {
    const avgMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    estimatedRemainingMs = Math.round(avgMs * pendingKeywords);
  }

  return {
    totalKeywords,
    completedKeywords,
    pendingKeywords,
    rankedKeywords,
    notFoundKeywords,
    failedKeywords,
    currentKeyword: job?.currentKeyword || null,
    jobStatus: job?.state || "Ready",
    progressPercentage,
    elapsedMs,
    estimatedRemainingMs,
  };
}

export function filterBulkTasks(tasks = [], { searchQuery = "", filterMode = "all" } = {}) {
  const q = String(searchQuery || "").trim().toLowerCase();

  return tasks.filter((task) => {
    if (q) {
      const hay = `${task.keyword || ""} ${task.rankingUrl || ""} ${task.errorDetails || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }

    switch (filterMode) {
      case "top3":
        return task.status === TASK_STATUSES.RANKED && typeof task.position === "number" && task.position <= 3;
      case "top10":
        return task.status === TASK_STATUSES.RANKED && typeof task.position === "number" && task.position <= 10;
      case "top20":
        return task.status === TASK_STATUSES.RANKED && typeof task.position === "number" && task.position <= 20;
      case "ranked":
        return task.status === TASK_STATUSES.RANKED;
      case "not_found":
        return task.status === TASK_STATUSES.NOT_FOUND;
      case "failed":
        return isFailedTaskStatus(task.status);
      case "pending":
        return task.status === TASK_STATUSES.PENDING || task.status === TASK_STATUSES.RUNNING;
      case "all":
      default:
        return true;
    }
  });
}

export function exportBulkResultsCsv(job, tasks = []) {
  const headers = [
    "Keyword",
    "Ranking position",
    "Ranking URL",
    "Location",
    "Latitude",
    "Longitude",
    "Result status",
    "Results checked",
    "Checked date",
    "Error details",
  ];

  const lines = [headers.join(",")];
  const locCfg = job?.locationConfig || {};

  for (const task of tasks) {
    const tLoc = task.locationConfig || locCfg;
    const locationLabel = tLoc.targetCity || tLoc.locationName || "";
    const posDisplay =
      task.status === TASK_STATUSES.RANKED
        ? task.position
        : task.status === TASK_STATUSES.NOT_FOUND
          ? "NA"
          : "";

    lines.push(
      [
        task.keyword,
        posDisplay,
        task.rankingUrl || "",
        locationLabel,
        tLoc.latitude ?? "",
        tLoc.longitude ?? "",
        task.status,
        task.checkedResults ?? 0,
        task.checkedAt || "",
        task.errorDetails || "",
      ]
        .map(sanitizeCsvCell)
        .join(",")
    );
  }

  return lines.join("\n");
}

