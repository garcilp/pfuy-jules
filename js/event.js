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

  const gamesStr = event.games.map(g => g.name).join(' · ');
  const avatarHtml = `<span class="event-header-avatar" aria-hidden="true">${esc((event.tournament || '?').slice(0, 1))}${event.image ? `<img src="${esc(event.image)}" alt="" loading="lazy">` : ''}</span>`;

  const headerBarHtml = `
    <section class="panel glass event-header-panel">
      <div class="event-header-top">
        ${avatarHtml}
        <div class="event-header-info">
          <div class="eyebrow mono">${esc(gamesStr || 'PLATFORM FIGHTER')}</div>
          <h1>${esc(event.tournament)}</h1>
          <div class="event-header-meta mono muted">
            <span>📅 ${fmt(event.date)}</span>
            <span>👥 ${event.totalEntrants} entrant${event.totalEntrants === 1 ? '' : 's'}</span>
          </div>
        </div>
        ${event.startggUrl ? `<a class="action-button open-startgg-btn" href="${esc(event.startggUrl)}" target="_blank" rel="noopener noreferrer">Open on start.gg ↗</a>` : ''}
      </div>
    </section>
  `;

  const subEventsHtml = event.subEvents && event.subEvents.length
    ? event.subEvents.map(sub => renderBracketCard(sub, event)).join('')
    : '<div class="panel glass empty-state"><p class="muted">No bracket standings available for this tournament.</p></div>';

  main.innerHTML = `${headerBarHtml}<div class="brackets-grid">${subEventsHtml}</div>`;
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

  return `
    <section class="panel glass bracket-card ${sub.isAmateur ? 'amateur-bracket' : 'main-bracket'}">
      <div class="bracket-card-head">
        <h2>${esc(sub.title)}</h2>
        <p class="mono muted">${esc(sub.game)} · ${sub.entrants} entrant${sub.entrants === 1 ? '' : 's'}</p>
      </div>
      <div class="standings-list">
        ${standingsHtml}
      </div>
    </section>
  `;
}

loadEvent();
