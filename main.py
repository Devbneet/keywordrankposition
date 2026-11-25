"""Entry point for Digital Minds Keyword Ranking Automation (Phase 1)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "clients.json"
EXAMPLE_CONFIG_PATH = PROJECT_ROOT / "config" / "clients.example.json"


def load_client_config() -> tuple[Path, dict]:
    """Load local client config if present, otherwise fall back to the example config."""
    config_path = DEFAULT_CONFIG_PATH if DEFAULT_CONFIG_PATH.exists() else EXAMPLE_CONFIG_PATH
    with config_path.open("r", encoding="utf-8") as f:
        return config_path, json.load(f)


def main() -> int:
    """Display Phase 1 environment and configuration status."""
    load_dotenv(PROJECT_ROOT / ".env")

    print("Digital Minds Keyword Ranking Automation - Phase 1")
    print(f"Python: {sys.version.split()[0]}")
    print(f"Project root: {PROJECT_ROOT}")

    config_path, config_data = load_client_config()
    clients = config_data.get("clients", [])
    print(f"Config loaded: {config_path.relative_to(PROJECT_ROOT)} ({len(clients)} client(s))")
    print("Status: Phase 1 environment ready. Run `pytest -v` for the local browser smoke test.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

