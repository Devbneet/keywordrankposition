"""Tests for Phase 11 logging, CLI entry point, and deployment readiness."""

from __future__ import annotations

from pathlib import Path

import main as cli_main
from src.utils.logging_setup import configure_logging


def test_configure_logging_writes_log_file(tmp_path: Path) -> None:
    """Verify rotating file logger creates and writes log entries."""
    logger = configure_logging(tmp_path, level="INFO", logger_name="test_phase11_logger")
    logger.info("Phase 11 deployment check")
    for handler in logger.handlers:
        handler.flush()
        handler.close()
    logger.handlers.clear()

    log_file = tmp_path / "keyword_rank.log"
    assert log_file.exists()
    assert "Phase 11 deployment check" in log_file.read_text(encoding="utf-8")


def test_cli_health_check_and_dry_run(tmp_path: Path, monkeypatch) -> None:
    """Verify main.py --check-health and --dry-run execute cleanly without live writes."""
    monkeypatch.setenv("SQLITE_DB_PATH", str(tmp_path / "test_rankings.db"))
    assert cli_main.main([]) == 0
    assert cli_main.main(["--check-health"]) == 0
    assert cli_main.main(["--dry-run"]) == 0
    assert (tmp_path / "test_rankings.db").exists()

