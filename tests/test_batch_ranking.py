"""Tests for Phase 4 multi-keyword ranking detection and SQLite persistence."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import parse_qs, urlparse

from src.browser.session import BrowserSession
from src.location.geolocation import GeoLocation
from src.ranking.batch_checker import BatchKeywordChecker, KeywordTask
from src.ranking.single_checker import SingleKeywordChecker
from src.storage.sqlite_store import RankingStore

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


@contextmanager
def routing_serp_server(route_map: dict[str, bytes]) -> Iterator[str]:
    """Serve different SERP fixtures depending on the '?q=' query parameter."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            query = parse_qs(urlparse(self.path).query).get("q", [""])[0]
            body = route_map.get(query, route_map.get("*", b"<html></html>"))
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

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


def test_batch_ranking_preserves_duplicate_rows_and_saves_to_sqlite(tmp_path: Path) -> None:
    """Multiple keywords—including duplicates at distinct rows—are tracked and persisted."""
    ranked_html = (FIXTURES_DIR / "serp_ranked.html").read_bytes()
    not_found_html = (FIXTURES_DIR / "serp_not_found.html").read_bytes()

    route_map = {
        "seo agency sydney": ranked_html,
        "rare keyword": not_found_html,
    }
    tasks = [
        KeywordTask(row_number=10, keyword="seo agency sydney"),
        KeywordTask(row_number=11, keyword="rare keyword"),
        KeywordTask(row_number=25, keyword="seo agency sydney"),
    ]
    sleep_calls: list[float] = []
    sydney = GeoLocation(latitude=-33.8688, longitude=151.2093, location_name="Sydney CBD")

    with routing_serp_server(route_map) as search_url, BrowserSession(sydney, headless=True) as session:
        checker = BatchKeywordChecker(
            SingleKeywordChecker(search_base_url=search_url),
            delay_range=(0.5, 0.5),
            sleep_fn=sleep_calls.append,
        )
        summary = checker.run_batch(session, tasks, "example.com", client_id="example-client")

    assert summary.total == 3
    assert summary.ranked_count == 2
    assert summary.not_found_count == 1
    assert summary.blocked_count == 0
    assert summary.stopped_early is False
    assert len(sleep_calls) == 2

    assert [item.row_number for item in summary.items] == [10, 11, 25]
    assert summary.items[0].result.position == 3
    assert summary.items[1].result.status == "not_found"
    assert summary.items[2].result.position == 3

    store = RankingStore(tmp_path / "rankings.db")
    store.save_run(summary)
    loaded = store.get_run_items(summary.run_id)
    assert [item.row_number for item in loaded] == [10, 11, 25]
    assert loaded[0].result.ranking_url == "https://www.example.com/services/seo-sydney"
    assert loaded[1].result.status == "not_found"


def test_batch_ranking_stops_safely_on_block() -> None:
    """When stop_on_block=True, encountering a CAPTCHA stops the batch early."""
    ranked_html = (FIXTURES_DIR / "serp_ranked.html").read_bytes()
    blocked_html = (FIXTURES_DIR / "serp_blocked.html").read_bytes()

    route_map = {
        "seo agency sydney": ranked_html,
        "blocked keyword": blocked_html,
        "never reached": ranked_html,
    }
    tasks = [
        KeywordTask(row_number=10, keyword="seo agency sydney"),
        KeywordTask(row_number=11, keyword="blocked keyword"),
        KeywordTask(row_number=12, keyword="never reached"),
    ]
    sydney = GeoLocation(latitude=-33.8688, longitude=151.2093, location_name="Sydney CBD")

    with routing_serp_server(route_map) as search_url, BrowserSession(sydney, headless=True) as session:
        checker = BatchKeywordChecker(
            SingleKeywordChecker(search_base_url=search_url),
            delay_range=(0.0, 0.0),
            stop_on_block=True,
        )
        summary = checker.run_batch(session, tasks, "example.com")

    assert summary.stopped_early is True
    assert summary.total == 2
    assert summary.ranked_count == 1
    assert summary.blocked_count == 1
    assert summary.items[1].result.status == "blocked"

