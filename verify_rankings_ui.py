import http.server
import socketserver
import threading
import time
import os
from playwright.sync_api import sync_playwright

os.makedirs("verification", exist_ok=True)

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

def run():
    PORT = 8089
    server = socketserver.TCPServer(("127.0.0.1", PORT), QuietHandler)
    server_thread = threading.Thread(target=server.serve_forever)
    server_thread.daemon = True
    server_thread.start()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 900})

            # 1. Overview Tab
            page.goto(f"http://127.0.0.1:{PORT}/rankings.html")
            page.wait_for_selector(".overview-system-card")
            page.screenshot(path="verification/rankings_overview.png")
            print("Captured rankings_overview.png")

            # 2. Glicko-2 Tab
            page.click("button[data-system='glicko2']")
            page.wait_for_selector(".ranking-row")
            page.screenshot(path="verification/rankings_glicko2.png")
            print("Captured rankings_glicko2.png")

            # 3. Quality Wins Tab
            page.click("button[data-system='quality_wins']")
            page.wait_for_selector(".ranking-row")
            page.screenshot(path="verification/rankings_quality_wins.png")
            print("Captured rankings_quality_wins.png")

            # 4. Comparison Tab
            page.click("button[data-system='comparison']")
            page.wait_for_selector(".comparison-row")
            page.screenshot(path="verification/rankings_comparison.png")
            print("Captured rankings_comparison.png")

            browser.close()
    finally:
        server.shutdown()
        server.server_close()

if __name__ == "__main__":
    run()
