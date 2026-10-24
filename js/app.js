// Platfighters.uy — player page. Plain JS, no build step.
// Use ?player=<start.gg player ID> for a generated profile; default to the sample profile.
const $ = s => document.querySelector(s);
const ord = n => {
  if (!Number.isFinite(Number(n)) || Number(n) < 1) return '—';
  n = Number(n);
  return n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
};
const slug = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = d => d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const profileId = new URLSearchParams(location.search).get('player');
let data;
let resultPage = 1;
let selectedOpponent = null;
let selectedBestPlacement = null;

async function loadProfile() {
  let profileUrl = 'data/mint.json';
  if (profileId) {
    if (!/^\d+$/.test(profileId)) throw new Error('Use a numeric start.gg player ID in the player URL.');
    const indexResponse = await fetch('data/profiles/index.json', { cache: 'no-store' });
    if (!indexResponse.ok) throw new Error('Could not load the player index.');
    const entries = await indexResponse.json();
    let canonicalId = profileId;
    const mergeResponse = await fetch('data/profiles/merges.json', { cache: 'no-store' });
    if (mergeResponse.ok) {
      const merges = await mergeResponse.json();
      const seen = new Set();
      while (merges[canonicalId] && !seen.has(canonicalId)) {
        seen.add(canonicalId);
        canonicalId = String(merges[canonicalId]);
      }
    }
    const entry = entries.find(item => String(item.playerId) === canonicalId);
    if (!entry) throw new Error(`No profile is available for start.gg player ID ${profileId}.`);
    if (canonicalId !== profileId) {
      const canonicalUrl = new URL(location.href);
      canonicalUrl.searchParams.set('player', canonicalId);
      history.replaceState(null, '', canonicalUrl);
    }
    profileUrl = `data/profiles/${encodeURIComponent(entry.slug)}.json`;
  }
  const response = await fetch(profileUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load profile (${response.status})`);
  return response.json();
}

loadProfile().then(d => {
  data = d;
  render();
  addEventListener('hashchange', () => { resultPage = 1; render(); });
}).catch(error => {
  $('#main').innerHTML = `<div class="panel glass"><h2>Profile unavailable</h2><p class="muted">${esc(error.message)}</p></div>`;
});

function render() {
  const { player, games } = data;
  $('#site-badge').textContent = profileId ? 'PLAYER PROFILE' : 'SAMPLE DATA';
  const id = location.hash.slice(1) || 'overview';
  const sel = games.find(g => g.id === id);
  const G = sel ? [sel] : games;
  const mostRecentlyPlayedFirst = [...games].sort((a, b) => {
    const latestDate = game => (game.results || []).reduce((latest, result) =>
      typeof result.date === 'string' && result.date > latest ? result.date : latest, '');
    return latestDate(b).localeCompare(latestDate(a));
  });
  const gamesBySetsPlayed = [...games].sort((a, b) => {
    const setCount = game => (game.results || []).reduce((total, result) =>
      total + (Array.isArray(result.sets) ? result.sets.length : 0), 0);
    return setCount(b) - setCount(a) || a.name.localeCompare(b.name);
  });
  const mg = sel || [...games].sort((a, b) => b.events - a.events)[0];
  const firstCharacter = mg?.characters?.[0]?.name;
  const playerPhoto = player.photo || `assets/players/${player.startggPlayerId || profileId || slug(player.tag)}.png`;
  const hasStructuredLocation = Object.hasOwn(player, 'city') || Object.hasOwn(player, 'country');
  const profileLocation = hasStructuredLocation
    ? [player.city, player.country || 'Uruguay'].filter(value => typeof value === 'string' && value.trim()).join(', ')
    : player.location || '';
  $('#profile').innerHTML =
    `<span class="ini">${esc(player.tag?.[0] || '?')}</span>
     <div class="art"><img src="${esc(playerPhoto)}" alt="${esc(player.tag)}" onerror="this.closest('.profile').querySelector('.ini').classList.add('show'); this.closest('.art').remove()"></div>
     ${player.sponsor ? `<div class="profile-detail">${esc(player.sponsor)}</div>` : ''}
     <h1>${esc(player.tag)}</h1>
     ${profileLocation ? `<div class="profile-detail">${esc(profileLocation)}</div>` : ''}
     ${player.startgg ? `<a class="profile-startgg" href="${esc(player.startgg)}" target="_blank" rel="noopener">View on start.gg</a>` : ''}`;
  fitPlayerName();

  $('#tabs').innerHTML = [{ id: 'overview', label: 'Overview', count: '' },
    ...mostRecentlyPlayedFirst.map(g => ({ id: g.id, label: g.name, count: `${g.events} event${g.events === 1 ? '' : 's'}` }))]
    .map(t => `<a class="tab${t.id === id ? ' on' : ''}" href="#${encodeURIComponent(t.id)}"><span class="lbl">${esc(t.label)}</span><span class="c">${esc(t.count)}</span></a>`).join('');

  const sum = f => G.reduce((a, g) => a + (Number(f(g)) || 0), 0);
  const ev = sum(g => g.events), w = sum(g => g.wins), l = sum(g => g.losses);
  const placedResults = G.flatMap(game => game.results || []).filter(result => Number.isFinite(Number(result.place)) && Number(result.place) > 0);
  const bestPlace = placedResults.length ? Math.min(...placedResults.map(result => Number(result.place))) : null;
  const bestResults = placedResults.filter(result => Number(result.place) === bestPlace);
  const bestEvent = bestResults.length > 1 ? `${bestResults.length} times` : bestResults[0]?.event?.split(' · ')[0] || 'No placement recorded';
  const scoreGames = score => {
    const match = String(score || '').match(/^\s*(\d+)\s*[-–—:]\s*(\d+)\s*$/);
    return match ? Number(match[1]) + Number(match[2]) : null;
  };
  const stats = [
    ...(!sel ? [['EVENTS ENTERED', ev, ev === 1 ? '' : `Across ${G.length} game${G.length === 1 ? '' : 's'}`]] : []),
    ['SET RECORD', `${w}–${l}`, `${w + l ? Math.round(100 * w / (w + l)) : 0}% set win rate`]
  ];
  let mostPlayedOpponent = null;
  if (sel) {
    const upsetCount = Number(sel.upsets) || 0;
    const seededLosses = (sel.results || []).flatMap(result => result.sets || [])
      .filter(set => set.outcome === 'loss' && Number(set.opponentSeed) > 0)
      .map(set => ({ ...set, gameScore: scoreGames(set.score) }))
      .sort((a, b) => Number(a.opponentSeed) - Number(b.opponentSeed)
        || (b.gameScore?.total || 0) - (a.gameScore?.total || 0));
    const closestLoss = seededLosses[0];
    const closestLossDetail = closestLoss
      ? `Seed ${closestLoss.opponentSeed}${closestLoss.gameScore ? ` (Game ${closestLoss.gameScore})` : ''}`
      : 'No seeded losses recorded';
    const upsetStat = upsetCount > 0
      ? ['UPSET WINS', upsetCount, 'Higher seeds beaten']
      : ['CLOSEST UPSET', closestLoss?.opponent || '—', closestLossDetail];
    stats.push(['BEST PLACING', ord(bestPlace), bestEvent], upsetStat);
  } else {
    const tournamentDates = games.flatMap(game => (game.results || []).map(result => result.date))
      .filter(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))
      .map(date => new Date(`${date}T00:00:00`)).filter(date => Number.isFinite(date.getTime()));
    const since = tournamentDates.length
      ? new Date(Math.min(...tournamentDates.map(date => date.getTime())))
      : (player.activeSince ? new Date(`${player.activeSince}T00:00:00`) : null);
    const latestTournament = tournamentDates.length
      ? new Date(Math.max(...tournamentDates.map(date => date.getTime()))) : null;
    const allResults = games.flatMap(game => game.results || []);
    const singleEventResult = ev === 1 ? allResults[0] : null;
    const today = new Date();
    const sixMonthsAgo = new Date(today);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const stillActive = Boolean(latestTournament && latestTournament >= sixMonthsAgo);
    const activityEnd = stillActive ? today : latestTournament;
    const activeDurationYears = since && activityEnd ? (activityEnd - since) / 31557600000 : null;
    const activeDurationMonths = activeDurationYears === null
      ? null : Math.max(1, Math.min(11, Math.round(activeDurationYears * 12)));
    const activeDuration = activeDurationYears === null
      ? '—'
      : activeDurationYears < 1
        ? `${activeDurationMonths} month${activeDurationMonths === 1 ? '' : 's'}`
        : `${activeDurationYears.toFixed(1)} years`;
    const formatActivityDate = date => date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    const activityPeriod = singleEventResult
      ? (singleEventResult.event || '').split(' · ')[0]
      : since
        ? latestTournament
          ? stillActive ? `Since ${formatActivityDate(since)}` : `${formatActivityDate(since)} – ${formatActivityDate(latestTournament)}`
          : `Since ${formatActivityDate(since)}`
        : '';
    const tot = {};
    games.forEach(g => (g.headToHead || []).forEach(h => {
      const t = tot[h.opponent] ||= { sets: 0, wins: 0, games: 0 };
      t.sets += h.sets; t.wins += h.wins; t.games++;
    }));
    const [oppName, opp] = Object.entries(tot).sort((x, y) => y[1].sets - x[1].sets)[0] || ['—', null];
    mostPlayedOpponent = opp ? oppName : null;
    stats.push(['ACTIVE FOR', singleEventResult ? '1 Event' : activeDuration, activityPeriod],
      ['MOST-PLAYED OPPONENT', oppName, opp ? `${opp.sets} sets · ${opp.wins}–${opp.sets - opp.wins} · ${opp.games} game${opp.games === 1 ? '' : 's'}` : 'No set data']);
  }
  const notableWins = (sel?.notableWins || []).filter((win, index, wins) =>
    wins.findIndex(item => String(item.opponent || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
      === String(win.opponent || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase()) === index).slice(0, 4);
  const mainCharacter = sel?.characters?.find(c => String(c.name || '').toLowerCase() !== 'other');
  const characterFeatureTile = sel
    ? `<div class="tile glass character-feature-tile">${mainCharacter ? `<img src="assets/renders/${esc(sel.slug)}/full/${slug(mainCharacter.name)}.png" alt="${esc(mainCharacter.name)}" onerror="this.remove()">` : ''}</div>`
    : '';
  const tiles = stats.map(([a, b, c]) => {
    const tileClass = `tile glass${a === 'MOST-PLAYED OPPONENT' ? ' tile-opponent' : a === 'BEST PLACING' ? ' tile-best-placement' : a === 'ACTIVE FOR' ? ' tile-active-for' : a === 'CLOSEST UPSET' ? ' tile-upset-fallback' : ''}`;
    const contents = `<span class="label">${esc(a)}</span><span class="val">${esc(b)}</span>${c ? `<span class="sub">${esc(c)}</span>` : ''}`;
    return a === 'MOST-PLAYED OPPONENT' && mostPlayedOpponent
      ? `<button class="${tileClass} opponent-tile-button" type="button" aria-expanded="${selectedOpponent === mostPlayedOpponent}" aria-controls="opponent-history">${contents}</button>`
      : a === 'BEST PLACING' && sel && bestPlace !== null
        ? `<button class="${tileClass} best-placement-tile-button" type="button" aria-expanded="${selectedBestPlacement === sel.id}" aria-controls="best-placement-history">${contents}</button>`
      : `<div class="${tileClass}">${contents}</div>`;
  }).join('') + characterFeatureTile;

  let middle;
  if (!sel) {
    middle = `<h2 class="sec" style="margin:4px 4px 0">Games played</h2><div class="cards">` +
      gamesBySetsPlayed.map(g => {
        const character = g.characters?.[0]?.name;
        const eventWins = (g.results || []).filter(result => Number(result.place) === 1).length;
        const bestLabel = eventWins
          ? `Won ${eventWins} event${eventWins === 1 ? '' : 's'}`
          : `Best: ${ord(g.bestPlace)}`;
        return `<a class="card glass" href="#${encodeURIComponent(g.id)}">${character ? `<span class="ini">${esc(character[0])}</span><img class="bg" src="assets/renders/${esc(g.slug)}/portraits/${slug(character)}.png" alt="" onload="this.previousElementSibling.remove()" onerror="this.remove()">` : ''}
        <b>${esc(g.name)}</b><span class="muted">${g.events} event${g.events === 1 ? '' : 's'}</span>
        <span class="rec">${g.wins}–${g.losses}</span><span class="muted">${bestLabel}</span></a>`;
      }).join('') + `</div>`;
  } else {
    middle = `<div class="row2">
      <div class="panel glass"><h2>Character usage</h2>${(sel.characters || []).map(c =>
        `<div class="usage"><div class="usage-row"><span class="stock-icon"><span>${esc(c.name[0])}</span><img src="assets/renders/${esc(sel.slug)}/stocks/${slug(c.name)}.webp" alt="" onload="this.previousElementSibling.remove()" onerror="if(!this.dataset.fallback){this.dataset.fallback='png';this.src=this.src.replace('.webp','.png')}else{this.parentElement.remove()}"></span><span>${esc(c.name)}</span><span class="mono usage-percent">${esc(c.usage)}%</span></div><div class="bar"><i style="width:${Number(c.usage) || 0}%"></i></div></div>`).join('') || '<p class="muted">No character selections recorded.</p>'}</div>
      <div class="panel glass"><h2>Notable wins</h2>${notableWins.map(x =>
        `<div class="win"><span class="win-main"><b class="win-opponent">${esc(x.opponent)}</b><small class="win-meta" title="Seed ${esc(x.seed ?? '—')} · ${(esc(x.event || x.detail?.split(' · ').slice(1).join(' · ') || '').split(' · ')[0])}">Seed ${esc(x.seed ?? '—')} <span aria-hidden="true">·</span> ${(esc(x.event || x.detail?.split(' · ').slice(1).join(' · ') || '').split(' · ')[0])}</small></span><span class="mono muted win-detail">${esc(x.score || x.detail?.split(' · ')[0] || '—')}</span></div>`).join('') || '<p class="muted">No notable wins recorded.</p>'}</div>
    </div>
    <div class="panel glass"><h2>Placement history</h2>${chart(sel)}</div>`;
  }

  const opponentHistory = !sel && selectedOpponent && selectedOpponent === mostPlayedOpponent
    ? (() => {
      const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      const sets = games.flatMap(game => (game.results || []).flatMap(result =>
        (result.sets || []).filter(set => String(set.opponent || '').split(/\s*[,/]\s*/)
          .some(name => normalize(name) === normalize(selectedOpponent)))
          .map(set => ({ ...set, game: game.name, event: result.event, date: result.date }))))
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const rows = sets.map(set => `<div class="opponent-set-row"><span class="opponent-set-context"><b>${esc((set.event || '').split(' · ')[0])}</b><small>${esc(set.game)}${set.round ? ` · ${esc(set.round)}` : ''}</small></span><span class="opponent-set-score">${esc(set.score || '—')}</span><span class="set-result ${['win', 'loss'].includes(set.outcome) ? set.outcome : 'unknown'}">${set.outcome === 'win' ? 'WIN' : set.outcome === 'loss' ? 'LOSS' : 'UNKNOWN'}</span></div>`).join('');
      return `<div class="panel glass opponent-history" id="opponent-history"><div class="opponent-history-heading"><h2>Sets vs ${esc(selectedOpponent)}</h2><button class="quiet-button close-opponent-history" type="button">Close</button></div>${rows || '<p class="muted">No set details were recorded against this opponent.</p>'}</div>`;
    })()
    : '';
  const bestPlacementHistory = sel && selectedBestPlacement === sel.id
    ? (() => {
      const tournaments = (sel.results || [])
        .filter(result => Number(result.place) === Number(sel.bestPlace ?? bestPlace))
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const rows = tournaments.map(result => `<div class="opponent-set-row"><span class="opponent-set-context"><b>${esc((result.event || '').split(' · ')[0])}</b><small>${fmt(result.date)}${result.entrants ? ` · ${result.entrants} entrants` : ''}</small></span><span class="opponent-set-score">${ord(result.place)}</span></div>`).join('');
      return `<div class="panel glass opponent-history" id="best-placement-history"><div class="opponent-history-heading"><h2>Best finishes</h2><button class="quiet-button close-best-placement-history" type="button">Close</button></div>${rows || '<p class="muted">No tournaments recorded for this placement.</p>'}</div>`;
    })()
    : '';

  const allRows = G.flatMap(g => (g.results || []).map(r => ({ ...r, game: g.name })))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const pageSize = sel ? 8 : 5;
  const rows = allRows.slice(0, pageSize * resultPage);
  const results = `<div class="panel glass"><h2>${sel ? `${esc(sel.name)} results` : 'Recent results'}</h2><div class="table">
    <div class="tr head"><span>EVENT</span><span>DATE</span><span>SEED</span><span>PLACE</span><span>ENTRANTS</span></div>` +
    (rows.length ? rows.map((r, index) => {
      const detailsId = `set-details-${index}`;
      const sets = r.sets || [];
      const setRows = sets.length ? sets.map(set => {
        const outcome = ['win', 'loss'].includes(set.outcome) ? set.outcome : 'unknown';
        const isPools = set.phase && /\bpools\b/i.test(set.phase);
        const roundHtml = (!isPools && set.round) ? `<small>${esc(set.round)}</small>` : '';
        return `<div class="set-row">
          <span class="set-phase"><b>${esc(set.phase || 'Phase not recorded')}</b>${roundHtml}</span>
          <span class="set-opponent">${esc(set.opponent || 'Unknown')}</span>
          <span class="set-score">${esc(set.score || '—')}</span>
          <span class="set-result ${outcome}">${outcome === 'unknown' ? 'RESULT UNKNOWN' : outcome.toUpperCase()}</span>
        </div>`;
      }).join('') : '<p class="set-empty muted">No set details were recorded for this event.</p>';
      return `<div class="result-entry">
        <button class="tr result-toggle" type="button" aria-expanded="false" aria-controls="${detailsId}">
          <span>${esc((r.event || '').split(' · ')[0])}${sel ? '' : `<small>${esc(r.game)}</small>`}</span><span>${fmt(r.date)}</span><span>${esc(r.seed ?? '—')}</span><span class="${r.place <= 3 ? 'top3' : ''}">${ord(r.place)}</span><span>${esc(r.entrants ?? '—')}<small class="expand-hint">${sets.length} set${sets.length === 1 ? '' : 's'}</small></span>
        </button>
        <div class="set-details" id="${detailsId}" hidden>
          <div class="set-head"><span>PHASE</span><span>OPPONENT</span><span>SCORE</span><span>RESULT</span></div>
          ${setRows}
        </div>
      </div>`;
    }).join('') : '<p class="muted">No event results recorded.</p>') +
    `</div>${rows.length < allRows.length ? '<button class="quiet-button load-more-results" type="button">Show more events</button>' : ''}</div>`;
  $('#main').innerHTML = `<div class="tiles">${tiles}</div>${middle}${bestPlacementHistory}${opponentHistory}${results}`;
  fitStatValues();
  $('#main').querySelector('.load-more-results')?.addEventListener('click', () => {
    resultPage += 1;
    render();
  });
  $('#main').querySelector('.opponent-tile-button')?.addEventListener('click', () => {
    selectedOpponent = selectedOpponent === mostPlayedOpponent ? null : mostPlayedOpponent;
    render();
    if (selectedOpponent) $('#opponent-history')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('#main').querySelector('.close-opponent-history')?.addEventListener('click', () => {
    selectedOpponent = null;
    render();
  });
  $('#main').querySelector('.best-placement-tile-button')?.addEventListener('click', () => {
    selectedBestPlacement = selectedBestPlacement === sel.id ? null : sel.id;
    render();
    if (selectedBestPlacement) $('#best-placement-history')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('#main').querySelector('.close-best-placement-history')?.addEventListener('click', () => {
    selectedBestPlacement = null;
    render();
  });
  $('#main').querySelectorAll('.result-toggle').forEach(button => {
    button.addEventListener('click', () => {
      const details = document.getElementById(button.getAttribute('aria-controls'));
      const expanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!expanded));
      details.hidden = expanded;
    });
  });
}

function fitPlayerName() {
  const heading = $('#profile h1');
  if (!heading) return;
  heading.style.fontSize = '';
  let size = parseFloat(getComputedStyle(heading).fontSize);
  while (heading.scrollWidth > heading.clientWidth && size > 12) {
    size -= 1;
    heading.style.fontSize = `${size}px`;
  }
}

function fitStatValues() {
  document.querySelectorAll('#main .tiles .tile .val').forEach(value => {
    value.style.fontSize = '';
    let size = parseFloat(getComputedStyle(value).fontSize);
    while (value.scrollWidth > value.clientWidth && size > 12) {
      size -= 1;
      value.style.fontSize = `${size}px`;
    }
  });
}

addEventListener('resize', () => { fitPlayerName(); fitStatValues(); });

function chart(g) {
  const rs = [...(g.results || [])].filter(r => r.place != null && Number.isFinite(Number(r.place)) && Number(r.place) > 0 && r.date).sort((a, b) => a.date.localeCompare(b.date));
  if (!rs.length) return '<p class="muted">No placement history recorded.</p>';
  const maxP = Math.max(4, ...rs.map(r => Number(r.place)));
  const pts = rs.map((r, i) => [40 + i * 560 / Math.max(1, rs.length - 1), 15 + (r.place - 1) / (maxP - 1) * 90]);
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 640 130" role="img" aria-label="Placement over recent events">
    <line x1="40" y1="15" x2="620" y2="15" stroke="rgba(255,255,255,.2)"/><line x1="40" y1="105" x2="620" y2="105" stroke="rgba(255,255,255,.2)"/>
    <text x="0" y="19">1st</text><text x="0" y="109">${ord(maxP)}</text>
    <polyline points="${pts.map(p => p.map(Math.round).join(',')).join(' ')}" fill="none" stroke="#9FD6FF" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${Math.round(last[0])}" cy="${Math.round(last[1])}" r="6" fill="#9FD6FF"/>
    <text x="40" y="127">Oldest</text><text x="560" y="127">Latest</text></svg>`;
}
