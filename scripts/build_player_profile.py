"""Build website-compatible profile JSON from the local start.gg SQLite database."""

import argparse
from functools import lru_cache
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATABASE = PROJECT_ROOT / "startgg-data" / "platfighters.sqlite3"
PROFILE_DIR = PROJECT_ROOT / "data" / "profiles"
RAW_EVENT_DIR = PROJECT_ROOT / "startgg-data" / "raw"


def text_id(value):
    return None if value is None else str(value)


def display_tournament(slug):
    return re.sub(r"\s+", " ", slug.replace("-", " ")).strip().title()


def date_from_epoch(value):
    if value is None:
        return None
    return datetime.fromtimestamp(value, timezone.utc).date().isoformat()


def ids_clause(values):
    return ",".join("?" for _ in values)


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
        if normalized in {"-1", "-score", "0-0", "score-score"}:
            return True
    return False


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


def amateur_brackets_config():
    path = PROFILE_DIR / "amateur_brackets.json"
    try:
        with path.open(encoding="utf-8") as file:
            value = json.load(file)
        events = {normalize_event_key(item) for item in value.get("events", []) if normalize_event_key(item)}
        phases = set()
        for item in value.get("phases", []):
            if isinstance(item, str) and "#" in item:
                key, phase_name = item.split("#", 1)
                norm_key = normalize_event_key(key)
                if norm_key and phase_name.strip():
                    phases.add(f"{norm_key}#{phase_name.strip()}")
        non_amateur_phases = set()
        for item in value.get("nonAmateurPhases", []):
            if isinstance(item, str) and "#" in item:
                key, phase_name = item.split("#", 1)
                norm_key = normalize_event_key(key)
                if norm_key and phase_name.strip():
                    non_amateur_phases.add(f"{norm_key}#{phase_name.strip()}")
        return {"events": events, "phases": phases, "nonAmateurPhases": non_amateur_phases}
    except (OSError, json.JSONDecodeError, AttributeError, TypeError):
        return {"events": set(), "phases": set(), "nonAmateurPhases": set()}


def is_amateur_name(name):
    if not isinstance(name, str) or not name.strip():
        return False
    normalized = " ".join(name.strip().split()).casefold()
    if normalized in {"bracket b", "categoria b", "amateur bracket", "singles b", "categoria bits", "falsa b"}:
        return True
    return bool(re.search(r"\b(bracket\s*b|categoria\s*b|amateur|singles\s*b|categoria\s*bits|falsa\s*b)\b", normalized))


def is_amateur_bracket(event_key, phase_name=None, amateur_cfg=None, event_links=None):
    if amateur_cfg is None:
        amateur_cfg = amateur_brackets_config()
    if event_links is None:
        event_links = event_group_overrides()

    norm_key = normalize_event_key(event_key) if event_key else None

    # Check phase-level non-amateur explicit override
    if norm_key and phase_name and f"{norm_key}#{phase_name.strip()}" in amateur_cfg.get("nonAmateurPhases", set()):
        return False

    # Check phase-level explicit amateur flag
    if norm_key and phase_name and f"{norm_key}#{phase_name.strip()}" in amateur_cfg.get("phases", set()):
        return True

    # Check event-level explicit amateur flag
    if norm_key and norm_key in amateur_cfg.get("events", set()):
        return True

    # Check event_groups linked event explicitly configured as amateur
    if norm_key and norm_key in event_links:
        link_info = event_links[norm_key]
        if isinstance(link_info, dict) and link_info.get("is_amateur") is True:
            return True
        if isinstance(link_info, dict) and link_info.get("is_amateur") is False:
            return False

    # Name-based compatibility fallback
    if phase_name and is_amateur_name(phase_name):
        return True
    if norm_key and is_amateur_name(norm_key.rsplit("/", 1)[-1].replace("-", " ")):
        return True

    return False


def event_group_overrides():
    path = PROFILE_DIR / "event_groups.json"
    try:
        with path.open(encoding="utf-8") as file:
            groups = json.load(file)
        normalized = {}
        for child, value in groups.items():
            child_key = normalize_event_key(child)
            parent_key = normalize_event_key(value.get("parent")) if isinstance(value, dict) else None
            phase = value.get("phase") if isinstance(value, dict) else None
            is_amateur = value.get("is_amateur") if isinstance(value, dict) else None
            if child_key and parent_key and child_key != parent_key and isinstance(phase, str) and phase.strip():
                item = {"parent": parent_key, "phase": phase.strip()}
                if isinstance(is_amateur, bool):
                    item["is_amateur"] = is_amateur
                normalized[child_key] = item
        return normalized
    except (OSError, json.JSONDecodeError, AttributeError):
        return {}


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


def combine_linked_events(results, links, labels, amateur_cfg=None, event_entrants=None):
    if event_entrants is None:
        event_entrants = {}
    buckets = {}
    for result in results:
        key = result.get("eventKey")
        parent = links.get(key, {}).get("parent") if key else None
        buckets.setdefault(parent or key, []).append(result)
    combined = []
    for root, linked in buckets.items():
        primary = next((item for item in linked if item.get("eventKey") == root), linked[0])
        event_result = dict(primary)
        event_result["event"] = labels.get(root, primary["event"])
        event_result["eventKey"] = root

        main_entrants = event_entrants.get(root) or primary.get("entrants") or 0

        source_events = []
        for item in linked:
            item_sources = item.get("sourceEvents", [{
                "eventKey": item.get("eventKey"), "event": item.get("event"),
                "date": item.get("date"), "seed": item.get("seed"),
                "place": item.get("place"), "entrants": item.get("entrants"),
                "characterCounts": item.get("characterCounts", {}),
            }])
            for source in item_sources:
                sc = dict(source)
                s_key = sc.get("eventKey")
                if s_key != root and is_amateur_bracket(s_key, None, amateur_cfg, links):
                    if sc.get("place") is not None and sc["place"] <= main_entrants:
                        sc["place"] = main_entrants + sc["place"]
                source_events.append(sc)

        primary_source = next((s for s in source_events if s.get("eventKey") == root), None)
        if primary_source and primary_source.get("place") is not None:
            event_result["place"] = primary_source["place"]
        else:
            places = [s["place"] for s in source_events if s.get("place") is not None]
            event_result["place"] = min(places) if places else None

        event_result["sets"] = sorted(
            [set_data for item in linked for set_data in item.get("sets", [])],
            key=lambda item: (
                item["startedAt"] is None,
                item["startedAt"] if item["startedAt"] is not None else 0,
                item["phaseOrder"] if item["phaseOrder"] is not None else 999,
                item["roundOrder"] if item["roundOrder"] is not None else 999,
            ),
        )
        character_counts = {}
        for item in linked:
            for name, count in item.get("characterCounts", {}).items():
                character_counts[name] = character_counts.get(name, 0) + count
        event_result["characterCounts"] = character_counts
        event_result["sourceEvents"] = source_events
        combined.append(event_result)
    return combined


def identity_merges():
    path = PROFILE_DIR / "merges.json"
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


def identity_ids(player_id, merges):
    canonical = canonical_id(player_id, merges)
    return sorted({source for source in merges if canonical_id(source, merges) == canonical} | {canonical})


_CURRENT_PLAYER_TAGS = {}
_OPPONENT_TAG_ALIASES = {}


def current_player_tags(connection, merges):
    cache_key = id(connection)
    if cache_key not in _CURRENT_PLAYER_TAGS:
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
        _CURRENT_PLAYER_TAGS[cache_key] = latest
    return _CURRENT_PLAYER_TAGS[cache_key]


def opponent_tag_aliases(connection, merges, latest_tags):
    cache_key = id(connection)
    if cache_key not in _OPPONENT_TAG_ALIASES:
        display_by_player = dict(latest_tags)
        try:
            with (PROFILE_DIR / "index.json").open(encoding="utf-8") as file:
                for entry in json.load(file):
                    player_id = entry.get("playerId")
                    tag = entry.get("tag")
                    if player_id and tag and str(tag).strip().casefold() != "deleted user":
                        display_by_player[canonical_id(str(player_id), merges)] = str(tag).strip()
        except (OSError, json.JSONDecodeError, AttributeError, TypeError):
            pass
        aliases_by_player = {}
        for row in connection.execute(
            "SELECT DISTINCT player_id, gamer_tag FROM participants "
            "WHERE player_id IS NOT NULL AND gamer_tag IS NOT NULL "
            "AND TRIM(gamer_tag) != '' AND LOWER(TRIM(gamer_tag)) != 'deleted user'"
        ):
            player_key = canonical_id(text_id(row["player_id"]), merges)
            alias_key = " ".join(str(row["gamer_tag"]).split()).casefold()
            if alias_key:
                aliases_by_player.setdefault(player_key, set()).add(alias_key)
        alias_to_players = {}
        for player_key, aliases in aliases_by_player.items():
            for alias in aliases:
                alias_to_players.setdefault(alias, set()).add(player_key)
        aliases = {}
        for alias, player_keys in alias_to_players.items():
            if len(player_keys) == 1:
                player_key = next(iter(player_keys))
                current_tag = display_by_player.get(player_key)
                if current_tag:
                    aliases[alias] = current_tag
        _OPPONENT_TAG_ALIASES[cache_key] = aliases
    return _OPPONENT_TAG_ALIASES[cache_key]


def current_opponent_name(value, aliases):
    parts = re.split(r"\s*[,/]\s*", str(value or ""))
    return ", ".join(
        aliases.get(" ".join(part.split()).casefold(), part.strip())
        for part in parts if part.strip()
    )


@lru_cache(maxsize=1)
def startgg_metadata():
    path = PROFILE_DIR / "startgg_metadata.json"
    if not path.is_file():
        return {}
    try:
        with path.open(encoding="utf-8") as file:
            return json.load(file)
    except (OSError, json.JSONDecodeError):
        return {}


def profile_for_player(connection, player_id, display_tag, profile_slug):
    merges = identity_merges()
    latest_player_tags = current_player_tags(connection, merges)
    opponent_aliases = opponent_tag_aliases(connection, merges, latest_player_tags)
    player_ids = identity_ids(player_id, merges)
    exclusions = visibility_exclusions()
    player_placeholders = ids_clause(player_ids)
    rows = connection.execute(
        "SELECT DISTINCT e.id AS event_id, e.name AS event_name, e.num_entrants, e.source_url, "
        "e.videogame_slug, v.name AS videogame_name, t.slug AS tournament_slug, "
        "t.name AS tournament_name, t.start_at AS tournament_start, e.is_temporary "
        "FROM participants p "
        "JOIN entrant_participants ep ON ep.participant_id=p.id "
        "JOIN entrants en ON en.id=ep.entrant_id "
        "JOIN events e ON e.id=en.event_id "
        "JOIN videogames v ON v.slug=e.videogame_slug "
        "JOIN tournaments t ON t.slug=e.tournament_slug "
        f"WHERE p.player_id IN ({player_placeholders}) ORDER BY e.videogame_slug, e.id",
        player_ids,
    ).fetchall()
    rows = [row for row in rows if not row["is_temporary"] and normalize_event_key(row["source_url"]) not in exclusions["events"]]
    if not rows:
        raise ValueError(f"No event entries found for start.gg player ID {player_id}")

    event_links = event_group_overrides()
    event_labels = {}
    event_entrants = {}
    for event_row in connection.execute(
        "SELECT e.name AS event_name, e.num_entrants, e.source_url, t.name AS tournament_name, t.slug AS tournament_slug "
        "FROM events e JOIN tournaments t ON t.slug=e.tournament_slug"
    ):
        key = normalize_event_key(event_row["source_url"])
        if key:
            label = event_row["tournament_name"] or display_tournament(event_row["tournament_slug"])
            if event_row["event_name"] and event_row["event_name"].lower() not in label.lower():
                label = f"{label} · {event_row['event_name']}"
            event_labels[key] = label
            if event_row["num_entrants"] is not None:
                event_entrants[key] = event_row["num_entrants"]

    aliases = [row[0] for row in connection.execute(
        f"SELECT DISTINCT gamer_tag FROM participants WHERE player_id IN ({player_placeholders}) AND gamer_tag IS NOT NULL "
        "ORDER BY gamer_tag", player_ids,
    )]
    profile = {
        "player": {
            "tag": display_tag,
            "photo": f"assets/players/{text_id(player_id)}.png",
            "sponsor": "",
            "city": "",
            "country": "Uruguay",
            "location": "",
            "activeSince": None,
            "startgg": "",
            "startggPlayerId": text_id(player_id),
            "aliases": aliases,
        },
        "games": [],
    }
    metadata_by_id = startgg_metadata()
    metadata = next((metadata_by_id.get(pid, {}) for pid in [text_id(player_id), *player_ids]
                    if metadata_by_id.get(pid)), {})
    profile["player"]["sponsor"] = metadata.get("sponsor") or profile["player"]["sponsor"]
    profile["player"]["city"] = metadata.get("city") or ""
    profile["player"]["country"] = metadata.get("country") or "Uruguay"
    location = [profile["player"]["city"], profile["player"]["country"]]
    profile["player"]["location"] = ", ".join(value for value in location if value)
    user_slug = metadata.get("userSlug")
    if isinstance(user_slug, str) and user_slug.strip():
        profile["player"]["startgg"] = f"https://www.start.gg/{user_slug.strip().lstrip('/')}"

    player_overrides = {}
    overrides_path = PROFILE_DIR / "overrides.json"
    if overrides_path.is_file():
        try:
            with overrides_path.open(encoding="utf-8") as file:
                overrides = json.load(file)
            player_overrides = overrides.get(text_id(player_id), {})
            for key in ("tag", "photo", "sponsor", "city", "country", "location", "startgg"):
                if isinstance(player_overrides.get(key), str):
                    profile["player"][key] = player_overrides[key]
        except (OSError, json.JSONDecodeError):
            pass

    by_game = {}
    for row in rows:
        event_id = text_id(row["event_id"])
        game_slug = row["videogame_slug"]
        own_entrants = [text_id(r[0]) for r in connection.execute(
            "SELECT DISTINCT en.id FROM entrants en "
            "JOIN entrant_participants ep ON ep.entrant_id=en.id "
            "JOIN participants p ON p.id=ep.participant_id "
            f"WHERE en.event_id=? AND p.player_id IN ({player_placeholders})",
            [event_id, *player_ids],
        )]
        if not own_entrants:
            continue
        group = by_game.setdefault(game_slug, {
            "id": game_slug,
            "slug": game_slug,
            "name": row["videogame_name"],
            "events": [],
            "entrant_ids": set(),
            "wins": 0,
            "losses": 0,
            "upsets": 0,
            "head_to_head": {},
            "character_counts": {},
        })
        event_label = row["tournament_name"] or display_tournament(row["tournament_slug"])
        if row["event_name"] and row["event_name"].lower() not in event_label.lower():
            event_label = f"{event_label} · {row['event_name']}"
        current_event_key = normalize_event_key(row["source_url"]) or f"event:{event_id}"
        phase_override = event_links.get(current_event_key, {}).get("phase")

        placeholders = ids_clause(own_entrants)
        set_rows = connection.execute(
            f"SELECT DISTINCT s.id, s.winner_entrant_id, s.display_score, s.round, "
            f"s.full_round_text, s.started_at, s.start_at, s.completed_at, "
            f"ph.id AS phase_id, ph.name AS phase_name, ph.phase_order FROM sets s "
            f"JOIN set_entrants mine ON mine.set_id=s.id "
            f"LEFT JOIN phase_groups pg ON pg.id=s.phase_group_id "
            f"LEFT JOIN phases ph ON ph.id=pg.phase_id "
            f"WHERE s.event_id=? AND mine.entrant_id IN ({placeholders})",
            [event_id, *own_entrants],
        ).fetchall()
        wins = 0
        losses = 0
        event_sets = []
        included_set_ids = []
        for set_row in set_rows:
            winner_id = text_id(set_row["winner_entrant_id"])
            own_won = winner_id in own_entrants
            opponents = connection.execute(
                f"SELECT DISTINCT other.entrant_id, en.name, p.player_id, p.gamer_tag, "
                f"other.score_display, other.score_label, other.score "
                f"FROM set_entrants other JOIN entrants en ON en.id=other.entrant_id "
                f"LEFT JOIN entrant_participants ep ON ep.entrant_id=en.id "
                f"LEFT JOIN participants p ON p.id=ep.participant_id "
                f"WHERE other.set_id=? AND other.entrant_id NOT IN ({placeholders})",
                [text_id(set_row["id"]), *own_entrants],
            ).fetchall()
            opponent_names = {}
            opponent_scores = {}
            for opponent in opponents:
                key = text_id(opponent["entrant_id"])
                player_key = canonical_id(text_id(opponent["player_id"]), merges) if opponent["player_id"] is not None else None
                current_tag = latest_player_tags.get(player_key) if player_key else None
                opponent_names.setdefault(key, current_tag or opponent["gamer_tag"] or opponent["name"] or "Unknown")
                opponent_scores[key] = slot_score(opponent)
            own_score_rows = connection.execute(
                f"SELECT entrant_id, score_display, score_label, score FROM set_entrants "
                f"WHERE set_id=? AND entrant_id IN ({placeholders})",
                [text_id(set_row["id"]), *own_entrants],
            ).fetchall()
            preferred_own_score = next(
                (slot_score(item) for item in own_score_rows
                 if text_id(item["entrant_id"]) == winner_id), None
            ) or (slot_score(own_score_rows[0]) if own_score_rows else None)
            opponent_ids = list(opponent_names)
            own_seed = None
            opponent_seed = None
            phase_display_name = phase_override or set_row["phase_name"] or "Phase not recorded"
            set_is_amateur = is_amateur_bracket(current_event_key, set_row["phase_name"]) or is_amateur_bracket(current_event_key, phase_display_name)
            if set_row["phase_id"] is not None and not set_is_amateur:
                own_seed_rows = connection.execute(
                    f"SELECT seed_num FROM phase_seeds WHERE phase_id=? AND entrant_id IN ({placeholders}) AND seed_num IS NOT NULL",
                    [set_row["phase_id"], *own_entrants],
                ).fetchall()
                opponent_seed_rows = connection.execute(
                    f"SELECT seed_num FROM phase_seeds WHERE phase_id=? AND entrant_id IN ({ids_clause(opponent_ids)}) AND seed_num IS NOT NULL",
                    [set_row["phase_id"], *opponent_ids],
                ).fetchall() if opponent_ids else []
                own_seed = min((item["seed_num"] for item in own_seed_rows), default=None)
                opponent_seed = min((item["seed_num"] for item in opponent_seed_rows), default=None)
            is_upset = bool(own_won and own_seed is not None and opponent_seed is not None and own_seed > opponent_seed)
            opponent_tag_rows = connection.execute(
                f"SELECT DISTINCT ep.entrant_id, p.player_id, p.gamer_tag FROM entrant_participants ep "
                f"JOIN participants p ON p.id=ep.participant_id "
                f"WHERE ep.entrant_id IN ({ids_clause(opponent_ids)}) AND p.gamer_tag IS NOT NULL",
                opponent_ids,
            ).fetchall() if opponent_ids else []
            names_by_entrant = {}
            for tag_row in opponent_tag_rows:
                player_key = canonical_id(text_id(tag_row["player_id"]), merges) if tag_row["player_id"] is not None else None
                current_tag = latest_player_tags.get(player_key) if player_key else None
                names_by_entrant.setdefault(text_id(tag_row["entrant_id"]), []).append(current_tag or tag_row["gamer_tag"])
            opponent_display = ", ".join(dict.fromkeys(
                tag for entrant_id in opponent_ids
                for tag in (names_by_entrant.get(entrant_id) or [opponent_names[entrant_id]])
            )) or "Unknown"
            opponent_score = next((opponent_scores[key] for key in opponent_ids if opponent_scores.get(key)), None)
            outcome = "win" if own_won else ("loss" if winner_id is not None else "unknown")
            score = f"{preferred_own_score}–{opponent_score}" if preferred_own_score is not None and opponent_score is not None else (set_row["display_score"] or "")
            if is_placeholder_set_score(set_row["display_score"], preferred_own_score, opponent_score, score):
                continue
            if is_upset:
                group["upsets"] += 1
            if winner_id is not None:
                if own_won:
                    wins += 1
                else:
                    losses += 1
            for opponent_name in set(opponent_names.values()):
                h2h = group["head_to_head"].setdefault(opponent_name, {"opponent": opponent_name, "sets": 0, "wins": 0})
                h2h["sets"] += 1
                if own_won:
                    h2h["wins"] += 1
            included_set_ids.append(text_id(set_row["id"]))
            event_sets.append({
                "eventKey": current_event_key,
                "event": event_label,
                "phase": phase_override or set_row["phase_name"] or "Phase not recorded",
                "round": set_row["full_round_text"] or (f"Round {set_row['round']}" if set_row["round"] is not None else ""),
                "opponent": opponent_display,
                "score": score,
                "outcome": outcome,
                "ownSeed": own_seed,
                "opponentSeed": opponent_seed,
                "isUpset": is_upset,
                "startedAt": set_row["started_at"] or set_row["start_at"] or set_row["completed_at"],
                "phaseOrder": set_row["phase_order"],
                "roundOrder": set_row["round"],
            })
        if not event_sets:
            continue
        group["entrant_ids"].update(own_entrants)
        group["wins"] += wins
        group["losses"] += losses

        standing_rows = connection.execute(
            f"SELECT es.placement FROM event_standings es "
            f"WHERE es.event_id=? AND es.entrant_id IN ({placeholders}) AND es.placement IS NOT NULL",
            [event_id, *own_entrants],
        ).fetchall()
        placements = [r[0] for r in standing_rows]
        place = min(placements) if placements else None

        all_sets_amateur = event_sets and all(
            is_amateur_bracket(current_event_key, s.get("phase")) for s in event_sets
        )
        is_event_amateur = is_amateur_bracket(current_event_key, None)
        is_linked_child = current_event_key in event_links

        if (all_sets_amateur or is_event_amateur) and not is_linked_child and place is not None:
            main_phase_rows = connection.execute(
                "SELECT id, name FROM phases WHERE event_id=?", (event_id,)
            ).fetchall()
            non_amateur_phase_ids = [
                p["id"] for p in main_phase_rows
                if not is_amateur_bracket(current_event_key, p["name"])
            ]
            if non_amateur_phase_ids:
                count_main_sets = connection.execute(
                    f"SELECT COUNT(DISTINCT se.entrant_id) FROM sets s "
                    f"JOIN set_entrants se ON se.set_id=s.id "
                    f"JOIN phase_groups pg ON pg.id=s.phase_group_id "
                    f"WHERE s.event_id=? AND pg.phase_id IN ({ids_clause(non_amateur_phase_ids)})",
                    [event_id, *non_amateur_phase_ids],
                ).fetchone()[0]
                n_main = max(row["num_entrants"] or 0, count_main_sets)
            else:
                n_main = row["num_entrants"] or 0

            if place <= n_main:
                place = n_main + place

        timing = connection.execute(
            f"SELECT MIN(s.started_at), MIN(s.start_at), MIN(s.completed_at) "
            f"FROM sets s JOIN set_entrants se ON se.set_id=s.id "
            f"WHERE s.event_id=? AND se.entrant_id IN ({placeholders})",
            [event_id, *own_entrants],
        ).fetchone()
        timestamp = row["tournament_start"] or timing[0] or timing[1] or timing[2]
        result_date = date_from_epoch(timestamp)
        entrants_count = row["num_entrants"]
        if entrants_count is None:
            entrants_count = connection.execute(
                "SELECT COUNT(*) FROM entrants WHERE event_id=?", (event_id,),
            ).fetchone()[0]
        seed_row = connection.execute(
            "SELECT ps.seed_num FROM phase_seeds ps "
            "JOIN phases ph ON ph.id=ps.phase_id "
            "JOIN entrants en ON en.id=ps.entrant_id "
            "WHERE en.event_id=? AND ps.entrant_id IN (" + placeholders + ") "
            "ORDER BY (SELECT COUNT(*) FROM phase_seeds peers WHERE peers.phase_id=ps.phase_id) DESC, "
            "COALESCE(ph.is_exhibition, 0), COALESCE(ph.phase_order, 999), ps.seed_num LIMIT 1",
            [event_id, *own_entrants],
        ).fetchone()
        seed = seed_row["seed_num"] if seed_row else None
        group["events"].append({
            "event": event_label,
            "eventKey": current_event_key,
            "date": result_date,
            "seed": seed,
            "place": place,
            "entrants": entrants_count,
            "sets": sorted(event_sets, key=lambda item: (
                item["startedAt"] is None,
                item["startedAt"] if item["startedAt"] is not None else 0,
                item["phaseOrder"] if item["phaseOrder"] is not None else 999,
                item["roundOrder"] if item["roundOrder"] is not None else 999,
            )),
            "characterCounts": {},
            "sourceEvents": [{
                "eventKey": current_event_key,
                "event": event_label,
                "date": result_date,
                "seed": seed,
                "place": place,
                "entrants": entrants_count,
                "characterCounts": {},
            }],
        })

        selections = connection.execute(
            f"SELECT c.name, COUNT(*) AS uses FROM set_game_selections sel "
            f"JOIN set_games g ON g.id=sel.set_game_id "
            f"JOIN sets s ON s.id=g.set_id "
            f"JOIN entrants e ON e.id=sel.entrant_id "
            f"LEFT JOIN characters c ON c.videogame_slug=sel.videogame_slug AND c.id=sel.character_id "
            f"WHERE s.event_id=? AND sel.entrant_id IN ({placeholders}) AND c.name IS NOT NULL "
            f"AND s.id IN ({ids_clause(included_set_ids)}) "
            f"GROUP BY c.name",
            [event_id, *own_entrants, *included_set_ids],
        ).fetchall()
        for selection in selections:
            group["character_counts"][selection["name"]] = group["character_counts"].get(selection["name"], 0) + selection["uses"]
            group["events"][-1]["characterCounts"][selection["name"]] = selection["uses"]
            group["events"][-1]["sourceEvents"][0]["characterCounts"][selection["name"]] = selection["uses"]

    amateur_cfg = amateur_brackets_config()
    all_dates = []
    for group in by_game.values():
        group["events"] = combine_linked_events(group["events"], event_links, event_labels, amateur_cfg, event_entrants)
        results = group["events"]
        if not results:
            continue
        dated = [r["date"] for r in results if r["date"]]
        all_dates.extend(dated)
        places = [r["place"] for r in results if r["place"] is not None]
        best_result = min((r for r in results if r["place"] is not None), key=lambda r: r["place"], default=None)
        best_place = min(places) if places else None
        best_place_count = sum(1 for result in results if result["place"] == best_place) if best_place is not None else 0
        total_character_uses = sum(group["character_counts"].values())
        ranked_characters = sorted(
            group["character_counts"].items(), key=lambda item: item[1], reverse=True
        )
        if len(ranked_characters) > 3:
            visible_characters = ranked_characters[:3]
            visible_characters.append(("Other", sum(count for _, count in ranked_characters[3:])))
        else:
            visible_characters = ranked_characters
        characters = [
            {"name": name, "usage": round(100 * count / total_character_uses, 1)}
            for name, count in visible_characters
        ] if total_character_uses else []
        profile["games"].append({
            "id": group["id"],
            "slug": group["slug"],
            "name": group["name"],
            "headToHead": sorted(group["head_to_head"].values(), key=lambda item: item["sets"], reverse=True),
            "events": len(results),
            "wins": group["wins"],
            "losses": group["losses"],
            "upsets": group["upsets"],
            "bestPlace": best_place,
            "bestEvent": f"{best_place_count} times" if best_place_count > 1 else best_result["event"] if best_result else "No placement recorded",
            "avgPlace": round(sum(places) / len(places), 1) if places else None,
            "avgSeed": round(sum(r["seed"] for r in results if r["seed"] is not None) / len([r for r in results if r["seed"] is not None])) if any(r["seed"] is not None for r in results) else None,
            "characters": characters,
            "notableWins": [],
            "results": sorted(results, key=lambda item: item["date"] or "", reverse=True),
        })
    profile["games"].sort(key=lambda game: game["name"].lower())
    profile["player"]["activeSince"] = min(all_dates) if all_dates else None
    saved_profile = player_overrides.get("profile") if isinstance(player_overrides, dict) else None
    if isinstance(saved_profile, dict):
        saved_player = saved_profile.get("player")
        if isinstance(saved_player, dict):
            profile["player"].update(saved_player)
            profile["player"]["startggPlayerId"] = text_id(player_id)
        saved_games = saved_profile.get("games")
        if isinstance(saved_games, list):
            profile["games"] = saved_games
        for key, value in saved_profile.items():
            if key not in {"player", "games"}:
                profile[key] = value
    player_excluded_games = set(exclusions["playerGames"].get(text_id(player_id), []))
    for game in profile["games"]:
        for result in game.get("results", []):
            for set_item in result.get("sets", []):
                set_item["opponent"] = current_opponent_name(set_item.get("opponent"), opponent_aliases)
        updated_head_to_head = {}
        for item in game.get("headToHead", []):
            opponent = current_opponent_name(item.get("opponent"), opponent_aliases)
            entry = updated_head_to_head.setdefault(opponent, {"opponent": opponent, "sets": 0, "wins": 0})
            entry["sets"] += int(item.get("sets") or 0)
            entry["wins"] += int(item.get("wins") or 0)
        if updated_head_to_head:
            game["headToHead"] = sorted(updated_head_to_head.values(), key=lambda item: item["sets"], reverse=True)
        results = game.get("results") or []
        remaining_results = []
        visibility_changed = False
        for result in results:
            source_events = result.get("sourceEvents")
            if isinstance(source_events, list) and source_events:
                kept_sources = [item for item in source_events
                                if item.get("eventKey") not in exclusions["events"]]
                if len(kept_sources) != len(source_events):
                    visibility_changed = True
                if not kept_sources:
                    continue
                result["sourceEvents"] = kept_sources
                primary_source = next((item for item in kept_sources
                                       if item.get("eventKey") == result.get("eventKey")), kept_sources[0])
                result["eventKey"] = primary_source.get("eventKey")
                result["event"] = primary_source.get("event") or result.get("event")
                for field in ("date", "seed", "place", "entrants"):
                    result[field] = primary_source.get(field)
                result["sets"] = [item for item in result.get("sets", [])
                                  if item.get("eventKey") not in exclusions["events"]]
                result["characterCounts"] = {}
                for source in kept_sources:
                    for name, count in source.get("characterCounts", {}).items():
                        result["characterCounts"][name] = result["characterCounts"].get(name, 0) + count
            else:
                if result.get("eventKey") in exclusions["events"]:
                    visibility_changed = True
                    continue
                original_sets = result.get("sets", [])
                result["sets"] = [item for item in original_sets
                                  if item.get("eventKey") not in exclusions["events"]]
                if len(original_sets) != len(result["sets"]):
                    visibility_changed = True
            if isinstance(result.get("sets"), list):
                original_sets = result["sets"]
                result["sets"] = [item for item in original_sets
                                  if not is_placeholder_set_score(
                                      item.get("score"), item.get("displayScore"), item.get("display_score"))]
                if len(original_sets) != len(result["sets"]):
                    visibility_changed = True
                if not result["sets"]:
                    visibility_changed = True
                    continue
            remaining_results.append(result)
        if len(remaining_results) != len(results):
            visibility_changed = True
        if visibility_changed:
            game["results"] = remaining_results
            game["events"] = len(remaining_results)
            if all("sets" in result for result in remaining_results):
                outcomes = [item.get("outcome") for result in remaining_results for item in result.get("sets", [])]
                game["wins"] = outcomes.count("win")
                game["losses"] = outcomes.count("loss")
                game["upsets"] = sum(1 for result in remaining_results
                                      for item in result.get("sets", []) if item.get("isUpset"))
                matchup = {}
                for result in remaining_results:
                    for item in result.get("sets", []):
                        opponent = item.get("opponent") or "Unknown"
                        h2h = matchup.setdefault(opponent, {"opponent": opponent, "sets": 0, "wins": 0})
                        h2h["sets"] += 1
                        if item.get("outcome") == "win":
                            h2h["wins"] += 1
                game["headToHead"] = sorted(matchup.values(), key=lambda item: item["sets"], reverse=True)
            places = [result["place"] for result in remaining_results if result.get("place") is not None]
            seeds = [result["seed"] for result in remaining_results if result.get("seed") is not None]
            best = min((result for result in remaining_results if result.get("place") is not None),
                       key=lambda result: result["place"], default=None)
            game["bestPlace"] = min(places) if places else None
            best_count = sum(1 for result in remaining_results if result.get("place") == game["bestPlace"]) if best else 0
            game["bestEvent"] = f"{best_count} times" if best_count > 1 else best["event"] if best else "No placement recorded"
            game["avgPlace"] = round(sum(places) / len(places), 1) if places else None
            game["avgSeed"] = round(sum(seeds) / len(seeds)) if seeds else None
            character_counts = {}
            for result in remaining_results:
                for name, count in result.get("characterCounts", {}).items():
                    character_counts[name] = character_counts.get(name, 0) + count
            total_uses = sum(character_counts.values())
            ranked_characters = sorted(character_counts.items(), key=lambda item: item[1], reverse=True)
            if len(ranked_characters) > 3:
                visible_characters = ranked_characters[:3] + [("Other", sum(count for _, count in ranked_characters[3:]))]
            else:
                visible_characters = ranked_characters
            game["characters"] = [
                {"name": name, "usage": round(100 * count / total_uses, 1)}
                for name, count in visible_characters
            ] if total_uses else []
        notable_wins = []
        for result in remaining_results:
            res_event_key = result.get("eventKey")
            for item in result.get("sets", []):
                own_seed = item.get("ownSeed")
                opponent_seed = item.get("opponentSeed")
                phase_name = str(item.get("phase") or "")
                set_event_key = item.get("eventKey") or res_event_key
                if (is_amateur_bracket(set_event_key, phase_name)
                        or "pools" in phase_name.casefold()
                        or item.get("outcome") != "win"
                        or opponent_seed is None
                        or int(opponent_seed) < 1):
                    continue
                upset_factor = (float(own_seed) / int(opponent_seed)
                                if own_seed is not None and int(own_seed) > 0 else None)
                beat_top_seed = int(opponent_seed) == 1
                qualifies = beat_top_seed or (upset_factor is not None and upset_factor >= 2)
                if not qualifies:
                    continue
                notable_wins.append({
                    "opponent": item.get("opponent") or "Unknown",
                    "seed": opponent_seed,
                    "ownSeed": own_seed,
                    "upsetFactor": upset_factor,
                    "priority": 0 if beat_top_seed else 1,
                    "score": item.get("score") or "",
                    "phase": item.get("phase") or "",
                    "round": item.get("round") or "",
                    "event": result.get("event") or item.get("event") or "",
                    "date": result.get("date") or "",
                    "phaseOrder": item.get("phaseOrder"),
                    "roundOrder": item.get("roundOrder"),
                })
        from collections import defaultdict
        wins_by_opponent = defaultdict(list)
        for item in notable_wins:
            opponent_key = " ".join(str(item["opponent"]).split()).casefold()
            wins_by_opponent[opponent_key].append(item)

        aggregated_notable_wins = []
        for opponent_key, wins in wins_by_opponent.items():
            sorted_wins = sorted(wins, key=lambda w: w["date"] or "", reverse=True)
            latest_win = dict(sorted_wins[0])
            latest_win["count"] = len(wins)
            latest_win["priority"] = min(w["priority"] for w in wins)
            aggregated_notable_wins.append(latest_win)

        aggregated_notable_wins.sort(key=lambda item: item["date"] or "", reverse=True)
        aggregated_notable_wins.sort(key=lambda item: item["priority"])

        game["notableWins"] = [{key: value for key, value in item.items()
                                 if key not in {"phaseOrder", "roundOrder", "priority"}}
                                for item in aggregated_notable_wins[:4]]
    profile["games"] = [game for game in profile["games"]
                        if game.get("id") not in player_excluded_games
                        and game.get("slug") not in player_excluded_games]
    visible_dates = [result["date"] for game in profile["games"]
                     for result in game.get("results", []) if result.get("date")]
    profile["player"]["activeSince"] = min(visible_dates) if visible_dates else None
    return profile


def safe_slug(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def write_profile(connection, player_id, display_tag, profile_slug):
    profile = profile_for_player(connection, player_id, display_tag, profile_slug)
    output = PROFILE_DIR / f"{profile_slug}.json"
    with output.open("w", encoding="utf-8") as file:
        json.dump(profile, file, indent=2, ensure_ascii=False)
        file.write("\n")
    print(f"Wrote {output.name}: {display_tag} (ID {player_id}), "
          f"{len(profile['games'])} games, "
          f"{sum(game['events'] for game in profile['games'])} event entries")
    if not profile["games"]:
        return None
    return {"playerId": str(player_id), "tag": profile["player"]["tag"], "slug": profile_slug}


def character_stock_icon(game_slug, character_name):
    if not character_name or not game_slug:
        return None
    c_slug = safe_slug(character_name)
    stocks_dir = PROJECT_ROOT / "assets" / "renders" / game_slug / "stocks"
    if not stocks_dir.is_dir():
        return None
    for ext in (".webp", ".png"):
        if (stocks_dir / f"{c_slug}{ext}").is_file():
            return f"assets/renders/{game_slug}/stocks/{c_slug}{ext}"
    aliases = {
        "simon-belmont": "simon",
        "shovel-knight": "shovelknight",
        "sheik-zelda": "sheik",
        "rob": "r-o-b",
    }
    if c_slug in aliases:
        alt_slug = aliases[c_slug]
        for ext in (".webp", ".png"):
            if (stocks_dir / f"{alt_slug}{ext}").is_file():
                return f"assets/renders/{game_slug}/stocks/{alt_slug}{ext}"
    for ext in (".webp", ".png"):
        if (stocks_dir / f"other{ext}").is_file():
            return f"assets/renders/{game_slug}/stocks/other{ext}"
    return None


def get_most_played_character(connection, event_id, entrant_id):
    row = connection.execute(
        "SELECT c.name, COUNT(*) AS count "
        "FROM set_game_selections sel "
        "JOIN set_games g ON g.id = sel.set_game_id "
        "JOIN sets st ON st.id = g.set_id "
        "JOIN characters c ON c.videogame_slug = sel.videogame_slug AND c.id = sel.character_id "
        "WHERE st.event_id = ? AND sel.entrant_id = ? "
        "GROUP BY c.id ORDER BY count DESC LIMIT 1",
        (event_id, entrant_id),
    ).fetchone()
    if row and row["name"]:
        return row["name"]
    return None


def get_phase_standings(connection, phase_id, event_id, game_slug, merges, latest_tags):
    sets = connection.execute(
        "SELECT s.id, s.full_round_text, s.round, s.winner_entrant_id "
        "FROM sets s JOIN phase_groups pg ON pg.id = s.phase_group_id "
        "WHERE pg.phase_id = ?",
        (phase_id,),
    ).fetchall()

    placements_map = {}
    for st in sets:
        w = text_id(st["winner_entrant_id"]) if st["winner_entrant_id"] is not None else None
        entrants = connection.execute(
            "SELECT entrant_id FROM set_entrants WHERE set_id = ?", (st["id"],)
        ).fetchall()
        e_ids = [text_id(e[0]) for e in entrants if e[0] is not None]
        loser = next((e for e in e_ids if e != w), None)
        if not w or not loser:
            continue
        round_text = (st["full_round_text"] or "").casefold()
        if "grand final" in round_text:
            placements_map[w] = 1
            placements_map[loser] = 2
        elif "losers final" in round_text or "loser's final" in round_text:
            placements_map[loser] = 3
        elif "losers semi" in round_text or "loser's semi" in round_text:
            placements_map[loser] = 4
        elif "losers quarter" in round_text or "loser's quarter" in round_text:
            placements_map[loser] = 5
        elif "losers round 3" in round_text or "loser's round 3" in round_text:
            placements_map[loser] = 7

    standings = []
    for entrant_id, place in sorted(placements_map.items(), key=lambda x: x[1]):
        if place > 8:
            continue
        row = connection.execute(
            "SELECT en.name, p.player_id, p.gamer_tag "
            "FROM entrants en "
            "LEFT JOIN entrant_participants ep ON ep.entrant_id = en.id "
            "LEFT JOIN participants p ON p.id = ep.participant_id "
            "WHERE en.id = ?",
            (entrant_id,),
        ).fetchone()
        if not row:
            continue
        p_key = canonical_id(text_id(row["player_id"]), merges) if row["player_id"] is not None else None
        tag = latest_tags.get(p_key) or row["gamer_tag"] or row["name"] or "Unknown"
        char_name = get_most_played_character(connection, event_id, entrant_id)
        stock_icon = character_stock_icon(game_slug, char_name) if char_name else None
        standings.append({
            "placement": place,
            "tag": tag,
            "playerId": p_key,
            "character": {
                "name": char_name,
                "stockIcon": stock_icon,
            } if char_name else None,
        })
    return standings


def write_event_details(connection):
    """Write individual tournament JSON files under data/events/<tournamentSlug>.json."""
    events_dir = PROJECT_ROOT / "data" / "events"
    events_dir.mkdir(parents=True, exist_ok=True)

    excluded_events = visibility_exclusions()["events"]
    merges = identity_merges()
    latest_tags = current_player_tags(connection, merges)
    amateur_cfg = amateur_brackets_config()
    event_links = event_group_overrides()

    tournament_images = {}
    if RAW_EVENT_DIR.is_dir():
        for raw_path in RAW_EVENT_DIR.rglob("event.json"):
            try:
                with raw_path.open(encoding="utf-8-sig") as file:
                    response = json.load(file).get("response", {}).get("data", {}).get("event") or {}
                tournament = response.get("tournament") or {}
                slug = (tournament.get("slug") or "").rsplit("/", 1)[-1]
                images = tournament.get("images") or []
                image_url = next((image.get("url") for image in images if image.get("url")), None)
                if slug and image_url:
                    tournament_images[slug] = image_url
            except (OSError, json.JSONDecodeError, AttributeError, TypeError):
                continue

    tournaments = connection.execute(
        "SELECT slug, startgg_id, name, start_at FROM tournaments"
    ).fetchall()

    written_count = 0
    for t in tournaments:
        t_slug = t["slug"]
        e_rows = connection.execute(
            "SELECT e.id, e.videogame_slug, v.name AS game_name, e.name AS event_name, "
            "e.num_entrants, e.source_url, e.is_temporary, "
            "COALESCE(t.start_at, (SELECT MIN(COALESCE(s.started_at, s.start_at, s.completed_at)) "
            "FROM sets s WHERE s.event_id=e.id)) AS event_timestamp "
            "FROM events e JOIN videogames v ON v.slug=e.videogame_slug "
            "JOIN tournaments t ON t.slug=e.tournament_slug "
            "WHERE e.tournament_slug=?", (t_slug,)
        ).fetchall()

        valid_events = []
        for er in e_rows:
            key = normalize_event_key(er["source_url"])
            if key in excluded_events:
                continue
            is_temp = bool(er["is_temporary"])
            date_str = date_from_epoch(er["event_timestamp"])
            today_iso = datetime.now(timezone.utc).date().isoformat()
            if is_temp and date_str and date_str < today_iso:
                continue
            valid_events.append(er)

        if not valid_events:
            continue

        t_name = t["name"] or display_tournament(t_slug)
        image_url = tournament_images.get(t_slug) or ""
        startgg_url = f"https://www.start.gg/tournament/{t_slug}"

        dates = [date_from_epoch(er["event_timestamp"]) for er in valid_events if er["event_timestamp"]]
        t_date = min(dates) if dates else None

        games_map = {}
        for er in valid_events:
            games_map[er["videogame_slug"]] = er["game_name"]
        games_list = [{"slug": slug, "name": name} for slug, name in sorted(games_map.items(), key=lambda x: x[1])]

        sub_events = []
        for er in valid_events:
            event_id = text_id(er["id"])
            game_slug = er["videogame_slug"]
            game_name = er["game_name"]
            key = normalize_event_key(er["source_url"])
            entrant_count = er["num_entrants"]
            if entrant_count is None:
                entrant_count = connection.execute(
                    "SELECT COUNT(*) FROM entrants WHERE event_id=?", (event_id,)
                ).fetchone()[0]

            is_event_amateur = is_amateur_bracket(key, None, amateur_cfg, event_links) or (key in event_links and event_links[key].get("is_amateur"))
            phases = connection.execute(
                "SELECT id, name FROM phases WHERE event_id=?", (event_id,)
            ).fetchall()
            amateur_phases = [] if is_event_amateur else [p for p in phases if is_amateur_bracket(key, p["name"], amateur_cfg, event_links)]

            main_standings_rows = connection.execute(
                "SELECT es.placement, en.id AS entrant_id, en.name AS entrant_name, p.player_id, p.gamer_tag "
                "FROM event_standings es "
                "JOIN entrants en ON en.id=es.entrant_id "
                "LEFT JOIN entrant_participants ep ON ep.entrant_id=en.id "
                "LEFT JOIN participants p ON p.id=ep.participant_id "
                "WHERE es.event_id=? AND es.placement <= 8 "
                "ORDER BY es.placement ASC", (event_id,)
            ).fetchall()

            main_standings = []
            for sr in main_standings_rows:
                p_key = canonical_id(text_id(sr["player_id"]), merges) if sr["player_id"] is not None else None
                tag = latest_tags.get(p_key) or sr["gamer_tag"] or sr["entrant_name"] or "Unknown"
                char_name = get_most_played_character(connection, event_id, text_id(sr["entrant_id"]))
                stock_icon = character_stock_icon(game_slug, char_name) if char_name else None
                main_standings.append({
                    "placement": sr["placement"],
                    "tag": tag,
                    "playerId": p_key,
                    "character": {
                        "name": char_name,
                        "stockIcon": stock_icon,
                    } if char_name else None,
                })

            if amateur_phases:
                sub_events.append({
                    "id": f"{event_id}-main",
                    "title": "Main event" if len(games_map) == 1 else f"Main event ({game_name})",
                    "game": game_name,
                    "gameSlug": game_slug,
                    "entrants": entrant_count,
                    "isAmateur": False,
                    "hasAmateur": True,
                    "standings": main_standings,
                })
                for aph in amateur_phases:
                    amateur_standings = get_phase_standings(connection, aph["id"], event_id, game_slug, merges, latest_tags)
                    # Entrants count in amateur phase can be retrieved from phase sets count
                    phase_entrants = connection.execute(
                        "SELECT COUNT(DISTINCT se.entrant_id) "
                        "FROM set_entrants se JOIN sets s ON s.id=se.set_id "
                        "JOIN phase_groups pg ON pg.id=s.phase_group_id "
                        "WHERE pg.phase_id=?", (aph["id"],)
                    ).fetchone()[0]
                    sub_events.append({
                        "id": f"{event_id}-phase-{aph['id']}",
                        "title": "Categoria B",
                        "game": game_name,
                        "gameSlug": game_slug,
                        "entrants": phase_entrants or len(amateur_standings),
                        "isAmateur": True,
                        "hasAmateur": True,
                        "standings": amateur_standings,
                    })
            else:
                is_amateur = is_event_amateur or (key in event_links and event_links[key].get("is_amateur"))
                sub_events.append({
                    "id": event_id,
                    "title": "Categoria B" if is_amateur else game_name,
                    "game": game_name,
                    "gameSlug": game_slug,
                    "entrants": entrant_count,
                    "isAmateur": bool(is_amateur),
                    "hasAmateur": False,
                    "standings": main_standings,
                })

        # If any sub-event in this tournament has an amateur bracket, update titles of main events that didn't have phase-level amateur brackets if needed
        has_any_amateur = any(se["isAmateur"] for se in sub_events)
        if has_any_amateur:
            for se in sub_events:
                if not se["isAmateur"] and se["title"] == se["game"]:
                    se["title"] = "Main event" if len(games_map) == 1 else f"Main event ({se['game']})"

        # Total attendees is distinct participants in the entire tournament
        tot_row = connection.execute(
            "SELECT COUNT(DISTINCT ep.participant_id) "
            "FROM events e JOIN entrants en ON en.event_id=e.id "
            "JOIN entrant_participants ep ON ep.entrant_id=en.id "
            "WHERE e.tournament_slug=?", (t_slug,)
        ).fetchone()
        total_entrants = tot_row[0] if tot_row and tot_row[0] else sum(se["entrants"] for se in sub_events if not se["isAmateur"])

        t_data = {
            "tournamentSlug": t_slug,
            "tournament": t_name,
            "image": image_url,
            "startggUrl": startgg_url,
            "date": t_date,
            "totalEntrants": total_entrants,
            "games": games_list,
            "subEvents": sub_events,
        }

        out_path = events_dir / f"{t_slug}.json"
        with out_path.open("w", encoding="utf-8") as file:
            json.dump(t_data, file, indent=2, ensure_ascii=False)
            file.write("\n")
        written_count += 1

    print(f"Wrote {written_count} tournament event detail files to {events_dir.relative_to(PROJECT_ROOT)}")


def write_event_index(connection):
    """Write the public event directory from the imported tournament database."""
    excluded_events = visibility_exclusions()["events"]
    tournament_images = {}
    if RAW_EVENT_DIR.is_dir():
        for raw_path in RAW_EVENT_DIR.rglob("event.json"):
            try:
                with raw_path.open(encoding="utf-8-sig") as file:
                    response = json.load(file).get("response", {}).get("data", {}).get("event") or {}
                tournament = response.get("tournament") or {}
                slug = (tournament.get("slug") or "").rsplit("/", 1)[-1]
                images = tournament.get("images") or []
                image_url = next((image.get("url") for image in images if image.get("url")), None)
                if slug and image_url:
                    tournament_images[slug] = image_url
            except (OSError, json.JSONDecodeError, AttributeError, TypeError):
                continue
    rows = connection.execute(
        "SELECT e.id, e.videogame_slug, v.name AS game_name, e.name AS event_name, "
        "e.num_entrants, e.source_url, e.is_temporary, t.slug AS tournament_slug, t.name AS tournament_name, "
        "COALESCE(t.start_at, (SELECT MIN(COALESCE(s.started_at, s.start_at, s.completed_at)) "
        "FROM sets s WHERE s.event_id=e.id)) AS event_timestamp "
        "FROM events e JOIN videogames v ON v.slug=e.videogame_slug "
        "JOIN tournaments t ON t.slug=e.tournament_slug"
    ).fetchall()
    now_timestamp = int(datetime.now(timezone.utc).timestamp())
    today_iso = datetime.now(timezone.utc).date().isoformat()
    event_index = []
    for row in rows:
        if normalize_event_key(row["source_url"]) in excluded_events:
            continue
        entrant_count = connection.execute(
            "SELECT COUNT(*) FROM entrants WHERE event_id=?", (row["id"],)
        ).fetchone()[0]
        event_timestamp = row["event_timestamp"]
        date_str = date_from_epoch(event_timestamp)
        is_temp = bool(row["is_temporary"])

        if date_str:
            if date_str < today_iso:
                has_taken_place = True
            elif date_str > today_iso:
                has_taken_place = False
            else:
                has_taken_place = (event_timestamp is not None and event_timestamp <= now_timestamp)
        else:
            has_taken_place = True

        if is_temp and has_taken_place:
            continue

        event_index.append({
            "id": str(row["id"]),
            "tournamentSlug": row["tournament_slug"],
            "image": tournament_images.get(row["tournament_slug"]),
            "gameSlug": row["videogame_slug"],
            "game": row["game_name"],
            "tournament": row["tournament_name"] or display_tournament(row["tournament_slug"]),
            "event": row["event_name"],
            "date": date_str,
            "entrants": row["num_entrants"] if row["num_entrants"] is not None else entrant_count,
            "url": row["source_url"],
            "isTemporary": is_temp,
            "hasTakenPlace": has_taken_place,
        })
    event_index.sort(key=lambda event: (event["tournament"].casefold(), event["event"].casefold()))
    event_index.sort(key=lambda event: event["date"] or "", reverse=True)
    output = PROJECT_ROOT / "data" / "events-index.json"
    with output.open("w", encoding="utf-8") as file:
        json.dump(event_index, file, indent=2, ensure_ascii=False)
        file.write("\n")
    print(f"Wrote {output.relative_to(PROJECT_ROOT)}: {len(event_index)} events")
    write_event_details(connection)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("player_id", nargs="?", help="start.gg player ID (from the players table)")
    parser.add_argument("--tag", help="display tag for a single profile")
    parser.add_argument("--slug", help="output/profile slug; defaults to a slug from --tag")
    parser.add_argument("--all", action="store_true", help="build a profile for every player in the database")
    parser.add_argument("--game", help="limit --all to players entered in this videogame slug")
    parser.add_argument("--events-only", action="store_true", help="build the event directory without rebuilding player profiles")
    args = parser.parse_args()
    if not DATABASE.is_file():
        raise SystemExit(f"Database not found: {DATABASE}; run scripts/import_startgg_data.py first")
    if args.events_only and (args.all or args.player_id or args.tag or args.game):
        parser.error("--events-only cannot be combined with player or --all options")
    if not args.all and not args.events_only and (not args.player_id or not args.tag):
        parser.error("provide PLAYER_ID and --tag, or use --all")
    if args.all and args.player_id:
        parser.error("PLAYER_ID cannot be combined with --all")
    if args.game and not args.all:
        parser.error("--game can only be used with --all")

    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DATABASE) as connection:
        connection.row_factory = sqlite3.Row
        if args.events_only:
            write_event_index(connection)
        elif args.all:
            query = (
                "SELECT p.id, COALESCE(part.gamer_tag, 'Player ' || p.id) AS tag "
                "FROM players p JOIN participants part ON part.player_id=p.id "
                "JOIN entrant_participants ep ON ep.participant_id=part.id "
                "JOIN entrants en ON en.id=ep.entrant_id JOIN events e ON e.id=en.event_id "
            )
            params = []
            if args.game:
                query += "WHERE e.videogame_slug=? "
                params.append(args.game)
            query += "GROUP BY p.id, part.gamer_tag ORDER BY p.id, COUNT(*) DESC, part.gamer_tag"
            candidates = connection.execute(query, params).fetchall()
            chosen = {}
            for row in candidates:
                canonical = canonical_id(row["id"], identity_merges())
                if canonical != str(row["id"]):
                    continue
                chosen.setdefault(canonical, row["tag"])
            index = []
            for player_id, tag in chosen.items():
                profile_slug = f"{safe_slug(tag) or 'player'}-{player_id}"
                try:
                    entry = write_profile(connection, player_id, tag, profile_slug)
                    if entry:
                        index.append(entry)
                except ValueError as error:
                    print(f"Skipped {tag} (ID {player_id}): {error}")
            index_path = PROFILE_DIR / "index.json"
            with index_path.open("w", encoding="utf-8") as file:
                json.dump(index, file, indent=2, ensure_ascii=False)
                file.write("\n")
            print(f"Wrote {index_path.name}: {len(index)} player profiles")
            write_event_index(connection)
        else:
            profile_slug = args.slug or safe_slug(args.tag)
            if not profile_slug or not re.fullmatch(r"[a-z0-9-]+", profile_slug):
                parser.error("--slug must contain only lowercase letters, numbers, and hyphens")
            write_profile(connection, args.player_id, args.tag, profile_slug)

if __name__ == "__main__":
    main()
