#!/usr/bin/env python3
"""Generate player badge images (80x80 WebP) and static JSON data for Tiermaker.

Features:
- Incremental generation using data/tiermaker-manifest.json
- Resolves most-played character per player and game with deterministic tie-breaking:
  1. Highest appearance count
  2. Most recent appearance date/timestamp
  3. Character ID ordering (deterministic fallback)
  4. Fallback to assets/renders/<game-slug>/portraits/other.webp if no character data or asset is missing
- Overlays player's authoritative tag from data/profiles/index.json (or exclusions/participants) in white text with black outline
- Outputs 80x80 WebP badges to assets/players/tiermaker/<game-slug>/<player-id>.webp
- Generates compact static JSON files:
  - data/tiermaker/<game-slug>.json
  - data/tiermaker.json (combined)
- Includes regular unranked players and International Players (excluded in data/profiles/exclusions.json)
- Detects obsolete images with --clean-obsolete
- Supports sample generation with --sample N
- Integrates with SummaryTracker for execution reporting
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Set

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Error: Pillow is required for badge generation. Please run 'pip install Pillow'.", file=sys.stderr)
    sys.exit(1)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "startgg-data" / "platfighters.sqlite3"
INDEX_PATH = PROJECT_ROOT / "data" / "profiles" / "index.json"
EXCLUSIONS_PATH = PROJECT_ROOT / "data" / "profiles" / "exclusions.json"
PROFILES_DIR = PROJECT_ROOT / "data" / "profiles"
MANIFEST_PATH = PROJECT_ROOT / "data" / "tiermaker-manifest.json"
OUTPUT_DIR = PROJECT_ROOT / "assets" / "players" / "tiermaker"
STATIC_JSON_DIR = PROJECT_ROOT / "data" / "tiermaker"
COMBINED_JSON_PATH = PROJECT_ROOT / "data" / "tiermaker.json"

TEMPLATE_VERSION = 1
BADGE_SIZE = (80, 80)

PORTRAIT_ALIASES = {
    "simon-belmont": "simon",
    "sheik-zelda": "sheik",
}

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]


def slugify(s: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s or "").lower()).strip("-")


def get_portrait_slug(char_name: str) -> str:
    s = slugify(char_name)
    return PORTRAIT_ALIASES.get(s, s)


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for font_path in FONT_CANDIDATES:
        if os.path.exists(font_path):
            try:
                return ImageFont.truetype(font_path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def get_file_sha256(path: Path) -> str:
    if not path.exists():
        return ""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def render_badge(
    portrait_path: Path,
    player_tag: str,
    output_path: Path,
) -> None:
    """Render an 80x80 WebP badge with character portrait and outlined player tag."""
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # 1. Base portrait: crop and resize to 80x80
    with Image.open(portrait_path) as src_img:
        src = src_img.convert("RGBA")
        width, height = src.size

        # Center-crop to square
        min_dim = min(width, height)
        left = (width - min_dim) // 2
        top = (height - min_dim) // 2
        right = left + min_dim
        bottom = top + min_dim

        cropped = src.crop((left, top, right, bottom))
        resized = cropped.resize(BADGE_SIZE, Image.Resampling.LANCZOS)

    # 2. Add subtle dark gradient overlay at the bottom for text legibility
    gradient = Image.new("RGBA", BADGE_SIZE, (0, 0, 0, 0))
    grad_draw = ImageDraw.Draw(gradient)
    # Overlay from y=46 to y=80 with increasing opacity
    for y in range(46, 80):
        alpha = int(170 * ((y - 46) / (80 - 46)) ** 1.2)
        grad_draw.line([(0, y), (79, y)], fill=(0, 0, 0, alpha))

    badge = Image.alpha_composite(resized, gradient)
    draw = ImageDraw.Draw(badge)

    # 3. Dynamic font sizing for player tag
    tag_clean = (player_tag or "").strip()
    target_width = 74  # 3px padding on each side
    font_size = 12
    font = load_font(font_size)

    # Calculate text width
    while font_size > 8:
        bbox = draw.textbbox((0, 0), tag_clean, font=font, stroke_width=2)
        w = bbox[2] - bbox[0]
        if w <= target_width:
            break
        font_size -= 1
        font = load_font(font_size)

    # If still too long at min font size, truncate with ellipsis
    bbox = draw.textbbox((0, 0), tag_clean, font=font, stroke_width=2)
    w = bbox[2] - bbox[0]
    display_tag = tag_clean
    if w > target_width:
        while len(display_tag) > 3 and draw.textbbox((0, 0), display_tag + "…", font=font, stroke_width=2)[2] > target_width:
            display_tag = display_tag[:-1]
        display_tag += "…"

    # Position text at bottom center (baseline ~70px)
    draw.text(
        (40, 71),
        display_tag,
        font=font,
        fill=(255, 255, 255, 255),
        stroke_width=2,
        stroke_fill=(0, 0, 0, 255),
        anchor="mm",
    )

    # 4. Save as WebP
    badge.save(output_path, "WEBP", quality=90, method=6)


class TiermakerDataPipeline:
    def __init__(
        self,
        db_path: Path = DB_PATH,
        index_path: Path = INDEX_PATH,
        exclusions_path: Path = EXCLUSIONS_PATH,
        profiles_dir: Path = PROFILES_DIR,
    ):
        self.db_path = db_path
        self.index_path = index_path
        self.exclusions_path = exclusions_path
        self.profiles_dir = profiles_dir
        self.con: Optional[sqlite3.Connection] = None

    def connect(self) -> sqlite3.Connection:
        if self.con is None:
            self.con = sqlite3.connect(self.db_path)
            self.con.row_factory = sqlite3.Row
        return self.con

    def close(self) -> None:
        if self.con:
            self.con.close()
            self.con = None

    def load_authoritative_index(self) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
        """Load regular players from data/profiles/index.json.
        Returns:
            player_map: playerId -> player metadata dict
            players_by_game: game_slug -> list of {playerId, tag, events, lastEventDate, isInternational: False}
        """
        if not self.index_path.exists():
            return {}, {}

        with open(self.index_path, "r", encoding="utf-8") as f:
            index_data: List[Dict[str, Any]] = json.load(f)

        player_map: Dict[str, Dict[str, Any]] = {}
        players_by_game: Dict[str, List[Dict[str, Any]]] = {}

        for p in index_data:
            pid = str(p["playerId"])
            player_map[pid] = p
            for g in p.get("games", []):
                gslug = g.get("slug") or g.get("id")
                if not gslug:
                    continue
                if gslug not in players_by_game:
                    players_by_game[gslug] = []
                players_by_game[gslug].append({
                    "playerId": pid,
                    "tag": p.get("tag", ""),
                    "events": int(g.get("events") or 0),
                    "lastEventDate": g.get("lastEventDate") or "",
                    "isInternational": False,
                })

        return player_map, players_by_game

    def load_international_players(
        self,
        participation_map: Dict[Tuple[str, str], Tuple[int, Optional[str]]]
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Load players marked as excluded in data/profiles/exclusions.json.
        Returns:
            international_by_game: game_slug -> list of {playerId, tag, events, lastEventDate, isInternational: True}
        """
        if not self.exclusions_path.exists():
            return {}

        try:
            with open(self.exclusions_path, "r", encoding="utf-8") as f:
                ex_data = json.load(f)
        except Exception:
            return {}

        player_games = ex_data.get("playerGames", {})
        if not player_games:
            return {}

        # Cache profile tags from individual profile json files in data/profiles/
        profile_tags: Dict[str, str] = {}
        if self.profiles_dir.exists():
            for pfile in self.profiles_dir.glob("*.json"):
                if pfile.name in [
                    "index.json", "exclusions.json", "merges.json", "overrides.json",
                    "amateur_brackets.json", "event_groups.json", "startgg_metadata.json"
                ]:
                    continue
                try:
                    with open(pfile, "r", encoding="utf-8") as pf:
                        pjson = json.load(pf)
                        pid = str(pjson.get("player", {}).get("startggPlayerId") or "")
                        ptag = pjson.get("player", {}).get("tag")
                        if pid and ptag and pid not in profile_tags:
                            profile_tags[pid] = ptag
                except Exception:
                    pass

        con = self.connect()
        cur = con.cursor()

        international_by_game: Dict[str, List[Dict[str, Any]]] = {}

        for pid, games in player_games.items():
            pid_str = str(pid)
            # Find authoritative tag: 1) profile JSON, 2) DB participants gamer_tag
            authoritative_tag = profile_tags.get(pid_str)
            if not authoritative_tag:
                cur.execute(
                    "SELECT gamer_tag FROM participants WHERE player_id=? ORDER BY id DESC LIMIT 1",
                    (pid_str,)
                )
                row = cur.fetchone()
                authoritative_tag = row[0] if row and row[0] else f"Player {pid_str}"

            for gslug in games:
                if not gslug:
                    continue
                events_count, last_date = participation_map.get((pid_str, gslug), (0, None))
                if gslug not in international_by_game:
                    international_by_game[gslug] = []
                international_by_game[gslug].append({
                    "playerId": pid_str,
                    "tag": authoritative_tag,
                    "events": events_count,
                    "lastEventDate": last_date or "",
                    "isInternational": True,
                })

        return international_by_game

    def query_character_usage(self) -> Dict[Tuple[str, str], List[Dict[str, Any]]]:
        """Query character appearances for each (player_id, videogame_slug).
        Attributed precisely through:
        set_game_selections -> set_games -> sets -> events
                            -> entrants -> entrant_participants -> participants
        Returns:
            (player_id, videogame_slug) -> list of character records sorted by:
            1. appearance_count desc
            2. latest_ts desc
            3. character_id asc
        """
        con = self.connect()
        query = """
        SELECT
            p.player_id,
            ev.videogame_slug,
            sel.character_id,
            c.name as character_name,
            COUNT(sel.id) as appearance_count,
            MAX(COALESCE(s.completed_at, s.started_at, s.start_at, 0)) as latest_ts
        FROM set_game_selections sel
        JOIN set_games g ON g.id = sel.set_game_id
        JOIN sets s ON s.id = g.set_id
        JOIN events ev ON ev.id = s.event_id
        JOIN entrants ent ON ent.id = sel.entrant_id
        JOIN entrant_participants ep ON ep.entrant_id = ent.id
        JOIN participants p ON p.id = ep.participant_id
        LEFT JOIN characters c ON c.videogame_slug = sel.videogame_slug AND c.id = sel.character_id
        WHERE p.player_id IS NOT NULL AND sel.character_id IS NOT NULL
        GROUP BY p.player_id, ev.videogame_slug, sel.character_id, c.name
        """
        cur = con.cursor()
        cur.execute(query)

        by_player_game: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
        for row in cur.fetchall():
            key = (str(row["player_id"]), str(row["videogame_slug"]))
            if key not in by_player_game:
                by_player_game[key] = []
            by_player_game[key].append({
                "character_id": str(row["character_id"]),
                "character_name": row["character_name"] or "",
                "appearance_count": int(row["appearance_count"]),
                "latest_ts": int(row["latest_ts"] or 0),
            })

        # Sort according to tie-breaking requirements
        for key, char_list in by_player_game.items():
            char_list.sort(key=lambda item: (
                -item["appearance_count"],
                -item["latest_ts"],
                item["character_id"]
            ))

        return by_player_game

    def query_player_participation(self) -> Dict[Tuple[str, str], Tuple[int, Optional[str]]]:
        """Query distinct event counts and most recent participation date per player and game.
        Directly from SQLite (events, tournaments, sets).
        Returns:
            (player_id, videogame_slug) -> (event_count, last_participation_date)
        """
        con = self.connect()
        query = """
        SELECT
            p.player_id,
            ev.videogame_slug,
            COUNT(DISTINCT ev.id) as distinct_events,
            MAX(COALESCE(s.completed_at, s.started_at, s.start_at, t.start_at, 0)) as latest_ts
        FROM participants p
        JOIN entrant_participants ep ON ep.participant_id = p.id
        JOIN entrants ent ON ent.id = ep.entrant_id
        JOIN events ev ON ev.id = ent.event_id
        JOIN tournaments t ON t.slug = ev.tournament_slug
        LEFT JOIN sets s ON s.event_id = ev.id
        WHERE p.player_id IS NOT NULL
        GROUP BY p.player_id, ev.videogame_slug
        """
        cur = con.cursor()
        cur.execute(query)

        res: Dict[Tuple[str, str], Tuple[int, Optional[str]]] = {}
        for row in cur.fetchall():
            pid = str(row["player_id"])
            gslug = str(row["videogame_slug"])
            event_count = int(row["distinct_events"] or 0)
            latest_ts = int(row["latest_ts"] or 0)
            last_date = None
            if latest_ts > 0:
                last_date = datetime.fromtimestamp(latest_ts, tz=timezone.utc).strftime("%Y-%m-%d")
            res[(pid, gslug)] = (event_count, last_date)
        return res

    def resolve_player_portrait(
        self,
        player_id: str,
        game_slug: str,
        usage_map: Dict[Tuple[str, str], List[Dict[str, Any]]]
    ) -> Tuple[Path, Optional[str], Optional[str], int, str]:
        """Resolve the portrait path, character ID, name, count, and date for a player/game.
        Falls back to assets/renders/<game-slug>/portraits/other.webp if no character data or asset exists.
        """
        fallback_path = PROJECT_ROOT / "assets" / "renders" / game_slug / "portraits" / "other.webp"
        if not fallback_path.exists():
            # Ultimate other fallback as universal safe fallback
            fallback_path = PROJECT_ROOT / "assets" / "renders" / "ultimate" / "portraits" / "other.webp"

        char_list = usage_map.get((player_id, game_slug), [])
        if not char_list:
            return fallback_path, None, None, 0, ""

        top_char = char_list[0]
        char_id = top_char["character_id"]
        char_name = top_char["character_name"]
        count = top_char["appearance_count"]
        ts = top_char["latest_ts"]
        date_str = ""
        if ts > 0:
            date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")

        pslug = get_portrait_slug(char_name)
        portrait_path = PROJECT_ROOT / "assets" / "renders" / game_slug / "portraits" / f"{pslug}.webp"

        if portrait_path.exists():
            return portrait_path, char_id, char_name, count, date_str

        # If portrait asset does not exist, use game other fallback
        return fallback_path, char_id, char_name, count, date_str


def load_manifest(manifest_path: Optional[Path] = None) -> Dict[str, Any]:
    target = manifest_path or MANIFEST_PATH
    if target.exists():
        try:
            with open(target, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"version": TEMPLATE_VERSION, "images": {}}


def save_manifest(manifest: Dict[str, Any], manifest_path: Optional[Path] = None) -> None:
    target = manifest_path or MANIFEST_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)


def run_pipeline(
    sample_limit: Optional[int] = None,
    force: bool = False,
    clean_obsolete: bool = False,
    game_filter: Optional[str] = None,
    db_path: Optional[Path] = None,
    index_path: Optional[Path] = None,
    exclusions_path: Optional[Path] = None,
    profiles_dir: Optional[Path] = None,
    output_dir: Optional[Path] = None,
    manifest_path: Optional[Path] = None,
    static_json_dir: Optional[Path] = None,
    combined_json_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Run the complete badge generation and static JSON export."""
    actual_db = db_path or DB_PATH
    actual_index = index_path or INDEX_PATH
    actual_exclusions = exclusions_path or EXCLUSIONS_PATH
    actual_profiles_dir = profiles_dir or PROFILES_DIR
    actual_output = output_dir or OUTPUT_DIR
    actual_manifest = manifest_path or MANIFEST_PATH
    actual_static_json = static_json_dir or STATIC_JSON_DIR
    actual_combined_json = combined_json_path or COMBINED_JSON_PATH

    pipeline = TiermakerDataPipeline(
        db_path=actual_db,
        index_path=actual_index,
        exclusions_path=actual_exclusions,
        profiles_dir=actual_profiles_dir,
    )
    try:
        player_map, players_by_game = pipeline.load_authoritative_index()
        usage_map = pipeline.query_character_usage()
        participation_map = pipeline.query_player_participation()
        international_by_game = pipeline.load_international_players(participation_map)
    finally:
        pipeline.close()

    manifest = load_manifest(actual_manifest)
    manifest_images: Dict[str, Dict[str, Any]] = manifest.get("images", {})

    all_games = sorted(set(list(players_by_game.keys()) + list(international_by_game.keys())))
    target_games = [game_filter] if game_filter else all_games

    stats = {
        "generated": 0,
        "updated": 0,
        "unchanged": 0,
        "obsolete_detected": 0,
        "obsolete_cleaned": 0,
        "json_files_generated": 0,
    }

    active_image_keys: Set[str] = set()
    current_game_rosters: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}

    for gslug in target_games:
        current_game_rosters[gslug] = {
            "players": [],
            "international": []
        }

        # 1. Process regular unranked players
        reg_players = players_by_game.get(gslug, [])
        if sample_limit:
            reg_players = reg_players[:sample_limit]

        for p_info in reg_players:
            pid = p_info["playerId"]
            tag = p_info["tag"]
            db_events, db_last_date = participation_map.get((pid, gslug), (p_info["events"], p_info["lastEventDate"]))
            events_count = db_events or p_info["events"]
            last_event_date = db_last_date or p_info["lastEventDate"]

            portrait_path, char_id, char_name, count, last_use_date = pipeline.resolve_player_portrait(
                pid, gslug, usage_map
            )

            portrait_hash = get_file_sha256(portrait_path)
            img_rel_dir = Path(gslug)
            img_filename = f"{pid}.webp"
            img_rel_path = img_rel_dir / img_filename
            img_full_path = actual_output / img_rel_path

            manifest_key = f"{gslug}/{pid}"
            active_image_keys.add(manifest_key)

            existing_record = manifest_images.get(manifest_key)
            needs_generation = False

            if force or not img_full_path.exists():
                needs_generation = True
            elif not existing_record:
                needs_generation = True
            elif existing_record.get("player_tag") != tag:
                needs_generation = True
            elif existing_record.get("character_id") != char_id:
                needs_generation = True
            elif existing_record.get("portrait_hash") != portrait_hash:
                needs_generation = True
            elif existing_record.get("template_version") != TEMPLATE_VERSION:
                needs_generation = True

            if needs_generation:
                render_badge(portrait_path, tag, img_full_path)
                is_update = existing_record is not None and img_full_path.exists()
                if is_update:
                    stats["updated"] += 1
                else:
                    stats["generated"] += 1

                manifest_images[manifest_key] = {
                    "player_id": pid,
                    "game_id": gslug,
                    "player_tag": tag,
                    "character_id": char_id,
                    "character_name": char_name,
                    "appearance_count": count,
                    "last_appearance_date": last_use_date,
                    "portrait_hash": portrait_hash,
                    "template_version": TEMPLATE_VERSION,
                    "filename": str(img_rel_path),
                }
            else:
                stats["unchanged"] += 1

            current_game_rosters[gslug]["players"].append({
                "id": pid,
                "tag": tag,
                "image": f"{pid}.webp",
                "image_path": f"assets/players/tiermaker/{gslug}/{pid}.webp",
                "event_count": events_count,
                "last_participation": last_event_date or None,
                "selected_character": char_name,
                "character_id": char_id,
                "is_international": False,
            })

        # 2. Process international players
        intl_players = international_by_game.get(gslug, [])
        if sample_limit:
            intl_players = intl_players[:sample_limit]

        for p_info in intl_players:
            pid = p_info["playerId"]
            tag = p_info["tag"]
            events_count = p_info["events"]
            last_event_date = p_info["lastEventDate"]

            portrait_path, char_id, char_name, count, last_use_date = pipeline.resolve_player_portrait(
                pid, gslug, usage_map
            )

            portrait_hash = get_file_sha256(portrait_path)
            img_rel_dir = Path(gslug)
            img_filename = f"{pid}.webp"
            img_rel_path = img_rel_dir / img_filename
            img_full_path = actual_output / img_rel_path

            manifest_key = f"{gslug}/{pid}"
            active_image_keys.add(manifest_key)

            existing_record = manifest_images.get(manifest_key)
            needs_generation = False

            if force or not img_full_path.exists():
                needs_generation = True
            elif not existing_record:
                needs_generation = True
            elif existing_record.get("player_tag") != tag:
                needs_generation = True
            elif existing_record.get("character_id") != char_id:
                needs_generation = True
            elif existing_record.get("portrait_hash") != portrait_hash:
                needs_generation = True
            elif existing_record.get("template_version") != TEMPLATE_VERSION:
                needs_generation = True

            if needs_generation:
                render_badge(portrait_path, tag, img_full_path)
                is_update = existing_record is not None and img_full_path.exists()
                if is_update:
                    stats["updated"] += 1
                else:
                    stats["generated"] += 1

                manifest_images[manifest_key] = {
                    "player_id": pid,
                    "game_id": gslug,
                    "player_tag": tag,
                    "character_id": char_id,
                    "character_name": char_name,
                    "appearance_count": count,
                    "last_appearance_date": last_use_date,
                    "portrait_hash": portrait_hash,
                    "template_version": TEMPLATE_VERSION,
                    "filename": str(img_rel_path),
                }
            else:
                stats["unchanged"] += 1

            current_game_rosters[gslug]["international"].append({
                "id": pid,
                "tag": tag,
                "image": f"{pid}.webp",
                "image_path": f"assets/players/tiermaker/{gslug}/{pid}.webp",
                "event_count": events_count,
                "last_participation": last_event_date or None,
                "selected_character": char_name,
                "character_id": char_id,
                "is_international": True,
            })

    # Detect obsolete images
    obsolete_keys = []
    if not sample_limit and not game_filter:
        for m_key in list(manifest_images.keys()):
            if m_key not in active_image_keys:
                obsolete_keys.append(m_key)
                stats["obsolete_detected"] += 1
                if clean_obsolete:
                    old_path = actual_output / f"{m_key}.webp"
                    if old_path.exists():
                        try:
                            old_path.unlink()
                            stats["obsolete_cleaned"] += 1
                        except OSError as e:
                            print(f"Warning: could not delete {old_path}: {e}")
                    del manifest_images[m_key]

        # Also scan disk for untracked files
        if actual_output.exists():
            for root, _, files in os.walk(actual_output):
                for f in files:
                    if f.endswith(".webp"):
                        full_p = Path(root) / f
                        rel_k = f"{full_p.parent.name}/{full_p.stem}"
                        if rel_k not in active_image_keys:
                            if rel_k not in obsolete_keys:
                                stats["obsolete_detected"] += 1
                            if clean_obsolete:
                                try:
                                    full_p.unlink()
                                    stats["obsolete_cleaned"] += 1
                                except OSError:
                                    pass

    # Save manifest
    manifest["version"] = TEMPLATE_VERSION
    manifest["images"] = manifest_images
    save_manifest(manifest, actual_manifest)

    # Generate static JSON files
    actual_static_json.mkdir(parents=True, exist_ok=True)
    combined_data: Dict[str, Any] = {"games": {}}

    for gslug, roster in current_game_rosters.items():
        # Sort rosters by tag ascending initially
        roster["players"].sort(key=lambda x: x["tag"].lower())
        roster["international"].sort(key=lambda x: x["tag"].lower())
        game_json_data = {
            "game_id": gslug,
            "players": roster["players"],
            "international": roster["international"],
        }
        game_json_path = actual_static_json / f"{gslug}.json"
        with open(game_json_path, "w", encoding="utf-8") as f:
            json.dump(game_json_data, f, indent=2)
        stats["json_files_generated"] += 1

        combined_data["games"][gslug] = game_json_data

    with open(actual_combined_json, "w", encoding="utf-8") as f:
        json.dump(combined_data, f, indent=2)
    stats["json_files_generated"] += 1

    return stats


def print_summary(stats: Dict[str, Any]) -> None:
    print("\nTIERMAKER PIPELINE SUMMARY:")
    print("---------------------------")
    print(f"Images generated:          {stats['generated']}")
    print(f"Images updated:            {stats['updated']}")
    print(f"Images unchanged:          {stats['unchanged']}")
    print(f"Obsolete images detected:  {stats['obsolete_detected']}")
    if stats['obsolete_cleaned']:
        print(f"Obsolete images cleaned:   {stats['obsolete_cleaned']}")
    print(f"Static JSONs generated:    {stats['json_files_generated']}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Tiermaker player badges and static JSON files.")
    parser.add_argument("--sample", type=int, default=None, help="Generate a sample limit of N players per game")
    parser.add_argument("--force", action="store_true", help="Force regenerate all badge images")
    parser.add_argument("--clean-obsolete", action="store_true", help="Delete obsolete images not in current index")
    parser.add_argument("--game", type=str, default=None, help="Process only a specific game slug")

    args = parser.parse_args()

    try:
        from scripts.summary_tracker import SummaryTracker
        tracker = SummaryTracker("generate_tiermaker_badges_summary.txt")
    except Exception:
        tracker = None

    stats = run_pipeline(
        sample_limit=args.sample,
        force=args.force,
        clean_obsolete=args.clean_obsolete,
        game_filter=args.game,
    )
    print_summary(stats)

    if tracker:
        if stats["generated"] > 0 or stats["updated"] > 0:
            tracker.record_new("BADGES", f"{stats['generated']} badges generated, {stats['updated']} updated")
        if stats["obsolete_cleaned"] > 0:
            tracker.record_modified("BADGES", f"{stats['obsolete_cleaned']} obsolete badges cleaned")
        tracker.write_summary()


if __name__ == "__main__":
    main()
