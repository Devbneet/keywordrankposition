"""Multi-client and multi-location configuration models and loader."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from src.location.geolocation import GeoLocation
from src.sheets.models import ColumnMapping


@dataclass(frozen=True)
class ClientLocationConfig:
    """Geographic location target for a client."""

    location_name: str
    latitude: float
    longitude: float
    search_depth: int = 50
    locale: str = "en-US"
    timezone_id: str | None = None

    def to_geolocation(self) -> GeoLocation:
        return GeoLocation(
            latitude=self.latitude,
            longitude=self.longitude,
            location_name=self.location_name,
            locale=self.locale,
            timezone_id=self.timezone_id,
        )


@dataclass(frozen=True)
class ClientSheetConfig:
    """Google Sheet target and column mapping for a client."""

    spreadsheet_id: str
    worksheet_name: str = "Keywords"
    column_mapping: ColumnMapping = ColumnMapping()


@dataclass(frozen=True)
class ClientConfig:
    """Complete configuration for one agency client."""

    client_id: str
    client_name: str
    website_domain: str
    target_url_match: str
    active: bool
    locations: list[ClientLocationConfig]
    google_sheet: ClientSheetConfig


def _parse_client(raw: dict[str, Any]) -> ClientConfig:
    raw_locations = raw.get("locations", [])
    if not raw_locations:
        raise ValueError(f"Client '{raw.get('client_id', '?')}' must define at least one location.")

    locations = [
        ClientLocationConfig(
            location_name=str(loc["location_name"]),
            latitude=float(loc["latitude"]),
            longitude=float(loc["longitude"]),
            search_depth=int(loc.get("search_depth", 50)),
            locale=str(loc.get("locale", "en-US")),
            timezone_id=loc.get("timezone_id"),
        )
        for loc in raw_locations
    ]

    # Validate coordinates eagerly via GeoLocation
    for loc in locations:
        loc.to_geolocation()

    sheet_raw = raw.get("google_sheet", {})
    col_map = ColumnMapping.from_dict(sheet_raw.get("column_mapping", {}))
    sheet_cfg = ClientSheetConfig(
        spreadsheet_id=str(sheet_raw["spreadsheet_id"]),
        worksheet_name=str(sheet_raw.get("worksheet_name", "Keywords")),
        column_mapping=col_map,
    )

    return ClientConfig(
        client_id=str(raw["client_id"]),
        client_name=str(raw["client_name"]),
        website_domain=str(raw["website_domain"]),
        target_url_match=str(raw.get("target_url_match", raw["website_domain"])),
        active=bool(raw.get("active", True)),
        locations=locations,
        google_sheet=sheet_cfg,
    )


def load_clients_config(
    config_path: str | Path,
    *,
    active_only: bool = True,
) -> list[ClientConfig]:
    """Load and validate client configurations from a JSON file."""
    path = Path(config_path)
    data = json.loads(path.read_text(encoding="utf-8"))
    clients = [_parse_client(item) for item in data.get("clients", [])]
    if active_only:
        return [client for client in clients if client.active]
    return clients

