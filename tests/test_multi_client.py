"""Tests for Phase 8 multi-client and multi-location management."""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import parse_qs, urlparse

from src.ranking.batch_checker import BatchKeywordChecker, KeywordTask
from src.ranking.orchestrator import MultiClientOrchestrator
from src.ranking.single_checker import SingleKeywordChecker
from src.storage.sqlite_store import RankingStore
from src.utils.client_config import ClientConfig, ClientLocationConfig, load_clients_config

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
PROJECT_ROOT = Path(__file__).resolve().parent.parent


@contextmanager
def routing_serp_server(html_bytes: bytes) -> Iterator[str]:
    """Serve SERP HTML on 127.0.0.1 for multi-client tests."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            _ = parse_qs(urlparse(self.path).query)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html_bytes)))
            self.end_headers()
            self.wfile.write(html_bytes)

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}/search"
    finally:
        server.shutdown()
        server.server_close()


def test_load_example_clients_config() -> None:
    """Verify config/clients.example.json loads and validates cleanly."""
    clients = load_clients_config(PROJECT_ROOT / "config" / "clients.example.json")
    assert len(clients) == 1
    assert clients[0].client_id == "example-client"
    assert clients[0].locations[0].location_name == "Sydney CBD"


def test_multi_client_orchestrator_runs_active_clients_and_isolates_errors(tmp_path: Path) -> None:
    """Run multiple clients & locations, skip inactive clients, persist to SQLite, and isolate errors."""
    config_file = tmp_path / "clients.json"
    config_file.write_text(
        json.dumps(
            {
                "clients": [
                    {
                        "client_id": "client-a",
                        "client_name": "Client A",
                        "website_domain": "example.com",
                        "active": True,
                        "locations": [
                            {"location_name": "Sydney", "latitude": -33.8688, "longitude": 151.2093},
                            {"location_name": "Melbourne", "latitude": -37.8136, "longitude": 144.9631},
                        ],
                        "google_sheet": {"spreadsheet_id": "sheet-a", "worksheet_name": "Keywords"},
                    },
                    {
                        "client_id": "client-inactive",
                        "client_name": "Inactive Client",
                        "website_domain": "inactive.com",
                        "active": False,
                        "locations": [
                            {"location_name": "Perth", "latitude": -31.9505, "longitude": 115.8605},
                        ],
                        "google_sheet": {"spreadsheet_id": "sheet-i", "worksheet_name": "Keywords"},
                    },
                    {
                        "client_id": "client-b",
                        "client_name": "Client B",
                        "website_domain": "competitor1.com.au",
                        "active": True,
                        "locations": [
                            {"location_name": "Brisbane", "latitude": -27.4698, "longitude": 153.0251},
                        ],
                        "google_sheet": {"spreadsheet_id": "sheet-b", "worksheet_name": "Keywords"},
                    },
                ]
            }
        ),
        encoding="utf-8",
    )

    clients = load_clients_config(config_file, active_only=True)
    assert [c.client_id for c in clients] == ["client-a", "client-b"]

    def task_provider(client: ClientConfig, loc: ClientLocationConfig) -> list[KeywordTask]:
        if client.client_id == "client-a" and loc.location_name == "Melbourne":
            raise RuntimeError("Simulated sheet read error for Melbourne")
        return [KeywordTask(row_number=8, keyword="seo agency sydney")]

    html_bytes = (FIXTURES_DIR / "serp_ranked.html").read_bytes()
    store = RankingStore(tmp_path / "multi.db")

    with routing_serp_server(html_bytes) as search_url:
        orchestrator = MultiClientOrchestrator(
            batch_checker=BatchKeywordChecker(
                SingleKeywordChecker(search_base_url=search_url),
                delay_range=(0.0, 0.0),
            ),
            store=store,
            headless=True,
        )
        outcomes = orchestrator.run_all(clients, task_provider)

    assert len(outcomes) == 3
    # Client A Sydney succeeded (rank 3 for example.com)
    assert outcomes[0].location_name == "Sydney"
    assert outcomes[0].summary is not None
    assert outcomes[0].summary.items[0].result.position == 3

    # Client A Melbourne isolated error
    assert outcomes[1].location_name == "Melbourne"
    assert outcomes[1].summary is None
    assert "Simulated sheet read error" in (outcomes[1].error or "")

    # Client B Brisbane still ran and succeeded (rank 1 for competitor1.com.au)
    assert outcomes[2].client_id == "client-b"
    assert outcomes[2].summary is not None
    assert outcomes[2].summary.items[0].result.position == 1
    assert len(store.get_run_items(outcomes[2].summary.run_id)) == 1

