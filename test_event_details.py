"""Unit and integration test suite for Event Page Data Generation."""

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
DATABASE = PROJECT_ROOT / "startgg-data" / "platfighters.sqlite3"
EVENTS_DIR = PROJECT_ROOT / "data" / "events"


def test_event_details_generation():
    assert DATABASE.exists(), "Database platfighters.sqlite3 required for testing"

    # Run build_player_profile.py --events-only
    subprocess.run([sys.executable, "scripts/build_player_profile.py", "--events-only"], check=True)

    assert EVENTS_DIR.is_dir(), "data/events directory must exist after building events"

    # Test 1: Check mashito-go-6 details
    mg6_file = EVENTS_DIR / "mashito-go-6.json"
    assert mg6_file.exists(), "data/events/mashito-go-6.json must exist"

    with mg6_file.open(encoding="utf-8") as f:
        data = json.load(f)

    assert data.get("tournamentSlug") == "mashito-go-6"
    assert "Mashito GO!" in data.get("tournament", "")
    assert data.get("startggUrl") == "https://www.start.gg/tournament/mashito-go-6"
    assert isinstance(data.get("totalEntrants"), int) and data.get("totalEntrants") > 0
    assert len(data.get("games", [])) >= 1
    assert data["games"][0]["slug"] == "ultimate"

    sub_events = data.get("subEvents", [])
    assert len(sub_events) >= 2, f"mashito-go-6 must have at least 2 sub-events, got {len(sub_events)}"

    main_event = next((se for se in sub_events if not se.get("isAmateur")), None)
    amateur_event = next((se for se in sub_events if se.get("isAmateur")), None)

    assert main_event is not None, "mashito-go-6 must have a main event"
    assert main_event.get("title") == "Main event", f"Main event title must be 'Main event', got {main_event.get('title')}"
    assert len(main_event.get("standings", [])) <= 8 and len(main_event.get("standings", [])) > 0

    top_player = main_event["standings"][0]
    assert top_player.get("placement") == 1
    assert "tag" in top_player
    if top_player.get("character"):
        assert "stockIcon" in top_player["character"]
        assert top_player["character"]["stockIcon"].startswith("assets/renders/ultimate/stocks/")

    assert amateur_event is not None, "mashito-go-6 must have an amateur bracket"
    assert amateur_event.get("title") == "Categoria B", f"Amateur bracket title must be 'Categoria B', got {amateur_event.get('title')}"

    # Test 2: Check ultimate-smashdown-17 details (which has a Bracket B phase)
    us17_file = EVENTS_DIR / "ultimate-smashdown-17.json"
    assert us17_file.exists(), "data/events/ultimate-smashdown-17.json must exist"

    with us17_file.open(encoding="utf-8") as f:
        us17_data = json.load(f)

    us17_subs = us17_data.get("subEvents", [])
    us17_main = next((se for se in us17_subs if not se.get("isAmateur")), None)
    us17_amateur = next((se for se in us17_subs if se.get("isAmateur")), None)

    assert us17_main is not None, "ultimate-smashdown-17 must have a main event"
    assert us17_main.get("title") == "Main event"
    assert us17_amateur is not None, "ultimate-smashdown-17 must have a Bracket B amateur bracket"
    assert us17_amateur.get("title") == "Categoria B"


if __name__ == "__main__":
    test_event_details_generation()
    print("All event details tests passed!")
