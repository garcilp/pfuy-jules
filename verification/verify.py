from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 960})
        page.goto('http://127.0.0.1:8000/rankings.html')
        page.wait_for_selector('#comparison-table-body')
        page.wait_for_timeout(1000)
        page.screenshot(path='./verification/rankings_preview.png')
        browser.close()

if __name__ == '__main__':
    run()
