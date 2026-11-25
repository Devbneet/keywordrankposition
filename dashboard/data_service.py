"""Data loading and formatting helpers for the Digital Minds Streamlit dashboard."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from src.ranking.batch_checker import BatchRankItem
from src.storage.sqlite_store import RankingStore
from src.utils.client_config import ClientConfig, load_clients_config


def resolve_client_config_path(project_root: Path) -> Path:
    """Return local clients.json if present, otherwise clients.example.json."""
    local_path = project_root / "config" / "clients.json"
    if local_path.exists():
        return local_path
    return project_root / "config" / "clients.example.json"


def load_dashboard_clients(project_root: Path) -> list[ClientConfig]:
    """Load configured clients for dashboard display."""
    cfg_path = resolve_client_config_path(project_root)
    return load_clients_config(cfg_path, active_only=False)


def load_dashboard_runs(db_path: str | Path, limit: int = 50) -> list[dict[str, Any]]:
    """Return recent runs from SQLite, or an empty list if no DB exists yet."""
    path = Path(db_path)
    if not path.exists():
        return []
    return RankingStore(path).list_runs(limit=limit)


def compute_run_metrics(items: list[BatchRankItem]) -> dict[str, int]:
    """Compute summary counts for a run's keyword results."""
    return {
        "total": len(items),
        "ranked": sum(1 for item in items if item.result.status == "ranked"),
        "not_found": sum(1 for item in items if item.result.status == "not_found"),
        "blocked_or_error": sum(
            1 for item in items if item.result.status in ("blocked", "error")
        ),
    }


def items_to_table_rows(items: list[BatchRankItem]) -> list[dict[str, Any]]:
    """Convert BatchRankItem records into flat dicts suitable for Streamlit tables."""
    rows: list[dict[str, Any]] = []
    for item in items:
        res = item.result
        pos_display: int | str = (
            res.position if res.status == "ranked" and res.position is not None else "NA"
        )
        if res.status in ("blocked", "error"):
            pos_display = res.status.upper()
        rows.append(
            {
                "Row #": item.row_number,
                "Keyword": res.keyword,
                "Status": res.status,
                "Position": pos_display,
                "Ranking URL": res.ranking_url or "",
                "Error": res.error_message or "",
            }
        )
    return rows


def list_recent_backups(backup_dir: str | Path, limit: int = 20) -> list[Path]:
    """List recent JSON backup files newest-first."""
    directory = Path(backup_dir)
    if not directory.exists():
        return []
    files = sorted(
        (p for p in directory.iterdir() if p.is_file() and p.suffix.lower() == ".json"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return files[:limit]

