"""SERP HTML parsing, ad/internal link filtering, and block detection."""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlparse

BLOCK_INDICATORS = (
    "unusual traffic from your computer network",
    "our systems have detected unusual traffic",
    "/sorry/index",
    "g-recaptcha",
    "captcha-form",
)

IGNORED_HOSTS = (
    "google.com",
    "www.google.com",
    "accounts.google.com",
    "support.google.com",
    "maps.google.com",
    "policies.google.com",
    "googleadservices.com",
    "www.googleadservices.com",
    "webcache.googleusercontent.com",
)


@dataclass(frozen=True)
class OrganicResult:
    """Single parsed organic SERP entry."""

    position: int
    url: str
    title: str = ""


def detect_block_page(html: str, page_url: str = "") -> str | None:
    """Return a reason string if the HTML or URL indicates a CAPTCHA or access block."""
    lower_url = page_url.lower()
    if "/sorry/" in lower_url:
        return "Google returned a /sorry/ verification page."

    lower_html = html.lower()
    for indicator in BLOCK_INDICATORS:
        if indicator in lower_html:
            return f"Blocked or CAPTCHA page detected ({indicator})."
    return None


def _unwrap_google_redirect(href: str) -> str:
    """Unwrap '/url?q=...' redirects if present; otherwise return href unchanged."""
    parsed = urlparse(href)
    if parsed.path == "/url":
        qs = parse_qs(parsed.query)
        target = qs.get("q") or qs.get("url")
        if target:
            return target[0]
    return href


def _is_ignored_url(url: str) -> bool:
    """Return True for non-HTTP links, ads, and Google internal links."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return True
    host = (parsed.hostname or "").lower()
    if not host:
        return True
    if host in IGNORED_HOSTS or host.endswith(".google.com"):
        return True
    if "/aclk" in parsed.path:
        return True
    return False


class _SerpAnchorParser(HTMLParser):
    """Extract candidate organic result links (h3 inside anchor, or organic container anchors)."""

    def __init__(self) -> None:
        super().__init__()
        self._in_ad_container_depth = 0
        self._current_href: str | None = None
        self._in_h3 = False
        self._h3_text: list[str] = []
        self.candidates: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = dict(attrs)
        classes = (attr_map.get("class") or "").lower()
        data_ad = attr_map.get("data-text-ad")

        if self._in_ad_container_depth > 0:
            self._in_ad_container_depth += 1
            return

        if data_ad is not None or "uEierd".lower() in classes or "ads-ad" in classes or "sponsored" in classes:
            self._in_ad_container_depth = 1
            return

        if tag == "a" and "href" in attr_map:
            self._current_href = attr_map["href"]
        elif tag == "h3" and self._current_href is not None:
            self._in_h3 = True
            self._h3_text = []

    def handle_endtag(self, tag: str) -> None:
        if self._in_ad_container_depth > 0:
            self._in_ad_container_depth -= 1
            return

        if tag == "h3" and self._in_h3:
            self._in_h3 = False
            if self._current_href:
                title = "".join(self._h3_text).strip()
                self.candidates.append((self._current_href, title))
        elif tag == "a":
            self._current_href = None

    def handle_data(self, data: str) -> None:
        if self._in_h3 and self._in_ad_container_depth == 0:
            self._h3_text.append(data)


def parse_organic_results(html: str, max_results: int = 50) -> list[OrganicResult]:
    """Parse ordered organic results from SERP HTML, excluding ads and Google links."""
    parser = _SerpAnchorParser()
    parser.feed(html)

    results: list[OrganicResult] = []
    seen_urls: set[str] = set()

    for raw_href, title in parser.candidates:
        url = _unwrap_google_redirect(raw_href.strip())
        if _is_ignored_url(url):
            continue
        if url in seen_urls:
            continue
        seen_urls.add(url)
        results.append(OrganicResult(position=len(results) + 1, url=url, title=title))
        if len(results) >= max_results:
            break

    return results

