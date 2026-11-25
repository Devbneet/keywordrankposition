"""Multiple keyword organic ranking detection with polite pacing and block safety."""

from __future__ import annotations

import random
import time
import uuid
from dataclasses import dataclass
from typing import Callable

from src.browser.session import BrowserSession
from src.ranking.single_checker import RankResult, SingleKeywordChecker


@dataclass(frozen=True)
class KeywordTask:
    """Single keyword to check, anchored by its spreadsheet row_number."""

    row_number: int
    keyword: str


@dataclass(frozen=True)
class BatchRankItem:
    """Ranking result tied back to its exact spreadsheet row_number."""

    row_number: int
    result: RankResult


@dataclass(frozen=True)
class BatchRunSummary:
    """Aggregated results for a multi-keyword ranking run."""

    run_id: str
    client_id: str
    location_name: str
    target_domain: str
    items: list[BatchRankItem]
    stopped_early: bool = False

    @property
    def total(self) -> int:
        return len(self.items)

    @property
    def ranked_count(self) -> int:
        return sum(1 for item in self.items if item.result.status == "ranked")

    @property
    def not_found_count(self) -> int:
        return sum(1 for item in self.items if item.result.status == "not_found")

    @property
    def blocked_count(self) -> int:
        return sum(1 for item in self.items if item.result.status == "blocked")

    @property
    def error_count(self) -> int:
        return sum(1 for item in self.items if item.result.status == "error")


class BatchKeywordChecker:
    """Run organic ranking checks across multiple KeywordTask items."""

    def __init__(
        self,
        single_checker: SingleKeywordChecker | None = None,
        *,
        delay_range: tuple[float, float] = (1.5, 3.0),
        stop_on_block: bool = True,
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        self.single_checker = single_checker or SingleKeywordChecker()
        self.delay_range = delay_range
        self.stop_on_block = stop_on_block
        self.sleep_fn = sleep_fn

    def _pause_between_queries(self) -> None:
        low, high = self.delay_range
        if high <= 0:
            return
        delay = low if low >= high else random.uniform(low, high)
        if delay > 0:
            self.sleep_fn(delay)

    def run_batch(
        self,
        session: BrowserSession,
        tasks: list[KeywordTask],
        target_domain: str,
        *,
        client_id: str = "",
        max_depth: int = 50,
        timeout_ms: int = 15000,
    ) -> BatchRunSummary:
        """Check each KeywordTask sequentially, preserving row_number identity."""
        items: list[BatchRankItem] = []
        stopped_early = False

        for index, task in enumerate(tasks):
            if index > 0:
                self._pause_between_queries()

            result = self.single_checker.check_keyword(
                session,
                task.keyword,
                target_domain,
                max_depth=max_depth,
                timeout_ms=timeout_ms,
            )
            items.append(BatchRankItem(row_number=task.row_number, result=result))

            if self.stop_on_block and result.status == "blocked":
                stopped_early = True
                break

        return BatchRunSummary(
            run_id=uuid.uuid4().hex[:12],
            client_id=client_id,
            location_name=session.location.location_name,
            target_domain=target_domain,
            items=items,
            stopped_early=stopped_early,
        )

