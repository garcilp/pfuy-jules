"""Unit and integration tests for static date filtering and client-side ranking calculations.
Verifies date filtering across preset years, arbitrary date intervals, boundary dates,
and empty periods without SQLite or DB API dependencies.
"""

import json
import subprocess
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent

class TestStaticDateFiltering(unittest.TestCase):
    def run_js_calc(self, game, system, mode, start=None, end=None, player_id=None, weights=None):
        script = f"""
        const {{ ClientRankingEngine }} = require('./js/rankings-engine.js');
        const fs = require('fs');
        const data = JSON.parse(fs.readFileSync('data/rankings/data/{game}.json'));
        const engine = new ClientRankingEngine(data);
        const res = engine.calculate({json.dumps(system)}, {json.dumps(mode)}, {json.dumps(start)}, {json.dumps(end)}, {json.dumps(player_id)}, {json.dumps(weights)});
        console.log(JSON.stringify(res));
        """
        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        return json.loads(proc.stdout)

    def test_static_data_files_exist(self):
        """Ensures all static game data files exist and are valid JSON."""
        games = ["ultimate", "melee", "rivals-2", "rivals-of-aether", "project-plus"]
        for g in games:
            path = PROJECT_ROOT / "data" / "rankings" / "data" / f"{g}.json"
            self.assertTrue(path.is_file(), f"Missing static game data for {g}")
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.assertIn("sets", data)
            self.assertIn("placements", data)
            self.assertIn("latestTags", data)

    def test_historical_mode_matches_exported_snapshots(self):
        """Checks that historical calculation matches pre-generated static snapshots."""
        games = ["rivals-2", "project-plus"]
        systems = ["glicko2", "sof", "quality_wins", "loss_quality"]
        for g in games:
            for s in systems:
                js_res = self.run_js_calc(g, s, "historical")
                snapshot_file = PROJECT_ROOT / "data" / "rankings" / f"{g}-{s}-historical.json"
                if snapshot_file.is_file():
                    with open(snapshot_file, "r", encoding="utf-8") as f:
                        snap_data = json.load(f)
                    self.assertEqual(js_res["totalPlayers"], snap_data["totalPlayers"])
                    for p_js, p_snap in zip(js_res["rankings"][:5], snap_data["rankings"][:5]):
                        self.assertEqual(p_js["playerId"], p_snap["playerId"])
                        self.assertEqual(p_js["score"], p_snap["score"])
                        self.assertEqual(p_js["rank"], p_snap["rank"])

    def test_preset_years_date_filtering(self):
        """Verifies period_only filtering for 2024 and 2025."""
        res_2024 = self.run_js_calc("ultimate", "glicko2", "period_only", "2024-01-01", "2024-12-31")
        self.assertGreater(res_2024["totalPlayers"], 0)
        self.assertEqual(res_2024["startDate"], "2024-01-01")
        self.assertEqual(res_2024["endDate"], "2024-12-31")

        res_2025 = self.run_js_calc("ultimate", "glicko2", "period_only", "2025-01-01", "2025-12-31")
        self.assertGreater(res_2025["totalPlayers"], 0)
        self.assertEqual(res_2025["startDate"], "2025-01-01")
        self.assertEqual(res_2025["endDate"], "2025-12-31")

    def test_arbitrary_custom_date_range(self):
        """Verifies filtering with an arbitrary custom date range."""
        res = self.run_js_calc("ultimate", "glicko2", "period_only", "2024-06-01", "2024-08-31")
        self.assertGreater(res["totalPlayers"], 0)
        self.assertEqual(res["startDate"], "2024-06-01")
        self.assertEqual(res["endDate"], "2024-08-31")
        # Ensure rankings are properly indexed
        for i, p in enumerate(res["rankings"], 1):
            self.assertEqual(p["rank"], i)

    def test_boundary_single_day_interval(self):
        """Verifies single-day tournament boundary filtering."""
        # 2024-11-23 had a Rivals 2 tournament
        res = self.run_js_calc("rivals-2", "glicko2", "period_only", "2024-11-23", "2024-11-23")
        self.assertEqual(res["totalPlayers"], 21)
        self.assertEqual(res["rankings"][0]["rank"], 1)

    def test_empty_date_interval(self):
        """Verifies that an interval with no events produces 0 ranked players without error."""
        res = self.run_js_calc("rivals-2", "glicko2", "period_only", "2015-01-01", "2015-12-31")
        self.assertEqual(res["totalPlayers"], 0)
        self.assertEqual(res["totalResultsConsidered"], 0)
        self.assertEqual(len(res["rankings"]), 0)

    def test_period_performance_mode(self):
        """Verifies period_performance mode with baseline ratings and changes."""
        res = self.run_js_calc("rivals-2", "glicko2", "period_performance", "2025-01-01", "2025-12-31")
        self.assertGreater(res["totalPlayers"], 0)
        top = res["rankings"][0]
        self.assertIn("baselineScore", top)
        self.assertIn("change", top)

    def test_diagnostic_generation_without_backend(self):
        """Verifies that diagnostic traces are generated purely client-side from static data."""
        res = self.run_js_calc("ultimate", "glicko2", "historical", player_id="557903")
        self.assertIn("diagnostic", res)
        diag = res["diagnostic"]
        self.assertEqual(diag["playerId"], "557903")
        self.assertIn("history", diag)
        self.assertGreater(len(diag["history"]), 0)

if __name__ == "__main__":
    unittest.main()
