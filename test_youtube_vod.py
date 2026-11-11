"""Comprehensive tests for YouTube VOD Management and Integration."""

import json
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from scripts.youtube_vod import (
    extract_playlist_id,
    is_valid_playlist_url,
    fetch_playlist_videos,
    YouTubeAPIError,
    YouTubeConfigError,
)
from scripts.import_startgg_data import migrate_vod_schema


class TestYouTubePlaylistImport(unittest.TestCase):
    """Test URL parsing, playlist ID extraction, and API interactions."""

    def test_extract_playlist_id(self):
        valid_urls = [
            ("https://www.youtube.com/playlist?list=PL12345ABCDE", "PL12345ABCDE"),
            ("http://youtube.com/playlist?list=PL12345ABCDE", "PL12345ABCDE"),
            ("https://m.youtube.com/playlist?list=PL12345ABCDE", "PL12345ABCDE"),
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL12345ABCDE", "PL12345ABCDE"),
            ("https://youtu.be/watch?v=abc&list=PL12345ABCDE", "PL12345ABCDE"),
            ("PL12345ABCDE123", "PL12345ABCDE123"),
        ]
        for url, expected in valid_urls:
            self.assertEqual(extract_playlist_id(url), expected)
            self.assertTrue(is_valid_playlist_url(url))

        invalid_urls = [
            "",
            "   ",
            "not_a_url",
            "https://www.google.com/playlist?list=PL12345",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/user/pewdiepie",
            None,
        ]
        for url in invalid_urls:
            self.assertIsNone(extract_playlist_id(url))
            self.assertFalse(is_valid_playlist_url(url))

    def test_missing_api_key_raises_config_error(self):
        with patch.dict(os.environ, {"YOUTUBE_API_KEY": ""}, clear=True):
            with self.assertRaises(YouTubeConfigError):
                fetch_playlist_videos("PL12345ABCDE123")

    @patch("urllib.request.urlopen")
    def test_fetch_playlist_videos_pagination(self, mock_urlopen):
        # Mock 2 pages of responses
        page1 = {
            "items": [
                {
                    "id": "item_1",
                    "snippet": {
                        "resourceId": {"videoId": "vid_1"},
                        "title": "Match 1 - Player A vs Player B",
                        "thumbnails": {"medium": {"url": "https://img.youtube.com/vi/vid_1/mqdefault.jpg"}},
                    },
                    "status": {"privacyStatus": "public"},
                }
            ],
            "nextPageToken": "page_2_token",
        }
        page2 = {
            "items": [
                {
                    "id": "item_2",
                    "snippet": {
                        "resourceId": {"videoId": "vid_2"},
                        "title": "Match 2 - Player C vs Player D",
                        "thumbnails": {"default": {"url": "https://img.youtube.com/vi/vid_2/default.jpg"}},
                    },
                    "status": {"privacyStatus": "public"},
                }
            ]
        }

        mock_cm1 = MagicMock()
        mock_resp1 = MagicMock()
        mock_resp1.read.return_value = json.dumps(page1).encode("utf-8")
        mock_cm1.__enter__.return_value = mock_resp1

        mock_cm2 = MagicMock()
        mock_resp2 = MagicMock()
        mock_resp2.read.return_value = json.dumps(page2).encode("utf-8")
        mock_cm2.__enter__.return_value = mock_resp2

        mock_urlopen.side_effect = [mock_cm1, mock_cm2]

        videos = fetch_playlist_videos("PL12345ABCDE123", api_key="dummy_key")
        self.assertEqual(len(videos), 2)
        self.assertEqual(videos[0]["youtube_video_id"], "vid_1")
        self.assertEqual(videos[0]["availability"], "available")
        self.assertEqual(videos[1]["youtube_video_id"], "vid_2")
        self.assertEqual(videos[1]["availability"], "available")

    @patch("urllib.request.urlopen")
    def test_fetch_playlist_videos_with_deleted_or_private(self, mock_urlopen):
        response_data = {
            "items": [
                {
                    "id": "item_1",
                    "snippet": {
                        "resourceId": {"videoId": "vid_1"},
                        "title": "Grand Finals",
                    },
                    "status": {"privacyStatus": "public"},
                },
                {
                    "id": "item_2",
                    "snippet": {
                        "resourceId": {"videoId": "vid_2"},
                        "title": "Private video",
                    },
                    "status": {"privacyStatus": "private"},
                },
                {
                    "id": "item_3",
                    "snippet": {
                        "title": "Deleted video",
                    },
                    "status": {"privacyStatus": "public"},
                },
            ]
        }
        mock_cm = MagicMock()
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(response_data).encode("utf-8")
        mock_cm.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_cm

        videos = fetch_playlist_videos("PL12345ABCDE123", api_key="dummy_key")
        self.assertEqual(len(videos), 3)
        self.assertEqual(videos[0]["availability"], "available")
        self.assertEqual(videos[1]["availability"], "unavailable")
        self.assertEqual(videos[2]["availability"], "unavailable")


class TestVODDatabaseAndSync(unittest.TestCase):
    """Test database schema, migration, idempotent synchronization, and match associations."""

    def setUp(self):
        self.temp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.db_path = self.temp_db.name
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row

        # Setup minimal schema
        self.conn.executescript("""
            CREATE TABLE tournaments (
                slug TEXT PRIMARY KEY,
                startgg_id TEXT,
                name TEXT,
                start_at INTEGER
            );
            CREATE TABLE videogames (slug TEXT PRIMARY KEY, name TEXT);
            CREATE TABLE events (
                id TEXT PRIMARY KEY,
                tournament_slug TEXT,
                videogame_slug TEXT,
                name TEXT,
                num_entrants INTEGER,
                source_url TEXT,
                is_temporary INTEGER DEFAULT 0
            );
            CREATE TABLE entrants (id TEXT PRIMARY KEY, event_id TEXT, name TEXT);
            CREATE TABLE participants (id TEXT PRIMARY KEY, player_id TEXT, gamer_tag TEXT);
            CREATE TABLE entrant_participants (entrant_id TEXT, participant_id TEXT, PRIMARY KEY(entrant_id, participant_id));
            CREATE TABLE event_standings (
                event_id TEXT,
                entrant_id TEXT,
                placement INTEGER,
                PRIMARY KEY (event_id, entrant_id)
            );
            CREATE TABLE sets (
                id TEXT PRIMARY KEY,
                event_id TEXT,
                phase_group_id TEXT,
                full_round_text TEXT,
                round INTEGER,
                identifier TEXT,
                display_score TEXT,
                winner_entrant_id TEXT,
                started_at INTEGER,
                start_at INTEGER,
                completed_at INTEGER
            );
            CREATE TABLE set_entrants (
                set_id TEXT,
                slot_id TEXT,
                slot_order INTEGER,
                entrant_id TEXT,
                score REAL,
                score_label TEXT,
                score_display TEXT,
                placement INTEGER,
                PRIMARY KEY (set_id, slot_order)
            );
            CREATE TABLE phases (id TEXT PRIMARY KEY, event_id TEXT, name TEXT, phase_order INTEGER);
            CREATE TABLE phase_groups (id TEXT PRIMARY KEY, phase_id TEXT);
        """)
        migrate_vod_schema(self.conn)

        # Seed event and match
        self.conn.execute("INSERT INTO tournaments VALUES ('tourney-1', '1000', 'Test Tournament', 1600000000)")
        self.conn.execute("INSERT INTO videogames VALUES ('game-1', 'Test Game')")
        self.conn.execute("INSERT INTO events (id, tournament_slug, videogame_slug, name) VALUES ('ev-100', 'tourney-1', 'game-1', 'Singles')")
        self.conn.execute("INSERT INTO entrants VALUES ('ent-1', 'ev-100', 'Player Alpha')")
        self.conn.execute("INSERT INTO entrants VALUES ('ent-2', 'ev-100', 'Player Beta')")
        self.conn.execute("INSERT INTO sets VALUES ('set-1', 'ev-100', NULL, 'Grand Finals', 1, 'GF', '3–1', 'ent-1', 1600000000, 1600000000, 1600001000)")
        self.conn.execute("INSERT INTO set_entrants VALUES ('set-1', 's1', 0, 'ent-1', 3, '3', '3', 1)")
        self.conn.execute("INSERT INTO set_entrants VALUES ('set-1', 's2', 1, 'ent-2', 1, '1', '1', 2)")
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        try:
            os.remove(self.db_path)
        except OSError:
            pass

    def test_schema_supports_multiple_vods_per_match(self):
        self.conn.execute("""
            INSERT INTO event_vods (event_id, match_id, youtube_video_id, youtube_title, status, availability, created_at, updated_at)
            VALUES ('ev-100', 'set-1', 'vid_gf_angle1', 'GF Angle 1', 'complete', 'available', 100, 100)
        """)
        self.conn.execute("""
            INSERT INTO event_vods (event_id, match_id, youtube_video_id, youtube_title, status, availability, created_at, updated_at)
            VALUES ('ev-100', 'set-1', 'vid_gf_angle2', 'GF Angle 2', 'complete', 'available', 101, 101)
        """)
        self.conn.commit()

        rows = self.conn.execute("SELECT youtube_video_id FROM event_vods WHERE match_id='set-1'").fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual({r[0] for r in rows}, {"vid_gf_angle1", "vid_gf_angle2"})

    def test_unique_constraint_on_event_and_video(self):
        self.conn.execute("""
            INSERT INTO event_vods (event_id, match_id, youtube_video_id, youtube_title, status, availability, created_at, updated_at)
            VALUES ('ev-100', 'set-1', 'vid_unique', 'Title', 'complete', 'available', 100, 100)
        """)
        self.conn.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute("""
                INSERT INTO event_vods (event_id, match_id, youtube_video_id, youtube_title, status, availability, created_at, updated_at)
                VALUES ('ev-100', 'set-1', 'vid_unique', 'Duplicate', 'complete', 'available', 102, 102)
            """)

    def test_idempotent_sync_preserves_associations(self):
        # 1. Initial insert of a mapped VOD
        self.conn.execute("""
            INSERT INTO event_vods (event_id, match_id, youtube_video_id, youtube_title, status, availability, created_at, updated_at)
            VALUES ('ev-100', 'set-1', 'vid_123', 'Old Title', 'complete', 'available', 100, 100)
        """)
        self.conn.commit()

        # 2. Simulate sync updating title but preserving match_id and status
        updated_title = "New Updated Title"
        self.conn.execute("""
            UPDATE event_vods SET youtube_title=?, updated_at=200 WHERE youtube_video_id='vid_123'
        """, (updated_title,))
        self.conn.commit()

        row = self.conn.execute("SELECT * FROM event_vods WHERE youtube_video_id='vid_123'").fetchone()
        self.assertEqual(row["youtube_title"], updated_title)
        self.assertEqual(row["match_id"], "set-1")
        self.assertEqual(row["status"], "complete")

    def test_write_event_details_attaches_sponsors(self):
        from scripts.build_player_profile import write_event_details
        from pathlib import Path
        import tempfile
        from unittest.mock import patch

        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS participants (
                id TEXT PRIMARY KEY,
                player_id TEXT,
                gamer_tag TEXT,
                prefix TEXT
            );
            CREATE TABLE IF NOT EXISTS entrant_participants (
                entrant_id TEXT,
                participant_id TEXT,
                PRIMARY KEY (entrant_id, participant_id)
            );
            CREATE TABLE IF NOT EXISTS event_standings (
                event_id TEXT,
                entrant_id TEXT,
                placement INTEGER,
                PRIMARY KEY (event_id, entrant_id)
            );
        """)
        # Add tournament start_at column if missing
        cols = [c[1] for c in self.conn.execute("PRAGMA table_info(tournaments)").fetchall()]
        if "start_at" not in cols:
            self.conn.execute("ALTER TABLE tournaments ADD COLUMN start_at INTEGER")
        if "startgg_id" not in cols:
            self.conn.execute("ALTER TABLE tournaments ADD COLUMN startgg_id TEXT")
        set_cols = [c[1] for c in self.conn.execute("PRAGMA table_info(sets)").fetchall()]
        if "started_at" not in set_cols:
            self.conn.execute("ALTER TABLE sets ADD COLUMN started_at INTEGER")
        if "start_at" not in set_cols:
            self.conn.execute("ALTER TABLE sets ADD COLUMN start_at INTEGER")
        if "completed_at" not in set_cols:
            self.conn.execute("ALTER TABLE sets ADD COLUMN completed_at INTEGER")
        ev_cols = [c[1] for c in self.conn.execute("PRAGMA table_info(events)").fetchall()]
        if "num_entrants" not in ev_cols:
            self.conn.execute("ALTER TABLE events ADD COLUMN num_entrants INTEGER")
        if "source_url" not in ev_cols:
            self.conn.execute("ALTER TABLE events ADD COLUMN source_url TEXT")
        if "is_temporary" not in ev_cols:
            self.conn.execute("ALTER TABLE events ADD COLUMN is_temporary INTEGER DEFAULT 0")

        self.conn.execute("INSERT INTO participants VALUES ('p-1', '101', 'Player Alpha')")
        self.conn.execute("INSERT INTO participants VALUES ('p-2', '102', 'Player Beta')")
        self.conn.execute("INSERT INTO entrant_participants VALUES ('ent-1', 'p-1')")
        self.conn.execute("INSERT INTO entrant_participants VALUES ('ent-2', 'p-2')")
        self.conn.execute("""
            INSERT INTO event_vods (event_id, match_id, youtube_video_id, youtube_title, status, availability, created_at, updated_at)
            VALUES ('ev-100', 'set-1', 'vid_match1', 'Alpha vs Beta', 'complete', 'available', 100, 100)
        """)
        self.conn.commit()

        mock_meta = {
            "101": {"sponsor": "SPON_A"},
            "102": {"sponsor": ""}
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_events_dir = Path(temp_dir) / "data" / "events"
            temp_events_dir.mkdir(parents=True, exist_ok=True)
            with patch("scripts.build_player_profile.PROJECT_ROOT", Path(temp_dir)), \
                 patch("scripts.build_player_profile.startgg_metadata", return_value=mock_meta):
                write_event_details(self.conn)

            event_json_path = temp_events_dir / "tourney-1.json"
            self.assertTrue(event_json_path.is_file())
            with event_json_path.open() as f:
                event_data = json.load(f)

            self.assertIn("vods", event_data)
            self.assertEqual(len(event_data["vods"]), 1)
            vod_entry = event_data["vods"][0]
            self.assertEqual(vod_entry["player1"]["sponsor"], "SPON_A")
            self.assertEqual(vod_entry["player2"]["sponsor"], "")

    def test_save_vods_updates_and_writes_event_details(self):
        """Regression test: verify updating VODs and calling write_event_details works without tuple TypeError."""
        from scripts.build_player_profile import write_event_details
        from pathlib import Path
        import tempfile
        from unittest.mock import patch

        # Insert a pending VOD record
        self.conn.execute("""
            INSERT INTO event_vods (event_id, match_id, youtube_video_id, youtube_title, status, availability, created_at, updated_at)
            VALUES ('ev-100', NULL, 'vid_save_test', 'Pending Match', 'pending', 'available', 100, 100)
        """)
        self.conn.commit()

        # Update VOD association as done by /api/admin/save-event-vods
        self.conn.execute(
            "UPDATE event_vods SET match_id=?, status=?, updated_at=? WHERE youtube_video_id=?",
            ('set-1', 'complete', 150, 'vid_save_test')
        )
        self.conn.commit()

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_events_dir = Path(temp_dir) / "data" / "events"
            temp_events_dir.mkdir(parents=True, exist_ok=True)
            with patch("scripts.build_player_profile.PROJECT_ROOT", Path(temp_dir)):
                # This call must not raise TypeError: tuple indices must be integers or slices, not str
                write_event_details(self.conn)

            event_json_path = temp_events_dir / "tourney-1.json"
            self.assertTrue(event_json_path.is_file())
            with event_json_path.open() as f:
                event_data = json.load(f)

            self.assertEqual(event_data["tournamentSlug"], "tourney-1")
            self.assertEqual(len(event_data["games"]), 1)
            self.assertEqual(event_data["games"][0]["slug"], "game-1")
            self.assertEqual(event_data["games"][0]["name"], "Test Game")
            self.assertIn("vods", event_data)
            self.assertTrue(any(v["videoId"] == "vid_save_test" for v in event_data["vods"]))


if __name__ == "__main__":
    unittest.main()
