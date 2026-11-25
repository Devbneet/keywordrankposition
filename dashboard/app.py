"""Streamlit dashboard for Digital Minds Keyword Ranking Automation."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import streamlit as st

from dashboard.data_service import (
    compute_run_metrics,
    items_to_table_rows,
    list_recent_backups,
    load_dashboard_clients,
    load_dashboard_runs,
)
from dashboard.single_test_service import (
    classify_rank_outcome,
    run_single_keyword_test,
    verify_location_in_browser,
)
from src.location.geolocation import GeoLocation
from src.ranking.accuracy_comparator import compare_with_gs_baseline, load_gs_baseline_csv
from src.storage.sqlite_store import RankingStore

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.getenv("SQLITE_DB_PATH", str(PROJECT_ROOT / "data" / "rankings.db")))
BACKUP_DIR = PROJECT_ROOT / "backups"

st.set_page_config(page_title="Digital Minds | Keyword Rank Tracker", layout="wide")
st.title("Digital Minds — Keyword Ranking Dashboard")
st.caption("Local geolocation rank tracking, GS Location Changer comparison, and safe Google Sheets backups.")

clients = load_dashboard_clients(PROJECT_ROOT)
runs = load_dashboard_runs(DB_PATH)

with st.sidebar:
    st.header("Clients")
    for client in clients:
        badge = "Active" if client.active else "Inactive"
        st.markdown(f"**{client.client_name}** (`{badge}`)")
        st.caption(f"Domain: {client.website_domain} | Locations: {len(client.locations)}")

    st.divider()
    st.header("Saved Runs")
    if runs:
        run_labels = {
            f"{r['created_at'][:19]} | {r['client_id']} ({r['location_name']})": r["run_id"]
            for r in runs
        }
        selected_label = st.selectbox("Select a ranking run", list(run_labels.keys()))
        selected_run_id = run_labels[selected_label]
    else:
        selected_run_id = None
        st.info("No ranking runs recorded yet in SQLite.")

tab_single, tab_results, tab_compare, tab_backups = st.tabs(
    ["Single Keyword Test", "Ranking Results", "GS Location Changer Comparison", "Sheet Backups"]
)

with tab_single:
    st.subheader("Single Keyword Test")
    st.caption("Opens visible Chromium (`headless=False`) for live checks, or parses manually supplied SERP HTML.")

    col_left, col_right = st.columns(2)
    with col_left:
        test_domain = st.text_input("Website Domain", value="example.com", placeholder="example.com")
        test_keyword = st.text_input("Keyword", value="seo agency sydney", placeholder="Enter keyword")
        search_depth = st.selectbox("Search Depth", options=[10, 20, 30, 50, 100], index=3)

    with col_right:
        test_lat = st.number_input("Latitude", min_value=-90.0, max_value=90.0, value=-33.8688, format="%.6f")
        test_lng = st.number_input("Longitude", min_value=-180.0, max_value=180.0, value=151.2093, format="%.6f")
        input_mode = st.radio(
            "Search Input Mode",
            options=["Visible Chromium (Authorized Search Access)", "Manual SERP HTML"],
            horizontal=True,
        )

    manual_html = ""
    if input_mode == "Manual SERP HTML":
        uploaded_html = st.file_uploader("Upload SERP HTML file (optional)", type=["html", "htm"])
        pasted_html = st.text_area("Or paste SERP HTML", height=160)
        if uploaded_html is not None:
            manual_html = uploaded_html.getvalue().decode("utf-8", errors="replace")
        else:
            manual_html = pasted_html

    btn_col1, btn_col2 = st.columns(2)
    verify_clicked = btn_col1.button("Verify Location", use_container_width=True)
    check_clicked = btn_col2.button("Check Ranking", type="primary", use_container_width=True)

    if verify_clicked:
        try:
            geo = GeoLocation(latitude=float(test_lat), longitude=float(test_lng))
        except ValueError as exc:
            st.error(f"Invalid coordinates: {exc}")
        else:
            with st.spinner("Opening visible Chromium and verifying browser GPS & Google location..."):
                loc_res = verify_location_in_browser(geo, headless=False)

            gps_col, google_col = st.columns(2)
            with gps_col:
                st.markdown("**Browser GPS (`navigator.geolocation`)**")
                if loc_res.browser_gps_verified and loc_res.browser_gps is not None:
                    st.success(
                        f"Verified: {loc_res.browser_gps['latitude']:.6f}, "
                        f"{loc_res.browser_gps['longitude']:.6f} "
                        f"(±{loc_res.browser_gps['accuracy']:.0f}m)"
                    )
                else:
                    st.error(f"Browser GPS verification failed: {loc_res.error_message or 'Unknown error'}")

            with google_col:
                st.markdown("**Google Detected Location**")
                if loc_res.google_status == "detected" and loc_res.google_detected_location:
                    st.success(f"Detected: {loc_res.google_detected_location}")
                elif loc_res.google_status == "blocked":
                    st.error(f"Stopped — CAPTCHA / Access Restriction: {loc_res.error_message}")
                elif loc_res.google_status == "unavailable":
                    st.warning("Google did not display a detected location footer on the page.")
                else:
                    st.error(f"Google location check incomplete: {loc_res.error_message}")

    if check_clicked:
        if not test_domain.strip() or not test_keyword.strip():
            st.error("Please enter both a Website Domain and a Keyword.")
        elif input_mode == "Manual SERP HTML" and not manual_html.strip():
            st.error("Please upload or paste SERP HTML for Manual SERP HTML mode.")
        else:
            try:
                geo = GeoLocation(latitude=float(test_lat), longitude=float(test_lng))
            except ValueError as exc:
                st.error(f"Invalid coordinates: {exc}")
            else:
                spinner_msg = (
                    "Parsing supplied SERP HTML..."
                    if input_mode == "Manual SERP HTML"
                    else "Opening visible Chromium and checking organic ranking..."
                )
                with st.spinner(spinner_msg):
                    rank_res = run_single_keyword_test(
                        website_domain=test_domain.strip(),
                        keyword=test_keyword.strip(),
                        location=geo,
                        search_depth=int(search_depth),
                        manual_serp_html=manual_html if input_mode == "Manual SERP HTML" else None,
                        headless=False,
                    )

                outcome = classify_rank_outcome(rank_res, int(search_depth))
                m1, m2, m3 = st.columns(3)
                pos_text = (
                    f"#{rank_res.position}"
                    if rank_res.status == "ranked" and rank_res.position is not None
                    else ("NA" if rank_res.status == "not_found" else rank_res.status.upper())
                )
                m1.metric("Organic Position", pos_text)
                m2.metric("Results Checked", rank_res.checked_results)
                m3.metric("Search Status", rank_res.status)

                if outcome["category"] == "ranked":
                    st.success(f"{outcome['headline']} — {outcome['detail']}")
                    st.write("**Ranking URL:**", rank_res.ranking_url)
                elif outcome["category"] == "confirmed_non_ranking":
                    st.info(f"{outcome['headline']} — {outcome['detail']}")
                else:
                    st.error(f"{outcome['headline']} — {outcome['detail']}")

with tab_results:
    if selected_run_id is None:
        st.info("Run a batch ranking check first to view results here.")
    else:
        items = RankingStore(DB_PATH).get_run_items(selected_run_id)
        metrics = compute_run_metrics(items)
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("Total Keywords", metrics["total"])
        c2.metric("Ranked", metrics["ranked"])
        c3.metric("Not Found (NA)", metrics["not_found"])
        c4.metric("Blocked / Errors", metrics["blocked_or_error"])

        st.dataframe(items_to_table_rows(items), use_container_width=True, hide_index=True)

with tab_compare:
    st.subheader("Compare Automated Run vs. GS Location Changer CSV")
    uploaded_csv = st.file_uploader("Upload baseline CSV (row_number, keyword, gs_position, gs_ranking_url)", type=["csv"])
    tolerance = st.number_input("Position tolerance (±)", min_value=0, max_value=10, value=1)

    if selected_run_id and uploaded_csv is not None:
        items = RankingStore(DB_PATH).get_run_items(selected_run_id)
        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as tmp:
            tmp.write(uploaded_csv.getvalue())
            tmp_path = Path(tmp.name)
        try:
            baseline = load_gs_baseline_csv(tmp_path)
        finally:
            tmp_path.unlink(missing_ok=True)

        report = compare_with_gs_baseline(items, baseline, tolerance=int(tolerance))
        m1, m2, m3 = st.columns(3)
        m1.metric("Exact Match Rate", f"{report.exact_match_rate}%")
        m2.metric("Within Tolerance Rate", f"{report.tolerance_match_rate}%")
        m3.metric("Blocked / Errors", report.blocked_or_errors)
        st.dataframe(
            [
                {
                    "Row #": r.row_number,
                    "Keyword": r.keyword,
                    "Auto": r.auto_position,
                    "GS Manual": r.gs_position,
                    "Delta": r.position_delta,
                    "Status": r.comparison_status,
                }
                for r in report.rows
            ],
            use_container_width=True,
            hide_index=True,
        )

with tab_backups:
    st.subheader("Recent Google Sheet Backups")
    backups = list_recent_backups(BACKUP_DIR)
    if not backups:
        st.info("No sheet backups created yet.")
    else:
        for b in backups:
            st.text(f"{b.name} ({b.stat().st_size} bytes)")

