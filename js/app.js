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
const fmtMonthYear = d => d ? new Date(d.includes('T') ? d : `${d}T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '';
const profileId = new URLSearchParams(location.search).get('player');
let data;
let playerDirectory = [];
let playerTagToIdMap = new Map();
let resultPage = 1;
let selectedOpponent = null;
let selectedBestPlacement = null;
let isOpponentListOpen = false;

async function loadPlayerDirectory() {
  try {
    const res = await fetch('data/profiles/index.json', { cache: 'no-store' });
    if (res.ok) {
      playerDirectory = await res.json();
      playerDirectory.forEach(item => {
        if (item.tag) {
          const normTag = String(item.tag).trim().replace(/\s+/g, ' ').toLowerCase();
          if (!playerTagToIdMap.has(normTag)) {
            playerTagToIdMap.set(normTag, item.playerId);
          }
        }
      });
    }
  } catch (e) {
    console.error('Failed to load player directory index for opponent linking', e);
  }
}

function linkifyOpponent(nameStr) {
  if (!nameStr || nameStr === '—' || nameStr === 'Unknown') return esc(nameStr || '—');
  const parts = String(nameStr).split(/\s*([,/])\s*/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return esc(part); // separator
    const trimmed = part.trim();
    if (!trimmed) return '';
    const norm = trimmed.replace(/\s+/g, ' ').toLowerCase();
    const pid = playerTagToIdMap.get(norm);
    if (pid) {
      return `<a class="opponent-link" href="index.html?player=${encodeURIComponent(pid)}">${esc(trimmed)}</a>`;
    }
    return esc(trimmed);
  }).join(' ');
}

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

Promise.all([loadProfile(), loadPlayerDirectory()]).then(([d]) => {
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
    return match ? { own: Number(match[1]), opp: Number(match[2]), total: Number(match[1]) + Number(match[2]) } : null;
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
      .map(set => ({ ...set, parsedScore: scoreGames(set.score) }))
      .filter(set => set.parsedScore && set.parsedScore.own > 0)
      .sort((a, b) => Number(a.opponentSeed) - Number(b.opponentSeed)
        || (b.parsedScore?.own || 0) - (a.parsedScore?.own || 0)
        || (b.parsedScore?.total || 0) - (a.parsedScore?.total || 0));
    const closestLoss = seededLosses[0];
    const closestLossDetail = closestLoss
      ? `Seed ${closestLoss.opponentSeed}${closestLoss.score ? ` (${closestLoss.score})` : ''}`
      : 'No seeded losses recorded';
    const upsetStat = upsetCount > 0
      ? ['UPSET WINS', upsetCount, 'Higher seeds beaten']
      : ['CLOSEST UPSET', linkifyOpponent(closestLoss?.opponent), closestLossDetail];
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
        : `${activeDurationYears.toFixed(1).replace(/\.0$/, '')} years`;
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
      const normKey = String(h.opponent || '').trim().replace(/\s+/g, ' ').toLowerCase();
      if (!normKey) return;
      const t = tot[normKey] ||= { name: h.opponent, sets: 0, wins: 0, games: 0 };
      t.sets += h.sets; t.wins += h.wins; t.games++;
    }));
    const topOpponents = Object.values(tot)
      .sort((a, b) => b.sets - a.sets || b.wins - a.wins || a.name.localeCompare(b.name))
      .slice(0, 5);
    const opp = topOpponents[0] || null;
    const oppName = opp ? opp.name : null;
    mostPlayedOpponent = oppName;
    const gameCountLabel = opp ? (opp.games > 1 ? ` · ${opp.games} games` : '') : '';
    stats.push(['ACTIVE FOR', singleEventResult ? '1 Event' : activeDuration, activityPeriod],
      ['MOST-PLAYED OPPONENT', oppName || '—', opp ? `${opp.sets} sets · ${opp.wins}–${opp.sets - opp.wins}${gameCountLabel}` : 'No set data']);
  }
  const notableWinsList = [];
  const seenOpponents = new Map();
  for (const win of sel?.notableWins || []) {
    const oppKey = String(win.opponent || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!oppKey) continue;
    if (!seenOpponents.has(oppKey)) {
      const entry = { ...win, count: Number(win.count) || 1 };
      seenOpponents.set(oppKey, entry);
      notableWinsList.push(entry);
    } else {
      const existing = seenOpponents.get(oppKey);
      existing.count = (existing.count || 1) + 1;
      if (win.date && (!existing.date || win.date > existing.date)) {
        existing.event = win.event;
        existing.date = win.date;
        existing.score = win.score;
        existing.detail = win.detail;
      }
    }
  }
  const notableWins = notableWinsList.slice(0, 4);
  const mainCharacter = sel?.characters?.find(c => String(c.name || '').toLowerCase() !== 'other');
  const mainCharSlug = mainCharacter ? slug(mainCharacter.name) : 'other';
  const mainCharName = mainCharacter ? mainCharacter.name : 'other';
  const characterFeatureTile = sel
    ? `<div class="tile glass character-feature-tile"><img src="assets/renders/${esc(sel.slug)}/full/${mainCharSlug}.png" alt="${esc(mainCharName)}" onerror="if(!this.dataset.fallback){this.dataset.fallback='1';this.src='assets/renders/${esc(sel.slug)}/full/other.png'}else{this.remove()}"></div>`
    : '';
  const tiles = stats.map(([a, b, c]) => {
    const tileClass = `tile glass${a === 'MOST-PLAYED OPPONENT' ? ' tile-opponent' : a === 'BEST PLACING' ? ' tile-best-placement' : a === 'ACTIVE FOR' ? ' tile-active-for' : a === 'CLOSEST UPSET' ? ' tile-upset-fallback' : ''}`;
    const valHtml = a === 'CLOSEST UPSET' ? b : esc(b);
    const contents = `<span class="label">${esc(a)}</span><span class="val">${valHtml}</span>${c ? `<span class="sub">${esc(c)}</span>` : ''}`;
    return a === 'MOST-PLAYED OPPONENT' && mostPlayedOpponent
      ? `<button class="${tileClass} opponent-tile-button" type="button" aria-expanded="${isOpponentListOpen}" aria-controls="opponent-history">${contents}</button>`
      : a === 'BEST PLACING' && sel && bestPlace !== null
        ? `<button class="${tileClass} best-placement-tile-button" type="button" aria-expanded="${selectedBestPlacement === sel.id}" aria-controls="best-placement-history">${contents}</button>`
      : `<div class="${tileClass}">${contents}</div>`;
  }).join('') + characterFeatureTile;

  let middle;
  if (!sel) {
    middle = `<h2 class="sec" style="margin:4px 4px 0">Games played</h2><div class="cards">` +
      gamesBySetsPlayed.map(g => {
          const character = g.characters?.[0]?.name || 'other';
        const eventWins = (g.results || []).filter(result => Number(result.place) === 1).length;
        const bestLabel = eventWins
          ? `Won ${eventWins} event${eventWins === 1 ? '' : 's'}`
          : `Best: ${ord(g.bestPlace)}`;
          return `<a class="card glass" href="#${encodeURIComponent(g.id)}"><span class="ini">${esc(character[0])}</span><img class="bg" src="assets/renders/${esc(g.slug)}/portraits/${slug(character)}.png" alt="" onload="this.previousElementSibling.remove()" onerror="if(!this.dataset.fallback){this.dataset.fallback='1';this.src='assets/renders/${esc(g.slug)}/portraits/other.png'}else{this.remove()}">
        <b>${esc(g.name)}</b><span class="muted">${g.events} event${g.events === 1 ? '' : 's'}</span>
        <span class="rec">${g.wins}–${g.losses}</span><span class="muted">${bestLabel}</span></a>`;
      }).join('') + `</div>`;
  } else {
    middle = `<div class="row2">
      <div class="panel glass"><h2>Character usage</h2>${(sel.characters || []).map(c =>
        `<div class="usage"><div class="usage-row"><span class="stock-icon"><span>${esc(c.name[0])}</span><img src="assets/renders/${esc(sel.slug)}/stocks/${slug(c.name)}.webp" alt="" onload="this.previousElementSibling.remove()" onerror="if(!this.dataset.fallback){this.dataset.fallback='png';this.src=this.src.replace('.webp','.png')}else{this.parentElement.remove()}"></span><span>${esc(c.name)}</span><span class="mono usage-percent">${Number(c.usage).toFixed(1)}%</span></div><div class="bar"><i style="width:${Number(c.usage) || 0}%"></i></div></div>`).join('') || '<p class="muted">No character selections recorded.</p>'}</div>
      <div class="panel glass"><h2>Notable wins</h2>${notableWins.map(x => {
        const tournamentName = ((x.event || x.detail?.split(' · ').slice(1).join(' · ') || '').split(' · ')[0]);
        let dateStr = x.date;
        if (!dateStr && sel?.results) {
          const matchResult = sel.results.find(r => (r.event || '').split(' · ')[0] === tournamentName);
          if (matchResult) dateStr = matchResult.date;
        }
        const dateFmt = fmtMonthYear(dateStr);
        const count = Number(x.count) || 1;
        const tourneyAndDate = `${esc(tournamentName)}${dateFmt ? ` <span aria-hidden="true">·</span> ${esc(dateFmt)}` : ''}`;
        const metaHtml = count > 1
          ? `${count} times <span aria-hidden="true">·</span> Latest: ${tourneyAndDate}`
          : tourneyAndDate;
        return `<div class="win"><span class="win-main"><b class="win-opponent">${linkifyOpponent(x.opponent)}</b><small class="win-meta">${metaHtml}</small></span><span class="mono muted win-detail">${esc(x.score || x.detail?.split(' · ')[0] || '—')}</span></div>`;
      }).join('') || '<p class="muted">No notable wins recorded.</p>'}</div>
    </div>
    <div class="panel glass">
      <div class="chart-header">
        <h2 style="margin:0">Placement history</h2>
        <div class="chart-controls">
          <button class="quiet-button chart-zoom-in" type="button" title="Zoom In">+</button>
          <button class="quiet-button chart-zoom-out" type="button" title="Zoom Out">−</button>
          <button class="quiet-button chart-zoom-reset" type="button" title="Reset Zoom">Reset</button>
        </div>
      </div>
      ${chart(sel)}
    </div>`;
  }

  const topOpponents = !sel ? (() => {
    const tot = {};
    games.forEach(g => (g.headToHead || []).forEach(h => {
      const normKey = String(h.opponent || '').trim().replace(/\s+/g, ' ').toLowerCase();
      if (!normKey) return;
      const t = tot[normKey] ||= { name: h.opponent, sets: 0, wins: 0, games: 0 };
      t.sets += h.sets; t.wins += h.wins; t.games++;
    }));
    return Object.values(tot)
      .sort((a, b) => b.sets - a.sets || b.wins - a.wins || a.name.localeCompare(b.name))
      .slice(0, 5);
  })() : [];

  const opponentHistory = !sel && isOpponentListOpen
    ? (() => {
      const topOpponentRows = topOpponents.map(o => {
        const isSelected = selectedOpponent && selectedOpponent.toLowerCase() === o.name.toLowerCase();
        return `<button class="opponent-row-button${isSelected ? ' active' : ''}" type="button" data-opponent="${esc(o.name)}">
          <span class="opponent-row-info">
            <span class="opponent-row-name">${esc(o.name)}</span>
            <span class="opponent-row-sets mono muted">${o.sets} set${o.sets === 1 ? '' : 's'}</span>
          </span>
          <span class="opponent-row-record mono">${o.wins}–${o.sets - o.wins}</span>
        </button>`;
      }).join('');

      let selectedOpponentSetsHtml = '';
      if (selectedOpponent) {
        const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
        const sets = games.flatMap(game => (game.results || []).flatMap(result =>
          (result.sets || []).filter(set => String(set.opponent || '').split(/\s*[,/]\s*/)
            .some(name => normalize(name) === normalize(selectedOpponent)))
            .map(set => ({ ...set, game: game.name, event: result.event, date: result.date }))))
          .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        const rows = sets.map(set => {
          const dateFmt = fmtMonthYear(set.date);
          const metaParts = [dateFmt, set.game, set.round].filter(Boolean).map(esc).join(' · ');
          return `<div class="opponent-set-row"><span class="opponent-set-context"><b>${esc((set.event || '').split(' · ')[0])}</b><small>${metaParts}</small></span><span class="opponent-set-score">${esc(set.score || '—')}</span><span class="set-result ${['win', 'loss'].includes(set.outcome) ? set.outcome : 'unknown'}">${set.outcome === 'win' ? 'WIN' : set.outcome === 'loss' ? 'LOSS' : 'UNKNOWN'}</span></div>`;
        }).join('');
        selectedOpponentSetsHtml = `<div class="opponent-history-subheading"><h3>Sets vs ${linkifyOpponent(selectedOpponent)}</h3></div>${rows || '<p class="muted">No set details were recorded against this opponent.</p>'}`;
      }

      return `<div class="panel glass opponent-history" id="opponent-history">
        <div class="opponent-history-heading"><h2>Most Played Opponents</h2><button class="quiet-button close-opponent-history" type="button">Close</button></div>
        <div class="most-played-list">${topOpponentRows || '<p class="muted">No set data available.</p>'}</div>
        ${selectedOpponentSetsHtml}
      </div>`;
    })()
    : '';
  const bestPlacementHistory = sel && selectedBestPlacement === sel.id
    ? (() => {
      const validResults = (sel.results || [])
        .filter(result => Number.isFinite(Number(result.place)) && Number(result.place) > 0);
      const targetPlace = Number(sel.bestPlace ?? bestPlace);
      const bestResults = validResults.filter(result => Number(result.place) === targetPlace);
      const tournaments = bestResults.length >= 5
        ? bestResults.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        : validResults
          .sort((a, b) => Number(a.place) - Number(b.place) || (b.date || '').localeCompare(a.date || ''))
          .slice(0, 5);
      const rows = tournaments.map(result => `<div class="opponent-set-row"><span class="opponent-set-context"><b>${esc((result.event || '').split(' · ')[0])}</b><small>${fmt(result.date)}${result.entrants ? ` · ${result.entrants} entrants` : ''}</small></span><span class="opponent-set-score ${result.place <= 3 ? `top3 p${result.place}` : ''}">${ord(result.place)}</span></div>`).join('');
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
          <span class="set-opponent">${linkifyOpponent(set.opponent || 'Unknown')}</span>
          <span class="set-score">${esc(set.score || '—')}</span>
          <span class="set-result ${outcome}">${outcome === 'unknown' ? 'RESULT UNKNOWN' : outcome.toUpperCase()}</span>
        </div>`;
      }).join('') : '<p class="set-empty muted">No set details were recorded for this event.</p>';
      return `<div class="result-entry">
        <button class="tr result-toggle" type="button" aria-expanded="false" aria-controls="${detailsId}">
          <span>${esc((r.event || '').split(' · ')[0])}${sel ? '' : `<small>${esc(r.game)}</small>`}</span><span>${fmt(r.date)}</span><span>${esc(r.seed ?? '—')}</span><span class="${r.place <= 3 ? `top3 p${r.place}` : ''}">${ord(r.place)}</span><span>${esc(r.entrants ?? '—')}<small class="expand-hint">${sets.length} set${sets.length === 1 ? '' : 's'}</small></span>
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
    isOpponentListOpen = !isOpponentListOpen;
    if (!isOpponentListOpen) selectedOpponent = null;
    render();
    if (isOpponentListOpen) $('#opponent-history')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('#main').querySelector('.close-opponent-history')?.addEventListener('click', () => {
    isOpponentListOpen = false;
    selectedOpponent = null;
    render();
  });
  $('#main').querySelectorAll('.opponent-row-button').forEach(btn => {
    btn.addEventListener('click', e => {
      if (e.target.closest('.opponent-link')) return;
      const oppName = btn.dataset.opponent;
      const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      selectedOpponent = (selectedOpponent && normalize(selectedOpponent) === normalize(oppName)) ? null : oppName;
      render();
    });
  });
  $('#main').querySelectorAll('.opponent-history .opponent-link').forEach(link => {
    link.addEventListener('click', e => {
      e.stopPropagation();
    });
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

  setupInteractiveChart();
}

let chartZoom = 1;
let chartPanX = 0;

function setupInteractiveChart() {
  const container = $('#main .chart-container');
  if (!container) return;
  const svg = container.querySelector('svg');
  const tooltip = $('#chart-tooltip');
  if (!svg || !tooltip) return;

  const baseWidth = 640;
  const baseHeight = 150;

  chartZoom = 1;
  chartPanX = 0;

  const chartSpan = 580;

  function updateTransform() {
    chartZoom = Math.max(1, Math.min(5, chartZoom));
    const maxPanX = (chartZoom - 1) * chartSpan;
    chartPanX = Math.max(0, Math.min(maxPanX, chartPanX));

    svg.setAttribute('viewBox', '0 0 640 150');

    const points = container.querySelectorAll('.chart-point');
    const polyline = container.querySelector('polyline');

    const pointCoords = [];
    points.forEach(point => {
      const baseX = parseFloat(point.dataset.baseX);
      const relX = baseX - 40;
      const xTrans = Math.round((40 + relX * chartZoom - chartPanX) * 100) / 100;
      const circle = point.querySelector('circle');
      if (circle) {
        circle.setAttribute('cx', xTrans);
        const cy = circle.getAttribute('cy');
        pointCoords.push(`${xTrans},${cy}`);
      }
    });

    if (polyline) {
      polyline.setAttribute('points', pointCoords.join(' '));
    }

    const gridLines = container.querySelectorAll('.chart-grid-line');
    gridLines.forEach(line => {
      const baseX = parseFloat(line.dataset.baseX);
      const relX = baseX - 40;
      const xTrans = Math.round((40 + relX * chartZoom - chartPanX) * 100) / 100;
      line.setAttribute('x1', xTrans);
      line.setAttribute('x2', xTrans);
    });

    if (!tooltip.hidden) {
      tooltip.hidden = true;
    }
  }

  function zoomAt(targetSvgX, zoomFactor) {
    const mouseRelX = targetSvgX - 40;
    const relXTarget = (mouseRelX + chartPanX) / chartZoom;
    const newZoom = Math.max(1, Math.min(5, chartZoom * zoomFactor));
    chartPanX = relXTarget * newZoom - mouseRelX;
    chartZoom = newZoom;
    updateTransform();
  }

  $('#main .chart-zoom-in')?.addEventListener('click', () => {
    zoomAt(330, 1.4);
  });

  $('#main .chart-zoom-out')?.addEventListener('click', () => {
    if (chartZoom <= 1.05) {
      chartZoom = 1;
      chartPanX = 0;
      updateTransform();
    } else {
      zoomAt(330, 1 / 1.4);
    }
  });

  $('#main .chart-zoom-reset')?.addEventListener('click', () => {
    chartZoom = 1;
    chartPanX = 0;
    updateTransform();
  });

  // Wheel zoom
  const wrap = container.querySelector('.chart-svg-wrap');
  wrap?.addEventListener('wheel', e => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    const wrapRect = wrap.getBoundingClientRect();
    const mouseXInWrap = e.clientX - wrapRect.left;
    const targetSvgX = (mouseXInWrap / wrapRect.width) * 640;
    zoomAt(targetSvgX, zoomFactor);
  }, { passive: false });

  // Pan dragging
  let isDragging = false;
  let startX = 0;

  wrap?.addEventListener('pointerdown', e => {
    if (e.target.closest('.chart-point')) return;
    isDragging = true;
    startX = e.clientX;
    wrap.setPointerCapture(e.pointerId);
  });

  wrap?.addEventListener('pointermove', e => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    startX = e.clientX;
    const wrapRect = wrap.getBoundingClientRect();
    const svgDx = (dx / wrapRect.width) * 640;
    chartPanX -= svgDx;
    updateTransform();
  });

  const stopDrag = e => {
    if (isDragging) {
      isDragging = false;
      try { wrap?.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  };
  wrap?.addEventListener('pointerup', stopDrag);
  wrap?.addEventListener('pointercancel', stopDrag);

  // Hover Tooltip for points
  container.querySelectorAll('.chart-point').forEach(point => {
    const showTooltip = () => {
      const circle = point.querySelector('circle');
      if (!circle) return;
      const cx = parseFloat(circle.getAttribute('cx'));
      if (cx < 35 || cx > 625) {
        tooltip.hidden = true;
        return;
      }
      const tourney = point.dataset.tourney;
      const date = point.dataset.date;
      const place = point.dataset.place;
      tooltip.innerHTML = `<b>${esc(tourney)}</b><small>${fmt(date)}</small><div class="chart-place ${place <= 3 ? `top3 p${place}` : ''}">${ord(place)} Place</div>`;
      tooltip.hidden = false;

      const rect = point.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      const x = rect.left + rect.width / 2 - wrapRect.left;
      const y = rect.top - wrapRect.top;

      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${y}px`;
    };

    const hideTooltip = () => {
      tooltip.hidden = true;
    };

    point.addEventListener('mouseenter', showTooltip);
    point.addEventListener('focus', showTooltip);
    point.addEventListener('mouseleave', hideTooltip);
    point.addEventListener('blur', hideTooltip);
  });

  updateTransform();
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
  const pts = rs.map((r, i) => {
    const x = rs.length === 1 ? 330 : 40 + i * 560 / (rs.length - 1);
    const y = maxP === 1 ? 60 : 15 + (r.place - 1) / (maxP - 1) * 90;
    return { x: Math.round(x), y: Math.round(y), result: r };
  });

  const gridLines = [];
  if (rs.length >= 2) {
    const dates = rs.map(r => new Date(`${r.date}T00:00:00`).getTime());
    const minTime = dates[0];
    const maxTime = dates[dates.length - 1];

    if (maxTime > minTime) {
      const startDate = new Date(`${rs[0].date}T00:00:00`);
      const endDate = new Date(`${rs[rs.length - 1].date}T00:00:00`);

      let cur = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1);
      while (cur.getTime() <= endDate.getTime()) {
        const curTime = cur.getTime();
        let i = 0;
        while (i < dates.length - 1 && dates[i + 1] < curTime) {
          i++;
        }
        if (i < dates.length - 1) {
          const t1 = dates[i];
          const t2 = dates[i + 1];
          const x1 = pts[i].x;
          const x2 = pts[i + 1].x;
          const ratio = t2 === t1 ? 0 : (curTime - t1) / (t2 - t1);
          const baseX = Math.round((x1 + ratio * (x2 - x1)) * 100) / 100;

          const isYear = cur.getMonth() === 0;
          gridLines.push({ baseX, isYear });
        }
        cur.setMonth(cur.getMonth() + 1);
      }
    }
  }

  const gridLinesHtml = gridLines.map(g => {
    if (g.isYear) {
      return `<line class="chart-grid-line chart-year-line" data-base-x="${g.baseX}" x1="${g.baseX}" y1="15" x2="${g.baseX}" y2="105" stroke="rgba(255,255,255,.35)" stroke-width="2" />`;
    } else {
      return `<line class="chart-grid-line" data-base-x="${g.baseX}" x1="${g.baseX}" y1="15" x2="${g.baseX}" y2="105" stroke="rgba(255,255,255,.15)" stroke-width="1" stroke-dasharray="3 3" />`;
    }
  }).join('');

  const polylinePoints = pts.map(p => `${p.x},${p.y}`).join(' ');
  const pointsHtml = pts.map(p => {
    const tourneyName = (p.result.event || '').split(' · ')[0];
    return `<g class="chart-point" tabindex="0" data-base-x="${p.x}" data-tourney="${esc(tourneyName)}" data-date="${esc(p.result.date)}" data-place="${esc(p.result.place)}">
      <circle cx="${p.x}" cy="${p.y}" r="5" />
    </g>`;
  }).join('');

  return `<div class="chart-container">
    <div class="chart-svg-wrap">
      <svg viewBox="0 0 640 150" role="img" aria-label="Placement over recent events">
        <defs>
          <clipPath id="chart-clip">
            <rect x="35" y="0" width="590" height="150" />
          </clipPath>
        </defs>
        <line x1="40" y1="15" x2="620" y2="15" stroke="rgba(255,255,255,.2)"/>
        <line x1="40" y1="105" x2="620" y2="105" stroke="rgba(255,255,255,.2)"/>
        <text x="0" y="19">1st</text>
        <text x="0" y="109">${ord(maxP)}</text>
        <g clip-path="url(#chart-clip)">
          ${gridLinesHtml}
          <polyline points="${polylinePoints}" fill="none" stroke="#9FD6FF" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
          ${pointsHtml}
        </g>
        <text x="40" y="140">Oldest</text>
        <text x="560" y="140">Latest</text>
      </svg>
    </div>
    <div class="chart-tooltip" id="chart-tooltip" hidden></div>
  </div>`;
}
