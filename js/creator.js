// Platfighters.uy — ranking creator. Plain JS, no build step.
// Supports Public mode and Admin mode with server-side authentication verification.

let draft, games = [], allProfiles = [], gameCharacters = {}, sel = 0, dragFrom = null, dirty = false, savedAt = '';
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

// Initial data load
const loadPromises = [
  fetch('data/games.json').then(r => r.json()),
  fetch('data/profiles/index.json').then(r => r.json()).catch(() => []),
  fetch('data/characters.json').then(r => r.json()).catch(() => ({})),
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
  .then(([g, profiles, chars, _, existingRanking]) => {
    games = (g || []).sort((a, b) => a.name.localeCompare(b.name));
    allProfiles = profiles || [];
    gameCharacters = chars || {};

    if (existingRanking) {
      draft = existingRanking;
      if (draft.status === 'current') draft.status = 'yearly';
      else if (draft.status === 'final') draft.status = 'seasonal';
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
        intro: '',
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

  const currentIds = new Set((draft.players || []).map(p => String(p.playerId)).filter(Boolean));
  if (currentIds.has(String(player.playerId))) {
    alert('This player is already included in the ranking.');
    return;
  }

  const newEntry = {
    tag: player.tag,
    playerId: String(player.playerId),
    points: null,
    photo: player.photo || `assets/players/${player.playerId}.png`
  };

  draft.players.push(newEntry);
  sel = draft.players.length - 1;
  dirty = true;
  closePlayerModal();
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
          const curGameSlug = draft.game ? draft.game.slug : '';
          const gamesArr = profileData.games || [];
          const matchedGame = gamesArr.find(g => g.slug === curGameSlug) || gamesArr[0];
          if (matchedGame && matchedGame.results) {
            playerEventResults = matchedGame.results;
            break;
          }
        }
      } catch (e) {}
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
  if (e.target.id === 'closePlayerModalBtn' || e.target.closest('#closePlayerModalBtn')) closePlayerModal();
  if (e.target === $('#player-select-modal')) closePlayerModal();
  if (e.target.id === 'closeEventModalBtn' || e.target.closest('#closeEventModalBtn')) closeEventModal();
  if (e.target === $('#event-select-modal')) closeEventModal();
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

const OPT = { realName: '', mains: [], text: '', notableWins: [], notableResults: [] };
const nums = v => String(v).trim() === '' ? null : Number(String(v).replace(/[^\d]/g, ''));
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
const lab = (t, req) => {
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  return `<div class="lab"><span>${t}</span><span>${req ? (isEs ? 'REQUERIDO' : 'REQUIRED') : (isEs ? 'OPCIONAL' : 'OPTIONAL')}</span></div>`;
};
const lab2 = t => `<div class="lab"><span>${t}</span></div>`;
const stock = name => `<span class="stock"><i>${esc(name[0])}</i><img src="assets/stock-icons/${esc(draft.game.slug)}/${slug(name)}.png" alt="" onerror="this.remove()"></span>`;
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

function populateFromSnapshot(count) {
  if (!prSnapshot || !prSnapshot.players || !prSnapshot.players.length) return;
  const countNum = parseInt(count, 10);
  const playersToTake = prSnapshot.players.slice(0, countNum);

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
    <div class="frow"><div class="fld" style="flex:2 1 320px">${lab(isEs ? 'NOMBRE' : 'NAME', 1)}<input class="inp" data-bind="title" value="${esc(draft.title)}" placeholder="e.g. Montevideo Season 1 PR"></div>
      <div class="fld" style="flex:1 1 200px">${lab(isEs ? 'JUEGO' : 'GAME', 1)}<select class="inp" data-bind="game">${games.map(g => `<option value="${g.id}"${g.id === draft.game.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div></div>
    <div class="frow"><div class="fld" style="flex:1 1 160px">${lab(isEs ? 'INICIO DEL PERIODO' : 'PERIOD START', 1)}<input type="date" class="inp" data-bind="start" value="${draft.period.start}"></div>
      <div class="fld" style="flex:1 1 160px">${lab(isEs ? 'FIN DEL PERIODO' : 'PERIOD END', 1)}<input type="date" class="inp" data-bind="end" value="${draft.period.end}"></div>
      <div class="fld">${lab(isEs ? 'CLASIFICACIÓN' : 'CLASSIFICATION', 1)}<div class="seg glass pill" id="status">${['yearly', 'seasonal'].map(s => `<button type="button" class="${draft.status === s ? 'on' : ''}" data-act="status" data-v="${s}">${s === 'yearly' ? (isEs ? 'Anual' : 'Yearly') : (isEs ? 'De temporada' : 'Seasonal')}</button>`).join('')}</div></div></div>
    <div class="fld">${lab(isEs ? 'PUBLICADO POR' : 'PUBLISHED BY', 0)}<input class="inp" data-bind="publishedBy" value="${esc(draft.publishedBy || '')}"></div>
    <div class="fld">${lab(isEs ? 'INTRODUCCIÓN' : 'INTRO', 0)}<textarea class="inp" data-bind="intro" placeholder="Introductory notes...">${esc(draft.intro || '')}</textarea><div class="cnt" id="introCount">${(draft.intro || '').length} ${isEs ? 'caracteres' : 'characters'}</div></div>`;
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
        <button type="button" class="btn glass pill" data-act="pick-photo">${isEs ? 'Cambiar imagen' : 'Replace picture'}</button><input type="file" id="photoFile" accept="image/png,image/jpeg" hidden><div class="note0" style="text-align:center">JPG or PNG (Optional)</div></div>
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

function onInput(e) {
  const t = e.target, d = t.dataset || {};
  if (t.id === 'playerSearchInput') {
    playerModalQuery = t.value;
    renderPlayerModalList();
    return;
  }
  if (d.bind) {
    const k = d.bind, v = t.value;
    if (k === 'game') {
      const g = games.find(x => x.id === v);
      if (g) draft.game = { id: g.id, name: g.name, slug: g.slug };
      renderEditor();
    } else if (k === 'start' || k === 'end') {
      draft.period[k] = v;
    } else {
      draft[k] = v;
    }
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
    case 'preview': doPreview(); return;
    case 'import': triggerImport(); return;
    case 'export': doExport(); return;
    case 'share': doShare(); return;
    case 'export-image': doExportImage(); return;
    case 'publish': doPublish(); return;
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

function onChange(e) {
  if (e.target.id === 'photoFile' && e.target.files[0]) {
    draft.players[sel]._preview = URL.createObjectURL(e.target.files[0]);
    dirty = true; renderEditor(); refresh();
  }
  if (e.target.id === 'importFileInput' && e.target.files[0]) {
    handleImportFile(e.target.files[0]);
    e.target.value = '';
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
  if (draft.intro && draft.intro.trim()) out.intro = draft.intro.trim();

  out.players = (draft.players || []).map((p, i) => {
    const o = { placement: i + 1, tag: (p.tag || '').trim() };
    if (p.playerId) o.playerId = String(p.playerId).trim();
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
    publishedBy: typeof data.publishedBy === 'string' ? data.publishedBy.slice(0, 100) : '',
    intro: typeof data.intro === 'string' ? data.intro.slice(0, 2000) : '',
    players: []
  };

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
    }

    if (Array.isArray(p.notableResults)) {
      playerObj.notableResults = p.notableResults.filter(r => r && typeof r === 'object' && typeof r.event === 'string').map(r => ({
        placement: (r.placement !== null && r.placement !== undefined) ? Number(r.placement) : null,
        event: r.event.slice(0, 120),
        entrants: (r.entrants !== null && r.entrants !== undefined) ? Number(r.entrants) : null
      }));
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

function doExportImage() {
  const rankingData = constructRankingJson();
  if (!rankingData.players || !rankingData.players.length) {
    alert('Add players to your ranking before exporting an image.');
    return;
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const width = 1200;
  const padding = 60;
  const rowHeight = 70;
  const headerHeight = 240;
  const height = headerHeight + (rankingData.players.length * rowHeight) + padding;

  canvas.width = width * 2;
  canvas.height = height * 2;
  ctx.scale(2, 2);

  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, '#050B1F');
  grad.addColorStop(0.5, '#0B1538');
  grad.addColorStop(1, '#050B1F');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
  ctx.beginPath();
  ctx.arc(width - 150, 150, 250, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = '#38BDF8';
  ctx.font = '700 16px "Space Grotesk", sans-serif';
  ctx.fillText('PLATFIGHTERS.UY · COMMUNITY POWER RANKING', padding, 70);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 36px "Space Grotesk", sans-serif';
  ctx.fillText(rankingData.title, padding, 120);

  const metaText = `${rankingData.game.name} · ${rankingData.status.toUpperCase()} · ${rankingData.period.start || ''} → ${rankingData.period.end || ''}`;
  ctx.fillStyle = '#94A3B8';
  ctx.font = '500 16px "Space Grotesk", sans-serif';
  ctx.fillText(metaText, padding, 155);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, 190);
  ctx.lineTo(width - padding, 190);
  ctx.stroke();

  rankingData.players.forEach((p, idx) => {
    const y = headerHeight + (idx * rowHeight);

    if (idx % 2 === 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.fillRect(padding, y - 36, width - (padding * 2), rowHeight);
    }

    let rankColor = '#38BDF8';
    if (p.placement === 1) rankColor = '#EAB308';
    else if (p.placement === 2) rankColor = '#94A3B8';
    else if (p.placement === 3) rankColor = '#D97706';

    ctx.fillStyle = rankColor;
    ctx.font = '700 24px monospace';
    ctx.fillText(String(p.placement).padStart(2, ' '), padding + 10, y + 6);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 22px "Space Grotesk", sans-serif';
    ctx.fillText(p.tag, padding + 70, y + 6);

    if (p.realName) {
      ctx.fillStyle = '#94A3B8';
      ctx.font = '400 16px "Space Grotesk", sans-serif';
      ctx.fillText(`(${p.realName})`, padding + 70 + ctx.measureText(p.tag).width + 12, y + 5);
    }

    if (p.mains && p.mains.length) {
      ctx.fillStyle = 'rgba(56, 189, 248, 0.8)';
      ctx.font = '500 14px "Space Grotesk", sans-serif';
      ctx.fillText(p.mains.join(' / '), width - padding - 220, y + 5);
    }

    if (p.points !== null && p.points !== undefined) {
      ctx.fillStyle = '#E2E8F0';
      ctx.font = '700 18px monospace';
      const ptsStr = `${Number(p.points).toLocaleString('en-US')} pts`;
      ctx.fillText(ptsStr, width - padding - 100, y + 6);
    }
  });

  ctx.fillStyle = '#64748B';
  ctx.font = '500 14px monospace';
  ctx.fillText('Generated on Platfighters.uy · Community Ranking (Unofficial)', padding, height - 20);

  const a = document.createElement('a');
  a.download = `${slug(rankingData.title || 'power-ranking')}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
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
