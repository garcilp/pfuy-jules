"""Local Platfighters.uy web server with password-protected profile editing."""

import base64
import hmac
import getpass
import json
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import time
from base64 import binascii
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
PROFILE_DIR = ROOT / "data" / "profiles"
EVENT_GROUPS_PATH = PROFILE_DIR / "event_groups.json"
EXCLUSIONS_PATH = PROFILE_DIR / "exclusions.json"
DATABASE = ROOT / "startgg-data" / "platfighters.sqlite3"
PLAYER_ASSETS = ROOT / "assets" / "players"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,100}$")
MAX_BODY = 7 * 1024 * 1024
MAX_PHOTO = 5 * 1024 * 1024
SESSION_SECONDS = 8 * 60 * 60
PASSWORD = os.environ.get("PLATFIGHTERS_ADMIN_PASSWORD", "")
SESSIONS = {}
MIME_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


def identity_merges():
    path = PROFILE_DIR / "merges.json"
    try:
        with path.open(encoding="utf-8") as stream:
            value = json.load(stream)
        return {str(source): str(target) for source, target in value.items()}
    except (OSError, json.JSONDecodeError, AttributeError):
        return {}


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
    except (OSError, json.JSONDecodeError):
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
    except (OSError, json.JSONDecodeError, AttributeError, TypeError):
        return {"events": [], "playerGames": {}}


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


def profile_entries(public_only=False):
    entries_by_id = {}
    merged_ids = identity_merges()
    exclusions = visibility_exclusions() if public_only else None
    for path in sorted(PROFILE_DIR.glob("*.json")):
        if path.name in {"index.json", "overrides.json"}:
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
        entry = {"playerId": player_id, "tag": player["tag"], "slug": path.stem}
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

    def is_admin(self):
        token = self.session_token()
        expires = SESSIONS.get(token) if token else None
        if not expires:
            return False
        if expires < time.time():
            SESSIONS.pop(token, None)
            return False
        return True

    def require_admin(self):
        if not self.is_admin():
            self.send_json(401, {"error": "Administrator sign-in required."})
            return False
        return True

    def has_admin_header(self):
        return self.headers.get("X-Admin-Request") == "1"

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == "/api/admin/session":
            self.send_json(200, {"authenticated": self.is_admin()})
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
                self.send_json(404, {"error": "Profile not found."})
        elif parsed.path == "/api/admin/merges":
            if not self.require_admin():
                return
            self.send_json(200, {"merges": identity_merges()})
        elif parsed.path == "/api/admin/event-groups":
            if not self.require_admin():
                return
            self.send_json(200, {"eventGroups": event_groups()})
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
            self.send_json(200, {"exclusions": visibility_exclusions()})
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
            password = body.get("password")
            if not PASSWORD:
                self.send_json(503, {"error": "Admin access is not configured on this server."})
                return
            if not isinstance(password, str) or not hmac.compare_digest(password, PASSWORD):
                self.send_json(401, {"error": "That password was not accepted."})
                return
            token = secrets.token_urlsafe(32)
            SESSIONS[token] = time.time() + SESSION_SECONDS
            self.send_json(200, {"authenticated": True}, {"Set-Cookie": f"platfighters_admin={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_SECONDS}"})
        elif parsed.path == "/api/admin/logout":
            token = self.session_token()
            if token:
                SESSIONS.pop(token, None)
            self.send_json(200, {"authenticated": False}, {"Set-Cookie": "platfighters_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"})
        elif parsed.path == "/api/admin/photo":
            if not self.require_admin():
                return
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
        elif parsed.path == "/api/admin/merge":
            if not self.require_admin():
                return
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
            if not self.require_admin():
                return
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
            if not self.require_admin():
                return
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
        if urlsplit(self.path).path != "/api/admin/profile":
            self.send_json(404, {"error": "Not found."})
            return
        if not self.has_admin_header():
            self.send_json(403, {"error": "Request rejected."})
            return
        if not self.require_admin():
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
            self.send_json(400, {"error": "Invalid profile update."})
            return
        slug, profile = body.get("slug", ""), body.get("profile")
        if not safe_slug(slug) or not isinstance(profile, dict):
            self.send_json(400, {"error": "Invalid profile update."})
            return
        path = PROFILE_DIR / f"{slug}.json"
        try:
            with path.open(encoding="utf-8") as stream:
                original = json.load(stream)
        except FileNotFoundError:
            self.send_json(404, {"error": "Profile not found."})
            return
        except json.JSONDecodeError:
            self.send_json(500, {"error": "The saved profile is not valid JSON."})
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
            except json.JSONDecodeError:
                self.send_json(500, {"error": "The profile overrides file is invalid."})
                return
            overrides[player_id] = {"profile": profile}
        atomic_json(path, profile)
        if player_id:
            atomic_json(overrides_path, overrides)
        refresh_index()
        self.send_json(200, {"saved": True})

    def do_DELETE(self):
        self.send_json(405, {"error": "Method not allowed."})


def main():
    global PASSWORD
    if not PASSWORD:
        password = getpass.getpass("Choose an administrator password for this session: ")
        confirmation = getpass.getpass("Confirm administrator password: ")
        if not password or not hmac.compare_digest(password, confirmation):
            raise SystemExit("A matching, non-empty administrator password is required.")
        PASSWORD = password
    host = "127.0.0.1"
    port = int(os.environ.get("PLATFIGHTERS_PORT", "8000"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Platfighters.uy is serving at http://{host}:{port}")
    print("Profile editing is protected by a password and is available only on this computer.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
