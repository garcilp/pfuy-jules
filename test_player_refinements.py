import json
import sqlite3
import pytest
from pathlib import Path
from scripts.serve_site import get_player_overlapping_events, profile_entries
from scripts.rankings_calculator import visibility_exclusions
from scripts.build_player_profile import (
    profile_for_player,
    count_events_per_identity,
    identity_ids,
)

def test_get_player_overlapping_events_empty():
    overlaps = get_player_overlapping_events("nonexistent1", "nonexistent2")
    assert overlaps == []

def test_get_player_overlapping_events_mock(tmp_path, monkeypatch):
    db_file = tmp_path / "platfighters.sqlite3"
    con = sqlite3.connect(str(db_file))
    cur = con.cursor()
    cur.execute("CREATE TABLE tournaments (slug TEXT, start_at INTEGER, name TEXT)")
    cur.execute("CREATE TABLE events (id TEXT, tournament_slug TEXT, videogame_slug TEXT, name TEXT)")
    cur.execute("CREATE TABLE entrants (id TEXT, event_id TEXT)")
    cur.execute("CREATE TABLE entrant_participants (entrant_id TEXT, participant_id TEXT)")
    cur.execute("CREATE TABLE participants (id TEXT, player_id TEXT)")

    cur.execute("INSERT INTO tournaments VALUES ('tourney-1', 1600000000, 'Tourney One')")
    cur.execute("INSERT INTO events VALUES ('ev-1', 'tourney-1', 'ultimate', 'Ultimate Singles')")

    cur.execute("INSERT INTO entrants VALUES ('ent-1', 'ev-1')")
    cur.execute("INSERT INTO entrant_participants VALUES ('ent-1', 'part-1')")
    cur.execute("INSERT INTO participants VALUES ('part-1', 'p1')")

    cur.execute("INSERT INTO entrants VALUES ('ent-2', 'ev-1')")
    cur.execute("INSERT INTO entrant_participants VALUES ('ent-2', 'part-2')")
    cur.execute("INSERT INTO participants VALUES ('part-2', 'p2')")

    con.commit()
    con.close()

    monkeypatch.setattr("scripts.serve_site.ROOT", tmp_path.parent)
    data_dir = tmp_path.parent / "startgg-data"
    data_dir.mkdir(exist_ok=True)
    import shutil
    shutil.copy(str(db_file), str(data_dir / "platfighters.sqlite3"))

    overlaps = get_player_overlapping_events("p1", "p2")
    assert len(overlaps) == 1
    assert overlaps[0]["eventId"] == "ev-1"
    assert overlaps[0]["tournamentName"] == "Tourney One"
    assert overlaps[0]["eventName"] == "Ultimate Singles"
    assert overlaps[0]["gameSlug"] == "ultimate"
    assert overlaps[0]["startAt"] == 1600000000

def test_profiles_event_counts_integrity():
    with open("data/profiles/index.json") as f:
        profiles = json.load(f)
    with open("data/profiles/merges.json") as f:
        merges = json.load(f)

    for p in profiles:
        assert p["events"] >= 0
        game_events_sum = sum(g["events"] for g in p.get("games", []))
        assert p["events"] == game_events_sum

def test_rankings_exclusion_active():
    exclusions = visibility_exclusions()
    assert isinstance(exclusions, dict)

def test_game_specific_player_directory_exclusion(tmp_path, monkeypatch):
    """
    Test that a player excluded from Game A does not appear in Game A's directory listings,
    while remaining fully visible and active in Game B.
    """
    exclusions_path = Path("data/profiles/exclusions.json")
    with open(exclusions_path) as f:
        orig_exclusions = f.read()

    try:
        # Exclude player 2915041 (Azrad) from rivals-of-aether
        ex_data = {"events": [], "playerGames": {"2915041": ["rivals-of-aether"]}}
        with open(exclusions_path, "w") as f:
            json.dump(ex_data, f)

        entries = profile_entries(public_only=True)
        azrad = next((e for e in entries if e["playerId"] == "2915041"), None)
        assert azrad is not None

        game_slugs = [g["slug"] for g in azrad["games"]]
        assert "rivals-of-aether" not in game_slugs
        assert "melee" in game_slugs
        assert "ultimate" in game_slugs
    finally:
        with open(exclusions_path, "w") as f:
            f.write(orig_exclusions)

def test_additive_event_counts_merged_profile():
    """
    Test that when profiles are merged, the combined profile inherits the additive
    sum of both profiles' event counts (X + Y) overall and per game.
    """
    con = sqlite3.connect("startgg-data/platfighters.sqlite3")
    con.row_factory = sqlite3.Row

    # Player 2915041 (Azrad) and merged 3456340
    p_ids = identity_ids("2915041", {"3456340": "2915041"})
    assert "2915041" in p_ids and "3456340" in p_ids

    # Count for 2915041 alone
    c_target = count_events_per_identity(con, ["2915041"])
    # Count for 3456340 alone
    c_source = count_events_per_identity(con, ["3456340"])

    assert c_source.get("rivals-of-aether", 0) == 1
    expected_roa = c_target.get("rivals-of-aether", 0) + c_source.get("rivals-of-aether", 0)

    # Combined profile calculation
    profile = profile_for_player(con, "2915041", "Azrad", "azrad-2915041")
    roa_game = next(g for g in profile["games"] if g["slug"] == "rivals-of-aether")

    assert roa_game["events"] == expected_roa
    expected_total = sum(c_target.values()) + sum(c_source.values())
    assert sum(g["events"] for g in profile["games"]) == expected_total

    con.close()
