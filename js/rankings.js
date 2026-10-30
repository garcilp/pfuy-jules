const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Default games fallback if API is unavailable
const DEFAULT_GAMES = [
  { slug: 'ultimate', name: 'Ultimate' },
  { slug: 'rivals-of-aether', name: 'Rivals of Aether' },
  { slug: 'melee', name: 'Melee' },
  { slug: 'rivals-2', name: 'Rivals 2' },
  { slug: 'project-plus', name: 'Project+' }
];

let availableGames = [...DEFAULT_GAMES];
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
  } else if (!section) {
    section = 'systems';
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
const SYSTEM_NAMES = {
  overview: 'Overview',
  glicko2: 'Glicko-2',
  sof: 'Strength of Field',
  quality_wins: 'Quality Wins',
  loss_quality: 'Consistency',
  custom: 'Custom Formula'
};

function renderSystemTabsNav() {
  if (activeSection !== 'systems') return '';
  return `
    <nav id="system-tabs" class="ranking-subsection-tabs" aria-label="Ranking Systems Subsections">
      <button class="ranking-tab ${activeSubsection === 'overview' ? 'active' : ''}" data-system="overview">Overview</button>
      <button class="ranking-tab ${activeSubsection === 'glicko2' ? 'active' : ''}" data-system="glicko2">Glicko-2</button>
      <button class="ranking-tab ${activeSubsection === 'sof' ? 'active' : ''}" data-system="sof">Strength of Field</button>
      <button class="ranking-tab ${activeSubsection === 'quality_wins' ? 'active' : ''}" data-system="quality_wins">Quality Wins</button>
      <button class="ranking-tab ${activeSubsection === 'loss_quality' ? 'active' : ''}" data-system="loss_quality">Consistency</button>
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
    } else {
      const subName = SYSTEM_NAMES[activeSubsection] || activeSubsection;
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

window.navigateToSection = function(section, subsection = null) {
  activeSection = section;
  if (section === 'power_rankings') {
    activeSubsection = 'custom';
  } else {
    activeSubsection = subsection || (activeSubsection === 'custom' ? 'overview' : activeSubsection);
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

  // Load available games
  try {
    const res = await fetch('/api/games');
    if (res.ok) {
      const json = await res.json();
      if (json.games && json.games.length) availableGames = json.games;
    }
  } catch (err) {
    // Fallback to DEFAULT_GAMES
  }

  // Populate game filter
  gameFilter.innerHTML = availableGames.map(g =>
    `<option value="${esc(g.slug)}"${g.slug === state.game ? ' selected' : ''}>${esc(g.name)}</option>`
  ).join('');

  // Set initial filter inputs
  modeFilter.value = state.mode;
  startDateInput.value = state.start;
  endDateInput.value = state.end;
  playerSearch.value = state.search;

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
        startDateInput.value = '';
        endDateInput.value = '';
      } else if (preset === '2025') {
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
      onFilterChange();
    });
  });

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', () => diagnosticModal.close());
  }

  await loadData();

  if (state.player) {
    openDiagnosticModal(state.player);
  }
}

function getActiveSystem() {
  if (activeSection === 'power_rankings') return 'custom';
  return activeSubsection || 'overview';
}

function getCurrentFilterState() {
  return {
    section: activeSection,
    game: gameFilter.value,
    system: getActiveSystem(),
    mode: modeFilter.value,
    start: startDateInput.value,
    end: endDateInput.value,
    search: playerSearch.value.trim()
  };
}

async function onFilterChange(event) {
  if (event && event.target === gameFilter) {
    selectedInspectorPlayerId = null;
  }
  visibleCount = batchSize;
  const state = getCurrentFilterState();
  updateURLState(state);
  await loadData();
}

async function loadData() {
  if (activeFetchController) {
    activeFetchController.abort();
  }
  activeFetchController = new AbortController();
  const signal = activeFetchController.signal;

  const requestId = ++currentRequestId;
  const game = gameFilter.value;
  const system = getActiveSystem();
  const mode = modeFilter.value;
  const start = startDateInput.value;
  const end = endDateInput.value;

  if (start && end && start > end) {
    rankingStatus.textContent = 'Invalid date range: Start date must be before or on end date.';
    rankingsContent.innerHTML = '<div class="panel glass empty-state"><h2>Invalid Date Range</h2><p class="muted">Start date cannot be after end date.</p></div>';
    return;
  }

  rankingStatus.textContent = 'Calculating rankings…';

  try {
    if (system === 'comparison' || system === 'overview' || system === 'custom') {
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
      if (system === 'custom') {
        rankingStatus.textContent = `Displaying Power Rankings for ${getGameName(game)}`;
      } else {
        rankingStatus.textContent = `Displaying rankings overview for ${getGameName(game)}`;
      }
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

async function fetchSystemData(game, system, mode, start, end, signal) {
  const apiURL = `/api/rankings?game=${encodeURIComponent(game)}&system=${encodeURIComponent(system)}&mode=${encodeURIComponent(mode)}${start ? `&start_date=${encodeURIComponent(start)}` : ''}${end ? `&end_date=${encodeURIComponent(end)}` : ''}`;
  try {
    const res = await fetch(apiURL, { signal });
    if (res.ok) {
      return await res.json();
    } else {
      const errJson = await res.json().catch(() => ({}));
      if (errJson.error) return { error: errJson.error };
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Fallback
  }

  const staticURL = `data/rankings/${encodeURIComponent(game)}-${encodeURIComponent(system)}-historical.json`;
  try {
    const res = await fetch(staticURL, { signal });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Snapshot not found
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
      events: p.events
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

function renderCustomPowerRankings() {
  cleanupObserver();

  if (!comparisonData || !Object.keys(comparisonData).length) {
    rankingsContent.innerHTML = '<div class="panel glass empty-state"><h2>No Power Rankings data</h2></div>';
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
    return sortAsc ? (valA - valB) : (valB - valA);
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

  let html = `
    <div class="panel glass pr-setup-panel">
      <div class="pr-header">
        <div>
          <div class="eyebrow mono">CUSTOM POWER RANKINGS CREATOR</div>
          <h2 style="margin:4px 0 0; font-size:26px;">Linked Weights &amp; Formula Budget</h2>
        </div>
        <div style="display:flex; align-items:center; gap:12px;">
          <button class="quiet-button mono" style="font-size:12px; padding:6px 12px; border:1px solid rgba(255,255,255,0.2); border-radius:6px; cursor:pointer;" onclick="resetToDefaultPRWeights()">Reset to Defaults (55/20/15/10)</button>
          <div class="pr-total-badge mono" id="pr-total-badge">
            TOTAL WEIGHT: <b>100%</b>
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

    <div class="panel glass ranking-table-panel">
      <div class="table">
        <div class="tr head ranking-row" style="grid-template-columns: 60px minmax(180px,1.8fr) 110px repeat(4, minmax(90px, 1fr)) 110px;">
          <span class="sortable" onclick="changeSort('rank')">RANK ${sortCol === 'rank' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span class="sortable" onclick="changeSort('playerTag')">PLAYER ${sortCol === 'playerTag' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span class="sortable" onclick="changeSort('score')">SCORE ${sortCol === 'score' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span>GLICKO-2</span>
          <span>QUALITY WINS</span>
          <span>SOF</span>
          <span>CONSISTENCY</span>
          <span>ACTIONS</span>
        </div>

        ${visibleList.length ? visibleList.map(p => `
          <div class="tr ranking-row" style="grid-template-columns: 60px minmax(180px,1.8fr) 110px repeat(4, minmax(90px, 1fr)) 110px; cursor:pointer;" onclick="onPRSelectPlayer('${esc(p.playerId)}')">
            <span class="rank-col font-bold ${p.rank && p.rank <= 3 ? 'p' + p.rank : ''}">#${p.rank}</span>
            <div class="player-col">
              <a href="index.html?player=${encodeURIComponent(p.playerId)}" class="player-card-link" onclick="event.stopPropagation();">
                <span class="player-avatar mini"><img src="assets/players/${esc(p.playerId)}.png" alt="" onerror="this.remove()"></span>
                <b>${esc(p.playerTag)}</b>
              </a>
            </div>
            <span class="score-col mono font-bold">${p.score}</span>
            <span class="mono" style="color:${PR_COMPONENTS.glicko2.color};">${Math.round((p.weightedContributions.glicko2||0)*10)/10} <small class="muted">(${Math.round((p.normalizedScores.glicko2||0)*10)/10})</small></span>
            <span class="mono" style="color:${PR_COMPONENTS.quality_wins.color};">${Math.round((p.weightedContributions.quality_wins||0)*10)/10} <small class="muted">(${Math.round((p.normalizedScores.quality_wins||0)*10)/10})</small></span>
            <span class="mono" style="color:${PR_COMPONENTS.sof.color};">${Math.round((p.weightedContributions.sof||0)*10)/10} <small class="muted">(${Math.round((p.normalizedScores.sof||0)*10)/10})</small></span>
            <span class="mono" style="color:${PR_COMPONENTS.loss_quality.color};">${Math.round((p.weightedContributions.loss_quality||0)*10)/10} <small class="muted">(${Math.round((p.normalizedScores.loss_quality||0)*10)/10})</small></span>
            <div class="actions-col" onclick="event.stopPropagation();">
              <button class="quiet-button diagnostic-btn" onclick="openDiagnosticModal('${esc(p.playerId)}')">Diagnostic</button>
            </div>
          </div>
        `).join('') : '<div class="empty-state"><p class="muted">No players match the search filter.</p></div>'}
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
    return sortAsc ? (valA - valB) : (valB - valA);
  });

  const totalFiltered = list.length;
  const visibleList = list.slice(0, visibleCount);

  const sysInfo = currentData.algorithm || {};

  let html = `
    <div class="panel glass system-banner">
      <h2>${esc(sysInfo.name || systemKey)} Rankings</h2>
      <p class="muted">${esc(sysInfo.description || getSystemDescription(systemKey))}</p>
    </div>

    ${renderSystemTabsNav()}

    <div class="panel glass ranking-table-panel">
      <div class="table">
        <div class="tr head ranking-row">
          <span class="sortable" onclick="changeSort('rank')">RANK ${sortCol === 'rank' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span class="sortable" onclick="changeSort('playerTag')">PLAYER ${sortCol === 'playerTag' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span class="sortable" onclick="changeSort('score')">SCORE ${sortCol === 'score' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span class="sortable" onclick="changeSort('winRate')">WIN % ${sortCol === 'winRate' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span>MATCHES / EVENTS</span>
          <span>ACTIONS</span>
        </div>
        ${visibleList.length ? visibleList.map(p => `
          <div class="tr ranking-row">
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
            <span class="winrate-col mono">${p.winRate !== undefined ? p.winRate + '%' : '-'}</span>
            <span class="matches-col mono">${p.matches !== undefined ? `${p.matches}${p.events !== undefined ? ` (${p.events} event${p.events === 1 ? '' : 's'})` : ''}` : '-'}</span>
            <div class="actions-col">
              <button class="quiet-button diagnostic-btn" onclick="openDiagnosticModal('${esc(p.playerId)}')">Diagnostic</button>
            </div>
          </div>
        `).join('') : '<div class="empty-state"><p class="muted">No players match the search filter.</p></div>'}
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
        playersMap.get(p.playerId)[sys] = { rank: p.rank, score: p.score };
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
            <span class="mono">${p.glicko2 ? (p.glicko2.rank ? `#${p.glicko2.rank} (${p.glicko2.score})` : `- (${p.glicko2.score})`) : '-'}</span>
            <span class="mono">${p.sof ? (p.sof.rank ? `#${p.sof.rank} (${p.sof.score})` : `- (${p.sof.score})`) : '-'}</span>
            <span class="mono">${p.quality_wins ? (p.quality_wins.rank ? `#${p.quality_wins.rank} (${p.quality_wins.score})` : `Unranked (${p.quality_wins.score})`) : '-'}</span>
            <span class="mono">${p.loss_quality ? (p.loss_quality.rank ? `#${p.loss_quality.rank} (${p.loss_quality.score})` : `- (${p.loss_quality.score})`) : '-'}</span>
            <div>
              <button class="quiet-button diagnostic-btn" onclick="openDiagnosticModal('${esc(p.playerId)}')">Diagnostic</button>
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

// Diagnostic Modal
window.openDiagnosticModal = async function(playerId) {
  const game = gameFilter.value;
  const system = getActiveSystem() === 'overview' || getActiveSystem() === 'comparison' ? 'glicko2' : getActiveSystem();
  const mode = modeFilter.value;
  const start = startDateInput.value;
  const end = endDateInput.value;

  modalPlayerInfo.innerHTML = '<p class="muted">Loading calculation diagnostic trace…</p>';
  modalBody.innerHTML = '';
  diagnosticModal.showModal();

  let diagData = null;

  const weightsQuery = system === 'custom' ? `&weights=${encodeURIComponent(JSON.stringify(prWeights))}` : '';
  const apiURL = `/api/rankings/diagnostic?game=${encodeURIComponent(game)}&system=${encodeURIComponent(system)}&mode=${encodeURIComponent(mode)}${start ? `&start_date=${encodeURIComponent(start)}` : ''}${end ? `&end_date=${encodeURIComponent(end)}` : ''}&player_id=${encodeURIComponent(playerId)}${weightsQuery}`;
  try {
    const res = await fetch(apiURL);
    if (res.ok) {
      diagData = await res.json();
    } else {
      const errJson = await res.json().catch(() => ({}));
      if (errJson.error) {
        modalPlayerInfo.innerHTML = `<h2>Player Diagnostic Error</h2>`;
        modalBody.innerHTML = `<p class="muted">${esc(errJson.error)}</p>`;
        return;
      }
    }
  } catch (err) {
    // Fallback
  }

  if (!diagData || !diagData.diagnostic) {
    modalPlayerInfo.innerHTML = `<h2>Player ID ${esc(playerId)}</h2>`;
    modalBody.innerHTML = '<p class="muted">Detailed calculation diagnostic trace requires local server endpoint (/api/rankings/diagnostic).</p>';
    return;
  }

  const diag = diagData.diagnostic;
  const algo = diagData.algorithm || {};
  const summary = diag.summary || {};
  const breakdown = summary.breakdown || {};

  modalPlayerInfo.innerHTML = `
    <div class="diag-player-head">
      <span class="player-avatar"><img src="assets/players/${esc(playerId)}.png" alt="" onerror="this.remove()"></span>
      <div>
        <h2>${esc(diag.playerTag)} <span class="muted font-normal">(ID ${esc(playerId)})</span></h2>
        <p class="muted mono">
          Rank: <b>${diag.playerRank ? '#' + diag.playerRank : 'Unranked'}</b> ·
          Final Score: <b>${diag.finalScore !== null ? diag.finalScore : '-'}</b> ·
          Game: <b>${esc(getGameName(game))}</b> ·
          System: <b>${esc(algo.name || system)}</b> (${esc(mode)})
        </p>
      </div>
    </div>
  `;

  let historyHtml = `
    <div class="diag-summary panel glass">
      <h3>Calculation Context &amp; Algorithm Configuration</h3>
      <div class="mono muted">
        <span>Formula: <b>${esc(summary.formula || algo.description || '')}</b></span><br>
        <span>Parameters: ${formatAlgorithmParams(summary.parameters || algo.parameters)}</span><br>
        ${start || end ? `<span>Date Range: <b>${esc(start || 'Inception')} → ${esc(end || 'Present')}</b></span><br>` : ''}
        <span>Total Matches / Events: <b>${diag.totalMatches || 0} matches (${diag.wins || 0}W - ${diag.losses || 0}L)${diag.events && diag.events.length ? ' / ' + diag.events.length + ' events' : ''}</b></span>
      </div>
    </div>

    <div class="diag-summary panel glass">
      <h3>Representative Breakdown &amp; Intermediate Values</h3>
      <div class="mono muted">
        ${formatBreakdown(system, breakdown)}
      </div>
    </div>
  `;

  if (diag.events && diag.events.length) {
    historyHtml += `
      <h3>Contributing Tournament Events (${diag.events.length})</h3>
      <div class="table diag-table">
        <div class="tr head diag-tr">
          <span>DATE &amp; EVENT</span>
          <span>PLACEMENT</span>
          <span>ENTRANTS</span>
          <span>FIELD STRENGTH</span>
          <span>EVENT POINTS</span>
        </div>
        ${diag.events.map(ev => `
          <div class="tr diag-tr">
            <span>
              <small>${esc(ev.date || '')}</small>
              <b>${ev.eventKey ? `<a href="https://www.start.gg/${esc(ev.eventKey)}" target="_blank" class="player-link">${esc(ev.tournamentName)} · ${esc(ev.eventName)}</a>` : esc(ev.tournamentName + ' · ' + ev.eventName)}</b>
            </span>
            <span class="mono">#${ev.placement}</span>
            <span class="mono">${ev.entrants}</span>
            <span class="mono">${ev.fieldStrength}</span>
            <span class="mono font-bold win">+${ev.eventPoints}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  historyHtml += `
    <h3>Step-by-Step Match Trace (${diag.history ? diag.history.length : 0} sets recorded)</h3>
    <div class="table diag-table">
      <div class="tr head diag-tr">
        <span>DATE &amp; EVENT</span>
        <span>ROUND / PHASE</span>
        <span>OPPONENT</span>
        <span>OUTCOME</span>
        <span>EXPECTED / DIFF</span>
        <span>CONTRIBUTION / PENALTY</span>
      </div>
      ${diag.history && diag.history.length ? diag.history.map(item => `
        <div class="tr diag-tr">
          <span>
            <small>${esc(item.date || '')}</small>
            <b>${item.eventKey ? `<a href="https://www.start.gg/${esc(item.eventKey)}" target="_blank" class="player-link">${esc(item.event || '')}</a>` : esc(item.event || '')}</b>
          </span>
          <span>${esc(item.phase || '')} <small>${esc(item.round || '')}</small></span>
          <span><b>${esc(item.opponentTag)}</b> <small>Pre:${item.opponentPreRating !== undefined ? item.opponentPreRating : '-'}${item.playerPreRating !== undefined ? ' | You:' + item.playerPreRating : ''}</small></span>
          <span class="mono ${item.outcome === 'win' ? 'win' : 'loss'}">${item.outcome.toUpperCase()}</span>
          <span class="mono">${item.expectedScore !== undefined ? 'E:' + item.expectedScore : (item.scoreDisplay || item.displayScore || (item.preScore !== undefined ? item.preScore + '→' + item.postScore : '-'))}</span>
          <span class="mono ${item.penalty !== undefined ? (item.penalty > 0 ? 'loss' : 'win') : (item.credit !== undefined && item.outcome === 'win' ? 'win' : (item.change !== undefined && item.change >= 0 ? 'win' : 'muted'))}">
            ${item.penalty !== undefined ? '-' + item.penalty : (item.credit !== undefined ? (item.outcome === 'win' ? '+' + item.credit : '0.0 (' + (item.exclusionReason || 'Excluded') + ')') : (item.change !== undefined ? (item.change >= 0 ? '+' + item.change : item.change) : (item.contribution !== undefined ? item.contribution : '-')))}
          </span>
        </div>
      `).join('') : '<div class="empty-state"><p class="muted">No contributing sets recorded in this date range.</p></div>'}
    </div>
  `;

  modalBody.innerHTML = historyHtml;
};

function formatBreakdown(systemKey, b) {
  if (!b || !Object.keys(b).length) return '<span>No breakdown details available.</span>';
  if (systemKey === 'glicko2') {
    return `
      <span>Rating (r): <b>${b.rating}</b></span> ·
      <span>Rating Deviation (RD): <b>${b.rd}</b></span> ·
      <span>Volatility (σ): <b>${b.volatility}</b></span><br>
      <span>Conservative Rating (r - 2*RD): <b>${b.conservativeScore}</b></span>
    `;
  } else if (systemKey === 'sof') {
    return `
      <span>Total Event Points: <b>${b.totalEventPoints}</b></span> ·
      <span>Events Count: <b>${b.eventsCount}</b></span><br>
      <span>Avg Field Strength: <b>${b.avgFieldStrength}</b></span> ·
      <span>Sample Dampener: <b>${b.sampleDampener}</b></span>
    `;
  } else if (systemKey === 'quality_wins') {
    return `
      <span>Cumulative QoW Points: <b>${b.totalQualityWins}</b></span> ·
      <span>Eligible Wins: <b>${b.eligibleWins !== undefined ? b.eligibleWins : b.wins}</b></span> ·
      <span>Losses: <b>${b.losses}</b><br>
      <span>Avg Opponent Win Rating: <b>${b.avgOpponentWinRating || '-'}</b></span> ·
      <span>Status: <b>${b.isUnranked ? 'Unranked (0 Wins)' : (b.isProvisional ? 'Provisional (< 3 Wins)' : 'Ranked')}</b></span>
    `;
  } else if (systemKey === 'loss_quality') {
    return `
      <span>Win Credits Total: <b>${b.winCreditsTotal}</b></span> ·
      <span>Loss Penalties Total: <b>${b.lossPenaltiesTotal}</b></span><br>
      <span>Net Performance Points: <b>${b.totalPoints}</b></span> ·
      <span>Matches: <b>${b.matches}</b></span>
    `;
  } else if (systemKey === 'custom') {
    const weightsStr = b.weights ? Object.entries(b.weights).map(([k, v]) => `${k}: ${v}%`).join(' · ') : '';
    const contribsStr = b.weightedContributions ? Object.entries(b.weightedContributions).map(([k, v]) => `${k}: +${v} pts`).join(' · ') : '';
    return `
      <span>Custom Score: <b>${b.finalScore}</b></span><br>
      <span>Configured Weights: <b>${esc(weightsStr)}</b></span><br>
      <span>Weighted Contributions: <b>${esc(contribsStr)}</b></span>
    `;
  }
  return Object.entries(b).map(([k, v]) => `<span>${esc(k)}: <b>${esc(v)}</b></span>`).join(' · ');
}

// Start
document.addEventListener('DOMContentLoaded', init);
