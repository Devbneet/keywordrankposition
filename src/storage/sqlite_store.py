"""SQLite persistence for multi-keyword ranking runs."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from src.ranking.batch_checker import BatchRankItem, BatchRunSummary
from src.ranking.single_checker import RankResult


class RankingStore:
    """Store and retrieve keyword ranking runs in a local SQLite database."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS ranking_runs (
                    run_id TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL,
                    location_name TEXT NOT NULL,
                    target_domain TEXT NOT NULL,
                    stopped_early INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS keyword_results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    row_number INTEGER NOT NULL,
                    keyword TEXT NOT NULL,
                    status TEXT NOT NULL,
                    position INTEGER,
                    ranking_url TEXT,
                    checked_results INTEGER NOT NULL,
                    error_message TEXT,
                    FOREIGN KEY (run_id) REFERENCES ranking_runs(run_id)
                );
                """
            )

    def save_run(self, summary: BatchRunSummary) -> None:
        """Persist a BatchRunSummary and all of its row-keyed keyword results."""
        created_at = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO ranking_runs (
                    run_id, client_id, location_name, target_domain, stopped_early, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    summary.run_id,
                    summary.client_id,
                    summary.location_name,
                    summary.target_domain,
                    int(summary.stopped_early),
                    created_at,
                ),
            )
            conn.executemany(
                """
                INSERT INTO keyword_results (
                    run_id, row_number, keyword, status, position, ranking_url, checked_results, error_message
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        summary.run_id,
                        item.row_number,
                        item.result.keyword,
                        item.result.status,
                        item.result.position,
                        item.result.ranking_url,
                        item.result.checked_results,
                        item.result.error_message,
                    )
                    for item in summary.items
                ],
            )

    def get_run_items(self, run_id: str) -> list[BatchRankItem]:
        """Load all keyword results for a run_id ordered by row_number."""
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT row_number, keyword, status, position, ranking_url, checked_results, error_message
                FROM keyword_results
                WHERE run_id = ?
                ORDER BY row_number ASC, id ASC
                """,
                (run_id,),
            ).fetchall()

        return [
            BatchRankItem(
                row_number=row["row_number"],
                result=RankResult(
                    keyword=row["keyword"],
                    status=row["status"],
                    position=row["position"],
                    ranking_url=row["ranking_url"],
                    checked_results=row["checked_results"],
                    error_message=row["error_message"],
                ),
            )
            for row in rows
        ]

    def list_runs(self, limit: int = 50) -> list[dict]:
        """Return recent ranking runs ordered newest-first."""
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT run_id, client_id, location_name, target_domain, stopped_early, created_at
                FROM ranking_runs
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

