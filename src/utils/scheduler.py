"""Windows Task Scheduler configuration and script generators for weekly runs."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

VALID_WEEKDAYS = ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")
_TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


@dataclass(frozen=True)
class WeeklyScheduleConfig:
    """Configuration for a weekly Windows Task Scheduler job."""

    project_root: Path
    python_executable: Path
    task_name: str = "DigitalMindsKeywordRankWeekly"
    weekday: str = "MON"
    start_time: str = "09:00"
    dry_run: bool = True

    def __post_init__(self) -> None:
        normalized_day = self.weekday.strip().upper()
        if normalized_day not in VALID_WEEKDAYS:
            raise ValueError(f"weekday must be one of {VALID_WEEKDAYS}, got {self.weekday!r}")
        if not _TIME_RE.match(self.start_time.strip()):
            raise ValueError(f"start_time must be HH:MM (24-hour), got {self.start_time!r}")
        if not self.task_name.strip():
            raise ValueError("task_name cannot be empty")


def build_runner_command(config: WeeklyScheduleConfig) -> str:
    """Build the Python CLI command invoked by Windows Task Scheduler."""
    main_py = config.project_root / "main.py"
    flag = " --dry-run" if config.dry_run else ""
    return f'"{config.python_executable}" "{main_py}"{flag}'


def write_weekly_runner_bat(config: WeeklyScheduleConfig, output_path: str | Path) -> Path:
    """Generate a Windows .bat wrapper that logs weekly runs into logs/weekly_scheduler.log."""
    bat_path = Path(output_path)
    bat_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = config.project_root / "logs" / "weekly_scheduler.log"
    cmd = build_runner_command(config)

    content = "\r\n".join(
        [
            "@echo off",
            f'cd /d "{config.project_root}"',
            f'if not exist "{config.project_root / "logs"}" mkdir "{config.project_root / "logs"}"',
            f'echo [%date% %time%] Starting weekly run >> "{log_file}"',
            f'{cmd} >> "{log_file}" 2>&1',
            f'echo [%date% %time%] Finished with exit code %errorlevel% >> "{log_file}"',
            "",
        ]
    )
    bat_path.write_text(content, encoding="utf-8")
    return bat_path


def build_schtasks_create_args(
    config: WeeklyScheduleConfig,
    *,
    task_runner_path: Path | None = None,
) -> list[str]:
    """Build the schtasks /Create argument list without executing it."""
    target_cmd = f'"{task_runner_path}"' if task_runner_path else build_runner_command(config)
    return [
        "schtasks",
        "/Create",
        "/SC",
        "WEEKLY",
        "/D",
        config.weekday.strip().upper(),
        "/ST",
        config.start_time.strip(),
        "/TN",
        config.task_name.strip(),
        "/TR",
        target_cmd,
        "/F",
    ]


def build_schtasks_query_args(task_name: str) -> list[str]:
    """Build the schtasks /Query argument list to inspect an existing task."""
    return ["schtasks", "/Query", "/TN", task_name.strip(), "/FO", "LIST", "/V"]


def build_schtasks_delete_args(task_name: str) -> list[str]:
    """Build the schtasks /Delete argument list to remove a scheduled task."""
    return ["schtasks", "/Delete", "/TN", task_name.strip(), "/F"]

