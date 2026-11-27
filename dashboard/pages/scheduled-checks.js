/**
 * Scheduled Ranking Checks Page Controller (Phase 11).
 * Matches the Digital Minds Agency SaaS interface with:
 * - KPI strip (Active schedules, Upcoming, Needs attention)
 * - Clean Schedule List rows (Client/Batch, Location, Frequency/Time, Keyword count, Enabled indicator)
 * - Missed Run recovery alerts & Run/Skip controls
 * - Single-client & Agency-wide multi-client weekly batch editor
 * - Execution history, error diagnostics, Chrome notifications & alarm inspection
 */

import { confirmAction } from "../components/modal.js";
import { setBanner, setPill } from "../components/status-indicator.js";
import {
  formatScheduleFrequencyLabel,
} from "../../modules/scheduler/schedule-calculator.js";
import {
  AUTOMATION_MODES,
  DAY_NAMES,
  EXECUTION_STATES,
  MISSED_RUN_POLICIES,
  SCHEDULE_STATES,
} from "../../modules/scheduler/scheduler-state.js";
import { MESSAGE_TYPES } from "../../utils/messages.js";

function createCalendarCheckIconSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", "3");
  rect.setAttribute("y", "4");
  rect.setAttribute("width", "18");
  rect.setAttribute("height", "18");
  rect.setAttribute("rx", "2");
  const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p1.setAttribute("d", "M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4");
  svg.appendChild(rect);
  svg.appendChild(p1);
  return svg;
}

export function createScheduledChecksPage({ onOpenSheetsForClient } = {}) {
  const feedbackEl = document.getElementById("sched-feedback");
  const kpiActiveEl = document.getElementById("sched-kpi-active");
  const kpiUpcomingEl = document.getElementById("sched-kpi-upcoming");
  const kpiAttentionEl = document.getElementById("sched-kpi-attention");
  const newScheduleBtn = document.getElementById("btn-sched-new");
  const checkMissedBtn = document.getElementById("btn-sched-check-missed");

  const missedBannerPanel = document.getElementById("sched-missed-panel");
  const missedTbody = document.getElementById("sched-missed-tbody");

  const scheduleListEl = document.getElementById("sched-list");
  const editorPanel = document.getElementById("sched-editor-panel");
  const editorTitleEl = document.getElementById("sched-editor-title");
  const editorForm = document.getElementById("sched-form");
  const cancelEditorBtn = document.getElementById("btn-sched-cancel");

  const schedIdInput = document.getElementById("sched-id");
  const schedNameInput = document.getElementById("sched-name");
  const schedScopeSelect = document.getElementById("sched-scope");
  const singleClientGroup = document.getElementById("sched-single-client-group");
  const agencyBatchGroup = document.getElementById("sched-agency-batch-group");
  const schedClientSelect = document.getElementById("sched-client");
  const schedLocationSelect = document.getElementById("sched-location");
  const batchClientsCheckboxesEl = document.getElementById("sched-batch-clients-list");

  const schedFreqSelect = document.getElementById("sched-frequency");
  const schedDaySelect = document.getElementById("sched-day");
  const schedTimeInput = document.getElementById("sched-time");
  const schedTimezoneSelect = document.getElementById("sched-timezone");
  const schedMissedPolicySelect = document.getElementById("sched-missed-policy");
  const schedDepthSelect = document.getElementById("sched-depth");
  const schedDelayInput = document.getElementById("sched-delay-ms");
  const schedSyncSheetChk = document.getElementById("sched-sync-sheet");
  const schedAuthorizedChk = document.getElementById("sched-authorized");
  const schedModeSelect = document.getElementById("sched-mode");
  const schedEnabledChk = document.getElementById("sched-enabled");

  const upcomingTbody = document.getElementById("sched-upcoming-tbody");
  const executionsTbody = document.getElementById("sched-executions-tbody");

  const notifEnabledChk = document.getElementById("notif-enabled");
  const notifCompletedChk = document.getElementById("notif-completed");
  const notifErrorsChk = document.getElementById("notif-errors");
  const notifMissedChk = document.getElementById("notif-missed");
  const notifAuthChk = document.getElementById("notif-auth");
  const notifCaptchaChk = document.getElementById("notif-captcha");
  const saveNotifBtn = document.getElementById("btn-sched-save-prefs");
  const alarmsStatusEl = document.getElementById("sched-alarms-status");

  let cachedClients = [];
  let cachedLocationsByClient = {};
  let cachedSummary = null;

  function syncScopeVisibility() {
    const isBatch = schedScopeSelect.value === "agency_batch";
    singleClientGroup.classList.toggle("hidden", isBatch);
    agencyBatchGroup.classList.toggle("hidden", !isBatch);
  }

  function populateLocationsForClient(clientId, selectedLocationId = null) {
    const locs = cachedLocationsByClient[clientId] || [];
    schedLocationSelect.replaceChildren();
    for (const loc of locs) {
      const opt = document.createElement("option");
      opt.value = loc.locationId;
      opt.textContent = loc.locationName || loc.city || loc.locationId;
      if (selectedLocationId && selectedLocationId === loc.locationId) opt.selected = true;
      schedLocationSelect.appendChild(opt);
    }
    if (locs.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No location saved for client";
      schedLocationSelect.appendChild(opt);
    }
  }

  async function refreshClientOptions(clientOverviews = []) {
    cachedClients = clientOverviews.filter((c) => c.status !== "archived");
    schedClientSelect.replaceChildren();
    batchClientsCheckboxesEl.replaceChildren();

    for (const c of cachedClients) {
      const wsRes = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.CLIENT_GET_WORKSPACE,
        payload: { clientId: c.clientId },
      });
      if (wsRes?.ok) {
        cachedLocationsByClient[c.clientId] = wsRes.locations || [];
      }

      const opt = document.createElement("option");
      opt.value = c.clientId;
      opt.textContent = `${c.clientName} (${c.websiteDomain || "-"})`;
      schedClientSelect.appendChild(opt);

      const label = document.createElement("label");
      label.className = "checkbox-inline sched-batch-item";
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.value = c.clientId;
      chk.className = "sched-batch-chk";
      const span = document.createElement("span");
      span.textContent = `${c.clientName} — ${(cachedLocationsByClient[c.clientId]?.[0]?.locationName || "No location")}`;
      label.append(chk, span);
      batchClientsCheckboxesEl.appendChild(label);
    }

    if (cachedClients[0]) {
      populateLocationsForClient(cachedClients[0].clientId);
    }
  }

  function openEditor(existingSchedule = null) {
    editorPanel.classList.remove("hidden");
    if (!existingSchedule) {
      editorTitleEl.textContent = "Create Scheduled Ranking Check";
      schedIdInput.value = "";
      schedNameInput.value = "";
      schedScopeSelect.value = "single_client";
      if (cachedClients[0]) {
        schedClientSelect.value = cachedClients[0].clientId;
        populateLocationsForClient(cachedClients[0].clientId);
      }
      schedFreqSelect.value = "weekly";
      schedDaySelect.value = "1";
      schedTimeInput.value = "09:00";
      schedTimezoneSelect.value = "Australia/Sydney";
      schedMissedPolicySelect.value = MISSED_RUN_POLICIES.ASK_USER;
      schedDepthSelect.value = "50";
      schedDelayInput.value = "3500";
      schedSyncSheetChk.checked = true;
      schedAuthorizedChk.checked = false;
      schedModeSelect.value = AUTOMATION_MODES.MODE_A_REVIEW;
      schedEnabledChk.checked = true;
      for (const chk of batchClientsCheckboxesEl.querySelectorAll(".sched-batch-chk")) {
        chk.checked = false;
      }
    } else {
      editorTitleEl.textContent = `Edit Schedule: ${existingSchedule.name}`;
      schedIdInput.value = existingSchedule.scheduleId;
      schedNameInput.value = existingSchedule.name || "";
      schedScopeSelect.value = existingSchedule.scopeType || "single_client";
      if (existingSchedule.scopeType === "agency_batch") {
        const selectedIds = new Set((existingSchedule.clientConfigs || []).map((x) => x.clientId));
        for (const chk of batchClientsCheckboxesEl.querySelectorAll(".sched-batch-chk")) {
          chk.checked = selectedIds.has(chk.value);
        }
      } else {
        schedClientSelect.value = existingSchedule.clientId || "";
        populateLocationsForClient(existingSchedule.clientId, existingSchedule.locationId);
      }
      schedFreqSelect.value = existingSchedule.frequency || "weekly";
      schedDaySelect.value = String(existingSchedule.dayOfWeek ?? 1);
      schedTimeInput.value = existingSchedule.timeOfDay || "09:00";
      schedTimezoneSelect.value = existingSchedule.timezone || "Australia/Sydney";
      schedMissedPolicySelect.value = existingSchedule.missedRunPolicy || MISSED_RUN_POLICIES.ASK_USER;
      schedDepthSelect.value = String(existingSchedule.searchDepth || 50);
      schedDelayInput.value = String(existingSchedule.delayBetweenKeywordsMs || 3500);
      schedSyncSheetChk.checked = existingSchedule.syncSheetBeforeRun !== false;
      schedAuthorizedChk.checked = Boolean(existingSchedule.isAuthorized);
      schedModeSelect.value = existingSchedule.automationMode || AUTOMATION_MODES.MODE_A_REVIEW;
      schedEnabledChk.checked = existingSchedule.enabled !== false;
    }
    syncScopeVisibility();
  }

  function renderScheduleList(summary) {
    const schedules = summary?.schedules || [];
    scheduleListEl.replaceChildren();

    if (schedules.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No recurring ranking schedules configured yet. Click '+ New Schedule' to create a weekly client or agency batch schedule.";
      scheduleListEl.appendChild(empty);
      return;
    }

    for (const s of schedules) {
      const row = document.createElement("div");
      row.className = "sched-item";

      const left = document.createElement("div");
      left.className = "sched-item-left";

      const iconTile = document.createElement("div");
      iconTile.className = "sched-icon-tile";
      iconTile.appendChild(createCalendarCheckIconSvg());

      const info = document.createElement("div");
      info.className = "sched-item-info";

      const titleLine = document.createElement("div");
      titleLine.className = "sched-item-title";
      titleLine.textContent = s.name || s.clientName || s.scheduleId;
      if (s.scopeType === "agency_batch") {
        const badge = document.createElement("span");
        badge.className = "pill pill-neutral";
        badge.style.marginLeft = "8px";
        badge.textContent = `Agency Batch (${(s.clientConfigs || []).length} clients)`;
        titleLine.appendChild(badge);
      }

      const locLine = document.createElement("div");
      locLine.className = "sched-item-sub";
      locLine.textContent =
        s.scopeType === "agency_batch"
          ? "Sequential multi-client batch"
          : s.locationName || cachedLocationsByClient[s.clientId]?.[0]?.locationName || "Target location configured";

      const freqLine = document.createElement("div");
      freqLine.className = "sched-item-freq";
      freqLine.textContent = `${formatScheduleFrequencyLabel(s)} · ${s.timezone || "Australia/Sydney"}`;

      const kwCount =
        s.expectedKeywordCount ||
        cachedClients.find((c) => c.clientId === s.clientId)?.keywordCount ||
        0;
      const metaLine = document.createElement("div");
      metaLine.className = "sched-item-sub";
      metaLine.textContent = `${kwCount} keywords · ${
        s.automationMode === AUTOMATION_MODES.MODE_B_AUTO_SHEET
          ? "Mode B (Sandbox auto-write)"
          : "Mode A (Preview & review)"
      }${s.nextScheduledRunAt ? ` · Next: ${s.nextScheduledRunAt.slice(0, 16).replace("T", " ")} UTC` : ""}`;

      info.append(titleLine, locLine, freqLine, metaLine);
      left.append(iconTile, info);

      const right = document.createElement("div");
      right.className = "sched-item-right";

      const statusEl = document.createElement("span");
      const isEnabled = s.enabled && s.status !== SCHEDULE_STATES.MISSED && s.status !== SCHEDULE_STATES.NEEDS_ATTENTION && s.status !== SCHEDULE_STATES.FAILED;
      statusEl.className = isEnabled
        ? "sched-status-enabled"
        : !s.enabled
          ? "sched-status-disabled"
          : "sched-status-attention";
      statusEl.textContent = isEnabled ? "✓ Enabled" : s.status || "Disabled";

      const actions = document.createElement("div");
      actions.className = "sched-row-actions";

      const runBtn = document.createElement("button");
      runBtn.type = "button";
      runBtn.className = "btn-outline btn-compact";
      runBtn.textContent = "Run Now";
      runBtn.addEventListener("click", async () => {
        runBtn.disabled = true;
        setBanner(feedbackEl, "pending", `Executing '${s.name}' sequentially...`);
        const res = await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.SCHEDULE_RUN_NOW,
          payload: { scheduleId: s.scheduleId },
        });
        runBtn.disabled = false;
        setBanner(
          feedbackEl,
          res?.ok ? "success" : "error",
          res?.ok
            ? `Finished scheduled run (${res.drain?.processed?.[0]?.execution?.status || "Done"}).`
            : res?.error || "Scheduled execution failed."
        );
        await refresh();
      });

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn-outline btn-compact";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => openEditor(s));

      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "btn-outline btn-compact";
      toggleBtn.textContent = s.enabled ? "Disable" : "Enable";
      toggleBtn.addEventListener("click", async () => {
        const res = await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.SCHEDULE_TOGGLE,
          payload: { scheduleId: s.scheduleId, enabled: !s.enabled },
        });
        if (!res?.ok) setBanner(feedbackEl, "error", res?.error || "Toggle failed.");
        await refresh();
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-outline btn-compact";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        if (!confirmAction(`Delete schedule '${s.name}'? Its registered Chrome alarm will be cleared.`)) return;
        await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.SCHEDULE_DELETE,
          payload: { scheduleId: s.scheduleId },
        });
        await refresh();
      });

      actions.append(runBtn, editBtn, toggleBtn, delBtn);
      right.append(statusEl, actions);
      row.append(left, right);
      scheduleListEl.appendChild(row);
    }
  }

  function renderMissedRuns(summary) {
    const missed = summary?.missedExecutions || [];
    missedBannerPanel.classList.toggle("hidden", missed.length === 0);
    missedTbody.replaceChildren();

    for (const m of missed) {
      const tr = document.createElement("tr");
      for (const val of [
        m.scheduleName || m.scheduleId,
        (m.scheduledForAt || "").slice(0, 16).replace("T", " "),
        String(m.missedCount || m.missedOccurrences?.length || 1),
        m.status,
      ]) {
        const td = document.createElement("td");
        td.textContent = val;
        tr.appendChild(td);
      }

      const actionTd = document.createElement("td");
      actionTd.className = "actions";
      const runNowBtn = document.createElement("button");
      runNowBtn.type = "button";
      runNowBtn.className = "btn-navy btn-compact";
      runNowBtn.textContent = "Run Latest Missed Now";
      runNowBtn.addEventListener("click", async () => {
        const res = await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.SCHEDULE_MISSED_RESOLVE,
          payload: { executionId: m.executionId, action: "run_now" },
        });
        setBanner(feedbackEl, res?.ok ? "success" : "error", res?.ok ? "Missed run executed." : res?.error || "Failed.");
        await refresh();
      });

      const skipBtn = document.createElement("button");
      skipBtn.type = "button";
      skipBtn.className = "btn-outline btn-compact";
      skipBtn.textContent = "Skip";
      skipBtn.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.SCHEDULE_MISSED_RESOLVE,
          payload: { executionId: m.executionId, action: "skip" },
        });
        await refresh();
      });

      actionTd.append(runNowBtn, skipBtn);
      tr.appendChild(actionTd);
      missedTbody.appendChild(tr);
    }
  }

  function renderUpcomingAndHistory(summary) {
    upcomingTbody.replaceChildren();
    const upcoming = summary?.upcomingRuns || [];
    for (const s of upcoming) {
      const tr = document.createElement("tr");
      for (const val of [
        s.name || s.clientName,
        formatScheduleFrequencyLabel(s),
        s.timezone || "Australia/Sydney",
        (s.nextScheduledRunAt || "").slice(0, 19).replace("T", " "),
      ]) {
        const td = document.createElement("td");
        td.textContent = val;
        tr.appendChild(td);
      }
      upcomingTbody.appendChild(tr);
    }
    if (upcoming.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "muted";
      td.textContent = "No enabled schedules scheduled within the next 7 days.";
      tr.appendChild(td);
      upcomingTbody.appendChild(tr);
    }

    executionsTbody.replaceChildren();
    const execs = summary?.recentExecutions || [];
    for (const e of execs.slice(0, 25)) {
      const tr = document.createElement("tr");
      const kwSummary = e.summary
        ? `${e.summary.completedKeywords ?? 0}/${e.summary.totalKeywords ?? 0} (${e.summary.failedKeywords ?? 0} err)`
        : "-";
      const cells = [
        e.scheduleName || e.scheduleId,
        (e.startedAt || e.scheduledForAt || "").slice(0, 16).replace("T", " "),
        e.triggerSource || "alarm",
        e.status || "-",
        kwSummary,
        e.deferredReason || e.firstError || (e.summary?.previewReadyCount > 0 ? "Preview ready in Google Sheets" : "-"),
      ];
      for (const v of cells) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.appendChild(td);
      }
      const actionTd = document.createElement("td");
      if (e.summary?.previewReadyCount > 0 && typeof onOpenSheetsForClient === "function") {
        const previewBtn = document.createElement("button");
        previewBtn.type = "button";
        previewBtn.className = "btn-outline btn-compact";
        previewBtn.textContent = "Review Sheet Update";
        previewBtn.addEventListener("click", () => {
          const targetCid =
            e.clientId !== "__agency_batch__" ? e.clientId : e.clientReports?.[0]?.clientId;
          if (targetCid) onOpenSheetsForClient(targetCid);
        });
        actionTd.appendChild(previewBtn);
      } else {
        actionTd.textContent = "-";
      }
      tr.appendChild(actionTd);
      executionsTbody.appendChild(tr);
    }
    if (execs.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.className = "muted";
      td.textContent = "No scheduled executions recorded yet.";
      tr.appendChild(td);
      executionsTbody.appendChild(tr);
    }
  }

  function renderSettingsAndAlarms(settings, alarms) {
    const p = settings?.notificationPreferences || {};
    notifEnabledChk.checked = p.enabled !== false;
    notifCompletedChk.checked = p.onCompleted !== false;
    notifErrorsChk.checked = p.onCompletedWithErrors !== false;
    notifMissedChk.checked = p.onMissedRun !== false;
    notifAuthChk.checked = p.onAuthRequired !== false;
    notifCaptchaChk.checked = p.onCaptchaBlocked !== false;

    const schedAlarms = (alarms || []).filter((a) => String(a.name || "").startsWith("dm_sched::"));
    alarmsStatusEl.textContent = `Active Chrome Alarms registered: ${schedAlarms.length}`;
  }

  async function refresh(clientOverviews = null) {
    if (Array.isArray(clientOverviews)) {
      await refreshClientOptions(clientOverviews);
    }
    const [sumRes, alarmsRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SCHEDULE_SUMMARY }),
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SCHEDULE_ALARMS_INSPECT }),
    ]);

    if (!sumRes?.ok) {
      setBanner(feedbackEl, "error", sumRes?.error || "Failed loading scheduled checks.");
      return;
    }

    cachedSummary = sumRes;
    const kpis = sumRes.kpis || {};
    kpiActiveEl.textContent = String(kpis.activeSchedulesCount ?? 0);
    kpiUpcomingEl.textContent = String(kpis.upcomingCount ?? 0);
    kpiAttentionEl.textContent = String(kpis.needsAttentionCount ?? 0);
    kpiAttentionEl.className =
      Number(kpis.needsAttentionCount || 0) > 0
        ? "sched-kpi-val sched-kpi-alert"
        : "sched-kpi-val sched-kpi-ok";

    renderMissedRuns(sumRes);
    renderScheduleList(sumRes);
    renderUpcomingAndHistory(sumRes);
    renderSettingsAndAlarms(sumRes.settings, alarmsRes?.alarms || []);
  }

  newScheduleBtn.addEventListener("click", () => openEditor(null));
  cancelEditorBtn.addEventListener("click", () => editorPanel.classList.add("hidden"));
  schedScopeSelect.addEventListener("change", syncScopeVisibility);
  schedClientSelect.addEventListener("change", () => populateLocationsForClient(schedClientSelect.value));

  checkMissedBtn.addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SCHEDULE_MISSED_CHECK });
    setBanner(
      feedbackEl,
      "success",
      `Missed-run scan finished (${res?.missedHandledCount ?? 0} overdue schedule(s) evaluated).`
    );
    await refresh();
  });

  editorForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const isBatch = schedScopeSelect.value === "agency_batch";
    const clientConfigs = isBatch
      ? [...batchClientsCheckboxesEl.querySelectorAll(".sched-batch-chk:checked")].map((chk) => ({
          clientId: chk.value,
          locationId: cachedLocationsByClient[chk.value]?.[0]?.locationId || null,
        }))
      : [];

    const selectedClient = cachedClients.find((c) => c.clientId === schedClientSelect.value);
    const selectedLoc = (cachedLocationsByClient[schedClientSelect.value] || []).find(
      (l) => l.locationId === schedLocationSelect.value
    );

    const payload = {
      name: schedNameInput.value.trim(),
      scopeType: schedScopeSelect.value,
      clientId: isBatch ? "__agency_batch__" : schedClientSelect.value,
      clientName: isBatch ? "Agency Weekly Batch" : selectedClient?.clientName || "",
      locationId: isBatch ? null : schedLocationSelect.value || null,
      locationName: isBatch ? "Multi-client" : selectedLoc?.locationName || "",
      clientConfigs,
      frequency: schedFreqSelect.value,
      dayOfWeek: Number(schedDaySelect.value),
      timeOfDay: schedTimeInput.value,
      timezone: schedTimezoneSelect.value,
      missedRunPolicy: schedMissedPolicySelect.value,
      searchDepth: Number(schedDepthSelect.value),
      delayBetweenKeywordsMs: Number(schedDelayInput.value),
      syncSheetBeforeRun: schedSyncSheetChk.checked,
      isAuthorized: schedAuthorizedChk.checked,
      automationMode: schedModeSelect.value,
      enabled: schedEnabledChk.checked,
      expectedKeywordCount: isBatch
        ? clientConfigs.reduce(
            (sum, cc) => sum + Number(cachedClients.find((c) => c.clientId === cc.clientId)?.keywordCount || 0),
            0
          )
        : Number(selectedClient?.keywordCount || 0),
    };

    const existingId = schedIdInput.value.trim();
    const res = existingId
      ? await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.SCHEDULE_UPDATE,
          payload: { scheduleId: existingId, updates: payload },
        })
      : await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.SCHEDULE_CREATE,
          payload,
        });

    if (!res?.ok) {
      setBanner(feedbackEl, "error", res?.errors?.join(" ") || res?.error || "Failed saving schedule.");
      return;
    }

    editorPanel.classList.add("hidden");
    setBanner(feedbackEl, "success", `Saved schedule '${res.schedule.name}'. Next run: ${res.schedule.nextScheduledRunAt || "Disabled"}`);
    await refresh();
  });

  saveNotifBtn.addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.SCHEDULER_SETTINGS_SAVE,
      payload: {
        notificationPreferences: {
          enabled: notifEnabledChk.checked,
          onCompleted: notifCompletedChk.checked,
          onCompletedWithErrors: notifErrorsChk.checked,
          onMissedRun: notifMissedChk.checked,
          onAuthRequired: notifAuthChk.checked,
          onCaptchaBlocked: notifCaptchaChk.checked,
          onLocationFailed: true,
          onSheetPreviewReady: true,
        },
      },
    });
    setBanner(
      feedbackEl,
      res?.ok ? "success" : "error",
      res?.ok ? "Notification preferences updated." : res?.error || "Failed saving preferences."
    );
  });

  return {
    refresh,
    getSummary: () => cachedSummary,
  };
}

