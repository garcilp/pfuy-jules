import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1280, "height": 900})
        await page.goto("http://localhost:8000/players.html")
        await page.wait_for_selector(".player-card")
        await page.screenshot(path="verification/verification.png")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
