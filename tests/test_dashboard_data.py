"""Tests for Phase 9 dashboard data service and SQLite run listing."""

from __future__ import annotations

from pathlib import Path

from dashboard.data_service import (
    compute_run_metrics,
    items_to_table_rows,
    list_recent_backups,
    load_dashboard_clients,
    load_dashboard_runs,
)
from src.ranking.batch_checker import BatchRankItem, BatchRunSummary
from src.ranking.single_checker import RankResult
from src.storage.sqlite_store import RankingStore

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def test_dashboard_data_service_with_sqlite_and_backups(tmp_path: Path) -> None:
    """Verify dashboard helpers load clients, runs, metrics, table rows, and backups."""
    clients = load_dashboard_clients(PROJECT_ROOT)
    assert len(clients) >= 1

    db_path = tmp_path / "dash.db"
    assert load_dashboard_runs(db_path) == []

    store = RankingStore(db_path)
    items = [
        BatchRankItem(
            row_number=8,
            result=RankResult(
                keyword="seo agency sydney",
                status="ranked",
                position=3,
                ranking_url="https://example.com/seo",
            ),
        ),
        BatchRankItem(
            row_number=9,
            result=RankResult(keyword="rare keyword", status="not_found"),
        ),
        BatchRankItem(
            row_number=10,
            result=RankResult(
                keyword="blocked keyword",
                status="blocked",
                error_message="CAPTCHA",
            ),
        ),
    ]
    summary = BatchRunSummary(
        run_id="run-001",
        client_id="example-client",
        location_name="Sydney CBD",
        target_domain="example.com",
        items=items,
    )
    store.save_run(summary)

    runs = load_dashboard_runs(db_path)
    assert len(runs) == 1
    assert runs[0]["run_id"] == "run-001"

    metrics = compute_run_metrics(items)
    assert metrics == {"total": 3, "ranked": 1, "not_found": 1, "blocked_or_error": 1}

    table = items_to_table_rows(items)
    assert table[0]["Position"] == 3
    assert table[1]["Position"] == "NA"
    assert table[2]["Position"] == "BLOCKED"

    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    (backup_dir / "sheet1_Keywords_20261125.json").write_text("{}", encoding="utf-8")
    backups = list_recent_backups(backup_dir)
    assert len(backups) == 1
    assert backups[0].name == "sheet1_Keywords_20261125.json"

