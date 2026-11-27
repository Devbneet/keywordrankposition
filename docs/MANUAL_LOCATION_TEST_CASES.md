# Manual Location Test Cases — 5 Target Cities

This document defines the manual Chrome verification test cases for **Phase 2 (Browser Geolocation Simulation)** and **Phase 3 (Google Search Location Verification)** across five agency target cities.

> **Status:** Manual verification pending (to be executed in Google Chrome with the unpacked extension loaded).

---

## Preconditions

1. Load **Digital Minds Rank Tracker** (`v1.0.0-rc.1`) as an unpacked extension in `chrome://extensions`.
2. Open the extension Dashboard -> **Clients** (or **Settings** / Location Controls).
3. Ensure no other debugger-attaching extension is active on the dedicated verification tab.
4. For each city below, click **Apply Browser Location**, **Test Browser GPS**, **Apply to Google Search**, and **Verify Google Location**.

---

## Test Cases

### 1. Sydney, Australia
- **Target Coordinates:** `-33.8688, 151.2093` (Accuracy: `25` m)
- **Country / Language / Google Domain:** `AU` / `en` / `google.com.au`
- **Expected Browser GPS:** `navigator.geolocation.getCurrentPosition()` returns `-33.8688, 151.2093` within tolerance; Browser GPS status = `Verified`.
- **Expected Google Search Location:** Google Search footer/location indicator resolves to `Sydney` / `Sydney NSW` with device-based match (`Device-Based`).
- **Expected Failure Handling:** If Google shows `IP-Based` only or another city, status must report mismatch and block live ranking checks.

### 2. Melbourne, Australia
- **Target Coordinates:** `-37.8136, 144.9631` (Accuracy: `25` m)
- **Country / Language / Google Domain:** `AU` / `en` / `google.com.au`
- **Expected Browser GPS:** `navigator.geolocation.getCurrentPosition()` returns `-37.8136, 144.9631`; Browser GPS status = `Verified`.
- **Expected Google Search Location:** Google Search footer resolves to `Melbourne` / `Melbourne VIC` with device-based match.

### 3. London, United Kingdom
- **Target Coordinates:** `51.5074, -0.1278` (Accuracy: `25` m)
- **Country / Language / Google Domain:** `GB` / `en` / `google.co.uk`
- **Expected Browser GPS:** `navigator.geolocation.getCurrentPosition()` returns `51.5074, -0.1278`; Browser GPS status = `Verified`.
- **Expected Google Search Location:** Google Search footer resolves to `London` with device-based match.

### 4. New York, United States
- **Target Coordinates:** `40.7128, -74.0060` (Accuracy: `25` m)
- **Country / Language / Google Domain:** `US` / `en` / `google.com`
- **Expected Browser GPS:** `navigator.geolocation.getCurrentPosition()` returns `40.7128, -74.0060`; Browser GPS status = `Verified`.
- **Expected Google Search Location:** Google Search footer resolves to `New York` (exact boundary match — must **not** match `York, UK`).

### 5. Delhi, India
- **Target Coordinates:** `28.6139, 77.2090` (Accuracy: `25` m)
- **Country / Language / Google Domain:** `IN` / `en` / `google.co.in`
- **Expected Browser GPS:** `navigator.geolocation.getCurrentPosition()` returns `28.6139, 77.2090`; Browser GPS status = `Verified`.
- **Expected Google Search Location:** Google Search footer resolves to `Delhi` or `New Delhi` with device-based match.

---

## Pass Criteria

- All 5 cities report **Browser GPS: Verified** with coordinates matching configured lat/lng.
- Google Search footer verification distinguishes `Device-Based` vs `IP-Based` matches.
- Switching between cities or clients immediately invalidates the prior location verification state.
- Detaching the Chrome debugger or closing the dedicated tab immediately marks location as unverified.

