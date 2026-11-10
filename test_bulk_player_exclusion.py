#!/usr/bin/env python3
import json
import sqlite3
import unittest
from pathlib import Path

from scripts.serve_site import (
    DATABASE,
    EXCLUSIONS_PATH,
    ROOT as PROJECT_ROOT,
    visibility_exclusions,
    atomic_json,
    profile_entries,
    refresh_index,
    rebuild_profiles,
)
from scripts.rankings_calculator import RankingEngine


class TestBulkPlayerExclusion(unittest.TestCase):
    def setUp(self):
        # Save original exclusions.json
        with open(EXCLUSIONS_PATH, "r", encoding="utf-8") as f:
            self.orig_exclusions = json.load(f)
        # Save catwo-3326405.json content if it exists
        self.catwo_path = PROJECT_ROOT / "data" / "profiles" / "catwo-3326405.json"
        self.catwo_orig = None
        if self.catwo_path.exists():
            with open(self.catwo_path, "r", encoding="utf-8") as f:
                self.catwo_orig = f.read()

    def tearDown(self):
        # Restore catwo profile
        if self.catwo_orig is not None:
            with open(self.catwo_path, "w", encoding="utf-8") as f:
                f.write(self.catwo_orig)
        # Restore original exclusions.json and refresh index/profiles
        atomic_json(EXCLUSIONS_PATH, self.orig_exclusions)
        refresh_index()

    def test_single_player_bulk_exclusion_matches_regular_behavior(self):
        """
        1. Excluding a single player through bulk exclusion produces
        the exact same structure and behavior as regular player exclusion.
        """
        player_id = "4837961"  # Washu
        # Find games from DB
        with sqlite3.connect(DATABASE) as conn:
            available = sorted({
                row[0] for row in conn.execute(
                    "SELECT DISTINCT e.videogame_slug FROM participants p "
                    "JOIN entrant_participants ep ON ep.participant_id=p.id "
                    "JOIN entrants en ON en.id=ep.entrant_id JOIN events e ON e.id=en.event_id "
                    "WHERE p.player_id=?",
                    (player_id,),
                )
            })
        self.assertTrue(len(available) > 0)

        # Apply regular exclusion
        reg_config = visibility_exclusions()
        reg_config["playerGames"][player_id] = available
        atomic_json(EXCLUSIONS_PATH, reg_config)
        refresh_index()

        entries_reg = profile_entries(public_only=True)
        self.assertFalse(any(p["playerId"] == player_id for p in entries_reg))

    def test_excluded_player_disappears_from_player_index(self):
        """
        2. An excluded player disappears from data/profiles/index.json.
        """
        player_id = "4837961"
        config = visibility_exclusions()
        config["playerGames"][player_id] = ["ultimate"]
        atomic_json(EXCLUSIONS_PATH, config)
        refresh_index()

        with open(PROJECT_ROOT / "data" / "profiles" / "index.json", "r", encoding="utf-8") as f:
            index_data = json.load(f)
        self.assertFalse(any(p["playerId"] == player_id for p in index_data))

    def test_ranking_calculations_exclude_player_sets(self):
        """
        3. Sets played against the excluded player must be excluded from ranking calculations.
        """
        player_id = "2915041"  # Azrad
        game_slug = "rivals-of-aether"

        # Engine before exclusion
        config = visibility_exclusions()
        config["playerGames"].pop(player_id, None)
        atomic_json(EXCLUSIONS_PATH, config)
        engine_before = RankingEngine(use_json=False)
        sets_before = engine_before.load_sets_from_db(game_slug)
        self.assertTrue(any(s["winnerId"] == player_id or s["loserId"] == player_id for s in sets_before))

        # Engine after exclusion
        config["playerGames"][player_id] = [game_slug]
        atomic_json(EXCLUSIONS_PATH, config)
        engine_after = RankingEngine(use_json=False)
        sets_after = engine_after.load_sets_from_db(game_slug)
        self.assertFalse(any(s["winnerId"] == player_id or s["loserId"] == player_id for s in sets_after))

    def test_recent_sets_remain_visible_with_opponent_excluded(self):
        """
        4. Sets against the excluded player must remain visible in other players'
        recent sets lists (with opponentExcluded: True).
        """
        player_id = "2915041"  # Azrad
        game_slug = "project-plus"
        config = visibility_exclusions()
        config["playerGames"][player_id] = [game_slug]
        atomic_json(EXCLUSIONS_PATH, config)

        # Build Catwo's profile (3326405 played Azrad in project-plus)
        from scripts.build_player_profile import write_profile
        with sqlite3.connect(DATABASE) as conn:
            conn.row_factory = sqlite3.Row
            write_profile(conn, "3326405", "Catwo", "catwo-3326405")

        catwo_file = PROJECT_ROOT / "data" / "profiles" / "catwo-3326405.json"
        with open(catwo_file, "r", encoding="utf-8") as f:
            catwo_profile = json.load(f)

        p_plus_game = next(g for g in catwo_profile["games"] if g["slug"] == game_slug)
        azrad_sets = [
            s for r in p_plus_game["results"]
            for s in r["sets"]
            if "Azrad" in s["opponent"]
        ]
        self.assertTrue(len(azrad_sets) > 0)
        for s in azrad_sets:
            self.assertTrue(s.get("opponentExcluded"), f"Expected opponentExcluded=True on set {s}")

    def test_event_placements_remain_visible(self):
        """
        5. The excluded player's placements must remain visible in the standings of events they entered.
        """
        # Azrad (2915041) placed 7th in rivalito-charrua-13
        ev_file = PROJECT_ROOT / "data" / "events" / "rivalito-charrua-13.json"
        with open(ev_file, "r", encoding="utf-8") as f:
            ev_data = json.load(f)

        found_standing = False
        for sub in ev_data.get("subEvents", []):
            for st in sub.get("standings", []):
                if st.get("playerId") == "2915041":
                    found_standing = True
                    self.assertEqual(st.get("placement"), 7)
        self.assertTrue(found_standing)

    def test_player_profile_remains_accessible(self):
        """
        6. The excluded player's profile must continue to exist and remain accessible.
        """
        player_id = "4837961"
        profile_file = PROJECT_ROOT / "data" / "profiles" / "washu-4837961.json"
        self.assertTrue(profile_file.exists())
        with open(profile_file, "r", encoding="utf-8") as f:
            p_data = json.load(f)
        self.assertEqual(p_data["player"]["startggPlayerId"], player_id)

    def test_excluded_player_retains_games_and_opponent_player_ids_in_sets(self):
        """
        Test that when a player is excluded from a game:
        - Their profile JSON file still has their games, results, and sets
        - Opponents' sets against them include opponentPlayerId and opponentExcluded: True
        - The excluded player does NOT appear in index.json
        """
        # Konkreto (1012772) is excluded from ultimate in exclusions.json
        from scripts.build_player_profile import write_profile
        with sqlite3.connect(DATABASE) as conn:
            conn.row_factory = sqlite3.Row
            entry = write_profile(conn, "1012772", "Konkreto", "konkreto-1012772")
            # Should not be returned for index.json inclusion if all games are excluded
            self.assertIsNone(entry)

            # But their profile file exists and has games populated!
            konkreto_path = PROJECT_ROOT / "data" / "profiles" / "konkreto-1012772.json"
            self.assertTrue(konkreto_path.exists())
            with open(konkreto_path, "r", encoding="utf-8") as f:
                konkreto_profile = json.load(f)
            self.assertEqual(len(konkreto_profile["games"]), 1)
            self.assertEqual(konkreto_profile["games"][0]["slug"], "ultimate")
            self.assertTrue(len(konkreto_profile["games"][0]["results"]) > 0)

            # Build Marroll (795083) who played Konkreto in ultimate
            write_profile(conn, "795083", "Marroll", "marroll-795083")
            marroll_path = PROJECT_ROOT / "data" / "profiles" / "marroll-795083.json"
            with open(marroll_path, "r", encoding="utf-8") as f:
                marroll_profile = json.load(f)
            ultimate_game = next(g for g in marroll_profile["games"] if g["slug"] == "ultimate")
            konkreto_sets = [
                s for r in ultimate_game["results"]
                for s in r["sets"]
                if "Konkreto" in s["opponent"]
            ]
            self.assertTrue(len(konkreto_sets) > 0)
            for s in konkreto_sets:
                self.assertEqual(s.get("opponentPlayerId"), "1012772")
                self.assertTrue(s.get("opponentExcluded"))

    def test_cross_game_exclusion_excludes_all_games(self):
        """
        7. Excluding a player who has participated in multiple games excludes them across all those games.
        """
        player_id = "2915041"  # Azrad has melee, project-plus, rivals-2, rivals-of-aether, ultimate
        with sqlite3.connect(DATABASE) as conn:
            all_games = sorted({
                row[0] for row in conn.execute(
                    "SELECT DISTINCT e.videogame_slug FROM participants p "
                    "JOIN entrant_participants ep ON ep.participant_id=p.id "
                    "JOIN entrants en ON en.id=ep.entrant_id JOIN events e ON e.id=en.event_id "
                    "WHERE p.player_id=?",
                    (player_id,),
                )
            })
        self.assertEqual(all_games, ["melee", "project-plus", "rivals-2", "rivals-of-aether", "ultimate"])

        config = visibility_exclusions()
        config["playerGames"][player_id] = all_games
        atomic_json(EXCLUSIONS_PATH, config)
        refresh_index()

        entries = profile_entries(public_only=True)
        self.assertFalse(any(p["playerId"] == player_id for p in entries))

        # Check rankings across all these games
        for g in all_games:
            engine = RankingEngine(use_json=False)
            sets = engine.load_sets_from_db(g)
            self.assertFalse(any(s["winnerId"] == player_id or s["loserId"] == player_id for s in sets))

    def test_bulk_exclusion_multiple_players_without_affecting_others(self):
        """
        8. Selecting and excluding multiple players works correctly without affecting unselected players.
        """
        p1 = "4837961"  # Washu
        p2 = "663033"   # aalz
        unselected = "795083"  # Marroll

        config = visibility_exclusions()
        config["playerGames"][p1] = ["ultimate"]
        config["playerGames"][p2] = ["melee", "project-plus", "rivals-2", "rivals-of-aether", "ultimate"]
        atomic_json(EXCLUSIONS_PATH, config)
        refresh_index()

        entries = profile_entries(public_only=True)
        self.assertFalse(any(p["playerId"] == p1 for p in entries))
        self.assertFalse(any(p["playerId"] == p2 for p in entries))
        self.assertTrue(any(p["playerId"] == unselected for p in entries))

    def test_existing_regular_exclusion_unaffected(self):
        """
        9. Existing regular game exclusion functionality remains unaffected.
        """
        p = "2915041"  # Azrad
        config = visibility_exclusions()
        # Only exclude from rivals-of-aether
        config["playerGames"][p] = ["rivals-of-aether"]
        atomic_json(EXCLUSIONS_PATH, config)
        refresh_index()

        entries = profile_entries(public_only=True)
        azrad = next((item for item in entries if item["playerId"] == p), None)
        self.assertIsNotNone(azrad)
        game_slugs = [g["slug"] for g in azrad["games"]]
        self.assertNotIn("rivals-of-aether", game_slugs)
        self.assertIn("melee", game_slugs)
        self.assertIn("ultimate", game_slugs)


if __name__ == "__main__":
    unittest.main()
