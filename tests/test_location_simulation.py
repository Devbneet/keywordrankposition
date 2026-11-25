"""Tests for Phase 2 browser geolocation simulation."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

from src.browser.session import BrowserSession
from src.location.geolocation import GeoLocation

GEOLOCATION_TEST_HTML = b"""<!doctype html>
<html>
  <head><title>Geolocation Test</title></head>
  <body>
    <script>
      window.readSimulatedLocation = () => new Promise((resolve, reject) => {
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


@contextmanager
def local_test_server() -> Iterator[str]:
    """Serve the geolocation test page on 127.0.0.1 (a secure origin for Chromium)."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(GEOLOCATION_TEST_HTML)))
            self.end_headers()
            self.wfile.write(GEOLOCATION_TEST_HTML)

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


def test_geolocation_validation() -> None:
    """Reject out-of-range coordinates or non-positive accuracy."""
    with pytest.raises(ValueError, match="Latitude"):
        GeoLocation(latitude=95.0, longitude=0.0)

    with pytest.raises(ValueError, match="Longitude"):
        GeoLocation(latitude=0.0, longitude=-181.0)

    with pytest.raises(ValueError, match="Accuracy"):
        GeoLocation(latitude=-33.8688, longitude=151.2093, accuracy=0)


def test_browser_simulates_and_updates_geolocation() -> None:
    """Verify Chromium reports simulated coordinates and updates them mid-session."""
    sydney = GeoLocation(latitude=-33.8688, longitude=151.2093, accuracy=25.0, location_name="Sydney CBD")
    melbourne = GeoLocation(latitude=-37.8136, longitude=144.9631, accuracy=30.0, location_name="Melbourne CBD")

    with local_test_server() as url, BrowserSession(sydney, headless=True) as session:
        page = session.new_page()
        page.goto(url)

        coords = page.evaluate("window.readSimulatedLocation()")
        assert coords["latitude"] == pytest.approx(-33.8688, abs=1e-4)
        assert coords["longitude"] == pytest.approx(151.2093, abs=1e-4)
        assert coords["accuracy"] == pytest.approx(25.0, abs=1e-2)

        session.set_location(melbourne)
        updated_coords = page.evaluate("window.readSimulatedLocation()")
        assert updated_coords["latitude"] == pytest.approx(-37.8136, abs=1e-4)
        assert updated_coords["longitude"] == pytest.approx(144.9631, abs=1e-4)
        assert updated_coords["accuracy"] == pytest.approx(30.0, abs=1e-2)
