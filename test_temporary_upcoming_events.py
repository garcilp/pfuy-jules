"""Unit and integration test for temporary and upcoming events."""

import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent

def test_pipeline_and_db():
    print("Testing pipeline and DB logic...")
    db_path = PROJECT_ROOT / "startgg-data" / "platfighters.sqlite3"
    assert db_path.exists(), "Database must exist for testing"

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # Verify is_temporary column exists
    columns = [row["name"] for row in conn.execute("PRAGMA table_info(events)").fetchall()]
    assert "is_temporary" in columns, "is_temporary column missing in events table"

    # Insert mock temporary and upcoming events
    now_ts = int(datetime.now(timezone.utc).timestamp())
    future_ts = now_ts + 86400 * 10
    past_ts = now_ts - 86400 * 10

    # Ensure mock videogames and tournaments exist
    conn.execute("INSERT OR IGNORE INTO videogames(slug, name) VALUES ('test-game', 'Test Game')")
    conn.execute("INSERT OR REPLACE INTO tournaments(slug, startgg_id, name, start_at) VALUES ('test-future-tourney', '999901', 'Future Tourney', ?)", (future_ts,))
    conn.execute("INSERT OR REPLACE INTO tournaments(slug, startgg_id, name, start_at) VALUES ('test-past-tourney', '999902', 'Past Tourney', ?)", (past_ts,))

    # Event 1: Future regular event
    conn.execute(
        "INSERT OR REPLACE INTO events(id, tournament_slug, videogame_slug, name, num_entrants, source_url, is_temporary) "
        "VALUES ('999901', 'test-future-tourney', 'test-game', 'Singles', 8, 'http://start.gg/tournament/test-future-tourney/event/singles', 0)"
    )
    # Event 2: Future temporary event
    conn.execute(
        "INSERT OR REPLACE INTO events(id, tournament_slug, videogame_slug, name, num_entrants, source_url, is_temporary) "
        "VALUES ('999902', 'test-future-tourney', 'test-game', 'Doubles', 8, 'http://start.gg/tournament/test-future-tourney/event/doubles', 1)"
    )
    # Event 3: Past temporary event
    conn.execute(
        "INSERT OR REPLACE INTO events(id, tournament_slug, videogame_slug, name, num_entrants, source_url, is_temporary) "
        "VALUES ('999903', 'test-past-tourney', 'test-game', 'Singles', 8, 'http://start.gg/tournament/test-past-tourney/event/singles', 1)"
    )
    # Event 4: Past regular event
    conn.execute(
        "INSERT OR REPLACE INTO events(id, tournament_slug, videogame_slug, name, num_entrants, source_url, is_temporary) "
        "VALUES ('999904', 'test-past-tourney', 'test-game', 'Doubles', 8, 'http://start.gg/tournament/test-past-tourney/event/doubles', 0)"
    )

    # Add mock entrant and set for a player in Event 3 (past temporary) and Event 4 (past regular)
    conn.execute("INSERT OR IGNORE INTO players(id) VALUES ('999999')")
    conn.execute("INSERT OR REPLACE INTO participants(id, player_id, gamer_tag) VALUES ('p999', '999999', 'TestPlayer')")

    conn.execute("INSERT OR REPLACE INTO entrants(id, event_id, name) VALUES ('e999_3', '999903', 'TestPlayer')")
    conn.execute("INSERT OR REPLACE INTO entrant_participants(entrant_id, participant_id) VALUES ('e999_3', 'p999')")
    conn.execute("INSERT OR REPLACE INTO event_standings(event_id, entrant_id, placement) VALUES ('999903', 'e999_3', 1)")

    conn.execute("INSERT OR REPLACE INTO entrants(id, event_id, name) VALUES ('e999_4', '999904', 'TestPlayer')")
    conn.execute("INSERT OR REPLACE INTO entrant_participants(entrant_id, participant_id) VALUES ('e999_4', 'p999')")
    conn.execute("INSERT OR REPLACE INTO event_standings(event_id, entrant_id, placement) VALUES ('999904', 'e999_4', 1)")

    # Add mock sets
    conn.execute("INSERT OR REPLACE INTO sets(id, event_id, state, winner_entrant_id, display_score) VALUES ('s3', '999903', 3, 'e999_3', '2-0')")
    conn.execute("INSERT OR REPLACE INTO set_entrants(set_id, slot_id, slot_order, entrant_id, score_display) VALUES ('s3', 'slot1', 0, 'e999_3', '2')")

    conn.execute("INSERT OR REPLACE INTO sets(id, event_id, state, winner_entrant_id, display_score) VALUES ('s4', '999904', 3, 'e999_4', '2-0')")
    conn.execute("INSERT OR REPLACE INTO set_entrants(set_id, slot_id, slot_order, entrant_id, score_display) VALUES ('s4', 'slot2', 0, 'e999_4', '2')")

    conn.commit()

    # Rebuild event index
    subprocess.run([sys.executable, "scripts/build_player_profile.py", "--events-only"], check=True)

    with open("data/events-index.json", encoding="utf-8") as f:
        events_index = json.load(f)

    event_ids = {e["id"]: e for e in events_index}

    # Verify Event 1 (Future regular) is present, hasNotTakenPlace
    assert "999901" in event_ids, "Event 1 (Future regular) missing from index"
    assert event_ids["999901"]["hasTakenPlace"] is False, "Event 1 should be upcoming"
    assert event_ids["999901"]["isTemporary"] is False, "Event 1 should not be temporary"

    # Verify Event 2 (Future temporary) is present, hasNotTakenPlace
    assert "999902" in event_ids, "Event 2 (Future temporary) missing from index"
    assert event_ids["999902"]["hasTakenPlace"] is False, "Event 2 should be upcoming"
    assert event_ids["999902"]["isTemporary"] is True, "Event 2 should be temporary"

    # Verify Event 3 (Past temporary) is EXCLUDED from event history index
    assert "999903" not in event_ids, "Event 3 (Past temporary) must be excluded from event history index"

    # Verify Event 4 (Past regular) is present, hasTakenPlace
    assert "999904" in event_ids, "Event 4 (Past regular) should be in event history"
    assert event_ids["999904"]["hasTakenPlace"] is True, "Event 4 should be marked as hasTakenPlace"

    # Build profile for player 999999
    subprocess.run([sys.executable, "scripts/build_player_profile.py", "999999", "--tag", "TestPlayer", "--slug", "testplayer-999999"], check=True)
    with open("data/profiles/testplayer-999999.json", encoding="utf-8") as f:
        profile = json.load(f)

    # Check profile results: event 3 (past temporary) must NOT be present, event 4 (past regular) MUST be present
    game_data = next((g for g in profile["games"] if g["id"] == "test-game"), None)
    assert game_data is not None, "Test game missing from profile"
    results = game_data["results"]
    event_keys_in_profile = [r.get("eventKey") for r in results]

    assert "tournament/test-past-tourney/event/singles" not in event_keys_in_profile, "Temporary event must not show up in player profile"
    assert "tournament/test-past-tourney/event/doubles" in event_keys_in_profile, "Regular past event must show up in player profile"

    # Clean up test DB entries
    conn.execute("DELETE FROM sets WHERE id IN ('s3', 's4')")
    conn.execute("DELETE FROM set_entrants WHERE set_id IN ('s3', 's4')")
    conn.execute("DELETE FROM event_standings WHERE event_id IN ('999901', '999902', '999903', '999904')")
    conn.execute("DELETE FROM entrant_participants WHERE entrant_id IN ('e999_3', 'e999_4')")
    conn.execute("DELETE FROM entrants WHERE id IN ('e999_3', 'e999_4')")
    conn.execute("DELETE FROM participants WHERE id = 'p999'")
    conn.execute("DELETE FROM players WHERE id = '999999'")
    conn.execute("DELETE FROM events WHERE id IN ('999901', '999902', '999903', '999904')")
    conn.execute("DELETE FROM tournaments WHERE slug IN ('test-future-tourney', 'test-past-tourney')")
    conn.execute("DELETE FROM videogames WHERE slug = 'test-game'")
    conn.commit()
    conn.close()

    # Rebuild event index back to clean state
    subprocess.run([sys.executable, "scripts/build_player_profile.py", "--events-only"], check=True)
    if os.path.exists("data/profiles/testplayer-999999.json"):
        os.remove("data/profiles/testplayer-999999.json")
    if os.path.exists("data/profiles/testplayer.json"):
        os.remove("data/profiles/testplayer.json")

    print("Pipeline and DB logic tests passed successfully!")

if __name__ == "__main__":
    test_pipeline_and_db()
