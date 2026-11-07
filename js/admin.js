const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let currentSlug = '';
let currentPlayerId = '';
let currentProfileSnapshot = '';
let currentProfileObject = null;
let activeEditorMode = 'visual';
let selectedPhoto = null;
let csrfToken = '';
let officialRankingsList = [];
let eventsCache = [];
let eventsIndexMap = new Map();

async function initEventsIndex() {
  try {
    const res = await fetch('data/events-index.json', { cache: 'no-store' });
    if (res.ok) {
      const items = await res.json();
      items.forEach(item => {
        if (item.tournamentSlug && item.tournament) {
          eventsIndexMap.set(item.tournamentSlug.toLowerCase(), item.tournament);
        }
        if (item.url) {
          const norm = item.url.replace(/^https?:\/\/(www\.)?start\.gg\//, '').replace(/\/$/, '').toLowerCase();
          eventsIndexMap.set(norm, item.tournament);
        }
      });
    }
  } catch (e) {
    console.warn('Could not load events index:', e);
  }
}
initEventsIndex();

function syncVisualFromObject(profile) {
  const p = profile?.player || {};
  if ($('#player-tag')) $('#player-tag').value = p.tag || '';
  if ($('#player-sponsor')) $('#player-sponsor').value = p.sponsor || '';
  if ($('#player-city')) $('#player-city').value = p.city || '';
  if ($('#player-country')) $('#player-country').value = p.country || '';
  if ($('#player-location')) $('#player-location').value = p.location || '';
  if ($('#player-startgg')) $('#player-startgg').value = p.startgg || '';
  if ($('#player-aliases')) $('#player-aliases').value = Array.isArray(p.aliases) ? p.aliases.join(', ') : '';
}

function syncObjectFromVisual() {
  if (!currentProfileObject) return;
  if (!currentProfileObject.player) currentProfileObject.player = {};
  const p = currentProfileObject.player;
  if ($('#player-tag')) p.tag = $('#player-tag').value.trim();
  if ($('#player-sponsor')) p.sponsor = $('#player-sponsor').value.trim() || '';
  if ($('#player-city')) p.city = $('#player-city').value.trim() || '';
  if ($('#player-country')) p.country = $('#player-country').value.trim() || '';
  if ($('#player-location')) p.location = $('#player-location').value.trim() || '';
  if ($('#player-startgg')) p.startgg = $('#player-startgg').value.trim() || '';
  if ($('#player-aliases')) {
    const raw = $('#player-aliases').value.trim();
    p.aliases = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  }
}

function setEditorMode(mode) {
  activeEditorMode = mode;
  const isVisual = mode === 'visual';
  const tabVisual = $('#tab-visual');
  const tabRaw = $('#tab-raw');
  const panelVisual = $('#panel-visual');
  const panelRaw = $('#panel-raw');
  if (tabVisual) {
    tabVisual.classList.toggle('active', isVisual);
    tabVisual.setAttribute('aria-selected', isVisual);
  }
  if (tabRaw) {
    tabRaw.classList.toggle('active', !isVisual);
    tabRaw.setAttribute('aria-selected', !isVisual);
  }
  if (panelVisual) panelVisual.hidden = !isVisual;
  if (panelRaw) panelRaw.hidden = isVisual;

  if (isVisual) {
    try {
      currentProfileObject = JSON.parse($('#profile-json').value);
      syncVisualFromObject(currentProfileObject);
    } catch (err) {
      const fileName = currentSlug ? `${currentSlug}.json` : 'profile JSON';
      alert(`The raw JSON for ${fileName} contains syntax errors (${err.message}). Fix them before switching to the structured form.`);
      setEditorMode('raw');
    }
  } else {
    syncObjectFromVisual();
    $('#profile-json').value = JSON.stringify(currentProfileObject, null, 2);
  }
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Admin-Request': '1',
    ...(options.headers || {})
  };
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers
  });
  const payload = await response.json().catch(() => ({}));
  if (payload.csrfToken) {
    csrfToken = payload.csrfToken;
  }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function showEditor(authed) {
  $('#admin-login').hidden = authed;
  $('#admin-editor').hidden = !authed;
  if (authed) {
    setEditorMode('visual');
    loadProfiles();
    loadRankings();
  }
}

async function loadRankings() {
  const tableBody = $('#rankings-table-body');
  if (!tableBody) return;
  const gameFilter = $('#ranking-game-filter')?.value || 'all';
  const searchQuery = $('#ranking-search')?.value.trim() || '';
  const showArchived = $('#ranking-show-archived')?.checked ? '1' : '0';

  try {
    const params = new URLSearchParams();
    if (gameFilter !== 'all') params.set('game', gameFilter);
    if (searchQuery) params.set('search', searchQuery);
    params.set('includeArchived', showArchived);

    const { rankings } = await api(`/api/admin/rankings?${params.toString()}`);
    officialRankingsList = rankings || [];
    renderRankingsTable(officialRankingsList);
  } catch (err) {
    tableBody.innerHTML = `<tr><td colspan="6" style="padding:20px; text-align:center; color:#f87171;">Error loading rankings: ${esc(err.message)}</td></tr>`;
  }
}

function renderRankingsTable(rankings) {
  const tableBody = $('#rankings-table-body');
  if (!tableBody) return;
  if (!rankings.length) {
    tableBody.innerHTML = '<tr><td colspan="6" style="padding:20px; text-align:center;" class="muted">No official rankings match the current filters.</td></tr>';
    return;
  }

  tableBody.innerHTML = rankings.map(r => {
    const isArchived = r.isArchived;
    const statusLabel = (r.status === 'yearly') ? 'Yearly' : 'Seasonal';
    const periodStr = (r.periodStart && r.periodEnd) ? `${r.periodStart} → ${r.periodEnd}` : '—';
    const archiveBadge = isArchived ? '<span style="font-size:11px; padding:2px 6px; border-radius:4px; background:rgba(239,68,68,0.2); color:#fca5a5; margin-left:6px;">ARCHIVED</span>' : '';

    return `
      <tr style="border-bottom:1px solid var(--line); opacity: ${isArchived ? '0.6' : '1'};">
        <td style="padding:10px 14px; font-weight:600;">
          ${esc(r.title)}
          ${archiveBadge}
        </td>
        <td style="padding:10px 14px;">${esc(r.gameSlug || r.gameId)}</td>
        <td style="padding:10px 14px;"><span class="tagpill" style="font-size:11px;">${statusLabel}</span></td>
        <td style="padding:10px 14px; font-size:13px;" class="muted">${esc(periodStr)}</td>
        <td style="padding:10px 14px; text-align:center; font-family:var(--font-mono, monospace);">${r.playerCount}</td>
        <td style="padding:10px 14px; text-align:right; white-space:nowrap;">
          <a href="ranking-creator.html?id=${encodeURIComponent(r.id)}&mode=admin" class="btn glass pill" style="padding:4px 10px; font-size:12px; text-decoration:none; margin-right:6px;">Edit</a>
          ${isArchived
            ? `<button type="button" class="btn glass pill" data-unarchive-ranking="${esc(r.id)}" style="padding:4px 10px; font-size:12px; color:#38bdf8;">Unarchive</button>`
            : `<button type="button" class="btn glass pill" data-archive-ranking="${esc(r.id)}" style="padding:4px 10px; font-size:12px; color:#f87171;">Archive</button>`
          }
        </td>
      </tr>
    `;
  }).join('');
}

async function loadProfiles(selected = '') {
  try {
    const [{ profiles }, { merges }, { eventGroups }, { exclusions }, { events }, { socials }, { games }] = await Promise.all([
      api('/api/admin/profiles'), api('/api/admin/merges'), api('/api/admin/event-groups'), api('/api/admin/exclusions'), api('/api/admin/events').catch(() => ({ events: [] })),
      api('/api/admin/community-socials').catch(() => ({ socials: {} })),
      api('/api/games').catch(() => ({ games: [] }))
    ]);
    eventsCache = events || [];
    renderEventGroups(eventGroups);
    renderExcludedEvents(exclusions.events || []);
    renderEventSelects(events || []);
    renderCommunitySocials(socials || {});
    renderGameFilter(games || []);
    const select = $('#profile-select');
    select.innerHTML = profiles.map(p => `<option value="${esc(p.slug)}" data-player-id="${esc(p.playerId || '')}">${esc(p.tag)} · ${esc(p.playerId || 'local profile')}</option>`).join('');
    const source = $('#merge-source');
    const target = $('#merge-target');
    const options = profiles.filter(p => p.playerId).map(p => {
      const eventCount = p.events ?? (p.games || []).reduce((sum, g) => sum + (g.events || 0), 0);
      const eventLabel = `${eventCount} event${eventCount === 1 ? '' : 's'}`;
      return `<option value="${esc(p.playerId)}">${esc(p.tag)} · ID: ${esc(p.playerId)} (${esc(eventLabel)})</option>`;
    }).join('');
    source.innerHTML = options;
    target.innerHTML = options;
    if (source.options.length > 1) source.selectedIndex = 1;
    if (target.options.length) target.selectedIndex = 0;
    if (Object.keys(merges).length) {
      $('#merge-message').textContent = `${Object.keys(merges).length} merged identity${Object.keys(merges).length === 1 ? '' : 'ies'} saved.`;
    }
    if (!profiles.length) throw new Error('No player profiles are available to edit yet. Generate profiles from the imported SQLite data first.');
    select.value = selected || profiles[0].slug;
    await loadProfile(select.value);
  } catch (error) { $('#save-message').textContent = error.message; }
}

function renderGameFilter(games = []) {
  const gameFilter = $('#ranking-game-filter');
  if (!gameFilter) return;
  const currentVal = gameFilter.value;
  gameFilter.innerHTML = '<option value="all">All games</option>' +
    games.map(g => `<option value="${esc(g.slug)}">${esc(g.name)}</option>`).join('');
  if (currentVal) gameFilter.value = currentVal;
}

function renderEventSelects(events = []) {
  const parentSelect = $('#event-parent-url');
  const childSelect = $('#event-child-url');
  if (!parentSelect || !childSelect) return;
  if (events.length) {
    const options = '<option value="" disabled selected>Select an event…</option>' +
      events.map(e => `<option value="${esc(e.sourceUrl)}">${esc(e.tournamentName)} · ${esc(e.eventName)} (${esc(e.gameName)})</option>`).join('');
    parentSelect.innerHTML = options;
    childSelect.innerHTML = options;
  } else {
    const empty = '<option value="" disabled selected>No imported events available</option>';
    parentSelect.innerHTML = empty;
    childSelect.innerHTML = empty;
  }
}

function getTournamentNameForEventKey(eventKey) {
  if (!eventKey) return '';
  const normKey = String(eventKey).replace(/^https?:\/\/(www\.)?start\.gg\//, '').replace(/\/$/, '').toLowerCase();

  // 1. Check in eventsCache (from /api/admin/events)
  if (eventsCache && eventsCache.length) {
    const found = eventsCache.find(e => {
      const eNorm = String(e.sourceUrl || '').replace(/^https?:\/\/(www\.)?start\.gg\//, '').replace(/\/$/, '').toLowerCase();
      return eNorm === normKey;
    });
    if (found && found.tournamentName) return found.tournamentName;
  }

  // 2. Check in eventsIndexMap
  if (eventsIndexMap.has(normKey)) {
    return eventsIndexMap.get(normKey);
  }

  // 3. Extract tournament slug from key (tournament/<slug>/...)
  const parts = normKey.split('/');
  if (parts.length >= 2 && parts[0] === 'tournament') {
    const tSlug = parts[1];
    if (eventsIndexMap.has(tSlug)) {
      return eventsIndexMap.get(tSlug);
    }
  }

  return '';
}

function renderEventGroups(groups = {}) {
  const list = $('#event-group-list');
  const entries = Object.entries(groups);
  if (!entries.length) {
    list.innerHTML = '<p class="muted event-group-empty">No additional events have been grouped yet.</p>';
    return;
  }
  list.innerHTML = entries.map(([child, group]) => {
    // When displaying event groupings, show the tournament name instead of the Amateur Bracket name
    const childTourney = group.childTournament || getTournamentNameForEventKey(child);
    const parentTourney = group.parentTournament || getTournamentNameForEventKey(group.parent);

    // Primary display heading: tournament name (falling back to parentTourney or phase)
    const displayName = childTourney || parentTourney || group.phase;
    const subtitle = (childTourney && parentTourney && childTourney !== parentTourney)
      ? `${esc(childTourney)} → ${esc(parentTourney)}`
      : `${esc(child)} → ${esc(group.parent)}`;

    return `<div class="event-group-item"><span><b>${esc(displayName)}</b><small>${subtitle} · ${esc(group.phase)}</small></span><button class="quiet-button" type="button" data-remove-event-group="${esc(child)}">Remove</button></div>`;
  }).join('');
}

function renderExcludedEvents(events = []) {
  const list = $('#event-exclusion-list');
  if (!events.length) {
    list.innerHTML = '<p class="muted event-group-empty">No events are currently excluded.</p>';
    return;
  }
  list.innerHTML = events.map(key =>
    `<label class="event-exclusion-item"><input type="checkbox" data-event-exclusion="${esc(key)}" checked><span><b>Excluded from all views</b><small>${esc(key)}</small></span></label>`
  ).join('');
}

async function loadPlayerGameOptions(playerId) {
  const { games, excluded } = await api(`/api/admin/player-games?playerId=${encodeURIComponent(playerId)}`);
  const excludedSet = new Set(excluded || []);
  $('#player-game-options').innerHTML = games.length ? games.map(game =>
    `<label class="check-row"><input type="checkbox" data-player-game="${esc(game.id)}" ${excludedSet.has(game.id) ? 'checked' : ''}><span>Exclude from ${esc(game.name)}</span></label>`
  ).join('') : '<p class="muted">No game entries are available for this player.</p>';
  $('#game-exclusion-message').textContent = '';
}

async function loadProfile(slug) {
  currentSlug = slug;
  selectedPhoto = null;
  $('#profile-photo-file').value = '';
  $('#photo-preview').hidden = true;
  const { profile } = await api(`/api/admin/profile?slug=${encodeURIComponent(slug)}`);
  currentProfileObject = profile;
  currentPlayerId = String(profile.player?.startggPlayerId || '');
  syncVisualFromObject(profile);
  $('#profile-json').value = JSON.stringify(profile, null, 2);
  currentProfileSnapshot = $('#profile-json').value;
  await loadPlayerGameOptions(currentPlayerId);
  $('#photo-name').textContent = profile.player?.photo || 'PNG, JPEG or WebP · up to 5 MB';
  $('#save-message').textContent = '';

  const publicLink = $('#view-public-profile-btn');
  if (publicLink) {
    const targetParam = currentPlayerId || currentSlug;
    publicLink.href = `player.html?player=${encodeURIComponent(targetParam)}`;
  }
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('#login-message');
  message.textContent = 'Signing in…';
  try {
    const res = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('#admin-password').value }) });
    if (res.csrfToken) csrfToken = res.csrfToken;
    $('#admin-password').value = '';
    message.textContent = '';
    showEditor(true);
  } catch (error) { message.textContent = error.message; }
});

$('#ranking-game-filter')?.addEventListener('change', () => loadRankings());
$('#ranking-search')?.addEventListener('input', () => loadRankings());
$('#ranking-show-archived')?.addEventListener('change', () => loadRankings());

$('#rankings-table-body')?.addEventListener('click', async event => {
  const archiveBtn = event.target.closest('[data-archive-ranking]');
  const unarchiveBtn = event.target.closest('[data-unarchive-ranking]');
  const message = $('#ranking-admin-message');

  if (archiveBtn) {
    const rid = archiveBtn.dataset.archiveRanking;
    if (!confirm(`Are you sure you want to archive official ranking "${rid}"? It will be hidden from the public website.`)) return;
    if (message) message.textContent = 'Archiving ranking…';
    try {
      await api(`/api/admin/rankings/${encodeURIComponent(rid)}`, { method: 'DELETE' });
      if (message) message.textContent = `Ranking "${rid}" archived successfully.`;
      loadRankings();
    } catch (err) {
      if (message) message.textContent = `Failed to archive: ${err.message}`;
    }
    return;
  }

  if (unarchiveBtn) {
    const rid = unarchiveBtn.dataset.unarchiveRanking;
    if (!confirm(`Unarchive official ranking "${rid}" and restore it to the public website?`)) return;
    if (message) message.textContent = 'Restoring ranking…';
    try {
      await api(`/api/admin/rankings/${encodeURIComponent(rid)}`, {
        method: 'PUT',
        body: JSON.stringify({ action: 'unarchive' })
      });
      if (message) message.textContent = `Ranking "${rid}" restored successfully.`;
      loadRankings();
    } catch (err) {
      if (message) message.textContent = `Failed to restore: ${err.message}`;
    }
    return;
  }
});

$('#merge-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('#merge-message');
  const sourceId = $('#merge-source').value;
  const targetId = $('#merge-target').value;
  if (!sourceId || !targetId || sourceId === targetId) {
    message.textContent = 'Choose two different profiles.';
    return;
  }
  const sourceName = $('#merge-source').selectedOptions[0].textContent;
  const targetName = $('#merge-target').selectedOptions[0].textContent;
  if (!confirm(`Merge ${sourceName} into ${targetName}? The retained profile ID will be ${targetId}.`)) return;
  message.textContent = 'Checking for overlaps and merging…';
  try {
    let res = await api('/api/admin/merge', { method: 'POST', body: JSON.stringify({ sourceId, targetId }) });
    if (res && res.warning && res.overlaps && res.overlaps.length > 0) {
      const overlapDetails = res.overlaps.map(o => {
        const dateStr = o.startAt ? new Date(o.startAt * 1000).toLocaleDateString() : 'Unknown date';
        const game = o.gameSlug || 'Unknown game';
        return `• ${o.tournamentName || 'Tournament'} - ${o.eventName || 'Event'} (${game}, ${dateStr})`;
      }).join('\n');
      const confirmed = confirm(
        `Warning: These profiles share tournament participation in ${res.overlaps.length} event(s):\n\n${overlapDetails}\n\nDo you want to proceed with merging them?`
      );
      if (!confirmed) {
        message.textContent = 'Merge cancelled.';
        return;
      }
      message.textContent = 'Merging and rebuilding profiles…';
      res = await api('/api/admin/merge', { method: 'POST', body: JSON.stringify({ sourceId, targetId, confirmed: true }) });
    }
    message.textContent = `Merged ${sourceName} into ${targetName}.`;
    await loadProfiles();
  } catch (error) { message.textContent = error.message; }
});

$('#event-group-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('#event-group-message');
  message.textContent = 'Saving and rebuilding profiles…';
  try {
    await api('/api/admin/event-group', { method: 'POST', body: JSON.stringify({
      parent: $('#event-parent-url').value,
      child: $('#event-child-url').value,
      phase: $('#event-phase-label').value
    }) });
    message.textContent = 'Event grouping saved. Imported player profiles have been refreshed.';
    const { eventGroups } = await api('/api/admin/event-groups');
    renderEventGroups(eventGroups);
  } catch (error) { message.textContent = error.message; }
});

$('#event-group-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-remove-event-group]');
  if (!button) return;
  const message = $('#event-group-message');
  message.textContent = 'Removing grouping and rebuilding profiles…';
  try {
    await api('/api/admin/event-group', { method: 'POST', body: JSON.stringify({
      action: 'remove', child: button.dataset.removeEventGroup
    }) });
    message.textContent = 'Event grouping removed.';
    const { eventGroups } = await api('/api/admin/event-groups');
    renderEventGroups(eventGroups);
  } catch (error) { message.textContent = error.message; }
});

$('#event-exclusion-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('#event-exclusion-message');
  message.textContent = 'Saving and rebuilding profiles…';
  try {
    const { exclusions } = await api('/api/admin/exclusions', { method: 'POST', body: JSON.stringify({
      kind: 'event', eventUrl: $('#event-exclusion-url').value,
      excluded: $('#event-excluded').checked
    }) });
    renderExcludedEvents(exclusions.events || []);
    message.textContent = $('#event-excluded').checked
      ? 'Event excluded from all views.' : 'Event restored to all views.';
  } catch (error) { message.textContent = error.message; }
});

$('#event-exclusion-list').addEventListener('change', async event => {
  const checkbox = event.target.closest('[data-event-exclusion]');
  if (!checkbox) return;
  const message = $('#event-exclusion-message');
  message.textContent = 'Updating event visibility and rebuilding profiles…';
  try {
    const { exclusions } = await api('/api/admin/exclusions', { method: 'POST', body: JSON.stringify({
      kind: 'event', eventUrl: checkbox.dataset.eventExclusion, excluded: checkbox.checked
    }) });
    renderExcludedEvents(exclusions.events || []);
    message.textContent = checkbox.checked ? 'Event excluded from all views.' : 'Event restored to all views.';
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    message.textContent = error.message;
  }
});

$('#save-game-exclusions').addEventListener('click', async () => {
  const message = $('#game-exclusion-message');
  if ($('#profile-json').value !== currentProfileSnapshot &&
      !confirm('The profile JSON has unsaved edits. Rebuilding game visibility will reload the saved profile and discard those edits. Continue?')) return;
  message.textContent = 'Saving game visibility and rebuilding profiles…';
  const excludedGames = [...$('#player-game-options').querySelectorAll('[data-player-game]:checked')]
    .map(input => input.dataset.playerGame);
  try {
    await api('/api/admin/exclusions', { method: 'POST', body: JSON.stringify({
      kind: 'player-games', playerId: currentPlayerId, excludedGames
    }) });
    await loadProfile(currentSlug);
    message.textContent = 'Game visibility saved. Profile data has been refreshed.';
  } catch (error) { message.textContent = error.message; }
});

$('#profile-select').addEventListener('change', event => loadProfile(event.target.value).catch(error => { $('#save-message').textContent = error.message; }));
$('#profile-photo-file').addEventListener('change', event => {
  const file = event.target.files[0];
  selectedPhoto = file || null;
  if (!file) return;
  if (file.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    $('#save-message').textContent = 'Choose a PNG, JPEG or WebP image up to 5 MB.';
    event.target.value = '';
    selectedPhoto = null;
    return;
  }
  $('#photo-name').textContent = file.name;
  const preview = $('#photo-preview');
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
});

$('#tab-visual')?.addEventListener('click', () => setEditorMode('visual'));
$('#tab-raw')?.addEventListener('click', () => setEditorMode('raw'));

function setAdminSubsection(sub) {
  const sections = ['players', 'events', 'rankings'];
  sections.forEach(s => {
    const tabBtn = $(`#subtab-${s}`);
    const secEl = $(`#admin-section-${s}`);
    const isCurrent = s === sub;
    if (tabBtn) {
      tabBtn.classList.toggle('active', isCurrent);
      tabBtn.setAttribute('aria-selected', isCurrent);
    }
    if (secEl) {
      secEl.hidden = !isCurrent;
    }
  });
}

document.querySelectorAll('.admin-section-nav button[data-admin-sub]').forEach(btn => {
  btn.addEventListener('click', () => {
    setAdminSubsection(btn.dataset.adminSub);
  });
});

$('#profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('#save-message');
  message.textContent = 'Saving…';
  try {
    let profile;
    if (activeEditorMode === 'visual') {
      syncObjectFromVisual();
      profile = currentProfileObject;
      $('#profile-json').value = JSON.stringify(profile, null, 2);
    } else {
      const fileName = currentSlug ? `${currentSlug}.json` : 'profile JSON';
      try { profile = JSON.parse($('#profile-json').value); }
      catch (err) { throw new Error(`Profile data for ${fileName} must be valid JSON: ${err.message}`); }
      currentProfileObject = profile;
      syncVisualFromObject(profile);
    }
    const profileFileName = currentSlug ? `${currentSlug}.json` : 'profile JSON';
    if (!profile || typeof profile !== 'object' || !profile.player || !Array.isArray(profile.games)) {
      throw new Error(`Profile JSON in ${profileFileName} must contain a player object and a games array.`);
    }
    if (String(profile.player.startggPlayerId || '') !== currentPlayerId) {
      throw new Error('The start.gg player ID is the profile’s fixed source of truth and cannot be changed here.');
    }
    if (selectedPhoto) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the selected picture.'));
        reader.readAsDataURL(selectedPhoto);
      });
      const photo = await api('/api/admin/photo', { method: 'POST', body: JSON.stringify({ playerId: currentPlayerId, filename: selectedPhoto.name, data: dataUrl }) });
      profile.player.photo = photo.path;
      currentProfileObject = profile;
      $('#profile-json').value = JSON.stringify(profile, null, 2);
      syncVisualFromObject(profile);
    }
    await api('/api/admin/profile', { method: 'PUT', body: JSON.stringify({ slug: currentSlug, profile }) });
    message.textContent = 'Saved. The player page now reflects the complete profile data.';
    selectedPhoto = null;
    await loadProfiles(currentSlug);
  } catch (error) { message.textContent = error.message; }
});

const COMMUNITY_GAMES = [
  { slug: 'ultimate', name: 'Super Smash Bros. Ultimate' },
  { slug: 'melee', name: 'Super Smash Bros. Melee' },
  { slug: 'project-plus', name: 'Project+' },
  { slug: 'rivals-2', name: 'Rivals 2' },
  { slug: 'rivals-of-aether', name: 'Rivals of Aether' }
];

function renderCommunitySocials(socials = {}) {
  const container = $('#community-socials-fields');
  if (!container) return;

  container.innerHTML = COMMUNITY_GAMES.map(g => {
    const gSocial = socials[g.slug] || {};
    const wa = gSocial.whatsapp || { enabled: false, url: '' };
    const dc = gSocial.discord || { enabled: false, url: '' };
    const ig = gSocial.instagram || gSocial.twitter || { enabled: false, url: '' };

    return `
      <div style="margin-bottom:20px;padding:16px;background:rgba(255,255,255,0.04);border-radius:12px;border:1px solid var(--line);">
        <h4 style="margin:0 0 12px 0;">${esc(g.name)}</h4>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="width:100px;font-weight:500;">WhatsApp</span>
            <input type="url" id="soc-${g.slug}-wa-url" placeholder="https://chat.whatsapp.com/..." value="${esc(wa.url || '')}" style="flex:1;">
          </div>
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="width:100px;font-weight:500;">Discord</span>
            <input type="url" id="soc-${g.slug}-dc-url" placeholder="https://discord.gg/..." value="${esc(dc.url || '')}" style="flex:1;">
          </div>
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="width:100px;font-weight:500;">Instagram</span>
            <input type="url" id="soc-${g.slug}-ig-url" placeholder="https://instagram.com/..." value="${esc(ig.url || '')}" style="flex:1;">
          </div>
        </div>
      </div>
    `;
  }).join('');
}

$('#community-socials-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('#socials-message');
  message.textContent = 'Saving…';
  try {
    const socials = {};
    COMMUNITY_GAMES.forEach(g => {
      const waUrl = $(`#soc-${g.slug}-wa-url`).value.trim();
      const dcUrl = $(`#soc-${g.slug}-dc-url`).value.trim();
      const igUrl = $(`#soc-${g.slug}-ig-url`).value.trim();

      socials[g.slug] = {
        whatsapp: {
          enabled: Boolean(waUrl),
          url: waUrl
        },
        discord: {
          enabled: Boolean(dcUrl),
          url: dcUrl
        },
        instagram: {
          enabled: Boolean(igUrl),
          url: igUrl
        }
      };
    });

    await api('/api/admin/community-socials', {
      method: 'POST',
      body: JSON.stringify({ socials })
    });
    message.textContent = 'Saved community social links.';
  } catch (err) {
    message.textContent = err.message || 'Error saving socials.';
  }
});

$('#signout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } finally { showEditor(false); }
});

api('/api/admin/session').then(res => {
  if (res.csrfToken) csrfToken = res.csrfToken;
  showEditor(res.authenticated);
}).catch(() => showEditor(false));
