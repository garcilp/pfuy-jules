(function () {
  let staticRankings = null;
  let currentPayload = null;

  const gameSelect = document.getElementById("game-select");
  const systemSelect = document.getElementById("system-select");
  const modeSelect = document.getElementById("mode-select");
  const startDateInput = document.getElementById("start-date");
  const endDateInput = document.getElementById("end-date");
  const calculateBtn = document.getElementById("calculate-btn");
  const statusEl = document.getElementById("rankings-status");
  const tableContainer = document.getElementById("rankings-table-container");
  const tbody = document.getElementById("rankings-tbody");
  const systemInfoEl = document.getElementById("system-info");
  const thScore = document.getElementById("th-score");
  const thDetail = document.getElementById("th-detail");
  const modal = document.getElementById("audit-modal");
  const modalClose = document.getElementById("modal-close");
  const modalTitle = document.getElementById("modal-title");
  const modalBody = document.getElementById("modal-body");

  async function init() {
    try {
      const res = await fetch("data/rankings.json");
      if (res.ok) {
        staticRankings = await res.json();
      }
    } catch (e) {
      console.warn("Could not load static rankings cache:", e);
    }
    loadRankings();
  }

  function updateSystemInfo(system, mode, params) {
    let desc = "";
    if (system === "trueskill") {
      desc = `<strong>TrueSkill System:</strong> Tracks Bayesian skill mean (μ) and uncertainty (σ). Conservative Leaderboard Metric = μ - 3σ. (Initial μ=${params.initialMu}, σ=${params.initialSigma})`;
      thScore.textContent = "Metric (μ - 3σ)";
      thDetail.textContent = "Mean (μ) ± Uncertainty (σ)";
    } else if (system === "glicko2") {
      desc = `<strong>Glicko-2 System:</strong> Standard Glicko-2 algorithm with Rating (R), Rating Deviation (RD), and Volatility (v). Display metric = R - 2RD. (Initial R=${params.initialRating}, RD=${params.initialRD})`;
      thScore.textContent = "Metric (R - 2RD)";
      thDetail.textContent = "Rating ± 2RD";
    } else if (system === "placings") {
      desc = `<strong>Tournament Placings System:</strong> Transparent points formula: <code>Points = 100 * √(entrants / 16) / √(placement)</code>. Evaluates overall placement quality.`;
      thScore.textContent = "Total Points";
      thDetail.textContent = "Events Entered";
    } else if (system === "sof") {
      desc = `<strong>Strength of Field (SoF):</strong> Rates competitive field strength using competitor <em>pre-event</em> ratings. ${params.limitations || ""}`;
      thScore.textContent = "SoF Score";
      thDetail.textContent = "Events / Wins";
    }

    let modeDesc = "";
    if (mode === "historical") {
      modeDesc = "Mode: <strong>Historical rating</strong> (uses all results up to End Date).";
    } else if (mode === "period_only") {
      modeDesc = "Mode: <strong>Period-only</strong> (uses only results within selected period, starting from neutral ratings).";
    } else if (mode === "period_performance") {
      modeDesc = "Mode: <strong>Period performance</strong> (starts from historical ratings prior to period, tracking performance within it).";
    }

    systemInfoEl.innerHTML = `<div>${desc}</div><div style="margin-top:4px;">${modeDesc}</div>`;
  }

  async function loadRankings() {
    const game = gameSelect.value;
    const system = systemSelect.value;
    const mode = modeSelect.value;
    const startDate = startDateInput.value || "";
    const endDate = endDateInput.value || "";

    statusEl.style.display = "block";
    statusEl.textContent = "Calculating rankings…";
    tableContainer.style.display = "none";

    // Try API endpoint first for dynamic queries
    let url = `/api/rankings?game=${encodeURIComponent(game)}&system=${encodeURIComponent(system)}&mode=${encodeURIComponent(mode)}`;
    if (startDate) url += `&startDate=${encodeURIComponent(startDate)}`;
    if (endDate) url += `&endDate=${encodeURIComponent(endDate)}`;

    try {
      const resp = await fetch(url);
      if (resp.ok) {
        currentPayload = await resp.json();
        renderRankings(currentPayload);
        return;
      }
    } catch (err) {
      // Fallback to static cache if server endpoint unavailable
    }

    if (staticRankings && staticRankings[game] && staticRankings[game][system] && !startDate && !endDate && mode === "historical") {
      currentPayload = staticRankings[game][system];
      renderRankings(currentPayload);
      return;
    }

    statusEl.textContent = "No rankings data found for the selected configuration.";
  }

  function renderRankings(payload) {
    statusEl.style.display = "none";
    tableContainer.style.display = "block";
    tbody.innerHTML = "";

    updateSystemInfo(payload.system, payload.mode, payload.parameters || {});

    const list = payload.leaderboard || [];
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center muted" style="padding:24px;">No active competitors found for this game and date range.</td></tr>`;
      return;
    }

    list.forEach((item) => {
      const tr = document.createElement("tr");

      let detailText = "";
      if (payload.system === "trueskill") {
        detailText = `μ=${item.mean.toFixed(2)}, σ=${item.uncertainty.toFixed(2)}`;
      } else if (payload.system === "glicko2") {
        detailText = `R=${Math.round(item.rating)}, RD=${Math.round(item.ratingDeviation)}`;
      } else if (payload.system === "placings") {
        detailText = `${item.eventsCount} events`;
      } else if (payload.system === "sof") {
        detailText = `${item.eventsCount} events (${item.wins}W-${item.losses}L)`;
      }

      const setsText = (item.totalSets !== undefined) ? `${item.wins}W - ${item.losses}L (${item.totalSets})` : `${item.eventsCount} events`;

      tr.innerHTML = `
        <td class="mono font-bold">${item.rank}</td>
        <td>
          <a href="index.html?player=${item.playerId}" class="player-link font-medium">${escapeHtml(item.tag)}</a>
        </td>
        <td class="mono text-right font-bold">${item.displayScore || item.score}</td>
        <td class="mono text-right muted">${detailText}</td>
        <td class="mono text-right">${setsText}</td>
        <td class="mono text-center">
          <button class="btn glass-btn text-xs audit-btn" data-pid="${item.playerId}" data-tag="${escapeHtml(item.tag)}">Inspect</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Add click listeners for audit buttons
    document.querySelectorAll(".audit-btn").forEach((btn) => {
      btn.addEventListener("click", () => openAuditModal(btn.dataset.pid, btn.dataset.tag));
    });
  }

  async function openAuditModal(playerId, tag) {
    modalTitle.textContent = `Diagnostic View: ${tag} (${playerId})`;
    modalBody.innerHTML = "<p class='muted mono'>Loading audit log…</p>";
    modal.style.display = "flex";

    const game = gameSelect.value;
    const system = systemSelect.value;
    const mode = modeSelect.value;
    const startDate = startDateInput.value || "";
    const endDate = endDateInput.value || "";

    let auditTrail = [];

    // Try admin audit endpoint first
    let auditUrl = `/api/admin/rankings/audit?game=${encodeURIComponent(game)}&system=${encodeURIComponent(system)}&mode=${encodeURIComponent(mode)}`;
    if (startDate) auditUrl += `&startDate=${encodeURIComponent(startDate)}`;
    if (endDate) auditUrl += `&endDate=${encodeURIComponent(endDate)}`;

    try {
      const resp = await fetch(auditUrl, { headers: { "X-Admin-Request": "1" } });
      if (resp.ok) {
        const fullPayload = await resp.json();
        auditTrail = fullPayload.auditTrail || [];
      }
    } catch (e) {}

    if (!auditTrail.length && currentPayload && currentPayload.auditTrail) {
      auditTrail = currentPayload.auditTrail;
    }

    // Filter audit entries for this player
    const playerEntries = auditTrail.filter(
      (entry) => entry.playerId === playerId || entry.winnerId === playerId || entry.loserId === playerId
    );

    if (playerEntries.length === 0) {
      modalBody.innerHTML = `<p class="muted">No detailed match log available for this player in the current query view.</p>`;
      return;
    }

    let html = `
      <div style="margin-bottom:12px;" class="mono text-sm muted">
        Matches/Events recorded for calculation: ${playerEntries.length}
      </div>
      <table class="rankings-table text-sm">
        <thead>
          <tr>
            <th>Date</th>
            <th>Event</th>
            <th>Role / Opponent</th>
            <th class="text-right">Shift / Score</th>
          </tr>
        </thead>
        <tbody>
    `;

    playerEntries.forEach((entry) => {
      if (system === "trueskill") {
        const isWinner = entry.winnerId === playerId;
        const oppTag = isWinner ? entry.loserTag : entry.winnerTag;
        const pre = isWinner ? entry.winnerPre : entry.loserPre;
        const post = isWinner ? entry.winnerPost : entry.loserPost;
        const preScore = (pre.mu - 3 * pre.sigma).toFixed(2);
        const postScore = (post.mu - 3 * post.sigma).toFixed(2);

        html += `
          <tr>
            <td class="mono">${entry.date || "—"}</td>
            <td>${escapeHtml(entry.event || "")}</td>
            <td>${isWinner ? "<span style='color:var(--sky);'>WIN vs</span>" : "<span style='color:#e57373;'>LOSS vs</span>"} ${escapeHtml(oppTag)}</td>
            <td class="mono text-right">${preScore} &rarr; <strong>${postScore}</strong></td>
          </tr>
        `;
      } else if (system === "glicko2") {
        html += `
          <tr>
            <td class="mono">${entry.date || "—"}</td>
            <td>${escapeHtml(entry.event || "")}</td>
            <td>Event Period Update</td>
            <td class="mono text-right">${entry.preRating} &rarr; <strong>${entry.postRating}</strong> (RD: ${entry.postRD})</td>
          </tr>
        `;
      } else if (system === "placings") {
        html += `
          <tr>
            <td class="mono">${entry.date || "—"}</td>
            <td>${escapeHtml(entry.event || "")}</td>
            <td>Placed #${entry.placement} / ${entry.entrants} entrants</td>
            <td class="mono text-right"><strong>+${entry.pointsAwarded} pts</strong></td>
          </tr>
        `;
      } else if (system === "sof") {
        html += `
          <tr>
            <td class="mono">${entry.date || "—"}</td>
            <td>${escapeHtml(entry.event || "")}</td>
            <td>Pre-Rating: ${entry.preEventRating} | Field: ${entry.fieldStrength}</td>
            <td class="mono text-right"><strong>+${entry.eventSoFPoints} SoF</strong> (${entry.eventWins}W-${entry.eventLosses}L)</td>
          </tr>
        `;
      }
    });

    html += `</tbody></table>`;
    modalBody.innerHTML = html;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  calculateBtn.addEventListener("click", loadRankings);
  modalClose.addEventListener("click", () => (modal.style.display = "none"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.style.display = "none";
  });

  init();
})();
