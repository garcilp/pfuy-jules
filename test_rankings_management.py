import json
import sqlite3
import pytest
from pathlib import Path
from scripts.rankings_manager import init_db, seed_existing_rankings, sync_static_rankings
from scripts import serve_site

ROOT = Path(__file__).resolve().parent

def test_rankings_db_seed_and_sync(tmp_path):
    test_db = tmp_path / "test_platfighters.sqlite3"
    con = sqlite3.connect(test_db)
    init_db(con)
    seed_existing_rankings(con)

    cur = con.cursor()
    cur.execute("SELECT count(*) as cnt FROM official_rankings")
    cnt = cur.fetchone()[0]
    assert cnt > 0, "Should have seeded initial rankings"

    res = sync_static_rankings(con)
    assert res["activeCount"] > 0
    con.close()

def test_password_hashing():
    pw = "supersecret123"
    hashed = serve_site.hash_password(pw)
    assert hashed != pw.encode("utf-8")
    assert serve_site.bcrypt.checkpw(pw.encode("utf-8"), hashed)

def test_rate_limiting():
    ip = "192.168.1.100"
    serve_site.LOGIN_ATTEMPTS[ip] = []
    for _ in range(serve_site.RATE_LIMIT_MAX_ATTEMPTS):
        assert serve_site.check_rate_limit(ip) is True
        serve_site.record_login_attempt(ip)
    assert serve_site.check_rate_limit(ip) is False
