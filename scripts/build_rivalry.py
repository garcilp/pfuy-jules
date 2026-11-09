"""Build Rivalry of the Week.

Selects a featured player rivalry for the current week according to
configured eligibility rules and weighting formulas, saving the selection
to data/rivalry.json and maintaining a persistent history in
data/rivalry-history.json.
"""

from collections import defaultdict
from datetime import date, datetime, timedelta
import json
import math
import os
from pathlib import Path
import random
import re
import secrets
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

MONTEVIDEO_TZ = ZoneInfo("America/Montevideo")

CHAR_PORTRAIT_ALIASES = {
    "simon-belmont": "simon",
    "sheik-zelda": "sheik",
}


def slugify(text: str) -> str:
    """Generate a clean slug for character portraits."""
    return re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")


def char_portrait_slug(name: str) -> str:
    """Map character name to filename slug taking aliases into account."""
    s = slugify(name)
    return CHAR_PORTRAIT_ALIASES.get(s, s)


def get_current_week_of(dt: Optional[datetime] = None) -> str:
    """Calculate the ISO date string (YYYY-MM-DD) for the current week's Sunday.

    Weekly boundary is Sunday at 00:00 America/Montevideo local time.
    In Python, dt.weekday() returns 0 for Monday and 6 for Sunday.
    (dt.weekday() + 1) % 7 gives 0 for Sunday, 1 for Monday, etc.
    """
    if dt is None:
        dt = datetime.now(MONTEVIDEO_TZ)
    elif dt.tzinfo is None:
        dt = dt.replace(tzinfo=MONTEVIDEO_TZ)
    else:
        dt = dt.astimezone(MONTEVIDEO_TZ)

    days_since_sunday = (dt.weekday() + 1) % 7
    sunday_date = dt.date() - timedelta(days=days_since_sunday)
    return sunday_date.isoformat()


def calendar_weeks_between(week_of_a: str, week_of_b: str) -> int:
    """Calculate calendar-week differences between two weekOf dates."""
    date_a = date.fromisoformat(week_of_a)
    date_b = date.fromisoformat(week_of_b)
    diff_days = (date_b - date_a).days
    return diff_days // 7


def calculate_cooldown_multiplier(weeks_since: Optional[int]) -> float:
    """Calculate cooldown multiplier based on calendar weeks since last featured.

    - None (never featured): 1.0
    - weeks_since < 8: 0.0
    - 8 <= weeks_since <= 24: linear recovery from 0.0 at 8 to 1.0 at 24
    - weeks_since > 24: 1.0
    """
    if weeks_since is None:
        return 1.0
    if weeks_since < 8:
        return 0.0
    if weeks_since > 24:
        return 1.0
    return (weeks_since - 8) / 16.0


def calculate_rivalry_weight(
    total_sets: int, distinct_games: int, cooldown_multiplier: float
) -> float:
    """Calculate candidate selection weight.

    Weight = sqrt(total_sets) * (1 + (distinct_games - 1) ** 1.4) * cooldown_multiplier
    """
    if cooldown_multiplier <= 0.0:
        return 0.0
    game_boost = 1.0 + ((distinct_games - 1) ** 1.4)
    return math.sqrt(total_sets) * game_boost * cooldown_multiplier


def resolve_player_photo(
    photo_path: Optional[str], repo_root: Path
) -> str:
    """Resolve an explicitly configured player profile photo.

    Only use explicitly uploaded player profile photos.
    Check that the file exists and that its published path is valid relative to
    the site root. Otherwise use 'assets/logo.jpg'.
    Never use ranking photos, character renders, or inferred images.
    """
    fallback = "assets/logo.jpg"
    if not photo_path or not isinstance(photo_path, str):
        return fallback

    cleaned = photo_path.strip().lstrip("/")
    if not cleaned:
        return fallback

    # Check path safety (must not escape repo root)
    target_file = (repo_root / cleaned).resolve()
    try:
        target_file.relative_to(repo_root.resolve())
    except ValueError:
        return fallback

    if target_file.is_file():
        return cleaned

    return fallback


def get_top_head_to_head_game(games_breakdown: List[Dict[str, Any]]) -> Optional[str]:
    """Determine the game with the highest number of head-to-head sets between the two featured players.

    Uses deterministic tie-breaking (alphabetical game slug ascending) if multiple games tie.
    """
    if not games_breakdown:
        return None

    # Sort key: (-sets, gameSlug)
    best = min(
        games_breakdown,
        key=lambda g: (-int(g.get("sets", 0)), str(g.get("gameSlug", ""))),
    )
    return best.get("gameSlug")


def resolve_character_portrait(
    game_slug: str, char_name: str, repo_root: Path
) -> Optional[str]:
    """Resolve character portrait path if valid and existing on disk.

    Follows assets/renders/{gameSlug}/portraits/{charSlug}.webp convention.
    Ensures path does not escape repository root and exists as a regular file.
    """
    if not game_slug or not char_name:
        return None

    c_slug = char_portrait_slug(char_name)
    if not c_slug:
        return None

    rel_path = f"assets/renders/{game_slug}/portraits/{c_slug}.webp"
    target_file = (repo_root / rel_path).resolve()
    try:
        target_file.relative_to(repo_root.resolve())
    except ValueError:
        return None

    if target_file.is_file():
        return rel_path

    return None


def resolve_player_image(
    profile: Dict[str, Any],
    top_game_slug: Optional[str],
    repo_root: Path,
) -> str:
    """Resolve player image following desired priority:

    1. Uploaded profile photo (if explicitly configured and exists on disk).
    2. Most-played character in the top head-to-head game.
    3. Website logo ('assets/logo.jpg').
    """
    fallback = "assets/logo.jpg"

    # Priority 1: Explicitly uploaded profile photo
    photo = resolve_player_photo(profile.get("photo"), repo_root)
    if photo != fallback:
        return photo

    # Priority 2: Most-played character in the game where the pair played the most sets
    if top_game_slug:
        player_slug = profile.get("slug")
        player_id = profile.get("playerId")

        # Try to locate player profile JSON file
        profile_file = None
        if player_slug:
            candidate = repo_root / "data" / "profiles" / f"{player_slug}.json"
            if candidate.is_file():
                profile_file = candidate

        if not profile_file and player_id:
            candidate = repo_root / "data" / "profiles" / f"{player_id}.json"
            if candidate.is_file():
                profile_file = candidate

        # If still not found by direct name, search in data/profiles/ by playerId suffix
        if not profile_file and player_id:
            matches = list((repo_root / "data" / "profiles").glob(f"*-{player_id}.json"))
            if matches and matches[0].is_file():
                profile_file = matches[0]

        if profile_file and profile_file.is_file():
            try:
                with profile_file.open("r", encoding="utf-8") as f:
                    full_profile = json.load(f)
                games = full_profile.get("games", [])
                for g in games:
                    if g.get("slug") == top_game_slug or g.get("id") == top_game_slug:
                        chars = g.get("characters", [])
                        # Chars are already ranked by usage in profile build
                        # If tie-breaking needed, preserve existing order or deterministic sort
                        for c in chars:
                            c_name = c.get("name")
                            if not c_name or c_name == "Other":
                                continue
                            portrait = resolve_character_portrait(top_game_slug, c_name, repo_root)
                            if portrait:
                                return portrait
            except Exception:
                pass

    # Priority 3: Fall back to website logo
    return fallback


def atomic_write_json(file_path: Path, data: Any) -> None:
    """Write data to a JSON file atomically using a sibling temp file."""
    temp_file = file_path.with_name(f"{file_path.name}.tmp")
    file_path.parent.mkdir(parents=True, exist_ok=True)
    with temp_file.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(temp_file, file_path)


def load_history(history_path: Path) -> List[Dict[str, Any]]:
    """Load persistent selection history.

    Never silently reset malformed or unparseable existing history. Raise an explicit error.
    """
    if not history_path.exists():
        return []

    try:
        with history_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as err:
        raise ValueError(
            f"Failed to parse history file {history_path}: {err}. "
            "Never silently reset malformed or unparseable history."
        ) from err

    if not isinstance(data, list):
        raise ValueError(
            f"History file {history_path} must contain a JSON array, got {type(data).__name__}."
        )

    return data


def reconcile_published_and_history(
    rivalry_path: Path, history_path: Path
) -> List[Dict[str, Any]]:
    """Check and reconcile consistency between data/rivalry.json and data/rivalry-history.json.

    Recovery strategy:
    If a crash occurred between writing data/rivalry.json and updating data/rivalry-history.json,
    the published rivalry has a weekOf selection that is either absent or inconsistent in history.
    This function reconciles history to ensure the two files cannot silently become inconsistent.
    """
    history = load_history(history_path)

    if not rivalry_path.exists():
        return history

    try:
        with rivalry_path.open("r", encoding="utf-8") as f:
            published = json.load(f)
    except Exception:
        # If rivalry.json itself is unparseable, leave history as is
        return history

    pub_week = published.get("weekOf")
    pub_players = published.get("players")
    if not pub_week or not isinstance(pub_players, list) or len(pub_players) != 2:
        return history

    pub_p1 = str(pub_players[0].get("playerId"))
    pub_p2 = str(pub_players[1].get("playerId"))
    pub_pair = sorted([pub_p1, pub_p2])
    pub_seed = published.get("seed")

    # Find if pub_week exists in history
    found_idx = -1
    for idx, entry in enumerate(history):
        if entry.get("weekOf") == pub_week:
            found_idx = idx
            break

    entry_data = {
        "weekOf": pub_week,
        "players": pub_pair,
        "seed": pub_seed,
        "overall": published.get("overall"),
    }

    if found_idx >= 0:
        existing = history[found_idx]
        exist_pair = sorted(existing.get("players", []))
        if exist_pair != pub_pair or existing.get("seed") != pub_seed:
            history[found_idx] = entry_data
            atomic_write_json(history_path, history)
    else:
        # Published rivalry has a week not recorded in history
        history.append(entry_data)
        atomic_write_json(history_path, history)

    return history


def update_rivalry_of_the_week(
    force: bool = False,
    repo_root: Optional[Path] = None,
    now_dt: Optional[datetime] = None,
) -> Optional[Dict[str, Any]]:
    """Generate or update the Rivalry of the Week.

    Args:
        force: If True, bypass weekly idempotency while preserving history and cooldowns.
        repo_root: Root directory of the repository (defaults to project root).
        now_dt: Optional current datetime override (useful for testing).

    Returns:
        The generated rivalry dict, or the existing one if idempotent, or None on failure.
    """
    if repo_root is None:
        repo_root = Path(__file__).resolve().parent.parent
    else:
        repo_root = Path(repo_root).resolve()

    rivalry_path = repo_root / "data" / "rivalry.json"
    history_path = repo_root / "data" / "rivalry-history.json"
    profiles_index_path = repo_root / "data" / "profiles" / "index.json"
    games_config_path = repo_root / "data" / "games.json"
    rankings_dir = repo_root / "data" / "rankings" / "data"

    current_week_of = get_current_week_of(now_dt)

    # Reconcile published rivalry and history if previous run crashed midway
    history = reconcile_published_and_history(rivalry_path, history_path)

    # Idempotency check: if not forcing, check if rivalry.json already has current_week_of
    if not force and rivalry_path.exists():
        try:
            with rivalry_path.open("r", encoding="utf-8") as f:
                existing_rivalry = json.load(f)
            if existing_rivalry.get("weekOf") == current_week_of:
                return existing_rivalry
        except Exception:
            # If reading existing rivalry fails, proceed to regenerate
            pass

    # 1. Load profiles index
    if not profiles_index_path.exists():
        print(f"Warning: Profiles index {profiles_index_path} not found.")
        return None

    try:
        with profiles_index_path.open("r", encoding="utf-8") as f:
            profiles_raw = json.load(f)
    except Exception as err:
        print(f"Warning: Failed to load profiles index: {err}")
        return None

    profiles = {}
    for p in profiles_raw:
        pid = str(p.get("playerId") or "").strip()
        if pid:
            profiles[pid] = p

    # 2. Load games config
    games_config = []
    if games_config_path.exists():
        try:
            with games_config_path.open("r", encoding="utf-8") as f:
                games_config = json.load(f)
        except Exception:
            pass

    game_metadata = {}
    for g in games_config:
        slug = g.get("slug")
        if slug:
            game_metadata[slug] = {
                "id": g.get("id", slug),
                "name": g.get("name", slug),
                "slug": slug,
            }

    # 3. Load sets from data/rankings/data/<game_slug>.json
    # Map pair (tuple of sorted player IDs) -> game_slug -> list of sets
    pair_game_sets: Dict[Tuple[str, str], Dict[str, List[Dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )

    if rankings_dir.exists():
        for file in rankings_dir.glob("*.json"):
            if file.name == "index.json":
                continue
            game_slug = file.stem
            try:
                with file.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                sets = data.get("sets", [])
                for s in sets:
                    w = str(s.get("winnerId") or "").strip()
                    l = str(s.get("loserId") or "").strip()
                    if not w or not l or w == l:
                        continue
                    # Both players must exist in profiles/index.json
                    if w not in profiles or l not in profiles:
                        continue
                    pair = tuple(sorted([w, l]))
                    pair_game_sets[pair][game_slug].append(s)
            except Exception as err:
                print(f"Warning: Error reading ranking file {file}: {err}")

    # 4. Form candidate list
    # Both player IDs must exist in profiles/index.json (already filtered above)
    # Primary candidates: >= 2 distinct games and >= 5 total sets
    # Fallback candidates: >= 5 total sets (only when no primary candidates exist)
    primary_candidates: List[Tuple[Tuple[str, str], int, int]] = []
    fallback_candidates: List[Tuple[Tuple[str, str], int, int]] = []

    for pair, game_dict in pair_game_sets.items():
        distinct_games = len(game_dict)
        total_sets = sum(len(s_list) for s_list in game_dict.values())
        if distinct_games >= 2 and total_sets >= 5:
            primary_candidates.append((pair, distinct_games, total_sets))
        elif total_sets >= 5:
            fallback_candidates.append((pair, distinct_games, total_sets))

    candidate_pool = primary_candidates if primary_candidates else fallback_candidates
    if not candidate_pool:
        print("Warning: No eligible rivalry candidates found.")
        return None

    # 5. Cooldown & Weight calculation
    # Build a lookup of the most recent weekOf for each pair in history
    # If force=True, ignore the current_week_of entry itself if replacing it
    pair_last_week: Dict[Tuple[str, str], str] = {}
    for entry in history:
        w_of = entry.get("weekOf")
        if not w_of:
            continue
        # If force=True and this entry is for the current week, skip it when finding past appearances
        if force and w_of == current_week_of:
            continue
        hist_players = entry.get("players")
        if isinstance(hist_players, list) and len(hist_players) == 2:
            h_pair = tuple(sorted([str(hist_players[0]), str(hist_players[1])]))
            prev = pair_last_week.get(h_pair)
            if prev is None or w_of > prev:
                pair_last_week[h_pair] = w_of

    weighted_candidates = []
    weights = []

    for pair, distinct_games, total_sets in candidate_pool:
        last_featured = pair_last_week.get(pair)
        weeks_since = None
        if last_featured is not None:
            weeks_since = calendar_weeks_between(last_featured, current_week_of)

        cooldown_mult = calculate_cooldown_multiplier(weeks_since)
        weight = calculate_rivalry_weight(total_sets, distinct_games, cooldown_mult)

        if weight > 0.0:
            weighted_candidates.append((pair, distinct_games, total_sets))
            weights.append(weight)

    if not weighted_candidates or sum(weights) <= 0.0:
        print("Warning: No eligible candidates with non-zero weight (all in cooldown).")
        return None

    # 6. Random selection using dedicated 32-bit seed
    seed = secrets.randbits(32)
    rng = random.Random(seed)
    selected_candidate = rng.choices(weighted_candidates, weights=weights, k=1)[0]
    selected_pair, selected_distinct_games, selected_total_sets = selected_candidate

    p1_id, p2_id = selected_pair
    p1_profile = profiles[p1_id]
    p2_profile = profiles[p2_id]

    # 7. Build match statistics and breakdown
    selected_game_dict = pair_game_sets[selected_pair]

    games_breakdown = []
    p1_total_wins = 0
    p2_total_wins = 0
    all_dates = []

    # Sort games deterministically (e.g. by set count desc, then name)
    sorted_game_slugs = sorted(
        selected_game_dict.keys(),
        key=lambda g: (-len(selected_game_dict[g]), g),
    )

    for g_slug in sorted_game_slugs:
        sets = selected_game_dict[g_slug]
        p1_wins = sum(1 for s in sets if str(s.get("winnerId")) == p1_id)
        p2_wins = sum(1 for s in sets if str(s.get("winnerId")) == p2_id)
        p1_total_wins += p1_wins
        p2_total_wins += p2_wins

        for s in sets:
            d = s.get("date")
            if d:
                all_dates.append(str(d))

        g_meta = game_metadata.get(
            g_slug, {"id": g_slug, "name": g_slug.replace("-", " ").title(), "slug": g_slug}
        )
        games_breakdown.append({
            "gameId": g_meta["id"],
            "gameName": g_meta["name"],
            "gameSlug": g_slug,
            "score": [p1_wins, p2_wins],
            "sets": len(sets),
        })

    last_encounter_date = max(all_dates) if all_dates else None

    top_h2h_game = get_top_head_to_head_game(games_breakdown)
    p1_image = resolve_player_image(p1_profile, top_h2h_game, repo_root)
    p2_image = resolve_player_image(p2_profile, top_h2h_game, repo_root)

    # 8. Create published data object
    rivalry_data = {
        "weekOf": current_week_of,
        "players": [
            {
                "playerId": p1_id,
                "tag": p1_profile.get("tag", p1_id),
                "slug": p1_profile.get("slug", p1_id),
                "photo": p1_image,
            },
            {
                "playerId": p2_id,
                "tag": p2_profile.get("tag", p2_id),
                "slug": p2_profile.get("slug", p2_id),
                "photo": p2_image,
            },
        ],
        "overall": {
            "score": [p1_total_wins, p2_total_wins],
            "totalSets": selected_total_sets,
            "distinctGames": selected_distinct_games,
            "lastEncounterDate": last_encounter_date,
        },
        "games": games_breakdown,
        "seed": seed,
    }

    # 9. Atomic persistence and failure handling
    # Step A: Atomically write published rivalry
    atomic_write_json(rivalry_path, rivalry_data)

    # Step B: Update history atomically
    # If force=True and an entry for current_week_of already exists, update it in place
    history_entry = {
        "weekOf": current_week_of,
        "players": [p1_id, p2_id],
        "seed": seed,
        "overall": rivalry_data["overall"],
    }

    existing_idx = -1
    for idx, h in enumerate(history):
        if h.get("weekOf") == current_week_of:
            existing_idx = idx
            break

    if existing_idx >= 0:
        history[existing_idx] = history_entry
    else:
        history.append(history_entry)

    atomic_write_json(history_path, history)

    print(
        f"Updated Rivalry of the Week for {current_week_of}: "
        f"{p1_profile.get('tag')} vs {p2_profile.get('tag')} (seed: {seed})"
    )
    return rivalry_data


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Update Rivalry of the Week.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force regeneration for the current week, bypassing idempotency.",
    )
    args = parser.parse_args()
    update_rivalry_of_the_week(force=args.force)
