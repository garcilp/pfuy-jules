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
    const bulkSource = $('#bulk-player-source');
    const bulkTarget = $('#bulk-player-target');
    if (bulkSource && bulkTarget) {
      bulkSource.innerHTML = options;
      bulkTarget.innerHTML = options;
      if (bulkSource.options.length > 1) bulkSource.selectedIndex = 1;
      if (bulkTarget.options.length) bulkTarget.selectedIndex = 0;
    }

    const bulkExcludeSelect = $('#bulk-exclude-player');
    if (bulkExcludeSelect) {
      const excludeOptions = profiles.filter(p => p.playerId).map(p => {
        const eventCount = p.events ?? (p.games || []).reduce((sum, g) => sum + (g.events || 0), 0);
        const eventLabel = `${eventCount} event${eventCount === 1 ? '' : 's'}`;
        const country = (p.country && String(p.country).trim()) ? String(p.country).trim() : 'Uruguay';
        return `<option value="${esc(p.playerId)}">${esc(p.tag)} · ${esc(eventLabel)} · ${esc(country)} (ID: ${esc(p.playerId)})</option>`;
      }).join('');
      bulkExcludeSelect.innerHTML = excludeOptions;
      if (bulkExcludeSelect.options.length) bulkExcludeSelect.selectedIndex = 0;
    }
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
  const bulkSourceSelect = $('#bulk-event-source');
  const bulkTargetSelect = $('#bulk-event-target');
  const vodEventSelect = $('#vod-event-select');

  if (events.length) {
    const options = '<option value="" disabled selected>Select an event…</option>' +
      events.map(e => `<option value="${esc(e.sourceUrl)}">${esc(e.tournamentName)} · ${esc(e.eventName)} (${esc(e.gameName)})</option>`).join('');
    if (parentSelect) parentSelect.innerHTML = options;
    if (childSelect) childSelect.innerHTML = options;
    if (bulkSourceSelect) bulkSourceSelect.innerHTML = options;
    if (bulkTargetSelect) bulkTargetSelect.innerHTML = options;

    if (vodEventSelect) {
      const prevVal = vodEventSelect.value;
      const vodOptions = '<option value="" disabled selected>Select an event…</option>' +
        events.map(e => `<option value="${esc(e.id)}" data-vod-url="${esc(e.vodPlaylistUrl || '')}" data-vod-count="${e.vodCount || 0}">${esc(e.tournamentName)} · ${esc(e.eventName)} (${esc(e.gameName)})</option>`).join('');
      vodEventSelect.innerHTML = vodOptions;
      if (prevVal && events.some(e => String(e.id) === String(prevVal))) {
        vodEventSelect.value = prevVal;
      }
      updateVodFormState();
    }
  } else {
    const empty = '<option value="" disabled selected>No imported events available</option>';
    if (parentSelect) parentSelect.innerHTML = empty;
    if (childSelect) childSelect.innerHTML = empty;
    if (bulkSourceSelect) bulkSourceSelect.innerHTML = empty;
    if (bulkTargetSelect) bulkTargetSelect.innerHTML = empty;
    if (vodEventSelect) vodEventSelect.innerHTML = empty;
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

// BULK PLAYER MERGING
let bulkPlayerQueue = [];
let editingPlayerIndex = -1;

function renderBulkPlayerQueue() {
  const list = $('#bulk-player-queue-list');
  const countEl = $('#bulk-player-queue-count');
  const clearBtn = $('#bulk-player-clear-btn');
  const executeBtn = $('#bulk-player-execute-btn');
  if (!list) return;

  if (countEl) countEl.textContent = `Queued operations (${bulkPlayerQueue.length})`;

  if (!bulkPlayerQueue.length) {
    list.innerHTML = '<p class="muted event-group-empty">No player merges currently queued.</p>';
    if (clearBtn) clearBtn.style.display = 'none';
    if (executeBtn) {
      executeBtn.disabled = true;
      executeBtn.textContent = 'Execute Batch';
    }
    return;
  }

  if (clearBtn) clearBtn.style.display = 'inline-block';
  if (executeBtn) {
    executeBtn.disabled = false;
    executeBtn.textContent = `Execute Batch (${bulkPlayerQueue.length})`;
  }

  list.innerHTML = bulkPlayerQueue.map((item, idx) => `
    <div class="event-group-item" style="${item.error ? 'border-color: rgba(239, 68, 68, 0.5); background: rgba(239, 68, 68, 0.05);' : ''}">
      <span>
        <b>${esc(item.sourceLabel)} → ${esc(item.targetLabel)}</b>
        <small>FROM: ${esc(item.sourceId)} → TO: ${esc(item.targetId)}</small>
        ${item.error ? `<small style="color:#f87171; margin-top:4px; font-weight:600;">⚠ ${esc(item.error)}</small>` : ''}
      </span>
      <div style="display:flex; gap:8px; align-items:center; flex-shrink:0;">
        <button class="quiet-button" type="button" data-edit-bulk-player="${idx}">Edit</button>
        <button class="quiet-button" type="button" data-remove-bulk-player="${idx}" style="color:#f87171;">Remove</button>
      </div>
    </div>
  `).join('');
}

function resetBulkPlayerEditMode() {
  editingPlayerIndex = -1;
  const queueBtn = $('#bulk-player-queue-btn');
  const cancelBtn = $('#bulk-player-cancel-edit-btn');
  const msg = $('#bulk-player-form-message');
  if (queueBtn) queueBtn.textContent = '+ Queue Merge';
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (msg) msg.textContent = '';
}

$('#bulk-player-form')?.addEventListener('submit', event => {
  event.preventDefault();
  const sourceSelect = $('#bulk-player-source');
  const targetSelect = $('#bulk-player-target');
  const msg = $('#bulk-player-form-message');
  const sourceId = sourceSelect.value;
  const targetId = targetSelect.value;

  if (!sourceId || !targetId || sourceId === targetId) {
    if (msg) msg.textContent = 'Choose two different player profiles.';
    return;
  }

  const duplicateSource = bulkPlayerQueue.some((item, i) =>
    (editingPlayerIndex === -1 || i !== editingPlayerIndex) && item.sourceId === sourceId
  );
  if (duplicateSource) {
    if (msg) msg.textContent = 'This player is already queued as a source merge.';
    return;
  }

  const createsLoop = bulkPlayerQueue.some((item, i) =>
    (editingPlayerIndex === -1 || i !== editingPlayerIndex) && item.sourceId === targetId && item.targetId === sourceId
  );
  if (createsLoop) {
    if (msg) msg.textContent = 'This operation would create an identity loop with another queued merge.';
    return;
  }

  const sourceLabel = sourceSelect.selectedOptions[0]?.textContent || sourceId;
  const targetLabel = targetSelect.selectedOptions[0]?.textContent || targetId;

  if (editingPlayerIndex >= 0) {
    bulkPlayerQueue[editingPlayerIndex] = {
      ...bulkPlayerQueue[editingPlayerIndex],
      sourceId,
      targetId,
      sourceLabel,
      targetLabel,
      error: undefined
    };
    resetBulkPlayerEditMode();
  } else {
    bulkPlayerQueue.push({
      id: Date.now() + Math.random(),
      sourceId,
      targetId,
      sourceLabel,
      targetLabel
    });
    if (msg) msg.textContent = '';
  }

  renderBulkPlayerQueue();
});

$('#bulk-player-cancel-edit-btn')?.addEventListener('click', () => {
  resetBulkPlayerEditMode();
});

$('#bulk-player-clear-btn')?.addEventListener('click', () => {
  if (!confirm('Clear all queued player merge operations?')) return;
  bulkPlayerQueue = [];
  resetBulkPlayerEditMode();
  renderBulkPlayerQueue();
  $('#bulk-player-message').textContent = 'Queue cleared.';
});

$('#bulk-player-queue-list')?.addEventListener('click', event => {
  const editBtn = event.target.closest('[data-edit-bulk-player]');
  const removeBtn = event.target.closest('[data-remove-bulk-player]');

  if (editBtn) {
    const idx = parseInt(editBtn.dataset.editBulkPlayer, 10);
    const item = bulkPlayerQueue[idx];
    if (!item) return;

    editingPlayerIndex = idx;
    const sourceSelect = $('#bulk-player-source');
    const targetSelect = $('#bulk-player-target');
    if (sourceSelect) sourceSelect.value = item.sourceId;
    if (targetSelect) targetSelect.value = item.targetId;

    const queueBtn = $('#bulk-player-queue-btn');
    const cancelBtn = $('#bulk-player-cancel-edit-btn');
    if (queueBtn) queueBtn.textContent = 'Save Changes';
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
    $('#bulk-player-form-message').textContent = `Editing queued merge #${idx + 1}`;
    sourceSelect?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  if (removeBtn) {
    const idx = parseInt(removeBtn.dataset.removeBulkPlayer, 10);
    if (editingPlayerIndex === idx) {
      resetBulkPlayerEditMode();
    } else if (editingPlayerIndex > idx) {
      editingPlayerIndex--;
    }
    bulkPlayerQueue.splice(idx, 1);
    renderBulkPlayerQueue();
    return;
  }
});

$('#bulk-player-execute-btn')?.addEventListener('click', async () => {
  if (!bulkPlayerQueue.length) return;
  const message = $('#bulk-player-message');
  if (!confirm(`Execute batch merge of ${bulkPlayerQueue.length} player operation(s)? Profiles and rankings will be rebuilt once.`)) return;

  message.textContent = 'Checking for overlaps and preparing batch execution…';
  const executeBtn = $('#bulk-player-execute-btn');
  if (executeBtn) executeBtn.disabled = true;

  try {
    const operations = bulkPlayerQueue.map(item => ({ sourceId: item.sourceId, targetId: item.targetId }));
    let res = await api('/api/admin/bulk-merge-players', { method: 'POST', body: JSON.stringify({ operations }) });

    if (res && res.warning && res.overlaps && res.overlaps.length > 0) {
      const overlapDetails = res.overlaps.map(o => {
        const eventsList = o.overlaps.map(ev => {
          const dateStr = ev.startAt ? new Date(ev.startAt * 1000).toLocaleDateString() : 'Unknown date';
          return `  • ${ev.tournamentName || 'Tournament'} - ${ev.eventName || 'Event'} (${ev.gameSlug || 'game'}, ${dateStr})`;
        }).join('\n');
        return `Operation ${o.sourceId} → ${o.targetId}:\n${eventsList}`;
      }).join('\n\n');

      const confirmed = confirm(
        `Warning: Shared tournament event participation was found in ${res.overlaps.length} operation(s):\n\n${overlapDetails}\n\nDo you want to proceed with executing the batch merge?`
      );
      if (!confirmed) {
        message.textContent = 'Batch execution cancelled.';
        if (executeBtn) executeBtn.disabled = false;
        return;
      }
      message.textContent = 'Executing batch merge and rebuilding profiles…';
      res = await api('/api/admin/bulk-merge-players', { method: 'POST', body: JSON.stringify({ operations, confirmed: true }) });
    }

    const completed = res.completed || [];
    const failed = res.failed || [];
    const completedSources = new Set(completed.map(c => c.sourceId || c.operation?.sourceId || c.operation?.from));

    bulkPlayerQueue = bulkPlayerQueue.filter(item => !completedSources.has(item.sourceId));

    if (failed.length > 0) {
      const errorMap = new Map();
      failed.forEach(f => {
        const src = f.operation?.sourceId || f.operation?.from;
        if (src) errorMap.set(src, f.error || 'Operation failed');
      });
      bulkPlayerQueue.forEach(item => {
        if (errorMap.has(item.sourceId)) {
          item.error = errorMap.get(item.sourceId);
        }
      });
      message.textContent = `Batch executed with issues: ${completed.length} completed, ${failed.length} failed. See queue below.`;
    } else {
      message.textContent = `Batch executed successfully: ${completed.length} player merge(s) completed.`;
    }

    resetBulkPlayerEditMode();
    renderBulkPlayerQueue();
    await loadProfiles();
  } catch (err) {
    message.textContent = `Batch execution failed: ${err.message}`;
    if (executeBtn) executeBtn.disabled = false;
  }
});

// BULK PLAYER EXCLUSION
let bulkExcludeQueue = [];
let editingExcludeIndex = -1;

function renderBulkExcludeQueue() {
  const list = $('#bulk-exclude-queue-list');
  const countEl = $('#bulk-exclude-queue-count');
  const clearBtn = $('#bulk-exclude-clear-btn');
  const executeBtn = $('#bulk-exclude-execute-btn');
  if (!list) return;

  if (countEl) countEl.textContent = `Queued exclusions (${bulkExcludeQueue.length})`;

  if (!bulkExcludeQueue.length) {
    list.innerHTML = '<p class="muted event-group-empty">No player exclusions currently queued.</p>';
    if (clearBtn) clearBtn.style.display = 'none';
    if (executeBtn) {
      executeBtn.disabled = true;
      executeBtn.textContent = 'Execute Batch';
    }
    return;
  }

  if (clearBtn) clearBtn.style.display = 'inline-block';
  if (executeBtn) {
    executeBtn.disabled = false;
    executeBtn.textContent = `Execute Batch (${bulkExcludeQueue.length})`;
  }

  list.innerHTML = bulkExcludeQueue.map((item, idx) => `
    <div class="event-group-item" style="${item.error ? 'border-color: rgba(239, 68, 68, 0.5); background: rgba(239, 68, 68, 0.05);' : ''}">
      <span>
        <b>${esc(item.label)}</b>
        <small>Player ID: ${esc(item.playerId)}</small>
        ${item.error ? `<small style="color:#f87171; margin-top:4px; font-weight:600;">⚠ ${esc(item.error)}</small>` : ''}
      </span>
      <div style="display:flex; gap:8px; align-items:center; flex-shrink:0;">
        <button class="quiet-button" type="button" data-edit-bulk-exclude="${idx}">Edit</button>
        <button class="quiet-button" type="button" data-remove-bulk-exclude="${idx}" style="color:#f87171;">Remove</button>
      </div>
    </div>
  `).join('');
}

function resetBulkExcludeEditMode() {
  editingExcludeIndex = -1;
  const queueBtn = $('#bulk-exclude-queue-btn');
  const cancelBtn = $('#bulk-exclude-cancel-edit-btn');
  const msg = $('#bulk-exclude-form-message');
  if (queueBtn) queueBtn.textContent = '+ Queue Exclusion';
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (msg) msg.textContent = '';
}

$('#bulk-exclude-form')?.addEventListener('submit', event => {
  event.preventDefault();
  const select = $('#bulk-exclude-player');
  const msg = $('#bulk-exclude-form-message');
  const playerId = select.value;

  if (!playerId) {
    if (msg) msg.textContent = 'Select a player to exclude.';
    return;
  }

  const isDuplicate = bulkExcludeQueue.some((item, i) =>
    (editingExcludeIndex === -1 || i !== editingExcludeIndex) && item.playerId === playerId
  );
  if (isDuplicate) {
    if (msg) msg.textContent = 'This player is already in the exclusion queue.';
    return;
  }

  const label = select.selectedOptions[0]?.textContent || playerId;

  if (editingExcludeIndex >= 0) {
    bulkExcludeQueue[editingExcludeIndex] = {
      ...bulkExcludeQueue[editingExcludeIndex],
      playerId,
      label,
      error: undefined
    };
    resetBulkExcludeEditMode();
  } else {
    bulkExcludeQueue.push({
      id: Date.now() + Math.random(),
      playerId,
      label
    });
    if (msg) msg.textContent = '';
  }

  renderBulkExcludeQueue();
});

$('#bulk-exclude-cancel-edit-btn')?.addEventListener('click', () => {
  resetBulkExcludeEditMode();
});

$('#bulk-exclude-clear-btn')?.addEventListener('click', () => {
  if (!confirm('Clear all queued player exclusion operations?')) return;
  bulkExcludeQueue = [];
  resetBulkExcludeEditMode();
  renderBulkExcludeQueue();
  $('#bulk-exclude-message').textContent = 'Queue cleared.';
});

$('#bulk-exclude-queue-list')?.addEventListener('click', event => {
  const editBtn = event.target.closest('[data-edit-bulk-exclude]');
  const removeBtn = event.target.closest('[data-remove-bulk-exclude]');

  if (editBtn) {
    const idx = parseInt(editBtn.dataset.editBulkExclude, 10);
    const item = bulkExcludeQueue[idx];
    if (!item) return;

    editingExcludeIndex = idx;
    const select = $('#bulk-exclude-player');
    if (select) select.value = item.playerId;

    const queueBtn = $('#bulk-exclude-queue-btn');
    const cancelBtn = $('#bulk-exclude-cancel-edit-btn');
    if (queueBtn) queueBtn.textContent = 'Save Changes';
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
    $('#bulk-exclude-form-message').textContent = `Editing queued exclusion #${idx + 1}`;
    select?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  if (removeBtn) {
    const idx = parseInt(removeBtn.dataset.removeBulkExclude, 10);
    if (editingExcludeIndex === idx) {
      resetBulkExcludeEditMode();
    } else if (editingExcludeIndex > idx) {
      editingExcludeIndex--;
    }
    bulkExcludeQueue.splice(idx, 1);
    renderBulkExcludeQueue();
    return;
  }
});

$('#bulk-exclude-execute-btn')?.addEventListener('click', async () => {
  if (!bulkExcludeQueue.length) return;
  const message = $('#bulk-exclude-message');
  if (!confirm(`Execute batch exclusion of ${bulkExcludeQueue.length} player(s) across all games? Profiles and rankings will be rebuilt once.`)) return;

  message.textContent = 'Executing batch player exclusions and rebuilding profiles…';
  const executeBtn = $('#bulk-exclude-execute-btn');
  if (executeBtn) executeBtn.disabled = true;

  try {
    const playerIds = bulkExcludeQueue.map(item => item.playerId);
    const res = await api('/api/admin/bulk-exclude-players', { method: 'POST', body: JSON.stringify({ playerIds }) });

    message.textContent = `Batch executed successfully: ${res.count || playerIds.length} player(s) excluded across all games.`;
    bulkExcludeQueue = [];
    resetBulkExcludeEditMode();
    renderBulkExcludeQueue();
    await loadProfiles();
  } catch (err) {
    message.textContent = `Batch execution failed: ${err.message}`;
    if (executeBtn) executeBtn.disabled = false;
  }
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

// BULK EVENT MERGING
let bulkEventQueue = [];
let editingEventIndex = -1;

function renderBulkEventQueue() {
  const list = $('#bulk-event-queue-list');
  const countEl = $('#bulk-event-queue-count');
  const clearBtn = $('#bulk-event-clear-btn');
  const executeBtn = $('#bulk-event-execute-btn');
  if (!list) return;

  if (countEl) countEl.textContent = `Queued operations (${bulkEventQueue.length})`;

  if (!bulkEventQueue.length) {
    list.innerHTML = '<p class="muted event-group-empty">No event merges currently queued.</p>';
    if (clearBtn) clearBtn.style.display = 'none';
    if (executeBtn) {
      executeBtn.disabled = true;
      executeBtn.textContent = 'Execute Batch';
    }
    return;
  }

  if (clearBtn) clearBtn.style.display = 'inline-block';
  if (executeBtn) {
    executeBtn.disabled = false;
    executeBtn.textContent = `Execute Batch (${bulkEventQueue.length})`;
  }

  list.innerHTML = bulkEventQueue.map((item, idx) => `
    <div class="event-group-item" style="${item.error ? 'border-color: rgba(239, 68, 68, 0.5); background: rgba(239, 68, 68, 0.05);' : ''}">
      <span>
        <b>${esc(item.childLabel)} → ${esc(item.parentLabel)}</b>
        <small>NAME: "${esc(item.phase)}" · FROM: ${esc(item.child)} → TO: ${esc(item.parent)}</small>
        ${item.error ? `<small style="color:#f87171; margin-top:4px; font-weight:600;">⚠ ${esc(item.error)}</small>` : ''}
      </span>
      <div style="display:flex; gap:8px; align-items:center; flex-shrink:0;">
        <button class="quiet-button" type="button" data-edit-bulk-event="${idx}">Edit</button>
        <button class="quiet-button" type="button" data-remove-bulk-event="${idx}" style="color:#f87171;">Remove</button>
      </div>
    </div>
  `).join('');
}

function resetBulkEventEditMode() {
  editingEventIndex = -1;
  const queueBtn = $('#bulk-event-queue-btn');
  const cancelBtn = $('#bulk-event-cancel-edit-btn');
  const msg = $('#bulk-event-form-message');
  if (queueBtn) queueBtn.textContent = '+ Queue Merge';
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (msg) msg.textContent = '';
}

$('#bulk-event-source')?.addEventListener('change', () => {
  const nameInput = $('#bulk-event-name');
  if (nameInput && !nameInput.value.trim()) {
    const selectedText = $('#bulk-event-source')?.selectedOptions[0]?.textContent || '';
    if (/amateur|bracket b|cat b|categoria b/i.test(selectedText)) {
      nameInput.value = 'Categoria B';
    }
  }
});

$('#bulk-event-form')?.addEventListener('submit', event => {
  event.preventDefault();
  const sourceSelect = $('#bulk-event-source');
  const targetSelect = $('#bulk-event-target');
  const nameInput = $('#bulk-event-name');
  const msg = $('#bulk-event-form-message');

  const child = sourceSelect.value;
  const parent = targetSelect.value;
  const phase = nameInput.value.trim();

  if (!child || !parent || child === parent) {
    if (msg) msg.textContent = 'Source event and destination event must be different.';
    return;
  }
  if (!phase) {
    if (msg) msg.textContent = 'Enter a display name inside tournament (NAME).';
    return;
  }

  const duplicateSource = bulkEventQueue.some((item, i) =>
    (editingEventIndex === -1 || i !== editingEventIndex) && item.child === child
  );
  if (duplicateSource) {
    if (msg) msg.textContent = 'This source event is already queued to be merged.';
    return;
  }

  const createsCycle = bulkEventQueue.some((item, i) =>
    (editingEventIndex === -1 || i !== editingEventIndex) && item.child === parent && item.parent === child
  );
  if (createsCycle) {
    if (msg) msg.textContent = 'This operation would create a cycle with another queued event merge.';
    return;
  }

  const childLabel = sourceSelect.selectedOptions[0]?.textContent || child;
  const parentLabel = targetSelect.selectedOptions[0]?.textContent || parent;

  if (editingEventIndex >= 0) {
    bulkEventQueue[editingEventIndex] = {
      ...bulkEventQueue[editingEventIndex],
      child,
      parent,
      phase,
      childLabel,
      parentLabel,
      error: undefined
    };
    resetBulkEventEditMode();
  } else {
    bulkEventQueue.push({
      id: Date.now() + Math.random(),
      child,
      parent,
      phase,
      childLabel,
      parentLabel
    });
    if (msg) msg.textContent = '';
  }

  renderBulkEventQueue();
});

$('#bulk-event-cancel-edit-btn')?.addEventListener('click', () => {
  resetBulkEventEditMode();
});

$('#bulk-event-clear-btn')?.addEventListener('click', () => {
  if (!confirm('Clear all queued event merge operations?')) return;
  bulkEventQueue = [];
  resetBulkEventEditMode();
  renderBulkEventQueue();
  $('#bulk-event-message').textContent = 'Queue cleared.';
});

$('#bulk-event-queue-list')?.addEventListener('click', event => {
  const editBtn = event.target.closest('[data-edit-bulk-event]');
  const removeBtn = event.target.closest('[data-remove-bulk-event]');

  if (editBtn) {
    const idx = parseInt(editBtn.dataset.editBulkEvent, 10);
    const item = bulkEventQueue[idx];
    if (!item) return;

    editingEventIndex = idx;
    const sourceSelect = $('#bulk-event-source');
    const targetSelect = $('#bulk-event-target');
    const nameInput = $('#bulk-event-name');
    if (sourceSelect) sourceSelect.value = item.child;
    if (targetSelect) targetSelect.value = item.parent;
    if (nameInput) nameInput.value = item.phase;

    const queueBtn = $('#bulk-event-queue-btn');
    const cancelBtn = $('#bulk-event-cancel-edit-btn');
    if (queueBtn) queueBtn.textContent = 'Save Changes';
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
    $('#bulk-event-form-message').textContent = `Editing queued merge #${idx + 1}`;
    sourceSelect?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  if (removeBtn) {
    const idx = parseInt(removeBtn.dataset.removeBulkEvent, 10);
    if (editingEventIndex === idx) {
      resetBulkEventEditMode();
    } else if (editingEventIndex > idx) {
      editingEventIndex--;
    }
    bulkEventQueue.splice(idx, 1);
    renderBulkEventQueue();
    return;
  }
});

$('#bulk-event-execute-btn')?.addEventListener('click', async () => {
  if (!bulkEventQueue.length) return;
  const message = $('#bulk-event-message');
  if (!confirm(`Execute batch merge of ${bulkEventQueue.length} event operation(s)? Tournament profiles will be rebuilt once.`)) return;

  message.textContent = 'Executing batch event merge and rebuilding profiles…';
  const executeBtn = $('#bulk-event-execute-btn');
  if (executeBtn) executeBtn.disabled = true;

  try {
    const operations = bulkEventQueue.map(item => ({ child: item.child, parent: item.parent, phase: item.phase }));
    const res = await api('/api/admin/bulk-merge-events', { method: 'POST', body: JSON.stringify({ operations }) });

    const completed = res.completed || [];
    const failed = res.failed || [];
    const completedChildren = new Set(completed.map(c => c.child || c.operation?.child || c.operation?.from));

    bulkEventQueue = bulkEventQueue.filter(item => !completedChildren.has(item.child));

    if (failed.length > 0) {
      const errorMap = new Map();
      failed.forEach(f => {
        const ch = f.operation?.child || f.operation?.from;
        if (ch) errorMap.set(ch, f.error || 'Operation failed');
      });
      bulkEventQueue.forEach(item => {
        if (errorMap.has(item.child)) {
          item.error = errorMap.get(item.child);
        }
      });
      message.textContent = `Batch executed with issues: ${completed.length} completed, ${failed.length} failed. See queue below.`;
    } else {
      message.textContent = `Batch executed successfully: ${completed.length} event merge(s) completed.`;
    }

    resetBulkEventEditMode();
    renderBulkEventQueue();
    if (res.eventGroups) {
      renderEventGroups(res.eventGroups);
    }
  } catch (err) {
    message.textContent = `Batch execution failed: ${err.message}`;
    if (executeBtn) executeBtn.disabled = false;
  }
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

// ==================== YOUTUBE VOD MANAGEMENT ====================

let currentVodData = null; // { event, entrants, opponentMap, matchesByPair, vods }
let hasUnsavedVodChanges = false;

function updateVodFormState() {
  const select = $('#vod-event-select');
  const actionBtn = $('#vod-action-btn');
  const playlistInput = $('#vod-playlist-url');
  if (!select || !actionBtn || !playlistInput) return;

  const selectedOpt = select.selectedOptions[0];
  if (!selectedOpt || !selectedOpt.value) {
    actionBtn.disabled = true;
    actionBtn.textContent = 'Load VODs';
    playlistInput.value = '';
    return;
  }

  actionBtn.disabled = false;
  const vodUrl = selectedOpt.getAttribute('data-vod-url') || '';
  const vodCount = parseInt(selectedOpt.getAttribute('data-vod-count') || '0', 10);
  playlistInput.value = vodUrl;

  if (vodCount > 0) {
    actionBtn.textContent = 'Manage VODs';
  } else {
    actionBtn.textContent = 'Load VODs';
  }
}

$('#vod-event-select')?.addEventListener('change', () => {
  updateVodFormState();
});

$('#event-vod-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const select = $('#vod-event-select');
  const input = $('#vod-playlist-url');
  const msg = $('#vod-form-message');
  if (!select || !select.value) {
    msg.textContent = 'Please select an event.';
    return;
  }
  msg.textContent = 'Saving playlist URL…';
  try {
    await api('/api/admin/event-vod-playlist', {
      method: 'POST',
      body: JSON.stringify({
        eventId: select.value,
        playlistUrl: input.value.trim()
      })
    });
    msg.textContent = 'Playlist URL saved.';
    const opt = select.selectedOptions[0];
    if (opt) opt.setAttribute('data-vod-url', input.value.trim());
  } catch (err) {
    msg.textContent = `Error: ${err.message}`;
  }
});

$('#vod-action-btn')?.addEventListener('click', async () => {
  const select = $('#vod-event-select');
  const msg = $('#vod-form-message');
  if (!select || !select.value) {
    msg.textContent = 'Please select an event first.';
    return;
  }
  const eventId = select.value;
  await openVodModal(eventId);
});

async function openVodModal(eventId) {
  const modal = $('#vod-modal');
  const title = $('#vod-modal-title');
  const subtitle = $('#vod-modal-subtitle');
  const tbody = $('#vod-table-body');
  const saveMsg = $('#vod-save-message');
  if (!modal) return;

  hasUnsavedVodChanges = false;
  if (saveMsg) saveMsg.textContent = '';
  if (title) title.textContent = 'Manage Event VODs';
  if (subtitle) subtitle.textContent = 'Loading event data…';
  if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="padding: 24px; text-align: center;" class="muted mono">Loading videos…</td></tr>';

  modal.showModal();

  try {
    const data = await api(`/api/admin/event-vod-info?eventId=${encodeURIComponent(eventId)}`);
    currentVodData = data;
    if (subtitle) {
      subtitle.textContent = `${data.event.tournamentName} · ${data.event.name} (${data.event.gameName})`;
    }

    if (!data.vods || !data.vods.length) {
      const playlistUrl = $('#vod-playlist-url')?.value.trim() || data.event.vodPlaylistUrl;
      if (playlistUrl) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="padding: 24px; text-align: center;" class="muted mono">Syncing playlist from YouTube…</td></tr>';
        await syncVodPlaylist(eventId, playlistUrl);
        return;
      }
    }

    renderVodTable();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="padding: 24px; text-align: center; color: #f87171;" class="mono">Failed to load VOD data: ${esc(err.message)}</td></tr>`;
  }
}

async function syncVodPlaylist(eventId, playlistUrl = '') {
  const saveMsg = $('#vod-save-message');
  const syncBtn = $('#vod-sync-btn');
  if (saveMsg) saveMsg.textContent = 'Syncing playlist from YouTube…';
  if (syncBtn) syncBtn.disabled = true;

  try {
    const res = await api('/api/admin/sync-event-vods', {
      method: 'POST',
      body: JSON.stringify({
        eventId,
        playlistUrl: playlistUrl || undefined
      })
    });
    if (saveMsg) saveMsg.textContent = `Synced: ${res.added} added, ${res.updated} updated (total ${res.total} in playlist).`;

    const data = await api(`/api/admin/event-vod-info?eventId=${encodeURIComponent(eventId)}`);
    currentVodData = data;
    const opt = $(`#vod-event-select option[value="${esc(eventId)}"]`);
    if (opt) opt.setAttribute('data-vod-count', data.vods.length);
    updateVodFormState();
    renderVodTable();
  } catch (err) {
    if (saveMsg) saveMsg.textContent = `Sync failed: ${err.message}`;
    renderVodTable();
  } finally {
    if (syncBtn) syncBtn.disabled = false;
  }
}

$('#vod-sync-btn')?.addEventListener('click', async () => {
  if (!currentVodData || !currentVodData.event) return;
  if (hasUnsavedVodChanges) {
    if (!confirm('You have unsaved changes. Syncing will refresh video metadata but may overwrite unsaved UI selections. Proceed?')) {
      return;
    }
  }
  const playlistUrl = $('#vod-playlist-url')?.value.trim() || currentVodData.event.vodPlaylistUrl;
  await syncVodPlaylist(currentVodData.event.id, playlistUrl);
});

function renderVodTable() {
  const tbody = $('#vod-table-body');
  const counter = $('#vod-counter');
  const showIgnored = $('#vod-filter-show-ignored')?.checked ?? true;
  if (!tbody || !currentVodData) return;

  const { entrants, opponentMap, matchesByPair, vods } = currentVodData;
  if (!vods || !vods.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="padding: 24px; text-align: center;" class="muted mono">No videos found. Check the playlist URL and click "Sync Playlist".</td></tr>';
    if (counter) counter.textContent = '0/0 mapped';
    return;
  }

  const totalVideos = vods.length;
  const mappedCount = vods.filter(v => v.status === 'complete' && v.matchId).length;
  const ignoredCount = vods.filter(v => v.status === 'ignored').length;
  if (counter) {
    counter.textContent = `${mappedCount}/${totalVideos} mapped${ignoredCount ? ` (${ignoredCount} ignored)` : ''}`;
  }

  const entrantOptionsHtml = '<option value="">Select Player 1…</option>' +
    entrants.map(e => `<option value="${esc(e.id)}">${esc(e.gamerTag || e.name)}</option>`).join('');

  tbody.innerHTML = vods.map((vod, idx) => {
    const isIgnored = vod.status === 'ignored';
    const isUnavailable = vod.availability === 'unavailable';
    const isComplete = vod.status === 'complete';

    if (isIgnored && !showIgnored) {
      return '';
    }

    const videoWatchUrl = vod.youtubeVideoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(vod.youtubeVideoId)}` : null;
    const thumbSrc = vod.youtubeThumbnailUrl || 'assets/logo.jpg';

    const p1 = vod.p1EntrantId || '';
    const p2 = vod.p2EntrantId || '';
    const matchId = vod.matchId || '';

    let p2OptionsHtml = '<option value="">Select Player 2…</option>';
    if (p1 && opponentMap[p1]) {
      const oppList = opponentMap[p1].map(oppId => {
        const opp = entrants.find(e => e.id === oppId);
        return opp ? { id: oppId, name: opp.gamerTag || opp.name } : { id: oppId, name: oppId };
      }).sort((a, b) => a.name.localeCompare(b.name));
      p2OptionsHtml += oppList.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
    }

    let matchOptionsHtml = '<option value="">Select Match…</option>';
    if (p1 && p2) {
      const pairKey = [p1, p2].sort().join('_');
      const matches = matchesByPair[pairKey] || [];
      matchOptionsHtml += matches.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    }

    let statusBadge = '<span class="mono muted" style="font-size:11px; padding:2px 6px; border-radius:4px; background:rgba(255,255,255,0.06);">PENDING</span>';
    if (isIgnored) {
      statusBadge = '<span class="mono" style="font-size:11px; padding:2px 6px; border-radius:4px; background:rgba(239,68,68,0.15); color:#f87171;">IGNORED</span>';
    } else if (isComplete && matchId) {
      statusBadge = '<span class="mono" style="font-size:11px; padding:2px 6px; border-radius:4px; background:rgba(34,197,94,0.15); color:#4ade80;">COMPLETE</span>';
    }

    const availBadge = isUnavailable
      ? '<span class="mono" style="font-size:11px; padding:2px 6px; border-radius:4px; background:rgba(234,179,8,0.15); color:#facc15; margin-left:4px;">UNAVAILABLE</span>'
      : '';

    return `
      <tr data-vod-index="${idx}" style="border-bottom: 1px solid var(--line); ${isIgnored ? 'opacity: 0.6; background: rgba(0,0,0,0.1);' : ''}">
        <td style="padding: 10px 12px; vertical-align: middle;">
          <div style="display: flex; gap: 10px; align-items: center;">
            ${videoWatchUrl ? `
              <a href="${esc(videoWatchUrl)}" target="_blank" rel="noopener noreferrer" style="flex-shrink: 0; display: block; border-radius: 6px; overflow: hidden; width: 64px; height: 36px; background: #000;">
                <img src="${esc(thumbSrc)}" alt="" style="width: 100%; height: 100%; object-fit: cover;" loading="lazy">
              </a>
            ` : `
              <div style="flex-shrink: 0; width: 64px; height: 36px; border-radius: 6px; background: #1e293b; display: flex; align-items: center; justify-content: center; font-size: 10px; color: var(--muted);">No Video</div>
            `}
            <div style="min-width: 0;">
              ${videoWatchUrl ? `
                <a href="${esc(videoWatchUrl)}" target="_blank" rel="noopener noreferrer" style="color: var(--text); font-weight: 500; text-decoration: none; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 13px;" title="${esc(vod.youtubeTitle)}">
                  ${esc(vod.youtubeTitle)}
                </a>
              ` : `
                <span style="font-weight: 500; font-size: 13px;" title="${esc(vod.youtubeTitle)}">${esc(vod.youtubeTitle)}</span>
              `}
              <div style="margin-top: 4px; display: flex; gap: 6px; align-items: center;">
                ${statusBadge}
                ${availBadge}
              </div>
            </div>
          </div>
        </td>

        <td style="padding: 10px 12px; vertical-align: middle;">
          <select class="inp vod-p1-select" style="width: 100%; font-size: 12px;" ${isIgnored ? 'disabled' : ''}>
            ${entrantOptionsHtml}
          </select>
        </td>

        <td style="padding: 10px 12px; vertical-align: middle;">
          <select class="inp vod-p2-select" style="width: 100%; font-size: 12px;" ${(!p1 || isIgnored) ? 'disabled' : ''}>
            ${p2OptionsHtml}
          </select>
        </td>

        <td style="padding: 10px 12px; vertical-align: middle;">
          <select class="inp vod-match-select" style="width: 100%; font-size: 12px;" ${(!p1 || !p2 || isIgnored) ? 'disabled' : ''}>
            ${matchOptionsHtml}
          </select>
        </td>

        <td style="padding: 10px 12px; vertical-align: middle; text-align: center;">
          <input type="checkbox" class="vod-ignore-check" ${isIgnored ? 'checked' : ''} title="Ignore / Hide video">
        </td>
      </tr>
    `;
  }).join('');

  vods.forEach((vod, idx) => {
    const row = tbody.querySelector(`tr[data-vod-index="${idx}"]`);
    if (!row) return;
    const p1Select = row.querySelector('.vod-p1-select');
    const p2Select = row.querySelector('.vod-p2-select');
    const matchSelect = row.querySelector('.vod-match-select');

    if (p1Select && vod.p1EntrantId) p1Select.value = vod.p1EntrantId;
    if (p2Select && vod.p2EntrantId) p2Select.value = vod.p2EntrantId;
    if (matchSelect && vod.matchId) matchSelect.value = vod.matchId;
  });
}

$('#vod-filter-show-ignored')?.addEventListener('change', () => {
  renderVodTable();
});

$('#vod-table-body')?.addEventListener('change', (e) => {
  const row = e.target.closest('tr[data-vod-index]');
  if (!row || !currentVodData) return;
  const idx = parseInt(row.getAttribute('data-vod-index'), 10);
  const vod = currentVodData.vods[idx];
  if (!vod) return;

  hasUnsavedVodChanges = true;
  const { entrants, opponentMap, matchesByPair } = currentVodData;

  const p1Select = row.querySelector('.vod-p1-select');
  const p2Select = row.querySelector('.vod-p2-select');
  const matchSelect = row.querySelector('.vod-match-select');
  const ignoreCheck = row.querySelector('.vod-ignore-check');

  if (e.target === ignoreCheck) {
    const isIgnored = ignoreCheck.checked;
    vod.status = isIgnored ? 'ignored' : (vod.matchId ? 'complete' : 'pending');
    p1Select.disabled = isIgnored;
    p2Select.disabled = isIgnored || !vod.p1EntrantId;
    matchSelect.disabled = isIgnored || !vod.p1EntrantId || !vod.p2EntrantId;
    renderVodTable();
    return;
  }

  if (e.target === p1Select) {
    const newP1 = p1Select.value;
    vod.p1EntrantId = newP1 || null;
    vod.p2EntrantId = null;
    vod.matchId = null;
    vod.status = 'pending';

    if (newP1 && opponentMap[newP1]) {
      const oppList = opponentMap[newP1].map(oppId => {
        const opp = entrants.find(ent => ent.id === oppId);
        return opp ? { id: oppId, name: opp.gamerTag || opp.name } : { id: oppId, name: oppId };
      }).sort((a, b) => a.name.localeCompare(b.name));
      p2Select.innerHTML = '<option value="">Select Player 2…</option>' +
        oppList.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
      p2Select.disabled = false;
    } else {
      p2Select.innerHTML = '<option value="">Select Player 2…</option>';
      p2Select.disabled = true;
    }
    matchSelect.innerHTML = '<option value="">Select Match…</option>';
    matchSelect.disabled = true;
  } else if (e.target === p2Select) {
    const newP2 = p2Select.value;
    vod.p2EntrantId = newP2 || null;
    vod.matchId = null;
    vod.status = 'pending';

    if (vod.p1EntrantId && newP2) {
      const pairKey = [vod.p1EntrantId, newP2].sort().join('_');
      const matches = matchesByPair[pairKey] || [];
      matchSelect.innerHTML = '<option value="">Select Match…</option>' +
        matches.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
      matchSelect.disabled = false;
      if (matches.length === 1) {
        matchSelect.value = matches[0].id;
        vod.matchId = matches[0].id;
        vod.status = 'complete';
      }
    } else {
      matchSelect.innerHTML = '<option value="">Select Match…</option>';
      matchSelect.disabled = true;
    }
  } else if (e.target === matchSelect) {
    const newMatch = matchSelect.value;
    vod.matchId = newMatch || null;
    vod.status = newMatch ? 'complete' : 'pending';
  }

  const totalVideos = currentVodData.vods.length;
  const mappedCount = currentVodData.vods.filter(v => v.status === 'complete' && v.matchId).length;
  const ignoredCount = currentVodData.vods.filter(v => v.status === 'ignored').length;
  const counter = $('#vod-counter');
  if (counter) {
    counter.textContent = `${mappedCount}/${totalVideos} mapped${ignoredCount ? ` (${ignoredCount} ignored)` : ''}`;
  }
});

$('#vod-save-btn')?.addEventListener('click', async () => {
  if (!currentVodData || !currentVodData.event) return;
  const saveMsg = $('#vod-save-message');
  const saveBtn = $('#vod-save-btn');
  if (saveMsg) saveMsg.textContent = 'Saving VOD associations…';
  if (saveBtn) saveBtn.disabled = true;

  try {
    const payload = {
      eventId: currentVodData.event.id,
      vods: currentVodData.vods.map(v => ({
        id: v.id,
        matchId: v.status === 'complete' ? (v.matchId || null) : (v.matchId || null),
        status: v.status,
        p1EntrantId: v.p1EntrantId || undefined,
        p2EntrantId: v.p2EntrantId || undefined,
      }))
    };

    const res = await api('/api/admin/save-event-vods', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    hasUnsavedVodChanges = false;
    if (saveMsg) saveMsg.textContent = `Saved ${res.saved} VOD associations. Static event and profile data refreshed.`;
    const opt = $(`#vod-event-select option[value="${esc(currentVodData.event.id)}"]`);
    if (opt) opt.setAttribute('data-vod-count', currentVodData.vods.length);
    updateVodFormState();
    renderVodTable();
  } catch (err) {
    if (saveMsg) saveMsg.textContent = `Save failed: ${err.message}`;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
});

function closeVodModal() {
  const modal = $('#vod-modal');
  if (!modal) return;
  if (hasUnsavedVodChanges) {
    if (!confirm('You have unsaved VOD changes. Are you sure you want to discard them?')) {
      return;
    }
  }
  hasUnsavedVodChanges = false;
  modal.close();
}

$('#vod-modal-close')?.addEventListener('click', closeVodModal);
$('#vod-cancel-btn')?.addEventListener('click', closeVodModal);

$('#signout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } finally { showEditor(false); }
});

api('/api/admin/session').then(res => {
  if (res.csrfToken) csrfToken = res.csrfToken;
  showEditor(res.authenticated);
}).catch(() => showEditor(false));
