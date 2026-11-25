"""Backend helpers for the Streamlit Single Keyword Test section."""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Literal

from src.browser.session import BrowserSession
from src.location.geolocation import GeoLocation
from src.ranking.serp_parser import detect_block_page
from src.ranking.single_checker import RankResult, SingleKeywordChecker, find_organic_rank_from_html

GoogleLocationStatus = Literal["detected", "unavailable", "blocked", "error"]

_GPS_CHECK_HTML = b"""<!doctype html>
<html>
  <head><title>Browser GPS Verification</title></head>
  <body>
    <script>
      window.readGps = () => new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy
          }),
          (err) => reject(err.message),
          { enableHighAccuracy: true, timeout: 5000 }
        );
      });
    </script>
  </body>
</html>
"""

_GOOGLE_LOC_PATTERNS = (
    re.compile(r'<span[^>]*class="[^"]*Q8LRLc[^"]*"[^>]*>(.*?)</span>', re.IGNORECASE | re.DOTALL),
    re.compile(r'<div[^>]*id="Wprf1b"[^>]*>(.*?)</div>', re.IGNORECASE | re.DOTALL),
)


@dataclass(frozen=True)
class LocationVerificationResult:
    """Separate verification outcomes for browser GPS and Google's detected location."""

    browser_gps: dict[str, float] | None
    browser_gps_verified: bool
    google_detected_location: str | None
    google_status: GoogleLocationStatus
    error_message: str | None = None


@contextmanager
def _local_gps_server() -> Iterator[str]:
    """Serve a local secure-origin page on 127.0.0.1 to read navigator.geolocation."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(_GPS_CHECK_HTML)))
            self.end_headers()
            self.wfile.write(_GPS_CHECK_HTML)

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}/"
    finally:
        server.shutdown()
        server.server_close()


def parse_google_detected_location(html: str) -> str | None:
    """Extract Google's detected location label from SERP footer HTML if present."""
    for pattern in _GOOGLE_LOC_PATTERNS:
        match = pattern.search(html)
        if match:
            cleaned = re.sub(r"<[^>]+>", "", match.group(1)).strip()
            if cleaned:
                return cleaned
    return None


def verify_location_in_browser(
    location: GeoLocation,
    *,
    headless: bool = False,
    google_url: str = "https://www.google.com/search?q=local+services",
    timeout_ms: int = 15000,
) -> LocationVerificationResult:
    """Open Chromium, verify browser GPS, and separately inspect Google's detected location."""
    browser_gps: dict[str, float] | None = None
    browser_gps_verified = False

    try:
        with _local_gps_server() as gps_url, BrowserSession(location, headless=headless) as session:
            gps_page = session.new_page()
            try:
                gps_page.goto(gps_url, wait_until="domcontentloaded", timeout=timeout_ms)
                coords = gps_page.evaluate("window.readGps()")
                browser_gps = {
                    "latitude": float(coords["latitude"]),
                    "longitude": float(coords["longitude"]),
                    "accuracy": float(coords["accuracy"]),
                }
                browser_gps_verified = True
            finally:
                gps_page.close()

            google_page = session.new_page()
            try:
                google_page.goto(google_url, wait_until="domcontentloaded", timeout=timeout_ms)
                html = google_page.content()
                block_reason = detect_block_page(html, page_url=google_page.url)
                if block_reason:
                    return LocationVerificationResult(
                        browser_gps=browser_gps,
                        browser_gps_verified=browser_gps_verified,
                        google_detected_location=None,
                        google_status="blocked",
                        error_message=block_reason,
                    )

                detected = parse_google_detected_location(html)
                if detected:
                    return LocationVerificationResult(
                        browser_gps=browser_gps,
                        browser_gps_verified=browser_gps_verified,
                        google_detected_location=detected,
                        google_status="detected",
                    )
                return LocationVerificationResult(
                    browser_gps=browser_gps,
                    browser_gps_verified=browser_gps_verified,
                    google_detected_location=None,
                    google_status="unavailable",
                )
            except Exception as exc:
                return LocationVerificationResult(
                    browser_gps=browser_gps,
                    browser_gps_verified=browser_gps_verified,
                    google_detected_location=None,
                    google_status="error",
                    error_message=str(exc),
                )
            finally:
                google_page.close()
    except Exception as exc:
        return LocationVerificationResult(
            browser_gps=browser_gps,
            browser_gps_verified=browser_gps_verified,
            google_detected_location=None,
            google_status="error",
            error_message=str(exc),
        )


def run_single_keyword_test(
    *,
    website_domain: str,
    keyword: str,
    location: GeoLocation,
    search_depth: int = 50,
    manual_serp_html: str | None = None,
    headless: bool = False,
    search_base_url: str = "https://www.google.com/search",
) -> RankResult:
    """Run a single keyword test from manually supplied SERP HTML or visible Chromium."""
    if manual_serp_html is not None and manual_serp_html.strip():
        return find_organic_rank_from_html(
            manual_serp_html,
            keyword=keyword,
            target_domain=website_domain,
            max_depth=search_depth,
        )

    checker = SingleKeywordChecker(search_base_url=search_base_url)
    with BrowserSession(location, headless=headless) as session:
        return checker.check_keyword(
            session,
            keyword=keyword,
            target_domain=website_domain,
            max_depth=search_depth,
        )


def classify_rank_outcome(result: RankResult, search_depth: int) -> dict[str, str]:
    """Return UI-friendly status metadata distinguishing incomplete searches from NA."""
    if result.status == "ranked" and result.position is not None:
        return {
            "category": "ranked",
            "headline": f"Ranked at organic position #{result.position}",
            "detail": f"Found {result.ranking_url} after checking {result.checked_results} organic result(s).",
        }
    if result.status == "not_found":
        return {
            "category": "confirmed_non_ranking",
            "headline": "Confirmed Non-Ranking (NA)",
            "detail": (
                f"Search completed across {result.checked_results} organic result(s) "
                f"(depth {search_depth}); target domain was not found."
            ),
        }
    if result.status == "blocked":
        return {
            "category": "incomplete_blocked",
            "headline": "Incomplete Search — Blocked / CAPTCHA",
            "detail": result.error_message or "Google restricted access. Not reported as NA.",
        }
    return {
        "category": "incomplete_error",
        "headline": "Incomplete Search — Error",
        "detail": result.error_message or "Search failed before completion. Not reported as NA.",
    }

