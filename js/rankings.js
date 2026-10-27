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
let currentPage = 1;
const pageSize = 25;

// URL State Sync
function getStateFromURL() {
  const params = new URLSearchParams(window.location.search);
  return {
    game: params.get('game') || 'ultimate',
    system: params.get('system') || 'overview',
    mode: params.get('mode') || 'historical',
    start: params.get('start') || '',
    end: params.get('end') || '',
    search: params.get('search') || '',
    player: params.get('player') || ''
  };
}

function updateURLState(state) {
  const params = new URLSearchParams();
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

// Initialize
async function init() {
  const state = getStateFromURL();

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

  // Set active system tab
  $$('.ranking-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.system === state.system);
  });

  // Add event listeners
  gameFilter.addEventListener('change', onFilterChange);
  modeFilter.addEventListener('change', onFilterChange);
  startDateInput.addEventListener('change', onFilterChange);
  endDateInput.addEventListener('change', onFilterChange);
  playerSearch.addEventListener('input', () => {
    currentPage = 1;
    render();
  });

  $$('.ranking-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.ranking-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPage = 1;
      onFilterChange();
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
  const activeBtn = $('.ranking-tab.active');
  return activeBtn ? activeBtn.dataset.system : 'overview';
}

async function onFilterChange() {
  const state = {
    game: gameFilter.value,
    system: getActiveSystem(),
    mode: modeFilter.value,
    start: startDateInput.value,
    end: endDateInput.value,
    search: playerSearch.value.trim()
  };
  updateURLState(state);
  await loadData();
}

async function loadData() {
  const game = gameFilter.value;
  const system = getActiveSystem();
  const mode = modeFilter.value;
  const start = startDateInput.value;
  const end = endDateInput.value;

  rankingStatus.textContent = 'Calculating rankings…';

  if (system === 'comparison' || system === 'overview') {
    // Load all 4 systems
    const systems = ['glicko2', 'sof', 'quality_wins', 'loss_quality'];
    comparisonData = {};
    for (const sys of systems) {
      comparisonData[sys] = await fetchSystemData(game, sys, mode, start, end);
    }
    rankingStatus.textContent = `Displaying ${system === 'overview' ? 'rankings overview' : 'system comparison'} for ${getGameName(game)}`;
    render();
    return;
  }

  currentData = await fetchSystemData(game, system, mode, start, end);
  if (currentData && currentData.rankings) {
    rankingStatus.textContent = `${currentData.totalPlayers} player${currentData.totalPlayers === 1 ? '' : 's'} ranked in ${currentData.algorithm ? currentData.algorithm.name : system}`;
  } else {
    rankingStatus.textContent = 'No ranking data available.';
  }
  render();
}

async function fetchSystemData(game, system, mode, start, end) {
  const apiURL = `/api/rankings?game=${encodeURIComponent(game)}&system=${encodeURIComponent(system)}&mode=${encodeURIComponent(mode)}${start ? `&start_date=${encodeURIComponent(start)}` : ''}${end ? `&end_date=${encodeURIComponent(end)}` : ''}`;
  try {
    const res = await fetch(apiURL);
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    // Fallback
  }

  const staticURL = `data/rankings/${encodeURIComponent(game)}-${encodeURIComponent(system)}-historical.json`;
  try {
    const res = await fetch(staticURL);
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    // Snapshot not found
  }

  return null;
}

function getGameName(slug) {
  const g = availableGames.find(item => item.slug === slug);
  return g ? g.name : slug;
}

// Render Router
function render() {
  const system = getActiveSystem();
  if (system === 'overview') {
    renderOverview();
  } else if (system === 'comparison') {
    renderComparison();
  } else {
    renderIndividualSystem(system);
  }
}

// Overview View
function renderOverview() {
  if (!comparisonData || !Object.keys(comparisonData).length) {
    rankingsContent.innerHTML = '<div class="panel glass empty-state"><h2>No data available</h2><p class="muted">Check filter parameters or server connection.</p></div>';
    return;
  }

  const gameName = getGameName(gameFilter.value);

  let html = `
    <div class="overview-grid">
      <div class="panel glass overview-banner">
        <h2>Rankings Overview — ${esc(gameName)}</h2>
        <p class="muted">Calculated using 4 distinct ranking systems anchored on pre-match Glicko-2 ratings. Select any system for detailed standings and calculation traces.</p>
        <div class="mode-indicator mono">
          <span>Mode: <b>${esc(modeFilter.value)}</b></span>
          ${startDateInput.value ? `<span>From: <b>${esc(startDateInput.value)}</b></span>` : ''}
          ${endDateInput.value ? `<span>To: <b>${esc(endDateInput.value)}</b></span>` : ''}
        </div>
      </div>

      <div class="cards overview-cards-grid">
  `;

  const systemConfigs = [
    { key: 'glicko2', title: 'Glicko-2', desc: 'Core player skill ratings (r - 2*RD conservative rating)', color: 'var(--gold)' },
    { key: 'sof', title: 'Strength of Field', desc: 'Pre-event competitive opponent strength and performance', color: 'var(--sky)' },
    { key: 'quality_wins', title: 'Quality Wins', desc: 'Credit gained from beating opponents based on expected win probability', color: 'var(--sky)' },
    { key: 'loss_quality', title: 'Loss Quality (Consistency)', desc: 'Measures consistency relative to pre-match expectations. Undefeated = 100.', color: 'var(--text)' }
  ];

  systemConfigs.forEach(sys => {
    const sysData = comparisonData[sys.key];
    const top3 = (sysData && sysData.rankings) ? sysData.rankings.slice(0, 3) : [];

    html += `
      <div class="card glass overview-system-card">
        <div class="system-card-head">
          <h3>${esc(sys.title)}</h3>
          <p class="muted">${esc(sys.desc)}</p>
        </div>
        <div class="top-standings-list">
          ${top3.length ? top3.map((p, idx) => `
            <div class="top-standing-item">
              <span class="rank-num p${idx + 1}">#${idx + 1}</span>
              <a href="index.html?player=${encodeURIComponent(p.playerId)}" class="player-link"><b>${esc(p.playerTag)}</b></a>
              <span class="score-val mono">${p.score}</span>
            </div>
          `).join('') : '<p class="muted">No ranked players</p>'}
        </div>
        <button class="action-button view-sys-btn" onclick="switchToSystem('${sys.key}')">View ${esc(sys.title)} Rankings →</button>
      </div>
    `;
  });

  html += `</div></div>`;
  rankingsContent.innerHTML = html;
}

window.switchToSystem = function(sysKey) {
  $$('.ranking-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.system === sysKey);
  });
  currentPage = 1;
  onFilterChange();
};

// Individual System View
function renderIndividualSystem(systemKey) {
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
  const totalPages = Math.ceil(totalFiltered / pageSize) || 1;
  if (currentPage > totalPages) currentPage = totalPages;

  const startIndex = (currentPage - 1) * pageSize;
  const paginated = list.slice(startIndex, startIndex + pageSize);

  const sysInfo = currentData.algorithm || {};

  let html = `
    <div class="panel glass system-banner">
      <div class="system-banner-head">
        <h2>${esc(sysInfo.name || systemKey)} Rankings</h2>
        <span class="badge mono">Version ${esc(sysInfo.version || '2.0.0')}</span>
      </div>
      <p class="muted">${esc(sysInfo.description || getSystemDescription(systemKey))}</p>
      ${sysInfo.limitations ? `<p class="muted mono"><b>Note:</b> ${esc(sysInfo.limitations)}</p>` : ''}
      <div class="params-row mono">
        ${formatAlgorithmParams(sysInfo.parameters)}
      </div>
    </div>

    <div class="panel glass ranking-table-panel">
      <div class="table">
        <div class="tr head">
          <span class="sortable" onclick="changeSort('rank')">RANK ${sortCol === 'rank' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span class="sortable" onclick="changeSort('playerTag')">PLAYER ${sortCol === 'playerTag' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span class="sortable" onclick="changeSort('score')">SCORE ${sortCol === 'score' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span>KEY METRICS</span>
          <span class="sortable" onclick="changeSort('winRate')">WIN % ${sortCol === 'winRate' ? (sortAsc ? '▲' : '▼') : ''}</span>
          <span>MATCHES</span>
          <span>ACTIONS</span>
        </div>
        ${paginated.length ? paginated.map(p => `
          <div class="tr ranking-row">
            <span class="rank-col font-bold ${p.rank <= 3 ? 'p' + p.rank : ''}">#${p.rank}</span>
            <div class="player-col">
              <a href="index.html?player=${encodeURIComponent(p.playerId)}" class="player-card-link">
                <span class="player-avatar mini"><img src="assets/players/${esc(p.playerId)}.png" alt="" onerror="this.remove()"></span>
                <b>${esc(p.playerTag)}</b>
              </a>
            </div>
            <span class="score-col mono font-bold">${p.score}</span>
            <span class="metrics-col mono muted">${formatMetrics(p, systemKey)}</span>
            <span class="winrate-col mono">${p.winRate !== undefined ? p.winRate + '%' : (p.avgQualityWin !== undefined ? 'Avg:' + p.avgQualityWin : '-')}</span>
            <span class="matches-col mono">${p.matches !== undefined ? p.matches : '-'}</span>
            <div class="actions-col">
              <button class="quiet-button diagnostic-btn" onclick="openDiagnosticModal('${esc(p.playerId)}')">Diagnostic</button>
            </div>
          </div>
        `).join('') : '<div class="empty-state"><p class="muted">No players match the search filter.</p></div>'}
      </div>

      ${totalPages > 1 ? `
        <div class="pagination-controls">
          <button class="quiet-button" ${currentPage === 1 ? 'disabled' : ''} onclick="changePage(${currentPage - 1})">← Previous</button>
          <span class="mono muted">Page ${currentPage} of ${totalPages}</span>
          <button class="quiet-button" ${currentPage === totalPages ? 'disabled' : ''} onclick="changePage(${currentPage + 1})">Next →</button>
        </div>
      ` : ''}
    </div>
  `;

  rankingsContent.innerHTML = html;
}

function getSystemDescription(systemKey) {
  switch (systemKey) {
    case 'glicko2':
      return 'Glicko-2 models rating r, rating deviation RD, and volatility σ. Conservative rating = r - 2RD.';
    case 'sof':
      return 'Strength of Field evaluates competitive strength of opponents faced in sets using pre-match Glicko ratings.';
    case 'quality_wins':
      return 'Quality Wins sums (1 - expected_score) across wins against opponents based on pre-match Glicko ratings.';
    case 'loss_quality':
      return 'Loss Quality measures competitive consistency relative to pre-match expectations. Undefeated players receive 100.';
    default:
      return '';
  }
}

function formatAlgorithmParams(params) {
  if (!params) return '';
  return Object.entries(params).map(([k, v]) => `<span>${esc(k)}: <b>${esc(v)}</b></span>`).join(' · ');
}

function formatMetrics(p, systemKey) {
  if (systemKey === 'glicko2') {
    return `r:${p.rating} RD:${p.rd} vol:${p.volatility}`;
  } else if (systemKey === 'sof') {
    return `Opponent Pre-Rating:${p.avgOpponentRating}`;
  } else if (systemKey === 'quality_wins') {
    return `Total:${p.totalQualityWins} Avg/Win:${p.avgQualityWin}`;
  } else if (systemKey === 'loss_quality') {
    return `W:${p.wins} L:${p.losses} Penalty:${p.totalLossPenalty}`;
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
  render();
};

window.changePage = function(page) {
  currentPage = page;
  renderIndividualSystem(getActiveSystem());
};

// Comparison View
function renderComparison() {
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

  let html = `
    <div class="panel glass system-banner">
      <h2>System Comparison View</h2>
      <p class="muted">Side-by-side player ranks and scores across all 4 distinct systems. Each metric measures a different competitive dimension and raw values are presented on their native scales.</p>
    </div>

    <div class="panel glass ranking-table-panel">
      <div class="table">
        <div class="tr head comparison-head">
          <span>PLAYER</span>
          <span>GLICKO-2</span>
          <span>STRENGTH OF FIELD</span>
          <span>QUALITY WINS</span>
          <span>LOSS QUALITY</span>
          <span>ACTIONS</span>
        </div>
        ${list.length ? list.map(p => `
          <div class="tr ranking-row comparison-row">
            <div class="player-col">
              <a href="index.html?player=${encodeURIComponent(p.playerId)}" class="player-card-link">
                <b>${esc(p.playerTag)}</b>
              </a>
            </div>
            <span class="mono">${p.glicko2 ? `#${p.glicko2.rank} (${p.glicko2.score})` : '-'}</span>
            <span class="mono">${p.sof ? `#${p.sof.rank} (${p.sof.score})` : '-'}</span>
            <span class="mono">${p.quality_wins ? `#${p.quality_wins.rank} (${p.quality_wins.score})` : '-'}</span>
            <span class="mono">${p.loss_quality ? `#${p.loss_quality.rank} (${p.loss_quality.score})` : '-'}</span>
            <div>
              <button class="quiet-button diagnostic-btn" onclick="openDiagnosticModal('${esc(p.playerId)}')">Diagnostic</button>
            </div>
          </div>
        `).join('') : '<div class="empty-state"><p class="muted">No players match the filter.</p></div>'}
      </div>
    </div>
  `;

  rankingsContent.innerHTML = html;
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

  const apiURL = `/api/rankings/diagnostic?game=${encodeURIComponent(game)}&system=${encodeURIComponent(system)}&mode=${encodeURIComponent(mode)}${start ? `&start_date=${encodeURIComponent(start)}` : ''}${end ? `&end_date=${encodeURIComponent(end)}` : ''}&player_id=${encodeURIComponent(playerId)}`;
  try {
    const res = await fetch(apiURL);
    if (res.ok) {
      diagData = await res.json();
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

  modalPlayerInfo.innerHTML = `
    <div class="diag-player-head">
      <span class="player-avatar"><img src="assets/players/${esc(playerId)}.png" alt="" onerror="this.remove()"></span>
      <div>
        <h2>${esc(diag.playerTag)} <span class="muted font-normal">(ID ${esc(playerId)})</span></h2>
        <p class="muted mono">Rank: <b>#${diag.playerRank || '-'}</b> · Final Score: <b>${diag.finalScore !== null ? diag.finalScore : '-'}</b> · System: <b>${esc(algo.name || system)}</b> (${esc(mode)})</p>
      </div>
    </div>
  `;

  let historyHtml = `
    <div class="diag-summary panel glass">
      <h3>Algorithm Configuration &amp; Limitations</h3>
      <div class="mono muted">
        <span>Description: <b>${esc(algo.description || '')}</b></span><br>
        ${algo.limitations ? `<span>Limitations: <b>${esc(algo.limitations)}</b></span><br>` : ''}
        <span>Parameters: ${formatAlgorithmParams(algo.parameters)}</span>
      </div>
    </div>

    <h3>Step-by-Step Calculation Trace (${diag.history ? diag.history.length : 0} sets recorded)</h3>
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
          <span><small>${esc(item.date || '')}</small><b>${esc(item.event || '')}</b></span>
          <span>${esc(item.phase || '')} <small>${esc(item.round || '')}</small></span>
          <span><b>${esc(item.opponentTag)}</b> <small>Pre:${item.opponentPreRating}</small></span>
          <span class="mono ${item.outcome === 'win' ? 'win' : 'loss'}">${item.outcome.toUpperCase()}</span>
          <span class="mono">${item.expectedScore !== undefined ? 'E:' + item.expectedScore : (item.scoreDisplay || item.displayScore || (item.preScore !== undefined ? item.preScore + '→' + item.postScore : '-'))}</span>
          <span class="mono ${item.penalty !== undefined ? (item.penalty > 0 ? 'loss' : 'win') : (item.credit !== undefined ? 'win' : (item.change !== undefined && item.change >= 0 ? 'win' : 'loss'))}">
            ${item.penalty !== undefined ? '-' + item.penalty : (item.credit !== undefined ? '+' + item.credit : (item.change !== undefined ? (item.change >= 0 ? '+' + item.change : item.change) : (item.contribution !== undefined ? item.contribution : '-')))}
          </span>
        </div>
      `).join('') : '<div class="empty-state"><p class="muted">No contributing sets recorded in this date range.</p></div>'}
    </div>
  `;

  modalBody.innerHTML = historyHtml;
};

// Start
document.addEventListener('DOMContentLoaded', init);
