(function() {
// ─── Sound removed ──────────────────────────────────────────────────────────────
// Audio has been disabled. getCtx() is a no-op and sfx.* calls do nothing,
// so existing call sites keep working silently.

function getCtx() { return null; }
const sfx = new Proxy({}, { get: () => () => {} });

// ─── State ────────────────────────────────────────────────────────────────────

let pState = {
  playerId: localStorage.getItem('playerId'),
  roomCode: localStorage.getItem('roomCode'),
  nickname: localStorage.getItem('nickname'),
  phase: 'lobby',
  status: 'active',
  roundEndsAt: null,
  tickInterval: null,
  myAnswers: [],
  lastTickSec: -1,
  specTickInterval: null,
  specBoxes: {},
};

// ─── Screen helpers ───────────────────────────────────────────────────────────

function showGameState(name) {
  ['waiting','round','ended','results','final',
   'spectateIdle','eliminated','spectate'].forEach(n =>
    document.getElementById(`state-${n}`)?.classList.toggle('hidden', n !== name)
  );
}

function showSpectatorIdle() {
  showGameState('spectateIdle');
}

function setConnectionStatus(status) {
  const dot = document.getElementById('status-dot');
  const lbl = document.getElementById('conn-label');
  if (!dot) return;
  dot.className = `status-dot ${status}`;
  lbl.textContent =
    status === 'connected'    ? 'متصل' :
    status === 'reconnecting' ? 'إعادة الاتصال…' : 'منقطع';
}

function showJoinError(msg) {
  const el = document.getElementById('join-error');
  if (el) el.textContent = msg;
}

function clearPlayerStorage() {
  ['playerId','roomCode','nickname'].forEach(k => localStorage.removeItem(k));
  pState.playerId = pState.roomCode = pState.nickname = null;
}

// ─── Navigation helpers ───────────────────────────────────────────────────────

function playerGoToMenu() {
  clearPlayerStorage();
  clearInterval(pState.tickInterval);
  clearInterval(pState.specTickInterval);
  hideLeavModal();
  showScreen('join');
}

function showLeaveModal() {
  document.getElementById('leave-modal')?.classList.remove('hidden');
}

function hideLeavModal() {
  document.getElementById('leave-modal')?.classList.add('hidden');
}

document.getElementById('player-leave-btn')?.addEventListener('click', showLeaveModal);
document.getElementById('leave-cancel-btn')?.addEventListener('click', hideLeavModal);
document.getElementById('leave-confirm-btn')?.addEventListener('click', () => {
  if (pState.playerId && pState.roomCode) {
    socket.emit('player:leave', { code: pState.roomCode, playerId: pState.playerId });
  }
  playerGoToMenu();
});

document.getElementById('player-final-menu-btn')?.addEventListener('click', playerGoToMenu);

document.getElementById('join-back-btn')?.addEventListener('click', () => {
  showJoinError('');
  showScreen('join');
});

document.getElementById('menu-btn-join')?.addEventListener('click', () => {
  getCtx();
  showScreen('join');
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get('room');
  if (roomFromUrl) document.getElementById('input-room-code').value = roomFromUrl.toUpperCase();
  setTimeout(() => document.getElementById('input-room-code').focus(), 50);
});

// ─── Join / reconnect ─────────────────────────────────────────────────────────

function attemptJoin(code, nickname, playerId) {
  socket.emit('player:join', { code, nickname, playerId }, (res) => {
    if (!res.ok) {
      if (res.error === 'تمت إزالتك من الغرفة') clearPlayerStorage();
      showJoinError(res.error);
      showScreen('join');
      const btn = document.getElementById('btn-join');
      if (btn) btn.disabled = false;
      return;
    }

    pState.playerId = res.playerId;
    pState.roomCode = code.toUpperCase();
    pState.nickname = res.nickname;
    pState.status   = res.status || 'active';
    localStorage.setItem('playerId', res.playerId);
    localStorage.setItem('roomCode', pState.roomCode);
    localStorage.setItem('nickname', res.nickname);

    const nickEl = document.getElementById('display-nickname');
    if (nickEl) nickEl.textContent = res.nickname;
    showScreen('lobby');

    if (res.spectateInfo) {
      enterSpectate(res.spectateInfo);
    } else if (res.phase === 'round' && res.roundInfo) {
      enterRound(res.roundInfo.category, res.roundInfo.endsAt, res.roundInfo.myAnswers || []);
    } else if (res.phase === 'finished' && res.leaderboard) {
      renderFinal(res.leaderboard);
      showGameState('final');
    } else if (pState.status !== 'active') {
      showSpectatorIdle();
    } else if (res.phase === 'adjudication') {
      showGameState('ended');
    } else if (res.phase === 'results' && res.leaderboard) {
      renderLeaderboard(res.leaderboard, res.roundNumber);
      showGameState('results');
    } else {
      showGameState('waiting');
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(function init() {
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get('room');

  if (roomFromUrl) {
    document.getElementById('input-room-code').value = roomFromUrl.toUpperCase();
    showScreen('join');
    setTimeout(() => document.getElementById('input-nickname')?.focus(), 50);
    return;
  }

  if (pState.playerId && pState.roomCode) {
    attemptJoin(pState.roomCode, pState.nickname, pState.playerId);
    return;
  }

  showScreen('join');
})();

// ─── Join form ────────────────────────────────────────────────────────────────

document.getElementById('btn-join')?.addEventListener('click', doJoin);
document.getElementById('input-nickname')?.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
document.getElementById('input-room-code')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('input-nickname').focus();
});
document.getElementById('input-room-code')?.addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});

function doJoin() {
  const code     = document.getElementById('input-room-code').value.trim().toUpperCase();
  const nickname = document.getElementById('input-nickname').value.trim();
  showJoinError('');
  if (!code || code.length !== 4) { showJoinError('أدخل كود الغرفة (4 أحرف)'); return; }
  if (!nickname)                  { showJoinError('أدخل اسمك'); return; }
  const btn = document.getElementById('btn-join');
  if (btn) btn.disabled = true;
  getCtx();
  attemptJoin(code, nickname, null);
}

// ─── Round ────────────────────────────────────────────────────────────────────

function enterRound(category, endsAt, existingAnswers) {
  pState.phase      = 'round';
  pState.roundEndsAt = endsAt;
  pState.myAnswers  = [...existingAnswers];
  pState.lastTickSec = -1;

  document.getElementById('category-display').textContent = category;
  const input = document.getElementById('answer-input');
  input.value = '';
  input.disabled = false;
  document.getElementById('btn-submit-answer').disabled = false;

  const area = document.getElementById('chips-area');
  area.innerHTML = '';
  pState.myAnswers.forEach(a => addChip(a, false));

  showGameState('round');
  startCountdown(endsAt);
  input.focus();
}

function startCountdown(endsAt) {
  clearInterval(pState.tickInterval);
  const el = document.getElementById('countdown');

  function tick() {
    const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.textContent = rem;
    el.classList.toggle('urgent', rem <= 10 && rem > 0);
    if (rem <= 0) clearInterval(pState.tickInterval);
  }
  tick();
  pState.tickInterval = setInterval(tick, 250);
}

document.getElementById('btn-submit-answer')?.addEventListener('click', submitAnswer);
document.getElementById('answer-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') submitAnswer();
});

function submitAnswer() {
  const input  = document.getElementById('answer-input');
  const answer = input.value.trim();
  if (!answer || pState.phase !== 'round') return;
  document.getElementById('btn-submit-answer').disabled = true;
  socket.emit('player:submit_answer', { code: pState.roomCode, answer });
  input.value = '';
  input.focus();
  setTimeout(() => { document.getElementById('btn-submit-answer').disabled = false; }, 200);
}

socket.on('player:answer_received', ({ answer }) => {
  prependChip(document.getElementById('chips-area'), answer, true);
  // no submit sound
});

function prependChip(container, text, animate = true) {
  if (!container) return;
  const chip = document.createElement('div');
  chip.className = animate ? 'chip chip-new' : 'chip';
  chip.textContent = text;
  container.prepend(chip);
}

function addChip(text, animate = true) {
  prependChip(document.getElementById('chips-area'), text, animate);
}

socket.on('round:started', ({ category, endsAt }) => {
  if (pState.status !== 'active') return;
  pState.myAnswers = [];
  sfx.roundStart();
  enterRound(category, endsAt, []);
});

socket.on('round:tick', ({ remaining }) => {
  if (pState.phase !== 'round') return;
  const el = document.getElementById('countdown');
  if (!el) return;
  el.textContent = remaining;
  el.classList.toggle('urgent', remaining <= 10 && remaining > 0);
  // no tick sounds
});

socket.on('round:time_up', () => {
  if (pState.status !== 'active') return;
  clearInterval(pState.tickInterval);
  pState.phase = 'adjudication';
  sfx.timeUp();
  document.getElementById('answer-input').disabled = true;
  document.getElementById('btn-submit-answer').disabled = true;
  showGameState('ended');
});

socket.on('round:reset', () => {
  pState.phase = 'lobby';
  clearInterval(pState.tickInterval);
  clearInterval(pState.specTickInterval);
  if (pState.status !== 'active') showSpectatorIdle();
  else showGameState('waiting');
});

// ─── Elimination ──────────────────────────────────────────────────────────────

socket.on('player:eliminated', () => {
  pState.status = 'out';
  clearInterval(pState.tickInterval);
  showGameState('eliminated');
});

// ─── Spectator live view ──────────────────────────────────────────────────────

function enterSpectate(info) {
  pState.phase = 'spectate';
  clearInterval(pState.tickInterval);
  clearInterval(pState.specTickInterval);
  document.getElementById('spectate-banner').textContent = '👀 أنت تتفرّج';
  document.getElementById('spectate-category').textContent = info.category || '';
  buildSpectateGrid(info.players || []);
  if (info.answers) {
    for (const pid of Object.keys(info.answers)) {
      (info.answers[pid] || []).forEach(a => addSpectateChip(pid, a, false));
    }
  }
  startSpectateCountdown(info.endsAt);
  showGameState('spectate');
}

function buildSpectateGrid(players) {
  const grid = document.getElementById('spectate-grid');
  grid.innerHTML = '';
  pState.specBoxes = {};
  players.forEach(p => {
    const box = document.createElement('div');
    box.className = 'spec-box';
    box.innerHTML = `
      <div class="spec-box-name">${escapeHtml(p.nickname)}</div>
      <div class="spec-chips"></div>
    `;
    grid.appendChild(box);
    pState.specBoxes[p.playerId] = box.querySelector('.spec-chips');
  });
}

function addSpectateChip(playerId, answer, animate = true) {
  prependChip(pState.specBoxes[playerId], answer, animate);
}

function startSpectateCountdown(endsAt) {
  clearInterval(pState.specTickInterval);
  const el = document.getElementById('spectate-countdown');
  if (!endsAt) { el.textContent = ''; return; }
  function tick() {
    const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.textContent = rem;
    el.classList.toggle('urgent', rem <= 10);
    if (rem <= 0) clearInterval(pState.specTickInterval);
  }
  tick();
  pState.specTickInterval = setInterval(tick, 250);
}

socket.on('spectate:round_start', (info) => {
  if (pState.status === 'active') return;
  enterSpectate(info);
});
socket.on('spectate:answer', ({ playerId, answer }) => {
  if (pState.phase === 'spectate') addSpectateChip(playerId, answer, true);
});
socket.on('spectate:round_end', () => {
  clearInterval(pState.specTickInterval);
});

// ─── Results / leaderboard ────────────────────────────────────────────────────

socket.on('round:results', ({ leaderboard, roundNumber }) => {
  pState.phase = 'results';
  renderLeaderboard(leaderboard, roundNumber);
  showGameState('results');
});

function renderLeaderboard(leaderboard, roundNumber) {
  document.getElementById('results-round-num').textContent = roundNumber;
  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = '';
  leaderboard.forEach((entry, idx) => {
    const tr   = document.createElement('tr');
    const isMe = entry.playerId === pState.playerId;
    if (isMe)         tr.className = 'my-row lb-row-enter';
    else if (idx===0) tr.className = 'rank-1-row lb-row-enter';
    else              tr.className = 'lb-row-enter';
    const sign  = entry.roundScore > 0 ? '+' : '';
    const cls   = entry.roundScore > 0 ? 'delta-pos' : entry.roundScore < 0 ? 'delta-neg' : 'delta-zero';
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '';
    tr.innerHTML = `
      <td class="rank-cell">${medal || entry.rank}</td>
      <td class="name-cell">${escapeHtml(entry.nickname)}${isMe ? ' <span class="you-badge">(أنت)</span>' : ''}</td>
      <td class="delta-cell ${cls} delta-pop">${sign}${entry.roundScore}</td>
      <td class="score-cell">${entry.totalScore}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Final screen ─────────────────────────────────────────────────────────────

socket.on('game:finished', ({ leaderboard }) => {
  pState.phase = 'finished';
  renderFinal(leaderboard);
  showGameState('final');
  sfx.fanfare();
  setTimeout(launchConfetti, 400);
});

function renderFinal(leaderboard) {
  renderPodium('final-podium', leaderboard);
  const tbody = document.getElementById('final-tbody');
  tbody.innerHTML = '';
  leaderboard.forEach((entry, idx) => {
    const isMe = entry.playerId === pState.playerId;
    const tr   = document.createElement('tr');
    tr.className = [isMe ? 'my-row' : '', idx === 0 ? 'rank-1-row' : '', 'lb-row-enter'].filter(Boolean).join(' ');
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '';
    tr.innerHTML = `
      <td class="rank-cell">${medal || entry.rank}</td>
      <td class="name-cell">${escapeHtml(entry.nickname)}${isMe ? ' <span class="you-badge">(أنت)</span>' : ''}</td>
      <td class="score-cell">${entry.totalScore}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Podium ───────────────────────────────────────────────────────────────────

function renderPodium(containerId, leaderboard) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  wrap.innerHTML = '';
  const top3    = leaderboard.slice(0, 3);
  if (!top3.length) return;
  const slots   = [top3[1], top3[0], top3[2]];
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

// ─── Kicked / room closed ─────────────────────────────────────────────────────

socket.on('player:kicked', () => {
  clearPlayerStorage();
  clearInterval(pState.tickInterval);
  showJoinError('تمت إزالتك من الغرفة');
  showScreen('join');
});

socket.on('room:closed', () => {
  clearPlayerStorage();
  clearInterval(pState.tickInterval);
  showJoinError('تم إغلاق الغرفة');
  showScreen('join');
});

// ─── Connection ───────────────────────────────────────────────────────────────

socket.on('disconnect', () => setConnectionStatus('reconnecting'));
socket.on('connect_error', () => setConnectionStatus('disconnected'));
socket.on('connect', () => {
  setConnectionStatus('connected');
  if (pState.playerId && pState.roomCode) {
    attemptJoin(pState.roomCode, pState.nickname, pState.playerId);
  }
});

// ─── Confetti ─────────────────────────────────────────────────────────────────

function launchConfetti() {
  const colors = ['#f59e0b','#10b981','#7c3aed','#ef4444','#3b82f6','#f97316','#ec4899'];
  for (let i = 0; i < 70; i++) {
    const el   = document.createElement('div');
    const size = Math.random() * 8 + 5;
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
      `animation-delay:${Math.random() * 1.5}s`,
    ].join(';');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5500);
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
})();
