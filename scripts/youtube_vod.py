"""YouTube VOD Data API and playlist processing helper functions.

Keeps YouTube API interactions independent of database operations.
Uses Python standard library (urllib.request) with zero external dependencies.
"""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"
DEFAULT_TIMEOUT = 15  # seconds

# Playlist ID regular expression matching standard YouTube playlist IDs (e.g. PL..., UU..., FL..., etc.)
PLAYLIST_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_\-]+$")


class YouTubeAPIError(Exception):
    """Raised when YouTube API returns an error or fails."""
    pass


class YouTubeConfigError(Exception):
    """Raised when YouTube API key is not configured."""
    pass


def extract_playlist_id(url_or_id: str) -> str | None:
    """Validate and extract a YouTube playlist ID from a URL or raw ID string.

    Supports:
      - https://www.youtube.com/playlist?list=PLxxx
      - https://m.youtube.com/playlist?list=PLxxx
      - https://youtube.com/playlist?list=PLxxx
      - https://www.youtube.com/watch?v=xxx&list=PLxxx
      - https://youtu.be/xxx?list=PLxxx
      - Direct playlist ID strings (e.g., PLxxx)
    Rejects invalid URLs, channels, single videos without list, or non-YouTube domains.
    """
    if not url_or_id or not isinstance(url_or_id, str):
        return None

    raw = url_or_id.strip()
    if not raw:
        return None

    # If it looks like a direct playlist ID (starts with PL, UU, FL, RD, OL, etc. and no slashes/protocol)
    if "/" not in raw and "?" not in raw and "&" not in raw and ":" not in raw:
        if PLAYLIST_ID_PATTERN.match(raw) and len(raw) >= 12:
            return raw
        return None

    try:
        # Prepend scheme if missing but starts with domain
        if not raw.startswith("http://") and not raw.startswith("https://"):
            raw = "https://" + raw

        parsed = urllib.parse.urlparse(raw)
        host = (parsed.netloc or "").lower()
        if host.startswith("www."):
            host = host[4:]
        elif host.startswith("m."):
            host = host[2:]

        if host not in ("youtube.com", "youtu.be"):
            return None

        qs = urllib.parse.parse_qs(parsed.query)
        playlist_id = qs.get("list", [None])[0]
        if not playlist_id:
            return None

        playlist_id = playlist_id.strip()
        if PLAYLIST_ID_PATTERN.match(playlist_id):
            return playlist_id
        return None
    except Exception:
        return None


def is_valid_playlist_url(url: str) -> bool:
    """Return True if url contains a valid YouTube playlist identifier."""
    return extract_playlist_id(url) is not None


def get_youtube_api_key(api_key: str | None = None) -> str:
    """Return the YouTube API key from parameter or environment, raising YouTubeConfigError if missing."""
    key = (api_key or os.environ.get("YOUTUBE_API_KEY") or "").strip()
    if not key:
        raise YouTubeConfigError(
            "YouTube API key is not configured. Set the YOUTUBE_API_KEY environment variable on the server."
        )
    return key


def fetch_playlist_videos(playlist_id_or_url: str, api_key: str | None = None) -> list[dict]:
    """Fetch all videos from a YouTube playlist using the YouTube Data API v3.

    Handles pagination, gracefully handles unavailable/private/deleted videos,
    and returns normalized video metadata dictionaries:
      - youtube_video_id: str | None
      - youtube_playlist_item_id: str
      - youtube_title: str
      - youtube_thumbnail_url: str | None
      - availability: 'available' | 'unavailable'

    Raises:
      - ValueError if playlist ID is invalid.
      - YouTubeConfigError if API key is not set.
      - YouTubeAPIError on network, quota, or API errors.
    """
    playlist_id = extract_playlist_id(playlist_id_or_url)
    if not playlist_id:
        raise ValueError(f"Invalid YouTube playlist URL or ID: {playlist_id_or_url}")

    key = get_youtube_api_key(api_key)
    videos = []
    next_page_token = None

    while True:
        params = {
            "part": "snippet,status",
            "playlistId": playlist_id,
            "maxResults": "50",
            "key": key,
        }
        if next_page_token:
            params["pageToken"] = next_page_token

        url = f"{YOUTUBE_API_BASE}/playlistItems?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "PlatfightersUY-VODManager/1.0",
                "Accept": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as response:
                raw_data = response.read().decode("utf-8")
                data = json.loads(raw_data)
        except urllib.error.HTTPError as err:
            err_body = ""
            try:
                err_body = err.read().decode("utf-8")
                err_json = json.loads(err_body)
                err_msg = err_json.get("error", {}).get("message", err.reason)
            except Exception:
                err_msg = err.reason or str(err)
            if err.code == 404:
                raise YouTubeAPIError(f"YouTube playlist not found (404): {playlist_id}") from err
            elif err.code in (400, 403):
                raise YouTubeAPIError(f"YouTube API error ({err.code}): {err_msg}") from err
            else:
                raise YouTubeAPIError(f"YouTube API request failed ({err.code}): {err_msg}") from err
        except urllib.error.URLError as err:
            raise YouTubeAPIError(f"Network error connecting to YouTube API: {err.reason}") from err
        except json.JSONDecodeError as err:
            raise YouTubeAPIError(f"Failed to parse YouTube API response: {err}") from err
        except Exception as err:
            raise YouTubeAPIError(f"Unexpected error communicating with YouTube API: {err}") from err

        items = data.get("items", [])
        for item in items:
            playlist_item_id = item.get("id")
            snippet = item.get("snippet") or {}
            item_status = item.get("status") or {}
            privacy_status = item_status.get("privacyStatus", "").lower()

            resource_id = snippet.get("resourceId") or {}
            video_id = resource_id.get("videoId")
            title = (snippet.get("title") or "").strip()

            is_unavailable = False
            lower_title = title.lower()
            if privacy_status == "private" or "private video" in lower_title:
                is_unavailable = True
            elif "deleted video" in lower_title or not video_id:
                is_unavailable = True

            availability = "unavailable" if is_unavailable else "available"

            thumbnails = snippet.get("thumbnails") or {}
            thumb_url = None
            for quality in ("standard", "medium", "high", "default", "maxres"):
                if quality in thumbnails and thumbnails[quality].get("url"):
                    thumb_url = thumbnails[quality]["url"]
                    break

            if not title:
                title = "Untitled Video" if availability == "available" else "Unavailable Video"

            videos.append({
                "youtube_video_id": video_id if not is_unavailable else (video_id or None),
                "youtube_playlist_item_id": playlist_item_id,
                "youtube_title": title,
                "youtube_thumbnail_url": thumb_url,
                "availability": availability,
            })

        next_page_token = data.get("nextPageToken")
        if not next_page_token:
            break

    return videos
