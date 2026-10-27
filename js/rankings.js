(function() {
  'use strict';

  let currentRawPlayers = [];
  let currentGame = 'all';
  let currentPeriod = 'all-time';
  let searchQuery = '';

  // Tab Elements
  const tabComparison = document.getElementById('tab-comparison');
  const tabPower = document.getElementById('tab-power');
  const tabArchive = document.getElementById('tab-archive');

  const areaComparison = document.getElementById('area-comparison');
  const areaPower = document.getElementById('area-power');
  const areaArchive = document.getElementById('area-archive');

  // Sliders
  const wTS = document.getElementById('weight-ts');
  const wG2 = document.getElementById('weight-g2');
  const wTP = document.getElementById('weight-tp');
  const wSOF = document.getElementById('weight-sof');

  const valTS = document.getElementById('val-ts');
  const valG2 = document.getElementById('val-g2');
  const valTP = document.getElementById('val-tp');
  const valSOF = document.getElementById('val-sof');

  const weightTotal = document.getElementById('weight-total');

  // Filters
  const filterGame = document.getElementById('filter-game');
  const filterPeriod = document.getElementById('filter-period');
  const searchPlayer = document.getElementById('search-player');

  // Modal
  const btnExplain = document.getElementById('btn-explain');
  const modal = document.getElementById('methodology-modal');
  const modalClose = document.getElementById('modal-close');

  // Archive Modal
  const archiveModal = document.getElementById('archive-modal');
  const archiveModalClose = document.getElementById('archive-modal-close');
  const archiveModalContent = document.getElementById('archive-modal-content');

  function initNav() {
    tabComparison.addEventListener('click', () => switchTab('comparison'));
    tabPower.addEventListener('click', () => switchTab('power'));
    tabArchive.addEventListener('click', () => switchTab('archive'));

    btnExplain.addEventListener('click', () => modal.style.display = 'flex');
    modalClose.addEventListener('click', () => modal.style.display = 'none');
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.style.display = 'none';
    });

    archiveModalClose.addEventListener('click', () => archiveModal.style.display = 'none');
    archiveModal.addEventListener('click', (e) => {
      if (e.target === archiveModal) archiveModal.style.display = 'none';
    });

    filterGame.addEventListener('change', (e) => {
      currentGame = e.target.value;
      fetchStatisticalRankings();
      fetchPowerRankings();
    });

    filterPeriod.addEventListener('change', (e) => {
      currentPeriod = e.target.value;
      fetchStatisticalRankings();
    });

    searchPlayer.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderComparisonTable();
    });

    [wTS, wG2, wTP, wSOF].forEach(slider => {
      slider.addEventListener('input', updateWeights);
    });

    document.getElementById('btn-reset-weights').addEventListener('click', () => {
      wTS.value = 30; wG2.value = 30; wTP.value = 20; wSOF.value = 20;
      updateWeights();
    });
  }

  function switchTab(tab) {
    [tabComparison, tabPower, tabArchive].forEach(t => t.classList.remove('active'));
    [areaComparison, areaPower, areaArchive].forEach(a => a.style.display = 'none');

    if (tab === 'comparison') {
      tabComparison.classList.add('active');
      areaComparison.style.display = 'block';
    } else if (tab === 'power') {
      tabPower.classList.add('active');
      areaPower.style.display = 'block';
      fetchPowerRankings();
    } else if (tab === 'archive') {
      tabArchive.classList.add('active');
      areaArchive.style.display = 'block';
      fetchArchive();
    }
  }

  function updateWeights() {
    valTS.textContent = `${wTS.value}%`;
    valG2.textContent = `${wG2.value}%`;
    valTP.textContent = `${wTP.value}%`;
    valSOF.textContent = `${wSOF.value}%`;

    const total = parseInt(wTS.value) + parseInt(wG2.value) + parseInt(wTP.value) + parseInt(wSOF.value);
    weightTotal.textContent = total;
    if (total !== 100) {
      weightTotal.style.color = '#ff6b6b';
    } else {
      weightTotal.style.color = 'inherit';
    }

    renderComparisonTable();
  }

  async function fetchStatisticalRankings() {
    const tbody = document.getElementById('comparison-tbody');
    tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align: center; padding: 24px;">Calculating rankings...</td></tr>';

    try {
      const res = await fetch(`/api/rankings?game=${encodeURIComponent(currentGame)}&period=${encodeURIComponent(currentPeriod)}`);
      if (!res.ok) throw new Error('Failed to load rankings');
      const data = await res.json();
      currentRawPlayers = data.players || [];
      renderComparisonTable();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8" class="muted" style="text-align: center; padding: 24px; color: #ff6b6b;">Error: ${err.message}</td></tr>`;
    }
  }

  function renderComparisonTable() {
    const tbody = document.getElementById('comparison-tbody');
    if (!currentRawPlayers || currentRawPlayers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align: center; padding: 24px;">No player data available for this filter.</td></tr>';
      return;
    }

    // Calculate individual system ranks
    const sortedTS = [...currentRawPlayers].sort((a, b) => b.trueskill.conservative - a.trueskill.conservative);
    const sortedG2 = [...currentRawPlayers].sort((a, b) => b.glicko2.conservative - a.glicko2.conservative);
    const sortedTP = [...currentRawPlayers].sort((a, b) => b.placings.points - a.placings.points);
    const sortedSOF = [...currentRawPlayers].sort((a, b) => b.strength_of_field.score - a.strength_of_field.score);

    const tsRanks = new Map(sortedTS.map((p, i) => [p.canonical_id, i + 1]));
    const g2Ranks = new Map(sortedG2.map((p, i) => [p.canonical_id, i + 1]));
    const tpRanks = new Map(sortedTP.map((p, i) => [p.canonical_id, i + 1]));
    const sofRanks = new Map(sortedSOF.map((p, i) => [p.canonical_id, i + 1]));

    // Min-Max normalization for component scores
    let minTS = Infinity, maxTS = -Infinity;
    let minG2 = Infinity, maxG2 = -Infinity;
    let minTP = Infinity, maxTP = -Infinity;
    let minSOF = Infinity, maxSOF = -Infinity;

    currentRawPlayers.forEach(p => {
      const ts = p.trueskill.conservative;
      const g2 = p.glicko2.conservative;
      const tp = p.placings.points;
      const sof = p.strength_of_field.score;

      if (ts < minTS) minTS = ts; if (ts > maxTS) maxTS = ts;
      if (g2 < minG2) minG2 = g2; if (g2 > maxG2) maxG2 = g2;
      if (tp < minTP) minTP = tp; if (tp > maxTP) maxTP = tp;
      if (sof < minSOF) minSOF = sof; if (sof > maxSOF) maxSOF = sof;
    });

    const normTS = (val) => (maxTS > minTS) ? ((val - minTS) / (maxTS - minTS)) * 100 : 50;
    const normG2 = (val) => (maxG2 > minG2) ? ((val - minG2) / (maxG2 - minG2)) * 100 : 50;
    const normTP = (val) => (maxTP > minTP) ? ((val - minTP) / (maxTP - minTP)) * 100 : 50;
    const normSOF = (val) => (maxSOF > minSOF) ? ((val - minSOF) / (maxSOF - minSOF)) * 100 : 50;

    const rawSum = parseInt(wTS.value) + parseInt(wG2.value) + parseInt(wTP.value) + parseInt(wSOF.value);
    const weightNorm = rawSum > 0 ? (100 / rawSum) : 1;
    const tsW = (parseInt(wTS.value) * weightNorm) / 100;
    const g2W = (parseInt(wG2.value) * weightNorm) / 100;
    const tpW = (parseInt(wTP.value) * weightNorm) / 100;
    const sofW = (parseInt(wSOF.value) * weightNorm) / 100;

    let processed = currentRawPlayers.map(p => {
      const nTS = normTS(p.trueskill.conservative);
      const nG2 = normG2(p.glicko2.conservative);
      const nTP = normTP(p.placings.points);
      const nSOF = normSOF(p.strength_of_field.score);

      const customScore = (nTS * tsW) + (nG2 * g2W) + (nTP * tpW) + (nSOF * sofW);
      return {
        ...p,
        customScore: Math.round(customScore * 10) / 10,
        tsRank: tsRanks.get(p.canonical_id) || '-',
        g2Rank: g2Ranks.get(p.canonical_id) || '-',
        tpRank: tpRanks.get(p.canonical_id) || '-',
        sofRank: sofRanks.get(p.canonical_id) || '-'
      };
    });

    // Filter by search
    if (searchQuery) {
      processed = processed.filter(p => p.tag.toLowerCase().includes(searchQuery));
    }

    // Sort by custom score desc
    processed.sort((a, b) => b.customScore - a.customScore);

    if (processed.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align: center; padding: 24px;">No players match your search query.</td></tr>';
      return;
    }

    tbody.innerHTML = processed.map((p, idx) => {
      const rank = idx + 1;
      const rankBadgeClass = rank <= 3 ? `badge-rank-${rank}` : '';
      const profileLink = p.canonical_id ? `index.html?player=${encodeURIComponent(p.canonical_id)}` : '#';

      return `
        <tr>
          <td><span class="badge-rank ${rankBadgeClass}">${rank}</span></td>
          <td><a href="${profileLink}" style="font-weight: 600; color: inherit; text-decoration: none;">${p.tag}</a></td>
          <td style="text-align: right;"><strong style="color: #646cff; font-size: 1.05rem;">${p.customScore}</strong></td>
          <td style="text-align: right;">${p.trueskill.conservative} <span class="badge mono" style="font-size:0.75rem; margin-left:4px;">#${p.tsRank}</span></td>
          <td style="text-align: right;">${p.glicko2.conservative} <span class="badge mono" style="font-size:0.75rem; margin-left:4px;">#${p.g2Rank}</span></td>
          <td style="text-align: right;">${p.placings.points} <span class="badge mono" style="font-size:0.75rem; margin-left:4px;">#${p.tpRank}</span></td>
          <td style="text-align: right;">${p.strength_of_field.score} <span class="badge mono" style="font-size:0.75rem; margin-left:4px;">#${p.sofRank}</span></td>
          <td style="text-align: right;" class="muted">${p.matches_count}</td>
        </tr>
      `;
    }).join('');
  }

  async function fetchPowerRankings() {
    const container = document.getElementById('power-rankings-list');
    container.innerHTML = '<p class="muted">Loading official power rankings...</p>';

    try {
      const res = await fetch(`/api/rankings/power?game=${encodeURIComponent(currentGame)}`);
      if (!res.ok) throw new Error('Failed to load power rankings');
      const data = await res.json();
      const prs = data.power_rankings || [];

      if (prs.length === 0) {
        container.innerHTML = '<div class="power-ranking-card"><p class="muted">No official power rankings published for this game selection yet.</p></div>';
        return;
      }

      container.innerHTML = prs.map(pr => `
        <article class="power-ranking-card">
          <h2>${pr.title}</h2>
          <div class="power-ranking-meta">
            <span>Game: <strong>${pr.game_slug}</strong></span> ·
            <span>Published: <strong>${pr.publication_date}</strong></span> ·
            <span>Author: <strong>${pr.author || 'Platfighters Admin'}</strong></span>
          </div>
          ${pr.introduction ? `<p style="margin-bottom: 16px;">${pr.introduction}</p>` : ''}
          <div class="pr-entries">
            ${(pr.entries || []).map(e => `
              <div class="pr-entry-row">
                <div class="pr-entry-pos">#${e.assigned_position}</div>
                <div class="pr-entry-content">
                  <h3>${e.tag || 'Player ' + e.canonical_player_id}</h3>
                  ${e.written_analysis ? `<p>${e.written_analysis}</p>` : ''}
                  ${e.highlights ? `<p class="muted" style="font-size:0.85rem; margin-top:4px;">${e.highlights}</p>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
          ${pr.closing_commentary ? `<p style="margin-top: 16px; font-style: italic;" class="muted">${pr.closing_commentary}</p>` : ''}
        </article>
      `).join('');
    } catch (err) {
      container.innerHTML = `<p style="color: #ff6b6b;">Error: ${err.message}</p>`;
    }
  }

  async function fetchArchive() {
    const container = document.getElementById('archive-list');
    container.innerHTML = '<p class="muted">Loading historical archive...</p>';

    try {
      const res = await fetch(`/api/rankings/archive?game=${encodeURIComponent(currentGame)}`);
      if (!res.ok) throw new Error('Failed to load archive');
      const data = await res.json();
      const prs = data.archive || [];

      if (prs.length === 0) {
        container.innerHTML = '<div class="power-ranking-card"><p class="muted">No archived ranking editions available.</p></div>';
        return;
      }

      container.innerHTML = prs.map(pr => `
        <article class="power-ranking-card">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div>
              <h2 style="margin-bottom: 4px;">${pr.title} <span class="badge mono" style="font-size:0.75rem; vertical-align:middle;">${pr.status}</span></h2>
              <div class="power-ranking-meta">
                <span>Game: <strong>${pr.game_slug}</strong></span> ·
                <span>Published: <strong>${pr.publication_date}</strong></span> ·
                <span>Author: <strong>${pr.author || 'Platfighters Admin'}</strong></span>
              </div>
            </div>
            <button class="glass btn-view-archive" data-id="${pr.id}" style="padding: 6px 14px; cursor: pointer;">View Edition</button>
          </div>
          <p class="muted" style="margin-top: 8px; margin-bottom: 0;">Contains ${pr.entries ? pr.entries.length : 0} ranked players.</p>
        </article>
      `).join('');

      document.querySelectorAll('.btn-view-archive').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = e.target.getAttribute('data-id');
          openArchiveDetail(id);
        });
      });
    } catch (err) {
      container.innerHTML = `<p style="color: #ff6b6b;">Error: ${err.message}</p>`;
    }
  }

  async function openArchiveDetail(prId) {
    archiveModalContent.innerHTML = '<p class="muted">Loading archived edition details...</p>';
    archiveModal.style.display = 'flex';

    try {
      const res = await fetch(`/api/rankings/power/detail?id=${encodeURIComponent(prId)}`);
      if (!res.ok) throw new Error('Failed to load power ranking detail');
      const pr = await res.json();

      archiveModalContent.innerHTML = `
        <h2>${pr.title} <span class="badge mono" style="font-size:0.75rem; vertical-align:middle;">${pr.status}</span></h2>
        <div class="power-ranking-meta">
          <span>Game: <strong>${pr.game_slug}</strong></span> ·
          <span>Published: <strong>${pr.publication_date}</strong></span> ·
          <span>Author: <strong>${pr.author || 'Platfighters Admin'}</strong></span>
        </div>
        ${pr.introduction ? `<p style="margin-bottom: 16px;">${pr.introduction}</p>` : ''}
        <div class="pr-entries" style="margin-top: 16px;">
          ${(pr.entries || []).map(e => `
            <div class="pr-entry-row">
              <div class="pr-entry-pos">#${e.assigned_position}</div>
              <div class="pr-entry-content">
                <h3><a href="${e.canonical_player_id ? 'index.html?player=' + encodeURIComponent(e.canonical_player_id) : '#'}" style="color: inherit; text-decoration: none;">${e.tag || 'Player ' + e.canonical_player_id}</a></h3>
                ${e.written_analysis ? `<p>${e.written_analysis}</p>` : ''}
                ${e.highlights ? `<p class="muted" style="font-size:0.85rem; margin-top:4px;">${e.highlights}</p>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
        ${pr.closing_commentary ? `<p style="margin-top: 16px; font-style: italic;" class="muted">${pr.closing_commentary}</p>` : ''}
      `;
    } catch (err) {
      archiveModalContent.innerHTML = `<p style="color: #ff6b6b;">Error: ${err.message}</p>`;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initNav();
    fetchStatisticalRankings();
  });
})();
