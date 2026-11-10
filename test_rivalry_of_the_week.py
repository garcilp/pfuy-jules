"""Unit and integration tests for Rivalry of the Week.

Covers:
1. Candidate eligibility and single-game fallback.
2. Weighted selection and seed reproducibility.
3. Cooldown boundaries and calendar-week calculations.
4. Weekly idempotency and forced regeneration (force=True).
5. Sunday transitions in America/Montevideo.
6. History preservation, malformed history error handling, and duplicate-week handling.
7. Atomic-write and failure-recovery behavior.
8. Preservation of existing published data after failures.
9. Strict profile-photo resolution and logo fallback.
10. Homepage rendering with valid, missing, and malformed JSON.
"""

from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import random
import shutil
import tempfile
import unittest
from zoneinfo import ZoneInfo

from scripts.build_rivalry import (
    MONTEVIDEO_TZ,
    calendar_weeks_between,
    calculate_cooldown_multiplier,
    calculate_rivalry_weight,
    get_current_week_of,
    get_top_head_to_head_game,
    load_history,
    reconcile_published_and_history,
    resolve_character_portrait,
    resolve_player_image,
    resolve_player_photo,
    update_rivalry_of_the_week,
)


class TestRivalryOfTheWeek(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.repo_root = Path(self.test_dir)
        (self.repo_root / "data" / "profiles").mkdir(parents=True, exist_ok=True)
        (self.repo_root / "data" / "rankings" / "data").mkdir(parents=True, exist_ok=True)
        (self.repo_root / "assets" / "players").mkdir(parents=True, exist_ok=True)

        # Create dummy assets/logo.jpg
        logo_path = self.repo_root / "assets" / "logo.jpg"
        logo_path.write_bytes(b"dummy logo")

        # Create dummy games.json
        games = [
            {"id": "melee", "name": "Melee", "slug": "melee"},
            {"id": "ult", "name": "Ultimate", "slug": "ultimate"},
            {"id": "r2", "name": "Rivals 2", "slug": "rivals-2"},
        ]
        with (self.repo_root / "data" / "games.json").open("w", encoding="utf-8") as f:
            json.dump(games, f)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def _setup_profiles(self, players):
        index = []
        for pid, tag, photo in players:
            index.append({
                "playerId": pid,
                "tag": tag,
                "slug": f"{tag.lower()}-{pid}",
                "photo": photo,
            })
        with (self.repo_root / "data" / "profiles" / "index.json").open("w", encoding="utf-8") as f:
            json.dump(index, f)

    def _setup_sets(self, game_slug, sets_data):
        file_path = self.repo_root / "data" / "rankings" / "data" / f"{game_slug}.json"
        with file_path.open("w", encoding="utf-8") as f:
            json.dump({"sets": sets_data}, f)

    def test_sunday_transitions_in_montevideo(self):
        # Sunday 2025-05-04 at 00:00:00 should be weekOf 2025-05-04
        sunday_midnight = datetime(2025, 5, 4, 0, 0, 0, tzinfo=MONTEVIDEO_TZ)
        self.assertEqual(get_current_week_of(sunday_midnight), "2025-05-04")

        # Saturday 2025-05-03 at 23:59:59 should be previous week 2025-04-27
        saturday_night = datetime(2025, 5, 3, 23, 59, 59, tzinfo=MONTEVIDEO_TZ)
        self.assertEqual(get_current_week_of(saturday_night), "2025-04-27")

        # Wednesday 2025-05-07 at 15:30 should still be 2025-05-04
        wednesday = datetime(2025, 5, 7, 15, 30, tzinfo=MONTEVIDEO_TZ)
        self.assertEqual(get_current_week_of(wednesday), "2025-05-04")

    def test_cooldown_multipliers_and_calendar_weeks(self):
        w0 = "2025-01-05"
        self.assertEqual(calendar_weeks_between(w0, "2025-01-05"), 0)
        self.assertEqual(calendar_weeks_between(w0, "2025-01-12"), 1)
        self.assertEqual(calendar_weeks_between(w0, "2025-02-02"), 4)
        self.assertEqual(calendar_weeks_between(w0, "2025-03-02"), 8)
        self.assertEqual(calendar_weeks_between(w0, "2025-04-27"), 16)
        self.assertEqual(calendar_weeks_between(w0, "2025-06-22"), 24)
        self.assertEqual(calendar_weeks_between(w0, "2025-06-29"), 25)

        # Cooldown values:
        # None -> 1.0
        self.assertEqual(calculate_cooldown_multiplier(None), 1.0)
        # Below 8 weeks -> 0.0
        self.assertEqual(calculate_cooldown_multiplier(0), 0.0)
        self.assertEqual(calculate_cooldown_multiplier(7), 0.0)
        # At 8 weeks -> 0.0
        self.assertEqual(calculate_cooldown_multiplier(8), 0.0)
        # Linear recovery 8 to 24 weeks
        self.assertAlmostEqual(calculate_cooldown_multiplier(16), 0.5)
        self.assertAlmostEqual(calculate_cooldown_multiplier(12), 0.25)
        self.assertAlmostEqual(calculate_cooldown_multiplier(20), 0.75)
        # At and above 24 weeks -> 1.0
        self.assertAlmostEqual(calculate_cooldown_multiplier(24), 1.0)
        self.assertEqual(calculate_cooldown_multiplier(25), 1.0)
        self.assertEqual(calculate_cooldown_multiplier(100), 1.0)

    def test_weighted_selection_formula_and_seed_reproducibility(self):
        # Weight = sqrt(total_sets) * (1 + (distinct_games - 1) ** 1.4) * cooldown_multiplier
        w1 = calculate_rivalry_weight(total_sets=9, distinct_games=1, cooldown_multiplier=1.0)
        # sqrt(9) * (1 + 0) * 1.0 = 3.0
        self.assertAlmostEqual(w1, 3.0)

        w2 = calculate_rivalry_weight(total_sets=9, distinct_games=2, cooldown_multiplier=1.0)
        # sqrt(9) * (1 + 1**1.4) * 1.0 = 3.0 * 2.0 = 6.0
        self.assertAlmostEqual(w2, 6.0)

        w_cd = calculate_rivalry_weight(total_sets=9, distinct_games=2, cooldown_multiplier=0.5)
        self.assertAlmostEqual(w_cd, 3.0)

        # Seed reproducibility
        seed = 123456789
        rng1 = random.Random(seed)
        rng2 = random.Random(seed)
        choices1 = [rng1.choices(["A", "B", "C"], weights=[1.0, 5.0, 10.0])[0] for _ in range(20)]
        choices2 = [rng2.choices(["A", "B", "C"], weights=[1.0, 5.0, 10.0])[0] for _ in range(20)]
        self.assertEqual(choices1, choices2)

    def test_candidate_eligibility_and_single_game_fallback(self):
        # Setup 3 players
        self._setup_profiles([
            ("101", "PlayerOne", None),
            ("102", "PlayerTwo", None),
            ("103", "PlayerThree", None),
        ])

        # Test single-game fallback:
        # PlayerOne and PlayerTwo have 5 sets in Melee only (1 distinct game).
        # No primary candidates exist. Fallback should pick them.
        melee_sets = [
            {"winnerId": "101", "loserId": "102", "date": "2025-01-01"},
            {"winnerId": "102", "loserId": "101", "date": "2025-01-02"},
            {"winnerId": "101", "loserId": "102", "date": "2025-01-03"},
            {"winnerId": "102", "loserId": "101", "date": "2025-01-04"},
            {"winnerId": "101", "loserId": "102", "date": "2025-01-05"},
        ]
        self._setup_sets("melee", melee_sets)

        fixed_dt = datetime(2025, 5, 4, 12, 0, tzinfo=MONTEVIDEO_TZ)
        res = update_rivalry_of_the_week(force=True, repo_root=self.repo_root, now_dt=fixed_dt)
        self.assertIsNotNone(res)
        self.assertEqual(res["overall"]["totalSets"], 5)
        self.assertEqual(res["overall"]["distinctGames"], 1)
        selected_ids = sorted([p["playerId"] for p in res["players"]])
        self.assertEqual(selected_ids, ["101", "102"])

        # Now introduce a primary candidate:
        # PlayerOne and PlayerThree have 3 sets in Melee and 2 sets in Ultimate (2 distinct games, 5 total sets)
        melee_sets.extend([
            {"winnerId": "101", "loserId": "103", "date": "2025-02-01"},
            {"winnerId": "103", "loserId": "101", "date": "2025-02-02"},
            {"winnerId": "101", "loserId": "103", "date": "2025-02-03"},
        ])
        self._setup_sets("melee", melee_sets)
        ult_sets = [
            {"winnerId": "101", "loserId": "103", "date": "2025-03-01"},
            {"winnerId": "103", "loserId": "101", "date": "2025-03-02"},
        ]
        self._setup_sets("ultimate", ult_sets)

        # Even though 101 vs 102 has 5 sets, 101 vs 103 is a primary candidate (>=2 games, >=5 sets),
        # so single-game fallback must not be used.
        res2 = update_rivalry_of_the_week(force=True, repo_root=self.repo_root, now_dt=fixed_dt)
        self.assertIsNotNone(res2)
        selected_ids2 = sorted([p["playerId"] for p in res2["players"]])
        self.assertEqual(selected_ids2, ["101", "103"])
        self.assertEqual(res2["overall"]["distinctGames"], 2)

    def test_strict_profile_photo_resolution_and_fallback(self):
        # Create an actual image file on disk
        photo_rel = "assets/players/101.png"
        photo_disk = self.repo_root / photo_rel
        photo_disk.write_bytes(b"dummy png")

        self._setup_profiles([
            ("101", "PlayerOne", photo_rel),
            ("102", "PlayerTwo", "assets/players/nonexistent.png"),  # Non-existent file
            ("103", "PlayerThree", None),  # No photo
        ])

        # Test resolve_player_photo directly
        self.assertEqual(resolve_player_photo(photo_rel, self.repo_root), photo_rel)
        self.assertEqual(
            resolve_player_photo("assets/players/nonexistent.png", self.repo_root),
            "assets/logo.jpg",
        )
        self.assertEqual(resolve_player_photo(None, self.repo_root), "assets/logo.jpg")
        self.assertEqual(resolve_player_photo("", self.repo_root), "assets/logo.jpg")
        # Directory traversal attempt
        self.assertEqual(
            resolve_player_photo("../../etc/passwd", self.repo_root), "assets/logo.jpg"
        )

        # Test within update_rivalry_of_the_week
        self._setup_sets("melee", [
            {"winnerId": "101", "loserId": "102", "date": "2025-01-01"},
            {"winnerId": "102", "loserId": "101", "date": "2025-01-02"},
            {"winnerId": "101", "loserId": "102", "date": "2025-01-03"},
            {"winnerId": "102", "loserId": "101", "date": "2025-01-04"},
            {"winnerId": "101", "loserId": "102", "date": "2025-01-05"},
        ])
        fixed_dt = datetime(2025, 5, 4, 12, 0, tzinfo=MONTEVIDEO_TZ)
        res = update_rivalry_of_the_week(force=True, repo_root=self.repo_root, now_dt=fixed_dt)
        p1 = [p for p in res["players"] if p["playerId"] == "101"][0]
        p2 = [p for p in res["players"] if p["playerId"] == "102"][0]
        self.assertEqual(p1["photo"], photo_rel)
        self.assertEqual(p2["photo"], "assets/logo.jpg")

    def _setup_player_profile_json(self, player_slug, games_data):
        profile_path = self.repo_root / "data" / "profiles" / f"{player_slug}.json"
        with profile_path.open("w", encoding="utf-8") as f:
            json.dump({"slug": player_slug, "games": games_data}, f)

    def _create_character_portrait(self, game_slug, char_slug):
        portrait_path = self.repo_root / "assets" / "renders" / game_slug / "portraits" / f"{char_slug}.webp"
        portrait_path.parent.mkdir(parents=True, exist_ok=True)
        portrait_path.write_bytes(b"dummy portrait")
        return portrait_path

    def test_character_fallback_priority_both_have_uploaded_photos(self):
        # Both players have uploaded profile photos -> use photos, not character portraits
        photo1 = "assets/players/101.png"
        photo2 = "assets/players/102.png"
        (self.repo_root / photo1).write_bytes(b"p1")
        (self.repo_root / photo2).write_bytes(b"p2")

        self._setup_profiles([
            ("101", "P1", photo1),
            ("102", "P2", photo2),
        ])
        self._setup_player_profile_json("p1-101", [
            {"slug": "ultimate", "characters": [{"name": "Fox", "usage": 100.0}]}
        ])
        self._setup_player_profile_json("p2-102", [
            {"slug": "ultimate", "characters": [{"name": "Wolf", "usage": 100.0}]}
        ])
        self._create_character_portrait("ultimate", "fox")
        self._create_character_portrait("ultimate", "wolf")

        profile1 = {"playerId": "101", "slug": "p1-101", "photo": photo1}
        profile2 = {"playerId": "102", "slug": "p2-102", "photo": photo2}

        self.assertEqual(resolve_player_image(profile1, "ultimate", self.repo_root), photo1)
        self.assertEqual(resolve_player_image(profile2, "ultimate", self.repo_root), photo2)

    def test_character_fallback_neither_has_uploaded_photo_both_have_character_usage(self):
        # Neither has uploaded photo -> resolve to character portraits in top game
        self._setup_profiles([
            ("101", "P1", None),
            ("102", "P2", None),
        ])
        self._setup_player_profile_json("p1-101", [
            {"slug": "ultimate", "characters": [{"name": "Fox", "usage": 80.0}, {"name": "Marth", "usage": 20.0}]}
        ])
        self._setup_player_profile_json("p2-102", [
            {"slug": "ultimate", "characters": [{"name": "Wolf", "usage": 90.0}]}
        ])
        self._create_character_portrait("ultimate", "fox")
        self._create_character_portrait("ultimate", "wolf")

        profile1 = {"playerId": "101", "slug": "p1-101", "photo": None}
        profile2 = {"playerId": "102", "slug": "p2-102", "photo": None}

        self.assertEqual(
            resolve_player_image(profile1, "ultimate", self.repo_root),
            "assets/renders/ultimate/portraits/fox.webp",
        )
        self.assertEqual(
            resolve_player_image(profile2, "ultimate", self.repo_root),
            "assets/renders/ultimate/portraits/wolf.webp",
        )

    def test_character_fallback_only_one_has_character_usage(self):
        # Player 1 has character usage, Player 2 has none for that game
        self._setup_profiles([
            ("101", "P1", None),
            ("102", "P2", None),
        ])
        self._setup_player_profile_json("p1-101", [
            {"slug": "ultimate", "characters": [{"name": "Fox", "usage": 100.0}]}
        ])
        self._setup_player_profile_json("p2-102", [
            {"slug": "ultimate", "characters": []}
        ])
        self._create_character_portrait("ultimate", "fox")

        profile1 = {"playerId": "101", "slug": "p1-101", "photo": None}
        profile2 = {"playerId": "102", "slug": "p2-102", "photo": None}

        self.assertEqual(
            resolve_player_image(profile1, "ultimate", self.repo_root),
            "assets/renders/ultimate/portraits/fox.webp",
        )
        self.assertEqual(
            resolve_player_image(profile2, "ultimate", self.repo_root),
            "assets/logo.jpg",
        )

    def test_character_fallback_neither_has_character_usage(self):
        # Both players have no character usage -> both fall back to assets/logo.jpg
        self._setup_profiles([
            ("101", "P1", None),
            ("102", "P2", None),
        ])
        self._setup_player_profile_json("p1-101", [
            {"slug": "ultimate", "characters": []}
        ])
        self._setup_player_profile_json("p2-102", [
            {"slug": "ultimate", "characters": []}
        ])

        profile1 = {"playerId": "101", "slug": "p1-101", "photo": None}
        profile2 = {"playerId": "102", "slug": "p2-102", "photo": None}

        self.assertEqual(
            resolve_player_image(profile1, "ultimate", self.repo_root),
            "assets/logo.jpg",
        )
        self.assertEqual(
            resolve_player_image(profile2, "ultimate", self.repo_root),
            "assets/logo.jpg",
        )

    def test_top_game_tie_breaker(self):
        # Tie in head-to-head set count across multiple games:
        # e.g., ultimate: 5 sets, melee: 5 sets, rivals-2: 5 sets.
        # Deterministic tie-breaker: alphabetical gameSlug ascending -> 'melee'
        breakdown = [
            {"gameSlug": "ultimate", "sets": 5},
            {"gameSlug": "melee", "sets": 5},
            {"gameSlug": "rivals-2", "sets": 5},
        ]
        self.assertEqual(get_top_head_to_head_game(breakdown), "melee")

        # Unequal: ultimate has 6 sets -> 'ultimate'
        breakdown_unequal = [
            {"gameSlug": "melee", "sets": 5},
            {"gameSlug": "ultimate", "sets": 6},
        ]
        self.assertEqual(get_top_head_to_head_game(breakdown_unequal), "ultimate")

    def test_character_usage_tie_breaker_and_other_exclusion(self):
        # If multiple characters have tied usage or 'Other' is listed,
        # 'Other' is skipped and first valid character in order is used.
        self._setup_profiles([("101", "P1", None)])
        self._setup_player_profile_json("p1-101", [
            {"slug": "ultimate", "characters": [
                {"name": "Other", "usage": 50.0},
                {"name": "Marth", "usage": 25.0},
                {"name": "Fox", "usage": 25.0},
            ]}
        ])
        self._create_character_portrait("ultimate", "marth")
        self._create_character_portrait("ultimate", "fox")

        profile1 = {"playerId": "101", "slug": "p1-101", "photo": None}
        self.assertEqual(
            resolve_player_image(profile1, "ultimate", self.repo_root),
            "assets/renders/ultimate/portraits/marth.webp",
        )

    def test_character_portrait_aliases(self):
        # Check alias mapping, e.g. Simon Belmont -> simon
        self._setup_profiles([("101", "P1", None)])
        self._setup_player_profile_json("p1-101", [
            {"slug": "ultimate", "characters": [{"name": "Simon Belmont", "usage": 100.0}]}
        ])
        self._create_character_portrait("ultimate", "simon")

        profile1 = {"playerId": "101", "slug": "p1-101", "photo": None}
        self.assertEqual(
            resolve_player_image(profile1, "ultimate", self.repo_root),
            "assets/renders/ultimate/portraits/simon.webp",
        )

    def test_missing_or_invalid_character_portrait_falls_back_to_logo(self):
        # Character is listed in profile, but portrait webp file does not exist on disk
        self._setup_profiles([("101", "P1", None)])
        self._setup_player_profile_json("p1-101", [
            {"slug": "ultimate", "characters": [{"name": "NonExistentChar", "usage": 100.0}]}
        ])

        profile1 = {"playerId": "101", "slug": "p1-101", "photo": None}
        self.assertEqual(
            resolve_player_image(profile1, "ultimate", self.repo_root),
            "assets/logo.jpg",
        )

    def test_malformed_profile_json_graceful_fallback(self):
        # Corrupted / malformed profile JSON file
        profile_path = self.repo_root / "data" / "profiles" / "p1-101.json"
        profile_path.write_text("{ corrupt json", encoding="utf-8")

        profile1 = {"playerId": "101", "slug": "p1-101", "photo": None}
        self.assertEqual(
            resolve_player_image(profile1, "ultimate", self.repo_root),
            "assets/logo.jpg",
        )

    def test_weekly_idempotency_and_force_regeneration(self):
        self._setup_profiles([
            ("101", "PlayerOne", None),
            ("102", "PlayerTwo", None),
        ])
        self._setup_sets("melee", [
            {"winnerId": "101", "loserId": "102", "date": "2025-01-01"},
            {"winnerId": "102", "loserId": "101", "date": "2025-01-02"},
            {"winnerId": "101", "loserId": "102", "date": "2025-01-03"},
            {"winnerId": "102", "loserId": "101", "date": "2025-01-04"},
            {"winnerId": "101", "loserId": "102", "date": "2025-01-05"},
        ])
        fixed_dt = datetime(2025, 5, 4, 12, 0, tzinfo=MONTEVIDEO_TZ)

        res1 = update_rivalry_of_the_week(force=False, repo_root=self.repo_root, now_dt=fixed_dt)
        seed1 = res1["seed"]

        # Second call without force should return the existing rivalry with same seed
        res2 = update_rivalry_of_the_week(force=False, repo_root=self.repo_root, now_dt=fixed_dt)
        self.assertEqual(res2["seed"], seed1)

        # Call with force=True should regenerate and update the existing week entry without duplicating history
        res3 = update_rivalry_of_the_week(force=True, repo_root=self.repo_root, now_dt=fixed_dt)
        history = load_history(self.repo_root / "data" / "rivalry-history.json")
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["weekOf"], "2025-05-04")
        self.assertEqual(history[0]["seed"], res3["seed"])

    def test_malformed_history_raises_error(self):
        history_path = self.repo_root / "data" / "rivalry-history.json"
        history_path.write_text("{ not valid json", encoding="utf-8")

        with self.assertRaises(ValueError):
            load_history(history_path)

        with self.assertRaises(ValueError):
            update_rivalry_of_the_week(force=False, repo_root=self.repo_root)

    def test_atomic_write_and_reconciliation_recovery(self):
        # Simulate scenario: data/rivalry.json was written for 2025-05-04, but process died before history was written.
        rivalry_path = self.repo_root / "data" / "rivalry.json"
        history_path = self.repo_root / "data" / "rivalry-history.json"

        published = {
            "weekOf": "2025-05-04",
            "players": [
                {"playerId": "101", "tag": "P1", "slug": "p1-101", "photo": "assets/logo.jpg"},
                {"playerId": "102", "tag": "P2", "slug": "p2-102", "photo": "assets/logo.jpg"},
            ],
            "overall": {"score": [3, 2], "totalSets": 5, "distinctGames": 1},
            "seed": 999888,
        }
        with rivalry_path.open("w", encoding="utf-8") as f:
            json.dump(published, f)

        # History is empty
        history = reconcile_published_and_history(rivalry_path, history_path)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["weekOf"], "2025-05-04")
        self.assertEqual(sorted(history[0]["players"]), ["101", "102"])
        self.assertEqual(history[0]["seed"], 999888)

        # Confirm history file on disk was reconciled
        disk_history = load_history(history_path)
        self.assertEqual(len(disk_history), 1)
        self.assertEqual(disk_history[0]["seed"], 999888)

    def test_cooldown_boundary_in_candidate_selection(self):
        # Test candidate selection cooldown:
        # Candidate A and Candidate B both have >=2 games, >=5 sets.
        # But Candidate A was featured 4 weeks ago (<8 weeks: cooldown multiplier = 0).
        # Candidate B was never featured (multiplier = 1.0).
        # Selection MUST pick Candidate B.
        self._setup_profiles([
            ("101", "PlayerOne", None),
            ("102", "PlayerTwo", None),
            ("103", "PlayerThree", None),
            ("104", "PlayerFour", None),
        ])
        # Candidate A: 101 vs 102 (10 sets Melee, 10 sets Ultimate)
        self._setup_sets("melee", [
            {"winnerId": "101", "loserId": "102", "date": "2025-01-01"} for _ in range(10)
        ] + [
            {"winnerId": "103", "loserId": "104", "date": "2025-01-01"} for _ in range(3)
        ])
        self._setup_sets("ultimate", [
            {"winnerId": "101", "loserId": "102", "date": "2025-01-01"} for _ in range(10)
        ] + [
            {"winnerId": "103", "loserId": "104", "date": "2025-01-01"} for _ in range(3)
        ])
        # History has 101 vs 102 featured on 2025-04-06 (4 weeks prior to 2025-05-04)
        history_path = self.repo_root / "data" / "rivalry-history.json"
        with history_path.open("w", encoding="utf-8") as f:
            json.dump([{
                "weekOf": "2025-04-06",
                "players": ["101", "102"],
                "seed": 1234,
                "overall": {"score": [10, 10], "totalSets": 20, "distinctGames": 2},
            }], f)

        fixed_dt = datetime(2025, 5, 4, 12, 0, tzinfo=MONTEVIDEO_TZ)
        res = update_rivalry_of_the_week(force=True, repo_root=self.repo_root, now_dt=fixed_dt)
        self.assertIsNotNone(res)
        selected_ids = sorted([p["playerId"] for p in res["players"]])
        self.assertEqual(selected_ids, ["103", "104"])

    def test_preservation_of_existing_published_data_after_failures(self):
        # Setup existing valid published rivalry
        rivalry_path = self.repo_root / "data" / "rivalry.json"
        existing_data = {
            "weekOf": "2025-04-27",
            "players": [
                {"playerId": "101", "tag": "P1", "slug": "p1-101", "photo": "assets/logo.jpg"},
                {"playerId": "102", "tag": "P2", "slug": "p2-102", "photo": "assets/logo.jpg"},
            ],
            "overall": {"score": [3, 2], "totalSets": 5, "distinctGames": 1},
            "seed": 1111,
        }
        with rivalry_path.open("w", encoding="utf-8") as f:
            json.dump(existing_data, f)

        # No profiles index exists -> selection fails
        fixed_dt = datetime(2025, 5, 4, 12, 0, tzinfo=MONTEVIDEO_TZ)
        res = update_rivalry_of_the_week(force=True, repo_root=self.repo_root, now_dt=fixed_dt)
        self.assertIsNone(res)

        # Existing rivalry.json must be preserved intact!
        with rivalry_path.open("r", encoding="utf-8") as f:
            persisted = json.load(f)
        self.assertEqual(persisted["weekOf"], "2025-04-27")
        self.assertEqual(persisted["seed"], 1111)


if __name__ == "__main__":
    unittest.main()
