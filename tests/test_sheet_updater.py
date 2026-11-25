"""Tests for Phase 7 design-preserving Google Sheets updater."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from src.ranking.batch_checker import BatchRankItem
from src.ranking.single_checker import RankResult
from src.sheets.structure_detector import detect_sheet_structure
from src.sheets.updater import (
    DuplicateDateColumnError,
    GoogleSheetsUpdater,
    build_update_plan,
    format_dry_run_preview,
    format_sheet_date,
)


def _sample_rows() -> list[list[str]]:
    return [
        ["", "", "Website Statistics", "", "", "", "", "23-November"],
        ["", "", "Semrush Authority Score", "28", "", "", "", "28"],
        [],
        ["", "", "Keyword", "Search Volume", "Competition", "Landing Page", "SERP", "23-November"],
        ["", "", "seo agency sydney", "1900", "High", "https://example.com/seo", "https://example.com/old", "4"],
        ["", "", "local seo sydney", "720", "Medium", "https://example.com/local", "", "NA"],
        [],
        ["", "", "Keyword", "Search Volume", "Competition", "Landing Page", "SERP", "23-November"],
        ["", "", "blocked keyword", "500", "Low", "https://example.com/b", "https://example.com/b", "6"],
    ]


def test_format_sheet_date_matches_agency_format() -> None:
    assert format_sheet_date(date(2026, 11, 30)) == "30-November"


def test_build_update_plan_preserves_rules_and_skips_errors() -> None:
    """Verify multi-group headers, SERP updates, NA handling, and blocked-row isolation."""
    rows = _sample_rows()
    structure = detect_sheet_structure(rows, spreadsheet_id="sheet-123", worksheet_name="Keywords", sheet_id=42)

    batch_items = [
        BatchRankItem(
            row_number=5,
            result=RankResult(
                keyword="seo agency sydney",
                status="ranked",
                position=2,
                ranking_url="https://example.com/seo-new",
            ),
        ),
        BatchRankItem(
            row_number=6,
            result=RankResult(keyword="local seo sydney", status="not_found", position=None),
        ),
        BatchRankItem(
            row_number=9,
            result=RankResult(
                keyword="blocked keyword",
                status="blocked",
                position=None,
                error_message="CAPTCHA",
            ),
        ),
    ]

    plan = build_update_plan(structure, batch_items, date_label="30-November")

    assert plan.insert_column_index == 7  # Column H
    assert plan.insert_column_letter == "H"
    assert [u.a1_range for u in plan.header_updates] == ["'Keywords'!H4", "'Keywords'!H8"]
    assert [(u.a1_range, u.value) for u in plan.rank_updates] == [
        ("'Keywords'!H5", 2),
        ("'Keywords'!H6", "NA"),
    ]
    # SERP updated only for ranked row 5; row 6 (not_found) and row 9 (blocked) untouched
    assert [(u.a1_range, u.value) for u in plan.serp_updates] == [
        ("'Keywords'!G5", "https://example.com/seo-new"),
    ]
    assert len(plan.skipped_errors) == 1
    assert plan.skipped_errors[0].row_number == 9

    preview = format_dry_run_preview(plan)
    assert "DRY RUN PREVIEW" in preview
    assert "SKIP Row 9 [blocked keyword]" in preview


def test_duplicate_date_column_raises_error() -> None:
    """Rule 18: Prevent duplicate date columns on same-day re-runs."""
    structure = detect_sheet_structure(_sample_rows(), spreadsheet_id="sheet-123", worksheet_name="Keywords", sheet_id=42)
    with pytest.raises(DuplicateDateColumnError, match="23-November"):
        build_update_plan(structure, [], date_label="23-November")


def test_updater_dry_run_and_apply_with_backup(tmp_path: Path) -> None:
    """Verify dry_run makes no API calls, and apply_plan creates backup + targeted updates."""
    rows = _sample_rows()
    structure = detect_sheet_structure(rows, spreadsheet_id="sheet-123", worksheet_name="Keywords", sheet_id=42)
    plan = build_update_plan(
        structure,
        [BatchRankItem(row_number=5, result=RankResult(keyword="seo agency sydney", status="ranked", position=2, ranking_url="https://example.com/seo"))],
        date_label="30-November",
    )

    mock_service = MagicMock()
    updater = GoogleSheetsUpdater(mock_service)

    dry_result = updater.apply_plan(plan, dry_run=True)
    assert dry_result["dry_run"] is True
    assert dry_result["cells_updated"] == 0
    mock_service.spreadsheets.assert_not_called()

    live_result = updater.apply_plan(plan, backup_rows=rows, backup_dir=tmp_path, dry_run=False)
    assert live_result["dry_run"] is False
    assert live_result["cells_updated"] == 4  # 2 headers + 1 rank + 1 SERP
    assert Path(live_result["backup_path"]).exists()
    mock_service.spreadsheets.return_value.batchUpdate.assert_called_once()
    mock_service.spreadsheets.return_value.values.return_value.batchUpdate.assert_called_once()

