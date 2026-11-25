"""Playwright browser session helper with simulated geolocation support."""

from __future__ import annotations

from types import TracebackType
from typing import Self

from playwright.sync_api import Browser, BrowserContext, Page, Playwright, sync_playwright

from src.location.geolocation import GeoLocation


class BrowserSession:
    """Manage a Playwright Chromium browser and geolocation-enabled context."""

    def __init__(
        self,
        location: GeoLocation,
        *,
        headless: bool = True,
        slow_mo: int = 0,
    ) -> None:
        self.location = location
        self.headless = headless
        self.slow_mo = slow_mo
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None

    def __enter__(self) -> Self:
        self._playwright = sync_playwright().start()
        self._browser = self._playwright.chromium.launch(
            headless=self.headless,
            slow_mo=self.slow_mo,
        )
        self._context = self._browser.new_context(**self.location.to_context_options())
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        if self._context is not None:
            self._context.close()
            self._context = None
        if self._browser is not None:
            self._browser.close()
            self._browser = None
        if self._playwright is not None:
            self._playwright.stop()
            self._playwright = None

    @property
    def context(self) -> BrowserContext:
        """Return the active Playwright BrowserContext."""
        if self._context is None:
            raise RuntimeError("BrowserSession is not active. Use 'with BrowserSession(...) as session:'.")
        return self._context

    def new_page(self) -> Page:
        """Open a new page inside the geolocation-enabled context."""
        return self.context.new_page()

    def set_location(self, location: GeoLocation) -> None:
        """Update the simulated geolocation on the active browser context."""
        self.location = location
        self.context.set_geolocation(location.to_playwright_geolocation())

