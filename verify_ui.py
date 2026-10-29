import os
from playwright.sync_api import sync_playwright, expect

os.makedirs("verification", exist_ok=True)

import threading
from http.server import ThreadingHTTPServer
import scripts.serve_site as serve_site

def run():
    PORT = 8088
    server = ThreadingHTTPServer(("127.0.0.1", PORT), serve_site.Handler)
    server_thread = threading.Thread(target=server.serve_forever)
    server_thread.daemon = True
    server_thread.start()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            page.goto(f"http://127.0.0.1:{PORT}/index.html#overview")
        page.wait_for_selector(".tile-opponent")

        opponent_tile = page.locator(".tile-opponent")
        expect(opponent_tile).to_be_visible()

        link = opponent_tile.locator("a.opponent-link")
        expect(link).to_be_visible()

        page.screenshot(path="verification/verification.png")
        print("Frontend verification screenshot saved to verification/verification.png.")
        browser.close()
    finally:
        server.shutdown()
        server.server_close()

if __name__ == "__main__":
    run()
