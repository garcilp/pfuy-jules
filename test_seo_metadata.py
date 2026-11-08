"""Tests for Page Titles and Open Graph Metadata across Platfighters.uy."""

import socket
import threading
import time
import urllib.request
import pytest
from pathlib import Path
from scripts.metadata_generator import (
    get_page_metadata,
    inject_html_metadata,
    load_profile_by_id_or_slug,
    load_ranking_by_id,
    load_event_by_slug,
)
from scripts.serve_site import ThreadingHTTPServer, Handler

ROOT = Path(__file__).resolve().parent


@pytest.fixture(scope="module")
def local_server():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    time.sleep(0.5)

    yield f"http://127.0.0.1:{port}"

    server.shutdown()


def test_player_profile_lookup():
    p1 = load_profile_by_id_or_slug("557903")
    assert p1 is not None
    assert p1["player"]["tag"] == "Mitsu"

    p2 = load_profile_by_id_or_slug("3326405")
    assert p2 is not None
    assert p2["player"]["tag"] == "Catwo"


def test_player_profile_titles_and_metadata():
    meta1 = get_page_metadata("player.html", "player=557903", "platfighters.uy")
    assert meta1["title"] == "Mitsu · Platfighters.uy"
    assert "Mitsu" in meta1["title"]
    assert meta1["type"] == "profile"
    assert meta1["url"] == "https://platfighters.uy/player.html?player=557903"
    assert meta1["image"].startswith("https://platfighters.uy/")
    assert meta1["site_name"] == "Platfighters.uy"
    assert meta1["locale"] == "es_UY"
    assert "Sheik" in meta1["description"] or "tournaments" in meta1["description"]

    meta2 = get_page_metadata("player.html", "player=3326405", "platfighters.uy")
    assert meta2["title"] == "Catwo · Platfighters.uy"
    assert meta2["title"] != meta1["title"]
    assert meta2["url"] != meta1["url"]
    assert meta2["description"] != meta1["description"]


def test_ranking_article_titles_and_metadata():
    meta = get_page_metadata("ranking.html", "id=roa-power-ranking-2023", "platfighters.uy")
    assert meta["title"] == "Power Ranking 2023 · Platfighters.uy"
    assert meta["type"] == "article"
    assert meta["url"] == "https://platfighters.uy/ranking.html?id=roa-power-ranking-2023"
    assert meta["image"].startswith("https://platfighters.uy/")
    assert "Rivals of Aether" in meta["description"] or "PR" in meta["description"]


def test_event_titles_and_metadata():
    meta = get_page_metadata("event.html", "tournament=montevideo-melee-monthly-2019-8", "platfighters.uy")
    assert meta["title"] == "Montevideo Melee Monthly 2019 #8 · Platfighters.uy"
    assert meta["type"] == "website"
    assert meta["url"] == "https://platfighters.uy/event.html?tournament=montevideo-melee-monthly-2019-8"
    assert meta["image"].startswith("http")
    assert "52 entrants" in meta["description"] or "Melee" in meta["description"]


def test_static_pages_titles_and_metadata():
    pages = [
        ("index.html", "", "Platfighters.uy · Uruguayan Platform Fighter Scene & Rankings"),
        ("players.html", "", "Players · Platfighters.uy"),
        ("events.html", "", "Events & Tournaments · Platfighters.uy"),
        ("rankings.html", "", "Rankings & Leaderboards · Platfighters.uy"),
        ("ranking-creator.html", "", "Ranking Creator · Platfighters.uy"),
        ("admin.html", "", "Site Management · Platfighters.uy"),
    ]
    for page, q, expected_title in pages:
        meta = get_page_metadata(page, q, "platfighters.uy")
        assert meta["title"] == expected_title
        assert meta["site_name"] == "Platfighters.uy"
        assert meta["url"].startswith("https://platfighters.uy")
        assert meta["image"].startswith("https://platfighters.uy")


def test_server_raw_html_serving(local_server):
    # Player 1 raw HTML
    req1 = urllib.request.urlopen(f"{local_server}/player.html?player=557903")
    raw1 = req1.read().decode("utf-8")
    assert "<title>Mitsu · Platfighters.uy</title>" in raw1
    assert '<meta property="og:title" content="Mitsu · Platfighters.uy">' in raw1
    assert '<meta property="og:type" content="profile">' in raw1
    assert f'<meta property="og:url" content="{local_server}/player.html?player=557903">' in raw1
    assert '<meta property="og:site_name" content="Platfighters.uy">' in raw1
    assert '<meta property="og:locale" content="es_UY">' in raw1

    # Player 2 raw HTML
    req2 = urllib.request.urlopen(f"{local_server}/player.html?player=3326405")
    raw2 = req2.read().decode("utf-8")
    assert "<title>Catwo · Platfighters.uy</title>" in raw2
    assert '<meta property="og:title" content="Catwo · Platfighters.uy">' in raw2

    # Ranking article raw HTML
    req3 = urllib.request.urlopen(f"{local_server}/ranking.html?id=roa-power-ranking-2023")
    raw3 = req3.read().decode("utf-8")
    assert "<title>Power Ranking 2023 · Platfighters.uy</title>" in raw3
    assert '<meta property="og:type" content="article">' in raw3

    # Event page raw HTML
    req4 = urllib.request.urlopen(f"{local_server}/event.html?tournament=montevideo-melee-monthly-2019-8")
    raw4 = req4.read().decode("utf-8")
    assert "<title>Montevideo Melee Monthly 2019 #8 · Platfighters.uy</title>" in raw4

    # Directory pages raw HTML
    req_players = urllib.request.urlopen(f"{local_server}/players.html")
    raw_players = req_players.read().decode("utf-8")
    assert "<title>Players · Platfighters.uy</title>" in raw_players

    req_events = urllib.request.urlopen(f"{local_server}/events.html")
    raw_events = req_events.read().decode("utf-8")
    assert "<title>Events &amp; Tournaments · Platfighters.uy</title>" in raw_events

    req_rankings = urllib.request.urlopen(f"{local_server}/rankings.html")
    raw_rankings = req_rankings.read().decode("utf-8")
    assert "<title>Rankings &amp; Leaderboards · Platfighters.uy</title>" in raw_rankings

    # Ensure no duplicate title tags
    assert raw1.count("<title>") == 1
    assert raw1.count("</title>") == 1
    assert raw3.count("<title>") == 1
