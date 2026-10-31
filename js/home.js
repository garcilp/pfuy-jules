// Platfighters.uy — Homepage logic
// Loads real tournament data, player index, rankings and stats.

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const fmt = d => d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

let eventsIndex = [];
let playerDirectory = [];
let activeCommunities = [
  { slug: 'rivals-2', name: 'Rivals 2', abbr: 'R2' },
  { slug: 'ultimate', name: 'Ultimate', abbr: 'U' },
  { slug: 'project-plus', name: 'Project+', abbr: 'P+' },
  { slug: 'rivals-of-aether', name: 'Rivals of Aether', abbr: 'RoA' },
  { slug: 'melee', name: 'Melee', abbr: 'M' }
];

async function initHome() {
  try {
    const [eventsRes, playersRes] = await Promise.all([
      fetch('data/events-index.json', { cache: 'no-store' }),
      fetch('data/profiles/index.json', { cache: 'no-store' })
    ]);

    if (eventsRes.ok) {
      eventsIndex = await eventsRes.json();
    }
    if (playersRes.ok) {
      playerDirectory = await playersRes.json();
    }

    renderStats();
    renderUpcomingEvents();
    await renderRecentResults();
    renderOnThisWeek();
    await renderTopPlayers();
    await renderRivalry();
    renderNewcomerSteps();
    renderHubs();
    setupSearch();

    // Set synced timestamp
    const syncedEl = $('#synced');
    if (syncedEl) {
      syncedEl.textContent = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  } catch (err) {
    console.error('Error loading homepage data:', err);
  }
}

// 1. Stats strip
function renderStats() {
  const statsContainer = $('#stats');
  if (!statsContainer) return;

  const totalPlayers = playerDirectory.length || 0;

  // Group events by tournament slug or title to count distinct tournaments
  const uniqueTournaments = new Set(eventsIndex.map(e => e.tournamentSlug || e.tournament).filter(Boolean));
  const totalTournaments = uniqueTournaments.size || eventsIndex.length;

  // Crossover players: players participating in 2 or more games
  const crossoverCount = playerDirectory.filter(p => (p.games || []).length >= 2).length;

  const stats = [
    { label: 'PLAYERS', value: totalPlayers.toLocaleString(), sub: `across ${activeCommunities.length} communities` },
    { label: 'TOURNAMENTS', value: totalTournaments.toLocaleString(), sub: 'indexed from start.gg' },
    { label: 'GAMES', value: activeCommunities.length.toString(), sub: 'platform fighters active' },
    { label: 'CROSSOVER PLAYERS', value: crossoverCount.toLocaleString(), sub: 'compete in 2+ games' }
  ];

  statsContainer.innerHTML = stats.map(s => `
    <div class="tile glass">
      <div class="label">${esc(s.label)}</div>
      <div class="val">${esc(s.value)}</div>
      <div class="sub">${esc(s.sub)}</div>
    </div>
  `).join('');
}

// 2. Upcoming Events
function renderUpcomingEvents() {
  const container = $('#events-grid');
  if (!container) return;

  const todayIso = new Date().toISOString().split('T')[0];

  // Group tournaments like events.js
  const grouped = new Map();
  eventsIndex.forEach(event => {
    const key = event.tournamentSlug || (event.tournament || '').toLowerCase();
    if (!grouped.has(key)) {
      grouped.set(key, {
        tournament: event.tournament,
        tournamentSlug: event.tournamentSlug,
        image: event.image || '',
        date: event.date,
        isTemporary: !!event.isTemporary,
        hasTakenPlace: event.hasTakenPlace,
        games: new Map(),
        entrants: event.entrants || 0
      });
    }
    const t = grouped.get(key);
    if (event.isTemporary) t.isTemporary = true;
    if (event.hasTakenPlace !== undefined) {
      if (t.hasTakenPlace === undefined || event.hasTakenPlace === false) {
        t.hasTakenPlace = event.hasTakenPlace;
      }
    }
    if (event.game) t.games.set(event.gameSlug || event.game, { slug: event.gameSlug, name: event.game });
    if (!t.date || (event.date && event.date < t.date)) t.date = event.date;
    if (event.entrants && event.entrants > t.entrants) t.entrants = event.entrants;
  });

  const tournaments = [...grouped.values()];
  const upcoming = tournaments.filter(t => {
    const takenPlace = t.hasTakenPlace !== undefined
      ? t.hasTakenPlace
      : (t.date ? t.date <= todayIso : true);
    return !takenPlace;
  }).sort((a, b) => (a.date || '').localeCompare(b.date || '') || collator.compare(a.tournament, b.tournament));

  if (!upcoming.length) {
    container.innerHTML = '<p class="empty-notice">No upcoming tournaments currently scheduled. Check back soon or view past events!</p>';
    return;
  }

  container.innerHTML = upcoming.map((e, i) => {
    const dt = e.date ? new Date(`${e.date}T00:00:00`) : new Date();
    const day = dt.getDate();
    const weekday = dt.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
    const month = dt.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
    const gameNames = [...e.games.values()].map(g => g.name).join(' · ');
    const entrantsStr = e.entrants ? `${e.entrants} registered` : 'Registration open';
    const linkUrl = e.tournamentSlug ? `event.html?tournament=${encodeURIComponent(e.tournamentSlug)}` : 'events.html';

    return `
      <a class="event glass" href="${esc(linkUrl)}">
        <div class="datebox">
          <div class="mono muted">${weekday}</div>
          <div class="day">${day}</div>
          <div class="mono muted">${month}</div>
        </div>
        <div class="info">
          ${i === 0 ? '<span class="next">NEXT</span>' : ''}
          <b>${esc(e.tournament)}</b>
          <span class="muted">${esc(gameNames || 'Platform Fighter')}</span>
          <span class="mono muted">${esc(entrantsStr)}</span>
        </div>
      </a>
    `;
  }).join('');
}

// 3. Recent results (showing distinct game events)
async function renderRecentResults() {
  const container = $('#results');
  if (!container) return;

  const todayIso = new Date().toISOString().split('T')[0];

  // Group completed events by (tournament, game) so tournaments with multiple games show multiple rows
  const grouped = new Map();
  eventsIndex.forEach(event => {
    const tourneyKey = event.tournamentSlug || (event.tournament || '').toLowerCase();
    const gameKey = (event.gameSlug || event.game || 'default').toLowerCase();
    const compositeKey = `${tourneyKey}::${gameKey}`;

    const takenPlace = event.hasTakenPlace !== undefined
      ? event.hasTakenPlace
      : (event.date ? event.date <= todayIso : true);

    if (takenPlace && !event.isTemporary) {
      if (!grouped.has(compositeKey)) {
        grouped.set(compositeKey, {
          tournament: event.tournament,
          tournamentSlug: event.tournamentSlug,
          date: event.date,
          game: event.game,
          gameSlug: event.gameSlug,
          entrants: event.entrants || 0
        });
      } else {
        const item = grouped.get(compositeKey);
        if (event.entrants && event.entrants > item.entrants) {
          item.entrants = event.entrants;
        }
      }
    }
  });

  const completed = [...grouped.values()]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 6);

  if (!completed.length) {
    container.innerHTML = '<p class="empty-notice">No recent results found.</p>';
    return;
  }

  // Cache event details to prevent fetching the same tournament JSON multiple times
  const eventDetailsCache = new Map();

  const resultsWithWinners = await Promise.all(completed.map(async tourney => {
    let winner = '—';
    let winnerId = null;
    let entrantsCount = tourney.entrants;

    if (tourney.tournamentSlug) {
      try {
        if (!eventDetailsCache.has(tourney.tournamentSlug)) {
          const res = await fetch(`data/events/${encodeURIComponent(tourney.tournamentSlug)}.json`);
          if (res.ok) {
            eventDetailsCache.set(tourney.tournamentSlug, await res.json());
          } else {
            eventDetailsCache.set(tourney.tournamentSlug, null);
          }
        }

        const detail = eventDetailsCache.get(tourney.tournamentSlug);
        if (detail) {
          // Find the matching subEvent for this game
          const sub = (detail.subEvents || []).find(s => {
            const g = (s.game || '').toLowerCase();
            const target = (tourney.game || '').toLowerCase();
            return g.includes(target) || target.includes(g);
          }) || (detail.subEvents || [])[0];

          if (sub) {
            if (sub.entrants) entrantsCount = sub.entrants;
            const first = (sub.standings || []).find(s => Number(s.placement) === 1);
            if (first) {
              winner = first.tag || '—';
              winnerId = first.playerId;
            }
          }
        }
      } catch (e) {
        // Fallback gracefully
      }
    }

    return {
      ...tourney,
      winner,
      winnerId,
      entrants: entrantsCount
    };
  }));

  container.innerHTML = `
    <div class="tr c4 head">
      <span>EVENT</span>
      <span>GAME</span>
      <span>WINNER</span>
      <span>ENTRANTS</span>
    </div>
    ${resultsWithWinners.map(r => {
      const tourneyUrl = r.tournamentSlug ? `event.html?tournament=${encodeURIComponent(r.tournamentSlug)}` : 'events.html';
      const winnerHtml = r.winnerId
        ? `<a class="opponent-link" href="player.html?player=${encodeURIComponent(r.winnerId)}">${esc(r.winner)}</a>`
        : esc(r.winner);

      return `
        <div class="tr c4">
          <span>
            <a class="opponent-link" href="${esc(tourneyUrl)}"><b>${esc(r.tournament)}</b></a>
            <small>${fmt(r.date)}</small>
          </span>
          <span>${esc(r.game || 'Platfighter')}</span>
          <span>${winnerHtml}</span>
          <span class="mono">${r.entrants || '—'}</span>
        </div>
      `;
    }).join('')}
  `;
}

// 4. On this week
function renderOnThisWeek() {
  const container = $('#history');
  const todayLabel = $('#today');
  if (!container) return;

  const now = new Date();
  if (todayLabel) {
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - 3);
    const endOfWeek = new Date(now);
    endOfWeek.setDate(now.getDate() + 3);
    todayLabel.textContent = `${startOfWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${endOfWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }

  const currentYear = now.getFullYear();

  // Match events that occurred in the calendar week (+/- 3 days) in past years
  const matchingEvents = eventsIndex.filter(e => {
    if (!e.date || e.isTemporary) return false;
    const parts = e.date.split('-');
    if (parts.length < 3) return false;
    const year = parseInt(parts[0], 10);
    if (year >= currentYear) return false;

    const eventDate = new Date(parts[0], parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    // Compare day difference relative to current year anniversary
    const anniversary = new Date(currentYear, parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    const diffTime = Math.abs(anniversary - now);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays <= 3;
  });

  if (!matchingEvents.length) {
    container.innerHTML = '<p class="empty-notice">No tournaments were played during this week in past years.</p>';
    return;
  }

  // Deduplicate tournaments if multiple sub-entries
  const seenTournaments = new Set();
  const items = [];
  matchingEvents.forEach(e => {
    const key = e.tournamentSlug || e.tournament;
    if (!seenTournaments.has(key)) {
      seenTournaments.add(key);
      const year = parseInt(e.date.split('-')[0], 10);
      items.push({
        yearsAgo: currentYear - year,
        year,
        date: e.date,
        event: e.tournament,
        slug: e.tournamentSlug,
        game: e.game,
        entrants: e.entrants
      });
    }
  });

  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  container.innerHTML = items.map(h => {
    const tourneyUrl = h.slug ? `event.html?tournament=${encodeURIComponent(h.slug)}` : 'events.html';
    return `
      <div class="tr day">
        <span class="mono muted">${h.year}</span>
        <span>
          <a class="opponent-link" href="${esc(tourneyUrl)}"><b>${esc(h.event)}</b></a>
          <small>${esc(h.game || 'Tournament')}${h.entrants ? ` · ${h.entrants} entrants` : ''}</small>
        </span>
        <span class="mono muted sm0">${h.yearsAgo} yr${h.yearsAgo === 1 ? '' : 's'} ago</span>
      </div>
    `;
  }).join('');
}

// 5. Top Players (#1 on each community's ranking snapshot)
async function renderTopPlayers() {
  const container = $('#top-players');
  if (!container) return;

  const topPlayers = [];

  for (const comm of activeCommunities) {
    try {
      const res = await fetch(`data/rankings/${comm.slug}-glicko2-historical.json`);
      if (res.ok) {
        const data = await res.json();
        const top = (data.rankings || [])[0];
        if (top) {
          topPlayers.push({
            game: comm.name,
            tag: top.playerTag,
            playerId: top.playerId,
            score: top.score,
            matches: top.matches
          });
        }
      }
    } catch (e) {
      // Continue to next community
    }
  }

  if (!topPlayers.length) {
    container.innerHTML = '<p class="empty-notice">Rankings are currently being calculated.</p>';
    return;
  }

  container.innerHTML = topPlayers.map(p => `
    <div class="tr rank">
      <span class="mono gold">#1</span>
      <span>
        <a class="opponent-link" href="player.html?player=${encodeURIComponent(p.playerId)}"><b>${esc(p.tag)}</b></a>
        <small>${esc(p.game)}</small>
      </span>
      <span class="mono muted sm0">${Math.round(p.score)} pts</span>
    </div>
  `).join('');
}

// 6. Rivalry of the Week
async function renderRivalry() {
  const container = $('#rivalry');
  if (!container) return;

  try {
    // Load real head-to-head records dynamically from player profile data
    const res = await fetch('data/profiles/iguana-264244.json');
    if (!res.ok) {
      container.closest('.panel')?.remove();
      return;
    }
    const profile = await res.json();
    const gamesList = [];

    (profile.games || []).forEach(g => {
      const match = (g.headToHead || []).find(h => h.opponent === 'SOL!D');
      if (match && match.sets > 0) {
        const winsB = match.wins || 0;
        const winsA = Math.max(0, match.sets - winsB);
        gamesList.push({
          name: g.name || g.id,
          winsA,
          winsB,
          sets: match.sets
        });
      }
    });

    if (!gamesList.length) {
      container.closest('.panel')?.remove();
      return;
    }

    const totalA = gamesList.reduce((acc, g) => acc + g.winsA, 0);
    const totalB = gamesList.reduce((acc, g) => acc + g.winsB, 0);
    const totalSets = totalA + totalB;

    container.innerHTML = `
      <div class="head mono muted sm0">
        <span>FEATURED RIVALRY</span>
        <span>ALL-TIME HEAD-TO-HEAD</span>
      </div>
      <div class="rival">
        <b><a class="opponent-link" href="player.html?player=894493">Sol!d</a></b>
        <span class="rec">${totalA}–${totalB}</span>
        <b><a class="opponent-link" href="player.html?player=264244">Iguana</a></b>
      </div>
      <p class="muted sm" style="text-align:center">${totalSets} sets across ${gamesList.length} game${gamesList.length === 1 ? '' : 's'}</p>
      ${gamesList.map(g => `
        <div class="rg">
          <span>${esc(g.name)}</span>
          <span class="mono muted">${g.winsA}–${g.winsB} (${g.sets} sets)</span>
        </div>
      `).join('')}
      <div style="margin-top:12px;text-align:center;">
        <a class="link" href="player.html?player=894493">View Sol!d profile</a> ·
        <a class="link" href="player.html?player=264244">View Iguana profile</a>
      </div>
    `;
  } catch (err) {
    console.warn('Could not render dynamic rivalry:', err);
    container.closest('.panel')?.remove();
  }
}

// 7. Newcomer Guide
function renderNewcomerSteps() {
  const container = $('#steps');
  if (!container) return;

  const steps = [
    {
      title: 'Pick a game',
      body: 'Every platform fighter has an active community in Uruguay. Choose your main game or explore multiple titles.',
      link: 'Browse communities',
      href: '#hubs'
    },
    {
      title: 'Join the scene',
      body: 'Connect with local players, find weekly meetups, and join friendly practice sessions across Uruguay.',
      link: 'Find community hubs',
      href: '#hubs'
    },
    {
      title: 'Enter a tournament',
      body: 'Test your skills in local weeklies, regionals, or online brackets tracked directly on start.gg.',
      link: 'See upcoming events',
      href: 'events.html'
    },
    {
      title: 'Track your career',
      body: 'Your placements, set history, head-to-head records, and rankings build automatically on Platfighters.',
      link: 'Explore players',
      href: 'players.html'
    }
  ];

  container.innerHTML = steps.map((s, i) => `
    <div class="step glass">
      <span class="n">${i + 1}</span>
      <b>${esc(s.title)}</b>
      <p>${esc(s.body)}</p>
      <a class="link" href="${esc(s.href)}">${esc(s.link)} →</a>
    </div>
  `).join('');
}

// 8. Community Hubs
async function renderHubs() {
  const container = $('#hub-list');
  if (!container) return;

  let socialsConfig = {};
  try {
    const res = await fetch('data/community_socials.json', { cache: 'no-store' });
    if (res.ok) {
      socialsConfig = await res.json();
    }
  } catch (e) {
    // Default fallback
  }

  // SVG Icons for WhatsApp, Discord, Twitter / X
  const icons = {
    whatsapp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.816 9.816 0 0 0 12.04 2zm.01 1.67c2.2 0 4.26.86 5.82 2.42a8.225 8.225 0 0 1 2.41 5.83c0 4.54-3.7 8.24-8.24 8.24-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.196 8.196 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.24-8.24zm4.52 11.64c-.25-.13-1.47-.72-1.7-.81-.23-.08-.39-.13-.56.13-.17.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.13-1.06-.39-2.02-1.25-.75-.67-1.25-1.5-1.4-1.75-.15-.25-.02-.39.11-.51.11-.11.25-.29.37-.44.13-.14.17-.25.25-.42.08-.17.04-.31-.02-.44-.06-.13-.56-1.35-.77-1.85-.2-.49-.41-.42-.56-.43h-.48c-.17 0-.44.06-.67.31-.23.25-.88.86-.88 2.1 0 1.24.9 2.44 1.03 2.61.13.17 1.78 2.72 4.31 3.81.6.26 1.07.41 1.44.53.61.19 1.16.17 1.6.1.49-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.15-1.18-.07-.11-.23-.17-.48-.3z"/></svg>`,
    discord: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`,
    twitter: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`
  };

  // Calculate real player count, event count, and latest tournament date for each game
  const hubs = activeCommunities.map(c => {
    const playersInGame = playerDirectory.filter(p => (p.games || []).some(g => (g.slug || g.id) === c.slug)).length;
    const gameEvents = eventsIndex.filter(e => (e.gameSlug || '').toLowerCase() === c.slug);

    // Find most recent completed tournament date
    const completedEvents = gameEvents.filter(e => !e.isTemporary && e.hasTakenPlace !== false);
    completedEvents.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const latestDate = completedEvents.length > 0 ? (completedEvents[0].date || '') : '';

    return {
      ...c,
      players: playersInGame,
      events: gameEvents.length,
      latestDate,
      socials: socialsConfig[c.slug] || {}
    };
  });

  // Order community hubs based on the most recent tournament hosted (descending)
  hubs.sort((a, b) => b.latestDate.localeCompare(a.latestDate) || b.events - a.events);

  container.innerHTML = hubs.map(h => {
    const soc = h.socials || {};
    const buttons = [];
    if (soc.whatsapp && soc.whatsapp.enabled && soc.whatsapp.url) {
      buttons.push(`<a class="hub-social-btn" href="${esc(soc.whatsapp.url)}" target="_blank" rel="noopener noreferrer" title="WhatsApp community" aria-label="WhatsApp">${icons.whatsapp}</a>`);
    }
    if (soc.discord && soc.discord.enabled && soc.discord.url) {
      buttons.push(`<a class="hub-social-btn" href="${esc(soc.discord.url)}" target="_blank" rel="noopener noreferrer" title="Discord community" aria-label="Discord">${icons.discord}</a>`);
    }
    if (soc.twitter && soc.twitter.enabled && soc.twitter.url) {
      buttons.push(`<a class="hub-social-btn" href="${esc(soc.twitter.url)}" target="_blank" rel="noopener noreferrer" title="Twitter / X profile" aria-label="Twitter / X">${icons.twitter}</a>`);
    }

    return `
      <div class="hub glass">
        <span class="abbr" id="abbr-${h.slug}">${esc(h.abbr)}</span>
        <img class="hub-art" src="assets/hubs/${esc(h.slug)}.webp" alt="" onerror="this.remove(); document.getElementById('abbr-${h.slug}') && (document.getElementById('abbr-${h.slug}').style.display='block');" onload="document.getElementById('abbr-${h.slug}') && (document.getElementById('abbr-${h.slug}').style.display='none');">
        <b>${esc(h.name)}</b>
        <div class="hub-stat-row">
          <span class="big">${h.players}</span>
          <span class="players-label">players</span>
        </div>
        <div class="events-sub">${h.events} events indexed</div>
        <div class="hub-links">
          ${buttons.length ? buttons.join('') : '<span class="muted sm0">Links available soon</span>'}
        </div>
      </div>
    `;
  }).join('');
}

// 9. Live Player & Event Search
function setupSearch() {
  const searchInput = $('#global-search');
  const searchForm = $('#search-form');
  if (!searchInput || !searchForm) return;

  // Create search results dropdown
  let resultsBox = document.createElement('div');
  resultsBox.className = 'search-results';
  resultsBox.hidden = true;
  searchForm.appendChild(resultsBox);

  function handleSearch() {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length < 2) {
      resultsBox.hidden = true;
      resultsBox.innerHTML = '';
      return;
    }

    // Match players
    const matchingPlayers = playerDirectory.filter(p => {
      const tag = (p.tag || '').toLowerCase();
      const sponsor = (p.sponsor || '').toLowerCase();
      return tag.includes(q) || sponsor.includes(q);
    }).slice(0, 5);

    // Match tournaments
    const matchingEvents = eventsIndex.filter(e => {
      const name = (e.tournament || '').toLowerCase();
      return name.includes(q);
    }).slice(0, 4);

    if (!matchingPlayers.length && !matchingEvents.length) {
      resultsBox.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:13px;">No matching players or events found.</div>';
      resultsBox.hidden = false;
      return;
    }

    let html = '';

    if (matchingPlayers.length) {
      html += `<div style="padding:6px 10px;font:11px 'JetBrains Mono',monospace;color:var(--muted)">PLAYERS</div>`;
      matchingPlayers.forEach(p => {
        const gamesStr = (p.games || []).map(g => g.name).join(' · ') || 'Player';
        html += `
          <a class="search-item" href="player.html?player=${encodeURIComponent(p.playerId)}">
            <span class="search-item-info">
              <span class="search-item-title">${p.sponsor ? `<span class="mono muted">[${esc(p.sponsor)}]</span> ` : ''}${esc(p.tag)}</span>
              <span class="search-item-sub">${esc(gamesStr)}</span>
            </span>
            <span class="search-item-tag">${(p.games || []).length} game${(p.games || []).length === 1 ? '' : 's'}</span>
          </a>
        `;
      });
    }

    if (matchingEvents.length) {
      html += `<div style="padding:6px 10px 4px;margin-top:4px;border-top:1px solid var(--line);font:11px 'JetBrains Mono',monospace;color:var(--muted)">TOURNAMENTS</div>`;
      matchingEvents.forEach(e => {
        const tourneyUrl = e.tournamentSlug ? `event.html?tournament=${encodeURIComponent(e.tournamentSlug)}` : 'events.html';
        html += `
          <a class="search-item" href="${esc(tourneyUrl)}">
            <span class="search-item-info">
              <span class="search-item-title">${esc(e.tournament)}</span>
              <span class="search-item-sub">${esc(e.game || '')}${e.date ? ` · ${fmt(e.date)}` : ''}</span>
            </span>
            <span class="search-item-tag">EVENT</span>
          </a>
        `;
      });
    }

    resultsBox.innerHTML = html;
    resultsBox.hidden = false;
  }

  searchInput.addEventListener('input', handleSearch);
  searchForm.addEventListener('submit', e => {
    e.preventDefault();
    const firstLink = resultsBox.querySelector('a.search-item');
    if (firstLink) firstLink.click();
  });

  // Hide on click outside
  document.addEventListener('click', e => {
    if (!searchForm.contains(e.target)) {
      resultsBox.hidden = true;
    }
  });

  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim().length >= 2) {
      resultsBox.hidden = false;
    }
  });
}

// Initialize on DOM load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHome);
} else {
  initHome();
}
