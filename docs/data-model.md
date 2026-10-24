# SQLite data model

Run `python scripts/import_startgg_data.py` to create and populate `startgg-data/platfighters.sqlite3` from the saved raw GraphQL responses. The schema uses start.gg IDs as keys and stores the source tournament slug parsed from the event URL.

The importer creates these tables:

    videogames          (slug, name)
    tournaments         (slug, startgg_id, name, start_at, city, country)
    events              (id, tournament_slug, videogame_slug, name, num_entrants, source_url)
    players             (id)
    participants        (id, player_id, gamer_tag)
    entrants            (id, event_id, name)
    entrant_participants (entrant_id, participant_id)
    event_standings     (event_id, entrant_id, placement)
    phase_seeds         (phase_id, entrant_id, seed_num)
    phases              (id, event_id, name, phase_order, bracket_type, is_exhibition)
    phase_groups        (id, phase_id, display_identifier, bracket_type, bracket_url,
                         first_round_time, start_at, num_rounds)
    sets                (id, event_id, phase_group_id, state, winner_entrant_id, round,
                         full_round_text, display_score, identifier, timestamps, ...)
    set_entrants        (set_id, slot_id, slot_order, entrant_id, score, placement, ...)
    set_games           (id, set_id, game_no, state, winner_entrant_id, scores, stage, ...)
    characters          (videogame_slug, id, name)
    set_game_selections (id, set_game_id, videogame_slug, character_id, entrant_id,
                         participant_id, selection_order, selection_type, selection_value)
    import_markers      (event_id, source_path, content_sha256, imported_at, row counts)

Public player profile metadata is fetched separately with `python scripts/fetch_player_profiles.py`. It stores start.gg player prefixes, linked user profile slugs, and public city/country values in `data/profiles/startgg_metadata.json`, keyed by start.gg player ID. Profile generation uses these fields when available, defaults a missing country to Uruguay, and admin-saved overrides take precedence. Full profile edits made in the admin panel are stored as per-player overrides so they persist across profile rebuilds.

Entrants are event-specific; group them by player ID for cross-event and cross-game stats. Seeds are stored by phase because an entrant can have a different seed in each phase; they are not the same as final event placement. Teams can have multiple participants, so the entrant-to-participant relationship is many-to-many. Character selections point to their entrant and, when start.gg reports it, participant.

For chronology, use `started_at` where present. `start_at` is scheduled time and only a fallback; `completed_at` indicates when the set was marked complete. These values can be missing, so some events only support bracket/phase/round ordering. Keep `phase_order`, bracket type, phase-group identifier, `round`, and `full_round_text` as separate signals.

Generated player event results include a `sets` list with each set's phase, round, opponent tag(s), score, and win/loss outcome. The profile's results table expands each event row to show those sets; events without saved set data show an unavailable-details message.

The admin event-group control stores child-event relationships in `data/profiles/event_groups.json`, keyed by normalized start.gg event URL paths. A linked event's sets appear under the selected primary event, using the configured phase label in place of the generic phase name. This can be configured before event imports are available.

The admin visibility controls store global event exclusions and per-player game exclusions in `data/profiles/exclusions.json`. Excluded events are omitted before profile statistics are built; excluded games are removed from that player's generated profile and directory filters. Saving either setting rebuilds the profiles and index.

The `import_markers` row stores a SHA-256 digest of all JSON files in the selected event folder. If the digest is unchanged, the importer skips that event. If raw files change, it re-imports the event with upserts so IDs do not duplicate. The importer also picks the most complete raw folder when multiple paths contain the same start.gg event ID.

The current saved snapshots contain tournament slugs from their URLs, but not tournament IDs or display names. `fetch_events.py` now requests those fields; after refreshing event snapshots, re-importing fills the available tournament metadata.

Before launch, check start.gg's developer terms on caching/storing data and attribution.
