"""Local Playwright Chromium smoke test for Phase 1 environment verification."""

from playwright.sync_api import sync_playwright


def test_local_chromium_smoke() -> None:
    """Verify Playwright can launch Chromium and render local HTML content."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.set_content(
                """
                <!doctype html>
                <html>
                  <head><title>Digital Minds Smoke Test</title></head>
                  <body><h1 id="status">Playwright Chromium Ready</h1></body>
                </html>
                """
            )
            assert page.title() == "Digital Minds Smoke Test"
            assert page.locator("#status").inner_text() == "Playwright Chromium Ready"
        finally:
            browser.close()

