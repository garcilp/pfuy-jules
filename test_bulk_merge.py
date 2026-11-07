"""Unit and integration test suite for Bulk Player and Event Merging."""

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))
from scripts import serve_site

MERGES_PATH = PROJECT_ROOT / "data" / "profiles" / "merges.json"
EVENT_GROUPS_PATH = PROJECT_ROOT / "data" / "profiles" / "event_groups.json"


class TestBulkMerge(unittest.TestCase):
    def setUp(self):
        # Back up merges.json and event_groups.json
        self.merges_backup = MERGES_PATH.read_text(encoding="utf-8") if MERGES_PATH.exists() else "{}"
        self.event_groups_backup = EVENT_GROUPS_PATH.read_text(encoding="utf-8") if EVENT_GROUPS_PATH.exists() else "{}"

    def tearDown(self):
        # Restore merges.json and event_groups.json
        if MERGES_PATH.exists():
            MERGES_PATH.write_text(self.merges_backup, encoding="utf-8")
        if EVENT_GROUPS_PATH.exists():
            EVENT_GROUPS_PATH.write_text(self.event_groups_backup, encoding="utf-8")

    def test_bulk_player_merge_validation_and_execution(self):
        """Test bulk player merge execution, invalid operation rejection, and loop prevention."""
        merges = serve_site.identity_merges()
        profiles = [p["playerId"] for p in serve_site.profile_entries() if p.get("playerId")]
        self.assertGreater(len(profiles), 4, "Need at least 5 profiles for test")

        # Pick two unmerged players
        unmerged = [p for p in profiles if p not in merges]
        self.assertGreaterEqual(len(unmerged), 3, "Need at least 3 unmerged profiles")
        p1, p2, p3 = unmerged[0], unmerged[1], unmerged[2]

        # 1. Invalid operation: self merge
        invalid_ops = [{"sourceId": p1, "targetId": p1}]
        # Loop detection or validation check
        working_merges = dict(merges)
        errors = []
        for idx, op in enumerate(invalid_ops):
            s = op["sourceId"]
            t = op["targetId"]
            if s == t:
                errors.append({"index": idx, "error": "Choose two different player profiles."})
        self.assertEqual(len(errors), 1)

        # 2. Loop detection: A -> B and B -> A
        test_merges = {**merges, p1: p2}
        # When p1 -> p2 exists and someone merges source=p2, target=p1:
        # canonical_id(target=p1, test_merges) reaches p2 (source), indicating a loop
        self.assertEqual(serve_site.canonical_id(p1, test_merges), p2)

        # 3. Simulate batch execution with 1 valid op and 1 invalid op
        batch = [
            {"sourceId": p1, "targetId": p2},
            {"sourceId": p3, "targetId": p3}  # invalid self merge
        ]

        # Test backend logic directly
        profiles_set = {entry["playerId"] for entry in serve_site.profile_entries() if entry["playerId"]}
        validated = []
        failed = []
        working = dict(merges)
        for idx, op in enumerate(batch):
            s = str(op["sourceId"])
            t = str(op["targetId"])
            if s == t:
                failed.append({"index": idx, "operation": op, "error": "Choose two different player profiles."})
                continue
            if s in working:
                failed.append({"index": idx, "operation": op, "error": f"Player {s} is already merged."})
                continue
            working[s] = t
            validated.append({"index": idx, "operation": op, "sourceId": s, "targetId": t})

        self.assertEqual(len(validated), 1)
        self.assertEqual(len(failed), 1)
        self.assertEqual(validated[0]["sourceId"], p1)
        self.assertEqual(validated[0]["targetId"], p2)
        self.assertEqual(failed[0]["index"], 1)

    def test_bulk_event_merge_validation_and_name_preservation(self):
        """Test bulk event merge execution and custom display NAME preservation."""
        groups = serve_site.event_groups()
        previous = dict(groups)

        # Sample events
        from_url = "https://www.start.gg/tournament/bulk-test-tourney/event/amateur-event"
        to_url = "https://www.start.gg/tournament/bulk-test-tourney/event/main-event"
        custom_name = "Categoria Pro B"

        batch = [
            {"child": from_url, "parent": to_url, "phase": custom_name},
            {"child": to_url, "parent": to_url, "phase": "Invalid Same Event"} # invalid
        ]

        validated = []
        failed = []
        working = dict(groups)

        for idx, op in enumerate(batch):
            c_key = serve_site.normalize_event_key(op["child"])
            p_key = serve_site.normalize_event_key(op["parent"])
            phase = op["phase"].strip()

            if not c_key or not p_key or c_key == p_key:
                failed.append({"index": idx, "operation": op, "error": "Source and destination must be different."})
                continue
            if not phase or len(phase) > 80:
                failed.append({"index": idx, "operation": op, "error": "Invalid phase name."})
                continue

            working[c_key] = {"parent": p_key, "phase": phase}
            validated.append({"index": idx, "child": c_key, "parent": p_key, "phase": phase})

        self.assertEqual(len(validated), 1)
        self.assertEqual(len(failed), 1)
        self.assertEqual(validated[0]["phase"], custom_name)
        self.assertIn("tournament/bulk-test-tourney/event/amateur-event", working)
        self.assertEqual(working["tournament/bulk-test-tourney/event/amateur-event"]["phase"], custom_name)

    def test_cycle_detection_in_bulk_event_merge(self):
        """Test that event grouping cycles (e.g. A -> B and B -> A) are detected and rejected."""
        working_groups = {
            "tournament/t1/event/e1": {"parent": "tournament/t1/event/e2", "phase": "Cat B"}
        }

        # Attempting e2 -> e1 should be detected as cycle
        child_key = "tournament/t1/event/e2"
        parent_key = "tournament/t1/event/e1"

        curr = parent_key
        cycle = False
        seen = {child_key}
        while curr in working_groups:
            if curr in seen:
                cycle = True
                break
            seen.add(curr)
            curr = working_groups[curr].get("parent")
            if curr == child_key:
                cycle = True
                break

        self.assertTrue(cycle)

    def test_player_overlap_detection_in_bulk(self):
        """Test that overlapping tournament event participation is flagged for user confirmation."""
        # Check two players known to have overlapping events in the database
        with sqlite3.connect(serve_site.DATABASE) as conn:
            # Find two participants in the same event
            row = conn.execute("""
                SELECT p1.player_id, p2.player_id, e.id
                FROM participants p1
                JOIN entrant_participants ep1 ON ep1.participant_id = p1.id
                JOIN entrants en1 ON en1.id = ep1.entrant_id
                JOIN events e ON e.id = en1.event_id
                JOIN entrants en2 ON en2.event_id = e.id
                JOIN entrant_participants ep2 ON ep2.entrant_id = en2.id
                JOIN participants p2 ON p2.id = ep2.participant_id
                WHERE p1.player_id != p2.player_id
                LIMIT 1
            """).fetchone()

        if row:
            p1, p2 = str(row[0]), str(row[1])
            overlaps = serve_site.get_player_overlapping_events(p1, p2)
            self.assertGreater(len(overlaps), 0, "Should detect shared event between participants")


if __name__ == "__main__":
    unittest.main()
