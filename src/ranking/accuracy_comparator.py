"""Compare automated ranking results against manual GS Location Changer baselines."""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from src.ranking.batch_checker import BatchRankItem

ComparisonStatus = Literal[
    "exact_match",
    "within_tolerance",
    "position_mismatch",
    "url_mismatch",
    "missing_baseline",
    "blocked_or_error",
]


@dataclass(frozen=True)
class ManualBaselineRow:
    """Manual ranking observation recorded using the GS Location Changer extension."""

    row_number: int
    keyword: str
    gs_position: int | str | None
    gs_ranking_url: str | None = None


@dataclass(frozen=True)
class RowComparison:
    """Comparison outcome for a single spreadsheet row."""

    row_number: int
    keyword: str
    auto_position: int | str
    gs_position: int | str
    position_delta: int | None
    auto_url: str | None
    gs_url: str | None
    url_match: bool
    comparison_status: ComparisonStatus


@dataclass(frozen=True)
class AccuracyReport:
    """Summary metrics and per-row comparison against GS Location Changer."""

    total_rows: int
    comparable_rows: int
    exact_matches: int
    within_tolerance: int
    mismatches: int
    missing_baseline: int
    blocked_or_errors: int
    rows: list[RowComparison]

    @property
    def exact_match_rate(self) -> float:
        if self.comparable_rows == 0:
            return 0.0
        return round((self.exact_matches / self.comparable_rows) * 100.0, 2)

    @property
    def tolerance_match_rate(self) -> float:
        if self.comparable_rows == 0:
            return 0.0
        return round(((self.exact_matches + self.within_tolerance) / self.comparable_rows) * 100.0, 2)


def _normalize_position(value: int | str | None) -> int | str:
    """Normalize integer positions and NA-like values into int or 'NA'."""
    if value is None:
        return "NA"
    if isinstance(value, int):
        return value
    cleaned = value.strip()
    if not cleaned or cleaned.upper() == "NA":
        return "NA"
    return int(cleaned)


def _normalize_url(url: str | None) -> str:
    if not url:
        return ""
    return url.strip().rstrip("/").lower()


def load_gs_baseline_csv(csv_path: str | Path) -> list[ManualBaselineRow]:
    """Load manual GS Location Changer baseline rows from a CSV file.

    Expected columns: row_number, keyword, gs_position, gs_ranking_url (optional).
    """
    rows: list[ManualBaselineRow] = []
    with Path(csv_path).open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for raw in reader:
            rows.append(
                ManualBaselineRow(
                    row_number=int(raw["row_number"]),
                    keyword=raw["keyword"].strip(),
                    gs_position=raw.get("gs_position", "NA"),
                    gs_ranking_url=(raw.get("gs_ranking_url") or "").strip() or None,
                )
            )
    return rows


def compare_with_gs_baseline(
    auto_items: list[BatchRankItem],
    baseline_rows: list[ManualBaselineRow],
    *,
    tolerance: int = 1,
) -> AccuracyReport:
    """Compare automated BatchRankItem results to manual GS Location Changer rows by row_number."""
    baseline_by_row = {row.row_number: row for row in baseline_rows}

    comparisons: list[RowComparison] = []
    comparable_rows = 0
    exact_matches = 0
    within_tolerance = 0
    mismatches = 0
    missing_baseline = 0
    blocked_or_errors = 0

    for item in auto_items:
        result = item.result
        baseline = baseline_by_row.get(item.row_number)

        if result.status in ("blocked", "error"):
            blocked_or_errors += 1
            gs_pos = _normalize_position(baseline.gs_position) if baseline else "NA"
            comparisons.append(
                RowComparison(
                    row_number=item.row_number,
                    keyword=result.keyword,
                    auto_position=result.status.upper(),
                    gs_position=gs_pos,
                    position_delta=None,
                    auto_url=result.ranking_url,
                    gs_url=baseline.gs_ranking_url if baseline else None,
                    url_match=False,
                    comparison_status="blocked_or_error",
                )
            )
            continue

        if baseline is None:
            missing_baseline += 1
            auto_pos: int | str = result.position if result.status == "ranked" and result.position is not None else "NA"
            comparisons.append(
                RowComparison(
                    row_number=item.row_number,
                    keyword=result.keyword,
                    auto_position=auto_pos,
                    gs_position="NA",
                    position_delta=None,
                    auto_url=result.ranking_url,
                    gs_url=None,
                    url_match=False,
                    comparison_status="missing_baseline",
                )
            )
            continue

        comparable_rows += 1
        auto_pos = result.position if result.status == "ranked" and result.position is not None else "NA"
        gs_pos = _normalize_position(baseline.gs_position)

        url_match = True
        if baseline.gs_ranking_url is not None or result.ranking_url is not None:
            url_match = _normalize_url(result.ranking_url) == _normalize_url(baseline.gs_ranking_url)

        delta: int | None = None
        if isinstance(auto_pos, int) and isinstance(gs_pos, int):
            delta = abs(auto_pos - gs_pos)

        if auto_pos == gs_pos:
            if auto_pos == "NA" or url_match or baseline.gs_ranking_url is None:
                status: ComparisonStatus = "exact_match"
                exact_matches += 1
            else:
                status = "url_mismatch"
                mismatches += 1
        elif delta is not None and delta <= tolerance:
            status = "within_tolerance"
            within_tolerance += 1
        else:
            status = "position_mismatch"
            mismatches += 1

        comparisons.append(
            RowComparison(
                row_number=item.row_number,
                keyword=result.keyword,
                auto_position=auto_pos,
                gs_position=gs_pos,
                position_delta=delta,
                auto_url=result.ranking_url,
                gs_url=baseline.gs_ranking_url,
                url_match=url_match,
                comparison_status=status,
            )
        )

    return AccuracyReport(
        total_rows=len(auto_items),
        comparable_rows=comparable_rows,
        exact_matches=exact_matches,
        within_tolerance=within_tolerance,
        mismatches=mismatches,
        missing_baseline=missing_baseline,
        blocked_or_errors=blocked_or_errors,
        rows=comparisons,
    )


def format_accuracy_report(report: AccuracyReport) -> str:
    """Format an AccuracyReport as a human-readable text summary."""
    lines = [
        f"Total rows: {report.total_rows} | Comparable: {report.comparable_rows}",
        f"Exact matches: {report.exact_matches} ({report.exact_match_rate}%)",
        f"Within tolerance: {report.within_tolerance} (Combined: {report.tolerance_match_rate}%)",
        f"Mismatches: {report.mismatches} | Missing baseline: {report.missing_baseline} | Blocked/Error: {report.blocked_or_errors}",
    ]
    for row in report.rows:
        lines.append(
            f"  Row {row.row_number} [{row.keyword}]: auto={row.auto_position}, gs={row.gs_position} -> {row.comparison_status}"
        )
    return "\n".join(lines)

