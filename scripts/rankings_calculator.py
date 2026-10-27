"""Ranking Engine for Platfighters.uy.

Calculates rankings using four systems:
1. TrueSkill
2. Glicko-2
3. Tournament Placings
4. Strength of Field (SoF)

Supports game isolation, arbitrary date ranges, 3 calculation modes,
canonical player identities, visibility exclusions, and reproducible audit logs.
"""

import math
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATABASE = PROJECT_ROOT / "startgg-data" / "platfighters.sqlite3"
PROFILE_DIR = PROJECT_ROOT / "data" / "profiles"


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


def load_merges():
    for path in (PROFILE_DIR / "merges.json", PROJECT_ROOT / "data" / "player_merges.json"):
        if path.is_file():
            try:
                with path.open(encoding="utf-8") as stream:
                    data = json.load(stream)
                    return {str(k): str(v) for k, v in data.items()}
            except (OSError, json.JSONDecodeError):
                pass
    return {}


def canonical_id(player_id, merges):
    current = str(player_id)
    seen = set()
    while current in merges and current not in seen:
        seen.add(current)
        current = merges[current]
    return current


def load_exclusions():
    path = PROFILE_DIR / "exclusions.json"
    if not path.is_file():
        return {"events": set(), "playerGames": {}}
    try:
        with path.open(encoding="utf-8") as stream:
            data = json.load(stream)
            events = {key for item in data.get("events", []) if (key := normalize_event_key(item))}
            player_games = data.get("playerGames", {})
            if not isinstance(player_games, dict):
                player_games = {}
            return {"events": events, "playerGames": player_games}
    except (OSError, json.JSONDecodeError):
        return {"events": set(), "playerGames": {}}


def load_player_tags(connection, merges):
    tags = {}
    index_path = PROFILE_DIR / "index.json"
    if index_path.is_file():
        try:
            with index_path.open(encoding="utf-8") as stream:
                for entry in json.load(stream):
                    pid = entry.get("playerId")
                    tag = entry.get("tag")
                    if pid and tag:
                        tags[canonical_id(str(pid), merges)] = str(tag).strip()
        except (OSError, json.JSONDecodeError):
            pass

    rows = connection.execute(
        "SELECT p.player_id, p.gamer_tag FROM participants p "
        "JOIN entrant_participants ep ON ep.participant_id=p.id "
        "JOIN entrants en ON en.id=ep.entrant_id "
        "JOIN events e ON e.id=en.event_id "
        "JOIN tournaments t ON t.slug=e.tournament_slug "
        "WHERE p.player_id IS NOT NULL AND p.gamer_tag IS NOT NULL "
        "AND TRIM(p.gamer_tag) != '' AND LOWER(TRIM(p.gamer_tag)) != 'deleted user' "
        "ORDER BY COALESCE(t.start_at, 0) ASC, p.id ASC"
    ).fetchall()
    for row in rows:
        c_id = canonical_id(str(row["player_id"]), merges)
        tags[c_id] = str(row["gamer_tag"]).strip()
    return tags


def is_invalid_or_dq_score(display_score):
    if not display_score:
        return False
    norm = re.sub(r"\s+", "", str(display_score)).casefold()
    if "dq" in norm or "bye" in norm or "forfeit" in norm:
        return True
    for dash in ("−", "–", "—", "﹣"):
        norm = norm.replace(dash, "-")
    if norm in {"-1", "-score", "0-0", "score-score"}:
        return True
    return False


def timestamp_to_iso_date(ts):
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, timezone.utc).date().isoformat()


def load_sets_for_game(connection, game_slug, merges, exclusions):
    """
    Loads all valid sets for a specific game, isolated from other games.
    Applies player merges and visibility exclusions.
    Returns sorted list of match dicts.
    """
    excluded_events = exclusions["events"]
    player_games = exclusions["playerGames"]

    query = """
        SELECT
            s.id AS set_id,
            s.event_id,
            s.winner_entrant_id,
            s.display_score,
            s.started_at,
            s.start_at,
            s.completed_at,
            e.source_url,
            e.name AS event_name,
            t.slug AS tournament_slug,
            t.name AS tournament_name,
            t.start_at AS tournament_start,
            ph.phase_order,
            s.round
        FROM sets s
        JOIN events e ON e.id = s.event_id
        JOIN videogames v ON v.slug = e.videogame_slug
        JOIN tournaments t ON t.slug = e.tournament_slug
        LEFT JOIN phase_groups pg ON pg.id = s.phase_group_id
        LEFT JOIN phases ph ON ph.id = pg.phase_id
        WHERE v.slug = ?
        ORDER BY
            COALESCE(s.started_at, s.start_at, s.completed_at, t.start_at) ASC,
            COALESCE(ph.phase_order, 999) ASC,
            COALESCE(s.round, 999) ASC,
            s.id ASC
    """

    set_rows = connection.execute(query, (game_slug,)).fetchall()

    matches = []
    for s in set_rows:
        set_id = str(s["set_id"])
        event_key = normalize_event_key(s["source_url"])

        if event_key in excluded_events:
            continue

        if is_invalid_or_dq_score(s["display_score"]):
            continue

        winner_entrant_id = str(s["winner_entrant_id"]) if s["winner_entrant_id"] is not None else None
        if not winner_entrant_id:
            continue

        entrants = connection.execute(
            "SELECT se.entrant_id, p.player_id "
            "FROM set_entrants se "
            "JOIN entrants en ON en.id = se.entrant_id "
            "JOIN entrant_participants ep ON ep.entrant_id = en.id "
            "JOIN participants p ON p.id = ep.participant_id "
            "WHERE se.set_id = ? AND p.player_id IS NOT NULL",
            (set_id,),
        ).fetchall()

        entrant_players = {}
        for row in entrants:
            e_id = str(row["entrant_id"])
            p_id = canonical_id(str(row["player_id"]), merges)
            entrant_players.setdefault(e_id, set()).add(p_id)

        if len(entrant_players) != 2:
            continue

        entrant_ids = list(entrant_players.keys())
        e1, e2 = entrant_ids[0], entrant_ids[1]
        p1_set, p2_set = entrant_players[e1], entrant_players[e2]

        if len(p1_set) != 1 or len(p2_set) != 1:
            continue

        p1, p2 = next(iter(p1_set)), next(iter(p2_set))
        if p1 == p2:
            continue

        if game_slug in player_games.get(p1, []) or game_slug in player_games.get(p2, []):
            continue

        winner = p1 if winner_entrant_id == e1 else (p2 if winner_entrant_id == e2 else None)
        if not winner:
            continue
        loser = p2 if winner == p1 else p1

        ts = s["started_at"] or s["start_at"] or s["completed_at"] or s["tournament_start"]
        date_iso = timestamp_to_iso_date(ts)

        matches.append({
            "setId": set_id,
            "eventId": str(s["event_id"]),
            "eventKey": event_key,
            "eventName": s["event_name"],
            "tournamentName": s["tournament_name"],
            "timestamp": ts,
            "date": date_iso,
            "winner": winner,
            "loser": loser,
            "displayScore": s["display_score"],
        })

    return matches


# --- TrueSkill Math Functions ---
TS_MU0 = 25.0
TS_SIGMA0 = 25.0 / 3.0
TS_BETA = 25.0 / 6.0
TS_TAU = 25.0 / 300.0


def _erf(x):
    return math.erf(x)


def _norm_pdf(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _norm_cdf(x):
    return 0.5 * (1.0 + _erf(x / math.sqrt(2.0)))


def _v_win(t):
    denom = _norm_cdf(t)
    return (_norm_pdf(t) / denom) if denom > 1e-12 else -t


def _w_win(t):
    v = _v_win(t)
    return v * (v + t)


def trueskill_update(w_mu, w_sig, l_mu, l_sig):
    """Calculates updated TrueSkill mean and sigma for winner and loser."""
    # Add additive dynamics factor tau
    w_sig_adj = math.sqrt(w_sig ** 2 + TS_TAU ** 2)
    l_sig_adj = math.sqrt(l_sig ** 2 + TS_TAU ** 2)

    c2 = 2.0 * (TS_BETA ** 2) + w_sig_adj ** 2 + l_sig_adj ** 2
    c = math.sqrt(c2)
    t = (w_mu - l_mu) / c

    v = _v_win(t)
    w = _w_win(t)

    w_mu_new = w_mu + (w_sig_adj ** 2 / c) * v
    l_mu_new = l_mu - (l_sig_adj ** 2 / c) * v

    w_sig2_new = w_sig_adj ** 2 * (1.0 - (w_sig_adj ** 2 / c2) * w)
    l_sig2_new = l_sig_adj ** 2 * (1.0 - (l_sig_adj ** 2 / c2) * w)

    w_sig_new = math.sqrt(max(1e-4, w_sig2_new))
    l_sig_new = math.sqrt(max(1e-4, l_sig2_new))

    return (w_mu_new, w_sig_new), (l_mu_new, l_sig_new)


# --- Glicko-2 Math Functions ---
G2_R0 = 1500.0
G2_RD0 = 350.0
G2_VOL0 = 0.06
G2_TAU = 0.5
G2_SCALE = 173.7178


def _g2_g(phi):
    return 1.0 / math.sqrt(1.0 + (3.0 * phi * phi) / (math.pi * math.pi))


def _g2_E(mu, mu_j, phi_j):
    return 1.0 / (1.0 + math.exp(-_g2_g(phi_j) * (mu - mu_j)))


def glicko2_update_period(mu, phi, vol, match_results):
    """
    Updates Glicko-2 rating for a single rating period.
    match_results is a list of tuples: (opp_mu, opp_phi, score) where score is 1.0 for win, 0.0 for loss.
    """
    if not match_results:
        # Inactive period: decay rating deviation
        new_phi = math.sqrt(phi ** 2 + vol ** 2)
        return mu, new_phi, vol

    v_inv = 0.0
    delta_sum = 0.0
    for opp_mu, opp_phi, score in match_results:
        g = _g2_g(opp_phi)
        E = _g2_E(mu, opp_mu, opp_phi)
        v_inv += g * g * E * (1.0 - E)
        delta_sum += g * (score - E)

    if v_inv < 1e-12:
        return mu, phi, vol

    v = 1.0 / v_inv
    delta = v * delta_sum

    # Step 5: Solve for new volatility sigma'
    a = math.log(vol * vol)
    tau = G2_TAU
    eps = 1e-6

    def f(x):
        ex = math.exp(x)
        d2 = delta * delta
        p2 = phi * phi
        num = ex * (d2 - p2 - v - ex)
        den = 2.0 * ((p2 + v + ex) ** 2)
        return (num / den) - ((x - a) / (tau * tau))

    A = a
    if delta * delta > (phi * phi + v):
        B = math.log(delta * delta - phi * phi - v)
    else:
        k = 1
        while f(a - k * tau) < 0:
            k += 1
        B = a - k * tau

    fA = f(A)
    fB = f(B)

    while abs(B - A) > eps:
        C = A + (A - B) * fA / (fB - fA)
        fC = f(C)
        if fC * fB < 0:
            A = B
            fA = fB
        else:
            fA = fA / 2.0
        B = C
        fB = fC

    new_vol = math.exp(A / 2.0)

    # Step 6 & 7: Update phi and mu
    phi_star = math.sqrt(phi ** 2 + new_vol ** 2)
    new_phi = 1.0 / math.sqrt((1.0 / (phi_star ** 2)) + (1.0 / v))
    new_mu = mu + (new_phi ** 2) * delta_sum

    return new_mu, new_phi, new_vol


# --- Ranking Engines ---

def calculate_rankings(game_slug, system, mode, start_date=None, end_date=None):
    """
    Calculates rankings on demand.
    Returns dict with leaderboard list, system parameters, metadata, and audit logs.
    """
    with sqlite3.connect(DATABASE) as connection:
        connection.row_factory = sqlite3.Row
        merges = load_merges()
        exclusions = load_exclusions()
        tags = load_player_tags(connection, merges)
        matches = load_sets_for_game(connection, game_slug, merges, exclusions)

    # Date filtering
    # end_date cutoff: include matches with date <= end_date
    if end_date:
        matches = [m for m in matches if m["date"] and m["date"] <= end_date]

    if system == "trueskill":
        return _calculate_trueskill(matches, tags, mode, start_date, end_date)
    elif system == "glicko2":
        return _calculate_glicko2(matches, tags, mode, start_date, end_date)
    elif system == "placings":
        return _calculate_placings(game_slug, tags, mode, start_date, end_date, merges, exclusions)
    elif system == "sof":
        return _calculate_sof(matches, tags, mode, start_date, end_date)
    else:
        raise ValueError(f"Unknown ranking system: {system}")


def _calculate_trueskill(matches, tags, mode, start_date, end_date):
    ratings = {}  # pid -> {'mu': float, 'sigma': float, 'wins': int, 'losses': int, 'sets': int}
    audit_trail = []

    def get_rating(pid):
        if pid not in ratings:
            ratings[pid] = {"mu": TS_MU0, "sigma": TS_SIGMA0, "wins": 0, "losses": 0, "sets": 0}
        return ratings[pid]

    # Mode logic:
    # Historical: process all matches up to end_date. Active matches in range update rating.
    # Period-only: process ONLY matches within [start_date, end_date], starting from neutral ratings.
    # Period-performance: process matches < start_date for baseline, track rating changes within [start_date, end_date].

    in_period_set_counts = {}

    for m in matches:
        m_date = m["date"]
        is_before = bool(start_date and m_date and m_date < start_date)
        is_in_period = (not start_date or (m_date and m_date >= start_date)) and (not end_date or (m_date and m_date <= end_date))

        if mode == "period_only" and is_before:
            continue

        w_pid = m["winner"]
        l_pid = m["loser"]

        w_r = get_rating(w_pid)
        l_r = get_rating(l_pid)

        w_pre = (w_r["mu"], w_r["sigma"])
        l_pre = (l_r["mu"], l_r["sigma"])

        (w_mu_post, w_sig_post), (l_mu_post, l_sig_post) = trueskill_update(
            w_r["mu"], w_r["sigma"], l_r["mu"], l_r["sigma"]
        )

        w_r["mu"], w_r["sigma"] = w_mu_post, w_sig_post
        l_r["mu"], l_r["sigma"] = l_mu_post, l_sig_post

        if is_in_period:
            w_r["wins"] += 1
            w_r["sets"] += 1
            l_r["losses"] += 1
            l_r["sets"] += 1
            in_period_set_counts[w_pid] = in_period_set_counts.get(w_pid, 0) + 1
            in_period_set_counts[l_pid] = in_period_set_counts.get(l_pid, 0) + 1

        audit_trail.append({
            "setId": m["setId"],
            "date": m_date,
            "event": m["tournamentName"],
            "winnerId": w_pid,
            "winnerTag": tags.get(w_pid, f"Player {w_pid}"),
            "loserId": l_pid,
            "loserTag": tags.get(l_pid, f"Player {l_pid}"),
            "winnerPre": {"mu": round(w_pre[0], 2), "sigma": round(w_pre[1], 2)},
            "winnerPost": {"mu": round(w_mu_post, 2), "sigma": round(w_sig_post, 2)},
            "loserPre": {"mu": round(l_pre[0], 2), "sigma": round(l_pre[1], 2)},
            "loserPost": {"mu": round(l_mu_post, 2), "sigma": round(l_sig_post, 2)},
            "inSelectedPeriod": is_in_period,
        })

    # Prepare leaderboard
    leaderboard = []
    for pid, r in ratings.items():
        if mode in ("period_only", "period_performance") and in_period_set_counts.get(pid, 0) == 0:
            continue
        if r["sets"] == 0 and mode != "historical":
            continue

        mu = r["mu"]
        sigma = r["sigma"]
        score = mu - 3.0 * sigma

        leaderboard.append({
            "playerId": pid,
            "tag": tags.get(pid, f"Player {pid}"),
            "score": round(score, 2),
            "displayScore": f"{score:.2f}",
            "mean": round(mu, 2),
            "uncertainty": round(sigma, 2),
            "wins": r["wins"],
            "losses": r["losses"],
            "totalSets": r["sets"],
        })

    leaderboard.sort(key=lambda x: x["score"], reverse=True)
    for idx, entry in enumerate(leaderboard, 1):
        entry["rank"] = idx

    return {
        "system": "trueskill",
        "mode": mode,
        "startDate": start_date,
        "endDate": end_date,
        "parameters": {"initialMu": TS_MU0, "initialSigma": round(TS_SIGMA0, 3), "beta": round(TS_BETA, 3), "tau": round(TS_TAU, 3), "metric": "mu - 3*sigma"},
        "leaderboard": leaderboard,
        "auditTrail": audit_trail,
    }


def _calculate_glicko2(matches, tags, mode, start_date, end_date):
    # Group matches by rating period (e.g. by eventId or date)
    periods = {}  # period_key -> list of matches
    for m in matches:
        p_key = m["eventId"]
        periods.setdefault(p_key, []).append(m)

    ratings = {}  # pid -> {'mu': float, 'phi': float, 'vol': float, 'wins': int, 'losses': int, 'sets': int}
    audit_trail = []

    def get_rating(pid):
        if pid not in ratings:
            # Glicko-2 scale initial values
            mu0 = (G2_R0 - 1500.0) / G2_SCALE
            phi0 = G2_RD0 / G2_SCALE
            ratings[pid] = {"mu": mu0, "phi": phi0, "vol": G2_VOL0, "wins": 0, "losses": 0, "sets": 0}
        return ratings[pid]

    in_period_set_counts = {}

    for p_key, p_matches in periods.items():
        m_date = p_matches[0]["date"]
        is_before = bool(start_date and m_date and m_date < start_date)
        is_in_period = (not start_date or (m_date and m_date >= start_date)) and (not end_date or (m_date and m_date <= end_date))

        if mode == "period_only" and is_before:
            continue

        # Collect player matches for this period
        period_player_matches = {}  # pid -> list of (opp_mu, opp_phi, score)
        period_set_participants = set()

        for m in p_matches:
            w_pid, l_pid = m["winner"], m["loser"]
            w_r = get_rating(w_pid)
            l_r = get_rating(l_pid)

            period_player_matches.setdefault(w_pid, []).append((l_r["mu"], l_r["phi"], 1.0))
            period_player_matches.setdefault(l_pid, []).append((w_r["mu"], w_r["phi"], 0.0))
            period_set_participants.add(w_pid)
            period_set_participants.add(l_pid)

            if is_in_period:
                w_r["wins"] += 1
                w_r["sets"] += 1
                l_r["losses"] += 1
                l_r["sets"] += 1
                in_period_set_counts[w_pid] = in_period_set_counts.get(w_pid, 0) + 1
                in_period_set_counts[l_pid] = in_period_set_counts.get(l_pid, 0) + 1

        # Process Glicko-2 period updates for all active players in period
        new_period_ratings = {}
        for pid in period_set_participants:
            r = ratings[pid]
            pre_R = r["mu"] * G2_SCALE + 1500.0
            pre_RD = r["phi"] * G2_SCALE

            new_mu, new_phi, new_vol = glicko2_update_period(r["mu"], r["phi"], r["vol"], period_player_matches[pid])
            new_period_ratings[pid] = (new_mu, new_phi, new_vol)

            post_R = new_mu * G2_SCALE + 1500.0
            post_RD = new_phi * G2_SCALE

            audit_trail.append({
                "eventId": p_key,
                "date": m_date,
                "event": p_matches[0]["tournamentName"],
                "playerId": pid,
                "playerTag": tags.get(pid, f"Player {pid}"),
                "preRating": round(pre_R, 1),
                "preRD": round(pre_RD, 1),
                "postRating": round(post_R, 1),
                "postRD": round(post_RD, 1),
                "inSelectedPeriod": is_in_period,
            })

        for pid, (n_mu, n_phi, n_vol) in new_period_ratings.items():
            ratings[pid]["mu"] = n_mu
            ratings[pid]["phi"] = n_phi
            ratings[pid]["vol"] = n_vol

    # Build leaderboard
    leaderboard = []
    for pid, r in ratings.items():
        if mode in ("period_only", "period_performance") and in_period_set_counts.get(pid, 0) == 0:
            continue
        if r["sets"] == 0 and mode != "historical":
            continue

        R = r["mu"] * G2_SCALE + 1500.0
        RD = r["phi"] * G2_SCALE
        score = R - 2.0 * RD  # Conservative Glicko-2 rating

        leaderboard.append({
            "playerId": pid,
            "tag": tags.get(pid, f"Player {pid}"),
            "score": round(score, 1),
            "displayScore": f"{round(R)} ± {round(2*RD)}",
            "rating": round(R, 1),
            "ratingDeviation": round(RD, 1),
            "volatility": round(r["vol"], 4),
            "wins": r["wins"],
            "losses": r["losses"],
            "totalSets": r["sets"],
        })

    leaderboard.sort(key=lambda x: x["score"], reverse=True)
    for idx, entry in enumerate(leaderboard, 1):
        entry["rank"] = idx

    return {
        "system": "glicko2",
        "mode": mode,
        "startDate": start_date,
        "endDate": end_date,
        "parameters": {"initialRating": G2_R0, "initialRD": G2_RD0, "volatility": G2_VOL0, "tau": G2_TAU, "metric": "R - 2*RD"},
        "leaderboard": leaderboard,
        "auditTrail": audit_trail,
    }


def _calculate_placings(game_slug, tags, mode, start_date, end_date, merges, exclusions):
    excluded_events = exclusions["events"]
    player_games = exclusions["playerGames"]

    with sqlite3.connect(DATABASE) as connection:
        connection.row_factory = sqlite3.Row
        query = """
            SELECT
                es.event_id,
                es.placement,
                en.id AS entrant_id,
                p.player_id,
                e.name AS event_name,
                e.num_entrants,
                e.source_url,
                t.name AS tournament_name,
                t.start_at AS tournament_start
            FROM event_standings es
            JOIN entrants en ON en.id = es.entrant_id
            JOIN entrant_participants ep ON ep.entrant_id = en.id
            JOIN participants p ON p.id = ep.participant_id
            JOIN events e ON e.id = es.event_id
            JOIN videogames v ON v.slug = e.videogame_slug
            JOIN tournaments t ON t.slug = e.tournament_slug
            WHERE v.slug = ? AND es.placement IS NOT NULL AND p.player_id IS NOT NULL
        """
        rows = connection.execute(query, (game_slug,)).fetchall()

    # Aggregate tournament placings
    player_scores = {}  # pid -> {'points': float, 'eventsCount': int, 'topPlacings': list}
    audit_trail = []

    # Map standings by (event_id, player_id)
    event_player_placings = {}
    for r in rows:
        event_key = normalize_event_key(r["source_url"])
        if event_key in excluded_events:
            continue

        pid = canonical_id(str(r["player_id"]), merges)
        if game_slug in player_games.get(pid, []):
            continue

        place = r["placement"]
        if place <= 0:
            continue

        ts = r["tournament_start"]
        m_date = timestamp_to_iso_date(ts)

        is_before = bool(start_date and m_date and m_date < start_date)
        is_in_period = (not start_date or (m_date and m_date >= start_date)) and (not end_date or (m_date and m_date <= end_date))

        if not is_in_period:
            continue

        num_entrants = r["num_entrants"] or 16

        # Placings formula: Points = round(100 * sqrt(entrants / 16) / sqrt(place))
        pts = round(100.0 * math.sqrt(num_entrants / 16.0) / math.sqrt(place), 1)

        event_player_placings.setdefault(pid, []).append({
            "eventId": str(r["event_id"]),
            "eventKey": event_key,
            "tournamentName": r["tournament_name"],
            "date": m_date,
            "placement": place,
            "entrants": num_entrants,
            "points": pts,
        })

    for pid, placings in event_player_placings.items():
        total_pts = sum(p["points"] for p in placings)
        placings.sort(key=lambda x: x["placement"])

        player_scores[pid] = {
            "points": round(total_pts, 1),
            "eventsCount": len(placings),
            "topPlacings": placings[:5],
        }

        for p in placings:
            audit_trail.append({
                "playerId": pid,
                "playerTag": tags.get(pid, f"Player {pid}"),
                "event": p["tournamentName"],
                "date": p["date"],
                "placement": p["placement"],
                "entrants": p["entrants"],
                "pointsAwarded": p["points"],
            })

    leaderboard = []
    for pid, data in player_scores.items():
        leaderboard.append({
            "playerId": pid,
            "tag": tags.get(pid, f"Player {pid}"),
            "score": data["points"],
            "displayScore": f"{data['points']} pts",
            "eventsCount": data["eventsCount"],
            "topPlacings": data["topPlacings"],
        })

    leaderboard.sort(key=lambda x: x["score"], reverse=True)
    for idx, entry in enumerate(leaderboard, 1):
        entry["rank"] = idx

    return {
        "system": "placings",
        "mode": mode,
        "startDate": start_date,
        "endDate": end_date,
        "parameters": {"formula": "100 * sqrt(entrants / 16) / sqrt(place)"},
        "leaderboard": leaderboard,
        "auditTrail": audit_trail,
    }


def _calculate_sof(matches, tags, mode, start_date, end_date):
    """
    Strength of Field (SoF):
    1. Tracks player pre-event ratings chronologically.
    2. Before each event, calculates pre-event ratings of all competitors.
    3. Uses strictly pre-event ratings to rate the strength of field and performance.
    """
    # Group matches by event
    events_map = {}
    for m in matches:
        e_id = m["eventId"]
        events_map.setdefault(e_id, []).append(m)

    ratings = {}  # pid -> TrueSkill pre-rating mean
    player_sof_scores = {}  # pid -> {'score': float, 'events': int, 'wins': int, 'losses': int, 'sets': int}
    audit_trail = []

    def get_rating(pid):
        if pid not in ratings:
            ratings[pid] = {"mu": TS_MU0, "sigma": TS_SIGMA0}
        return ratings[pid]["mu"]

    in_period_set_counts = {}

    for e_id, e_matches in events_map.items():
        m_date = e_matches[0]["date"]
        e_name = e_matches[0]["tournamentName"]

        is_before = bool(start_date and m_date and m_date < start_date)
        is_in_period = (not start_date or (m_date and m_date >= start_date)) and (not end_date or (m_date and m_date <= end_date))

        if mode == "period_only" and is_before:
            continue

        # Step A: Record PRE-EVENT ratings for all participants in this event
        e_participants = set()
        for m in e_matches:
            e_participants.add(m["winner"])
            e_participants.add(m["loser"])

        pre_event_ratings = {pid: get_rating(pid) for pid in e_participants}

        # Event Field Strength = average pre-event rating of attendees
        field_strength = sum(pre_event_ratings.values()) / max(1, len(pre_event_ratings))

        # Step B: Process match updates and record SoF performance within event
        event_performance = {}  # pid -> list of opponent pre-event ratings for wins and losses

        for m in e_matches:
            w_pid, l_pid = m["winner"], m["loser"]
            w_pre_r = pre_event_ratings[w_pid]
            l_pre_r = pre_event_ratings[l_pid]

            event_performance.setdefault(w_pid, {"wins": [], "losses": []})["wins"].append(l_pre_r)
            event_performance.setdefault(l_pid, {"wins": [], "losses": []})["losses"].append(w_pre_r)

            # Update actual ratings post-match for future pre-event calculations
            w_r = ratings[w_pid]
            l_r = ratings[l_pid]
            (w_mu_post, w_sig_post), (l_mu_post, l_sig_post) = trueskill_update(
                w_r["mu"], w_r["sigma"], l_r["mu"], l_r["sigma"]
            )
            ratings[w_pid] = {"mu": w_mu_post, "sigma": w_sig_post}
            ratings[l_pid] = {"mu": l_mu_post, "sigma": l_sig_post}

            if is_in_period:
                in_period_set_counts[w_pid] = in_period_set_counts.get(w_pid, 0) + 1
                in_period_set_counts[l_pid] = in_period_set_counts.get(l_pid, 0) + 1

        if is_in_period:
            for pid, perf in event_performance.items():
                if pid not in player_sof_scores:
                    player_sof_scores[pid] = {"sof_points": 0.0, "events": 0, "wins": 0, "losses": 0, "sets": 0}

                # SoF Event Score = sum(opp_pre_rating for wins) - 0.5 * sum(opp_pre_rating for losses)
                win_score = sum(perf["wins"])
                loss_penalty = 0.5 * sum(perf["losses"])
                event_sof = (win_score - loss_penalty) * math.log2(1.0 + field_strength / 25.0)

                player_sof_scores[pid]["sof_points"] += event_sof
                player_sof_scores[pid]["events"] += 1
                player_sof_scores[pid]["wins"] += len(perf["wins"])
                player_sof_scores[pid]["losses"] += len(perf["losses"])
                player_sof_scores[pid]["sets"] += len(perf["wins"]) + len(perf["losses"])

                audit_trail.append({
                    "eventId": e_id,
                    "event": e_name,
                    "date": m_date,
                    "playerId": pid,
                    "playerTag": tags.get(pid, f"Player {pid}"),
                    "preEventRating": round(pre_event_ratings[pid], 2),
                    "fieldStrength": round(field_strength, 2),
                    "eventWins": len(perf["wins"]),
                    "eventLosses": len(perf["losses"]),
                    "eventSoFPoints": round(event_sof, 1),
                })

    leaderboard = []
    for pid, data in player_sof_scores.items():
        if mode in ("period_only", "period_performance") and in_period_set_counts.get(pid, 0) == 0:
            continue

        score = round(max(0.0, data["sof_points"]), 1)
        leaderboard.append({
            "playerId": pid,
            "tag": tags.get(pid, f"Player {pid}"),
            "score": score,
            "displayScore": f"{score} SoF",
            "eventsCount": data["events"],
            "wins": data["wins"],
            "losses": data["losses"],
            "totalSets": data["sets"],
        })

    leaderboard.sort(key=lambda x: x["score"], reverse=True)
    for idx, entry in enumerate(leaderboard, 1):
        entry["rank"] = idx

    return {
        "system": "sof",
        "mode": mode,
        "startDate": start_date,
        "endDate": end_date,
        "parameters": {"fieldStrengthMetric": "Pre-event rating average", "limitations": "Initial events default to neutral pre-event ratings"},
        "leaderboard": leaderboard,
        "auditTrail": audit_trail,
    }


def get_rankings_payload(game_slug="ultimate", system="trueskill", mode="historical", start_date=None, end_date=None):
    return calculate_rankings(game_slug, system, mode, start_date, end_date)


def precompute_default_rankings():
    """Precomputes default rankings for all supported games into data/rankings.json."""
    rankings_path = PROJECT_ROOT / "data" / "rankings.json"
    with sqlite3.connect(DATABASE) as conn:
        games = [r[0] for r in conn.execute("SELECT slug FROM videogames").fetchall()]

    data = {}
    for g in games:
        data[g] = {}
        for s in ("trueskill", "glicko2", "placings", "sof"):
            try:
                res = calculate_rankings(g, s, "historical")
                # Exclude full audit trail from static JSON to keep payload lightweight
                res_light = dict(res)
                res_light["auditTrail"] = res_light.get("auditTrail", [])[:10]
                data[g][s] = res_light
            except Exception as err:
                print(f"Error computing rankings for {g}/{s}: {err}")

    with rankings_path.open("w", encoding="utf-8") as stream:
        json.dump(data, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    print(f"Precomputed rankings saved to {rankings_path.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    precompute_default_rankings()
