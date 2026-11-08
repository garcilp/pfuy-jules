"""Official power rankings database model, migration, and static synchronization."""

import json
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATABASE = ROOT / "startgg-data" / "platfighters.sqlite3"
RANKINGS_DATA_DIR = ROOT / "data" / "rankings"
RANKINGS_INDEX_PATH = ROOT / "data" / "rankings.json"
GAMES_PATH = ROOT / "data" / "games.json"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS official_rankings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    game_slug TEXT NOT NULL,
    game_id TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    status TEXT NOT NULL,
    published_by TEXT,
    intro TEXT,
    players_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    is_archived INTEGER NOT NULL DEFAULT 0,
    image_box TEXT
);
CREATE INDEX IF NOT EXISTS idx_official_rankings_game ON official_rankings(game_slug, is_archived);
"""


def init_db(con: sqlite3.Connection = None):
    close_con = False
    if con is None:
        DATABASE.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(DATABASE)
        close_con = True
    try:
        con.executescript(SCHEMA_SQL)
        # Check and migrate image_box column if missing in existing table
        cur = con.cursor()
        cur.execute("PRAGMA table_info(official_rankings)")
        cols = [r[1] for r in cur.fetchall()]
        if "image_box" not in cols:
            con.execute("ALTER TABLE official_rankings ADD COLUMN image_box TEXT")
        con.commit()
    finally:
        if close_con:
            con.close()


def atomic_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    tmp_path.replace(path)


def seed_existing_rankings(con: sqlite3.Connection = None):
    """Seed existing rankings from data/rankings.json and data/rankings/*.json into SQLite."""
    close_con = False
    if con is None:
        con = sqlite3.connect(DATABASE)
        close_con = True
    con.row_factory = sqlite3.Row
    try:
        init_db(con)
        cur = con.cursor()
        cur.execute("SELECT COUNT(*) as count FROM official_rankings")
        if cur.fetchone()["count"] > 0:
            return

        if not RANKINGS_INDEX_PATH.exists():
            return

        with RANKINGS_INDEX_PATH.open(encoding="utf-8") as f:
            index_data = json.load(f)

        games_meta = {g["id"]: g for g in index_data.get("games", [])}
        now = int(time.time())

        for game_id, ranking_items in index_data.get("rankings", {}).items():
            game_info = games_meta.get(game_id, {"id": game_id, "name": game_id, "slug": game_id})
            for item in ranking_items:
                rid = item.get("id")
                if not rid:
                    continue
                detail_file = RANKINGS_DATA_DIR / f"{rid}.json"
                if detail_file.exists():
                    try:
                        with detail_file.open(encoding="utf-8") as df:
                            full_ranking = json.load(df)
                        players = full_ranking.get("players", [])
                        title = full_ranking.get("title", item.get("name", rid))
                        start = full_ranking.get("period", {}).get("start", item.get("start", ""))
                        end = full_ranking.get("period", {}).get("end", item.get("end", ""))
                        status = full_ranking.get("status", item.get("status", "seasonal"))
                        published_by = full_ranking.get("publishedBy", "")
                        intro = full_ranking.get("intro", "")
                        img_box_val = full_ranking.get("imageBox")
                        image_box_str = json.dumps(img_box_val, ensure_ascii=False) if (img_box_val and isinstance(img_box_val, dict) and img_box_val.get("url")) else None
                    except Exception:
                        players = []
                        title = item.get("name", rid)
                        start = item.get("start", "")
                        end = item.get("end", "")
                        status = item.get("status", "seasonal")
                        published_by = ""
                        intro = ""
                        image_box_str = None
                else:
                    players = []
                    top_player = item.get("top")
                    num_players = item.get("players", 0)
                    if top_player:
                        players.append({"placement": 1, "tag": top_player})
                        for p_idx in range(2, num_players + 1):
                            players.append({"placement": p_idx, "tag": f"Player {p_idx}"})
                    title = item.get("name", rid)
                    start = item.get("start", "")
                    end = item.get("end", "")
                    status = item.get("status", "seasonal")
                    published_by = ""
                    intro = ""
                    image_box_str = None

                cur.execute(
                    """
                    INSERT OR REPLACE INTO official_rankings (
                        id, title, game_slug, game_id, period_start, period_end,
                        status, published_by, intro, players_json,
                        created_at, updated_at, is_archived, image_box
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                    """,
                    (
                        rid,
                        title,
                        game_info.get("slug", game_id),
                        game_info.get("id", game_id),
                        start,
                        end,
                        status,
                        published_by,
                        intro,
                        json.dumps(players, ensure_ascii=False),
                        now,
                        now,
                        image_box_str,
                    ),
                )
        con.commit()
    finally:
        if close_con:
            con.close()


def sync_static_rankings(con: sqlite3.Connection = None):
    """
    Regenerates static data/rankings/<id>.json and data/rankings.json from active SQLite rankings.
    Uses atomic file writing.
    """
    close_con = False
    if con is None:
        con = sqlite3.connect(DATABASE)
        close_con = True
    con.row_factory = sqlite3.Row
    try:
        init_db(con)
        cur = con.cursor()

        games_list = []
        if GAMES_PATH.exists():
            try:
                with GAMES_PATH.open(encoding="utf-8") as gf:
                    games_list = json.load(gf)
            except Exception:
                pass
        if not games_list and RANKINGS_INDEX_PATH.exists():
            try:
                with RANKINGS_INDEX_PATH.open(encoding="utf-8") as rf:
                    games_list = json.load(rf).get("games", [])
            except Exception:
                pass

        game_map = {g.get("id"): g for g in games_list}
        game_slug_to_id = {g.get("slug"): g.get("id") for g in games_list}

        cur.execute("SELECT * FROM official_rankings ORDER BY period_end DESC, created_at DESC")
        rows = cur.fetchall()

        rankings_by_game = {g.get("id"): [] for g in games_list}
        active_rankings = []

        for row in rows:
            is_archived = bool(row["is_archived"])
            rid = row["id"]
            gid = row["game_id"]
            if gid not in rankings_by_game:
                gid = game_slug_to_id.get(row["game_slug"], gid)
                if gid not in rankings_by_game:
                    rankings_by_game[gid] = []

            try:
                players = json.loads(row["players_json"])
            except Exception:
                players = []

            game_info = game_map.get(gid) or {
                "id": gid,
                "name": row["game_slug"],
                "slug": row["game_slug"],
            }

            full_obj = {
                "id": rid,
                "title": row["title"],
                "game": {
                    "id": game_info.get("id", gid),
                    "name": game_info.get("name", row["game_slug"]),
                    "slug": game_info.get("slug", row["game_slug"]),
                },
                "period": {
                    "start": row["period_start"],
                    "end": row["period_end"],
                },
                "publishedBy": row["published_by"] or "",
                "intro": row["intro"] or "",
                "status": row["status"],
                "players": players,
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }

            if "image_box" in row.keys() and row["image_box"]:
                try:
                    ib = json.loads(row["image_box"])
                    if isinstance(ib, dict) and ib.get("url"):
                        full_obj["imageBox"] = ib
                except Exception:
                    pass

            if not is_archived:
                active_rankings.append(full_obj)
                detail_path = RANKINGS_DATA_DIR / f"{rid}.json"
                atomic_json(detail_path, full_obj)

                top_tag = players[0].get("tag", "") if players else ""
                rankings_by_game[gid].append({
                    "id": rid,
                    "name": row["title"],
                    "start": row["period_start"],
                    "end": row["period_end"],
                    "status": row["status"],
                    "top": top_tag,
                    "players": len(players),
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                })
            else:
                detail_path = RANKINGS_DATA_DIR / f"{rid}.json"
                if detail_path.exists():
                    try:
                        detail_path.unlink()
                    except OSError:
                        pass

        index_data = {
            "games": games_list,
            "rankings": rankings_by_game,
        }
        atomic_json(RANKINGS_INDEX_PATH, index_data)
        return {"activeCount": len(active_rankings), "totalCount": len(rows)}
    finally:
        if close_con:
            con.close()


if __name__ == "__main__":
    seed_existing_rankings()
    res = sync_static_rankings()
    print("Rankings sync complete:", res)
