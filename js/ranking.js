// Ranking article: loads data/rankings/<id>.json (id comes from ?id=...).
// Each player's layout depends on how much data they have:
//   full    -> has text, notableWins or notableResults
//   medium  -> has mains or realName
//   minimum -> only placement, tag, points (and the picture)
const id = new URLSearchParams(location.search).get('id') || '';
(/^[a-z0-9-]+$/.test(id) ? fetch(`data/rankings/${id}.json`).then(r => r.ok ? r.json() : Promise.reject()) : Promise.reject())
  .then(render)
  .catch(() => {
    $('#col').innerHTML = '<div class="empty glass">Ranking not found. <a href="rankings.html?section=historical">Back to all rankings</a></div>';
  });

const photo = (p, size) => `<div class="photo ${size}"><i>${esc(p.tag ? p.tag[0] : '?')}</i><img src="${esc(p.photo || `assets/players/${slug(p.tag)}.jpg`)}" alt="" onerror="this.remove()"></div>`;
const stock = (g, name) => `<span class="stock" title="${esc(name)}" role="img" aria-label="${esc(name)}"><i>${esc(name ? name[0] : '?')}</i><img src="assets/stock-icons/${g.slug}/${slug(name)}.png" alt="" onerror="this.remove()"></span>`;
const pts = p => `${Number(p.points || 0).toLocaleString('en-US')} pts`;

function render(r) {
  document.title = `${r.title} · Platfighters.uy`;
  const players = [...r.players].sort((a, b) => a.placement - b.placement);
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const mains = p => p.mains && p.mains.length ? `<div class="stocks">${p.mains.map(m => stock(r.game, m)).join('')}</div>` : '';
  const real = p => p.realName ? `<div class="muted" style="font-size:15px">${esc(p.realName)}</div>` : '';
  const win = w => `<div>${esc(w.opponent)} <span class="muted">· ${w.times > 1 ? (isEs ? w.times + ' veces' : w.times + ' times') : esc(w.tournament)}</span></div>`;
  const res = x => `<div>${ord(x.placement)} · ${esc(x.event)} · ${x.entrants} ${isEs ? 'participantes' : 'entrants'}</div>`;
  const list = (label, items, fn) => items && items.length ? `<div class="list"><h3>${label}</h3>${items.map(fn).join('')}</div>` : '';

  const full = p => `<article class="entry full glass" id="p-${p.placement}">
    <div class="top-row">${photo(p, 'lg')}<div class="who">
      <div class="ident"><span class="rank ${pcls(p.placement)}">${p.placement}</span><h2>${esc(p.tag)}</h2></div>
      ${real(p)}<div class="pts mono">${pts(p)}</div>${mains(p)}</div></div>
    ${p.text ? `<p class="text">${esc(p.text)}</p>` : ''}
    ${p.notableWins || p.notableResults ? `<div class="lists">${list(isEs ? 'VICTORIAS DESTACADAS' : 'NOTABLE WINS', p.notableWins, win)}${list(isEs ? 'RESULTADOS DESTACADOS' : 'NOTABLE RESULTS', p.notableResults, res)}</div>` : ''}</article>`;

  const medium = p => `<article class="entry med glass" id="p-${p.placement}">
    <span class="rank-md ${pcls(p.placement)}">${p.placement}</span>${photo(p, 'md')}
    <div class="who"><span class="tag">${esc(p.tag)}</span>${real(p)}${mains(p)}</div><span class="pts mono">${pts(p)}</span></article>`;

  const row = p => `<div class="row" id="p-${p.placement}"><span class="n ${pcls(p.placement)}">${p.placement}</span>${photo(p, 'sm')}<b>${esc(p.tag)}</b><span class="pts mono">${pts(p)}</span></div>`;

  // Consecutive minimum entries share one panel.
  let html = '', run = [];
  const flush = () => { if (run.length) html += `<div class="minlist glass">${run.map(row).join('')}</div>`; run = []; };
  players.forEach(p => {
    if (p.text || (p.notableWins && p.notableWins.length) || (p.notableResults && p.notableResults.length)) { flush(); html += full(p); }
    else if ((p.mains && p.mains.length) || p.realName) { flush(); html += medium(p); }
    else run.push(p);
  });
  flush();

  $('#side').innerHTML = `<div class="top"><div class="eyebrow mono">POWER RANKINGS</div><b>${esc(r.title)}</b><span class="muted">${esc(r.game.name)} · ${players.length} ${isEs ? 'jugadores rankeados' : 'players ranked'}</span></div>` +
    players.map(p => `<a class="jump" href="#p-${p.placement}"><span class="n ${pcls(p.placement)}">${p.placement}</span>${esc(p.tag)}</a>`).join('');

  $('#col').innerHTML = `<section class="head-panel glass">
      <div class="eyebrow mono"><a href="rankings.html?section=historical#${esc(r.game.id)}">Rankings</a> › ${esc(r.game.name)} › ${esc(r.title)}</div>
      <h1 class="display">${esc(r.title)}</h1>
      <div class="meta"><span class="glass pill chip">${esc(r.game.name)}</span><span>${period(r.period.start, r.period.end)}</span>${r.publishedBy ? `<span>·</span><span>${isEs ? 'Publicado por ' + esc(r.publishedBy) : 'Published by ' + esc(r.publishedBy)}</span>` : ''}</div>
      ${r.intro ? `<p class="intro">${esc(r.intro)}</p>` : ''}</section>` + html;
}

if (window.i18n && window.i18n.onChange) {
  window.i18n.onChange(() => {
    if (typeof id === 'string' && id) {
      fetch(`data/rankings/${id}.json`).then(r => r.ok ? r.json() : null).then(data => { if (data) render(data); });
    }
  });
}
