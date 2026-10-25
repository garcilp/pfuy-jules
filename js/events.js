const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const list = $('#event-list');
const upcomingSection = $('#upcoming-events-section');
const upcomingList = $('#upcoming-event-list');
const status = $('#directory-status');
const search = $('#event-search');
const gameFilter = $('#game-filter');
const eventView = $('#event-view');
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
let events = [];

function groupTournaments(entries) {
  const grouped = new Map();
  entries.forEach(event => {
    const key = event.tournamentSlug || event.tournament.toLocaleLowerCase();
    if (!grouped.has(key)) {
      grouped.set(key, {
        tournament: event.tournament,
        tournamentSlug: event.tournamentSlug,
        image: event.image || '',
        date: event.date,
        isTemporary: !!event.isTemporary,
        hasTakenPlace: event.hasTakenPlace,
        games: new Map(),
      });
    }
    const tournament = grouped.get(key);
    if (event.isTemporary) tournament.isTemporary = true;
    if (event.hasTakenPlace !== undefined) {
      if (tournament.hasTakenPlace === undefined || event.hasTakenPlace === false) {
        tournament.hasTakenPlace = event.hasTakenPlace;
      }
    }
    if (event.game) tournament.games.set(event.gameSlug || event.game, { slug: event.gameSlug, name: event.game });
    if (!tournament.image && event.image) tournament.image = event.image;
    if (!tournament.date || (event.date && event.date < tournament.date)) tournament.date = event.date;
  });
  return [...grouped.values()].map(tournament => ({
    ...tournament,
    games: [...tournament.games.values()].sort((a, b) => collator.compare(a.name, b.name)),
    url: tournament.tournamentSlug
      ? `https://www.start.gg/tournament/${encodeURIComponent(tournament.tournamentSlug)}`
      : '',
  }));
}

async function loadEvents() {
  try {
    const response = await fetch('data/events-index.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('The event directory has not been generated yet.');
    events = groupTournaments(await response.json());
    populateGameFilter();
    render();
  } catch (error) {
    status.textContent = error.message;
    if (upcomingSection) upcomingSection.style.display = 'none';
    list.innerHTML = '<div class="panel glass empty-state"><h2>No events available</h2><p class="muted">Import tournament data and generate the event directory to populate this page.</p></div>';
  }
}

function populateGameFilter() {
  const games = new Map(events.flatMap(event => event.games).map(game => [game.slug, game.name]).filter(([slug, name]) => slug && name));
  gameFilter.innerHTML = '<option value="">All games</option>' +
    [...games].sort((a, b) => collator.compare(a[1], b[1]))
      .map(([slug, name]) => `<option value="${esc(slug)}">${esc(name)}</option>`).join('');
}

function renderCard(event) {
  const avatar = `<span class="event-avatar" aria-hidden="true">${esc((event.tournament || '?').slice(0, 1))}${event.image ? `<img src="${esc(event.image)}" alt="" loading="lazy">` : ''}</span>`;
  const gameDate = [event.games.map(game => game.name).join(' · '), event.date].filter(Boolean).join(' · ');
  const body = `<span class="event-card-copy"><b>${esc(event.tournament)}</b><span>${esc(gameDate)}</span></span>${avatar}`;
  const internalUrl = event.tournamentSlug
    ? `event.html?tournament=${encodeURIComponent(event.tournamentSlug)}`
    : (event.url || '');
  return internalUrl
    ? `<a class="event-card glass" href="${esc(internalUrl)}">${body}</a>`
    : `<article class="event-card glass">${body}</article>`;
}

function render() {
  const isCondensed = eventView.value === 'condensed';
  list.classList.toggle('condensed', isCondensed);
  if (upcomingList) upcomingList.classList.toggle('condensed', isCondensed);

  const query = search.value.trim().toLocaleLowerCase();
  const selectedGame = gameFilter.value;
  const todayIso = new Date().toISOString().split('T')[0];

  const matching = events.filter(event => {
    const matchesGame = !selectedGame || event.games.some(game => game.slug === selectedGame);
    const matchesSearch = [event.tournament, ...event.games.map(game => game.name), event.date].join(' ').toLocaleLowerCase().includes(query);
    return matchesGame && matchesSearch;
  });

  const upcoming = [];
  const past = [];

  matching.forEach(event => {
    const takenPlace = event.hasTakenPlace !== undefined
      ? event.hasTakenPlace
      : (event.date ? event.date <= todayIso : true);

    if (!takenPlace) {
      upcoming.push(event);
    } else if (!event.isTemporary) {
      past.push(event);
    }
  });

  upcoming.sort((a, b) => (a.date || '').localeCompare(b.date || '') || collator.compare(a.tournament, b.tournament));
  past.sort((a, b) => (b.date || '').localeCompare(a.date || '') || collator.compare(a.tournament, b.tournament));

  const totalShown = upcoming.length + past.length;
  status.textContent = `${totalShown} tournament${totalShown === 1 ? '' : 's'}`;

  if (upcomingSection && upcomingList) {
    if (upcoming.length) {
      upcomingSection.style.display = '';
      upcomingList.innerHTML = upcoming.map(renderCard).join('');
    } else {
      upcomingSection.style.display = 'none';
      upcomingList.innerHTML = '';
    }
  }

  if (past.length) {
    list.innerHTML = past.map(renderCard).join('');
  } else if (upcoming.length) {
    list.innerHTML = '';
  } else {
    list.innerHTML = '<div class="panel glass empty-state"><h2>No matches</h2><p class="muted">Try another tournament name or game.</p></div>';
  }
}

search.addEventListener('input', render);
gameFilter.addEventListener('change', render);
eventView.addEventListener('change', render);
eventView.value = 'condensed';
loadEvents();
