"""Platfighters.uy Ranking System Engine.

Calculates TrueSkill, Glicko-2, Tournament Placings, and Strength of Field (SoF)
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
ALGORITHM_VERSION = "1.0.0"


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
# Math Algorithms
# -----------------------------------------------------------------------------

# Standard Normal Functions for TrueSkill
def phi(x):
    """Standard normal probability density function (PDF)."""
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def Phi(x):
    """Standard normal cumulative distribution function (CDF)."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def v_func(t):
    """TrueSkill mean update function V(t)."""
    cdf = Phi(t)
    if cdf < 1e-12:
        return -t
    return phi(t) / cdf


def w_func(t):
    """TrueSkill variance update function W(t)."""
    v = v_func(t)
    return v * (v + t)


class TrueSkillCalculator:
    """TrueSkill 1v1 Rating Engine."""

    def __init__(self, mu_0=25.0, sigma_0=25.0 / 3.0, beta=25.0 / 6.0, tau=25.0 / 300.0):
        self.mu_0 = mu_0
        self.sigma_0 = sigma_0
        self.beta = beta
        self.tau = tau

    def initial_rating(self):
        return {"mu": self.mu_0, "sigma": self.sigma_0}

    def conservative_score(self, mu, sigma):
        return mu - 3.0 * sigma

    def update(self, winner_mu, winner_sigma, loser_mu, loser_sigma):
        # Apply additive dynamics (uncertainty drift)
        w_sig2 = winner_sigma ** 2 + self.tau ** 2
        l_sig2 = loser_sigma ** 2 + self.tau ** 2

        c2 = 2.0 * (self.beta ** 2) + w_sig2 + l_sig2
        c = math.sqrt(c2)

        t = (winner_mu - loser_mu) / c
        v = v_func(t)
        w = w_func(t)

        new_winner_mu = winner_mu + (w_sig2 / c) * v
        new_loser_mu = loser_mu - (l_sig2 / c) * v

        new_winner_sig2 = w_sig2 * (1.0 - (w_sig2 / c2) * w)
        new_loser_sig2 = l_sig2 * (1.0 - (l_sig2 / c2) * w)

        # Floor variance to small positive float
        new_winner_sigma = math.sqrt(max(1e-6, new_winner_sig2))
        new_loser_sigma = math.sqrt(max(1e-6, new_loser_sig2))

        return (
            {"mu": new_winner_mu, "sigma": new_winner_sigma},
            {"mu": new_loser_mu, "sigma": new_loser_sigma},
        )


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
        return 1.0 / (1.0 + math.exp(-self.g(phi_j) * (mu - mu_j)))

    def update_period(self, r, rd, vol, matches):
        """Update a player's rating for a single rating period.

        matches: list of tuples (opponent_r, opponent_rd, outcome_s)
                 outcome_s is 1.0 for win, 0.0 for loss.
        """
        mu, phi = self.to_glicko2_scale(r, rd)

        if not matches:
            # Did not play in this rating period
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

        # Step 5: Solve for new volatility sigma'
        a = math.log(vol ** 2)

        def f(x):
            ex = math.exp(x)
            d2 = delta ** 2
            p2 = phi ** 2
            num = ex * (d2 - p2 - v - ex)
            den = 2.0 * ((p2 + v + ex) ** 2)
            return (num / den) - ((x - a) / (self.tau ** 2))

        # Determine initial bounds
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

        # Step 6: Pre-rating period RD
        phi_star = math.sqrt(phi ** 2 + new_vol ** 2)

        # Step 7: New rating and RD
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

    def load_sets_for_game(self, game_slug):
        """Loads all valid sets for a game in chronological order."""
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

            # Get entrants in this set
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

            # Map entrants to canonical player IDs
            entrant_players = {}
            for e in entrants:
                p_row = self.connection.execute(
                    "SELECT p.player_id FROM entrant_participants ep "
                    "JOIN participants p ON p.id = ep.participant_id "
                    "WHERE ep.entrant_id = ? AND p.player_id IS NOT NULL",
                    (text_id(e["entrant_id"]),),
                ).fetchone()
                if p_row and p_row["player_id"]:
                    c_id = canonical_id(text_id(p_row["player_id"]), self.merges)
                    entrant_players[text_id(e["entrant_id"])] = c_id

            if len(entrant_players) < 2:
                continue

            # Find winner and loser player IDs
            winner_player = entrant_players.get(winner_entrant)
            loser_entrant = next((eid for eid in entrant_players if eid != winner_entrant), None)
            loser_player = entrant_players.get(loser_entrant) if loser_entrant else None

            if not winner_player or not loser_player or winner_player == loser_player:
                continue

            # Check if game is excluded for either player
            if game_slug in self.exclusions["playerGames"].get(winner_player, []) or \
               game_slug in self.exclusions["playerGames"].get(loser_player, []):
                continue

            ts = row["started_at"] or row["start_at"] or row["completed_at"] or row["tournament_start"]
            date_str = date_from_epoch(ts)

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
            })

        return valid_sets

    def load_event_placements_for_game(self, game_slug):
        """Loads event placements for Tournament Placings calculation."""
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
                "eventName": row["event_name"],
                "tournamentName": row["tournament_name"],
                "playerId": player_id,
                "placement": row["placement"],
                "entrants": entrants_count,
                "date": date_str,
                "timestamp": row["event_timestamp"] or 0,
            })

        return event_placements

    def calculate(self, game_slug, system="trueskill", mode="historical", start_date=None, end_date=None, target_player_id=None):
        """Calculates rankings for a specific game, system, mode, and date range."""
        valid_sets = self.load_sets_for_game(game_slug)
        event_placements = self.load_event_placements_for_game(game_slug)

        if system == "trueskill":
            return self._calculate_trueskill(valid_sets, mode, start_date, end_date, target_player_id, game_slug)
        elif system == "glicko2":
            return self._calculate_glicko2(valid_sets, mode, start_date, end_date, target_player_id, game_slug)
        elif system == "placings":
            return self._calculate_placings(event_placements, mode, start_date, end_date, game_slug)
        elif system == "sof":
            return self._calculate_sof(valid_sets, mode, start_date, end_date, target_player_id, game_slug)
        else:
            raise ValueError(f"Unknown ranking system: {system}")

    # -------------------------------------------------------------------------
    # System Implementations
    # -------------------------------------------------------------------------

    def _calculate_trueskill(self, sets, mode, start_date, end_date, target_player_id, game_slug):
        calc = TrueSkillCalculator()

        # Split sets according to mode and date range
        pre_period_sets = []
        period_sets = []

        for s in sets:
            s_date = s["date"]
            if end_date and s_date and s_date > end_date:
                continue

            if mode == "period_only":
                if start_date and s_date and s_date < start_date:
                    continue
                period_sets.append(s)
            elif mode == "period_performance":
                if start_date and s_date and s_date < start_date:
                    pre_period_sets.append(s)
                else:
                    period_sets.append(s)
            else:  # historical
                period_sets.append(s)

        ratings = {}  # pid -> {mu, sigma}
        stats = {}    # pid -> {wins, losses, matches}
        baseline_ratings = {}  # pid -> score at start_date (for period_performance)
        diagnostic_history = {}  # pid -> list of set trace objects

        def get_rating(pid):
            if pid not in ratings:
                ratings[pid] = calc.initial_rating()
                stats[pid] = {"wins": 0, "losses": 0, "matches": 0}
            return ratings[pid]

        def process_set_list(set_list, is_period):
            for s in set_list:
                w_id = s["winnerId"]
                l_id = s["loserId"]

                w_rat = get_rating(w_id)
                l_rat = get_rating(l_id)

                w_pre_score = calc.conservative_score(w_rat["mu"], w_rat["sigma"])
                l_pre_score = calc.conservative_score(l_rat["mu"], l_rat["sigma"])

                new_w, new_l = calc.update(w_rat["mu"], w_rat["sigma"], l_rat["mu"], l_rat["sigma"])

                w_post_score = calc.conservative_score(new_w["mu"], new_w["sigma"])
                l_post_score = calc.conservative_score(new_l["mu"], new_l["sigma"])

                ratings[w_id] = new_w
                ratings[l_id] = new_l

                if is_period:
                    stats[w_id]["wins"] += 1
                    stats[w_id]["matches"] += 1
                    stats[l_id]["losses"] += 1
                    stats[l_id]["matches"] += 1

                # Record diagnostic trace for target player
                for pid, is_win, pre, post, opp_id, opp_pre in [
                    (w_id, True, w_pre_score, w_post_score, l_id, l_pre_score),
                    (l_id, False, l_pre_score, l_post_score, w_id, w_pre_score),
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
                            "opponentPreRating": round(opp_pre, 2),
                            "outcome": "win" if is_win else "loss",
                            "preScore": round(pre, 2),
                            "postScore": round(post, 2),
                            "change": round(post - pre, 2),
                        }
                        diagnostic_history.setdefault(pid, []).append(trace)

        if mode == "period_performance":
            process_set_list(pre_period_sets, is_period=False)
            for pid, r in ratings.items():
                baseline_ratings[pid] = calc.conservative_score(r["mu"], r["sigma"])

        process_set_list(period_sets, is_period=True)

        # Build final ranking list
        rankings = []
        for pid, r in ratings.items():
            if stats[pid]["matches"] == 0 and mode != "historical":
                continue

            score = calc.conservative_score(r["mu"], r["sigma"])
            base_score = baseline_ratings.get(pid, 0.0 if mode == "period_only" else calc.conservative_score(calc.mu_0, calc.sigma_0))
            change = score - base_score

            rankings.append({
                "playerId": pid,
                "playerTag": self.latest_tags.get(pid, f"Player {pid}"),
                "score": round(score, 2),
                "mu": round(r["mu"], 2),
                "sigma": round(r["sigma"], 2),
                "baselineScore": round(base_score, 2),
                "change": round(change, 2),
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
            "system": "trueskill",
            "mode": mode,
            "startDate": start_date,
            "endDate": end_date,
            "totalPlayers": len(rankings),
            "rankings": rankings,
            "algorithm": {
                "version": ALGORITHM_VERSION,
                "name": "TrueSkill",
                "parameters": {
                    "initialMu": calc.mu_0,
                    "initialSigma": round(calc.sigma_0, 4),
                    "beta": round(calc.beta, 4),
                    "tau": round(calc.tau, 4),
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

    def _calculate_glicko2(self, sets, mode, start_date, end_date, target_player_id, game_slug):
        calc = Glicko2Calculator()

        # Group sets into rating periods (by event)
        pre_period_events = {}  # event_id -> list of sets
        period_events = {}      # event_id -> list of sets

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

        ratings = {}  # pid -> {r, rd, vol}
        stats = {}    # pid -> {wins, losses, matches}
        baseline_ratings = {}
        diagnostic_history = {}

        def get_rating(pid):
            if pid not in ratings:
                ratings[pid] = calc.initial_rating()
                stats[pid] = {"wins": 0, "losses": 0, "matches": 0}
            return ratings[pid]

        def process_event_dict(event_dict, is_period):
            for e_id, e_sets in event_dict.items():
                # Collect matches per player in this event rating period
                player_matches = {}  # pid -> list of (opp_r, opp_rd, outcome)
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

                # Update active players in this rating period
                new_ratings = {}
                for pid, p_m in player_matches.items():
                    p_rat = ratings[pid]
                    new_ratings[pid] = calc.update_period(p_rat["r"], p_rat["rd"], p_rat["vol"], p_m)

                # Update ratings
                for pid, new_rat in new_ratings.items():
                    ratings[pid] = new_rat

                # Record diagnostic traces for sets in this event
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
                "parameters": {
                    "initialRating": calc.r_0,
                    "initialRD": calc.rd_0,
                    "initialVolatility": calc.vol_0,
                    "tau": calc.tau,
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

    def _calculate_placings(self, placements, mode, start_date, end_date, game_slug):
        BASE_POINTS = {
            1: 100, 2: 70, 3: 50, 4: 40, 5: 30, 6: 30,
            7: 20, 8: 20, 9: 14, 10: 14, 11: 14, 12: 14,
            13: 10, 14: 10, 15: 10, 16: 10, 17: 6, 25: 4, 33: 2
        }

        def get_base_points(place):
            for threshold in sorted(BASE_POINTS.keys(), reverse=True):
                if place >= threshold:
                    return BASE_POINTS[threshold]
            return 2

        player_data = {}

        for p in placements:
            p_date = p["date"]
            if end_date and p_date and p_date > end_date:
                continue

            if start_date and p_date and p_date < start_date:
                continue

            pid = p["playerId"]
            if pid not in player_data:
                player_data[pid] = {
                    "totalPoints": 0.0,
                    "events": 0,
                    "placements": [],
                }

            entrants_count = p["entrants"]
            entrant_mult = max(0.5, min(2.5, math.log2(entrants_count + 1) / 3.0))
            pts = get_base_points(p["placement"]) * entrant_mult

            player_data[pid]["totalPoints"] += pts
            player_data[pid]["events"] += 1
            player_data[pid]["placements"].append(p["placement"])

        rankings = []
        for pid, data in player_data.items():
            best_p = min(data["placements"]) if data["placements"] else None
            avg_pts = data["totalPoints"] / data["events"] if data["events"] > 0 else 0.0

            rankings.append({
                "playerId": pid,
                "playerTag": self.latest_tags.get(pid, f"Player {pid}"),
                "score": round(data["totalPoints"], 1),
                "avgPoints": round(avg_pts, 1),
                "events": data["events"],
                "bestPlace": best_p,
            })

        rankings.sort(key=lambda x: x["score"], reverse=True)
        for idx, item in enumerate(rankings, 1):
            item["rank"] = idx

        return {
            "gameSlug": game_slug,
            "system": "placings",
            "mode": mode,
            "startDate": start_date,
            "endDate": end_date,
            "totalPlayers": len(rankings),
            "rankings": rankings,
            "algorithm": {
                "version": ALGORITHM_VERSION,
                "name": "Tournament Placings",
                "parameters": {
                    "basePoints": "1st: 100, 2nd: 70, 3rd: 50, 4th: 40, 5th: 30, 7th: 20, 9th: 14, 13th: 10, 17th: 6",
                    "scaling": "log2(entrants + 1) / 3.0 (clamped [0.5, 2.5])",
                },
            },
        }

    def _calculate_sof(self, sets, mode, start_date, end_date, target_player_id, game_slug):
        """Strength of Field (SoF) calculation using valid pre-event TrueSkill ratings."""
        calc = TrueSkillCalculator()

        # Step 1: Pre-event rating tracking
        # Calculate pre-event TrueSkill scores for every set chronologically
        pre_event_ratings = {}  # pid -> {mu, sigma}
        event_sets_map = {}     # event_id -> list of sets

        for s in sets:
            event_sets_map.setdefault(s["eventId"], []).append(s)

        # Map each set to the pre-event opponent score
        set_opponent_pre_scores = {}  # (setId, player_id) -> opponent_pre_score

        for e_id, e_sets in event_sets_map.items():
            # Capture pre-event ratings of all players in this event
            pre_event_scores = {
                pid: calc.conservative_score(r["mu"], r["sigma"])
                for pid, r in pre_event_ratings.items()
            }

            # Process sets within event while recording pre-event opponent ratings
            for s in e_sets:
                w_id, l_id = s["winnerId"], s["loserId"]

                w_pre_score = pre_event_scores.get(w_id, 0.0)
                l_pre_score = pre_event_scores.get(l_id, 0.0)

                set_opponent_pre_scores[(s["setId"], w_id)] = l_pre_score
                set_opponent_pre_scores[(s["setId"], l_id)] = w_pre_score

                # Update TrueSkill ratings for subsequent events
                w_rat = pre_event_ratings.get(w_id, calc.initial_rating())
                l_rat = pre_event_ratings.get(l_id, calc.initial_rating())

                new_w, new_l = calc.update(w_rat["mu"], w_rat["sigma"], l_rat["mu"], l_rat["sigma"])
                pre_event_ratings[w_id] = new_w
                pre_event_ratings[l_id] = new_l

        # Step 2: Calculate SoF for selected range/period
        player_sof = {}  # pid -> {opp_pre_scores: [], wins: 0, losses: 0, events: set()}

        for s in sets:
            s_date = s["date"]
            if end_date and s_date and s_date > end_date:
                continue

            if start_date and s_date and s_date < start_date:
                continue

            w_id, l_id = s["winnerId"], s["loserId"]
            w_opp_pre = set_opponent_pre_scores.get((s["setId"], w_id), 0.0)
            l_opp_pre = set_opponent_pre_scores.get((s["setId"], l_id), 0.0)

            for pid, is_win, opp_pre in [(w_id, True, w_opp_pre), (l_id, False, l_opp_pre)]:
                if pid not in player_sof:
                    player_sof[pid] = {
                        "oppScores": [],
                        "wins": 0,
                        "losses": 0,
                        "events": set(),
                    }
                player_sof[pid]["oppScores"].append(opp_pre)
                player_sof[pid]["events"].add(s["eventId"])
                if is_win:
                    player_sof[pid]["wins"] += 1
                else:
                    player_sof[pid]["losses"] += 1

        rankings = []
        diagnostic_history = {}

        for pid, data in player_sof.items():
            if not data["oppScores"]:
                continue

            avg_opp_pre = sum(data["oppScores"]) / len(data["oppScores"])
            total_matches = data["wins"] + data["losses"]
            win_rate = data["wins"] / total_matches if total_matches > 0 else 0.0

            # SoF Score Formula: Average Opponent Pre-Event Score + Win Rate Adjustment
            sof_score = avg_opp_pre + (win_rate - 0.5) * 20.0

            rankings.append({
                "playerId": pid,
                "playerTag": self.latest_tags.get(pid, f"Player {pid}"),
                "score": round(sof_score, 2),
                "avgOpponentRating": round(avg_opp_pre, 2),
                "winRate": round(100.0 * win_rate, 1),
                "matches": total_matches,
                "wins": data["wins"],
                "losses": data["losses"],
                "events": len(data["events"]),
            })

        rankings.sort(key=lambda x: x["score"], reverse=True)
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
                "parameters": {
                    "opponentMetric": "Pre-Event TrueSkill Conservative Rating (μ - 3σ)",
                    "formula": "Avg Opponent Pre-Event Score + (Win Rate - 0.5) * 20.0",
                },
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
    systems = ["trueskill", "glicko2", "placings", "sof"]

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
    parser.add_argument("--system", default="trueskill", choices=["trueskill", "glicko2", "placings", "sof"], help="ranking system")
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
