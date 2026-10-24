"""Import saved start.gg GraphQL responses into the project's SQLite database."""

import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAW_ROOT = PROJECT_ROOT / "startgg-data" / "raw"
DATABASE = PROJECT_ROOT / "startgg-data" / "platfighters.sqlite3"
MANIFEST = PROJECT_ROOT / "events.json"

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS videogames (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tournaments (
    slug TEXT PRIMARY KEY,
    startgg_id TEXT,
    name TEXT,
    start_at INTEGER,
    city TEXT,
    country TEXT
);
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    tournament_slug TEXT NOT NULL REFERENCES tournaments(slug),
    videogame_slug TEXT NOT NULL REFERENCES videogames(slug),
    name TEXT NOT NULL,
    num_entrants INTEGER,
    source_url TEXT,
    is_temporary INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    player_id TEXT REFERENCES players(id),
    gamer_tag TEXT
);
CREATE TABLE IF NOT EXISTS entrants (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    name TEXT
);
CREATE TABLE IF NOT EXISTS entrant_participants (
    entrant_id TEXT NOT NULL REFERENCES entrants(id),
    participant_id TEXT NOT NULL REFERENCES participants(id),
    PRIMARY KEY (entrant_id, participant_id)
);
CREATE TABLE IF NOT EXISTS event_standings (
    event_id TEXT NOT NULL REFERENCES events(id),
    entrant_id TEXT NOT NULL REFERENCES entrants(id),
    placement INTEGER,
    PRIMARY KEY (event_id, entrant_id)
);
CREATE TABLE IF NOT EXISTS phases (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    name TEXT,
    phase_order INTEGER,
    bracket_type TEXT,
    is_exhibition INTEGER
);
CREATE TABLE IF NOT EXISTS phase_seeds (
    phase_id TEXT NOT NULL REFERENCES phases(id),
    entrant_id TEXT NOT NULL REFERENCES entrants(id),
    seed_num INTEGER,
    PRIMARY KEY (phase_id, entrant_id)
);CREATE TABLE IF NOT EXISTS phase_groups (
    id TEXT PRIMARY KEY,
    phase_id TEXT REFERENCES phases(id),
    display_identifier TEXT,
    bracket_type TEXT,
    bracket_url TEXT,
    first_round_time INTEGER,
    start_at INTEGER,
    num_rounds INTEGER
);
CREATE TABLE IF NOT EXISTS sets (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    phase_group_id TEXT REFERENCES phase_groups(id),
    state INTEGER,
    winner_entrant_id TEXT,
    round INTEGER,
    full_round_text TEXT,
    display_score TEXT,
    identifier TEXT,
    start_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER,
    updated_at INTEGER,
    total_games INTEGER,
    set_games_type INTEGER,
    has_placeholder INTEGER,
    l_placement INTEGER,
    w_placement INTEGER,
    vod_url TEXT,
    station_id TEXT,
    station_number INTEGER,
    stream_id TEXT,
    stream_name TEXT,
    stream_source TEXT
);
CREATE TABLE IF NOT EXISTS set_entrants (
    set_id TEXT NOT NULL REFERENCES sets(id),
    slot_id TEXT NOT NULL,
    slot_order INTEGER NOT NULL,
    entrant_id TEXT REFERENCES entrants(id),
    score REAL,
    score_label TEXT,
    score_display TEXT,
    placement INTEGER,
    PRIMARY KEY (set_id, slot_order)
);
CREATE TABLE IF NOT EXISTS set_games (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL REFERENCES sets(id),
    game_no INTEGER,
    state INTEGER,
    winner_entrant_id TEXT,
    entrant1_score REAL,
    entrant2_score REAL,
    stage_id TEXT,
    stage_name TEXT
);
CREATE TABLE IF NOT EXISTS characters (
    videogame_slug TEXT NOT NULL REFERENCES videogames(slug),
    id TEXT NOT NULL,
    name TEXT,
    PRIMARY KEY (videogame_slug, id)
);
CREATE TABLE IF NOT EXISTS set_game_selections (
    id TEXT PRIMARY KEY,
    set_game_id TEXT NOT NULL REFERENCES set_games(id),
    videogame_slug TEXT NOT NULL,
    character_id TEXT,
    entrant_id TEXT,
    participant_id TEXT,
    selection_order INTEGER,
    selection_type TEXT,
    selection_value INTEGER,
    FOREIGN KEY (videogame_slug, character_id)
      REFERENCES characters(videogame_slug, id)
);
CREATE TABLE IF NOT EXISTS import_markers (
    event_id TEXT PRIMARY KEY REFERENCES events(id),
    source_path TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    entrants_imported INTEGER NOT NULL,
    standings_imported INTEGER NOT NULL,
    sets_imported INTEGER NOT NULL,
    games_imported INTEGER NOT NULL,
    selections_imported INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_tournament ON events(tournament_slug);
CREATE INDEX IF NOT EXISTS idx_events_game ON events(videogame_slug);
CREATE INDEX IF NOT EXISTS idx_entrants_event ON entrants(event_id);
CREATE INDEX IF NOT EXISTS idx_sets_event ON sets(event_id);
CREATE INDEX IF NOT EXISTS idx_sets_phase_round ON sets(phase_group_id, round);
CREATE INDEX IF NOT EXISTS idx_sets_started_at ON sets(event_id, started_at);
CREATE INDEX IF NOT EXISTS idx_participants_player ON participants(player_id);
CREATE INDEX IF NOT EXISTS idx_selections_entrant ON set_game_selections(entrant_id);
"""


def text_id(value):
    return None if value is None else str(value)


def wrapped_response(path):
    with path.open(encoding="utf-8-sig") as file:
        wrapped = json.load(file)
    response = wrapped.get("response", {})
    return wrapped, response


def event_from_folder(folder):
    event_file = folder / "event.json"
    if not event_file.is_file():
        return None
    _, response = wrapped_response(event_file)
    return response.get("data", {}).get("event")


def digest_folder(folder):
    digest = hashlib.sha256()
    json_files = sorted(folder.rglob("*.json"))
    for path in json_files:
        digest.update(path.relative_to(folder).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest(), json_files


def page_files(folder, section):
    directory = folder / section
    if not directory.is_dir():
        return []
    return sorted(directory.glob("page-*.json"))


def discover_events():
    groups = {}
    if not RAW_ROOT.exists():
        return groups
    for event_file in RAW_ROOT.rglob("event.json"):
        folder = event_file.parent
        event = event_from_folder(folder)
        if not event or event.get("id") is None:
            print(f"Skipping invalid event file: {event_file}")
            continue
        event_id = text_id(event["id"])
        entrants = page_files(folder, "entrants")
        standings = page_files(folder, "standings")
        sets = page_files(folder, "sets")
        seeds_dir = folder / "seeds"
        seeds = sorted(seeds_dir.glob("phase-*-page-*.json")) if seeds_dir.is_dir() else []
        quality = (len(sets), len(entrants) + len(standings), len(list(folder.rglob("*.json"))))
        groups.setdefault(event_id, []).append({
            "folder": folder,
            "event": event,
            "quality": quality,
            "entrants": entrants,
            "standings": standings,
            "sets": sets,
            "seeds": seeds,
        })
    return groups


def normalize_event_key(value):
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    parsed = urlparse(raw if "://" in raw else f"https://www.start.gg/{raw.lstrip('/')}")
    if parsed.netloc and parsed.netloc.lower() not in {"start.gg", "www.start.gg"}:
        return None
    parts = parsed.path.strip("/").lower().split("/")
    if len(parts) < 4 or parts[0] != "tournament" or parts[2] != "event":
        return None
    return "/".join(parts[:4])


def load_event_configs():
    if not MANIFEST.is_file():
        return {}
    with MANIFEST.open(encoding="utf-8-sig") as file:
        config = json.load(file)
    configs = {}
    for game in config.get("games", []):
        for event_ref in game.get("events", []):
            if isinstance(event_ref, dict):
                url = event_ref.get("url")
                is_temp = bool(event_ref.get("temporary", False))
            else:
                url = str(event_ref)
                is_temp = False
            if url:
                key = normalize_event_key(url)
                if key:
                    configs[key] = {"url": url, "temporary": is_temp, "game_slug": game.get("slug")}
    return configs


def tournament_slug_from_url(url, fallback_folder):
    if url:
        parts = [part for part in urlparse(url).path.split("/") if part]
        try:
            index = parts.index("tournament")
            if len(parts) > index + 1:
                return parts[index + 1]
        except ValueError:
            pass
    # Folder names are tournament__<slug>__event__<event-slug>.
    folder_name = fallback_folder.name
    if folder_name.startswith("tournament__"):
        return folder_name[len("tournament__"):].split("__event__", 1)[0]
    return f"unknown-tournament-{fallback_folder.name}"


def upsert_participant(connection, participant):
    participant_id = text_id(participant.get("id"))
    if participant_id is None:
        return None
    player = participant.get("player") or {}
    player_id = text_id(player.get("id"))
    if player_id is not None:
        connection.execute("INSERT OR IGNORE INTO players(id) VALUES (?)", (player_id,))
    connection.execute(
        "INSERT INTO participants(id, player_id, gamer_tag) VALUES (?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET player_id=excluded.player_id, gamer_tag=excluded.gamer_tag",
        (participant_id, player_id, participant.get("gamerTag")),
    )
    return participant_id


def upsert_participants(connection, entrant, event_id):
    entrant_id = text_id(entrant.get("id"))
    if entrant_id is None:
        return None
    connection.execute(
        "INSERT INTO entrants(id, event_id, name) VALUES (?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET event_id=excluded.event_id, name=excluded.name",
        (entrant_id, event_id, entrant.get("name")),
    )
    for participant in entrant.get("participants") or []:
        participant_id = upsert_participant(connection, participant)
        if participant_id is not None:
            connection.execute(
                "INSERT OR IGNORE INTO entrant_participants(entrant_id, participant_id) VALUES (?, ?)",
                (entrant_id, participant_id),
            )
    return entrant_id

def score_from_slot(slot):
    standing = slot.get("standing") or {}
    score = ((standing.get("stats") or {}).get("score") or {})
    return (
        score.get("value"), score.get("label"), score.get("displayValue"),
        standing.get("placement"),
    )


def import_event(connection, candidate, event_id, game_names, event_configs):
    folder = candidate["folder"]
    event = candidate["event"]
    event_wrapper, _ = wrapped_response(folder / "event.json")
    source_url = event_wrapper.get("sourceUrl")
    game_slug = folder.parent.name
    game_name = game_names.get(game_slug, game_slug.replace("-", " ").title())
    tournament = event.get("tournament") or {}
    tournament_slug = tournament_slug_from_url(source_url, folder)
    api_tournament_slug = tournament.get("slug")
    if api_tournament_slug:
        tournament_slug = api_tournament_slug.rsplit("/", 1)[-1]

    event_key = normalize_event_key(source_url)
    is_temporary = 1 if (event_key and event_configs.get(event_key, {}).get("temporary")) else 0
    tournament_start = tournament.get("startAt") or event.get("startAt")

    counts = {"entrants": 0, "standings": 0, "sets": 0, "games": 0, "selections": 0}
    connection.execute(
        "INSERT INTO videogames(slug, name) VALUES (?, ?) "
        "ON CONFLICT(slug) DO UPDATE SET name=excluded.name", (game_slug, game_name),
    )
    # Existing snapshots contain the tournament slug in the URL, but not its
    # start.gg ID/name. Those columns are filled automatically if raw data later
    # includes tournament metadata.
    connection.execute(
        "INSERT INTO tournaments(slug, startgg_id, name, start_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(slug) DO UPDATE SET startgg_id=COALESCE(excluded.startgg_id, tournaments.startgg_id), "
        "name=COALESCE(excluded.name, tournaments.name), "
        "start_at=COALESCE(excluded.start_at, tournaments.start_at)",
        (tournament_slug, text_id(tournament.get("id")), tournament.get("name"), tournament_start),
    )
    connection.execute(
        "INSERT INTO events(id, tournament_slug, videogame_slug, name, num_entrants, source_url, is_temporary) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
        "tournament_slug=excluded.tournament_slug, videogame_slug=excluded.videogame_slug, "
        "name=excluded.name, num_entrants=excluded.num_entrants, source_url=excluded.source_url, "
        "is_temporary=excluded.is_temporary",
        (event_id, tournament_slug, game_slug, event.get("name") or "Unknown event",
         event.get("numEntrants"), source_url, is_temporary),
    )

    for path in candidate["entrants"]:
        _, payload = wrapped_response(path)
        nodes = payload.get("data", {}).get("event", {}).get("entrants", {}).get("nodes") or []
        for entrant in nodes:
            upsert_participants(connection, entrant, event_id)
            counts["entrants"] += 1

    for path in candidate["standings"]:
        _, payload = wrapped_response(path)
        nodes = payload.get("data", {}).get("event", {}).get("standings", {}).get("nodes") or []
        for standing in nodes:
            entrant = standing.get("entrant") or {}
            entrant_id = text_id(entrant.get("id"))
            if entrant_id is None:
                continue
            connection.execute(
                "INSERT INTO entrants(id, event_id, name) VALUES (?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET event_id=excluded.event_id, name=COALESCE(excluded.name, entrants.name)",
                (entrant_id, event_id, entrant.get("name")),
            )
            connection.execute(
                "INSERT INTO event_standings(event_id, entrant_id, placement) VALUES (?, ?, ?) "
                "ON CONFLICT(event_id, entrant_id) DO UPDATE SET placement=excluded.placement",
                (event_id, entrant_id, standing.get("placement")),
            )
            counts["standings"] += 1

    for path in candidate["sets"]:
        _, payload = wrapped_response(path)
        nodes = payload.get("data", {}).get("event", {}).get("sets", {}).get("nodes") or []
        for set_data in nodes:
            set_id = text_id(set_data.get("id"))
            if set_id is None:
                continue
            phase_group = set_data.get("phaseGroup") or {}
            phase = phase_group.get("phase") or {}
            phase_id = text_id(phase.get("id"))
            phase_group_id = text_id(phase_group.get("id"))
            if phase_id:
                connection.execute(
                    "INSERT INTO phases(id, event_id, name, phase_order, bracket_type, is_exhibition) "
                    "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                    "event_id=excluded.event_id, name=excluded.name, phase_order=excluded.phase_order, "
                    "bracket_type=excluded.bracket_type, is_exhibition=excluded.is_exhibition",
                    (phase_id, event_id, phase.get("name"), phase.get("phaseOrder"),
                     phase.get("bracketType"), int(phase["isExhibition"]) if phase.get("isExhibition") is not None else None),
                )
            if phase_group_id:
                connection.execute(
                    "INSERT INTO phase_groups(id, phase_id, display_identifier, bracket_type, bracket_url, "
                    "first_round_time, start_at, num_rounds) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(id) DO UPDATE SET phase_id=excluded.phase_id, "
                    "display_identifier=excluded.display_identifier, bracket_type=excluded.bracket_type, "
                    "bracket_url=excluded.bracket_url, first_round_time=excluded.first_round_time, "
                    "start_at=excluded.start_at, num_rounds=excluded.num_rounds",
                    (phase_group_id, phase_id, phase_group.get("displayIdentifier"),
                     phase_group.get("bracketType"), phase_group.get("bracketUrl"),
                     phase_group.get("firstRoundTime"), phase_group.get("startAt"), phase_group.get("numRounds")),
                )
            station = set_data.get("station") or {}
            stream = set_data.get("stream") or {}
            connection.execute(
                "INSERT INTO sets(id, event_id, phase_group_id, state, winner_entrant_id, round, "
                "full_round_text, display_score, identifier, start_at, started_at, completed_at, "
                "created_at, updated_at, total_games, set_games_type, has_placeholder, l_placement, "
                "w_placement, vod_url, station_id, station_number, stream_id, stream_name, stream_source) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET event_id=excluded.event_id, phase_group_id=excluded.phase_group_id, "
                "state=excluded.state, winner_entrant_id=excluded.winner_entrant_id, round=excluded.round, "
                "full_round_text=excluded.full_round_text, display_score=excluded.display_score, "
                "identifier=excluded.identifier, start_at=excluded.start_at, started_at=excluded.started_at, "
                "completed_at=excluded.completed_at, created_at=excluded.created_at, updated_at=excluded.updated_at, "
                "total_games=excluded.total_games, set_games_type=excluded.set_games_type, "
                "has_placeholder=excluded.has_placeholder, l_placement=excluded.l_placement, "
                "w_placement=excluded.w_placement, vod_url=excluded.vod_url, station_id=excluded.station_id, "
                "station_number=excluded.station_number, stream_id=excluded.stream_id, "
                "stream_name=excluded.stream_name, stream_source=excluded.stream_source",
                (set_id, event_id, phase_group_id, set_data.get("state"), text_id(set_data.get("winnerId")),
                 set_data.get("round"), set_data.get("fullRoundText"), set_data.get("displayScore"),
                 set_data.get("identifier"), set_data.get("startAt"), set_data.get("startedAt"),
                 set_data.get("completedAt"), set_data.get("createdAt"), set_data.get("updatedAt"),
                 set_data.get("totalGames"), set_data.get("setGamesType"),
                 int(set_data["hasPlaceholder"]) if set_data.get("hasPlaceholder") is not None else None,
                 set_data.get("lPlacement"), set_data.get("wPlacement"), set_data.get("vodUrl"),
                 text_id(station.get("id")), station.get("number"), text_id(stream.get("id")),
                 stream.get("streamName"), stream.get("streamSource")),
            )
            for slot_order, slot in enumerate(set_data.get("slots") or []):
                entrant = slot.get("entrant") or {}
                entrant_id = upsert_participants(connection, entrant, event_id) if entrant.get("id") is not None else None
                score, score_label, score_display, placement = score_from_slot(slot)
                connection.execute(
                    "INSERT INTO set_entrants(set_id, slot_id, slot_order, entrant_id, score, score_label, score_display, placement) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(set_id, slot_order) DO UPDATE SET "
                    "slot_id=excluded.slot_id, entrant_id=excluded.entrant_id, score=excluded.score, "
                    "score_label=excluded.score_label, score_display=excluded.score_display, placement=excluded.placement",
                    (set_id, text_id(slot.get("id")) or f"{set_id}-{slot_order}", slot_order,
                     entrant_id, score, score_label, score_display, placement),
                )
            for game_index, game in enumerate(set_data.get("games") or [], start=1):
                game_id = text_id(game.get("id"))
                if game_id is None:
                    continue
                stage = game.get("stage") or {}
                connection.execute(
                    "INSERT INTO set_games(id, set_id, game_no, state, winner_entrant_id, entrant1_score, "
                    "entrant2_score, stage_id, stage_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(id) DO UPDATE SET set_id=excluded.set_id, game_no=excluded.game_no, "
                    "state=excluded.state, winner_entrant_id=excluded.winner_entrant_id, "
                    "entrant1_score=excluded.entrant1_score, entrant2_score=excluded.entrant2_score, "
                    "stage_id=excluded.stage_id, stage_name=excluded.stage_name",
                    (game_id, set_id, game.get("orderNum") or game_index, game.get("state"),
                     text_id(game.get("winnerId")), game.get("entrant1Score"), game.get("entrant2Score"),
                     text_id(stage.get("id")), stage.get("name")),
                )
                counts["games"] += 1
                for selection_index, selection in enumerate(game.get("selections") or [], start=1):
                    selection_id = text_id(selection.get("id"))
                    if selection_id is None:
                        continue
                    character = selection.get("character") or {}
                    character_id = text_id(character.get("id")) or text_id(selection.get("selectionValue"))
                    if character_id:
                        connection.execute(
                            "INSERT INTO characters(videogame_slug, id, name) VALUES (?, ?, ?) "
                            "ON CONFLICT(videogame_slug, id) DO UPDATE SET name=excluded.name",
                            (game_slug, character_id, character.get("name")),
                        )
                    selection_entrant = selection.get("entrant") or {}
                    participant = selection.get("participant") or {}
                    participant_id = upsert_participant(connection, participant)
                    connection.execute(
                        "INSERT INTO set_game_selections(id, set_game_id, videogame_slug, character_id, entrant_id, "
                        "participant_id, selection_order, selection_type, selection_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
                        "ON CONFLICT(id) DO UPDATE SET set_game_id=excluded.set_game_id, "
                        "videogame_slug=excluded.videogame_slug, character_id=excluded.character_id, "
                        "entrant_id=excluded.entrant_id, participant_id=excluded.participant_id, "
                        "selection_order=excluded.selection_order, selection_type=excluded.selection_type, "
                        "selection_value=excluded.selection_value",
                        (selection_id, game_id, game_slug, character_id, text_id(selection_entrant.get("id")),
                         participant_id, selection.get("orderNum") or selection_index,
                         selection.get("selectionType"), selection.get("selectionValue")),
                    )
                    counts["selections"] += 1
            counts["sets"] += 1

    for path in candidate.get("seeds", []):
        _, payload = wrapped_response(path)
        phase_data = payload.get("data", {}).get("phase") or {}
        phase_id = text_id(phase_data.get("id"))
        if phase_id is None:
            continue
        for seed in (phase_data.get("seeds") or {}).get("nodes") or []:
            entrant_id = text_id((seed.get("entrant") or {}).get("id"))
            if entrant_id is None or seed.get("seedNum") is None:
                continue
            connection.execute(
                "INSERT INTO phase_seeds(phase_id, entrant_id, seed_num) VALUES (?, ?, ?) "
                "ON CONFLICT(phase_id, entrant_id) DO UPDATE SET seed_num=excluded.seed_num",
                (phase_id, entrant_id, seed.get("seedNum")),
            )

    return counts


def load_game_names():
    if not MANIFEST.is_file():
        return {}
    with MANIFEST.open(encoding="utf-8-sig") as file:
        config = json.load(file)
    return {game["slug"]: game["name"] for game in config.get("games", [])}


def main():
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    game_names = load_game_names()
    event_configs = load_event_configs()
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(SCHEMA)

    try:
        connection.execute("ALTER TABLE events ADD COLUMN is_temporary INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass

    groups = discover_events()
    if not groups:
        print(f"No event.json files found under {RAW_ROOT}")
        connection.close()
        return

    imported = 0
    skipped = 0
    failed = 0
    for event_id, candidates in sorted(groups.items()):
        candidates.sort(key=lambda item: item["quality"], reverse=True)
        candidate = candidates[0]
        for duplicate in candidates[1:]:
            print(f"  Duplicate source for event {event_id}: {duplicate['folder'].relative_to(PROJECT_ROOT)}")
        folder = candidate["folder"]
        digest, _ = digest_folder(folder)
        relative_path = folder.relative_to(PROJECT_ROOT).as_posix()
        marker = connection.execute(
            "SELECT content_sha256 FROM import_markers WHERE event_id = ?", (event_id,),
        ).fetchone()
        if marker and marker["content_sha256"] == digest:
            print(f"Already imported, skipping event {event_id}: {folder.name}")
            skipped += 1
            continue

        try:
            with connection:
                counts = import_event(connection, candidate, event_id, game_names, event_configs)
                connection.execute(
                    "INSERT INTO import_markers(event_id, source_path, content_sha256, imported_at, "
                    "entrants_imported, standings_imported, sets_imported, games_imported, selections_imported) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET "
                    "source_path=excluded.source_path, content_sha256=excluded.content_sha256, "
                    "imported_at=excluded.imported_at, entrants_imported=excluded.entrants_imported, "
                    "standings_imported=excluded.standings_imported, sets_imported=excluded.sets_imported, "
                    "games_imported=excluded.games_imported, selections_imported=excluded.selections_imported",
                    (event_id, relative_path, digest, datetime.now(timezone.utc).isoformat(),
                     counts["entrants"], counts["standings"], counts["sets"],
                     counts["games"], counts["selections"]),
                )
            print(
                f"Imported event {event_id} from {relative_path}: "
                f"{counts['entrants']} entrants, {counts['standings']} standings, "
                f"{counts['sets']} sets, {counts['games']} games, "
                f"{counts['selections']} character selections"
            )
            imported += 1
        except (OSError, ValueError, KeyError, sqlite3.Error, json.JSONDecodeError) as error:
            print(f"ERROR importing event {event_id} ({relative_path}): {error}", file=sys.stderr)
            failed += 1

    connection.close()
    print(f"\nDatabase: {DATABASE}")
    print(f"Imported: {imported}; unchanged: {skipped}; failed: {failed}")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
