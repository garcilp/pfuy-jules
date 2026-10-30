const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let currentSlug = '';
let currentPlayerId = '';
let currentProfileSnapshot = '';
let currentProfileObject = null;
let activeEditorMode = 'visual';
let selectedPhoto = null;

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
  if ($('#player-sponsor')) p.sponsor = $('#player-sponsor').value.trim() || null;
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
    } catch {
      alert('The raw JSON contains syntax errors. Fix them before switching to the structured form.');
      setEditorMode('raw');
    }
  } else {
    syncObjectFromVisual();
    $('#profile-json').value = JSON.stringify(currentProfileObject, null, 2);
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function showEditor(authed) {
  $('#admin-login').hidden = authed;
  $('#admin-editor').hidden = !authed;
  if (authed) {
    setEditorMode('visual');
    loadProfiles();
  }
}

async function loadProfiles(selected = '') {
  try {
    const [{ profiles }, { merges }, { eventGroups }, { exclusions }, { events }] = await Promise.all([
      api('/api/admin/profiles'), api('/api/admin/merges'), api('/api/admin/event-groups'), api('/api/admin/exclusions'), api('/api/admin/events').catch(() => ({ events: [] }))
    ]);
    renderEventGroups(eventGroups);
    renderExcludedEvents(exclusions.events || []);
    renderEventSelects(events || []);
    const select = $('#profile-select');
    select.innerHTML = profiles.map(p => `<option value="${esc(p.slug)}">${esc(p.tag)} · ${esc(p.playerId || 'local profile')}</option>`).join('');
    const source = $('#merge-source');
    const target = $('#merge-target');
    const options = profiles.filter(p => p.playerId).map(p => `<option value="${esc(p.playerId)}">${esc(p.tag)} · ${esc(p.playerId)}</option>`).join('');
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

function renderEventGroups(groups = {}) {
  const list = $('#event-group-list');
  const entries = Object.entries(groups);
  if (!entries.length) {
    list.innerHTML = '<p class="muted event-group-empty">No additional events have been grouped yet.</p>';
    return;
  }
  list.innerHTML = entries.map(([child, group]) =>
    `<div class="event-group-item"><span><b>${esc(group.phase)}</b><small>${esc(child)} → ${esc(group.parent)}</small></span><button class="quiet-button" type="button" data-remove-event-group="${esc(child)}">Remove</button></div>`
  ).join('');
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
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('#login-message');
  message.textContent = 'Signing in…';
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('#admin-password').value }) });
    $('#admin-password').value = '';
    message.textContent = '';
    showEditor(true);
  } catch (error) { message.textContent = error.message; }
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
  message.textContent = 'Merging and rebuilding profiles…';
  try {
    await api('/api/admin/merge', { method: 'POST', body: JSON.stringify({ sourceId, targetId }) });
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
      try { profile = JSON.parse($('#profile-json').value); }
      catch { throw new Error('Profile data must be valid JSON.'); }
      currentProfileObject = profile;
      syncVisualFromObject(profile);
    }
    if (!profile || typeof profile !== 'object' || !profile.player || !Array.isArray(profile.games)) {
      throw new Error('Profile JSON must contain a player object and a games array.');
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

$('#signout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } finally { showEditor(false); }
});

api('/api/admin/session').then(({ authenticated }) => showEditor(authenticated)).catch(() => showEditor(false));
