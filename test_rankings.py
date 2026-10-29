import os
import json
import sqlite3
import threading
import urllib.request
from http.server import ThreadingHTTPServer
import pytest

from scripts.rankings_calculator import (
    RankingEngine,
    Glicko2Calculator,
    canonical_id,
    identity_merges,
    visibility_exclusions,
)
import scripts.serve_site as serve_site

@pytest.fixture
def mock_db():
    """Creates an in-memory SQLite DB with standard schema and sample match/event data."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.executescript("""
        CREATE TABLE videogames (
            id INTEGER PRIMARY KEY,
            slug TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL
        );
        CREATE TABLE tournaments (
            slug TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            start_at INTEGER
        );
        CREATE TABLE events (
            id TEXT PRIMARY KEY,
            videogame_slug TEXT NOT NULL,
            tournament_slug TEXT NOT NULL,
            name TEXT NOT NULL,
            source_url TEXT,
            is_temporary INTEGER DEFAULT 0,
            num_entrants INTEGER DEFAULT 0
        );
        CREATE TABLE entrants (
            id TEXT PRIMARY KEY,
            event_id TEXT NOT NULL
        );
        CREATE TABLE phases (
            id TEXT PRIMARY KEY,
            phase_order INTEGER,
            name TEXT
        );
        CREATE TABLE phase_groups (
            id TEXT PRIMARY KEY,
            phase_id TEXT
        );
        CREATE TABLE sets (
            id TEXT PRIMARY KEY,
            event_id TEXT NOT NULL,
            winner_entrant_id TEXT,
            display_score TEXT,
            started_at INTEGER,
            start_at INTEGER,
            completed_at INTEGER,
            phase_group_id TEXT,
            round INTEGER
        );
        CREATE TABLE set_entrants (
            set_id TEXT NOT NULL,
            entrant_id TEXT NOT NULL,
            score_display TEXT,
            score_label TEXT,
            score TEXT
        );
        CREATE TABLE entrant_participants (
            entrant_id TEXT NOT NULL,
            participant_id TEXT NOT NULL
        );
        CREATE TABLE participants (
            id TEXT PRIMARY KEY,
            player_id TEXT,
            gamer_tag TEXT
        );
        CREATE TABLE event_standings (
            event_id TEXT NOT NULL,
            entrant_id TEXT NOT NULL,
            placement INTEGER
        );
    """)

    # Populate videogames
    cursor.execute("INSERT INTO videogames VALUES (1, 'ultimate', 'Super Smash Bros. Ultimate')")
    cursor.execute("INSERT INTO videogames VALUES (2, 'sf6', 'Street Fighter 6')")

    # Tournaments
    cursor.execute("INSERT INTO tournaments VALUES ('tourney-1', 'Smash Monthly 1', 1704883200)")
    cursor.execute("INSERT INTO tournaments VALUES ('tourney-2', 'Smash Monthly 2', 1707561600)")
    cursor.execute("INSERT INTO tournaments VALUES ('tourney-3', 'SF6 Monthly 1', 1705315200)")

    # Events
    cursor.execute("INSERT INTO events VALUES ('e101', 'ultimate', 'tourney-1', 'Singles', 'https://start.gg/tournament/tourney-1/event/singles', 0, 8)")
    cursor.execute("INSERT INTO events VALUES ('e102', 'ultimate', 'tourney-2', 'Singles', 'https://start.gg/tournament/tourney-2/event/singles', 0, 16)")
    cursor.execute("INSERT INTO events VALUES ('e201', 'sf6', 'tourney-3', 'Singles', 'https://start.gg/tournament/tourney-3/event/singles', 0, 4)")

    # Participants & Entrants for Event 101 (Ultimate)
    for p_id, tag in [(101, 'PlayerOne'), (102, 'PlayerTwo'), (103, 'PlayerThree'), (104, 'PlayerFour')]:
        cursor.execute("INSERT INTO participants VALUES (?, ?, ?)", (f"part_{p_id}", str(p_id), tag))
        cursor.execute("INSERT INTO entrants VALUES (?, ?)", (f"ent_{p_id}_e101", 'e101'))
        cursor.execute("INSERT INTO entrant_participants VALUES (?, ?)", (f"ent_{p_id}_e101", f"part_{p_id}"))

    # Event 101 Sets
    cursor.execute("INSERT INTO sets VALUES ('s1', 'e101', 'ent_101_e101', '2 - 0', 1704883300, 1704883300, 1704883300, NULL, 1)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s1', 'ent_101_e101', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s1', 'ent_102_e101', '0', '0', '0')")

    cursor.execute("INSERT INTO sets VALUES ('s2', 'e101', 'ent_103_e101', '2 - 1', 1704883400, 1704883400, 1704883400, NULL, 1)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s2', 'ent_103_e101', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s2', 'ent_104_e101', '1', '1', '1')")

    cursor.execute("INSERT INTO sets VALUES ('s3', 'e101', 'ent_101_e101', '2 - 0', 1704883500, 1704883500, 1704883500, NULL, 2)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s3', 'ent_101_e101', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s3', 'ent_103_e101', '0', '0', '0')")

    # Set 4 (DQ - should be ignored): display_score 'DQ'
    cursor.execute("INSERT INTO sets VALUES ('s4', 'e101', 'ent_102_e101', 'DQ', 1704883600, 1704883600, 1704883600, NULL, -1)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s4', 'ent_102_e101', 'DQ', 'DQ', 'DQ')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s4', 'ent_104_e101', '-1', '-1', '-1')")

    # Standings for Event 101
    cursor.execute("INSERT INTO event_standings VALUES ('e101', 'ent_101_e101', 1)")
    cursor.execute("INSERT INTO event_standings VALUES ('e101', 'ent_103_e101', 2)")
    cursor.execute("INSERT INTO event_standings VALUES ('e101', 'ent_102_e101', 3)")
    cursor.execute("INSERT INTO event_standings VALUES ('e101', 'ent_104_e101', 4)")

    # Event 102 (Feb 10, 2024): Player 102 beats Player 101 (2 - 1)
    for p_id in [101, 102]:
        cursor.execute("INSERT INTO entrants VALUES (?, ?)", (f"ent_{p_id}_e102", 'e102'))
        cursor.execute("INSERT INTO entrant_participants VALUES (?, ?)", (f"ent_{p_id}_e102", f"part_{p_id}"))

    cursor.execute("INSERT INTO sets VALUES ('s5', 'e102', 'ent_102_e102', '2 - 1', 1707561700, 1707561700, 1707561700, NULL, 1)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s5', 'ent_102_e102', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s5', 'ent_101_e102', '1', '1', '1')")

    cursor.execute("INSERT INTO event_standings VALUES ('e102', 'ent_102_e102', 1)")
    cursor.execute("INSERT INTO event_standings VALUES ('e102', 'ent_101_e102', 2)")

    # Event 201 (SF6): Player 201 beats Player 202
    for p_id, tag in [(201, 'SF6Winner'), (202, 'SF6Loser')]:
        cursor.execute("INSERT INTO participants VALUES (?, ?, ?)", (f"part_{p_id}", str(p_id), tag))
        cursor.execute("INSERT INTO entrants VALUES (?, ?)", (f"ent_{p_id}_e201", 'e201'))
        cursor.execute("INSERT INTO entrant_participants VALUES (?, ?)", (f"ent_{p_id}_e201", f"part_{p_id}"))

    cursor.execute("INSERT INTO sets VALUES ('s6', 'e201', 'ent_201_e201', '2 - 0', 1705315300, 1705315300, 1705315300, NULL, 1)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s6', 'ent_201_e201', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s6', 'ent_202_e201', '0', '0', '0')")

    cursor.execute("INSERT INTO event_standings VALUES ('e201', 'ent_201_e201', 1)")
    cursor.execute("INSERT INTO event_standings VALUES ('e201', 'ent_202_e201', 2)")

    conn.commit()
    engine = RankingEngine(connection=conn)
    yield conn, engine
    conn.close()

def test_glicko2_math():
    g2 = Glicko2Calculator()
    init = g2.initial_rating()
    assert init["r"] == 1500.0
    assert init["rd"] == 350.0

    # Win 1 match against equal player
    updated = g2.update_period(1500.0, 350.0, 0.06, [(1500.0, 350.0, 1.0)])
    assert updated["r"] > 1500.0
    assert updated["rd"] < 350.0

def test_game_isolation(mock_db):
    conn, engine = mock_db
    res_smash = engine.calculate(game_slug="ultimate", system="glicko2")
    res_sf6 = engine.calculate(game_slug="sf6", system="glicko2")

    smash_ids = {p["playerId"] for p in res_smash["rankings"]}
    sf6_ids = {p["playerId"] for p in res_sf6["rankings"]}

    assert smash_ids == {"101", "102", "103", "104"}
    assert sf6_ids == {"201", "202"}
    assert smash_ids.isdisjoint(sf6_ids)

def test_dq_matches_filtered(mock_db):
    conn, engine = mock_db
    res = engine.calculate(game_slug="ultimate", system="glicko2")
    p101 = next(p for p in res["rankings"] if p["playerId"] == "101")
    assert p101["matches"] == 3
    assert p101["wins"] == 2
    assert p101["losses"] == 1

def test_calculation_modes(mock_db):
    conn, engine = mock_db

    # Range covering Feb 1 - Feb 28, 2024 (contains Event e102)
    res_hist = engine.calculate("ultimate", system="glicko2", mode="historical", start_date="2024-02-01", end_date="2024-02-28")
    p101_hist = next(p for p in res_hist["rankings"] if p["playerId"] == "101")
    assert p101_hist["matches"] == 3

    res_po = engine.calculate("ultimate", system="glicko2", mode="period_only", start_date="2024-02-01", end_date="2024-02-28")
    p101_po = next(p for p in res_po["rankings"] if p["playerId"] == "101")
    assert p101_po["matches"] == 1
    assert p101_po["losses"] == 1

    res_pp = engine.calculate("ultimate", system="glicko2", mode="period_performance", start_date="2024-02-01", end_date="2024-02-28")
    p101_pp = next(p for p in res_pp["rankings"] if p["playerId"] == "101")
    assert p101_pp["matches"] == 1
    assert p101_pp["baselineScore"] > 0

def test_sof_incorporates_placements_and_field_strength(mock_db):
    conn, engine = mock_db
    res_sof = engine.calculate("ultimate", system="sof")
    assert res_sof["system"] == "sof"
    assert len(res_sof["rankings"]) > 0
    # Winner of e101 (101) should rank higher than early exit (104)
    p101 = next(p for p in res_sof["rankings"] if p["playerId"] == "101")
    p104 = next(p for p in res_sof["rankings"] if p["playerId"] == "104")
    assert p101["score"] > p104["score"]

def test_quality_wins_system(mock_db):
    conn, engine = mock_db
    res_qw = engine.calculate("ultimate", system="quality_wins")
    assert res_qw["system"] == "quality_wins"
    p101 = next(p for p in res_qw["rankings"] if p["playerId"] == "101")
    p102 = next(p for p in res_qw["rankings"] if p["playerId"] == "102")
    assert p101["wins"] == 2
    assert p101["totalQualityWins"] > 0
    assert p101["score"] == p101["avgQualityWin"]
    assert p101["isProvisional"] is True
    # Player 102 defeated higher-rated Player 101, earning higher average win quality
    assert p102["score"] > p101["score"]
    assert p102["rank"] == 1
    assert p101["rank"] == 2

def test_quality_wins_average_formula_and_ranking_order(mock_db):
    conn, engine = mock_db
    res_qw = engine.calculate("ultimate", system="quality_wins")
    rankings = res_qw["rankings"]
    ranked_players = [p for p in rankings if not p["isUnranked"]]

    # Verify ranking order is strictly descending by score (Average Quality per Win)
    for i in range(len(ranked_players) - 1):
        assert ranked_players[i]["score"] >= ranked_players[i + 1]["score"]
        assert ranked_players[i]["rank"] == i + 1

    # Verify formula correctness: score == round(totalQualityWins / wins, 3)
    for p in ranked_players:
        expected_avg = round(p["totalQualityWins"] / p["wins"], 3)
        assert p["score"] == expected_avg
        assert p["avgQualityWin"] == expected_avg

def test_quality_wins_zero_wins_and_provisional():
    """Test dedicated scenarios for small samples, zero wins, and ranking order."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.executescript("""
        CREATE TABLE videogames (id INTEGER PRIMARY KEY, slug TEXT UNIQUE, name TEXT);
        CREATE TABLE tournaments (slug TEXT PRIMARY KEY, name TEXT, start_at INTEGER);
        CREATE TABLE events (id TEXT PRIMARY KEY, videogame_slug TEXT, tournament_slug TEXT, name TEXT, source_url TEXT, is_temporary INTEGER DEFAULT 0, num_entrants INTEGER);
        CREATE TABLE entrants (id TEXT PRIMARY KEY, event_id TEXT);
        CREATE TABLE phases (id TEXT PRIMARY KEY, phase_order INTEGER, name TEXT);
        CREATE TABLE phase_groups (id TEXT PRIMARY KEY, phase_id TEXT);
        CREATE TABLE sets (id TEXT PRIMARY KEY, event_id TEXT, winner_entrant_id TEXT, display_score TEXT, started_at INTEGER, start_at INTEGER, completed_at INTEGER, phase_group_id TEXT, round INTEGER);
        CREATE TABLE set_entrants (set_id TEXT, entrant_id TEXT, score_display TEXT, score_label TEXT, score TEXT);
        CREATE TABLE entrant_participants (entrant_id TEXT, participant_id TEXT);
        CREATE TABLE participants (id TEXT PRIMARY KEY, player_id TEXT, gamer_tag TEXT);
        CREATE TABLE event_standings (event_id TEXT, entrant_id TEXT, placement INTEGER);
    """)

    cursor.execute("INSERT INTO videogames VALUES (1, 'ultimate', 'Super Smash Bros. Ultimate')")
    cursor.execute("INSERT INTO tournaments VALUES ('t1', 'Tournament 1', 1700000000)")
    cursor.execute("INSERT INTO events VALUES ('e1', 'ultimate', 't1', 'Singles', 'https://start.gg/tournament/t1/event/singles', 0, 4)")

    # P1 (1 big win), P2 (5 easy wins, but lower average quality), P3 (0 wins, 2 losses)
    players = [(1, 'ProvisionalPlayer'), (2, 'VeteranPlayer'), (3, 'ZeroWinPlayer'), (4, 'Opponent')]
    for pid, tag in players:
        cursor.execute("INSERT INTO participants VALUES (?, ?, ?)", (f"part_{pid}", str(pid), tag))
        cursor.execute("INSERT INTO entrants VALUES (?, ?)", (f"ent_{pid}_e1", 'e1'))
        cursor.execute("INSERT INTO entrant_participants VALUES (?, ?)", (f"ent_{pid}_e1", f"part_{pid}"))

    # P1 beats P4 (Win 1)
    cursor.execute("INSERT INTO sets VALUES ('s1', 'e1', 'ent_1_e1', '2-0', 1700000100, 1700000100, 1700000100, NULL, 1)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s1', 'ent_1_e1', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s1', 'ent_4_e1', '0', '0', '0')")

    # P2 beats P4 in 3 sets
    for set_num in range(2, 5):
        s_id = f"s{set_num}"
        cursor.execute("INSERT INTO sets VALUES (?, 'e1', 'ent_2_e1', '2-0', ?, ?, ?, NULL, ?)", (s_id, 1700000100 + set_num*100, 1700000100 + set_num*100, 1700000100 + set_num*100, set_num))
        cursor.execute("INSERT INTO set_entrants VALUES (?, 'ent_2_e1', '2', '2', '2')", (s_id,))
        cursor.execute("INSERT INTO set_entrants VALUES (?, 'ent_4_e1', '0', '0', '0')", (s_id,))

    # P3 loses to P4 twice (0 wins)
    for set_num in range(5, 7):
        s_id = f"s{set_num}"
        cursor.execute("INSERT INTO sets VALUES (?, 'e1', 'ent_4_e1', '2-0', ?, ?, ?, NULL, ?)", (s_id, 1700000100 + set_num*100, 1700000100 + set_num*100, 1700000100 + set_num*100, set_num))
        cursor.execute("INSERT INTO set_entrants VALUES (?, 'ent_4_e1', '2', '2', '2')", (s_id,))
        cursor.execute("INSERT INTO set_entrants VALUES (?, 'ent_3_e1', '0', '0', '0')", (s_id,))

    conn.commit()
    engine = RankingEngine(connection=conn)

    res = engine.calculate("ultimate", system="quality_wins")
    p1 = next(p for p in res["rankings"] if p["playerId"] == "1")
    p2 = next(p for p in res["rankings"] if p["playerId"] == "2")
    p3 = next(p for p in res["rankings"] if p["playerId"] == "3")

    # P1 has 1 win (< 3), so isProvisional is True
    assert p1["isProvisional"] is True
    assert p1["wins"] == 1

    # P2 has 3 wins (>= 3), so isProvisional is False
    assert p2["isProvisional"] is False
    assert p2["wins"] == 3

    # P3 has 0 wins, so isUnranked is True, rank is None
    assert p3["isUnranked"] is True
    assert p3["rank"] is None
    assert p3["score"] == 0.0

    conn.close()

def test_loss_quality_consistency_system(mock_db):
    conn, engine = mock_db
    res_lq = engine.calculate("ultimate", system="loss_quality")
    assert res_lq["system"] == "loss_quality"

    # Player 101 (2-1) vs Player 104 (0-1)
    p101 = next(p for p in res_lq["rankings"] if p["playerId"] == "101")
    p104 = next(p for p in res_lq["rankings"] if p["playerId"] == "104")
    assert p101["score"] > p104["score"]

def test_merges_and_canonical_id():
    merges = {"2002": "1001", "3003": "2002"}
    assert canonical_id("3003", merges) == "1001"
    assert canonical_id("2002", merges) == "1001"
    assert canonical_id("1001", merges) == "1001"

@pytest.fixture
def http_server():
    """Starts serve_site.Handler on port 8999 for endpoint testing."""
    server = ThreadingHTTPServer(("127.0.0.1", 8999), serve_site.Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.daemon = True
    thread.start()
    yield "http://127.0.0.1:8999"
    server.shutdown()
    server.server_close()

def test_invalid_date_range_raises_valueerror(mock_db):
    conn, engine = mock_db
    with pytest.raises(ValueError, match="Start date must be before or on end date"):
        engine.calculate("ultimate", system="glicko2", start_date="2024-03-01", end_date="2024-02-01")

def test_diagnostic_all_systems_and_reconciliation(mock_db):
    conn, engine = mock_db
    systems = ["glicko2", "sof", "quality_wins", "loss_quality"]

    for sys in systems:
        res = engine.calculate("ultimate", system=sys, mode="historical")
        assert len(res["rankings"]) > 0
        top_player = res["rankings"][0]
        pid = top_player["playerId"]

        diag_res = engine.calculate("ultimate", system=sys, target_player_id=pid, mode="historical")
        diag = diag_res["diagnostic"]

        # Calculation context check
        context = diag["context"]
        assert context["playerId"] == pid
        assert context["canonicalPlayerId"] == pid
        assert context["gameSlug"] == "ultimate"
        assert context["system"] == sys
        assert context["mode"] == "historical"

        # Reconciliation: final score and rank must match leaderboard
        assert round(context["finalScore"], 2) == round(top_player["score"], 2)
        assert context["rank"] == top_player["rank"]

        # Evidence check
        evidence = diag["evidence"]
        assert "tournaments" in evidence
        assert "matches" in evidence

        # Algorithm parameters and breakdown check
        assert "algorithmParameters" in diag
        assert "breakdown" in diag

def test_diagnostic_merged_player_lookup(mock_db):
    conn, engine = mock_db
    # Pass custom merges into ranking engine
    engine.merges = {"alias_p101": "101"}

    # Request diagnostic using alias ID
    diag_res = engine.calculate("ultimate", system="glicko2", target_player_id="alias_p101")
    context = diag_res["diagnostic"]["context"]
    assert context["playerId"] == "alias_p101"
    assert context["canonicalPlayerId"] == "101"
    assert context["totalResultsConsidered"] > 0

def test_server_api_endpoints_and_errors(http_server):
    # GET /api/games
    req = urllib.request.urlopen(f"{http_server}/api/games")
    assert req.status == 200
    games_data = json.loads(req.read().decode("utf-8"))
    assert "games" in games_data

    # GET /api/rankings
    req = urllib.request.urlopen(f"{http_server}/api/rankings?game=ultimate&system=glicko2")
    assert req.status == 200
    rankings_data = json.loads(req.read().decode("utf-8"))
    assert rankings_data["gameSlug"] == "ultimate"
    assert rankings_data["system"] == "glicko2"
    assert "rankings" in rankings_data

    # Test invalid date range error 400
    try:
        urllib.request.urlopen(f"{http_server}/api/rankings?game=ultimate&system=glicko2&start_date=2024-05-01&end_date=2024-01-01")
        assert False, "Should have raised HTTPError 400"
    except urllib.error.HTTPError as err:
        assert err.code == 400
        error_payload = json.loads(err.read().decode("utf-8"))
        assert "error" in error_payload
        assert "Start date must be before or on end date" in error_payload["error"]

    # GET /api/rankings/diagnostic
    if rankings_data["rankings"]:
        pid = rankings_data["rankings"][0]["playerId"]
        req = urllib.request.urlopen(f"{http_server}/api/rankings/diagnostic?game=ultimate&system=glicko2&player_id={pid}")
        assert req.status == 200
        diag_data = json.loads(req.read().decode("utf-8"))
        assert "diagnostic" in diag_data
        context = diag_data["diagnostic"]["context"]
        assert context["playerId"] == pid
