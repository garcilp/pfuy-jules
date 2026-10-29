import socketserver
import threading
import time
import os
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
import scripts.serve_site as serve_site

os.makedirs("verification", exist_ok=True)

def run():
    PORT = 8089
    server = ThreadingHTTPServer(("127.0.0.1", PORT), serve_site.Handler)
    server_thread = threading.Thread(target=server.serve_forever)
    server_thread.daemon = True
    server_thread.start()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 900})

            # 1. Overview Tab (Side-by-side system comparison)
            page.goto(f"http://127.0.0.1:{PORT}/rankings.html")
            page.wait_for_selector(".comparison-row")
            page.screenshot(path="verification/rankings_overview.png")
            print("Captured rankings_overview.png")

            # 2. Power Rankings Tab (Custom weights & contribution indicators)
            page.click("button[data-system='custom']")
            page.wait_for_selector(".pr-setup-panel")
            page.wait_for_selector(".ranking-row")
            page.screenshot(path="verification/rankings_power_rankings.png")
            print("Captured rankings_power_rankings.png")

            # 2b. Adjust weight slider and verify live UI update
            slider = page.locator(".pr-slider").first
            slider.fill("70")
            page.wait_for_timeout(300)
            page.screenshot(path="verification/rankings_power_rankings_adjusted.png")
            print("Captured rankings_power_rankings_adjusted.png")

            # 3. Glicko-2 Tab
            page.click("button[data-system='glicko2']")
            page.wait_for_selector(".ranking-row")
            page.screenshot(path="verification/rankings_glicko2.png")
            print("Captured rankings_glicko2.png")

            # 3. Quality Wins Tab
            page.click("button[data-system='quality_wins']")
            page.wait_for_selector(".ranking-row")
            page.screenshot(path="verification/rankings_quality_wins.png")
            print("Captured rankings_quality_wins.png")

            # 3b. Quality Wins Diagnostic Modal
            page.click(".diagnostic-btn")
            page.wait_for_selector(".diag-summary")
            page.screenshot(path="verification/rankings_quality_wins_diagnostic.png")
            print("Captured rankings_quality_wins_diagnostic.png")

            # Close modal
            page.click("#modal-close-btn")

            browser.close()
    finally:
        server.shutdown()
        server.server_close()

if __name__ == "__main__":
    run()
