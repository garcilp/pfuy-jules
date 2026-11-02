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

function isValidStartggUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (host === 'start.gg' || host.endsWith('.start.gg')) && parsed.pathname.length > 1;
  } catch (e) {
    return false;
  }
}

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
    if (event.game) {
      const gSlug = event.gameSlug || event.game;
      if (!tournament.games.has(gSlug)) {
        tournament.games.set(gSlug, { slug: event.gameSlug, name: event.game, url: event.url || '' });
      } else if (!tournament.games.get(gSlug).url && event.url) {
        tournament.games.get(gSlug).url = event.url;
      }
    }
    if (!tournament.image && event.image) tournament.image = event.image;
    if (!tournament.date || (event.date && event.date < tournament.date)) tournament.date = event.date;
  });
  return [...grouped.values()].map(tournament => {
    const games = [...tournament.games.values()].sort((a, b) => collator.compare(a.name, b.name));
    let mainStartggUrl = '';
    // Look for valid start.gg tournament URL
    const anyEventUrl = games.find(g => g.url && isValidStartggUrl(g.url))?.url;
    if (anyEventUrl) {
      const tourneyMatch = anyEventUrl.match(/^(https?:\/\/(?:www\.)?start\.gg\/tournament\/[^/?#]+)/i);
      if (tourneyMatch) mainStartggUrl = tourneyMatch[1];
    }
    if (!mainStartggUrl && tournament.tournamentSlug) {
      mainStartggUrl = `https://www.start.gg/tournament/${encodeURIComponent(tournament.tournamentSlug)}`;
    }

    return {
      ...tournament,
      games,
      startggUrl: mainStartggUrl,
      url: mainStartggUrl,
    };
  });
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
  const currentVal = gameFilter.value;
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  gameFilter.innerHTML = `<option value="">${isEs ? 'Todos los juegos' : 'All games'}</option>` +
    [...games].sort((a, b) => collator.compare(a[1], b[1]))
      .map(([slug, name]) => `<option value="${esc(slug)}"${slug === currentVal ? ' selected' : ''}>${esc(name)}</option>`).join('');
}

function renderCard(event, isUpcoming = false, selectedGame = '') {
  const avatar = `<span class="event-avatar" aria-hidden="true">${esc((event.tournament || '?').slice(0, 1))}${event.image ? `<img src="${esc(event.image)}" alt="" loading="lazy">` : ''}</span>`;
  const gameDate = [event.games.map(game => game.name).join(' · '), event.date].filter(Boolean).join(' · ');
  const body = `<span class="event-card-copy"><b>${esc(event.tournament)}</b><span>${esc(gameDate)}</span></span>${avatar}`;

  if (isUpcoming) {
    // Upcoming event navigation:
    // - When listing is filtered to a specific game, open that specific event's Start.gg page.
    // - When single game tournament, open that specific event's Start.gg page.
    // - When multiple games and viewing all games, open the tournament's main Start.gg page.
    // - If missing/invalid, fall back to the internal tournament detail page.
    let startggTargetUrl = '';

    if (selectedGame) {
      const matchedGame = event.games.find(g => g.slug === selectedGame);
      if (matchedGame && matchedGame.url && isValidStartggUrl(matchedGame.url)) {
        startggTargetUrl = matchedGame.url;
      }
    }

    if (!startggTargetUrl) {
      if (event.games.length === 1 && event.games[0].url && isValidStartggUrl(event.games[0].url)) {
        startggTargetUrl = event.games[0].url;
      } else if (event.startggUrl && isValidStartggUrl(event.startggUrl)) {
        startggTargetUrl = event.startggUrl;
      } else if (event.url && isValidStartggUrl(event.url)) {
        startggTargetUrl = event.url;
      }
    }

    if (startggTargetUrl) {
      return `<a class="event-card glass" href="${esc(startggTargetUrl)}" target="_blank" rel="noopener noreferrer">${body}</a>`;
    }

    // Graceful fallback to internal tournament detail page
    const fallbackUrl = event.tournamentSlug
      ? `event.html?tournament=${encodeURIComponent(event.tournamentSlug)}`
      : '';
    return fallbackUrl
      ? `<a class="event-card glass" href="${esc(fallbackUrl)}">${body}</a>`
      : `<article class="event-card glass">${body}</article>`;
  }

  // Past events: always link to internal tournament detail page
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
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  status.textContent = isEs
    ? `${totalShown} torneo${totalShown === 1 ? '' : 's'}`
    : `${totalShown} tournament${totalShown === 1 ? '' : 's'}`;

  if (upcomingSection && upcomingList) {
    if (upcoming.length) {
      upcomingSection.style.display = '';
      upcomingList.innerHTML = upcoming.map(event => renderCard(event, true, selectedGame)).join('');
    } else {
      upcomingSection.style.display = 'none';
      upcomingList.innerHTML = '';
    }
  }

  if (past.length) {
    list.innerHTML = past.map(event => renderCard(event, false, selectedGame)).join('');
  } else if (upcoming.length) {
    list.innerHTML = '';
  } else {
    list.innerHTML = isEs
      ? '<div class="panel glass empty-state"><h2>Sin resultados</h2><p class="muted">Prueba con otro nombre de torneo o juego.</p></div>'
      : '<div class="panel glass empty-state"><h2>No matches</h2><p class="muted">Try another tournament name or game.</p></div>';
  }
}

search.addEventListener('input', render);
gameFilter.addEventListener('change', render);
eventView.addEventListener('change', render);
eventView.value = 'condensed';

if (window.i18n && window.i18n.onChange) {
  window.i18n.onChange(() => {
    populateGameFilter();
    render();
  });
}

loadEvents();
