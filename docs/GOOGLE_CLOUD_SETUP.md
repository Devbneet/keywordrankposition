# Google Cloud & Chrome Extension OAuth 2.0 Setup Guide

Follow these steps to configure Google Sheets API read-only authentication (`Phase 8`) for **Digital Minds Rank Tracker** without storing private credentials or secrets in Git.

> **Important Scope Notice:**  
> Phase 8 requests strictly the read-only scope:  
> `https://www.googleapis.com/auth/spreadsheets.readonly`  
> Google OAuth applies this permission at the Google Account level—once approved, the extension can **read** spreadsheets accessible to that signed-in Google account, not only a single worksheet. It **cannot** edit, insert, delete, or format any spreadsheet data, and does **not** request broad Google Drive permissions.

---

## Step-by-Step Configuration

1. **Open Google Cloud Console**  
   Navigate to `https://console.cloud.google.com/` using an authorized agency Google account.
2. **Create a Google Cloud Project**  
   Click the project selector -> **New Project**, name it (e.g., `Digital-Minds-Rank-Tracker`), and select it.
3. **Enable the Google Sheets API**  
   Go to **APIs & Services -> Library**, search for **Google Sheets API**, and click **Enable**.
4. **Configure the OAuth Consent Screen**  
   - Go to **APIs & Services -> OAuth consent screen**.
   - Choose **Internal** (if Google Workspace agency domain) or **External** (`Testing` mode for private agency testing).
   - Fill in App Name (`Digital Minds Rank Tracker`), User Support Email, and Developer Contact Email.
   - Under **Scopes**, add ONLY `https://www.googleapis.com/auth/spreadsheets.readonly`.
5. **Configure Test Users (if External / Testing)**  
   Add the agency Google accounts that will access client spreadsheets during testing.
6. **Load the Unpacked Chrome Extension**  
   Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `C:\Users\harsh\Documents\KeywordRankPosition`.
7. **Obtain the Chrome Extension ID**  
   Copy the 32-character Extension ID shown on the extension card in `chrome://extensions`.
8. **Create the Chrome Extension OAuth Client**  
   - Go to **APIs & Services -> Credentials -> Create Credentials -> OAuth client ID**.
   - Application type: **Chrome Extension**.
   - Name: `Digital Minds Rank Tracker (Local / Prod)`.
   - Item ID: paste the 32-character Chrome Extension ID obtained in Step 7.
9. **Configure the OAuth Client ID Locally**  
   In your local workspace copy of `manifest.json` (or private local build config — **never commit private client secrets or tokens**), add the `oauth2` block with your public Chrome Extension Client ID:
   ```json
   "oauth2": {
     "client_id": "YOUR_NUMERIC_ID.apps.googleusercontent.com",
     "scopes": [
       "https://www.googleapis.com/auth/spreadsheets.readonly"
     ]
   }
   ```
   *(Never add `spreadsheets` write scope, Drive scopes, service-account keys, or client secrets.)*
10. **Reload the Extension**  
    Return to `chrome://extensions` and click **Reload** on Digital Minds Rank Tracker.
11. **Connect the Google Account**  
    Open the extension dashboard -> **Google Sheets Integration (Phase 8)** -> click **Connect Google Account**, and grant the read-only permission.
12. **Test Access to an Existing Spreadsheet**  
    Select a client, paste a Google Sheet URL (`https://docs.google.com/spreadsheets/d/.../edit#gid=...`), click **Load Worksheets**, then click **Test Connection** / **Preview & Read Sheet**.

---

## Maintaining a Stable Extension ID Across Environments

Unpacked Chrome extensions change ID whenever loaded from a different filesystem path unless pinned with a public key or published as an unlisted/internal Chrome Web Store item:

- **Recommended (Unlisted Chrome Web Store / Workspace Private Distribution):** Generating the extension package or private key once keeps the `Item ID` permanent across team machines.
- **Local Unpacked Development:** Pin `"key": "<BASE64_PUBLIC_KEY>"` locally if needed across workstations, while keeping private `.pem` keys **strictly outside the repository** (never commit private `.pem`, `client_secret*.json`, tokens, or service-account files).
- Verify your git status never includes `oauth_credentials*`, `*.pem`, `service-account*.json`, or token files.

