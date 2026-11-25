"""Tests for Phase 10 Windows Task Scheduler helpers."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.utils.scheduler import (
    WeeklyScheduleConfig,
    build_schtasks_create_args,
    build_schtasks_delete_args,
    build_schtasks_query_args,
    write_weekly_runner_bat,
)


def test_weekly_schedule_validation(tmp_path: Path) -> None:
    """Reject invalid weekday names or invalid 24-hour times."""
    py_exe = tmp_path / "python.exe"
    with pytest.raises(ValueError, match="weekday"):
        WeeklyScheduleConfig(project_root=tmp_path, python_executable=py_exe, weekday="FUNDAY")

    with pytest.raises(ValueError, match="start_time"):
        WeeklyScheduleConfig(project_root=tmp_path, python_executable=py_exe, start_time="25:99")


def test_build_schtasks_args_and_runner_bat(tmp_path: Path) -> None:
    """Verify schtasks CLI args and generated .bat wrapper contents."""
    py_exe = tmp_path / ".venv" / "Scripts" / "python.exe"
    cfg = WeeklyScheduleConfig(
        project_root=tmp_path,
        python_executable=py_exe,
        task_name="DigitalMindsWeekly",
        weekday="mon",
        start_time="08:30",
        dry_run=True,
    )

    bat_path = write_weekly_runner_bat(cfg, tmp_path / "scripts" / "run_weekly.bat")
    assert bat_path.exists()
    bat_text = bat_path.read_text(encoding="utf-8")
    assert "main.py" in bat_text
    assert "--dry-run" in bat_text
    assert "weekly_scheduler.log" in bat_text

    create_args = build_schtasks_create_args(cfg, task_runner_path=bat_path)
    assert create_args[:4] == ["schtasks", "/Create", "/SC", "WEEKLY"]
    assert "MON" in create_args
    assert "08:30" in create_args
    assert "DigitalMindsWeekly" in create_args
    assert build_schtasks_query_args("DigitalMindsWeekly")[1] == "/Query"
    assert build_schtasks_delete_args("DigitalMindsWeekly")[1] == "/Delete"

