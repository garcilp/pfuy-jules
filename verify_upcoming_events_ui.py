import http.server
import json
import os
import socketserver
import threading
import time
from playwright.sync_api import sync_playwright, expect

os.makedirs("verification", exist_ok=True)

class SilentHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

def run():
    PORT = 8888
    handler = SilentHTTPRequestHandler
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    server_thread = threading.Thread(target=httpd.serve_forever)
    server_thread.daemon = True
    server_thread.start()

    # Backup existing events-index.json
    events_index_path = "data/events-index.json"
    backup_path = "data/events-index.json.bak"
    if os.path.exists(events_index_path):
        os.rename(events_index_path, backup_path)

    try:
        # Create mock events-index.json with upcoming and past events
        mock_events = [
            {
                "id": "1001",
                "tournamentSlug": "future-regular-championship",
                "gameSlug": "rivals-of-aether",
                "game": "Rivals of Aether",
                "tournament": "Future Charrúa Championship 2027",
                "event": "Singles",
                "date": "2027-11-15",
                "entrants": 32,
                "url": "https://www.start.gg/tournament/future-regular-championship/event/singles",
                "isTemporary": False,
                "hasTakenPlace": False
            },
            {
                "id": "1002",
                "tournamentSlug": "future-temporary-bracket",
                "gameSlug": "rivals-2",
                "game": "Rivals 2",
                "tournament": "Temporary Weekly #99",
                "event": "Singles",
                "date": "2027-11-20",
                "entrants": 16,
                "url": "https://www.start.gg/tournament/future-temporary-bracket/event/singles",
                "isTemporary": True,
                "hasTakenPlace": False
            },
            {
                "id": "1003",
                "tournamentSlug": "past-regular-monthly",
                "gameSlug": "rivals-of-aether",
                "game": "Rivals of Aether",
                "tournament": "Montevideo Melee Monthly #50",
                "event": "Singles",
                "date": "2024-05-10",
                "entrants": 40,
                "url": "https://www.start.gg/tournament/past-regular-monthly/event/singles",
                "isTemporary": False,
                "hasTakenPlace": True
            }
        ]

        with open(events_index_path, "w", encoding="utf-8") as f:
            json.dump(mock_events, f)

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            page.goto(f"http://127.0.0.1:{PORT}/events.html")

            page.wait_for_selector("#upcoming-events-section")

            # Check that Upcoming events section is visible
            upcoming_section = page.locator("#upcoming-events-section")
            expect(upcoming_section).to_be_visible()
            expect(upcoming_section.locator("h2")).to_have_text("Upcoming events")

            # Check upcoming events
            upcoming_list = page.locator("#upcoming-event-list")
            expect(upcoming_list.locator(".event-card", has_text="Future Charrúa Championship 2027")).to_be_visible()
            expect(upcoming_list.locator(".event-card", has_text="Temporary Weekly #99")).to_be_visible()

            # Check past event history
            past_list = page.locator("#event-list")
            expect(past_list.locator(".event-card", has_text="Montevideo Melee Monthly #50")).to_be_visible()
            expect(past_list.locator(".event-card", has_text="Temporary Weekly #99")).not_to_be_visible()

            page.screenshot(path="verification/upcoming_events.png")
            print("Playwright UI verification screenshot saved.")
            browser.close()

    finally:
        httpd.shutdown()
        if os.path.exists(backup_path):
            os.rename(backup_path, events_index_path)

if __name__ == "__main__":
    run()
