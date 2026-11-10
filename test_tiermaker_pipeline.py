#!/usr/bin/env python3
"""Comprehensive test suite for Tiermaker player image generation and data pipeline.

Tests all 10 required scenarios:
1. Player with a valid most-played character.
2. Player without character data.
3. Equal appearance counts with different last-used dates.
4. Equal counts and equal dates.
5. Changed player tag.
6. Changed character portrait.
7. Changed most-played character.
8. Missing source portrait.
9. Removed player.
10. Repeated execution without source changes.
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
        # Create a temporary working directory
        self.test_dir = tempfile.mkdtemp()
        self.project_root = Path(self.test_dir)

        # Setup mock directories
        self.db_path = self.project_root / "startgg.sqlite3"
        self.index_path = self.project_root / "index.json"
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
            tiermaker.MANIFEST_PATH,
            tiermaker.OUTPUT_DIR,
            tiermaker.STATIC_JSON_DIR,
            tiermaker.COMBINED_JSON_PATH,
        )
        tiermaker.PROJECT_ROOT = self.project_root
        tiermaker.DB_PATH = self.db_path
        tiermaker.INDEX_PATH = self.index_path
        tiermaker.MANIFEST_PATH = self.manifest_path
        tiermaker.OUTPUT_DIR = self.output_dir
        tiermaker.STATIC_JSON_DIR = self.static_json_dir
        tiermaker.COMBINED_JSON_PATH = self.combined_json_path

        # Create mock portraits for game 'melee' and 'ultimate'
        for g in ["melee", "ultimate"]:
            portraits_g = self.renders_dir / g / "portraits"
            portraits_g.mkdir(parents=True, exist_ok=True)
            for cname in ["fox", "marth", "sheik", "falco", "other"]:
                img = Image.new("RGBA", (120, 120), (50, 100, 150, 255))
                img.save(portraits_g / f"{cname}.webp", "WEBP")

        # Symlink assets/renders to project_root/assets/renders so resolve_player_portrait works
        (self.project_root / "assets").mkdir(parents=True, exist_ok=True)
        os.symlink(self.renders_dir, self.project_root / "assets" / "renders")

        # Create mock SQLite database
        self.init_test_db()

    def tearDown(self):
        # Restore module paths
        (
            tiermaker.PROJECT_ROOT,
            tiermaker.DB_PATH,
            tiermaker.INDEX_PATH,
            tiermaker.MANIFEST_PATH,
            tiermaker.OUTPUT_DIR,
            tiermaker.STATIC_JSON_DIR,
            tiermaker.COMBINED_JSON_PATH,
        ) = self.orig_paths

        shutil.rmtree(self.test_dir, ignore_errors=True)

    def init_test_db(self):
        con = sqlite3.connect(self.db_path)
        cur = con.cursor()
        cur.executescript("""
        CREATE TABLE videogames (slug TEXT PRIMARY KEY, name TEXT);
        INSERT INTO videogames VALUES ('melee', 'Super Smash Bros. Melee');

        CREATE TABLE tournaments (slug TEXT PRIMARY KEY, start_at INTEGER);
        INSERT INTO tournaments VALUES ('tourney-1', 1600000000);

        CREATE TABLE events (id TEXT PRIMARY KEY, tournament_slug TEXT, videogame_slug TEXT);
        INSERT INTO events VALUES ('ev-1', 'tourney-1', 'melee');

        CREATE TABLE players (id TEXT PRIMARY KEY);
        CREATE TABLE participants (id TEXT PRIMARY KEY, player_id TEXT, gamer_tag TEXT);
        CREATE TABLE entrants (id TEXT PRIMARY KEY, event_id TEXT);
        CREATE TABLE entrant_participants (entrant_id TEXT, participant_id TEXT, PRIMARY KEY(entrant_id, participant_id));

        CREATE TABLE sets (id TEXT PRIMARY KEY, event_id TEXT, completed_at INTEGER, started_at INTEGER, start_at INTEGER);
        CREATE TABLE set_games (id TEXT PRIMARY KEY, set_id TEXT, game_no INTEGER);
        CREATE TABLE characters (videogame_slug TEXT, id TEXT, name TEXT, PRIMARY KEY(videogame_slug, id));
        INSERT INTO characters VALUES ('melee', '1', 'Fox');
        INSERT INTO characters VALUES ('melee', '2', 'Marth');
        INSERT INTO characters VALUES ('melee', '3', 'Falco');
        INSERT INTO characters VALUES ('melee', '4', 'Sheik');
        INSERT INTO characters VALUES ('melee', '99', 'Nonexistent');

        CREATE TABLE set_game_selections (
            id TEXT PRIMARY KEY,
            set_game_id TEXT,
            videogame_slug TEXT,
            character_id TEXT,
            entrant_id TEXT,
            selection_order INTEGER
        );
        """)
        con.commit()
        con.close()

    def add_player(self, pid: str, tag: str, events: int = 1, last_date: str = "2026-01-01"):
        index_data = []
        if self.index_path.exists():
            with open(self.index_path, "r", encoding="utf-8") as f:
                index_data = json.load(f)

        # Update or append
        existing = next((p for p in index_data if p["playerId"] == pid), None)
        if existing:
            existing["tag"] = tag
            existing["games"] = [{"slug": "melee", "events": events, "lastEventDate": last_date}]
        else:
            index_data.append({
                "playerId": pid,
                "tag": tag,
                "games": [{"slug": "melee", "events": events, "lastEventDate": last_date}]
            })

        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump(index_data, f, indent=2)

    def add_selections(self, pid: str, selections: list):
        """selections: list of (char_id, count, timestamp)"""
        con = sqlite3.connect(self.db_path)
        cur = con.cursor()
        cur.execute("INSERT OR IGNORE INTO players VALUES (?)", (pid,))
        part_id = f"part-{pid}"
        cur.execute("INSERT OR IGNORE INTO participants VALUES (?, ?, ?)", (part_id, pid, f"Tag-{pid}"))
        ent_id = f"ent-{pid}"
        cur.execute("INSERT OR IGNORE INTO entrants VALUES (?, 'ev-1')", (ent_id,))
        cur.execute("INSERT OR IGNORE INTO entrant_participants VALUES (?, ?)", (ent_id, part_id))

        sel_id_counter = int(cur.execute("SELECT COUNT(*) FROM set_game_selections").fetchone()[0])

        for char_id, count, ts in selections:
            for i in range(count):
                sel_id_counter += 1
                set_id = f"set-{pid}-{char_id}-{sel_id_counter}"
                game_id = f"game-{pid}-{char_id}-{sel_id_counter}"
                cur.execute("INSERT INTO sets VALUES (?, 'ev-1', ?, ?, ?)", (set_id, ts, ts, ts))
                cur.execute("INSERT INTO set_games VALUES (?, ?, 1)", (game_id, set_id))
                cur.execute(
                    "INSERT INTO set_game_selections VALUES (?, ?, 'melee', ?, ?, 1)",
                    (str(sel_id_counter), game_id, str(char_id), ent_id)
                )
        con.commit()
        con.close()

    def run_pipeline(self, **kwargs):
        return tiermaker.run_pipeline(
            db_path=self.db_path,
            index_path=self.index_path,
            output_dir=self.output_dir,
            manifest_path=self.manifest_path,
            static_json_dir=self.static_json_dir,
            combined_json_path=self.combined_json_path,
            **kwargs
        )

    def test_01_valid_most_played_character(self):
        """1. Player with a valid most-played character."""
        self.add_player("101", "FoxMaster")
        # Fox: 5 appearances, Marth: 2 appearances
        self.add_selections("101", [("1", 5, 1600000000), ("2", 2, 1600000000)])

        stats = self.run_pipeline()
        self.assertEqual(stats["generated"], 1)

        badge_path = self.output_dir / "melee" / "101.webp"
        self.assertTrue(badge_path.exists())

        manifest = tiermaker.load_manifest(self.manifest_path)
        self.assertEqual(manifest["images"]["melee/101"]["character_id"], "1")
        self.assertEqual(manifest["images"]["melee/101"]["character_name"], "Fox")

    def test_02_player_without_character_data(self):
        """2. Player without character data (falls back to other.webp)."""
        self.add_player("102", "UnknownGamer")
        # No character selections added

        stats = self.run_pipeline()
        self.assertEqual(stats["generated"], 1)

        badge_path = self.output_dir / "melee" / "102.webp"
        self.assertTrue(badge_path.exists())

        manifest = tiermaker.load_manifest(self.manifest_path)
        self.assertIsNone(manifest["images"]["melee/102"]["character_id"])
        self.assertEqual(manifest["images"]["melee/102"]["appearance_count"], 0)

    def test_03_equal_counts_different_dates(self):
        """3. Equal appearance counts with different last-used dates."""
        self.add_player("103", "DualMain")
        # Fox: 3 uses, ts=1600001000
        # Marth: 3 uses, ts=1600002000 (more recent)
        self.add_selections("103", [("1", 3, 1600001000), ("2", 3, 1600002000)])

        stats = self.run_pipeline()
        self.assertEqual(stats["generated"], 1)

        manifest = tiermaker.load_manifest(self.manifest_path)
        self.assertEqual(manifest["images"]["melee/103"]["character_id"], "2")
        self.assertEqual(manifest["images"]["melee/103"]["character_name"], "Marth")

    def test_04_equal_counts_and_equal_dates(self):
        """4. Equal counts and equal dates (deterministic character ID fallback)."""
        self.add_player("104", "TiedMain")
        # Fox (ID '1'): 2 uses, ts=1600000000
        # Marth (ID '2'): 2 uses, ts=1600000000
        self.add_selections("104", [("2", 2, 1600000000), ("1", 2, 1600000000)])

        stats = self.run_pipeline()
        self.assertEqual(stats["generated"], 1)

        manifest = tiermaker.load_manifest(self.manifest_path)
        # '1' < '2' deterministically
        self.assertEqual(manifest["images"]["melee/104"]["character_id"], "1")
        self.assertEqual(manifest["images"]["melee/104"]["character_name"], "Fox")

    def test_05_changed_player_tag(self):
        """5. Changed player tag triggers regeneration."""
        self.add_player("105", "OldTag")
        self.add_selections("105", [("1", 2, 1600000000)])
        self.run_pipeline()

        # Change tag in authoritative index
        self.add_player("105", "NewTag")
        stats2 = self.run_pipeline()
        self.assertEqual(stats2["updated"], 1)
        self.assertEqual(stats2["unchanged"], 0)

        manifest = tiermaker.load_manifest(self.manifest_path)
        self.assertEqual(manifest["images"]["melee/105"]["player_tag"], "NewTag")

    def test_06_changed_character_portrait(self):
        """6. Changed character portrait asset triggers regeneration."""
        self.add_player("106", "FoxPro")
        self.add_selections("106", [("1", 4, 1600000000)])
        self.run_pipeline()

        # Modify the source portrait for Fox
        fox_portrait = self.renders_dir / "melee" / "portraits" / "fox.webp"
        with Image.new("RGBA", (120, 120), (255, 0, 0, 255)) as img:
            img.save(fox_portrait, "WEBP")

        stats2 = self.run_pipeline()
        self.assertEqual(stats2["updated"], 1)
        self.assertEqual(stats2["unchanged"], 0)

    def test_07_changed_most_played_character(self):
        """7. Changed most-played character triggers regeneration."""
        self.add_player("107", "SwitchPlayer")
        self.add_selections("107", [("1", 2, 1600000000)])  # Fox: 2
        self.run_pipeline()

        manifest1 = tiermaker.load_manifest(self.manifest_path)
        self.assertEqual(manifest1["images"]["melee/107"]["character_id"], "1")

        # Now Marth has 5 appearances
        self.add_selections("107", [("2", 5, 1600000000)])
        stats2 = self.run_pipeline()
        self.assertEqual(stats2["updated"], 1)

        manifest2 = tiermaker.load_manifest(self.manifest_path)
        self.assertEqual(manifest2["images"]["melee/107"]["character_id"], "2")
        self.assertEqual(manifest2["images"]["melee/107"]["character_name"], "Marth")

    def test_08_missing_source_portrait(self):
        """8. Missing source portrait safely falls back to other.webp."""
        self.add_player("108", "RareMain")
        # Character ID '99' named 'Nonexistent' has no portrait file
        self.add_selections("108", [("99", 5, 1600000000)])

        stats = self.run_pipeline()
        self.assertEqual(stats["generated"], 1)

        badge_path = self.output_dir / "melee" / "108.webp"
        self.assertTrue(badge_path.exists())

        # Check portrait hash matches other.webp
        other_path = self.renders_dir / "melee" / "portraits" / "other.webp"
        expected_hash = tiermaker.get_file_sha256(other_path)
        manifest = tiermaker.load_manifest(self.manifest_path)
        self.assertEqual(manifest["images"]["melee/108"]["portrait_hash"], expected_hash)

    def test_09_removed_player_obsolete_detection(self):
        """9. Removed player detection and cleanup."""
        self.add_player("109", "TemporaryPlayer")
        self.run_pipeline()

        badge_path = self.output_dir / "melee" / "109.webp"
        self.assertTrue(badge_path.exists())

        # Remove player from index
        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump([], f)

        # Run without clean_obsolete -> should detect 1 obsolete
        stats1 = self.run_pipeline(clean_obsolete=False)
        self.assertEqual(stats1["obsolete_detected"], 1)
        self.assertTrue(badge_path.exists())

        # Run with clean_obsolete=True -> should delete badge and purge manifest
        stats2 = self.run_pipeline(clean_obsolete=True)
        self.assertEqual(stats2["obsolete_cleaned"], 1)
        self.assertFalse(badge_path.exists())

        manifest = tiermaker.load_manifest(self.manifest_path)
        self.assertNotIn("melee/109", manifest["images"])

    def test_10_repeated_execution_without_source_changes(self):
        """10. Repeated execution without source changes is fully idempotent."""
        self.add_player("110", "ConsistentGamer")
        self.add_selections("110", [("1", 4, 1600000000)])

        stats1 = self.run_pipeline()
        self.assertEqual(stats1["generated"], 1)
        self.assertEqual(stats1["unchanged"], 0)

        # Second run with no changes
        stats2 = self.run_pipeline()
        self.assertEqual(stats2["generated"], 0)
        self.assertEqual(stats2["updated"], 0)
        self.assertEqual(stats2["unchanged"], 1)
        self.assertEqual(stats2["obsolete_detected"], 0)


if __name__ == "__main__":
    unittest.main()
