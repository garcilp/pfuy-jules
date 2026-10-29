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

            # Verify default weights (55/20/15/10)
            glicko_badge = page.locator(".pr-card-badge[data-sys='glicko2']").text_content()
            qw_badge = page.locator(".pr-card-badge[data-sys='quality_wins']").text_content()
            sof_badge = page.locator(".pr-card-badge[data-sys='sof']").text_content()
            lq_badge = page.locator(".pr-card-badge[data-sys='loss_quality']").text_content()
            print(f"Default weights verified: Glicko-2={glicko_badge}, Quality Wins={qw_badge}, SOF={sof_badge}, Consistency={lq_badge}")
            assert glicko_badge == "55%"
            assert qw_badge == "20%"
            assert sof_badge == "15%"
            assert lq_badge == "10%"

            page.screenshot(path="verification/rankings_power_rankings.png")
            print("Captured rankings_power_rankings.png")

            # 2b. Test smooth slider dragging (input) vs deferred commit (change)
            slider = page.locator("input.pr-slider[data-sys='glicko2']")
            slider.evaluate("el => { el.value = '70'; el.dispatchEvent(new Event('input', { bubbles: true })); }")
            page.wait_for_timeout(100)

            # Visual badge should update live during input drag
            live_badge = page.locator(".pr-card-badge[data-sys='glicko2']").text_content()
            assert live_badge == "70%"

            # Trigger commit (change / drag release)
            slider.evaluate("el => { el.dispatchEvent(new Event('change', { bubbles: true })); }")
            page.wait_for_timeout(300)
            page.screenshot(path="verification/rankings_power_rankings_adjusted.png")
            print("Captured rankings_power_rankings_adjusted.png")

            # Test reset to defaults
            reset_btn = page.locator("button:has-text('Reset to Defaults')")
            reset_btn.click()
            page.wait_for_timeout(200)
            reset_glicko = page.locator(".pr-card-badge[data-sys='glicko2']").text_content()
            assert reset_glicko == "55%"

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
