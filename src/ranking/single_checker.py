"""Single keyword organic ranking detection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from urllib.parse import quote_plus

from src.browser.session import BrowserSession
from src.ranking.matcher import is_target_domain
from src.ranking.serp_parser import detect_block_page, parse_organic_results

RankStatus = Literal["ranked", "not_found", "blocked", "error"]


@dataclass(frozen=True)
class RankResult:
    """Outcome of checking a single keyword's organic ranking."""

    keyword: str
    status: RankStatus
    position: int | None = None
    ranking_url: str | None = None
    checked_results: int = 0
    error_message: str | None = None


def find_organic_rank_from_html(
    html: str,
    keyword: str,
    target_domain: str,
    *,
    max_depth: int = 50,
    page_url: str = "",
) -> RankResult:
    """Detect organic rank for target_domain from SERP HTML without fabricating results."""
    block_reason = detect_block_page(html, page_url=page_url)
    if block_reason:
        return RankResult(
            keyword=keyword,
            status="blocked",
            position=None,
            ranking_url=None,
            checked_results=0,
            error_message=block_reason,
        )

    organic_results = parse_organic_results(html, max_results=max_depth)
    for item in organic_results:
        if is_target_domain(item.url, target_domain):
            return RankResult(
                keyword=keyword,
                status="ranked",
                position=item.position,
                ranking_url=item.url,
                checked_results=len(organic_results),
            )

    return RankResult(
        keyword=keyword,
        status="not_found",
        position=None,
        ranking_url=None,
        checked_results=len(organic_results),
    )


class SingleKeywordChecker:
    """Check organic ranking for one keyword using a geolocation-enabled BrowserSession."""

    def __init__(self, search_base_url: str = "https://www.google.com/search") -> None:
        self.search_base_url = search_base_url

    def build_search_url(self, keyword: str, num_results: int = 50) -> str:
        """Build the search URL for a single keyword."""
        separator = "&" if "?" in self.search_base_url else "?"
        return f"{self.search_base_url}{separator}q={quote_plus(keyword)}&num={num_results}"

    def check_keyword(
        self,
        session: BrowserSession,
        keyword: str,
        target_domain: str,
        *,
        max_depth: int = 50,
        timeout_ms: int = 15000,
    ) -> RankResult:
        """Navigate to the search page in the active BrowserSession and detect organic rank."""
        page = session.new_page()
        search_url = self.build_search_url(keyword, num_results=max_depth)
        try:
            page.goto(search_url, wait_until="domcontentloaded", timeout=timeout_ms)
            html = page.content()
            return find_organic_rank_from_html(
                html,
                keyword=keyword,
                target_domain=target_domain,
                max_depth=max_depth,
                page_url=page.url,
            )
        except Exception as exc:
            return RankResult(
                keyword=keyword,
                status="error",
                position=None,
                ranking_url=None,
                checked_results=0,
                error_message=str(exc),
            )
        finally:
            page.close()

