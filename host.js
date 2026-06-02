'use strict';

const socket = io();

const PRESETS = [
  'فواكه','خضار','دول','مدن سعودية','أسماء أولاد','أسماء بنات',
  'حيوانات','ماركات سيارات','أكلات','لاعبين كرة قدم','مهن','ألوان',
];

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  hostKey: localStorage.getItem('hostKey'),
  roomCode: localStorage.getItem('hostRoomCode'),
  phase: 'no-room',
  selectedCategory: '',
  adjState: {}, // key → boolean (true = valid)
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
}

// Show/hide the main panels based on game phase
function showHostPhase(phase) {
  state.phase = phase;

  const allPanels = ['panel-no-room','panel-room-info','panel-right',
                     'panel-adjudication','panel-leaderboard','panel-final'];

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
      // round controls hidden during active round
      break;
    case 'adjudication':
      show('panel-room-info');
      show('panel-right');
      show('panel-adjudication');
      break;
    case 'results':
      show('panel-room-info');
      show('panel-right');
      show('panel-leaderboard');
      break;
    case 'finished':
      show('panel-final');
      break;
  }
}

function setConnectionStatus(status) {
  const dot = document.getElementById('host-status-dot');
  const label = document.getElementById('host-conn-label');
  if (!dot) return;
  dot.className = `status-dot ${status}`;
  label.textContent = status === 'connected' ? 'متصل'
                    : status === 'reconnecting' ? 'إعادة الاتصال…'
                    : 'منقطع';
}

// ─── Lock screen ──────────────────────────────────────────────────────────────

document.getElementById('btn-unlock').addEventListener('click', doUnlock);
document.getElementById('input-host-key').addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });

function doUnlock() {
  const key = document.getElementById('input-host-key').value;
  document.getElementById('lock-error').textContent = '';
  socket.emit('host:authenticate', { key }, (res) => {
    if (res.ok) {
      state.hostKey = key;
      localStorage.setItem('hostKey', key);
      showMainConsole();
    } else {
      document.getElementById('lock-error').textContent = res.error || 'مفتاح خاطئ';
    }
  });
}

function showMainConsole() {
  showScreen('console');
  buildPresets();
  if (state.roomCode) {
    tryRejoinRoom();
  } else {
    showHostPhase('no-room');
  }
}

// Validate saved key on load
if (state.hostKey) {
  socket.emit('host:authenticate', { key: state.hostKey }, (res) => {
    if (res.ok) {
      showMainConsole();
    } else {
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
  socket.emit('host:create_room', { key: state.hostKey }, (res) => {
    if (res.ok) {
      state.roomCode = res.code;
      localStorage.setItem('hostRoomCode', res.code);
      setupRoomView(res.code);
      showHostPhase('lobby');
    }
  });
});

// ─── Rejoin existing room ─────────────────────────────────────────────────────

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
      case 'adjudication':
        if (res.adjGroups) renderAdjudicationPanel(res.adjGroups, res.adjCategory, res.roundNumber);
        showHostPhase('adjudication');
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
  });
}

// ─── Room view: code + QR ─────────────────────────────────────────────────────

function setupRoomView(code) {
  document.getElementById('room-code-display').textContent = code;
  const joinUrl = `${window.location.origin}/?room=${code}`;
  document.getElementById('qr-url').textContent = joinUrl;

  if (typeof QRCode !== 'undefined') {
    QRCode.toDataURL(joinUrl, { width: 200, margin: 1, color: { dark: '#f59e0b', light: '#1a1a35' } }, (err, url) => {
      if (!err) document.getElementById('qr-img').src = url;
    });
  }
}

// ─── Player list ──────────────────────────────────────────────────────────────

function renderPlayerList(players) {
  const list = document.getElementById('player-list');
  document.getElementById('player-count-badge').textContent = `${players.length} / 20`;

  if (!players.length) {
    list.innerHTML = '<p class="text-muted" style="font-size:0.9rem;">لم ينضم أحد بعد…</p>';
    return;
  }

  list.innerHTML = '';
  players.forEach(p => {
    const row = document.createElement('div');
    row.className = `player-row${p.connected ? '' : ' offline'}`;
    row.innerHTML = `
      <span class="${p.connected ? 'online-dot' : 'offline-dot'}"></span>
      <span class="player-name">${escapeHtml(p.nickname)}</span>
      <span class="text-muted" style="font-size:0.85rem;margin-inline-start:auto;margin-inline-end:8px;">${p.score ?? 0}</span>
      <button class="btn btn-danger btn-small" data-pid="${escapeHtml(p.playerId)}">طرد</button>
    `;
    row.querySelector('button').addEventListener('click', e =>
      socket.emit('host:kick', { code: state.roomCode, playerId: e.target.dataset.pid })
    );
    list.appendChild(row);
  });
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
  const btn = document.getElementById('btn-start-round');
  if (cat) {
    display.textContent = `الفئة: ${cat}`;
    display.classList.remove('hidden');
    btn.disabled = false;
  } else {
    display.classList.add('hidden');
    btn.disabled = true;
  }
}

// ─── Start round ──────────────────────────────────────────────────────────────

document.getElementById('btn-start-round').addEventListener('click', () => {
  if (!state.selectedCategory) return;
  document.getElementById('round-error').textContent = '';
  document.getElementById('btn-start-round').disabled = true;

  socket.emit('host:start_round', { code: state.roomCode, category: state.selectedCategory }, (res) => {
    if (res?.ok) {
      showHostPhase('round');
    } else {
      document.getElementById('round-error').textContent = res?.error || 'حدث خطأ';
      document.getElementById('btn-start-round').disabled = false;
    }
  });
});

// ─── Adjudication ─────────────────────────────────────────────────────────────

socket.on('round:ended', ({ groups, category, roundNumber }) => {
  renderAdjudicationPanel(groups, category, roundNumber);
  showHostPhase('adjudication');
});

function renderAdjudicationPanel(groups, category, roundNumber) {
  document.getElementById('adj-category').textContent = category;
  document.getElementById('adj-round-num').textContent = roundNumber;

  // Reset adjudication state — all valid by default
  state.adjState = {};
  groups.forEach(g => { state.adjState[g.key] = true; });

  updateAdjStats(groups);

  const list = document.getElementById('adj-list');
  list.innerHTML = '';
  groups.forEach(g => {
    const row = document.createElement('div');
    row.className = 'adj-row';
    row.dataset.key = g.key;
    row.dataset.label = g.displayLabel;

    const count = g.playerCount;
    row.innerHTML = `
      <button class="adj-toggle valid" title="تبديل الصحة">✓</button>
      <span class="adj-label">${escapeHtml(g.displayLabel)}</span>
      <span class="adj-count">${count} ${count === 1 ? 'لاعب' : 'لاعبين'}</span>
    `;

    row.querySelector('.adj-toggle').addEventListener('click', (e) => {
      const key = row.dataset.key;
      state.adjState[key] = !state.adjState[key];
      const valid = state.adjState[key];
      e.target.classList.toggle('valid', valid);
      e.target.classList.toggle('invalid', !valid);
      e.target.textContent = valid ? '✓' : '✗';
      row.classList.toggle('rejected', !valid);
      updateAdjStats(groups);
    });

    list.appendChild(row);
  });

  // Search filter
  document.getElementById('adj-search').value = '';
  document.getElementById('adj-search').oninput = (e) => {
    const q = e.target.value.trim();
    document.querySelectorAll('.adj-row').forEach(row => {
      row.classList.toggle('hidden', !!q && !row.dataset.label.includes(q));
    });
  };
}

function updateAdjStats(groups) {
  const valid = groups.filter(g => state.adjState[g.key] !== false).length;
  const invalid = groups.length - valid;
  document.getElementById('adj-stats').innerHTML = `
    <span>✓ مقبول: <strong>${valid}</strong></span>
    <span>✗ مرفوض: <strong>${invalid}</strong></span>
    <span>الإجمالي: <strong>${groups.length}</strong></span>
  `;
}

document.getElementById('btn-score-round').addEventListener('click', () => {
  const decisions = Object.entries(state.adjState).map(([key, valid]) => ({ key, valid }));
  document.getElementById('btn-score-round').disabled = true;

  socket.emit('host:score_round', { code: state.roomCode, decisions }, (res) => {
    document.getElementById('btn-score-round').disabled = false;
    // round:results event will handle the UI transition
  });
});

// ─── Leaderboard (results) ────────────────────────────────────────────────────

socket.on('round:results', ({ leaderboard, roundNumber }) => {
  renderLeaderboard(leaderboard, roundNumber);
  showHostPhase('results');
});

function renderLeaderboard(leaderboard, roundNumber) {
  document.getElementById('lb-round-num').textContent = roundNumber;
  const tbody = document.getElementById('lb-tbody');
  tbody.innerHTML = '';
  leaderboard.forEach(entry => {
    const tr = document.createElement('tr');
    const sign = entry.roundScore > 0 ? '+' : '';
    const cls = entry.roundScore > 0 ? 'delta-pos' : entry.roundScore < 0 ? 'delta-neg' : 'delta-zero';
    tr.innerHTML = `
      <td class="rank-cell">${entry.rank}</td>
      <td class="name-cell">${escapeHtml(entry.nickname)}</td>
      <td class="delta-cell ${cls}">${sign}${entry.roundScore}</td>
      <td class="score-cell">${entry.totalScore}</td>
    `;
    tbody.appendChild(tr);
  });
}

// New round
document.getElementById('btn-new-round').addEventListener('click', () => {
  socket.emit('host:new_round', { code: state.roomCode }, (res) => {
    if (res?.ok) {
      // Reset category selection
      state.selectedCategory = '';
      document.getElementById('selected-category-display').classList.add('hidden');
      document.getElementById('btn-start-round').disabled = true;
      document.getElementById('custom-category').value = '';
      document.getElementById('round-error').textContent = '';
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('selected'));
      showHostPhase('lobby');
    }
  });
});

// End game
document.getElementById('btn-end-game').addEventListener('click', () => {
  socket.emit('host:end_game', { code: state.roomCode }, (res) => {
    // game:finished event will handle UI
  });
});

// ─── Final screen ─────────────────────────────────────────────────────────────

socket.on('game:finished', ({ leaderboard }) => {
  renderFinal(leaderboard);
  showHostPhase('finished');
  launchConfetti();
});

function renderFinal(leaderboard) {
  renderPodium('host-podium', leaderboard);

  const tbody = document.getElementById('final-tbody');
  tbody.innerHTML = '';
  leaderboard.forEach(entry => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="rank-cell">${entry.rank}</td>
      <td class="name-cell">${escapeHtml(entry.nickname)}</td>
      <td class="score-cell">${entry.totalScore}</td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('btn-new-game').addEventListener('click', () => {
  localStorage.removeItem('hostRoomCode');
  state.roomCode = null;
  state.phase = 'no-room';
  showHostPhase('no-room');
});

// ─── Podium ───────────────────────────────────────────────────────────────────

function renderPodium(containerId, leaderboard) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = '';
  const top3 = leaderboard.slice(0, 3);
  if (!top3.length) return;

  // Physical L→R order: 2nd, 1st, 3rd
  const slots = [top3[1], top3[0], top3[2]];
  const classes = ['second', 'first', 'third'];
  const medals  = ['🥈', '🥇', '🥉'];
  const labels  = ['2', '1', '3'];

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
  for (let i = 0; i < 100; i++) {
    const el = document.createElement('div');
    const size = Math.random() * 10 + 5;
    el.style.cssText = [
      `position:fixed`,
      `width:${size}px`,
      `height:${size}px`,
      `background:${colors[Math.floor(Math.random() * colors.length)]}`,
      `left:${Math.random() * 100}vw`,
      `top:-12px`,
      `border-radius:${Math.random() > 0.5 ? '50%' : '2px'}`,
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
