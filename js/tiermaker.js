// Tiermaker Implementation for Platfighters.uy
(function() {
  'use strict';

  const STORAGE_PREFIX = 'pfuy_tiermaker_';

  const DEFAULT_TIERS = [
    { id: 'tier-s', name: 'S', color: '#ff4d4d', playerIds: [] },
    { id: 'tier-a', name: 'A', color: '#ff9f43', playerIds: [] },
    { id: 'tier-b', name: 'B', color: '#feca57', playerIds: [] },
    { id: 'tier-c', name: 'C', color: '#1dd1a1', playerIds: [] },
    { id: 'tier-d', name: 'D', color: '#54a0ff', playerIds: [] },
    { id: 'tier-f', name: 'F', color: '#5f27cd', playerIds: [] },
  ];

  // DOM Elements
  const openBtn = document.getElementById('open-tiermaker-btn');
  const closeBtn = document.getElementById('close-tiermaker-btn');
  const tiermakerView = document.getElementById('tiermaker-view');
  const dirHead = document.querySelector('.directory-head');
  const dirStatus = document.getElementById('directory-status');
  const playerList = document.getElementById('player-list');
  const scrollSentinel = document.getElementById('scroll-sentinel');

  // Controls
  const gameSelect = document.getElementById('tm-game-select');
  const poolSortSelect = document.getElementById('tm-pool-sort');
  const addTierBtn = document.getElementById('tm-add-tier-btn');
  const undoBtn = document.getElementById('tm-undo-btn');
  const resetBtn = document.getElementById('tm-reset-btn');
  const exportBtn = document.getElementById('tm-export-btn');

  const tiersContainer = document.getElementById('tm-tiers-container');
  const unrankedPoolEl = document.getElementById('tm-unranked-pool');
  const intlPoolEl = document.getElementById('tm-intl-pool');
  const unrankedCountEl = document.getElementById('tm-unranked-count');
  const intlCountEl = document.getElementById('tm-intl-count');

  // State
  let activeGame = 'ultimate';
  let catalog = null; // { game_id, players: [...], international: [...] }
  let playersById = new Map(); // id -> player object
  let tiers = [];
  let history = []; // Undo stack of tier states

  // Preserved Players directory state
  let preservedDirState = null;

  // Selected badge for mobile touch tap-to-move
  let selectedBadgeId = null;

  function init() {
    if (!openBtn || !tiermakerView) return;

    openBtn.addEventListener('click', enterTiermakerMode);
    closeBtn.addEventListener('click', exitTiermakerMode);

    gameSelect.addEventListener('change', () => {
      activeGame = gameSelect.value;
      loadGameData(activeGame);
    });

    poolSortSelect.addEventListener('change', () => {
      renderPools();
    });

    addTierBtn.addEventListener('click', () => {
      pushHistory();
      const newId = 'tier-' + Date.now();
      const colors = ['#ff4d4d', '#ff9f43', '#feca57', '#1dd1a1', '#54a0ff', '#5f27cd', '#e056fd', '#686de0'];
      const randomColor = colors[tiers.length % colors.length];
      tiers.push({
        id: newId,
        name: 'NEW',
        color: randomColor,
        playerIds: []
      });
      saveState();
      renderTiers();
    });

    undoBtn.addEventListener('click', () => {
      if (!history.length) return;
      tiers = history.pop();
      saveState();
      renderAll();
    });

    resetBtn.addEventListener('click', () => {
      const msg = window.i18n ? window.i18n.t('tiermaker.resetConfirm') : 'Reset tier list and return all players to their pools?';
      if (!confirm(msg)) return;
      pushHistory();
      tiers = JSON.parse(JSON.stringify(DEFAULT_TIERS));
      saveState();
      renderAll();
    });

    if (exportBtn) {
      exportBtn.addEventListener('click', exportTierlistPNG);
    }

    setupDragAndDrop();
  }

  function enterTiermakerMode() {
    // Preserve current Players directory state
    preservedDirState = {
      search: document.getElementById('player-search')?.value || '',
      game: document.getElementById('game-filter')?.value || '',
      sort: document.getElementById('player-sort')?.value || 'tag',
      view: document.getElementById('player-view')?.value || 'condensed',
      scroll: window.scrollY || document.documentElement.scrollTop || 0
    };

    // Hide Players directory elements
    if (dirHead) dirHead.style.display = 'none';
    if (dirStatus) dirStatus.style.display = 'none';
    if (playerList) playerList.style.display = 'none';
    const sentinel = document.getElementById('scroll-sentinel');
    if (sentinel) sentinel.style.display = 'none';

    // Show Tiermaker
    tiermakerView.style.display = 'flex';
    window.scrollTo(0, 0);

    // Sync game selector with directory game if applicable
    if (preservedDirState.game && ['ultimate', 'melee', 'project-plus', 'rivals-2', 'rivals-of-aether'].includes(preservedDirState.game)) {
      activeGame = preservedDirState.game;
      gameSelect.value = activeGame;
    }

    loadGameData(activeGame);
  }

  function exitTiermakerMode() {
    // Hide Tiermaker
    tiermakerView.style.display = 'none';

    // Restore Players directory elements
    if (dirHead) dirHead.style.display = '';
    if (dirStatus) dirStatus.style.display = '';
    if (playerList) playerList.style.display = '';
    const sentinel = document.getElementById('scroll-sentinel');
    if (sentinel) sentinel.style.display = '';

    // Restore directory state
    if (preservedDirState) {
      const searchInput = document.getElementById('player-search');
      const gameFilter = document.getElementById('game-filter');
      const playerSort = document.getElementById('player-sort');
      const playerView = document.getElementById('player-view');

      if (searchInput) searchInput.value = preservedDirState.search;
      if (gameFilter) gameFilter.value = preservedDirState.game;
      if (playerSort) playerSort.value = preservedDirState.sort;
      if (playerView) playerView.value = preservedDirState.view;

      // Trigger render
      if (typeof window.render === 'function') {
        window.render();
      } else {
        searchInput?.dispatchEvent(new Event('input'));
      }

      window.scrollTo(0, preservedDirState.scroll);
    }
  }

  async function loadGameData(gameSlug) {
    history = [];
    playersById.clear();

    try {
      const res = await fetch(`data/tiermaker/${gameSlug}.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Could not load tiermaker data for ${gameSlug}`);
      catalog = await res.json();
    } catch (err) {
      console.error(err);
      catalog = { game_id: gameSlug, players: [], international: [] };
    }

    // Populate players map
    (catalog.players || []).forEach(p => playersById.set(String(p.id), { ...p, is_international: false }));
    (catalog.international || []).forEach(p => playersById.set(String(p.id), { ...p, is_international: true }));

    // Load saved tiers from localStorage
    loadState(gameSlug);
    renderAll();
  }

  function loadState(gameSlug) {
    try {
      const saved = localStorage.getItem(STORAGE_PREFIX + gameSlug);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Filter out player IDs that no longer exist in catalog
          tiers = parsed.map(tier => ({
            ...tier,
            playerIds: (tier.playerIds || []).filter(pid => playersById.has(String(pid)))
          }));
          return;
        }
      }
    } catch (e) {
      console.warn('Failed to load tiermaker state:', e);
    }
    tiers = JSON.parse(JSON.stringify(DEFAULT_TIERS));
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_PREFIX + activeGame, JSON.stringify(tiers));
    } catch (e) {
      console.warn('Failed to save tiermaker state:', e);
    }
  }

  function pushHistory() {
    history.push(JSON.parse(JSON.stringify(tiers)));
    if (history.length > 30) history.shift();
  }

  function getPlacedPlayerIds() {
    const placed = new Set();
    tiers.forEach(t => (t.playerIds || []).forEach(id => placed.add(String(id))));
    return placed;
  }

  function sortPlayerList(list) {
    const sortBy = poolSortSelect ? poolSortSelect.value : 'tag';
    return [...list].sort((a, b) => {
      if (sortBy === 'events') {
        const diff = (b.event_count || 0) - (a.event_count || 0);
        if (diff !== 0) return diff;
      } else if (sortBy === 'recent') {
        const dateA = a.last_participation || '';
        const dateB = b.last_participation || '';
        if (dateA !== dateB) {
          if (!dateA) return 1;
          if (!dateB) return -1;
          return dateB.localeCompare(dateA);
        }
      }
      return (a.tag || '').localeCompare(b.tag || '', undefined, { sensitivity: 'base', numeric: true });
    });
  }

  function renderAll() {
    renderTiers();
    renderPools();
  }

  function renderTiers() {
    tiersContainer.innerHTML = '';

    tiers.forEach((tier, index) => {
      const row = document.createElement('div');
      row.className = 'tm-tier-row';
      row.dataset.tierId = tier.id;

      // Label Box
      const labelBox = document.createElement('div');
      labelBox.className = 'tm-tier-label-box';
      labelBox.style.backgroundColor = tier.color;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tm-tier-label-input';
      input.value = tier.name;
      input.maxLength = 15;
      input.addEventListener('change', () => {
        pushHistory();
        tier.name = input.value.trim() || 'TIER';
        saveState();
      });
      labelBox.appendChild(input);

      // Items Box
      const itemsBox = document.createElement('div');
      itemsBox.className = 'tm-tier-items-box';
      itemsBox.dataset.tierId = tier.id;

      (tier.playerIds || []).forEach(pid => {
        const p = playersById.get(String(pid));
        if (p) {
          itemsBox.appendChild(createBadgeElement(p));
        }
      });

      // Controls
      const controls = document.createElement('div');
      controls.className = 'tm-tier-controls';

      // Move Up
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'tm-icon-btn';
      upBtn.innerHTML = '▲';
      upBtn.title = window.i18n ? window.i18n.t('tiermaker.moveUp') : 'Move up';
      upBtn.disabled = index === 0;
      upBtn.addEventListener('click', () => {
        if (index > 0) {
          pushHistory();
          const tmp = tiers[index];
          tiers[index] = tiers[index - 1];
          tiers[index - 1] = tmp;
          saveState();
          renderTiers();
        }
      });
      controls.appendChild(upBtn);

      // Move Down
      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'tm-icon-btn';
      downBtn.innerHTML = '▼';
      downBtn.title = window.i18n ? window.i18n.t('tiermaker.moveDown') : 'Move down';
      downBtn.disabled = index === tiers.length - 1;
      downBtn.addEventListener('click', () => {
        if (index < tiers.length - 1) {
          pushHistory();
          const tmp = tiers[index];
          tiers[index] = tiers[index + 1];
          tiers[index + 1] = tmp;
          saveState();
          renderTiers();
        }
      });
      controls.appendChild(downBtn);

      // Color Picker
      const colorWrap = document.createElement('div');
      colorWrap.className = 'tm-color-picker-wrap';
      colorWrap.style.backgroundColor = tier.color;

      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'tm-color-picker-input';
      colorInput.value = tier.color;
      colorInput.addEventListener('input', () => {
        tier.color = colorInput.value;
        labelBox.style.backgroundColor = tier.color;
        colorWrap.style.backgroundColor = tier.color;
      });
      colorInput.addEventListener('change', () => {
        pushHistory();
        saveState();
      });
      colorWrap.appendChild(colorInput);
      controls.appendChild(colorWrap);

      // Delete Tier
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'tm-icon-btn';
      delBtn.innerHTML = '✕';
      delBtn.title = window.i18n ? window.i18n.t('tiermaker.deleteTier') : 'Delete tier';
      delBtn.addEventListener('click', () => {
        pushHistory();
        // Removing tier returns its players to unranked pools automatically
        tiers.splice(index, 1);
        saveState();
        renderAll();
      });
      controls.appendChild(delBtn);

      row.appendChild(labelBox);
      row.appendChild(itemsBox);
      row.appendChild(controls);
      tiersContainer.appendChild(row);
    });
  }

  function renderPools() {
    const placed = getPlacedPlayerIds();

    // Regular Pool
    const unrankedPlayers = (catalog?.players || []).filter(p => !placed.has(String(p.id)));
    const sortedUnranked = sortPlayerList(unrankedPlayers);
    unrankedPoolEl.innerHTML = '';
    unrankedCountEl.textContent = sortedUnranked.length;
    sortedUnranked.forEach(p => {
      unrankedPoolEl.appendChild(createBadgeElement(p));
    });

    // International Pool
    const intlPlayers = (catalog?.international || []).filter(p => !placed.has(String(p.id)));
    const sortedIntl = sortPlayerList(intlPlayers);
    intlPoolEl.innerHTML = '';
    intlCountEl.textContent = sortedIntl.length;
    sortedIntl.forEach(p => {
      intlPoolEl.appendChild(createBadgeElement(p));
    });
  }

  function createBadgeElement(player) {
    const el = document.createElement('div');
    el.className = 'tm-badge';
    el.draggable = true;
    el.dataset.playerId = String(player.id);
    el.dataset.isInternational = player.is_international ? 'true' : 'false';
    el.title = `${player.tag} (${player.event_count || 0} events)`;

    const img = document.createElement('img');
    img.src = `assets/players/tiermaker/${activeGame}/${player.id}.webp`;
    img.alt = player.tag;
    img.loading = 'lazy';
    el.appendChild(img);

    // Tap/Click interaction for mobile or quick placement
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      handleBadgeClick(player.id);
    });

    return el;
  }

  function handleBadgeClick(playerId) {
    // If we have a selected badge and click another badge or target, move it
    if (selectedBadgeId === playerId) {
      // Deselect
      selectedBadgeId = null;
      document.querySelectorAll('.tm-badge.selected').forEach(b => b.classList.remove('selected'));
      return;
    }

    selectedBadgeId = playerId;
    document.querySelectorAll('.tm-badge.selected').forEach(b => b.classList.remove('selected'));
    const current = document.querySelector(`.tm-badge[data-player-id="${playerId}"]`);
    if (current) current.classList.add('selected');
  }

  // Handle clicking on dropzones when a badge is selected (Tap-to-move for touch/mobile)
  document.addEventListener('click', (e) => {
    if (!selectedBadgeId) return;

    const targetTierBox = e.target.closest('.tm-tier-items-box');
    const targetPool = e.target.closest('.tm-pool-dropzone');

    if (targetTierBox) {
      const tierId = targetTierBox.dataset.tierId;
      movePlayerToTier(selectedBadgeId, tierId);
      selectedBadgeId = null;
      document.querySelectorAll('.tm-badge.selected').forEach(b => b.classList.remove('selected'));
    } else if (targetPool) {
      movePlayerToPool(selectedBadgeId);
      selectedBadgeId = null;
      document.querySelectorAll('.tm-badge.selected').forEach(b => b.classList.remove('selected'));
    }
  });

  function movePlayerToTier(playerId, targetTierId, targetIndex = null) {
    pushHistory();
    const pidStr = String(playerId);

    // Remove from existing tier if placed
    tiers.forEach(t => {
      t.playerIds = (t.playerIds || []).filter(id => String(id) !== pidStr);
    });

    const targetTier = tiers.find(t => t.id === targetTierId);
    if (targetTier) {
      if (targetIndex !== null && targetIndex >= 0) {
        targetTier.playerIds.splice(targetIndex, 0, pidStr);
      } else {
        targetTier.playerIds.push(pidStr);
      }
    }

    saveState();
    renderAll();
  }

  function movePlayerToPool(playerId) {
    pushHistory();
    const pidStr = String(playerId);

    // Remove from tier
    tiers.forEach(t => {
      t.playerIds = (t.playerIds || []).filter(id => String(id) !== pidStr);
    });

    saveState();
    renderAll();
  }

  function setupDragAndDrop() {
    let draggedPid = null;

    document.addEventListener('dragstart', (e) => {
      const badge = e.target.closest('.tm-badge');
      if (!badge) return;
      draggedPid = badge.dataset.playerId;
      badge.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedPid);
    });

    document.addEventListener('dragend', (e) => {
      const badge = e.target.closest('.tm-badge');
      if (badge) badge.classList.remove('dragging');
      draggedPid = null;
      document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    document.addEventListener('dragover', (e) => {
      const dropzone = e.target.closest('.tm-tier-items-box, .tm-pool-dropzone');
      if (!dropzone) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      dropzone.classList.add('drag-over');
    });

    document.addEventListener('dragleave', (e) => {
      const dropzone = e.target.closest('.tm-tier-items-box, .tm-pool-dropzone');
      if (dropzone && !dropzone.contains(e.relatedTarget)) {
        dropzone.classList.remove('drag-over');
      }
    });

    document.addEventListener('drop', (e) => {
      const dropzone = e.target.closest('.tm-tier-items-box, .tm-pool-dropzone');
      if (!dropzone || !draggedPid) return;
      e.preventDefault();
      dropzone.classList.remove('drag-over');

      if (dropzone.classList.contains('tm-tier-items-box')) {
        const tierId = dropzone.dataset.tierId;
        // Check if dropped before an existing badge for inline reordering
        const targetBadge = e.target.closest('.tm-badge');
        let targetIndex = null;
        if (targetBadge && targetBadge.parentElement === dropzone) {
          const badges = Array.from(dropzone.querySelectorAll('.tm-badge'));
          targetIndex = badges.indexOf(targetBadge);
        }
        movePlayerToTier(draggedPid, tierId, targetIndex);
      } else if (dropzone.classList.contains('tm-pool-dropzone')) {
        movePlayerToPool(draggedPid);
      }
    });
  }

  // PNG Export Implementation
  async function exportTierlistPNG() {
    exportBtn.disabled = true;
    const origText = exportBtn.textContent;
    exportBtn.textContent = 'Generating…';

    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      const width = 1200;
      const padding = 32;
      const labelWidth = 140;
      const badgeSize = 80;
      const badgeGap = 8;
      const contentWidth = width - (padding * 2);
      const itemsAreaWidth = contentWidth - labelWidth;

      // Calculate layout heights
      let totalHeight = padding; // Top padding

      // Header: Logo/Title (approx 90px)
      const headerHeight = 90;
      totalHeight += headerHeight + 20;

      // Calculate tier row heights
      const tierLayouts = tiers.map(tier => {
        const pids = tier.playerIds || [];
        const badgesPerRow = Math.max(1, Math.floor((itemsAreaWidth - 16) / (badgeSize + badgeGap)));
        const rows = Math.max(1, Math.ceil(pids.length / badgesPerRow));
        const rowHeight = Math.max(badgeSize + 16, rows * (badgeSize + badgeGap) + 16);
        return { tier, pids, rowHeight, badgesPerRow };
      });

      tierLayouts.forEach(tl => {
        totalHeight += tl.rowHeight + 10;
      });

      totalHeight += 20; // Gap before unranked pools

      // International Players section
      const placed = getPlacedPlayerIds();
      const intlPlayers = (catalog?.international || []).filter(p => !placed.has(String(p.id)));
      const badgesPerRowPool = Math.max(1, Math.floor((contentWidth - 24) / (badgeSize + badgeGap)));
      const intlRows = Math.max(1, Math.ceil(intlPlayers.length / badgesPerRowPool));
      const intlPoolHeight = 44 + (intlRows * (badgeSize + badgeGap)) + 16;
      totalHeight += intlPoolHeight + 20;

      // Regular Unranked Players section
      const unrankedPlayers = (catalog?.players || []).filter(p => !placed.has(String(p.id)));
      const unrankedRows = Math.max(1, Math.ceil(unrankedPlayers.length / badgesPerRowPool));
      const unrankedPoolHeight = 44 + (unrankedRows * (badgeSize + badgeGap)) + 16;
      totalHeight += unrankedPoolHeight + padding;

      // Set canvas dimensions
      canvas.width = width;
      canvas.height = totalHeight;

      // Background
      ctx.fillStyle = '#050B1F';
      ctx.fillRect(0, 0, width, totalHeight);

      // Gradient overlay
      const bgGrad = ctx.createRadialGradient(width / 2, 0, 100, width / 2, totalHeight / 2, totalHeight);
      bgGrad.addColorStop(0, 'rgba(26, 43, 90, 0.4)');
      bgGrad.addColorStop(1, 'rgba(5, 11, 31, 0.95)');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, totalHeight);

      // Preload images
      const allPidsToRender = new Set();
      tiers.forEach(t => (t.playerIds || []).forEach(id => allPidsToRender.add(String(id))));
      intlPlayers.forEach(p => allPidsToRender.add(String(p.id)));
      unrankedPlayers.forEach(p => allPidsToRender.add(String(p.id)));

      const loadedImages = new Map();
      await Promise.all(Array.from(allPidsToRender).map(pid => {
        return new Promise(resolve => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            loadedImages.set(pid, img);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = `assets/players/tiermaker/${activeGame}/${pid}.webp`;
        });
      }));

      // Render Header
      let currentY = padding;
      ctx.fillStyle = '#9FD6FF';
      ctx.font = '700 14px "JetBrains Mono", monospace';
      ctx.fillText('PLATFIGHTERS.UY · COMMUNITY TIER LIST', padding, currentY + 18);

      const gameNames = {
        'ultimate': 'Super Smash Bros. Ultimate',
        'melee': 'Super Smash Bros. Melee',
        'project-plus': 'Project+',
        'rivals-2': 'Rivals 2',
        'rivals-of-aether': 'Rivals of Aether'
      };
      const gameTitle = gameNames[activeGame] || activeGame.toUpperCase();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 32px "Space Grotesk", sans-serif';
      ctx.fillText(gameTitle, padding, currentY + 54);

      currentY += headerHeight + 20;

      // Render Tier Rows
      tierLayouts.forEach(tl => {
        const rowX = padding;
        const rowY = currentY;
        const rowW = contentWidth;
        const rowH = tl.rowHeight;

        // Row border & background
        ctx.fillStyle = 'rgba(10, 16, 35, 0.7)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(rowX, rowY, rowW, rowH, 12);
        ctx.fill();
        ctx.stroke();

        // Label Box
        ctx.fillStyle = tl.tier.color;
        ctx.beginPath();
        ctx.roundRect(rowX, rowY, labelWidth, rowH, [12, 0, 0, 12]);
        ctx.fill();

        // Label Text
        ctx.fillStyle = '#111111';
        ctx.font = '700 24px "Space Grotesk", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tl.tier.name, rowX + (labelWidth / 2), rowY + (rowH / 2));
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        // Render Badges
        const itemsStartX = rowX + labelWidth + 12;
        const itemsStartY = rowY + 8;

        tl.pids.forEach((pid, bIdx) => {
          const col = bIdx % tl.badgesPerRow;
          const r = Math.floor(bIdx / tl.badgesPerRow);
          const bx = itemsStartX + col * (badgeSize + badgeGap);
          const by = itemsStartY + r * (badgeSize + badgeGap);

          const img = loadedImages.get(String(pid));
          if (img) {
            ctx.save();
            ctx.beginPath();
            ctx.roundRect(bx, by, badgeSize, badgeSize, 10);
            ctx.clip();
            ctx.drawImage(img, bx, by, badgeSize, badgeSize);
            ctx.restore();

            // Border around badge
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(bx, by, badgeSize, badgeSize, 10);
            ctx.stroke();
          }
        });

        currentY += rowH + 10;
      });

      currentY += 15;

      // Render International Players Category
      const intlBoxX = padding;
      const intlBoxY = currentY;
      const intlBoxW = contentWidth;

      ctx.fillStyle = 'rgba(245, 197, 66, 0.05)';
      ctx.strokeStyle = 'rgba(245, 197, 66, 0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(intlBoxX, intlBoxY, intlBoxW, intlPoolHeight, 16);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#F5C542';
      ctx.font = '700 18px "Space Grotesk", sans-serif';
      ctx.fillText(`International Players (${intlPlayers.length})`, intlBoxX + 16, intlBoxY + 30);

      intlPlayers.forEach((p, bIdx) => {
        const col = bIdx % badgesPerRowPool;
        const r = Math.floor(bIdx / badgesPerRowPool);
        const bx = intlBoxX + 16 + col * (badgeSize + badgeGap);
        const by = intlBoxY + 44 + r * (badgeSize + badgeGap);

        const img = loadedImages.get(String(p.id));
        if (img) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(bx, by, badgeSize, badgeSize, 10);
          ctx.clip();
          ctx.drawImage(img, bx, by, badgeSize, badgeSize);
          ctx.restore();

          ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(bx, by, badgeSize, badgeSize, 10);
          ctx.stroke();
        }
      });

      currentY += intlPoolHeight + 20;

      // Render Regular Unranked Pool
      const unrankedBoxX = padding;
      const unrankedBoxY = currentY;
      const unrankedBoxW = contentWidth;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(unrankedBoxX, unrankedBoxY, unrankedBoxW, unrankedPoolHeight, 16);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 18px "Space Grotesk", sans-serif';
      ctx.fillText(`Unranked Players (${unrankedPlayers.length})`, unrankedBoxX + 16, unrankedBoxY + 30);

      unrankedPlayers.forEach((p, bIdx) => {
        const col = bIdx % badgesPerRowPool;
        const r = Math.floor(bIdx / badgesPerRowPool);
        const bx = unrankedBoxX + 16 + col * (badgeSize + badgeGap);
        const by = unrankedBoxY + 44 + r * (badgeSize + badgeGap);

        const img = loadedImages.get(String(p.id));
        if (img) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(bx, by, badgeSize, badgeSize, 10);
          ctx.clip();
          ctx.drawImage(img, bx, by, badgeSize, badgeSize);
          ctx.restore();

          ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(bx, by, badgeSize, badgeSize, 10);
          ctx.stroke();
        }
      });

      // Download PNG
      const link = document.createElement('a');
      link.download = `${activeGame}-tierlist.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (err) {
      console.error('PNG export failed:', err);
      alert('Failed to export PNG: ' + err.message);
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = origText;
    }
  }

  // Language change subscription
  if (window.i18n && window.i18n.onChange) {
    window.i18n.onChange(() => {
      renderAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
