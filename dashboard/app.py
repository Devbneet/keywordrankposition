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

tab_results, tab_compare, tab_backups = st.tabs(
    ["Ranking Results", "GS Location Changer Comparison", "Sheet Backups"]
)

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

