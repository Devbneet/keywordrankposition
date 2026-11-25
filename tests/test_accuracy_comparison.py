"""Tests for Phase 5 GS Location Changer accuracy comparison."""

from __future__ import annotations

from pathlib import Path

from src.ranking.accuracy_comparator import (
    ManualBaselineRow,
    compare_with_gs_baseline,
    format_accuracy_report,
    load_gs_baseline_csv,
)
from src.ranking.batch_checker import BatchRankItem
from src.ranking.single_checker import RankResult


def test_accuracy_comparison_handles_matches_tolerance_and_blocks() -> None:
    """Verify exact matches, NA matches, tolerance, URL mismatches, and blocked isolation."""
    auto_items = [
        BatchRankItem(
            row_number=10,
            result=RankResult(
                keyword="seo agency sydney",
                status="ranked",
                position=3,
                ranking_url="https://www.example.com/services/seo-sydney/",
            ),
        ),
        BatchRankItem(
            row_number=11,
            result=RankResult(
                keyword="seo agency sydney",  # duplicate keyword at another row
                status="ranked",
                position=4,
                ranking_url="https://www.example.com/services/seo-sydney",
            ),
        ),
        BatchRankItem(
            row_number=12,
            result=RankResult(keyword="rare keyword", status="not_found", position=None),
        ),
        BatchRankItem(
            row_number=13,
            result=RankResult(
                keyword="web design sydney",
                status="ranked",
                position=5,
                ranking_url="https://www.example.com/other-page",
            ),
        ),
        BatchRankItem(
            row_number=14,
            result=RankResult(
                keyword="blocked keyword",
                status="blocked",
                position=None,
                error_message="CAPTCHA detected",
            ),
        ),
    ]

    baseline = [
        ManualBaselineRow(
            row_number=10,
            keyword="seo agency sydney",
            gs_position=3,
            gs_ranking_url="https://www.example.com/services/seo-sydney",
        ),
        ManualBaselineRow(
            row_number=11,
            keyword="seo agency sydney",
            gs_position=3,
            gs_ranking_url="https://www.example.com/services/seo-sydney",
        ),
        ManualBaselineRow(row_number=12, keyword="rare keyword", gs_position="NA"),
        ManualBaselineRow(
            row_number=13,
            keyword="web design sydney",
            gs_position=5,
            gs_ranking_url="https://www.example.com/web-design",
        ),
        ManualBaselineRow(row_number=14, keyword="blocked keyword", gs_position="NA"),
    ]

    report = compare_with_gs_baseline(auto_items, baseline, tolerance=1)

    assert report.total_rows == 5
    assert report.comparable_rows == 4
    assert report.exact_matches == 2  # rows 10 and 12
    assert report.within_tolerance == 1  # row 11 (delta=1)
    assert report.mismatches == 1  # row 13 (url_mismatch)
    assert report.blocked_or_errors == 1  # row 14 (never counted as NA match)
    assert report.exact_match_rate == 50.0
    assert report.tolerance_match_rate == 75.0

    text = format_accuracy_report(report)
    assert "Exact matches: 2 (50.0%)" in text
    assert "Row 14 [blocked keyword]" in text


def test_load_gs_baseline_csv(tmp_path: Path) -> None:
    """Verify CSV loader parses row_number, keyword, gs_position, and optional URL."""
    csv_file = tmp_path / "gs_baseline.csv"
    csv_file.write_text(
        "row_number,keyword,gs_position,gs_ranking_url\n"
        "10,seo agency sydney,3,https://example.com/seo\n"
        "11,rare keyword,NA,\n",
        encoding="utf-8",
    )

    rows = load_gs_baseline_csv(csv_file)
    assert len(rows) == 2
    assert rows[0].row_number == 10
    assert rows[0].gs_position == "3"
    assert rows[0].gs_ranking_url == "https://example.com/seo"
    assert rows[1].gs_ranking_url is None

