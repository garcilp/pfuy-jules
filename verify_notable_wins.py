import os
from playwright.sync_api import sync_playwright, expect

os.makedirs("verification", exist_ok=True)

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto("http://127.0.0.1:8080/index.html#r2")
        page.wait_for_selector(".win")

        novakite_win = page.locator(".win", has_text="NovaKite")
        expect(novakite_win).to_be_visible()
        expect(novakite_win).to_contain_text("2 times")
        expect(novakite_win).to_contain_text("Latest: Fall Open")
        expect(novakite_win).to_contain_text("September 2026")

        brickwall_win = page.locator(".win", has_text="Brickwall")
        expect(brickwall_win).to_be_visible()
        expect(brickwall_win).to_contain_text("Basement Brawl 14")
        expect(brickwall_win).to_contain_text("October 2026")

        page.screenshot(path="verification/verification.png")
        print("Playwright verification screenshot saved.")
        browser.close()

if __name__ == "__main__":
    run()
