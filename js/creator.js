// Platfighters.uy — ranking creator (front-end prototype). Plain JS, no build step.
// State lives in `draft`, which has the same shape as data/rankings/<id>.json in the rankings pages.
let draft, games, sel = 0, dragFrom = null, dirty = false, savedAt = '';

Promise.all([fetch('data/games.json').then(r => r.json()), fetch('data/draft.json').then(r => r.json())])
  .then(([g, d]) => { games = g; draft = d; renderDetails(); renderAll(); });

document.addEventListener('input', onInput);
document.addEventListener('click', onClick);
document.addEventListener('change', onChange);
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
const WHY = { FULL: 'Shown as a full entry because it has a year text or notable wins or results.',
  MEDIUM: 'Shown as a medium entry because it has mains or a real name.',
  MINIMUM: 'Shown as a minimum row: placement, picture, tag and points only.' };
const lab = (t, req) => `<div class="lab"><span>${t}</span><span>${req ? 'REQUIRED' : 'OPTIONAL'}</span></div>`;
const lab2 = t => `<div class="lab"><span>${t}</span></div>`;
const stock = name => `<span class="stock"><i>${esc(name[0])}</i><img src="assets/stock-icons/${esc(draft.game.slug)}/${slug(name)}.png" alt="" onerror="this.remove()"></span>`;
const rowId = () => draft.id || `${draft.game.id}-${slug(draft.title || 'ranking')}`;

// ---- rendering ----
function renderAll() { renderSide(); renderEditor(); renderSub(); }
function refresh() { renderSide(); renderSub(); const p = draft.players[sel], k = kind(p); $('#kindPill').textContent = k + ' ENTRY'; $('#why').textContent = WHY[k]; }

function renderSub() {
  $('#crumbGame').textContent = draft.game.name;
  $('#sub').textContent = `${draft.game.name} community · ${dirty ? 'Unsaved changes' : savedAt ? 'Saved at ' + savedAt : 'No changes yet'}`;
  $('#preview').href = `ranking.html?id=${encodeURIComponent(rowId())}`;
}

function renderDetails() {
  $('#details').innerHTML = `<div><h2>Ranking details</h2><div class="sub">Shown in the archive and at the top of the article.</div></div>
    <div class="frow"><div class="fld" style="flex:2 1 320px">${lab('NAME', 1)}<input class="inp" data-bind="title" value="${esc(draft.title)}"></div>
      <div class="fld" style="flex:1 1 200px">${lab('GAME', 1)}<select class="inp" data-bind="game">${games.map(g => `<option value="${g.id}"${g.id === draft.game.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div></div>
    <div class="frow"><div class="fld" style="flex:1 1 160px">${lab('PERIOD START', 1)}<input type="date" class="inp" data-bind="start" value="${draft.period.start}"></div>
      <div class="fld" style="flex:1 1 160px">${lab('PERIOD END', 1)}<input type="date" class="inp" data-bind="end" value="${draft.period.end}"></div>
      <div class="fld">${lab('STATUS', 1)}<div class="seg glass pill" id="status">${['current', 'final'].map(s => `<button type="button" class="${draft.status === s ? 'on' : ''}" data-act="status" data-v="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div></div></div>
    <div class="fld">${lab('PUBLISHED BY', 0)}<input class="inp" data-bind="publishedBy" value="${esc(draft.publishedBy || '')}"></div>
    <div class="fld">${lab('INTRO', 0)}<textarea class="inp" data-bind="intro">${esc(draft.intro || '')}</textarea><div class="cnt" id="introCount">${(draft.intro || '').length} characters</div></div>`;
}

function renderSide() {
  const ps = draft.players;
  const item = (ok, t, s) => `<div class="ci${ok ? ' done' : ''}"><i></i><span>${t}</span><small>${s}</small></div>`;
  const okD = draft.title.trim() && draft.period.start && draft.period.end;
  const okP = ps.every(p => p.tag.trim() && p.points !== null && p.points !== undefined);
  const pics = ps.filter(p => p.photo || p._preview).length;
  $('#side').innerHTML = `<div class="plist glass"><div class="hd"><b>Players</b><span class="mono muted sm0">${ps.length}</span></div>` +
    ps.map((p, i) => `<button type="button" class="prow${i === sel ? ' on' : ''}" draggable="true" data-act="sel" data-i="${i}"><span class="h">⋮⋮</span><span class="n ${pcls(i + 1)}">${i + 1}</span><span class="t">${esc(p.tag || 'New player')}</span><span class="k">${kind(p)}</span></button>`).join('') +
    `<button type="button" class="btn glass pill addp" data-act="add-player">+ Add player</button>
     <div class="note">Drag to reorder. Placements follow the order. <button type="button" class="add" style="padding:0" data-act="sort">Sort by points</button></div></div>
    <div class="check glass"><b>Before publishing</b>${item(okD, 'Name, game and period', okD ? 'DONE' : 'MISSING')}${item(okP, `Placement, tag and points for all ${ps.length} players`, okP ? 'DONE' : 'MISSING')}${item(pics === ps.length, 'Pictures', `${pics} OF ${ps.length}`)}</div>`;
}

function renderEditor() {
  const p = draft.players[sel], n = sel + 1, k = kind(p);
  const pic = p._preview ? `<img src="${p._preview}" alt="">` : p.photo ? `<img src="${esc(p.photo)}" alt="" onerror="this.remove()">` : '';
  const sec = (key, title, body) => { const on = p[key] !== undefined;
    return `<div class="sec glass"><div class="sh"><b>${title}</b><small>OPTIONAL</small><span class="sp"></span><button type="button" class="tog${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${title}" data-act="toggle" data-k="${key}"></button></div>${on ? body : ''}</div>`; };
  const seg = (i, cur) => `<span class="seg glass pill">${[['tournament', 'Tournament'], ['times', 'Times']].map(([v, l]) => `<button type="button" class="${cur === v ? 'on' : ''}" data-act="fmt" data-i="${i}" data-v="${v}">${l}</button>`).join('')}</span>`;
  const rm = (act, i, what) => `<button type="button" class="x glass pill" data-act="${act}" data-i="${i}" aria-label="Remove ${what}">×</button>`;
  const cell = (cls, label, row, i, f, val, extra = '') => `<div class="${cls}">${lab2(label)}<input class="inp" data-row="${row}" data-i="${i}" data-f="${f}" value="${esc(val ?? '')}" ${extra}></div>`;

  const wins = (p.notableWins || []).map((w, i) => { const t = w.times !== undefined;
    return `<div class="rowf">${cell('g', 'OPPONENT', 'notableWins', i, 'opponent', w.opponent)}<div>${lab2('FORMAT')}${seg(i, t ? 'times' : 'tournament')}</div>${t ? cell('g', 'TIMES', 'notableWins', i, 'times', w.times) : cell('g', 'TOURNAMENT', 'notableWins', i, 'tournament', w.tournament)}${rm('rm-win', i, 'win')}</div>`; }).join('');
  const results = (p.notableResults || []).map((r, i) =>
    `<div class="rowf"><div style="flex:0 0 100px">${lab2('PLACEMENT')}<input class="inp" data-row="notableResults" data-i="${i}" data-f="placement" value="${r.placement ?? ''}"></div>${cell('g', 'EVENT', 'notableResults', i, 'event', r.event)}<div style="flex:0 0 120px">${lab2('ENTRANTS')}<input class="inp" data-row="notableResults" data-i="${i}" data-f="entrants" value="${r.entrants ?? ''}"></div>${rm('rm-res', i, 'result')}</div>`).join('');
  const mains = `<div class="chips">${(p.mains || []).map((m, i) => `<span class="glass pill mchip">${stock(m)}${esc(m)}<button type="button" class="x glass pill" data-act="rm-main" data-i="${i}" aria-label="Remove ${esc(m)}">×</button></span>`).join('')}</div>
    <div class="rowf"><div class="g"><input class="inp" id="newMain" placeholder="Character name"></div><button type="button" class="btn glass pill" data-act="add-main">+ Add main</button></div><div class="note0">Shown on the ranking as stock icons.</div>`;

  $('#editor').innerHTML = `<div class="ed-head"><div class="l"><span class="big ${pcls(n)}">${n}</span><span class="nm">${esc(p.tag || 'New player')}</span></div>
      <div class="l" style="align-items:center"><span class="kind" id="kindPill">${k} ENTRY</span><button type="button" class="add" data-act="remove-player">Remove player</button></div></div>
    <div class="why" id="why">${WHY[k]}</div>
    <div class="req"><div class="dzw"><div class="dz"><i>${esc((p.tag || '?')[0])}</i>${pic}</div>
        <button type="button" class="btn glass pill" data-act="pick-photo">Replace picture</button><input type="file" id="photoFile" accept="image/png,image/jpeg" hidden><div class="note0" style="text-align:center">JPG or PNG</div></div>
      <div class="reqf"><div class="fld" style="flex:0 0 120px">${lab('PLACEMENT', 1)}<input class="inp ro ${pcls(n)}" value="${n}" readonly aria-readonly="true"></div>
        <div class="fld" style="flex:1 1 200px">${lab('TAG', 1)}<input class="inp" data-pbind="tag" value="${esc(p.tag)}" placeholder="Gamertag"></div>
        <div class="fld" style="flex:1 1 160px">${lab('POINTS', 1)}<input class="inp mono" data-pbind="points" inputmode="numeric" value="${p.points == null ? '' : Number(p.points).toLocaleString('en-US')}"></div>
        <div class="hint">Placement is set by the player’s position in the list.</div></div></div>
    ${sec('realName', 'Real name', `<input class="inp" data-pbind="realName" value="${esc(p.realName ?? '')}" placeholder="[Real name]">`)}
    ${sec('mains', 'Mains', mains)}
    ${sec('text', 'Year text', `<textarea class="inp" data-pbind="text" style="min-height:128px">${esc(p.text ?? '')}</textarea><div class="cnt" id="textCount">${(p.text || '').length} characters</div>`)}
    ${sec('notableWins', 'Notable wins', wins + '<button type="button" class="add" data-act="add-win">+ Add notable win</button>')}
    ${sec('notableResults', 'Notable results', results + '<button type="button" class="add" data-act="add-res">+ Add notable result</button>')}`;
}

// ---- events ----
function onInput(e) {
  const t = e.target, d = t.dataset || {};
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
    case 'add-player': draft.players.push({ tag: '', points: null }); sel = draft.players.length - 1; renderAll(); break;
    case 'remove-player': if (draft.players.length > 1) { draft.players.splice(sel, 1); sel = Math.max(0, sel - 1); renderAll(); } break;
    case 'sort': { const cur = p; draft.players.sort((x, y) => (y.points || 0) - (x.points || 0)); sel = draft.players.indexOf(cur); renderAll(); break; }
    case 'status': draft.status = b.dataset.v; document.querySelectorAll('#status button').forEach(x => x.classList.toggle('on', x.dataset.v === draft.status)); break;
    case 'toggle': { const k = b.dataset.k; if (p[k] === undefined) p[k] = structuredClone(OPT[k]); else delete p[k]; renderEditor(); break; }
    case 'add-main': { const v = $('#newMain').value.trim(); if (v) { p.mains.push(v); renderEditor(); $('#newMain').focus(); } break; }
    case 'rm-main': p.mains.splice(i, 1); renderEditor(); break;
    case 'fmt': { const w = p.notableWins[i]; if (b.dataset.v === 'times') { w.times = w.times ?? 2; delete w.tournament; } else { w.tournament = w.tournament ?? ''; delete w.times; } renderEditor(); break; }
    case 'add-win': p.notableWins.push({ opponent: '', tournament: '' }); renderEditor(); break;
    case 'rm-win': p.notableWins.splice(i, 1); renderEditor(); break;
    case 'add-res': p.notableResults.push({ placement: null, event: '', entrants: null }); renderEditor(); break;
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
    const o = { placement: i + 1, tag: p.tag.trim(), points: p.points };
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
