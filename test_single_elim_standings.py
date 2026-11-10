import sqlite3
import unittest
from scripts.build_player_profile import get_phase_standings


class TestSingleElimStandings(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self._init_schema()

    def tearDown(self):
        self.conn.close()

    def _init_schema(self):
        self.conn.executescript("""
            CREATE TABLE phases (
                id TEXT PRIMARY KEY,
                event_id TEXT,
                name TEXT,
                phase_order INTEGER,
                bracket_type TEXT,
                is_exhibition INTEGER
            );
            CREATE TABLE phase_groups (
                id TEXT PRIMARY KEY,
                phase_id TEXT
            );
            CREATE TABLE sets (
                id TEXT PRIMARY KEY,
                event_id TEXT,
                phase_group_id TEXT,
                winner_entrant_id TEXT,
                round INTEGER,
                full_round_text TEXT,
                w_placement INTEGER,
                l_placement INTEGER
            );
            CREATE TABLE set_entrants (
                set_id TEXT,
                entrant_id TEXT
            );
            CREATE TABLE entrants (
                id TEXT PRIMARY KEY,
                event_id TEXT,
                name TEXT
            );
            CREATE TABLE entrant_participants (
                entrant_id TEXT,
                participant_id TEXT
            );
            CREATE TABLE participants (
                id TEXT PRIMARY KEY,
                player_id TEXT,
                gamer_tag TEXT
            );
            CREATE TABLE set_games (
                id TEXT PRIMARY KEY,
                set_id TEXT
            );
            CREATE TABLE characters (
                id TEXT,
                videogame_slug TEXT,
                name TEXT
            );
            CREATE TABLE set_game_selections (
                set_game_id TEXT,
                entrant_id TEXT,
                videogame_slug TEXT,
                character_id TEXT
            );
        """)

    def _add_entrant(self, entrant_id, tag, player_id):
        self.conn.execute(
            "INSERT INTO entrants(id, event_id, name) VALUES (?, 'ev1', ?)",
            (entrant_id, tag),
        )
        self.conn.execute(
            "INSERT INTO entrant_participants(entrant_id, participant_id) VALUES (?, ?)",
            (entrant_id, f"p_{entrant_id}"),
        )
        self.conn.execute(
            "INSERT INTO participants(id, player_id, gamer_tag) VALUES (?, ?, ?)",
            (f"p_{entrant_id}", player_id, tag),
        )

    def test_single_elim_with_third_place_playoff(self):
        """Single elimination bracket with a 3rd place tiebreak match."""
        self.conn.execute(
            "INSERT INTO phases(id, event_id, name, bracket_type) VALUES ('ph1', 'ev1', 'Bracket B', 'SINGLE_ELIMINATION')"
        )
        self.conn.execute("INSERT INTO phase_groups(id, phase_id) VALUES ('pg1', 'ph1')")

        # 8 Entrants: e1 to e8
        for i in range(1, 9):
            self._add_entrant(f"e{i}", f"Player{i}", f"pid{i}")

        # Quarter-Finals: e1 vs e5, e2 vs e6, e3 vs e7, e4 vs e8
        # Losers get 5th place
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s_qf1', 'pg1', 'e1', 2, 'Quarter-Final', 3, 5)"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('s_qf1', 'e1'), ('s_qf1', 'e5')])

        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s_qf2', 'pg1', 'e2', 2, 'Quarter-Final', 3, 5)"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('s_qf2', 'e2'), ('s_qf2', 'e6')])

        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s_qf3', 'pg1', 'e3', 2, 'Quarter-Final', 3, 5)"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('s_qf3', 'e3'), ('s_qf3', 'e7')])

        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s_qf4', 'pg1', 'e4', 2, 'Quarter-Final', 3, 5)"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('s_qf4', 'e4'), ('s_qf4', 'e8')])

        # Semi-Finals: e1 vs e3, e2 vs e4
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s_sf1', 'pg1', 'e1', 3, 'Semi-Final', 2, 3)"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('s_sf1', 'e1'), ('s_sf1', 'e3')])

        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s_sf2', 'pg1', 'e2', 3, 'Semi-Final', 2, 3)"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('s_sf2', 'e2'), ('s_sf2', 'e4')])

        # Final: e1 beats e2 -> e1 is 1st, e2 is 2nd
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s_fin', 'pg1', 'e1', 4, 'Final', 1, 2)"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('s_fin', 'e1'), ('s_fin', 'e2')])

        # 3rd Place Tiebreak: e3 beats e4 -> e3 is 3rd, e4 is 4th
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s_3rd', 'pg1', 'e3', 5, '3rd Place Tiebreak', 3, 4)"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('s_3rd', 'e3'), ('s_3rd', 'e4')])

        standings = get_phase_standings(self.conn, 'ph1', 'ev1', 'ultimate', {}, {})
        self.assertEqual(len(standings), 8)

        placements = {s["tag"]: s["placement"] for s in standings}
        self.assertEqual(placements["Player1"], 1)
        self.assertEqual(placements["Player2"], 2)
        self.assertEqual(placements["Player3"], 3)
        self.assertEqual(placements["Player4"], 4)
        self.assertEqual(placements["Player5"], 5)
        self.assertEqual(placements["Player6"], 5)
        self.assertEqual(placements["Player7"], 5)
        self.assertEqual(placements["Player8"], 5)

    def test_single_elim_without_third_place_playoff(self):
        """Single elimination bracket without a 3rd place tiebreak match."""
        self.conn.execute(
            "INSERT INTO phases(id, event_id, name, bracket_type) VALUES ('ph2', 'ev1', 'Bracket B', 'SINGLE_ELIMINATION')"
        )
        self.conn.execute("INSERT INTO phase_groups(id, phase_id) VALUES ('pg2', 'ph2')")

        for i in range(1, 9):
            self._add_entrant(f"e2_{i}", f"Player{i}", f"pid2_{i}")

        # Quarter-Finals: e2_1 vs e2_5, e2_2 vs e2_6, e2_3 vs e2_7, e2_4 vs e2_8
        for i, (w, l) in enumerate([('e2_1', 'e2_5'), ('e2_2', 'e2_6'), ('e2_3', 'e2_7'), ('e2_4', 'e2_8')]):
            self.conn.execute(
                f"INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
                f"VALUES ('s2_qf{i}', 'pg2', '{w}', 2, 'Quarter-Final', 3, 5)"
            )
            self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [(f's2_qf{i}', w), (f's2_qf{i}', l)])

        # Semi-Finals: e2_1 beats e2_3, e2_2 beats e2_4
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s2_sf1', 'pg2', 'e2_1', 3, 'Semi-Final', 2, 3)"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('s2_sf1', 'e2_1'), ('s2_sf1', 'e2_3')])

        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s2_sf2', 'pg2', 'e2_2', 3, 'Semi-Final', 2, 3)"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('s2_sf2', 'e2_2'), ('s2_sf2', 'e2_4')])

        # Final: e2_1 beats e2_2
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s2_fin', 'pg2', 'e2_1', 4, 'Final', 1, 2)"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('s2_fin', 'e2_1'), ('s2_fin', 'e2_2')])

        # Note: No 3rd place match added
        standings = get_phase_standings(self.conn, 'ph2', 'ev1', 'ultimate', {}, {})
        self.assertEqual(len(standings), 8)

        placements = {s["tag"]: s["placement"] for s in standings}
        self.assertEqual(placements["Player1"], 1)
        self.assertEqual(placements["Player2"], 2)
        # Both semifinal losers share 3rd place
        self.assertEqual(placements["Player3"], 3)
        self.assertEqual(placements["Player4"], 3)
        self.assertEqual(placements["Player5"], 5)
        self.assertEqual(placements["Player6"], 5)
        self.assertEqual(placements["Player7"], 5)
        self.assertEqual(placements["Player8"], 5)

    def test_preserved_double_elimination_behavior(self):
        """Preserves existing Double Elimination round matching logic."""
        self.conn.execute(
            "INSERT INTO phases(id, event_id, name, bracket_type) VALUES ('ph_de', 'ev1', 'Bracket B', 'DOUBLE_ELIMINATION')"
        )
        self.conn.execute("INSERT INTO phase_groups(id, phase_id) VALUES ('pg_de', 'ph_de')")

        for i in range(1, 9):
            self._add_entrant(f"de_{i}", f"DE_Player{i}", f"de_pid{i}")

        # Grand Final: de_1 beats de_2
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text) "
            "VALUES ('de_gf', 'pg_de', 'de_1', 6, 'Grand Final')"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('de_gf', 'de_1'), ('de_gf', 'de_2')])

        # Losers Final: de_2 beats de_3 (loser is 3rd)
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text) "
            "VALUES ('de_lf', 'pg_de', 'de_2', -5, 'Losers Final')"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('de_lf', 'de_2'), ('de_lf', 'de_3')])

        # Losers Semi: de_3 beats de_4 (loser is 4th)
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text) "
            "VALUES ('de_ls', 'pg_de', 'de_3', -4, 'Losers Semi-Final')"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('de_ls', 'de_3'), ('de_ls', 'de_4')])

        # Losers Quarters: losers are 5th (de_5, de_6)
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text) "
            "VALUES ('de_lq1', 'pg_de', 'de_4', -3, 'Losers Quarter-Final')"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('de_lq1', 'de_4'), ('de_lq1', 'de_5')])

        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text) "
            "VALUES ('de_lq2', 'pg_de', 'de_3', -3, 'Losers Quarter-Final')"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('de_lq2', 'de_3'), ('de_lq2', 'de_6')])

        # Losers Round 3: losers are 7th (de_7, de_8)
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text) "
            "VALUES ('de_lr1', 'pg_de', 'de_5', -2, 'Losers Round 3')"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('de_lr1', 'de_5'), ('de_lr1', 'de_7')])

        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text) "
            "VALUES ('de_lr2', 'pg_de', 'de_6', -2, 'Losers Round 3')"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('de_lr2', 'de_6'), ('de_lr2', 'de_8')])

        standings = get_phase_standings(self.conn, 'ph_de', 'ev1', 'ultimate', {}, {})
        self.assertEqual(len(standings), 8)

        placements = {s["tag"]: s["placement"] for s in standings}
        self.assertEqual(placements["DE_Player1"], 1)
        self.assertEqual(placements["DE_Player2"], 2)
        self.assertEqual(placements["DE_Player3"], 3)
        self.assertEqual(placements["DE_Player4"], 4)
        self.assertEqual(placements["DE_Player5"], 5)
        self.assertEqual(placements["DE_Player6"], 5)
        self.assertEqual(placements["DE_Player7"], 7)
        self.assertEqual(placements["DE_Player8"], 7)

    def test_incomplete_and_missing_matches_handled_gracefully(self):
        """Sets with null winner, missing entrants, or null placements are handled gracefully."""
        self.conn.execute(
            "INSERT INTO phases(id, event_id, name, bracket_type) VALUES ('ph_inc', 'ev1', 'Bracket B', 'SINGLE_ELIMINATION')"
        )
        self.conn.execute("INSERT INTO phase_groups(id, phase_id) VALUES ('pg_inc', 'ph_inc')")

        self._add_entrant("ei_1", "PlayerI1", "pid_i1")
        self._add_entrant("ei_2", "PlayerI2", "pid_i2")

        # Incomplete set with no winner
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s_none', 'pg_inc', NULL, 1, 'Round 1', NULL, NULL)"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('s_none', 'ei_1'), ('s_none', 'ei_2')])

        # Set with only 1 entrant (bye / missing opponent)
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s_bye', 'pg_inc', 'ei_1', 2, 'Quarter-Final', 3, 5)"
        )
        self.conn.execute("INSERT INTO set_entrants(set_id, entrant_id) VALUES ('s_bye', 'ei_1')")

        # Valid final set
        self.conn.execute(
            "INSERT INTO sets(id, phase_group_id, winner_entrant_id, round, full_round_text, w_placement, l_placement) "
            "VALUES ('s_fin', 'pg_inc', 'ei_1', 3, 'Final', 1, 2)"
        )
        self.conn.executemany("INSERT INTO set_entrants(set_id, entrant_id) VALUES (?, ?)", [('s_fin', 'ei_1'), ('s_fin', 'ei_2')])

        standings = get_phase_standings(self.conn, 'ph_inc', 'ev1', 'ultimate', {}, {})
        self.assertEqual(len(standings), 2)
        placements = {s["tag"]: s["placement"] for s in standings}
        self.assertEqual(placements["PlayerI1"], 1)
        self.assertEqual(placements["PlayerI2"], 2)


if __name__ == "__main__":
    unittest.main()
