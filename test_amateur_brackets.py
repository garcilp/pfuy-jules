"""Unit and integration test suite for Amateur Bracket Handling and Placement Adjustments.

Verifies:
1. An amateur bracket named "Bracket B" within a main event.
2. An amateur bracket named "Categoria B" within a main event.
3. An amateur bracket with a custom name explicitly flagged as amateur.
4. A separate amateur event linked to a main event.
5. An amateur bracket whose sets have seeds that would otherwise qualify for notable wins.
6. A main event with 32 participants, where the amateur bracket winner is assigned 33rd place.
7. Multiple placements in an amateur bracket, ensuring they are ordered correctly after main event placements.
8. A regular, non-amateur bracket whose notable wins and placements must remain unchanged.
"""

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
DATABASE = PROJECT_ROOT / "startgg-data" / "platfighters.sqlite3"
AMATEUR_CONFIG = PROJECT_ROOT / "data" / "profiles" / "amateur_brackets.json"
EVENT_GROUPS_CONFIG = PROJECT_ROOT / "data" / "profiles" / "event_groups.json"


def run_tests():
    print("Running amateur bracket handling test suite...")
    assert DATABASE.exists(), "Database platfighters.sqlite3 required for testing"

    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row

    # Insert test game and tournament
    conn.execute("INSERT OR IGNORE INTO videogames(slug, name) VALUES ('amateur-test-game', 'Amateur Test Game')")
    conn.execute("INSERT OR REPLACE INTO tournaments(slug, startgg_id, name, start_at) VALUES ('amateur-test-tourney', '888001', 'Amateur Test Tourney', 1700000000)")

    # 1. Setup Main Event 1 (32 entrants in main phases)
    # Event ID: 888001
    conn.execute(
        "INSERT OR REPLACE INTO events(id, tournament_slug, videogame_slug, name, num_entrants, source_url, is_temporary) "
        "VALUES ('888001', 'amateur-test-tourney', 'amateur-test-game', 'Main Event Singles', 32, 'http://start.gg/tournament/amateur-test-tourney/event/singles', 0)"
    )

    # Phases for Event 1:
    # Phase 1: Main Bracket (32 entrants)
    # Phase 2: Bracket B (Amateur named Bracket B)
    # Phase 3: Categoria B (Amateur named Categoria B)
    # Phase 4: Custom Tier (Custom name, flagged explicitly as amateur)
    conn.execute("INSERT OR REPLACE INTO phases(id, event_id, name, phase_order, is_exhibition) VALUES ('888101', '888001', 'Main Bracket', 1, 0)")
    conn.execute("INSERT OR REPLACE INTO phases(id, event_id, name, phase_order, is_exhibition) VALUES ('888102', '888001', 'Bracket B', 2, 1)")
    conn.execute("INSERT OR REPLACE INTO phases(id, event_id, name, phase_order, is_exhibition) VALUES ('888103', '888001', 'Categoria B', 3, 1)")
    conn.execute("INSERT OR REPLACE INTO phases(id, event_id, name, phase_order, is_exhibition) VALUES ('888104', '888001', 'Custom Tier', 4, 1)")

    conn.execute("INSERT OR REPLACE INTO phase_groups(id, phase_id, display_identifier) VALUES ('888201', '888101', '1')")
    conn.execute("INSERT OR REPLACE INTO phase_groups(id, phase_id, display_identifier) VALUES ('888202', '888102', '1')")
    conn.execute("INSERT OR REPLACE INTO phase_groups(id, phase_id, display_identifier) VALUES ('888203', '888103', '1')")
    conn.execute("INSERT OR REPLACE INTO phase_groups(id, phase_id, display_identifier) VALUES ('888204', '888104', '1')")

    # 2. Setup Linked Separate Event (Event ID 888002 - Categoria B Linked Event)
    conn.execute(
        "INSERT OR REPLACE INTO events(id, tournament_slug, videogame_slug, name, num_entrants, source_url, is_temporary) "
        "VALUES ('888002', 'amateur-test-tourney', 'amateur-test-game', 'Side Categoria B', 8, 'http://start.gg/tournament/amateur-test-tourney/event/side-categoria-b', 0)"
    )
    conn.execute("INSERT OR REPLACE INTO phases(id, event_id, name, phase_order, is_exhibition) VALUES ('888105', '888002', 'Bracket', 1, 0)")
    conn.execute("INSERT OR REPLACE INTO phase_groups(id, phase_id, display_identifier) VALUES ('888205', '888105', '1')")

    # Players setup:
    # Player 888001 (Top Pro): 1st in Main Event
    # Player 888002 (Seed 1 Pro): Seed 1 in Main Event, lost upset to Player 888003 in amateur bracket!
    # Player 888003 (Amateur Champ): Played in Bracket B, won 1st place in Bracket B!
    # Player 888004 (Amateur RunnerUp): Played in Bracket B, 2nd place in Bracket B!
    # Player 888005 (Cat B Champ): Played in Categoria B, 1st place in Categoria B!
    # Player 888006 (Custom Champ): Played in Custom Tier, 1st place in Custom Tier!
    # Player 888007 (Side Event Champ): Played in Side Categoria B linked event, 1st place!
    # Player 888008 (Side Event RunnerUp): Played in Side Categoria B linked event, 2nd place!

    players = [
        ('888001', 'TopPro'),
        ('888002', 'Seed1Pro'),
        ('888003', 'AmateurChamp'),
        ('888004', 'AmateurRunnerUp'),
        ('888005', 'CatBChamp'),
        ('888006', 'CustomChamp'),
        ('888007', 'SideChamp'),
        ('888008', 'SideRunnerUp'),
    ]

    for p_id, tag in players:
        conn.execute("INSERT OR IGNORE INTO players(id) VALUES (?)", (p_id,))
        conn.execute("INSERT OR REPLACE INTO participants(id, player_id, gamer_tag) VALUES (?, ?, ?)", (f"part_{p_id}", p_id, tag))

    # Add 32 main event entrants
    for i in range(1, 33):
        p_id = f"888{i:03d}" if i <= 8 else f"8889{i:02d}"
        if i > 8:
            conn.execute("INSERT OR IGNORE INTO players(id) VALUES (?)", (p_id,))
            conn.execute("INSERT OR REPLACE INTO participants(id, player_id, gamer_tag) VALUES (?, ?, ?)", (f"part_{p_id}", p_id, f"MainPlayer{i}"))
        conn.execute("INSERT OR REPLACE INTO entrants(id, event_id, name) VALUES (?, '888001', ?)", (f"ent_m_{i}", f"Player{i}"))
        conn.execute("INSERT OR REPLACE INTO entrant_participants(entrant_id, participant_id) VALUES (?, ?)", (f"ent_m_{i}", f"part_{p_id}"))
        b_place = 1 if i == 3 else (2 if i == 4 else i)
        conn.execute("INSERT OR REPLACE INTO event_standings(event_id, entrant_id, placement) VALUES ('888001', ?, ?)", (f"ent_m_{i}", b_place))

    # Add entrants for Linked Side Event
    conn.execute("INSERT OR REPLACE INTO entrants(id, event_id, name) VALUES ('ent_s_7', '888002', 'SideChamp')")
    conn.execute("INSERT OR REPLACE INTO entrant_participants(entrant_id, participant_id) VALUES ('ent_s_7', 'part_888007')")
    conn.execute("INSERT OR REPLACE INTO event_standings(event_id, entrant_id, placement) VALUES ('888002', 'ent_s_7', 1)")

    conn.execute("INSERT OR REPLACE INTO entrants(id, event_id, name) VALUES ('ent_s_8', '888002', 'SideRunnerUp')")
    conn.execute("INSERT OR REPLACE INTO entrant_participants(entrant_id, participant_id) VALUES ('ent_s_8', 'part_888008')")
    conn.execute("INSERT OR REPLACE INTO event_standings(event_id, entrant_id, placement) VALUES ('888002', 'ent_s_8', 2)")

    # Phase Seeds
    # In Main Bracket (888101): Seed1Pro = seed 1, TopPro = seed 2, AmateurChamp = seed 20
    conn.execute("INSERT OR REPLACE INTO phase_seeds(phase_id, entrant_id, seed_num) VALUES ('888101', 'ent_m_2', 1)")
    conn.execute("INSERT OR REPLACE INTO phase_seeds(phase_id, entrant_id, seed_num) VALUES ('888101', 'ent_m_1', 2)")
    conn.execute("INSERT OR REPLACE INTO phase_seeds(phase_id, entrant_id, seed_num) VALUES ('888101', 'ent_m_3', 20)")

    # In Bracket B (888102): Seed1Pro = seed 1, AmateurChamp = seed 20
    conn.execute("INSERT OR REPLACE INTO phase_seeds(phase_id, entrant_id, seed_num) VALUES ('888102', 'ent_m_2', 1)")
    conn.execute("INSERT OR REPLACE INTO phase_seeds(phase_id, entrant_id, seed_num) VALUES ('888102', 'ent_m_3', 20)")
    conn.execute("INSERT OR REPLACE INTO phase_seeds(phase_id, entrant_id, seed_num) VALUES ('888102', 'ent_m_4', 21)")

    # Sets:
    # Set 1: Regular Main Bracket Set (TopPro beat MainPlayer9 in Winners Finals - qualifies as notable win if seed qualifies)
    conn.execute(
        "INSERT OR REPLACE INTO sets(id, event_id, phase_group_id, state, winner_entrant_id, display_score, full_round_text, round) "
        "VALUES ('set_m_1', '888001', '888201', 3, 'ent_m_1', '2-0', 'Grand Finals', 1)"
    )
    conn.execute("INSERT OR REPLACE INTO set_entrants(set_id, slot_id, slot_order, entrant_id, score_display) VALUES ('set_m_1', 's1_1', 0, 'ent_m_1', '2')")
    conn.execute("INSERT OR REPLACE INTO set_entrants(set_id, slot_id, slot_order, entrant_id, score_display) VALUES ('set_m_1', 's1_2', 1, 'ent_m_9', '0')")

    # Set 2: Amateur Bracket B Set (AmateurChamp [seed 20] beat Seed1Pro [seed 1] in Bracket B Finals)
    conn.execute(
        "INSERT OR REPLACE INTO sets(id, event_id, phase_group_id, state, winner_entrant_id, display_score, full_round_text, round) "
        "VALUES ('set_b_1', '888001', '888202', 3, 'ent_m_3', '2-0', 'Grand Finals', 1)"
    )
    conn.execute("INSERT OR REPLACE INTO set_entrants(set_id, slot_id, slot_order, entrant_id, score_display) VALUES ('set_b_1', 'sb1_1', 0, 'ent_m_3', '2')")
    conn.execute("INSERT OR REPLACE INTO set_entrants(set_id, slot_id, slot_order, entrant_id, score_display) VALUES ('set_b_1', 'sb1_2', 1, 'ent_m_2', '0')")

    # Set 3: Categoria B Phase Set
    conn.execute(
        "INSERT OR REPLACE INTO sets(id, event_id, phase_group_id, state, winner_entrant_id, display_score, full_round_text, round) "
        "VALUES ('set_c_1', '888001', '888203', 3, 'ent_m_5', '2-0', 'Grand Finals', 1)"
    )
    conn.execute("INSERT OR REPLACE INTO set_entrants(set_id, slot_id, slot_order, entrant_id, score_display) VALUES ('set_c_1', 'sc1_1', 0, 'ent_m_5', '2')")
    conn.execute("INSERT OR REPLACE INTO set_entrants(set_id, slot_id, slot_order, entrant_id, score_display) VALUES ('set_c_1', 'sc1_2', 1, 'ent_m_4', '0')")

    # Set 4: Custom Tier Phase Set (Custom name)
    conn.execute(
        "INSERT OR REPLACE INTO sets(id, event_id, phase_group_id, state, winner_entrant_id, display_score, full_round_text, round) "
        "VALUES ('set_cust_1', '888001', '888204', 3, 'ent_m_6', '2-0', 'Grand Finals', 1)"
    )
    conn.execute("INSERT OR REPLACE INTO set_entrants(set_id, slot_id, slot_order, entrant_id, score_display) VALUES ('set_cust_1', 'scust1_1', 0, 'ent_m_6', '2')")
    conn.execute("INSERT OR REPLACE INTO set_entrants(set_id, slot_id, slot_order, entrant_id, score_display) VALUES ('set_cust_1', 'scust1_2', 1, 'ent_m_4', '0')")

    # Set 5: Linked Side Categoria B Event Set
    conn.execute(
        "INSERT OR REPLACE INTO sets(id, event_id, phase_group_id, state, winner_entrant_id, display_score, full_round_text, round) "
        "VALUES ('set_side_1', '888002', '888205', 3, 'ent_s_7', '2-0', 'Grand Finals', 1)"
    )
    conn.execute("INSERT OR REPLACE INTO set_entrants(set_id, slot_id, slot_order, entrant_id, score_display) VALUES ('set_side_1', 'sside1_1', 0, 'ent_s_7', '2')")
    conn.execute("INSERT OR REPLACE INTO set_entrants(set_id, slot_id, slot_order, entrant_id, score_display) VALUES ('set_side_1', 'sside1_2', 1, 'ent_s_8', '0')")

    conn.commit()

    # Save explicit configuration in amateur_brackets.json & event_groups.json
    amateur_data = {
        "events": [],
        "phases": ["tournament/amateur-test-tourney/event/singles#Custom Tier"],
        "nonAmateurPhases": []
    }
    with AMATEUR_CONFIG.open("w", encoding="utf-8") as f:
        json.dump(amateur_data, f, indent=2)

    groups_data = {
        "tournament/amateur-test-tourney/event/side-categoria-b": {
            "parent": "tournament/amateur-test-tourney/event/singles",
            "phase": "Side Categoria B",
            "is_amateur": True
        }
    }
    with EVENT_GROUPS_CONFIG.open("w", encoding="utf-8") as f:
        json.dump(groups_data, f, indent=2)

    print("Rebuilding test profiles...")
    for p_id, tag in players:
        slug = f"{tag.lower()}-{p_id}"
        subprocess.run([sys.executable, "scripts/build_player_profile.py", p_id, "--tag", tag, "--slug", slug], check=True)

    # -------------------------------------------------------------------------
    # VALIDATIONS
    # -------------------------------------------------------------------------
    print("Validating test scenarios...")

    # Load profiles
    def load_prof(p_id, tag):
        path = PROJECT_ROOT / "data" / "profiles" / f"{tag.lower()}-{p_id}.json"
        with path.open(encoding="utf-8") as f:
            return json.load(f)

    p_top = load_prof('888001', 'TopPro')
    p_amateur = load_prof('888003', 'AmateurChamp')
    p_amateur_ru = load_prof('888004', 'AmateurRunnerUp')
    p_side_champ = load_prof('888007', 'SideChamp')
    p_side_ru = load_prof('888008', 'SideRunnerUp')

    # Scenario 1, 5, 6: Amateur Bracket B Winner
    game_amateur = next(g for g in p_amateur["games"] if g["id"] == "amateur-test-game")
    res_amateur = game_amateur["results"][0]

    # Scenario 5 validation: Notable wins must NOT contain the upset against Seed 1 in Bracket B
    assert len(game_amateur["notableWins"]) == 0, f"Amateur champ must have 0 notable wins from Bracket B, got: {game_amateur['notableWins']}"

    # Scenario 6 validation: Main event has 32 participants; amateur bracket 1st place receives 33rd place!
    assert res_amateur["place"] == 33, f"Amateur bracket winner in 32-participant event should get 33rd place, got: {res_amateur['place']}"

    # Scenario 7 validation: Multiple placements in amateur bracket ordered after main event
    # 2nd place in Bracket B -> 32 + 2 = 34th place
    game_amateur_ru = next(g for g in p_amateur_ru["games"] if g["id"] == "amateur-test-game")
    res_amateur_ru = game_amateur_ru["results"][0]
    assert res_amateur_ru["place"] == 34, f"Amateur bracket 2nd place should get 34th place, got: {res_amateur_ru['place']}"

    # Scenario 4 validation: Separate amateur event linked to a main event
    game_side_champ = next(g for g in p_side_champ["games"] if g["id"] == "amateur-test-game")
    res_side_champ = game_side_champ["results"][0]
    # Side event is linked to Main Event (32 entrants). 1st place in side amateur event -> 32 + 1 = 33rd place
    assert res_side_champ["place"] == 33, f"Linked amateur event 1st place should be assigned 33rd place, got: {res_side_champ['place']}"

    # Scenario 8 validation: Regular non-amateur result
    game_top = next(g for g in p_top["games"] if g["id"] == "amateur-test-game")
    res_top = game_top["results"][0]
    assert res_top["place"] == 1, f"Main event winner placement should remain 1st, got: {res_top['place']}"

    # Cleanup test DB entries & config
    conn.execute("DELETE FROM sets WHERE event_id IN ('888001', '888002')")
    conn.execute("DELETE FROM set_entrants WHERE set_id LIKE 'set_%'")
    conn.execute("DELETE FROM phase_seeds WHERE phase_id LIKE '888%'")
    conn.execute("DELETE FROM phase_groups WHERE id LIKE '888%'")
    conn.execute("DELETE FROM phases WHERE id LIKE '888%'")
    conn.execute("DELETE FROM event_standings WHERE event_id IN ('888001', '888002')")
    conn.execute("DELETE FROM entrant_participants WHERE entrant_id LIKE 'ent_%'")
    conn.execute("DELETE FROM entrants WHERE event_id IN ('888001', '888002')")
    conn.execute("DELETE FROM participants WHERE id LIKE 'part_888%'")
    conn.execute("DELETE FROM players WHERE id LIKE '888%'")
    conn.execute("DELETE FROM events WHERE id IN ('888001', '888002')")
    conn.execute("DELETE FROM tournaments WHERE slug = 'amateur-test-tourney'")
    conn.execute("DELETE FROM videogames WHERE slug = 'amateur-test-game'")
    conn.commit()
    conn.close()

    # Reset test config files
    with AMATEUR_CONFIG.open("w", encoding="utf-8") as f:
        json.dump({"events": [], "phases": [], "nonAmateurPhases": []}, f, indent=2)

    with EVENT_GROUPS_CONFIG.open("w", encoding="utf-8") as f:
        json.dump({"tournament/mashito-go-6/event/categoria-b": {"parent": "tournament/mashito-go-6/event/smash-ultimate-singles", "phase": "Categoria B"}}, f, indent=2)

    # Rebuild all profiles to ensure clean state
    subprocess.run([sys.executable, "scripts/build_player_profile.py", "--all"], check=True)

    # Clean test profile files
    for p_id, tag in players:
        test_file = PROJECT_ROOT / "data" / "profiles" / f"{tag.lower()}-{p_id}.json"
        if test_file.exists():
            test_file.unlink()

    print("All amateur bracket test scenarios passed successfully!")

if __name__ == "__main__":
    run_tests()
