"""CLI entry point for Digital Minds Keyword Ranking Automation."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from src.storage.sqlite_store import RankingStore
from src.utils.client_config import load_clients_config
from src.utils.logging_setup import configure_logging
from src.utils.scheduler import (
    WeeklyScheduleConfig,
    build_schtasks_create_args,
    write_weekly_runner_bat,
)

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "clients.json"
EXAMPLE_CONFIG_PATH = PROJECT_ROOT / "config" / "clients.example.json"


def resolve_config_path() -> Path:
    """Return local clients.json if present, otherwise fall back to clients.example.json."""
    return DEFAULT_CONFIG_PATH if DEFAULT_CONFIG_PATH.exists() else EXAMPLE_CONFIG_PATH


def run_health_check(db_path: Path, config_path: Path) -> int:
    """Validate configuration loading and SQLite storage readiness."""
    clients = load_clients_config(config_path, active_only=False)
    active_count = sum(1 for c in clients if c.active)
    store = RankingStore(db_path)
    recent_runs = store.list_runs(limit=5)
    print(f"Health Check OK | Config: {config_path.name} ({active_count}/{len(clients)} active)")
    print(f"SQLite DB: {db_path} ({len(recent_runs)} recent run(s))")
    return 0


def generate_scheduler_artifacts(weekday: str, start_time: str, dry_run: bool) -> int:
    """Write the weekly .bat runner and print the schtasks registration command."""
    cfg = WeeklyScheduleConfig(
        project_root=PROJECT_ROOT,
        python_executable=Path(sys.executable),
        weekday=weekday,
        start_time=start_time,
        dry_run=dry_run,
    )
    bat_path = write_weekly_runner_bat(cfg, PROJECT_ROOT / "scripts" / "run_weekly.bat")
    args = build_schtasks_create_args(cfg, task_runner_path=bat_path)
    print(f"Generated runner script: {bat_path}")
    print("Register in Windows Task Scheduler with:")
    print("  " + " ".join(args))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Digital Minds Keyword Ranking Automation CLI"
    )
    parser.add_argument(
        "--check-health",
        action="store_true",
        help="Validate client config and SQLite database readiness.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview environment and client configuration without modifying Google Sheets.",
    )
    parser.add_argument(
        "--generate-scheduler-bat",
        action="store_true",
        help="Generate scripts/run_weekly.bat and print the Windows schtasks command.",
    )
    parser.add_argument("--weekday", default="MON", help="Weekly schedule day (MON-SUN).")
    parser.add_argument("--start-time", default="09:00", help="Weekly start time (HH:MM).")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the Digital Minds Keyword Ranking Automation CLI."""
    load_dotenv(PROJECT_ROOT / ".env")
    log_level = os.getenv("LOG_LEVEL", "INFO")
    logger = configure_logging(PROJECT_ROOT / "logs", level=log_level)

    args = build_parser().parse_args(argv)
    config_path = resolve_config_path()
    db_path = Path(os.getenv("SQLITE_DB_PATH", str(PROJECT_ROOT / "data" / "rankings.db")))

    if args.generate_scheduler_bat:
        return generate_scheduler_artifacts(
            weekday=args.weekday,
            start_time=args.start_time,
            dry_run=True,
        )

    if args.check_health or args.dry_run:
        logger.info("Running health/dry-run check using %s", config_path.name)
        return run_health_check(db_path=db_path, config_path=config_path)

    clients = load_clients_config(config_path, active_only=False)
    print("Digital Minds Keyword Ranking Automation")
    print(f"Python: {sys.version.split()[0]}")
    print(f"Project root: {PROJECT_ROOT}")
    print(f"Config loaded: {config_path.relative_to(PROJECT_ROOT)} ({len(clients)} client(s))")
    print("Options: --check-health | --dry-run | --generate-scheduler-bat")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
