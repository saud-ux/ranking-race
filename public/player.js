'use strict';

const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  playerId: localStorage.getItem('playerId'),
  roomCode: localStorage.getItem('roomCode'),
  nickname: localStorage.getItem('nickname'),
  phase: 'lobby',
  roundEndsAt: null,
  tickInterval: null,
  myAnswers: [],
};

// ─── Screen / state helpers ───────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
}

function showGameState(name) {
  ['waiting', 'round', 'ended', 'results', 'final'].forEach(n =>
    document.getElementById(`state-${n}`).classList.toggle('hidden', n !== name)
  );
}

function setConnectionStatus(status) {
  document.getElementById('status-dot').className = `status-dot ${status}`;
  document.getElementById('conn-label').textContent =
    status === 'connected' ? 'متصل' :
    status === 'reconnecting' ? 'إعادة الاتصال…' : 'منقطع';
}

function showJoinError(msg) {
  document.getElementById('join-error').textContent = msg;
}

function clearPlayerStorage() {
  ['playerId', 'roomCode', 'nickname'].forEach(k => localStorage.removeItem(k));
  state.playerId = state.roomCode = state.nickname = null;
}

// ─── Join / reconnect ─────────────────────────────────────────────────────────

function attemptJoin(code, nickname, playerId) {
  socket.emit('player:join', { code, nickname, playerId }, (res) => {
    if (!res.ok) {
      if (res.error === 'تمت إزالتك من الغرفة') clearPlayerStorage();
      showJoinError(res.error);
      showScreen('join');
      document.getElementById('btn-join').disabled = false;
      return;
    }

    state.playerId = res.playerId;
    state.roomCode = code.toUpperCase();
    state.nickname = res.nickname;
    localStorage.setItem('playerId', res.playerId);
    localStorage.setItem('roomCode', state.roomCode);
    localStorage.setItem('nickname', res.nickname);

    document.getElementById('display-nickname').textContent = res.nickname;
    showScreen('lobby');

    if (res.phase === 'round' && res.roundInfo) {
      enterRound(res.roundInfo.category, res.roundInfo.endsAt, res.roundInfo.myAnswers || []);
    } else if (res.phase === 'adjudication') {
      showGameState('ended');
    } else if (res.phase === 'results' && res.leaderboard) {
      renderLeaderboard(res.leaderboard, res.roundNumber);
      showGameState('results');
    } else if (res.phase === 'finished' && res.leaderboard) {
      renderFinal(res.leaderboard);
      showGameState('final');
    } else {
      showGameState('waiting');
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(function init() {
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get('room');
  if (roomFromUrl) document.getElementById('input-room-code').value = roomFromUrl.toUpperCase();

  if (state.playerId && state.roomCode) {
    attemptJoin(state.roomCode, state.nickname, state.playerId);
  } else {
    showScreen('join');
  }
})();

// ─── Join form ────────────────────────────────────────────────────────────────

document.getElementById('btn-join').addEventListener('click', doJoin);
document.getElementById('input-nickname').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
document.getElementById('input-room-code').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('input-nickname').focus(); });
document.getElementById('input-room-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });

function doJoin() {
  const code = document.getElementById('input-room-code').value.trim().toUpperCase();
  const nickname = document.getElementById('input-nickname').value.trim();
  showJoinError('');
  if (!code || code.length !== 4) { showJoinError('أدخل كود الغرفة (4 أحرف)'); return; }
  if (!nickname) { showJoinError('أدخل اسمك'); return; }
  document.getElementById('btn-join').disabled = true;
  attemptJoin(code, nickname, null);
}

// ─── Round: enter ─────────────────────────────────────────────────────────────

function enterRound(category, endsAt, existingAnswers) {
  state.phase = 'round';
  state.roundEndsAt = endsAt;
  state.myAnswers = [...existingAnswers];

  document.getElementById('category-display').textContent = category;
  document.getElementById('answer-input').value = '';
  document.getElementById('answer-input').disabled = false;
  document.getElementById('btn-submit-answer').disabled = false;

  const area = document.getElementById('chips-area');
  area.innerHTML = '';
  state.myAnswers.forEach(a => addChip(a));

  showGameState('round');
  startCountdown(endsAt);
  document.getElementById('answer-input').focus();
}

// ─── Countdown ────────────────────────────────────────────────────────────────

function startCountdown(endsAt) {
  clearInterval(state.tickInterval);
  const el = document.getElementById('countdown');

  function tick() {
    const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.textContent = rem;
    const urgent = rem <= 10;
    if (urgent && !el.classList.contains('urgent')) el.classList.add('urgent');
    else if (!urgent) el.classList.remove('urgent');
    if (rem <= 0) clearInterval(state.tickInterval);
  }
  tick();
  state.tickInterval = setInterval(tick, 250);
}

// ─── Answer submission ────────────────────────────────────────────────────────

document.getElementById('btn-submit-answer').addEventListener('click', submitAnswer);
document.getElementById('answer-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitAnswer(); });

function submitAnswer() {
  const input = document.getElementById('answer-input');
  const answer = input.value.trim();
  if (!answer || state.phase !== 'round') return;
  socket.emit('player:submit_answer', { code: state.roomCode, answer });
  input.value = '';
  input.focus();
}

socket.on('player:answer_received', ({ answer }) => addChip(answer));

function addChip(text) {
  const chip = document.createElement('div');
  chip.className = 'chip';
  chip.textContent = text;
  document.getElementById('chips-area').prepend(chip);
}

// ─── Round events ─────────────────────────────────────────────────────────────

socket.on('round:started', ({ category, endsAt }) => {
  state.myAnswers = [];
  enterRound(category, endsAt, []);
});

socket.on('round:tick', ({ remaining }) => {
  if (state.phase !== 'round') return;
  const el = document.getElementById('countdown');
  if (el) {
    el.textContent = remaining;
    el.classList.toggle('urgent', remaining <= 10);
  }
});

socket.on('round:time_up', () => {
  clearInterval(state.tickInterval);
  state.phase = 'adjudication';
  document.getElementById('answer-input').disabled = true;
  document.getElementById('btn-submit-answer').disabled = true;
  showGameState('ended');
});

socket.on('round:reset', () => {
  state.phase = 'lobby';
  clearInterval(state.tickInterval);
  showGameState('waiting');
});

// ─── Results / leaderboard ────────────────────────────────────────────────────

socket.on('round:results', ({ leaderboard, roundNumber }) => {
  state.phase = 'results';
  renderLeaderboard(leaderboard, roundNumber);
  showGameState('results');
});

function renderLeaderboard(leaderboard, roundNumber) {
  document.getElementById('results-round-num').textContent = roundNumber;
  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = '';
  leaderboard.forEach(entry => {
    const tr = document.createElement('tr');
    const isMe = entry.playerId === state.playerId;
    if (isMe) tr.className = 'my-row';
    const sign = entry.roundScore > 0 ? '+' : '';
    const cls = entry.roundScore > 0 ? 'delta-pos' : entry.roundScore < 0 ? 'delta-neg' : 'delta-zero';
    tr.innerHTML = `
      <td class="rank-cell">${entry.rank}</td>
      <td class="name-cell">${escapeHtml(entry.nickname)}${isMe ? ' <span style="color:var(--accent);font-size:0.75rem;">(أنت)</span>' : ''}</td>
      <td class="delta-cell ${cls}">${sign}${entry.roundScore}</td>
      <td class="score-cell">${entry.totalScore}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Final screen ─────────────────────────────────────────────────────────────

socket.on('game:finished', ({ leaderboard }) => {
  state.phase = 'finished';
  renderFinal(leaderboard);
  showGameState('final');
  launchConfetti();
});

function renderFinal(leaderboard) {
  renderPodium('final-podium', leaderboard);

  const tbody = document.getElementById('final-tbody');
  tbody.innerHTML = '';
  leaderboard.forEach(entry => {
    const isMe = entry.playerId === state.playerId;
    const tr = document.createElement('tr');
    if (isMe) tr.className = 'my-row';
    tr.innerHTML = `
      <td class="rank-cell">${entry.rank}</td>
      <td class="name-cell">${escapeHtml(entry.nickname)}${isMe ? ' <span style="color:var(--accent);font-size:0.75rem;">(أنت)</span>' : ''}</td>
      <td class="score-cell">${entry.totalScore}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Podium helper ────────────────────────────────────────────────────────────

function renderPodium(containerId, leaderboard) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = '';
  const top3 = leaderboard.slice(0, 3);
  if (!top3.length) return;

  // Physical order on screen: 2nd (left), 1st (center), 3rd (right)
  const order = [top3[1], top3[0], top3[2]].filter(Boolean);
  const posClass = ['second', 'first', 'third'];
  const medals = ['🥈', '🥇', '🥉'];
  const labels = ['2', '1', '3'];

  order.forEach((entry, i) => {
    const realIdx = top3.indexOf(entry);
    const cls = posClass[i];
    const div = document.createElement('div');
    div.className = `podium-item ${cls}`;
    div.innerHTML = `
      <span class="podium-emoji">${medals[i]}</span>
      <span class="podium-name">${escapeHtml(entry.nickname)}</span>
      <span class="podium-score">${entry.totalScore} نقطة</span>
      <div class="podium-stand">${labels[i]}</div>
    `;
    wrap.appendChild(div);
  });
}

// ─── Kick / room closed ───────────────────────────────────────────────────────

socket.on('player:kicked', () => {
  clearPlayerStorage();
  clearInterval(state.tickInterval);
  showJoinError('تمت إزالتك من الغرفة');
  showScreen('join');
});

socket.on('room:closed', () => {
  clearPlayerStorage();
  clearInterval(state.tickInterval);
  showJoinError('تم إغلاق الغرفة');
  showScreen('join');
});

// ─── Connection ───────────────────────────────────────────────────────────────

socket.on('disconnect', () => setConnectionStatus('reconnecting'));
socket.on('connect_error', () => setConnectionStatus('disconnected'));
socket.on('connect', () => {
  setConnectionStatus('connected');
  if (state.playerId && state.roomCode) {
    attemptJoin(state.roomCode, state.nickname, state.playerId);
  }
});

// ─── Confetti ─────────────────────────────────────────────────────────────────

function launchConfetti() {
  const colors = ['#f59e0b', '#10b981', '#7c3aed', '#ef4444', '#3b82f6', '#f97316', '#ec4899'];
  for (let i = 0; i < 90; i++) {
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

// ─── Utils ────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
