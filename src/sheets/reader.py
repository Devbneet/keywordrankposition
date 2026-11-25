"""Read-only Google Sheets API wrapper for Phase 6 structure detection."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from src.sheets.models import ColumnMapping, SheetStructure
from src.sheets.structure_detector import detect_sheet_structure

READONLY_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]


def build_readonly_sheets_service(credentials_path: str | Path) -> Any:
    """Build a read-only Google Sheets API service from a service-account JSON file."""
    try:
        from google.oauth2.service_account import Credentials
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise ImportError(
            "Google Sheets API packages are not installed. "
            "Install google-api-python-client and google-auth when ready for live Sheets."
        ) from exc

    creds = Credentials.from_service_account_file(str(credentials_path), scopes=READONLY_SCOPES)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


class GoogleSheetsReader:
    """Read-only client to fetch worksheet values, metadata, and detected structure."""

    def __init__(self, service: Any) -> None:
        self._service = service

    @classmethod
    def from_service_account(cls, credentials_path: str | Path) -> GoogleSheetsReader:
        return cls(build_readonly_sheets_service(credentials_path))

    def get_worksheet_id(self, spreadsheet_id: str, worksheet_name: str) -> int | None:
        """Return the numeric sheetId for worksheet_name, or None if not found."""
        metadata = (
            self._service.spreadsheets()
            .get(spreadsheetId=spreadsheet_id, fields="sheets.properties")
            .execute()
        )
        for sheet in metadata.get("sheets", []):
            props = sheet.get("properties", {})
            if props.get("title") == worksheet_name:
                return props.get("sheetId")
        return None

    def read_values(self, spreadsheet_id: str, worksheet_name: str) -> list[list[str]]:
        """Read all non-empty cell rows from the target worksheet."""
        response = (
            self._service.spreadsheets()
            .values()
            .get(spreadsheetId=spreadsheet_id, range=worksheet_name)
            .execute()
        )
        return response.get("values", [])

    def read_and_detect_structure(
        self,
        spreadsheet_id: str,
        worksheet_name: str,
        *,
        column_mapping: ColumnMapping | None = None,
    ) -> SheetStructure:
        """Fetch worksheet metadata + values and return a validated SheetStructure."""
        sheet_id = self.get_worksheet_id(spreadsheet_id, worksheet_name)
        rows = self.read_values(spreadsheet_id, worksheet_name)
        return detect_sheet_structure(
            rows,
            spreadsheet_id=spreadsheet_id,
            worksheet_name=worksheet_name,
            column_mapping=column_mapping,
            sheet_id=sheet_id,
        )

