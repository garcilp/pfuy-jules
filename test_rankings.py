"""Tests for Platfighters.uy Rankings Engine."""

import json
import sqlite3
import pytest
from scripts.rankings_calculator import (
    calculate_rankings,
    load_sets_for_game,
    load_merges,
    load_exclusions,
    DATABASE,
)


def test_game_isolation():
    """Verify that calculations for one game do not mix or leak into another game."""
    with sqlite3.connect(DATABASE) as conn:
        conn.row_factory = sqlite3.Row
        merges = load_merges()
        exclusions = load_exclusions()

        ultimate_sets = load_sets_for_game(conn, "ultimate", merges, exclusions)
        melee_sets = load_sets_for_game(conn, "melee", merges, exclusions)

        # Set IDs must be disjoint between games
        ultimate_ids = {s["setId"] for s in ultimate_sets}
        melee_ids = {s["setId"] for s in melee_sets}
        assert ultimate_ids.isdisjoint(melee_ids)

        # Calculate rankings for ultimate and melee
        u_res = calculate_rankings("ultimate", "trueskill", "historical")
        m_res = calculate_rankings("melee", "trueskill", "historical")

        u_players = {p["playerId"] for p in u_res["leaderboard"]}
        m_players = {p["playerId"] for p in m_res["leaderboard"]}

        # All ultimate players should have active sets in ultimate_sets
        u_set_players = {s["winner"] for s in ultimate_sets} | {s["loser"] for s in ultimate_sets}
        assert u_players.issubset(u_set_players)


def test_ranking_systems_execution():
    """Verify that all four systems compute valid non-empty leaderboards and audit logs."""
    for system in ("trueskill", "glicko2", "placings", "sof"):
        res = calculate_rankings("ultimate", system, "historical")
        assert res["system"] == system
        assert len(res["leaderboard"]) > 0
        assert len(res["auditTrail"]) > 0

        # Check ranking order (descending score)
        scores = [item["score"] for item in res["leaderboard"]]
        assert scores == sorted(scores, reverse=True)


def test_calculation_modes():
    """Verify Historical, Period-only, and Period performance calculation modes."""
    start_date = "2023-01-01"
    end_date = "2023-12-31"

    hist = calculate_rankings("ultimate", "trueskill", "historical", start_date, end_date)
    p_only = calculate_rankings("ultimate", "trueskill", "period_only", start_date, end_date)
    p_perf = calculate_rankings("ultimate", "trueskill", "period_performance", start_date, end_date)

    assert hist["mode"] == "historical"
    assert p_only["mode"] == "period_only"
    assert p_perf["mode"] == "period_performance"

    # Period-only and period performance should only list players with active sets in that period
    assert len(p_only["leaderboard"]) <= len(hist["leaderboard"])


def test_sof_preevent_ratings():
    """Verify Strength of Field uses pre-event ratings (ratings before the event)."""
    res = calculate_rankings("ultimate", "sof", "historical")
    audit = res["auditTrail"]
    assert len(audit) > 0

    # Ensure preEventRating field exists in audit log
    for entry in audit:
        assert "preEventRating" in entry
        assert "fieldStrength" in entry


def test_player_merges_and_exclusions():
    """Verify player identity merges and exclusions are applied."""
    merges = load_merges()
    exclusions = load_exclusions()

    res = calculate_rankings("ultimate", "trueskill", "historical")
    p_ids = {p["playerId"] for p in res["leaderboard"]}

    # Merged source IDs should not appear as independent leaderboard entries
    for source in merges.keys():
        assert source not in p_ids
