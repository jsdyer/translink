"""Exercise the built sheet at a project subpath in Chromium."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import tempfile
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    screenshots = ROOT / "browser-checks"
    screenshots.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        shutil.copytree(ROOT / "dist", Path(temporary) / "translink")
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=temporary))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                page = browser.new_page(viewport={"width": 1280, "height": 1000})
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(f"http://127.0.0.1:{server.server_port}/translink/")
                page.locator("#finding").wait_for()
                page.wait_for_function("document.querySelector('#finding').textContent !== 'Loading saved captures.'")
                page.locator("#route").fill("99")
                page.wait_for_function("document.querySelector('#finding').textContent.includes('99')")
                page.locator("#route").fill("410")
                page.wait_for_function("document.querySelector('#finding').textContent.includes('410')")
                page.locator("#route").fill('<img src=x onerror="alert(1)">')
                page.wait_for_function("document.querySelector('#finding').textContent.includes('No saved route')")
                assert page.locator("img").count() == 0
                assert "<img" not in page.locator("#finding").inner_text()
                page.locator("#route").fill("99")
                page.screenshot(path=str(screenshots / "desktop.png"), full_page=True)
                page.set_viewport_size({"width": 390, "height": 844})
                assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
                page.screenshot(path=str(screenshots / "mobile.png"), full_page=True)
                assert not errors, errors
                browser.close()
            print("Browser checks passed: project subpath, route lookup, safe text and mobile layout")
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
