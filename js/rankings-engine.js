/**
 * rankings-engine.js
 * Client-side rankings calculation engine matching scripts/rankings_calculator.py (v2.2.0)
 * Allows computing Glicko-2, SoF, Quality Wins, Consistency, and Power Rankings
 * purely from static JSON files (data/rankings/data/<game>.json).
 */

(function (global) {
  'use strict';

  const ALGORITHM_VERSION = '2.2.0';

  function decomposeFloat(val) {
    const buf = new ArrayBuffer(8);
    const f64 = new Float64Array(buf);
    const u32 = new Uint32Array(buf);
    f64[0] = val;
    const hi = u32[1];
    const lo = u32[0];
    const sign = (hi >>> 31) === 1 ? -1n : 1n;
    const expBits = (hi >>> 20) & 0x7ff;
    let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    if (expBits === 0) {
      if (mantissa === 0n) return { sign, mantissa: 0n, exp: 0 };
      return { sign, mantissa, exp: -1074 };
    } else {
      mantissa |= 1n << 52n;
      return { sign, mantissa, exp: expBits - 1023 - 52 };
    }
  }

  // Exact Python 3 float round(val, ndigits) implementation
  function pyRound(val, ndigits = 0) {
    if (val === null || val === undefined || isNaN(val)) return val;
    if (val === 0) return 0;
    const { sign, mantissa, exp } = decomposeFloat(val);
    if (!mantissa) return 0;

    const nBig = BigInt(ndigits);
    const fivePow = 5n ** nBig;
    const totalExp = BigInt(exp) + nBig;

    let num, den;
    if (totalExp >= 0n) {
      num = mantissa * (2n ** totalExp) * fivePow;
      den = 1n;
    } else {
      num = mantissa * fivePow;
      den = 2n ** (-totalExp);
    }

    let q = num / den;
    let r = num % den;

    const doubledR = 2n * r;
    if (doubledR > den) {
      q += 1n;
    } else if (doubledR === den) {
      if (q % 2n !== 0n) {
        q += 1n;
      }
    }

    const qNum = Number(q);
    const divisor = Math.pow(10, ndigits);
    return Number(sign) * (qNum / divisor);
  }

  // Python 3.12 Neumaier summation matching builtin sum() on floats
  function pySum(iterable) {
    let sum = 0.0;
    let c = 0.0;
    for (const x of iterable) {
      const t = sum + x;
      if (Math.abs(sum) >= Math.abs(x)) {
        c += (sum - t) + x;
      } else {
        c += (x - t) + sum;
      }
      sum = t;
    }
    return sum + c;
  }

  class Glicko2Calculator {
    constructor(r0 = 1500.0, rd0 = 350.0, vol0 = 0.06, tau = 0.5) {
      this.r0 = r0;
      this.rd0 = rd0;
      this.vol0 = vol0;
      this.tau = tau;
      this.scale = 173.7178;
    }

    initialRating() {
      return { r: this.r0, rd: this.rd0, vol: this.vol0 };
    }

    conservativeScore(r, rd) {
      return r - 2.0 * rd;
    }

    toGlicko2Scale(r, rd) {
      return [(r - this.r0) / this.scale, rd / this.scale];
    }

    toOriginalScale(mu, phi) {
      return [mu * this.scale + this.r0, phi * this.scale];
    }

    g(phi) {
      return 1.0 / Math.sqrt(1.0 + 3.0 * (phi ** 2) / (Math.PI ** 2));
    }

    E(mu, muJ, phiJ) {
      return 1.0 / (1.0 + Math.exp(-this.g(phiJ) * (mu - muJ)));
    }

    expectedScoreOriginal(r1, rd1, r2, rd2) {
      const [mu1, phi1] = this.toGlicko2Scale(r1, rd1);
      const [mu2, phi2] = this.toGlicko2Scale(r2, rd2);
      return this.E(mu1, mu2, phi2);
    }

    updatePeriod(r, rd, vol, matches) {
      const [mu, phi] = this.toGlicko2Scale(r, rd);

      if (!matches || matches.length === 0) {
        const phiPrime = Math.sqrt(phi ** 2 + vol ** 2);
        const [rPrime, rdPrime] = this.toOriginalScale(mu, phiPrime);
        return { r: rPrime, rd: Math.min(rdPrime, this.rd0), vol: vol };
      }

      let vInv = 0.0;
      let deltaSum = 0.0;

      for (const [oppR, oppRd, outcomeS] of matches) {
        const [oppMu, oppPhi] = this.toGlicko2Scale(oppR, oppRd);
        const gOpp = this.g(oppPhi);
        const eOpp = this.E(mu, oppMu, oppPhi);

        vInv += (gOpp ** 2) * eOpp * (1.0 - eOpp);
        deltaSum += gOpp * (outcomeS - eOpp);
      }

      const v = 1.0 / vInv;
      const delta = v * deltaSum;

      const a = Math.log(vol ** 2);

      const f = (x) => {
        const ex = Math.exp(x);
        const d2 = delta ** 2;
        const p2 = phi ** 2;
        const num = ex * (d2 - p2 - v - ex);
        const den = 2.0 * ((p2 + v + ex) ** 2);
        return (num / den) - ((x - a) / (this.tau ** 2));
      };

      let A = a;
      let B;
      if ((delta ** 2) > (phi ** 2) + v) {
        B = Math.log((delta ** 2) - (phi ** 2) - v);
      } else {
        let k = 1;
        while (f(a - k * this.tau) < 0) {
          k += 1;
        }
        B = a - k * this.tau;
      }

      let fA = f(A);
      let fB = f(B);

      while (Math.abs(B - A) > 1e-6) {
        const C = A + (A - B) * fA / (fB - fA);
        const fC = f(C);
        if (fC * fB <= 0) {
          A = B;
          fA = fB;
        } else {
          fA = fA / 2.0;
        }
        B = C;
        fB = fC;
      }

      const newVol = Math.exp(A / 2.0);

      const phiStar = Math.sqrt(phi ** 2 + newVol ** 2);
      const phiPrime = 1.0 / Math.sqrt((1.0 / (phiStar ** 2)) + (1.0 / v));
      const muPrime = mu + (phiPrime ** 2) * deltaSum;

      const [rPrime, rdPrime] = this.toOriginalScale(muPrime, phiPrime);

      return { r: rPrime, rd: Math.min(rdPrime, this.rd0), vol: newVol };
    }
  }

  function textId(val) {
    if (val === null || val === undefined) return '';
    return String(val).trim();
  }

  function buildTournamentDateMaps(sets, placements) {
    const eventDates = {};
    const tourneyDates = {};

    for (const p of placements) {
      const eid = textId(p.eventId);
      const tslug = p.tournamentSlug;
      const pDate = p.date;
      if (eid && pDate) {
        eventDates[eid] = pDate;
      }
      if (tslug && pDate) {
        if (!tourneyDates[tslug] || pDate < tourneyDates[tslug]) {
          tourneyDates[tslug] = pDate;
        }
      }
    }

    for (const s of sets) {
      const eid = textId(s.eventId);
      const tslug = s.tournamentSlug;
      const sDate = s.date;
      if (eid && sDate && !eventDates[eid]) {
        eventDates[eid] = sDate;
      }
      if (tslug && sDate && !tourneyDates[tslug]) {
        tourneyDates[tslug] = sDate;
      }
    }

    return { eventDates, tourneyDates };
  }

  function getTournamentDate(item, eventDates, tourneyDates) {
    const eid = textId(item.eventId);
    if (eid && eventDates[eid]) {
      return eventDates[eid];
    }
    const tslug = item.tournamentSlug;
    if (tslug && tourneyDates[tslug]) {
      return tourneyDates[tslug];
    }
    return item.date;
  }

  function filterTournamentDataset(sets, placements, mode, startDate, endDate) {
    if (mode === 'historical') {
      return { prePeriodSets: [], periodSets: [...sets], periodPlacements: [...placements] };
    }

    const { eventDates, tourneyDates } = buildTournamentDateMaps(sets, placements);

    if (mode === 'period_only') {
      if (!startDate && !endDate) {
        throw new Error('Period-only mode requires a start date, end date, or date range.');
      }
      if (startDate && endDate && startDate > endDate) {
        throw new Error('Start date must be before or on end date.');
      }

      const periodSets = [];
      for (const s of sets) {
        const d = getTournamentDate(s, eventDates, tourneyDates);
        if (startDate && d && d < startDate) continue;
        if (endDate && d && d > endDate) continue;
        periodSets.push(s);
      }

      const periodPlacements = [];
      for (const p of placements) {
        const d = getTournamentDate(p, eventDates, tourneyDates);
        if (startDate && d && d < startDate) continue;
        if (endDate && d && d > endDate) continue;
        periodPlacements.push(p);
      }

      return { prePeriodSets: [], periodSets, periodPlacements };
    } else if (mode === 'period_performance') {
      if (!startDate) {
        throw new Error('Period performance mode requires a start date.');
      }
      if (startDate && endDate && startDate > endDate) {
        throw new Error('Start date must be before or on end date.');
      }

      const prePeriodSets = [];
      const periodSets = [];
      for (const s of sets) {
        const d = getTournamentDate(s, eventDates, tourneyDates);
        if (d && d < startDate) {
          prePeriodSets.push(s);
        } else if (!endDate || (d && d <= endDate)) {
          periodSets.push(s);
        }
      }

      const periodPlacements = [];
      for (const p of placements) {
        const d = getTournamentDate(p, eventDates, tourneyDates);
        if (d && d >= startDate && (!endDate || d <= endDate)) {
          periodPlacements.push(p);
        }
      }

      return { prePeriodSets, periodSets, periodPlacements };
    } else {
      throw new Error(`Unknown calculation mode: ${mode}`);
    }
  }

  class ClientRankingEngine {
    constructor(gameData) {
      this.gameData = gameData || { sets: [], placements: [], latestTags: {}, metadata: {} };
      this.sets = this.gameData.sets || [];
      this.placements = this.gameData.placements || [];
      this.latestTags = this.gameData.latestTags || {};
      this.gameSlug = (this.gameData.metadata && this.gameData.metadata.gameSlug) || '';
      this.glickoCalc = new Glicko2Calculator();
    }

    _computePreMatchGlickoRatings(evalSets) {
      const calc = this.glickoCalc;
      const ratings = new Map();

      const getRating = (pid) => {
        if (!ratings.has(pid)) {
          ratings.set(pid, calc.initialRating());
        }
        return ratings.get(pid);
      };

      const eventSetsMap = new Map();
      for (const s of evalSets) {
        const eid = s.eventId;
        if (!eventSetsMap.has(eid)) {
          eventSetsMap.set(eid, []);
        }
        eventSetsMap.get(eid).push(s);
      }

      const preMatchRatings = new Map();
      const eventFieldStrengths = {};

      for (const [eId, eSets] of eventSetsMap.entries()) {
        const eventPlayers = new Set();
        for (const s of eSets) {
          eventPlayers.add(s.winnerId);
          eventPlayers.add(s.loserId);
        }

        const playerMatches = new Map();
        const setPreSnapshots = new Map();

        for (const s of eSets) {
          const wId = s.winnerId;
          const lId = s.loserId;
          const wRat = getRating(wId);
          const lRat = getRating(lId);

          setPreSnapshots.set(`${s.setId}_${wId}`, { ...wRat });
          setPreSnapshots.set(`${s.setId}_${lId}`, { ...lRat });

          if (!playerMatches.has(wId)) playerMatches.set(wId, []);
          playerMatches.get(wId).push([lRat.r, lRat.rd, 1.0]);

          if (!playerMatches.has(lId)) playerMatches.set(lId, []);
          playerMatches.get(lId).push([wRat.r, wRat.rd, 0.0]);
        }

        for (const [k, v] of setPreSnapshots.entries()) {
          preMatchRatings.set(k, v);
        }

        if (eventPlayers.size > 0) {
          let sumR = 0;
          for (const pid of eventPlayers) {
            sumR += getRating(pid).r;
          }
          eventFieldStrengths[eId] = sumR / eventPlayers.size;
        }

        for (const [pid, pM] of playerMatches.entries()) {
          const cur = ratings.get(pid);
          ratings.set(pid, calc.updatePeriod(cur.r, cur.rd, cur.vol, pM));
        }
      }

      return { preMatchRatings, eventFieldStrengths };
    }

    calculateGlicko2(prePeriodSets, periodSets, mode = 'historical', startDate = null, endDate = null, targetPlayerId = null) {
      if (!periodSets) {
        periodSets = prePeriodSets;
        prePeriodSets = [];
      }
      const calc = this.glickoCalc;

      const prePeriodEvents = new Map();
      for (const s of prePeriodSets) {
        if (!prePeriodEvents.has(s.eventId)) prePeriodEvents.set(s.eventId, []);
        prePeriodEvents.get(s.eventId).push(s);
      }

      const periodEvents = new Map();
      for (const s of periodSets) {
        if (!periodEvents.has(s.eventId)) periodEvents.set(s.eventId, []);
        periodEvents.get(s.eventId).push(s);
      }

      const ratings = new Map();
      const stats = new Map();
      const baselineRatings = new Map();
      const diagnosticHistory = new Map();

      const getRating = (pid) => {
        if (!ratings.has(pid)) {
          ratings.set(pid, calc.initialRating());
          stats.set(pid, { wins: 0, losses: 0, matches: 0, events: new Set() });
        }
        return ratings.get(pid);
      };

      const processEventMap = (eventMap, isPeriod) => {
        for (const [eId, eSets] of eventMap.entries()) {
          const playerMatches = new Map();
          const setPreScores = {};

          for (const s of eSets) {
            const wId = s.winnerId;
            const lId = s.loserId;

            const wRat = getRating(wId);
            const lRat = getRating(lId);

            setPreScores[s.setId] = {
              [wId]: [wRat, calc.conservativeScore(wRat.r, wRat.rd)],
              [lId]: [lRat, calc.conservativeScore(lRat.r, lRat.rd)]
            };

            if (!playerMatches.has(wId)) playerMatches.set(wId, []);
            playerMatches.get(wId).push([lRat.r, lRat.rd, 1.0]);

            if (!playerMatches.has(lId)) playerMatches.set(lId, []);
            playerMatches.get(lId).push([wRat.r, wRat.rd, 0.0]);

            if (isPeriod) {
              const wStat = stats.get(wId);
              const lStat = stats.get(lId);
              wStat.wins += 1;
              wStat.matches += 1;
              lStat.losses += 1;
              lStat.matches += 1;
              wStat.events.add(eId);
              lStat.events.add(eId);
            }
          }

          const newRatings = new Map();
          for (const [pid, pM] of playerMatches.entries()) {
            const pRat = ratings.get(pid);
            newRatings.set(pid, calc.updatePeriod(pRat.r, pRat.rd, pRat.vol, pM));
          }

          for (const [pid, newRat] of newRatings.entries()) {
            ratings.set(pid, newRat);
          }

          if (isPeriod || targetPlayerId) {
            for (const s of eSets) {
              const wId = s.winnerId;
              const lId = s.loserId;
              const wPreScore = setPreScores[s.setId][wId][1];
              const lPreScore = setPreScores[s.setId][lId][1];

              const wPost = calc.conservativeScore(ratings.get(wId).r, ratings.get(wId).rd);
              const lPost = calc.conservativeScore(ratings.get(lId).r, ratings.get(lId).rd);

              const items = [
                [wId, true, wPreScore, wPost, lId, lPreScore],
                [lId, false, lPreScore, lPost, wId, wPreScore]
              ];

              for (const [pid, isWin, pre, post, oppId, oppPre] of items) {
                if (targetPlayerId === null || pid === targetPlayerId) {
                  const trace = {
                    setId: s.setId,
                    event: `${s.tournamentName} · ${s.eventName}`,
                    eventKey: s.eventKey,
                    tournamentSlug: s.tournamentSlug,
                    date: s.date,
                    phase: s.phaseName,
                    round: s.roundText,
                    opponentId: oppId,
                    opponentTag: this.latestTags[oppId] || `Player ${oppId}`,
                    opponentPreRating: pyRound(oppPre, 1),
                    outcome: isWin ? 'win' : 'loss',
                    preScore: pyRound(pre, 1),
                    postScore: pyRound(post, 1),
                    change: pyRound(post - pre, 1)
                  };
                  if (!diagnosticHistory.has(pid)) diagnosticHistory.set(pid, []);
                  diagnosticHistory.get(pid).push(trace);
                }
              }
            }
          }
        }
      };

      if (mode === 'period_performance') {
        processEventMap(prePeriodEvents, false);
        for (const [pid, r] of ratings.entries()) {
          baselineRatings.set(pid, calc.conservativeScore(r.r, r.rd));
        }
      }

      processEventMap(periodEvents, true);

      const rankings = [];
      for (const [pid, r] of ratings.entries()) {
        const pStat = stats.get(pid);
        if (pStat.matches === 0 && mode !== 'historical') {
          continue;
        }

        const score = pyRound(calc.conservativeScore(r.r, r.rd), 1);
        const rawBase = baselineRatings.has(pid)
          ? baselineRatings.get(pid)
          : (mode === 'period_only' ? 0.0 : calc.conservativeScore(calc.r0, calc.rd0));
        const baseScore = pyRound(rawBase, 1);
        const change = mode === 'period_performance'
          ? pyRound(score - baseScore, 1)
          : (mode === 'period_only' ? 0.0 : pyRound(score - baseScore, 1));

        rankings.push({
          playerId: pid,
          playerTag: this.latestTags[pid] || `Player ${pid}`,
          score: score,
          rating: pyRound(r.r, 1),
          rd: pyRound(r.rd, 1),
          volatility: pyRound(r.vol, 4),
          baselineScore: baseScore,
          change: change,
          matches: pStat.matches,
          wins: pStat.wins,
          losses: pStat.losses,
          winRate: pyRound(100.0 * pStat.wins / Math.max(1, pStat.matches), 1),
          events: pStat.events.size
        });
      }

      // Python stable sort on score descending
      rankings.sort((a, b) => b.score - a.score);
      rankings.forEach((item, idx) => {
        item.rank = idx + 1;
      });

      const totalSetsConsidered = periodSets.length;

      const result = {
        gameSlug: this.gameSlug,
        system: 'glicko2',
        mode: mode,
        startDate: startDate,
        endDate: endDate,
        totalPlayers: rankings.length,
        totalResultsConsidered: totalSetsConsidered,
        rankings: rankings,
        algorithm: {
          version: ALGORITHM_VERSION,
          name: 'Glicko-2',
          description: 'Measures player skill ratings (r, RD, volatility). Conservative rating = r - 2*RD.',
          limitations: 'Measures skill rating rather than cumulative event achievements or individual match closeness.',
          parameters: {
            initialRating: calc.r0,
            initialRD: calc.rd0,
            initialVolatility: calc.vol0,
            tau: calc.tau,
            formula: 'r - 2 * RD'
          }
        }
      };

      if (targetPlayerId) {
        const pRank = rankings.find(it => it.playerId === targetPlayerId) || null;
        const pHist = diagnosticHistory.get(targetPlayerId) || [];
        const pR = ratings.get(targetPlayerId) || calc.initialRating();
        const pStat = stats.get(targetPlayerId) || { wins: 0, losses: 0, matches: 0 };
        const finalSc = pRank ? pyRound(pRank.score, 1) : null;

        const algParams = {
          tau: calc.tau,
          initialRating: calc.r0,
          initialRD: calc.rd0,
          formula: 'Conservative Rating = Rating (r) - 2 * Rating Deviation (RD)'
        };
        const breakdownDict = {
          rating: pyRound(pR.r, 1),
          rd: pyRound(pR.rd, 1),
          volatility: pyRound(pR.vol, 4),
          conservativeScore: finalSc,
          baselineScore: pRank ? pRank.baselineScore : (mode === 'period_performance' ? pyRound(rawBase, 1) : null),
          change: pRank ? pRank.change : (mode === 'period_performance' ? pyRound(change, 1) : null),
          matches: pStat.matches,
          wins: pStat.wins,
          losses: pStat.losses
        };

        result.diagnostic = {
          context: {
            playerId: targetPlayerId,
            canonicalPlayerId: targetPlayerId,
            playerTag: this.latestTags[targetPlayerId] || `Player ${targetPlayerId}`,
            gameSlug: this.gameSlug,
            system: 'glicko2',
            mode: mode,
            startDate: startDate,
            endDate: endDate,
            finalScore: finalSc,
            rank: pRank ? pRank.rank : null,
            totalResultsConsidered: totalSetsConsidered,
            totalResultsIncluded: pStat.matches
          },
          playerId: targetPlayerId,
          playerTag: this.latestTags[targetPlayerId] || `Player ${targetPlayerId}`,
          playerRank: pRank ? pRank.rank : null,
          finalScore: finalSc,
          totalMatches: pStat.matches,
          wins: pStat.wins,
          losses: pStat.losses,
          algorithmParameters: algParams,
          breakdown: breakdownDict,
          evidence: {
            tournaments: [],
            matches: pHist
          },
          history: pHist,
          events: [],
          summary: {
            system: 'glicko2',
            mode: mode,
            startDate: startDate,
            endDate: endDate,
            formula: 'Conservative Rating = Rating (r) - 2 * Rating Deviation (RD)',
            parameters: algParams,
            breakdown: breakdownDict
          }
        };
      }

      return result;
    }

    calculateSof(prePeriodSets, periodSets, periodPlacements, mode = 'historical', startDate = null, endDate = null, targetPlayerId = null) {
      if (!periodSets && !periodPlacements) {
        periodSets = prePeriodSets;
        prePeriodSets = [];
        periodPlacements = this.placements;
      }
      const evalSets = [...prePeriodSets, ...periodSets];
      const { preMatchRatings, eventFieldStrengths } = this._computePreMatchGlickoRatings(evalSets);

      const playerEvents = new Map();
      for (const p of periodPlacements) {
        const pid = p.playerId;
        const eId = p.eventId;
        const fStrength = eventFieldStrengths[eId] !== undefined ? eventFieldStrengths[eId] : 1500.0;

        const pWeight = 1.0 / Math.sqrt(p.placement);
        const eWeight = Math.log2(p.entrants + 1) / 3.0;
        const rawPts = fStrength * pWeight * eWeight;

        if (!playerEvents.has(pid)) playerEvents.set(pid, []);
        playerEvents.get(pid).push({
          eventId: eId,
          eventName: p.eventName,
          tournamentName: p.tournamentName,
          eventKey: p.eventKey,
          tournamentSlug: p.tournamentSlug,
          placement: p.placement,
          entrants: p.entrants,
          fieldStrength: pyRound(fStrength, 1),
          placementWeight: pyRound(pWeight, 3),
          entrantWeight: pyRound(eWeight, 3),
          eventPoints: pyRound(rawPts, 1),
          date: p.date
        });
      }

      const playerMatches = new Map();
      const diagnosticHistory = new Map();

      for (const s of periodSets) {
        const wId = s.winnerId;
        const lId = s.loserId;
        if (!playerMatches.has(wId)) playerMatches.set(wId, []);
        playerMatches.get(wId).push([s, true]);

        if (!playerMatches.has(lId)) playerMatches.set(lId, []);
        playerMatches.get(lId).push([s, false]);

        for (const pid of [wId, lId]) {
          if (targetPlayerId === null || pid === targetPlayerId) {
            const oppId = pid === wId ? lId : wId;
            const key = `${s.setId}_${oppId}`;
            const oppSnap = preMatchRatings.get(key) || this.glickoCalc.initialRating();
            const oppPre = oppSnap.r;
            const trace = {
              setId: s.setId,
              event: `${s.tournamentName} · ${s.eventName}`,
              eventKey: s.eventKey,
              tournamentSlug: s.tournamentSlug,
              date: s.date,
              phase: s.phaseName,
              round: s.roundText,
              opponentId: oppId,
              opponentTag: this.latestTags[oppId] || `Player ${oppId}`,
              opponentPreRating: pyRound(oppPre, 1),
              outcome: pid === wId ? 'win' : 'loss'
            };
            if (!diagnosticHistory.has(pid)) diagnosticHistory.set(pid, []);
            diagnosticHistory.get(pid).push(trace);
          }
        }
      }

      const rankings = [];
      for (const [pid, evs] of playerEvents.entries()) {
        const matchesInfo = playerMatches.get(pid) || [];
        const mCount = matchesInfo.length;
        if (mCount === 0) continue;

        let wins = 0;
        for (const m of matchesInfo) {
          if (m[1]) wins += 1;
        }
        const losses = mCount - wins;

        const eventPts = pySum(evs.map(e => e.eventPoints));

        const sampleDampener = Math.min(1.0, mCount / 15.0);
        const avgEventScore = (eventPts / evs.length) * sampleDampener;
        const sumField = pySum(evs.map(e => e.fieldStrength));
        const avgField = evs.length > 0 ? sumField / evs.length : 1500.0;

        rankings.push({
          playerId: pid,
          playerTag: this.latestTags[pid] || `Player ${pid}`,
          score: pyRound(avgEventScore, 1),
          totalEventPoints: pyRound(eventPts, 1),
          avgFieldStrength: pyRound(avgField, 1),
          sampleDampener: pyRound(sampleDampener, 3),
          winRate: pyRound(100.0 * wins / Math.max(1, mCount), 1),
          matches: mCount,
          wins: wins,
          losses: losses,
          events: evs.length
        });
      }

      // Python sort: (x["score"], x["matches"]) reverse
      rankings.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.matches - a.matches;
      });
      rankings.forEach((item, idx) => {
        item.rank = idx + 1;
      });

      const result = {
        gameSlug: this.gameSlug,
        system: 'sof',
        mode: mode,
        startDate: startDate,
        endDate: endDate,
        totalPlayers: rankings.length,
        rankings: rankings,
        algorithm: {
          version: ALGORITHM_VERSION,
          name: 'Strength of Field (SoF)',
          description: 'Evaluates competitive accomplishment relative to tournament field strengths, placements, and entrant scaling. Higher placements in strong fields earn top scores.',
          limitations: 'Measures tournament progression in strong fields rather than raw match win-rates.',
          parameters: {
            eventAccomplishment: 'FieldStrength * (1 / sqrt(placement)) * log2(entrants + 1) / 3.0',
            sampleDampening: 'min(1.0, matches / 15.0)'
          }
        }
      };

      if (targetPlayerId) {
        const pRank = rankings.find(it => it.playerId === targetPlayerId) || null;
        const pEvents = playerEvents.get(targetPlayerId) || [];
        const pMatches = playerMatches.get(targetPlayerId) || [];
        const pHist = diagnosticHistory.get(targetPlayerId) || [];

        const wins = pMatches.filter(m => m[1]).length;
        const losses = pMatches.length - wins;

        const algParams = {
          eventAccomplishmentFormula: 'FieldStrength * (1 / sqrt(placement)) * log2(entrants + 1) / 3.0',
          sampleDampeningFormula: 'min(1.0, matches / 15.0)',
          scoreFormula: '(Sum(EventPoints) / EventsCount) * SampleDampener'
        };

        const breakdownDict = {
          finalScore: pRank ? pRank.score : null,
          totalEventPoints: pRank ? pRank.totalEventPoints : 0.0,
          eventsCount: pEvents.length,
          avgFieldStrength: pRank ? pRank.avgFieldStrength : 1500.0,
          sampleDampener: pRank ? pRank.sampleDampener : 0.0,
          matches: pMatches.length,
          wins: wins,
          losses: losses
        };

        result.diagnostic = {
          context: {
            playerId: targetPlayerId,
            canonicalPlayerId: targetPlayerId,
            playerTag: this.latestTags[targetPlayerId] || `Player ${targetPlayerId}`,
            gameSlug: this.gameSlug,
            system: 'sof',
            mode: mode,
            startDate: startDate,
            endDate: endDate,
            finalScore: pRank ? pRank.score : null,
            rank: pRank ? pRank.rank : null,
            totalResultsConsidered: pEvents.length,
            totalResultsIncluded: pEvents.length
          },
          playerId: targetPlayerId,
          playerTag: this.latestTags[targetPlayerId] || `Player ${targetPlayerId}`,
          playerRank: pRank ? pRank.rank : null,
          finalScore: pRank ? pRank.score : null,
          totalMatches: pMatches.length,
          wins: wins,
          losses: losses,
          algorithmParameters: algParams,
          breakdown: breakdownDict,
          events: pEvents,
          history: pHist,
          evidence: {
            tournaments: pEvents,
            matches: pHist
          },
          summary: {
            system: 'sof',
            mode: mode,
            startDate: startDate,
            endDate: endDate,
            formula: 'Score = (Sum(EventPoints) / EventsCount) * min(1.0, matches / 15.0)',
            parameters: algParams,
            breakdown: breakdownDict
          }
        };
      }

      return result;
    }

    calculateQualityWins(prePeriodSets, periodSets, mode = 'historical', startDate = null, endDate = null, targetPlayerId = null) {
      if (!periodSets) {
        periodSets = prePeriodSets;
        prePeriodSets = [];
      }
      const evalSets = [...prePeriodSets, ...periodSets];
      const { preMatchRatings } = this._computePreMatchGlickoRatings(evalSets);
      const calc = this.glickoCalc;
      const provisionalThreshold = 3;
      const confidenceM = 5.0;
      const scaleFactor = 20.0;

      const playerQw = new Map();
      const diagnosticHistory = new Map();

      const safeSnapshot = (snap) => {
        const def = calc.initialRating();
        if (!snap || typeof snap !== 'object') return def;
        let r = parseFloat(snap.r);
        let rd = parseFloat(snap.rd);
        if (isNaN(r) || !isFinite(r)) r = 1500.0;
        if (isNaN(rd) || !isFinite(rd)) rd = 350.0;
        return { r, rd, vol: snap.vol !== undefined ? snap.vol : 0.06 };
      };

      for (const s of periodSets) {
        const wId = s.winnerId;
        const lId = s.loserId;
        const wPre = safeSnapshot(preMatchRatings.get(`${s.setId}_${wId}`));
        const lPre = safeSnapshot(preMatchRatings.get(`${s.setId}_${lId}`));

        const effRatingL = lPre.r - 0.25 * Math.max(0.0, lPre.rd - 50.0);
        const qPointsW = Math.pow(Math.max(0.0, (effRatingL - 1400.0) / 100.0), 1.8);

        if (!playerQw.has(wId)) {
          playerQw.set(wId, { totalQuality: 0.0, wins: 0, losses: 0, points: [], winOpponentRatingsSum: 0.0, events: new Set() });
        }
        const wData = playerQw.get(wId);
        wData.totalQuality += qPointsW;
        wData.wins += 1;
        wData.points.push(qPointsW);
        wData.winOpponentRatingsSum += lPre.r;
        wData.events.add(s.eventId);

        if (!playerQw.has(lId)) {
          playerQw.set(lId, { totalQuality: 0.0, wins: 0, losses: 0, points: [], winOpponentRatingsSum: 0.0, events: new Set() });
        }
        const lData = playerQw.get(lId);
        lData.losses += 1;
        lData.events.add(s.eventId);

        if (targetPlayerId === null || wId === targetPlayerId) {
          const trace = {
            setId: s.setId,
            event: `${s.tournamentName} · ${s.eventName}`,
            eventKey: s.eventKey,
            tournamentSlug: s.tournamentSlug,
            date: s.date,
            phase: s.phaseName,
            round: s.roundText,
            opponentId: lId,
            opponentTag: this.latestTags[lId] || `Player ${lId}`,
            playerPreRating: pyRound(wPre.r, 1),
            opponentPreRating: pyRound(lPre.r, 1),
            opponentPreRD: pyRound(lPre.rd, 1),
            opponentEffectiveRating: pyRound(effRatingL, 1),
            qualityPoints: pyRound(qPointsW, 4),
            outcome: 'win',
            isEligibleWin: true,
            exclusionReason: null
          };
          if (!diagnosticHistory.has(wId)) diagnosticHistory.set(wId, []);
          diagnosticHistory.get(wId).push(trace);
        }

        if (targetPlayerId === null || lId === targetPlayerId) {
          const effRatingW = wPre.r - 0.25 * Math.max(0.0, wPre.rd - 50.0);
          const traceL = {
            setId: s.setId,
            event: `${s.tournamentName} · ${s.eventName}`,
            eventKey: s.eventKey,
            tournamentSlug: s.tournamentSlug,
            date: s.date,
            phase: s.phaseName,
            round: s.roundText,
            opponentId: wId,
            opponentTag: this.latestTags[wId] || `Player ${wId}`,
            playerPreRating: pyRound(lPre.r, 1),
            opponentPreRating: pyRound(wPre.r, 1),
            opponentPreRD: pyRound(wPre.rd, 1),
            opponentEffectiveRating: pyRound(effRatingW, 1),
            qualityPoints: 0.0,
            outcome: 'loss',
            isEligibleWin: false,
            exclusionReason: 'Loss (only victories earn Quality Wins points)'
          };
          if (!diagnosticHistory.has(lId)) diagnosticHistory.set(lId, []);
          diagnosticHistory.get(lId).push(traceL);
        }
      }

      const rankings = [];
      for (const [pid, data] of playerQw.entries()) {
        const wins = data.wins;
        const losses = data.losses;
        const matches = wins + losses;
        if (wins === 0) continue;

        const unadjustedTotQ = data.totalQuality;
        const avgQuality = unadjustedTotQ / wins;
        const confidenceFactor = wins / (wins + confidenceM);
        const adjustedScore = avgQuality * confidenceFactor * scaleFactor;

        const avgOppRating = data.winOpponentRatingsSum / wins;
        const isProvisional = (wins < provisionalThreshold);

        rankings.push({
          playerId: pid,
          playerTag: this.latestTags[pid] || `Player ${pid}`,
          score: pyRound(adjustedScore, 1),
          rawScore: pyRound(adjustedScore, 4),
          avgOpponentQuality: pyRound(avgQuality, 4),
          confidenceFactor: pyRound(confidenceFactor, 4),
          totalQualityWins: pyRound(unadjustedTotQ, 4),
          avgOpponentWinRating: pyRound(avgOppRating, 1),
          wins: wins,
          losses: losses,
          matches: matches,
          winRate: pyRound(100.0 * wins / Math.max(1, matches), 1),
          isProvisional: isProvisional,
          events: data.events.size
        });
      }

      // Python sort: (x["score"], x["wins"], x["matches"]) reverse
      rankings.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.wins !== a.wins) return b.wins - a.wins;
        return b.matches - a.matches;
      });
      rankings.forEach((item, idx) => {
        item.rank = idx + 1;
      });

      const result = {
        gameSlug: this.gameSlug,
        system: 'quality_wins',
        mode: mode,
        startDate: startDate,
        endDate: endDate,
        totalPlayers: rankings.length,
        rankings: rankings,
        algorithm: {
          version: ALGORITHM_VERSION,
          name: 'Quality Wins',
          description: 'Ranks players by average victory quality adjusted for sample confidence. Rewards beating strong opponents without volume inflation.',
          limitations: 'Evaluates defeated opponent quality density relative to a 1400 effective rating baseline.',
          parameters: {
            victoryQualityFormula: 'q_i = max(0, (r_eff,opp - 1400) / 100) ^ 1.8',
            effectiveRatingFormula: 'r_opp - 0.25 * max(0, RD_opp - 50)',
            averageQualityFormula: 'Sum(q_i) / eligible_wins',
            confidenceFactorFormula: 'eligible_wins / (eligible_wins + 5.0)',
            scoreFormula: 'Average Quality * Confidence Factor * 20.0',
            baseline: 1400,
            confidenceParam: confidenceM,
            scale: scaleFactor
          }
        }
      };

      if (targetPlayerId) {
        const pRank = rankings.find(it => it.playerId === targetPlayerId) || null;
        const hist = diagnosticHistory.get(targetPlayerId) || [];
        const pData = playerQw.get(targetPlayerId) || { totalQuality: 0.0, wins: 0, losses: 0, winOpponentRatingsSum: 0.0 };
        const wins = pData.wins;
        const losses = pData.losses;
        const matches = wins + losses;

        const unadjQ = pData.totalQuality;
        const avgQ = wins > 0 ? unadjQ / wins : 0.0;
        const confF = wins > 0 ? wins / (wins + confidenceM) : 0.0;
        const adjSc = wins > 0 ? avgQ * confF * scaleFactor : 0.0;

        const algParams = {
          victoryQualityFormula: 'q_i = max(0, (r_eff,opp - 1400) / 100) ^ 1.8',
          effectiveRatingFormula: 'r_opp - 0.25 * max(0, RD_opp - 50)',
          confidenceFactorFormula: 'eligible_wins / (eligible_wins + 5.0)',
          scoreFormula: 'Average Quality * Confidence Factor * 20.0',
          baseline: 1400,
          confidenceParam: confidenceM,
          scale: scaleFactor
        };

        const breakdownDict = {
          totalQualityWins: pyRound(unadjQ, 4),
          wins: wins,
          eligibleWins: wins,
          losses: losses,
          matches: matches,
          avgOpponentQuality: pyRound(avgQ, 4),
          confidenceFactor: pyRound(confF, 4),
          avgOpponentWinRating: wins > 0 ? pyRound(pData.winOpponentRatingsSum / wins, 1) : null,
          adjustedScore: pyRound(adjSc, 1),
          rawScore: pyRound(adjSc, 4),
          isProvisional: wins < provisionalThreshold,
          isUnranked: wins === 0
        };

        result.diagnostic = {
          context: {
            playerId: targetPlayerId,
            canonicalPlayerId: targetPlayerId,
            playerTag: this.latestTags[targetPlayerId] || `Player ${targetPlayerId}`,
            gameSlug: this.gameSlug,
            system: 'quality_wins',
            mode: mode,
            startDate: startDate,
            endDate: endDate,
            finalScore: pRank ? pRank.score : null,
            rank: pRank ? pRank.rank : null,
            totalResultsConsidered: matches,
            totalResultsIncluded: wins
          },
          playerId: targetPlayerId,
          playerTag: this.latestTags[targetPlayerId] || `Player ${targetPlayerId}`,
          playerRank: pRank ? pRank.rank : null,
          finalScore: pRank ? pRank.score : null,
          totalMatches: matches,
          wins: wins,
          losses: losses,
          algorithmParameters: algParams,
          breakdown: breakdownDict,
          evidence: {
            tournaments: [],
            matches: hist
          },
          history: hist,
          events: [],
          summary: {
            system: 'quality_wins',
            mode: mode,
            startDate: startDate,
            endDate: endDate,
            formula: 'Score = (Sum(q_i) / wins) * (wins / (wins + 5)) * 20',
            parameters: algParams,
            breakdown: breakdownDict
          }
        };
      }

      return result;
    }

    calculateLossQuality(prePeriodSets, periodSets, mode = 'historical', startDate = null, endDate = null, targetPlayerId = null) {
      if (!periodSets) {
        periodSets = prePeriodSets;
        prePeriodSets = [];
      }
      const evalSets = [...prePeriodSets, ...periodSets];
      const { preMatchRatings } = this._computePreMatchGlickoRatings(evalSets);
      const calc = this.glickoCalc;

      const gamma = 0.30;
      const beta = 0.75;
      const betaMin = 0.20;
      const dampenerM = 15.0;

      const playerData = new Map();
      const diagnosticHistory = new Map();

      for (const s of periodSets) {
        const wId = s.winnerId;
        const lId = s.loserId;
        const wPre = preMatchRatings.get(`${s.setId}_${wId}`) || calc.initialRating();
        const lPre = preMatchRatings.get(`${s.setId}_${lId}`) || calc.initialRating();

        const eWin = calc.expectedScoreOriginal(wPre.r, wPre.rd, lPre.r, lPre.rd);
        const eLoss = calc.expectedScoreOriginal(lPre.r, lPre.rd, wPre.r, wPre.rd);

        const winCredit = 1.0 + gamma * Math.max(0.0, (lPre.r - 1500.0) / 400.0);
        const protectionL = Math.max(betaMin, 1.0 - beta * Math.max(0.0, (wPre.r - 1400.0) / 400.0));
        const lossPenalty = eLoss * protectionL;

        const winContrib = winCredit;
        const lossContrib = -lossPenalty;

        if (!playerData.has(wId)) {
          playerData.set(wId, { wins: 0, losses: 0, matches: 0, totalPoints: 0.0, winCredits: 0.0, lossPenalties: 0.0, events: new Set() });
        }
        const wData = playerData.get(wId);
        wData.wins += 1;
        wData.matches += 1;
        wData.totalPoints += winContrib;
        wData.winCredits += winContrib;
        wData.events.add(s.eventId);

        if (!playerData.has(lId)) {
          playerData.set(lId, { wins: 0, losses: 0, matches: 0, totalPoints: 0.0, winCredits: 0.0, lossPenalties: 0.0, events: new Set() });
        }
        const lData = playerData.get(lId);
        lData.losses += 1;
        lData.matches += 1;
        lData.totalPoints += lossContrib;
        lData.lossPenalties += lossPenalty;
        lData.events.add(s.eventId);

        if (targetPlayerId === null || wId === targetPlayerId) {
          const traceW = {
            setId: s.setId,
            event: `${s.tournamentName} · ${s.eventName}`,
            eventKey: s.eventKey,
            tournamentSlug: s.tournamentSlug,
            date: s.date,
            phase: s.phaseName,
            round: s.roundText,
            opponentId: lId,
            opponentTag: this.latestTags[lId] || `Player ${lId}`,
            opponentPreRating: pyRound(lPre.r, 1),
            expectedScore: pyRound(eWin, 3),
            credit: pyRound(winCredit, 3),
            contribution: pyRound(winContrib, 3),
            outcome: 'win'
          };
          if (!diagnosticHistory.has(wId)) diagnosticHistory.set(wId, []);
          diagnosticHistory.get(wId).push(traceW);
        }

        if (targetPlayerId === null || lId === targetPlayerId) {
          const traceL = {
            setId: s.setId,
            event: `${s.tournamentName} · ${s.eventName}`,
            eventKey: s.eventKey,
            tournamentSlug: s.tournamentSlug,
            date: s.date,
            phase: s.phaseName,
            round: s.roundText,
            opponentId: wId,
            opponentTag: this.latestTags[wId] || `Player ${wId}`,
            opponentPreRating: pyRound(wPre.r, 1),
            expectedScore: pyRound(eLoss, 3),
            protection: pyRound(protectionL, 3),
            penalty: pyRound(lossPenalty, 3),
            contribution: pyRound(lossContrib, 3),
            outcome: 'loss'
          };
          if (!diagnosticHistory.has(lId)) diagnosticHistory.set(lId, []);
          diagnosticHistory.get(lId).push(traceL);
        }
      }

      const rankings = [];
      for (const [pid, data] of playerData.entries()) {
        const matches = data.matches;
        if (matches === 0) continue;

        const totPts = data.totalPoints;
        const rawConsistency = 50.0 + (50.0 * totPts / (matches + dampenerM));
        const clampedScore = Math.max(0.0, Math.min(100.0, rawConsistency));
        const consistencyScore = pyRound(clampedScore, 1);

        rankings.push({
          playerId: pid,
          playerTag: this.latestTags[pid] || `Player ${pid}`,
          score: consistencyScore,
          rawScore: pyRound(rawConsistency, 4),
          totalPoints: pyRound(totPts, 3),
          winCredits: pyRound(data.winCredits, 3),
          lossPenalties: pyRound(data.lossPenalties, 3),
          wins: data.wins,
          losses: data.losses,
          matches: matches,
          winRate: pyRound(100.0 * data.wins / Math.max(1, matches), 1),
          events: data.events.size
        });
      }

      // Python sort: (x["score"], x["rawScore"], x["wins"], x["matches"]) reverse
      rankings.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.rawScore !== a.rawScore) return b.rawScore - a.rawScore;
        if (b.wins !== a.wins) return b.wins - a.wins;
        return b.matches - a.matches;
      });
      rankings.forEach((item, idx) => {
        item.rank = idx + 1;
      });

      const result = {
        gameSlug: this.gameSlug,
        system: 'loss_quality',
        mode: mode,
        startDate: startDate,
        endDate: endDate,
        totalPlayers: rankings.length,
        rankings: rankings,
        algorithm: {
          version: ALGORITHM_VERSION,
          name: 'Consistency',
          description: 'Evaluates competitive consistency relative to pre-match expectations and opponent quality. Rewards victories against strong rivals with bonus credit and applies opponent-sensitive loss protection when losing to elite peers.',
          limitations: 'Evaluates opponent-adjusted win performance relative to pre-match Glicko-2 ratings and sample size.',
          parameters: {
            gamma: gamma,
            beta: beta,
            betaMin: betaMin,
            sampleDampener: dampenerM,
            winCreditFormula: '1.0 + gamma * max(0.0, (r_opp - 1500.0) / 400.0)',
            lossProtectionFormula: 'max(beta_min, 1.0 - beta * max(0.0, (r_opp - 1400.0) / 400.0))',
            lossPenaltyFormula: 'E_win * Protection',
            scoreFormula: `max(0.0, min(100.0, 50.0 + 50.0 * NetPoints / (Matches + ${dampenerM})))`
          }
        }
      };

      if (targetPlayerId) {
        const pRank = rankings.find(it => it.playerId === targetPlayerId) || null;
        const hist = diagnosticHistory.get(targetPlayerId) || [];

        const algParams = {
          gamma: gamma,
          beta: beta,
          betaMin: betaMin,
          sampleDampener: dampenerM,
          winCreditFormula: '1.0 + gamma * max(0.0, (r_opp - 1500.0) / 400.0)',
          lossProtectionFormula: 'max(beta_min, 1.0 - beta * max(0.0, (r_opp - 1400.0) / 400.0))',
          lossPenaltyFormula: 'E_win * Protection',
          scoreFormula: `max(0.0, min(100.0, 50.0 + 50.0 * NetPoints / (Matches + ${dampenerM})))`
        };

        const pData = playerData.get(targetPlayerId) || { wins: 0, losses: 0, matches: 0, totalPoints: 0.0, winCredits: 0.0, lossPenalties: 0.0 };

        const breakdownDict = {
          finalScore: pRank ? pRank.score : null,
          rawScore: pRank ? pRank.rawScore : null,
          totalPoints: pyRound(pData.totalPoints, 3),
          winCreditsTotal: pyRound(pData.winCredits, 3),
          lossPenaltiesTotal: pyRound(pData.lossPenalties, 3),
          wins: pData.wins,
          losses: pData.losses,
          matches: pData.matches
        };

        result.diagnostic = {
          context: {
            playerId: targetPlayerId,
            canonicalPlayerId: targetPlayerId,
            playerTag: this.latestTags[targetPlayerId] || `Player ${targetPlayerId}`,
            gameSlug: this.gameSlug,
            system: 'loss_quality',
            mode: mode,
            startDate: startDate,
            endDate: endDate,
            finalScore: pRank ? pRank.score : null,
            rank: pRank ? pRank.rank : null,
            totalResultsConsidered: pData.matches,
            totalResultsIncluded: pData.matches
          },
          playerId: targetPlayerId,
          playerTag: this.latestTags[targetPlayerId] || `Player ${targetPlayerId}`,
          playerRank: pRank ? pRank.rank : null,
          finalScore: pRank ? pRank.score : null,
          totalMatches: pData.matches,
          wins: pData.wins,
          losses: pData.losses,
          algorithmParameters: algParams,
          breakdown: breakdownDict,
          evidence: {
            tournaments: [],
            matches: hist
          },
          history: hist,
          events: [],
          summary: {
            system: 'loss_quality',
            mode: mode,
            startDate: startDate,
            endDate: endDate,
            formula: 'Score = 50.0 + 50.0 * NetPoints / (Matches + 15)',
            parameters: algParams,
            breakdown: breakdownDict
          }
        };
      }

      return result;
    }

    calculateCustom(prePeriodSets, periodSets, periodPlacements, mode, startDate, endDate, targetPlayerId, weights = null) {
      if (weights === null || weights === undefined) {
        weights = { glicko2: 50, quality_wins: 25, sof: 15, loss_quality: 10 };
      } else if (typeof weights === 'string') {
        try {
          weights = JSON.parse(weights);
        } catch (e) {
          weights = { glicko2: 50, quality_wins: 25, sof: 15, loss_quality: 10 };
        }
      }

      const knownSystems = ['glicko2', 'quality_wins', 'sof', 'loss_quality'];
      let cleanWeights = {};
      for (const sys of knownSystems) {
        const val = parseFloat(weights[sys]);
        cleanWeights[sys] = (!isNaN(val) && isFinite(val) && val > 0) ? val : 0.0;
      }

      let totalW = 0;
      for (const k of knownSystems) totalW += cleanWeights[k];

      if (totalW > 0) {
        for (const k of knownSystems) {
          cleanWeights[k] = (cleanWeights[k] / totalW) * 100.0;
        }
      } else {
        cleanWeights = { glicko2: 25.0, quality_wins: 25.0, sof: 25.0, loss_quality: 25.0 };
      }

      const resG2 = this.calculateGlicko2(prePeriodSets, periodSets, mode, startDate, endDate, null);
      const resSof = this.calculateSof(prePeriodSets, periodSets, periodPlacements, mode, startDate, endDate, null);
      const resQw = this.calculateQualityWins(prePeriodSets, periodSets, mode, startDate, endDate, null);
      const resLq = this.calculateLossQuality(prePeriodSets, periodSets, mode, startDate, endDate, null);

      const sysResults = {
        glicko2: resG2,
        sof: resSof,
        quality_wins: resQw,
        loss_quality: resLq
      };

      const playersMap = new Map();
      for (const [sysKey, sysRes] of Object.entries(sysResults)) {
        for (const p of sysRes.rankings || []) {
          const pid = p.playerId;
          if (!playersMap.has(pid)) {
            playersMap.set(pid, {
              playerId: pid,
              playerTag: p.playerTag,
              rawScores: {},
              matches: 0,
              events: 0
            });
          }
          const pObj = playersMap.get(pid);
          pObj.rawScores[sysKey] = p.score;
          pObj.matches = Math.max(pObj.matches, p.matches || 0);
          pObj.events = Math.max(pObj.events, p.events || 0);
        }
      }

      const statsMinMax = {};
      for (const sysKey of knownSystems) {
        const scores = Array.from(playersMap.values()).map(pInfo => pInfo.rawScores[sysKey] !== undefined ? pInfo.rawScores[sysKey] : 0.0);
        if (scores.length > 0) {
          statsMinMax[sysKey] = { min: Math.min(...scores), max: Math.max(...scores) };
        } else {
          statsMinMax[sysKey] = { min: 0.0, max: 100.0 };
        }
      }

      const rankings = [];
      for (const [pid, pInfo] of playersMap.entries()) {
        const normScores = {};
        const weightedContribs = {};
        let finalScore = 0.0;

        for (const sysKey of knownSystems) {
          const rawVal = pInfo.rawScores[sysKey] !== undefined ? pInfo.rawScores[sysKey] : 0.0;
          const mn = statsMinMax[sysKey].min;
          const mx = statsMinMax[sysKey].max;
          let normVal = 100.0;
          if (mx > mn) {
            normVal = ((rawVal - mn) / (mx - mn)) * 100.0;
          }
          normScores[sysKey] = pyRound(normVal, 1);

          const w = cleanWeights[sysKey];
          const contrib = normVal * (w / 100.0);
          weightedContribs[sysKey] = pyRound(contrib, 2);
          finalScore += contrib;
        }

        const cleanWeightsRounded = {};
        for (const [k, v] of Object.entries(cleanWeights)) {
          cleanWeightsRounded[k] = pyRound(v, 1);
        }

        const pEntry = {
          playerId: pid,
          playerTag: pInfo.playerTag,
          score: pyRound(finalScore, 1),
          normalizedScores: normScores,
          weightedContributions: weightedContribs,
          weights: cleanWeightsRounded,
          matches: pInfo.matches,
          events: pInfo.events
        };

        if (mode === 'period_performance' && resG2) {
          const g2P = (resG2.rankings || []).find(x => x.playerId === pid);
          if (g2P) {
            pEntry.baselineScore = g2P.baselineScore;
            pEntry.change = g2P.change;
          }
        }
        rankings.push(pEntry);
      }

      // Python sort: x["score"] reverse
      rankings.sort((a, b) => b.score - a.score);
      rankings.forEach((item, idx) => {
        item.rank = idx + 1;
      });

      const cleanWeightsParams = {};
      const cleanWeightsSummary = {};
      for (const [k, v] of Object.entries(cleanWeights)) {
        cleanWeightsParams[k] = `${pyRound(v, 1)}%`;
        cleanWeightsSummary[k] = pyRound(v, 1);
      }

      const result = {
        gameSlug: this.gameSlug,
        system: 'custom',
        mode: mode,
        startDate: startDate,
        endDate: endDate,
        totalPlayers: rankings.length,
        weights: cleanWeightsSummary,
        rankings: rankings,
        algorithm: {
          version: ALGORITHM_VERSION,
          name: 'Power Rankings',
          description: 'Combines normalized component scores across Glicko-2, Strength of Field, Quality Wins, and Consistency into a custom weighted score.',
          limitations: 'Dependent on configured weighting budget and component normalization across eligible players.',
          parameters: {
            weights: cleanWeightsParams,
            formula: 'Final Score = Sum(NormalizedScore_k * Weight_k / 100)'
          }
        }
      };

      if (targetPlayerId) {
        const pRank = rankings.find(it => it.playerId === targetPlayerId) || null;
        const algParams = cleanWeightsParams;
        const breakdownDict = {
          finalScore: pRank ? pRank.score : null,
          normalizedScores: pRank ? pRank.normalizedScores : {},
          weightedContributions: pRank ? pRank.weightedContributions : {},
          weights: pRank ? pRank.weights : {}
        };

        result.diagnostic = {
          context: {
            playerId: targetPlayerId,
            canonicalPlayerId: targetPlayerId,
            playerTag: this.latestTags[targetPlayerId] || `Player ${targetPlayerId}`,
            gameSlug: this.gameSlug,
            system: 'custom',
            mode: mode,
            startDate: startDate,
            endDate: endDate,
            finalScore: pRank ? pRank.score : null,
            rank: pRank ? pRank.rank : null,
            totalResultsConsidered: periodSets.length,
            totalResultsIncluded: pRank ? pRank.matches : 0
          },
          playerId: targetPlayerId,
          playerTag: this.latestTags[targetPlayerId] || `Player ${targetPlayerId}`,
          playerRank: pRank ? pRank.rank : null,
          finalScore: pRank ? pRank.score : null,
          algorithmParameters: algParams,
          breakdown: breakdownDict,
          evidence: {
            tournaments: [],
            matches: []
          },
          events: [],
          history: [],
          summary: {
            system: 'custom',
            mode: mode,
            startDate: startDate,
            endDate: endDate,
            formula: 'Custom Score = Sum(NormalizedScore_k * Weight_k / 100)',
            parameters: algParams,
            breakdown: breakdownDict
          }
        };
      }

      return result;
    }

    calculate(system = 'glicko2', mode = 'historical', startDate = null, endDate = null, targetPlayerId = null, weights = null) {
      if (startDate && endDate && startDate > endDate) {
        throw new Error('Start date must be before or on end date.');
      }
      if (mode === 'historical') {
        startDate = null;
        endDate = null;
      }

      const { prePeriodSets, periodSets, periodPlacements } = filterTournamentDataset(
        this.sets,
        this.placements,
        mode,
        startDate,
        endDate
      );

      switch (system) {
        case 'glicko2':
          return this.calculateGlicko2(prePeriodSets, periodSets, mode, startDate, endDate, targetPlayerId);
        case 'sof':
          return this.calculateSof(prePeriodSets, periodSets, periodPlacements, mode, startDate, endDate, targetPlayerId);
        case 'quality_wins':
          return this.calculateQualityWins(prePeriodSets, periodSets, mode, startDate, endDate, targetPlayerId);
        case 'loss_quality':
          return this.calculateLossQuality(prePeriodSets, periodSets, mode, startDate, endDate, targetPlayerId);
        case 'custom':
        case 'power_rankings':
          return this.calculateCustom(prePeriodSets, periodSets, periodPlacements, mode, startDate, endDate, targetPlayerId, weights);
        default:
          throw new Error(`Unknown ranking system: ${system}`);
      }
    }
  }

  // Export to environment
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ClientRankingEngine,
      Glicko2Calculator,
      filterTournamentDataset,
      pyRound
    };
  } else {
    global.ClientRankingEngine = ClientRankingEngine;
    global.Glicko2Calculator = Glicko2Calculator;
    global.filterTournamentDataset = filterTournamentDataset;
  }
})(typeof window !== 'undefined' ? window : globalThis);
