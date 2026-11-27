# Ranking Accuracy Test Plan (GS Location Changer Comparison)

This document defines the manual accuracy validation plan using the **Ranking Accuracy Lab** to compare **Digital Minds Rank Tracker** against manually verified **GS Location Changer** baselines.

> **Status:** Manual verification pending.

---

## Objective & Targets

- **Sample Size:** Minimum **20 keywords** across at least 2–3 target locations (e.g., Sydney, Melbourne, London).
- **Exact Match Target:** >= **90%** exact position match against GS Location Changer manual baseline (excluding CAPTCHA/blocked/incomplete failures from accuracy denominator, while reporting failure rate separately).
- **Top 10 Agreement Target:** >= **95%** agreement on whether a keyword ranks in Top 10 vs >10/Not Found.

---

## Procedure

1. **Prepare GS Location Changer Baseline CSV**:
   - Export or prepare a CSV with the 8 supported baseline columns:
     `keyword`, `domain`, `location_name`, `latitude`, `longitude`, `search_depth`, `manual_rank`, `notes`.
   - Include a mix of:
     - Top 3 rankings (positions 1–3)
     - Page 1 rankings (positions 4–10)
     - Page 2+ rankings (positions 11–50)
     - Confirmed `Not Found` (`NA`) keywords
2. **Verify Location in Digital Minds Rank Tracker**:
   - Select the matching test client and location.
   - Run **Apply Browser Location** -> **Verify Google Location** and confirm `Device-Based` match.
3. **Run Comparison in Ranking Accuracy Lab**:
   - Open **Ranking Accuracy Lab** in the dashboard.
   - Import the 20+ keyword baseline CSV.
   - Execute authorized live checks for the comparison set (or import results from a completed bulk check).
   - Review per-keyword classification (`Exact Match`, `Close Match`, `Mismatch`, `False Positive`, `False Negative`, `Excluded Failure`).
4. **Export Evidence**:
   - Export both CSV and JSON comparison reports from the Accuracy Lab.
   - Record any discrepancies caused by SERP personalization, dynamic local packs, or organic layout shifts.

