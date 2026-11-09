const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = dateStr => dateStr ? new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const ord = n => {
  if (!Number.isFinite(Number(n)) || Number(n) < 1) return '—';
  const num = Number(n);
  return num + ((num % 100 >= 11 && num % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[num % 10] || 'th'));
};

const tournamentSlug = new URLSearchParams(location.search).get('tournament');
const main = $('#main');

async function loadEvent() {
  if (!tournamentSlug) {
    main.innerHTML = '<div class="panel glass empty-state"><h2>No tournament selected</h2><p class="muted"><a href="events.html">Return to event directory</a></p></div>';
    return;
  }

  try {
    const response = await fetch(`data/events/${encodeURIComponent(tournamentSlug)}.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Tournament details not found.');
    const event = await response.json();
    renderEvent(event);
  } catch (error) {
    main.innerHTML = `<div class="panel glass empty-state"><h2>Event unavailable</h2><p class="muted">${esc(error.message)}</p><p style="margin-top:12px;"><a href="events.html" class="action-button">Return to Event Directory</a></p></div>`;
  }
}

function renderEvent(event) {
  document.title = `${event.tournament} · Platfighters.uy`;

  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const gamesStr = event.games.map(g => g.name).join(' · ');
  const avatarHtml = `<span class="event-header-avatar" aria-hidden="true">${esc((event.tournament || '?').slice(0, 1))}${event.image ? `<img src="${esc(event.image)}" alt="" loading="lazy">` : ''}</span>`;
  const entrantsLabel = isEs
    ? `${event.totalEntrants} participante${event.totalEntrants === 1 ? '' : 's'}`
    : `${event.totalEntrants} entrant${event.totalEntrants === 1 ? '' : 's'}`;

  const headerBarHtml = `
    <section class="panel glass event-header-panel">
      <div class="event-header-top">
        ${avatarHtml}
        <div class="event-header-info">
          <div class="eyebrow mono">${esc(gamesStr || (isEs ? 'PLATFORM FIGHTER' : 'PLATFORM FIGHTER'))}</div>
          <h1>${esc(event.tournament)}</h1>
          <div class="event-header-meta mono muted">
            <span>📅 ${fmt(event.date)}</span>
            <span>👥 ${entrantsLabel}</span>
          </div>
        </div>
        ${event.startggUrl ? `<a class="action-button open-startgg-btn" href="${esc(event.startggUrl)}" target="_blank" rel="noopener noreferrer">${isEs ? 'Abrir en start.gg ↗' : 'Open on start.gg ↗'}</a>` : ''}
      </div>
    </section>
  `;

  const subEventsHtml = event.subEvents && event.subEvents.length
    ? event.subEvents.map(sub => renderBracketCard(sub, event)).join('')
    : '<div class="panel glass empty-state"><p class="muted">No bracket standings available for this tournament.</p></div>';

  const vodsHtml = renderEventVods(event);

  main.innerHTML = `${headerBarHtml}<div class="brackets-grid">${subEventsHtml}</div>${vodsHtml}`;
}

function renderEventVods(event) {
  if (!event.vods || !event.vods.length) return '';

  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const vodsTitle = isEs ? 'Partidas grabadas (VODs)' : 'Tournament Matches (VODs)';
  const watchText = isEs ? 'Ver en YouTube ↗' : 'Watch on YouTube ↗';

  // Group VODs by Phase / Round
  const groups = {};
  for (const vod of event.vods) {
    const groupKey = vod.phase || 'Bracket';
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(vod);
  }

  const groupSections = Object.entries(groups).map(([phaseName, vodList]) => {
    const itemsHtml = vodList.map(vod => {
      const p1Tag = esc(vod.player1?.tag || 'Player 1');
      const p2Tag = esc(vod.player2?.tag || 'Player 2');
      const p1Link = vod.player1?.playerId
        ? `<a class="standing-tag opponent-link" href="player.html?player=${encodeURIComponent(vod.player1.playerId)}">${p1Tag}</a>`
        : `<span class="standing-tag">${p1Tag}</span>`;
      const p2Link = vod.player2?.playerId
        ? `<a class="standing-tag opponent-link" href="player.html?player=${encodeURIComponent(vod.player2.playerId)}">${p2Tag}</a>`
        : `<span class="standing-tag">${p2Tag}</span>`;

      const scoreHtml = vod.displayScore ? `<span class="mono muted" style="font-size:13px; margin:0 6px;">(${esc(vod.displayScore)})</span>` : ' <span class="muted" style="margin:0 4px;">vs</span> ';
      const roundLabel = vod.round ? `<span class="mono muted" style="font-size:12px;">${esc(vod.round)}</span>` : '';
      const thumbSrc = esc(vod.thumbnail || 'assets/logo.jpg');

      return `
        <div class="vod-item-card" style="display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 14px; border-radius:12px; background:rgba(255,255,255,0.02); border:1px solid var(--line); flex-wrap:wrap;">
          <div style="display:flex; align-items:center; gap:14px; min-width:240px; flex:1 1 auto;">
            <a href="${esc(vod.url)}" target="_blank" rel="noopener noreferrer" style="flex-shrink:0; display:block; border-radius:6px; overflow:hidden; width:80px; height:45px; background:#000;">
              <img src="${thumbSrc}" alt="" style="width:100%; height:100%; object-fit:cover;" loading="lazy">
            </a>
            <div>
              <div style="font-weight:600; font-size:14px; display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
                ${p1Link} ${scoreHtml} ${p2Link}
              </div>
              <div class="mono muted" style="font-size:12px; margin-top:2px;">
                ${roundLabel}${roundLabel && vod.title ? ' · ' : ''}${esc(vod.title)}
              </div>
            </div>
          </div>
          <div style="flex-shrink:0;">
            <a href="${esc(vod.url)}" target="_blank" rel="noopener noreferrer" class="btn glass pill" style="font-size:12px; padding:6px 12px; text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
              ${watchText}
            </a>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div style="margin-bottom:18px;">
        <h3 class="mono muted" style="font-size:13px; text-transform:uppercase; margin:0 0 8px 4px; letter-spacing:0.5px;">${esc(phaseName)}</h3>
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${itemsHtml}
        </div>
      </div>
    `;
  }).join('');

  return `
    <section class="panel glass" style="margin-top:28px;">
      <div style="margin-bottom:18px;">
        <h2 style="margin:0 0 4px 0;">${esc(vodsTitle)}</h2>
        <p class="mono muted" style="margin:0; font-size:13px;">${event.vods.length} ${isEs ? 'video(s) disponible(s)' : 'video(s) available'}</p>
      </div>
      <div>
        ${groupSections}
      </div>
    </section>
  `;
}

function renderBracketCard(sub, tournament) {
  const standingsHtml = sub.standings && sub.standings.length
    ? sub.standings.map(st => {
        const isTop3 = st.placement <= 3;
        const playerHtml = st.playerId
          ? `<a class="standing-tag opponent-link" href="index.html?player=${encodeURIComponent(st.playerId)}">${esc(st.tag)}</a>`
          : `<span class="standing-tag">${esc(st.tag)}</span>`;

        let stockIconHtml = '<span class="stock-icon stock-placeholder"></span>';
        if (st.character && st.character.stockIcon) {
          const charInitial = esc((st.character.name || '?')[0]);
          const stockIconSrc = esc(st.character.stockIcon.replace(/\.png$/, '.webp'));
          stockIconHtml = `<span class="stock-icon"><span>${charInitial}</span><img src="${stockIconSrc}" alt="${esc(st.character.name)}" title="${esc(st.character.name)}" onload="if(this.previousElementSibling)this.previousElementSibling.remove()" onerror="this.remove()"></span>`;
        }

        return `
          <div class="standing-row">
            <span class="placement-badge p${st.placement} ${isTop3 ? 'top3' : 'muted'} mono">${ord(st.placement)}</span>
            ${stockIconHtml}
            ${playerHtml}
          </div>
        `;
      }).join('')
    : '<p class="muted p-12">No standings recorded.</p>';

  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const entrantsLabel = isEs
    ? `${sub.entrants} participante${sub.entrants === 1 ? '' : 's'}`
    : `${sub.entrants} entrant${sub.entrants === 1 ? '' : 's'}`;

  return `
    <section class="panel glass bracket-card ${sub.isAmateur ? 'amateur-bracket' : 'main-bracket'}">
      <div class="bracket-card-head">
        <h2>${esc(sub.title)}</h2>
        <p class="mono muted">${esc(sub.game)} · ${entrantsLabel}</p>
      </div>
      <div class="standings-list">
        ${standingsHtml}
      </div>
    </section>
  `;
}

if (window.i18n && window.i18n.onChange) {
  window.i18n.onChange(() => {
    loadEvent();
  });
}

loadEvent();
