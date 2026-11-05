// Platfighters.uy — PR Badges Module
// Faithfully implements the PR Badges Style Sheet:
// - Hexagon ring with placement colors: 1st Gold, 2nd Silver, 3rd Bronze, 4th+ Sky Blue
// - Placement ordinal inside hexagon (1st, 2nd, 3rd, 35th, etc.)
// - Game name (bold) & Period (monospaced: YYYY or YYYY.n)
// - Three badge variants: Large (standalone/resume), Compact (overview), Mini (inline)
// - PR rankings table rows for Game tabs
// - Liquid Glass interactive hover card (works with mouse, keyboard focus-visible, and touch)

(function(global) {
  'use strict';

  // Placement color config
  const PLACEMENT_COLORS = {
    gold: {
      key: 'gold',
      color: 'var(--gold, #eab308)',
      rgb: '234, 179, 8',
      hex: '#eab308',
      tier: '1st',
      label: 'Gold'
    },
    silver: {
      key: 'silver',
      color: '#cbd5e1',
      rgb: '203, 213, 225',
      hex: '#cbd5e1',
      tier: '2nd',
      label: 'Silver'
    },
    bronze: {
      key: 'bronze',
      color: '#f97316',
      rgb: '249, 115, 22',
      hex: '#f97316',
      tier: '3rd',
      label: 'Bronze'
    },
    sky: {
      key: 'sky',
      color: 'var(--sky, #38bdf8)',
      rgb: '56, 189, 248',
      hex: '#38bdf8',
      tier: '4th+',
      label: 'Sky Blue'
    }
  };

  function getPlacementTier(place) {
    const n = Number(place);
    if (!Number.isFinite(n) || n < 1) return PLACEMENT_COLORS.sky;
    if (n === 1) return PLACEMENT_COLORS.gold;
    if (n === 2) return PLACEMENT_COLORS.silver;
    if (n === 3) return PLACEMENT_COLORS.bronze;
    return PLACEMENT_COLORS.sky;
  }

  function getOrdinal(n) {
    if (!Number.isFinite(Number(n)) || Number(n) < 1) return '—';
    const num = Number(n);
    const mod100 = num % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${num}th`;
    const mod10 = num % 10;
    if (mod10 === 1) return `${num}st`;
    if (mod10 === 2) return `${num}nd`;
    if (mod10 === 3) return `${num}rd`;
    return `${num}th`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  function formatDateRange(start, end) {
    if (!start && !end) return '';
    const parse = d => d ? new Date(`${d}T00:00:00`) : null;
    const sDate = parse(start);
    const eDate = parse(end);
    if (!sDate && !eDate) return '';
    const fmtMonthDay = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const sYear = sDate ? sDate.getFullYear() : null;
    const eYear = eDate ? eDate.getFullYear() : null;

    if (sDate && eDate) {
      if (sYear === eYear) {
        return `${fmtMonthDay(sDate)} – ${fmtMonthDay(eDate)}, ${sYear}`;
      }
      return `${fmtMonthDay(sDate)}, ${sYear} – ${fmtMonthDay(eDate)}, ${eYear}`;
    }
    const single = sDate || eDate;
    return single.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Central cache of all official rankings indexed
  let rankingsCache = null;
  let rankingsCachePromise = null;

  async function loadAllRankings() {
    if (rankingsCache) return rankingsCache;
    if (rankingsCachePromise) return rankingsCachePromise;

    rankingsCachePromise = (async () => {
      try {
        const res = await fetch('data/rankings.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const gamesMap = new Map();
        (data.games || []).forEach(g => {
          gamesMap.set(g.id, g);
          gamesMap.set(g.slug, g);
        });

        // Collect all ranking summaries
        const summaries = [];
        const rankingsByGame = data.rankings || {};
        for (const [gameId, list] of Object.entries(rankingsByGame)) {
          (list || []).forEach(item => {
            summaries.push({ ...item, gameId });
          });
        }

        // Fetch detail json for each ranking to get player list & points
        const detailPromises = summaries.map(async summary => {
          try {
            const detailRes = await fetch(`data/rankings/${encodeURIComponent(summary.id)}.json`, { cache: 'no-store' });
            if (!detailRes.ok) return null;
            const detail = await detailRes.json();
            return {
              ...summary,
              ...detail,
              id: summary.id,
              game: detail.game || gamesMap.get(summary.gameId) || { id: summary.gameId, name: summary.gameId },
              players: detail.players || []
            };
          } catch (e) {
            console.warn(`Could not load ranking ${summary.id}`, e);
            return null;
          }
        });

        const fullRankings = (await Promise.all(detailPromises)).filter(Boolean);

        // Sort chronologically ascending to compute period labels (year vs year.n)
        // Group by gameId + startYear
        const gameYearGroups = new Map();
        fullRankings.forEach(r => {
          const gameId = r.game?.id || r.gameId;
          const startYear = (r.period?.start || r.start || '2000').slice(0, 4);
          const key = `${gameId}:${startYear}`;
          if (!gameYearGroups.has(key)) gameYearGroups.set(key, []);
          gameYearGroups.get(key).push(r);
        });

        // Sort each group by start date
        gameYearGroups.forEach((groupRankings) => {
          groupRankings.sort((a, b) => {
            const da = a.period?.start || a.start || '';
            const db = b.period?.start || b.start || '';
            return da.localeCompare(db);
          });
          const hasMultiple = groupRankings.length > 1;
          groupRankings.forEach((r, idx) => {
            const startYear = (r.period?.start || r.start || '2000').slice(0, 4);
            r._periodFormatted = hasMultiple ? `${startYear}.${idx + 1}` : `${startYear}`;
          });
        });

        // Build player index: Map(playerTagLower -> list of rankings with player's entry)
        const playerRankingsMap = new Map();
        fullRankings.forEach(r => {
          (r.players || []).forEach(p => {
            const tag = String(p.tag || '').trim();
            if (!tag) return;
            const norm = tag.toLowerCase();
            if (!playerRankingsMap.has(norm)) playerRankingsMap.set(norm, []);
            playerRankingsMap.get(norm).push({
              ranking: r,
              playerEntry: p,
              placement: p.placement,
              points: p.points,
              date: r.period?.end || r.end || r.period?.start || r.start || ''
            });
          });
        });

        // Sort each player's rankings by date descending (latest first)
        playerRankingsMap.forEach(list => {
          list.sort((a, b) => b.date.localeCompare(a.date));
        });

        rankingsCache = {
          rankings: fullRankings,
          playerRankings: playerRankingsMap,
          games: data.games || []
        };
        return rankingsCache;
      } catch (err) {
        console.error('Failed to load all rankings for badges', err);
        return { rankings: [], playerRankings: new Map(), games: [] };
      }
    })();

    return rankingsCachePromise;
  }

  function getPlayerRankings(playerTag) {
    if (!rankingsCache || !playerTag) return [];
    const norm = String(playerTag).trim().toLowerCase();
    return rankingsCache.playerRankings.get(norm) || [];
  }

  function getLatestPlayerRankingsByGame(playerTag) {
    const list = getPlayerRankings(playerTag);
    const latestByGame = new Map();
    list.forEach(entry => {
      const gid = entry.ranking.game?.id || entry.ranking.gameId;
      if (!latestByGame.has(gid)) {
        latestByGame.set(gid, entry);
      }
    });
    return Array.from(latestByGame.values());
  }

  function getPlayerRankingsForGame(playerTag, gameIdOrSlug) {
    const list = getPlayerRankings(playerTag);
    if (!gameIdOrSlug) return list;
    const target = String(gameIdOrSlug).toLowerCase();
    return list.filter(entry => {
      const g = entry.ranking.game;
      return (g?.id && g.id.toLowerCase() === target) ||
             (g?.slug && g.slug.toLowerCase() === target) ||
             (entry.ranking.gameId && entry.ranking.gameId.toLowerCase() === target);
    });
  }

  /**
   * Generates a crisp SVG Hexagon Ring with rounded aesthetics.
   * Pointy-topped hexagon with smooth border and subtle glow.
   */
  function renderHexagonSvg(tier, size = 56, strokeWidth = 3) {
    const half = size / 2;
    const r = half - strokeWidth - 1;
    // Calculate 6 vertices of a pointy-topped regular hexagon
    // Angles: -90, -30, 30, 90, 150, 210 degrees
    const points = [];
    for (let i = 0; i < 6; i++) {
      const angleDeg = -90 + i * 60;
      const angleRad = (Math.PI / 180) * angleDeg;
      const x = (half + r * Math.cos(angleRad)).toFixed(2);
      const y = (half + r * Math.sin(angleRad)).toFixed(2);
      points.push(`${x},${y}`);
    }
    const pointsStr = points.join(' ');

    return `
      <svg class="pr-badge-hex-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false">
        <defs>
          <filter id="pr-glow-${tier.key}" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="rgba(${tier.rgb}, 0.5)"/>
          </filter>
        </defs>
        <polygon class="pr-hex-bg" points="${pointsStr}" />
        <polygon class="pr-hex-ring" points="${pointsStr}" stroke="${tier.hex}" stroke-width="${strokeWidth}" />
      </svg>
    `;
  }

  /**
   * Generates the Liquid Glass Hover Card HTML
   */
  function renderHoverCard(entry) {
    const r = entry.ranking;
    const p = entry.playerEntry;
    const tier = getPlacementTier(p.placement);
    const ordStr = getOrdinal(p.placement);
    const titleStr = r.title || r.name || 'Power Rankings';
    const gameName = r.game?.name || 'Smash';
    const periodDates = formatDateRange(r.period?.start || r.start, r.period?.end || r.end);
    const pointsStr = (p.points !== undefined && p.points !== null) ? `${Number(p.points).toLocaleString()} pts` : '';
    const rankingUrl = `ranking.html?id=${encodeURIComponent(r.id)}`;

    return `
      <div class="pr-hover-card glass tier-${tier.key}" role="tooltip" aria-hidden="true">
        <div class="pr-card-header">
          <div class="pr-card-placement-badge tier-${tier.key}">
            <span class="pr-card-ord">${escapeHtml(ordStr)}</span>
          </div>
          <div class="pr-card-title-wrap">
            <h4 class="pr-card-title">${escapeHtml(titleStr)}</h4>
            <div class="pr-card-meta">${escapeHtml(gameName)}${periodDates ? ` <span class="sep">·</span> ${escapeHtml(periodDates)}` : ''}</div>
          </div>
        </div>
        ${pointsStr ? `
        <div class="pr-card-body">
          <div class="pr-card-stat">
            <span class="pr-card-stat-label">Total Points</span>
            <span class="pr-card-stat-val mono">${escapeHtml(pointsStr)}</span>
          </div>
        </div>` : ''}
        <div class="pr-card-footer">
          <span class="pr-card-link-text">Read ranking <span class="arr" aria-hidden="true">→</span></span>
        </div>
      </div>
    `;
  }

  /**
   * Large — Standalone Variant
   * Used in standalone contexts such as printable player resumes and shareable images.
   */
  function renderLarge(entry, options = {}) {
    const r = entry.ranking;
    const p = entry.playerEntry;
    const tier = getPlacementTier(p.placement);
    const ordStr = getOrdinal(p.placement);
    const gameName = r.game?.name || 'Smash';
    const periodStr = r._periodFormatted || (r.period?.start || r.start || '2025').slice(0, 4);
    const rankingUrl = `ranking.html?id=${encodeURIComponent(r.id)}`;
    const extraClass = options.className || '';

    return `
      <a class="pr-badge pr-badge-lg tier-${tier.key} glass ${extraClass}" href="${escapeHtml(rankingUrl)}" aria-label="${escapeHtml(gameName)} ${escapeHtml(periodStr)} Ranking: ${escapeHtml(ordStr)} place" tabindex="0">
        <div class="pr-badge-hex-wrap">
          ${renderHexagonSvg(tier, 76, 4)}
          <span class="pr-badge-ord">${escapeHtml(ordStr)}</span>
        </div>
        <div class="pr-badge-content">
          <span class="pr-badge-game">${escapeHtml(gameName)}</span>
          <span class="pr-badge-period mono">${escapeHtml(periodStr)}</span>
        </div>
        ${renderHoverCard(entry)}
      </a>
    `;
  }

  /**
   * Compact — Overview Variant
   * Used on the Overview tab, showing the latest ranking for each game.
   */
  function renderCompact(entry, options = {}) {
    const r = entry.ranking;
    const p = entry.playerEntry;
    const tier = getPlacementTier(p.placement);
    const ordStr = getOrdinal(p.placement);
    const gameName = r.game?.name || 'Smash';
    const periodStr = r._periodFormatted || (r.period?.start || r.start || '2025').slice(0, 4);
    const rankingUrl = `ranking.html?id=${encodeURIComponent(r.id)}`;
    const extraClass = options.className || '';

    return `
      <a class="pr-badge pr-badge-compact tier-${tier.key} glass ${extraClass}" href="${escapeHtml(rankingUrl)}" aria-label="${escapeHtml(gameName)} ${escapeHtml(periodStr)}: ${escapeHtml(ordStr)} place" tabindex="0">
        <div class="pr-badge-hex-wrap">
          ${renderHexagonSvg(tier, 48, 3)}
          <span class="pr-badge-ord">${escapeHtml(ordStr)}</span>
        </div>
        <div class="pr-badge-content">
          <span class="pr-badge-game">${escapeHtml(gameName)}</span>
          <span class="pr-badge-period mono">${escapeHtml(periodStr)}</span>
        </div>
        ${renderHoverCard(entry)}
      </a>
    `;
  }

  /**
   * Mini — Inline Variant
   * Used alongside player tags in lists and rankings.
   */
  function renderMini(entry, options = {}) {
    const r = entry.ranking;
    const p = entry.playerEntry;
    const tier = getPlacementTier(p.placement);
    const ordStr = getOrdinal(p.placement);
    const gameName = r.game?.name || 'Smash';
    const periodStr = r._periodFormatted || (r.period?.start || r.start || '2025').slice(0, 4);
    const rankingUrl = `ranking.html?id=${encodeURIComponent(r.id)}`;
    const extraClass = options.className || '';

    return `
      <a class="pr-badge pr-badge-mini tier-${tier.key} ${extraClass}" href="${escapeHtml(rankingUrl)}" title="${escapeHtml(gameName)} ${escapeHtml(periodStr)}: ${escapeHtml(ordStr)}" aria-label="${escapeHtml(gameName)} ${escapeHtml(periodStr)}: ${escapeHtml(ordStr)}" tabindex="0">
        <div class="pr-badge-hex-wrap">
          ${renderHexagonSvg(tier, 26, 2)}
          <span class="pr-badge-ord">${escapeHtml(ordStr)}</span>
        </div>
        ${renderHoverCard(entry)}
      </a>
    `;
  }

  /**
   * Renders the PR Rankings table for game tabs
   */
  function renderGameRankingsTable(entries, gameName) {
    if (!entries || !entries.length) {
      return '';
    }

    const rowsHtml = entries.map(entry => {
      const r = entry.ranking;
      const p = entry.playerEntry;
      const tier = getPlacementTier(p.placement);
      const ordStr = getOrdinal(p.placement);
      const periodStr = r._periodFormatted || (r.period?.start || r.start || '2025').slice(0, 4);
      const rankingUrl = `ranking.html?id=${encodeURIComponent(r.id)}`;
      const datesStr = formatDateRange(r.period?.start || r.start, r.period?.end || r.end);
      const pointsDisplay = (p.points !== undefined && p.points !== null) ? `${Number(p.points).toLocaleString()} pts` : '—';
      const entrants = r.players ? `${r.players.length} ranked` : '';

      return `
        <div class="pr-table-row tier-${tier.key}">
          <div class="pr-table-badge-cell">
            <a class="pr-badge pr-badge-compact tier-${tier.key} glass" href="${escapeHtml(rankingUrl)}" aria-label="${escapeHtml(r.title)}: ${escapeHtml(ordStr)}" tabindex="0">
              <div class="pr-badge-hex-wrap">
                ${renderHexagonSvg(tier, 44, 3)}
                <span class="pr-badge-ord">${escapeHtml(ordStr)}</span>
              </div>
              <div class="pr-badge-content">
                <span class="pr-badge-game">${escapeHtml(r.game?.name || gameName || '')}</span>
                <span class="pr-badge-period mono">${escapeHtml(periodStr)}</span>
              </div>
              ${renderHoverCard(entry)}
            </a>
          </div>
          <div class="pr-table-info-cell">
            <a class="pr-table-title-link" href="${escapeHtml(rankingUrl)}">
              <b>${escapeHtml(r.title || r.name)}</b>
            </a>
            <small class="muted">${escapeHtml(datesStr)} ${entrants ? `· ${escapeHtml(entrants)}` : ''}</small>
          </div>
          <div class="pr-table-points-cell mono">
            ${escapeHtml(pointsDisplay)}
          </div>
          <div class="pr-table-action-cell">
            <a class="pr-table-view-btn" href="${escapeHtml(rankingUrl)}">Read ranking →</a>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="panel glass pr-rankings-panel">
        <div class="pr-panel-head">
          <h2>Power Rankings</h2>
          <span class="muted mono">${entries.length} official ranking${entries.length === 1 ? '' : 's'}</span>
        </div>
        <div class="pr-rankings-table">
          ${rowsHtml}
        </div>
      </div>
    `;
  }

  /**
   * Attach global event listeners for touch devices and card positioning
   */
  function initHoverCardInteractions() {
    // For touch devices: tapping a badge once opens the hover card, tapping again follows the link
    document.addEventListener('click', function(e) {
      const badge = e.target.closest('.pr-badge');
      const isTouch = window.matchMedia('(hover: none)').matches;
      if (!badge) {
        // Click outside closes any active touch cards
        document.querySelectorAll('.pr-badge.touch-active').forEach(b => b.classList.remove('touch-active'));
        return;
      }
      if (isTouch) {
        if (!badge.classList.contains('touch-active')) {
          e.preventDefault();
          document.querySelectorAll('.pr-badge.touch-active').forEach(b => b.classList.remove('touch-active'));
          badge.classList.add('touch-active');
        }
      }
    });

    // Close touch active on Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        document.querySelectorAll('.pr-badge.touch-active').forEach(b => b.classList.remove('touch-active'));
      }
    });
  }

  // Initialize on script load
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initHoverCardInteractions);
    } else {
      initHoverCardInteractions();
    }
  }

  // Public API
  const PRBadges = {
    loadAllRankings,
    getPlayerRankings,
    getLatestPlayerRankingsByGame,
    getPlayerRankingsForGame,
    getPlacementTier,
    getOrdinal,
    renderLarge,
    renderCompact,
    renderMini,
    renderGameRankingsTable,
    formatDateRange,
    COLORS: PLACEMENT_COLORS
  };

  global.PRBadges = PRBadges;

})(typeof window !== 'undefined' ? window : this);
