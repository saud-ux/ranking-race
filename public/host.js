'use strict';

const socket = io();

const PRESETS = [
  'فواكه','خضار','دول','مدن سعودية','أسماء أولاد','أسماء بنات',
  'حيوانات','ماركات سيارات','أكلات','لاعبين كرة قدم','مهن','ألوان',
];

// ─── Audio engine ─────────────────────────────────────────────────────────────

let audioCtx = null;
let muted = localStorage.getItem('muted') === '1';

function getCtx() {
  if (!audioCtx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (C) audioCtx = new C();
  }
  if (audioCtx?.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

document.addEventListener('pointerdown', () => getCtx(), { once: false, passive: true });

function beep(freq, dur, type = 'sine', vol = 0.22) {
  if (muted) return;
  const ctx = getCtx();
  if (!ctx) return;
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  gain.gain.setValueAtTime(vol, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  osc.start();
  osc.stop(ctx.currentTime + dur);
}

function seq(notes) {
  notes.forEach(n => setTimeout(() => beep(n.f, n.d, n.t || 'sine', n.v || 0.22), n.at || 0));
}

function sweep(f1, f2, dur, type = 'sawtooth', vol = 0.25) {
  if (muted) return;
  const ctx = getCtx();
  if (!ctx) return;
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(f1, ctx.currentTime);
  osc.frequency.linearRampToValueAtTime(f2, ctx.currentTime + dur);
  gain.gain.setValueAtTime(vol, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  osc.start();
  osc.stop(ctx.currentTime + dur);
}

const sfx = {
  playerJoin()   { seq([{f:660,d:0.10,at:0},{f:880,d:0.10,at:90}]); },
  roundStart()   { seq([{f:400,d:0.09,at:0},{f:600,d:0.09,at:80},{f:900,d:0.18,at:160}]); },
  timeUp()       { sweep(480, 90, 0.75, 'sawtooth', 0.28); },
  adjReject()    { beep(220, 0.18, 'square', 0.15); },
  adjAccept()    { beep(660, 0.12, 'sine', 0.15); },
  scored()       { seq([{f:523,d:0.12,at:0},{f:659,d:0.12,at:110},{f:784,d:0.22,at:220}]); },
  tick()         { beep(560, 0.07, 'square', 0.08); },
  urgentTick()   { beep(880, 0.07, 'square', 0.12); },
  gulagAlert()   {
    seq([{f:300,d:0.12,at:0},{f:200,d:0.22,at:130}]);
  },
  duelStart()    {
    seq([
      {f:200,d:0.10,at:0},{f:250,d:0.10,at:100},
      {f:300,d:0.10,at:200},{f:450,d:0.25,at:320},
    ]);
  },
  fanfare()      {
    seq([
      {f:523,d:0.13,at:0},   {f:523,d:0.13,at:140},
      {f:523,d:0.13,at:280}, {f:698,d:0.35,at:420},
      {f:659,d:0.35,at:780}, {f:587,d:0.13,at:1100},
      {f:784,d:0.55,at:1240},
    ]);
  },
};

// ─── Mute toggle ──────────────────────────────────────────────────────────────

function updateMuteBtn() {
  const btn = document.getElementById('host-mute-btn');
  if (!btn) return;
  btn.textContent = muted ? '🔇' : '🔊';
  btn.title = muted ? 'تشغيل الصوت' : 'كتم الصوت';
}
updateMuteBtn();

document.getElementById('host-mute-btn')?.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('muted', muted ? '1' : '0');
  updateMuteBtn();
});

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  hostKey: localStorage.getItem('hostKey'),
  roomCode: localStorage.getItem('hostRoomCode'),
  phase: 'no-room',
  selectedCategory: '',
  adjState: {},
  adjMode: 'round',
  prevPlayerCount: 0,
  gulagPending: null,
  duelBoxes: {},
  duelTickInterval: null,
  roundTickInterval: null,
  lastTickSec: -1,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
}

function showHostPhase(phase) {
  state.phase = phase;
  state.lastTickSec = -1;

  const allPanels = [
    'panel-no-room','panel-room-info','panel-right',
    'panel-adjudication','panel-leaderboard','panel-final',
    'panel-duel','panel-duel-result','panel-round-live',
  ];
  allPanels.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('hidden');
    if (id === 'panel-right') el.style.display = 'none';
  });
  document.getElementById('round-controls')?.classList.add('hidden');

  function show(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('hidden');
    if (id === 'panel-right') el.style.display = 'flex';
  }

  switch (phase) {
    case 'no-room':
      show('panel-no-room');
      break;
    case 'lobby':
      show('panel-room-info');
      show('panel-right');
      show('round-controls');
      break;
    case 'round':
      show('panel-room-info');
      show('panel-right');
      show('panel-round-live');           // ← was missing in public/host.js
      break;
    case 'adjudication':
    case 'duel_adjudication':
      show('panel-room-info');
      show('panel-right');
      show('panel-adjudication');
      break;
    case 'results':
      show('panel-room-info');
      show('panel-right');
      show('panel-leaderboard');
      break;
    case 'duel':
      show('panel-room-info');
      show('panel-right');
      show('panel-duel');
      break;
    case 'duel_result':
      show('panel-room-info');
      show('panel-right');
      show('panel-duel-result');
      break;
    case 'finished':
      show('panel-final');
      break;
  }
}

function setConnectionStatus(status) {
  const dot   = document.getElementById('host-status-dot');
  const label = document.getElementById('host-conn-label');
  if (!dot) return;
  dot.className = `status-dot ${status}`;
  label.textContent = status === 'connected'    ? 'متصل'
                    : status === 'reconnecting' ? 'إعادة الاتصال…' : 'منقطع';
}

// ─── Lock screen ──────────────────────────────────────────────────────────────

document.getElementById('btn-unlock').addEventListener('click', doUnlock);
document.getElementById('input-host-key').addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });

function doUnlock() {
  const key = document.getElementById('input-host-key').value;
  document.getElementById('lock-error').textContent = '';
  getCtx();
  socket.emit('host:authenticate', { key }, (res) => {
    if (res.ok) {
      state.hostKey = key;
      localStorage.setItem('hostKey', key);
      showMainConsole();
    } else {
      document.getElementById('lock-error').textContent = res.error || 'مفتاح خاطئ';
      const input = document.getElementById('input-host-key');
      input.classList.add('input-error-shake');
      setTimeout(() => input.classList.remove('input-error-shake'), 500);
    }
  });
}

function showMainConsole() {
  showScreen('console');
  buildPresets();
  if (state.roomCode) tryRejoinRoom();
  else showHostPhase('no-room');
}

if (state.hostKey) {
  socket.emit('host:authenticate', { key: state.hostKey }, (res) => {
    if (res.ok) showMainConsole();
    else {
      localStorage.removeItem('hostKey');
      state.hostKey = null;
      showScreen('lock');
    }
  });
} else {
  showScreen('lock');
}

// ─── Logout ───────────────────────────────────────────────────────────────────

document.getElementById('btn-logout').addEventListener('click', () => {
  localStorage.removeItem('hostKey');
  localStorage.removeItem('hostRoomCode');
  state.hostKey = null;
  state.roomCode = null;
  showScreen('lock');
});

// ─── Create room ──────────────────────────────────────────────────────────────

document.getElementById('btn-create-room').addEventListener('click', () => {
  const btn = document.getElementById('btn-create-room');
  btn.disabled = true;
  socket.emit('host:create_room', { key: state.hostKey }, (res) => {
    btn.disabled = false;
    if (res.ok) {
      state.roomCode = res.code;
      localStorage.setItem('hostRoomCode', res.code);
      setupRoomView(res.code);
      showHostPhase('lobby');
    }
  });
});

// ─── Rejoin room ──────────────────────────────────────────────────────────────

function tryRejoinRoom() {
  socket.emit('host:rejoin_room', { key: state.hostKey, code: state.roomCode }, (res) => {
    if (!res.ok) {
      localStorage.removeItem('hostRoomCode');
      state.roomCode = null;
      showHostPhase('no-room');
      return;
    }
    setupRoomView(state.roomCode);
    renderPlayerList(res.players);

    switch (res.phase) {
      case 'round':
        if (res.roundInfo) {
          document.getElementById('round-live-category').textContent = res.roundInfo.category;
          startHostRoundCountdown(res.roundInfo.endsAt);
        }
        showHostPhase('round');
        break;
      case 'adjudication':
        state.adjMode = 'round';
        if (res.adjGroups) renderAdjudicationPanel(res.adjGroups, res.adjCategory, res.roundNumber);
        showHostPhase('adjudication');
        break;
      case 'duel':
        if (res.duelSpectate) {
          enterHostDuel(res.duelSpectate.category, res.duelSpectate.endsAt, res.duelSpectate.players);
          const ans = res.duelSpectate.answers || {};
          Object.keys(ans).forEach(pid => (ans[pid] || []).forEach(a => addHostDuelChip(pid, a)));
        } else showHostPhase('duel');
        break;
      case 'duel_adjudication':
        state.adjMode = 'duel';
        if (res.duelGroups) renderAdjudicationPanel(res.duelGroups.groups, `${res.duelGroups.category} ⚔️`, '—');
        showHostPhase('duel_adjudication');
        break;
      case 'duel_result':
        if (res.duelResult) renderDuelResult(res.duelResult);
        showHostPhase('duel_result');
        break;
      case 'results':
        if (res.leaderboard) renderLeaderboard(res.leaderboard, res.roundNumber);
        showHostPhase('results');
        break;
      case 'finished':
        if (res.leaderboard) renderFinal(res.leaderboard);
        showHostPhase('finished');
        break;
      default:
        showHostPhase('lobby');
    }

    if (res.pendingGulag) {
      state.gulagPending = { playerId: res.pendingGulag.playerId, nickname: res.pendingGulag.nickname };
      renderGulagPrompt(res.pendingGulag);
    }
  });
}

// ─── Room view: code + QR ─────────────────────────────────────────────────────

function setupRoomView(code) {
  document.getElementById('room-code-display').textContent = code;
  const joinUrl = `${window.location.origin}/?room=${code}`;
  document.getElementById('qr-url').textContent = joinUrl;
  generateQR(joinUrl);
}

function generateQR(url) {
  // Try canvas method first (most reliable)
  const canvas = document.getElementById('qr-canvas');
  const img    = document.getElementById('qr-img');

  function tryGenerate() {
    if (typeof QRCode === 'undefined') {
      console.warn('QRCode not loaded yet, retrying…');
      setTimeout(tryGenerate, 300);
      return;
    }
    // toCanvas is the most reliable method
    if (canvas && QRCode.toCanvas) {
      QRCode.toCanvas(canvas, url, {
        width: 180,
        margin: 1,
        color: { dark: '#f59e0b', light: '#1a1a35' },
      }, (err) => {
        if (err) {
          console.error('QR canvas error:', err);
          tryDataURL(url);
        } else {
          canvas.style.display = 'block';
          if (img) img.style.display = 'none';
          // Style the canvas border
          canvas.style.border = '4px solid #f59e0b';
          canvas.style.borderRadius = '8px';
        }
      });
    } else {
      tryDataURL(url);
    }
  }

  function tryDataURL(u) {
    if (!QRCode.toDataURL) return;
    QRCode.toDataURL(u, {
      width: 180,
      margin: 1,
      color: { dark: '#f59e0b', light: '#1a1a35' },
    }, (err, dataUrl) => {
      if (err) { console.error('QR dataURL error:', err); return; }
      if (img) {
        img.src = dataUrl;
        img.style.display = 'block';
        if (canvas) canvas.style.display = 'none';
      }
    });
  }

  tryGenerate();
}

// ─── Player list (with +/- score adjustment) ──────────────────────────────────

function renderPlayerList(players) {
  const list  = document.getElementById('player-list');
  const badge = document.getElementById('player-count-badge');
  badge.textContent = `${players.length} / 20`;

  if (players.length > state.prevPlayerCount) sfx.playerJoin();
  state.prevPlayerCount = players.length;

  if (!players.length) {
    list.innerHTML = '<p class="text-muted" style="font-size:0.9rem;text-align:center;padding:12px 0;">لم ينضم أحد بعد…</p>';
    return;
  }

  // Preserve scroll position
  const scrollTop = list.scrollTop;

  list.innerHTML = '';
  players.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = `player-row${p.connected ? '' : ' offline'}`;
    if (p.status === 'out')   row.classList.add('player-out');
    if (p.status === 'gulag') row.classList.add('player-gulag');
    row.style.setProperty('--row-delay', `${idx * 40}ms`);
    row.classList.add('lb-row-enter');

    const statusBadge = p.status === 'out'   ? '<span class="status-pill pill-out">خارج</span>'
                      : p.status === 'gulag' ? '<span class="status-pill pill-gulag">⛓️</span>'
                      : '';

    const pid = escapeHtml(p.playerId);
    row.innerHTML = `
      <span class="${p.connected ? 'online-dot' : 'offline-dot'}"></span>
      <span class="player-name">${escapeHtml(p.nickname)}${statusBadge ? ' ' + statusBadge : ''}</span>
      <div class="score-controls">
        <button class="adj-btn adj-minus" data-pid="${pid}" title="−1">−</button>
        <span class="player-score" id="score-${pid}">${p.score ?? 0}</span>
        <button class="adj-btn adj-plus"  data-pid="${pid}" title="+1">+</button>
      </div>
      <button class="btn btn-danger btn-small kick-btn" data-pid="${pid}">طرد</button>
    `;

    row.querySelector('.adj-minus').addEventListener('click', e => {
      const id = e.currentTarget.dataset.pid;
      socket.emit('host:adjust_score', { code: state.roomCode, playerId: id, delta: -1 }, (res) => {
        if (res?.ok) flashScore(id, false);
      });
    });
    row.querySelector('.adj-plus').addEventListener('click', e => {
      const id = e.currentTarget.dataset.pid;
      socket.emit('host:adjust_score', { code: state.roomCode, playerId: id, delta: 1 }, (res) => {
        if (res?.ok) flashScore(id, true);
      });
    });
    row.querySelector('.kick-btn').addEventListener('click', e => {
      socket.emit('host:kick', { code: state.roomCode, playerId: e.currentTarget.dataset.pid });
    });

    list.appendChild(row);
  });

  list.scrollTop = scrollTop;
}

function flashScore(pid, positive) {
  const el = document.getElementById(`score-${escapeHtml(pid)}`);
  if (!el) return;
  el.classList.remove('score-flash-up', 'score-flash-down');
  void el.offsetWidth;
  el.classList.add(positive ? 'score-flash-up' : 'score-flash-down');
  setTimeout(() => el.classList.remove('score-flash-up', 'score-flash-down'), 600);
}

socket.on('room:player_list', renderPlayerList);

// ─── Category presets ─────────────────────────────────────────────────────────

function buildPresets() {
  const grid = document.getElementById('preset-grid');
  grid.innerHTML = '';
  PRESETS.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = cat;
    btn.addEventListener('click', () => selectPreset(cat, btn));
    grid.appendChild(btn);
  });
}

function selectPreset(cat, btn) {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('custom-category').value = '';
  setSelectedCategory(cat);
}

document.getElementById('custom-category').addEventListener('input', e => {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('selected'));
  setSelectedCategory(e.target.value.trim());
});

function setSelectedCategory(cat) {
  state.selectedCategory = cat;
  const display = document.getElementById('selected-category-display');
  const btn     = document.getElementById('btn-start-round');
  if (cat) { display.textContent = `الفئة: ${cat}`; display.classList.remove('hidden'); btn.disabled = false; }
  else     { display.classList.add('hidden'); btn.disabled = true; }
}

// ─── Live round countdown (host) ──────────────────────────────────────────────

function startHostRoundCountdown(endsAt) {
  clearInterval(state.roundTickInterval);
  state.lastTickSec = -1;
  const el = document.getElementById('round-live-countdown');
  if (!el) return;

  function tick() {
    const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.textContent = rem;
    el.classList.toggle('urgent', rem <= 10);

    // Play tick sounds for the host too, so they know when to watch
    if (rem <= 10 && rem > 0 && rem !== state.lastTickSec) {
      state.lastTickSec = rem;
      rem <= 5 ? sfx.urgentTick() : sfx.tick();
    }
    if (rem <= 0) clearInterval(state.roundTickInterval);
  }
  tick();
  state.roundTickInterval = setInterval(tick, 250);
}

// ─── Start round ──────────────────────────────────────────────────────────────

document.getElementById('btn-start-round').addEventListener('click', () => {
  if (!state.selectedCategory) return;
  document.getElementById('round-error').textContent = '';
  document.getElementById('btn-start-round').disabled = true;

  socket.emit('host:start_round', { code: state.roomCode, category: state.selectedCategory }, (res) => {
    if (res?.ok) {
      sfx.roundStart();
      document.getElementById('round-live-category').textContent = state.selectedCategory;
      startHostRoundCountdown(res.endsAt);
      showHostPhase('round');
    } else {
      document.getElementById('round-error').textContent = res?.error || 'حدث خطأ';
      document.getElementById('btn-start-round').disabled = false;
    }
  });
});

// ─── Adjudication ─────────────────────────────────────────────────────────────

socket.on('round:ended', ({ groups, category, roundNumber }) => {
  clearInterval(state.roundTickInterval);
  sfx.timeUp();
  state.adjMode = 'round';
  renderAdjudicationPanel(groups, category, roundNumber);
  showHostPhase('adjudication');
});

function renderAdjudicationPanel(groups, category, roundNumber) {
  document.getElementById('adj-category').textContent = category;
  document.getElementById('adj-round-num').textContent = roundNumber;

  // Auto-detect duplicates: second+ occurrences of the same display label
  const labelOccurrence = {};
  const duplicateKeys = new Set();
  groups.forEach(g => {
    const seen = labelOccurrence[g.displayLabel] || 0;
    if (seen >= 1) duplicateKeys.add(g.key);
    labelOccurrence[g.displayLabel] = seen + 1;
  });

  state.adjState = {};
  groups.forEach(g => { state.adjState[g.key] = !duplicateKeys.has(g.key); });
  updateAdjStats(groups);

  const list = document.getElementById('adj-list');
  list.innerHTML = '';

  groups.forEach((g, idx) => {
    const isDup = duplicateKeys.has(g.key);
    const initialValid = !isDup;
    const nicks = g.playerNicks || [];

    const row = document.createElement('div');
    row.className = 'adj-row lb-row-enter' + (isDup ? ' rejected' : '');
    row.style.setProperty('--row-delay', `${idx * 35}ms`);
    row.dataset.key    = g.key;
    row.dataset.label  = g.displayLabel;
    row.dataset.search = `${g.displayLabel} ${nicks.join(' ')}`;

    const nicksHtml = nicks.length
      ? `<div class="adj-nicks">${nicks.map(n => `<span class="adj-nick">${escapeHtml(n)}</span>`).join('')}</div>`
      : '';
    const dupBadge = isDup
      ? `<span class="adj-dup-badge" title="ظهرت نفس الكلمة في صف آخر">مكرّر</span>`
      : '';

    // Unique-answer highlight (only one player gave this)
    const uniqueClass = g.playerCount === 1 ? ' adj-row-unique' : '';
    row.classList.add(...uniqueClass.trim().split(' ').filter(Boolean));

    row.innerHTML = `
      <button class="adj-toggle ${initialValid ? 'valid' : 'invalid'}" title="تبديل">${initialValid ? '✓' : '✗'}</button>
      <div class="adj-label-wrap">
        <div class="adj-label-row">
          <span class="adj-label">${escapeHtml(g.displayLabel)}</span>
          ${dupBadge}
        </div>
        ${nicksHtml}
      </div>
      <span class="adj-count-badge ${g.playerCount === 1 ? 'adj-count-unique' : ''}">${g.playerCount}</span>
    `;

    row.querySelector('.adj-toggle').addEventListener('click', (e) => {
      const key  = row.dataset.key;
      state.adjState[key] = !state.adjState[key];
      const valid = state.adjState[key];
      e.target.classList.toggle('valid',   valid);
      e.target.classList.toggle('invalid', !valid);
      e.target.textContent = valid ? '✓' : '✗';
      row.classList.toggle('rejected', !valid);

      if (!valid) {
        row.classList.remove('shake');
        void row.offsetWidth;
        row.classList.add('shake');
        sfx.adjReject();
      } else {
        sfx.adjAccept();
      }

      updateAdjStats(groups);
    });

    list.appendChild(row);
  });

  document.getElementById('adj-search').value = '';
  document.getElementById('adj-search').oninput = (e) => {
    const q = e.target.value.trim();
    document.querySelectorAll('.adj-row').forEach(row => {
      row.classList.toggle('hidden', !!q && !row.dataset.search.includes(q));
    });
  };
}

function updateAdjStats(groups) {
  const valid   = groups.filter(g => state.adjState[g.key] !== false).length;
  const invalid = groups.length - valid;
  document.getElementById('adj-stats').innerHTML = `
    <span class="adj-stat-valid">✓ مقبول: <strong>${valid}</strong></span>
    <span class="adj-stat-invalid">✗ مرفوض: <strong>${invalid}</strong></span>
    <span>الإجمالي: <strong>${groups.length}</strong></span>
  `;
}

document.getElementById('btn-score-round').addEventListener('click', () => {
  const decisions = Object.entries(state.adjState).map(([key, valid]) => ({ key, valid }));
  const btn = document.getElementById('btn-score-round');
  btn.disabled = true;
  btn.textContent = 'جارٍ الاحتساب…';
  const event = state.adjMode === 'duel' ? 'host:score_duel' : 'host:score_round';
  socket.emit(event, { code: state.roomCode, decisions }, () => {
    btn.disabled = false;
    btn.textContent = 'احتساب النقاط';
  });
});

// ─── Leaderboard ──────────────────────────────────────────────────────────────

socket.on('round:results', ({ leaderboard, roundNumber }) => {
  sfx.scored();
  renderLeaderboard(leaderboard, roundNumber);
  showHostPhase('results');
});

function renderLeaderboard(leaderboard, roundNumber) {
  document.getElementById('lb-round-num').textContent = roundNumber;
  const tbody = document.getElementById('lb-tbody');
  tbody.innerHTML = '';
  leaderboard.forEach((entry, idx) => {
    const tr = document.createElement('tr');
    tr.className = idx === 0 ? 'rank-1-row lb-row-enter' : 'lb-row-enter';
    tr.style.setProperty('--row-delay', `${idx * 70}ms`);
    const sign = entry.roundScore > 0 ? '+' : '';
    const cls  = entry.roundScore > 0 ? 'delta-pos' : entry.roundScore < 0 ? 'delta-neg' : 'delta-zero';
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '';
    tr.innerHTML = `
      <td class="rank-cell">${medal || entry.rank}</td>
      <td class="name-cell">${escapeHtml(entry.nickname)}</td>
      <td class="delta-cell ${cls} delta-pop" style="animation-delay:${idx*70+300}ms">${sign}${entry.roundScore}</td>
      <td class="score-cell">${entry.totalScore}</td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('btn-new-round').addEventListener('click', () => {
  socket.emit('host:new_round', { code: state.roomCode }, (res) => {
    if (res?.ok) {
      resetRoundControls();
      showHostPhase('lobby');
    }
  });
});

document.getElementById('btn-end-game').addEventListener('click', () => {
  socket.emit('host:end_game', { code: state.roomCode });
});

function resetRoundControls() {
  state.selectedCategory = '';
  document.getElementById('selected-category-display').classList.add('hidden');
  document.getElementById('btn-start-round').disabled = true;
  document.getElementById('custom-category').value = '';
  document.getElementById('round-error').textContent = '';
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('selected'));
}

// ─── Gulag prompt modal ─────────────────────────────────────────────────────

function showGulagModal(show) {
  document.getElementById('gulag-modal').classList.toggle('hidden', !show);
}

function renderGulagPrompt({ nickname, willDuel, waitingNickname }) {
  document.getElementById('gulag-modal-text').innerHTML = willDuel
    ? `آخر لاعب بالترتيب: «${escapeHtml(nickname)}».<br>سينزل إلى الـ Gulag ويبارز «${escapeHtml(waitingNickname)}» مباشرةً ⚔️`
    : `آخر لاعب بالترتيب: «${escapeHtml(nickname)}».<br>سينزل إلى الـ Gulag وينتظر خصمه القادم.`;
  showGulagModal(true);
}

socket.on('gulag:prompt', (data) => {
  state.gulagPending = { playerId: data.playerId, nickname: data.nickname };
  renderGulagPrompt(data);
  sfx.gulagAlert();
});

document.getElementById('btn-gulag-yes').addEventListener('click', () => {
  socket.emit('host:gulag_decision', { code: state.roomCode, accept: true });
  showGulagModal(false);
  state.gulagPending = null;
});
document.getElementById('btn-gulag-no').addEventListener('click', () => {
  socket.emit('host:gulag_decision', { code: state.roomCode, accept: false });
  showGulagModal(false);
  state.gulagPending = null;
});

// ─── Gulag duel (host: spectate, adjudicate, resolve) ───────────────────────

function buildHostDuelBoxes(players) {
  const wrap = document.getElementById('host-duel-boxes');
  wrap.innerHTML = '';
  state.duelBoxes = {};
  (players || []).forEach(p => {
    const box = document.createElement('div');
    box.className = 'duel-box';
    box.innerHTML = `
      <div class="duel-box-name">${escapeHtml(p.nickname)}</div>
      <div class="duel-box-chips chips-area"></div>
    `;
    wrap.appendChild(box);
    state.duelBoxes[p.playerId] = box.querySelector('.duel-box-chips');
  });
}

function addHostDuelChip(playerId, answer) {
  const chips = state.duelBoxes[playerId];
  if (!chips) return;
  const chip = document.createElement('div');
  chip.className = 'chip chip-new';
  chip.textContent = answer;
  chips.prepend(chip);
}

function startHostDuelCountdown(endsAt) {
  clearInterval(state.duelTickInterval);
  const el = document.getElementById('host-duel-countdown');
  function tick() {
    const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.textContent = rem;
    el.classList.toggle('urgent', rem <= 10);
    if (rem <= 0) clearInterval(state.duelTickInterval);
  }
  tick();
  state.duelTickInterval = setInterval(tick, 250);
}

function enterHostDuel(category, endsAt, players) {
  document.getElementById('host-duel-category').textContent = category;
  buildHostDuelBoxes(players);
  startHostDuelCountdown(endsAt);
  showHostPhase('duel');
  sfx.duelStart();
}

function renderDuelResult({ winnerNick, loserNick, champion }) {
  document.getElementById('duel-result-banner').innerHTML =
    `🏆 ${escapeHtml(winnerNick || '')} <span style="color:var(--text-muted);font-weight:400;">فاز على</span> ${escapeHtml(loserNick || '')}`;
  document.getElementById('duel-result-detail').textContent = champion
    ? 'لم يتبقَّ سوى لاعب واحد — جاهز للتتويج!'
    : `${loserNick} يصبح متفرّجاً، و${winnerNick} يعود للمنافسة.`;
  document.getElementById('btn-duel-continue').textContent = champion ? 'توّج البطل 🏆' : 'متابعة';
}

socket.on('duel:spectate_start', ({ category, endsAt, players }) => {
  enterHostDuel(category, endsAt, players);
});

socket.on('duel:spectate_answer', ({ playerId, answer }) => addHostDuelChip(playerId, answer));

socket.on('duel:tick', ({ remaining }) => {
  if (state.phase !== 'duel') return;
  const el = document.getElementById('host-duel-countdown');
  el.textContent = remaining;
  el.classList.toggle('urgent', remaining <= 10);
});

socket.on('duel:ended', ({ groups, category }) => {
  clearInterval(state.duelTickInterval);
  sfx.timeUp();
  state.adjMode = 'duel';
  renderAdjudicationPanel(groups, `${category} ⚔️`, '—');
  showHostPhase('duel_adjudication');
});

socket.on('duel:result', (data) => {
  renderDuelResult(data);
  showHostPhase('duel_result');
  sfx.scored();
});

document.getElementById('btn-duel-continue').addEventListener('click', () => {
  const btn = document.getElementById('btn-duel-continue');
  btn.disabled = true;
  socket.emit('host:resume_lobby', { code: state.roomCode }, (res) => {
    btn.disabled = false;
    if (res?.ok && !res.finished) {
      resetRoundControls();
      showHostPhase('lobby');
    }
  });
});

// ─── Final screen ─────────────────────────────────────────────────────────────

socket.on('game:finished', ({ leaderboard }) => {
  renderFinal(leaderboard);
  showHostPhase('finished');
  sfx.fanfare();
  setTimeout(launchConfetti, 400);
});

function renderFinal(leaderboard) {
  renderPodium('host-podium', leaderboard);
  const tbody = document.getElementById('final-tbody');
  tbody.innerHTML = '';
  leaderboard.forEach((entry, idx) => {
    const tr = document.createElement('tr');
    tr.className = idx === 0 ? 'rank-1-row lb-row-enter' : 'lb-row-enter';
    tr.style.setProperty('--row-delay', `${idx * 60}ms`);
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '';
    tr.innerHTML = `
      <td class="rank-cell">${medal || entry.rank}</td>
      <td class="name-cell">${escapeHtml(entry.nickname)}</td>
      <td class="score-cell">${entry.totalScore}</td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('btn-new-game').addEventListener('click', () => {
  localStorage.removeItem('hostRoomCode');
  state.roomCode = null;
  state.prevPlayerCount = 0;
  showHostPhase('no-room');
});

// ─── Podium ───────────────────────────────────────────────────────────────────

function renderPodium(containerId, leaderboard) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = '';
  const top3 = leaderboard.slice(0, 3);
  if (!top3.length) return;
  const slots  = [top3[1], top3[0], top3[2]];
  const classes = ['second','first','third'];
  const medals  = ['🥈','🥇','🥉'];
  const labels  = ['2','1','3'];
  slots.forEach((entry, i) => {
    if (!entry) return;
    const div = document.createElement('div');
    div.className = `podium-item ${classes[i]}`;
    div.innerHTML = `
      <span class="podium-emoji">${medals[i]}</span>
      <span class="podium-name">${escapeHtml(entry.nickname)}</span>
      <span class="podium-score">${entry.totalScore} نقطة</span>
      <div class="podium-stand">${labels[i]}</div>
    `;
    wrap.appendChild(div);
  });
}

// ─── Confetti ─────────────────────────────────────────────────────────────────

function launchConfetti() {
  const colors = ['#f59e0b','#10b981','#7c3aed','#ef4444','#3b82f6','#f97316','#ec4899'];
  for (let i = 0; i < 120; i++) {
    const el   = document.createElement('div');
    const size = Math.random() * 10 + 5;
    const isRect = Math.random() > 0.5;
    el.style.cssText = [
      `position:fixed`,
      `width:${isRect ? size * 1.6 : size}px`,
      `height:${size}px`,
      `background:${colors[Math.floor(Math.random() * colors.length)]}`,
      `left:${Math.random() * 100}vw`,
      `top:-12px`,
      `border-radius:${isRect ? '2px' : '50%'}`,
      `z-index:9999`,
      `pointer-events:none`,
      `animation:confetti-fall ${Math.random() * 2 + 2.5}s linear forwards`,
      `animation-delay:${Math.random() * 2}s`,
    ].join(';');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }
}

// ─── Connection ───────────────────────────────────────────────────────────────

socket.on('disconnect', () => setConnectionStatus('reconnecting'));
socket.on('connect_error', () => setConnectionStatus('disconnected'));
socket.on('connect', () => {
  setConnectionStatus('connected');
  if (state.hostKey && state.roomCode) tryRejoinRoom();
});
