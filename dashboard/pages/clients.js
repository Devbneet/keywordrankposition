/**
 * Clients Management & Individual Client Overview Dashboard page controller.
 */

import { renderDistributionBars } from "../components/charts.js";
import { createClientOverviewCard } from "../components/client-card.js";
import { confirmAction } from "../components/modal.js";
import { createStatisticsCard } from "../components/statistics-card.js";
import { downloadTextFile, formatShortDate, setBanner } from "../components/status-indicator.js";
import { parseCoordinatePair } from "../../modules/location/coordinate-validator.js";
import { MESSAGE_TYPES } from "../../utils/messages.js";

export function createClientsPage({
  getLocationDefaults,
  getRankingDefaults,
  onClientSelected,
  onStartCheckFlow,
  onNavigate,
  onViewClientHistory,
}) {
  const activeClientPillEl = document.getElementById("active-client-pill");
  const clientSearchInput = document.getElementById("client-search-input");
  const clientShowArchivedChk = document.getElementById("client-show-archived");
  const clientNewBtn = document.getElementById("btn-client-new");
  const clientImportFileInput = document.getElementById("client-import-file");
  const clientExportBtn = document.getElementById("btn-client-export");
  const clientFeedbackEl = document.getElementById("client-feedback");
  const clientCardsGridEl = document.getElementById("client-cards-grid");

  const clientEditorPanel = document.getElementById("client-editor-panel");
  const clientEditorTitleEl = document.getElementById("client-editor-title");
  const clientEditorForm = document.getElementById("client-editor-form");
  const cliIdInput = document.getElementById("cli-id");
  const cliNameInput = document.getElementById("cli-name");
  const cliDomainInput = document.getElementById("cli-domain");
  const cliStatusSelect = document.getElementById("cli-status");
  const cliUrlInput = document.getElementById("cli-url");
  const cliNotesInput = document.getElementById("cli-notes");
  const cliSheetUrlInput = document.getElementById("cli-sheet-url");
  const cliSheetIdInput = document.getElementById("cli-sheet-id");
  const cliWsNameInput = document.getElementById("cli-ws-name");
  const cliWsIdInput = document.getElementById("cli-ws-id");
  const cliColKwInput = document.getElementById("cli-col-kw");
  const cliColVolInput = document.getElementById("cli-col-vol");
  const cliColCompInput = document.getElementById("cli-col-comp");
  const cliColLpInput = document.getElementById("cli-col-lp");
  const cliColSerpInput = document.getElementById("cli-col-serp");
  const cliColDateInput = document.getElementById("cli-col-date");
  const clientCancelBtn = document.getElementById("btn-client-cancel");

  const activeClientWorkspaceEl = document.getElementById("active-client-workspace");
  const wsClientHeadingEl = document.getElementById("ws-client-heading");
  const clientDashMetricsEl = document.getElementById("cli-dash-metrics");
  const clientDashDistEl = document.getElementById("cli-dash-distribution");
  const clientQaCheckBtn = document.getElementById("btn-cli-qa-check");
  const clientQaVerifyBtn = document.getElementById("btn-cli-qa-verify");
  const clientQaSheetBtn = document.getElementById("btn-cli-qa-sheet");
  const clientQaHistoryBtn = document.getElementById("btn-cli-qa-history");
  const clientQaEditBtn = document.getElementById("btn-cli-qa-edit");

  const clientBackupBtn = document.getElementById("btn-client-backup");
  const clientLoadBulkBtn = document.getElementById("btn-client-load-bulk");
  const cliLocationsListEl = document.getElementById("cli-locations-list");
  const cliLocNameInput = document.getElementById("cli-loc-name");
  const cliLocCoordsInput = document.getElementById("cli-loc-coords");
  const cliLocStateInput = document.getElementById("cli-loc-state");
  const cliLocWsInput = document.getElementById("cli-loc-ws");
  const cliLocColInput = document.getElementById("cli-loc-col");
  const cliAddLocBtn = document.getElementById("btn-cli-add-loc");
  const cliKwCountEl = document.getElementById("cli-kw-count");
  const cliKwPasteInput = document.getElementById("cli-kw-paste");
  const cliAddKwsBtn = document.getElementById("btn-cli-add-kws");
  const cliKwCsvFileInput = document.getElementById("cli-kw-csv-file");
  const cliKeywordsListEl = document.getElementById("cli-keywords-list");
  const cliHistoryTbody = document.getElementById("cli-history-tbody");

  let activeWorkspace = null;
  let overviewsCache = [];

  function populateEditor(client = null) {
    cliIdInput.value = client?.clientId || "";
    cliNameInput.value = client?.clientName || "";
    cliDomainInput.value = client?.websiteDomain || "";
    cliStatusSelect.value = client?.status || "active";
    cliUrlInput.value = client?.websiteUrl || "";
    cliNotesInput.value = client?.notes || "";
    const sc = client?.sheetConfig || {};
    cliSheetUrlInput.value = sc.sheetUrl || "";
    cliSheetIdInput.value = sc.spreadsheetId || "";
    cliWsNameInput.value = sc.worksheetName || "Keywords";
    cliWsIdInput.value = sc.worksheetId || "";
    cliColKwInput.value = sc.keywordColumn || "C";
    cliColVolInput.value = sc.searchVolumeColumn || "D";
    cliColCompInput.value = sc.competitionColumn || "E";
    cliColLpInput.value = sc.landingPageColumn || "F";
    cliColSerpInput.value = sc.serpColumn || "G";
    cliColDateInput.value = sc.latestDateColumn || "H";
    clientEditorTitleEl.textContent = client ? `Edit Client: ${client.clientName}` : "Add Client";
  }

  async function refreshClientDashboardSummary(clientId) {
    if (!clientDashMetricsEl || !clientDashDistEl) return;
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CLIENT_DASHBOARD_METRICS,
      payload: { clientId },
    });
    if (!res?.ok || !res.metrics) return;
    const m = res.metrics;
    clientDashMetricsEl.replaceChildren(
      createStatisticsCard({ label: "Active Keywords", value: String(m.totalTrackedKeywords) }),
      createStatisticsCard({ label: "Locations", value: String(m.totalConfiguredLocations) }),
      createStatisticsCard({ label: "Improved / Declined", value: `${m.improvedCount} / ${m.declinedCount}` }),
      createStatisticsCard({ label: "Sheet Status", value: m.sheetConnectionStatus }),
      createStatisticsCard({ label: "Last Check", value: formatShortDate(m.lastRankingCheck) }),
      createStatisticsCard({ label: "Last Sheet Update", value: formatShortDate(m.lastSheetUpdate) })
    );
    renderDistributionBars(clientDashDistEl, m.distribution);
  }

  function renderWorkspace(workspace) {
    activeWorkspace = workspace;
    const hasClient = Boolean(workspace?.client);
    clientExportBtn.disabled = !hasClient;

    if (!hasClient) {
      activeClientPillEl.className = "pill pill-neutral";
      activeClientPillEl.textContent = "No Active Client";
      activeClientWorkspaceEl.classList.add("hidden");
      if (onClientSelected) onClientSelected(null);
      return;
    }

    const { client, locations = [], selectedLocation = null, keywords = [], results = [] } = workspace;
    activeClientPillEl.className = "pill pill-healthy";
    activeClientPillEl.textContent = `Active: ${client.clientName}`;
    wsClientHeadingEl.textContent = `${client.clientName} (${client.websiteDomain})`;
    activeClientWorkspaceEl.classList.remove("hidden");

    refreshClientDashboardSummary(client.clientId);
    if (onClientSelected) onClientSelected(workspace);

    cliLocationsListEl.replaceChildren();
    if (locations.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No client locations saved yet.";
      cliLocationsListEl.appendChild(empty);
    } else {
      for (const loc of locations) {
        const item = document.createElement("div");
        item.className = "mini-list-item";
        const label = document.createElement("span");
        const activeTag = selectedLocation?.locationId === loc.locationId ? " [Active]" : "";
        label.textContent = `${loc.locationName}${loc.stateRegion ? ` (${loc.stateRegion})` : ""} · ${loc.latitude}, ${loc.longitude}${activeTag}`;

        const btns = document.createElement("div");
        btns.className = "actions";
        const useBtn = document.createElement("button");
        useBtn.type = "button";
        useBtn.className = "btn-outline btn-compact";
        useBtn.textContent = "Use";
        useBtn.addEventListener("click", () => selectClient(client.clientId, loc.locationId));

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn-outline btn-compact";
        delBtn.textContent = "Remove";
        delBtn.addEventListener("click", async () => {
          const res = await chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.CLIENT_DELETE_LOCATION,
            payload: { locationId: loc.locationId },
          });
          if (res?.ok) {
            await refreshWorkspace(client.clientId);
            await refreshOverviews();
          }
        });
        btns.append(useBtn, delBtn);
        item.append(label, btns);
        cliLocationsListEl.appendChild(item);
      }
    }

    cliKwCountEl.textContent = String(keywords.length);
    cliKeywordsListEl.replaceChildren();
    if (keywords.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No keywords saved for this client yet.";
      cliKeywordsListEl.appendChild(empty);
    } else {
      for (const kw of keywords) {
        const item = document.createElement("div");
        item.className = "mini-list-item";
        const label = document.createElement("span");
        label.textContent = `${kw.keyword} [${kw.keywordGroup || "Default"} · Row ${kw.rowPosition || "-"}]${kw.active === false ? " (Inactive)" : ""}`;

        const btns = document.createElement("div");
        btns.className = "actions";
        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "btn-outline btn-compact";
        toggleBtn.textContent = kw.active === false ? "Enable" : "Disable";
        toggleBtn.addEventListener("click", async () => {
          await chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.CLIENT_UPDATE_KEYWORD,
            payload: {
              clientId: client.clientId,
              keywordId: kw.keywordId,
              updates: { active: kw.active === false },
            },
          });
          await refreshWorkspace(client.clientId);
        });

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn-outline btn-compact";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", async () => {
          await chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.CLIENT_DELETE_KEYWORD,
            payload: { keywordId: kw.keywordId },
          });
          await refreshWorkspace(client.clientId);
          await refreshOverviews();
        });
        btns.append(toggleBtn, delBtn);
        item.append(label, btns);
        cliKeywordsListEl.appendChild(item);
      }
    }

    cliHistoryTbody.replaceChildren();
    if (results.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.className = "muted";
      td.textContent = "No stored ranking results for this client yet.";
      tr.appendChild(td);
      cliHistoryTbody.appendChild(tr);
    } else {
      for (const row of results.slice(0, 50)) {
        const tr = document.createElement("tr");
        for (const val of [
          row.keyword || "-",
          typeof row.position === "number" ? String(row.position) : "-",
          row.status || "-",
          row.rankingUrl || "-",
          row.checkedAt ? new Date(row.checkedAt).toLocaleString() : "-",
          row.googleLocation || "-",
        ]) {
          const td = document.createElement("td");
          td.textContent = val;
          tr.appendChild(td);
        }
        cliHistoryTbody.appendChild(tr);
      }
    }
  }

  function renderCards(overviews = []) {
    overviewsCache = overviews;
    clientCardsGridEl.replaceChildren();
    const activeId = activeWorkspace?.client?.clientId || null;

    if (overviews.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No clients match the filter. Click + Add Client to create one.";
      clientCardsGridEl.appendChild(empty);
      return;
    }

    for (const ov of overviews) {
      const card = createClientOverviewCard({
        overview: ov,
        isActive: ov.clientId === activeId,
        onSelectManage: async (cid) => {
          await selectClient(cid);
          activeClientWorkspaceEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
        },
        onStartCheck: async (cid) => {
          await selectClient(cid);
          if (onStartCheckFlow) onStartCheckFlow(activeWorkspace);
        },
        onEdit: async (cid) => {
          const ws = await chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.CLIENT_GET_WORKSPACE,
            payload: { clientId: cid },
          });
          if (ws?.ok) {
            populateEditor(ws.client);
            clientEditorPanel.classList.remove("hidden");
          }
        },
        onDuplicate: async (cid, overview) => {
          const res = await chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.CLIENT_DUPLICATE,
            payload: { clientId: cid },
          });
          if (res?.ok) {
            setBanner(clientFeedbackEl, "success", `Duplicated '${overview.clientName}'.`);
            await refreshOverviews();
          } else {
            setBanner(clientFeedbackEl, "error", res?.error || res?.errors?.join(" ") || "Duplicate failed.");
          }
        },
        onArchive: async (cid) => {
          const res = await chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.CLIENT_ARCHIVE,
            payload: { clientId: cid },
          });
          if (res?.ok) await refreshOverviews({ preserveWorkspace: true });
        },
        onDelete: async (cid, overview) => {
          if (!confirmAction(`Permanently delete '${overview.clientName}' and all isolated data?`)) return;
          const res = await chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.CLIENT_DELETE,
            payload: { clientId: cid, confirmed: true },
          });
          if (res?.ok) {
            if (activeWorkspace?.client?.clientId === cid) renderWorkspace(null);
            setBanner(clientFeedbackEl, "success", `Deleted '${overview.clientName}'.`);
            await refreshOverviews();
          }
        },
      });
      clientCardsGridEl.appendChild(card);
    }
  }

  async function refreshWorkspace(clientId, locationId = null) {
    if (!clientId) {
      renderWorkspace(null);
      return;
    }
    const ws = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CLIENT_GET_WORKSPACE,
      payload: { clientId, locationId },
    });
    if (ws?.ok) renderWorkspace(ws);
  }

  async function refreshOverviews({ preserveWorkspace = false } = {}) {
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CLIENT_LIST_OVERVIEWS,
      payload: {
        query: clientSearchInput.value,
        includeArchived: Boolean(clientShowArchivedChk.checked),
      },
    });
    if (res?.ok) {
      if (res.active?.clientId && (!activeWorkspace || preserveWorkspace)) {
        await refreshWorkspace(res.active.clientId, res.active.locationId);
      }
      renderCards(res.overviews || []);
      return res;
    }
    return null;
  }

  async function selectClient(clientId, locationId = null) {
    setBanner(clientFeedbackEl, null, "");
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CLIENT_SELECT,
      payload: { clientId, locationId },
    });
    if (!res?.ok) {
      setBanner(clientFeedbackEl, "error", res?.error || "Unable to select client.");
      return null;
    }
    renderWorkspace(res);
    renderCards(overviewsCache);
    setBanner(
      clientFeedbackEl,
      "warning",
      `Switched to '${res.client.clientName}'. Previous location verification was reset — verify location before running checks.`
    );
    return res;
  }

  // Event wiring
  clientSearchInput.addEventListener("input", () => refreshOverviews());
  clientShowArchivedChk.addEventListener("change", () => refreshOverviews());
  clientNewBtn.addEventListener("click", () => {
    populateEditor(null);
    clientEditorPanel.classList.remove("hidden");
  });
  clientCancelBtn.addEventListener("click", () => clientEditorPanel.classList.add("hidden"));

  cliSheetUrlInput.addEventListener("input", () => {
    const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(cliSheetUrlInput.value.trim());
    if (m && !cliSheetIdInput.value.trim()) cliSheetIdInput.value = m[1];
  });

  clientEditorForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setBanner(clientFeedbackEl, null, "");
    const cid = cliIdInput.value.trim();
    const payloadData = {
      clientName: cliNameInput.value,
      websiteDomain: cliDomainInput.value,
      websiteUrl: cliUrlInput.value,
      status: cliStatusSelect.value,
      notes: cliNotesInput.value,
      sheetConfig: {
        sheetUrl: cliSheetUrlInput.value,
        spreadsheetId: cliSheetIdInput.value,
        worksheetName: cliWsNameInput.value,
        worksheetId: cliWsIdInput.value,
        keywordColumn: cliColKwInput.value,
        searchVolumeColumn: cliColVolInput.value,
        competitionColumn: cliColCompInput.value,
        landingPageColumn: cliColLpInput.value,
        serpColumn: cliColSerpInput.value,
        latestDateColumn: cliColDateInput.value,
      },
    };
    const res = cid
      ? await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.CLIENT_UPDATE, payload: { clientId: cid, updates: payloadData } })
      : await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.CLIENT_CREATE, payload: payloadData });

    if (!res?.ok) {
      setBanner(clientFeedbackEl, "error", res?.errors?.join(" ") || res?.error || "Failed saving client.");
      return;
    }
    clientEditorPanel.classList.add("hidden");
    await selectClient(res.client.clientId);
    await refreshOverviews({ preserveWorkspace: true });
    setBanner(clientFeedbackEl, "success", `Saved client '${res.client.clientName}'.`);
  });

  cliAddLocBtn.addEventListener("click", async () => {
    if (!activeWorkspace?.client) return;
    const parsed = parseCoordinatePair(cliLocCoordsInput.value.trim());
    const locDefs = getLocationDefaults();
    const rankDefs = getRankingDefaults();
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CLIENT_ADD_LOCATION,
      payload: {
        clientId: activeWorkspace.client.clientId,
        locationName: cliLocNameInput.value,
        stateRegion: cliLocStateInput.value,
        latitude: parsed ? parsed.latitude : "",
        longitude: parsed ? parsed.longitude : "",
        ...locDefs,
        ...rankDefs,
        worksheetName: cliLocWsInput.value,
        reportingRange: cliLocColInput.value,
      },
    });
    if (!res?.ok) {
      setBanner(clientFeedbackEl, "error", res?.errors?.join(" ") || res?.error || "Unable to add location.");
      return;
    }
    cliLocNameInput.value = "";
    cliLocCoordsInput.value = "";
    cliLocStateInput.value = "";
    cliLocWsInput.value = "";
    cliLocColInput.value = "";
    await refreshWorkspace(activeWorkspace.client.clientId, res.location.locationId);
    await refreshOverviews();
  });

  cliAddKwsBtn.addEventListener("click", async () => {
    if (!activeWorkspace?.client) return;
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CLIENT_IMPORT_KEYWORDS_TEXT,
      payload: {
        clientId: activeWorkspace.client.clientId,
        rawText: cliKwPasteInput.value,
        defaultLocationId: activeWorkspace.selectedLocation?.locationId || null,
      },
    });
    if (res?.ok) {
      cliKwPasteInput.value = "";
      await refreshWorkspace(activeWorkspace.client.clientId);
      await refreshOverviews();
    } else {
      setBanner(clientFeedbackEl, "error", res?.error || "Unable to add keywords.");
    }
  });

  cliKwCsvFileInput.addEventListener("change", async () => {
    const file = cliKwCsvFileInput.files?.[0];
    if (!file || !activeWorkspace?.client) return;
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CLIENT_IMPORT_KEYWORDS_CSV,
      payload: {
        clientId: activeWorkspace.client.clientId,
        csvText: await file.text(),
        defaultLocationId: activeWorkspace.selectedLocation?.locationId || null,
      },
    });
    cliKwCsvFileInput.value = "";
    if (res?.ok) {
      await refreshWorkspace(activeWorkspace.client.clientId);
      await refreshOverviews();
    }
  });

  clientBackupBtn.addEventListener("click", async () => {
    if (!activeWorkspace?.client) return;
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CLIENT_BACKUP_CREATE,
      payload: { clientId: activeWorkspace.client.clientId },
    });
    if (res?.ok) setBanner(clientFeedbackEl, "success", `Created local backup snapshot (${res.backup.backupId}).`);
  });

  clientExportBtn.addEventListener("click", async () => {
    if (!activeWorkspace?.client) return;
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CLIENT_EXPORT_CONFIG,
      payload: { clientId: activeWorkspace.client.clientId },
    });
    if (res?.ok) {
      const safeName = activeWorkspace.client.websiteDomain.replace(/[^a-z0-9.-]+/gi, "-");
      downloadTextFile(`${safeName}-client-config.json`, res.json, "application/json;charset=utf-8");
    }
  });

  clientImportFileInput.addEventListener("change", async () => {
    const file = clientImportFileInput.files?.[0];
    if (!file) return;
    const json = await file.text();
    clientImportFileInput.value = "";
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CLIENT_IMPORT_CONFIG,
      payload: { json },
    });
    if (res?.ok) {
      await selectClient(res.client.clientId);
      await refreshOverviews({ preserveWorkspace: true });
    } else {
      setBanner(clientFeedbackEl, "error", res?.errors?.join(" ") || res?.error || "Import failed.");
    }
  });

  // Client Dashboard Quick Actions
  clientQaCheckBtn?.addEventListener("click", () => {
    if (onStartCheckFlow && activeWorkspace) onStartCheckFlow(activeWorkspace);
  });
  clientQaVerifyBtn?.addEventListener("click", () => onNavigate("jobs"));
  clientQaSheetBtn?.addEventListener("click", () => {
    const url = activeWorkspace?.client?.sheetConfig?.sheetUrl;
    if (url) window.open(url, "_blank", "noopener");
    else onNavigate("google-sheets");
  });
  clientQaHistoryBtn?.addEventListener("click", () => {
    if (onViewClientHistory && activeWorkspace?.client) onViewClientHistory(activeWorkspace.client.clientId);
  });
  clientQaEditBtn?.addEventListener("click", () => {
    if (activeWorkspace?.client) {
      populateEditor(activeWorkspace.client);
      clientEditorPanel.classList.remove("hidden");
    }
  });

  return {
    refreshOverviews,
    refreshWorkspace,
    selectClient,
    getActiveWorkspace: () => activeWorkspace,
    getOverviews: () => overviewsCache,
    clientLoadBulkBtn,
  };
}

