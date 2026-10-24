const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let players = [];
const list = $('#player-list');
const status = $('#directory-status');
const search = $('#player-search');
const gameFilter = $('#game-filter');
const playerView = $('#player-view');
const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

async function loadPlayers() {
  try {
    const response = await fetch('data/profiles/index.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('No generated player directory is available yet.');
    const entries = await response.json();
    players = await Promise.all(entries.map(async entry => {
      const profileResponse = await fetch(`data/profiles/${encodeURIComponent(entry.slug)}.json`);
      if (!profileResponse.ok) return null;
      return { ...entry, profile: await profileResponse.json() };
    }));
    players = players.filter(Boolean);
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
  players.forEach(entry => (entry.profile.games || []).forEach(game => {
    const id = game.slug || game.id;
    if (id && game.name) games.set(id, game.name);
  }));
  gameFilter.innerHTML = '<option value="">All games</option>' +
    [...games].sort((a, b) => nameCollator.compare(a[1], b[1]))
      .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
}

function render() {
  const condensed = playerView.value === 'condensed';
  list.classList.toggle('condensed', condensed);
  const query = search.value.trim().toLocaleLowerCase();
  const selectedGame = gameFilter.value;
  const shown = players.filter(entry => {
    const p = entry.profile.player;
    const games = entry.profile.games || [];
    const location = p.city || p.country
      ? [p.city, p.country || 'Uruguay'].filter(Boolean).join(', ')
      : p.location;
    const includesGame = !selectedGame || games.some(game => (game.slug || game.id) === selectedGame);
    const matchesSearch = [entry.tag, p.tag, p.sponsor, p.city, p.country, location, ...(p.aliases || []), ...games.map(g => g.name)].join(' ').toLocaleLowerCase().includes(query);
    return includesGame && matchesSearch;
  }).sort((a, b) => nameCollator.compare(a.profile.player.tag || a.tag, b.profile.player.tag || b.tag) || nameCollator.compare(a.slug, b.slug));
  status.textContent = `${shown.length} player${shown.length === 1 ? '' : 's'}`;
  list.innerHTML = shown.length ? shown.map(entry => {
    const p = entry.profile.player;
    const games = entry.profile.games || [];
    const location = p.city || p.country
      ? [p.city, p.country || 'Uruguay'].filter(Boolean).join(', ')
      : p.location;
    const events = games.reduce((total, game) => total + (Number(game.events) || 0), 0);
    const eventLabel = events === 1 ? 'EVENT' : 'EVENTS';
    const picture = p.photo || `assets/players/${entry.playerId}.png`;
    return `<a class="player-card glass" href="index.html?player=${encodeURIComponent(entry.playerId)}">
      <span class="player-avatar"><img src="${esc(picture)}" alt="" loading="lazy"></span>
      <span class="player-card-copy"><b>${esc(p.tag || entry.tag)}</b>${p.sponsor ? `<span class="mono muted player-sponsor">${esc(p.sponsor)}</span>` : ''}<span class="muted">${esc(location || games.map(g => g.name).join(' · ') || 'Player')}</span></span>
      <span class="player-card-meta"><b>${events}</b><span class="mono muted">${eventLabel}</span></span>
    </a>`;
  }).join('') : '<div class="panel glass empty-state"><h2>No matches</h2><p class="muted">Try another player name, tag, sponsor or game.</p></div>';
  list.querySelectorAll('.player-avatar img').forEach(image => image.addEventListener('error', () => {
    const avatar = image.parentElement;
    image.remove();
    avatar.textContent = (avatar.closest('.player-card')?.querySelector('.player-card-copy>b')?.textContent || '?')[0];
  }, { once: true }));
}

search.addEventListener('input', render);
gameFilter.addEventListener('change', render);
playerView.addEventListener('change', render);
loadPlayers();
