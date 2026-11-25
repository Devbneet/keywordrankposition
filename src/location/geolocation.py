"""Geolocation models, validation, and Playwright context option builders."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class GeoLocation:
    """Validated geographic coordinates for browser location simulation."""

    latitude: float
    longitude: float
    accuracy: float = 50.0
    location_name: str = ""
    locale: str = "en-US"
    timezone_id: str | None = None

    def __post_init__(self) -> None:
        if not -90.0 <= self.latitude <= 90.0:
            raise ValueError(f"Latitude must be between -90 and 90, got {self.latitude}")
        if not -180.0 <= self.longitude <= 180.0:
            raise ValueError(f"Longitude must be between -180 and 180, got {self.longitude}")
        if self.accuracy <= 0:
            raise ValueError(f"Accuracy must be positive, got {self.accuracy}")

    def to_playwright_geolocation(self) -> dict[str, float]:
        """Return the dict format expected by Playwright's geolocation parameter."""
        return {
            "latitude": float(self.latitude),
            "longitude": float(self.longitude),
            "accuracy": float(self.accuracy),
        }

    def to_context_options(self) -> dict[str, Any]:
        """Return Playwright Browser.new_context kwargs with geolocation enabled."""
        options: dict[str, Any] = {
            "geolocation": self.to_playwright_geolocation(),
            "permissions": ["geolocation"],
            "locale": self.locale,
        }
        if self.timezone_id:
            options["timezone_id"] = self.timezone_id
        return options

