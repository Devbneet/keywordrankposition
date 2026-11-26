# Automation Limitations & Operational Constraints

Scheduled ranking automation inside a Manifest V3 Chrome Extension operates strictly within browser, operating-system, and Google access constraints:

1. **Computer & Chrome Must Be Powered On**:
   - Scheduled checks execute via Chrome Extension service workers and `chrome.alarms`.
   - If the computer is shut down, sleeping, or Google Chrome is closed at the scheduled time, Chrome cannot run the check until the browser restarts (`onStartup` missed-run check).
2. **Visible Tab & Active Browser Session Requirements**:
   - GPS emulation via Chrome Debugger (`chrome.debugger`) and Google Search verification require an interactive browser window/tab with authorized access and valid session permissions.
3. **Google OAuth Session Availability**:
   - Connected Google Sheets read access (`spreadsheets.readonly`) requires an active, unrevoked Google OAuth token in the signed-in Chrome profile. Expired/revoked OAuth halts the scheduled client run and surfaces a notification & failure status without data loss.
4. **CAPTCHA & Anti-Bot Limits (No Evasion)**:
   - Digital Minds Rank Tracker **never** solves, bypasses, or evades CAPTCHA / unusual traffic checks.
   - If Google presents a CAPTCHA or traffic block during a scheduled batch, execution stops immediately, partial verified results are preserved safely, remaining keywords stay unmarked (never recorded as `Not Found`), and the schedule is marked `Needs attention`.
5. **No Parallel Searches & Conflict Deferral**:
   - Only one client and one keyword search execute at a time.
   - If a manual single check, bulk check, client switch, backup restore, or Google Sheet update lock is active when a scheduled alarm fires, the scheduled run stays in the persistent `Queued` state and defers automatically rather than colliding.
6. **Production Google Sheets Stay Protected**:
   - Automatic unattended Google Sheet writes on production client spreadsheets remain disabled until dedicated Phase 12 sandbox verification and agency sign-off (`Mode A` dry-run preview preparation only).

