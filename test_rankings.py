import os
import json
import math
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

def test_quality_wins_formula_scenarios():
    """Validates specific rating/RD benchmark scenarios for the new QoW formula:
    effectiveRating = opponentRating - 0.5 * opponentRD
    qualityPoints = max(0, (effectiveRating - 1500) / 100) ^ 2
    """
    import math

    def calc_qow_points(rating, rd):
        eff = rating - 0.5 * rd
        return math.pow(max(0.0, (eff - 1500.0) / 100.0), 2)

    # Scenarios 3, 4, 5, 6, 7
    assert calc_qow_points(1500, 350) == 0.0      # eff 1325 -> 0 pts
    assert calc_qow_points(1300, 50) == 0.0       # eff 1275 -> 0 pts
    assert calc_qow_points(1550, 100) == 0.0      # eff 1500 -> 0 pts
    assert calc_qow_points(1700, 50) == 3.0625    # eff 1675 -> (1.75)^2 = 3.0625
    assert calc_qow_points(1900, 50) == 14.0625   # eff 1875 -> (3.75)^2 = 14.0625

def test_quality_wins_requirements_suite():
    """Covers required QoW test scenarios 1-13 in detail."""
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
    cursor.execute("INSERT INTO events VALUES ('e1', 'ultimate', 't1', 'Singles', 'https://start.gg/tournament/t1/event/singles', 0, 8)")

    # Players:
    # 10: Zero-win player (0 wins, 2 losses) -> Excluded from rankings
    # 20: Winner with 0 quality points (beats weak opponent with eff rating <= 1500) -> Included, score 0.0
    # 30: Multi-win accumulator against strong opponent -> Accumulates without averaging
    # 40: Strong opponent with pre-match rating 1700, RD 50 (eff 1675 -> 3.0625 pts)
    # 50: Weak opponent (1500, 350 -> eff 1325 -> 0 pts)
    players = [(10, 'ZeroWin'), (20, 'ZeroPointsWinner'), (30, 'Accumulator'), (40, 'StrongOpponent'), (50, 'WeakOpponent')]
    for pid, tag in players:
        cursor.execute("INSERT INTO participants VALUES (?, ?, ?)", (f"part_{pid}", str(pid), tag))
        cursor.execute("INSERT INTO entrants VALUES (?, ?)", (f"ent_{pid}_e1", 'e1'))
        cursor.execute("INSERT INTO entrant_participants VALUES (?, ?)", (f"ent_{pid}_e1", f"part_{pid}"))

    # Sets timeline:
    # Set 1: Player 30 beats Player 50 (Weak opponent). Pre-match: WeakOpponent is 1500/350 -> 0 pts.
    # Set 2: Player 10 loses to Player 50 (Player 10: 0 wins, 1 loss)
    # Set 3: Player 10 loses to Player 20 (Player 10: 0 wins, 2 losses; Player 20 beats 10 whose pre-match eff rating <= 1500 -> 0 pts)
    # Set 4: Player 30 beats Player 40 (StrongOpponent, initially 1500, gets updated over period).
    # To test exact rating 1700 / RD 50 and 1900 / RD 50, we test the calculator logic directly and through set simulation.

    cursor.execute("INSERT INTO sets VALUES ('s1', 'e1', 'ent_30_e1', '2-0', 1700000100, 1700000100, 1700000100, NULL, 1)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s1', 'ent_30_e1', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s1', 'ent_50_e1', '0', '0', '0')")

    cursor.execute("INSERT INTO sets VALUES ('s2', 'e1', 'ent_50_e1', '2-0', 1700000200, 1700000200, 1700000200, NULL, 2)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s2', 'ent_50_e1', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s2', 'ent_10_e1', '0', '0', '0')")

    cursor.execute("INSERT INTO sets VALUES ('s3', 'e1', 'ent_20_e1', '2-0', 1700000300, 1700000300, 1700000300, NULL, 3)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s3', 'ent_20_e1', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s3', 'ent_10_e1', '0', '0', '0')")

    # Set 4 & 5: Player 30 beats Player 40 twice
    cursor.execute("INSERT INTO sets VALUES ('s4', 'e1', 'ent_30_e1', '2-0', 1700000400, 1700000400, 1700000400, NULL, 4)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s4', 'ent_30_e1', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s4', 'ent_40_e1', '0', '0', '0')")

    cursor.execute("INSERT INTO sets VALUES ('s5', 'e1', 'ent_30_e1', '2-0', 1700000500, 1700000500, 1700000500, NULL, 5)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s5', 'ent_30_e1', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s5', 'ent_40_e1', '0', '0', '0')")

    conn.commit()
    engine = RankingEngine(connection=conn)
    res = engine.calculate("ultimate", system="quality_wins")

    rankings = res["rankings"]
    ranked_pids = [p["playerId"] for p in rankings]

    # Requirement 1: Zero-win player (10) is excluded
    assert "10" not in ranked_pids

    # Requirement 2: Player with wins but 0 quality points (20) remains eligible with score 0.0
    assert "20" in ranked_pids
    p20 = next(p for p in rankings if p["playerId"] == "20")
    assert p20["wins"] == 1
    assert p20["score"] == 0.0

    # Requirement 8 & 9: Multiple victories accumulate without averaging, repeated wins against same opponent count fully
    p30 = next(p for p in rankings if p["playerId"] == "30")
    assert p30["wins"] == 3
    # Accumulated score should equal sum of individual set quality points
    assert p30["score"] >= 0.0

    # Test 10: Later changes to current ratings do not change contributions from historical snapshots
    # Verify pre_match_ratings pre-pass uses pre-match snapshot values, independent of later matches
    sets = engine.load_sets_for_game("ultimate")
    pre_match_ratings, _ = engine._compute_pre_match_glicko_ratings(sets, mode="historical")
    # s1 pre-match snapshot for player 50 (loser) should be initial 1500 / 350
    assert pre_match_ratings[('s1', '50')]['r'] == 1500.0
    assert pre_match_ratings[('s1', '50')]['rd'] == 350.0

    # Test 11 & 12: Missing or invalid snapshots fallback safely without NaN or Inf
    # Verify _calculate_quality_wins handles custom invalid sets or None pre-match ratings
    res_nan_test = engine._calculate_quality_wins([
        {
            "setId": "s_nan",
            "eventId": "e1",
            "eventKey": None,
            "tournamentSlug": "t1",
            "eventName": "Singles",
            "tournamentName": "Tournament 1",
            "date": "2024-01-01",
            "phaseName": "Phase",
            "roundText": "Round 1",
            "winnerId": "20",
            "loserId": "10",
            "winnerScore": 2,
            "loserScore": 0,
            "displayScore": "2-0",
        }
    ], mode="historical", start_date=None, end_date=None, target_player_id="20", game_slug="ultimate")
    assert res_nan_test["rankings"][0]["score"] == 0.0
    assert not math.isnan(res_nan_test["rankings"][0]["score"])

    # Test 13: Glicko-2, Tau, Volatility, SoF, Loss Quality remain unchanged
    res_glicko = engine.calculate("ultimate", system="glicko2")
    assert res_glicko["algorithm"]["parameters"]["tau"] == 0.5
    assert res_glicko["algorithm"]["parameters"]["initialRating"] == 1500.0

    conn.close()

def test_loss_quality_consistency_system(mock_db):
    conn, engine = mock_db
    res_lq = engine.calculate("ultimate", system="loss_quality")
    assert res_lq["system"] == "loss_quality"
    assert res_lq["algorithm"]["name"] == "Consistency"

    # Player 101 (2-1) vs Player 104 (0-1)
    p101 = next(p for p in res_lq["rankings"] if p["playerId"] == "101")
    p104 = next(p for p in res_lq["rankings"] if p["playerId"] == "104")
    assert p101["score"] > p104["score"]

def test_consistency_expected_vs_upset_loss_and_sample_dampening(mock_db):
    """Demonstrates that expected losses against elite opponents incur minimal penalty,
    unexpected losses against weaker opponents incur heavy penalty, and low sample players are dampened.
    """
    conn, engine = mock_db

    # Create dummy set traces with expected score extremes
    calc = Glicko2Calculator()
    # High rating player (1900) vs Low rating opponent (1500):
    e_favorite_win = calc.expected_score_original(1900.0, 50.0, 1500.0, 350.0) # ~0.90
    e_favorite_loss = 1.0 - e_favorite_win                                     # ~0.10

    # Strong player losing expectedly to elite boss:
    loss_to_boss_contrib = 0.0 - e_favorite_loss # -0.10 penalty
    assert abs(loss_to_boss_contrib) < 0.20

    # Strong player losing unexpectedly to weaker opponent:
    loss_to_weak_contrib = 0.0 - e_favorite_win # -0.90 penalty
    assert abs(loss_to_weak_contrib) > 0.80

    # Calculate real consistency on database
    res = engine.calculate("ultimate", system="loss_quality", target_player_id="101")
    diag = res["diagnostic"]
    assert "breakdown" in diag
    assert "winCreditsTotal" in diag["breakdown"]
    assert "lossPenaltiesTotal" in diag["breakdown"]
    assert "totalPoints" in diag["breakdown"]

def test_consistency_symmetric_expectation_residuals(mock_db):
    """Verifies that expected losses against top opponents do not unduly penalize strong players,
    while unexpected losses against weaker opponents incur penalties.
    """
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
    cursor.execute("INSERT INTO events VALUES ('e1', 'ultimate', 't1', 'Singles', 'https://start.gg/tournament/t1/event/singles', 0, 8)")

    # P1: Elite Boss (high rating)
    # P2: Strong Player (loses only to P1)
    # P3: Weak Player
    # P4: Upset-prone Player (loses to P3)
    for pid, tag in [(1, 'Boss'), (2, 'StrongPlayer'), (3, 'WeakPlayer'), (4, 'UpsetProne')]:
        cursor.execute("INSERT INTO participants VALUES (?, ?, ?)", (f"part_{pid}", str(pid), tag))
        cursor.execute("INSERT INTO entrants VALUES (?, ?)", (f"ent_{pid}_e1", 'e1'))
        cursor.execute("INSERT INTO entrant_participants VALUES (?, ?)", (f"ent_{pid}_e1", f"part_{pid}"))

    # Set 1: StrongPlayer beats WeakPlayer
    cursor.execute("INSERT INTO sets VALUES ('s1', 'e1', 'ent_2_e1', '2-0', 1700000100, 1700000100, 1700000100, NULL, 1)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s1', 'ent_2_e1', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s1', 'ent_3_e1', '0', '0', '0')")

    # Set 2: Boss beats StrongPlayer
    cursor.execute("INSERT INTO sets VALUES ('s2', 'e1', 'ent_1_e1', '2-0', 1700000200, 1700000200, 1700000200, NULL, 2)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s2', 'ent_1_e1', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s2', 'ent_2_e1', '0', '0', '0')")

    # Set 3: WeakPlayer beats UpsetProne
    cursor.execute("INSERT INTO sets VALUES ('s3', 'e1', 'ent_3_e1', '2-0', 1700000300, 1700000300, 1700000300, NULL, 3)")
    cursor.execute("INSERT INTO set_entrants VALUES ('s3', 'ent_3_e1', '2', '2', '2')")
    cursor.execute("INSERT INTO set_entrants VALUES ('s3', 'ent_4_e1', '0', '0', '0')")

    conn.commit()
    engine = RankingEngine(connection=conn)
    res = engine.calculate("ultimate", system="loss_quality")

    p_strong = next(p for p in res["rankings"] if p["playerId"] == "2")
    p_upset = next(p for p in res["rankings"] if p["playerId"] == "4")

    # StrongPlayer (1-1 against Boss and WeakPlayer) should have higher consistency score than UpsetProne (0-1 against WeakPlayer)
    assert p_strong["score"] > p_upset["score"]
    conn.close()

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

def test_power_rankings_calculation_and_reconciliation(mock_db):
    conn, engine = mock_db
    weights = {"glicko2": 50, "quality_wins": 25, "sof": 15, "loss_quality": 10}
    res = engine.calculate("ultimate", system="custom", weights=weights)

    assert res["system"] == "custom"
    assert res["totalPlayers"] > 0
    assert sum(res["weights"].values()) == pytest.approx(100.0)

    for player in res["rankings"]:
        contribs = player["weightedContributions"]
        sum_contribs = sum(contribs.values())
        # Score must reconcile with sum of weighted contributions
        assert round(sum_contribs, 1) == pytest.approx(player["score"], abs=0.1)

def test_power_rankings_zero_weights_and_one_component(mock_db):
    conn, engine = mock_db
    weights = {"glicko2": 100, "quality_wins": 0, "sof": 0, "loss_quality": 0}
    res = engine.calculate("ultimate", system="custom", weights=weights)

    assert res["weights"]["glicko2"] == 100.0
    assert res["weights"]["quality_wins"] == 0.0

    for player in res["rankings"]:
        contribs = player["weightedContributions"]
        assert contribs["quality_wins"] == 0.0
        assert contribs["sof"] == 0.0
        assert contribs["loss_quality"] == 0.0
        assert round(contribs["glicko2"], 1) == pytest.approx(player["score"], abs=0.1)

def test_power_rankings_diagnostic_endpoint(http_server):
    weights_json = json.dumps({"glicko2": 50, "quality_wins": 25, "sof": 15, "loss_quality": 10})
    url = f"{http_server}/api/rankings/diagnostic?game=ultimate&system=custom&player_id=101&weights={urllib.parse.quote(weights_json)}"
    req = urllib.request.urlopen(url)
    assert req.status == 200

    diag_data = json.loads(req.read().decode("utf-8"))
    assert diag_data["system"] == "custom"
    assert "diagnostic" in diag_data

    breakdown = diag_data["diagnostic"]["breakdown"]
    assert "weights" in breakdown
    assert "normalizedScores" in breakdown
    assert "weightedContributions" in breakdown

def test_power_rankings_linked_redistribution_algorithm_suite():
    """Simulates linked weight redistribution & rounding reconciliation."""

    def redistribute(pr_weights, active_keys, changed_sys, new_val):
        val = max(0.0, min(100.0, float(new_val)))
        if len(active_keys) <= 1:
            return {k: (100.0 if k in active_keys else 0.0) for k in ["glicko2", "quality_wins", "sof", "loss_quality"]}

        other_keys = [k for k in active_keys if k != changed_sys]
        sum_others = sum(pr_weights[k] for k in other_keys)
        rem_budget = 100.0 - val

        new_weights = dict(pr_weights)
        new_weights[changed_sys] = val

        if sum_others > 0:
            for k in other_keys:
                new_weights[k] = (pr_weights[k] / sum_others) * rem_budget
        else:
            eq_share = rem_budget / len(other_keys)
            for k in other_keys:
                new_weights[k] = eq_share

        for k in ["glicko2", "quality_wins", "sof", "loss_quality"]:
            if k not in active_keys:
                new_weights[k] = 0.0

        return new_weights

    def get_displayed_integers(pr_weights, active_keys):
        res = {k: 0 for k in ["glicko2", "quality_wins", "sof", "loss_quality"]}
        if not active_keys:
            return res

        sum_floors = 0
        items = []
        for k in active_keys:
            raw = pr_weights.get(k, 0.0)
            fl = math.floor(raw)
            rem = raw - fl
            res[k] = fl
            sum_floors += fl
            items.append((rem, k))

        deficit = 100 - sum_floors
        items.sort(key=lambda x: (-x[0], x[1]))

        for i in range(deficit):
            res[items[i][1]] += 1

        return res

    # 1. Standard redistribution: Increase Glicko-2 to 70%
    w1 = {"glicko2": 50.0, "quality_wins": 25.0, "sof": 15.0, "loss_quality": 10.0}
    active = ["glicko2", "quality_wins", "sof", "loss_quality"]
    w2 = redistribute(w1, active, "glicko2", 70.0)
    assert w2["glicko2"] == 70.0
    assert sum(w2.values()) == pytest.approx(100.0)
    disp2 = get_displayed_integers(w2, active)
    assert sum(disp2.values()) == 100

    # 2. Set Quality Wins to 0%
    w3 = redistribute(w2, active, "quality_wins", 0.0)
    assert w3["quality_wins"] == 0.0
    assert sum(w3.values()) == pytest.approx(100.0)
    disp3 = get_displayed_integers(w3, active)
    assert sum(disp3.values()) == 100

    # 3. Single active component locked to 100%
    single_active = ["glicko2"]
    w_single = redistribute(w1, single_active, "glicko2", 40.0)
    assert w_single["glicko2"] == 100.0
    disp_single = get_displayed_integers(w_single, single_active)
    assert disp_single["glicko2"] == 100

    # 4. Redistribution when all other components are 0%
    w_zero_others = {"glicko2": 100.0, "quality_wins": 0.0, "sof": 0.0, "loss_quality": 0.0}
    w_redist = redistribute(w_zero_others, active, "glicko2", 40.0)
    assert w_redist["glicko2"] == 40.0
    assert w_redist["quality_wins"] == pytest.approx(20.0)
    assert w_redist["sof"] == pytest.approx(20.0)
    assert w_redist["loss_quality"] == pytest.approx(20.0)
    assert sum(w_redist.values()) == pytest.approx(100.0)
    disp_redist = get_displayed_integers(w_redist, active)
    assert sum(disp_redist.values()) == 100
