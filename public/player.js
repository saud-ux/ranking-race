'use strict';

const socket = io();

// ─── Audio engine (Web Audio API, no files) ───────────────────────────────────

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
  submit()      { beep(900, 0.08, 'sine', 0.16); },
  tick()        { beep(560, 0.07, 'square', 0.10); },
  urgentTick()  { beep(880, 0.07, 'square', 0.14); },
  timeUp()      { sweep(480, 90, 0.75, 'sawtooth', 0.28); },
  roundStart()  { seq([{f:400,d:0.09,at:0},{f:600,d:0.09,at:80},{f:900,d:0.15,at:160}]); },
  goodScore()   { seq([{f:523,d:0.12,at:0},{f:659,d:0.12,at:110},{f:784,d:0.22,at:220}]); },
  badScore()    { sweep(250, 120, 0.35, 'square', 0.18); },
  gulagEnter()  {
    // Descending ominous tones — distinct from round sounds
    seq([{f:300,d:0.18,at:0},{f:220,d:0.18,at:200},{f:150,d:0.35,at:420}]);
  },
  duelStart()   {
    seq([
      {f:200,d:0.10,at:0},{f:250,d:0.10,at:100},
      {f:300,d:0.10,at:200},{f:450,d:0.25,at:320},
    ]);
  },
  duelWin()     {
    seq([
      {f:523,d:0.12,at:0},{f:659,d:0.12,at:110},
      {f:784,d:0.18,at:220},{f:1047,d:0.35,at:380},
    ]);
  },
  duelLose()    { sweep(300, 80, 0.6, 'sawtooth', 0.22); },
  fanfare()     {
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
  const btn = document.getElementById('mute-btn');
  if (!btn) return;
  btn.textContent = muted ? '🔇' : '🔊';
  btn.title = muted ? 'تشغيل الصوت' : 'كتم الصوت';
}
updateMuteBtn();

document.getElementById('mute-btn')?.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('muted', muted ? '1' : '0');
  updateMuteBtn();
});

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
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

// ─── Screen / state helpers ───────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
}

function showGameState(name) {
  ['waiting','round','ended','results','final',
   'gulagWait','spectateIdle','duel','duelResult','spectate'].forEach(n =>
    document.getElementById(`state-${n}`).classList.toggle('hidden', n !== name)
  );
}

function showSpectatorIdle() {
  showGameState(state.status === 'gulag' ? 'gulagWait' : 'spectateIdle');
}

function setConnectionStatus(status) {
  document.getElementById('status-dot').className = `status-dot ${status}`;
  document.getElementById('conn-label').textContent =
    status === 'connected'    ? 'متصل' :
    status === 'reconnecting' ? 'إعادة الاتصال…' : 'منقطع';
}

function showJoinError(msg) { document.getElementById('join-error').textContent = msg; }

function clearPlayerStorage() {
  ['playerId','roomCode','nickname'].forEach(k => localStorage.removeItem(k));
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
    state.status   = res.status || 'active';
    localStorage.setItem('playerId', res.playerId);
    localStorage.setItem('roomCode', state.roomCode);
    localStorage.setItem('nickname', res.nickname);

    document.getElementById('display-nickname').textContent = res.nickname;
    showScreen('lobby');

    if (res.duelInfo) {
      enterDuel(res.duelInfo.category, res.duelInfo.endsAt, res.duelInfo.opponent, res.duelInfo.myAnswers || []);
    } else if (res.spectateInfo) {
      enterSpectate(res.spectateInfo);
    } else if (res.phase === 'round' && res.roundInfo) {
      enterRound(res.roundInfo.category, res.roundInfo.endsAt, res.roundInfo.myAnswers || []);
    } else if (res.phase === 'finished' && res.leaderboard) {
      renderFinal(res.leaderboard);
      showGameState('final');
    } else if (state.status !== 'active') {
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
document.getElementById('input-room-code').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('input-nickname').focus();
});
document.getElementById('input-room-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});

function doJoin() {
  const code     = document.getElementById('input-room-code').value.trim().toUpperCase();
  const nickname = document.getElementById('input-nickname').value.trim();
  showJoinError('');
  if (!code || code.length !== 4) { showJoinError('أدخل كود الغرفة (4 أحرف)'); return; }
  if (!nickname)                  { showJoinError('أدخل اسمك'); return; }
  document.getElementById('btn-join').disabled = true;
  getCtx();
  attemptJoin(code, nickname, null);
}

// ─── Round: enter ─────────────────────────────────────────────────────────────

function enterRound(category, endsAt, existingAnswers) {
  state.phase     = 'round';
  state.roundEndsAt = endsAt;
  state.myAnswers = [...existingAnswers];
  state.lastTickSec = -1;

  document.getElementById('category-display').textContent = category;
  const input = document.getElementById('answer-input');
  input.value = '';
  input.disabled = false;
  document.getElementById('btn-submit-answer').disabled = false;

  const area = document.getElementById('chips-area');
  area.innerHTML = '';
  state.myAnswers.forEach(a => addChip(a, false));

  showGameState('round');

  const roundCard = document.querySelector('#state-round .card');
  if (roundCard) {
    roundCard.classList.remove('round-start-flash');
    void roundCard.offsetWidth;
    roundCard.classList.add('round-start-flash');
  }

  startCountdown(endsAt);
  input.focus();
}

// ─── Countdown ────────────────────────────────────────────────────────────────

function startCountdown(endsAt) {
  clearInterval(state.tickInterval);
  const el = document.getElementById('countdown');

  function tick() {
    const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.textContent = rem;
    const urgent = rem <= 10 && rem > 0;
    el.classList.toggle('urgent', urgent || rem === 0);

    if (urgent && rem !== state.lastTickSec) {
      state.lastTickSec = rem;
      rem <= 5 ? sfx.urgentTick() : sfx.tick();
    }
    if (rem <= 0) clearInterval(state.tickInterval);
  }
  tick();
  state.tickInterval = setInterval(tick, 250);
}

// ─── Answer submission ────────────────────────────────────────────────────────

document.getElementById('btn-submit-answer').addEventListener('click', submitAnswer);
document.getElementById('answer-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitAnswer();
});

function submitAnswer() {
  const input  = document.getElementById('answer-input');
  const answer = input.value.trim();
  if (!answer || state.phase !== 'round') return;

  // Optimistic: briefly disable to prevent double-submit, re-enable on server echo
  document.getElementById('btn-submit-answer').disabled = true;
  socket.emit('player:submit_answer', { code: state.roomCode, answer });
  input.value = '';
  input.focus();
  setTimeout(() => { document.getElementById('btn-submit-answer').disabled = false; }, 200);
}

socket.on('player:answer_received', ({ answer }) => {
  const area = state.phase === 'duel'
    ? document.getElementById('duel-chips')
    : document.getElementById('chips-area');
  prependChip(area, answer, true);
  sfx.submit();
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

// ─── Round events ─────────────────────────────────────────────────────────────

socket.on('round:started', ({ category, endsAt }) => {
  if (state.status !== 'active') return;
  state.myAnswers = [];
  sfx.roundStart();
  enterRound(category, endsAt, []);
});

socket.on('round:tick', ({ remaining }) => {
  if (state.phase !== 'round') return;
  const el = document.getElementById('countdown');
  if (!el) return;
  el.textContent = remaining;
  el.classList.toggle('urgent', remaining <= 10 && remaining > 0);
  if (remaining <= 10 && remaining > 0 && remaining !== state.lastTickSec) {
    state.lastTickSec = remaining;
    remaining <= 5 ? sfx.urgentTick() : sfx.tick();
  }
});

socket.on('round:time_up', () => {
  if (state.status !== 'active') return;
  clearInterval(state.tickInterval);
  state.phase = 'adjudication';
  sfx.timeUp();
  document.getElementById('answer-input').disabled = true;
  document.getElementById('btn-submit-answer').disabled = true;
  showGameState('ended');
});

socket.on('round:reset', () => {
  state.phase = 'lobby';
  clearInterval(state.tickInterval);
  clearInterval(state.specTickInterval);
  if (state.status !== 'active') showSpectatorIdle();
  else showGameState('waiting');
});

// ─── Gulag & duel (player) ──────────────────────────────────────────────────

socket.on('gulag:entered', () => {
  state.status = 'gulag';
  clearInterval(state.tickInterval);
  sfx.gulagEnter();           // ominous drop instead of generic bad score
  showGameState('gulagWait');
});

function enterDuel(category, endsAt, opponent, existingAnswers) {
  state.phase     = 'duel';
  state.roundEndsAt = endsAt;
  state.lastTickSec = -1;

  document.getElementById('duel-opponent').textContent  = opponent || '—';
  document.getElementById('duel-category').textContent  = category;

  const input = document.getElementById('duel-input');
  input.value = '';
  input.disabled = false;
  document.getElementById('btn-duel-submit').disabled = false;

  const chips = document.getElementById('duel-chips');
  chips.innerHTML = '';
  (existingAnswers || []).forEach(a => prependChip(chips, a, false));

  showGameState('duel');
  startDuelCountdown(endsAt);

  // Flash the duel card on entry
  const duelCard = document.querySelector('#state-duel .duel-card');
  if (duelCard) {
    duelCard.classList.remove('round-start-flash');
    void duelCard.offsetWidth;
    duelCard.classList.add('round-start-flash');
  }

  input.focus();
}

socket.on('duel:started', ({ category, endsAt, opponent }) => {
  state.status = 'gulag';
  sfx.duelStart();
  enterDuel(category, endsAt, opponent, []);
});

function startDuelCountdown(endsAt) {
  clearInterval(state.tickInterval);
  state.lastTickSec = -1;
  const el = document.getElementById('duel-countdown');
  function tick() {
    const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.textContent = rem;
    el.classList.toggle('urgent', rem <= 10);
    // Ticks during duel too — tension matters
    if (rem <= 10 && rem > 0 && rem !== state.lastTickSec) {
      state.lastTickSec = rem;
      rem <= 5 ? sfx.urgentTick() : sfx.tick();
    }
    if (rem <= 0) clearInterval(state.tickInterval);
  }
  tick();
  state.tickInterval = setInterval(tick, 250);
}

document.getElementById('btn-duel-submit').addEventListener('click', submitDuelAnswer);
document.getElementById('duel-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitDuelAnswer();
});

function submitDuelAnswer() {
  const input  = document.getElementById('duel-input');
  const answer = input.value.trim();
  if (!answer || state.phase !== 'duel') return;
  document.getElementById('btn-duel-submit').disabled = true;
  socket.emit('player:submit_answer', { code: state.roomCode, answer });
  input.value = '';
  input.focus();
  setTimeout(() => { document.getElementById('btn-duel-submit').disabled = false; }, 200);
}

socket.on('duel:tick', ({ remaining }) => {
  const id = state.phase === 'duel'     ? 'duel-countdown'
           : state.phase === 'spectate' ? 'spectate-countdown' : null;
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = remaining;
  el.classList.toggle('urgent', remaining <= 10);
});

socket.on('duel:time_up', () => {
  if (state.phase === 'duel') {
    clearInterval(state.tickInterval);
    document.getElementById('duel-input').disabled = true;
    document.getElementById('btn-duel-submit').disabled = true;
    sfx.timeUp();
  } else {
    clearInterval(state.specTickInterval);
  }
});

socket.on('duel:result', ({ winnerId, loserId, winnerNick, loserNick }) => {
  if (winnerId === state.playerId) {
    state.status = 'active';
    document.getElementById('duel-result-emoji').textContent = '🎉';
    const msg = document.getElementById('duel-result-msg');
    msg.textContent = 'نجوت!';
    msg.style.color = 'var(--success)';
    document.getElementById('duel-result-sub').textContent = 'ترجع للمنافسة — استعدّ للجولة القادمة.';
    showGameState('duelResult');
    sfx.duelWin();
  } else if (loserId === state.playerId) {
    state.status = 'out';
    document.getElementById('duel-result-emoji').textContent = '💀';
    const msg = document.getElementById('duel-result-msg');
    msg.textContent = 'خرجت من اللعبة';
    msg.style.color = 'var(--danger)';
    document.getElementById('duel-result-sub').textContent = 'بتتفرّج على الباقين لين تنتهي اللعبة 👀';
    showGameState('duelResult');
    sfx.duelLose();
  } else {
    const banner = document.getElementById('spectate-banner');
    if (banner) banner.textContent = `⚔️ ${winnerNick} فاز على ${loserNick}`;
    clearInterval(state.specTickInterval);
  }
});

// ─── Spectator live view ────────────────────────────────────────────────────

function enterSpectate(info) {
  state.phase = 'spectate';
  clearInterval(state.tickInterval);
  clearInterval(state.specTickInterval);
  document.getElementById('spectate-banner').textContent =
    info.isDuel ? '⚔️ مبارزة الـ Gulag' : '👀 أنت تتفرّج';
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
  state.specBoxes = {};
  players.forEach(p => {
    const box = document.createElement('div');
    box.className = 'spec-box';
    box.innerHTML = `
      <div class="spec-box-name">${escapeHtml(p.nickname)}</div>
      <div class="spec-chips"></div>
    `;
    grid.appendChild(box);
    state.specBoxes[p.playerId] = box.querySelector('.spec-chips');
  });
}

function addSpectateChip(playerId, answer, animate = true) {
  prependChip(state.specBoxes[playerId], answer, animate);
}

function startSpectateCountdown(endsAt) {
  clearInterval(state.specTickInterval);
  const el = document.getElementById('spectate-countdown');
  if (!endsAt) { el.textContent = ''; return; }
  function tick() {
    const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.textContent = rem;
    el.classList.toggle('urgent', rem <= 10);
    if (rem <= 0) clearInterval(state.specTickInterval);
  }
  tick();
  state.specTickInterval = setInterval(tick, 250);
}

socket.on('spectate:round_start', (info) => {
  if (state.status === 'active') return;
  enterSpectate({ ...info, isDuel: false });
});

socket.on('duel:spectate_start', (info) => {
  enterSpectate({ ...info, isDuel: true });
});

socket.on('spectate:answer', ({ playerId, answer }) => {
  if (state.phase === 'spectate') addSpectateChip(playerId, answer, true);
});

socket.on('duel:spectate_answer', ({ playerId, answer }) => {
  if (state.phase === 'spectate') addSpectateChip(playerId, answer, true);
});

socket.on('spectate:round_end', () => {
  clearInterval(state.specTickInterval);
});

// ─── Results / leaderboard ────────────────────────────────────────────────────

socket.on('round:results', ({ leaderboard, roundNumber }) => {
  state.phase = 'results';
  renderLeaderboard(leaderboard, roundNumber);
  showGameState('results');

  const mine = leaderboard.find(e => e.playerId === state.playerId);
  if (mine) {
    setTimeout(() => {
      if (mine.roundScore > 0)      sfx.goodScore();
      else if (mine.roundScore < 0) sfx.badScore();
    }, 500);
  }
});

function renderLeaderboard(leaderboard, roundNumber) {
  document.getElementById('results-round-num').textContent = roundNumber;
  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = '';

  leaderboard.forEach((entry, idx) => {
    const tr  = document.createElement('tr');
    const isMe = entry.playerId === state.playerId;
    if (isMe)        tr.className = 'my-row lb-row-enter';
    else if (idx===0) tr.className = 'rank-1-row lb-row-enter';
    else              tr.className = 'lb-row-enter';
    tr.style.setProperty('--row-delay', `${idx * 70}ms`);

    const sign  = entry.roundScore > 0 ? '+' : '';
    const cls   = entry.roundScore > 0 ? 'delta-pos' : entry.roundScore < 0 ? 'delta-neg' : 'delta-zero';
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '';
    tr.innerHTML = `
      <td class="rank-cell">${medal || entry.rank}</td>
      <td class="name-cell">${escapeHtml(entry.nickname)}${isMe ? ' <span class="you-badge">(أنت)</span>' : ''}</td>
      <td class="delta-cell ${cls} delta-pop" style="animation-delay:${idx*70+300}ms">${sign}${entry.roundScore}</td>
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
  sfx.fanfare();
  setTimeout(launchConfetti, 400);
});

function renderFinal(leaderboard) {
  renderPodium('final-podium', leaderboard);
  const tbody = document.getElementById('final-tbody');
  tbody.innerHTML = '';
  leaderboard.forEach((entry, idx) => {
    const isMe = entry.playerId === state.playerId;
    const tr   = document.createElement('tr');
    tr.className = [
      isMe ? 'my-row' : '',
      idx === 0 ? 'rank-1-row' : '',
      'lb-row-enter',
    ].filter(Boolean).join(' ');
    tr.style.setProperty('--row-delay', `${idx * 60}ms`);
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
  wrap.innerHTML = '';
  const top3  = leaderboard.slice(0, 3);
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
  if (state.playerId && state.roomCode) attemptJoin(state.roomCode, state.nickname, state.playerId);
});

// ─── Confetti ─────────────────────────────────────────────────────────────────

function launchConfetti() {
  const colors = ['#f59e0b','#10b981','#7c3aed','#ef4444','#3b82f6','#f97316','#ec4899'];
  for (let i = 0; i < 90; i++) {
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
