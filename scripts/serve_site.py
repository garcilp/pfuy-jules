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

PROFILE_DIR = ROOT / "data" / "profiles"
EVENT_GROUPS_PATH = PROFILE_DIR / "event_groups.json"
EXCLUSIONS_PATH = PROFILE_DIR / "exclusions.json"
COMMUNITY_SOCIALS_PATH = ROOT / "data" / "community_socials.json"
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
        from scripts.rankings_calculator import export_default_rankings
        export_default_rankings()
    except Exception as err:
        print(f"Warning: could not export default rankings: {err}")
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
        elif parsed.path == "/api/admin/event-groups":
            if not self.require_admin():
                return
            try:
                self.send_json(200, {"eventGroups": event_groups()})
            except Exception as err:
                self.send_json(500, {"error": str(err)})
        elif parsed.path in {"/api/admin/events", "/api/admin/imported-events"}:
            if not self.require_admin():
                return
            try:
                with sqlite3.connect(DATABASE) as connection:
                    rows = connection.execute(
                        "SELECT e.source_url, t.name, e.name, v.name, t.start_at "
                        "FROM events e "
                        "JOIN tournaments t ON e.tournament_slug = t.slug "
                        "JOIN videogames v ON e.videogame_slug = v.slug "
                        "ORDER BY t.start_at DESC, t.name ASC, e.name ASC"
                    ).fetchall()
                events = [
                    {
                        "sourceUrl": row[0],
                        "tournamentName": row[1],
                        "eventName": row[2],
                        "gameName": row[3],
                        "startAt": row[4],
                    }
                    for row in rows
                ]
                self.send_json(200, {"events": events})
            except sqlite3.Error as error:
                self.send_json(500, {"error": f"Could not load imported events: {error}"})
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
                    self.send_json(200, {"ranking": data})
            except Exception as e:
                self.send_json(500, {"error": f"Error loading ranking: {e}"})
        elif parsed.path == "/api/games":
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
                            created_at, updated_at, is_archived
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
            self.send_json(200, {"eventGroups": groups})
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
                            status = ?, published_by = ?, intro = ?, players_json = ?, updated_at = ?
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
