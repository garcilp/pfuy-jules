import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.fetch_events import get_processed_event_ids, main


class TestFetchEventsSkip(unittest.TestCase):
    def test_get_processed_event_ids_non_existent_db(self):
        non_existent = Path("/path/does/not/exist/db.sqlite3")
        self.assertEqual(get_processed_event_ids(non_existent), set())

    def test_get_processed_event_ids_with_db(self):
        with tempfile.NamedTemporaryFile(suffix=".sqlite3") as tmp_file:
            db_path = Path(tmp_file.name)
            conn = sqlite3.connect(db_path)
            conn.execute("CREATE TABLE import_markers (event_id TEXT PRIMARY KEY)")
            conn.execute("INSERT INTO import_markers VALUES ('12345')")
            conn.execute("INSERT INTO import_markers VALUES ('67890')")
            conn.commit()
            conn.close()

            processed = get_processed_event_ids(db_path)
            self.assertEqual(processed, {"12345", "67890"})

    @patch("scripts.fetch_events.fetch_event")
    @patch("scripts.fetch_events.fetch_entrants")
    @patch("scripts.fetch_events.fetch_standings")
    @patch("scripts.fetch_events.fetch_sets")
    @patch("scripts.fetch_events.fetch_phase_seeds")
    def test_main_skips_processed_event_with_local_event_json(
        self, mock_seeds, mock_sets, mock_standings, mock_entrants, mock_fetch_event
    ):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            db_path = tmp_path / "platfighters.sqlite3"
            conn = sqlite3.connect(db_path)
            conn.execute("CREATE TABLE import_markers (event_id TEXT PRIMARY KEY)")
            conn.execute("INSERT INTO import_markers VALUES ('358053')")
            conn.commit()
            conn.close()

            raw_dir = tmp_path / "startgg-data" / "raw"
            event_dir = raw_dir / "ultimate" / "tournament__test__event__test"
            event_dir.mkdir(parents=True, exist_ok=True)
            event_json = event_dir / "event.json"
            event_json.write_text(
                json.dumps({
                    "response": {
                        "data": {
                            "event": {
                                "id": 358053,
                                "name": "Test Event"
                            }
                        }
                    }
                }),
                encoding="utf-8"
            )

            manifest_file = tmp_path / "events.json"
            manifest_file.write_text(
                json.dumps({
                    "games": [
                        {
                            "name": "Ultimate",
                            "slug": "ultimate",
                            "events": [
                                "https://www.start.gg/tournament/test/event/test"
                            ]
                        }
                    ]
                }),
                encoding="utf-8"
            )

            with patch("scripts.fetch_events.DATABASE", db_path), \
                 patch("scripts.fetch_events.RAW_DIR", raw_dir), \
                 patch("scripts.fetch_events.MANIFEST", manifest_file), \
                 patch.dict("os.environ", {"STARTGG_API_TOKEN": "dummy_token"}), \
                 patch("sys.argv", ["fetch_events.py"]):
                main()

            mock_fetch_event.assert_not_called()
            mock_entrants.assert_not_called()
            mock_standings.assert_not_called()
            mock_sets.assert_not_called()
            mock_seeds.assert_not_called()

    @patch("scripts.fetch_events.fetch_event")
    @patch("scripts.fetch_events.fetch_entrants")
    @patch("scripts.fetch_events.fetch_standings")
    @patch("scripts.fetch_events.fetch_sets")
    @patch("scripts.fetch_events.fetch_phase_seeds")
    def test_main_forces_refetch_when_force_flag_passed(
        self, mock_seeds, mock_sets, mock_standings, mock_entrants, mock_fetch_event
    ):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            db_path = tmp_path / "platfighters.sqlite3"
            conn = sqlite3.connect(db_path)
            conn.execute("CREATE TABLE import_markers (event_id TEXT PRIMARY KEY)")
            conn.execute("INSERT INTO import_markers VALUES ('358053')")
            conn.commit()
            conn.close()

            raw_dir = tmp_path / "startgg-data" / "raw"
            event_dir = raw_dir / "ultimate" / "tournament__test__event__test"
            event_dir.mkdir(parents=True, exist_ok=True)
            event_json = event_dir / "event.json"
            event_json.write_text(
                json.dumps({
                    "response": {
                        "data": {
                            "event": {
                                "id": 358053,
                                "name": "Test Event"
                            }
                        }
                    }
                }),
                encoding="utf-8"
            )

            manifest_file = tmp_path / "events.json"
            manifest_file.write_text(
                json.dumps({
                    "games": [
                        {
                            "name": "Ultimate",
                            "slug": "ultimate",
                            "events": [
                                "https://www.start.gg/tournament/test/event/test"
                            ]
                        }
                    ]
                }),
                encoding="utf-8"
            )

            mock_fetch_event.return_value = {"id": 358053, "name": "Test Event"}
            mock_entrants.return_value = 10
            mock_standings.return_value = 10
            mock_sets.return_value = 5
            mock_seeds.return_value = 10

            with patch("scripts.fetch_events.DATABASE", db_path), \
                 patch("scripts.fetch_events.RAW_DIR", raw_dir), \
                 patch("scripts.fetch_events.MANIFEST", manifest_file), \
                 patch.dict("os.environ", {"STARTGG_API_TOKEN": "dummy_token"}), \
                 patch("sys.argv", ["fetch_events.py", "--force"]):
                main()

            mock_fetch_event.assert_called_once()
            mock_entrants.assert_called_once()
            mock_standings.assert_called_once()
            mock_sets.assert_called_once()
            mock_seeds.assert_called_once()


if __name__ == "__main__":
    unittest.main()
