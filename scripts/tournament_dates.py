#!/usr/bin/env python3
"""Centralized tournament date override and resolution module.

Provides resolution logic following the strict hierarchy:
1. Explicit date override from data/profiles/tournament_dates.json (YYYY-MM-DD).
2. Existing tournament start_at timestamp from start.gg.
3. Earliest available set timestamp (started_at, start_at, or completed_at).
"""

from __future__ import annotations

import json
import os
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Dict, Optional, Union
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
TOURNAMENT_DATES_FILE = "tournament_dates.json"


def normalize_tournament_slug(value: Optional[str]) -> Optional[str]:
    """Normalize a tournament slug or URL into a plain slug.

    Examples:
        'tournament/montevideo-smash-ultimate-enero' -> 'montevideo-smash-ultimate-enero'
        'https://start.gg/tournament/crossup-23/event/singles' -> 'crossup-23'
        'crossup-23' -> 'crossup-23'
    """
    if not value or not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None

    # Handle URLs
    if "://" in raw or raw.startswith("start.gg") or raw.startswith("www.start.gg"):
        parsed = urlsplit(raw if "://" in raw else f"https://{raw}")
        parts = [p for p in parsed.path.strip("/").split("/") if p]
        if "tournament" in parts:
            idx = parts.index("tournament")
            if idx + 1 < len(parts):
                return parts[idx + 1].lower()
        if parts:
            return parts[0].lower()

    parts = [p for p in raw.strip("/").split("/") if p]
    if "tournament" in parts:
        idx = parts.index("tournament")
        if idx + 1 < len(parts):
            return parts[idx + 1].lower()
    return parts[-1].lower() if parts else None


def validate_date_string(date_str: str) -> bool:
    """Validate that date_str is a valid calendar date in YYYY-MM-DD format."""
    if not isinstance(date_str, str) or not re.match(r"^\d{4}-\d{2}-\d{2}$", date_str.strip()):
        return False
    try:
        date.fromisoformat(date_str.strip())
        return True
    except ValueError:
        return False


def get_tournament_dates_path(repo_root: Optional[Union[Path, str]] = None) -> Path:
    base = Path(repo_root) if repo_root else ROOT
    return base / "data" / "profiles" / TOURNAMENT_DATES_FILE


def load_tournament_date_overrides(repo_root: Optional[Union[Path, str]] = None) -> Dict[str, str]:
    """Load and normalize tournament date overrides from tournament_dates.json.

    Returns:
        dict mapping normalized tournament slug -> validated YYYY-MM-DD date string.
    """
    path = get_tournament_dates_path(repo_root)
    if not path.is_file():
        return {}

    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}

    if not isinstance(data, dict):
        return {}

    normalized: Dict[str, str] = {}
    for key, val in data.items():
        if not isinstance(val, str):
            continue
        val_clean = val.strip()
        if not validate_date_string(val_clean):
            continue
        slug = normalize_tournament_slug(key)
        if slug:
            normalized[slug] = val_clean

    return normalized


def save_tournament_date_overrides(overrides: Dict[str, str], repo_root: Optional[Union[Path, str]] = None) -> None:
    """Save tournament date overrides atomically to tournament_dates.json."""
    path = get_tournament_dates_path(repo_root)
    path.parent.mkdir(parents=True, exist_ok=True)

    clean: Dict[str, str] = {}
    for k in sorted(overrides.keys()):
        slug = normalize_tournament_slug(k)
        val = overrides[k]
        if slug and isinstance(val, str) and validate_date_string(val.strip()):
            clean[slug] = val.strip()

    tmp_path = path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(clean, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp_path, path)


def epoch_to_iso(epoch: Optional[Union[int, float]]) -> Optional[str]:
    """Convert a Unix epoch timestamp (seconds) to UTC ISO date string (YYYY-MM-DD)."""
    if epoch is None:
        return None
    try:
        return datetime.fromtimestamp(int(epoch), timezone.utc).date().isoformat()
    except (ValueError, OverflowError, OSError):
        return None


def iso_to_epoch(date_str: str) -> Optional[int]:
    """Convert a UTC ISO date string (YYYY-MM-DD) to Unix epoch timestamp at UTC midnight."""
    if not validate_date_string(date_str):
        return None
    try:
        d = date.fromisoformat(date_str)
        dt = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
        return int(dt.timestamp())
    except (ValueError, OverflowError):
        return None


def resolve_tournament_date(
    tournament_slug: Optional[str],
    tournament_start_at: Optional[Union[int, float]] = None,
    earliest_set_timestamp: Optional[Union[int, float]] = None,
    date_overrides: Optional[Dict[str, str]] = None,
    repo_root: Optional[Union[Path, str]] = None,
) -> Optional[str]:
    """Resolve the effective date (YYYY-MM-DD) for a tournament.

    Resolution hierarchy:
    1. Explicit date override from tournament_dates.json.
    2. Start.gg tournament start_at timestamp.
    3. Earliest set timestamp (started_at, start_at, completed_at).
    """
    if date_overrides is None:
        date_overrides = load_tournament_date_overrides(repo_root)

    norm_slug = normalize_tournament_slug(tournament_slug)
    if norm_slug and norm_slug in date_overrides:
        return date_overrides[norm_slug]

    if tournament_start_at is not None:
        iso = epoch_to_iso(tournament_start_at)
        if iso:
            return iso

    if earliest_set_timestamp is not None:
        iso = epoch_to_iso(earliest_set_timestamp)
        if iso:
            return iso

    return None


def resolve_tournament_timestamp(
    tournament_slug: Optional[str],
    tournament_start_at: Optional[Union[int, float]] = None,
    earliest_set_timestamp: Optional[Union[int, float]] = None,
    date_overrides: Optional[Dict[str, str]] = None,
    repo_root: Optional[Union[Path, str]] = None,
) -> Optional[int]:
    """Resolve the effective timestamp (epoch seconds) for a tournament.

    If an explicit date override exists, returns UTC midnight of that date.
    Otherwise returns tournament_start_at if present, or earliest_set_timestamp.
    """
    if date_overrides is None:
        date_overrides = load_tournament_date_overrides(repo_root)

    norm_slug = normalize_tournament_slug(tournament_slug)
    if norm_slug and norm_slug in date_overrides:
        return iso_to_epoch(date_overrides[norm_slug])

    if tournament_start_at is not None:
        return int(tournament_start_at)

    if earliest_set_timestamp is not None:
        return int(earliest_set_timestamp)

    return None
