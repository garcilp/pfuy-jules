# Production Deployment & Admin Security Guide

This document explains which files/folders are required to publish the Platfighters.uy website, which files are optional, which files should never be publicly uploaded, and how to safely run and protect the administration features.

---

## 1. File & Directory Breakdown

Platfighters.uy is architected as a **static front-end** that loads pre-rendered JSON files. It can either be hosted entirely as a static site (using a static host or CDN like Cloudflare Pages, Netlify, Vercel, or GitHub Pages) or served alongside the backend Python server (`scripts/serve_site.py`) if you need online admin editing.

### A. Mandatory Files & Folders (For Public Site Display)

These files are essential for the public website to render correctly:

- **HTML Page Shells:**
  - `index.html` (Homepage with game hub and recent/upcoming events)
  - `player.html` (Player profiles and match records)
  - `players.html` (Searchable player directory)
  - `event.html` (Event tournament details)
  - `events.html` (Searchable tournament directory)
  - `rankings.html` (Dynamic algorithmic ranking views & systems breakdown)
  - `ranking.html` (Published historical official power ranking articles)
- **Styles & Scripts:**
  - `css/` (All stylesheets: `styles.css`, `home.css`, `creator.css`, `historical-rankings.css`, `themes.css`)
  - `js/` (All client scripts: `app.js`, `home.js`, `players.js`, `event.js`, `events.js`, `rankings.js`, `ranking.js`, `common.js`, `i18n.js`, `theme.js`, `pr-badges.js`)
- **Assets:**
  - `assets/` (Site logo `assets/logo.jpg`, character portraits/stocks/renders `assets/renders/`, and uploaded player photos `assets/players/`)
- **Generated Static Data:**
  - `data/events-index.json` (Directory of events and upcoming tournaments)
  - `data/events/` (Individual event details JSON files)
  - `data/profiles/index.json` (Directory of player profiles)
  - `data/profiles/*.json` (Individual player profile files, excluding internal metadata files if preferred)
  - `data/rankings.json` (Index of published official rankings)
  - `data/rankings/` (Pre-calculated static ranking snapshots)
  - `data/games.json` and `data/characters.json` (Game rosters and character mappings)
  - `data/community_socials.json` (Community Discord / WhatsApp / Instagram links)

---

### B. Optional Files & Folders

These files are only needed under specific conditions:

- `ranking-creator.html` & `js/creator.js`, `js/export.js`:
  - Optional for regular visitors. You can choose to expose the ranking creator publicly so users can create and export personal ranking graphics using canvas export, or keep it restricted.
- `data/draft.json`:
  - Contains default template data for new rankings created in the ranking creator.
- `data/mint.json`:
  - Sample player profile used when browsing `player.html` without a `?player=` parameter.
- `data/profiles/exclusions.json`, `event_groups.json`, `amateur_brackets.json`, `merges.json`:
  - Config files used by build scripts and the admin dashboard to control bracket grouping, canonical identities, and exclusions.

---

### C. Do NOT Upload Publicly (Sensitive / Internal)

The following files and folders should **never** be made publicly downloadable or served in the web root of a public static hosting bucket:

- `startgg-data/platfighters.sqlite3` & `startgg-data/raw/`:
  - The SQLite database and raw API responses contain your local database state, unseeded participant details, and internal markers. They are bulky and not required by client browsers (the frontend consumes JSON from `data/`).
- `server.log` & local configuration logs.
- `test_*.py` & `verify_*.py`:
  - Test suites and test scripts.
- `torneos*.txt` & local batch text files.
- `admin.html` and `js/admin.js` (if choosing a pure static deployment model without backend administration).
- `.env` or any script containing API tokens like `STARTGG_API_TOKEN`.

---

## 2. Admin Password Security: How It Works & How to Protect It

### How Authentication Works in the Codebase

1. **No Client-Side Passwords:**
   The password is **never stored or checked in JavaScript or HTML**. There is no hardcoded password in frontend files.
2. **Server-Side Verification (`scripts/serve_site.py`):**
   - When an administrator enters a password in `admin.html`, a `POST` request is sent to `/api/admin/login`.
   - The server verifies the password in Python using **bcrypt** (or constant-time timing-safe HMAC digest comparison).
   - If authentication succeeds, the server issues an in-memory random session token transmitted via an **`HttpOnly; SameSite=Strict`** cookie and returns an anti-CSRF token (`X-CSRF-Token`).
   - Brute-force attacks are mitigated by built-in **IP-based rate limiting** (maximum 5 failed attempts per 5-minute window).
   - The password itself is configured via the environment variable `PLATFIGHTERS_ADMIN_PASSWORD` (or prompted interactively in the terminal on startup).

---

## 3. Recommended Deployment Architectures

### Architecture A: Static Public Site + Local/Private Admin (Recommended)

Because Platfighters.uy is designed around pre-generated static files:

1. **Deploy Frontend to a Static Host / CDN:**
   - Upload the static assets (`index.html`, `players.html`, `events.html`, `rankings.html`, `ranking.html`, `css/`, `js/`, `data/`, `assets/`) to Cloudflare Pages, GitHub Pages, Netlify, Vercel, or AWS S3 + CloudFront.
   - Do **not** upload `admin.html`, `scripts/serve_site.py`, or `startgg-data/`.
2. **Perform Admin Tasks Locally:**
   - Keep `scripts/serve_site.py` running locally on your private computer (`http://127.0.0.1:8000`).
   - Run profile edits, tournament imports, event exclusions, or official PR creation locally.
   - Commit the generated JSON files in `data/` and push to git to deploy updates automatically.
3. **Security Advantage:**
   - 100% immune to remote attacks on the admin interface because the admin endpoints simply do not exist on the public internet.

---

### Architecture B: Live Public Site with Remote Admin Access

If you want the admin dashboard and Python server running on a remote VPS (e.g., Ubuntu on DigitalOcean, AWS EC2, or Linode):

1. **Never Expose the Python Server Directly to the Web:**
   - `scripts/serve_site.py` binds to `127.0.0.1`. Keep it behind a reverse proxy (such as Nginx or Caddy) with TLS/HTTPS.
2. **Use HTTPS / TLS (Mandatory):**
   - Never transmit admin passwords over unencrypted HTTP. Always use Let's Encrypt or Cloudflare TLS.
3. **Set the Admin Password via Environment Variable:**
   ```bash
   export PLATFIGHTERS_ADMIN_PASSWORD="a-very-strong-unique-passphrase"
   python3 scripts/serve_site.py
   ```
4. **Add a Second Layer of Defense for `/admin.html` and `/api/admin/`:**
   - **Option 1: VPN / Tailscale / WireGuard (Best):** Only allow access to port 8000 or the admin paths from your private Tailscale or VPN IP.
   - **Option 2: Cloudflare Zero Trust / Access:** Place Cloudflare Access in front of `/admin.html` and `/api/admin/*` requiring email OTP or GitHub authentication before reaching the login screen.
   - **Option 3: HTTP Basic Authentication or IP Whitelisting in Nginx:**
     ```nginx
     location /admin.html {
         allow 203.0.113.10; # Your home/office IP
         deny all;
         proxy_pass http://127.0.0.1:8000;
     }

     location /api/admin/ {
         allow 203.0.113.10;
         deny all;
         proxy_pass http://127.0.0.1:8000;
     }
     ```
5. **Protect Database & Internal Folders in Web Server Config:**
   If serving static files directly through Nginx:
   ```nginx
   location ~* (startgg-data|tests|\.sqlite3|\.log|\.env) {
       deny all;
       return 404;
   }
   ```
