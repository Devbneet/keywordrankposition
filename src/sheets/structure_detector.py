"""Detect repeated keyword groups, headers, and row positions in a worksheet."""

from __future__ import annotations

from src.ranking.batch_checker import KeywordTask
from src.sheets.models import (
    ColumnMapping,
    KeywordGroup,
    SheetKeywordRow,
    SheetStructure,
    SheetStructureError,
)


def _cell(row: list[str], index: int) -> str:
    if index < 0 or index >= len(row):
        return ""
    return str(row[index]).strip()


def _is_header_row(row: list[str], mapping: ColumnMapping) -> bool:
    """Return True when the row matches a keyword table header at the mapped columns."""
    kw_header = _cell(row, mapping.keyword_idx).lower()
    serp_header = _cell(row, mapping.serp_url_idx).lower()
    return kw_header in ("keyword", "keywords") and "serp" in serp_header


def detect_sheet_structure(
    rows: list[list[str]],
    *,
    spreadsheet_id: str = "",
    worksheet_name: str = "Keywords",
    column_mapping: ColumnMapping | None = None,
    sheet_id: int | None = None,
) -> SheetStructure:
    """Parse a 2D worksheet grid into KeywordGroup objects and validate structure.

    Raises SheetStructureError if no valid keyword table headers are found at the
    configured column positions (Rule 23).
    """
    mapping = column_mapping or ColumnMapping()
    groups: list[KeywordGroup] = []
    current_header_row: int | None = None
    current_date_headers: list[str] = []
    current_rows: list[SheetKeywordRow] = []

    def _flush_group() -> None:
        nonlocal current_header_row, current_date_headers, current_rows
        if current_header_row is not None:
            groups.append(
                KeywordGroup(
                    header_row=current_header_row,
                    date_headers=current_date_headers,
                    keyword_rows=current_rows,
                )
            )
        current_header_row = None
        current_date_headers = []
        current_rows = []

    for row_idx, row in enumerate(rows, start=1):
        if _is_header_row(row, mapping):
            _flush_group()
            current_header_row = row_idx
            start_idx = mapping.latest_date_start_idx
            current_date_headers = [
                str(cell).strip()
                for cell in row[start_idx:]
                if str(cell).strip()
            ]
            continue

        if current_header_row is None:
            # Top website statistics / metadata rows before the first keyword table header.
            continue

        keyword_text = _cell(row, mapping.keyword_idx)
        if not keyword_text:
            # Blank separator row between keyword groups (or trailing empty row).
            continue

        current_rows.append(
            SheetKeywordRow(
                row_number=row_idx,
                keyword=keyword_text,
                search_volume=_cell(row, mapping.search_volume_idx),
                competition=_cell(row, mapping.competition_idx),
                landing_page=_cell(row, mapping.landing_page_idx),
                serp_url=_cell(row, mapping.serp_url_idx),
                latest_rank_value=_cell(row, mapping.latest_date_start_idx),
            )
        )

    _flush_group()

    if not groups:
        raise SheetStructureError(
            f"No keyword table header found at columns "
            f"Keyword={mapping.keyword}, SERP={mapping.serp_url}."
        )

    return SheetStructure(
        spreadsheet_id=spreadsheet_id,
        worksheet_name=worksheet_name,
        column_mapping=mapping,
        groups=groups,
        sheet_id=sheet_id,
    )


def extract_keyword_tasks(structure: SheetStructure) -> list[KeywordTask]:
    """Convert detected SheetKeywordRow entries into row-anchored KeywordTask items."""
    return [
        KeywordTask(row_number=row.row_number, keyword=row.keyword)
        for row in structure.all_keyword_rows
    ]

