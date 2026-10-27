import pytest
import sqlite3
import os
import json
from scripts.rankings_calculator import (
    TrueSkillEngine,
    Glicko2Engine,
    calculate_statistical_rankings,
    init_db
)

def test_trueskill_engine_winner_increases_mu():
    engine = TrueSkillEngine()
    (mu1, sig1), (mu2, sig2) = engine.update_match((25.0, 8.333), (25.0, 8.333), 1.0)
    assert mu1 > 25.0
    assert mu2 < 25.0
    assert sig1 < 8.333
    assert sig2 < 8.333

def test_glicko2_engine_winner_increases_rating():
    engine = Glicko2Engine()
    r_w, rd_w, vol_w = engine.update_rating((1500.0, 350.0, 0.06), [(1500.0, 350.0, 1.0)])
    r_l, rd_l, vol_l = engine.update_rating((1500.0, 350.0, 0.06), [(1500.0, 350.0, 0.0)])
    assert r_w > 1500.0
    assert r_l < 1500.0
    assert rd_w < 350.0
    assert rd_l < 350.0

def test_database_rankings_calculation(tmp_path):
    db_file = str(tmp_path / "test.sqlite3")
    init_db(db_file)

    conn = sqlite3.connect(db_file)
    cur = conn.cursor()

    # Create source schema tables
    cur.execute("CREATE TABLE IF NOT EXISTS videogames (slug TEXT PRIMARY KEY, name TEXT)")
    cur.execute("CREATE TABLE IF NOT EXISTS tournaments (slug TEXT PRIMARY KEY, name TEXT, start_at INTEGER)")
    cur.execute("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, tournament_slug TEXT, videogame_slug TEXT, name TEXT, source_url TEXT, num_entrants INTEGER)")
    cur.execute("CREATE TABLE IF NOT EXISTS participants (id INTEGER PRIMARY KEY, player_id TEXT, gamer_tag TEXT)")
    cur.execute("CREATE TABLE IF NOT EXISTS entrants (id INTEGER PRIMARY KEY, event_id INTEGER, name TEXT)")
    cur.execute("CREATE TABLE IF NOT EXISTS entrant_participants (entrant_id INTEGER, participant_id INTEGER)")
    cur.execute("CREATE TABLE IF NOT EXISTS sets (id INTEGER PRIMARY KEY, event_id INTEGER, winner_entrant_id INTEGER)")
    cur.execute("CREATE TABLE IF NOT EXISTS set_entrants (set_id INTEGER, entrant_id INTEGER)")
    cur.execute("CREATE TABLE IF NOT EXISTS event_standings (event_id INTEGER, entrant_id INTEGER, placement INTEGER)")

    # Insert sample videogame, tournament, event, entrants, and sets
    cur.execute("INSERT INTO videogames (slug, name) VALUES ('ultimate', 'Super Smash Bros. Ultimate')")
    cur.execute("INSERT INTO tournaments (slug, name, start_at) VALUES ('tourney1', 'Tournament 1', 1736505600)") # 2025-01-10 unix timestamp
    cur.execute("INSERT INTO events (id, tournament_slug, videogame_slug, name, source_url, num_entrants) VALUES (1, 'tourney1', 'ultimate', 'Singles', 'http://test', 8)")

    cur.execute("INSERT INTO participants (id, player_id, gamer_tag) VALUES (101, '1001', 'PlayerOne')")
    cur.execute("INSERT INTO participants (id, player_id, gamer_tag) VALUES (102, '1002', 'PlayerTwo')")

    cur.execute("INSERT INTO entrants (id, event_id, name) VALUES (1, 1, 'PlayerOne')")
    cur.execute("INSERT INTO entrants (id, event_id, name) VALUES (2, 1, 'PlayerTwo')")

    cur.execute("INSERT INTO entrant_participants (entrant_id, participant_id) VALUES (1, 101)")
    cur.execute("INSERT INTO entrant_participants (entrant_id, participant_id) VALUES (2, 102)")

    cur.execute("INSERT INTO sets (id, event_id, winner_entrant_id) VALUES (50, 1, 1)")
    cur.execute("INSERT INTO set_entrants (set_id, entrant_id) VALUES (50, 1)")
    cur.execute("INSERT INTO set_entrants (set_id, entrant_id) VALUES (50, 2)")

    cur.execute("INSERT INTO event_standings (event_id, entrant_id, placement) VALUES (1, 1, 1)")
    cur.execute("INSERT INTO event_standings (event_id, entrant_id, placement) VALUES (1, 2, 2)")

    conn.commit()
    conn.close()

    res = calculate_statistical_rankings(db_file, game_slug='ultimate')
    assert len(res) == 2
    p1 = res['1001']
    p2 = res['1002']

    # Winner should have higher TrueSkill conservative score
    assert p1['trueskill']['conservative'] > p2['trueskill']['conservative']
    assert p1['glicko2']['conservative'] > p2['glicko2']['conservative']
    assert p1['placings']['points'] > p2['placings']['points']


def test_player_merges_data_integrity(tmp_path):
    db_file = str(tmp_path / "test_merge.sqlite3")
    init_db(db_file)

    conn = sqlite3.connect(db_file)
    cur = conn.cursor()

    cur.execute("CREATE TABLE IF NOT EXISTS videogames (slug TEXT PRIMARY KEY, name TEXT)")
    cur.execute("CREATE TABLE IF NOT EXISTS tournaments (slug TEXT PRIMARY KEY, name TEXT, start_at INTEGER)")
    cur.execute("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, tournament_slug TEXT, videogame_slug TEXT, name TEXT, source_url TEXT, num_entrants INTEGER)")
    cur.execute("CREATE TABLE IF NOT EXISTS participants (id INTEGER PRIMARY KEY, player_id TEXT, gamer_tag TEXT)")
    cur.execute("CREATE TABLE IF NOT EXISTS entrants (id INTEGER PRIMARY KEY, event_id INTEGER, name TEXT)")
    cur.execute("CREATE TABLE IF NOT EXISTS entrant_participants (entrant_id INTEGER, participant_id INTEGER)")
    cur.execute("CREATE TABLE IF NOT EXISTS sets (id INTEGER PRIMARY KEY, event_id INTEGER, winner_entrant_id INTEGER)")
    cur.execute("CREATE TABLE IF NOT EXISTS set_entrants (set_id INTEGER, entrant_id INTEGER)")
    cur.execute("CREATE TABLE IF NOT EXISTS event_standings (event_id INTEGER, entrant_id INTEGER, placement INTEGER)")

    cur.execute("INSERT INTO videogames (slug, name) VALUES ('ultimate', 'Super Smash Bros. Ultimate')")
    cur.execute("INSERT INTO tournaments (slug, name, start_at) VALUES ('tourney1', 'Tournament 1', 1736505600)")
    cur.execute("INSERT INTO events (id, tournament_slug, videogame_slug, name, source_url, num_entrants) VALUES (1, 'tourney1', 'ultimate', 'Singles', 'http://test', 8)")

    # 1001 is merged into 1002 in merges.json
    cur.execute("INSERT INTO participants (id, player_id, gamer_tag) VALUES (101, '1001', 'OldTag')")
    cur.execute("INSERT INTO participants (id, player_id, gamer_tag) VALUES (102, '1002', 'CanonicalTag')")
    cur.execute("INSERT INTO participants (id, player_id, gamer_tag) VALUES (103, '1003', 'OpponentTag')")

    cur.execute("INSERT INTO entrants (id, event_id, name) VALUES (1, 1, 'OldTag')")
    cur.execute("INSERT INTO entrants (id, event_id, name) VALUES (2, 1, 'OpponentTag')")

    cur.execute("INSERT INTO entrant_participants (entrant_id, participant_id) VALUES (1, 101)")
    cur.execute("INSERT INTO entrant_participants (entrant_id, participant_id) VALUES (2, 103)")

    cur.execute("INSERT INTO sets (id, event_id, winner_entrant_id) VALUES (50, 1, 1)")
    cur.execute("INSERT INTO set_entrants (set_id, entrant_id) VALUES (50, 1)")
    cur.execute("INSERT INTO set_entrants (set_id, entrant_id) VALUES (50, 2)")

    cur.execute("INSERT INTO event_standings (event_id, entrant_id, placement) VALUES (1, 1, 1)")
    cur.execute("INSERT INTO event_standings (event_id, entrant_id, placement) VALUES (1, 2, 2)")

    conn.commit()
    conn.close()

    # Pass player_merges mapping
    merges = {"1001": "1002"}
    res = calculate_statistical_rankings(db_file, game_slug='ultimate', player_merges=merges)

    # 1001 should be remapped to 1002, so 1001 is not a key in res, but 1002 is
    assert '1001' not in res
    assert '1002' in res
    assert res['1002']['tag'] == 'CanonicalTag'
    assert res['1002']['matches_count'] == 1
