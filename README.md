# Platfighters.uy

Static front-end for a platform-fighter stats/resume page. No build step.

## Run the site

    cd platfighters-uy
    python -m http.server 8000

Then open http://localhost:8000. A local server is needed because the page loads JSON data.

For the password-protected player editor, run:

    python scripts/serve_site.py

If `PLATFIGHTERS_ADMIN_PASSWORD` is not set, the server securely prompts you to choose a password twice and keeps it only in memory for that run. There is no preset password. Open `http://localhost:8000/admin.html` to sign in. The editor can update the complete profile JSON, merge player identities, group an additional event under a primary event with a custom phase label, exclude an event site-wide, and exclude games for individual players; the start.gg player ID is fixed. This editor server binds to this computer only; use a TLS-enabled host and proper authentication before exposing any admin functions publicly. The static `python -m http.server` command does not provide admin editing.

## Download start.gg event data

1. Create an API token in your start.gg account settings.
2. Set it in your terminal as `STARTGG_API_TOKEN` (do not put the token in this repository).
3. Add event URLs to `events.json` under the correct game's `events` list.
4. Run `python scripts/fetch_events.py` from the project directory.

The script fetches each event's details, entrants, placements, phase seeding, sets, and any reported per-game data. It paginates results and spaces requests to stay under start.gg's published rate limit. It does not write to start.gg; it only reads data.

Raw responses are saved under `startgg-data/raw/<game-slug>/<event-slug>/`:

    event.json
    entrants/page-0001.json
    standings/page-0001.json
    sets/page-0001.json
    seeds/phase-<phase-id>-page-0001.json

Set pages include entrants/participants, phase and phase-group identity, bracket type/URL, round labels, timestamps, scores, stations/streams/VOD links, and reported per-game stage and character choices. Seed pages are saved under `seeds/` for each phase and include each entrant's `seedNum`. `startedAt` and `completedAt` represent actual timing when reported; `startAt` is the scheduled time and is a fallback, not proof of when play happened. Some start.gg records may have no actual timestamps, so exact chronological order cannot always be recovered. Missing game reports remain missing/null and should not be invented.

Each file wraps the untouched API response with its fetch time, operation name, variables, and source event URL. Re-running the script refreshes matching files. Keep `startgg-data/raw/` as source data and import it into SQLite separately.

## Import into SQLite

SQLite is included with Python, so no database server or extra package is needed. From the project directory, run:

    python scripts/import_startgg_data.py

The database is `startgg-data/platfighters.sqlite3`. The importer scans `startgg-data/raw/`, imports each start.gg event ID once, stores phase seeds in `phase_seeds`, and records a SHA-256 content marker in `import_markers`. Re-running it skips events whose raw files are unchanged; changed or newly added raw event files are imported again with ID-based upserts. Duplicate folders for the same start.gg event ID are deduplicated, preferring the folder with the most set/entrant/standing pages.

The existing snapshots identify tournament slugs from their source URLs but do not include tournament names or IDs. The fetcher now requests tournament ID/name/slug for future snapshots; after refreshing the raw event files, rerunning the importer will fill in that metadata.

## Layout

- `index.html` — player profile shell: top bar, sidebar, content area
- `players.html` and `js/players.js` — searchable player directory from generated profiles
- `events.html` and `js/events.js` — searchable event directory with a game filter
- `admin.html` and `js/admin.js` — password-protected profile editor (served by `scripts/serve_site.py`)
- `scripts/serve_site.py` — local-only authenticated profile/photo editing server
- `css/styles.css` — Liquid Glass material + palette (CSS variables at the top: `--blue`, `--sky`, `--gold`)
- `js/app.js` — renders the page from JSON; tabs are routed by URL hash (`#overview`, `#r2`, ...)
- `data/mint.json` — sample player. The tab list is generated from `games`, so adding a game adds a tab.
- `docs/data-model.md` — SQLite tables and import behavior
- `assets/logo.jpg` — logo (also used as favicon)
- `assets/renders/<game-slug>/portraits/` — character portraits used on game cards
- `assets/renders/<game-slug>/stocks/` — small stock icons used in character usage lists
- `assets/renders/<game-slug>/full/` — full character artwork used in the player’s top-character box; filenames use the character slug, such as `captain-falcon.webp`
- `assets/players/` — player photos named with the start.gg player ID, such as `557903.png`

## Build a player profile from SQLite

Generate a static website profile using a start.gg player ID from the imported database:

    python scripts/build_player_profile.py 557903 --tag Mitsu

This writes `data/profiles/mitsu.json`. Open it with `http://localhost:8000/?player=557903`; profile URLs use the start.gg player ID. The page defaults to the sample profile in `data/mint.json` when there is no `player` query parameter. After importing refreshed tournament snapshots, rerun the builder to refresh the generated profile.








To build profiles for all players entered in Rivals of Aether events in the database, run:

    python scripts/build_player_profile.py --all --game rivals-of-aether

This creates one uniquely named JSON file per start.gg player ID and an `index.json` mapping tags and IDs to profile slugs. Profiles include the seed from the phase with the broadest seed list (excluding exhibition phases when possible). The player directory reads this index file.

The same command also refreshes `data/events-index.json` for the Events page. To rebuild only that event catalog without regenerating every player profile, run:

    python scripts/build_player_profile.py --events-only

Refresh public start.gg profile metadata (player prefix/sponsor, profile link, city and country) for players in the database with:

    python scripts/fetch_player_profiles.py

This requires `STARTGG_API_TOKEN` and saves `data/profiles/startgg_metadata.json`. Generated profiles use the saved values when available; values saved through the admin editor take precedence.
