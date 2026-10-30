"""Platfighters.uy Ranking System Engine.

Calculates Glicko-2, Strength of Field (SoF), Quality Wins, and Loss Quality
rankings dynamically from SQLite set and event data.
"""

import argparse
import json
import math
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATABASE = PROJECT_ROOT / "startgg-data" / "platfighters.sqlite3"
PROFILE_DIR = PROJECT_ROOT / "data" / "profiles"
RANKINGS_DIR = PROJECT_ROOT / "data" / "rankings"
ALGORITHM_VERSION = "2.2.0"
MONTEVIDEO_TZ = ZoneInfo("America/Montevideo")


# -----------------------------------------------------------------------------
# Configuration & Helpers
# -----------------------------------------------------------------------------

def text_id(value):
    return None if value is None else str(value)


def normalize_event_key(value):
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    parsed = urlsplit(raw if "://" in raw else f"https://www.start.gg/{raw.lstrip('/')}")
    if parsed.netloc and parsed.netloc.lower() not in {"start.gg", "www.start.gg"}:
        return None
    parts = parsed.path.strip("/").lower().split("/")
    if len(parts) < 4 or parts[0] != "tournament" or parts[2] != "event":
        return None
    return "/".join(parts[:4])


def date_from_epoch(value):
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(value, MONTEVIDEO_TZ).date().isoformat()
    except (ValueError, OverflowError, OSError):
        return None


def identity_merges():
    path = PROFILE_DIR / "merges.json"
    if not path.is_file():
        path = PROFILE_DIR.parent / "player_merges.json"
    if not path.is_file():
        return {}
    try:
        with path.open(encoding="utf-8") as file:
            value = json.load(file)
        return {str(source): str(target) for source, target in value.items()}
    except (OSError, json.JSONDecodeError, AttributeError):
        return {}


def canonical_id(player_id, merges):
    current = str(player_id)
    seen = set()
    while current in merges and current not in seen:
        seen.add(current)
        current = merges[current]
    return current


def visibility_exclusions():
    path = PROFILE_DIR / "exclusions.json"
    try:
        with path.open(encoding="utf-8") as file:
            value = json.load(file)
        events = {key for item in value.get("events", [])
                  if (key := normalize_event_key(item))}
        player_games = value.get("playerGames", {})
        if not isinstance(player_games, dict):
            player_games = {}
        return {"events": events, "playerGames": player_games}
    except (OSError, json.JSONDecodeError, AttributeError, TypeError):
        return {"events": set(), "playerGames": {}}


def slot_score(row):
    for key in ("score_display", "score_label", "score"):
        value = row[key]
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def is_placeholder_set_score(*values):
    for value in values:
        if value is None:
            continue
        normalized = re.sub(r"\s+", "", str(value)).casefold()
        for dash in ("−", "–", "—", "﹣"):
            normalized = normalized.replace(dash, "-")
        if normalized in {"-1", "-score", "0-0", "score-score", "dq"}:
            return True
    return False


def parse_numeric_score(val):
    if val is None:
        return None
    try:
        v = float(val)
        return v if v >= 0 else None
    except (ValueError, TypeError):
        return None


def get_latest_player_tags(connection, merges):
    latest = {}
    rows = connection.execute(
        "SELECT p.player_id, p.gamer_tag FROM participants p "
        "JOIN entrant_participants ep ON ep.participant_id=p.id "
        "JOIN entrants en ON en.id=ep.entrant_id "
        "JOIN events e ON e.id=en.event_id "
        "JOIN tournaments t ON t.slug=e.tournament_slug "
        "WHERE p.player_id IS NOT NULL AND p.gamer_tag IS NOT NULL "
        "AND TRIM(p.gamer_tag) != '' AND LOWER(TRIM(p.gamer_tag)) != 'deleted user' "
        "ORDER BY COALESCE(t.start_at, 0) DESC, p.id DESC"
    )
    for row in rows:
        player_id = canonical_id(text_id(row["player_id"]), merges)
        latest.setdefault(player_id, row["gamer_tag"])
    return latest


# -----------------------------------------------------------------------------
# Glicko-2 Core Algorithm
# -----------------------------------------------------------------------------

class Glicko2Calculator:
    """Glicko-2 Rating Engine (Mark Glickman Paper)."""

    def __init__(self, r_0=1500.0, rd_0=350.0, vol_0=0.06, tau=0.5):
        self.r_0 = r_0
        self.rd_0 = rd_0
        self.vol_0 = vol_0
        self.tau = tau
        self.scale = 173.7178

    def initial_rating(self):
        return {"r": self.r_0, "rd": self.rd_0, "vol": self.vol_0}

    def conservative_score(self, r, rd):
        return r - 2.0 * rd

    def to_glicko2_scale(self, r, rd):
        return (r - self.r_0) / self.scale, rd / self.scale

    def to_original_scale(self, mu, phi):
        return mu * self.scale + self.r_0, phi * self.scale

    def g(self, phi):
        return 1.0 / math.sqrt(1.0 + 3.0 * (phi ** 2) / (math.pi ** 2))

    def E(self, mu, mu_j, phi_j):
        """Expected score of player with rating/RD (mu, phi) against opponent (mu_j, phi_j)."""
        return 1.0 / (1.0 + math.exp(-self.g(phi_j) * (mu - mu_j)))

    def expected_score_original(self, r1, rd1, r2, rd2):
        """Calculates expected win probability of player 1 (r1, rd1) against player 2 (r2, rd2)."""
        mu1, phi1 = self.to_glicko2_scale(r1, rd1)
        mu2, phi2 = self.to_glicko2_scale(r2, rd2)
        return self.E(mu1, mu2, phi2)

    def update_period(self, r, rd, vol, matches):
        """Update a player's rating for a single rating period."""
        mu, phi = self.to_glicko2_scale(r, rd)

        if not matches:
            phi_prime = math.sqrt(phi ** 2 + vol ** 2)
            r_prime, rd_prime = self.to_original_scale(mu, phi_prime)
            return {"r": r_prime, "rd": min(rd_prime, self.rd_0), "vol": vol}

        v_inv = 0.0
        delta_sum = 0.0

        for opp_r, opp_rd, outcome_s in matches:
            opp_mu, opp_phi = self.to_glicko2_scale(opp_r, opp_rd)
            g_opp = self.g(opp_phi)
            e_opp = self.E(mu, opp_mu, opp_phi)

            v_inv += (g_opp ** 2) * e_opp * (1.0 - e_opp)
            delta_sum += g_opp * (outcome_s - e_opp)

        v = 1.0 / v_inv
        delta = v * delta_sum

        a = math.log(vol ** 2)

        def f(x):
            ex = math.exp(x)
            d2 = delta ** 2
            p2 = phi ** 2
            num = ex * (d2 - p2 - v - ex)
            den = 2.0 * ((p2 + v + ex) ** 2)
            return (num / den) - ((x - a) / (self.tau ** 2))

        A = a
        if (delta ** 2) > (phi ** 2) + v:
            B = math.log((delta ** 2) - (phi ** 2) - v)
        else:
            k = 1
            while f(a - k * self.tau) < 0:
                k += 1
            B = a - k * self.tau

        f_A = f(A)
        f_B = f(B)

        while abs(B - A) > 1e-6:
            C = A + (A - B) * f_A / (f_B - f_A)
            f_C = f(C)
            if f_C * f_B <= 0:
                A = B
                f_A = f_B
            else:
                f_A = f_A / 2.0
            B = C
            f_B = f_C

        new_vol = math.exp(A / 2.0)

        phi_star = math.sqrt(phi ** 2 + new_vol ** 2)
        phi_prime = 1.0 / math.sqrt((1.0 / (phi_star ** 2)) + (1.0 / v))
        mu_prime = mu + (phi_prime ** 2) * delta_sum

        r_prime, rd_prime = self.to_original_scale(mu_prime, phi_prime)

        return {"r": r_prime, "rd": min(rd_prime, self.rd_0), "vol": new_vol}


# -----------------------------------------------------------------------------
# Main Ranking Computation Class
# -----------------------------------------------------------------------------

class RankingEngine:
    def __init__(self, connection=None):
        self.connection = connection or sqlite3.connect(DATABASE)
        self.connection.row_factory = sqlite3.Row
        self.merges = identity_merges()
        self.exclusions = visibility_exclusions()
        self.latest_tags = get_latest_player_tags(self.connection, self.merges)
        self.glicko_calc = Glicko2Calculator()

    def load_sets_for_game(self, game_slug):
        """Loads all valid sets for a game in chronological order with score details."""
        rows = self.connection.execute(
            "SELECT s.id AS set_id, s.event_id, s.winner_entrant_id, s.display_score, "
            "s.started_at, s.start_at, s.completed_at, "
            "e.source_url, e.name AS event_name, "
            "t.slug AS tournament_slug, t.name AS tournament_name, t.start_at AS tournament_start, "
            "ph.name AS phase_name, ph.phase_order, s.round "
            "FROM sets s "
            "JOIN events e ON e.id = s.event_id "
            "JOIN videogames v ON v.slug = e.videogame_slug "
            "JOIN tournaments t ON t.slug = e.tournament_slug "
            "LEFT JOIN phase_groups pg ON pg.id = s.phase_group_id "
            "LEFT JOIN phases ph ON ph.id = pg.phase_id "
            "WHERE e.videogame_slug = ? "
            "AND e.is_temporary = 0 "
            "ORDER BY COALESCE(s.started_at, s.start_at, s.completed_at, t.start_at, 0) ASC, "
            "e.id ASC, COALESCE(ph.phase_order, 999) ASC, COALESCE(s.round, 999) ASC, s.id ASC",
            (game_slug,),
        ).fetchall()

        valid_sets = []
        for row in rows:
            event_key = normalize_event_key(row["source_url"])
            if event_key and event_key in self.exclusions["events"]:
                continue

            winner_entrant = text_id(row["winner_entrant_id"])
            if not winner_entrant:
                continue

            entrants = self.connection.execute(
                "SELECT entrant_id, score_display, score_label, score "
                "FROM set_entrants WHERE set_id = ?",
                (text_id(row["set_id"]),),
            ).fetchall()

            if len(entrants) < 2:
                continue

            scores = [slot_score(e) for e in entrants]
            if is_placeholder_set_score(row["display_score"], *scores):
                continue

            entrant_players = {}
            entrant_scores = {}
            for e in entrants:
                eid = text_id(e["entrant_id"])
                p_row = self.connection.execute(
                    "SELECT p.player_id FROM entrant_participants ep "
                    "JOIN participants p ON p.id = ep.participant_id "
                    "WHERE ep.entrant_id = ? AND p.player_id IS NOT NULL",
                    (eid,),
                ).fetchone()
                if p_row and p_row["player_id"]:
                    c_id = canonical_id(text_id(p_row["player_id"]), self.merges)
                    entrant_players[eid] = c_id
                    entrant_scores[eid] = parse_numeric_score(e["score"])

            if len(entrant_players) < 2:
                continue

            winner_player = entrant_players.get(winner_entrant)
            loser_entrant = next((eid for eid in entrant_players if eid != winner_entrant), None)
            loser_player = entrant_players.get(loser_entrant) if loser_entrant else None

            if not winner_player or not loser_player or winner_player == loser_player:
                continue

            if game_slug in self.exclusions["playerGames"].get(winner_player, []) or \
               game_slug in self.exclusions["playerGames"].get(loser_player, []):
                continue

            ts = row["started_at"] or row["start_at"] or row["completed_at"] or row["tournament_start"]
            date_str = date_from_epoch(ts)

            winner_score = entrant_scores.get(winner_entrant)
            loser_score = entrant_scores.get(loser_entrant) if loser_entrant else None

            valid_sets.append({
                "setId": text_id(row["set_id"]),
                "eventId": text_id(row["event_id"]),
                "eventKey": event_key,
                "tournamentSlug": row["tournament_slug"],
                "eventName": row["event_name"],
                "tournamentName": row["tournament_name"],
                "date": date_str,
                "timestamp": ts or 0,
                "phaseName": row["phase_name"] or "Phase",
                "roundText": f"Round {row['round']}" if row["round"] is not None else "Set",
                "winnerId": winner_player,
                "loserId": loser_player,
                "winnerScore": winner_score,
                "loserScore": loser_score,
                "displayScore": row["display_score"],
            })

        return valid_sets

    def load_event_placements_for_game(self, game_slug):
        """Loads event standings and entrant counts for SoF calculations."""
        rows = self.connection.execute(
            "SELECT es.event_id, es.entrant_id, es.placement, e.num_entrants, "
            "e.source_url, e.name AS event_name, t.slug AS tournament_slug, t.name AS tournament_name, "
            "COALESCE(t.start_at, (SELECT MIN(COALESCE(s.started_at, s.start_at, s.completed_at)) "
            "FROM sets s WHERE s.event_id=e.id)) AS event_timestamp "
            "FROM event_standings es "
            "JOIN events e ON e.id = es.event_id "
            "JOIN tournaments t ON t.slug = e.tournament_slug "
            "WHERE e.videogame_slug = ? AND e.is_temporary = 0 AND es.placement IS NOT NULL "
            "ORDER BY event_timestamp ASC",
            (game_slug,),
        ).fetchall()

        event_placements = []
        for row in rows:
            event_key = normalize_event_key(row["source_url"])
            if event_key and event_key in self.exclusions["events"]:
                continue

            p_row = self.connection.execute(
                "SELECT p.player_id FROM entrant_participants ep "
                "JOIN participants p ON p.id = ep.participant_id "
                "WHERE ep.entrant_id = ? AND p.player_id IS NOT NULL",
                (text_id(row["entrant_id"]),),
            ).fetchone()

            if not p_row or not p_row["player_id"]:
                continue

            player_id = canonical_id(text_id(p_row["player_id"]), self.merges)
            if game_slug in self.exclusions["playerGames"].get(player_id, []):
                continue

            date_str = date_from_epoch(row["event_timestamp"])
            entrants_count = row["num_entrants"] or 1

            event_placements.append({
                "eventId": text_id(row["event_id"]),
                "eventKey": event_key,
                "tournamentSlug": row["tournament_slug"],
                "eventName": row["event_name"],
                "tournamentName": row["tournament_name"],
                "playerId": player_id,
                "placement": row["placement"],
                "entrants": entrants_count,
                "date": date_str,
                "timestamp": row["event_timestamp"] or 0,
            })

        return event_placements

    def calculate(self, game_slug, system="glicko2", mode="historical", start_date=None, end_date=None, target_player_id=None, alpha=2.0, weights=None):
        """Calculates rankings for a specific game, system, mode, and date range."""
        if start_date and end_date and start_date > end_date:
            raise ValueError("Start date must be before or on end date.")

        raw_target_player_id = text_id(target_player_id) if target_player_id is not None else None
        if target_player_id is not None:
            target_player_id = canonical_id(target_player_id, self.merges)

        valid_sets = self.load_sets_for_game(game_slug)

        if system == "glicko2":
            return self._calculate_glicko2(valid_sets, mode, start_date, end_date, target_player_id, game_slug, raw_target_player_id=raw_target_player_id)
        elif system == "sof":
            return self._calculate_sof(valid_sets, mode, start_date, end_date, target_player_id, game_slug, raw_target_player_id=raw_target_player_id)
        elif system == "quality_wins":
            return self._calculate_quality_wins(valid_sets, mode, start_date, end_date, target_player_id, game_slug, raw_target_player_id=raw_target_player_id)
        elif system == "loss_quality":
            return self._calculate_loss_quality(valid_sets, mode, start_date, end_date, target_player_id, game_slug, raw_target_player_id=raw_target_player_id)
        elif system in ("custom", "power_rankings"):
            return self._calculate_custom(valid_sets, mode, start_date, end_date, target_player_id, game_slug, weights=weights, raw_target_player_id=raw_target_player_id)
        else:
            raise ValueError(f"Unknown ranking system: {system}")

    # -------------------------------------------------------------------------
    # Pre-Match Glicko Rating Pre-pass
    # -------------------------------------------------------------------------

    def _compute_pre_match_glicko_ratings(self, sets, mode="historical", start_date=None):
        """Reconstructs pre-match Glicko-2 ratings for every set in chronological order by event.

        Respects calculation mode:
        - historical / period_performance: reconstruct ratings from start of history.
        - period_only: reset all initial ratings to neutral (1500, 350) for sets on/after start_date.
        """
        calc = self.glicko_calc
        ratings = {}

        def get_rating(pid, is_period_start=False):
            if pid not in ratings or (is_period_start and mode == "period_only"):
                ratings[pid] = calc.initial_rating()
            return ratings[pid]

        event_sets_map = {}
        for s in sets:
            event_sets_map.setdefault(s["eventId"], []).append(s)

        pre_match_ratings = {}
        event_field_strengths = {}

        for e_id, e_sets in event_sets_map.items():
            e_date = e_sets[0]["date"] if e_sets else None
            is_in_period = not (start_date and e_date and e_date < start_date)

            event_players = set()
            for s in e_sets:
                event_players.add(s["winnerId"])
                event_players.add(s["loserId"])

            player_matches = {}
            set_pre_snapshots = {}

            for s in e_sets:
                w_id, l_id = s["winnerId"], s["loserId"]
                w_rat = get_rating(w_id, is_period_start=(mode == "period_only" and is_in_period))
                l_rat = get_rating(l_id, is_period_start=(mode == "period_only" and is_in_period))

                set_pre_snapshots[(s["setId"], w_id)] = dict(w_rat)
                set_pre_snapshots[(s["setId"], l_id)] = dict(l_rat)

                player_matches.setdefault(w_id, []).append((l_rat["r"], l_rat["rd"], 1.0))
                player_matches.setdefault(l_id, []).append((w_rat["r"], w_rat["rd"], 0.0))

            pre_match_ratings.update(set_pre_snapshots)

            if event_players:
                event_field_strengths[e_id] = sum(get_rating(pid)["r"] for pid in event_players) / len(event_players)

            for pid, p_m in player_matches.items():
                ratings[pid] = calc.update_period(ratings[pid]["r"], ratings[pid]["rd"], ratings[pid]["vol"], p_m)

        return pre_match_ratings, event_field_strengths

    # -------------------------------------------------------------------------
    # System 1: Glicko-2 Player Skill Ratings
    # -------------------------------------------------------------------------

    def _calculate_glicko2(self, sets, mode, start_date, end_date, target_player_id, game_slug, raw_target_player_id=None):
        calc = self.glicko_calc

        pre_period_events = {}
        period_events = {}

        for s in sets:
            s_date = s["date"]
            if end_date and s_date and s_date > end_date:
                continue

            e_id = s["eventId"]
            if mode == "period_only":
                if start_date and s_date and s_date < start_date:
                    continue
                period_events.setdefault(e_id, []).append(s)
            elif mode == "period_performance":
                if start_date and s_date and s_date < start_date:
                    pre_period_events.setdefault(e_id, []).append(s)
                else:
                    period_events.setdefault(e_id, []).append(s)
            else:  # historical
                period_events.setdefault(e_id, []).append(s)

        ratings = {}
        stats = {}
        baseline_ratings = {}
        diagnostic_history = {}

        def get_rating(pid):
            if pid not in ratings:
                ratings[pid] = calc.initial_rating()
                stats[pid] = {"wins": 0, "losses": 0, "matches": 0, "events": set()}
            return ratings[pid]

        def process_event_dict(event_dict, is_period):
            for e_id, e_sets in event_dict.items():
                player_matches = {}
                set_pre_scores = {}

                for s in e_sets:
                    w_id = s["winnerId"]
                    l_id = s["loserId"]

                    w_rat = get_rating(w_id)
                    l_rat = get_rating(l_id)

                    set_pre_scores[s["setId"]] = {
                        w_id: (w_rat, calc.conservative_score(w_rat["r"], w_rat["rd"])),
                        l_id: (l_rat, calc.conservative_score(l_rat["r"], l_rat["rd"])),
                    }

                    player_matches.setdefault(w_id, []).append((l_rat["r"], l_rat["rd"], 1.0))
                    player_matches.setdefault(l_id, []).append((w_rat["r"], w_rat["rd"], 0.0))

                    if is_period:
                        stats[w_id]["wins"] += 1
                        stats[w_id]["matches"] += 1
                        stats[l_id]["losses"] += 1
                        stats[l_id]["matches"] += 1
                        stats[w_id]["events"].add(e_id)
                        stats[l_id]["events"].add(e_id)

                new_ratings = {}
                for pid, p_m in player_matches.items():
                    p_rat = ratings[pid]
                    new_ratings[pid] = calc.update_period(p_rat["r"], p_rat["rd"], p_rat["vol"], p_m)

                for pid, new_rat in new_ratings.items():
                    ratings[pid] = new_rat

                if is_period or target_player_id:
                    for s in e_sets:
                        w_id, l_id = s["winnerId"], s["loserId"]
                        w_pre_score = set_pre_scores[s["setId"]][w_id][1]
                        l_pre_score = set_pre_scores[s["setId"]][l_id][1]

                        w_post = calc.conservative_score(ratings[w_id]["r"], ratings[w_id]["rd"])
                        l_post = calc.conservative_score(ratings[l_id]["r"], ratings[l_id]["rd"])

                        for pid, is_win, pre, post, opp_id, opp_pre in [
                            (w_id, True, w_pre_score, w_post, l_id, l_pre_score),
                            (l_id, False, l_pre_score, l_post, w_id, w_pre_score),
                        ]:
                            if target_player_id is None or pid == target_player_id:
                                trace = {
                                    "setId": s["setId"],
                                    "event": f"{s['tournamentName']} · {s['eventName']}",
                                    "eventKey": s["eventKey"],
                                    "tournamentSlug": s["tournamentSlug"],
                                    "date": s["date"],
                                    "phase": s["phaseName"],
                                    "round": s["roundText"],
                                    "opponentId": opp_id,
                                    "opponentTag": self.latest_tags.get(opp_id, f"Player {opp_id}"),
                                    "opponentPreRating": round(opp_pre, 1),
                                    "outcome": "win" if is_win else "loss",
                                    "preScore": round(pre, 1),
                                    "postScore": round(post, 1),
                                    "change": round(post - pre, 1),
                                }
                                diagnostic_history.setdefault(pid, []).append(trace)

        if mode == "period_performance":
            process_event_dict(pre_period_events, is_period=False)
            for pid, r in ratings.items():
                baseline_ratings[pid] = calc.conservative_score(r["r"], r["rd"])

        process_event_dict(period_events, is_period=True)

        rankings = []
        for pid, r in ratings.items():
            if stats[pid]["matches"] == 0 and mode != "historical":
                continue

            score = calc.conservative_score(r["r"], r["rd"])
            base_score = baseline_ratings.get(pid, 0.0 if mode == "period_only" else calc.conservative_score(calc.r_0, calc.rd_0))
            change = score - base_score

            rankings.append({
                "playerId": pid,
                "playerTag": self.latest_tags.get(pid, f"Player {pid}"),
                "score": round(score, 1),
                "rating": round(r["r"], 1),
                "rd": round(r["rd"], 1),
                "volatility": round(r["vol"], 4),
                "baselineScore": round(base_score, 1),
                "change": round(change, 1),
                "matches": stats[pid]["matches"],
                "wins": stats[pid]["wins"],
                "losses": stats[pid]["losses"],
                "winRate": round(100.0 * stats[pid]["wins"] / max(1, stats[pid]["matches"]), 1),
                "events": len(stats[pid]["events"]),
            })

        rankings.sort(key=lambda x: x["score"], reverse=True)
        for idx, item in enumerate(rankings, 1):
            item["rank"] = idx

        total_sets_considered = sum(len(e) for e in period_events.values())

        result = {
            "gameSlug": game_slug,
            "system": "glicko2",
            "mode": mode,
            "startDate": start_date,
            "endDate": end_date,
            "totalPlayers": len(rankings),
            "totalResultsConsidered": total_sets_considered,
            "rankings": rankings,
            "algorithm": {
                "version": ALGORITHM_VERSION,
                "name": "Glicko-2",
                "description": "Measures player skill ratings (r, RD, volatility). Conservative rating = r - 2*RD.",
                "limitations": "Measures skill rating rather than cumulative event achievements or individual match closeness.",
                "parameters": {
                    "initialRating": calc.r_0,
                    "initialRD": calc.rd_0,
                    "initialVolatility": calc.vol_0,
                    "tau": calc.tau,
                    "formula": "r - 2 * RD",
                },
            },
        }

        if target_player_id:
            p_rank = next((item for item in rankings if item["playerId"] == target_player_id), None)
            p_hist = diagnostic_history.get(target_player_id, [])
            p_r = ratings.get(target_player_id, calc.initial_rating())
            p_stat = stats.get(target_player_id, {"wins": 0, "losses": 0, "matches": 0})
            final_sc = round(p_rank["score"], 1) if p_rank else None

            alg_params = {
                "tau": calc.tau,
                "initialRating": calc.r_0,
                "initialRD": calc.rd_0,
                "formula": "Conservative Rating = Rating (r) - 2 * Rating Deviation (RD)",
            }
            breakdown_dict = {
                "rating": round(p_r["r"], 1),
                "rd": round(p_r["rd"], 1),
                "volatility": round(p_r["vol"], 4),
                "conservativeScore": final_sc,
                "matches": p_stat["matches"],
                "wins": p_stat["wins"],
                "losses": p_stat["losses"],
            }

            result["diagnostic"] = {
                "context": {
                    "playerId": raw_target_player_id or target_player_id,
                    "canonicalPlayerId": canonical_id(target_player_id, self.merges),
                    "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                    "gameSlug": game_slug,
                    "system": "glicko2",
                    "mode": mode,
                    "startDate": start_date,
                    "endDate": end_date,
                    "finalScore": final_sc,
                    "rank": p_rank["rank"] if p_rank else None,
                    "totalResultsConsidered": total_sets_considered,
                    "totalResultsIncluded": p_stat["matches"],
                },
                "playerId": raw_target_player_id or target_player_id,
                "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                "playerRank": p_rank["rank"] if p_rank else None,
                "finalScore": final_sc,
                "totalMatches": p_stat["matches"],
                "wins": p_stat["wins"],
                "losses": p_stat["losses"],
                "algorithmParameters": alg_params,
                "breakdown": breakdown_dict,
                "evidence": {
                    "tournaments": [],
                    "matches": p_hist,
                },
                "history": p_hist,
                "events": [],
                "summary": {
                    "system": "glicko2",
                    "mode": mode,
                    "startDate": start_date,
                    "endDate": end_date,
                    "formula": "Conservative Rating = Rating (r) - 2 * Rating Deviation (RD)",
                    "parameters": alg_params,
                    "breakdown": breakdown_dict,
                },
            }

        return result

    # -------------------------------------------------------------------------
    # System 5: Custom Power Rankings
    # -------------------------------------------------------------------------

    def _calculate_custom(self, sets, mode, start_date, end_date, target_player_id, game_slug, weights=None, raw_target_player_id=None):
        """Power Rankings: Combines normalized component scores across Glicko-2, SoF, Quality Wins, and Loss Quality."""
        if weights is None:
            weights = {"glicko2": 50, "quality_wins": 25, "sof": 15, "loss_quality": 10}
        elif isinstance(weights, str):
            try:
                weights = json.loads(weights)
            except Exception:
                weights = {"glicko2": 50, "quality_wins": 25, "sof": 15, "loss_quality": 10}

        known_systems = ["glicko2", "quality_wins", "sof", "loss_quality"]
        clean_weights = {}
        for sys in known_systems:
            try:
                clean_weights[sys] = max(0.0, float(weights.get(sys, 0)))
            except (ValueError, TypeError):
                clean_weights[sys] = 0.0

        total_w = sum(clean_weights.values())
        if total_w > 0:
            clean_weights = {k: (v / total_w) * 100.0 for k, v in clean_weights.items()}
        else:
            clean_weights = {"glicko2": 25.0, "quality_wins": 25.0, "sof": 25.0, "loss_quality": 25.0}

        res_g2 = self._calculate_glicko2(sets, mode, start_date, end_date, None, game_slug)
        res_sof = self._calculate_sof(sets, mode, start_date, end_date, None, game_slug)
        res_qw = self._calculate_quality_wins(sets, mode, start_date, end_date, None, game_slug)
        res_lq = self._calculate_loss_quality(sets, mode, start_date, end_date, None, game_slug)

        sys_results = {
            "glicko2": res_g2,
            "sof": res_sof,
            "quality_wins": res_qw,
            "loss_quality": res_lq,
        }

        players_map = {}
        for sys_key, sys_res in sys_results.items():
            for p in sys_res.get("rankings", []):
                pid = p["playerId"]
                if pid not in players_map:
                    players_map[pid] = {
                        "playerId": pid,
                        "playerTag": p["playerTag"],
                        "rawScores": {},
                        "matches": 0,
                        "events": 0,
                    }
                players_map[pid]["rawScores"][sys_key] = p["score"]
                players_map[pid]["matches"] = max(players_map[pid]["matches"], p.get("matches", 0))
                players_map[pid]["events"] = max(players_map[pid]["events"], p.get("events", 0))

        stats_min_max = {}
        for sys_key in known_systems:
            scores = [p_info["rawScores"].get(sys_key, 0.0) for p_info in players_map.values()]
            if scores:
                stats_min_max[sys_key] = {"min": min(scores), "max": max(scores)}
            else:
                stats_min_max[sys_key] = {"min": 0.0, "max": 100.0}

        rankings = []
        for pid, p_info in players_map.items():
            norm_scores = {}
            weighted_contribs = {}
            final_score = 0.0

            for sys_key in known_systems:
                raw_val = p_info["rawScores"].get(sys_key, 0.0)
                mn = stats_min_max[sys_key]["min"]
                mx = stats_min_max[sys_key]["max"]
                if mx > mn:
                    norm_val = ((raw_val - mn) / (mx - mn)) * 100.0
                else:
                    norm_val = 100.0
                norm_scores[sys_key] = round(norm_val, 1)

                w = clean_weights[sys_key]
                contrib = norm_val * (w / 100.0)
                weighted_contribs[sys_key] = round(contrib, 2)
                final_score += contrib

            rankings.append({
                "playerId": pid,
                "playerTag": p_info["playerTag"],
                "score": round(final_score, 1),
                "normalizedScores": norm_scores,
                "weightedContributions": weighted_contribs,
                "weights": {k: round(v, 1) for k, v in clean_weights.items()},
                "matches": p_info["matches"],
                "events": p_info["events"],
            })

        rankings.sort(key=lambda x: x["score"], reverse=True)
        for idx, item in enumerate(rankings, 1):
            item["rank"] = idx

        result = {
            "gameSlug": game_slug,
            "system": "custom",
            "mode": mode,
            "startDate": start_date,
            "endDate": end_date,
            "totalPlayers": len(rankings),
            "weights": {k: round(v, 1) for k, v in clean_weights.items()},
            "rankings": rankings,
            "algorithm": {
                "version": ALGORITHM_VERSION,
                "name": "Power Rankings",
                "description": "Combines normalized component scores across Glicko-2, Strength of Field, Quality Wins, and Consistency into a custom weighted score.",
                "limitations": "Dependent on configured weighting budget and component normalization across eligible players.",
                "parameters": {
                    "weights": {k: f"{round(v, 1)}%" for k, v in clean_weights.items()},
                    "formula": "Final Score = Sum(NormalizedScore_k * Weight_k / 100)",
                },
            },
        }

        if target_player_id:
            p_rank = next((item for item in rankings if item["playerId"] == target_player_id), None)
            alg_params = {k: f"{round(v, 1)}%" for k, v in clean_weights.items()}
            breakdown_dict = {
                "finalScore": p_rank["score"] if p_rank else None,
                "normalizedScores": p_rank["normalizedScores"] if p_rank else {},
                "weightedContributions": p_rank["weightedContributions"] if p_rank else {},
                "weights": p_rank["weights"] if p_rank else {},
            }

            result["diagnostic"] = {
                "context": {
                    "playerId": raw_target_player_id or target_player_id,
                    "canonicalPlayerId": canonical_id(target_player_id, self.merges),
                    "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                    "gameSlug": game_slug,
                    "system": "custom",
                    "mode": mode,
                    "startDate": start_date,
                    "endDate": end_date,
                    "finalScore": p_rank["score"] if p_rank else None,
                    "rank": p_rank["rank"] if p_rank else None,
                    "totalResultsConsidered": len(sets),
                    "totalResultsIncluded": p_rank["matches"] if p_rank else 0,
                },
                "playerId": raw_target_player_id or target_player_id,
                "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                "playerRank": p_rank["rank"] if p_rank else None,
                "finalScore": p_rank["score"] if p_rank else None,
                "algorithmParameters": alg_params,
                "breakdown": breakdown_dict,
                "evidence": {
                    "tournaments": [],
                    "matches": [],
                },
                "events": [],
                "history": [],
                "summary": {
                    "system": "custom",
                    "mode": mode,
                    "startDate": start_date,
                    "endDate": end_date,
                    "formula": "Custom Score = Sum(NormalizedScore_k * Weight_k / 100)",
                    "parameters": alg_params,
                    "breakdown": breakdown_dict,
                },
            }

        return result

    # -------------------------------------------------------------------------
    # System 2: Strength of Field (SoF)
    # -------------------------------------------------------------------------

    def _calculate_sof(self, sets, mode, start_date, end_date, target_player_id, game_slug, raw_target_player_id=None):
        """Evaluates competitive accomplishments in tournaments against pre-event field strengths."""
        pre_match_ratings, event_field_strengths = self._compute_pre_match_glicko_ratings(sets, mode=mode, start_date=start_date)
        event_placements = self.load_event_placements_for_game(game_slug)

        player_events = {}
        for p in event_placements:
            p_date = p["date"]
            if end_date and p_date and p_date > end_date:
                continue
            if mode in ("period_only", "period_performance") and start_date and p_date and p_date < start_date:
                continue

            pid = p["playerId"]
            e_id = p["eventId"]
            f_strength = event_field_strengths.get(e_id, 1500.0)

            p_weight = 1.0 / math.sqrt(p["placement"])
            e_weight = math.log2(p["entrants"] + 1) / 3.0
            raw_pts = f_strength * p_weight * e_weight

            player_events.setdefault(pid, []).append({
                "eventId": e_id,
                "eventName": p["eventName"],
                "tournamentName": p["tournamentName"],
                "eventKey": p["eventKey"],
                "tournamentSlug": p["tournamentSlug"],
                "placement": p["placement"],
                "entrants": p["entrants"],
                "fieldStrength": round(f_strength, 1),
                "placementWeight": round(p_weight, 3),
                "entrantWeight": round(e_weight, 3),
                "eventPoints": round(raw_pts, 1),
                "date": p_date,
            })

        player_matches = {}
        diagnostic_history = {}

        for s in sets:
            s_date = s["date"]
            if end_date and s_date and s_date > end_date:
                continue
            if mode in ("period_only", "period_performance") and start_date and s_date and s_date < start_date:
                continue

            w_id, l_id = s["winnerId"], s["loserId"]
            player_matches.setdefault(w_id, []).append((s, True))
            player_matches.setdefault(l_id, []).append((s, False))

            for pid in (w_id, l_id):
                if target_player_id is None or pid == target_player_id:
                    opp_id = l_id if pid == w_id else w_id
                    opp_pre = pre_match_ratings.get((s["setId"], opp_id), self.glicko_calc.initial_rating())["r"]
                    trace = {
                        "setId": s["setId"],
                        "event": f"{s['tournamentName']} · {s['eventName']}",
                        "eventKey": s["eventKey"],
                        "tournamentSlug": s["tournamentSlug"],
                        "date": s["date"],
                        "phase": s["phaseName"],
                        "round": s["roundText"],
                        "opponentId": opp_id,
                        "opponentTag": self.latest_tags.get(opp_id, f"Player {opp_id}"),
                        "opponentPreRating": round(opp_pre, 1),
                        "outcome": "win" if pid == w_id else "loss",
                    }
                    diagnostic_history.setdefault(pid, []).append(trace)

        rankings = []
        for pid, evs in player_events.items():
            matches_info = player_matches.get(pid, [])
            m_count = len(matches_info)
            if m_count == 0:
                continue

            wins = sum(1 for m in matches_info if m[1])
            losses = m_count - wins

            event_pts = sum(e["eventPoints"] for e in evs)
            sample_dampener = min(1.0, m_count / 15.0)
            avg_event_score = (event_pts / len(evs)) * sample_dampener
            avg_field = sum(e["fieldStrength"] for e in evs) / len(evs) if evs else 1500.0

            rankings.append({
                "playerId": pid,
                "playerTag": self.latest_tags.get(pid, f"Player {pid}"),
                "score": round(avg_event_score, 1),
                "totalEventPoints": round(event_pts, 1),
                "avgFieldStrength": round(avg_field, 1),
                "sampleDampener": round(sample_dampener, 3),
                "winRate": round(100.0 * wins / max(1, m_count), 1),
                "matches": m_count,
                "wins": wins,
                "losses": losses,
                "events": len(evs),
            })

        rankings.sort(key=lambda x: (x["score"], x["matches"]), reverse=True)
        for idx, item in enumerate(rankings, 1):
            item["rank"] = idx

        result = {
            "gameSlug": game_slug,
            "system": "sof",
            "mode": mode,
            "startDate": start_date,
            "endDate": end_date,
            "totalPlayers": len(rankings),
            "rankings": rankings,
            "algorithm": {
                "version": ALGORITHM_VERSION,
                "name": "Strength of Field (SoF)",
                "description": "Evaluates competitive accomplishment relative to tournament field strengths, placements, and entrant scaling. Higher placements in strong fields earn top scores.",
                "limitations": "Measures tournament progression in strong fields rather than raw match win-rates.",
                "parameters": {
                    "eventAccomplishment": "FieldStrength * (1 / sqrt(placement)) * log2(entrants + 1) / 3.0",
                    "sampleDampening": "min(1.0, matches / 15.0)",
                },
            },
        }

        if target_player_id:
            p_rank = next((item for item in rankings if item["playerId"] == target_player_id), None)
            evs = player_events.get(target_player_id, [])
            hist = diagnostic_history.get(target_player_id, [])

            alg_params = {"minSampleMatches": 15}
            breakdown_dict = {
                "totalEventPoints": p_rank["totalEventPoints"] if p_rank else 0.0,
                "eventsCount": len(evs),
                "avgFieldStrength": p_rank["avgFieldStrength"] if p_rank else 0.0,
                "sampleDampener": p_rank["sampleDampener"] if p_rank else 0.0,
                "matches": p_rank["matches"] if p_rank else 0,
            }

            result["diagnostic"] = {
                "context": {
                    "playerId": raw_target_player_id or target_player_id,
                    "canonicalPlayerId": canonical_id(target_player_id, self.merges),
                    "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                    "gameSlug": game_slug,
                    "system": "sof",
                    "mode": mode,
                    "startDate": start_date,
                    "endDate": end_date,
                    "finalScore": p_rank["score"] if p_rank else None,
                    "rank": p_rank["rank"] if p_rank else None,
                    "totalResultsConsidered": len(event_placements),
                    "totalResultsIncluded": len(evs),
                },
                "playerId": raw_target_player_id or target_player_id,
                "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                "playerRank": p_rank["rank"] if p_rank else None,
                "finalScore": p_rank["score"] if p_rank else None,
                "totalMatches": p_rank["matches"] if p_rank else 0,
                "wins": p_rank["wins"] if p_rank else 0,
                "losses": p_rank["losses"] if p_rank else 0,
                "algorithmParameters": alg_params,
                "breakdown": breakdown_dict,
                "evidence": {
                    "tournaments": evs,
                    "matches": hist,
                },
                "events": evs,
                "history": hist,
                "summary": {
                    "system": "sof",
                    "mode": mode,
                    "startDate": start_date,
                    "endDate": end_date,
                    "formula": "Score = (Sum(EventPoints) / EventCount) * min(1.0, Matches / 15.0)",
                    "parameters": alg_params,
                    "breakdown": breakdown_dict,
                },
            }

        return result

    # -------------------------------------------------------------------------
    # System 3: Quality Wins
    # -------------------------------------------------------------------------

    def _calculate_quality_wins(self, sets, mode, start_date, end_date, target_player_id, game_slug, raw_target_player_id=None):
        """Quality Wins: Normalized average victory quality adjusted for sample confidence.

        Formula:
        q_i = max(0, (r_eff,opp - 1400) / 100) ^ 1.8
        r_eff,opp = r_opp - 0.25 * max(0, RD_opp - 50)
        Average Quality = Sum(q_i) / eligible_wins
        Adjusted QoW Score = Average Quality * (eligible_wins / (eligible_wins + 5.0)) * 20.0
        """
        pre_match_ratings, _ = self._compute_pre_match_glicko_ratings(sets, mode=mode, start_date=start_date)
        calc = self.glicko_calc
        provisional_threshold = 3
        confidence_m = 5.0
        scale_factor = 20.0

        player_qw = {}
        diagnostic_history = {}

        def safe_snapshot(snap):
            default = calc.initial_rating()
            if not isinstance(snap, dict):
                return default
            r = snap.get("r")
            rd = snap.get("rd")
            try:
                r_val = float(r) if r is not None else 1500.0
                rd_val = float(rd) if rd is not None else 350.0
                if math.isnan(r_val) or math.isinf(r_val):
                    r_val = 1500.0
                if math.isnan(rd_val) or math.isinf(rd_val):
                    rd_val = 350.0
                return {"r": r_val, "rd": rd_val, "vol": snap.get("vol", 0.06)}
            except (ValueError, TypeError):
                return default

        for s in sets:
            s_date = s["date"]
            if end_date and s_date and s_date > end_date:
                continue

            if mode in ("period_only", "period_performance") and start_date and s_date and s_date < start_date:
                continue

            w_id, l_id = s["winnerId"], s["loserId"]
            w_pre = safe_snapshot(pre_match_ratings.get((s["setId"], w_id)))
            l_pre = safe_snapshot(pre_match_ratings.get((s["setId"], l_id)))

            # Effective rating of loser: opponentRating - 0.25 * max(0, opponentRD - 50)
            eff_rating_l = l_pre["r"] - 0.25 * max(0.0, l_pre["rd"] - 50.0)
            q_points_w = math.pow(max(0.0, (eff_rating_l - 1400.0) / 100.0), 1.8)

            if w_id not in player_qw:
                player_qw[w_id] = {"totalQuality": 0.0, "wins": 0, "losses": 0, "points": [], "winOpponentRatingsSum": 0.0, "events": set()}
            player_qw[w_id]["totalQuality"] += q_points_w
            player_qw[w_id]["wins"] += 1
            player_qw[w_id]["points"].append(q_points_w)
            player_qw[w_id]["winOpponentRatingsSum"] += l_pre["r"]
            player_qw[w_id]["events"].add(s["eventId"])

            if l_id not in player_qw:
                player_qw[l_id] = {"totalQuality": 0.0, "wins": 0, "losses": 0, "points": [], "winOpponentRatingsSum": 0.0, "events": set()}
            player_qw[l_id]["losses"] += 1
            player_qw[l_id]["events"].add(s["eventId"])

            if target_player_id is None or w_id == target_player_id:
                trace = {
                    "setId": s["setId"],
                    "event": f"{s['tournamentName']} · {s['eventName']}",
                    "eventKey": s["eventKey"],
                    "tournamentSlug": s["tournamentSlug"],
                    "date": s["date"],
                    "phase": s["phaseName"],
                    "round": s["roundText"],
                    "opponentId": l_id,
                    "opponentTag": self.latest_tags.get(l_id, f"Player {l_id}"),
                    "playerPreRating": round(w_pre["r"], 1),
                    "opponentPreRating": round(l_pre["r"], 1),
                    "opponentPreRD": round(l_pre["rd"], 1),
                    "opponentEffectiveRating": round(eff_rating_l, 1),
                    "qualityPoints": round(q_points_w, 4),
                    "outcome": "win",
                    "isEligibleWin": True,
                    "exclusionReason": None,
                }
                diagnostic_history.setdefault(w_id, []).append(trace)

            if target_player_id is None or l_id == target_player_id:
                eff_rating_w = w_pre["r"] - 0.25 * max(0.0, w_pre["rd"] - 50.0)
                trace_l = {
                    "setId": s["setId"],
                    "event": f"{s['tournamentName']} · {s['eventName']}",
                    "eventKey": s["eventKey"],
                    "tournamentSlug": s["tournamentSlug"],
                    "date": s["date"],
                    "phase": s["phaseName"],
                    "round": s["roundText"],
                    "opponentId": w_id,
                    "opponentTag": self.latest_tags.get(w_id, f"Player {w_id}"),
                    "playerPreRating": round(l_pre["r"], 1),
                    "opponentPreRating": round(w_pre["r"], 1),
                    "opponentPreRD": round(w_pre["rd"], 1),
                    "opponentEffectiveRating": round(eff_rating_w, 1),
                    "qualityPoints": 0.0,
                    "outcome": "loss",
                    "isEligibleWin": False,
                    "exclusionReason": "Loss (only victories earn Quality Wins points)",
                }
                diagnostic_history.setdefault(l_id, []).append(trace_l)

        rankings = []
        for pid, data in player_qw.items():
            wins = data["wins"]
            losses = data["losses"]
            matches = wins + losses
            if wins == 0:
                continue

            unadjusted_tot_q = data["totalQuality"]
            avg_quality = unadjusted_tot_q / wins
            confidence_factor = wins / (wins + confidence_m)
            adjusted_score = avg_quality * confidence_factor * scale_factor

            avg_opp_rating = data["winOpponentRatingsSum"] / wins
            is_provisional = (wins < provisional_threshold)

            rankings.append({
                "playerId": pid,
                "playerTag": self.latest_tags.get(pid, f"Player {pid}"),
                "score": round(adjusted_score, 1),
                "rawScore": round(adjusted_score, 4),
                "avgOpponentQuality": round(avg_quality, 4),
                "confidenceFactor": round(confidence_factor, 4),
                "totalQualityWins": round(unadjusted_tot_q, 4),
                "avgOpponentWinRating": round(avg_opp_rating, 1),
                "wins": wins,
                "losses": losses,
                "matches": matches,
                "winRate": round(100.0 * wins / max(1, matches), 1),
                "isProvisional": is_provisional,
                "events": len(data["events"]),
            })

        rankings.sort(
            key=lambda x: (x["score"], x["wins"], x["matches"]),
            reverse=True,
        )
        for idx, item in enumerate(rankings, 1):
            item["rank"] = idx

        result = {
            "gameSlug": game_slug,
            "system": "quality_wins",
            "mode": mode,
            "startDate": start_date,
            "endDate": end_date,
            "totalPlayers": len(rankings),
            "rankings": rankings,
            "algorithm": {
                "version": ALGORITHM_VERSION,
                "name": "Quality Wins",
                "description": "Ranks players by average victory quality adjusted for sample confidence. Rewards beating strong opponents without volume inflation.",
                "limitations": "Evaluates defeated opponent quality density relative to a 1400 effective rating baseline.",
                "parameters": {
                    "victoryQualityFormula": "q_i = max(0, (r_eff,opp - 1400) / 100) ^ 1.8",
                    "effectiveRatingFormula": "r_opp - 0.25 * max(0, RD_opp - 50)",
                    "averageQualityFormula": "Sum(q_i) / eligible_wins",
                    "confidenceFactorFormula": "eligible_wins / (eligible_wins + 5.0)",
                    "scoreFormula": "Average Quality * Confidence Factor * 20.0",
                    "baseline": 1400,
                    "confidenceParam": confidence_m,
                    "scale": scale_factor,
                },
            },
        }

        if target_player_id:
            p_rank = next((item for item in rankings if item["playerId"] == target_player_id), None)
            hist = diagnostic_history.get(target_player_id, [])
            p_data = player_qw.get(target_player_id, {"totalQuality": 0.0, "wins": 0, "losses": 0, "winOpponentRatingsSum": 0.0})
            wins = p_data["wins"]
            losses = p_data["losses"]
            matches = wins + losses

            unadj_q = p_data["totalQuality"]
            avg_q = unadj_q / wins if wins > 0 else 0.0
            conf_f = wins / (wins + confidence_m) if wins > 0 else 0.0
            adj_sc = avg_q * conf_f * scale_factor if wins > 0 else 0.0

            alg_params = {
                "victoryQualityFormula": "q_i = max(0, (r_eff,opp - 1400) / 100) ^ 1.8",
                "effectiveRatingFormula": "r_opp - 0.25 * max(0, RD_opp - 50)",
                "confidenceFactorFormula": "eligible_wins / (eligible_wins + 5.0)",
                "scoreFormula": "Average Quality * Confidence Factor * 20.0",
                "baseline": 1400,
                "confidenceParam": confidence_m,
                "scale": scale_factor,
            }
            breakdown_dict = {
                "unadjustedTotalQuality": round(unadj_q, 4),
                "avgOpponentQuality": round(avg_q, 4),
                "confidenceFactor": round(conf_f, 4),
                "adjustedQualityWins": round(adj_sc, 4),
                "eligibleWins": wins,
                "losses": losses,
                "matches": matches,
                "avgOpponentWinRating": round(p_data["winOpponentRatingsSum"] / wins, 1) if wins > 0 else 0.0,
                "isProvisional": (0 < wins < 3),
                "isUnranked": (wins == 0),
            }

            result["diagnostic"] = {
                "context": {
                    "playerId": raw_target_player_id or target_player_id,
                    "canonicalPlayerId": canonical_id(target_player_id, self.merges),
                    "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                    "gameSlug": game_slug,
                    "system": "quality_wins",
                    "mode": mode,
                    "startDate": start_date,
                    "endDate": end_date,
                    "finalScore": p_rank["score"] if p_rank else (0.0 if wins > 0 else None),
                    "rank": p_rank["rank"] if p_rank else None,
                    "totalResultsConsidered": len(sets),
                    "totalResultsIncluded": matches,
                },
                "playerId": raw_target_player_id or target_player_id,
                "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                "playerRank": p_rank["rank"] if p_rank else None,
                "finalScore": p_rank["score"] if p_rank else (0.0 if wins > 0 else None),
                "totalMatches": matches,
                "wins": wins,
                "losses": losses,
                "algorithmParameters": alg_params,
                "breakdown": breakdown_dict,
                "evidence": {
                    "tournaments": [],
                    "matches": hist,
                },
                "events": [],
                "history": hist,
                "summary": {
                    "system": "quality_wins",
                    "mode": mode,
                    "startDate": start_date,
                    "endDate": end_date,
                    "formula": "Score = Average Quality * (eligible_wins / (eligible_wins + 5.0)) * 20.0",
                    "parameters": alg_params,
                    "breakdown": breakdown_dict,
                },
            }

        return result

    # -------------------------------------------------------------------------
    # System 4: Loss Quality (Consistency Ranking)
    # -------------------------------------------------------------------------

    def _calculate_loss_quality(self, sets, mode, start_date, end_date, target_player_id, game_slug, raw_target_player_id=None):
        """Consistency (Loss Quality / Upset Resistance):
        Evaluates player competitive consistency relative to pre-match Glicko-2 expectations.

        For each match:
        - Actual outcome S in {1.0, 0.0} (1.0 for win, 0.0 for loss).
        - Pre-match Glicko-2 win probability E in (0.0, 1.0).
        - Match performance contribution d = S - E:
          * Victory credit = + (1.0 - E) (rewards upset wins against stronger opponents)
          * Loss penalty = - E (minimal penalty -E ~ -0.1 for expected losses against elite rivals;
            heavy penalty -E ~ -0.9 for unexpected losses against weaker opponents)
        - Net Performance Points = Sum(S - E).
        - Consistency Score = 50.0 + 100.0 * NetPoints / (Matches + 20.0), dampening small sample sizes
          with Bayesian prior m = 20.0 toward neutral baseline 50.0.
        """
        pre_match_ratings, _ = self._compute_pre_match_glicko_ratings(sets, mode=mode, start_date=start_date)
        calc = self.glicko_calc

        player_data = {}
        diagnostic_history = {}

        for s in sets:
            s_date = s["date"]
            if end_date and s_date and s_date > end_date:
                continue

            if mode in ("period_only", "period_performance") and start_date and s_date and s_date < start_date:
                continue

            w_id, l_id = s["winnerId"], s["loserId"]
            w_pre = pre_match_ratings.get((s["setId"], w_id), calc.initial_rating())
            l_pre = pre_match_ratings.get((s["setId"], l_id), calc.initial_rating())

            e_win = calc.expected_score_original(w_pre["r"], w_pre["rd"], l_pre["r"], l_pre["rd"])
            e_loss = calc.expected_score_original(l_pre["r"], l_pre["rd"], w_pre["r"], w_pre["rd"])

            win_contrib = 1.0 - e_win
            loss_contrib = 0.0 - e_loss

            if w_id not in player_data:
                player_data[w_id] = {"wins": 0, "losses": 0, "matches": 0, "totalPoints": 0.0, "winCredits": 0.0, "lossPenalties": 0.0, "events": set()}
            player_data[w_id]["wins"] += 1
            player_data[w_id]["matches"] += 1
            player_data[w_id]["totalPoints"] += win_contrib
            player_data[w_id]["winCredits"] += win_contrib
            player_data[w_id]["events"].add(s["eventId"])

            if l_id not in player_data:
                player_data[l_id] = {"wins": 0, "losses": 0, "matches": 0, "totalPoints": 0.0, "winCredits": 0.0, "lossPenalties": 0.0, "events": set()}
            player_data[l_id]["losses"] += 1
            player_data[l_id]["matches"] += 1
            player_data[l_id]["totalPoints"] += loss_contrib
            player_data[l_id]["lossPenalties"] += abs(loss_contrib)
            player_data[l_id]["events"].add(s["eventId"])

            if target_player_id is None or w_id == target_player_id:
                trace_w = {
                    "setId": s["setId"],
                    "event": f"{s['tournamentName']} · {s['eventName']}",
                    "eventKey": s["eventKey"],
                    "tournamentSlug": s["tournamentSlug"],
                    "date": s["date"],
                    "phase": s["phaseName"],
                    "round": s["roundText"],
                    "opponentId": l_id,
                    "opponentTag": self.latest_tags.get(l_id, f"Player {l_id}"),
                    "opponentPreRating": round(l_pre["r"], 1),
                    "expectedScore": round(e_win, 3),
                    "credit": round(win_contrib, 3),
                    "contribution": round(win_contrib, 3),
                    "outcome": "win",
                }
                diagnostic_history.setdefault(w_id, []).append(trace_w)

            if target_player_id is None or l_id == target_player_id:
                trace_l = {
                    "setId": s["setId"],
                    "event": f"{s['tournamentName']} · {s['eventName']}",
                    "eventKey": s["eventKey"],
                    "tournamentSlug": s["tournamentSlug"],
                    "date": s["date"],
                    "phase": s["phaseName"],
                    "round": s["roundText"],
                    "opponentId": w_id,
                    "opponentTag": self.latest_tags.get(w_id, f"Player {w_id}"),
                    "opponentPreRating": round(w_pre["r"], 1),
                    "expectedScore": round(e_loss, 3),
                    "penalty": round(e_loss, 3),
                    "contribution": round(loss_contrib, 3),
                    "outcome": "loss",
                }
                diagnostic_history.setdefault(l_id, []).append(trace_l)

        dampener_m = 20.0
        rankings = []
        for pid, data in player_data.items():
            matches = data["matches"]
            if matches == 0:
                continue

            tot_pts = data["totalPoints"]
            consistency_score = round(50.0 + (100.0 * tot_pts / (matches + dampener_m)), 1)

            rankings.append({
                "playerId": pid,
                "playerTag": self.latest_tags.get(pid, f"Player {pid}"),
                "score": consistency_score,
                "totalPoints": round(tot_pts, 3),
                "winCredits": round(data["winCredits"], 3),
                "lossPenalties": round(data["lossPenalties"], 3),
                "wins": data["wins"],
                "losses": data["losses"],
                "matches": matches,
                "winRate": round(100.0 * data["wins"] / max(1, matches), 1),
                "events": len(data["events"]),
            })

        rankings.sort(key=lambda x: (x["score"], x["matches"]), reverse=True)
        for idx, item in enumerate(rankings, 1):
            item["rank"] = idx

        result = {
            "gameSlug": game_slug,
            "system": "loss_quality",
            "mode": mode,
            "startDate": start_date,
            "endDate": end_date,
            "totalPlayers": len(rankings),
            "rankings": rankings,
            "algorithm": {
                "version": ALGORITHM_VERSION,
                "name": "Performance vs. Expectation",
                "description": "Measures competitive performance relative to pre-match expectations. Score contribution equals actual minus expected result (S - E) with Bayesian sample-size dampening.",
                "limitations": "Measures performance relative to pre-match expectations rather than absolute skill rating.",
                "parameters": {
                    "matchContribution": "Actual - Expected (S - E)",
                    "sampleDampener": f"m = {dampener_m}",
                    "scoreFormula": f"50.0 + 100.0 * NetPoints / (Matches + {dampener_m})",
                },
            },
        }

        if target_player_id:
            p_rank = next((item for item in rankings if item["playerId"] == target_player_id), None)
            hist = diagnostic_history.get(target_player_id, [])

            alg_params = {
                "sampleDampener": dampener_m,
                "matchContribution": "Actual - Expected (S - E)",
            }
            breakdown_dict = {
                "winCreditsTotal": p_rank["winCredits"] if p_rank else 0.0,
                "lossPenaltiesTotal": p_rank["lossPenalties"] if p_rank else 0.0,
                "totalPoints": p_rank["totalPoints"] if p_rank else 0.0,
                "matches": p_rank["matches"] if p_rank else 0,
                "wins": p_rank["wins"] if p_rank else 0,
                "losses": p_rank["losses"] if p_rank else 0,
            }

            result["diagnostic"] = {
                "context": {
                    "playerId": raw_target_player_id or target_player_id,
                    "canonicalPlayerId": canonical_id(target_player_id, self.merges),
                    "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                    "gameSlug": game_slug,
                    "system": "loss_quality",
                    "mode": mode,
                    "startDate": start_date,
                    "endDate": end_date,
                    "finalScore": p_rank["score"] if p_rank else None,
                    "rank": p_rank["rank"] if p_rank else None,
                    "totalResultsConsidered": len(sets),
                    "totalResultsIncluded": p_rank["matches"] if p_rank else 0,
                },
                "playerId": raw_target_player_id or target_player_id,
                "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                "playerRank": p_rank["rank"] if p_rank else None,
                "finalScore": p_rank["score"] if p_rank else None,
                "totalMatches": p_rank["matches"] if p_rank else 0,
                "wins": p_rank["wins"] if p_rank else 0,
                "losses": p_rank["losses"] if p_rank else 0,
                "algorithmParameters": alg_params,
                "breakdown": breakdown_dict,
                "evidence": {
                    "tournaments": [],
                    "matches": hist,
                },
                "events": [],
                "history": hist,
                "summary": {
                    "system": "loss_quality",
                    "mode": mode,
                    "startDate": start_date,
                    "endDate": end_date,
                    "formula": f"Consistency Score = 50.0 + (100.0 * NetPoints / (Matches + {dampener_m}))",
                    "parameters": alg_params,
                    "breakdown": breakdown_dict,
                },
            }

        return result


# -----------------------------------------------------------------------------
# Pre-generation & Cache Export
# -----------------------------------------------------------------------------

def export_default_rankings():
    """Generates default ranking JSON files under data/rankings/ for static serving."""
    RANKINGS_DIR.mkdir(parents=True, exist_ok=True)
    engine = RankingEngine()

    games = ["ultimate", "rivals-of-aether", "melee", "rivals-2", "project-plus"]
    systems = ["glicko2", "sof", "quality_wins", "loss_quality"]

    count = 0
    for game in games:
        for system in systems:
            try:
                data = engine.calculate(game_slug=game, system=system, mode="historical")
                out_file = RANKINGS_DIR / f"{game}-{system}-historical.json"
                with out_file.open("w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                    f.write("\n")
                count += 1
            except Exception as err:
                print(f"Warning: could not export default rankings for {game} {system}: {err}")

    print(f"Wrote {count} default ranking snapshot files under {RANKINGS_DIR.relative_to(PROJECT_ROOT)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game", default="ultimate", help="game slug (e.g., ultimate, rivals-of-aether)")
    parser.add_argument("--system", default="glicko2", choices=["glicko2", "sof", "quality_wins", "loss_quality"], help="ranking system")
    parser.add_argument("--mode", default="historical", choices=["historical", "period_only", "period_performance"], help="calculation mode")
    parser.add_argument("--start", help="start date YYYY-MM-DD")
    parser.add_argument("--end", help="end date YYYY-MM-DD")
    parser.add_argument("--player-id", help="start.gg player ID for diagnostic output")
    parser.add_argument("--export-all", action="store_true", help="pre-generate default static ranking files")

    args = parser.parse_args()

    if args.export_all:
        export_default_rankings()
        return

    engine = RankingEngine()
    result = engine.calculate(
        game_slug=args.game,
        system=args.system,
        mode=args.mode,
        start_date=args.start,
        end_date=args.end,
        target_player_id=args.player_id,
    )

    print(json.dumps(result, indent=2, ensure_ascii=False)[:2000])
    print(f"\n... Total ranked players: {result['totalPlayers']}")


if __name__ == "__main__":
    main()
