# Digital Minds Rank Tracker (Chrome Extension)

An internal, 100% free **Chrome Extension (Manifest V3)** for **Digital Minds** to check location-specific organic keyword rankings and update client Google Sheets while preserving all spreadsheet formatting and history.

## Phase 1 Status

**Phase 1: Clean previous Python project and initialize Chrome extension** — Complete (ready for manual unpacked extension verification in Chrome).

> Note: The previous Python/Playwright implementation is preserved safely on the `backup/python-version` branch.

## Folder Structure

```text
keywordrankposition/
├── manifest.json               # Chrome Extension Manifest V3 configuration
├── package.json                # Node.js native test runner configuration
├── README.md                   # Setup, testing, and Chrome loading guide
├── ROADMAP.md                  # 12-phase development roadmap
├── SHEET_REQUIREMENTS.md       # Non-negotiable Google Sheet preservation rules
├── ARCHITECTURE.md             # Extension architecture & design principles
├── .gitignore                  # Ignores credentials, local exports, OS/IDE files
├── background/
│   └── service-worker.js       # MV3 background service worker
├── popup/
│   ├── popup.html              # Extension popup UI
│   ├── popup.css
│   └── popup.js
├── dashboard/
│   ├── dashboard.html          # Agency workspace page
│   ├── dashboard.css
│   └── dashboard.js
├── content/
│   └── search-content.js       # Content script placeholder (Phases 3-4)
├── modules/
│   ├── location/               # Geolocation simulation (Phase 2)
│   ├── ranking/                # Organic rank detection (Phases 4-5)
│   ├── sheets/                 # Google Sheets reader & updater (Phases 8-9)
│   ├── clients/                # Multi-client config (Phase 7)
│   ├── jobs/                   # Bulk job & pause/resume (Phase 6)
│   └── storage/
│       └── storage.js          # chrome.storage.local wrapper & health ping
├── utils/
│   ├── health.js               # Standardized health report builder
│   └── messages.js             # Popup <-> service worker message constants
├── icons/                      # Extension icons (16, 32, 48, 128 px)
├── tests/
│   └── smoke.test.mjs          # Node.js native smoke tests
└── docs/
```

## Running Automated Tests

Requires Node.js 20+ (no external packages needed):

```powershell
node --test tests/*.test.mjs
```

## Loading the Extension in Google Chrome

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Turn **Developer mode** ON (top-right toggle).
3. Click **Load unpacked**.
4. Select `C:\Users\harsh\Documents\KeywordRankPosition`.
5. Confirm **Digital Minds Rank Tracker** (`v0.1.0`) appears with no manifest errors.
6. Click the extension icon in the Chrome toolbar to open the popup, confirm **Extension Health: Healthy**, and click **Open Dashboard**.
