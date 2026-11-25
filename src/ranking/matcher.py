"""Domain and URL normalization helpers for organic ranking detection."""

from __future__ import annotations

from urllib.parse import urlparse


def normalize_domain(domain_or_url: str) -> str:
    """Extract a lowercase host without leading 'www.' from a domain or URL."""
    raw = domain_or_url.strip().lower()
    if not raw:
        return ""
    if "://" not in raw:
        raw = f"https://{raw}"
    host = (urlparse(raw).hostname or "").strip().lower()
    if host.startswith("www."):
        host = host[4:]
    return host


def is_target_domain(result_url: str, target_domain: str) -> bool:
    """Return True if result_url belongs to target_domain or one of its subdomains."""
    target = normalize_domain(target_domain)
    result_host = normalize_domain(result_url)
    if not target or not result_host:
        return False
    return result_host == target or result_host.endswith(f".{target}")

