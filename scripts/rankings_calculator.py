import json
import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MERGES_FILE = PROJECT_ROOT / "data" / "player_merges.json"

# Default TrueSkill Parameters
TRUESKILL_MU0 = 25.0
TRUESKILL_SIGMA0 = 25.0 / 3.0  # 8.333333
TRUESKILL_BETA = TRUESKILL_SIGMA0 / 2.0  # 4.166667
TRUESKILL_TAU = TRUESKILL_SIGMA0 / 100.0  # 0.083333
TRUESKILL_DRAW_MARGIN = 0.10

# Default Glicko-2 Parameters
GLICKO_R0 = 1500.0
GLICKO_RD0 = 350.0
GLICKO_SIGMA0 = 0.06
GLICKO_TAU = 0.5
GLICKO_SCALE = 173.7178

def load_player_merges():
    if not MERGES_FILE.exists():
        return {}
    try:
        with MERGES_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
            return {str(k): str(v) for k, v in data.items()}
    except Exception:
        return {}

def canonical_id(player_id, merges):
    if player_id is None:
        return None
    curr = str(player_id)
    seen = set()
    while curr in merges and curr not in seen:
        seen.add(curr)
        curr = merges[curr]
    return curr

def erfc(x):
    a1, a2, a3, a4, a5 = 0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429
    p = 0.3275911
    sign = 1
    if x < 0:
        sign = -1
    x = abs(x)
    t = 1.0 / (1.0 + p * x)
    y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * math.exp(-x * x)
    return 1.0 - y if sign == 1 else 1.0 + y

def norm_pdf(x):
    return (1.0 / math.sqrt(2.0 * math.pi)) * math.exp(-0.5 * x * x)

def norm_cdf(x):
    return 0.5 * erfc(-x / math.sqrt(2.0))

def v_win(t, margin):
    denom = norm_cdf(t - margin)
    if denom < 1e-12:
        return -t + margin
    return norm_pdf(t - margin) / denom

def w_win(t, margin):
    v = v_win(t, margin)
    return v * (v + t - margin)

def init_db(db_path="startgg-data/platfighters.sqlite3"):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS power_rankings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            subtitle TEXT,
            game_slug TEXT NOT NULL,
            coverage_period TEXT,
            publication_date TEXT,
            season TEXT,
            introduction TEXT,
            closing_commentary TEXT,
            featured_image TEXT,
            author TEXT,
            status TEXT DEFAULT 'draft',
            created_at TEXT,
            updated_at TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS power_ranking_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            power_ranking_id INTEGER NOT NULL,
            canonical_player_id INTEGER NOT NULL,
            assigned_position INTEGER NOT NULL,
            written_analysis TEXT,
            image_url TEXT,
            highlights TEXT,
            position_change INTEGER,
            FOREIGN KEY (power_ranking_id) REFERENCES power_rankings(id) ON DELETE CASCADE
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS power_ranking_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            power_ranking_id INTEGER NOT NULL,
            revision_number INTEGER NOT NULL,
            editor TEXT,
            revised_at TEXT,
            snapshot_data TEXT,
            FOREIGN KEY (power_ranking_id) REFERENCES power_rankings(id) ON DELETE CASCADE
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS statistical_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_slug TEXT NOT NULL,
            cutoff_date TEXT NOT NULL,
            methodology TEXT NOT NULL,
            data_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)

    conn.commit()
    conn.close()

class TrueSkillEngine:
    def __init__(self, mu0=TRUESKILL_MU0, sigma0=TRUESKILL_SIGMA0, beta=TRUESKILL_BETA, tau=TRUESKILL_TAU):
        self.mu0 = mu0
        self.sigma0 = sigma0
        self.beta = beta
        self.tau = tau

    def update_match(self, p1_rating, p2_rating, result):
        mu1, sig1 = p1_rating
        mu2, sig2 = p2_rating

        sig1 = math.sqrt(sig1 * sig1 + self.tau * self.tau)
        sig2 = math.sqrt(sig2 * sig2 + self.tau * self.tau)

        c = math.sqrt(sig1 * sig1 + sig2 * sig2 + 2 * self.beta * self.beta)
        if c < 1e-9:
            c = 1e-9

        d_mu = mu1 - mu2
        t = d_mu / c
        margin = TRUESKILL_DRAW_MARGIN / c

        if result == 1.0:
            v = v_win(t, margin)
            w = w_win(t, margin)
            new_mu1 = mu1 + (sig1 * sig1 / c) * v
            new_mu2 = mu2 - (sig2 * sig2 / c) * v
            new_sig1 = math.sqrt(max(1e-4, sig1 * sig1 * (1.0 - (sig1 * sig1 / (c * c)) * w)))
            new_sig2 = math.sqrt(max(1e-4, sig2 * sig2 * (1.0 - (sig2 * sig2 / (c * c)) * w)))
        elif result == 0.0:
            v = v_win(-t, margin)
            w = w_win(-t, margin)
            new_mu1 = mu1 - (sig1 * sig1 / c) * v
            new_mu2 = mu2 + (sig2 * sig2 / c) * v
            new_sig1 = math.sqrt(max(1e-4, sig1 * sig1 * (1.0 - (sig1 * sig1 / (c * c)) * w)))
            new_sig2 = math.sqrt(max(1e-4, sig2 * sig2 * (1.0 - (sig2 * sig2 / (c * c)) * w)))
        else:
            new_mu1, new_mu2, new_sig1, new_sig2 = mu1, mu2, sig1, sig2

        return (new_mu1, new_sig1), (new_mu2, new_sig2)

class Glicko2Engine:
    def __init__(self, r0=GLICKO_R0, rd0=GLICKO_RD0, sigma0=GLICKO_SIGMA0, tau=GLICKO_TAU):
        self.r0 = r0
        self.rd0 = rd0
        self.sigma0 = sigma0
        self.tau = tau

    def _to_glicko2(self, r, rd):
        return (r - GLICKO_R0) / GLICKO_SCALE, rd / GLICKO_SCALE

    def _from_glicko2(self, mu, phi):
        return mu * GLICKO_SCALE + GLICKO_R0, phi * GLICKO_SCALE

    def _g(self, phi):
        return 1.0 / math.sqrt(1.0 + 3.0 * phi * phi / (math.pi * math.pi))

    def _E(self, mu, mu_j, phi_j):
        return 1.0 / (1.0 + math.exp(-self._g(phi_j) * (mu - mu_j)))

    def update_rating(self, rating_tuple, matches):
        r, rd, sigma = rating_tuple
        mu, phi = self._to_glicko2(r, rd)

        if not matches:
            phi_prime = math.sqrt(phi * phi + sigma * sigma)
            r_new, rd_new = self._from_glicko2(mu, phi_prime)
            return (r_new, min(GLICKO_RD0, rd_new), sigma)

        v_inv = 0.0
        delta_sum = 0.0
        for opp_r, opp_rd, score in matches:
            opp_mu, opp_phi = self._to_glicko2(opp_r, opp_rd)
            g_phi = self._g(opp_phi)
            e_val = self._E(mu, opp_mu, opp_phi)
            v_inv += g_phi * g_phi * e_val * (1.0 - e_val)
            delta_sum += g_phi * (score - e_val)

        if v_inv < 1e-12:
            return rating_tuple

        v = 1.0 / v_inv
        delta = v * delta_sum

        a = math.log(sigma * sigma)
        tau = self.tau

        def f(x):
            ex = math.exp(x)
            num = ex * (delta * delta - phi * phi - v - ex)
            denom = 2.0 * (phi * phi + v + ex) ** 2
            return num / denom - (x - a) / (tau * tau)

        A = a
        if delta * delta > phi * phi + v:
            B = math.log(delta * delta - phi * phi - v)
        else:
            k = 1
            while f(a - k * tau) < 0:
                k += 1
            B = a - k * tau

        fa = f(A)
        fb = f(B)
        for _ in range(50):
            if abs(B - A) < 1e-6:
                break
            C = A + (A - B) * fa / (fb - fa + 1e-12)
            fc = f(C)
            if fc * fb < 0:
                A = B
                fa = fb
            else:
                fa = fa / 2.0
            B = C
            fb = fc

        sigma_prime = math.exp(A / 2.0)
        phi_star = math.sqrt(phi * phi + sigma_prime * sigma_prime)
        phi_prime = 1.0 / math.sqrt(1.0 / (phi_star * phi_star) + 1.0 / v)
        mu_prime = mu + phi_prime * phi_prime * delta_sum

        r_new, rd_new = self._from_glicko2(mu_prime, phi_prime)
        return (r_new, min(GLICKO_RD0, rd_new), sigma_prime)

def calculate_placement_points(placement, num_entrants):
    if placement <= 0 or num_entrants <= 0:
        return 0.0

    base_points = {
        1: 1000, 2: 700, 3: 500, 4: 350, 5: 250, 7: 175,
        9: 120, 13: 80, 17: 50, 25: 30, 33: 20, 49: 10
    }

    pt = 10.0
    for p_threshold in sorted(base_points.keys()):
        if placement <= p_threshold:
            pt = base_points[p_threshold]
            break

    entrant_mult = math.log2(max(2, num_entrants)) / math.log2(32)
    return pt * entrant_mult

def calculate_statistical_rankings(db_path="startgg-data/platfighters.sqlite3", game_slug="all", cutoff_date=None, start_date=None, player_merges=None):
    init_db(db_path)
    merges = player_merges if player_merges is not None else load_player_merges()

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Query events
    query_events = """
        SELECT e.id, e.videogame_slug, e.num_entrants, t.start_at
        FROM events e
        LEFT JOIN tournaments t ON e.tournament_slug = t.slug
        WHERE 1=1
    """
    params_events = []
    if game_slug and game_slug != "all":
        query_events += " AND e.videogame_slug = ?"
        params_events.append(game_slug)

    query_events += " ORDER BY COALESCE(t.start_at, 0) ASC"
    cur.execute(query_events, params_events)
    events_rows = cur.fetchall()

    filtered_events = []
    for ev in events_rows:
        dt_str = None
        if ev['start_at']:
            dt_str = datetime.fromtimestamp(ev['start_at'], timezone.utc).date().isoformat()

        if cutoff_date and dt_str and dt_str > cutoff_date:
            continue
        if start_date and dt_str and dt_str < start_date:
            continue

        filtered_events.append({
            "id": str(ev['id']),
            "game_slug": ev['videogame_slug'],
            "num_entrants": ev['num_entrants'] or 8,
            "date": dt_str
        })

    if not filtered_events:
        conn.close()
        return {}

    # Build player tags
    cur.execute("SELECT player_id, gamer_tag FROM participants WHERE player_id IS NOT NULL AND gamer_tag IS NOT NULL AND TRIM(gamer_tag) != ''")
    participants_rows = cur.fetchall()
    player_tags = {}
    for r in participants_rows:
        cid = canonical_id(r['player_id'], merges)
        if cid and (cid not in player_tags or r['gamer_tag']):
            player_tags[cid] = r['gamer_tag']

    # Entrant ID to canonical Player ID mapping
    cur.execute("""
        SELECT ep.entrant_id, part.player_id
        FROM entrant_participants ep
        JOIN participants part ON ep.participant_id = part.id
    """)
    entrant_player_map = {}
    for r in cur.fetchall():
        ent_id = str(r['entrant_id'])
        cid = canonical_id(r['player_id'], merges)
        if cid:
            entrant_player_map[ent_id] = cid

    ts_engine = TrueSkillEngine()
    ts_ratings = {}      # cid -> (mu, sigma)
    glicko_ratings = {}  # cid -> (r, rd, sigma)
    placement_scores = {} # cid -> float
    sof_scores = {}      # cid -> float
    match_counts = {}    # cid -> int

    def get_ts(cid):
        return ts_ratings.get(cid, (TRUESKILL_MU0, TRUESKILL_SIGMA0))

    def get_glicko(cid):
        return glicko_ratings.get(cid, (GLICKO_R0, GLICKO_RD0, GLICKO_SIGMA0))

    for ev in filtered_events:
        eid = ev['id']
        num_entrants = ev['num_entrants']

        # 1. Placement Points & SOF
        cur.execute("SELECT entrant_id, placement FROM event_standings WHERE event_id = ?", (eid,))
        standings = cur.fetchall()

        entrant_ts_conservative = []
        for st in standings:
            ent_id = str(st['entrant_id'])
            cid = entrant_player_map.get(ent_id)
            if cid:
                mu, sig = get_ts(cid)
                entrant_ts_conservative.append(mu - 3.0 * sig)

        avg_field_strength = (sum(entrant_ts_conservative) / len(entrant_ts_conservative)) if entrant_ts_conservative else 0.0

        for st in standings:
            ent_id = str(st['entrant_id'])
            cid = entrant_player_map.get(ent_id)
            if not cid:
                continue

            pos = st['placement']
            pts = calculate_placement_points(pos, num_entrants)
            placement_scores[cid] = placement_scores.get(cid, 0.0) + pts

            sof_contrib = pts * (1.0 + max(0.0, avg_field_strength / 25.0))
            sof_scores[cid] = sof_scores.get(cid, 0.0) + sof_contrib

        # 2. Match processing
        cur.execute("""
            SELECT s.id, s.winner_entrant_id
            FROM sets s
            WHERE s.event_id = ? AND s.winner_entrant_id IS NOT NULL
        """, (eid,))
        sets_rows = cur.fetchall()

        glicko_period_matches = {}

        for srow in sets_rows:
            sid = str(srow['id'])
            w_ent_id = str(srow['winner_entrant_id'])

            cur.execute("SELECT entrant_id FROM set_entrants WHERE set_id = ?", (sid,))
            se_rows = cur.fetchall()
            ent_ids = [str(r['entrant_id']) for r in se_rows if r['entrant_id']]

            if len(ent_ids) < 2:
                continue

            l_ent_id = ent_ids[0] if ent_ids[1] == w_ent_id else ent_ids[1]

            w_cid = entrant_player_map.get(w_ent_id)
            l_cid = entrant_player_map.get(l_ent_id)

            if not w_cid or not l_cid or w_cid == l_cid:
                continue

            # TrueSkill update
            w_ts = get_ts(w_cid)
            l_ts = get_ts(l_cid)
            new_w_ts, new_l_ts = ts_engine.update_match(w_ts, l_ts, 1.0)
            ts_ratings[w_cid] = new_w_ts
            ts_ratings[l_cid] = new_l_ts

            match_counts[w_cid] = match_counts.get(w_cid, 0) + 1
            match_counts[l_cid] = match_counts.get(l_cid, 0) + 1

            # Glicko-2 queue
            w_gl = get_glicko(w_cid)
            l_gl = get_glicko(l_cid)

            glicko_period_matches.setdefault(w_cid, []).append((l_gl[0], l_gl[1], 1.0))
            glicko_period_matches.setdefault(l_cid, []).append((w_gl[0], w_gl[1], 0.0))

        # Glicko-2 end of event update
        glicko_engine = Glicko2Engine()
        all_active_cids = set(ts_ratings.keys()).union(glicko_ratings.keys())
        for cid in all_active_cids:
            gl_state = get_glicko(cid)
            p_matches = glicko_period_matches.get(cid, [])
            glicko_ratings[cid] = glicko_engine.update_rating(gl_state, p_matches)

    conn.close()

    results = {}
    all_players = set(ts_ratings.keys()).union(glicko_ratings.keys()).union(placement_scores.keys())

    for cid in all_players:
        tag = player_tags.get(cid, f"Player {cid}")
        mu, sig = ts_ratings.get(cid, (TRUESKILL_MU0, TRUESKILL_SIGMA0))
        r, rd, sigma = glicko_ratings.get(cid, (GLICKO_R0, GLICKO_RD0, GLICKO_SIGMA0))
        pts = placement_scores.get(cid, 0.0)
        sof = sof_scores.get(cid, 0.0)
        m_count = match_counts.get(cid, 0)

        ts_conservative = mu - 3.0 * sig
        glicko_conservative = r - 2.0 * rd

        results[cid] = {
            "canonical_id": cid,
            "tag": tag,
            "matches_count": m_count,
            "trueskill": {
                "mu": round(mu, 2),
                "sigma": round(sig, 2),
                "conservative": round(ts_conservative, 2)
            },
            "glicko2": {
                "r": round(r, 1),
                "rd": round(rd, 1),
                "sigma": round(sigma, 4),
                "conservative": round(glicko_conservative, 1)
            },
            "placings": {
                "points": round(pts, 1)
            },
            "strength_of_field": {
                "score": round(sof, 1)
            }
        }

    return results

if __name__ == "__main__":
    init_db()
    res = calculate_statistical_rankings()
    print(f"Calculated statistical rankings for {len(res)} players.")
