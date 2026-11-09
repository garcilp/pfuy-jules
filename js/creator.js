// Platfighters.uy — ranking creator. Plain JS, no build step.
// Supports Public mode and Admin mode with server-side authentication verification.

let draft, games = [], allProfiles = [], gameCharacters = {}, sel = 0, dragFrom = null, dragSubtype = null, dragSubFrom = null, dirty = false, savedAt = '';
let prSnapshot = null;
let isAdmin = false;
let adminCsrfToken = '';

const urlParams = new URLSearchParams(window.location.search);
const requestedMode = urlParams.get('mode');
const rankingIdParam = urlParams.get('id');

// Read snapshot if coming from PR
try {
  const isPrSource = urlParams.get('source') === 'pr';
  const savedSnap = sessionStorage.getItem('platfighters_pr_snapshot');
  if (isPrSource && savedSnap) {
    prSnapshot = JSON.parse(savedSnap);
  }
} catch (e) {
  console.warn('Could not read PR snapshot:', e);
}

// Check admin session securely from backend
async function checkAdminSession() {
  try {
    const res = await fetch('/api/admin/session', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      if (data.authenticated) {
        isAdmin = true;
        adminCsrfToken = data.csrfToken || '';
      }
    }
  } catch (e) {
    isAdmin = false;
  }
  updateAdminUI();
}

function updateAdminUI() {
  const adminGroup = $('#adminActionGroup');
  if (adminGroup) {
    adminGroup.hidden = !(isAdmin && requestedMode === 'admin');
  }
}

let eventsIndexList = [];

// Initial data load
const loadPromises = [
  fetch('data/games.json').then(r => r.json()),
  fetch('data/profiles/index.json').then(r => r.json()).catch(() => []),
  fetch('data/characters.json').then(r => r.json()).catch(() => ({})),
  fetch('data/events-index.json').then(r => r.json()).catch(() => []),
  checkAdminSession()
];

if (rankingIdParam) {
  loadPromises.push(
    fetch(`data/rankings/${encodeURIComponent(rankingIdParam)}.json`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
  );
}

Promise.all(loadPromises)
  .then(([g, profiles, chars, evList, _, existingRanking]) => {
    games = (g || []).sort((a, b) => a.name.localeCompare(b.name));
    allProfiles = profiles || [];
    gameCharacters = chars || {};
    eventsIndexList = evList || [];

    if (existingRanking) {
      draft = existingRanking;
      draft.createdBy = draft.createdBy || '';
      if (draft.status === 'current') draft.status = 'yearly';
      else if (draft.status === 'final') draft.status = 'seasonal';
      if (draft.players) {
        draft.players.forEach(p => {
          if (p.notableResults) sortNotableResults(p.notableResults);
          if (p.notableWins) sortNotableWins(p.notableWins, draft.players);
        });
      }
      dirty = false;
    } else if (prSnapshot) {
      const matchingGame = games.find(gm => gm.slug === prSnapshot.game?.slug || gm.id === prSnapshot.game?.id) || games[0];
      draft = {
        id: '',
        title: '',
        game: { id: matchingGame.id, name: matchingGame.name, slug: matchingGame.slug },
        period: { start: '', end: '' },
        status: 'yearly',
        publishedBy: '',
        createdBy: '',
        intro: '',
        imageBox: null,
        players: []
      };
      dirty = false;
    } else {
      const defaultGame = games[0] || { id: 'r2', name: 'Rivals 2', slug: 'rivals-2' };
      draft = {
        id: '',
        title: '',
        game: { id: defaultGame.id, name: defaultGame.name, slug: defaultGame.slug },
        period: { start: '', end: '' },
        status: 'yearly',
        publishedBy: '',
        createdBy: '',
        intro: '',
        imageBox: null,
        players: []
      };
      dirty = false;
    }

    // Resolve character portraits for initial players
    if (draft.players && draft.players.length) {
      draft.players.forEach(p => {
        p._resolvedPortrait = resolvePlayerPortrait(p);
      });
      renderEditor();
      renderSide();
    }

    renderDetails();
    renderAll();
  });

// Modal search and selection state
let playerModalQuery = '';
let playerModalTarget = 'ranking';

function openPlayerModal(target = 'ranking') {
  playerModalTarget = target;
  const modal = $('#player-select-modal');
  if (!modal) return;
  playerModalQuery = '';
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const titleEl = $('#playerModalTitle');
  const subEl = $('#playerModalSub');
  if (titleEl) {
    titleEl.textContent = (target === 'ranking')
      ? (isEs ? 'Seleccionar Jugador' : 'Select Player')
      : (isEs ? 'Seleccionar Rival' : 'Select Opponent');
  }
  if (subEl) {
    subEl.textContent = (target === 'ranking')
      ? (isEs ? 'Busca y selecciona un jugador del directorio' : 'Search and select a player from the directory')
      : (isEs ? 'Selecciona un rival de la base de datos de jugadores' : 'Select an opponent from the player database');
  }
  const searchInput = $('#playerSearchInput');
  if (searchInput) searchInput.value = '';
  renderPlayerModalList();
  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.setAttribute('open', '');
  }
  if (searchInput) setTimeout(() => searchInput.focus(), 50);
}

function closePlayerModal() {
  const modal = $('#player-select-modal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.removeAttribute('open');
  }
}

function renderPlayerModalList() {
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const listEl = $('#playerSelectList');
  if (!listEl) return;

  const isRankingMode = playerModalTarget === 'ranking';
  const currentIds = isRankingMode ? new Set((draft.players || []).map(p => String(p.playerId)).filter(Boolean)) : new Set();
  const q = playerModalQuery.trim().toLowerCase();

  const filtered = allProfiles.filter(p => {
    if (!q) return true;
    const tagMatch = p.tag && p.tag.toLowerCase().includes(q);
    const idMatch = p.playerId && String(p.playerId).includes(q);
    const aliasMatch = (p.aliases || []).some(a => a.toLowerCase().includes(q));
    const sponsorMatch = p.sponsor && p.sponsor.toLowerCase().includes(q);
    return tagMatch || idMatch || aliasMatch || sponsorMatch;
  });

  if (!filtered.length) {
    const emptyMsg = isEs
      ? `No se encontraron jugadores que coincidan con "${esc(playerModalQuery)}"`
      : `No players found matching "${esc(playerModalQuery)}"`;
    listEl.innerHTML = `<div class="player-empty-search">${emptyMsg}</div>`;
    return;
  }

  listEl.innerHTML = filtered.map(p => {
    const isAdded = currentIds.has(String(p.playerId));
    const photoSrc = p.photo || `assets/players/${p.playerId}.png`;
    const avatar = `<span class="player-select-avatar"><i>${esc(p.tag ? p.tag[0] : '?')}</i><img src="${esc(photoSrc)}" alt="" onerror="this.remove()"></span>`;
    const sponsorBadge = p.sponsor ? `<span class="player-select-sponsor">${esc(p.sponsor)}</span>` : '';
    const metaParts = [`ID: ${esc(p.playerId)}`];
    if (p.location) metaParts.push(esc(p.location));
    if (p.events) metaParts.push(isEs ? `${p.events} eventos` : `${p.events} events`);
    const metaStr = metaParts.join(' · ');

    const actionBadge = isAdded
      ? `<span class="player-select-badge added">${isEs ? 'Ya agregado' : 'Already added'}</span>`
      : `<span class="player-select-badge">${isEs ? 'Seleccionar' : 'Select'}</span>`;

    return `<button type="button" class="player-select-item" data-act="choose-player" data-player-id="${esc(p.playerId)}" ${isAdded ? 'disabled' : ''}>
      ${avatar}
      <div class="player-select-info">
        <div class="player-select-tag-row">
          <span class="player-select-tag">${esc(p.tag)}</span>
          ${sponsorBadge}
        </div>
        <div class="player-select-meta">${metaStr}</div>
      </div>
      ${actionBadge}
    </button>`;
  }).join('');
}

async function addPlayerFromDirectory(playerId) {
  const player = allProfiles.find(p => String(p.playerId) === String(playerId));
  if (!player) {
    alert('Player profile could not be found.');
    return;
  }

  if (playerModalTarget && playerModalTarget.type === 'opponent') {
    closePlayerModal();
    updateNotableWinStats(playerModalTarget.index, player.tag, player.playerId);
    return;
  }

  const currentIds = new Set((draft.players || []).map(p => String(p.playerId)).filter(Boolean));
  if (currentIds.has(String(player.playerId))) {
    alert('This player is already included in the ranking.');
    return;
  }

  const newEntry = {
    tag: player.tag,
    playerId: String(player.playerId),
    sponsor: player.sponsor || '',
    points: null,
    photo: (isAdmin && requestedMode === 'admin') ? (player.photo || `assets/players/${player.playerId}.png`) : undefined
  };

  draft.players.push(newEntry);
  sel = draft.players.length - 1;
  dirty = true;
  closePlayerModal();

  // Load crew (sponsor) and up to 3 most-played characters automatically from profile
  const gslug = draft.game?.slug || 'ultimate';
  try {
    const prof = await getProfileData(player.playerId, player.tag);
    if (prof) {
      if (!newEntry.sponsor && prof.player && prof.player.sponsor) {
        newEntry.sponsor = prof.player.sponsor;
      }
      const topMains = getTopCharactersFromProfile(prof, gslug, 3);
      if (topMains.length > 0) {
        newEntry.mains = topMains;
      }
    }
  } catch (err) {
    console.warn('Could not enrich added player from profile:', player.tag, err);
  }

  newEntry._resolvedPortrait = resolvePlayerPortrait(newEntry);
  renderAll();
}

let playerEventResults = [];

function closeEventModal() {
  const modal = $('#event-select-modal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.removeAttribute('open');
  }
}

// --- Notable Wins Modal ---
let playerWinOpponents = [];

function closeWinModal() {
  const modal = $('#win-select-modal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.removeAttribute('open');
  }
}

async function openWinModalForCurrentPlayer() {
  const p = draft.players[sel];
  if (!p) return;
  savedScrollY = window.scrollY || document.documentElement.scrollTop;
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const modal = $('#win-select-modal');
  const listEl = $('#winSelectList');
  if (!modal || !listEl) {
    p.notableWins = p.notableWins || [];
    p.notableWins.push({ opponent: '', tournament: '' });
    preserveScroll(() => renderEditor());
    return;
  }

  listEl.innerHTML = `<div class="player-empty-search">${isEs ? 'Calculando victorias del jugador...' : 'Loading player wins...'}</div>`;

  if (typeof modal.showModal === 'function') {
    modal.showModal();
    window.scrollTo({ top: savedScrollY, behavior: 'instant' });
  } else {
    modal.setAttribute('open', '');
  }

  playerWinOpponents = [];

  const prof = await getProfileData(p.playerId, p.tag);
  if (prof) {
    const gslug = draft.game?.slug || 'ultimate';
    const curGame = (prof.games || []).find(g => g.slug === gslug || g.id === gslug) || prof.games?.[0];
    if (curGame && Array.isArray(curGame.results)) {
      const startDate = draft.period?.start || '';
      const endDate = draft.period?.end || '';

      const byOpp = new Map();
      for (const res of curGame.results) {
        const resDate = res.date || '';
        if (startDate && resDate && resDate < startDate) continue;
        if (endDate && resDate && resDate > endDate) continue;
        for (const s of (res.sets || [])) {
          const outcome = (s.outcome || '').trim().toLowerCase();
          if (outcome !== 'win') continue;
          const oppDisplay = (s.opponent || '').trim();
          const oppKey = oppDisplay.toLowerCase();
          if (!oppKey) continue;
          if (!byOpp.has(oppKey)) byOpp.set(oppKey, { displayTag: oppDisplay, wins: [] });
          byOpp.get(oppKey).wins.push({
            event: res.event || s.event || '',
            eventKey: res.eventKey || s.eventKey || '',
            date: resDate
          });
        }
      }

      playerWinOpponents = [...byOpp.entries()]
        .sort((a, b) => b[1].wins.length - a[1].wins.length || a[1].displayTag.localeCompare(b[1].displayTag))
        .map(([, v]) => {
          const count = v.wins.length;
          if (count === 1) {
            const tourneyName = extractTournamentName(v.wins[0].event, v.wins[0].eventKey);
            return { opponent: v.displayTag, tournament: tourneyName };
          } else {
            return { opponent: v.displayTag, times: count };
          }
        });
    }
  }

  renderWinModalList();
}

function renderWinModalList() {
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const listEl = $('#winSelectList');
  if (!listEl) return;

  if (!playerWinOpponents.length) {
    listEl.innerHTML = `<div class="player-empty-search">${isEs ? 'No se encontraron victorias en este periodo.' : 'No wins found in this period.'}</div>`;
    return;
  }

  listEl.innerHTML = playerWinOpponents.map((w, idx) => {
    const detail = w.times !== undefined
      ? `${w.times} ${isEs ? 'veces' : 'wins'}`
      : esc(w.tournament || '');
    return `<button type="button" class="player-select-item" data-act="choose-win" data-idx="${idx}">
      <span class="player-select-avatar"><span style="font-size:14px;font-weight:700;">✓</span></span>
      <div class="player-select-info">
        <div class="player-select-tag-row">
          <span class="player-select-tag">${esc(w.opponent)}</span>
        </div>
        <div class="player-select-meta">${detail}</div>
      </div>
      <span class="player-select-badge">${isEs ? 'Seleccionar' : 'Select'}</span>
    </button>`;
  }).join('');
}

function selectWinOpponent(idx) {
  const p = draft.players[sel];
  if (!p) return;
  const w = playerWinOpponents[idx];
  if (!w) return;
  p.notableWins = p.notableWins || [];
  if (w.times !== undefined) {
    p.notableWins.push({ opponent: w.opponent, times: w.times });
  } else {
    p.notableWins.push({ opponent: w.opponent, tournament: w.tournament || '' });
  }
  sortNotableWins(p.notableWins, draft.players);
  dirty = true;
  closeWinModal();
  preserveScroll(() => {
    refresh();
    renderEditor();
  });
}

let savedScrollY = 0;

function preserveScroll(callback) {
  savedScrollY = window.scrollY || document.documentElement.scrollTop;
  callback();
  window.scrollTo({ top: savedScrollY, behavior: 'instant' });
}

async function openEventModalForCurrentPlayer() {
  const p = draft.players[sel];
  if (!p) return;
  savedScrollY = window.scrollY || document.documentElement.scrollTop;
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const modal = $('#event-select-modal');
  const listEl = $('#eventSelectList');
  if (!modal || !listEl) {
    p.notableResults = p.notableResults || [];
    p.notableResults.push({ placement: null, event: '', entrants: null });
    preserveScroll(() => renderEditor());
    return;
  }

  listEl.innerHTML = `<div class="player-empty-search">${isEs ? 'Cargando eventos del jugador...' : 'Loading player events...'}</div>`;

  if (typeof modal.showModal === 'function') {
    modal.showModal();
    window.scrollTo({ top: savedScrollY, behavior: 'instant' });
  } else {
    modal.setAttribute('open', '');
  }

  playerEventResults = [];
  if (p.playerId) {
    const matched = allProfiles.find(x => String(x.playerId) === String(p.playerId));
    const slugName = matched?.slug || (p.tag ? slug(p.tag) : '');
    const profilePaths = [
      slugName ? `data/profiles/${slugName}.json` : null,
      (slugName && p.playerId && !slugName.endsWith('-' + p.playerId)) ? `data/profiles/${slugName}-${p.playerId}.json` : null,
      (p.tag && p.playerId) ? `data/profiles/${slug(p.tag)}-${p.playerId}.json` : null,
      p.tag ? `data/profiles/${slug(p.tag)}.json` : null
    ].filter(Boolean);

    for (const path of profilePaths) {
      try {
        const res = await fetch(path);
        if (res.ok) {
          const profileData = await res.json();
          const curGameSlug = draft.game ? draft.game.slug : '';
          const gamesArr = profileData.games || [];
          const matchedGame = gamesArr.find(g => g.slug === curGameSlug) || gamesArr[0];
          if (matchedGame && matchedGame.results) {
            const startDate = draft.period?.start || '';
            const endDate = draft.period?.end || '';
            playerEventResults = matchedGame.results.filter(r => {
              const resDate = r.date || '';
              if (startDate && resDate && resDate < startDate) return false;
              if (endDate && resDate && resDate > endDate) return false;
              return true;
            });
            break;
          }
        }
      } catch (e) {}
    }
  }

  renderEventModalList();
}

function extractTournamentName(rawEventName, eventKey) {
  if (!rawEventName && !eventKey) return '';
  const str = String(rawEventName || '').trim();
  if (eventsIndexList && eventsIndexList.length) {
    if (eventKey) {
      const match = eventsIndexList.find(e => e.id === String(eventKey) || e.tournamentSlug === String(eventKey));
      if (match && match.tournament) return match.tournament;
    }
    const matchTourn = eventsIndexList.find(e => e.tournament && (str === e.tournament || str.startsWith(e.tournament + ' ·')));
    if (matchTourn) return matchTourn.tournament;
  }
  if (str.includes(' · ')) {
    return str.split(' · ')[0].trim();
  }
  return str;
}

function renderEventModalList() {
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const listEl = $('#eventSelectList');
  if (!listEl) return;

  if (!playerEventResults.length) {
    listEl.innerHTML = `<div class="player-empty-search">${isEs ? 'No se encontraron resultados de torneos para este jugador.' : 'No tournament results found for this player.'}</div>`;
    return;
  }

  listEl.innerHTML = playerEventResults.map((r, idx) => {
    const place = r.place ?? r.placement ?? '?';
    const tournamentName = extractTournamentName(r.event || r.eventName || r.tournament, r.eventKey);
    const entrants = r.entrants ? (isEs ? `${r.entrants} participantes` : `${r.entrants} entrants`) : '';
    const date = r.date || '';
    const meta = [entrants, date].filter(Boolean).join(' · ');

    return `<button type="button" class="player-select-item" data-act="choose-event" data-idx="${idx}">
      <span class="player-select-avatar"><span style="font-size:16px;font-weight:700;">${place}</span></span>
      <div class="player-select-info">
        <div class="player-select-tag-row">
          <span class="player-select-tag">${esc(tournamentName)}</span>
        </div>
        <div class="player-select-meta">${meta}</div>
      </div>
      <span class="player-select-badge">${isEs ? 'Seleccionar' : 'Select'}</span>
    </button>`;
  }).join('');
}

function selectEventForNotableResult(idx) {
  const p = draft.players[sel];
  if (!p) return;
  const ev = playerEventResults[idx];
  if (!ev) return;
  p.notableResults = p.notableResults || [];
  const tournamentName = extractTournamentName(ev.event || ev.eventName || ev.tournament, ev.eventKey);
  p.notableResults.push({
    placement: ev.place ?? ev.placement ?? null,
    event: tournamentName,
    entrants: ev.entrants ?? null
  });
  sortNotableResults(p.notableResults);
  dirty = true;
  closeEventModal();
  preserveScroll(() => {
    refresh();
    renderEditor();
  });
}

async function updateNotableWinStats(winIndex, opponentTag, opponentId) {
  const p = draft.players[sel];
  if (!p || !p.notableWins || !p.notableWins[winIndex]) return;
  const w = p.notableWins[winIndex];
  w.opponent = opponentTag;

  try {
    const prof = await getProfileData(p.playerId, p.tag);
    if (prof) {
      const gslug = draft.game?.slug || 'ultimate';
      const curGame = (prof.games || []).find(g => g.slug === gslug || g.id === gslug) || prof.games?.[0];
      if (curGame && Array.isArray(curGame.results)) {
        const startDate = draft.period?.start || '';
        const endDate = draft.period?.end || '';

        const oppTagNorm = (opponentTag || '').trim().toLowerCase();
        const oppMatched = allProfiles.find(x =>
          (opponentId && String(x.playerId) === String(opponentId)) ||
          (x.tag && x.tag.trim().toLowerCase() === oppTagNorm)
        );
        const oppAliases = new Set([oppTagNorm]);
        if (oppMatched) {
          if (oppMatched.tag) oppAliases.add(oppMatched.tag.trim().toLowerCase());
          if (Array.isArray(oppMatched.aliases)) {
            oppMatched.aliases.forEach(a => oppAliases.add(String(a).trim().toLowerCase()));
          }
        }

        const winSets = [];
        for (const res of curGame.results) {
          const resDate = res.date || '';
          if (startDate && resDate && resDate < startDate) continue;
          if (endDate && resDate && resDate > endDate) continue;
          for (const s of (res.sets || [])) {
            const oppName = (s.opponent || '').trim().toLowerCase();
            const outcome = (s.outcome || '').trim().toLowerCase();
            if (oppAliases.has(oppName) && outcome === 'win') {
              winSets.push({
                date: resDate,
                event: res.event || s.event || '',
                eventKey: res.eventKey || s.eventKey || ''
              });
            }
          }
        }

        if (winSets.length === 1) {
          delete w.times;
          const tourneyName = extractTournamentName(winSets[0].event, winSets[0].eventKey);
          w.tournament = tourneyName || '';
        } else if (winSets.length > 1) {
          delete w.tournament;
          w.times = winSets.length;
        } else {
          if (w.times === undefined && w.tournament === undefined) {
            w.tournament = '';
          }
        }
      }
    }
  } catch (err) {
    console.warn('Could not compute notable win stats:', err);
  }

  sortNotableWins(p.notableWins, draft.players);
  dirty = true;
  refresh();
  renderEditor();
}

document.addEventListener('input', onInput);
document.addEventListener('click', onClick);
document.addEventListener('change', onChange);
document.addEventListener('click', e => {
  if (e.target.id === 'closePlayerModalBtn' || e.target.closest('#closePlayerModalBtn')) {
    e.preventDefault();
    closePlayerModal();
  }
  if (e.target === $('#player-select-modal')) closePlayerModal();
  if (e.target.id === 'closeEventModalBtn' || e.target.closest('#closeEventModalBtn')) {
    e.preventDefault();
    closeEventModal();
    window.scrollTo({ top: savedScrollY, behavior: 'instant' });
  }
  if (e.target === $('#event-select-modal')) {
    closeEventModal();
    window.scrollTo({ top: savedScrollY, behavior: 'instant' });
  }
  if (e.target.id === 'closeCropModalBtn' || e.target.closest('#closeCropModalBtn') || e.target.id === 'cancelCropBtn') {
    e.preventDefault();
    closeCropModal();
  }
  if (e.target === $('#crop-modal')) closeCropModal();
  if (e.target.id === 'applyCropBtn') {
    e.preventDefault();
    confirmCrop();
  }
  if (e.target.id === 'addBlankResultBtn') {
    e.preventDefault();
    const p = draft.players[sel];
    if (p) {
      p.notableResults = p.notableResults || [];
      p.notableResults.push({ placement: null, event: '', entrants: null });
      sortNotableResults(p.notableResults);
      dirty = true;
      closeEventModal();
      preserveScroll(() => {
        refresh();
        renderEditor();
      });
    }
  }
  if (e.target.id === 'closeWinModalBtn' || e.target.closest('#closeWinModalBtn')) {
    e.preventDefault();
    closeWinModal();
    window.scrollTo({ top: savedScrollY, behavior: 'instant' });
  }
  if (e.target === $('#win-select-modal')) {
    closeWinModal();
    window.scrollTo({ top: savedScrollY, behavior: 'instant' });
  }
  if (e.target.id === 'addBlankWinBtn') {
    e.preventDefault();
    const p = draft.players[sel];
    if (p) {
      p.notableWins = p.notableWins || [];
      p.notableWins.push({ opponent: '', tournament: '' });
      sortNotableWins(p.notableWins, draft.players);
      dirty = true;
      closeWinModal();
      preserveScroll(() => {
        refresh();
        renderEditor();
      });
    }
  }
});

document.addEventListener('mousedown', e => {
  const viewport = e.target.closest('#cropViewport');
  if (viewport) {
    e.preventDefault();
    cropIsDragging = true;
    cropDragStartX = e.clientX;
    cropDragStartY = e.clientY;
    cropDragStartOffsetX = cropOffsetX;
    cropDragStartOffsetY = cropOffsetY;
  }
});

document.addEventListener('mousemove', e => {
  if (cropIsDragging && cropImageObj) {
    cropOffsetX = cropDragStartOffsetX + (e.clientX - cropDragStartX);
    cropOffsetY = cropDragStartOffsetY + (e.clientY - cropDragStartY);
    clampCropOffsets();
    drawCropCanvas();
  }
});

document.addEventListener('mouseup', () => {
  cropIsDragging = false;
});

document.addEventListener('touchstart', e => {
  const viewport = e.target.closest('#cropViewport');
  if (viewport && e.touches[0]) {
    cropIsDragging = true;
    cropDragStartX = e.touches[0].clientX;
    cropDragStartY = e.touches[0].clientY;
    cropDragStartOffsetX = cropOffsetX;
    cropDragStartOffsetY = cropOffsetY;
  }
}, { passive: true });

document.addEventListener('touchmove', e => {
  if (cropIsDragging && cropImageObj && e.touches[0]) {
    cropOffsetX = cropDragStartOffsetX + (e.touches[0].clientX - cropDragStartX);
    cropOffsetY = cropDragStartOffsetY + (e.touches[0].clientY - cropDragStartY);
    clampCropOffsets();
    drawCropCanvas();
  }
}, { passive: true });

document.addEventListener('touchend', () => {
  cropIsDragging = false;
});

document.addEventListener('wheel', e => {
  const viewport = e.target.closest('#cropViewport');
  if (viewport && cropImageObj) {
    e.preventDefault();
    const slider = $('#cropZoomSlider');
    if (slider) {
      const delta = e.deltaY > 0 ? -0.08 : 0.08;
      const nextVal = Math.min(3, Math.max(1, parseFloat(slider.value) + delta));
      slider.value = nextVal;
      onCropZoom(nextVal);
    }
  }
}, { passive: false });

let highlightedMainsIndex = -1;

function getMainsCandidates() {
  const inp = $('#newMain');
  const q = (inp ? inp.value : '').trim().toLowerCase();
  const chars = (draft.game && gameCharacters[draft.game.slug]) || [];
  if (!q) return chars;
  return chars.filter(c => c.toLowerCase().includes(q));
}

function renderMainsDropdown() {
  const dd = $('#mainsDropdown');
  if (!dd) return;
  const candidates = getMainsCandidates();
  if (!candidates.length) {
    dd.innerHTML = '<div class="mains-empty">No matching characters</div>';
  } else {
    dd.innerHTML = candidates.map((name, idx) => {
      const isHigh = idx === highlightedMainsIndex ? ' highlighted' : '';
      return `
        <div class="mains-item${isHigh}" data-name="${esc(name)}">
          <span class="stock">${stock(name)}</span>
          <span class="mains-item-title">${esc(name)}</span>
        </div>
      `;
    }).join('');
  }
  dd.hidden = false;
}

function closeMainsDropdown() {
  const dd = $('#mainsDropdown');
  if (dd) dd.hidden = true;
  highlightedMainsIndex = -1;
}

function selectMainsOption(name) {
  if (!name) return;
  const p = draft.players[sel];
  if (!p) return;
  p.mains = p.mains || [];
  p.mains.push(name);
  p._resolvedPortrait = resolvePlayerPortrait(p);
  renderEditor();
  closeMainsDropdown();
}

document.addEventListener('input', e => {
  if (e.target.id === 'newMain') {
    highlightedMainsIndex = -1;
    renderMainsDropdown();
  }
});

document.addEventListener('focusin', e => {
  if (e.target.id === 'newMain' && e.target.value.trim()) {
    highlightedMainsIndex = -1;
    renderMainsDropdown();
  }
});

document.addEventListener('keydown', e => {
  if (e.target.id === 'newMain') {
    const dd = $('#mainsDropdown');
    if (!dd || dd.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        renderMainsDropdown();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const v = e.target.value.trim();
        if (v) selectMainsOption(v);
      }
      return;
    }

    const items = dd.querySelectorAll('.mains-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) {
        highlightedMainsIndex = (highlightedMainsIndex + 1) % items.length;
        items.forEach((it, i) => {
          if (i === highlightedMainsIndex) {
            it.classList.add('highlighted');
            it.scrollIntoView({ block: 'nearest' });
          } else {
            it.classList.remove('highlighted');
          }
        });
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) {
        highlightedMainsIndex = (highlightedMainsIndex - 1 + items.length) % items.length;
        items.forEach((it, i) => {
          if (i === highlightedMainsIndex) {
            it.classList.add('highlighted');
            it.scrollIntoView({ block: 'nearest' });
          } else {
            it.classList.remove('highlighted');
          }
        });
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedMainsIndex >= 0 && items[highlightedMainsIndex]) {
        selectMainsOption(items[highlightedMainsIndex].getAttribute('data-name'));
      } else {
        const v = e.target.value.trim();
        if (v) selectMainsOption(v);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMainsDropdown();
    }
  }
});

document.addEventListener('mousedown', e => {
  const item = e.target.closest('.mains-item');
  if (item) {
    e.preventDefault();
    selectMainsOption(item.getAttribute('data-name'));
    return;
  }
  const inp = $('#newMain');
  const dd = $('#mainsDropdown');
  if (dd && !dd.hidden && inp && !inp.contains(e.target) && !dd.contains(e.target)) {
    closeMainsDropdown();
  }
});
document.addEventListener('dragstart', e => {
  const prow = e.target.closest && e.target.closest('.prow');
  if (prow) {
    dragFrom = +prow.dataset.i;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    return;
  }
  const sortable = e.target.closest && e.target.closest('.rowf-sortable');
  if (sortable) {
    dragSubtype = sortable.dataset.sortSection;
    dragSubFrom = +sortable.dataset.i;
    sortable.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  }
});
document.addEventListener('dragover', e => {
  const prow = e.target.closest && e.target.closest('.prow');
  if (prow && dragFrom !== null) {
    e.preventDefault();
    document.querySelectorAll('.prow.over').forEach(x => x.classList.remove('over'));
    prow.classList.add('over');
    return;
  }
  const sortable = e.target.closest && e.target.closest('.rowf-sortable');
  if (sortable && dragSubtype && sortable.dataset.sortSection === dragSubtype && dragSubFrom !== null) {
    e.preventDefault();
    document.querySelectorAll('.rowf-sortable.drag-over').forEach(x => x.classList.remove('drag-over'));
    sortable.classList.add('drag-over');
  }
});
document.addEventListener('dragend', () => {
  document.querySelectorAll('.rowf-sortable.dragging').forEach(x => x.classList.remove('dragging'));
  document.querySelectorAll('.rowf-sortable.drag-over').forEach(x => x.classList.remove('drag-over'));
  dragSubtype = null;
  dragSubFrom = null;
});
document.addEventListener('drop', e => {
  const prow = e.target.closest && e.target.closest('.prow');
  if (prow && dragFrom !== null) {
    e.preventDefault();
    const cur = draft.players[sel], [m] = draft.players.splice(dragFrom, 1);
    draft.players.splice(+prow.dataset.i, 0, m);
    sel = draft.players.indexOf(cur); dragFrom = null; dirty = true; renderAll();
    return;
  }
  const sortable = e.target.closest && e.target.closest('.rowf-sortable');
  if (sortable && dragSubtype && sortable.dataset.sortSection === dragSubtype && dragSubFrom !== null) {
    e.preventDefault();
    const toIndex = +sortable.dataset.i;
    const p = draft.players[sel];
    if (p && Array.isArray(p[dragSubtype]) && dragSubFrom !== toIndex) {
      const [item] = p[dragSubtype].splice(dragSubFrom, 1);
      p[dragSubtype].splice(toIndex, 0, item);
      dirty = true;
      preserveScroll(() => renderEditor());
    }
    dragSubtype = null;
    dragSubFrom = null;
  }
});

const OPT = { realName: '', mains: [], text: '', notableWins: [], notableResults: [] };
const nums = v => String(v).trim() === '' ? null : Number(String(v).replace(/[^\d]/g, ''));

function sortNotableResults(results) {
  if (!Array.isArray(results) || results.length <= 1) return results;
  return results.sort((a, b) => {
    const placeA = (a.placement !== null && a.placement !== undefined && !Number.isNaN(Number(a.placement))) ? Number(a.placement) : Infinity;
    const placeB = (b.placement !== null && b.placement !== undefined && !Number.isNaN(Number(b.placement))) ? Number(b.placement) : Infinity;
    if (placeA !== placeB) {
      return placeA - placeB;
    }
    const entA = (a.entrants !== null && a.entrants !== undefined && !Number.isNaN(Number(a.entrants))) ? Number(a.entrants) : -Infinity;
    const entB = (b.entrants !== null && b.entrants !== undefined && !Number.isNaN(Number(b.entrants))) ? Number(b.entrants) : -Infinity;
    if (entA !== entB) {
      return entB - entA;
    }
    return (a.event || '').localeCompare(b.event || '');
  });
}

function getOpponentRankingPoints(opponentName, players) {
  if (!opponentName || !Array.isArray(players)) return -Infinity;
  const target = String(opponentName).trim().toLowerCase();
  const matched = players.find(p => {
    if (p.tag && String(p.tag).trim().toLowerCase() === target) return true;
    if (p.playerId && String(p.playerId).trim() === target) return true;
    return false;
  });
  if (matched && matched.points !== null && matched.points !== undefined && !Number.isNaN(Number(matched.points))) {
    return Number(matched.points);
  }
  return -Infinity;
}

function sortNotableWins(wins, players = draft?.players) {
  if (!Array.isArray(wins) || wins.length <= 1) return wins;
  return wins.sort((a, b) => {
    const ptsA = getOpponentRankingPoints(a.opponent, players);
    const ptsB = getOpponentRankingPoints(b.opponent, players);
    if (ptsA !== ptsB) {
      return ptsB - ptsA;
    }
    return (a.opponent || '').localeCompare(b.opponent || '');
  });
}
const parseDecimal = v => {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const has = a => a && a.length;
const kind = p => ((p.text && p.text.trim()) || has(p.notableWins) || has(p.notableResults)) ? 'FULL'
  : (has(p.mains) || (p.realName && p.realName.trim())) ? 'MEDIUM' : 'MINIMUM';
const getWhy = () => {
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  return isEs ? {
    FULL: 'Se muestra como entrada completa porque tiene descripción del jugador o victorias/resultados destacados.',
    MEDIUM: 'Se muestra como entrada mediana porque tiene personajes principales o nombre real.',
    MINIMUM: 'Se muestra como fila mínima: solo puesto, imagen, tag y puntos.'
  } : {
    FULL: 'Shown as a full entry because it has a player description or notable wins or results.',
    MEDIUM: 'Shown as a medium entry because it has mains or a real name.',
    MINIMUM: 'Shown as a minimum row: placement, picture, tag and points only.'
  };
};
const lab = t => `<div class="lab"><span>${t}</span></div>`;
const lab2 = t => `<div class="lab"><span>${t}</span></div>`;
const stock = name => {
  const gslug = draft.game?.slug || 'ultimate';
  const cslug = charStockSlug(name);
  return `<span class="stock"><i>${esc(name ? name[0] : '?')}</i><img src="assets/renders/${esc(gslug)}/stocks/${esc(cslug)}.webp" alt="" onerror="if(!this.dataset.fallback){this.dataset.fallback='1';this.src='assets/renders/${esc(gslug)}/stocks/other.webp';}else{this.remove();}"></span>`;
};

// Profile cache for resolving top played character portraits
const profileCache = new Map();

async function getProfileData(playerId, tag) {
  if (!playerId && !tag) return null;
  const key = String(playerId || tag);
  if (profileCache.has(key)) return profileCache.get(key);

  const matched = allProfiles.find(x => String(x.playerId) === String(playerId) || (tag && slug(x.tag) === slug(tag)));
  const slugName = matched?.slug || (tag ? slug(tag) : '');
  const candidatePaths = [
    slugName ? `data/profiles/${slugName}.json` : null,
    (slugName && playerId && !slugName.endsWith('-' + playerId)) ? `data/profiles/${slugName}-${playerId}.json` : null,
    (tag && playerId) ? `data/profiles/${slug(tag)}-${playerId}.json` : null,
    tag ? `data/profiles/${slug(tag)}.json` : null
  ].filter(Boolean);

  for (const path of candidatePaths) {
    try {
      const res = await fetch(path);
      if (res.ok) {
        const data = await res.json();
        profileCache.set(key, data);
        return data;
      }
    } catch (e) {}
  }
  return null;
}

function getTopCharactersFromProfile(prof, gslug, limit = 3) {
  if (!prof || !Array.isArray(prof.games)) return [];
  const curGame = prof.games.find(g => g.slug === gslug || g.id === gslug) || prof.games[0];
  if (!curGame || !Array.isArray(curGame.characters)) return [];
  return curGame.characters
    .filter(c => c && c.name && String(c.name).trim().toLowerCase() !== 'other')
    .slice(0, limit)
    .map(c => c.name);
}

function resolvePlayerPortrait(p) {
  const gslug = draft?.game?.slug || 'ultimate';
  if (p && Array.isArray(p.mains) && p.mains.length) {
    return charPortraitPath(gslug, p.mains[0]);
  }
  const defaultChar = (gameCharacters[gslug] && gameCharacters[gslug][0]) ? gameCharacters[gslug][0] : 'other';
  return charPortraitPath(gslug, defaultChar);
}

function getPlayerPictureSrc(p) {
  const gslug = draft?.game?.slug || 'ultimate';
  const isAdminCreation = isAdmin && requestedMode === 'admin';
  if (isAdminCreation) {
    return p._preview || p.photo || (p.playerId ? `assets/players/${p.playerId}.png` : (p._resolvedPortrait || (p.mains && p.mains.length ? charPortraitPath(gslug, p.mains[0]) : '')));
  }
  return p._resolvedPortrait || (p.mains && p.mains.length ? charPortraitPath(gslug, p.mains[0]) : `assets/renders/${gslug}/portraits/other.webp`);
}

const rowId = () => draft.id || `${draft.game.id}-${slug(draft.title || 'ranking')}`;

function renderAll() { renderSide(); renderEditor(); renderSub(); }
function refresh() {
  renderSide();
  renderSub();
  if (draft.players && draft.players[sel]) {
    const p = draft.players[sel], k = kind(p);
    const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
    $('#kindPill').textContent = isEs ? (k === 'FULL' ? 'ENTRADA COMPLETA' : k === 'MEDIUM' ? 'ENTRADA MEDIANA' : 'ENTRADA MÍNIMA') : k + ' ENTRY';
    $('#why').textContent = getWhy()[k];
  }
}

function renderSub() {
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  $('#crumbGame').textContent = draft.game.name;
  const statusStr = dirty
    ? (isEs ? 'Cambios sin guardar' : 'Unsaved changes')
    : savedAt
      ? (isEs ? 'Guardado a las ' + savedAt : 'Saved at ' + savedAt)
      : (isEs ? 'Sin cambios aún' : 'No changes yet');
  $('#sub').textContent = `${isEs ? 'Comunidad de ' + draft.game.name : draft.game.name + ' community'} · ${statusStr}`;
}

async function populateFromSnapshot(count) {
  if (!prSnapshot || !prSnapshot.players || !prSnapshot.players.length) return;
  const countNum = parseInt(count, 10);
  const playersToTake = prSnapshot.players.slice(0, countNum);

  draft.players = playersToTake.map((p, idx) => {
    const matchedProfile = allProfiles.find(x =>
      (p.playerId && String(x.playerId) === String(p.playerId)) ||
      (p.tag && x.tag && x.tag.trim().toLowerCase() === String(p.tag).trim().toLowerCase())
    );
    const sponsor = (p.sponsor !== undefined && p.sponsor !== null && p.sponsor !== '')
      ? p.sponsor
      : (matchedProfile?.sponsor || '');

    const playerObj = {
      placement: idx + 1,
      tag: p.tag || '',
      sponsor: sponsor,
      points: p.points !== null && p.points !== undefined ? p.points : null,
      photo: p.photo || '',
      playerId: p.playerId || ''
    };

    if (Array.isArray(p.mains) && p.mains.length) {
      playerObj.mains = [...p.mains];
    }

    return playerObj;
  });

  // Automatically populate most-used characters for each player from profile data
  const gslug = draft.game?.slug || prSnapshot.game?.slug || 'ultimate';

  const enrichPromises = draft.players.map(async (p) => {
    try {
      const prof = await getProfileData(p.playerId, p.tag);
      if (prof) {
        if (!p.sponsor && prof.player && prof.player.sponsor) {
          p.sponsor = prof.player.sponsor;
        }
        if (!p.mains || !p.mains.length) {
          const topMains = getTopCharactersFromProfile(prof, gslug, 3);
          if (topMains.length > 0) {
            p.mains = topMains;
          }
        }
      }
    } catch (err) {
      console.warn('Could not enrich player from profile:', p.tag, err);
    }
    p._resolvedPortrait = resolvePlayerPortrait(p);
  });

  sel = 0;
  dirty = true;
  renderAll();

  await Promise.all(enrichPromises);
  renderAll();
}

function renderDetails() {
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');

  let snapshotControlsHtml = '';
  if (prSnapshot && prSnapshot.players && prSnapshot.players.length) {
    snapshotControlsHtml = `
      <div class="pr-snapshot-box glass" style="padding:14px 18px; border-radius:18px; margin-bottom:16px; border:1px solid rgba(56,189,248,.3); background:rgba(56,189,248,.08);">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
          <div>
            <span class="eyebrow mono" style="color:var(--sky); font-weight:700;">${isEs ? 'POBLACIÓN RÁPIDA DESDE POWER RANKINGS' : 'QUICK POPULATE FROM POWER RANKINGS'}</span>
            <div style="font-size:13px; color:var(--muted); margin-top:2px;">${isEs ? `Snapshot capturado con ${prSnapshot.players.length} jugadores en orden calculado.` : `Captured snapshot with ${prSnapshot.players.length} ranked players in calculated order.`}</div>
          </div>
          <div class="seg glass pill" style="display:inline-flex; gap:6px;">
            <button type="button" class="btn glass pill" data-act="pop-snapshot" data-n="10" style="padding:4px 12px; font-size:13px; cursor:pointer;">${isEs ? 'Agregar 10' : 'Add 10'}</button>
            <button type="button" class="btn glass pill" data-act="pop-snapshot" data-n="20" style="padding:4px 12px; font-size:13px; cursor:pointer;">${isEs ? 'Agregar 20' : 'Add 20'}</button>
            <button type="button" class="btn glass pill" data-act="pop-snapshot" data-n="50" style="padding:4px 12px; font-size:13px; cursor:pointer;">${isEs ? 'Agregar 50' : 'Add 50'}</button>
            <button type="button" class="btn glass pill" data-act="pop-snapshot" data-n="100" style="padding:4px 12px; font-size:13px; cursor:pointer;">${isEs ? 'Agregar 100' : 'Add 100'}</button>
          </div>
        </div>
      </div>
    `;
  }

  const isYearly = draft.status === 'yearly';
  let curYear = '';
  if (isYearly) {
    curYear = (draft.period.start || '').slice(0, 4) || (draft.period.end || '').slice(0, 4) || new Date().getFullYear().toString();
    draft.period.start = `${curYear}-01-01`;
    draft.period.end = `${curYear}-12-31`;
  }

  const periodInputsHtml = isYearly
    ? `<div class="fld" style="flex:1 1 160px">${lab(isEs ? 'AÑO' : 'YEAR')}<input type="number" class="inp inp-req mono" data-bind="year" min="2000" max="2100" value="${esc(curYear)}" placeholder="2026"></div>`
    : `<div class="fld" style="flex:1 1 160px">${lab(isEs ? 'INICIO DEL PERIODO' : 'PERIOD START')}<input type="date" class="inp inp-req" data-bind="start" value="${draft.period.start}"></div>
       <div class="fld" style="flex:1 1 160px">${lab(isEs ? 'FIN DEL PERIODO' : 'PERIOD END')}<input type="date" class="inp inp-req" data-bind="end" value="${draft.period.end}"></div>`;

  $('#details').innerHTML = `${snapshotControlsHtml}<div><h2>${isEs ? 'Detalles del ranking' : 'Ranking details'}</h2><div class="sub">${isEs ? 'Se muestra en el archivo y al inicio del artículo.' : 'Shown in the archive and at the top of the article.'}</div></div>
    <div class="frow"><div class="fld" style="flex:2 1 320px">${lab(isEs ? 'NOMBRE' : 'NAME')}<input class="inp inp-req" data-bind="title" value="${esc(draft.title)}" placeholder="e.g. Montevideo Season 1 PR"></div>
      <div class="fld" style="flex:1 1 200px">${lab(isEs ? 'JUEGO' : 'GAME')}<select class="inp inp-req" data-bind="game">${games.map(g => `<option value="${g.id}"${g.id === draft.game.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div></div>
    <div class="frow">${periodInputsHtml}
      <div class="fld">${lab(isEs ? 'CLASIFICACIÓN' : 'CLASSIFICATION')}<div class="seg seg-req glass pill" id="status">${['yearly', 'seasonal'].map(s => `<button type="button" class="${draft.status === s ? 'on' : ''}" data-act="status" data-v="${s}">${s === 'yearly' ? (isEs ? 'Anual' : 'Yearly') : (isEs ? 'De temporada' : 'Seasonal')}</button>`).join('')}</div></div></div>
    ${(isAdmin && requestedMode === 'admin') ? `<div class="fld">${lab(isEs ? 'PUBLICADO POR' : 'PUBLISHED BY')}<input class="inp" data-bind="publishedBy" value="${esc(draft.publishedBy || '')}"></div>` : ''}
    <div class="fld">${lab(isEs ? 'CREADO POR' : 'CREATED BY')}<input class="inp" data-bind="createdBy" maxlength="80" value="${esc(draft.createdBy || '')}" placeholder="${isEs ? 'Alias o nombre para mostrar' : 'Display name, alias, or handle'}"></div>
    <div class="fld">${lab(isEs ? 'INTRODUCCIÓN' : 'INTRO')}<textarea class="inp" data-bind="intro" placeholder="Introductory notes...">${esc(draft.intro || '')}</textarea><div class="cnt" id="introCount">${(draft.intro || '').length} ${isEs ? 'caracteres' : 'characters'}</div></div>
    ${renderImageBoxDetails()}`;
}

function renderImageBoxDetails() {
  const isAdminCreation = isAdmin && requestedMode === 'admin';
  if (!isAdminCreation) return '';
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const imgBox = draft.imageBox || { url: '', placement: 'after_intro', caption: '' };
  const hasImg = Boolean(imgBox.url);

  const placementOptions = [
    ['beginning', isEs ? '1. Inicio (antes de la introducción)' : '1. Beginning (before introduction)'],
    ['after_intro', isEs ? '2. Después de la introducción' : '2. After the introduction'],
    ['end', isEs ? '3. Final (después del último jugador)' : '3. End (after final player)']
  ];

  return `
    <div class="sec glass" data-sec="imageBox" style="margin-top:8px;">
      <div class="sh">
        <b>${isEs ? 'Imagen del Power Ranking' : 'Power Ranking Picture'}</b>
        <span class="sp"></span>
        <button type="button" class="btn glass pill image-box-clear-btn" data-act="clear-image-box" style="padding:4px 12px;font-size:12px;${hasImg ? '' : 'display:none;'}">${isEs ? 'Quitar imagen' : 'Remove image'}</button>
      </div>
      <div class="frow" style="gap:16px;">
        <div class="fld" style="flex:2 1 280px;">
          ${lab(isEs ? 'URL DE LA IMAGEN' : 'IMAGE URL')}
          <div style="display:flex;gap:8px;">
            <input class="inp" data-img-bind="url" value="${esc(imgBox.url || '')}" placeholder="https://... or upload local file">
            <button type="button" class="btn glass pill" data-act="pick-box-image" style="white-space:nowrap;min-height:46px;padding:0 14px;">📁 ${isEs ? 'Subir' : 'Upload'}</button>
            <input type="file" id="imageBoxFileInput" accept="image/png,image/jpeg,image/webp" hidden>
          </div>
          <div class="note0" style="margin-top:4px;">${isEs ? 'PNG, JPEG o WebP · Máx. 5 MB' : 'PNG, JPEG or WebP · Max 5 MB'}</div>
        </div>
        <div class="fld" style="flex:1 1 240px;">
          ${lab(isEs ? 'UBICACIÓN EN EL ARTÍCULO' : 'PLACEMENT IN ARTICLE')}
          <select class="inp" data-img-bind="placement">
            ${placementOptions.map(([val, label]) => `<option value="${val}"${imgBox.placement === val ? ' selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="fld" style="margin-top:8px;">
        ${lab(isEs ? 'EPÍGRAFE / TEXTO DE LA IMAGEN' : 'IMAGE CAPTION')}
        <input class="inp" data-img-bind="caption" value="${esc(imgBox.caption || '')}" placeholder="${isEs ? 'Leyenda opcional bajo la imagen' : 'Optional caption below the image'}">
      </div>
      <div id="imageBoxPreviewContainer">
        ${hasImg ? `
          <div class="image-box-preview">
            <img src="${esc(imgBox.url)}" alt="" onerror="this.src='';">
            <button type="button" class="x glass pill remove-img-box-btn" data-act="clear-image-box" aria-label="Remove image">×</button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function updateImageBoxPreview() {
  const container = $('#imageBoxPreviewContainer');
  const clearBtn = $('.image-box-clear-btn');
  const url = (draft.imageBox?.url || '').trim();
  if (clearBtn) {
    clearBtn.style.display = url ? '' : 'none';
  }
  if (!container) return;
  if (url) {
    container.innerHTML = `
      <div class="image-box-preview">
        <img src="${esc(url)}" alt="" onerror="this.src='';">
        <button type="button" class="x glass pill remove-img-box-btn" data-act="clear-image-box" aria-label="Remove image">×</button>
      </div>
    `;
  } else {
    container.innerHTML = '';
  }
}

function renderSide() {
  const ps = draft.players;
  const item = (ok, t, s) => `<div class="ci${ok ? ' done' : ''}"><i></i><span>${t}</span><small>${s}</small></div>`;
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const okD = draft.title.trim() && draft.period.start && draft.period.end;
  const okP = ps.length > 0 && ps.every(p => p.tag && p.tag.trim());
  const pics = ps.filter(p => p.photo || p._preview).length;
  const mainsCount = ps.filter(p => Array.isArray(p.mains) && p.mains.length > 0).length;
  const isAdminCreation = isAdmin && requestedMode === 'admin';
  const checkPlayersText = isEs
    ? `Puesto y tag para los ${ps.length} jugadores`
    : `Placement and tag for all ${ps.length} players`;
  const checkDetailsText = isEs ? 'Nombre, juego y periodo' : 'Name, game and period';
  const checkPicsText = isAdminCreation
    ? (isEs ? 'Imágenes (opcional)' : 'Pictures (optional)')
    : (isEs ? 'Personajes principales' : 'Mains');
  const doneText = isEs ? 'LISTO' : 'DONE';
  const missingText = isEs ? 'FALTANTE' : 'MISSING';
  const picsSub = isAdminCreation
    ? `${pics} ${isEs ? 'DE' : 'OF'} ${ps.length}`
    : `${mainsCount} ${isEs ? 'DE' : 'OF'} ${ps.length}`;

  $('#side').innerHTML = `<div class="plist glass"><div class="hd"><b>${isEs ? 'Jugadores' : 'Players'}</b><span class="mono muted sm0">${ps.length}</span></div>` +
    ps.map((p, i) => `<button type="button" class="prow${i === sel ? ' on' : ''}" draggable="true" data-act="sel" data-i="${i}"><span class="h">⋮⋮</span><span class="n ${pcls(i + 1)}">${i + 1}</span><span class="t">${esc(p.tag || (isEs ? 'Nuevo jugador' : 'New player'))}</span><span class="k">${kind(p)}</span></button>`).join('') +
    `<button type="button" class="btn glass pill addp" data-act="add-player">${isEs ? '+ Agregar jugador' : '+ Add player'}</button>
     <div class="note">${isEs ? 'Arrastra para reordenar. Los puestos siguen el orden.' : 'Drag to reorder. Placements follow the order.'} <button type="button" class="add" style="padding:0" data-act="sort">${isEs ? 'Ordenar por puntos' : 'Sort by points'}</button></div></div>
    <div class="check glass"><b>${isEs ? 'Antes de publicar' : 'Checklist'}</b>${item(okD, checkDetailsText, okD ? doneText : missingText)}${item(okP, checkPlayersText, okP ? doneText : missingText)}${item(true, checkPicsText, picsSub)}</div>`;
}

function renderEditor() {
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  if (!draft.players || !draft.players.length) {
    $('#editor').innerHTML = `<div class="panel glass empty-state" style="padding:36px; text-align:center;">
      <h3>${isEs ? 'No hay jugadores en este ranking' : 'No players in this ranking'}</h3>
      <p class="muted" style="margin:12px 0 20px;">${isEs ? 'Haz clic en "+ Agregar jugador" para seleccionar jugadores del directorio.' : 'Click "+ Add player" to select players from the directory.'}</p>
      <button type="button" class="btn glass pill" data-act="add-player">${isEs ? '+ Agregar jugador' : '+ Add player'}</button>
    </div>`;
    return;
  }
  const p = draft.players[sel] || draft.players[0];
  const n = sel + 1, k = kind(p);
  const isAdminCreation = isAdmin && requestedMode === 'admin';
  const gslug = draft?.game?.slug || 'ultimate';
  const picSrc = getPlayerPictureSrc(p);
  const genericFallback = `assets/renders/${gslug}/portraits/other.webp`;
  const portraitFallback = p._resolvedPortrait || (p.mains && p.mains.length ? charPortraitPath(gslug, p.mains[0]) : genericFallback);
  const pic = picSrc ? `<img src="${esc(picSrc)}" data-portrait="${esc(portraitFallback)}" data-generic="${esc(genericFallback)}" alt="" onerror="if(!this.dataset.triedPortrait && this.dataset.portrait && this.src !== this.dataset.portrait){this.dataset.triedPortrait='1';this.src=this.dataset.portrait;}else if(!this.dataset.triedGeneric && this.src !== this.dataset.generic){this.dataset.triedGeneric='1';this.src=this.dataset.generic;}else{this.remove();}">` : '';
  const sec = (key, title, body) => { const on = p[key] !== undefined;
    return `<div class="sec glass" data-sec="${key}"><div class="sh"><b>${title}</b><span class="sp"></span><button type="button" class="tog${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${title}" data-act="toggle" data-k="${key}"></button></div>${on ? body : ''}</div>`; };
  const seg = (i, cur) => `<span class="seg glass pill">${[['tournament', 'Tournament'], ['times', 'Times']].map(([v, l]) => `<button type="button" class="${cur === v ? 'on' : ''}" data-act="fmt" data-i="${i}" data-v="${v}">${l}</button>`).join('')}</span>`;
  const rm = (act, i, what) => `<button type="button" class="x glass pill" data-act="${act}" data-i="${i}" aria-label="Remove ${what}">×</button>`;
  const cell = (cls, label, row, i, f, val, extra = '') => `<div class="${cls}">${lab2(label)}<input class="inp" data-row="${row}" data-i="${i}" data-f="${f}" value="${esc(val ?? '')}" ${extra}></div>`;

  const oppCell = (i, val) => `<div class="g">${lab2(isEs ? 'RIVAL' : 'OPPONENT')}<div style="display:flex;gap:6px;"><input class="inp" data-row="notableWins" data-i="${i}" data-f="opponent" value="${esc(val ?? '')}"><button type="button" class="btn glass pill" data-act="pick-opponent" data-i="${i}" style="min-height:46px;padding:0 14px;white-space:nowrap;font-size:13px;" title="${isEs ? 'Seleccionar rival del directorio' : 'Select opponent from directory'}">🔍</button></div></div>`;
  const wins = (p.notableWins || []).map((w, i) => { const t = w.times !== undefined;
    return `<div class="rowf rowf-sortable" draggable="true" data-sort-section="notableWins" data-i="${i}"><span class="drag-handle" title="${isEs ? 'Arrastrar para reordenar' : 'Drag to reorder'}">⋮⋮</span>${oppCell(i, w.opponent)}<div>${lab2(isEs ? 'FORMATO' : 'FORMAT')}${seg(i, t ? 'times' : 'tournament')}</div>${t ? cell('g', isEs ? 'VECES' : 'TIMES', 'notableWins', i, 'times', w.times) : cell('g', isEs ? 'TORNEO' : 'TOURNAMENT', 'notableWins', i, 'tournament', w.tournament)}${rm('rm-win', i, 'win')}</div>`; }).join('');
  const results = (p.notableResults || []).map((r, i) =>
    `<div class="rowf rowf-sortable" draggable="true" data-sort-section="notableResults" data-i="${i}"><span class="drag-handle" title="${isEs ? 'Arrastrar para reordenar' : 'Drag to reorder'}">⋮⋮</span><div style="flex:0 0 100px">${lab2('PLACEMENT')}<input class="inp" data-row="notableResults" data-i="${i}" data-f="placement" value="${r.placement ?? ''}"></div>${cell('g', isEs ? 'TORNEO' : 'TOURNAMENT', 'notableResults', i, 'event', r.event)}<div style="flex:0 0 120px">${lab2('ENTRANTS')}<input class="inp" data-row="notableResults" data-i="${i}" data-f="entrants" value="${r.entrants ?? ''}"></div>${rm('rm-res', i, 'result')}</div>`).join('');
  const mains = `<div class="chips">${(p.mains || []).map((m, i) => `<span class="glass pill mchip">${stock(m)}${esc(m)}<button type="button" class="x glass pill" data-act="rm-main" data-i="${i}" aria-label="Remove ${esc(m)}">×</button></span>`).join('')}</div>
    <div class="rowf"><div class="g mains-input-wrap" style="width:100%"><input class="inp" id="newMain" autocomplete="off" placeholder="${isEs ? 'Buscar personaje para agregar...' : 'Search character to add...'}"><div id="mainsDropdown" class="mains-dropdown" hidden></div></div></div><div class="note0">${isEs ? 'Selecciona un personaje de la lista para agregarlo como principal.' : 'Select a character from the list to add as main.'}</div>`;

  $('#editor').innerHTML = `<div class="ed-head"><div class="l"><span class="big ${pcls(n)}">${n}</span><span class="nm">${esc(p.tag || 'New player')}</span></div>
      <div class="l" style="align-items:center"><span class="kind" id="kindPill">${k} ENTRY</span><button type="button" class="add" data-act="remove-player">${isEs ? 'Eliminar jugador' : 'Remove player'}</button></div></div>
    <div class="why" id="why">${getWhy()[k]}</div>
    <div class="req"><div class="dzw"><div class="dz">${pic}</div>
        ${isAdminCreation ? `<button type="button" class="btn glass pill" data-act="pick-photo">${isEs ? 'Cambiar imagen' : 'Replace picture'}</button><input type="file" id="photoFile" accept="image/png,image/jpeg" hidden><div class="note0" style="text-align:center">JPG or PNG</div>` : `<div class="note0" style="text-align:center">${isEs ? 'Retrato del personaje más jugado' : 'Most played character portrait'}</div>`}</div>
      <div class="reqf"><div class="fld" style="flex:0 0 100px">${lab(isEs ? 'PUESTO' : 'PLACEMENT')}<input class="inp inp-req ro ${pcls(n)}" value="${n}" readonly aria-readonly="true"></div>
        <div class="fld" style="flex:2 1 240px">${lab(isEs ? 'TAG' : 'TAG')}<input class="inp inp-req" data-pbind="tag" value="${esc(p.tag)}" placeholder="Gamertag"></div>
        <div class="frow" style="flex:1 1 100%; gap:16px;">
          <div class="fld" style="flex:1 1 180px">${lab(isEs ? 'SPONSOR' : 'SPONSOR')}<input class="inp" data-pbind="sponsor" value="${esc(p.sponsor ?? '')}" placeholder="e.g. CLG"></div>
          <div class="fld" style="flex:1 1 180px">${lab(isEs ? 'NOMBRE REAL' : 'REAL NAME')}<input class="inp" data-pbind="realName" value="${esc(p.realName ?? '')}" placeholder="${isEs ? '[Nombre real]' : '[Real name]'}"></div>
          <div class="fld" style="flex:1 1 180px">${lab(isEs ? 'PUNTOS' : 'POINTS')}<input class="inp mono" data-pbind="points" inputmode="decimal" value="${p.points == null ? '' : p.points}" placeholder="e.g. 1,420"></div>
        </div>
        <div class="hint">${isEs ? 'El puesto está determinado por la posición en la lista.' : 'Placement is set by the player’s position in the list.'}</div></div></div>
    ${sec('mains', isEs ? 'Personajes principales' : 'Mains', mains)}
    ${sec('notableWins', 'Notable wins', wins + '<button type="button" class="add" data-act="add-win">+ Add notable win</button>')}
    ${sec('notableResults', 'Notable results', results + '<button type="button" class="add" data-act="add-res">+ Add notable result</button>')}
    ${sec('text', isEs ? 'Descripción del jugador' : 'Player Description', `<textarea class="inp" data-pbind="text" style="min-height:128px">${esc(p.text ?? '')}</textarea><div class="cnt" id="textCount">${(p.text || '').length} ${isEs ? 'caracteres' : 'characters'}</div>`)}`;
}

function onInput(e) {
  const t = e.target, d = t.dataset || {};
  if (t.id === 'playerSearchInput') {
    playerModalQuery = t.value;
    renderPlayerModalList();
    return;
  }
  if (t.id === 'cropZoomSlider') {
    onCropZoom(parseFloat(t.value));
    return;
  }
  if (d.bind) {
    const k = d.bind, v = t.value;
    if (k === 'game') {
      const g = games.find(x => x.id === v);
      if (g) draft.game = { id: g.id, name: g.name, slug: g.slug };
      if (draft.players) {
        draft.players.forEach(p => {
          p._resolvedPortrait = resolvePlayerPortrait(p);
        });
      }
      renderEditor();
    } else if (k === 'year') {
      const yr = v.trim();
      if (/^\d{4}$/.test(yr)) {
        draft.period.start = `${yr}-01-01`;
        draft.period.end = `${yr}-12-31`;
      }
    } else if (k === 'start' || k === 'end') {
      draft.period[k] = v;
    } else {
      draft[k] = v;
    }
    if (k === 'intro') $('#introCount').textContent = `${v.length} characters`;
  } else if (d.imgBind) {
    draft.imageBox = draft.imageBox || { url: '', placement: 'after_intro', caption: '' };
    draft.imageBox[d.imgBind] = t.value;
    dirty = true;
    renderSub();
    if (d.imgBind === 'url') {
      updateImageBoxPreview();
    }
    return;
  } else if (d.pbind) {
    const p = draft.players[sel];
    p[d.pbind] = d.pbind === 'points' ? parseDecimal(t.value) : t.value;
    if (d.pbind === 'points') {
      if (draft.players) {
        draft.players.forEach(pl => {
          if (pl.notableWins) sortNotableWins(pl.notableWins, draft.players);
        });
      }
    }
    if (d.pbind === 'text') $('#textCount').textContent = `${t.value.length} characters`;
    if (d.pbind === 'tag') {
      $('.nm').textContent = t.value || 'New player';
      if (draft.players) {
        draft.players.forEach(pl => {
          if (pl.notableWins) sortNotableWins(pl.notableWins, draft.players);
        });
      }
    }
  } else if (d.row) {
    const r = draft.players[sel][d.row][+d.i];
    r[d.f] = ['times', 'placement', 'entrants'].includes(d.f) ? nums(t.value) : t.value;
    if (d.row === 'notableResults') {
      sortNotableResults(draft.players[sel].notableResults);
    } else if (d.row === 'notableWins') {
      sortNotableWins(draft.players[sel].notableWins, draft.players);
    }
  } else return;
  dirty = true; refresh();
}

function onClick(e) {
  const b = e.target.closest && e.target.closest('[data-act]');
  if (!b) return;
  const p = draft.players[sel], a = b.dataset.act, i = +b.dataset.i;
  switch (a) {
    case 'sel': sel = i; renderAll(); return;
    case 'pick-photo': $('#photoFile').click(); return;
    case 'preview': doPreview(); return;
    case 'import': triggerImport(); return;
    case 'export': doExport(); return;
    case 'share': doShare(); return;
    case 'export-image': doExportImage(); return;
    case 'publish': doPublish(); return;
    case 'pick-box-image': {
      const fi = $('#imageBoxFileInput');
      if (fi) fi.click();
      return;
    }
    case 'clear-image-box': {
      draft.imageBox = null;
      dirty = true;
      renderDetails();
      refresh();
      return;
    }
    case 'pop-snapshot': populateFromSnapshot(b.dataset.n); return;
    case 'add-player': openPlayerModal('ranking'); return;
    case 'pick-opponent': openPlayerModal({ type: 'opponent', index: i }); return;
    case 'choose-player': addPlayerFromDirectory(b.dataset.playerId); return;
    case 'choose-event': selectEventForNotableResult(+b.dataset.idx); return;
    case 'choose-win': selectWinOpponent(+b.dataset.idx); return;
    case 'remove-player':
      if (draft.players.length > 0) {
        draft.players.splice(sel, 1);
        sel = Math.max(0, sel - 1);
        renderAll();
      }
      break;
    case 'sort': {
      const cur = p;
      draft.players.sort((x, y) => {
        const py = (y.points !== null && y.points !== undefined && !Number.isNaN(Number(y.points))) ? Number(y.points) : -Infinity;
        const px = (x.points !== null && x.points !== undefined && !Number.isNaN(Number(x.points))) ? Number(x.points) : -Infinity;
        return py - px;
      });
      sel = cur ? draft.players.indexOf(cur) : 0;
      if (sel < 0) sel = 0;
      renderAll();
      break;
    }
    case 'status':
      draft.status = b.dataset.v;
      if (draft.status === 'yearly') {
        const yr = (draft.period.start || '').slice(0, 4) || new Date().getFullYear().toString();
        draft.period.start = `${yr}-01-01`;
        draft.period.end = `${yr}-12-31`;
      }
      renderDetails();
      break;
    case 'toggle': { const k = b.dataset.k; if (p[k] === undefined) p[k] = structuredClone(OPT[k]); else delete p[k]; renderEditor(); break; }
    case 'add-main': { const v = $('#newMain').value.trim(); if (v) { p.mains.push(v); renderEditor(); $('#newMain').focus(); } break; }
    case 'rm-main':
      p.mains.splice(i, 1);
      p._resolvedPortrait = resolvePlayerPortrait(p);
      renderEditor();
      break;
    case 'fmt': { const w = p.notableWins[i]; if (b.dataset.v === 'times') { w.times = w.times ?? 2; delete w.tournament; } else { w.tournament = w.tournament ?? ''; delete w.times; } renderEditor(); break; }
    case 'add-win': e.preventDefault(); openWinModalForCurrentPlayer(); return;
    case 'rm-win': p.notableWins.splice(i, 1); renderEditor(); break;
    case 'add-res': e.preventDefault(); openEventModalForCurrentPlayer(); return;
    case 'rm-res':
      e.preventDefault();
      p.notableResults.splice(i, 1);
      preserveScroll(() => renderEditor());
      break;
  }
  dirty = true; refresh();
}

let cropModalFile = null;
let cropImageObj = null;
let cropScale = 1;
let cropBaseScale = 1;
let cropOffsetX = 0;
let cropOffsetY = 0;
let cropIsDragging = false;
let cropDragStartX = 0;
let cropDragStartY = 0;
let cropDragStartOffsetX = 0;
let cropDragStartOffsetY = 0;

function openCropModal(file) {
  cropModalFile = file;
  const modal = $('#crop-modal');
  if (!modal) {
    handlePhotoUpload(file);
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    cropImageObj = new Image();
    cropImageObj.onload = () => {
      setupCropCanvas();
      if (typeof modal.showModal === 'function') {
        modal.showModal();
      } else {
        modal.setAttribute('open', '');
      }
    };
    cropImageObj.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function closeCropModal() {
  const modal = $('#crop-modal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.removeAttribute('open');
  }
  cropModalFile = null;
  cropImageObj = null;
  cropIsDragging = false;
}

function setupCropCanvas() {
  const canvas = $('#cropCanvas');
  const slider = $('#cropZoomSlider');
  if (!canvas || !cropImageObj) return;

  canvas.width = 240;
  canvas.height = 293;

  cropBaseScale = Math.max(canvas.width / cropImageObj.width, canvas.height / cropImageObj.height);
  cropScale = cropBaseScale;
  if (slider) slider.value = 1;

  cropOffsetX = (canvas.width - cropImageObj.width * cropScale) / 2;
  cropOffsetY = (canvas.height - cropImageObj.height * cropScale) / 2;

  drawCropCanvas();
}

function drawCropCanvas() {
  const canvas = $('#cropCanvas');
  if (!canvas || !cropImageObj) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    cropImageObj,
    cropOffsetX,
    cropOffsetY,
    cropImageObj.width * cropScale,
    cropImageObj.height * cropScale
  );
}

function onCropZoom(newZoom) {
  const canvas = $('#cropCanvas');
  if (!canvas || !cropImageObj) return;
  const oldScale = cropScale;
  const newScale = cropBaseScale * newZoom;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  cropOffsetX = cx - (cx - cropOffsetX) * (newScale / oldScale);
  cropOffsetY = cy - (cy - cropOffsetY) * (newScale / oldScale);
  cropScale = newScale;

  clampCropOffsets();
  drawCropCanvas();
}

function clampCropOffsets() {
  const canvas = $('#cropCanvas');
  if (!canvas || !cropImageObj) return;
  const minX = canvas.width - cropImageObj.width * cropScale;
  const minY = canvas.height - cropImageObj.height * cropScale;
  cropOffsetX = Math.min(0, Math.max(minX, cropOffsetX));
  cropOffsetY = Math.min(0, Math.max(minY, cropOffsetY));
}

function confirmCrop() {
  const canvas = $('#cropCanvas');
  if (!canvas || !cropImageObj) {
    if (cropModalFile) handlePhotoUpload(cropModalFile);
    closeCropModal();
    return;
  }

  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = 360;
  exportCanvas.height = 440;
  const exportCtx = exportCanvas.getContext('2d');

  const exportRatio = exportCanvas.width / canvas.width;
  exportCtx.drawImage(
    cropImageObj,
    cropOffsetX * exportRatio,
    cropOffsetY * exportRatio,
    cropImageObj.width * cropScale * exportRatio,
    cropImageObj.height * cropScale * exportRatio
  );

  exportCanvas.toBlob((blob) => {
    if (blob) {
      const croppedFile = new File([blob], 'player-portrait.png', { type: 'image/png' });
      handlePhotoUpload(croppedFile);
    } else if (cropModalFile) {
      handlePhotoUpload(cropModalFile);
    }
    closeCropModal();
  }, 'image/png');
}

async function handleImageBoxUpload(file) {
  if (!file) return;
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');

  const MAX_FILE_SIZE = 5 * 1024 * 1024;
  if (file.size > MAX_FILE_SIZE) {
    alert(isEs ? 'El archivo es demasiado grande. El límite de tamaño es de 5 MB.' : 'File is too large. Maximum file size is 5 MB.');
    return;
  }

  // Convert to dataUrl or upload if admin
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read image file.'));
      reader.readAsDataURL(file);
    });

    draft.imageBox = draft.imageBox || { url: '', placement: 'after_intro', caption: '' };

    if (isAdmin && requestedMode === 'admin') {
      try {
        const res = await fetch('/api/admin/ranking-photo', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Request': '1',
            'X-CSRF-Token': adminCsrfToken
          },
          body: JSON.stringify({
            playerId: 'box_image',
            data: dataUrl
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        draft.imageBox.url = data.path;
      } catch (e) {
        draft.imageBox.url = dataUrl;
      }
    } else {
      draft.imageBox.url = dataUrl;
    }

    dirty = true;
    renderDetails();
    refresh();
  } catch (err) {
    alert(isEs ? `Error al cargar la imagen: ${err.message}` : `Could not upload image: ${err.message}`);
  }
}

async function handlePhotoUpload(file) {
  if (!file) return;
  const p = draft.players[sel];
  if (!p) return;

  // Local object URL for instant preview feedback
  p._preview = URL.createObjectURL(file);
  p._selectedPhotoFile = file;
  dirty = true;
  renderEditor();
  refresh();

  // If in admin mode, upload to backend ranking-photo endpoint immediately
  if (isAdmin && requestedMode === 'admin') {
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read photo file.'));
        reader.readAsDataURL(file);
      });

      const res = await fetch('/api/admin/ranking-photo', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Request': '1',
          'X-CSRF-Token': adminCsrfToken
        },
        body: JSON.stringify({
          playerId: p.playerId || '',
          data: dataUrl
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Photo upload failed');
      p.photo = data.path;
      delete p._selectedPhotoFile;
      dirty = true;
      renderEditor();
      refresh();
    } catch (err) {
      alert(`Could not upload photo: ${err.message}`);
    }
  }
}

function onChange(e) {
  if (e.target.id === 'photoFile' && e.target.files[0]) {
    openCropModal(e.target.files[0]);
    e.target.value = '';
  }
  if (e.target.id === 'imageBoxFileInput' && e.target.files[0]) {
    handleImageBoxUpload(e.target.files[0]);
    e.target.value = '';
  }
  if (e.target.id === 'importFileInput' && e.target.files[0]) {
    handleImportFile(e.target.files[0]);
    e.target.value = '';
  }
  if (e.target.dataset && e.target.dataset.row === 'notableWins' && e.target.dataset.f === 'opponent') {
    updateNotableWinStats(+e.target.dataset.i, e.target.value.trim());
  }
  if (e.target.dataset && e.target.dataset.imgBind) {
    draft.imageBox = draft.imageBox || { url: '', placement: 'after_intro', caption: '' };
    draft.imageBox[e.target.dataset.imgBind] = e.target.value;
    dirty = true;
    renderSub();
    if (e.target.dataset.imgBind === 'url') {
      updateImageBoxPreview();
    }
  }
}

function constructRankingJson() {
  const list = (a, ok) => (a || []).filter(ok);
  const out = {
    schemaVersion: 1,
    id: rowId(),
    title: draft.title.trim() || 'Custom Ranking',
    game: { ...draft.game },
    period: { ...draft.period },
    status: draft.status || 'yearly'
  };
  if (draft.publishedBy && draft.publishedBy.trim()) out.publishedBy = draft.publishedBy.trim();
  if (draft.createdBy && draft.createdBy.trim()) out.createdBy = draft.createdBy.trim().slice(0, 80);
  if (draft.intro && draft.intro.trim()) out.intro = draft.intro.trim();
  if (draft.imageBox && draft.imageBox.url && draft.imageBox.url.trim()) {
    out.imageBox = {
      url: draft.imageBox.url.trim(),
      placement: ['beginning', 'after_intro', 'end'].includes(draft.imageBox.placement) ? draft.imageBox.placement : 'after_intro',
      caption: (draft.imageBox.caption || '').trim().slice(0, 300)
    };
  }

  out.players = (draft.players || []).map((p, i) => {
    const o = { placement: i + 1, tag: (p.tag || '').trim() };
    if (p.playerId) o.playerId = String(p.playerId).trim();
    if (p.sponsor && p.sponsor.trim()) o.sponsor = p.sponsor.trim();
    if (p.points !== null && p.points !== undefined && !Number.isNaN(Number(p.points))) {
      o.points = Number(p.points);
    }
    if (p.photo && !p.photo.startsWith('blob:')) o.photo = p.photo;
    if (p.realName && p.realName.trim()) o.realName = p.realName.trim();
    if (has(p.mains)) o.mains = [...p.mains];
    if (p.text && p.text.trim()) o.text = p.text.trim();
    const w = list(p.notableWins, x => x.opponent && x.opponent.trim());
    if (w.length) {
      o.notableWins = w.map(x => x.times !== undefined && x.times !== null
        ? { opponent: x.opponent.trim(), times: Number(x.times) }
        : { opponent: x.opponent.trim(), tournament: (x.tournament || '').trim() });
    }
    const r = list(p.notableResults, x => x.event && x.event.trim());
    if (r.length) {
      o.notableResults = r.map(x => ({
        placement: x.placement !== null && x.placement !== undefined ? Number(x.placement) : null,
        event: x.event.trim(),
        entrants: x.entrants !== null && x.entrants !== undefined ? Number(x.entrants) : null
      }));
    }
    return o;
  });
  return out;
}

function getDescriptiveFilename() {
  const titlePart = slug(draft.title || 'power-ranking');
  const gamePart = draft.game?.slug || 'ranking';
  let yearPart = '';
  if (draft.period?.start) {
    yearPart = '-' + draft.period.start.split('-')[0];
  }
  return `${titlePart || gamePart}${yearPart}.json`;
}

function doExport() {
  const out = constructRankingJson();
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = getDescriptiveFilename();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function triggerImport() {
  if (dirty) {
    if (!confirm('You have unsaved changes in the creator. Importing a ranking will overwrite your current form. Continue?')) {
      return;
    }
  }
  $('#importFileInput').click();
}

function validateAndSanitizeImport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid file format: ranking file must contain a JSON object.');
  }

  if (Object.prototype.hasOwnProperty.call(data, '__proto__') || Object.prototype.hasOwnProperty.call(data, 'constructor')) {
    throw new Error('Security violation: malformed object properties detected.');
  }

  if (data.schemaVersion !== undefined && data.schemaVersion !== 1) {
    throw new Error(`Unsupported schema version (${data.schemaVersion}). Only version 1 is supported.`);
  }

  const sanitized = {
    id: typeof data.id === 'string' ? data.id.slice(0, 100) : '',
    title: typeof data.title === 'string' ? data.title.slice(0, 150) : '',
    game: { id: 'r2', name: 'Rivals 2', slug: 'rivals-2' },
    period: { start: '', end: '' },
    status: (data.status === 'seasonal' || data.status === 'final') ? 'seasonal' : 'yearly',
    publishedBy: (isAdmin && requestedMode === 'admin' && typeof data.publishedBy === 'string') ? data.publishedBy.slice(0, 100).trim() : '',
    createdBy: typeof data.createdBy === 'string' ? data.createdBy.slice(0, 80).trim() : '',
    intro: typeof data.intro === 'string' ? data.intro.slice(0, 2000) : '',
    imageBox: null,
    players: []
  };

  if (data.imageBox && typeof data.imageBox === 'object' && typeof data.imageBox.url === 'string' && data.imageBox.url.trim()) {
    sanitized.imageBox = {
      url: data.imageBox.url.trim(),
      placement: ['beginning', 'after_intro', 'end'].includes(data.imageBox.placement) ? data.imageBox.placement : 'after_intro',
      caption: typeof data.imageBox.caption === 'string' ? data.imageBox.caption.slice(0, 300) : ''
    };
  }

  if (data.game && typeof data.game === 'object') {
    const matched = games.find(g => g.id === data.game.id || g.slug === data.game.slug || g.name === data.game.name);
    if (matched) {
      sanitized.game = { id: matched.id, name: matched.name, slug: matched.slug };
    }
  }

  if (data.period && typeof data.period === 'object') {
    if (typeof data.period.start === 'string') sanitized.period.start = data.period.start.slice(0, 20);
    if (typeof data.period.end === 'string') sanitized.period.end = data.period.end.slice(0, 20);
  }

  if (!Array.isArray(data.players)) {
    throw new Error('Missing or invalid "players" array in ranking data.');
  }
  if (data.players.length > 200) {
    throw new Error('Ranking contains too many players (maximum 200).');
  }

  const missingProfiles = [];
  const knownProfileIds = new Set(allProfiles.map(p => String(p.playerId)));

  data.players.forEach((p, idx) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return;
    const tag = typeof p.tag === 'string' ? p.tag.slice(0, 80) : `Player ${idx + 1}`;
    const pid = (p.playerId !== undefined && p.playerId !== null) ? String(p.playerId).trim() : '';

    if (pid && !knownProfileIds.has(pid)) {
      missingProfiles.push(`${tag} (ID: ${pid})`);
    }

    const playerObj = {
      placement: idx + 1,
      tag,
      playerId: pid || undefined,
      sponsor: typeof p.sponsor === 'string' ? p.sponsor.slice(0, 50).trim() : undefined,
      points: (p.points !== null && p.points !== undefined && !Number.isNaN(Number(p.points))) ? Number(p.points) : null,
      photo: (typeof p.photo === 'string' && (p.photo.startsWith('assets/players/') || p.photo.startsWith('https://'))) ? p.photo.slice(0, 240) : undefined,
      realName: typeof p.realName === 'string' ? p.realName.slice(0, 100) : undefined,
      text: typeof p.text === 'string' ? p.text.slice(0, 2000) : undefined,
      mains: Array.isArray(p.mains) ? p.mains.filter(m => typeof m === 'string').map(m => m.slice(0, 50)) : undefined
    };

    if (Array.isArray(p.notableWins)) {
      playerObj.notableWins = p.notableWins.filter(w => w && typeof w === 'object' && typeof w.opponent === 'string').map(w => ({
        opponent: w.opponent.slice(0, 80),
        times: (w.times !== undefined && w.times !== null && !Number.isNaN(Number(w.times))) ? Number(w.times) : undefined,
        tournament: typeof w.tournament === 'string' ? w.tournament.slice(0, 100) : undefined
      }));
      sortNotableWins(playerObj.notableWins, data.players);
    }

    if (Array.isArray(p.notableResults)) {
      playerObj.notableResults = p.notableResults.filter(r => r && typeof r === 'object' && typeof r.event === 'string').map(r => ({
        placement: (r.placement !== null && r.placement !== undefined) ? Number(r.placement) : null,
        event: r.event.slice(0, 120),
        entrants: (r.entrants !== null && r.entrants !== undefined) ? Number(r.entrants) : null
      }));
      sortNotableResults(playerObj.notableResults);
    }

    sanitized.players.push(playerObj);
  });

  return { sanitized, missingProfiles };
}

function handleImportFile(file) {
  if (file.size > 2 * 1024 * 1024) {
    alert('Selected file is too large (maximum 2 MB).');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      const { sanitized, missingProfiles } = validateAndSanitizeImport(parsed);
      draft = sanitized;
      sel = 0;
      dirty = false;
      renderDetails();
      renderAll();

      if (missingProfiles.length > 0) {
        alert(`Note: The following ${missingProfiles.length} player profile(s) could not be resolved in the directory:\n\n${missingProfiles.slice(0, 5).join('\n')}${missingProfiles.length > 5 ? '\n...and more' : ''}\n\nTheir data has been imported, but their profiles may be outdated or missing.`);
      }
    } catch (err) {
      alert(`Import error: ${err.message}`);
    }
  };
  reader.onerror = () => alert('Failed to read the selected file.');
  reader.readAsText(file);
}

function doPreview() {
  const rankingData = constructRankingJson();
  if (isAdmin && requestedMode === 'admin') {
    rankingData.isOfficial = true;
  }
  sessionStorage.setItem('platfighters_community_preview', JSON.stringify(rankingData));
  window.open('ranking.html?preview=community', '_blank');
}

function encodeCommunityRanking(data) {
  const jsonStr = JSON.stringify(data);
  const base64 = btoa(encodeURIComponent(jsonStr).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode('0x' + p1)));
  return base64;
}

function doShare() {
  const rankingData = constructRankingJson();
  const encoded = encodeCommunityRanking(rankingData);

  if (encoded.length > 6000) {
    alert('This ranking contains too much information for a shareable URL link.\n\nPlease use the "Export" button to download a JSON file to share with others.');
    return;
  }

  const shareUrl = `${window.location.origin}${window.location.pathname.replace('ranking-creator.html', 'ranking.html')}#community=${encoded}`;

  navigator.clipboard.writeText(shareUrl).then(() => {
    alert(`Shareable link copied to clipboard!\n\nAnyone opening this link can view your community ranking.\n\n${shareUrl}`);
  }).catch(() => {
    prompt('Copy your shareable ranking link:', shareUrl);
  });
}

async function doExportImage() {
  const rankingData = constructRankingJson();
  if (!rankingData.players || !rankingData.players.length) {
    alert('Add players to your ranking before exporting an image.');
    return;
  }

  // Preserve live previews/custom photos in draft players for export
  if (Array.isArray(draft.players)) {
    rankingData.players.forEach((p, idx) => {
      const draftPlayer = draft.players[idx];
      if (draftPlayer) {
        if (draftPlayer._preview) p._preview = draftPlayer._preview;
        if (draftPlayer._resolvedPortrait) p._resolvedPortrait = draftPlayer._resolvedPortrait;
        if (draftPlayer.photo) p.photo = draftPlayer.photo;
        if (draftPlayer.playerId) p.playerId = draftPlayer.playerId;
      }
    });
  }

  try {
    await exportRankingImage(rankingData, {
      isAdmin: isAdmin && requestedMode === 'admin'
    });
  } catch (err) {
    console.error('Failed to export ranking image:', err);
    alert('An error occurred while generating the ranking image.');
  }
}

async function doPublish() {
  if (!isAdmin) {
    alert('Publishing requires active administrator credentials.');
    return;
  }

  const okD = draft.title.trim() && draft.period.start && draft.period.end;
  const okP = draft.players && draft.players.length > 0 && draft.players.every(p => p.tag && p.tag.trim());
  if (!okD || !okP) {
    alert('Please complete all required fields (Ranking title, period start/end, and valid players) before publishing.');
    return;
  }

  const rankingPayload = constructRankingJson();

  const isEditingExisting = rankingIdParam && draft.id === rankingIdParam;
  const confirmMsg = isEditingExisting
    ? `Publish changes to existing official ranking "${draft.title}" (${draft.id})? This will update the official database and public website files.`
    : `Publish new official ranking "${draft.title}"? This will save it to the official database and publish it on Platfighters.uy.`;

  if (!confirm(confirmMsg)) return;

  const btn = $('#publishBtn');
  if (btn) btn.disabled = true;

  try {
    const url = isEditingExisting
      ? `/api/admin/rankings/${encodeURIComponent(draft.id)}`
      : '/api/admin/rankings';
    const method = isEditingExisting ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Request': '1',
        'X-CSRF-Token': adminCsrfToken
      },
      body: JSON.stringify({ ranking: rankingPayload })
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Publishing failed');

    alert(`Official power ranking "${draft.title}" was published successfully!`);
    dirty = false;
    window.location.href = 'admin.html';
  } catch (err) {
    alert(`Could not publish ranking: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

if (window.i18n && window.i18n.onChange) {
  window.i18n.onChange(() => {
    if (draft) {
      renderDetails();
      renderAll();
    }
  });
}
