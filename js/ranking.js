// Ranking article: loads official ranking or community shared ranking.
// Supports:
// 1. URL parameter: ?id=<id> (official rankings)
// 2. URL parameter: ?preview=community (local preview from creator)
// 3. URL fragment: #community=<base64-json> (shareable links)

const urlParams = new URLSearchParams(location.search);
const id = urlParams.get('id') || '';
const isPreview = urlParams.get('preview') === 'community';

// Profile and portrait caching
const profileCache = new Map();
let allProfilesIndex = null;

async function fetchProfileData(playerId, tag) {
  if (!playerId && !tag) return null;
  const key = String(playerId || tag);
  if (profileCache.has(key)) return profileCache.get(key);

  if (!allProfilesIndex) {
    try {
      const res = await fetch('data/profiles/index.json');
      if (res.ok) allProfilesIndex = await res.json();
    } catch (e) {
      allProfilesIndex = [];
    }
  }

  const matched = (allProfilesIndex || []).find(x => String(x.playerId) === String(playerId) || (tag && slug(x.tag) === slug(tag)));
  const slugName = matched?.slug || (tag ? slug(tag) : '');
  const candidatePaths = [
    slugName ? `data/profiles/${slugName}.json` : null,
    (slugName && playerId) ? `data/profiles/${slugName}-${playerId}.json` : null
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

function resolveCharacterPortraitFallback(p, gslug, profile) {
  if (profile && Array.isArray(profile.games)) {
    const g = profile.games.find(x => x.slug === gslug) || profile.games[0];
    if (g && Array.isArray(g.characters)) {
      const topChar = g.characters.find(c => String(c.name || '').toLowerCase() !== 'other');
      if (topChar && topChar.name) {
        const cslug = charStockSlug(topChar.name);
        return `assets/renders/${gslug}/portraits/${cslug}.webp`;
      }
    }
  }
  if (p && Array.isArray(p.mains) && p.mains.length) {
    const cslug = charStockSlug(p.mains[0]);
    return `assets/renders/${gslug}/portraits/${cslug}.webp`;
  }
  return `assets/renders/${gslug}/portraits/other.webp`;
}

const photo = (p, size, gslug = 'ultimate', isRegularUserRanking = false) => {
  let photoSrc = '';
  if (isRegularUserRanking) {
    // Regular user creation: do not allow custom player photos; use character portrait
    photoSrc = p._characterPortrait || (p.mains && p.mains.length ? `assets/renders/${gslug}/portraits/${charStockSlug(p.mains[0])}.webp` : `assets/renders/${gslug}/portraits/other.webp`);
  } else {
    // Admin creation or official ranking: custom photo or character portrait fallback
    photoSrc = p.photo || p._characterPortrait || (p.playerId ? `assets/players/${p.playerId}.png` : `assets/players/${slug(p.tag)}.jpg`);
  }
  return `<div class="photo ${size}"><i>${esc(p.tag ? p.tag[0] : '?')}</i><img src="${esc(photoSrc)}" alt="" onerror="this.remove()"></div>`;
};
const stock = (g, name) => {
  const gslug = (g && g.slug) ? g.slug : 'rivals-2';
  const cslug = charStockSlug(name);
  return `<span class="stock" title="${esc(name)}" role="img" aria-label="${esc(name)}"><i>${esc(name ? name[0] : '?')}</i><img src="assets/renders/${esc(gslug)}/stocks/${esc(cslug)}.webp" alt="" onerror="if(!this.dataset.fallback){this.dataset.fallback='1';this.src='assets/renders/${esc(gslug)}/stocks/other.webp';}else{this.remove();}"></span>`;
};
const pts = p => (p.points !== null && p.points !== undefined && !Number.isNaN(Number(p.points)))
  ? `<span class="pts mono">${Number(p.points).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 })} pts</span>`
  : '';

function decodeCommunityPayload(base64Str) {
  try {
    const jsonStr = decodeURIComponent(Array.prototype.map.call(atob(base64Str), c => {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.players)) {
      throw new Error('Invalid community ranking structure.');
    }
    if (parsed.createdBy !== undefined && parsed.createdBy !== null) {
      parsed.createdBy = String(parsed.createdBy).slice(0, 80).trim();
    }
    // Prevent unauthenticated elevation from shareable community links
    delete parsed.isOfficial;
    delete parsed.publishedBy;
    return parsed;
  } catch (err) {
    throw new Error('Malformed or corrupted shareable link.');
  }
}

function loadRanking() {
  const hash = window.location.hash || '';

  // 1. Check for community share in URL fragment (#community=...)
  if (hash.startsWith('#community=')) {
    try {
      const payload = hash.slice('#community='.length);
      const rankingObj = decodeCommunityPayload(payload);
      rankingObj._isCommunity = true;
      preparePlayerPortraits(rankingObj).then(() => render(rankingObj));
      return;
    } catch (e) {
      $('#col').innerHTML = `<div class="empty glass">${esc(e.message)} <a href="rankings.html?section=historical">Back to all rankings</a></div>`;
      return;
    }
  }

  // 2. Check for local community preview in sessionStorage
  if (isPreview) {
    try {
      const raw = sessionStorage.getItem('platfighters_community_preview');
      if (raw) {
        const rankingObj = JSON.parse(raw);
        rankingObj._isCommunity = true;
        preparePlayerPortraits(rankingObj).then(() => render(rankingObj));
        return;
      }
    } catch (e) {}
  }

  // 3. Official historical ranking from data/rankings/<id>.json
  if (/^[a-z0-9-]+$/.test(id)) {
    fetch(`data/rankings/${id}.json`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(async r => {
        r._isCommunity = false;
        await preparePlayerPortraits(r);
        render(r);
      })
      .catch(() => {
        $('#col').innerHTML = '<div class="empty glass">Ranking not found. <a href="rankings.html?section=historical">Back to all rankings</a></div>';
      });
  } else {
    $('#col').innerHTML = '<div class="empty glass">No ranking specified. <a href="rankings.html?section=historical">Back to all rankings</a></div>';
  }
}

async function preparePlayerPortraits(r) {
  const gslug = r.game?.slug || 'ultimate';
  const isRegularUserRanking = Boolean(r._isCommunity && !r.isOfficial && !r.publishedBy);
  for (const p of (r.players || [])) {
    if (isRegularUserRanking || !p.photo) {
      const prof = await fetchProfileData(p.playerId, p.tag);
      p._characterPortrait = resolveCharacterPortraitFallback(p, gslug, prof);
    }
  }
}

loadRanking();
window.addEventListener('hashchange', loadRanking);

async function render(r) {
  const isCommunity = Boolean(r._isCommunity);
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const isRegularUserRanking = Boolean(isCommunity && !r.isOfficial && !r.publishedBy);
  const gslug = r.game?.slug || 'ultimate';

  document.title = `${r.title} · ${isCommunity ? (isEs ? 'Ranking Comunitario' : 'Community Ranking') : 'Platfighters.uy'}`;
  const players = [...(r.players || [])].sort((a, b) => a.placement - b.placement);
  const mains = p => p.mains && p.mains.length ? `<div class="stocks">${p.mains.map(m => stock(r.game, m)).join('')}</div>` : '';
  const real = p => p.realName ? `<div class="muted" style="font-size:15px">${esc(p.realName)}</div>` : '';
  const win = w => `<div>${esc(w.opponent)} <span class="muted">· ${w.times > 1 ? (isEs ? w.times + ' veces' : w.times + ' times') : esc(w.tournament || '')}</span></div>`;
  const res = x => `<div>${ord(x.placement)} · ${esc(x.event)} ${x.entrants ? '· ' + x.entrants + ' ' + (isEs ? 'participantes' : 'entrants') : ''}</div>`;
  const list = (label, items, fn) => items && items.length ? `<div class="list"><h3>${label}</h3>${items.map(fn).join('')}</div>` : '';

  const playerLink = (tag, pid, cls = '') => pid
    ? `<a href="player.html?player=${encodeURIComponent(pid)}" class="opponent-link ${cls}">${esc(tag)}</a>`
    : esc(tag);

  const sponsorBadge = p => p.sponsor ? `<span class="player-sponsor">${esc(p.sponsor)}</span> ` : '';

  const full = p => `<article class="entry full glass" id="p-${p.placement}">
    <div class="top-row">${photo(p, 'lg', gslug, isRegularUserRanking)}<div class="who">
      <div class="ident"><span class="rank ${pcls(p.placement)}">${p.placement}</span><h2>${sponsorBadge(p)}${playerLink(p.tag, p.playerId)}</h2></div>
      ${real(p)}${pts(p)}${mains(p)}</div></div>
    ${p.text ? `<div class="text markdown-content">${renderMarkdown(p.text)}</div>` : ''}
    ${p.notableWins || p.notableResults ? `<div class="lists">${list(isEs ? 'VICTORIAS DESTACADAS' : 'NOTABLE WINS', p.notableWins, win)}${list(isEs ? 'RESULTADOS DESTACADOS' : 'NOTABLE RESULTS', p.notableResults, res)}</div>` : ''}</article>`;

  const medium = p => `<article class="entry med glass" id="p-${p.placement}">
    <span class="rank-md ${pcls(p.placement)}">${p.placement}</span>${photo(p, 'md', gslug, isRegularUserRanking)}
    <div class="who"><span class="tag">${sponsorBadge(p)}${playerLink(p.tag, p.playerId)}</span>${real(p)}${mains(p)}</div>${pts(p)}</article>`;

  const row = p => `<div class="row" id="p-${p.placement}"><span class="n ${pcls(p.placement)}">${p.placement}</span>${photo(p, 'sm', gslug, isRegularUserRanking)}<b>${sponsorBadge(p)}${playerLink(p.tag, p.playerId)}</b>${pts(p)}</div>`;

  let html = '', run = [];
  const flush = () => { if (run.length) html += `<div class="minlist glass">${run.map(row).join('')}</div>`; run = []; };
  players.forEach(p => {
    if (p.text || (p.notableWins && p.notableWins.length) || (p.notableResults && p.notableResults.length)) { flush(); html += full(p); }
    else if ((p.mains && p.mains.length) || p.realName) { flush(); html += medium(p); }
    else run.push(p);
  });
  flush();

  const customRankingLabel = isEs ? 'Ranking Personalizado' : 'Custom Ranking';
  const creatorStr = (r.createdBy && typeof r.createdBy === 'string') ? r.createdBy.trim() : '';

  let badgeHtml = '';
  if (isCommunity) {
    if (creatorStr) {
      badgeHtml = `<span class="tagpill" style="color:var(--gold); border-color:rgba(234,179,8,.4); background:rgba(234,179,8,.1); font-weight:700;"><span class="custom-ranking-main">${esc(customRankingLabel)}</span> <span class="custom-ranking-by" style="font-weight:400; opacity:0.9;">· ${isEs ? 'Creado por ' + esc(creatorStr) : 'Created by ' + esc(creatorStr)}</span></span>`;
    } else {
      badgeHtml = `<span class="tagpill" style="color:var(--gold); border-color:rgba(234,179,8,.4); background:rgba(234,179,8,.1); font-weight:700;"><span class="custom-ranking-main">${esc(customRankingLabel)}</span></span>`;
    }
  }

  const eyebrowTitle = isCommunity
    ? (isEs ? 'RANKING PERSONALIZADO' : 'CUSTOM RANKING')
    : 'POWER RANKINGS';

  $('#side').innerHTML = `<div class="top"><div class="eyebrow mono">${eyebrowTitle}</div><b>${esc(r.title)}</b><span class="muted">${esc(r.game ? r.game.name : '')} · ${players.length} ${isEs ? 'jugadores' : 'players'}</span></div>` +
    players.map(p => `<a class="jump" href="#p-${p.placement}"><span class="n ${pcls(p.placement)}">${p.placement}</span>${esc(p.tag)}</a>`).join('');

  const breadcrumb = isCommunity
    ? `<a href="ranking-creator.html">Ranking Creator</a> › ${esc(r.game ? r.game.name : '')} › ${esc(r.title)}`
    : `<a href="rankings.html?section=historical#${esc(r.game ? r.game.id : '')}">Rankings</a> › ${esc(r.game ? r.game.name : '')} › ${esc(r.title)}`;

  const periodText = (r.period && r.period.start && r.period.end) ? period(r.period.start, r.period.end) : '';

  const metaCreatorHtml = (isCommunity && creatorStr)
    ? `<span>·</span><span class="ranking-created-by">${isEs ? 'Creado por ' + esc(creatorStr) : 'Created by ' + esc(creatorStr)}</span>`
    : '';

  $('#col').innerHTML = `<section class="head-panel glass">
      <div class="eyebrow mono">${breadcrumb}</div>
      <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-top:8px;">
        <h1 class="display" style="margin:0;">${esc(r.title)}</h1>
        ${badgeHtml}
      </div>
      <div class="meta" style="margin-top:12px;"><span class="glass pill chip">${esc(r.game ? r.game.name : '')}</span>${periodText ? `<span>${periodText}</span>` : ''}${r.publishedBy ? `<span>·</span><span>${isEs ? 'Publicado por ' + esc(r.publishedBy) : 'Published by ' + esc(r.publishedBy)}</span>` : ''}${metaCreatorHtml}</div>
      ${r.intro ? `<p class="intro">${esc(r.intro)}</p>` : ''}</section>` + html;
}

if (window.i18n && window.i18n.onChange) {
  window.i18n.onChange(() => {
    loadRanking();
  });
}
