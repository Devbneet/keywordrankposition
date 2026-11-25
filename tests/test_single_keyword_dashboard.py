"""Tests for the Streamlit Single Keyword Test backend service."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest

from dashboard.single_test_service import (
    classify_rank_outcome,
    parse_google_detected_location,
    run_single_keyword_test,
    verify_location_in_browser,
)
from src.location.geolocation import GeoLocation

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


@contextmanager
def local_html_server(html_bytes: bytes) -> Iterator[str]:
    """Serve static HTML on 127.0.0.1 for isolated browser tests."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
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


def test_parse_google_detected_location() -> None:
    """Extract Google's detected location from standard footer elements."""
    html = '<footer><span class="Q8LRLc">Sydney NSW, Australia</span></footer>'
    assert parse_google_detected_location(html) == "Sydney NSW, Australia"
    assert parse_google_detected_location("<html><body>No footer</body></html>") is None


def test_verify_location_separates_browser_gps_and_google_detection() -> None:
    """Verify browser GPS succeeds independently while Google location is detected or blocked."""
    sydney = GeoLocation(latitude=-33.8688, longitude=151.2093, accuracy=20.0)
    google_html = b'<html><body><div id="Wprf1b">Sydney NSW</div></body></html>'

    with local_html_server(google_html) as url:
        res = verify_location_in_browser(sydney, headless=True, google_url=url)

    assert res.browser_gps_verified is True
    assert res.browser_gps is not None
    assert res.browser_gps["latitude"] == pytest.approx(-33.8688, abs=1e-4)
    assert res.google_status == "detected"
    assert res.google_detected_location == "Sydney NSW"

    blocked_bytes = (FIXTURES_DIR / "serp_blocked.html").read_bytes()
    with local_html_server(blocked_bytes) as blocked_url:
        blocked_res = verify_location_in_browser(sydney, headless=True, google_url=blocked_url)

    assert blocked_res.browser_gps_verified is True
    assert blocked_res.google_status == "blocked"
    assert blocked_res.google_detected_location is None


def test_run_single_keyword_test_manual_html_and_outcome_classification() -> None:
    """Support manually supplied SERP HTML and distinguish NA from blocked/error."""
    sydney = GeoLocation(latitude=-33.8688, longitude=151.2093)

    ranked_html = (FIXTURES_DIR / "serp_ranked.html").read_text(encoding="utf-8")
    ranked = run_single_keyword_test(
        website_domain="example.com",
        keyword="seo agency sydney",
        location=sydney,
        search_depth=50,
        manual_serp_html=ranked_html,
    )
    assert ranked.status == "ranked"
    assert ranked.position == 3
    assert ranked.ranking_url == "https://www.example.com/services/seo-sydney"
    assert classify_rank_outcome(ranked, 50)["category"] == "ranked"

    not_found_html = (FIXTURES_DIR / "serp_not_found.html").read_text(encoding="utf-8")
    not_found = run_single_keyword_test(
        website_domain="example.com",
        keyword="rare keyword",
        location=sydney,
        search_depth=50,
        manual_serp_html=not_found_html,
    )
    assert not_found.status == "not_found"
    assert classify_rank_outcome(not_found, 50)["category"] == "confirmed_non_ranking"

    blocked_html = (FIXTURES_DIR / "serp_blocked.html").read_text(encoding="utf-8")
    blocked = run_single_keyword_test(
        website_domain="example.com",
        keyword="seo agency sydney",
        location=sydney,
        search_depth=50,
        manual_serp_html=blocked_html,
    )
    assert blocked.status == "blocked"
    assert classify_rank_outcome(blocked, 50)["category"] == "incomplete_blocked"


def test_run_single_keyword_test_live_browser_mode() -> None:
    """Verify BrowserSession path against a local SERP server."""
    sydney = GeoLocation(latitude=-33.8688, longitude=151.2093)
    ranked_bytes = (FIXTURES_DIR / "serp_ranked.html").read_bytes()

    with local_html_server(ranked_bytes) as search_url:
        res = run_single_keyword_test(
            website_domain="example.com",
            keyword="seo agency sydney",
            location=sydney,
            search_depth=50,
            headless=True,
            search_base_url=search_url,
        )

    assert res.status == "ranked"
    assert res.position == 3
    assert res.checked_results == 4

