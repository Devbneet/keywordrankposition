# Architecture — Digital Minds Rank Tracker

## Overview

Digital Minds Rank Tracker is a **Manifest V3** Chrome extension built with **Vanilla JavaScript (ES modules)**, HTML5, CSS3, and the **Node.js native test runner** (`node --test`) — with zero external dependencies, zero paid APIs, and zero backend hosting.

## Phase 1 Core Architecture

- **`manifest.json` (MV3):** Requests only the minimum Phase 1 permissions (`storage`, `tabs`). Additional permissions (`debugger`, `identity`, `alarms`, host permissions) will be added only in the phases that require them.
- **`background/service-worker.js`:** ES module service worker handling extension lifecycle (`onInstalled`), health checks (`HEALTH_CHECK`), storage self-tests (`STORAGE_SELF_TEST`), and dashboard tab opening/focusing (`OPEN_DASHBOARD`). Exposes `handleRuntimeMessage` with an injectable `chromeApi` parameter for isolated Node.js testing.
- **`modules/storage/storage.js`:** Promise-based `chrome.storage.local` client with `pingStorage()` round-trip verification.
- **`popup/` & `dashboard/`:** Clean agency UI using dark navy (`#0F2744`), blue accent (`#2563EB`), and semantic status pills (green/red/amber).

## Planned Phase Architecture Guardrails

1. **Location Simulation (Phases 2–3):** Uses `chrome.debugger` + `Emulation.setGeolocationOverride` scoped strictly to a dedicated testing tab, with explicit handling for debugger detachment, closed tabs, and location reset. Maintains 8 distinct verification states separating **Browser GPS verified** (`navigator.geolocation`) from **Google search location verified** (acknowledging IP/account signals).
2. **Organic Ranking (Phases 4–6):** Counts genuine organic results only (excluding ads, local packs, PAA, AI Overviews, and shopping blocks), distinguishes confirmed `NA` from incomplete/blocked/error states, and halts immediately on CAPTCHA or access restrictions.
3. **Google Sheets Preservation (Phases 8–9):** Enforces every rule in [SHEET_REQUIREMENTS.md](SHEET_REQUIREMENTS.md) — backups before write, dry-run previews, structural validation, configurable client mappings, and atomic batch updates.

