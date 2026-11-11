"""Local Platfighters.uy web server with password-protected profile editing and ranking management."""

import base64
import getpass
import hmac
import json
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import time
import uuid
from base64 import binascii
from collections import defaultdict
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

try:
    import bcrypt
except ImportError:
    bcrypt = None

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.rankings_manager import (
    init_db as init_rankings_db,
    seed_existing_rankings,
    sync_static_rankings,
)
from scripts.metadata_generator import (
    get_page_metadata,
    inject_html_metadata,
)
from scripts.import_startgg_data import migrate_vod_schema
from scripts.youtube_vod import (
    extract_playlist_id,
    fetch_playlist_videos,
    is_valid_playlist_url,
    YouTubeAPIError,
    YouTubeConfigError,
)

PROFILE_DIR = ROOT / "data" / "profiles"
from scripts.tournament_dates import (
    load_tournament_date_overrides,
    save_tournament_date_overrides,
    normalize_tournament_slug,
    validate_date_string,
    resolve_tournament_date,
    resolve_tournament_timestamp,
    epoch_to_iso,
)

EVENT_GROUPS_PATH = PROFILE_DIR / "event_groups.json"
EXCLUSIONS_PATH = PROFILE_DIR / "exclusions.json"
COMMUNITY_SOCIALS_PATH = ROOT / "data" / "community_socials.json"
TOURNAMENT_DATES_PATH = PROFILE_DIR / "tournament_dates.json"
DATABASE = ROOT / "startgg-data" / "platfighters.sqlite3"
PLAYER_ASSETS = ROOT / "assets" / "players"
RANKING_PLAYER_ASSETS = ROOT / "assets" / "players" / "rankings"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,100}$")
MAX_BODY = 7 * 1024 * 1024
MAX_PHOTO = 5 * 1024 * 1024
SESSION_SECONDS = 8 * 60 * 60

# Authentication state
PASSWORD = os.environ.get("PLATFIGHTERS_ADMIN_PASSWORD", "")
PASSWORD_BCRYPT = None

# In-memory sessions: token -> { "expires": float, "csrf_token": str }
SESSIONS = {}

# Rate limiting for login attempts: client_ip -> list of timestamps
LOGIN_ATTEMPTS = defaultdict(list)
RATE_LIMIT_MAX_ATTEMPTS = 5
RATE_LIMIT_WINDOW = 300  # 5 minutes

MIME_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


def hash_password(plain_password: str) -> bytes:
    if bcrypt:
        return bcrypt.hashpw(plain_password.encode("utf-8"), bcrypt.gensalt(12))
    return plain_password.encode("utf-8")


def verify_password(plain_password: str) -> bool:
    global PASSWORD_BCRYPT, PASSWORD
    if bcrypt and PASSWORD_BCRYPT:
        try:
            return bcrypt.checkpw(plain_password.encode("utf-8"), PASSWORD_BCRYPT)
        except Exception:
            return False
    return hmac.compare_digest(plain_password, PASSWORD)


def init_auth():
    global PASSWORD, PASSWORD_BCRYPT
    if PASSWORD:
        if bcrypt:
            PASSWORD_BCRYPT = hash_password(PASSWORD)


init_auth()


def check_rate_limit(client_ip: str) -> bool:
    """Returns True if allowed, False if rate-limited."""
    now = time.time()
    attempts = [t for t in LOGIN_ATTEMPTS[client_ip] if now - t < RATE_LIMIT_WINDOW]
    LOGIN_ATTEMPTS[client_ip] = attempts
    return len(attempts) < RATE_LIMIT_MAX_ATTEMPTS


def record_login_attempt(client_ip: str):
    LOGIN_ATTEMPTS[client_ip].append(time.time())


def identity_merges():
    path = PROFILE_DIR / "merges.json"
    try:
        with path.open(encoding="utf-8") as stream:
            value = json.load(stream)
        return {str(source): str(target) for source, target in value.items()}
    except json.JSONDecodeError as err:
        print(f"Error: merges.json contains invalid JSON: {err}")
        raise ValueError(f"merges.json contains invalid JSON: {err}")
    except (OSError, AttributeError):
        return {}


def get_player_overlapping_events(player_a_id: str, player_b_id: str):
    db_path = ROOT / "startgg-data" / "platfighters.sqlite3"
    if not db_path.exists():
        return []
    try:
        con = sqlite3.connect(str(db_path))
        con.row_factory = sqlite3.Row
        cur = con.cursor()
        query = """
            SELECT DISTINCT
                e.id AS event_id,
                e.name AS event_name,
                t.name AS tournament_name,
                t.start_at AS start_at,
                e.videogame_slug AS game_slug,
                p.player_id AS player_id
            FROM entrants ent
            JOIN events e ON ent.event_id = e.id
            JOIN tournaments t ON e.tournament_slug = t.slug
            JOIN entrant_participants ep ON ep.entrant_id = ent.id
            JOIN participants p ON ep.participant_id = p.id
            WHERE p.player_id IN (?, ?)
        """
        cur.execute(query, (str(player_a_id), str(player_b_id)))
        rows = cur.fetchall()
        con.close()

        events_by_id = defaultdict(list)
        event_info = {}
        for row in rows:
            eid = str(row["event_id"])
            events_by_id[eid].append(str(row["player_id"]))
            if eid not in event_info:
                event_info[eid] = {
                    "eventId": eid,
                    "eventName": row["event_name"] or "",
                    "tournamentName": row["tournament_name"] or "",
                    "startAt": row["start_at"],
                    "gameSlug": row["game_slug"] or "",
                }

        overlaps = [event_info[eid] for eid, pids in events_by_id.items() if len(set(pids)) > 1]
        return overlaps
    except Exception:
        return []


def canonical_id(player_id, merges):
    current, seen = str(player_id), set()
    while current in merges and current not in seen:
        seen.add(current)
        current = merges[current]
    return current


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


def event_groups():
    try:
        with EVENT_GROUPS_PATH.open(encoding="utf-8") as stream:
            value = json.load(stream)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError as err:
        print(f"Error: event_groups.json contains invalid JSON: {err}")
        raise ValueError(f"event_groups.json contains invalid JSON: {err}")
    except OSError:
        return {}


def enrich_event_groups(groups):
    with sqlite3.connect(DATABASE) as conn:
        rows = conn.execute("SELECT e.source_url, t.name FROM events e JOIN tournaments t ON e.tournament_slug = t.slug").fetchall()
        tourneys = dict(conn.execute("SELECT slug, name FROM tournaments").fetchall())
    url_to_tourney = {}
    for r in rows:
        url_to_tourney[normalize_event_key(r[0])] = r[1]
        url_to_tourney[r[0]] = r[1]

    enriched = {}
    for child_key, grp in groups.items():
        parent_key = grp.get("parent", "")
        child_tourney = url_to_tourney.get(normalize_event_key(child_key))
        if not child_tourney:
            child_slug = child_key.split("/")[1] if "/" in child_key else child_key
            child_tourney = tourneys.get(child_slug, child_slug)
        parent_tourney = url_to_tourney.get(normalize_event_key(parent_key))
        if not parent_tourney:
            parent_slug = parent_key.split("/")[1] if "/" in parent_key else parent_key
            parent_tourney = tourneys.get(parent_slug, parent_slug)

        enriched[child_key] = {
            "parent": parent_key,
            "phase": grp.get("phase", ""),
            "childTournament": child_tourney,
            "parentTournament": parent_tourney
        }
    return enriched


def visibility_exclusions():
    try:
        with EXCLUSIONS_PATH.open(encoding="utf-8") as stream:
            value = json.load(stream)
        events = value.get("events", []) if isinstance(value, dict) else []
        player_games = value.get("playerGames", {}) if isinstance(value, dict) else {}
        return {
            "events": sorted({key for item in events if (key := normalize_event_key(item))}),
            "playerGames": player_games if isinstance(player_games, dict) else {},
        }
    except json.JSONDecodeError as err:
        print(f"Error: exclusions.json contains invalid JSON: {err}")
        raise ValueError(f"exclusions.json contains invalid JSON: {err}")
    except (OSError, AttributeError, TypeError):
        return {"events": [], "playerGames": {}}


def community_socials():
    try:
        if COMMUNITY_SOCIALS_PATH.exists():
            with COMMUNITY_SOCIALS_PATH.open(encoding="utf-8") as stream:
                data = json.load(stream)
                if isinstance(data, dict):
                    return data
    except json.JSONDecodeError as err:
        print(f"Error: community_socials.json contains invalid JSON: {err}")
        raise ValueError(f"community_socials.json contains invalid JSON: {err}")
    except OSError:
        pass
    return {}


def rebuild_profiles():
    builder = ROOT / "scripts" / "build_player_profile.py"
    res = subprocess.run([sys.executable, str(builder), "--all"], cwd=ROOT,
                         capture_output=True, text=True)
    try:
        from scripts.rankings_calculator import export_ranking_data, export_default_rankings
        export_ranking_data()
        export_default_rankings()
    except Exception as err:
        print(f"Warning: could not export default rankings or ranking data: {err}")
    return res


def safe_slug(value):
    return isinstance(value, str) and bool(SLUG_RE.fullmatch(value))


def atomic_json(path, value):
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    temp.replace(path)


NON_PROFILE_NAMES = {
    "index.json",
    "overrides.json",
    "merges.json",
    "startgg_metadata.json",
    "amateur_brackets.json",
    "event_groups.json",
    "exclusions.json",
    "tournament_dates.json",
}


def profile_entries(public_only=False):
    entries_by_id = {}
    merged_ids = identity_merges()
    exclusions = visibility_exclusions() if public_only else None
    for path in sorted(PROFILE_DIR.glob("*.json")):
        if path.name in NON_PROFILE_NAMES:
            continue
        try:
            with path.open(encoding="utf-8") as stream:
                profile = json.load(stream)
                player = (profile.get("player") or {})
        except (OSError, json.JSONDecodeError):
            continue
        if not player.get("tag"):
            continue
        player_id = str(player.get("startggPlayerId") or "")
        if player_id in merged_ids:
            continue
        if public_only and player_id:
            hidden_games = set(exclusions["playerGames"].get(player_id, []))
            games = [game for game in profile.get("games", [])
                     if game.get("id") not in hidden_games and game.get("slug") not in hidden_games]
            has_visible_data = any(
                any(
                    any(source.get("eventKey") not in exclusions["events"]
                        for source in result.get("sourceEvents", []))
                    if result.get("sourceEvents") else result.get("eventKey") not in exclusions["events"]
                    for result in game.get("results", [])
                )
                for game in games
            )
            if not has_visible_data:
                continue
        games_list = games if (public_only and player_id) else profile.get("games", [])
        games_summary = [
            {
                "id": g.get("id"),
                "slug": g.get("slug") or g.get("id"),
                "name": g.get("name"),
                "events": int(g.get("events") or 0),
            }
            for g in games_list
        ]
        total_events = sum(g["events"] for g in games_summary)
        entry = {
            "playerId": player_id,
            "tag": player.get("tag") or path.stem,
            "slug": path.stem,
            "sponsor": player.get("sponsor"),
            "city": player.get("city"),
            "country": player.get("country"),
            "location": player.get("location"),
            "aliases": player.get("aliases") or [],
            "photo": player.get("photo"),
            "games": games_summary,
            "events": total_events,
        }
        if not player_id:
            entries_by_id[f"file:{path.stem}"] = entry
        elif player_id not in entries_by_id or path.stem.endswith(f"-{player_id}"):
            entries_by_id[player_id] = entry
    return sorted(entries_by_id.values(), key=lambda entry: (entry["tag"].casefold(), entry["playerId"]))


def refresh_index():
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    atomic_json(PROFILE_DIR / "index.json", profile_entries(public_only=True))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status, value, extra_headers=None):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, header_value in (extra_headers or {}).items():
            self.send_header(key, header_value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Invalid request size")
        if length < 0 or length > MAX_BODY:
            raise OverflowError("Request is too large")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("Request must contain valid JSON")

    def session_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return None
        morsel = cookie.get("platfighters_admin")
        return morsel.value if morsel else None

    def get_session(self):
        token = self.session_token()
        if not token:
            return None
        session = SESSIONS.get(token)
        if not session:
            return None
        if session["expires"] < time.time():
            SESSIONS.pop(token, None)
            return None
        return session

    def is_admin(self):
        return self.get_session() is not None

    def require_admin(self):
        if not self.is_admin():
            self.send_json(401, {"error": "Administrator sign-in required."})
            return False
        return True

    def has_admin_header(self):
        return self.headers.get("X-Admin-Request") == "1"

    def verify_csrf(self):
        """Verifies CSRF token on state-changing requests."""
        csrf_hdr = self.headers.get("X-CSRF-Token")
        session = self.get_session()
        if not session or not csrf_hdr or not hmac.compare_digest(csrf_hdr, session.get("csrf_token", "")):
            return False
        return True

    def client_ip(self):
        forwarded = self.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return self.client_address[0] if self.client_address else "127.0.0.1"

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == "/api/admin/session":
            session = self.get_session()
            if session:
                self.send_json(200, {
                    "authenticated": True,
                    "csrfToken": session["csrf_token"]
                })
            else:
                self.send_json(200, {"authenticated": False})
        elif parsed.path == "/api/admin/profiles":
            if not self.require_admin():
                return
            self.send_json(200, {"profiles": profile_entries()})
        elif parsed.path == "/api/admin/profile":
            if not self.require_admin():
                return
            slug = parse_qs(parsed.query).get("slug", [""])[0]
            if not safe_slug(slug):
                self.send_json(400, {"error": "Invalid profile slug."})
                return
            try:
                with (PROFILE_DIR / f"{slug}.json").open(encoding="utf-8") as stream:
                    self.send_json(200, {"profile": json.load(stream)})
            except FileNotFoundError:
                self.send_json(404, {"error": f"Profile file '{slug}.json' not found."})
            except json.JSONDecodeError as err:
                self.send_json(500, {"error": f"The profile file '{slug}.json' contains invalid JSON: {err}"})
        elif parsed.path == "/api/player-profile-lookup":
            player_id = parse_qs(parsed.query).get("playerId", [""])[0].strip()
            if not player_id.isdigit():
                self.send_json(400, {"error": "Invalid playerId."})
                return
            # Search for profile file matching player_id
            target_slug = None
            for p in PROFILE_DIR.glob(f"*-{player_id}.json"):
                if p.name not in NON_PROFILE_NAMES:
                    target_slug = p.stem
                    break
            if not target_slug:
                for p in PROFILE_DIR.glob("*.json"):
                    if p.name in NON_PROFILE_NAMES:
                        continue
                    try:
                        with p.open(encoding="utf-8") as stream:
                            data = json.load(stream)
                            if str(data.get("player", {}).get("startggPlayerId") or "") == player_id:
                                target_slug = p.stem
                                break
                    except Exception:
                        continue
            if target_slug:
                self.send_json(200, {"playerId": player_id, "slug": target_slug})
            else:
                self.send_json(404, {"error": "Profile not found."})
        elif parsed.path == "/api/admin/merges":
            if not self.require_admin():
                return
            try:
                self.send_json(200, {"merges": identity_merges()})
            except Exception as err:
                self.send_json(500, {"error": str(err)})
        elif parsed.path == "/api/admin/community-socials":
            if not self.require_admin():
                return
            try:
                self.send_json(200, {"socials": community_socials()})
            except Exception as err:
                self.send_json(500, {"error": str(err)})
        elif parsed.path == "/api/admin/tournament-dates":
            if not self.require_admin():
                return
            try:
                overrides = load_tournament_date_overrides(ROOT)
                with sqlite3.connect(DATABASE) as connection:
                    connection.row_factory = sqlite3.Row
                    rows = connection.execute(
                        "SELECT t.slug, t.name, t.start_at, "
                        "(SELECT MIN(COALESCE(s.started_at, s.start_at, s.completed_at)) "
                        "FROM events e JOIN sets s ON s.event_id=e.id WHERE e.tournament_slug=t.slug) AS earliest_set_ts "
                        "FROM tournaments t ORDER BY t.name ASC"
                    ).fetchall()
                tournaments = []
                for row in rows:
                    slug = row["slug"]
                    orig_date = epoch_to_iso(row["start_at"]) or epoch_to_iso(row["earliest_set_ts"])
                    override_date = overrides.get(slug)
                    effective_date = override_date or orig_date
                    tournaments.append({
                        "slug": slug,
                        "name": row["name"] or slug,
                        "originalDate": orig_date,
                        "overrideDate": override_date,
                        "effectiveDate": effective_date,
                        "isOverridden": bool(override_date),
                    })
                tournaments.sort(key=lambda item: (item["effectiveDate"] or "", item["name"]), reverse=True)
                self.send_json(200, {"tournaments": tournaments, "overrides": overrides})
            except Exception as err:
                self.send_json(500, {"error": f"Could not load tournament dates: {err}"})
        elif parsed.path == "/api/admin/event-groups":
            if not self.require_admin():
                return
            try:
                groups = event_groups()
                self.send_json(200, {"eventGroups": enrich_event_groups(groups)})
            except Exception as err:
                self.send_json(500, {"error": str(err)})
        elif parsed.path in {"/api/admin/events", "/api/admin/imported-events"}:
            if not self.require_admin():
                return
            try:
                with sqlite3.connect(DATABASE) as connection:
                    migrate_vod_schema(connection)
                    rows = connection.execute(
                        "SELECT e.id, e.source_url, t.name, e.name, v.name, t.start_at, "
                        "e.vod_playlist_url, "
                        "(SELECT COUNT(*) FROM event_vods ev WHERE ev.event_id = e.id) AS vod_count "
                        "FROM events e "
                        "JOIN tournaments t ON e.tournament_slug = t.slug "
                        "JOIN videogames v ON e.videogame_slug = v.slug "
                        "ORDER BY t.start_at DESC, t.name ASC, e.name ASC"
                    ).fetchall()
                events = [
                    {
                        "id": str(row[0]),
                        "sourceUrl": row[1],
                        "tournamentName": row[2],
                        "eventName": row[3],
                        "gameName": row[4],
                        "startAt": row[5],
                        "vodPlaylistUrl": row[6] or "",
                        "vodCount": row[7] or 0,
                    }
                    for row in rows
                ]
                self.send_json(200, {"events": events})
            except sqlite3.Error as error:
                self.send_json(500, {"error": f"Could not load imported events: {error}"})
        elif parsed.path == "/api/admin/event-vod-info":
            if not self.require_admin():
                return
            qs = parse_qs(parsed.query)
            event_id = qs.get("eventId", [None])[0]
            if not event_id:
                self.send_json(400, {"error": "Missing eventId query parameter."})
                return
            try:
                with sqlite3.connect(DATABASE) as connection:
                    connection.row_factory = sqlite3.Row
                    migrate_vod_schema(connection)

                    # 1. Event metadata
                    ev_row = connection.execute(
                        "SELECT e.id, e.name, e.source_url, e.vod_playlist_url, t.name as tournament_name, v.name as game_name "
                        "FROM events e "
                        "JOIN tournaments t ON t.slug=e.tournament_slug "
                        "JOIN videogames v ON v.slug=e.videogame_slug "
                        "WHERE e.id=?", (str(event_id),)
                    ).fetchone()
                    if not ev_row:
                        self.send_json(404, {"error": f"Event not found with ID {event_id}"})
                        return

                    # 2. Entrants
                    entrants_rows = connection.execute(
                        "SELECT en.id, en.name, p.player_id, p.gamer_tag "
                        "FROM entrants en "
                        "LEFT JOIN entrant_participants ep ON ep.entrant_id=en.id "
                        "LEFT JOIN participants p ON p.id=ep.participant_id "
                        "WHERE en.event_id=? ORDER BY en.name COLLATE NOCASE ASC", (str(event_id),)
                    ).fetchall()
                    entrants = []
                    seen_entrants = set()
                    for er in entrants_rows:
                        eid_str = str(er["id"])
                        if eid_str not in seen_entrants:
                            seen_entrants.add(eid_str)
                            entrants.append({
                                "id": eid_str,
                                "name": er["name"] or er["gamer_tag"] or "Unknown",
                                "gamerTag": er["gamer_tag"] or er["name"] or "Unknown",
                                "playerId": str(er["player_id"]) if er["player_id"] is not None else None,
                            })

                    # 3. Sets & Opponent pairings & Matches
                    set_rows = connection.execute(
                        "SELECT s.id, s.display_score, s.round, s.full_round_text, s.identifier, "
                        "s.winner_entrant_id, ph.name as phase_name, "
                        "se1.entrant_id as e1, se2.entrant_id as e2 "
                        "FROM sets s "
                        "LEFT JOIN phase_groups pg ON pg.id=s.phase_group_id "
                        "LEFT JOIN phases ph ON ph.id=pg.phase_id "
                        "JOIN set_entrants se1 ON se1.set_id=s.id AND se1.slot_order=0 "
                        "JOIN set_entrants se2 ON se2.set_id=s.id AND se2.slot_order=1 "
                        "WHERE s.event_id=?", (str(event_id),)
                    ).fetchall()

                    opponent_map = defaultdict(set)
                    matches_by_pair = defaultdict(list)
                    set_to_entrants = {}

                    for sr in set_rows:
                        sid = str(sr["id"])
                        e1 = str(sr["e1"])
                        e2 = str(sr["e2"])
                        if e1 and e2 and e1 != e2:
                            opponent_map[e1].add(e2)
                            opponent_map[e2].add(e1)
                            pair_key = "_".join(sorted([e1, e2]))
                            set_to_entrants[sid] = (e1, e2)

                            phase_str = sr["phase_name"] or "Bracket"
                            round_str = sr["full_round_text"] or (f"Round {sr['round']}" if sr["round"] is not None else "")
                            ident_str = f"Match {sr['identifier']}" if sr["identifier"] else ""
                            label_parts = [p for p in (phase_str, round_str, ident_str) if p]
                            match_label = " – ".join(label_parts) if label_parts else f"Match {sid}"
                            if sr["display_score"]:
                                match_label += f" ({sr['display_score']})"

                            matches_by_pair[pair_key].append({
                                "id": sid,
                                "phase": phase_str,
                                "round": round_str,
                                "identifier": sr["identifier"] or "",
                                "displayScore": sr["display_score"] or "",
                                "winnerEntrantId": str(sr["winner_entrant_id"]) if sr["winner_entrant_id"] is not None else None,
                                "label": match_label,
                            })

                    # 4. Current VOD records for this event
                    vod_rows = connection.execute(
                        "SELECT id, event_id, match_id, youtube_video_id, youtube_playlist_item_id, "
                        "youtube_title, youtube_thumbnail_url, status, availability, created_at, updated_at "
                        "FROM event_vods WHERE event_id=? ORDER BY id ASC", (str(event_id),)
                    ).fetchall()

                    vods = []
                    for vr in vod_rows:
                        mid = str(vr["match_id"]) if vr["match_id"] is not None else None
                        p1_id = None
                        p2_id = None
                        if mid and mid in set_to_entrants:
                            p1_id, p2_id = set_to_entrants[mid]

                        vods.append({
                            "id": vr["id"],
                            "eventId": str(vr["event_id"]),
                            "matchId": mid,
                            "youtubeVideoId": vr["youtube_video_id"],
                            "youtubePlaylistItemId": vr["youtube_playlist_item_id"],
                            "youtubeTitle": vr["youtube_title"],
                            "youtubeThumbnailUrl": vr["youtube_thumbnail_url"],
                            "status": vr["status"],
                            "availability": vr["availability"] if "availability" in vr.keys() else "available",
                            "p1EntrantId": p1_id,
                            "p2EntrantId": p2_id,
                            "createdAt": vr["created_at"],
                            "updatedAt": vr["updated_at"],
                        })

                serializable_opponents = {k: sorted(list(v)) for k, v in opponent_map.items()}
                self.send_json(200, {
                    "event": {
                        "id": str(ev_row["id"]),
                        "name": ev_row["name"],
                        "tournamentName": ev_row["tournament_name"],
                        "gameName": ev_row["game_name"],
                        "sourceUrl": ev_row["source_url"],
                        "vodPlaylistUrl": ev_row["vod_playlist_url"] or "",
                        "vodCount": len(vods),
                    },
                    "entrants": entrants,
                    "opponentMap": serializable_opponents,
                    "matchesByPair": dict(matches_by_pair),
                    "vods": vods,
                })
            except Exception as err:
                self.send_json(500, {"error": f"Failed to load VOD info: {err}"})
        elif parsed.path == "/api/admin/exclusions":
            if not self.require_admin():
                return
            try:
                self.send_json(200, {"exclusions": visibility_exclusions()})
            except Exception as err:
                self.send_json(500, {"error": str(err)})
        elif parsed.path == "/api/admin/rankings":
            if not self.require_admin():
                return
            qs = parse_qs(parsed.query)
            game_filter = qs.get("game", [None])[0]
            search_query = qs.get("search", [None])[0]
            include_archived = qs.get("includeArchived", ["0"])[0] in {"1", "true", "yes"}

            try:
                init_rankings_db()
                with sqlite3.connect(DATABASE) as connection:
                    connection.row_factory = sqlite3.Row
                    sql = "SELECT * FROM official_rankings"
                    clauses = []
                    params = []

                    if not include_archived:
                        clauses.append("is_archived = 0")
                    if game_filter and game_filter != "all":
                        clauses.append("(game_slug = ? OR game_id = ?)")
                        params.extend([game_filter, game_filter])
                    if search_query and search_query.strip():
                        clauses.append("title LIKE ?")
                        params.append(f"%{search_query.strip()}%")

                    if clauses:
                        sql += " WHERE " + " AND ".join(clauses)
                    sql += " ORDER BY period_end DESC, created_at DESC"

                    rows = connection.execute(sql, params).fetchall()

                    rankings_list = []
                    for r in rows:
                        try:
                            players = json.loads(r["players_json"])
                        except Exception:
                            players = []
                        rankings_list.append({
                            "id": r["id"],
                            "title": r["title"],
                            "gameSlug": r["game_slug"],
                            "gameId": r["game_id"],
                            "periodStart": r["period_start"],
                            "periodEnd": r["period_end"],
                            "status": r["status"],
                            "publishedBy": r["published_by"] or "",
                            "intro": r["intro"] or "",
                            "playerCount": len(players),
                            "createdAt": r["created_at"],
                            "updatedAt": r["updated_at"],
                            "isArchived": bool(r["is_archived"]),
                        })
                    self.send_json(200, {"rankings": rankings_list})
            except Exception as e:
                self.send_json(500, {"error": f"Could not load rankings: {e}"})
        elif parsed.path.startswith("/api/admin/rankings/"):
            if not self.require_admin():
                return
            rid = parsed.path.split("/api/admin/rankings/")[1].strip()
            if not safe_slug(rid):
                self.send_json(400, {"error": "Invalid ranking ID."})
                return
            try:
                init_rankings_db()
                with sqlite3.connect(DATABASE) as connection:
                    connection.row_factory = sqlite3.Row
                    row = connection.execute("SELECT * FROM official_rankings WHERE id = ?", (rid,)).fetchone()
                    if not row:
                        self.send_json(404, {"error": "Ranking not found."})
                        return
                    try:
                        players = json.loads(row["players_json"])
                    except Exception:
                        players = []

                    data = {
                        "id": row["id"],
                        "title": row["title"],
                        "game": {
                            "id": row["game_id"],
                            "slug": row["game_slug"],
                        },
                        "period": {
                            "start": row["period_start"],
                            "end": row["period_end"],
                        },
                        "status": row["status"],
                        "publishedBy": row["published_by"] or "",
                        "intro": row["intro"] or "",
                        "players": players,
                        "isArchived": bool(row["is_archived"]),
                    }
                    if "image_box" in row.keys() and row["image_box"]:
                        try:
                            ib = json.loads(row["image_box"])
                            if isinstance(ib, dict) and ib.get("url"):
                                data["imageBox"] = ib
                        except Exception:
                            pass
                    self.send_json(200, {"ranking": data})
            except Exception as e:
                self.send_json(500, {"error": f"Error loading ranking: {e}"})
        elif parsed.path == "/api/games":
            data_index = ROOT / "data" / "rankings" / "data" / "index.json"
            games_json_file = ROOT / "data" / "games.json"
            if data_index.is_file():
                try:
                    with data_index.open(encoding="utf-8") as f:
                        catalog = json.load(f)
                    games_list = [{"slug": g["slug"], "name": g["name"]} for g in catalog.get("games", [])]
                    self.send_json(200, {"games": games_list})
                    return
                except Exception:
                    pass
            elif games_json_file.is_file():
                try:
                    with games_json_file.open(encoding="utf-8") as f:
                        catalog = json.load(f)
                    games_list = [{"slug": g["slug"], "name": g["name"]} for g in catalog.get("games", [])]
                    self.send_json(200, {"games": games_list})
                    return
                except Exception:
                    pass

            try:
                with sqlite3.connect(DATABASE) as connection:
                    rows = connection.execute("SELECT slug, name FROM videogames ORDER BY name ASC").fetchall()
                self.send_json(200, {"games": [{"slug": r[0], "name": r[1]} for r in rows]})
            except sqlite3.Error as error:
                self.send_json(500, {"error": f"Could not load games: {error}"})
        elif parsed.path == "/api/rankings":
            qs = parse_qs(parsed.query)
            game = qs.get("game", ["ultimate"])[0]
            system = qs.get("system", ["glicko2"])[0]
            mode = qs.get("mode", ["historical"])[0]
            start_date = qs.get("start_date", qs.get("start", [None]))[0]
            end_date = qs.get("end_date", qs.get("end", [None]))[0]
            weights_param = qs.get("weights", [None])[0]

            if not start_date or not start_date.strip():
                start_date = None
            if not end_date or not end_date.strip():
                end_date = None

            try:
                from scripts.rankings_calculator import RankingEngine
                engine = RankingEngine()
                data = engine.calculate(
                    game_slug=game,
                    system=system,
                    mode=mode,
                    start_date=start_date,
                    end_date=end_date,
                    weights=weights_param,
                )
                self.send_json(200, data)
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
            except Exception as error:
                self.send_json(500, {"error": f"Could not calculate rankings: {error}"})
        elif parsed.path == "/api/rankings/diagnostic":
            qs = parse_qs(parsed.query)
            game = qs.get("game", ["ultimate"])[0]
            system = qs.get("system", ["glicko2"])[0]
            mode = qs.get("mode", ["historical"])[0]
            start_date = qs.get("start_date", qs.get("start", [None]))[0]
            end_date = qs.get("end_date", qs.get("end", [None]))[0]
            player_id = qs.get("player_id", qs.get("playerId", [None]))[0]
            weights_param = qs.get("weights", [None])[0]

            if not start_date or not start_date.strip():
                start_date = None
            if not end_date or not end_date.strip():
                end_date = None
            if player_id is not None:
                player_id = player_id.strip() or None

            if not player_id:
                self.send_json(400, {"error": "player_id parameter is required for diagnostic view."})
                return

            try:
                from scripts.rankings_calculator import RankingEngine
                engine = RankingEngine()
                data = engine.calculate(
                    game_slug=game,
                    system=system,
                    mode=mode,
                    start_date=start_date,
                    end_date=end_date,
                    target_player_id=player_id,
                    weights=weights_param,
                )
                self.send_json(200, data)
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
            except Exception as error:
                self.send_json(500, {"error": f"Could not calculate diagnostic rankings: {error}"})
        elif parsed.path == "/api/admin/player-games":
            if not self.require_admin():
                return
            player_id = parse_qs(parsed.query).get("playerId", [""])[0]
            profiles = {entry["playerId"] for entry in profile_entries() if entry["playerId"]}
            if player_id not in profiles:
                self.send_json(404, {"error": "Player profile not found."})
                return
            merges = identity_merges()
            identity_ids = {player_id}
            identity_ids.update(source for source in merges if canonical_id(source, merges) == player_id)
            try:
                with sqlite3.connect(DATABASE) as connection:
                    games = connection.execute(
                        "SELECT DISTINCT v.slug, v.name FROM participants p "
                        "JOIN entrant_participants ep ON ep.participant_id=p.id "
                        "JOIN entrants en ON en.id=ep.entrant_id JOIN events e ON e.id=en.event_id "
                        "JOIN videogames v ON v.slug=e.videogame_slug "
                        f"WHERE p.player_id IN ({','.join('?' for _ in identity_ids)}) ORDER BY v.name",
                        sorted(identity_ids),
                    ).fetchall()
            except sqlite3.Error as error:
                self.send_json(500, {"error": f"Could not load the player's games: {error}"})
                return
            excluded = visibility_exclusions()["playerGames"].get(player_id, [])
            self.send_json(200, {"games": [{"id": row[0], "name": row[1]} for row in games], "excluded": excluded})
        elif parsed.path.startswith("/api/"):
            self.send_json(404, {"error": "Not found."})
        else:
            # Check if this request is for an HTML page or directory index
            clean_path = parsed.path.strip("/")
            is_root = clean_path == ""
            is_html = clean_path.endswith(".html") or is_root
            if is_html:
                html_filename = "index.html" if is_root else clean_path
                target_file = ROOT / html_filename
                if target_file.is_file():
                    try:
                        with target_file.open("r", encoding="utf-8") as f:
                            content = f.read()

                        host_hdr = self.headers.get("Host", "")
                        proto_hdr = self.headers.get("X-Forwarded-Proto", "")
                        meta = get_page_metadata(html_filename, parsed.query, host_hdr, proto_hdr)
                        injected_html = inject_html_metadata(content, meta)

                        body = injected_html.encode("utf-8")
                        self.send_response(200)
                        self.send_header("Content-Type", "text/html; charset=utf-8")
                        self.send_header("Content-Length", str(len(body)))
                        self.send_header("Cache-Control", "no-cache")
                        self.end_headers()
                        self.wfile.write(body)
                        return
                    except Exception as err:
                        print(f"Error rendering metadata for {self.path}: {err}")

            super().do_GET()

    def do_POST(self):
        parsed = urlsplit(self.path)
        if not self.has_admin_header():
            self.send_json(403, {"error": "Request rejected."})
            return

        client_ip = self.client_ip()

        try:
            body = self.read_json()
        except OverflowError as error:
            self.send_json(413, {"error": str(error)})
            return
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        if not isinstance(body, dict):
            self.send_json(400, {"error": "Invalid request."})
            return

        if parsed.path == "/api/admin/login":
            if not check_rate_limit(client_ip):
                self.send_json(429, {"error": "Too many failed sign-in attempts. Please wait 5 minutes before trying again."})
                return

            password = body.get("password")
            if not PASSWORD and not PASSWORD_BCRYPT:
                self.send_json(503, {"error": "Admin access is not configured on this server."})
                return
            if not isinstance(password, str) or not verify_password(password):
                record_login_attempt(client_ip)
                self.send_json(401, {"error": "That password was not accepted."})
                return

            # Regenerate session token
            token = secrets.token_urlsafe(32)
            csrf_token = secrets.token_urlsafe(32)
            SESSIONS[token] = {
                "expires": time.time() + SESSION_SECONDS,
                "csrf_token": csrf_token,
            }
            self.send_json(
                200,
                {"authenticated": True, "csrfToken": csrf_token},
                {"Set-Cookie": f"platfighters_admin={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_SECONDS}"}
            )
            return

        # State-changing operations require authentication & CSRF verification
        if not self.require_admin():
            return

        if not self.verify_csrf():
            self.send_json(403, {"error": "Invalid or missing CSRF token."})
            return

        if parsed.path == "/api/admin/logout":
            token = self.session_token()
            if token:
                SESSIONS.pop(token, None)
            self.send_json(200, {"authenticated": False}, {"Set-Cookie": "platfighters_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"})
        elif parsed.path == "/api/admin/rankings":
            ranking_data = body.get("ranking")
            if not isinstance(ranking_data, dict):
                self.send_json(400, {"error": "Invalid ranking payload."})
                return

            rid = str(ranking_data.get("id") or "").strip()
            title = str(ranking_data.get("title") or "").strip()
            game = ranking_data.get("game") or {}
            game_slug = str(game.get("slug") or "").strip()
            game_id = str(game.get("id") or "").strip()
            period = ranking_data.get("period") or {}
            start = str(period.get("start") or "").strip()
            end = str(period.get("end") or "").strip()
            status = str(ranking_data.get("status") or "yearly").strip()
            published_by = str(ranking_data.get("publishedBy") or "").strip()
            intro = str(ranking_data.get("intro") or "").strip()
            players = ranking_data.get("players")
            image_box_raw = ranking_data.get("imageBox")
            image_box_str = None
            if isinstance(image_box_raw, dict) and image_box_raw.get("url"):
                sanitized_ib = {
                    "url": str(image_box_raw["url"]).strip()[:500],
                    "placement": image_box_raw.get("placement") if image_box_raw.get("placement") in {"beginning", "after_intro", "end"} else "after_intro",
                    "caption": str(image_box_raw.get("caption") or "").strip()[:300]
                }
                if sanitized_ib["url"]:
                    image_box_str = json.dumps(sanitized_ib, ensure_ascii=False)

            if not safe_slug(rid) or not title or not game_slug or not start or not end or not isinstance(players, list):
                self.send_json(400, {"error": "Missing required ranking fields (id, title, game, period, players)."})
                return

            if status not in {"yearly", "seasonal"}:
                self.send_json(400, {"error": "Classification must be 'yearly' or 'seasonal'."})
                return

            sanitized_players = []
            seen_player_ids = set()
            for p in players:
                if not isinstance(p, dict) or not p.get("tag"):
                    self.send_json(400, {"error": "Each player must have a valid tag."})
                    return
                pid = str(p.get("playerId") or "").strip()
                if pid:
                    if pid in seen_player_ids:
                        self.send_json(400, {"error": f"Duplicate player ID '{pid}' in ranking."})
                        return
                    seen_player_ids.add(pid)
                sanitized_player = {
                    "placement": int(p.get("placement") or (len(sanitized_players) + 1)),
                    "tag": str(p["tag"]).strip()[:80],
                }
                if pid:
                    sanitized_player["playerId"] = pid
                if p.get("sponsor"):
                    sanitized_player["sponsor"] = str(p["sponsor"]).strip()[:50]
                if p.get("points") is not None and str(p.get("points")).strip() != "":
                    try:
                        sanitized_player["points"] = float(p["points"])
                    except (ValueError, TypeError):
                        pass
                if p.get("photo"):
                    sanitized_player["photo"] = str(p["photo"]).strip()[:240]
                if p.get("realName"):
                    sanitized_player["realName"] = str(p["realName"]).strip()[:100]
                if isinstance(p.get("mains"), list):
                    sanitized_player["mains"] = [str(m).strip()[:50] for m in p["mains"] if str(m).strip()]
                if p.get("text"):
                    sanitized_player["text"] = str(p["text"]).strip()[:2000]
                if isinstance(p.get("notableWins"), list):
                    sanitized_player["notableWins"] = []
                    for w in p["notableWins"]:
                        if isinstance(w, dict) and w.get("opponent"):
                            win_obj = {"opponent": str(w["opponent"]).strip()[:80]}
                            if "times" in w and w["times"] is not None:
                                try:
                                    win_obj["times"] = int(w["times"])
                                except (ValueError, TypeError):
                                    win_obj["times"] = 1
                            elif "tournament" in w:
                                win_obj["tournament"] = str(w.get("tournament") or "").strip()[:100]
                            sanitized_player["notableWins"].append(win_obj)
                if isinstance(p.get("notableResults"), list):
                    sanitized_player["notableResults"] = []
                    for r in p["notableResults"]:
                        if isinstance(r, dict) and r.get("event"):
                            res_obj = {
                                "placement": r.get("placement"),
                                "event": str(r["event"]).strip()[:120],
                                "entrants": r.get("entrants")
                            }
                            sanitized_player["notableResults"].append(res_obj)

                sanitized_players.append(sanitized_player)

            now = int(time.time())
            try:
                init_rankings_db()
                with sqlite3.connect(DATABASE) as connection:
                    existing = connection.execute("SELECT created_at FROM official_rankings WHERE id = ?", (rid,)).fetchone()
                    created_at = existing[0] if existing else now

                    connection.execute(
                        """
                        INSERT OR REPLACE INTO official_rankings (
                            id, title, game_slug, game_id, period_start, period_end,
                            status, published_by, intro, players_json,
                            created_at, updated_at, is_archived, image_box
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                        """,
                        (
                            rid,
                            title[:150],
                            game_slug[:50],
                            game_id[:50],
                            start[:20],
                            end[:20],
                            status,
                            published_by[:100],
                            intro[:2000],
                            json.dumps(sanitized_players, ensure_ascii=False),
                            created_at,
                            now,
                            image_box_str,
                        )
                    )
                    connection.commit()

                sync_static_rankings()
                self.send_json(200, {"success": True, "id": rid})
            except Exception as e:
                self.send_json(500, {"error": f"Failed to publish ranking: {e}"})
        elif parsed.path == "/api/admin/photo":
            player_id, data_url = str(body.get("playerId", "")), body.get("data", "")
            if not player_id.isdigit() or not isinstance(data_url, str) or "," not in data_url:
                self.send_json(400, {"error": "Invalid picture upload."})
                return
            header, encoded = data_url.split(",", 1)
            mime = header.removeprefix("data:").removesuffix(";base64")
            if mime not in MIME_EXTENSIONS:
                self.send_json(400, {"error": "Use a PNG, JPEG or WebP picture."})
                return
            try:
                photo = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                self.send_json(400, {"error": "The picture data is invalid."})
                return
            signatures = {
                "image/png": photo.startswith(b"\x89PNG\r\n\x1a\n"),
                "image/jpeg": photo.startswith(b"\xff\xd8\xff"),
                "image/webp": len(photo) >= 12 and photo[:4] == b"RIFF" and photo[8:12] == b"WEBP",
            }
            if not photo or len(photo) > MAX_PHOTO or not signatures[mime]:
                self.send_json(400, {"error": "The picture must be a valid image no larger than 5 MB."})
                return
            PLAYER_ASSETS.mkdir(parents=True, exist_ok=True)
            path = PLAYER_ASSETS / f"{player_id}{MIME_EXTENSIONS[mime]}"
            path.write_bytes(photo)
            self.send_json(200, {"path": f"assets/players/{path.name}"})
        elif parsed.path == "/api/admin/ranking-photo":
            player_id, data_url = str(body.get("playerId", "")).strip(), body.get("data", "")
            if not isinstance(data_url, str) or "," not in data_url:
                self.send_json(400, {"error": "Invalid picture upload."})
                return
            header, encoded = data_url.split(",", 1)
            mime = header.removeprefix("data:").removesuffix(";base64")
            if mime not in MIME_EXTENSIONS:
                self.send_json(400, {"error": "Use a PNG, JPEG or WebP picture."})
                return
            try:
                photo = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                self.send_json(400, {"error": "The picture data is invalid."})
                return
            signatures = {
                "image/png": photo.startswith(b"\x89PNG\r\n\x1a\n"),
                "image/jpeg": photo.startswith(b"\xff\xd8\xff"),
                "image/webp": len(photo) >= 12 and photo[:4] == b"RIFF" and photo[8:12] == b"WEBP",
            }
            if not photo or len(photo) > MAX_PHOTO or not signatures[mime]:
                self.send_json(400, {"error": "The picture must be a valid image no larger than 5 MB."})
                return
            RANKING_PLAYER_ASSETS.mkdir(parents=True, exist_ok=True)
            file_stem = f"{player_id}_{int(time.time())}" if player_id.isdigit() else f"p_{uuid.uuid4().hex[:12]}_{int(time.time())}"
            path = RANKING_PLAYER_ASSETS / f"{file_stem}{MIME_EXTENSIONS[mime]}"
            path.write_bytes(photo)
            self.send_json(200, {"path": f"assets/players/rankings/{path.name}"})
        elif parsed.path == "/api/admin/community-socials":
            socials = body.get("socials")
            if not isinstance(socials, dict):
                self.send_json(400, {"error": "Invalid socials configuration."})
                return
            atomic_json(COMMUNITY_SOCIALS_PATH, socials)
            self.send_json(200, {"socials": socials})
        elif parsed.path == "/api/admin/event-vod-playlist":
            event_id = str(body.get("eventId", "")).strip()
            playlist_url = str(body.get("playlistUrl", "")).strip()
            if not event_id:
                self.send_json(400, {"error": "Missing eventId."})
                return
            if playlist_url and not is_valid_playlist_url(playlist_url):
                self.send_json(400, {"error": "Please enter a valid YouTube playlist URL or ID."})
                return

            try:
                with sqlite3.connect(DATABASE) as connection:
                    migrate_vod_schema(connection)
                    ev = connection.execute("SELECT id FROM events WHERE id=?", (event_id,)).fetchone()
                    if not ev:
                        self.send_json(404, {"error": f"Event not found with ID {event_id}"})
                        return
                    connection.execute(
                        "UPDATE events SET vod_playlist_url=? WHERE id=?",
                        (playlist_url if playlist_url else None, event_id)
                    )
                    connection.commit()
                self.send_json(200, {"success": True, "eventId": event_id, "playlistUrl": playlist_url})
            except Exception as err:
                self.send_json(500, {"error": f"Database error updating playlist URL: {err}"})
        elif parsed.path == "/api/admin/sync-event-vods":
            event_id = str(body.get("eventId", "")).strip()
            playlist_url = str(body.get("playlistUrl", "")).strip()
            if not event_id:
                self.send_json(400, {"error": "Missing eventId."})
                return

            try:
                with sqlite3.connect(DATABASE) as connection:
                    connection.row_factory = sqlite3.Row
                    migrate_vod_schema(connection)
                    ev = connection.execute("SELECT id, vod_playlist_url FROM events WHERE id=?", (event_id,)).fetchone()
                    if not ev:
                        self.send_json(404, {"error": f"Event not found with ID {event_id}"})
                        return

                    target_url = playlist_url or ev["vod_playlist_url"]
                    if not target_url or not is_valid_playlist_url(target_url):
                        self.send_json(400, {"error": "A valid YouTube playlist URL is required to sync VODs."})
                        return

                    if playlist_url and playlist_url != ev["vod_playlist_url"]:
                        connection.execute("UPDATE events SET vod_playlist_url=? WHERE id=?", (playlist_url, event_id))
                        connection.commit()

                # Fetch playlist videos from YouTube Data API (outside DB transaction)
                try:
                    fetched_videos = fetch_playlist_videos(target_url)
                except YouTubeConfigError as err:
                    self.send_json(400, {"error": str(err)})
                    return
                except (YouTubeAPIError, ValueError) as err:
                    self.send_json(502, {"error": f"YouTube API error: {err}"})
                    return

                # Synchronize into database non-destructively
                now_ts = int(time.time())
                added_count = 0
                updated_count = 0
                active_video_ids = set()

                with sqlite3.connect(DATABASE) as connection:
                    connection.row_factory = sqlite3.Row
                    migrate_vod_schema(connection)

                    existing_rows = connection.execute(
                        "SELECT id, youtube_video_id, youtube_playlist_item_id, youtube_title, "
                        "youtube_thumbnail_url, status, availability, match_id "
                        "FROM event_vods WHERE event_id=?", (event_id,)
                    ).fetchall()

                    existing_by_video_id = {}
                    existing_by_item_id = {}
                    for row in existing_rows:
                        if row["youtube_video_id"]:
                            existing_by_video_id[row["youtube_video_id"]] = row
                        if row["youtube_playlist_item_id"]:
                            existing_by_item_id[row["youtube_playlist_item_id"]] = row

                    for v in fetched_videos:
                        vid = v["youtube_video_id"]
                        item_id = v["youtube_playlist_item_id"]
                        title = v["youtube_title"]
                        thumb = v["youtube_thumbnail_url"]
                        avail = v["availability"]
                        if vid:
                            active_video_ids.add(vid)

                        existing = None
                        if vid and vid in existing_by_video_id:
                            existing = existing_by_video_id[vid]
                        elif item_id and item_id in existing_by_item_id:
                            existing = existing_by_item_id[item_id]

                        if existing:
                            connection.execute(
                                "UPDATE event_vods SET "
                                "youtube_video_id=COALESCE(?, youtube_video_id), "
                                "youtube_playlist_item_id=COALESCE(?, youtube_playlist_item_id), "
                                "youtube_title=?, "
                                "youtube_thumbnail_url=COALESCE(?, youtube_thumbnail_url), "
                                "availability=?, "
                                "updated_at=? "
                                "WHERE id=?",
                                (vid, item_id, title, thumb, avail, now_ts, existing["id"])
                            )
                            updated_count += 1
                        else:
                            connection.execute(
                                "INSERT INTO event_vods (event_id, match_id, youtube_video_id, "
                                "youtube_playlist_item_id, youtube_title, youtube_thumbnail_url, "
                                "status, availability, created_at, updated_at) "
                                "VALUES (?, NULL, ?, ?, ?, ?, 'pending', ?, ?, ?)",
                                (event_id, vid, item_id, title, thumb, avail, now_ts, now_ts)
                            )
                            added_count += 1

                    connection.commit()

                self.send_json(200, {
                    "success": True,
                    "eventId": event_id,
                    "added": added_count,
                    "updated": updated_count,
                    "total": len(fetched_videos),
                })
            except Exception as err:
                self.send_json(500, {"error": f"Failed to sync playlist: {err}"})
        elif parsed.path == "/api/admin/save-event-vods":
            event_id = str(body.get("eventId", "")).strip()
            vods_input = body.get("vods", [])
            if not event_id:
                self.send_json(400, {"error": "Missing eventId."})
                return
            if not isinstance(vods_input, list):
                self.send_json(400, {"error": "vods must be a list of VOD associations."})
                return

            now_ts = int(time.time())
            try:
                with sqlite3.connect(DATABASE) as connection:
                    connection.row_factory = sqlite3.Row
                    migrate_vod_schema(connection)

                    ev = connection.execute("SELECT id FROM events WHERE id=?", (event_id,)).fetchone()
                    if not ev:
                        self.send_json(404, {"error": f"Event not found with ID {event_id}"})
                        return

                    valid_sets = connection.execute(
                        "SELECT s.id, se1.entrant_id as e1, se2.entrant_id as e2 "
                        "FROM sets s "
                        "JOIN set_entrants se1 ON se1.set_id=s.id AND se1.slot_order=0 "
                        "JOIN set_entrants se2 ON se2.set_id=s.id AND se2.slot_order=1 "
                        "WHERE s.event_id=?", (event_id,)
                    ).fetchall()
                    valid_set_map = {str(s["id"]): (str(s["e1"]), str(s["e2"])) for s in valid_sets}

                    current_vods = connection.execute(
                        "SELECT id FROM event_vods WHERE event_id=?", (event_id,)
                    ).fetchall()
                    current_vod_ids = {r["id"] for r in current_vods}

                    updates_to_run = []
                    for v in vods_input:
                        vod_id = v.get("id")
                        if vod_id not in current_vod_ids:
                            self.send_json(400, {"error": f"VOD record {vod_id} does not belong to event {event_id}."})
                            return

                        status = str(v.get("status", "pending")).lower()
                        if status not in ("pending", "complete", "ignored"):
                            self.send_json(400, {"error": f"Invalid status '{status}' for VOD {vod_id}."})
                            return

                        raw_match_id = v.get("matchId")
                        match_id = str(raw_match_id).strip() if raw_match_id is not None and str(raw_match_id).strip() else None

                        if status == "complete":
                            if not match_id:
                                self.send_json(400, {"error": f"VOD {vod_id} is marked complete but has no associated match."})
                                return
                            if match_id not in valid_set_map:
                                self.send_json(400, {"error": f"Match {match_id} does not exist in event {event_id}."})
                                return

                            p1 = v.get("p1EntrantId")
                            p2 = v.get("p2EntrantId")
                            set_e1, set_e2 = valid_set_map[match_id]
                            if p1 and str(p1) not in (set_e1, set_e2):
                                self.send_json(400, {"error": f"Player 1 is not a participant in match {match_id}."})
                                return
                            if p2 and str(p2) not in (set_e1, set_e2):
                                self.send_json(400, {"error": f"Player 2 is not a participant in match {match_id}."})
                                return
                        elif status == "ignored":
                            pass

                        updates_to_run.append((match_id, status, now_ts, vod_id))

                    for match_id, status, updated_at, vod_id in updates_to_run:
                        connection.execute(
                            "UPDATE event_vods SET match_id=?, status=?, updated_at=? WHERE id=?",
                            (match_id, status, updated_at, vod_id)
                        )
                    connection.commit()

                    # Trigger static write for this event detail
                    from scripts.build_player_profile import write_event_details
                    write_event_details(connection)

                self.send_json(200, {"success": True, "saved": len(updates_to_run)})
            except Exception as err:
                self.send_json(500, {"error": f"Failed to save VOD associations: {err}"})
        elif parsed.path == "/api/admin/merge":
            source, target = str(body.get("sourceId", "")), str(body.get("targetId", ""))
            profiles = {entry["playerId"] for entry in profile_entries() if entry["playerId"]}
            merges = identity_merges()
            if not source or not target or source == target:
                self.send_json(400, {"error": "Choose two different player profiles."})
                return
            if source not in profiles or target not in profiles:
                self.send_json(400, {"error": "Both players must be unmerged profiles in the admin list."})
                return
            if canonical_id(target, {**merges, source: target}) == source:
                self.send_json(400, {"error": "That merge would create an identity loop."})
                return
            confirmed = body.get("confirmed", False)
            if not confirmed:
                overlaps = get_player_overlapping_events(source, target)
                if overlaps:
                    self.send_json(200, {
                        "warning": True,
                        "overlaps": overlaps,
                        "message": f"Source and target share {len(overlaps)} tournament event(s)."
                    })
                    return
            merges[source] = target
            atomic_json(PROFILE_DIR / "merges.json", merges)
            builder = ROOT / "scripts" / "build_player_profile.py"
            result = subprocess.run([sys.executable, str(builder), "--all"], cwd=ROOT,
                                    capture_output=True, text=True)
            if result.returncode:
                merges.pop(source, None)
                atomic_json(PROFILE_DIR / "merges.json", merges)
                self.send_json(500, {"error": "Could not rebuild profiles after merging. " + (result.stderr[-1000:] or result.stdout[-1000:])})
                return
            refresh_index()
            self.send_json(200, {"merged": source, "into": target, "profiles": profile_entries()})
        elif parsed.path == "/api/admin/tournament-dates":
            raw_slug = body.get("tournamentSlug")
            slug = normalize_tournament_slug(raw_slug)
            if not slug:
                self.send_json(400, {"error": "Please provide a valid tournament slug."})
                return

            with sqlite3.connect(DATABASE) as connection:
                connection.row_factory = sqlite3.Row
                tourney = connection.execute("SELECT slug FROM tournaments WHERE slug = ?", (slug,)).fetchone()
            if not tourney:
                self.send_json(404, {"error": f"Tournament '{slug}' was not found in the database."})
                return

            remove = bool(body.get("remove") or body.get("action") == "remove")
            overrides = load_tournament_date_overrides(ROOT)
            previous = dict(overrides)

            if remove:
                if slug not in overrides:
                    self.send_json(404, {"error": f"No date override found for tournament '{slug}'."})
                    return
                overrides.pop(slug, None)
            else:
                date_str = body.get("date")
                if not isinstance(date_str, str) or not validate_date_string(date_str):
                    self.send_json(400, {"error": "Please provide a valid calendar date in YYYY-MM-DD format."})
                    return
                overrides[slug] = date_str.strip()

            save_tournament_date_overrides(overrides, ROOT)
            result = rebuild_profiles()
            if result.returncode:
                save_tournament_date_overrides(previous, ROOT)
                self.send_json(500, {"error": "Could not rebuild profiles after updating tournament date. " + (result.stderr[-1000:] or result.stdout[-1000:])})
                return
            refresh_index()
            self.send_json(200, {
                "success": True,
                "tournamentSlug": slug,
                "overrides": overrides,
                "action": "removed" if remove else "saved",
            })
        elif parsed.path == "/api/admin/event-group":
            groups = event_groups()
            child_key = normalize_event_key(body.get("child"))
            if not child_key:
                self.send_json(400, {"error": "Enter a valid start.gg event URL for the additional event."})
                return
            action = body.get("action", "save")
            previous = dict(groups)
            if action == "remove":
                if child_key not in groups:
                    self.send_json(404, {"error": "No grouping is saved for that event."})
                    return
                groups.pop(child_key)
            else:
                parent_key = normalize_event_key(body.get("parent"))
                phase = body.get("phase")
                if not parent_key or parent_key == child_key:
                    self.send_json(400, {"error": "Enter a different, valid primary event URL."})
                    return
                if not isinstance(phase, str) or not phase.strip() or len(phase.strip()) > 80:
                    self.send_json(400, {"error": "Enter a phase label up to 80 characters, such as Categoria B."})
                    return
                groups[child_key] = {"parent": parent_key, "phase": phase.strip()}
            atomic_json(EVENT_GROUPS_PATH, groups)
            result = rebuild_profiles()
            if result.returncode:
                atomic_json(EVENT_GROUPS_PATH, previous)
                self.send_json(500, {"error": "Could not rebuild profiles after updating the event grouping. " + (result.stderr[-1000:] or result.stdout[-1000:])})
                return
            refresh_index()
            self.send_json(200, {"eventGroups": enrich_event_groups(groups)})
        elif parsed.path in ("/api/admin/bulk-merge-players", "/api/admin/merges/bulk"):
            operations = body.get("operations")
            if not isinstance(operations, list) or not operations:
                self.send_json(400, {"error": "No merge operations provided in batch."})
                return
            confirmed = body.get("confirmed", False)
            profiles_set = {entry["playerId"] for entry in profile_entries() if entry["playerId"]}
            merges = identity_merges()
            previous_merges = dict(merges)
            working_merges = dict(merges)

            validated_ops = []
            errors = []
            all_overlaps = []

            for idx, op in enumerate(operations):
                if not isinstance(op, dict):
                    errors.append({"index": idx, "operation": op, "error": "Invalid operation format."})
                    continue
                source = str(op.get("sourceId") or op.get("from") or "").strip()
                target = str(op.get("targetId") or op.get("to") or "").strip()

                if not source or not target or source == target:
                    errors.append({"index": idx, "operation": op, "error": "Choose two different player profiles."})
                    continue
                if source in working_merges:
                    errors.append({"index": idx, "operation": op, "error": f"Player {source} is already merged into another profile."})
                    continue
                if source not in profiles_set:
                    errors.append({"index": idx, "operation": op, "error": f"Player {source} must be an unmerged profile in the admin list."})
                    continue
                if target not in profiles_set and target not in working_merges.values():
                    errors.append({"index": idx, "operation": op, "error": f"Player {target} must be an unmerged profile in the admin list."})
                    continue
                if canonical_id(target, working_merges) == source or canonical_id(target, {**working_merges, source: target}) == source:
                    errors.append({"index": idx, "operation": op, "error": f"Merge would create an identity loop."})
                    continue

                if not confirmed:
                    overlaps = get_player_overlapping_events(source, target)
                    if overlaps:
                        all_overlaps.append({
                            "sourceId": source,
                            "targetId": target,
                            "overlaps": overlaps
                        })

                working_merges[source] = target
                validated_ops.append({"index": idx, "operation": op, "sourceId": source, "targetId": target})

            if not confirmed and all_overlaps:
                self.send_json(200, {
                    "warning": True,
                    "overlaps": all_overlaps,
                    "message": f"{len(all_overlaps)} operation(s) have overlapping tournament participation."
                })
                return

            if not validated_ops:
                self.send_json(400, {
                    "error": "None of the queued player merge operations were valid.",
                    "completed": [],
                    "failed": errors
                })
                return

            atomic_json(PROFILE_DIR / "merges.json", working_merges)
            result = rebuild_profiles()
            if result.returncode:
                atomic_json(PROFILE_DIR / "merges.json", previous_merges)
                self.send_json(500, {
                    "error": "Could not rebuild profiles after batch merge: " + (result.stderr[-1000:] or result.stdout[-1000:]),
                    "completed": [],
                    "failed": [{"index": op["index"], "operation": op["operation"], "error": "Rebuild failed; changes rolled back"} for op in validated_ops] + errors
                })
                return
            refresh_index()
            self.send_json(200, {
                "completed": validated_ops,
                "failed": errors,
                "profiles": profile_entries()
            })
        elif parsed.path in ("/api/admin/bulk-merge-events", "/api/admin/event-groups/bulk"):
            operations = body.get("operations")
            if not isinstance(operations, list) or not operations:
                self.send_json(400, {"error": "No event merge operations provided in batch."})
                return
            groups = event_groups()
            previous_groups = dict(groups)
            working_groups = dict(groups)

            validated_ops = []
            errors = []

            for idx, op in enumerate(operations):
                if not isinstance(op, dict):
                    errors.append({"index": idx, "operation": op, "error": "Invalid operation format."})
                    continue
                child_raw = op.get("child") or op.get("from") or ""
                parent_raw = op.get("parent") or op.get("to") or ""
                phase_raw = op.get("phase") or op.get("name") or ""

                child_key = normalize_event_key(child_raw)
                parent_key = normalize_event_key(parent_raw)
                phase = str(phase_raw).strip()

                if not child_key:
                    errors.append({"index": idx, "operation": op, "error": "Enter a valid start.gg event URL for the source event (FROM)."})
                    continue
                if not parent_key or parent_key == child_key:
                    errors.append({"index": idx, "operation": op, "error": "Source event (FROM) and destination event (TO) must be different valid event URLs."})
                    continue
                if not phase or len(phase) > 80:
                    errors.append({"index": idx, "operation": op, "error": "Enter a phase display name (NAME) up to 80 characters."})
                    continue

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
                if cycle:
                    errors.append({"index": idx, "operation": op, "error": "Event merge would create a grouping cycle."})
                    continue

                working_groups[child_key] = {"parent": parent_key, "phase": phase}
                validated_ops.append({"index": idx, "operation": op, "child": child_key, "parent": parent_key, "phase": phase})

            if not validated_ops:
                self.send_json(400, {
                    "error": "None of the queued event merge operations were valid.",
                    "completed": [],
                    "failed": errors
                })
                return

            atomic_json(EVENT_GROUPS_PATH, working_groups)
            result = rebuild_profiles()
            if result.returncode:
                atomic_json(EVENT_GROUPS_PATH, previous_groups)
                self.send_json(500, {
                    "error": "Could not rebuild profiles after updating event groupings: " + (result.stderr[-1000:] or result.stdout[-1000:]),
                    "completed": [],
                    "failed": [{"index": op["index"], "operation": op["operation"], "error": "Rebuild failed; changes rolled back"} for op in validated_ops] + errors
                })
                return
            refresh_index()
            self.send_json(200, {
                "completed": validated_ops,
                "failed": errors,
                "eventGroups": enrich_event_groups(working_groups)
            })
        elif parsed.path == "/api/admin/exclusions":
            config = visibility_exclusions()
            previous = json.loads(json.dumps(config))
            kind = body.get("kind")
            if kind == "event":
                key = normalize_event_key(body.get("eventUrl"))
                excluded = body.get("excluded")
                if not key or not isinstance(excluded, bool):
                    self.send_json(400, {"error": "Enter a valid start.gg event URL and choose its exclusion state."})
                    return
                event_keys = set(config["events"])
                if excluded:
                    event_keys.add(key)
                else:
                    event_keys.discard(key)
                config["events"] = sorted(event_keys)
            elif kind == "player-games":
                player_id = str(body.get("playerId", ""))
                excluded_games = body.get("excludedGames")
                profiles = {entry["playerId"] for entry in profile_entries() if entry["playerId"]}
                if player_id not in profiles or not isinstance(excluded_games, list) or any(
                    not isinstance(game_id, str) or not SLUG_RE.fullmatch(game_id) for game_id in excluded_games
                ):
                    self.send_json(400, {"error": "Invalid player game exclusions."})
                    return
                merges = identity_merges()
                identity_ids = {player_id}
                identity_ids.update(source for source in merges if canonical_id(source, merges) == player_id)
                with sqlite3.connect(DATABASE) as connection:
                    available = {row[0] for row in connection.execute(
                        f"SELECT DISTINCT e.videogame_slug FROM participants p "
                        "JOIN entrant_participants ep ON ep.participant_id=p.id "
                        "JOIN entrants en ON en.id=ep.entrant_id JOIN events e ON e.id=en.event_id "
                        f"WHERE p.player_id IN ({','.join('?' for _ in identity_ids)})",
                        sorted(identity_ids),
                    )}
                if not set(excluded_games).issubset(available):
                    self.send_json(400, {"error": "A selected game is not part of this player's tournament history."})
                    return
                config["playerGames"][player_id] = sorted(set(excluded_games))
                if not config["playerGames"][player_id]:
                    config["playerGames"].pop(player_id, None)
            else:
                self.send_json(400, {"error": "Unknown exclusion setting."})
                return
            atomic_json(EXCLUSIONS_PATH, config)
            result = rebuild_profiles()
            if result.returncode:
                atomic_json(EXCLUSIONS_PATH, previous)
                self.send_json(500, {"error": "Could not rebuild profiles after updating exclusions. " + (result.stderr[-1000:] or result.stdout[-1000:])})
                return
            refresh_index()
            self.send_json(200, {"exclusions": config})
        elif parsed.path in ("/api/admin/bulk-exclude-players", "/api/admin/exclusions/bulk"):
            if not self.require_admin():
                return
            player_ids = body.get("playerIds")
            if not isinstance(player_ids, list) or not player_ids:
                self.send_json(400, {"error": "No players provided for bulk exclusion."})
                return

            # Clean and validate player IDs
            clean_ids = []
            for pid in player_ids:
                pid_str = str(pid).strip()
                if not pid_str.isdigit():
                    self.send_json(400, {"error": f"Invalid player ID: {pid}"})
                    return
                clean_ids.append(pid_str)

            merges = identity_merges()
            all_canonical_ids = set()
            for pid in clean_ids:
                all_canonical_ids.add(canonical_id(pid, merges))

            config = visibility_exclusions()
            previous = json.loads(json.dumps(config))

            with sqlite3.connect(DATABASE) as connection:
                completed = []
                # Get all known games in the database as fallback for players with 0 event history
                all_known_games = sorted({row[0] for row in connection.execute("SELECT slug FROM videogames")})
                for cid in sorted(all_canonical_ids):
                    identity_ids = {cid}
                    identity_ids.update(source for source in merges if canonical_id(source, merges) == cid)
                    available_games = sorted({row[0] for row in connection.execute(
                        f"SELECT DISTINCT e.videogame_slug FROM participants p "
                        "JOIN entrant_participants ep ON ep.participant_id=p.id "
                        "JOIN entrants en ON en.id=ep.entrant_id JOIN events e ON e.id=en.event_id "
                        f"WHERE p.player_id IN ({','.join('?' for _ in identity_ids)})",
                        sorted(identity_ids),
                    )})
                    games_to_exclude = available_games if available_games else all_known_games
                    config["playerGames"][cid] = games_to_exclude
                    completed.append({"playerId": cid, "games": games_to_exclude})

            atomic_json(EXCLUSIONS_PATH, config)
            result = rebuild_profiles()
            if result.returncode:
                atomic_json(EXCLUSIONS_PATH, previous)
                self.send_json(500, {"error": "Could not rebuild profiles after bulk exclusion. " + (result.stderr[-1000:] or result.stdout[-1000:])})
                return
            refresh_index()
            self.send_json(200, {
                "completed": completed,
                "exclusions": config,
                "count": len(completed),
            })
        else:
            self.send_json(404, {"error": "Not found."})

    def do_PUT(self):
        parsed = urlsplit(self.path)
        if not self.has_admin_header():
            self.send_json(403, {"error": "Request rejected."})
            return
        if not self.require_admin():
            return
        if not self.verify_csrf():
            self.send_json(403, {"error": "Invalid or missing CSRF token."})
            return

        try:
            body = self.read_json()
        except OverflowError as error:
            self.send_json(413, {"error": str(error)})
            return
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        if not isinstance(body, dict):
            self.send_json(400, {"error": "Invalid request."})
            return

        if parsed.path == "/api/admin/profile":
            slug, profile = body.get("slug", ""), body.get("profile")
            if not safe_slug(slug) or not isinstance(profile, dict):
                self.send_json(400, {"error": "Invalid profile update."})
                return
            path = PROFILE_DIR / f"{slug}.json"
            try:
                with path.open(encoding="utf-8") as stream:
                    original = json.load(stream)
            except FileNotFoundError:
                self.send_json(404, {"error": f"Profile file '{slug}.json' not found."})
                return
            except json.JSONDecodeError as err:
                self.send_json(500, {"error": f"The profile file '{slug}.json' contains invalid JSON: {err}"})
                return
            player = profile.get("player")
            games = profile.get("games")
            if not isinstance(player, dict) or not isinstance(games, list):
                self.send_json(400, {"error": "Profile JSON must contain a player object and a games array."})
                return
            if not isinstance(player.get("tag"), str) or not player["tag"].strip() or len(player["tag"]) > 80:
                self.send_json(400, {"error": "Display name must be a non-empty string up to 80 characters."})
                return
            for key, limit in (("sponsor", 100), ("location", 120), ("startgg", 500), ("photo", 240)):
                value = player.get(key, "")
                if not isinstance(value, str) or len(value) > limit:
                    self.send_json(400, {"error": f"Invalid {key} value."})
                    return
                player[key] = value.strip()
            if player["startgg"]:
                link = urlsplit(player["startgg"])
                if link.scheme != "https" or link.netloc not in {"start.gg", "www.start.gg"}:
                    self.send_json(400, {"error": "Use an HTTPS start.gg profile link."})
                    return
            photo_path = player["photo"]
            if photo_path and (not photo_path.startswith("assets/players/") or ".." in Path(photo_path).parts or "\\" in photo_path):
                self.send_json(400, {"error": "Player pictures must be stored under assets/players/."})
                return
            for game in games:
                if not isinstance(game, dict) or not isinstance(game.get("id"), str) or not game["id"].strip():
                    self.send_json(400, {"error": "Every game entry must be an object with a non-empty id."})
                    return
            player_id = str(original.get("player", {}).get("startggPlayerId") or "")
            if str(player.get("startggPlayerId") or "") != player_id:
                self.send_json(400, {"error": "The start.gg player ID is fixed and cannot be changed."})
                return
            overrides_path = PROFILE_DIR / "overrides.json"
            overrides = None
            if player_id:
                try:
                    with overrides_path.open(encoding="utf-8") as stream:
                        overrides = json.load(stream)
                except FileNotFoundError:
                    overrides = {}
                except json.JSONDecodeError as err:
                    self.send_json(500, {"error": f"The profile overrides file 'overrides.json' contains invalid JSON: {err}"})
                    return
                overrides[player_id] = {"profile": profile}
            atomic_json(path, profile)
            if player_id:
                atomic_json(overrides_path, overrides)
            refresh_index()
            self.send_json(200, {"saved": True})
        elif parsed.path.startswith("/api/admin/rankings/"):
            rid = parsed.path.split("/api/admin/rankings/")[1].strip()
            if not safe_slug(rid):
                self.send_json(400, {"error": "Invalid ranking ID."})
                return
            action = body.get("action")
            if action == "unarchive":
                try:
                    with sqlite3.connect(DATABASE) as connection:
                        connection.execute("UPDATE official_rankings SET is_archived = 0, updated_at = ? WHERE id = ?", (int(time.time()), rid))
                        connection.commit()
                    sync_static_rankings()
                    self.send_json(200, {"success": True, "unarchived": rid})
                    return
                except Exception as e:
                    self.send_json(500, {"error": f"Failed to unarchive ranking: {e}"})
                    return

            ranking_data = body.get("ranking")
            if not isinstance(ranking_data, dict):
                self.send_json(400, {"error": "Invalid ranking payload."})
                return

            title = str(ranking_data.get("title") or "").strip()
            game = ranking_data.get("game") or {}
            game_slug = str(game.get("slug") or "").strip()
            game_id = str(game.get("id") or "").strip()
            period = ranking_data.get("period") or {}
            start = str(period.get("start") or "").strip()
            end = str(period.get("end") or "").strip()
            status = str(ranking_data.get("status") or "yearly").strip()
            published_by = str(ranking_data.get("publishedBy") or "").strip()
            intro = str(ranking_data.get("intro") or "").strip()
            players = ranking_data.get("players")
            image_box_raw = ranking_data.get("imageBox")
            image_box_str = None
            if isinstance(image_box_raw, dict) and image_box_raw.get("url"):
                sanitized_ib = {
                    "url": str(image_box_raw["url"]).strip()[:500],
                    "placement": image_box_raw.get("placement") if image_box_raw.get("placement") in {"beginning", "after_intro", "end"} else "after_intro",
                    "caption": str(image_box_raw.get("caption") or "").strip()[:300]
                }
                if sanitized_ib["url"]:
                    image_box_str = json.dumps(sanitized_ib, ensure_ascii=False)

            if not title or not game_slug or not start or not end or not isinstance(players, list):
                self.send_json(400, {"error": "Missing required ranking fields."})
                return

            sanitized_players = []
            seen_player_ids = set()
            for p in players:
                if not isinstance(p, dict) or not p.get("tag"):
                    self.send_json(400, {"error": "Each player must have a valid tag."})
                    return
                pid = str(p.get("playerId") or "").strip()
                if pid:
                    if pid in seen_player_ids:
                        self.send_json(400, {"error": f"Duplicate player ID '{pid}'."})
                        return
                    seen_player_ids.add(pid)
                sanitized_player = {
                    "placement": int(p.get("placement") or (len(sanitized_players) + 1)),
                    "tag": str(p["tag"]).strip()[:80],
                }
                if pid:
                    sanitized_player["playerId"] = pid
                if p.get("sponsor"):
                    sanitized_player["sponsor"] = str(p["sponsor"]).strip()[:50]
                if p.get("points") is not None and str(p.get("points")).strip() != "":
                    try:
                        sanitized_player["points"] = float(p["points"])
                    except (ValueError, TypeError):
                        pass
                if p.get("photo"):
                    sanitized_player["photo"] = str(p["photo"]).strip()[:240]
                if p.get("realName"):
                    sanitized_player["realName"] = str(p["realName"]).strip()[:100]
                if isinstance(p.get("mains"), list):
                    sanitized_player["mains"] = [str(m).strip()[:50] for m in p["mains"] if str(m).strip()]
                if p.get("text"):
                    sanitized_player["text"] = str(p["text"]).strip()[:2000]
                if isinstance(p.get("notableWins"), list):
                    sanitized_player["notableWins"] = []
                    for w in p["notableWins"]:
                        if isinstance(w, dict) and w.get("opponent"):
                            win_obj = {"opponent": str(w["opponent"]).strip()[:80]}
                            if "times" in w and w["times"] is not None:
                                try:
                                    win_obj["times"] = int(w["times"])
                                except (ValueError, TypeError):
                                    win_obj["times"] = 1
                            elif "tournament" in w:
                                win_obj["tournament"] = str(w.get("tournament") or "").strip()[:100]
                            sanitized_player["notableWins"].append(win_obj)
                if isinstance(p.get("notableResults"), list):
                    sanitized_player["notableResults"] = []
                    for r in p["notableResults"]:
                        if isinstance(r, dict) and r.get("event"):
                            res_obj = {
                                "placement": r.get("placement"),
                                "event": str(r["event"]).strip()[:120],
                                "entrants": r.get("entrants")
                            }
                            sanitized_player["notableResults"].append(res_obj)

                sanitized_players.append(sanitized_player)

            now = int(time.time())
            try:
                init_rankings_db()
                with sqlite3.connect(DATABASE) as connection:
                    cur = connection.cursor()
                    cur.execute(
                        """
                        UPDATE official_rankings SET
                            title = ?, game_slug = ?, game_id = ?, period_start = ?, period_end = ?,
                            status = ?, published_by = ?, intro = ?, players_json = ?, updated_at = ?,
                            image_box = ?
                        WHERE id = ?
                        """,
                        (
                            title[:150],
                            game_slug[:50],
                            game_id[:50],
                            start[:20],
                            end[:20],
                            status,
                            published_by[:100],
                            intro[:2000],
                            json.dumps(sanitized_players, ensure_ascii=False),
                            now,
                            image_box_str,
                            rid,
                        )
                    )
                    if cur.rowcount == 0:
                        self.send_json(404, {"error": "Ranking not found to update."})
                        return
                    connection.commit()

                sync_static_rankings()
                self.send_json(200, {"success": True, "id": rid})
            except Exception as e:
                self.send_json(500, {"error": f"Failed to update ranking: {e}"})
        else:
            self.send_json(404, {"error": "Not found."})

    def do_DELETE(self):
        parsed = urlsplit(self.path)
        if not self.has_admin_header():
            self.send_json(403, {"error": "Request rejected."})
            return
        if not self.require_admin():
            return
        if not self.verify_csrf():
            self.send_json(403, {"error": "Invalid or missing CSRF token."})
            return

        if parsed.path.startswith("/api/admin/rankings/"):
            rid = parsed.path.split("/api/admin/rankings/")[1].strip()
            if not safe_slug(rid):
                self.send_json(400, {"error": "Invalid ranking ID."})
                return

            qs = parse_qs(parsed.query)
            permanent = qs.get("permanent", ["0"])[0] in {"1", "true", "yes"}

            try:
                init_rankings_db()
                with sqlite3.connect(DATABASE) as connection:
                    if permanent:
                        connection.execute("DELETE FROM official_rankings WHERE id = ?", (rid,))
                    else:
                        connection.execute("UPDATE official_rankings SET is_archived = 1, updated_at = ? WHERE id = ?", (int(time.time()), rid))
                    connection.commit()

                sync_static_rankings()
                self.send_json(200, {"success": True, "archived": not permanent, "deleted": permanent, "id": rid})
            except Exception as e:
                self.send_json(500, {"error": f"Failed to delete/archive ranking: {e}"})
        else:
            self.send_json(405, {"error": "Method not allowed."})


def main():
    global PASSWORD, PASSWORD_BCRYPT
    if not PASSWORD:
        password = getpass.getpass("Choose an administrator password for this session: ")
        confirmation = getpass.getpass("Confirm administrator password: ")
        if not password or not hmac.compare_digest(password, confirmation):
            raise SystemExit("A matching, non-empty administrator password is required.")
        PASSWORD = password
    init_auth()

    try:
        init_rankings_db()
        seed_existing_rankings()
        sync_static_rankings()
    except Exception as e:
        print(f"Warning: Could not sync rankings on startup: {e}")

    host = "127.0.0.1"
    port = int(os.environ.get("PLATFIGHTERS_PORT", "8000"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Platfighters.uy is serving at http://{host}:{port}")
    print("Profile and ranking management is protected by a password and is available only on this computer.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
