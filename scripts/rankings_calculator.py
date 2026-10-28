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

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATABASE = PROJECT_ROOT / "startgg-data" / "platfighters.sqlite3"
PROFILE_DIR = PROJECT_ROOT / "data" / "profiles"
RANKINGS_DIR = PROJECT_ROOT / "data" / "rankings"
ALGORITHM_VERSION = "2.0.0"


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
        return datetime.fromtimestamp(value, timezone.utc).date().isoformat()
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
        """Update a player's rating for a single rating period.

        matches: list of tuples (opponent_r, opponent_rd, outcome_s)
                 outcome_s is 1.0 for win, 0.0 for loss.
        """
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

    def calculate(self, game_slug, system="glicko2", mode="historical", start_date=None, end_date=None, target_player_id=None, alpha=2.0):
        """Calculates rankings for a specific game, system, mode, and date range."""
        valid_sets = self.load_sets_for_game(game_slug)

        if system == "glicko2":
            return self._calculate_glicko2(valid_sets, mode, start_date, end_date, target_player_id, game_slug)
        elif system == "sof":
            return self._calculate_sof(valid_sets, mode, start_date, end_date, target_player_id, game_slug)
        elif system == "quality_wins":
            return self._calculate_quality_wins(valid_sets, mode, start_date, end_date, target_player_id, game_slug)
        elif system == "loss_quality":
            return self._calculate_loss_quality(valid_sets, mode, start_date, end_date, target_player_id, game_slug, alpha=alpha)
        else:
            raise ValueError(f"Unknown ranking system: {system}")

    # -------------------------------------------------------------------------
    # Pre-Match Glicko Rating Pre-pass
    # -------------------------------------------------------------------------

    def _compute_pre_match_glicko_ratings(self, sets):
        """Reconstructs pre-match Glicko-2 ratings for every set in chronological order by event.

        Returns (pre_match_ratings, event_field_strengths)
        pre_match_ratings: (setId, playerId) -> pre-match rating dict {"r": ..., "rd": ..., "vol": ...}
        event_field_strengths: eventId -> float (average pre-event Glicko-2 rating of participants)
        """
        calc = self.glicko_calc
        ratings = {}  # pid -> rating dict

        def get_rating(pid):
            if pid not in ratings:
                ratings[pid] = calc.initial_rating()
            return ratings[pid]

        event_sets_map = {}
        for s in sets:
            event_sets_map.setdefault(s["eventId"], []).append(s)

        pre_match_ratings = {}
        event_field_strengths = {}

        for e_id, e_sets in event_sets_map.items():
            event_players = set()
            for s in e_sets:
                event_players.add(s["winnerId"])
                event_players.add(s["loserId"])

            player_matches = {}
            set_pre_snapshots = {}

            for s in e_sets:
                w_id, l_id = s["winnerId"], s["loserId"]
                w_rat = get_rating(w_id)
                l_rat = get_rating(l_id)

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

    def _calculate_glicko2(self, sets, mode, start_date, end_date, target_player_id, game_slug):
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
                stats[pid] = {"wins": 0, "losses": 0, "matches": 0}
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
            })

        rankings.sort(key=lambda x: x["score"], reverse=True)
        for idx, item in enumerate(rankings, 1):
            item["rank"] = idx

        result = {
            "gameSlug": game_slug,
            "system": "glicko2",
            "mode": mode,
            "startDate": start_date,
            "endDate": end_date,
            "totalPlayers": len(rankings),
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
            result["diagnostic"] = {
                "playerId": target_player_id,
                "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                "playerRank": p_rank["rank"] if p_rank else None,
                "finalScore": p_rank["score"] if p_rank else None,
                "history": diagnostic_history.get(target_player_id, []),
            }

        return result

    # -------------------------------------------------------------------------
    # System 2: Strength of Field (SoF)
    # -------------------------------------------------------------------------

    def _calculate_sof(self, sets, mode, start_date, end_date, target_player_id, game_slug):
        """Evaluates opposition strength faced based strictly on average pre-match Glicko-2 opponent ratings."""
        pre_match_ratings, event_field_strengths = self._compute_pre_match_glicko_ratings(sets)
        calc = self.glicko_calc

        player_sof = {}
        diagnostic_history = {}

        for s in sets:
            s_date = s["date"]
            if end_date and s_date and s_date > end_date:
                continue

            if start_date and s_date and s_date < start_date:
                continue

            w_id, l_id = s["winnerId"], s["loserId"]
            w_pre = pre_match_ratings.get((s["setId"], w_id), calc.initial_rating())
            l_pre = pre_match_ratings.get((s["setId"], l_id), calc.initial_rating())

            w_pre_r = w_pre["r"]
            l_pre_r = l_pre["r"]

            for pid, is_win, opp_id, opp_pre_r in [
                (w_id, True, l_id, l_pre_r),
                (l_id, False, w_id, w_pre_r),
            ]:
                if pid not in player_sof:
                    player_sof[pid] = {
                        "oppRatings": [],
                        "wins": 0,
                        "losses": 0,
                        "events": set(),
                    }
                player_sof[pid]["oppRatings"].append(opp_pre_r)
                player_sof[pid]["events"].add(s["eventId"])
                if is_win:
                    player_sof[pid]["wins"] += 1
                else:
                    player_sof[pid]["losses"] += 1

                if target_player_id is None or pid == target_player_id:
                    trace = {
                        "setId": s["setId"],
                        "event": f"{s['tournamentName']} · {s['eventName']}",
                        "date": s["date"],
                        "phase": s["phaseName"],
                        "round": s["roundText"],
                        "opponentId": opp_id,
                        "opponentTag": self.latest_tags.get(opp_id, f"Player {opp_id}"),
                        "opponentPreRating": round(opp_pre_r, 1),
                        "outcome": "win" if is_win else "loss",
                        "contribution": round(opp_pre_r, 1),
                    }
                    diagnostic_history.setdefault(pid, []).append(trace)

        rankings = []
        for pid, data in player_sof.items():
            if not data["oppRatings"]:
                continue

            # Primary score = exact average pre-match Glicko-2 rating of opponents faced
            avg_opp_r = sum(data["oppRatings"]) / len(data["oppRatings"])
            total_matches = data["wins"] + data["losses"]
            win_rate = data["wins"] / total_matches if total_matches > 0 else 0.0

            player_events = data["events"]
            avg_field = (sum(event_field_strengths[e_id] for e_id in player_events if e_id in event_field_strengths) / len(player_events)) if player_events else 0.0

            rankings.append({
                "playerId": pid,
                "playerTag": self.latest_tags.get(pid, f"Player {pid}"),
                "score": round(avg_opp_r, 1),
                "avgOpponentRating": round(avg_opp_r, 1),
                "avgFieldStrength": round(avg_field, 1),
                "winRate": round(100.0 * win_rate, 1),
                "matches": total_matches,
                "wins": data["wins"],
                "losses": data["losses"],
                "events": len(player_events),
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
                "description": "Measures the strength of competition faced, calculated strictly as the average pre-match Glicko-2 rating of opponents actually faced in eligible matches.",
                "limitations": "Measures opposition strength faced, not overall player skill or tournament placement success.",
                "parameters": {
                    "primaryScore": "Average pre-match Glicko-2 rating of opponents faced in eligible matches",
                    "fieldStrengthContext": "Average pre-event Glicko-2 rating of entrants across attended events",
                },
            },
        }

        if target_player_id:
            p_rank = next((item for item in rankings if item["playerId"] == target_player_id), None)
            result["diagnostic"] = {
                "playerId": target_player_id,
                "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                "playerRank": p_rank["rank"] if p_rank else None,
                "finalScore": p_rank["score"] if p_rank else None,
                "history": diagnostic_history.get(target_player_id, []),
            }

        return result

    # -------------------------------------------------------------------------
    # System 3: Quality Wins
    # -------------------------------------------------------------------------

    def _calculate_quality_wins(self, sets, mode, start_date, end_date, target_player_id, game_slug):
        """Quality Wins: Sum of (1 - expected_score) across wins using pre-match Glicko ratings."""
        pre_match_ratings, _ = self._compute_pre_match_glicko_ratings(sets)
        calc = self.glicko_calc

        player_qw = {}
        diagnostic_history = {}

        for s in sets:
            s_date = s["date"]
            if end_date and s_date and s_date > end_date:
                continue

            if start_date and s_date and s_date < start_date:
                continue

            w_id, l_id = s["winnerId"], s["loserId"]
            w_pre = pre_match_ratings.get((s["setId"], w_id), calc.initial_rating())
            l_pre = pre_match_ratings.get((s["setId"], l_id), calc.initial_rating())

            # Expected score of winner before match
            e_win = calc.expected_score_original(w_pre["r"], w_pre["rd"], l_pre["r"], l_pre["rd"])
            credit = 1.0 - e_win

            if w_id not in player_qw:
                player_qw[w_id] = {
                    "totalQuality": 0.0,
                    "wins": 0,
                    "credits": [],
                }
            player_qw[w_id]["totalQuality"] += credit
            player_qw[w_id]["wins"] += 1
            player_qw[w_id]["credits"].append(credit)

            # Ensure loser exists in dataset tracking even if 0 quality wins
            if l_id not in player_qw:
                player_qw[l_id] = {
                    "totalQuality": 0.0,
                    "wins": 0,
                    "credits": [],
                }

            if target_player_id is None or w_id == target_player_id:
                trace = {
                    "setId": s["setId"],
                    "event": f"{s['tournamentName']} · {s['eventName']}",
                    "date": s["date"],
                    "phase": s["phaseName"],
                    "round": s["roundText"],
                    "opponentId": l_id,
                    "opponentTag": self.latest_tags.get(l_id, f"Player {l_id}"),
                    "opponentPreRating": round(l_pre["r"], 1),
                    "expectedScore": round(e_win, 3),
                    "credit": round(credit, 3),
                    "outcome": "win",
                }
                diagnostic_history.setdefault(w_id, []).append(trace)

        rankings = []
        for pid, data in player_qw.items():
            wins = data["wins"]
            total = data["totalQuality"]
            avg_credit = total / wins if wins > 0 else 0.0

            rankings.append({
                "playerId": pid,
                "playerTag": self.latest_tags.get(pid, f"Player {pid}"),
                "score": round(total, 2),
                "totalQualityWins": round(total, 2),
                "avgQualityWin": round(avg_credit, 3),
                "wins": wins,
                "matches": wins,  # Total wins evaluated
            })

        rankings.sort(key=lambda x: (x["score"], x["wins"]), reverse=True)
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
                "description": "Rewards victories based on opponent strength and pre-match expected score. Earns higher credit for defeating stronger opponents.",
                "limitations": "Cumulative metric rewarding victory volume against strong opponents. Does not penalize losses.",
                "parameters": {
                    "formula": "Sum of (1 - E_win) across eligible wins",
                    "expectedScoreFormula": "Glicko-2 E(mu_winner, mu_loser, phi_loser) using pre-match ratings",
                },
            },
        }

        if target_player_id:
            p_rank = next((item for item in rankings if item["playerId"] == target_player_id), None)
            result["diagnostic"] = {
                "playerId": target_player_id,
                "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                "playerRank": p_rank["rank"] if p_rank else None,
                "finalScore": p_rank["score"] if p_rank else None,
                "history": diagnostic_history.get(target_player_id, []),
            }

        return result

    # -------------------------------------------------------------------------
    # System 4: Loss Quality (Consistency Ranking)
    # -------------------------------------------------------------------------

    def _calculate_loss_quality(self, sets, mode, start_date, end_date, target_player_id, game_slug, alpha=2.0):
        """Loss Quality (Consistency): Measures competitive consistency relative to expectations.

        Penalty per loss = expected_score ^ alpha (using pre-match Glicko-2 expected win probability).
        Consistency score = 100 * (1 - total_loss_penalty / match_count), bounded [0, 100].
        Undefeated players receive a score of 100.
        """
        pre_match_ratings, _ = self._compute_pre_match_glicko_ratings(sets)
        calc = self.glicko_calc

        player_data = {}
        diagnostic_history = {}

        for s in sets:
            s_date = s["date"]
            if end_date and s_date and s_date > end_date:
                continue

            if start_date and s_date and s_date < start_date:
                continue

            w_id, l_id = s["winnerId"], s["loserId"]
            w_pre = pre_match_ratings.get((s["setId"], w_id), calc.initial_rating())
            l_pre = pre_match_ratings.get((s["setId"], l_id), calc.initial_rating())

            # Expected win probabilities before match
            e_win = calc.expected_score_original(w_pre["r"], w_pre["rd"], l_pre["r"], l_pre["rd"])
            e_loss = calc.expected_score_original(l_pre["r"], l_pre["rd"], w_pre["r"], w_pre["rd"])

            # Loss penalty for loser = expected_score ^ alpha
            loss_penalty = (e_loss ** alpha)

            # Record for winner (win = 0 penalty)
            if w_id not in player_data:
                player_data[w_id] = {"wins": 0, "losses": 0, "matches": 0, "totalPenalty": 0.0}
            player_data[w_id]["wins"] += 1
            player_data[w_id]["matches"] += 1

            # Record for loser
            if l_id not in player_data:
                player_data[l_id] = {"wins": 0, "losses": 0, "matches": 0, "totalPenalty": 0.0}
            player_data[l_id]["losses"] += 1
            player_data[l_id]["matches"] += 1
            player_data[l_id]["totalPenalty"] += loss_penalty

            # Diagnostic traces
            if target_player_id is None or w_id == target_player_id:
                trace_w = {
                    "setId": s["setId"],
                    "event": f"{s['tournamentName']} · {s['eventName']}",
                    "date": s["date"],
                    "phase": s["phaseName"],
                    "round": s["roundText"],
                    "opponentId": l_id,
                    "opponentTag": self.latest_tags.get(l_id, f"Player {l_id}"),
                    "opponentPreRating": round(l_pre["r"], 1),
                    "expectedScore": round(e_win, 3),
                    "penalty": 0.0,
                    "outcome": "win",
                }
                diagnostic_history.setdefault(w_id, []).append(trace_w)

            if target_player_id is None or l_id == target_player_id:
                trace_l = {
                    "setId": s["setId"],
                    "event": f"{s['tournamentName']} · {s['eventName']}",
                    "date": s["date"],
                    "phase": s["phaseName"],
                    "round": s["roundText"],
                    "opponentId": w_id,
                    "opponentTag": self.latest_tags.get(w_id, f"Player {w_id}"),
                    "opponentPreRating": round(w_pre["r"], 1),
                    "expectedScore": round(e_loss, 3),
                    "penalty": round(loss_penalty, 3),
                    "outcome": "loss",
                }
                diagnostic_history.setdefault(l_id, []).append(trace_l)

        rankings = []
        for pid, data in player_data.items():
            matches = data["matches"]
            if matches == 0:
                continue

            tot_penalty = data["totalPenalty"]
            avg_penalty = tot_penalty / matches if matches > 0 else 0.0

            consistency_score = max(0.0, min(100.0, 100.0 * (1.0 - tot_penalty / matches)))

            rankings.append({
                "playerId": pid,
                "playerTag": self.latest_tags.get(pid, f"Player {pid}"),
                "score": round(consistency_score, 1),
                "totalLossPenalty": round(tot_penalty, 3),
                "avgLossPenalty": round(avg_penalty, 3),
                "wins": data["wins"],
                "losses": data["losses"],
                "matches": matches,
                "winRate": round(100.0 * data["wins"] / max(1, matches), 1),
            })

        # Rank by consistency score descending, then match count descending
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
                "name": "Loss Quality (Consistency)",
                "description": "Measures competitive consistency relative to pre-match expectations. Lower penalties for expected losses to stronger opponents; higher penalties for unexpected upset losses. Undefeated players receive a score of 100.",
                "limitations": "Measures consistency relative to pre-match expectations rather than absolute skill. Undefeated players receive 100 regardless of sample size.",
                "parameters": {
                    "alpha": alpha,
                    "penaltyFormula": f"expected_score ^ {alpha} for losses, 0 for wins",
                    "scoreFormula": "100 * (1 - total_loss_penalty / eligible_matches) bounded [0, 100]",
                },
            },
        }

        if target_player_id:
            p_rank = next((item for item in rankings if item["playerId"] == target_player_id), None)
            result["diagnostic"] = {
                "playerId": target_player_id,
                "playerTag": self.latest_tags.get(target_player_id, f"Player {target_player_id}"),
                "playerRank": p_rank["rank"] if p_rank else None,
                "finalScore": p_rank["score"] if p_rank else None,
                "history": diagnostic_history.get(target_player_id, []),
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
