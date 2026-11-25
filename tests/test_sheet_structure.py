"""Tests for Phase 6 Google Sheet structure detection and read-only reader."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from src.sheets.models import (
    ColumnMapping,
    SheetStructureError,
    col_index_to_letter,
    col_letter_to_index,
)
from src.sheets.reader import GoogleSheetsReader
from src.sheets.structure_detector import detect_sheet_structure, extract_keyword_tasks


def _sample_agency_sheet_rows() -> list[list[str]]:
    """Return a realistic 2D grid matching Digital Minds' reference Google Sheet."""
    return [
        ["", "", "Website Statistics", "", "", "", "", "23-November", "16-November"],
        ["", "", "Semrush Authority Score", "28", "", "", "", "28", "27"],
        ["", "", "Backlinks", "1.4K", "", "", "", "1.4K", "1.3K"],
        ["", "", "MOZ DA", "22", "", "", "", "22", "22"],
        ["", "", "MOZ PA", "31", "", "", "", "31", "30"],
        [],
        ["", "", "Keyword", "Search Volume", "Competition", "Landing Page", "SERP", "23-November", "16-November"],
        ["", "", "seo agency sydney", "1900", "High", "https://example.com/seo", "https://example.com/seo", "3", "4"],
        ["", "", "local seo sydney", "720", "Medium", "https://example.com/local", "", "NA", "NA"],
        [],
        ["", "", "Keyword", "Search Volume", "Competition", "Landing Page", "SERP", "23-November", "16-November"],
        ["", "", "seo agency sydney", "1900", "High", "https://example.com/seo-2", "https://example.com/seo-2", "7", "8"],
    ]


def test_column_letter_conversions() -> None:
    """Verify A1 column letters convert accurately to/from 0-based indices."""
    assert col_letter_to_index("A") == 0
    assert col_letter_to_index("C") == 2
    assert col_letter_to_index("H") == 7
    assert col_letter_to_index("AA") == 26
    assert col_index_to_letter(2) == "C"
    assert col_index_to_letter(7) == "H"
    assert col_index_to_letter(26) == "AA"


def test_detect_multi_group_sheet_structure_and_duplicate_keywords() -> None:
    """Detect repeated headers, blank separators, date headers, and exact row numbers."""
    rows = _sample_agency_sheet_rows()
    structure = detect_sheet_structure(rows, spreadsheet_id="sheet-123", worksheet_name="Keywords")

    assert structure.header_rows == [7, 11]
    assert structure.total_keywords == 3
    assert structure.latest_date_header == "23-November"
    assert structure.has_date_header("23-November") is True
    assert structure.has_date_header("30-November") is False

    tasks = extract_keyword_tasks(structure)
    assert [(t.row_number, t.keyword) for t in tasks] == [
        (8, "seo agency sydney"),
        (9, "local seo sydney"),
        (12, "seo agency sydney"),
    ]


def test_detect_sheet_structure_stops_on_unexpected_layout() -> None:
    """Raise SheetStructureError when expected Keyword/SERP headers are missing (Rule 23)."""
    broken_rows = [
        ["", "", "Query", "Volume", "Comp", "URL", "Link", "23-November"],
        ["", "", "seo agency sydney", "1900", "High", "https://example.com", "", "3"],
    ]
    with pytest.raises(SheetStructureError, match="No keyword table header found"):
        detect_sheet_structure(broken_rows)


def test_configurable_column_mapping() -> None:
    """Support clients with slightly shifted column letters (Rule 24)."""
    shifted_rows = [
        ["", "Keyword", "Search Volume", "Competition", "Landing Page", "SERP", "23-November"],
        ["", "web design sydney", "880", "Medium", "https://example.com/web", "https://example.com/web", "5"],
    ]
    mapping = ColumnMapping(
        keyword="B",
        search_volume="C",
        competition="D",
        landing_page="E",
        serp_url="F",
        latest_date_start="G",
    )
    structure = detect_sheet_structure(shifted_rows, column_mapping=mapping)
    assert structure.total_keywords == 1
    assert structure.all_keyword_rows[0].row_number == 2
    assert structure.all_keyword_rows[0].keyword == "web design sydney"


def test_google_sheets_reader_with_mocked_service() -> None:
    """Verify GoogleSheetsReader fetches sheetId and values and builds SheetStructure."""
    mock_service = MagicMock()
    mock_service.spreadsheets.return_value.get.return_value.execute.return_value = {
        "sheets": [{"properties": {"title": "Keywords", "sheetId": 987654}}]
    }
    mock_service.spreadsheets.return_value.values.return_value.get.return_value.execute.return_value = {
        "values": _sample_agency_sheet_rows()
    }

    reader = GoogleSheetsReader(mock_service)
    structure = reader.read_and_detect_structure("sheet-123", "Keywords")

    assert structure.sheet_id == 987654
    assert structure.total_keywords == 3
    assert structure.header_rows == [7, 11]

