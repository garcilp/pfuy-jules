"""Metadata generation utilities for Platfighters.uy pages and entities.

Provides dynamic Open Graph tags, canonical URLs, descriptive titles,
and social share metadata across player profiles, official rankings,
tournament events, and directory pages.
"""

import html
import json
import re
import sqlite3
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
PROFILE_DIR = ROOT / "data" / "profiles"
DATABASE = ROOT / "startgg-data" / "platfighters.sqlite3"
CANONICAL_ORIGIN = "https://platfighters.uy"

CHAR_PORTRAIT_ALIASES = {
    "simon-belmont": "simon",
    "sheik-zelda": "sheik",
}


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")
    return s


def char_portrait_slug(name: str) -> str:
    s = slugify(name)
    return CHAR_PORTRAIT_ALIASES.get(s, s)


def resolve_base_url(host_header: str = "", proto: str = "") -> str:
    """Returns absolute base URL. Uses CANONICAL_ORIGIN by default or client request if provided."""
    if host_header:
        scheme = proto or ("https" if "443" in host_header or not any(h in host_header for h in ("localhost", "127.0.0.1")) else "http")
        return f"{scheme}://{host_header}"
    return CANONICAL_ORIGIN


def make_absolute_url(rel_or_abs: str, base_url: str = CANONICAL_ORIGIN) -> str:
    if not rel_or_abs:
        return f"{base_url}/assets/logo.jpg"
    if rel_or_abs.startswith("http://") or rel_or_abs.startswith("https://"):
        return rel_or_abs
    clean = rel_or_abs.lstrip("/")
    return f"{base_url}/{clean}"


def load_profile_by_id_or_slug(player_query: str) -> dict | None:
    """Finds and loads a player's JSON profile by start.gg ID or slug."""
    if not player_query:
        return None
    p_str = str(player_query).strip()

    # Direct slug or player-id match
    if (PROFILE_DIR / f"{p_str}.json").exists():
        try:
            with (PROFILE_DIR / f"{p_str}.json").open(encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    # Check *-<player_id>.json
    if p_str.isdigit():
        for p in PROFILE_DIR.glob(f"*-{p_str}.json"):
            try:
                with p.open(encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass

    # Scan profile contents as fallback
    for p in PROFILE_DIR.glob("*.json"):
        if p.name in {
            "index.json", "overrides.json", "merges.json",
            "startgg_metadata.json", "amateur_brackets.json",
            "event_groups.json", "exclusions.json",
        }:
            continue
        try:
            with p.open(encoding="utf-8") as f:
                d = json.load(f)
                if isinstance(d, dict) and "player" in d:
                    player_data = d.get("player") or {}
                    if str(player_data.get("startggPlayerId") or "") == p_str:
                        return d
                    if slugify(player_data.get("tag") or "") == slugify(p_str):
                        return d
        except Exception:
            continue

    return None


def get_player_metadata(player_id_or_slug: str, base_url: str) -> dict | None:
    profile = load_profile_by_id_or_slug(player_id_or_slug)
    if not profile or not isinstance(profile, dict):
        return None

    player = profile.get("player") or {}
    tag = player.get("tag") or player_id_or_slug
    sponsor = player.get("sponsor")
    city = player.get("city")
    country = player.get("country") or ("Uruguay" if city else "")
    loc_parts = [p for p in (city, country) if p]
    location = ", ".join(loc_parts) if loc_parts else (player.get("location") or "")

    games = profile.get("games") or []
    total_events = sum(int(g.get("events") or 0) for g in games)
    total_wins = sum(int(g.get("wins") or 0) for g in games)
    total_losses = sum(int(g.get("losses") or 0) for g in games)
    game_names = [g.get("name") for g in games if g.get("name")]

    # Find top characters and ranking highlights
    top_characters = []
    top_rankings = []
    for g in games:
        for c in g.get("characters") or []:
            cname = c.get("name")
            if cname and cname != "Other" and cname not in top_characters:
                top_characters.append(cname)
        for r in g.get("rankings") or []:
            if isinstance(r, dict):
                r_name = r.get("title") or r.get("name") or "PR"
                r_place = r.get("placement") or r.get("rank")
                if r_name and r_place:
                    top_rankings.append(f"#{r_place} {r_name}")

    # Build description
    desc_parts = []
    if sponsor:
        desc_parts.append(f"Competitor for {sponsor}.")
    if location:
        desc_parts.append(f"Based in {location}.")
    if game_names:
        games_str = ", ".join(game_names[:3])
        if len(game_names) > 3:
            games_str += f", and {len(game_names) - 3} more"
        desc_parts.append(f"Competes in {games_str}.")
    if total_events > 0:
        desc_parts.append(f"{total_events} tournament{'s' if total_events != 1 else ''} logged.")
    if total_wins + total_losses > 0:
        desc_parts.append(f"{total_wins}–{total_losses} set record.")
    if top_characters:
        desc_parts.append(f"Mains: {', '.join(top_characters[:3])}.")
    if top_rankings:
        desc_parts.append(f"Rankings: {', '.join(top_rankings[:2])}.")

    description = " ".join(desc_parts) if desc_parts else f"Player profile and tournament statistics for {tag} on Platfighters.uy."

    # Resolve preview image
    image_url = None
    photo = player.get("photo")
    if photo and (ROOT / photo.lstrip("/")).exists():
        image_url = make_absolute_url(photo, base_url)
    elif player.get("startggPlayerId") and (ROOT / f"assets/players/{player['startggPlayerId']}.png").exists():
        image_url = make_absolute_url(f"assets/players/{player['startggPlayerId']}.png", base_url)

    # Fallback to top character portrait
    if not image_url and games:
        for g in games:
            g_slug = g.get("slug") or g.get("id") or "ultimate"
            for c in g.get("characters") or []:
                c_name = c.get("name")
                if c_name and c_name != "Other":
                    c_slug = char_portrait_slug(c_name)
                    portrait_rel = f"assets/renders/{g_slug}/portraits/{c_slug}.webp"
                    if (ROOT / portrait_rel).exists():
                        image_url = make_absolute_url(portrait_rel, base_url)
                        break
            if image_url:
                break

    if not image_url:
        image_url = make_absolute_url("assets/logo.jpg", base_url)

    canonical_pid = str(player.get("startggPlayerId") or player_id_or_slug)
    page_url = f"{base_url}/player.html?player={canonical_pid}"

    return {
        "title": f"{tag} · Platfighters.uy",
        "description": description,
        "type": "profile",
        "url": page_url,
        "image": image_url,
    }


def load_ranking_by_id(ranking_id: str) -> dict | None:
    if not ranking_id:
        return None
    r_id = str(ranking_id).strip()

    # Try static JSON export in data/rankings/<id>.json
    r_file = ROOT / "data" / "rankings" / f"{r_id}.json"
    if r_file.exists():
        try:
            with r_file.open(encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    # Try SQLite official_rankings table
    if DATABASE.exists():
        try:
            with sqlite3.connect(DATABASE) as conn:
                conn.row_factory = sqlite3.Row
                row = conn.execute("SELECT * FROM official_rankings WHERE id = ?", (r_id,)).fetchone()
                if row:
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
                    }
                    if "image_box" in row.keys() and row["image_box"]:
                        try:
                            ib = json.loads(row["image_box"])
                            if isinstance(ib, dict) and ib.get("url"):
                                data["imageBox"] = ib
                        except Exception:
                            pass
                    return data
        except Exception:
            pass

    return None


def get_ranking_metadata(ranking_id: str, base_url: str) -> dict | None:
    ranking = load_ranking_by_id(ranking_id)
    if not ranking or not isinstance(ranking, dict):
        return None

    title = ranking.get("title") or "Power Ranking"
    game = ranking.get("game") or {}
    game_name = game.get("name") or game.get("slug") or ""
    period = ranking.get("period") or {}
    period_start = period.get("start")
    period_end = period.get("end")
    players = ranking.get("players") or []
    top_player = players[0].get("tag") if players and isinstance(players[0], dict) else None

    # Description
    intro = (ranking.get("intro") or "").strip()
    if intro:
        clean_intro = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", intro)
        clean_intro = re.sub(r"[*#_`>-]", " ", clean_intro)
        clean_intro = re.sub(r"\s+", " ", clean_intro).strip()
        description = clean_intro[:250] + ("…" if len(clean_intro) > 250 else "")
    else:
        desc_parts = [f"Official power ranking for {game_name} in Uruguay."]
        if period_start and period_end:
            desc_parts.append(f"Active period: {period_start} to {period_end}.")
        if len(players) > 0:
            desc_parts.append(f"Features {len(players)} ranked competitors.")
        if top_player:
            desc_parts.append(f"Ranked #1: {top_player}.")
        description = " ".join(desc_parts)

    # Preview image
    image_url = None
    image_box = ranking.get("imageBox")
    if isinstance(image_box, dict) and image_box.get("url"):
        ib_url = image_box["url"].strip()
        if ib_url.startswith("http://") or ib_url.startswith("https://"):
            image_url = ib_url
        elif (ROOT / ib_url.lstrip("/")).exists():
            image_url = make_absolute_url(ib_url, base_url)

    # Top player image
    if not image_url and players:
        p1 = players[0]
        p1_photo = p1.get("photo")
        if p1_photo and (ROOT / p1_photo.lstrip("/")).exists():
            image_url = make_absolute_url(p1_photo, base_url)
        elif p1.get("playerId") and (ROOT / f"assets/players/{p1['playerId']}.png").exists():
            image_url = make_absolute_url(f"assets/players/{p1['playerId']}.png", base_url)

    # Game hub or default image fallback
    if not image_url and game.get("slug"):
        hub_img = f"assets/hubs/{game['slug']}.webp"
        if (ROOT / hub_img).exists():
            image_url = make_absolute_url(hub_img, base_url)

    if not image_url:
        image_url = make_absolute_url("assets/logo.jpg", base_url)

    page_url = f"{base_url}/ranking.html?id={ranking.get('id') or ranking_id}"

    return {
        "title": f"{title} · Platfighters.uy",
        "description": description,
        "type": "article",
        "url": page_url,
        "image": image_url,
    }


def load_event_by_slug(tournament_slug: str) -> dict | None:
    if not tournament_slug:
        return None
    t_slug = str(tournament_slug).strip()

    t_file = ROOT / "data" / "events" / f"{t_slug}.json"
    if t_file.exists():
        try:
            with t_file.open(encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    # Check data/events-index.json
    events_index_file = ROOT / "data" / "events-index.json"
    if events_index_file.exists():
        try:
            with events_index_file.open(encoding="utf-8") as f:
                items = json.load(f)
                if isinstance(items, list):
                    for item in items:
                        if item.get("tournamentSlug") == t_slug:
                            return item
        except Exception:
            pass

    return None


def get_event_metadata(tournament_slug: str, base_url: str) -> dict | None:
    event = load_event_by_slug(tournament_slug)
    if not event or not isinstance(event, dict):
        return None

    name = event.get("tournament") or event.get("name") or tournament_slug
    date = event.get("date")
    total_entrants = event.get("totalEntrants") or event.get("entrants")
    games = event.get("games") or []
    game_names = [g.get("name") for g in games if isinstance(g, dict) and g.get("name")]
    if not game_names and event.get("game"):
        game_names = [event.get("game")]

    desc_parts = [f"Tournament results and standings for {name}."]
    if date:
        desc_parts.append(f"Date: {date}.")
    if total_entrants:
        desc_parts.append(f"{total_entrants} entrant{'s' if total_entrants != 1 else ''}.")
    if game_names:
        desc_parts.append(f"Events: {', '.join(game_names)}.")

    description = " ".join(desc_parts)

    image_url = event.get("image")
    if not image_url or not (image_url.startswith("http://") or image_url.startswith("https://")):
        image_url = make_absolute_url("assets/logo.jpg", base_url)

    page_url = f"{base_url}/event.html?tournament={event.get('tournamentSlug') or tournament_slug}"

    return {
        "title": f"{name} · Platfighters.uy",
        "description": description,
        "type": "website",
        "url": page_url,
        "image": image_url,
    }


def get_page_metadata(path: str, query: str = "", host: str = "", proto: str = "") -> dict:
    """Returns metadata dict {title, description, type, url, image, site_name, locale} for any request."""
    base_url = resolve_base_url(host, proto)
    clean_path = path.strip("/") or "index.html"
    if clean_path.endswith("/"):
        clean_path = clean_path.rstrip("/")

    qs = parse_qs(query) if query else {}

    # 1. Dynamic player profile
    if clean_path in {"player.html", "index.html"} and "player" in qs:
        player_query = qs["player"][0].strip()
        meta = get_player_metadata(player_query, base_url)
        if meta:
            meta["site_name"] = "Platfighters.uy"
            meta["locale"] = "es_UY"
            return meta

    # 2. Dynamic ranking article
    if clean_path == "ranking.html" and "id" in qs:
        ranking_id = qs["id"][0].strip()
        meta = get_ranking_metadata(ranking_id, base_url)
        if meta:
            meta["site_name"] = "Platfighters.uy"
            meta["locale"] = "es_UY"
            return meta

    # 3. Dynamic tournament event
    if clean_path == "event.html" and "tournament" in qs:
        tournament_slug = qs["tournament"][0].strip()
        meta = get_event_metadata(tournament_slug, base_url)
        if meta:
            meta["site_name"] = "Platfighters.uy"
            meta["locale"] = "es_UY"
            return meta

    # 4. Static pages defaults
    static_configs = {
        "index.html": {
            "title": "Platfighters.uy · Uruguayan Platform Fighter Scene & Rankings",
            "description": "Results, rankings and events from every game and community in Uruguay, built from start.gg history.",
            "type": "website",
            "image": "assets/logo.jpg",
        },
        "players.html": {
            "title": "Players · Platfighters.uy",
            "description": "Browse competitor profiles, characters, tournament attendance, and results across Uruguayan platform fighter communities.",
            "type": "website",
            "image": "assets/logo.jpg",
        },
        "events.html": {
            "title": "Events & Tournaments · Platfighters.uy",
            "description": "Browse upcoming and past platform fighter tournaments and competitive events in Uruguay.",
            "type": "website",
            "image": "assets/logo.jpg",
        },
        "rankings.html": {
            "title": "Rankings & Leaderboards · Platfighters.uy",
            "description": "Explore Glicko-2, Quality Wins, Strength of Field, Consistency and Power Rankings across Uruguay platform fighters.",
            "type": "website",
            "image": "assets/logo.jpg",
        },
        "ranking-creator.html": {
            "title": "Ranking Creator · Platfighters.uy",
            "description": "Design, preview, customize, and export community power rankings and graphics for platform fighter communities.",
            "type": "website",
            "image": "assets/logo.jpg",
        },
        "admin.html": {
            "title": "Site Management · Platfighters.uy",
            "description": "Manage player profiles, official power rankings, and event groupings on Platfighters.uy.",
            "type": "website",
            "image": "assets/logo.jpg",
        },
        "player.html": {
            "title": "Player Profile · Platfighters.uy",
            "description": "Player tournament history, rankings, character usage, head-to-head records and match stats on Platfighters.uy.",
            "type": "profile",
            "image": "assets/logo.jpg",
        },
        "ranking.html": {
            "title": "Power Ranking · Platfighters.uy",
            "description": "Official community power rankings and retrospective standings for platform fighter scenes in Uruguay.",
            "type": "article",
            "image": "assets/logo.jpg",
        },
        "event.html": {
            "title": "Event Details · Platfighters.uy",
            "description": "Tournament details, game events, standings, and participant placements on Platfighters.uy.",
            "type": "website",
            "image": "assets/logo.jpg",
        },
    }

    config = static_configs.get(clean_path, static_configs["index.html"])
    page_url = f"{base_url}/{clean_path}" if clean_path != "index.html" else f"{base_url}/"

    return {
        "title": config["title"],
        "description": config["description"],
        "type": config["type"],
        "url": page_url,
        "image": make_absolute_url(config["image"], base_url),
        "site_name": "Platfighters.uy",
        "locale": "es_UY",
    }


def inject_html_metadata(html_content: str, meta: dict) -> str:
    """Injects or updates <title>, <meta name='description'>, <link rel='canonical'> and <meta property='og:...'> in HTML."""
    title_esc = html.escape(meta.get("title", "Platfighters.uy"))
    desc_esc = html.escape(meta.get("description", ""))
    type_esc = html.escape(meta.get("type", "website"))
    url_esc = html.escape(meta.get("url", CANONICAL_ORIGIN))
    image_esc = html.escape(meta.get("image", f"{CANONICAL_ORIGIN}/assets/logo.jpg"))
    site_name_esc = html.escape(meta.get("site_name", "Platfighters.uy"))
    locale_esc = html.escape(meta.get("locale", "es_UY"))

    # Remove existing <title>, canonical link, meta description, and og:* tags from html_content
    cleaned = html_content
    cleaned = re.sub(r"<title>.*?</title>", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r'<link\s+rel=["\']canonical["\'].*?>', "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'<meta\s+name=["\']description["\'].*?>', "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'<meta\s+property=["\']og:[^"\']+["\'].*?>', "", cleaned, flags=re.IGNORECASE)

    metadata_block = (
        f"<title>{title_esc}</title>\n"
        f'<meta name="description" content="{desc_esc}">\n'
        f'<link rel="canonical" href="{url_esc}">\n'
        f'<meta property="og:title" content="{title_esc}">\n'
        f'<meta property="og:description" content="{desc_esc}">\n'
        f'<meta property="og:type" content="{type_esc}">\n'
        f'<meta property="og:url" content="{url_esc}">\n'
        f'<meta property="og:image" content="{image_esc}">\n'
        f'<meta property="og:site_name" content="{site_name_esc}">\n'
        f'<meta property="og:locale" content="{locale_esc}">'
    )

    # Insert right after <head> or at the top of <head>
    head_match = re.search(r"<head\b[^>]*>", cleaned, flags=re.IGNORECASE)
    if head_match:
        pos = head_match.end()
        return cleaned[:pos] + "\n" + metadata_block + cleaned[pos:]

    return metadata_block + "\n" + cleaned
