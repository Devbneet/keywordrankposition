"""Tests for Phase 3 single keyword organic ranking detection."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from src.browser.session import BrowserSession
from src.location.geolocation import GeoLocation
from src.ranking.matcher import is_target_domain, normalize_domain
from src.ranking.serp_parser import parse_organic_results
from src.ranking.single_checker import SingleKeywordChecker, find_organic_rank_from_html

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


@contextmanager
def fixture_serp_server(html_bytes: bytes) -> Iterator[str]:
    """Serve a SERP HTML fixture on 127.0.0.1 for local browser testing."""

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


def test_domain_matching() -> None:
    """Verify domain normalization and subdomain matching without false positives."""
    assert normalize_domain("https://www.Example.com/path") == "example.com"
    assert is_target_domain("https://www.example.com/services", "example.com") is True
    assert is_target_domain("https://blog.example.com/post", "example.com") is True
    assert is_target_domain("https://notexample.com/post", "example.com") is False


def test_parse_organic_results_skips_ads_and_google_links() -> None:
    """Sponsored ads and Google internal links must not affect organic rank counts."""
    html = (FIXTURES_DIR / "serp_ranked.html").read_text(encoding="utf-8")
    results = parse_organic_results(html)

    assert [r.position for r in results] == [1, 2, 3, 4]
    assert results[0].url == "https://competitor1.com.au/"
    assert results[1].url == "https://www.competitor2.com/seo"
    assert results[2].url == "https://www.example.com/services/seo-sydney"
    assert results[3].url == "https://competitor3.org/blog"


def test_find_organic_rank_ranked_and_not_found() -> None:
    """Detect exact organic rank when present, and not_found when absent."""
    ranked_html = (FIXTURES_DIR / "serp_ranked.html").read_text(encoding="utf-8")
    ranked = find_organic_rank_from_html(ranked_html, "seo agency sydney", "example.com")
    assert ranked.status == "ranked"
    assert ranked.position == 3
    assert ranked.ranking_url == "https://www.example.com/services/seo-sydney"
    assert ranked.error_message is None

    not_found_html = (FIXTURES_DIR / "serp_not_found.html").read_text(encoding="utf-8")
    missing = find_organic_rank_from_html(not_found_html, "rare keyword", "example.com")
    assert missing.status == "not_found"
    assert missing.position is None
    assert missing.ranking_url is None
    assert missing.checked_results == 3


def test_find_organic_rank_blocked_is_not_reported_as_not_found() -> None:
    """Blocked/CAPTCHA pages must return status='blocked', never 'not_found'."""
    blocked_html = (FIXTURES_DIR / "serp_blocked.html").read_text(encoding="utf-8")
    result = find_organic_rank_from_html(blocked_html, "seo agency sydney", "example.com")
    assert result.status == "blocked"
    assert result.position is None
    assert result.ranking_url is None
    assert result.error_message is not None


def test_single_keyword_checker_with_browser_session() -> None:
    """End-to-end Phase 3 check using BrowserSession against a local SERP fixture."""
    html_bytes = (FIXTURES_DIR / "serp_ranked.html").read_bytes()
    sydney = GeoLocation(latitude=-33.8688, longitude=151.2093, location_name="Sydney CBD")

    with fixture_serp_server(html_bytes) as search_url, BrowserSession(sydney, headless=True) as session:
        checker = SingleKeywordChecker(search_base_url=search_url)
        result = checker.check_keyword(session, "seo agency sydney", "example.com")

    assert result.status == "ranked"
    assert result.position == 3
    assert result.ranking_url == "https://www.example.com/services/seo-sydney"

