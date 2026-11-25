"""Design-preserving Google Sheets updater (Rules 1-24)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from src.ranking.batch_checker import BatchRankItem
from src.sheets.models import SheetStructure, col_index_to_letter

WRITE_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


class DuplicateDateColumnError(ValueError):
    """Raised when the target date header already exists on the sheet (Rule 18)."""


@dataclass(frozen=True)
class CellUpdate:
    """Single targeted cell update."""

    a1_range: str
    value: str | int
    row_number: int
    column_letter: str
    reason: str


@dataclass(frozen=True)
class SheetUpdatePlan:
    """Dry-run / execution plan for updating a client worksheet without redesigning it."""

    spreadsheet_id: str
    worksheet_name: str
    sheet_id: int
    date_label: str
    insert_column_index: int
    insert_column_letter: str
    header_updates: list[CellUpdate]
    rank_updates: list[CellUpdate]
    serp_updates: list[CellUpdate]
    skipped_errors: list[BatchRankItem]

    @property
    def all_cell_updates(self) -> list[CellUpdate]:
        return [*self.header_updates, *self.rank_updates, *self.serp_updates]


def format_sheet_date(target_date: date | None = None) -> str:
    """Format date using the existing sheet style, e.g. '23-November' (Rule 11)."""
    d = target_date or date.today()
    return f"{d.day}-{d.strftime('%B')}"


def save_sheet_backup(
    spreadsheet_id: str,
    worksheet_name: str,
    rows: list[list[str]],
    backup_dir: str | Path = "backups",
) -> Path:
    """Save a timestamped JSON snapshot of worksheet values before modifying a live sheet (Rule 20)."""
    target_dir = Path(backup_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe_ws = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in worksheet_name)
    backup_path = target_dir / f"{spreadsheet_id}_{safe_ws}_{stamp}.json"
    payload = {
        "spreadsheet_id": spreadsheet_id,
        "worksheet_name": worksheet_name,
        "backed_up_at_utc": stamp,
        "rows": rows,
    }
    backup_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return backup_path


def build_update_plan(
    structure: SheetStructure,
    batch_items: list[BatchRankItem],
    *,
    date_label: str | None = None,
) -> SheetUpdatePlan:
    """Build a targeted update plan adhering to all 24 sheet preservation rules."""
    if structure.sheet_id is None:
        raise ValueError("SheetStructure.sheet_id is required before building an update plan.")

    resolved_date = date_label or format_sheet_date()
    if structure.has_date_header(resolved_date):
        raise DuplicateDateColumnError(
            f"Date column '{resolved_date}' already exists in '{structure.worksheet_name}'."
        )

    mapping = structure.column_mapping
    date_col_idx = mapping.latest_date_start_idx
    date_col_letter = col_index_to_letter(date_col_idx)
    serp_col_letter = mapping.serp_url.upper()
    ws = structure.worksheet_name

    # Rule 12: Update the date header across every keyword group.
    header_updates = [
        CellUpdate(
            a1_range=f"'{ws}'!{date_col_letter}{header_row}",
            value=resolved_date,
            row_number=header_row,
            column_letter=date_col_letter,
            reason="date_header",
        )
        for header_row in structure.header_rows
    ]

    valid_rows = {row.row_number for row in structure.all_keyword_rows}
    rank_updates: list[CellUpdate] = []
    serp_updates: list[CellUpdate] = []
    skipped_errors: list[BatchRankItem] = []

    for item in batch_items:
        if item.row_number not in valid_rows:
            raise ValueError(f"Row {item.row_number} is not a detected keyword row in '{ws}'.")

        res = item.result
        if res.status in ("blocked", "error"):
            # Rule 17: Never report blocked/error as NA.
            skipped_errors.append(item)
            continue

        if res.status == "ranked" and res.position is not None:
            rank_updates.append(
                CellUpdate(
                    a1_range=f"'{ws}'!{date_col_letter}{item.row_number}",
                    value=res.position,
                    row_number=item.row_number,
                    column_letter=date_col_letter,
                    reason="ranked_position",
                )
            )
            if res.ranking_url:
                # Rule 13: Update SERP column only when a valid result is available.
                serp_updates.append(
                    CellUpdate(
                        a1_range=f"'{ws}'!{serp_col_letter}{item.row_number}",
                        value=res.ranking_url,
                        row_number=item.row_number,
                        column_letter=serp_col_letter,
                        reason="verified_serp_url",
                    )
                )
        elif res.status == "not_found":
            # Rule 16: Confirmed not ranking within search depth -> NA.
            rank_updates.append(
                CellUpdate(
                    a1_range=f"'{ws}'!{date_col_letter}{item.row_number}",
                    value="NA",
                    row_number=item.row_number,
                    column_letter=date_col_letter,
                    reason="not_found_na",
                )
            )

    return SheetUpdatePlan(
        spreadsheet_id=structure.spreadsheet_id,
        worksheet_name=ws,
        sheet_id=structure.sheet_id,
        date_label=resolved_date,
        insert_column_index=date_col_idx,
        insert_column_letter=date_col_letter,
        header_updates=header_updates,
        rank_updates=rank_updates,
        serp_updates=serp_updates,
        skipped_errors=skipped_errors,
    )


def format_dry_run_preview(plan: SheetUpdatePlan) -> str:
    """Return a human-readable dry-run preview of planned sheet changes (Rule 21)."""
    lines = [
        f"DRY RUN PREVIEW - {plan.worksheet_name} ({plan.spreadsheet_id})",
        f"Insert 1 column at {plan.insert_column_letter} (index {plan.insert_column_index}) for '{plan.date_label}'",
        f"Copy formatting from {col_index_to_letter(plan.insert_column_index + 1)} -> {plan.insert_column_letter}",
        f"Header updates: {len(plan.header_updates)} | Rank updates: {len(plan.rank_updates)} | SERP updates: {len(plan.serp_updates)} | Skipped errors: {len(plan.skipped_errors)}",
    ]
    for upd in plan.all_cell_updates:
        lines.append(f"  {upd.a1_range} <- {upd.value!r} ({upd.reason})")
    for err in plan.skipped_errors:
        lines.append(
            f"  SKIP Row {err.row_number} [{err.result.keyword}]: {err.result.status} ({err.result.error_message})"
        )
    return "\n".join(lines)


class GoogleSheetsUpdater:
    """Apply a SheetUpdatePlan using targeted Google Sheets API batch updates."""

    def __init__(self, service: Any) -> None:
        self._service = service

    @classmethod
    def from_service_account(cls, credentials_path: str | Path) -> GoogleSheetsUpdater:
        try:
            from google.oauth2.service_account import Credentials
            from googleapiclient.discovery import build
        except ImportError as exc:
            raise ImportError(
                "Google Sheets API packages are not installed. "
                "Install google-api-python-client and google-auth when ready for live Sheets."
            ) from exc

        creds = Credentials.from_service_account_file(str(credentials_path), scopes=WRITE_SCOPES)
        return cls(build("sheets", "v4", credentials=creds, cache_discovery=False))

    def apply_plan(
        self,
        plan: SheetUpdatePlan,
        *,
        backup_rows: list[list[str]] | None = None,
        backup_dir: str | Path = "backups",
        dry_run: bool = True,
    ) -> dict[str, Any]:
        """Execute or preview a SheetUpdatePlan.

        When dry_run=True (default), no API writes are performed.
        When dry_run=False, a backup must be created first (Rule 20).
        """
        if dry_run:
            return {
                "dry_run": True,
                "preview": format_dry_run_preview(plan),
                "backup_path": None,
                "cells_updated": 0,
            }

        if backup_rows is None:
            raise ValueError("backup_rows must be provided to create a pre-update backup (Rule 20).")

        backup_path = save_sheet_backup(
            plan.spreadsheet_id,
            plan.worksheet_name,
            backup_rows,
            backup_dir=backup_dir,
        )

        # Rules 9 & 10: Insert new date column at latest_date_start_idx and copy format from previous column.
        col_idx = plan.insert_column_index
        structural_requests = [
            {
                "insertDimension": {
                    "range": {
                        "sheetId": plan.sheet_id,
                        "dimension": "COLUMNS",
                        "startIndex": col_idx,
                        "endIndex": col_idx + 1,
                    },
                    "inheritFromBefore": False,
                }
            },
            {
                "copyPaste": {
                    "source": {
                        "sheetId": plan.sheet_id,
                        "startColumnIndex": col_idx + 1,
                        "endColumnIndex": col_idx + 2,
                    },
                    "destination": {
                        "sheetId": plan.sheet_id,
                        "startColumnIndex": col_idx,
                        "endColumnIndex": col_idx + 1,
                    },
                    "pasteType": "PASTE_FORMAT",
                    "pasteOrientation": "NORMAL",
                }
            },
        ]

        self._service.spreadsheets().batchUpdate(
            spreadsheetId=plan.spreadsheet_id,
            body={"requests": structural_requests},
        ).execute()

        # Rule 22: Targeted cell value updates only.
        value_data = [
            {"range": upd.a1_range, "values": [[upd.value]]}
            for upd in plan.all_cell_updates
        ]
        if value_data:
            self._service.spreadsheets().values().batchUpdate(
                spreadsheetId=plan.spreadsheet_id,
                body={"valueInputOption": "USER_ENTERED", "data": value_data},
            ).execute()

        return {
            "dry_run": False,
            "backup_path": str(backup_path),
            "cells_updated": len(value_data),
        }

