const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Default games fallback if API is unavailable
const DEFAULT_GAMES = [
  { slug: 'melee', name: 'Melee' },
  { slug: 'project-plus', name: 'Project+' },
  { slug: 'rivals-2', name: 'Rivals 2' },
  { slug: 'rivals-of-aether', name: 'Rivals of Aether' },
  { slug: 'ultimate', name: 'Ultimate' }
];

let availableGames = [...DEFAULT_GAMES].sort((a, b) => a.name.localeCompare(b.name));
let currentData = null;
let comparisonData = {};
let sortCol = 'rank';
let sortAsc = true;
let visibleCount = 25;
const batchSize = 25;
let currentRequestId = 0;
let activeFetchController = null;
let scrollObserver = null;

// URL State Sync
function getStateFromURL() {
  const params = new URLSearchParams(window.location.search);
  let section = params.get('section') || '';
  let system = params.get('system') || 'overview';

  // Backward compatibility: system=custom maps to power_rankings section
  if (system === 'custom' || system === 'power_rankings') {
    section = 'power_rankings';
    system = 'custom';
  } else if (section === 'historical' || system === 'historical') {
    section = 'historical';
    system = 'historical';
  } else if (!section) {
    if (window.location.hash && !params.get('system')) {
      section = 'historical';
      system = 'historical';
    } else {
      section = 'systems';
    }
  }

  return {
    section,
    game: params.get('game') || 'ultimate',
    system,
    mode: params.get('mode') || 'historical',
    start: params.get('start') || '',
    end: params.get('end') || '',
    search: params.get('search') || '',
    player: params.get('player') || ''
  };
}

function updateURLState(state) {
  const params = new URLSearchParams();
  if (state.section && state.section !== 'systems') params.set('section', state.section);
  if (state.section === 'historical') {
    const hash = window.location.hash || '';
    const newSearch = params.toString() ? `?${params.toString()}` : window.location.pathname;
    window.history.replaceState({}, '', newSearch + hash);
    return;
  }
  if (state.game && state.game !== 'ultimate') params.set('game', state.game);
  if (state.system && state.system !== 'overview') params.set('system', state.system);
  if (state.mode && state.mode !== 'historical') params.set('mode', state.mode);
  if (state.start) params.set('start', state.start);
  if (state.end) params.set('end', state.end);
  if (state.search) params.set('search', state.search);
  if (state.player) params.set('player', state.player);

  const newSearch = params.toString() ? `?${params.toString()}` : window.location.pathname;
  window.history.replaceState({}, '', newSearch);
}

// Elements
const gameFilter = $('#game-filter');
const modeFilter = $('#mode-filter');
const startDateInput = $('#start-date-input');
const endDateInput = $('#end-date-input');
const playerSearch = $('#player-search');
const rankingStatus = $('#ranking-status');
const rankingsContent = $('#rankings-content');
const diagnosticModal = $('#diagnostic-modal');
const modalCloseBtn = $('#modal-close-btn');
const modalPlayerInfo = $('#modal-player-info');
const modalBody = $('#modal-body');
const breadcrumbNav = $('#ranking-breadcrumbs');

let activeSection = 'systems';
let activeSubsection = 'overview';

// Helper to get descriptive names for system tabs
function getSystemNames() {
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  return {
    overview: isEs ? 'Resumen' : 'Overview',
    glicko2: 'Glicko-2',
    sof: isEs ? 'Fuerza de Campo' : 'Strength of Field',
    quality_wins: isEs ? 'Victorias de Calidad' : 'Quality Wins',
    loss_quality: isEs ? 'Consistencia' : 'Consistency',
    custom: isEs ? 'Fórmula Personalizada' : 'Custom Formula'
  };
}

function renderSystemTabsNav() {
  if (activeSection !== 'systems') return '';
  const names = getSystemNames();
  return `
    <nav id="system-tabs" class="ranking-subsection-tabs" aria-label="Ranking Systems Subsections">
      <button class="ranking-tab ${activeSubsection === 'overview' ? 'active' : ''}" data-system="overview">${names.overview}</button>
      <button class="ranking-tab ${activeSubsection === 'glicko2' ? 'active' : ''}" data-system="glicko2">${names.glicko2}</button>
      <button class="ranking-tab ${activeSubsection === 'sof' ? 'active' : ''}" data-system="sof">${names.sof}</button>
      <button class="ranking-tab ${activeSubsection === 'quality_wins' ? 'active' : ''}" data-system="quality_wins">${names.quality_wins}</button>
      <button class="ranking-tab ${activeSubsection === 'loss_quality' ? 'active' : ''}" data-system="loss_quality">${names.loss_quality}</button>
    </nav>
  `;
}

function bindSystemTabsEvents() {
  $$('#system-tabs .ranking-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const sys = btn.dataset.system;
      window.navigateToSection('systems', sys);
    });
  });
}

function updateBreadcrumbsAndNav() {
  // Update section tabs highlight
  $$('.ranking-section-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.section === activeSection);
  });

  // Update active subsection tab highlight (if present in DOM)
  $$('.ranking-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.system === activeSubsection);
  });

  // Render breadcrumbs
  if (breadcrumbNav) {
    if (activeSection === 'power_rankings') {
      breadcrumbNav.innerHTML = `
        <a href="rankings.html?section=systems&system=overview" onclick="event.preventDefault(); window.navigateToSection('systems', 'overview');">Rankings</a>
        <span class="sep">/</span>
        <span class="current">Power Rankings</span>
      `;
    } else if (activeSection === 'historical') {
      breadcrumbNav.innerHTML = `
        <a href="rankings.html?section=systems&system=overview" onclick="event.preventDefault(); window.navigateToSection('systems', 'overview');">Rankings</a>
        <span class="sep">/</span>
        <span class="current">Historical Rankings</span>
      `;
    } else {
      const names = getSystemNames();
      const subName = names[activeSubsection] || activeSubsection;
      breadcrumbNav.innerHTML = `
        <a href="rankings.html?section=systems&system=overview" onclick="event.preventDefault(); window.navigateToSection('systems', 'overview');">Rankings</a>
        <span class="sep">/</span>
        <a href="rankings.html?section=systems&system=overview" onclick="event.preventDefault(); window.navigateToSection('systems', 'overview');">Ranking Systems</a>
        <span class="sep">/</span>
        <span class="current">${esc(subName)}</span>
      `;
    }
  }
}

if (window.i18n && window.i18n.onChange) {
  window.i18n.onChange(() => {
    updateBreadcrumbsAndNav();
    if (activeSection === 'historical') {
      renderHistoricalRankings();
    } else {
      render();
    }
  });
}

window.navigateToSection = function(section, subsection = null) {
  activeSection = section;
  if (section === 'power_rankings') {
    activeSubsection = 'custom';
  } else if (section === 'historical') {
    activeSubsection = 'historical';
  } else {
    activeSubsection = subsection || (activeSubsection === 'custom' || activeSubsection === 'historical' ? 'overview' : activeSubsection);
  }
  updateBreadcrumbsAndNav();
  visibleCount = batchSize;
  const state = getCurrentFilterState();
  updateURLState(state);
  loadData();
};

// Initialize
async function init() {
  const state = getStateFromURL();
  activeSection = state.section;
  activeSubsection = state.system;

  if (window.PRBadges) {
    window.PRBadges.loadAllRankings().catch(e => console.warn(e));
  }

  // Load available games (prefer static data/games.json for published site, fallback to DEFAULT_GAMES)
  try {
    const res = await fetch('data/games.json');
    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json) && json.length) {
        availableGames = json.map(g => ({ slug: g.slug || g.id, name: g.name }));
      }
    }
  } catch (err) {
    // Fallback to DEFAULT_GAMES
  }

  // Sort available games alphabetically
  availableGames.sort((a, b) => a.name.localeCompare(b.name));

  // Populate game filter
  gameFilter.innerHTML = availableGames.map(g =>
    `<option value="${esc(g.slug)}"${g.slug === state.game ? ' selected' : ''}>${esc(g.name)}</option>`
  ).join('');

  // Set initial filter inputs
  modeFilter.value = state.mode;
  startDateInput.value = state.start;
  endDateInput.value = state.end;
  playerSearch.value = state.search;

  syncDateInputsDisabledState();
  updateBreadcrumbsAndNav();

  // Add event listeners
  gameFilter.addEventListener('change', onFilterChange);
  modeFilter.addEventListener('change', onFilterChange);
  startDateInput.addEventListener('change', onFilterChange);
  startDateInput.addEventListener('input', onFilterChange);
  endDateInput.addEventListener('change', onFilterChange);
  endDateInput.addEventListener('input', onFilterChange);

  playerSearch.addEventListener('input', () => {
    visibleCount = batchSize;
    const state = getCurrentFilterState();
    updateURLState(state);
    render();
  });

  $$('.ranking-section-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const sec = btn.dataset.section;
      window.navigateToSection(sec);
    });
  });


  $$('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      const today = new Date().toISOString().split('T')[0];
      if (preset === 'all') {
        modeFilter.value = 'historical';
        startDateInput.value = '';
        endDateInput.value = '';
      } else {
        if (modeFilter.value === 'historical') {
          modeFilter.value = 'period_only';
        }
        if (preset === '2025') {
          startDateInput.value = '2025-01-01';
          endDateInput.value = '2025-12-31';
        } else if (preset === '2024') {
          startDateInput.value = '2024-01-01';
          endDateInput.value = '2024-12-31';
        } else if (preset === '6m') {
          const d = new Date();
          d.setMonth(d.getMonth() - 6);
          startDateInput.value = d.toISOString().split('T')[0];
          endDateInput.value = today;
        }
      }
      onFilterChange();
    });
  });

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', () => closeDiagnosticModal());
  }

  if (diagnosticModal) {
    // Close on backdrop click
    diagnosticModal.addEventListener('click', (e) => {
      const rect = diagnosticModal.getBoundingClientRect();
      const isInDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
                          rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
      if (!isInDialog) {
        closeDiagnosticModal();
      }
    });

    // Close on Escape & trap tab focus
    diagnosticModal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDiagnosticModal();
        return;
      }
      if (e.key === 'Tab') {
        const focusables = diagnosticModal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            last.focus();
            e.preventDefault();
          }
        } else {
          if (document.activeElement === last) {
            first.focus();
            e.preventDefault();
          }
        }
      }
    });
  }

  window.addEventListener('hashchange', () => {
    if (activeSection === 'historical') {
      renderHistoricalRankings();
    }
  });

  await loadData();

  if (state.player) {
    openDiagnosticModal(state.player);
  }
}

function getActiveSystem() {
  if (activeSection === 'power_rankings') return 'custom';
  if (activeSection === 'historical') return 'historical';
  return activeSubsection || 'overview';
}

function syncDateInputsDisabledState() {
  const isHistorical = modeFilter.value === 'historical';
  startDateInput.disabled = isHistorical;
  endDateInput.disabled = isHistorical;
}

function getCurrentFilterState() {
  const isHistorical = modeFilter.value === 'historical';
  return {
    section: activeSection,
    game: gameFilter.value,
    system: getActiveSystem(),
    mode: modeFilter.value,
    start: isHistorical ? '' : startDateInput.value,
    end: isHistorical ? '' : endDateInput.value,
    search: playerSearch.value.trim()
  };
}

async function onFilterChange(event) {
  if (event && event.target === gameFilter) {
    selectedInspectorPlayerId = null;
  }
  syncDateInputsDisabledState();
  visibleCount = batchSize;
  const state = getCurrentFilterState();
  updateURLState(state);
  await loadData();
}

let historicalRankingsData = null;
const historicalArticlesCache = {};

async function fetchHistoricalArticle(id) {
  if (historicalArticlesCache[id]) return historicalArticlesCache[id];
  try {
    const res = await fetch(`data/rankings/${encodeURIComponent(id)}.json`);
    if (res.ok) {
      const data = await res.json();
      historicalArticlesCache[id] = data;
      return data;
    }
  } catch (err) {
    // Article might not exist yet as individual JSON, fall back gracefully
  }
  return null;
}

function getRankingTop3(r, article) {
  if (article && Array.isArray(article.players) && article.players.length > 0) {
    return article.players.slice(0, 3).map((p, idx) => ({
      placement: p.placement || idx + 1,
      tag: p.tag || p.player || `Player${idx + 1}`
    }));
  }
  if (Array.isArray(r.top3) && r.top3.length > 0) {
    return r.top3.slice(0, 3).map((tag, idx) => ({
      placement: idx + 1,
      tag: tag
    }));
  }
  if (r.top) {
    return [{ placement: 1, tag: r.top }];
  }
  return [];
}

async function renderHistoricalRankings() {
  if (!historicalRankingsData) {
    try {
      const res = await fetch('data/rankings.json');
      if (res.ok) {
        historicalRankingsData = await res.json();
      }
    } catch (e) {
      rankingsContent.innerHTML = '<div class="empty glass">Could not load historical rankings data.</div>';
      return;
    }
  }

  if (!historicalRankingsData || !historicalRankingsData.games) {
    rankingsContent.innerHTML = '<div class="empty glass">No historical rankings available.</div>';
    return;
  }

  const games = historicalRankingsData.games;
  const rawHash = location.hash.replace(/^#/, '');
  const isAll = !rawHash || rawHash === 'all';
  const selectedGame = isAll ? null : (games.find(g => g.id === rawHash || g.slug === rawHash) || null);

  const md = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const period = (s, e) => s.slice(0, 4) === e.slice(0, 4)
    ? `${md(s)} – ${md(e)}, ${e.slice(0, 4)}`
    : `${md(s)}, ${s.slice(0, 4)} – ${md(e)}, ${e.slice(0, 4)}`;

  let items = [];
  if (isAll || !selectedGame) {
    games.forEach(g => {
      const gRankings = historicalRankingsData.rankings[g.id] || [];
      gRankings.forEach(r => {
        items.push({ ...r, gameName: g.name, gameSlug: g.slug });
      });
    });
  } else {
    items = (historicalRankingsData.rankings[selectedGame.id] || []).map(r => ({
      ...r,
      gameName: selectedGame.name,
      gameSlug: selectedGame.slug
    }));
  }

  items.sort((a, b) => b.end.localeCompare(a.end));

  let listHtml = '';
  if (!items.length) {
    listHtml = '<div class="empty glass">No rankings published for this selection yet.</div>';
  } else {
    // Fetch article details in parallel if available to show top 3 players
    const articles = await Promise.all(items.map(r => fetchHistoricalArticle(r.id)));

    let lastYear = '';
    listHtml = items.map((r, index) => {
      const year = r.end.slice(0, 4);
      const label = year === lastYear ? '' : year;
      lastYear = year;
      const article = articles[index];
      const top3 = getRankingTop3(r, article);

      let top3Html = '';
      if (top3.length > 0) {
        top3Html = top3.map(p => `<span class="top-player-item"><b class="mono p${p.placement}">#${p.placement}</b> ${esc(p.tag)}</span>`).join('<span class="dot-sep">·</span>');
      }

      return `<div class="rk"><div class="yr mono">${label}</div>
        <a class="card glass" href="ranking.html?id=${encodeURIComponent(r.id)}">
          <div class="hub-icon-col">
            <img class="hub-icon" src="assets/hubs/${esc(r.gameSlug)}.webp" alt="" onerror="this.onerror=null; this.src='assets/players/${esc(r.gameSlug)}.png'; this.style.display=this.src.includes('undefined')?'none':'block';">
          </div>
          <div class="main">
            <!-- Row 1: Ranking Identity -->
            <div class="row-identity">
              <span class="name">${esc(r.name)}</span>
              <span class="status ${r.status === 'yearly' || r.status === 'current' ? 'yearly' : 'seasonal'}">${r.status === 'yearly' || r.status === 'current' ? (window.i18n ? window.i18n.t('historical.yearly') : 'YEARLY') : (window.i18n ? window.i18n.t('historical.seasonal') : 'SEASONAL')}</span>
            </div>

            <!-- Row 2: Ranking Details -->
            <div class="row-details">
              <span class="glass pill chip">${esc(r.gameName)}</span>
              <span class="period mono">${period(r.start, r.end)}</span>
            </div>

            <!-- Row 3: Ranking Summary & Action -->
            <div class="row-summary">
              <div class="top-three mono">
                ${top3Html}
              </div>
              <span class="dot-sep">·</span>
              <span class="players-count mono muted">${r.players} players</span>
              <span class="view-link mono">View Ranking →</span>
            </div>
          </div>
        </a></div>`;
    }).join('');
  }

  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const allActive = isAll || !selectedGame;
  const gameSwitches = [
    `<a class="${allActive ? 'on' : ''}" href="#all">${isEs ? 'Todos los juegos' : 'All games'}</a>`,
    ...games.map(g =>
      `<a class="${!allActive && selectedGame && selectedGame.id === g.id ? 'on' : ''}" href="#${esc(g.id)}">${esc(g.name)}</a>`
    )
  ].join('');

  const displayTitle = (isAll || !selectedGame)
    ? (isEs ? 'Power rankings de todos los juegos' : 'All games power rankings')
    : (isEs ? `Power rankings de ${esc(selectedGame.name)}` : `${esc(selectedGame.name)} power rankings`);

  rankingsContent.innerHTML = `
    <section class="head-panel glass">
      <div class="historical-head-actions">
        <div>
          <div class="eyebrow mono">${isEs ? 'POWER RANKINGS HISTÓRICOS' : 'HISTORICAL POWER RANKINGS'}</div>
          <h2 class="display" style="font-size:36px; margin: 8px 0;">${displayTitle}</h2>
          <p class="muted lead">${isEs ? 'Los rankings son publicados por la comunidad de cada juego. Más recientes primero.' : 'Rankings are published by each game’s community. Newest first.'}</p>
        </div>
        <a href="ranking-creator.html" class="create-ranking-btn">
          <span style="font-size: 18px; line-height: 1;">+</span>
          <span>${isEs ? 'Crear' : 'Create'}</span>
        </a>
      </div>
      <nav id="switch" class="switch glass pill" aria-label="Game Switcher">
        ${gameSwitches}
      </nav>
    </section>
    <div id="list" class="list-col">
      ${listHtml}
    </div>
  `;
}

async function loadData() {
  if (activeSection === 'historical') {
    if (activeFetchController) {
      activeFetchController.abort();
    }
    cleanupObserver();
    const controlsPanel = $('.ranking-controls-panel');
    if (controlsPanel) controlsPanel.style.display = 'none';
    if (rankingStatus) rankingStatus.style.display = 'none';
    renderHistoricalRankings();
    return;
  }

  const controlsPanel = $('.ranking-controls-panel');
  if (controlsPanel) controlsPanel.style.display = '';
  if (rankingStatus) rankingStatus.style.display = '';

  if (activeFetchController) {
    activeFetchController.abort();
  }
  activeFetchController = new AbortController();
  const signal = activeFetchController.signal;

  const requestId = ++currentRequestId;
  const game = gameFilter.value;
  const system = getActiveSystem();
  const mode = modeFilter.value;
  const isHistorical = mode === 'historical';
  const start = isHistorical ? '' : startDateInput.value;
  const end = isHistorical ? '' : endDateInput.value;
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');

  if (mode === 'period_only' && !start && !end) {
    const msg = isEs
      ? 'Selecciona una fecha de inicio, fecha de fin o rango de fechas para el modo Solo período.'
      : 'Please select a start date, an end date, or a date range for Period-only mode.';
    rankingStatus.textContent = msg;
    rankingsContent.innerHTML = `<div class="panel glass empty-state"><h2>${isEs ? 'Rango de Fechas Requerido' : 'Date Range Required'}</h2><p class="muted">${msg}</p></div>`;
    return;
  }

  if (mode === 'period_performance' && !start) {
    const msg = isEs
      ? 'Selecciona una fecha de inicio para el modo Desempeño en período.'
      : 'Period performance mode requires a start date to establish pre-period ratings.';
    rankingStatus.textContent = msg;
    rankingsContent.innerHTML = `<div class="panel glass empty-state"><h2>${isEs ? 'Fecha de Inicio Requerida' : 'Start Date Required'}</h2><p class="muted">${msg}</p></div>`;
    return;
  }

  if (!isHistorical && start && end && start > end) {
    const msg = isEs
      ? 'Rango de fechas inválido: La fecha de inicio debe ser anterior o igual a la de fin.'
      : 'Invalid date range: Start date must be before or on end date.';
    rankingStatus.textContent = msg;
    rankingsContent.innerHTML = `<div class="panel glass empty-state"><h2>${isEs ? 'Rango de Fechas Inválido' : 'Invalid Date Range'}</h2><p class="muted">${msg}</p></div>`;
    return;
  }

  rankingStatus.textContent = 'Calculating rankings…';

  try {
    if (system === 'custom') {
      // Prioritize loading and displaying the Formula Budget box before starting/displaying calculated rankings
      comparisonData = null;
      renderCustomPowerRankingsLoading();
      const systems = ['glicko2', 'sof', 'quality_wins', 'loss_quality'];
      const newCompData = {};
      for (const sys of systems) {
        const data = await fetchSystemData(game, sys, mode, start, end, signal);
        if (requestId !== currentRequestId || signal.aborted) return;
        if (data && data.error) {
          rankingStatus.textContent = `Error: ${data.error}`;
          rankingsContent.innerHTML = `<div class="panel glass empty-state"><h2>Calculation Error</h2><p class="muted">${esc(data.error)}</p></div>`;
          return;
        }
        newCompData[sys] = data;
      }
      if (requestId !== currentRequestId || signal.aborted) return;
      comparisonData = newCompData;
      rankingStatus.textContent = `Displaying Power Rankings for ${getGameName(game)}`;
      render();
      return;
    }

    if (system === 'comparison' || system === 'overview') {
      const systems = ['glicko2', 'sof', 'quality_wins', 'loss_quality'];
      const newCompData = {};
      for (const sys of systems) {
        const data = await fetchSystemData(game, sys, mode, start, end, signal);
        if (requestId !== currentRequestId || signal.aborted) return;
        if (data && data.error) {
          rankingStatus.textContent = `Error: ${data.error}`;
          rankingsContent.innerHTML = `<div class="panel glass empty-state"><h2>Calculation Error</h2><p class="muted">${esc(data.error)}</p></div>`;
          return;
        }
        newCompData[sys] = data;
      }
      if (requestId !== currentRequestId || signal.aborted) return;
      comparisonData = newCompData;
      rankingStatus.textContent = `Displaying rankings overview for ${getGameName(game)}`;
      render();
      return;
    }

    const data = await fetchSystemData(game, system, mode, start, end, signal);
    if (requestId !== currentRequestId || signal.aborted) return;

    if (data && data.error) {
      currentData = null;
      rankingStatus.textContent = `Error: ${data.error}`;
      rankingsContent.innerHTML = `<div class="panel glass empty-state"><h2>Calculation Error</h2><p class="muted">${esc(data.error)}</p></div>`;
      return;
    }

    currentData = data;
    if (currentData && currentData.rankings) {
      rankingStatus.textContent = `${currentData.totalPlayers} player${currentData.totalPlayers === 1 ? '' : 's'} ranked in ${currentData.algorithm ? currentData.algorithm.name : system}`;
    } else {
      rankingStatus.textContent = 'No ranking data available.';
    }
    render();
  } catch (err) {
    if (err.name === 'AbortError') {
      return;
    }
    rankingStatus.textContent = `Error: ${err.message}`;
  }
}

// In-memory cache for loaded game JSON datasets and calculated ranking snapshots
const staticGameDataCache = new Map();
const calculatedRankingsCache = new Map();

async function getGameData(game, signal) {
  if (staticGameDataCache.has(game)) {
    return staticGameDataCache.get(game);
  }
  const url = `data/rankings/data/${encodeURIComponent(game)}.json`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Failed to load ranking data for ${game}`);
  }
  const json = await res.json();
  staticGameDataCache.set(game, json);
  return json;
}

async function fetchSystemData(game, system, mode, start, end, signal) {
  const cacheKey = `${game}_${system}_${mode}_${start || ''}_${end || ''}`;
  if (calculatedRankingsCache.has(cacheKey)) {
    return calculatedRankingsCache.get(cacheKey);
  }

  // 1. If mode is historical (no date filter applied), load pre-calculated snapshot directly for fast load
  if (mode === 'historical') {
    const staticURL = `data/rankings/${encodeURIComponent(game)}-${encodeURIComponent(system)}-historical.json`;
    try {
      const res = await fetch(staticURL, { signal });
      if (res.ok) {
        const json = await res.json();
        calculatedRankingsCache.set(cacheKey, json);
        return json;
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
  }

  // 2. Perform client-side ranking calculation using static game data
  try {
    const gameData = await getGameData(game, signal);
    if (window.ClientRankingEngine) {
      const engine = new window.ClientRankingEngine(gameData);
      const computed = engine.calculate(system, mode, start || null, end || null, null);
      calculatedRankingsCache.set(cacheKey, computed);
      return computed;
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { error: err.message };
  }

  return null;
}

function getGameName(slug) {
  const g = availableGames.find(item => item.slug === slug);
  return g ? g.name : slug;
}

// Power Rankings Custom Weights State & Logic
const PR_COMPONENTS = {
  glicko2: { name: 'Glicko-2', color: '#38BDF8' },
  quality_wins: { name: 'Quality Wins', color: '#F5C542' },
  sof: { name: 'Strength of Field', color: '#34D399' },
  loss_quality: { name: 'Consistency', color: '#A78BFA' }
};

const DEFAULT_PR_WEIGHTS = {
  glicko2: 55.0,
  quality_wins: 20.0,
  sof: 15.0,
  loss_quality: 10.0
};

const DEFAULT_PR_ACTIVE = {
  glicko2: true,
  quality_wins: true,
  sof: true,
  loss_quality: true
};

let prWeights = loadSavedPRWeights();
let prActiveComponents = loadSavedPRActive();
let selectedInspectorPlayerId = null;

function loadSavedPRWeights() {
  try {
    const saved = localStorage.getItem('platfighters_pr_weights');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed === 'object' && parsed !== null) {
        return {
          glicko2: Math.max(0, parseFloat(parsed.glicko2) || 0),
          quality_wins: Math.max(0, parseFloat(parsed.quality_wins) || 0),
          sof: Math.max(0, parseFloat(parsed.sof) || 0),
          loss_quality: Math.max(0, parseFloat(parsed.loss_quality) || 0)
        };
      }
    }
  } catch (e) {}
  return { ...DEFAULT_PR_WEIGHTS };
}

function loadSavedPRActive() {
  try {
    const saved = localStorage.getItem('platfighters_pr_active');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed === 'object' && parsed !== null) {
        return {
          glicko2: Boolean(parsed.glicko2),
          quality_wins: Boolean(parsed.quality_wins),
          sof: Boolean(parsed.sof),
          loss_quality: Boolean(parsed.loss_quality)
        };
      }
    }
  } catch (e) {}
  return { ...DEFAULT_PR_ACTIVE };
}

function savePRState() {
  try {
    localStorage.setItem('platfighters_pr_weights', JSON.stringify(prWeights));
    localStorage.setItem('platfighters_pr_active', JSON.stringify(prActiveComponents));
  } catch (e) {}
}

function calculateRedistributedWeights(changedSys, newWeightInput, baseWeights, activeComponents) {
  let val = Math.max(0, Math.min(100, parseFloat(newWeightInput) || 0));
  const newWeights = { ...baseWeights };

  const activeKeys = Object.keys(PR_COMPONENTS).filter(k => activeComponents[k]);
  if (!activeKeys.includes(changedSys)) {
    activeKeys.push(changedSys);
  }

  if (activeKeys.length <= 1) {
    activeKeys.forEach(k => { newWeights[k] = 100.0; });
    return newWeights;
  }

  const otherKeys = activeKeys.filter(k => k !== changedSys);
  const sumOthers = otherKeys.reduce((acc, k) => acc + (baseWeights[k] || 0), 0);
  const remainingBudget = 100.0 - val;

  newWeights[changedSys] = val;

  if (sumOthers > 0) {
    otherKeys.forEach(k => {
      newWeights[k] = ((baseWeights[k] || 0) / sumOthers) * remainingBudget;
    });
  } else {
    const equalShare = remainingBudget / otherKeys.length;
    otherKeys.forEach(k => {
      newWeights[k] = equalShare;
    });
  }

  Object.keys(PR_COMPONENTS).forEach(k => {
    if (!activeComponents[k]) {
      newWeights[k] = 0.0;
    }
  });

  return newWeights;
}

function redistributePRWeights(changedSys, newWeightInput) {
  if (!prActiveComponents[changedSys]) {
    prActiveComponents[changedSys] = true;
  }
  prWeights = calculateRedistributedWeights(changedSys, newWeightInput, prWeights, prActiveComponents);
  savePRState();
}

function togglePRComponent(sysKey, isChecked) {
  if (!isChecked) {
    const activeKeys = Object.keys(PR_COMPONENTS).filter(k => prActiveComponents[k]);
    if (activeKeys.length <= 1) {
      return;
    }
    prActiveComponents[sysKey] = false;
    prWeights[sysKey] = 0.0;

    const remainingKeys = Object.keys(PR_COMPONENTS).filter(k => prActiveComponents[k]);
    const remainingSum = remainingKeys.reduce((acc, k) => acc + prWeights[k], 0);
    if (remainingSum > 0) {
      remainingKeys.forEach(k => {
        prWeights[k] = (prWeights[k] / remainingSum) * 100.0;
      });
    } else {
      const equalShare = 100.0 / remainingKeys.length;
      remainingKeys.forEach(k => {
        prWeights[k] = equalShare;
      });
    }
  } else {
    prActiveComponents[sysKey] = true;
    const activeKeys = Object.keys(PR_COMPONENTS).filter(k => prActiveComponents[k]);
    if (activeKeys.length === 1) {
      prWeights[sysKey] = 100.0;
    } else {
      const newShare = Math.min(25.0, 100.0 / activeKeys.length);
      redistributePRWeights(sysKey, newShare);
    }
  }
  savePRState();
}

function getDisplayPRWeights(weights = prWeights, activeComponents = prActiveComponents) {
  const activeKeys = Object.keys(PR_COMPONENTS).filter(k => activeComponents[k]);
  const result = { glicko2: 0, quality_wins: 0, sof: 0, loss_quality: 0 };
  if (activeKeys.length === 0) return result;

  let sumFloors = 0;
  const items = [];

  activeKeys.forEach(k => {
    const rawVal = weights[k] || 0;
    const floorVal = Math.floor(rawVal);
    const rem = rawVal - floorVal;
    result[k] = floorVal;
    sumFloors += floorVal;
    items.push({ key: k, rem: rem });
  });

  let deficit = 100 - sumFloors;
  items.sort((a, b) => {
    if (Math.abs(b.rem - a.rem) > 1e-6) {
      return b.rem - a.rem;
    }
    return a.key.localeCompare(b.key);
  });

  for (let i = 0; i < deficit && i < items.length; i++) {
    result[items[i].key] += 1;
  }

  return result;
}

function computePRLeaderboard() {
  if (!comparisonData || !Object.keys(comparisonData).length) {
    return { players: [], minMax: {} };
  }

  const sysKeys = Object.keys(PR_COMPONENTS);
  const playersMap = new Map();

  sysKeys.forEach(sys => {
    const sysData = comparisonData[sys];
    if (sysData && sysData.rankings) {
      sysData.rankings.forEach(p => {
        if (!playersMap.has(p.playerId)) {
          playersMap.set(p.playerId, {
            playerId: p.playerId,
            playerTag: p.playerTag,
            rawScores: {},
            matches: 0,
            events: 0
          });
        }
        const pObj = playersMap.get(p.playerId);
        pObj.rawScores[sys] = p.score;
        pObj.matches = Math.max(pObj.matches, p.matches || 0);
        pObj.events = Math.max(pObj.events, p.events || 0);
        if (p.baselineScore !== undefined && p.baselineScore !== null) pObj.baselineScore = p.baselineScore;
        if (p.change !== undefined && p.change !== null) pObj.change = p.change;
      });
    }
  });

  const allPlayers = Array.from(playersMap.values());
  if (!allPlayers.length) return { players: [], minMax: {} };

  const minMax = {};
  sysKeys.forEach(sys => {
    const scores = allPlayers.map(p => p.rawScores[sys] !== undefined ? p.rawScores[sys] : 0);
    const minVal = Math.min(...scores);
    const maxVal = Math.max(...scores);
    minMax[sys] = { min: minVal, max: maxVal };
  });

  const displayWeights = getDisplayPRWeights();

  const computedPlayers = allPlayers.map(p => {
    const normalized = {};
    const contributions = {};
    let totalScore = 0;

    sysKeys.forEach(sys => {
      const raw = p.rawScores[sys] !== undefined ? p.rawScores[sys] : 0;
      const { min, max } = minMax[sys];
      let norm = 0;
      if (max > min) {
        norm = ((raw - min) / (max - min)) * 100.0;
      } else {
        norm = 100.0;
      }
      normalized[sys] = norm;

      const w = prActiveComponents[sys] ? (prWeights[sys] || 0) : 0;
      const contrib = (norm * w) / 100.0;
      contributions[sys] = contrib;
      totalScore += contrib;
    });

    return {
      playerId: p.playerId,
      playerTag: p.playerTag,
      score: Math.round(totalScore * 10) / 10,
      exactTotalScore: totalScore,
      rawScores: p.rawScores,
      normalizedScores: normalized,
      weightedContributions: contributions,
      matches: p.matches,
      events: p.events,
      baselineScore: p.baselineScore,
      change: p.change
    };
  });

  computedPlayers.sort((a, b) => b.exactTotalScore - a.exactTotalScore);
  computedPlayers.forEach((p, idx) => { p.rank = idx + 1; });

  return { players: computedPlayers, minMax };
}

let prDraftWeights = null;

window.onPRWeightInput = function(sysKey, value) {
  prDraftWeights = calculateRedistributedWeights(sysKey, value, prWeights, prActiveComponents);
  const displayWeights = getDisplayPRWeights(prDraftWeights, prActiveComponents);

  Object.keys(PR_COMPONENTS).forEach(k => {
    const isActive = prActiveComponents[k];
    const dispW = displayWeights[k] || 0;

    const slider = $(`input.pr-slider[data-sys="${k}"]`);
    if (slider && document.activeElement !== slider) {
      slider.value = dispW;
    }

    const numInput = $(`input.pr-number-input[data-sys="${k}"]`);
    if (numInput && document.activeElement !== numInput) {
      numInput.value = dispW;
    }

    const badge = $(`.pr-card-badge[data-sys="${k}"]`);
    if (badge) {
      badge.textContent = `${dispW}%`;
    }

    const fill = $(`.pr-card-contrib-fill[data-sys="${k}"]`);
    if (fill) {
      fill.style.width = `${dispW}%`;
    }

    const segment = $(`.pr-stacked-segment[data-sys="${k}"]`);
    if (segment) {
      segment.style.width = `${isActive ? dispW : 0}%`;
    }

    const legendText = $(`.pr-legend-text[data-sys="${k}"]`);
    if (legendText) {
      legendText.textContent = isActive ? `${dispW}%` : 'Disabled';
    }
  });
};

window.onPRWeightCommit = function(sysKey, value) {
  redistributePRWeights(sysKey, value);
  prDraftWeights = null;
  renderCustomPowerRankings();
};

window.onPRWeightChange = function(sysKey, value) {
  onPRWeightCommit(sysKey, value);
};

window.onPRToggleComponent = function(sysKey, isChecked) {
  togglePRComponent(sysKey, isChecked);
  renderCustomPowerRankings();
};

window.onPRSelectPlayer = function(playerId) {
  selectedInspectorPlayerId = playerId;
  renderCustomPowerRankings();
};

window.resetToDefaultPRWeights = function() {
  prWeights = { ...DEFAULT_PR_WEIGHTS };
  prActiveComponents = { ...DEFAULT_PR_ACTIVE };
  savePRState();
  renderCustomPowerRankings();
};

window.createPRFromCurrentRankings = function() {
  const { players: leaderboard } = computePRLeaderboard();
  const currentGameSlug = gameFilter.value || 'ultimate';
  const gameObj = availableGames.find(g => g.slug === currentGameSlug) || { slug: currentGameSlug, name: currentGameSlug };

  // Capture snapshot without modifying any existing rankings data
  const snapshot = {
    game: {
      id: gameObj.id || gameObj.slug,
      name: gameObj.name,
      slug: gameObj.slug
    },
    capturedAt: new Date().toISOString(),
    players: leaderboard.map((p, idx) => ({
      placement: idx + 1,
      tag: p.playerTag,
      points: Math.round(p.score),
      photo: `assets/players/${p.playerId}.png`,
      playerId: p.playerId
    }))
  };

  try {
    sessionStorage.setItem('platfighters_pr_snapshot', JSON.stringify(snapshot));
  } catch (e) {
    console.error('Could not save PR snapshot to sessionStorage:', e);
  }

  // Navigate to ranking creator in PR creation mode
  window.location.href = 'ranking-creator.html?source=pr';
};

function renderInlineMiniBadges(playerTag) {
  return '';
}

function renderFormulaBudgetBox() {
  const displayWeights = getDisplayPRWeights();

  const stackedSegmentsHtml = Object.keys(PR_COMPONENTS).map(sysKey => {
    const w = displayWeights[sysKey] || 0;
    const color = PR_COMPONENTS[sysKey].color;
    return `<div class="pr-stacked-segment" data-sys="${sysKey}" style="width: ${prActiveComponents[sysKey] ? w : 0}%; background-color: ${color};" title="${PR_COMPONENTS[sysKey].name}: ${w}%"></div>`;
  }).join('');

  const legendHtml = Object.keys(PR_COMPONENTS).map(sysKey => {
    const w = displayWeights[sysKey] || 0;
    const color = PR_COMPONENTS[sysKey].color;
    const isActive = prActiveComponents[sysKey];
    return `
      <div class="pr-legend-item ${isActive ? '' : 'muted'}">
        <span class="pr-legend-swatch" style="background-color: ${isActive ? color : '#666'};"></span>
        <span><b>${PR_COMPONENTS[sysKey].name}</b>: <span class="pr-legend-text" data-sys="${sysKey}">${isActive ? w + '%' : 'Disabled'}</span></span>
      </div>
    `;
  }).join('');

  const controlsGridHtml = Object.keys(PR_COMPONENTS).map(sysKey => {
    const meta = PR_COMPONENTS[sysKey];
    const isActive = prActiveComponents[sysKey];
    const dispWeight = displayWeights[sysKey] || 0;

    return `
      <div class="pr-component-card ${isActive ? '' : 'inactive'}" style="border-left: 4px solid ${isActive ? meta.color : '#555'};">
        <div class="pr-card-head">
          <label class="pr-card-title check-label">
            <input type="checkbox" ${isActive ? 'checked' : ''} onchange="onPRToggleComponent('${sysKey}', this.checked)">
            <span>${meta.name}</span>
          </label>
          <span class="pr-card-badge mono" data-sys="${sysKey}" style="color: ${isActive ? meta.color : 'var(--muted)'};">${dispWeight}%</span>
        </div>
        <div class="pr-inputs-row">
          <input type="range" class="pr-slider" data-sys="${sysKey}" min="0" max="100" value="${dispWeight}" ${isActive ? '' : 'disabled'} oninput="onPRWeightInput('${sysKey}', this.value)" onchange="onPRWeightCommit('${sysKey}', this.value)" aria-label="${meta.name} Weight Slider">
          <input type="number" class="pr-number-input mono" data-sys="${sysKey}" min="0" max="100" value="${dispWeight}" ${isActive ? '' : 'disabled'} oninput="onPRWeightInput('${sysKey}', this.value)" onchange="onPRWeightCommit('${sysKey}', this.value)" aria-label="${meta.name} Weight Input">%
        </div>
        <div class="pr-contrib-bar-wrap">
          <div class="pr-contrib-bar-fill pr-card-contrib-fill" data-sys="${sysKey}" style="width: ${dispWeight}%; background-color: ${isActive ? meta.color : '#555'};"></div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="panel glass pr-setup-panel">
      <div class="pr-header">
        <div>
          <div class="eyebrow mono">CUSTOM POWER RANKINGS CREATOR</div>
          <h2 style="margin:4px 0 0; font-size:26px;">Linked Weights &amp; Formula Budget</h2>
        </div>
        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
          <button class="quiet-button mono" style="font-size:12px; padding:6px 12px; border:1px solid rgba(255,255,255,0.2); border-radius:6px; cursor:pointer;" onclick="resetToDefaultPRWeights()">${(window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es') ? 'Restablecer Valores (55/20/15/10)' : 'Reset to Defaults (55/20/15/10)'}</button>
          <div class="pr-total-badge mono" id="pr-total-badge">
            ${(window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es') ? 'PESO TOTAL:' : 'TOTAL WEIGHT:'} <b>100%</b>
          </div>
        </div>
      </div>

      <p class="muted" style="margin-bottom:8px; font-size:14px;">
        Adjust percentage shares to balance component systems. Increasing one component automatically scales down others proportionally to maintain an exact 100% total.
      </p>

      <p class="mono muted" style="margin-bottom:16px; font-size:12px; color:var(--sky);">
        💡 Recommended Starting Formula: <b>55% Glicko-2</b> · <b>20% Quality Wins</b> · <b>15% Strength of Field</b> · <b>10% Consistency</b>
      </p>

      <div class="pr-stacked-container">
        <div class="pr-stacked-bar" aria-label="Stacked weight configuration visualization">
          ${stackedSegmentsHtml}
        </div>
        <div class="pr-legend">
          ${legendHtml}
        </div>
      </div>

      <div class="pr-controls-grid">
        ${controlsGridHtml}
      </div>

      <details class="pr-guide-box">
        <summary>💡 Formula Distinction: Weight vs. Normalized Score vs. Weighted Contribution</summary>
        <p>
          • <b>Weight (%):</b> How important a ranking system is in the custom formula configuration budget.<br>
          • <b>Normalized Score (0–100):</b> How a particular player performs on that system relative to the eligible player population (scaled from 0 = lowest to 100 = highest in active scope).<br>
          • <b>Weighted Contribution (pts):</b> <code>(Normalized Score × Weight) / 100</code>. How much that component contributes to the player's final custom score.
        </p>
      </details>
    </div>
  `;
}

function renderCustomPowerRankingsLoading() {
  cleanupObserver();
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const budgetBoxHtml = renderFormulaBudgetBox();

  const loadingHtml = `
    ${budgetBoxHtml}
    <div class="panel glass ranking-table-panel">
      <div class="pr-table-toolbar">
        <button class="pr-create-pill-btn mono" disabled style="opacity:0.5; cursor:not-allowed;">
          ${isEs ? 'CREAR PR' : 'CREATE PR'}
        </button>
      </div>
      <div class="pr-loading-container">
        <div class="pr-spinner"></div>
        <span class="pr-loading-text mono">${isEs ? 'Calculando Power Rankings…' : 'Calculating Power Rankings…'}</span>
        <div class="pr-skeleton-table">
          <div class="pr-skeleton-row"></div>
          <div class="pr-skeleton-row"></div>
          <div class="pr-skeleton-row"></div>
          <div class="pr-skeleton-row"></div>
          <div class="pr-skeleton-row"></div>
        </div>
      </div>
    </div>
  `;

  rankingsContent.innerHTML = loadingHtml;
}

function renderCustomPowerRankings() {
  cleanupObserver();

  if (!comparisonData || !Object.keys(comparisonData).length) {
    const budgetBoxHtml = renderFormulaBudgetBox();
    const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
    rankingsContent.innerHTML = `
      ${budgetBoxHtml}
      <div class="panel glass empty-state">
        <h2>${isEs ? 'Sin datos de Power Rankings' : 'No Power Rankings data'}</h2>
        <p class="muted">${isEs ? 'No se encontraron resultados para la selección.' : 'No results found for this selection.'}</p>
      </div>
    `;
    return;
  }

  const { players: leaderboard } = computePRLeaderboard();
  const displayWeights = getDisplayPRWeights();
  const activeKeys = Object.keys(PR_COMPONENTS).filter(k => prActiveComponents[k]);

  let inspectedPlayer = leaderboard.find(p => p.playerId === selectedInspectorPlayerId);
  if (!inspectedPlayer && leaderboard.length > 0) {
    inspectedPlayer = leaderboard[0];
    selectedInspectorPlayerId = inspectedPlayer.playerId;
  }

  const query = playerSearch.value.trim().toLowerCase();
  let list = leaderboard.filter(p => p.playerTag.toLowerCase().includes(query));

  list.sort((a, b) => {
    let valA = a[sortCol];
    let valB = b[sortCol];
    if (typeof valA === 'string') {
      return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    const numA = (valA !== undefined && valA !== null) ? valA : (sortAsc ? 9999999 : -9999999);
    const numB = (valB !== undefined && valB !== null) ? valB : (sortAsc ? 9999999 : -9999999);
    return sortAsc ? (numA - numB) : (numB - numA);
  });

  const totalFiltered = list.length;
  const visibleList = list.slice(0, visibleCount);

  const stackedSegmentsHtml = Object.keys(PR_COMPONENTS).map(sysKey => {
    const w = displayWeights[sysKey] || 0;
    const color = PR_COMPONENTS[sysKey].color;
    return `<div class="pr-stacked-segment" data-sys="${sysKey}" style="width: ${prActiveComponents[sysKey] ? w : 0}%; background-color: ${color};" title="${PR_COMPONENTS[sysKey].name}: ${w}%"></div>`;
  }).join('');

  const legendHtml = Object.keys(PR_COMPONENTS).map(sysKey => {
    const w = displayWeights[sysKey] || 0;
    const color = PR_COMPONENTS[sysKey].color;
    const isActive = prActiveComponents[sysKey];
    return `
      <div class="pr-legend-item ${isActive ? '' : 'muted'}">
        <span class="pr-legend-swatch" style="background-color: ${isActive ? color : '#666'};"></span>
        <span><b>${PR_COMPONENTS[sysKey].name}</b>: <span class="pr-legend-text" data-sys="${sysKey}">${isActive ? w + '%' : 'Disabled'}</span></span>
      </div>
    `;
  }).join('');

  const controlsGridHtml = Object.keys(PR_COMPONENTS).map(sysKey => {
    const meta = PR_COMPONENTS[sysKey];
    const isActive = prActiveComponents[sysKey];
    const dispWeight = displayWeights[sysKey] || 0;

    return `
      <div class="pr-component-card ${isActive ? '' : 'inactive'}" style="border-left: 4px solid ${isActive ? meta.color : '#555'};">
        <div class="pr-card-head">
          <label class="pr-card-title check-label">
            <input type="checkbox" ${isActive ? 'checked' : ''} onchange="onPRToggleComponent('${sysKey}', this.checked)">
            <span>${meta.name}</span>
          </label>
          <span class="pr-card-badge mono" data-sys="${sysKey}" style="color: ${isActive ? meta.color : 'var(--muted)'};">${dispWeight}%</span>
        </div>
        <div class="pr-inputs-row">
          <input type="range" class="pr-slider" data-sys="${sysKey}" min="0" max="100" value="${dispWeight}" ${isActive ? '' : 'disabled'} oninput="onPRWeightInput('${sysKey}', this.value)" onchange="onPRWeightCommit('${sysKey}', this.value)" aria-label="${meta.name} Weight Slider">
          <input type="number" class="pr-number-input mono" data-sys="${sysKey}" min="0" max="100" value="${dispWeight}" ${isActive ? '' : 'disabled'} oninput="onPRWeightInput('${sysKey}', this.value)" onchange="onPRWeightCommit('${sysKey}', this.value)" aria-label="${meta.name} Weight Input">%
        </div>
        <div class="pr-contrib-bar-wrap">
          <div class="pr-contrib-bar-fill pr-card-contrib-fill" data-sys="${sysKey}" style="width: ${dispWeight}%; background-color: ${isActive ? meta.color : '#555'};"></div>
        </div>
      </div>
    `;
  }).join('');

  let inspectorHtml = '';
  if (inspectedPlayer) {
    const p = inspectedPlayer;
    let sumContribs = 0;

    const inspectorRowsHtml = Object.keys(PR_COMPONENTS).map(sysKey => {
      const meta = PR_COMPONENTS[sysKey];
      const isActive = prActiveComponents[sysKey];
      const w = displayWeights[sysKey] || 0;
      const normScore = Math.round((p.normalizedScores[sysKey] || 0) * 10) / 10;
      const contrib = Math.round((p.weightedContributions[sysKey] || 0) * 10) / 10;
      if (isActive) sumContribs += contrib;

      return `
        <div class="pr-inspector-row">
          <span style="color: ${isActive ? meta.color : 'var(--muted)'}; font-weight:600;">${meta.name}</span>
          <span class="mono muted">Weight: <b>${isActive ? w + '%' : '0%'}</b></span>
          <span class="mono muted">Norm: <b>${normScore}</b>/100</span>
          <div class="pr-contrib-bar-wrap" style="height:10px;">
            <div class="pr-contrib-bar-fill" style="width: ${Math.min(100, contrib)}%; background-color: ${isActive ? meta.color : '#555'};"></div>
          </div>
          <span class="mono font-bold" style="color: ${isActive ? meta.color : 'var(--muted)'};">+${contrib} pts</span>
        </div>
      `;
    }).join('');

    const roundedSumContribs = Math.round(sumContribs * 10) / 10;

    inspectorHtml = `
      <div class="pr-inspector-head">
        <div>
          <span class="eyebrow mono">PLAYER CONTRIBUTION INSPECTOR</span>
          <h3 style="margin:2px 0 0; font-size:20px;">
            ${esc(p.playerTag)} <span class="muted font-normal">(Rank #${p.rank})</span>
          </h3>
        </div>
        <div style="display:flex; align-items:center; gap:12px;">
          <label class="mono muted" style="font-size:12px;">INSPECT PLAYER:
            <select class="game-filter glass" style="min-width:180px; height:38px; padding:0 10px;" onchange="onPRSelectPlayer(this.value)">
              ${leaderboard.map(pl => `<option value="${esc(pl.playerId)}"${pl.playerId === p.playerId ? ' selected' : ''}>#${pl.rank} ${esc(pl.playerTag)} (${pl.score} pts)</option>`).join('')}
            </select>
          </label>
          <div class="badge mono" style="font-size:16px; font-weight:700; background:rgba(255,255,255,0.1); padding:8px 16px;">
            FINAL SCORE: <span style="color:var(--sky);">${p.score}</span>
          </div>
        </div>
      </div>

      <div class="pr-inspector-bars">
        ${inspectorRowsHtml}
      </div>

      <p class="mono muted" style="font-size:12px; margin-top:12px; text-align:right;">
        Reconciliation: ${Object.keys(PR_COMPONENTS).filter(k => prActiveComponents[k]).map(k => Math.round((p.weightedContributions[k]||0)*10)/10).join(' + ')} = <b>${roundedSumContribs} pts</b> (matches final score ${p.score})
      </p>
    `;
  }

  const budgetBoxHtml = renderFormulaBudgetBox();
  const isPeriodPerf = modeFilter.value === 'period_performance';
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const prGridCols = isPeriodPerf ? '55px minmax(170px,1.6fr) 95px 85px repeat(4, minmax(85px, 1fr)) 100px;' : '60px minmax(180px,1.8fr) 110px repeat(4, minmax(90px, 1fr)) 110px;';

  let html = `
    ${budgetBoxHtml}

    <div class="panel glass ranking-table-panel">
      <div class="pr-table-toolbar">
        <button class="pr-create-pill-btn mono" onclick="createPRFromCurrentRankings()">
          ${isEs ? 'CREAR PR' : 'CREATE PR'}
        </button>
      </div>
      <div class="table">
        <div class="tr head ranking-row" style="grid-template-columns: ${prGridCols}">
          <span class="sortable" onclick="changeSort('rank')">${isEs ? 'PUESTO' : 'RANK'} ${sortCol === 'rank' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span class="sortable" onclick="changeSort('playerTag')">${isEs ? 'JUGADOR' : 'PLAYER'} ${sortCol === 'playerTag' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span class="sortable" onclick="changeSort('score')">${isEs ? 'PUNTAJE' : 'SCORE'} ${sortCol === 'score' ? (sortAsc ? '▲' : '▼') : ''}</span>
          ${isPeriodPerf ? `<span class="sortable" onclick="changeSort('change')">${isEs ? 'CAMBIO' : 'CHANGE'} ${sortCol === 'change' ? (sortAsc ? '▲' : '▼') : ''}</span>` : ''}
          <span>GLICKO-2</span>
          <span>${isEs ? 'VICTORIAS CALIDAD' : 'QUALITY WINS'}</span>
          <span>SOF</span>
          <span>${isEs ? 'CONSISTENCIA' : 'CONSISTENCY'}</span>
          <span>${isEs ? 'ACCIONES' : 'ACTIONS'}</span>
        </div>

        ${visibleList.length ? visibleList.map(p => `
          <div class="tr ranking-row" style="grid-template-columns: ${prGridCols}; cursor:pointer;" onclick="onPRSelectPlayer('${esc(p.playerId)}')">
            <span class="rank-col font-bold ${p.rank && p.rank <= 3 ? 'p' + p.rank : ''}">#${p.rank}</span>
            <div class="player-col">
              <a href="index.html?player=${encodeURIComponent(p.playerId)}" class="player-card-link" onclick="event.stopPropagation();">
                <span class="player-avatar mini"><img src="assets/players/${esc(p.playerId)}.png" alt="" onerror="this.remove()"></span>
                <b>${esc(p.playerTag)}</b>
              </a>
            </div>
            <span class="score-col mono font-bold">${p.score}</span>
            ${isPeriodPerf ? `
              <span class="change-col mono font-bold ${p.change > 0 ? 'win' : (p.change < 0 ? 'loss' : 'muted')}">
                ${p.change !== undefined && p.change !== null ? (p.change > 0 ? `+${p.change}` : `${p.change}`) : '-'}
              </span>
            ` : ''}
            <span class="mono" style="color:${PR_COMPONENTS.glicko2.color};">${Math.round((p.weightedContributions.glicko2||0)*10)/10} <small class="muted">(${Math.round((p.normalizedScores.glicko2||0)*10)/10})</small></span>
            <span class="mono" style="color:${PR_COMPONENTS.quality_wins.color};">${Math.round((p.weightedContributions.quality_wins||0)*10)/10} <small class="muted">(${Math.round((p.normalizedScores.quality_wins||0)*10)/10})</small></span>
            <span class="mono" style="color:${PR_COMPONENTS.sof.color};">${Math.round((p.weightedContributions.sof||0)*10)/10} <small class="muted">(${Math.round((p.normalizedScores.sof||0)*10)/10})</small></span>
            <span class="mono" style="color:${PR_COMPONENTS.loss_quality.color};">${Math.round((p.weightedContributions.loss_quality||0)*10)/10} <small class="muted">(${Math.round((p.normalizedScores.loss_quality||0)*10)/10})</small></span>
            <div class="actions-col" onclick="event.stopPropagation();">
              <button class="quiet-button diagnostic-btn" onclick="openDiagnosticModal('${esc(p.playerId)}')">${isEs ? 'Diagnóstico' : 'Diagnostic'}</button>
            </div>
          </div>
        `).join('') : `<div class="empty-state"><p class="muted">${isEs ? 'Ningún jugador coincide con el filtro.' : 'No players match the search filter.'}</p></div>`}
      </div>

      ${totalFiltered > 0 ? `
        <div id="scroll-sentinel" class="infinite-scroll-sentinel mono muted">
          ${visibleCount < totalFiltered ? ((window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es') ? `Mostrando ${visibleList.length} de ${totalFiltered} jugadores (desplaza hacia abajo para cargar más…)` : `Showing ${visibleList.length} of ${totalFiltered} players (scroll down to load more…)`) : ((window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es') ? `Mostrando los ${totalFiltered} jugadores` : `Showing all ${totalFiltered} players`)}
        </div>
      ` : ''}
    </div>
  `;

  rankingsContent.innerHTML = html;
  bindSystemTabsEvents();
  setupInfiniteScroll(totalFiltered);
}

// Render Router
function render() {
  const system = getActiveSystem();
  if (system === 'custom') {
    renderCustomPowerRankings();
  } else if (system === 'overview' || system === 'comparison') {
    renderComparison();
  } else {
    renderIndividualSystem(system);
  }
}

function cleanupObserver() {
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
}

function setupInfiniteScroll(totalCount) {
  cleanupObserver();

  const sentinel = $('#scroll-sentinel');
  if (!sentinel || visibleCount >= totalCount) return;

  scrollObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      visibleCount += batchSize;
      render();
    }
  }, { rootMargin: '200px' });

  scrollObserver.observe(sentinel);
}

// Individual System View
function renderIndividualSystem(systemKey) {
  cleanupObserver();

  if (!currentData || !currentData.rankings) {
    rankingsContent.innerHTML = '<div class="panel glass empty-state"><h2>No ranking results</h2><p class="muted">No matches found for this game and date range.</p></div>';
    return;
  }

  const query = playerSearch.value.trim().toLowerCase();
  let list = currentData.rankings.filter(p => p.playerTag.toLowerCase().includes(query));

  // Sorting
  list.sort((a, b) => {
    let valA = a[sortCol];
    let valB = b[sortCol];
    if (typeof valA === 'string') {
      return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    const numA = (valA !== undefined && valA !== null) ? valA : (sortAsc ? 9999999 : -9999999);
    const numB = (valB !== undefined && valB !== null) ? valB : (sortAsc ? 9999999 : -9999999);
    return sortAsc ? (numA - numB) : (numB - numA);
  });

  const totalFiltered = list.length;
  const visibleList = list.slice(0, visibleCount);

  const sysInfo = currentData.algorithm || {};
  const isPeriodPerf = modeFilter.value === 'period_performance';
  const isEs = (window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es');
  const indGridCols = isPeriodPerf ? '55px minmax(160px,1.8fr) 95px 95px 85px minmax(130px, 1.2fr) 90px;' : '';

  let html = `
    <div class="panel glass system-banner">
      <h2>${esc(sysInfo.name || systemKey)} Rankings</h2>
      <p class="muted">${esc(sysInfo.description || getSystemDescription(systemKey))}</p>
    </div>

    ${renderSystemTabsNav()}

    <div class="panel glass ranking-table-panel">
      <div class="table">
        <div class="tr head ranking-row" style="${indGridCols ? `grid-template-columns: ${indGridCols}` : ''}">
          <span class="sortable" onclick="changeSort('rank')">${isEs ? 'PUESTO' : 'RANK'} ${sortCol === 'rank' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span class="sortable" onclick="changeSort('playerTag')">${isEs ? 'JUGADOR' : 'PLAYER'} ${sortCol === 'playerTag' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span class="sortable" onclick="changeSort('score')">${isEs ? 'PUNTAJE' : 'SCORE'} ${sortCol === 'score' ? (sortAsc ? '▲' : '▼') : ''}</span>
          ${isPeriodPerf ? `<span class="sortable" onclick="changeSort('change')">${isEs ? 'CAMBIO' : 'CHANGE'} ${sortCol === 'change' ? (sortAsc ? '▲' : '▼') : ''}</span>` : ''}
          <span class="sortable" onclick="changeSort('winRate')">${isEs ? '% VICTORIAS' : 'WIN %'} ${sortCol === 'winRate' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span>${isEs ? 'PARTIDAS / EVENTOS' : 'MATCHES / EVENTS'}</span>
          <span>${isEs ? 'ACCIONES' : 'ACTIONS'}</span>
        </div>
        ${visibleList.length ? visibleList.map(p => `
          <div class="tr ranking-row" style="${indGridCols ? `grid-template-columns: ${indGridCols}` : ''}">
            <span class="rank-col font-bold ${p.rank && p.rank <= 3 ? 'p' + p.rank : ''}">${p.rank ? '#' + p.rank : 'Unranked'}</span>
            <div class="player-col">
              <a href="index.html?player=${encodeURIComponent(p.playerId)}" class="player-card-link">
                <span class="player-avatar mini"><img src="assets/players/${esc(p.playerId)}.png" alt="" onerror="this.remove()"></span>
                <b>${esc(p.playerTag)}</b>
                ${p.isProvisional ? `<span class="badge warning mono" style="font-size:0.75rem; padding:0.1rem 0.4rem; margin-left:0.4rem;" title="Provisional ranking (< 3 eligible wins)">Provisional</span>` : ''}
                ${p.isUnranked ? `<span class="badge muted mono" style="font-size:0.75rem; padding:0.1rem 0.4rem; margin-left:0.4rem;" title="No eligible wins recorded">Unranked</span>` : ''}
              </a>
            </div>
            <span class="score-col mono font-bold">${p.isUnranked ? '-' : p.score}</span>
            ${isPeriodPerf ? `
              <span class="change-col mono font-bold ${p.change > 0 ? 'win' : (p.change < 0 ? 'loss' : 'muted')}">
                ${p.change !== undefined && p.change !== null ? (p.change > 0 ? `+${p.change}` : `${p.change}`) : '-'}
              </span>
            ` : ''}
            <span class="winrate-col mono">${p.winRate !== undefined ? p.winRate + '%' : '-'}</span>
            <span class="matches-col mono">${p.matches !== undefined ? `${p.matches}${p.events !== undefined ? ` (${p.events} event${p.events === 1 ? '' : 's'})` : ''}` : '-'}</span>
            <div class="actions-col">
              <button class="quiet-button diagnostic-btn" onclick="openDiagnosticModal('${esc(p.playerId)}')">${isEs ? 'Diagnóstico' : 'Diagnostic'}</button>
            </div>
          </div>
        `).join('') : `<div class="empty-state"><p class="muted">${isEs ? 'Ningún jugador coincide con el filtro.' : 'No players match the search filter.'}</p></div>`}
      </div>

      ${totalFiltered > 0 ? `
        <div id="scroll-sentinel" class="infinite-scroll-sentinel mono muted">
          ${visibleCount < totalFiltered ? `Showing ${visibleList.length} of ${totalFiltered} players (scroll down to load more…)` : `Showing all ${totalFiltered} players`}
        </div>
      ` : ''}
    </div>
  `;

  rankingsContent.innerHTML = html;
  bindSystemTabsEvents();
  setupInfiniteScroll(totalFiltered);
}

function getSystemDescription(systemKey) {
  switch (systemKey) {
    case 'glicko2':
      return 'Glicko-2 models rating r, rating deviation RD, and volatility σ. Conservative rating = r - 2RD.';
    case 'sof':
      return 'Strength of Field evaluates tournament performance against pre-event field strengths and entrant scaling.';
    case 'quality_wins':
      return 'Quality Wins ranks players by average victory quality adjusted for sample confidence, rewarding wins against strong opponents without volume inflation.';
    case 'loss_quality':
      return 'Consistency reflects how reliably a player achieves strong results. It rewards wins, gives extra credit for defeating stronger opponents, and accounts for the number of matches played.';
    default:
      return '';
  }
}

function formatAlgorithmParams(params) {
  if (!params) return '';
  return Object.entries(params)
    .filter(([k]) => !/(formula|Formula|Credit|Penalty|Accomplishment|Dampening)/.test(k))
    .map(([k, v]) => `<span>${esc(k)}: <b>${esc(v)}</b></span>`).join(' · ');
}

function formatMetrics(p, systemKey) {
  if (systemKey === 'glicko2') {
    return `r:${p.rating} RD:${p.rd} vol:${p.volatility}`;
  } else if (systemKey === 'sof') {
    return `Avg Field:${p.avgFieldStrength}`;
  } else if (systemKey === 'quality_wins') {
    return `Wins:${p.wins} · Total QoW:${p.totalQualityWins} · Avg Opp Win Rating:${p.avgOpponentWinRating || '-'}`;
  } else if (systemKey === 'loss_quality') {
    return `W:${p.wins} L:${p.losses} NetPts:${p.totalPoints}`;
  }
  return '';
}

window.changeSort = function(col) {
  if (sortCol === col) {
    sortAsc = !sortAsc;
  } else {
    sortCol = col;
    sortAsc = (col === 'playerTag' || col === 'rank');
  }
  visibleCount = batchSize;
  render();
};

// Comparison View
function renderComparison() {
  cleanupObserver();

  if (!comparisonData || !Object.keys(comparisonData).length) {
    rankingsContent.innerHTML = '<div class="panel glass empty-state"><h2>No comparison data</h2></div>';
    return;
  }

  const playersMap = new Map();
  const systems = ['glicko2', 'sof', 'quality_wins', 'loss_quality'];

  systems.forEach(sys => {
    const sysData = comparisonData[sys];
    if (sysData && sysData.rankings) {
      sysData.rankings.forEach(p => {
        if (!playersMap.has(p.playerId)) {
          playersMap.set(p.playerId, { playerId: p.playerId, playerTag: p.playerTag });
        }
        playersMap.get(p.playerId)[sys] = { rank: p.rank, score: p.score, change: p.change };
      });
    }
  });

  let list = Array.from(playersMap.values());
  const query = playerSearch.value.trim().toLowerCase();
  list = list.filter(p => p.playerTag.toLowerCase().includes(query));

  list.sort((a, b) => {
    const rA = a.glicko2 ? a.glicko2.rank : 999;
    const rB = b.glicko2 ? b.glicko2.rank : 999;
    return rA - rB;
  });

  const totalFiltered = list.length;
  const visibleList = list.slice(0, visibleCount);

  let html = `
    <div class="panel glass system-banner">
      <h2>Rankings Overview</h2>
      <p class="muted">Side-by-side player ranks and scores across all 4 distinct systems. Each metric measures a different competitive dimension and raw values are presented on their native scales.</p>
    </div>

    ${renderSystemTabsNav()}

    <div class="panel glass ranking-table-panel">
      <div class="table">
        <div class="tr head comparison-head">
          <span>PLAYER</span>
          <span>GLICKO-2</span>
          <span>STRENGTH OF FIELD</span>
          <span>QUALITY WINS</span>
          <span>CONSISTENCY</span>
          <span>ACTIONS</span>
        </div>
        ${visibleList.length ? visibleList.map(p => `
          <div class="tr ranking-row comparison-row">
            <div class="player-col">
              <a href="index.html?player=${encodeURIComponent(p.playerId)}" class="player-card-link">
                <b>${esc(p.playerTag)}</b>
              </a>
            </div>
            <span class="mono">${p.glicko2 ? (p.glicko2.rank ? `#${p.glicko2.rank} (${p.glicko2.score}${p.glicko2.change !== undefined && p.glicko2.change !== null ? (p.glicko2.change >= 0 ? ' +' + p.glicko2.change : ' ' + p.glicko2.change) : ''})` : `- (${p.glicko2.score})`) : '-'}</span>
            <span class="mono">${p.sof ? (p.sof.rank ? `#${p.sof.rank} (${p.sof.score})` : `- (${p.sof.score})`) : '-'}</span>
            <span class="mono">${p.quality_wins ? (p.quality_wins.rank ? `#${p.quality_wins.rank} (${p.quality_wins.score})` : `Unranked (${p.quality_wins.score})`) : '-'}</span>
            <span class="mono">${p.loss_quality ? (p.loss_quality.rank ? `#${p.loss_quality.rank} (${p.loss_quality.score})` : `- (${p.loss_quality.score})`) : '-'}</span>
            <div>
              <button class="quiet-button diagnostic-btn" onclick="openDiagnosticModal('${esc(p.playerId)}')">${(window.i18n && window.i18n.getLang && window.i18n.getLang() === 'es') ? 'Diagnóstico' : 'Diagnostic'}</button>
            </div>
          </div>
        `).join('') : '<div class="empty-state"><p class="muted">No players match the filter.</p></div>'}
      </div>

      ${totalFiltered > 0 ? `
        <div id="scroll-sentinel" class="infinite-scroll-sentinel mono muted">
          ${visibleCount < totalFiltered ? `Showing ${visibleList.length} of ${totalFiltered} players (scroll down to load more…)` : `Showing all ${totalFiltered} players`}
        </div>
      ` : ''}
    </div>
  `;

  rankingsContent.innerHTML = html;
  bindSystemTabsEvents();
  setupInfiniteScroll(totalFiltered);
}

// Diagnostic State & Logic
const diagState = {
  activeTab: 'summary',
  setsFilter: 'all',
  setsSort: 'newest',
  showAllEvents: false,
  diagData: null,
  playerId: null,
  playerTag: '',
  playerRank: null,
  finalScore: null,
  game: '',
  gameName: '',
  system: '',
  mode: '',
  startDate: '',
  endDate: '',
  allRankings: [],
  allSets: [],
  allEvents: [],
  triggerElement: null
};

function formatDiagDateRange(start, end) {
  if (!start && !end) return '';
  const parse = d => d ? new Date(`${d}T00:00:00`) : null;
  const sDate = parse(start);
  const eDate = parse(end);
  if (!sDate && !eDate) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (sDate && eDate) {
    if (sDate.getFullYear() === eDate.getFullYear()) {
      return `${months[sDate.getMonth()]} ${sDate.getDate()} – ${months[eDate.getMonth()]} ${eDate.getDate()}, ${sDate.getFullYear()}`;
    }
    return `${months[sDate.getMonth()]} ${sDate.getDate()}, ${sDate.getFullYear()} – ${months[eDate.getMonth()]} ${eDate.getDate()}, ${eDate.getFullYear()}`;
  }
  if (sDate) return `Since ${months[sDate.getMonth()]} ${sDate.getDate()}, ${sDate.getFullYear()}`;
  return `Until ${months[eDate.getMonth()]} ${eDate.getDate()}, ${eDate.getFullYear()}`;
}

function getDiagHexagonSvg(rank) {
  let cls = 'place-accent';
  let stroke = 'var(--accent, #9fd6ff)';
  if (rank === 1) { cls = 'place-gold'; stroke = 'var(--gold, #ffcc00)'; }
  else if (rank === 2) { cls = 'place-silver'; stroke = 'var(--silver, #d1d5db)'; }
  else if (rank === 3) { cls = 'place-bronze'; stroke = 'var(--bronze, #d97706)'; }

  const ordStr = (window.PRBadges && window.PRBadges.getOrdinal) ? window.PRBadges.getOrdinal(rank) : (rank ? rank : '-');
  return `
    <div class="diag-hex-wrap ${cls}">
      <svg viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <polygon points="22,2 40,12 40,32 22,42 4,32 4,12" stroke="${stroke}" stroke-width="2" fill="rgba(16,24,50,0.85)"/>
      </svg>
      <span class="diag-hex-ordinal">${esc(ordStr)}</span>
    </div>
  `;
}

function generateDecidedSentence(playerTag, playerRank, sets, neighbors) {
  if (!sets || sets.length === 0) return '';

  const wins = sets.filter(s => s.won);
  const losses = sets.filter(s => !s.won);

  let sentence1 = '';
  if (wins.length > 0) {
    const oppWins = new Map();
    for (const w of wins) {
      if (w.opponentRank !== null && w.opponentRank !== undefined) {
        if (!oppWins.has(w.opponentId)) {
          oppWins.set(w.opponentId, { tag: w.opponentTag, rank: w.opponentRank, count: 0 });
        }
        oppWins.get(w.opponentId).count++;
      }
    }
    const sortedBeaten = Array.from(oppWins.values()).sort((a, b) => a.rank - b.rank);
    if (sortedBeaten.length > 0) {
      const topBeaten = sortedBeaten.slice(0, 2);
      const parts = topBeaten.map(o => {
        const timesStr = o.count === 2 ? ', twice' : (o.count > 2 ? `, ${o.count} times` : '');
        return `<strong>${esc(o.tag)} (#${o.rank}${timesStr})</strong>`;
      });
      if (parts.length === 1) {
        sentence1 = `${esc(playerTag)} finished <strong>#${playerRank || '-'}</strong> on the strength of wins over ${parts[0]}.`;
      } else {
        sentence1 = `${esc(playerTag)} finished <strong>#${playerRank || '-'}</strong> on the strength of wins over ${parts[0]} and ${parts[1]}.`;
      }
    }
  }

  let sentence2 = '';
  if (losses.length > 0) {
    const sortedLosses = [...losses].sort((a, b) => a.impact - b.impact);
    const worstLoss = sortedLosses[0];
    if (worstLoss) {
      const oppRankStr = worstLoss.opponentRank ? ` (#${worstLoss.opponentRank})` : '';
      sentence2 = `The costliest result was a loss to <strong>${esc(worstLoss.opponentTag)}${oppRankStr}</strong> at ${esc(worstLoss.eventName || 'Tournament')}`;

      if (neighbors && neighbors.above) {
        const neighborAboveId = neighbors.above.playerId;
        const setsVsAbove = sets.filter(s => s.opponentId === neighborAboveId);
        if (setsVsAbove.length === 1 && !setsVsAbove[0].won) {
          const s = setsVsAbove[0];
          sentence2 += `, and the only set against <strong>${esc(neighbors.above.playerTag)} (#${neighbors.above.rank})</strong> was lost, ${esc(s.score || '1–3')}.`;
        } else {
          sentence2 += '.';
        }
      } else {
        sentence2 += '.';
      }
    }
  }

  if (sentence1 && sentence2) {
    return `${sentence1} ${sentence2}`;
  }
  return sentence1 || sentence2 || '';
}

function closeDiagnosticModal() {
  if (diagnosticModal) {
    diagnosticModal.close();
  }
  document.body.classList.remove('mobile-scroll-locked');
  if (diagState.triggerElement) {
    try { diagState.triggerElement.focus(); } catch (e) {}
    diagState.triggerElement = null;
  }
}

// Global modal open
window.openDiagnosticModal = async function(playerId) {
  diagState.triggerElement = document.activeElement;
  diagState.playerId = String(playerId);
  diagState.activeTab = 'summary';
  diagState.setsFilter = 'all';
  diagState.setsSort = 'newest';
  diagState.showAllEvents = false;

  const game = gameFilter.value;
  diagState.game = game;
  diagState.gameName = getGameName(game);
  diagState.system = getActiveSystem();
  diagState.mode = modeFilter.value;
  diagState.startDate = diagState.mode === 'historical' ? '' : startDateInput.value;
  diagState.endDate = diagState.mode === 'historical' ? '' : endDateInput.value;

  const diagHeader = $('#diag-header');
  const diagBody = $('#diag-body');

  if (diagHeader) {
    diagHeader.innerHTML = `
      <div class="diag-player-head">
        <div class="diag-player-avatar">${playerId.charAt(0).toUpperCase()}</div>
        <div class="diag-player-meta">
          <h2 id="diag-player-tag">Loading…</h2>
          <span class="player-id mono muted">ID ${esc(playerId)}</span>
        </div>
      </div>
      <p class="muted">Loading calculation diagnostic data…</p>
    `;
  }
  if (diagBody) {
    diagBody.innerHTML = '';
  }

  diagnosticModal.showModal();
  document.body.classList.add('mobile-scroll-locked');

  // Focus modal
  const closeBtn = $('#modal-close-btn');
  if (closeBtn) closeBtn.focus();

  try {
    const gameData = await getGameData(game);
    if (!window.ClientRankingEngine) {
      throw new Error('Ranking engine client library not found.');
    }

    const calcSystem = (diagState.system === 'overview' || diagState.system === 'comparison') ? 'glicko2' : diagState.system;
    const engine = new window.ClientRankingEngine(gameData);
    const result = engine.calculate(calcSystem, diagState.mode, diagState.startDate || null, diagState.endDate || null, diagState.playerId, prWeights);

    // Also calculate Glicko2 if calcSystem is custom and has empty history
    let glickoRes = null;
    if (calcSystem === 'custom' && (!result.diagnostic || !result.diagnostic.history || result.diagnostic.history.length === 0)) {
      try {
        glickoRes = engine.calculate('glicko2', diagState.mode, diagState.startDate || null, diagState.endDate || null, diagState.playerId);
      } catch (e) {}
    }

    diagState.diagData = result;
    diagState.allRankings = result.rankings || [];

    const pRankObj = diagState.allRankings.find(r => String(r.playerId) === String(diagState.playerId));
    diagState.playerTag = pRankObj ? pRankObj.playerTag : (result.diagnostic?.playerTag || `Player ${diagState.playerId}`);
    diagState.playerRank = pRankObj ? pRankObj.rank : (result.diagnostic?.playerRank || null);
    diagState.finalScore = pRankObj ? pRankObj.score : (result.diagnostic?.finalScore !== null ? result.diagnostic?.finalScore : null);

    // Map ranks to players for easy lookup
    const rankMap = new Map();
    diagState.allRankings.forEach(r => rankMap.set(String(r.playerId), r.rank));

    // Normalize sets
    const rawHistory = (result.diagnostic && result.diagnostic.history && result.diagnostic.history.length > 0)
      ? result.diagnostic.history
      : (glickoRes && glickoRes.diagnostic && glickoRes.diagnostic.history ? glickoRes.diagnostic.history : []);

    // Filter sets by date if in period_only or period_performance
    let filteredHistory = rawHistory;
    if (diagState.mode !== 'historical') {
      filteredHistory = rawHistory.filter(h => {
        if (!h.date) return true;
        if (diagState.startDate && h.date < diagState.startDate) return false;
        if (diagState.endDate && h.date > diagState.endDate) return false;
        return true;
      });
    }

    diagState.allSets = filteredHistory.map(h => {
      const won = h.outcome === 'win';
      const oppId = String(h.opponentId || '');
      const oppRank = rankMap.get(oppId) || null;

      let winChance = 0.5;
      if (h.expectedScore !== undefined && h.expectedScore !== null) {
        winChance = parseFloat(h.expectedScore) || 0.5;
      } else if (h.opponentPreRating !== undefined && h.playerPreRating !== undefined) {
        const diff = (h.playerPreRating - h.opponentPreRating);
        winChance = 1 / (1 + Math.pow(10, -diff / 400));
      } else if (h.opponentPreRating !== undefined && h.preScore !== undefined) {
        const diff = (h.preScore - h.opponentPreRating);
        winChance = 1 / (1 + Math.pow(10, -diff / 400));
      }

      let impact = 0;
      if (h.penalty !== undefined && h.penalty !== null) {
        impact = -parseFloat(h.penalty);
      } else if (h.contribution !== undefined && h.contribution !== null) {
        impact = parseFloat(h.contribution);
      } else if (h.credit !== undefined && h.credit !== null) {
        impact = parseFloat(h.credit);
      } else if (h.change !== undefined && h.change !== null) {
        impact = parseFloat(h.change);
      } else if (h.qualityPoints !== undefined && h.qualityPoints !== null) {
        impact = parseFloat(h.qualityPoints);
      } else {
        impact = won ? 1.0 : -1.0;
      }

      // Format event name & clean up
      let eventTitle = h.event || 'Tournament';
      if (eventTitle.includes(' · ')) {
        eventTitle = eventTitle.split(' · ')[0];
      }

      return {
        setId: h.setId,
        eventId: h.eventId || h.tournamentSlug || eventTitle,
        eventName: eventTitle,
        eventDate: h.date || '',
        round: h.round ? (h.phase ? `${h.phase} ${h.round}` : h.round) : (h.phase || 'Bracket'),
        opponentId: oppId,
        opponentTag: h.opponentTag || `Player ${oppId}`,
        opponentRank: oppRank,
        won: won,
        score: h.scoreDisplay || h.displayScore || (won ? 'Won' : 'Lost'),
        winChance: Math.max(0.01, Math.min(0.99, winChance)),
        impact: impact
      };
    });

    // Extract events summary from placements or sets
    const rawPlacements = (gameData.placements || []).filter(p => String(p.playerId) === String(diagState.playerId));
    let filteredPlacements = rawPlacements;
    if (diagState.mode !== 'historical') {
      filteredPlacements = rawPlacements.filter(p => {
        if (!p.date) return true;
        if (diagState.startDate && p.date < diagState.startDate) return false;
        if (diagState.endDate && p.date > diagState.endDate) return false;
        return true;
      });
    }

    const eventMap = new Map();
    filteredPlacements.forEach(p => {
      const key = p.tournamentName || p.eventName || p.eventId;
      if (!eventMap.has(key)) {
        eventMap.set(key, {
          name: p.tournamentName || p.eventName || 'Tournament',
          date: p.date || '',
          placement: p.placement,
          entrants: p.entrants || 0
        });
      }
    });

    // Also populate any events in sets that might be missing in placements
    diagState.allSets.forEach(s => {
      if (!eventMap.has(s.eventName)) {
        eventMap.set(s.eventName, {
          name: s.eventName,
          date: s.eventDate,
          placement: null,
          entrants: null
        });
      }
    });

    diagState.allEvents = Array.from(eventMap.values()).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    // Render modal view
    renderDiagnosticHeader();
    bindDiagnosticTabs();
    renderDiagnosticActiveTab();

  } catch (err) {
    if (diagHeader) {
      diagHeader.innerHTML = `<h2>Diagnostic Error</h2>`;
    }
    if (diagBody) {
      diagBody.innerHTML = `<div class="diag-empty-card"><p>${esc(err.message)}</p></div>`;
    }
  }
};

function renderDiagnosticHeader() {
  const diagHeader = $('#diag-header');
  if (!diagHeader) return;

  const tag = diagState.playerTag;
  const pId = diagState.playerId;
  const rank = diagState.playerRank;
  const score = diagState.finalScore !== null ? diagState.finalScore : '-';
  const scoreNum = parseFloat(score) || 0;
  const isGlicko = diagState.system === 'glicko2' || (scoreNum > 100);
  const maxScore = isGlicko ? (Math.max(2200, Math.ceil(scoreNum / 100) * 100)) : 100;
  const scorePct = Math.min(100, Math.max(0, (scoreNum / maxScore) * 100));

  // Determine neighbors for summary sentence & where it sits
  const neighbors = getPlayerNeighbors(pId, diagState.allRankings);

  // Date range formatted chip
  const dateRangeStr = formatDiagDateRange(diagState.startDate, diagState.endDate) || (diagState.mode === 'historical' ? 'All-time' : 'Full history');
  const systemName = (diagState.system === 'custom' || diagState.system === 'power_rankings') ? 'Power Rankings' : (getSystemNames()[diagState.system] || diagState.system);

  const initial = tag.charAt(0).toUpperCase();

  let rankCls = 'place-accent';
  if (rank === 1) rankCls = 'place-gold';
  else if (rank === 2) rankCls = 'place-silver';
  else if (rank === 3) rankCls = 'place-bronze';

  const decidedSentence = generateDecidedSentence(tag, rank, diagState.allSets, neighbors);

  diagHeader.innerHTML = `
    <div class="diag-player-head">
      <div class="diag-player-avatar" id="diag-player-avatar">
        <img src="assets/players/${esc(pId)}.png" alt="${esc(tag)}" onerror="this.onerror=null; this.parentNode.textContent='${esc(initial)}';">
      </div>
      <div class="diag-player-meta">
        <h2 id="diag-player-tag">${esc(tag)}</h2>
        <span class="player-id mono muted">ID ${esc(pId)}</span>
      </div>
    </div>

    <div class="diag-chips-row" id="diag-chips">
      <span class="diag-chip">${esc(diagState.gameName)}</span>
      <span class="diag-chip">${esc(systemName)}</span>
      <span class="diag-chip">${esc(dateRangeStr)}</span>
      ${diagState.mode === 'period_only' ? '<span class="diag-chip muted">Counts this period only</span>' : ''}
    </div>

    <div class="diag-stats-summary-row">
      <div class="diag-badge-card diag-rank-block">
        ${getDiagHexagonSvg(rank)}
        <div class="diag-rank-num-group">
          <span class="rank-label">Rank</span>
          <span class="rank-val ${rankCls}">#${rank ? rank : '-'}</span>
        </div>
      </div>

      <div class="diag-badge-card score-card">
        <div class="diag-score-title">Final Score</div>
        <div class="diag-score-value-row">
          <span class="score-num font-bold">${score}</span>
          <span class="score-max">/ ${maxScore}</span>
        </div>
        <div class="diag-progress-track">
          <div class="diag-progress-fill" style="width:${scorePct}%;"></div>
        </div>
      </div>
    </div>

    ${decidedSentence ? `
      <div class="diag-decided-wrap">
        <div class="diag-decided-label">What decided this rank</div>
        <div class="diag-decided-text">${decidedSentence}</div>
      </div>
    ` : ''}
  `;

  // Update tab labels (e.g. Sets (24))
  const setsTab = $('#diag-tab-sets');
  if (setsTab) {
    setsTab.textContent = `Sets (${diagState.allSets.length})`;
  }
}

function getPlayerNeighbors(playerId, rankings) {
  if (!rankings || rankings.length === 0) return { above: null, below: null, list: [] };
  const idx = rankings.findIndex(r => String(r.playerId) === String(playerId));
  if (idx === -1) return { above: null, below: null, list: [] };

  const current = rankings[idx];
  const above = idx > 0 ? rankings[idx - 1] : null;
  const below = idx < rankings.length - 1 ? rankings[idx + 1] : null;

  // Window of up to 4 rows
  let start = Math.max(0, idx - 1);
  let end = Math.min(rankings.length, start + 4);
  if (end - start < 4 && start > 0) {
    start = Math.max(0, end - 4);
  }
  const list = rankings.slice(start, end);

  return { current, above, below, list };
}

function bindDiagnosticTabs() {
  const tabs = [
    { id: 'diag-tab-summary', key: 'summary' },
    { id: 'diag-tab-sets', key: 'sets' },
    { id: 'diag-tab-method', key: 'method' }
  ];

  tabs.forEach((tabInfo, idx) => {
    const el = $(`#${tabInfo.id}`);
    if (!el) return;

    el.onclick = () => {
      setDiagActiveTab(tabInfo.key);
    };

    el.onkeydown = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const nextIdx = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
        const nextEl = $(`#${tabs[nextIdx].id}`);
        if (nextEl) {
          nextEl.focus();
          setDiagActiveTab(tabs[nextIdx].key);
        }
      }
    };
  });
}

function setDiagActiveTab(tabKey) {
  diagState.activeTab = tabKey;
  ['summary', 'sets', 'method'].forEach(k => {
    const tabEl = $(`#diag-tab-${k}`);
    if (tabEl) {
      const active = (k === tabKey);
      tabEl.classList.toggle('active', active);
      tabEl.setAttribute('aria-selected', active ? 'true' : 'false');
      tabEl.setAttribute('tabindex', active ? '0' : '-1');
    }
  });
  renderDiagnosticActiveTab();
}

function renderDiagnosticActiveTab() {
  const diagBody = $('#diag-body');
  if (!diagBody) return;

  if (diagState.activeTab === 'summary') {
    diagBody.innerHTML = renderDiagSummaryTab();
  } else if (diagState.activeTab === 'sets') {
    diagBody.innerHTML = renderDiagSetsTab();
    bindDiagSetsControls();
  } else if (diagState.activeTab === 'method') {
    diagBody.innerHTML = renderDiagMethodTab();
  }
}

function renderDiagSummaryTab() {
  const sets = diagState.allSets;
  const events = diagState.allEvents;
  const pId = diagState.playerId;
  const pTag = diagState.playerTag;
  const rank = diagState.playerRank;
  const neighbors = getPlayerNeighbors(pId, diagState.allRankings);

  // 1. At a glance metrics
  const setsPlayedCount = sets.length;
  const winsCount = sets.filter(s => s.won).length;
  const lossesCount = sets.filter(s => !s.won).length;
  const winRate = setsPlayedCount > 0 ? Math.round((winsCount / setsPlayedCount) * 100) : 0;

  const eventsCount = events.length;
  let eventDatesStr = '—';
  if (events.length > 0) {
    const sortedEv = [...events].filter(e => e.date).sort((a, b) => a.date.localeCompare(b.date));
    if (sortedEv.length > 0) {
      const firstD = sortedEv[0].date;
      const lastD = sortedEv[sortedEv.length - 1].date;
      eventDatesStr = formatDiagDateRange(firstD, lastD) || `${firstD} – ${lastD}`;
    }
  }

  // Best Result
  let bestPlacingStr = '—';
  let bestEventSub = '—';
  const placements = events.filter(e => e.placement !== null && e.placement !== undefined);
  if (placements.length > 0) {
    const sortedP = [...placements].sort((a, b) => a.placement - b.placement);
    const bestP = sortedP[0];
    const ord = (window.PRBadges && window.PRBadges.getOrdinal) ? window.PRBadges.getOrdinal(bestP.placement) : `#${bestP.placement}`;
    bestPlacingStr = ord;
    bestEventSub = `${bestP.name}${bestP.entrants ? ` · ${bestP.entrants}` : ''}`;
  }

  // Record vs Top 10
  const top10Sets = sets.filter(s => s.opponentRank !== null && s.opponentRank <= 10);
  const top10Wins = top10Sets.filter(s => s.won).length;
  const top10Losses = top10Sets.filter(s => !s.won).length;
  const top10Rate = top10Sets.length > 0 ? Math.round((top10Wins / top10Sets.length) * 100) : 0;

  // 2. Where #N sits
  let whereSitsHtml = '';
  if (neighbors.list && neighbors.list.length > 0) {
    const scoreRowsHtml = neighbors.list.map(r => {
      const isCur = String(r.playerId) === String(pId);
      const sc = parseFloat(r.score) || 0;
      const maxSc = (diagState.system === 'glicko2') ? 2200 : 100;
      const pct = Math.min(100, Math.max(0, (sc / maxSc) * 100));
      let rankCls = 'place-accent';
      if (r.rank === 1) rankCls = 'place-gold';
      else if (r.rank === 2) rankCls = 'place-silver';
      else if (r.rank === 3) rankCls = 'place-bronze';

      return `
        <div class="diag-score-row ${isCur ? 'current' : ''}">
          <span class="rank-num ${rankCls}">#${r.rank}</span>
          <span class="player-tag">${esc(r.playerTag)}</span>
          <div class="score-bar-wrap">
            <div class="score-bar-fill" style="width:${pct}%;"></div>
          </div>
          <span class="score-num font-mono">${r.score}</span>
        </div>
      `;
    }).join('');

    // H2H against above and below
    const compareNeighbors = [neighbors.above, neighbors.below].filter(Boolean);
    const h2hRowsHtml = compareNeighbors.map(nb => {
      const vsSets = sets.filter(s => s.opponentId === String(nb.playerId));
      const w = vsSets.filter(s => s.won).length;
      const l = vsSets.filter(s => !s.won).length;
      let desc = 'No sets recorded';
      if (vsSets.length > 0) {
        const sortedVs = [...vsSets].sort((a, b) => (b.eventDate || '').localeCompare(a.eventDate || ''));
        const latest = sortedVs[0];
        if (latest.score && latest.score !== 'Won' && latest.score !== 'Lost') {
          desc = `${latest.won ? 'Won' : 'Lost'} ${latest.score} at ${latest.eventName}`;
        } else {
          desc = `${latest.won ? 'Won' : 'Lost'} at ${latest.eventName}`;
        }
      }
      return `
        <div class="diag-h2h-row">
          <div class="diag-h2h-info">
            <div>
              <span class="opp-tag">${esc(nb.playerTag)}</span>
              <span class="opp-rank">#${nb.rank}</span>
            </div>
            <span class="opp-detail">${esc(desc)}</span>
          </div>
          <span class="diag-h2h-score font-mono">${w}–${l}</span>
        </div>
      `;
    }).join('');

    // Why sentences
    let whySentences = [];
    if (neighbors.above) {
      const nb = neighbors.above;
      const vsSets = sets.filter(s => s.opponentId === String(nb.playerId));
      const w = vsSets.filter(s => s.won).length;
      const l = vsSets.filter(s => !s.won).length;
      const ptsBehind = Math.abs(Math.round(((nb.score || 0) - (diagState.finalScore || 0)) * 10) / 10);
      let vsStr = (vsSets.length === 1 && l === 1) ? `lost the only set against ${esc(nb.playerTag)} (${vsSets[0].score || '1–3'})` : `is ${w}–${l} against ${esc(nb.playerTag)}`;
      whySentences.push(`<strong>Why #${rank} and not #${nb.rank}:</strong> ${esc(pTag)} ${vsStr} and finished ${ptsBehind} points behind.`);
    }
    if (neighbors.below) {
      const nb = neighbors.below;
      const vsSets = sets.filter(s => s.opponentId === String(nb.playerId));
      const w = vsSets.filter(s => s.won).length;
      const l = vsSets.filter(s => !s.won).length;
      const ptsAhead = Math.abs(Math.round(((diagState.finalScore || 0) - (nb.score || 0)) * 10) / 10);
      whySentences.push(`<strong>Why not #${nb.rank}:</strong> ${esc(pTag)} leads ${esc(nb.playerTag)} ${w}–${l} and by ${ptsAhead} points.`);
    }

    whereSitsHtml = `
      <div class="diag-card">
        <h3 class="diag-card-title">Where #${rank || '-'} sits</h3>
        <p class="diag-card-subtitle">The players on either side of ${esc(pTag)}, and how ${esc(pTag)} did against them.</p>

        <div class="diag-where-grid">
          <div>
            <div class="diag-section-label">Final scores</div>
            <div class="diag-score-rows">${scoreRowsHtml}</div>
          </div>
          <div>
            <div class="diag-section-label">Head-to-head</div>
            <div class="diag-h2h-rows">${h2hRowsHtml}</div>
          </div>
        </div>

        ${whySentences.length > 0 ? `
          <div class="diag-why-box">
            ${whySentences.join(' ')}
          </div>
        ` : ''}
      </div>
    `;
  }

  // 3. Moments that shaped it
  let momentsHtml = '';
  if (setsPlayedCount === 0) {
    momentsHtml = `
      <div class="diag-card">
        <h3 class="diag-card-title">Moments that shaped it</h3>
        <p class="diag-card-subtitle">The sets that moved the score the most.</p>
        <div class="diag-empty-card">
          No sets are recorded for this player between ${esc(diagState.startDate || 'start')} and ${esc(diagState.endDate || 'end')}, so no significant win or loss moments could be identified.
        </div>
      </div>
    `;
  } else {
    const wins = sets.filter(s => s.won).sort((a, b) => b.impact - a.impact).slice(0, 3);
    const losses = sets.filter(s => !s.won).sort((a, b) => a.impact - b.impact).slice(0, 3);

    const renderMomentItem = (item) => {
      const oppRankStr = item.opponentRank ? `<span class="opp-rank">#${item.opponentRank}</span>` : '';
      const roundScore = `${item.round} · ${item.score}`;
      const sign = item.impact > 0 ? `+${item.impact}` : `${item.impact}`;
      const cls = item.impact >= 0 ? 'pos' : 'neg';

      return `
        <div class="diag-moment-item">
          <div class="diag-moment-info">
            <div>
              <span class="opp-name">${esc(item.opponentTag)}</span>
              ${oppRankStr}
            </div>
            <span class="event-round">${esc(item.eventName)} · ${esc(roundScore)}</span>
          </div>
          <span class="diag-impact-val ${cls}">${sign}</span>
        </div>
      `;
    };

    momentsHtml = `
      <div class="diag-card">
        <h3 class="diag-card-title">Moments that shaped it</h3>
        <p class="diag-card-subtitle">The sets that moved the score the most.</p>
        <div class="diag-moments-grid">
          <div>
            <div class="diag-section-label">Best wins</div>
            <div class="diag-moment-list">
              ${wins.length > 0 ? wins.map(renderMomentItem).join('') : '<div class="muted font-13">No recorded wins</div>'}
            </div>
          </div>
          <div>
            <div class="diag-section-label">Costliest losses</div>
            <div class="diag-moment-list">
              ${losses.length > 0 ? losses.map(renderMomentItem).join('') : '<div class="muted font-13">No recorded losses</div>'}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // 4. Score over the period (SVG chart)
  let chartHtml = '';
  if (setsPlayedCount === 0) {
    chartHtml = `
      <div class="diag-card">
        <h3 class="diag-card-title">Score over the period</h3>
        <p class="diag-card-subtitle">The score after each event.</p>
        <div class="diag-empty-card">
          No sets are recorded for this player between ${esc(diagState.startDate || 'start')} and ${esc(diagState.endDate || 'end')}, so score progression is unavailable.
        </div>
      </div>
    `;
  } else {
    chartHtml = `
      <div class="diag-card">
        <h3 class="diag-card-title">Score over the period</h3>
        <p class="diag-card-subtitle">The score after each event. The larger dot is the biggest gain.</p>
        <div class="diag-chart-container">
          ${renderScoreChartSvg(sets, events)}
        </div>
      </div>
    `;
  }

  // 5. Footnote
  const footnoteHtml = `
    <div class="diag-footnote">
      Based on ${setsPlayedCount} sets across ${eventsCount} events
    </div>
  `;

  return `
    <div class="diag-glance-grid">
      <div class="diag-glance-tile">
        <span class="tile-label">Sets played</span>
        <span class="tile-value">${setsPlayedCount}</span>
        <span class="tile-sub">${setsPlayedCount > 0 ? `${winsCount}W – ${lossesCount}L · ${winRate}% win rate` : '—'}</span>
      </div>
      <div class="diag-glance-tile">
        <span class="tile-label">Events</span>
        <span class="tile-value">${eventsCount}</span>
        <span class="tile-sub">${esc(eventDatesStr)}</span>
      </div>
      <div class="diag-glance-tile">
        <span class="tile-label">Best result</span>
        <span class="tile-value">${bestPlacingStr}</span>
        <span class="tile-sub">${esc(bestEventSub)}</span>
      </div>
      <div class="diag-glance-tile">
        <span class="tile-label">vs Top 10</span>
        <span class="tile-value">${top10Sets.length > 0 ? `${top10Wins}–${top10Losses}` : '0–0'}</span>
        <span class="tile-sub">${top10Sets.length > 0 ? `${top10Rate}% win rate` : '—'}</span>
      </div>
    </div>

    ${whereSitsHtml}
    ${momentsHtml}
    ${chartHtml}
    ${footnoteHtml}
  `;
}

// Generate the responsive SVG score chart
function renderScoreChartSvg(sets, events) {
  const eventsByDate = [...events].filter(e => e.date).sort((a, b) => a.date.localeCompare(b.date));
  let runningScore = 50;
  const points = [];
  let biggestGain = -Infinity;
  let biggestGainPoint = null;

  if (eventsByDate.length === 0) {
    points.push({ label: 'Initial', score: diagState.finalScore || 70, date: '2025-01-01' });
  } else {
    eventsByDate.forEach(ev => {
      const evSets = sets.filter(s => s.eventName === ev.name);
      let evImpact = evSets.reduce((acc, s) => acc + s.impact, 0);
      runningScore += evImpact;
      const pt = { label: ev.name, score: Math.round(runningScore * 10) / 10, date: ev.date, gain: evImpact };
      points.push(pt);
      if (evImpact > biggestGain) {
        biggestGain = evImpact;
        biggestGainPoint = pt;
      }
    });
  }

  if (diagState.finalScore !== null && points.length > 0) {
    const delta = (diagState.finalScore - points[points.length - 1].score);
    points.forEach(p => p.score = Math.round((p.score + delta) * 10) / 10);
  }

  const scores = points.map(p => p.score);
  const minScore = Math.floor(Math.min(...scores, 50) / 10) * 10;
  const maxScore = Math.ceil(Math.max(...scores, 80) / 10) * 10;
  const range = Math.max(1, maxScore - minScore);

  const w = 800;
  const h = 260;
  const padLeft = 45;
  const padRight = 70;
  const padTop = 30;
  const padBottom = 40;

  const chartW = w - padLeft - padRight;
  const chartH = h - padTop - padBottom;

  const getX = (idx) => padLeft + (points.length <= 1 ? chartW / 2 : (idx / (points.length - 1)) * chartW);
  const getY = (val) => padTop + chartH - ((val - minScore) / range) * chartH;

  const coords = points.map((p, idx) => ({ x: getX(idx), y: getY(p.score), ...p }));

  const lineD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
  const areaD = `${lineD} L ${coords[coords.length - 1].x.toFixed(1)} ${(padTop + chartH).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(padTop + chartH).toFixed(1)} Z`;

  // Grid lines
  const gridVals = [minScore, Math.round((minScore + maxScore) / 2), maxScore];
  const gridLines = gridVals.map(val => {
    const y = getY(val);
    return `
      <line x1="${padLeft}" y1="${y}" x2="${w - padRight}" y2="${y}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="4,4"/>
      <text x="${padLeft - 10}" y="${y + 4}" fill="#94a3b8" font-size="11" font-family="'JetBrains Mono', monospace" text-anchor="end">${val}</text>
    `;
  }).join('');

  // Months on x axis
  const monthLetters = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  const monthLabels = monthLetters.map((m, i) => {
    const x = padLeft + (i / 11) * chartW;
    return `<text x="${x}" y="${h - 10}" fill="#94a3b8" font-size="11" font-family="'JetBrains Mono', monospace" text-anchor="middle">${m}</text>`;
  }).join('');

  // Biggest gain point marker
  let biggestGainSvg = '';
  if (biggestGainPoint) {
    const bgCoord = coords.find(c => c.label === biggestGainPoint.label) || coords[0];
    const sign = bgCoord.gain > 0 ? `+${Math.round(bgCoord.gain * 10) / 10}` : `${Math.round(bgCoord.gain * 10) / 10}`;
    biggestGainSvg = `
      <circle cx="${bgCoord.x}" cy="${bgCoord.y}" r="7" fill="var(--accent, #9fd6ff)" stroke="rgba(16,24,50,0.9)" stroke-width="2"/>
      <text x="${bgCoord.x - 8}" y="${bgCoord.y - 12}" fill="#fff" font-size="12" font-family="'Space Grotesk', sans-serif" font-weight="600" text-anchor="end">${esc(bgCoord.label)} ${sign}</text>
    `;
  }

  // Final point marker
  const lastCoord = coords[coords.length - 1];
  const finalSvg = `
    <circle cx="${lastCoord.x}" cy="${lastCoord.y}" r="4" fill="var(--accent, #9fd6ff)"/>
    <text x="${lastCoord.x}" y="${lastCoord.y - 12}" fill="#fff" font-size="12" font-family="'Space Grotesk', sans-serif" font-weight="700" text-anchor="middle">Finished at ${lastCoord.score}</text>
  `;

  return `
    <svg class="diag-chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Score progression chart from ${minScore} to ${maxScore}, finishing at ${diagState.finalScore || scores[scores.length - 1]}">
      <defs>
        <linearGradient id="diagChartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent, #9fd6ff)" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="var(--accent, #9fd6ff)" stop-opacity="0.0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      ${monthLabels}
      <path d="${areaD}" fill="url(#diagChartGrad)"/>
      <path d="${lineD}" fill="none" stroke="var(--accent, #9fd6ff)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      ${coords.map(c => `<circle cx="${c.x}" cy="${c.y}" r="3" fill="var(--accent, #9fd6ff)"/>`).join('')}
      ${biggestGainSvg}
      ${finalSvg}
    </svg>
  `;
}

// Sets Tab Rendering
function renderDiagSetsTab() {
  const allSets = diagState.allSets;

  if (allSets.length === 0) {
    return `
      <div class="diag-card">
        <h3 class="diag-card-title">Sets (${allSets.length})</h3>
        <div class="diag-empty-card">
          No sets are recorded for this player between ${esc(diagState.startDate || 'start')} and ${esc(diagState.endDate || 'end')}.
        </div>
      </div>
      <div class="diag-footnote">0 sets across 0 events</div>
    `;
  }

  // Filter sets
  let filtered = allSets;
  if (diagState.setsFilter === 'wins') {
    filtered = allSets.filter(s => s.won);
  } else if (diagState.setsFilter === 'losses') {
    filtered = allSets.filter(s => !s.won);
  } else if (diagState.setsFilter === 'impact') {
    filtered = [...allSets].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  }

  // Sort sets
  let sorted = [...filtered];
  if (diagState.setsSort === 'newest') {
    sorted.sort((a, b) => (b.eventDate || '').localeCompare(a.eventDate || ''));
  } else if (diagState.setsSort === 'oldest') {
    sorted.sort((a, b) => (a.eventDate || '').localeCompare(b.eventDate || ''));
  } else if (diagState.setsSort === 'impact') {
    sorted.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  }

  // Group by event
  const eventGroupMap = new Map();
  sorted.forEach(s => {
    if (!eventGroupMap.has(s.eventName)) {
      const evMeta = diagState.allEvents.find(e => e.name === s.eventName) || { name: s.eventName, date: s.eventDate, placement: null, entrants: null };
      eventGroupMap.set(s.eventName, {
        meta: evMeta,
        sets: []
      });
    }
    eventGroupMap.get(s.eventName).sets.push(s);
  });

  const eventGroups = Array.from(eventGroupMap.values());
  const visibleGroups = diagState.showAllEvents ? eventGroups : eventGroups.slice(0, 3);

  const winsCount = allSets.filter(s => s.won).length;
  const lossesCount = allSets.filter(s => !s.won).length;

  const eventCardsHtml = visibleGroups.map(grp => {
    const ev = grp.meta;
    const netImpact = Math.round(grp.sets.reduce((acc, s) => acc + s.impact, 0) * 10) / 10;
    const netSign = netImpact > 0 ? `+${netImpact}` : `${netImpact}`;
    const netCls = netImpact >= 0 ? 'pos' : 'neg';

    const placeStr = ev.placement ? `${(window.PRBadges && window.PRBadges.getOrdinal) ? window.PRBadges.getOrdinal(ev.placement) : '#' + ev.placement}${ev.entrants ? ' of ' + ev.entrants : ''}` : '';
    const datePlaceStr = [ev.date, placeStr].filter(Boolean).join(' · ');

    const rowsHtml = grp.sets.map(s => {
      const oppRankStr = s.opponentRank ? `<span class="opp-rank">#${s.opponentRank}</span>` : '';
      const resCls = s.won ? 'pos' : 'neg';
      const resText = s.won ? `W ${s.score}` : `L ${s.score}`;
      const impSign = s.impact > 0 ? `+${s.impact}` : `${s.impact}`;
      const impCls = s.impact >= 0 ? 'pos' : 'neg';
      const pct = Math.round(s.winChance * 100);

      // Desktop row
      const desktopRow = `
        <div class="diag-set-row-desktop">
          <span class="set-round">${esc(s.round)}</span>
          <span class="set-opp">${esc(s.opponentTag)} ${oppRankStr}</span>
          <span class="set-res ${resCls}">${esc(resText)}</span>
          <div class="set-chance-wrap">
            <div class="chance-bar"><div class="chance-bar-fill" style="width:${pct}%;"></div></div>
            <span class="chance-num font-mono">${pct}%</span>
          </div>
          <span class="set-impact font-mono ${impCls}">${impSign}</span>
        </div>
      `;

      // Mobile card
      const mobileCard = `
        <div class="diag-set-card-mobile">
          <div class="line-1">
            <span class="round-caps font-mono">${esc(s.round)}</span>
            <span class="diag-impact-val ${impCls}">${impSign}</span>
          </div>
          <div class="line-2">
            <div>
              <span class="opp-bold">${esc(s.opponentTag)}</span>
              ${oppRankStr}
            </div>
            <span class="score-res ${resCls}">${esc(resText)}</span>
          </div>
          <div class="line-3">
            <span class="chance-label">WIN CHANCE</span>
            <div class="chance-bar"><div class="chance-bar-fill" style="width:${pct}%;"></div></div>
            <span class="chance-num">${pct}%</span>
          </div>
        </div>
      `;

      return desktopRow + mobileCard;
    }).join('');

    return `
      <div class="diag-event-card">
        <div class="diag-event-head">
          <div class="diag-event-meta">
            <h4 class="diag-event-name">${esc(ev.name)}</h4>
            <span class="diag-event-sub">${esc(datePlaceStr)}</span>
          </div>
          <div class="diag-event-impact">
            <span class="net-label">Net impact</span>
            <span class="net-val ${netCls}">${netSign}</span>
          </div>
        </div>
        ${rowsHtml}
      </div>
    `;
  }).join('');

  const showMoreBtnHtml = (!diagState.showAllEvents && eventGroups.length > 3) ? `
    <button class="diag-show-more-btn" id="diag-btn-show-all-events">
      Show all ${eventGroups.length} events
    </button>
  ` : '';

  return `
    <div class="diag-sets-toolbar">
      <div class="diag-filter-chips">
        <button class="diag-filter-btn ${diagState.setsFilter === 'all' ? 'active' : ''}" data-filter="all">All ${allSets.length}</button>
        <button class="diag-filter-btn ${diagState.setsFilter === 'wins' ? 'active' : ''}" data-filter="wins">Wins ${winsCount}</button>
        <button class="diag-filter-btn ${diagState.setsFilter === 'losses' ? 'active' : ''}" data-filter="losses">Losses ${lossesCount}</button>
        <button class="diag-filter-btn ${diagState.setsFilter === 'impact' ? 'active' : ''}" data-filter="impact">Biggest impact</button>
      </div>

      <div class="diag-sort-wrap">
        <label for="diag-sort-select" class="mono muted font-12">Sort by:</label>
        <select id="diag-sort-select" class="diag-sort-select">
          <option value="newest" ${diagState.setsSort === 'newest' ? 'selected' : ''}>Newest first</option>
          <option value="oldest" ${diagState.setsSort === 'oldest' ? 'selected' : ''}>Oldest first</option>
          <option value="impact" ${diagState.setsSort === 'impact' ? 'selected' : ''}>Biggest impact</option>
        </select>
      </div>
    </div>

    <div class="diag-sets-explanation">
      Win chance indicates estimated probability before the set; Impact indicates points gained or lost.
    </div>

    <div class="diag-table-head-row">
      <span>ROUND</span>
      <span>OPPONENT</span>
      <span>RESULT</span>
      <span>WIN CHANCE BEFORE SET</span>
      <span style="text-align:right;">IMPACT</span>
    </div>

    <div class="diag-event-cards">
      ${eventCardsHtml}
    </div>

    ${showMoreBtnHtml}

    <div class="diag-footnote">
      Based on ${allSets.length} sets across ${diagState.allEvents.length} events
    </div>
  `;
}

function bindDiagSetsControls() {
  const filterBtns = document.querySelectorAll('.diag-filter-btn');
  filterBtns.forEach(btn => {
    btn.onclick = () => {
      diagState.setsFilter = btn.getAttribute('data-filter');
      renderDiagnosticActiveTab();
    };
  });

  const sortSelect = $('#diag-sort-select');
  if (sortSelect) {
    sortSelect.onchange = () => {
      diagState.setsSort = sortSelect.value;
      renderDiagnosticActiveTab();
    };
  }

  const showMoreBtn = $('#diag-btn-show-all-events');
  if (showMoreBtn) {
    showMoreBtn.onclick = () => {
      diagState.showAllEvents = true;
      renderDiagnosticActiveTab();
    };
  }
}

// Method Tab Rendering
function renderDiagMethodTab() {
  const algo = diagState.diagData?.algorithm || {};
  const sysKey = diagState.system;
  const sysName = (sysKey === 'custom' || sysKey === 'power_rankings') ? 'Power Rankings' : (algo.name || sysKey);

  const dateRangeStr = formatDiagDateRange(diagState.startDate, diagState.endDate) || (diagState.mode === 'historical' ? 'All-time (no date restrictions)' : 'Full period');

  let modeDescription = 'Historical: uses all recorded sets across tournament history.';
  if (diagState.mode === 'period_only') {
    modeDescription = 'Period only: only sets played inside this date range count.';
  } else if (diagState.mode === 'period_performance') {
    modeDescription = 'Period performance: pre-period history establishes starting baseline ratings; performance is evaluated over the date range.';
  }

  const rawConfig = {
    system: sysKey,
    mode: diagState.mode,
    dateRange: {
      start: diagState.startDate || null,
      end: diagState.endDate || null
    },
    formula: algo.parameters?.formula || algo.description || 'Conservative Rating = r - 2*RD',
    weights: diagState.diagData?.weights || prWeights,
    parameters: algo.parameters || {}
  };

  return `
    <div class="diag-card">
      <h3 class="diag-card-title">Rules for this ranking</h3>
      <dl class="diag-method-defs">
        <div class="diag-def-item">
          <dt>SYSTEM</dt>
          <dd>${esc(sysName)}</dd>
        </div>
        <div class="diag-def-item">
          <dt>GAME</dt>
          <dd>${esc(diagState.gameName)}</dd>
        </div>
        <div class="diag-def-item">
          <dt>DATE RANGE</dt>
          <dd>${esc(dateRangeStr)}</dd>
        </div>
        <div class="diag-def-item">
          <dt>MODE</dt>
          <dd>${esc(modeDescription)}</dd>
        </div>
      </dl>
    </div>

    <div class="diag-card">
      <h3 class="diag-card-title">How to read the Sets tab</h3>
      <dl class="diag-method-defs">
        <div class="diag-def-item">
          <dt>Round</dt>
          <dd>The tournament round or bracket phase in which the match was played.</dd>
        </div>
        <div class="diag-def-item">
          <dt>Opponent rank</dt>
          <dd>The final standing of the opponent in this ranking.</dd>
        </div>
        <div class="diag-def-item">
          <dt>Result</dt>
          <dd>Whether the set was won (W) or lost (L) along with the final game count.</dd>
        </div>
        <div class="diag-def-item">
          <dt>Win chance</dt>
          <dd>The pre-match predicted probability of victory based on relative ratings.</dd>
        </div>
        <div class="diag-def-item">
          <dt>Impact</dt>
          <dd>The signed rating or standing point delta resulting from the match outcome.</dd>
        </div>
      </dl>
    </div>

    <div class="diag-card">
      <h3 class="diag-card-title">Raw configuration</h3>
      <pre class="diag-code-block" tabindex="0">${esc(JSON.stringify(rawConfig, null, 2))}</pre>
    </div>
  `;
}


document.addEventListener('DOMContentLoaded', init);
