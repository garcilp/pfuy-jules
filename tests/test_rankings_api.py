import pytest
import sqlite3
import json
from urllib.parse import urlsplit
from scripts.serve_site import Handler
from scripts.rankings_calculator import init_db

class DummyWfile:
    def __init__(self):
        self.data = b""
    def write(self, b):
        self.data += b

class DummyRfile:
    def __init__(self, data=b""):
        self.data = data
    def read(self, length):
        return self.data[:length]

class DummyHandler(Handler):
    def __init__(self, method="GET", path="/", body=None, headers=None):
        self.command = method
        self.path = path
        self.headers = headers or {}
        self.rfile = DummyRfile(json.dumps(body).encode("utf-8") if body else b"")
        self.wfile = DummyWfile()
        self.status = None
        self.response_headers = {}

    def send_response(self, code, message=None):
        self.status = code

    def send_header(self, keyword, value):
        self.response_headers[keyword] = value

    def end_headers(self):
        pass

def test_api_power_ranking_save_and_retrieve(tmp_path, monkeypatch):
    db_path = str(tmp_path / "platfighters.sqlite3")
    init_db(db_path)

    # Ensure participants table exists for group by test query
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE IF NOT EXISTS participants (id INTEGER PRIMARY KEY, player_id TEXT, gamer_tag TEXT)")
    conn.commit()
    conn.close()

    monkeypatch.setattr("scripts.serve_site.DATABASE", db_path)

    # Save a power ranking
    save_body = {
        "title": "Test PR 2025",
        "subtitle": "Season 1",
        "game_slug": "ultimate",
        "status": "published",
        "introduction": "Intro test",
        "entries": [
            {"assigned_position": 1, "canonical_player_id": "1001", "written_analysis": "Number 1"}
        ]
    }

    handler = DummyHandler("POST", "/api/admin/power-ranking/save", body=save_body, headers={"X-Admin-Request": "1"})
    # Mock require_admin to return True
    monkeypatch.setattr(handler, "require_admin", lambda: True)

    handler.handle_admin_power_ranking_save(save_body)
    assert handler.status == 200
    res_data = json.loads(handler.wfile.data.decode("utf-8"))
    assert res_data["status"] == "ok"

    # Get published power rankings
    get_handler = DummyHandler("GET", "/api/rankings/power?game=ultimate")
    parsed_url = urlsplit("/api/rankings/power?game=ultimate")
    get_handler.handle_get_power_rankings(parsed_url)
    assert get_handler.status == 200
    prs = json.loads(get_handler.wfile.data.decode("utf-8"))["power_rankings"]
    assert len(prs) == 1
    assert prs[0]["title"] == "Test PR 2025"
    assert len(prs[0]["entries"]) == 1
    assert prs[0]["entries"][0]["assigned_position"] == 1
