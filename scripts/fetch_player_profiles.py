"""Fetch public start.gg profile metadata for players in the local database."""

import json
import os
import sqlite3
from pathlib import Path

from fetch_events import graphql_request

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATABASE = PROJECT_ROOT / "startgg-data" / "platfighters.sqlite3"
OUTPUT = PROJECT_ROOT / "data" / "profiles" / "startgg_metadata.json"
PER_PAGE = 100

PLAYER_METADATA_QUERY = """
query PlayerProfileMetadata($eventId: ID!, $page: Int!, $perPage: Int!) {
  event(id: $eventId) {
    entrants(query: { page: $page, perPage: $perPage }) {
      pageInfo { totalPages }
      nodes {
        participants {
          player { id prefix }
          user { slug location { city country } }
        }
      }
    }
  }
}
"""


def main():
    token = os.environ.get("STARTGG_API_TOKEN")
    if not token:
        raise SystemExit("Set STARTGG_API_TOKEN to your start.gg API token before running this script.")
    if not DATABASE.is_file():
        raise SystemExit(f"Database not found: {DATABASE}; import event data first.")

    with sqlite3.connect(DATABASE) as connection:
        event_ids = [row[0] for row in connection.execute("SELECT id FROM events ORDER BY id")]
        player_ids = {str(row[0]) for row in connection.execute("SELECT id FROM players")}

    metadata = {}
    if OUTPUT.is_file():
        try:
            metadata = json.loads(OUTPUT.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            metadata = {}

    for event_id in event_ids:
        page = 1
        total_pages = 1
        while page <= total_pages:
            payload = graphql_request(
                "PlayerProfileMetadata",
                PLAYER_METADATA_QUERY,
                {"eventId": event_id, "page": page, "perPage": PER_PAGE},
                token,
            )
            event = payload.get("data", {}).get("event")
            if event is None:
                print(f"Skipped event {event_id}: no event returned")
                break
            entrants = event["entrants"]
            total_pages = entrants["pageInfo"].get("totalPages") or 0
            for entrant in entrants.get("nodes") or []:
                for participant in entrant.get("participants") or []:
                    player = participant.get("player") or {}
                    player_id = str(player.get("id") or "")
                    if player_id not in player_ids:
                        continue
                    user = participant.get("user") or {}
                    location = user.get("location") or {}
                    record = metadata.setdefault(player_id, {})
                    for key, value in (
                        ("sponsor", player.get("prefix")),
                        ("userSlug", user.get("slug")),
                        ("city", location.get("city")),
                        ("country", location.get("country")),
                    ):
                        if isinstance(value, str) and value.strip():
                            record[key] = value.strip()
            page += 1
        print(f"Read profile metadata from event {event_id}")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix(OUTPUT.suffix + ".tmp")
    temporary.write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(OUTPUT)
    populated = sum(bool(any(value for value in record.values())) for record in metadata.values())
    print(f"Saved {len(metadata)} player records ({populated} populated) to {OUTPUT}")


if __name__ == "__main__":
    main()
