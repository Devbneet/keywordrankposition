# Installation Guide — Digital Minds Rank Tracker (Unpacked Chrome Extension)

This extension is distributed internally for **Digital Minds** as an **unpacked Chrome Extension (Manifest V3)** — it is **not** published to the Chrome Web Store.

---

## System Requirements

- **Google Chrome** (Desktop, version 120+ recommended)
- **Operating System:** Windows, macOS, or Linux
- **Google Account** with access to the agency Google Sheets (for Phase 8/9 Sheets integration)
- **Node.js 20+** (only required if running automated tests or building the `v1.0.0-rc.1` release folder)

---

## Installing the Unpacked Extension

1. Obtain either:
   - The clean release package folder `dist/digital-minds-rank-tracker-v1.0.0-rc.1/` (recommended for agency workstations), **or**
   - The repository folder `C:\Users\harsh\Documents\KeywordRankPosition`.
2. Open Google Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked**.
5. Select the extension root folder (containing `manifest.json`).
6. Verify **Digital Minds Rank Tracker** appears with:
   - Version: `1.0.0` (`1.0.0-rc.1`)
   - **No manifest or service worker errors**.
7. Pin the extension icon to the Chrome toolbar, click it, confirm **Extension Health: Healthy**, and click **Open Dashboard**.

---

## Configuring Google Sheets OAuth (Optional for Local Checks, Required for Sheets)

Follow [GOOGLE_CLOUD_SETUP.md](./GOOGLE_CLOUD_SETUP.md) to register your Extension ID in Google Cloud Console and configure the `oauth2.client_id` in `manifest.json`. After updating `manifest.json`, click **Reload** on the extension card in `chrome://extensions`.

