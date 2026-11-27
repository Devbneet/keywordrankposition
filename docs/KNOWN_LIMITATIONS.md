# Known Limitations — Digital Minds Rank Tracker (`v1.0.0-rc.1`)

1. **Chrome & Computer Must Be Active for Schedules**:
   - Manifest V3 `chrome.alarms` only fire while Google Chrome is running and the workstation is awake. Missed runs are detected on startup and handled via the configured missed-run policy.
2. **No CAPTCHA Bypass**:
   - The extension strictly respects Google Search access controls and never solves or bypasses CAPTCHAs or anti-bot gates. High-frequency bulk runs may trigger Google rate limits.
3. **Interactive Browser Session Required**:
   - `chrome.debugger` geolocation emulation and DOM-based SERP inspection require an active Chrome window and tab.
4. **Production Google Sheet Writes Disabled by Default**:
   - Unattended scheduled writes (`Mode B`) to production client spreadsheets remain blocked until manual Sandbox verification and agency sign-off are completed.
5. **Unpacked Extension ID Stability**:
   - Loading the unpacked extension from different filesystem paths on different machines generates different Chrome Extension IDs unless pinned with a Chrome Extension public key or distributed privately. Update Google Cloud OAuth `Item ID` accordingly.
6. **Manual Verification Status**:
   - Automated unit and integration tests pass in Node.js with mocked Chrome APIs; live Chrome browser verification across the 5 target cities, 20+ keyword GS Location Changer comparison, and live Sandbox Google Sheets OAuth testing remain **pending manual execution**.

