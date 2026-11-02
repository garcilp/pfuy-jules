// Platfighters.uy — ranking creator (front-end prototype). Plain JS, no build step.
// State lives in `draft`, which has the same shape as data/rankings/<id>.json in the rankings pages.
let draft, games, allProfiles = [], gameCharacters = {}, sel = 0, dragFrom = null, dirty = false, savedAt = '';
let prSnapshot = null;

// Check for PR snapshot from sessionStorage
try {
  const isPrSource = new URLSearchParams(window.location.search).get('source') === 'pr';
  const savedSnap = sessionStorage.getItem('platfighters_pr_snapshot');
  if (isPrSource && savedSnap) {
    prSnapshot = JSON.parse(savedSnap);
  }
} catch (e) {
  console.warn('Could not read PR snapshot:', e);
}

const rankingIdParam = new URLSearchParams(window.location.search).get('id');

const loadPromises = [
  fetch('data/games.json').then(r => r.json()),
  fetch('data/profiles/index.json').then(r => r.json()).catch(() => []),
  fetch('data/characters.json').then(r => r.json()).catch(() => ({}))
];

if (rankingIdParam) {
  loadPromises.push(
    fetch(`data/rankings/${encodeURIComponent(rankingIdParam)}.json`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
  );
}

Promise.all(loadPromises)
  .then(([g, profiles, chars, existingRanking]) => {
    games = g.sort((a, b) => a.name.localeCompare(b.name));
    allProfiles = profiles || [];
    gameCharacters = chars || {};

    if (existingRanking) {
      draft = existingRanking;
      dirty = false;
    } else if (prSnapshot) {
      const matchingGame = games.find(gm => gm.slug === prSnapshot.game.slug || gm.id === prSnapshot.game.id) || games[0];
      draft = {
        id: '',
        title: '',
        game: { id: matchingGame.id, name: matchingGame.name, slug: matchingGame.slug },
        period: { start: '', end: '' },
        status: 'draft',
        publishedBy: '',
        intro: '',
        players: []
      };
      dirty = false;
    } else {
      // Clean initial state for new rankings
      const defaultGame = games[0] || { id: 'r2', name: 'Rivals 2', slug: 'rivals-2' };
      draft = {
        id: '',
        title: '',
        game: { id: defaultGame.id, name: defaultGame.name, slug: defaultGame.slug },
        period: { start: '', end: '' },
        status: 'draft',
        publishedBy: '',
        intro: '',
        players: []
      };
      dirty = false;
    }
    renderDetails();
    renderAll();
  });

// Modal search and selection state
let playerModalQuery = '';
let playerModalTarget = 'ranking'; // 'ranking' or { type: 'opponent', index: number }

function openPlayerModal(target = 'ranking') {
  playerModalTarget = target;
  const modal = $('#player-select-modal');
  if (!modal) return;
  playerModalQuery = '';
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const titleEl = $('#playerModalTitle');
  const subEl = $('#playerModalSub');
  if (titleEl) {
    if (target === 'ranking') {
      titleEl.textContent = isEs ? 'Seleccionar Jugador' : 'Select Player';
    } else {
      titleEl.textContent = isEs ? 'Seleccionar Rival' : 'Select Opponent';
    }
  }
  if (subEl) {
    if (target === 'ranking') {
      subEl.textContent = isEs ? 'Busca y selecciona un jugador del directorio' : 'Search and select a player from the directory';
    } else {
      subEl.textContent = isEs ? 'Selecciona un rival de la base de datos de jugadores' : 'Select an opponent from the player database';
    }
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
  if (!player) return;

  if (playerModalTarget && playerModalTarget.type === 'opponent') {
    const p = draft.players[sel];
    if (p && p.notableWins && p.notableWins[playerModalTarget.index]) {
      p.notableWins[playerModalTarget.index].opponent = player.tag;
      dirty = true;
      refresh();
      renderEditor();
    }
    closePlayerModal();
    return;
  }

  // Prevent duplicate additions in ranking mode
  const currentIds = new Set((draft.players || []).map(p => String(p.playerId)).filter(Boolean));
  if (currentIds.has(String(player.playerId))) return;

  const newEntry = {
    tag: player.tag,
    playerId: String(player.playerId),
    points: null,
    photo: player.photo || `assets/players/${player.playerId}.png`
  };

  // Optionally fetch rich profile info if available
  if (player.slug) {
    try {
      const resp = await fetch(`data/profiles/${encodeURIComponent(player.slug)}.json`);
      if (resp.ok) {
        const fullProf = await resp.json();
        if (fullProf.player) {
          if (fullProf.player.photo) newEntry.photo = fullProf.player.photo;
        }
      }
    } catch (e) {
      // Non-fatal, use basic player data
    }
  }

  draft.players.push(newEntry);
  sel = draft.players.length - 1;
  dirty = true;
  closePlayerModal();
  renderAll();
}

// Notable Results Event Modal
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

async function openEventModalForCurrentPlayer() {
  const p = draft.players[sel];
  if (!p) return;
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const modal = $('#event-select-modal');
  const listEl = $('#eventSelectList');
  if (!modal || !listEl) {
    p.notableResults = p.notableResults || [];
    p.notableResults.push({ placement: null, event: '', entrants: null });
    renderEditor();
    return;
  }

  listEl.innerHTML = `<div class="player-empty-search">${isEs ? 'Cargando eventos del jugador...' : 'Loading player events...'}</div>`;

  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.setAttribute('open', '');
  }

  playerEventResults = [];
  if (p.playerId) {
    const matched = allProfiles.find(x => String(x.playerId) === String(p.playerId));
    const slugName = matched?.slug || (p.tag ? slug(p.tag) : '');
    const profilePaths = [
      slugName ? `data/profiles/${slugName}-${p.playerId}.json` : null,
      slugName ? `data/profiles/${slugName}.json` : null
    ].filter(Boolean);

    for (const path of profilePaths) {
      try {
        const res = await fetch(path);
        if (res.ok) {
          const profileData = await res.json();
          // Extract results from games matching current game or all games
          const curGameSlug = draft.game ? draft.game.slug : '';
          const gamesArr = profileData.games || [];
          const matchedGame = gamesArr.find(g => g.slug === curGameSlug) || gamesArr[0];
          if (matchedGame && matchedGame.results) {
            playerEventResults = matchedGame.results;
            break;
          }
        }
      } catch (e) {
        // try next
      }
    }
  }

  renderEventModalList();
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
    const eventName = r.event || r.eventName || 'Tournament';
    const entrants = r.entrants ? (isEs ? `${r.entrants} participantes` : `${r.entrants} entrants`) : '';
    const date = r.date || '';
    const meta = [entrants, date].filter(Boolean).join(' · ');

    return `<button type="button" class="player-select-item" data-act="choose-event" data-idx="${idx}">
      <span class="player-select-avatar"><span style="font-size:16px;font-weight:700;">${place}</span></span>
      <div class="player-select-info">
        <div class="player-select-tag-row">
          <span class="player-select-tag">${esc(eventName)}</span>
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
  p.notableResults.push({
    placement: ev.place ?? ev.placement ?? null,
    event: ev.event || ev.eventName || '',
    entrants: ev.entrants ?? null
  });
  dirty = true;
  closeEventModal();
  refresh();
  renderEditor();
}

document.addEventListener('input', onInput);
document.addEventListener('click', onClick);
document.addEventListener('change', onChange);
document.addEventListener('click', e => {
  if (e.target.id === 'closePlayerModalBtn' || e.target.closest('#closePlayerModalBtn')) {
    closePlayerModal();
  }
  const modal = $('#player-select-modal');
  if (e.target === modal) {
    closePlayerModal();
  }

  if (e.target.id === 'closeEventModalBtn' || e.target.closest('#closeEventModalBtn')) {
    closeEventModal();
  }
  const evModal = $('#event-select-modal');
  if (e.target === evModal) {
    closeEventModal();
  }
  if (e.target.id === 'addBlankResultBtn') {
    const p = draft.players[sel];
    if (p) {
      p.notableResults = p.notableResults || [];
      p.notableResults.push({ placement: null, event: '', entrants: null });
      dirty = true;
      closeEventModal();
      refresh();
      renderEditor();
    }
  }
});
document.addEventListener('keydown', e => { if (e.target.id === 'newMain' && e.key === 'Enter') { e.preventDefault(); $('[data-act="add-main"]').click(); } });
document.addEventListener('dragstart', e => { const r = e.target.closest && e.target.closest('.prow'); if (r) { dragFrom = +r.dataset.i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ''); } });
document.addEventListener('dragover', e => { const r = e.target.closest && e.target.closest('.prow'); if (r && dragFrom !== null) { e.preventDefault(); document.querySelectorAll('.prow.over').forEach(x => x.classList.remove('over')); r.classList.add('over'); } });
document.addEventListener('drop', e => {
  const r = e.target.closest && e.target.closest('.prow');
  if (!r || dragFrom === null) return;
  e.preventDefault();
  const cur = draft.players[sel], [m] = draft.players.splice(dragFrom, 1);
  draft.players.splice(+r.dataset.i, 0, m);
  sel = draft.players.indexOf(cur); dragFrom = null; dirty = true; renderAll();
});

// ---- helpers ----
const OPT = { realName: '', mains: [], text: '', notableWins: [], notableResults: [] };   // defaults when a section is switched on
const nums = v => String(v).trim() === '' ? null : Number(String(v).replace(/[^\d]/g, ''));
const has = a => a && a.length;
// The layout a player gets on the ranking page depends on how much data they have.
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
const lab = (t, req) => {
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  return `<div class="lab"><span>${t}</span><span>${req ? (isEs ? 'REQUERIDO' : 'REQUIRED') : (isEs ? 'OPCIONAL' : 'OPTIONAL')}</span></div>`;
};
const lab2 = t => `<div class="lab"><span>${t}</span></div>`;
const stock = name => `<span class="stock"><i>${esc(name[0])}</i><img src="assets/stock-icons/${esc(draft.game.slug)}/${slug(name)}.png" alt="" onerror="this.remove()"></span>`;
const rowId = () => draft.id || `${draft.game.id}-${slug(draft.title || 'ranking')}`;

// ---- rendering ----
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
  $('#preview').href = `ranking.html?id=${encodeURIComponent(rowId())}`;
}

function populateFromSnapshot(count) {
  if (!prSnapshot || !prSnapshot.players || !prSnapshot.players.length) return;
  const countNum = parseInt(count, 10);
  const playersToTake = prSnapshot.players.slice(0, countNum);

  // Populate or replace generated ranking entries, preserving ordering and fields
  draft.players = playersToTake.map((p, idx) => ({
    placement: idx + 1,
    tag: p.tag || '',
    points: p.points !== null && p.points !== undefined ? p.points : null,
    photo: p.photo || '',
    playerId: p.playerId || ''
  }));

  sel = 0;
  dirty = true;
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

  $('#details').innerHTML = `${snapshotControlsHtml}<div><h2>${isEs ? 'Detalles del ranking' : 'Ranking details'}</h2><div class="sub">${isEs ? 'Se muestra en el archivo y al inicio del artículo.' : 'Shown in the archive and at the top of the article.'}</div></div>
    <div class="frow"><div class="fld" style="flex:2 1 320px">${lab(isEs ? 'NOMBRE' : 'NAME', 1)}<input class="inp" data-bind="title" value="${esc(draft.title)}"></div>
      <div class="fld" style="flex:1 1 200px">${lab(isEs ? 'JUEGO' : 'GAME', 1)}<select class="inp" data-bind="game">${games.map(g => `<option value="${g.id}"${g.id === draft.game.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div></div>
    <div class="frow"><div class="fld" style="flex:1 1 160px">${lab(isEs ? 'INICIO DEL PERIODO' : 'PERIOD START', 1)}<input type="date" class="inp" data-bind="start" value="${draft.period.start}"></div>
      <div class="fld" style="flex:1 1 160px">${lab(isEs ? 'FIN DEL PERIODO' : 'PERIOD END', 1)}<input type="date" class="inp" data-bind="end" value="${draft.period.end}"></div>
      <div class="fld">${lab(isEs ? 'ESTADO' : 'STATUS', 1)}<div class="seg glass pill" id="status">${['current', 'final'].map(s => `<button type="button" class="${draft.status === s ? 'on' : ''}" data-act="status" data-v="${s}">${s === 'current' ? (isEs ? 'Actual' : 'Current') : (isEs ? 'Final' : 'Final')}</button>`).join('')}</div></div></div>
    <div class="fld">${lab(isEs ? 'PUBLICADO POR' : 'PUBLISHED BY', 0)}<input class="inp" data-bind="publishedBy" value="${esc(draft.publishedBy || '')}"></div>
    <div class="fld">${lab(isEs ? 'INTRODUCCIÓN' : 'INTRO', 0)}<textarea class="inp" data-bind="intro">${esc(draft.intro || '')}</textarea><div class="cnt" id="introCount">${(draft.intro || '').length} ${isEs ? 'caracteres' : 'characters'}</div></div>`;
}

function renderSide() {
  const ps = draft.players;
  const item = (ok, t, s) => `<div class="ci${ok ? ' done' : ''}"><i></i><span>${t}</span><small>${s}</small></div>`;
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const okD = draft.title.trim() && draft.period.start && draft.period.end;
  const okP = ps.length > 0 && ps.every(p => p.tag && p.tag.trim());
  const pics = ps.filter(p => p.photo || p._preview).length;
  const checkPlayersText = isEs
    ? `Puesto y tag para los ${ps.length} jugadores`
    : `Placement and tag for all ${ps.length} players`;
  const checkDetailsText = isEs ? 'Nombre, juego y periodo' : 'Name, game and period';
  const checkPicsText = isEs ? 'Imágenes (opcional)' : 'Pictures (optional)';
  const doneText = isEs ? 'LISTO' : 'DONE';
  const missingText = isEs ? 'FALTANTE' : 'MISSING';
  const picsSub = `${pics} ${isEs ? 'DE' : 'OF'} ${ps.length}`;

  $('#side').innerHTML = `<div class="plist glass"><div class="hd"><b>${isEs ? 'Jugadores' : 'Players'}</b><span class="mono muted sm0">${ps.length}</span></div>` +
    ps.map((p, i) => `<button type="button" class="prow${i === sel ? ' on' : ''}" draggable="true" data-act="sel" data-i="${i}"><span class="h">⋮⋮</span><span class="n ${pcls(i + 1)}">${i + 1}</span><span class="t">${esc(p.tag || (isEs ? 'Nuevo jugador' : 'New player'))}</span><span class="k">${kind(p)}</span></button>`).join('') +
    `<button type="button" class="btn glass pill addp" data-act="add-player">${isEs ? '+ Agregar jugador' : '+ Add player'}</button>
     <div class="note">${isEs ? 'Arrastra para reordenar. Los puestos siguen el orden.' : 'Drag to reorder. Placements follow the order.'} <button type="button" class="add" style="padding:0" data-act="sort">${isEs ? 'Ordenar por puntos' : 'Sort by points'}</button></div></div>
    <div class="check glass"><b>${isEs ? 'Antes de publicar' : 'Before publishing'}</b>${item(okD, checkDetailsText, okD ? doneText : missingText)}${item(okP, checkPlayersText, okP ? doneText : missingText)}${item(true, checkPicsText, picsSub)}</div>`;
}

function renderEditor() {
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  if (!draft.players || !draft.players.length) {
    $('#editor').innerHTML = `<div class="panel glass empty-state" style="padding:36px; text-align:center;">
      <h3>${isEs ? 'No hay jugadores en este ranking' : 'No players in this ranking'}</h3>
      <p class="muted" style="margin:12px 0 20px;">${isEs ? 'Usa las opciones de población rápida arriba o agrega jugadores manualmente.' : 'Use the quick populate options above or add players manually.'}</p>
      <button type="button" class="btn glass pill" data-act="add-player">${isEs ? '+ Agregar jugador' : '+ Add player'}</button>
    </div>`;
    return;
  }
  const p = draft.players[sel] || draft.players[0];
  const n = sel + 1, k = kind(p);
  const defaultPhoto = p.playerId ? `assets/players/${p.playerId}.png` : '';
  const picSrc = p._preview || p.photo || defaultPhoto;
  const pic = picSrc ? `<img src="${esc(picSrc)}" alt="" onerror="this.remove()">` : '';
  const sec = (key, title, body) => { const on = p[key] !== undefined;
    return `<div class="sec glass"><div class="sh"><b>${title}</b><small>OPTIONAL</small><span class="sp"></span><button type="button" class="tog${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${title}" data-act="toggle" data-k="${key}"></button></div>${on ? body : ''}</div>`; };
  const seg = (i, cur) => `<span class="seg glass pill">${[['tournament', 'Tournament'], ['times', 'Times']].map(([v, l]) => `<button type="button" class="${cur === v ? 'on' : ''}" data-act="fmt" data-i="${i}" data-v="${v}">${l}</button>`).join('')}</span>`;
  const rm = (act, i, what) => `<button type="button" class="x glass pill" data-act="${act}" data-i="${i}" aria-label="Remove ${what}">×</button>`;
  const cell = (cls, label, row, i, f, val, extra = '') => `<div class="${cls}">${lab2(label)}<input class="inp" data-row="${row}" data-i="${i}" data-f="${f}" value="${esc(val ?? '')}" ${extra}></div>`;

  const oppCell = (i, val) => `<div class="g">${lab2(isEs ? 'RIVAL' : 'OPPONENT')}<div style="display:flex;gap:6px;"><input class="inp" data-row="notableWins" data-i="${i}" data-f="opponent" value="${esc(val ?? '')}"><button type="button" class="btn glass pill" data-act="pick-opponent" data-i="${i}" style="min-height:46px;padding:0 14px;white-space:nowrap;font-size:13px;" title="${isEs ? 'Seleccionar rival del directorio' : 'Select opponent from directory'}">🔍</button></div></div>`;
  const wins = (p.notableWins || []).map((w, i) => { const t = w.times !== undefined;
    return `<div class="rowf">${oppCell(i, w.opponent)}<div>${lab2(isEs ? 'FORMATO' : 'FORMAT')}${seg(i, t ? 'times' : 'tournament')}</div>${t ? cell('g', isEs ? 'VECES' : 'TIMES', 'notableWins', i, 'times', w.times) : cell('g', isEs ? 'TORNEO' : 'TOURNAMENT', 'notableWins', i, 'tournament', w.tournament)}${rm('rm-win', i, 'win')}</div>`; }).join('');
  const results = (p.notableResults || []).map((r, i) =>
    `<div class="rowf"><div style="flex:0 0 100px">${lab2('PLACEMENT')}<input class="inp" data-row="notableResults" data-i="${i}" data-f="placement" value="${r.placement ?? ''}"></div>${cell('g', 'EVENT', 'notableResults', i, 'event', r.event)}<div style="flex:0 0 120px">${lab2('ENTRANTS')}<input class="inp" data-row="notableResults" data-i="${i}" data-f="entrants" value="${r.entrants ?? ''}"></div>${rm('rm-res', i, 'result')}</div>`).join('');
  const currentChars = (draft.game && gameCharacters[draft.game.slug]) || [];
  const charDatalist = `<datalist id="characterSuggestions">${currentChars.map(c => `<option value="${esc(c)}">`).join('')}</datalist>`;
  const mains = `<div class="chips">${(p.mains || []).map((m, i) => `<span class="glass pill mchip">${stock(m)}${esc(m)}<button type="button" class="x glass pill" data-act="rm-main" data-i="${i}" aria-label="Remove ${esc(m)}">×</button></span>`).join('')}</div>
    <div class="rowf"><div class="g"><input class="inp" id="newMain" list="characterSuggestions" placeholder="${isEs ? 'Nombre del personaje' : 'Character name'}">${charDatalist}</div><button type="button" class="btn glass pill" data-act="add-main">+ ${isEs ? 'Agregar personaje' : 'Add main'}</button></div><div class="note0">${isEs ? 'Se muestran en el ranking como íconos de stock.' : 'Shown on the ranking as stock icons.'}</div>`;

  $('#editor').innerHTML = `<div class="ed-head"><div class="l"><span class="big ${pcls(n)}">${n}</span><span class="nm">${esc(p.tag || 'New player')}</span></div>
      <div class="l" style="align-items:center"><span class="kind" id="kindPill">${k} ENTRY</span><button type="button" class="add" data-act="remove-player">${isEs ? 'Eliminar jugador' : 'Remove player'}</button></div></div>
    <div class="why" id="why">${getWhy()[k]}</div>
    <div class="req"><div class="dzw"><div class="dz"><i>${esc((p.tag || '?')[0])}</i>${pic}</div>
        <button type="button" class="btn glass pill" data-act="pick-photo">${isEs ? 'Cambiar imagen' : 'Replace picture'}</button><input type="file" id="photoFile" accept="image/png,image/jpeg" hidden><div class="note0" style="text-align:center">JPG or PNG</div></div>
      <div class="reqf"><div class="fld" style="flex:0 0 100px">${lab(isEs ? 'PUESTO' : 'PLACEMENT', 1)}<input class="inp ro ${pcls(n)}" value="${n}" readonly aria-readonly="true"></div>
        <div class="fld" style="flex:2 1 240px">${lab(isEs ? 'TAG' : 'TAG', 1)}<input class="inp" data-pbind="tag" value="${esc(p.tag)}" placeholder="Gamertag"></div>
        <div class="frow" style="flex:1 1 100%; gap:16px;">
          <div class="fld" style="flex:1 1 220px">${lab(isEs ? 'NOMBRE REAL' : 'REAL NAME', 0)}<input class="inp" data-pbind="realName" value="${esc(p.realName ?? '')}" placeholder="${isEs ? '[Nombre real]' : '[Real name]'}"></div>
          <div class="fld" style="flex:1 1 220px">${lab(isEs ? 'PUNTOS' : 'POINTS', 0)}<input class="inp mono" data-pbind="points" inputmode="numeric" value="${p.points == null ? '' : Number(p.points).toLocaleString('en-US')}" placeholder="e.g. 1,420"></div>
        </div>
        <div class="hint">${isEs ? 'El puesto está determinado por la posición en la lista.' : 'Placement is set by the player’s position in the list.'}</div></div></div>
    ${sec('mains', isEs ? 'Personajes principales' : 'Mains', mains)}
    ${sec('notableWins', 'Notable wins', wins + '<button type="button" class="add" data-act="add-win">+ Add notable win</button>')}
    ${sec('notableResults', 'Notable results', results + '<button type="button" class="add" data-act="add-res">+ Add notable result</button>')}
    ${sec('text', isEs ? 'Descripción del jugador' : 'Player Description', `<textarea class="inp" data-pbind="text" style="min-height:128px">${esc(p.text ?? '')}</textarea><div class="cnt" id="textCount">${(p.text || '').length} ${isEs ? 'caracteres' : 'characters'}</div>`)}`;
}

// ---- events ----
function onInput(e) {
  const t = e.target, d = t.dataset || {};
  if (t.id === 'playerSearchInput') {
    playerModalQuery = t.value;
    renderPlayerModalList();
    return;
  }
  if (d.bind) {
    const k = d.bind, v = t.value;
    if (k === 'game') { const g = games.find(x => x.id === v); draft.game = { id: g.id, name: g.name, slug: g.slug }; renderEditor(); }   // stock icon paths depend on the game
    else if (k === 'start' || k === 'end') draft.period[k] = v;
    else draft[k] = v;
    if (k === 'intro') $('#introCount').textContent = `${v.length} characters`;
  } else if (d.pbind) {
    const p = draft.players[sel];
    p[d.pbind] = d.pbind === 'points' ? nums(t.value) : t.value;
    if (d.pbind === 'text') $('#textCount').textContent = `${t.value.length} characters`;
    if (d.pbind === 'tag') $('.nm').textContent = t.value || 'New player';
  } else if (d.row) {
    const r = draft.players[sel][d.row][+d.i];
    r[d.f] = ['times', 'placement', 'entrants'].includes(d.f) ? nums(t.value) : t.value;
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
    case 'save': save(); return;
    case 'pop-snapshot': populateFromSnapshot(b.dataset.n); return;
    case 'add-player': openPlayerModal('ranking'); return;
    case 'pick-opponent': openPlayerModal({ type: 'opponent', index: i }); return;
    case 'choose-player': addPlayerFromDirectory(b.dataset.playerId); return;
    case 'choose-event': selectEventForNotableResult(+b.dataset.idx); return;
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
    case 'status': draft.status = b.dataset.v; document.querySelectorAll('#status button').forEach(x => x.classList.toggle('on', x.dataset.v === draft.status)); break;
    case 'toggle': { const k = b.dataset.k; if (p[k] === undefined) p[k] = structuredClone(OPT[k]); else delete p[k]; renderEditor(); break; }
    case 'add-main': { const v = $('#newMain').value.trim(); if (v) { p.mains.push(v); renderEditor(); $('#newMain').focus(); } break; }
    case 'rm-main': p.mains.splice(i, 1); renderEditor(); break;
    case 'fmt': { const w = p.notableWins[i]; if (b.dataset.v === 'times') { w.times = w.times ?? 2; delete w.tournament; } else { w.tournament = w.tournament ?? ''; delete w.times; } renderEditor(); break; }
    case 'add-win': p.notableWins.push({ opponent: '', tournament: '' }); renderEditor(); break;
    case 'rm-win': p.notableWins.splice(i, 1); renderEditor(); break;
    case 'add-res': openEventModalForCurrentPlayer(); return;
    case 'rm-res': p.notableResults.splice(i, 1); renderEditor(); break;
  }
  dirty = true; refresh();
}

// Picture upload: previewed in the page only. The saved JSON points at the player's `photo` path,
// so copy the image file to that path (default assets/players/<tag-slug>.jpg) yourself.
function onChange(e) {
  if (e.target.id !== 'photoFile' || !e.target.files[0]) return;
  draft.players[sel]._preview = URL.createObjectURL(e.target.files[0]);
  dirty = true; renderEditor(); refresh();
}

// ---- export: same shape as data/rankings/<id>.json in the rankings pages ----
function exportJson() {
  const list = (a, ok) => (a || []).filter(ok);
  const out = { id: rowId(), title: draft.title.trim(), game: { ...draft.game }, period: { ...draft.period }, status: draft.status };
  if (draft.publishedBy && draft.publishedBy.trim()) out.publishedBy = draft.publishedBy.trim();
  if (draft.intro && draft.intro.trim()) out.intro = draft.intro.trim();
  out.players = draft.players.map((p, i) => {
    const o = { placement: i + 1, tag: p.tag.trim() };
    if (p.playerId) o.playerId = String(p.playerId).trim();
    if (p.points !== null && p.points !== undefined && !Number.isNaN(Number(p.points))) {
      o.points = Number(p.points);
    }
    if (p.photo) o.photo = p.photo;
    if (p.realName && p.realName.trim()) o.realName = p.realName.trim();
    if (has(p.mains)) o.mains = [...p.mains];
    if (p.text && p.text.trim()) o.text = p.text.trim();
    const w = list(p.notableWins, x => x.opponent.trim()); if (w.length) o.notableWins = w.map(x => x.times !== undefined && x.times !== null ? { opponent: x.opponent.trim(), times: x.times } : { opponent: x.opponent.trim(), tournament: (x.tournament || '').trim() });
    const r = list(p.notableResults, x => x.event.trim()); if (r.length) o.notableResults = r.map(x => ({ placement: x.placement, event: x.event.trim(), entrants: x.entrants }));
    return o;
  });
  return out;
}

function save() {
  const out = exportJson(), a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = out.id + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  dirty = false; savedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); renderSub();
}

if (window.i18n && window.i18n.onChange) {
  window.i18n.onChange(() => {
    if (draft) {
      renderDetails();
      renderAll();
    }
  });
}
