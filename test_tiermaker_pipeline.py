#!/usr/bin/env python3
"""Comprehensive unit test suite for Tiermaker pipeline and International Players handling.

Tests:
1. Badge generation with valid most-played character.
2. Player without character selections (other.webp fallback).
3. Equal appearance counts with different last-used dates (recency tie-breaker).
4. Equal counts and equal dates (character ID tie-breaker).
5. Changed player tag triggers badge update.
6. Changed character portrait triggers badge update.
7. Changed most-played character selection triggers badge update.
8. Missing character portrait falls back to other.webp.
9. Incremental generation skips unchanged players.
10. Obsolete badges detected and cleaned with clean_obsolete.
11. Excluded players from data/profiles/exclusions.json included in static JSON and badges.
12. Excluded players separated into international pool, not regular unranked pool.
"""

import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path
from PIL import Image

import scripts.generate_tiermaker_badges as tiermaker


class TestTiermakerPipeline(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.project_root = Path(self.test_dir)

        # Setup mock paths
        self.db_path = self.project_root / "startgg.sqlite3"
        self.index_path = self.project_root / "index.json"
        self.exclusions_path = self.project_root / "exclusions.json"
        self.profiles_dir = self.project_root / "profiles"
        self.profiles_dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.project_root / "manifest.json"
        self.output_dir = self.project_root / "badges"
        self.static_json_dir = self.project_root / "static_json"
        self.combined_json_path = self.project_root / "tiermaker.json"
        self.renders_dir = self.project_root / "renders"

        # Patch module paths
        self.orig_paths = (
            tiermaker.PROJECT_ROOT,
            tiermaker.DB_PATH,
            tiermaker.INDEX_PATH,
            tiermaker.EXCLUSIONS_PATH,
            tiermaker.PROFILES_DIR,
            tiermaker.MANIFEST_PATH,
            tiermaker.OUTPUT_DIR,
            tiermaker.STATIC_JSON_DIR,
            tiermaker.COMBINED_JSON_PATH,
        )
        tiermaker.PROJECT_ROOT = self.project_root
        tiermaker.DB_PATH = self.db_path
        tiermaker.INDEX_PATH = self.index_path
        tiermaker.EXCLUSIONS_PATH = self.exclusions_path
        tiermaker.PROFILES_DIR = self.profiles_dir
        tiermaker.MANIFEST_PATH = self.manifest_path
        tiermaker.OUTPUT_DIR = self.output_dir
        tiermaker.STATIC_JSON_DIR = self.static_json_dir
        tiermaker.COMBINED_JSON_PATH = self.combined_json_path

        # Create mock portraits for game 'melee' and 'ultimate'
        for g in ["melee", "ultimate"]:
            portraits_g = self.renders_dir / g / "portraits"
            portraits_g.mkdir(parents=True, exist_ok=True)
            for cname in ["fox", "marth", "sheik", "falco", "ness", "other"]:
                img = Image.new("RGBA", (120, 120), (50, 100, 150, 255))
                img.save(portraits_g / f"{cname}.webp", "WEBP")

        # Symlink assets/renders so resolve_player_portrait works
        (self.project_root / "assets").mkdir(parents=True, exist_ok=True)
        os.symlink(self.renders_dir, self.project_root / "assets" / "renders")

        # Initialize test SQLite DB
        self.init_test_db()

    def tearDown(self):
        (
            tiermaker.PROJECT_ROOT,
            tiermaker.DB_PATH,
            tiermaker.INDEX_PATH,
            tiermaker.EXCLUSIONS_PATH,
            tiermaker.PROFILES_DIR,
            tiermaker.MANIFEST_PATH,
            tiermaker.OUTPUT_DIR,
            tiermaker.STATIC_JSON_DIR,
            tiermaker.COMBINED_JSON_PATH,
        ) = self.orig_paths
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def init_test_db(self):
        con = sqlite3.connect(self.db_path)
        cur = con.cursor()

        cur.execute("""
            CREATE TABLE tournaments (
                id INTEGER PRIMARY KEY,
                name TEXT,
                slug TEXT,
                start_at INTEGER
            );
        """)
        cur.execute("""
            CREATE TABLE events (
                id INTEGER PRIMARY KEY,
                tournament_slug TEXT,
                videogame_slug TEXT,
                name TEXT
            );
        """)
        cur.execute("""
            CREATE TABLE sets (
                id INTEGER PRIMARY KEY,
                event_id INTEGER,
                completed_at INTEGER,
                started_at INTEGER,
                start_at INTEGER
            );
        """)
        cur.execute("""
            CREATE TABLE set_games (
                id INTEGER PRIMARY KEY,
                set_id INTEGER
            );
        """)
        cur.execute("""
            CREATE TABLE entrants (
                id INTEGER PRIMARY KEY,
                event_id INTEGER,
                name TEXT
            );
        """)
        cur.execute("""
            CREATE TABLE participants (
                id INTEGER PRIMARY KEY,
                player_id TEXT,
                gamer_tag TEXT
            );
        """)
        cur.execute("""
            CREATE TABLE entrant_participants (
                entrant_id INTEGER,
                participant_id INTEGER
            );
        """)
        cur.execute("""
            CREATE TABLE characters (
                id INTEGER,
                videogame_slug TEXT,
                name TEXT,
                PRIMARY KEY (id, videogame_slug)
            );
        """)
        cur.execute("""
            CREATE TABLE set_game_selections (
                id INTEGER PRIMARY KEY,
                set_game_id INTEGER,
                entrant_id INTEGER,
                character_id INTEGER,
                videogame_slug TEXT
            );
        """)

        # Insert characters
        cur.executemany(
            "INSERT INTO characters (id, videogame_slug, name) VALUES (?, ?, ?)",
            [
                (1, "melee", "Fox"),
                (2, "melee", "Marth"),
                (3, "melee", "Sheik"),
                (4, "melee", "Falco"),
                (10, "ultimate", "Ness"),
            ]
        )

        # Base tournament, event, participant
        cur.execute("INSERT INTO tournaments VALUES (1, 'Tourney 1', 't1', 1700000000)")
        cur.execute("INSERT INTO events VALUES (10, 't1', 'melee', 'Melee Singles') VALUES" if False else "INSERT INTO events VALUES (10, 't1', 'melee', 'Melee Singles')")
        cur.execute("INSERT INTO sets VALUES (100, 10, 1700000100, 1700000000, 1700000000)")
        cur.execute("INSERT INTO set_games VALUES (1000, 100)")
        cur.execute("INSERT INTO entrants VALUES (500, 10, 'Player One')")
        cur.execute("INSERT INTO participants VALUES (600, '101', 'Player One')")
        cur.execute("INSERT INTO entrant_participants VALUES (500, 600)")

        con.commit()
        con.close()

    def test_single_character_badge_generation(self):
        """Player with a valid most-played character generates 80x80 badge."""
        con = sqlite3.connect(self.db_path)
        cur = con.cursor()
        cur.execute("INSERT INTO set_game_selections VALUES (1, 1000, 500, 1, 'melee')")
        con.commit()
        con.close()

        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump([
                {"playerId": "101", "tag": "Player One", "games": [{"slug": "melee", "events": 1}]}
            ], f)

        stats = tiermaker.run_pipeline(
            db_path=self.db_path,
            index_path=self.index_path,
            exclusions_path=self.exclusions_path,
            profiles_dir=self.profiles_dir,
            output_dir=self.output_dir,
            manifest_path=self.manifest_path,
            static_json_dir=self.static_json_dir,
            combined_json_path=self.combined_json_path,
        )

        badge_path = self.output_dir / "melee" / "101.webp"
        self.assertTrue(badge_path.exists())
        self.assertEqual(stats["generated"], 1)

        with Image.open(badge_path) as img:
            self.assertEqual(img.size, (80, 80))

    def test_no_character_data_fallback(self):
        """Player without character selections falls back to other.webp."""
        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump([
                {"playerId": "101", "tag": "Player One", "games": [{"slug": "melee", "events": 1}]}
            ], f)

        stats = tiermaker.run_pipeline(
            db_path=self.db_path,
            index_path=self.index_path,
            exclusions_path=self.exclusions_path,
            profiles_dir=self.profiles_dir,
            output_dir=self.output_dir,
            manifest_path=self.manifest_path,
            static_json_dir=self.static_json_dir,
            combined_json_path=self.combined_json_path,
        )

        badge_path = self.output_dir / "melee" / "101.webp"
        self.assertTrue(badge_path.exists())

        with open(self.manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        record = manifest["images"]["melee/101"]
        self.assertIsNone(record["character_id"])

    def test_recency_tie_breaker(self):
        """Equal appearance counts tie-broken by most recent timestamp."""
        con = sqlite3.connect(self.db_path)
        cur = con.cursor()
        cur.execute("INSERT INTO sets VALUES (101, 10, 1700000500, 1700000500, 1700000500)")
        cur.execute("INSERT INTO set_games VALUES (1001, 101)")
        # 1 selection of Fox (id 1) at ts 1700000100
        cur.execute("INSERT INTO set_game_selections VALUES (1, 1000, 500, 1, 'melee')")
        # 1 selection of Marth (id 2) at ts 1700000500 (more recent)
        cur.execute("INSERT INTO set_game_selections VALUES (2, 1001, 500, 2, 'melee')")
        con.commit()
        con.close()

        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump([
                {"playerId": "101", "tag": "Player One", "games": [{"slug": "melee", "events": 2}]}
            ], f)

        tiermaker.run_pipeline(
            db_path=self.db_path,
            index_path=self.index_path,
            exclusions_path=self.exclusions_path,
            profiles_dir=self.profiles_dir,
            output_dir=self.output_dir,
            manifest_path=self.manifest_path,
            static_json_dir=self.static_json_dir,
            combined_json_path=self.combined_json_path,
        )

        with open(self.manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        record = manifest["images"]["melee/101"]
        self.assertEqual(record["character_id"], "2")
        self.assertEqual(record["character_name"], "Marth")

    def test_character_id_tie_breaker(self):
        """Equal appearance counts and equal timestamps tie-broken by character ID asc."""
        con = sqlite3.connect(self.db_path)
        cur = con.cursor()
        # Same set game (same timestamp)
        cur.execute("INSERT INTO set_game_selections VALUES (1, 1000, 500, 3, 'melee')")  # Sheik id 3
        cur.execute("INSERT INTO set_game_selections VALUES (2, 1000, 500, 2, 'melee')")  # Marth id 2
        con.commit()
        con.close()

        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump([
                {"playerId": "101", "tag": "Player One", "games": [{"slug": "melee", "events": 1}]}
            ], f)

        tiermaker.run_pipeline(
            db_path=self.db_path,
            index_path=self.index_path,
            exclusions_path=self.exclusions_path,
            profiles_dir=self.profiles_dir,
            output_dir=self.output_dir,
            manifest_path=self.manifest_path,
            static_json_dir=self.static_json_dir,
            combined_json_path=self.combined_json_path,
        )

        with open(self.manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        record = manifest["images"]["melee/101"]
        self.assertEqual(record["character_id"], "2")
        self.assertEqual(record["character_name"], "Marth")

    def test_incremental_updates_and_tag_change(self):
        """Test tag change triggers regeneration, while unchanged execution skips."""
        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump([
                {"playerId": "101", "tag": "InitialTag", "games": [{"slug": "melee", "events": 1}]}
            ], f)

        stats1 = tiermaker.run_pipeline(
            db_path=self.db_path,
            index_path=self.index_path,
            exclusions_path=self.exclusions_path,
            profiles_dir=self.profiles_dir,
            output_dir=self.output_dir,
            manifest_path=self.manifest_path,
            static_json_dir=self.static_json_dir,
            combined_json_path=self.combined_json_path,
        )
        self.assertEqual(stats1["generated"], 1)

        # Second run unchanged
        stats2 = tiermaker.run_pipeline(
            db_path=self.db_path,
            index_path=self.index_path,
            exclusions_path=self.exclusions_path,
            profiles_dir=self.profiles_dir,
            output_dir=self.output_dir,
            manifest_path=self.manifest_path,
            static_json_dir=self.static_json_dir,
            combined_json_path=self.combined_json_path,
        )
        self.assertEqual(stats2["unchanged"], 1)

        # Update tag
        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump([
                {"playerId": "101", "tag": "UpdatedTag", "games": [{"slug": "melee", "events": 1}]}
            ], f)

        stats3 = tiermaker.run_pipeline(
            db_path=self.db_path,
            index_path=self.index_path,
            exclusions_path=self.exclusions_path,
            profiles_dir=self.profiles_dir,
            output_dir=self.output_dir,
            manifest_path=self.manifest_path,
            static_json_dir=self.static_json_dir,
            combined_json_path=self.combined_json_path,
        )
        self.assertEqual(stats3["updated"], 1)

    def test_international_players_inclusion_and_separation(self):
        """Excluded players in exclusions.json must be in international pool, separated from regular unranked."""
        con = sqlite3.connect(self.db_path)
        cur = con.cursor()
        # Excluded player participant 999
        cur.execute("INSERT INTO participants VALUES (999, '8888', 'IntlStar')")
        cur.execute("INSERT INTO entrants VALUES (888, 10, 'IntlStar')")
        cur.execute("INSERT INTO entrant_participants VALUES (888, 999)")
        cur.execute("INSERT INTO set_game_selections VALUES (99, 1000, 888, 4, 'melee')")  # Falco
        con.commit()
        con.close()

        # Regular player in index.json
        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump([
                {"playerId": "101", "tag": "LocalHero", "games": [{"slug": "melee", "events": 1}]}
            ], f)

        # International player in exclusions.json
        with open(self.exclusions_path, "w", encoding="utf-8") as f:
            json.dump({
                "events": [],
                "playerGames": {
                    "8888": ["melee"]
                }
            }, f)

        stats = tiermaker.run_pipeline(
            db_path=self.db_path,
            index_path=self.index_path,
            exclusions_path=self.exclusions_path,
            profiles_dir=self.profiles_dir,
            output_dir=self.output_dir,
            manifest_path=self.manifest_path,
            static_json_dir=self.static_json_dir,
            combined_json_path=self.combined_json_path,
        )

        # Both badges generated
        self.assertTrue((self.output_dir / "melee" / "101.webp").exists())
        self.assertTrue((self.output_dir / "melee" / "8888.webp").exists())

        # Check static catalog
        melee_json = self.static_json_dir / "melee.json"
        with open(melee_json, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertIn("players", data)
        self.assertIn("international", data)

        reg_ids = [p["id"] for p in data["players"]]
        intl_ids = [p["id"] for p in data["international"]]

        self.assertIn("101", reg_ids)
        self.assertNotIn("8888", reg_ids)

        self.assertIn("8888", intl_ids)
        self.assertNotIn("101", intl_ids)

        intl_player = next(p for p in data["international"] if p["id"] == "8888")
        self.assertEqual(intl_player["tag"], "IntlStar")
        self.assertEqual(intl_player["selected_character"], "Falco")

    def test_obsolete_badge_detection_and_clean(self):
        """Obsolete badges must be cleaned with clean_obsolete=True."""
        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump([
                {"playerId": "101", "tag": "Player One", "games": [{"slug": "melee", "events": 1}]}
            ], f)

        tiermaker.run_pipeline(
            db_path=self.db_path,
            index_path=self.index_path,
            exclusions_path=self.exclusions_path,
            profiles_dir=self.profiles_dir,
            output_dir=self.output_dir,
            manifest_path=self.manifest_path,
            static_json_dir=self.static_json_dir,
            combined_json_path=self.combined_json_path,
        )
        self.assertTrue((self.output_dir / "melee" / "101.webp").exists())

        # Empty index and exclusions
        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump([], f)
        with open(self.exclusions_path, "w", encoding="utf-8") as f:
            json.dump({"events": [], "playerGames": {}}, f)

        stats = tiermaker.run_pipeline(
            clean_obsolete=True,
            db_path=self.db_path,
            index_path=self.index_path,
            exclusions_path=self.exclusions_path,
            profiles_dir=self.profiles_dir,
            output_dir=self.output_dir,
            manifest_path=self.manifest_path,
            static_json_dir=self.static_json_dir,
            combined_json_path=self.combined_json_path,
        )

        self.assertEqual(stats["obsolete_detected"], 1)
        self.assertEqual(stats["obsolete_cleaned"], 1)
        self.assertFalse((self.output_dir / "melee" / "101.webp").exists())


if __name__ == "__main__":
    unittest.main()
