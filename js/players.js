const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let players = [];
const list = $('#player-list');
const status = $('#directory-status');
const search = $('#player-search');
const gameFilter = $('#game-filter');
const playerSort = $('#player-sort');
const playerView = $('#player-view');
const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

const batchSize = 36;
let visibleCount = batchSize;
let scrollObserver = null;

function cleanupObserver() {
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
}

function setupInfiniteScroll(totalCount) {
  cleanupObserver();

  const sentinel = $('#scroll-sentinel');
  if (!sentinel || visibleCount >= totalCount) return;

  scrollObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      visibleCount += batchSize;
      render();
    }
  }, { rootMargin: '200px' });

  scrollObserver.observe(sentinel);
}

function resetPagination() {
  visibleCount = batchSize;
  cleanupObserver();
  window.scrollTo(0, 0);
}

function getPlayerEventCount(entry, selectedGame) {
  const games = entry.games || entry.profile?.games || [];
  if (selectedGame) {
    const target = games.find(g => (g.slug || g.id) === selectedGame);
    return Number(target?.events || 0);
  }
  if (entry.events !== undefined) return Number(entry.events) || 0;
  return games.reduce((total, g) => total + (Number(g.events) || 0), 0);
}

function getPlayerLastEventDate(entry, selectedGame) {
  const games = entry.games || entry.profile?.games || [];
  if (selectedGame) {
    const target = games.find(g => (g.slug || g.id) === selectedGame);
    if (target?.lastEventDate) return target.lastEventDate;
    if (entry.profile) {
      const pGame = (entry.profile.games || []).find(g => (g.slug || g.id) === selectedGame);
      const dates = (pGame?.results || []).map(r => r.date).filter(Boolean);
      return dates.length ? dates.sort().reverse()[0] : '';
    }
    return '';
  }
  if (entry.lastEventDate) return entry.lastEventDate;
  if (entry.profile) {
    const dates = (entry.profile.games || []).flatMap(g => (g.results || []).map(r => r.date)).filter(Boolean);
    return dates.length ? dates.sort().reverse()[0] : '';
  }
  const allGameDates = games.map(g => g.lastEventDate).filter(Boolean);
  return allGameDates.length ? allGameDates.sort().reverse()[0] : '';
}

function sortMedals(rankingsList) {
  // Medal hierarchy priority:
  // 1. Placement (1st > 2nd > 3rd > 4th...)
  // 2. Tier hierarchy (Gold: 1, Silver: 2, Bronze: 3, Sky Blue: 4)
  // 3. Chronological recency (latest first)
  const tierWeights = { gold: 1, silver: 2, bronze: 3, sky: 4 };
  return [...rankingsList].sort((a, b) => {
    const placeA = Number(a.placement ?? a.playerEntry?.placement ?? 9999);
    const placeB = Number(b.placement ?? b.playerEntry?.placement ?? 9999);
    if (placeA !== placeB) return placeA - placeB;

    const tierA = window.PRBadges ? tierWeights[window.PRBadges.getPlacementTier(placeA).key] : 4;
    const tierB = window.PRBadges ? tierWeights[window.PRBadges.getPlacementTier(placeB).key] : 4;
    if (tierA !== tierB) return tierA - tierB;

    const dateA = a.date || a.ranking?.period?.end || a.ranking?.end || a.ranking?.period?.start || a.ranking?.start || '';
    const dateB = b.date || b.ranking?.period?.end || b.ranking?.end || b.ranking?.period?.start || b.ranking?.start || '';
    return dateB.localeCompare(dateA);
  });
}

async function loadPlayers() {
  try {
    if (window.PRBadges) {
      await window.PRBadges.loadAllRankings();
    }
    const response = await fetch('data/profiles/index.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('No generated player directory is available yet.');
    const entries = await response.json();
    if (entries.length && (entries[0].games || entries[0].events !== undefined)) {
      players = entries;
    } else {
      players = await Promise.all(entries.map(async entry => {
        const profileResponse = await fetch(`data/profiles/${encodeURIComponent(entry.slug)}.json`);
        if (!profileResponse.ok) return null;
        return { ...entry, profile: await profileResponse.json() };
      }));
      players = players.filter(Boolean);
    }
    populateGameFilter();
    render();
  } catch (error) {
    status.textContent = error.message;
    list.innerHTML = '<div class="panel glass empty-state"><h2>No player profiles yet</h2><p class="muted">Import tournament data and generate player profiles to populate this directory.</p></div>';
  }
}

// Keep the directory's initial presentation in sync with its selected control.
playerView.value = 'condensed';

function populateGameFilter() {
  const games = new Map();
  players.forEach(entry => {
    const gameList = entry.games || entry.profile?.games || [];
    gameList.forEach(game => {
      const id = game.slug || game.id;
      if (id && game.name) games.set(id, game.name);
    });
  });
  const currentVal = gameFilter.value;
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  gameFilter.innerHTML = `<option value="">${isEs ? 'Todos los juegos' : 'All games'}</option>` +
    [...games].sort((a, b) => nameCollator.compare(a[1], b[1]))
      .map(([id, name]) => `<option value="${esc(id)}"${id === currentVal ? ' selected' : ''}>${esc(name)}</option>`).join('');
}

function render() {
  const condensed = playerView.value === 'condensed';
  list.classList.toggle('condensed', condensed);
  const query = search.value.trim().toLocaleLowerCase();
  const selectedGame = gameFilter.value;
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const sortBy = playerSort ? playerSort.value : 'tag';

  const shown = players.filter(entry => {
    const p = entry.profile?.player || entry;
    const games = entry.games || entry.profile?.games || [];
    const location = p.city || p.country
      ? [p.city, p.country || 'Uruguay'].filter(Boolean).join(', ')
      : (p.location || '');
    const includesGame = !selectedGame || games.some(game => (game.slug || game.id) === selectedGame);
    const matchesSearch = [entry.tag, p.tag, p.sponsor, p.city, p.country, location, ...(p.aliases || []), ...games.map(g => g.name)].join(' ').toLocaleLowerCase().includes(query);
    return includesGame && matchesSearch;
  }).sort((a, b) => {
    if (sortBy === 'events') {
      const countA = getPlayerEventCount(a, selectedGame);
      const countB = getPlayerEventCount(b, selectedGame);
      if (countA !== countB) return countB - countA;
    } else if (sortBy === 'recent') {
      const dateA = getPlayerLastEventDate(a, selectedGame) || '';
      const dateB = getPlayerLastEventDate(b, selectedGame) || '';
      if (dateA !== dateB) {
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateB.localeCompare(dateA);
      }
    }
    return nameCollator.compare(a.profile?.player?.tag || a.tag, b.profile?.player?.tag || b.tag) || nameCollator.compare(a.slug, b.slug);
  });

  const totalFiltered = shown.length;
  const visibleList = shown.slice(0, visibleCount);

  if (totalFiltered <= visibleCount) {
    status.textContent = isEs
      ? `${totalFiltered} jugador${totalFiltered === 1 ? '' : 'es'}`
      : `${totalFiltered} player${totalFiltered === 1 ? '' : 's'}`;
  } else {
    status.textContent = isEs
      ? `Mostrando ${visibleList.length} de ${totalFiltered} jugadores`
      : `Showing ${visibleList.length} of ${totalFiltered} players`;
  }

  if (!totalFiltered) {
    cleanupObserver();
    list.innerHTML = isEs
      ? '<div class="panel glass empty-state"><h2>Sin resultados</h2><p class="muted">Prueba con otro nombre, tag, sponsor o juego.</p></div>'
      : '<div class="panel glass empty-state"><h2>No matches</h2><p class="muted">Try another player name, tag, sponsor or game.</p></div>';
    const existingSentinel = $('#scroll-sentinel');
    if (existingSentinel) existingSentinel.remove();
    return;
  }

  list.innerHTML = visibleList.map(entry => {
    const p = entry.profile?.player || entry;
    const games = entry.games || entry.profile?.games || [];
    const location = p.city || p.country
      ? [p.city, p.country || 'Uruguay'].filter(Boolean).join(', ')
      : (p.location || '');
    const events = getPlayerEventCount(entry, selectedGame);
    const eventLabel = isEs
      ? (events === 1 ? 'TORNEO' : 'TORNEOS')
      : (events === 1 ? 'EVENT' : 'EVENTS');
    const picture = p.photo || `assets/players/${entry.playerId}.png`;
    const playerTag = p.tag || entry.tag;
    let miniBadgesHtml = '';
    if (window.PRBadges && playerTag) {
      const rList = window.PRBadges.getPlayerRankings(playerTag);
      // Only display a medal for a game if the player is ranked in the most recent PR for that game,
      // and in that case, only display that corresponding medal.
      const qualifyingEntries = [];
      const checkedGames = new Set();
      rList.forEach(entry => {
        const gameKey = entry.ranking?.game?.id || entry.ranking?.game?.slug || entry.ranking?.gameId;
        if (!gameKey || checkedGames.has(gameKey)) return;
        checkedGames.add(gameKey);

        const latestRanking = window.PRBadges.getLatestRankingForGame(gameKey);
        if (latestRanking && entry.ranking?.id === latestRanking.id) {
          qualifyingEntries.push(entry);
        }
      });

      if (qualifyingEntries.length) {
        const sortedBadges = sortMedals(qualifyingEntries);
        miniBadgesHtml = `<span class="player-mini-badges">${sortedBadges.slice(0, 3).map(e => window.PRBadges.renderMini(e)).join('')}</span>`;
      }
    }
    return `<div class="player-card glass">
      <a class="player-card-target" href="index.html?player=${encodeURIComponent(entry.playerId)}" aria-label="${esc(playerTag)}"></a>
      <span class="player-avatar"><img src="${esc(picture)}" alt="" loading="lazy"></span>
      <span class="player-card-copy">${p.sponsor ? `<span class="mono muted player-sponsor">${esc(p.sponsor)}</span>` : ''}<span class="player-tag-row"><b>${esc(playerTag)}</b>${miniBadgesHtml}</span><span class="muted">${esc(location || games.map(g => g.name).join(' · ') || (isEs ? 'Jugador' : 'Player'))}</span></span>
      <span class="player-card-meta"><b>${events}</b><span class="mono muted">${eventLabel}</span></span>
    </div>`;
  }).join('');

  list.querySelectorAll('.player-avatar img').forEach(image => image.addEventListener('error', () => {
    const avatar = image.parentElement;
    image.remove();
    avatar.textContent = (avatar.closest('.player-card')?.querySelector('.player-tag-row b')?.textContent || '?')[0];
  }, { once: true }));

  let sentinel = $('#scroll-sentinel');
  if (!sentinel) {
    sentinel = document.createElement('div');
    sentinel.id = 'scroll-sentinel';
    sentinel.className = 'infinite-scroll-sentinel mono muted';
    list.parentNode.insertBefore(sentinel, list.nextSibling);
  }

  const sentinelText = visibleCount < totalFiltered
    ? (isEs
      ? `Mostrando ${visibleList.length} de ${totalFiltered} jugadores (desplaza hacia abajo para cargar más…)`
      : `Showing ${visibleList.length} of ${totalFiltered} players (scroll down to load more…)`)
    : (isEs
      ? `Mostrando los ${totalFiltered} jugadores`
      : `Showing all ${totalFiltered} players`);

  sentinel.textContent = sentinelText;
  setupInfiniteScroll(totalFiltered);
}

search.addEventListener('input', () => {
  resetPagination();
  render();
});
gameFilter.addEventListener('change', () => {
  resetPagination();
  render();
});
if (playerSort) {
  playerSort.addEventListener('change', () => {
    resetPagination();
    render();
  });
}
playerView.addEventListener('change', render);

if (window.i18n && window.i18n.onChange) {
  window.i18n.onChange(() => {
    populateGameFilter();
    render();
  });
}

loadPlayers();
