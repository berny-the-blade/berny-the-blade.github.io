// ============================================================
// Pernambuco Domino — Symbolic Belief + State Encoder (JS)
// Mirror of training/symbolic_belief.py + training/domino_encoder.py
//
// Produces the 175-dim symbolic-belief feature vector and the
// 268-dim Branch B base state, concatenated to 443 dims to feed
// the symbolic-belief champion (cloud_a100_g00150.pt).
//
// Plain JS, no build deps. Exposed as window.SymbolicEncoder.
// ============================================================

(function (root) {
  'use strict';

  var NUM_TILES = 28;
  var NUM_PIPS = 7;

  // TILES[i] = [a, b] with a <= b. Matches Python TILES order.
  var TILES = [];
  for (var i = 0; i < NUM_PIPS; i++) {
    for (var j = i; j < NUM_PIPS; j++) {
      TILES.push([i, j]);
    }
  }
  if (TILES.length !== NUM_TILES) {
    throw new Error('SymbolicEncoder: TILES length ' + TILES.length + ' != ' + NUM_TILES);
  }

  // Pip a present in tile t? (a or b matches)
  function tileContainsPip(tileIdx, pip) {
    var t = TILES[tileIdx];
    return t[0] === pip || t[1] === pip;
  }

  function tilePips(tileIdx) {
    return TILES[tileIdx];
  }

  // ----------------------------------------------------------
  // PublicObservation.from_obs equivalent — accepts a flat obs
  // dict matching Python's DominoEnv.get_obs() shape:
  //   {player, hand:[tileIdx], played:[tileIdx]|Set, hand_sizes:[4],
  //    cant_have:[Set,Set,Set,Set], (optional) plays_by, recent_actions}
  // ----------------------------------------------------------
  function publicObsFromObs(obs, dormeSize) {
    var observerSeat = ((obs.player | 0) || 0);
    var myHand = [].slice.call(obs.hand || []);
    var played;
    if (obs.played && typeof obs.played.forEach === 'function' && !(obs.played instanceof Array)) {
      played = [];
      obs.played.forEach(function (v) { played.push(v); });
    } else {
      played = [].slice.call(obs.played || []);
    }
    var rawHs = obs.hand_sizes || obs.handSizes || [0, 0, 0, 0];
    var handSizes = [0, 0, 0, 0];
    for (var k = 0; k < 4; k++) handSizes[k] = (rawHs[k] | 0) || 0;
    var rawCh = obs.cant_have || obs.cantHave || [];
    var cantHave = [new Set(), new Set(), new Set(), new Set()];
    for (var s = 0; s < 4; s++) {
      var src = rawCh[s];
      if (!src) continue;
      if (src instanceof Set) {
        src.forEach(function (v) { cantHave[s].add(v | 0); });
      } else {
        for (var x = 0; x < src.length; x++) cantHave[s].add(src[x] | 0);
      }
    }
    return {
      observerSeat: observerSeat,
      myHand: myHand,
      played: played,
      handSizes: handSizes,
      cantHavePips: cantHave,
      dormeSize: (dormeSize == null) ? 4 : dormeSize,
    };
  }

  // ----------------------------------------------------------
  // deduce(pubObs) — mirror of symbolic_belief.deduce()
  // Returns {seatLacksPip, pipUnplayedCount, pipExhausted,
  //          tileCannotBeIn, tileMustBeIn, tileMustBeInDorme,
  //          observerSeat, featureVector(): Float32Array(175)}
  // ----------------------------------------------------------
  function deduce(pub) {
    // 1. seat_lacks_pip — directly from pass-tracking
    // shape (4, 7) flattened: idx = seat*7 + pip
    var seatLacks = new Uint8Array(4 * NUM_PIPS);
    for (var s = 0; s < 4; s++) {
      pub.cantHavePips[s].forEach(function (p) {
        if (p >= 0 && p < NUM_PIPS) seatLacks[s * NUM_PIPS + p] = 1;
      });
    }

    // 2. pip_unplayed_count
    var playedSet = new Set();
    for (var i = 0; i < pub.played.length; i++) playedSet.add(pub.played[i] | 0);

    var pipCount = new Int32Array(NUM_PIPS);
    for (var t = 0; t < NUM_TILES; t++) {
      if (playedSet.has(t)) continue;
      var pp = TILES[t];
      var a = pp[0], b = pp[1];
      pipCount[a] += 1;
      if (a !== b) pipCount[b] += 1;
    }

    // 3. pip_exhausted
    var pipExhausted = new Uint8Array(NUM_PIPS);
    for (var p = 0; p < NUM_PIPS; p++) pipExhausted[p] = (pipCount[p] === 0) ? 1 : 0;

    var myHandSet = new Set();
    for (var hi = 0; hi < pub.myHand.length; hi++) myHandSet.add(pub.myHand[hi] | 0);

    // 4. tile_cannot_be_in[t][s] — shape (28, 4) flattened: idx = t*4 + s
    var cannotBe = new Uint8Array(NUM_TILES * 4);
    for (var t2 = 0; t2 < NUM_TILES; t2++) {
      var off = t2 * 4;
      if (playedSet.has(t2)) {
        cannotBe[off] = 1; cannotBe[off + 1] = 1; cannotBe[off + 2] = 1; cannotBe[off + 3] = 1;
        continue;
      }
      if (myHandSet.has(t2)) {
        for (var ss = 0; ss < 4; ss++) {
          if (ss !== pub.observerSeat) cannotBe[off + ss] = 1;
        }
        continue;
      }
      var pa = TILES[t2][0], pb = TILES[t2][1];
      for (var ss2 = 0; ss2 < 4; ss2++) {
        if (seatLacks[ss2 * NUM_PIPS + pa] || seatLacks[ss2 * NUM_PIPS + pb]) {
          cannotBe[off + ss2] = 1;
        }
      }
      for (var ss3 = 0; ss3 < 4; ss3++) {
        if (pub.handSizes[ss3] === 0) cannotBe[off + ss3] = 1;
      }
    }

    // 5. tile_must_be_in[t][s] + tile_must_be_in_dorme
    var mustBe = new Uint8Array(NUM_TILES * 4);
    var mustBeInDorme = new Uint8Array(NUM_TILES);
    for (var t3 = 0; t3 < NUM_TILES; t3++) {
      if (playedSet.has(t3) || myHandSet.has(t3)) continue;
      var possible = [];
      for (var sP = 0; sP < 4; sP++) {
        if (!cannotBe[t3 * 4 + sP]) possible.push(sP);
      }
      var dormePossible = pub.dormeSize > 0;
      if (possible.length === 0 && !dormePossible) {
        // logically inconsistent, skip
        continue;
      }
      if (possible.length === 1 && !dormePossible) {
        mustBe[t3 * 4 + possible[0]] = 1;
      } else if (possible.length === 0 && dormePossible) {
        mustBeInDorme[t3] = 1;
      }
    }

    // ------------------ feature_vector ------------------
    function featureVector() {
      var sObs = pub.observerSeat | 0;
      // rot[0..3] = self, partner, lho, rho
      var rot = [sObs, (sObs + 2) % 4, (sObs + 1) % 4, (sObs + 3) % 4];
      var out = new Float32Array(28 + 4 * 28 + 7 + 4 * 7); // 175

      // [0:28]   tile_must_be_in_self    -> mustBe[:, rot[0]]
      // [28:56]  tile_must_be_in_partner -> mustBe[:, rot[1]]
      // [56:84]  tile_must_be_in_lho     -> mustBe[:, rot[2]]
      // [84:112] tile_must_be_in_rho     -> mustBe[:, rot[3]]
      for (var slot = 0; slot < 4; slot++) {
        var seat = rot[slot];
        var base = slot * 28;
        for (var ti = 0; ti < NUM_TILES; ti++) {
          out[base + ti] = mustBe[ti * 4 + seat] ? 1.0 : 0.0;
        }
      }
      // [112:140] tile_must_be_in_dorme
      for (var ti2 = 0; ti2 < NUM_TILES; ti2++) {
        out[112 + ti2] = mustBeInDorme[ti2] ? 1.0 : 0.0;
      }
      // [140:147] pip_exhausted
      for (var pp2 = 0; pp2 < NUM_PIPS; pp2++) {
        out[140 + pp2] = pipExhausted[pp2] ? 1.0 : 0.0;
      }
      // [147:175] seat_lacks_pip[rot, :].flatten() — observer-relative, row-major
      for (var rsl = 0; rsl < 4; rsl++) {
        var seat2 = rot[rsl];
        for (var pi = 0; pi < NUM_PIPS; pi++) {
          out[147 + rsl * 7 + pi] = seatLacks[seat2 * NUM_PIPS + pi] ? 1.0 : 0.0;
        }
      }
      return out;
    }

    return {
      seatLacksPip: seatLacks,
      pipUnplayedCount: pipCount,
      pipExhausted: pipExhausted,
      tileCannotBeIn: cannotBe,
      tileMustBeIn: mustBe,
      tileMustBeInDorme: mustBeInDorme,
      observerSeat: pub.observerSeat,
      featureVector: featureVector,
    };
  }

  // ----------------------------------------------------------
  // Belief reset/sync helpers — mirror DominoEncoder.belief
  // We need a per-encoder belief state to produce the [119:203]
  // belief block exactly the way Python's _sync_belief does.
  //
  // belief[t][zone] zones: 0=partner, 1=LHO, 2=RHO, 3=dorme
  // Initialized to 0.25 each, zeroed out as constraints arrive.
  // ----------------------------------------------------------
  function makeBelief() {
    var b = new Float64Array(NUM_TILES * 4);
    for (var t = 0; t < NUM_TILES; t++) {
      b[t * 4] = 0.25; b[t * 4 + 1] = 0.25; b[t * 4 + 2] = 0.25; b[t * 4 + 3] = 0.25;
    }
    return b;
  }

  // Stateless belief computation — recomputes from observation alone.
  // Matches `DominoEncoder` initial-state encode() (no prior update_on_play
  // calls). For real-time inference we don't accumulate Bayesian mass between
  // moves; we always start from a fresh uniform prior, then _sync_belief
  // applies constraints. Output: Float64Array(28*4) row-major [t][zone].
  function computeBelief(obs) {
    var belief = makeBelief();
    var me = obs.player | 0;
    var partner = (me + 2) % 4;
    var lho = (me + 1) % 4;
    var rho = (me + 3) % 4;
    var other = [partner, lho, rho];

    var myHandSet = new Set();
    for (var hi = 0; hi < (obs.hand || []).length; hi++) myHandSet.add(obs.hand[hi] | 0);
    var playedSet = new Set();
    var pl = obs.played;
    if (pl && pl.forEach && !(pl instanceof Array)) {
      pl.forEach(function (v) { playedSet.add(v | 0); });
    } else if (pl) {
      for (var pi = 0; pi < pl.length; pi++) playedSet.add(pl[pi] | 0);
    }

    var cantHave = [];
    for (var c = 0; c < 4; c++) {
      var src = (obs.cant_have && obs.cant_have[c]) || (obs.cantHave && obs.cantHave[c]) || new Set();
      var s = new Set();
      if (src instanceof Set) {
        src.forEach(function (v) { s.add(v | 0); });
      } else {
        for (var x = 0; x < src.length; x++) s.add(src[x] | 0);
      }
      cantHave.push(s);
    }

    for (var t = 0; t < NUM_TILES; t++) {
      var off = t * 4;
      if (myHandSet.has(t) || playedSet.has(t)) {
        belief[off] = 0; belief[off + 1] = 0; belief[off + 2] = 0; belief[off + 3] = 0;
        continue;
      }
      var pp = TILES[t];
      var left = pp[0], right = pp[1];
      var changed = false;
      for (var zi = 0; zi < 3; zi++) {
        var zoneIdx = zi; // belief column for partner/LHO/RHO
        var pAbs = other[zi];
        if (belief[off + zoneIdx] > 0) {
          if (cantHave[pAbs].has(left) || cantHave[pAbs].has(right)) {
            belief[off + zoneIdx] = 0;
            changed = true;
          }
        }
      }
      if (changed) {
        var sumZ = belief[off] + belief[off + 1] + belief[off + 2] + belief[off + 3];
        if (sumZ > 0) {
          belief[off] /= sumZ; belief[off + 1] /= sumZ; belief[off + 2] /= sumZ; belief[off + 3] /= sumZ;
        } else {
          belief[off] = 0; belief[off + 1] = 0; belief[off + 2] = 0; belief[off + 3] = 1;
        }
      }
    }
    return belief;
  }

  // Conditional belief: P(zone | not dorme). Mirror of
  // DominoEncoder.export_conditional_belief().
  // Returns Float32Array(28*3), row-major [t][zone].
  function exportConditionalBelief(belief) {
    var out = new Float32Array(NUM_TILES * 3);
    for (var t = 0; t < NUM_TILES; t++) {
      var off = t * 4;
      var s = belief[off] + belief[off + 1] + belief[off + 2];
      var oo = t * 3;
      if (s > 0) {
        out[oo] = belief[off] / s;
        out[oo + 1] = belief[off + 1] / s;
        out[oo + 2] = belief[off + 2] / s;
      } // else zeros
    }
    return out;
  }

  // tile_contains_counts — pip presence (1 occurrence per distinct pip).
  // Returns Float32Array(7).
  function tileContainsCounts(tileIdx) {
    var out = new Float32Array(NUM_PIPS);
    var pp = TILES[tileIdx];
    out[pp[0]] = 1.0;
    out[pp[1]] = 1.0; // idempotent for doubles
    return out;
  }

  // ----------------------------------------------------------
  // encodeStateBaseBranchC(obs, scores) -> Float32Array(268)
  //
  // Mirror of DominoEncoder.encode() with input_dim=268 (Branch B layout).
  // scores = {my_score, opp_score, multiplier}.
  // ----------------------------------------------------------
  function encodeStateBaseBranchB(obs, scores) {
    scores = scores || {};
    var myScore = scores.my_score | 0;
    var oppScore = scores.opp_score | 0;
    var multiplier = (scores.multiplier == null) ? 1 : scores.multiplier;

    var state = new Float32Array(268);
    var me = obs.player | 0;
    var partner = (me + 2) % 4;
    var lho = (me + 1) % 4;
    var rho = (me + 3) % 4;

    // [0:28] my hand
    for (var i = 0; i < (obs.hand || []).length; i++) {
      state[obs.hand[i] | 0] = 1.0;
    }

    // [28:56] played tiles
    var pl = obs.played;
    if (pl && pl.forEach && !(pl instanceof Array)) {
      pl.forEach(function (v) { state[28 + (v | 0)] = 1.0; });
    } else if (pl) {
      for (var pi = 0; pi < pl.length; pi++) state[28 + (pl[pi] | 0)] = 1.0;
    }

    // [56:63] left end one-hot
    var le = (obs.left_end == null ? -1 : obs.left_end) | 0;
    if (le >= 0 && le <= 6) state[56 + le] = 1.0;

    // [63:70] right end one-hot
    var re = (obs.right_end == null ? -1 : obs.right_end) | 0;
    if (re >= 0 && re <= 6) state[63 + re] = 1.0;

    // [70:91] cant_have for 3 other players (partner, lho, rho)
    var ch = obs.cant_have || obs.cantHave;
    var others = [partner, lho, rho];
    for (var oi = 0; oi < 3; oi++) {
      var src = ch ? ch[others[oi]] : null;
      if (!src) continue;
      var iter = (src instanceof Set) ? src : src;
      iter.forEach(function (n) {
        var nn = n | 0;
        if (nn >= 0 && nn <= 6) state[70 + oi * 7 + nn] = 1.0;
      });
    }

    // [91:119] partner play history (binary)
    var partnerPlays = (obs.plays_by && obs.plays_by[partner]) || (obs.playsBy && obs.playsBy[partner]) || [];
    for (var ppI = 0; ppI < partnerPlays.length; ppI++) {
      state[91 + (partnerPlays[ppI] | 0)] = 1.0;
    }

    // [119:203] belief: 3 zones x 28 tiles, fed by exportConditionalBelief.
    var belief = computeBelief(obs);
    var cond = exportConditionalBelief(belief);
    for (var zoneI = 0; zoneI < 3; zoneI++) {
      var zBase = 119 + zoneI * 28;
      for (var ti = 0; ti < NUM_TILES; ti++) {
        state[zBase + ti] = cond[ti * 3 + zoneI];
      }
    }

    // [203:207] hand sizes (normalized /6) — order: me, partner, lho, rho
    var hs = obs.hand_sizes || obs.handSizes || [0, 0, 0, 0];
    var seatOrder = [me, partner, lho, rho];
    for (var soi = 0; soi < 4; soi++) {
      state[203 + soi] = (hs[seatOrder[soi]] | 0) / 6.0;
    }

    // [207:209] match scores
    state[207] = myScore / 6.0;
    state[208] = oppScore / 6.0;

    // [209:210] multiplier (capped at 8, /8)
    state[209] = Math.min(multiplier, 8) / 8.0;

    // [210:211] board length (/24)
    state[210] = ((obs.board_length | 0) || 0) / 24.0;

    // [211:212] game phase = len(played)/24
    var playedLen = 0;
    if (pl && pl.size != null) playedLen = pl.size;
    else if (pl) playedLen = pl.length;
    state[211] = playedLen / 24.0;

    // [212:213] my team
    state[212] = (me % 2);

    // ===== Branch B tail [213:268] =====
    // [213:261] last-4 actions, 12 dims each, oldest-first
    // role one-hot: [self, partner, LHO, RHO] — Python uses
    //   role_map = {0:0, 2:1, 1:2, 3:3}
    var ra = obs.recent_actions || obs.recentActions || [];
    var slice = ra.slice(Math.max(0, ra.length - 4));
    var roleMap = { 0: 0, 2: 1, 1: 2, 3: 3 };
    for (var slot = 0; slot < slice.length; slot++) {
      var act = slice[slot];
      var base = 213 + slot * 12;
      var actor = (act.actor_abs == null ? act.actorAbs : act.actor_abs) | 0;
      var rIdx = roleMap[((actor - me) % 4 + 4) % 4];
      state[base + rIdx] = 1.0;
      var isPass = !!(act.is_pass != null ? act.is_pass : act.isPass);
      state[base + 4] = isPass ? 1.0 : 0.0;
      var side = act.side;
      state[base + 5] = (side === 'left') ? 1.0 : 0.0;
      state[base + 6] = (side === 'right') ? 1.0 : 0.0;
      var bothEnds = !!(act.tile_could_play_both_ends != null
        ? act.tile_could_play_both_ends : act.tileCouldPlayBothEnds);
      state[base + 7] = bothEnds ? 1.0 : 0.0;
      var tileIdx = (act.tile_idx == null ? act.tileIdx : act.tile_idx);
      if (!isPass && tileIdx != null && tileIdx >= 0) {
        var pp = TILES[tileIdx];
        state[base + 8] = pp[0] / 6.0;
        state[base + 9] = pp[1] / 6.0;
      }
      var leB = act.left_before == null ? act.leftBefore : act.left_before;
      var reB = act.right_before == null ? act.rightBefore : act.right_before;
      state[base + 10] = (leB != null && leB >= 0) ? (leB / 6.0) : 0.0;
      state[base + 11] = (reB != null && reB >= 0) ? (reB / 6.0) : 0.0;
    }

    // [261:268] partner pip-claim strength
    var claim = new Float32Array(NUM_PIPS);
    for (var ppI2 = 0; ppI2 < partnerPlays.length; ppI2++) {
      var counts = tileContainsCounts(partnerPlays[ppI2] | 0);
      for (var ci = 0; ci < NUM_PIPS; ci++) claim[ci] += counts[ci];
    }
    for (var ci2 = 0; ci2 < NUM_PIPS; ci2++) {
      var c = claim[ci2];
      if (c < 0) c = 0; else if (c > 6) c = 6;
      state[261 + ci2] = c / 6.0;
    }

    return state;
  }

  // Combined 443-dim encoder = base268 + symbolic175
  function encodeState443(obs, scores) {
    var base = encodeStateBaseBranchB(obs, scores);
    var pub = publicObsFromObs(obs, (scores && scores.dorme_size) ? scores.dorme_size : 4);
    var sym = deduce(pub).featureVector();
    var out = new Float32Array(443);
    out.set(base, 0);
    out.set(sym, 268);
    return out;
  }

  // ----------------------------------------------------------
  // Bridge: build a Python-compatible obs from the in-app
  // (hand, lE, rE, bLen, player, knowledge, ...) shape used
  // by index.html's _nnEncodeState.
  // ----------------------------------------------------------
  function obsFromKnowledge(hand, lE, rE, bLen, player, knowledge, opts) {
    opts = opts || {};
    // hand: array of {left,right,id}; convert to tile indices
    // Tile index = (a * (15 - a)) / 2 + (b - a) ... but we don't have id->idx
    // map here. The caller must pass a tileIndex map OR we recompute.
    var handIdx = [];
    for (var i = 0; i < hand.length; i++) {
      handIdx.push(_tileIndexFromPair(hand[i].left, hand[i].right));
    }
    // played: knowledge.played is a Set of tile.id strings like "3-5"
    var played = [];
    if (knowledge && knowledge.played) {
      knowledge.played.forEach(function (id) {
        var parts = id.split('-');
        played.push(_tileIndexFromPair(parts[0] | 0, parts[1] | 0));
      });
    }
    // hand_sizes: 4-tuple. We need to pass via opts.handSizes.
    var hs = opts.handSizes || [hand.length, 0, 0, 0];
    // cant_have: knowledge.cantHave[seat] is Set of pip integers
    var ch = [];
    if (knowledge && knowledge.cantHave) {
      for (var s = 0; s < 4; s++) ch.push(new Set(knowledge.cantHave[s]));
    } else {
      for (var s2 = 0; s2 < 4; s2++) ch.push(new Set());
    }
    // plays_by: knowledge.playsBy[seat] is array of tile objects; convert
    var pb = [[], [], [], []];
    if (knowledge && knowledge.playsBy) {
      for (var sp = 0; sp < 4; sp++) {
        var arr = knowledge.playsBy[sp] || [];
        for (var ti = 0; ti < arr.length; ti++) {
          pb[sp].push(_tileIndexFromPair(arr[ti].left, arr[ti].right));
        }
      }
    }
    // recent_actions: pass through if provided
    var ra = opts.recentActions || [];
    return {
      player: player,
      hand: handIdx,
      played: played,
      left_end: (lE == null) ? -1 : lE,
      right_end: (rE == null) ? -1 : rE,
      board_length: (bLen == null) ? 0 : bLen,
      cant_have: ch,
      plays_by: pb,
      hand_sizes: hs,
      recent_actions: ra,
    };
  }

  // tile pair (a,b) with a<=b assumed -> index in TILES.
  // For 0..6 doubles + non-doubles in lex order, exact:
  //   sum_{i=0..a-1} (7-i) + (b - a)
  // = a*7 - a*(a-1)/2 + (b - a)
  var _PAIR_TO_IDX = {};
  (function () {
    var k = 0;
    for (var a = 0; a < NUM_PIPS; a++) {
      for (var b = a; b < NUM_PIPS; b++) {
        _PAIR_TO_IDX[a + 'x' + b] = k++;
      }
    }
  })();
  function _tileIndexFromPair(a, b) {
    a = a | 0; b = b | 0;
    if (b < a) { var tmp = a; a = b; b = tmp; }
    var idx = _PAIR_TO_IDX[a + 'x' + b];
    if (idx == null) throw new Error('SymbolicEncoder: bad tile pair (' + a + ',' + b + ')');
    return idx;
  }

  // ----------------------------------------------------------
  // Exports
  // ----------------------------------------------------------
  var ns = {
    NUM_TILES: NUM_TILES,
    NUM_PIPS: NUM_PIPS,
    TILES: TILES,
    tileContainsPip: tileContainsPip,
    tilePips: tilePips,
    publicObsFromObs: publicObsFromObs,
    deduce: deduce,
    computeBelief: computeBelief,
    exportConditionalBelief: exportConditionalBelief,
    encodeStateBaseBranchB: encodeStateBaseBranchB,
    encodeState443: encodeState443,
    obsFromKnowledge: obsFromKnowledge,
    tileIndexFromPair: _tileIndexFromPair,
  };

  if (root) {
    root.SymbolicEncoder = ns;
  }
  return ns;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

// Also expose for CommonJS so node-side tooling can `require()` directly.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SymbolicEncoder;
}

