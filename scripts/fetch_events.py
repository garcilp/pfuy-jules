import json
import os
import argparse
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MANIFEST = PROJECT_ROOT / "events.json"
RAW_DIR = PROJECT_ROOT / "startgg-data" / "raw"
API_URL = "https://api.start.gg/gql/alpha"

# Keep pages modest: nested set games, slots, participants, and selections all
# count toward start.gg's per-request object limit.
ENTRANTS_PER_PAGE = 100
STANDINGS_PER_PAGE = 100
SETS_PER_PAGE = 10
MIN_REQUEST_INTERVAL = 0.8  # stays below the documented 80 requests / minute
_last_request_at = 0.0

GET_EVENT = """
query GetEvent($slug: String) {
  event(slug: $slug) {
    id
    name
    numEntrants
    tournament { id name slug images(type: "profile") { url type } }
  }
}
"""

GET_ENTRANTS = """
query EventEntrants($eventId: ID!, $page: Int!, $perPage: Int!) {
  event(id: $eventId) {
    id
    name
    entrants(query: { page: $page, perPage: $perPage }) {
      pageInfo { total totalPages }
      nodes {
        id
        name
        participants {
          id
          gamerTag
          player { id }
        }
      }
    }
  }
}
"""

GET_STANDINGS = """
query EventStandings($eventId: ID!, $page: Int!, $perPage: Int!) {
  event(id: $eventId) {
    id
    name
    standings(query: { page: $page, perPage: $perPage }) {
      nodes {
        placement
        entrant {
          id
          name
        }
      }
    }
  }
}
"""

GET_PHASE_SEEDS = """
query PhaseSeeds($phaseId: ID!, $page: Int!, $perPage: Int!) {
  phase(id: $phaseId) {
    id
    seeds(query: { page: $page, perPage: $perPage }) {
      pageInfo { total totalPages }
      nodes {
        seedNum
        entrant { id }
      }
    }
  }
}
"""
GET_SETS = """
query EventSets($eventId: ID!, $page: Int!, $perPage: Int!) {
  event(id: $eventId) {
    id
    name
    sets(page: $page, perPage: $perPage, sortType: STANDARD) {
      pageInfo { total }
      nodes {
        id
        state
        winnerId
        round
        fullRoundText
        displayScore
        lPlacement
        wPlacement
        identifier
        startAt
        startedAt
        completedAt
        createdAt
        updatedAt
        totalGames
        setGamesType
        hasPlaceholder
        vodUrl
        station { id number }
        stream { id streamName streamSource }
        phaseGroup {
          id
          displayIdentifier
          bracketType
          bracketUrl
          firstRoundTime
          startAt
          numRounds
          phase {
            id
            name
            phaseOrder
            bracketType
            isExhibition
          }
        }
        slots {
          id
          entrant {
            id
            name
            participants {
              id
              gamerTag
              player { id }
            }
          }
          standing {
            id
            placement
            stats {
              score {
                label
                value
                displayValue
              }
            }
          }
        }
        games {
          id
          orderNum
          state
          winnerId
          entrant1Score
          entrant2Score
          stage { id name }
          selections {
            id
            orderNum
            selectionType
            selectionValue
            entrant { id }
            participant { id gamerTag player { id } }
            character { id name }
          }
        }
      }
    }
  }
}
"""


def event_slug_from_url(url):
    parts = [part for part in urlparse(url).path.split("/") if part]
    try:
        start = parts.index("tournament")
    except ValueError as error:
        raise ValueError(f"Not a start.gg event URL: {url}") from error

    slug_parts = parts[start:start + 4]
    if len(slug_parts) != 4 or slug_parts[2] != "event":
        raise ValueError(f"Expected /tournament/<slug>/event/<slug>: {url}")
    return "/".join(slug_parts)


def graphql_request(operation_name, query, variables, token):
    global _last_request_at
    rate_limit_attempts = 0
    while True:
        wait = MIN_REQUEST_INTERVAL - (time.monotonic() - _last_request_at)
        if wait > 0:
            time.sleep(wait)

        body = json.dumps({
            "operationName": operation_name,
            "query": query,
            "variables": variables,
        }).encode("utf-8")
        request = Request(
            API_URL,
            data=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urlopen(request, timeout=60) as response:
                payload = json.load(response)
            break
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            _last_request_at = time.monotonic()
            if (error.code == 429 or error.code >= 500) and rate_limit_attempts < 5:
                retry_after = error.headers.get("Retry-After")
                try:
                    delay = max(1, float(retry_after)) if retry_after else (60 if error.code == 429 else 10)
                except ValueError:
                    delay = 60 if error.code == 429 else 10
                rate_limit_attempts += 1
                reason = "rate limit" if error.code == 429 else f"HTTP {error.code}"
                print(f"    start.gg {reason}; retrying in {delay:g}s "
                      f"(attempt {rate_limit_attempts}/5)", flush=True)
                time.sleep(delay)
                continue
            raise RuntimeError(f"start.gg HTTP {error.code}: {detail}") from error
        except URLError as error:
            _last_request_at = time.monotonic()
            raise RuntimeError(f"Could not reach start.gg: {error.reason}") from error
        finally:
            _last_request_at = time.monotonic()

    if payload.get("errors"):
        raise RuntimeError(json.dumps(payload["errors"], indent=2))
    if "data" not in payload:
        raise RuntimeError(f"start.gg response did not contain data: {payload}")
    return payload


def save_raw(output_dir, folder, filename, source_url, operation_name, variables, payload):
    target_dir = output_dir / folder if folder else output_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    saved = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "sourceUrl": source_url,
        "operationName": operation_name,
        "variables": variables,
        "response": payload,
    }
    target = target_dir / filename
    temporary = target.with_suffix(target.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as file:
        json.dump(saved, file, indent=2, ensure_ascii=False)
        file.write("\n")
    temporary.replace(target)


def fetch_event(url, token, output_dir):
    slug = event_slug_from_url(url)
    variables = {"slug": slug}
    payload = graphql_request("GetEvent", GET_EVENT, variables, token)
    event = payload.get("data", {}).get("event")
    if event is None:
        raise ValueError(f"start.gg returned no event for {slug}")
    save_raw(output_dir, "", "event.json", url, "GetEvent", variables, payload)
    return event


def fetch_entrants(event_id, event_name, url, token, output_dir):
    page = 1
    total_pages = None
    total = 0
    while total_pages is None or page <= total_pages:
        variables = {"eventId": event_id, "page": page, "perPage": ENTRANTS_PER_PAGE}
        payload = graphql_request("EventEntrants", GET_ENTRANTS, variables, token)
        event = payload.get("data", {}).get("event")
        if event is None:
            raise ValueError(f"No event returned while fetching entrants for {event_name}")
        connection = event["entrants"]
        page_info = connection["pageInfo"]
        total_pages = page_info["totalPages"]
        total = page_info["total"]
        save_raw(output_dir, "entrants", f"page-{page:04}.json", url,
                 "EventEntrants", variables, payload)
        print(f"    entrants page {page}/{total_pages}")
        page += 1
    return total


def fetch_standings(event_id, event_name, url, token, output_dir):
    page = 1
    total_rows = 0
    while True:
        variables = {"eventId": event_id, "page": page, "perPage": STANDINGS_PER_PAGE}
        payload = graphql_request("EventStandings", GET_STANDINGS, variables, token)
        event = payload.get("data", {}).get("event")
        if event is None:
            raise ValueError(f"No event returned while fetching standings for {event_name}")
        nodes = event["standings"]["nodes"]
        if not nodes:
            break
        save_raw(output_dir, "standings", f"page-{page:04}.json", url,
                 "EventStandings", variables, payload)
        total_rows += len(nodes)
        print(f"    standings page {page} ({len(nodes)} rows)")
        if len(nodes) < STANDINGS_PER_PAGE:
            break
        page += 1
    return total_rows


def phase_ids_from_sets(output_dir):
    phase_ids = set()
    for path in sorted((output_dir / "sets").glob("page-*.json")):
        with path.open(encoding="utf-8-sig") as file:
            wrapped = json.load(file)
        nodes = wrapped.get("response", {}).get("data", {}).get("event", {}).get("sets", {}).get("nodes") or []
        for set_data in nodes:
            phase = ((set_data.get("phaseGroup") or {}).get("phase") or {})
            if phase.get("id") is not None:
                phase_ids.add(str(phase["id"]))
    return sorted(phase_ids, key=int)


def fetch_phase_seeds(event_name, url, token, output_dir):
    total_seeds = 0
    for phase_id in phase_ids_from_sets(output_dir):
        page = 1
        total_pages = None
        while total_pages is None or page <= total_pages:
            variables = {"phaseId": phase_id, "page": page, "perPage": STANDINGS_PER_PAGE}
            payload = graphql_request("PhaseSeeds", GET_PHASE_SEEDS, variables, token)
            phase = payload.get("data", {}).get("phase")
            if phase is None:
                raise ValueError(f"No phase returned while fetching seeds for {event_name} (phase {phase_id})")
            connection = phase["seeds"]
            page_info = connection["pageInfo"]
            total_pages = page_info["totalPages"] or 0
            nodes = connection["nodes"] or []
            save_raw(output_dir, "seeds", f"phase-{phase_id}-page-{page:04}.json", url,
                     "PhaseSeeds", variables, payload)
            total_seeds += len(nodes)
            print(f"    phase {phase_id} seeds page {page}/{total_pages} ({len(nodes)} rows)")
            if not nodes:
                break
            page += 1
    return total_seeds

def fetch_sets(event_id, event_name, url, token, output_dir):
    page = 1
    total_sets = None
    saved_sets = 0
    while total_sets is None or saved_sets < total_sets:
        variables = {"eventId": event_id, "page": page, "perPage": SETS_PER_PAGE}
        payload = graphql_request("EventSets", GET_SETS, variables, token)
        event = payload.get("data", {}).get("event")
        if event is None:
            raise ValueError(f"No event returned while fetching sets for {event_name}")
        connection = event["sets"]
        total_sets = connection["pageInfo"]["total"]
        nodes = connection["nodes"]
        save_raw(output_dir, "sets", f"page-{page:04}.json", url,
                 "EventSets", variables, payload)
        saved_sets += len(nodes)
        print(f"    sets page {page} ({saved_sets}/{total_sets})")
        if not nodes:
            break
        page += 1
    return saved_sets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--images-only", action="store_true",
                        help="refresh tournament profile images without fetching entrants, standings, or sets")
    args = parser.parse_args()
    token = os.environ.get("STARTGG_API_TOKEN")
    if not token:
        raise SystemExit(
            "Set STARTGG_API_TOKEN to your start.gg API token before running this script."
        )

    with MANIFEST.open(encoding="utf-8") as file:
        config = json.load(file)

    failures = 0
    if args.images_only:
        tournaments = {}
        for game in config["games"]:
            for event_ref in game.get("events", []):
                url = event_ref["url"] if isinstance(event_ref, dict) else event_ref
                event_slug = event_slug_from_url(url)
                tournament_slug = event_slug.split("/")[1]
                output_dir = RAW_DIR / game["slug"] / event_slug.replace("/", "__")
                tournaments.setdefault(tournament_slug, (game, url, output_dir))

        for tournament_slug, (game, url, output_dir) in tournaments.items():
            print(f"Fetching {game['name']} tournament image: {tournament_slug}", flush=True)
            try:
                event = fetch_event(url, token, output_dir)
                images = ((event.get("tournament") or {}).get("images") or [])
                print(f"  Saved {len(images)} profile image(s)", flush=True)
            except Exception as error:
                failures += 1
                print(f"  ERROR: {error}", flush=True)
        if failures:
            raise SystemExit(f"Finished with {failures} tournament image request(s) that failed.")
        return

    for game in config["games"]:
        for event_ref in game.get("events", []):
            url = event_ref["url"] if isinstance(event_ref, dict) else event_ref
            slug = event_slug_from_url(url)
            output_dir = RAW_DIR / game["slug"] / slug.replace("/", "__")
            print(f"Fetching {game['name']}: {url}")
            try:
                event = fetch_event(url, token, output_dir)
                entrants = fetch_entrants(event["id"], event["name"], url, token, output_dir)
                standings = fetch_standings(event["id"], event["name"], url, token, output_dir)
                sets = fetch_sets(event["id"], event["name"], url, token, output_dir)
                seeds = fetch_phase_seeds(event["name"], url, token, output_dir)
                print(
                    f"  Saved {event['name']} (ID {event['id']}): "
                    f"{entrants} entrants, {standings} standings, {sets} sets, {seeds} phase seeds"
                )
            except Exception as error:
                failures += 1
                print(f"  ERROR: {error}")

    if failures:
        raise SystemExit(f"Finished with {failures} event(s) that could not be fully fetched.")


if __name__ == "__main__":
    main()
