/**
 * Per-client keyword management: single add, paste, CSV/TXT import, groups,
 * spreadsheet row references, and duplicate-keyword preservation.
 */

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function makeKeywordId(clientId, index) {
  return `kw_${clientId}_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`;
}

export function createKeywordManager({ clientStorage }) {
  async function listKeywords(clientId, { activeOnly = false } = {}) {
    const rows = await clientStorage.listKeywordsByClient(clientId);
    return activeOnly ? rows.filter((r) => r.active !== false) : rows;
  }

  async function addKeywords({
    clientId,
    items = [],
    defaultLocationId = null,
    defaultGroup = "Default",
  }) {
    if (!clientId) {
      return { ok: false, error: "clientId is required." };
    }
    const existing = await clientStorage.listKeywordsByClient(clientId);
    const maxOrder = existing.reduce((max, k) => Math.max(max, k.sortOrder ?? 0), -1);
    const now = new Date().toISOString();

    const toSave = [];
    items.forEach((raw, idx) => {
      const obj = typeof raw === "string" ? { keyword: raw } : raw || {};
      const kw = String(obj.keyword || "").trim();
      if (!kw) return;

      const sortOrder = maxOrder + 1 + toSave.length;
      const rowRef =
        obj.rowPosition !== undefined && obj.rowPosition !== null && String(obj.rowPosition).trim() !== ""
          ? Number(obj.rowPosition)
          : sortOrder + 1;

      toSave.push({
        keywordId: obj.keywordId || makeKeywordId(clientId, idx),
        clientId,
        locationId: obj.locationId || defaultLocationId || null,
        keyword: kw,
        keywordGroup: String(obj.keywordGroup || defaultGroup || "Default").trim(),
        rowPosition: Number.isFinite(rowRef) ? rowRef : sortOrder + 1,
        landingPage: String(obj.landingPage || "").trim(),
        searchVolume: String(obj.searchVolume ?? "").trim(),
        competition: String(obj.competition || "").trim(),
        active: obj.active !== false,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      });
    });

    if (toSave.length === 0) {
      return { ok: false, error: "No valid keywords provided." };
    }

    const res = await clientStorage.saveKeywordsBulk(toSave);
    if (!res.ok) {
      return { ok: false, error: res.error, quotaExceeded: res.quotaExceeded };
    }
    return { ok: true, added: toSave };
  }

  async function importFromText({ clientId, rawText, defaultLocationId = null, defaultGroup = "Default" }) {
    const items = String(rawText || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((keyword) => ({ keyword }));
    return addKeywords({ clientId, items, defaultLocationId, defaultGroup });
  }

  async function importFromCsv({ clientId, csvText, defaultLocationId = null }) {
    const lines = String(csvText || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .filter((l) => l.trim() !== "");

    if (lines.length === 0) {
      return { ok: false, error: "CSV is empty." };
    }

    const firstCells = parseCsvLine(lines[0]);
    const headerMap = new Map();
    firstCells.forEach((cell, idx) =>
      headerMap.set(cell.toLowerCase().replace(/[^a-z0-9]/g, ""), idx)
    );

    const hasHeader = headerMap.has("keyword");
    const startIdx = hasHeader ? 1 : 0;
    const col = (cells, ...keys) => {
      for (const k of keys) {
        const idx = headerMap.get(k);
        if (idx !== undefined && idx < cells.length) return cells[idx];
      }
      return "";
    };

    const items = [];
    for (let i = startIdx; i < lines.length; i += 1) {
      const cells = parseCsvLine(lines[i]);
      const keyword = hasHeader ? col(cells, "keyword") : cells[0];
      if (!String(keyword || "").trim()) continue;

      items.push({
        keyword: String(keyword).trim(),
        keywordGroup: hasHeader ? col(cells, "keywordgroup", "group") || "Default" : "Default",
        rowPosition: hasHeader ? col(cells, "rowposition", "row", "rownumber") : undefined,
        landingPage: hasHeader ? col(cells, "landingpage", "url") : "",
        searchVolume: hasHeader ? col(cells, "searchvolume", "volume") : "",
        competition: hasHeader ? col(cells, "competition", "comp") : "",
        active: hasHeader ? col(cells, "active").toLowerCase() !== "false" : true,
      });
    }

    return addKeywords({ clientId, items, defaultLocationId });
  }

  async function updateKeyword(clientId, keywordId, updates = {}) {
    const list = await clientStorage.listKeywordsByClient(clientId);
    const existing = list.find((k) => k.keywordId === keywordId);
    if (!existing) {
      return { ok: false, error: `Keyword '${keywordId}' not found.` };
    }

    const nextKeyword = String(updates.keyword ?? existing.keyword).trim();
    if (!nextKeyword) {
      return { ok: false, error: "Keyword text cannot be empty." };
    }

    const updated = {
      ...existing,
      ...updates,
      keywordId,
      clientId,
      keyword: nextKeyword,
      updatedAt: new Date().toISOString(),
    };
    const res = await clientStorage.saveKeyword(updated);
    if (!res.ok) {
      return { ok: false, error: res.error, quotaExceeded: res.quotaExceeded };
    }
    return { ok: true, keyword: updated };
  }

  async function deleteKeyword(keywordId) {
    return clientStorage.deleteKeyword(keywordId);
  }

  return {
    listKeywords,
    addKeywords,
    importFromText,
    importFromCsv,
    updateKeyword,
    deleteKeyword,
  };
}

