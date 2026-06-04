'use strict';

const socket = io();

const PRESETS = [
  // الطعام والطبيعة
  'فواكه','خضار','أكلات','حلويات','مشروبات','بهارات','حيوانات','طيور','أسماك','نباتات','أشجار','زهور',
  // الناس والأماكن
  'دول','عواصم','مدن سعودية','مدن عربية','أنهار','جبال','بحار',
  'أسماء أولاد','أسماء بنات','مهن','رياضات','لاعبين كرة قدم','أندية كرة قدم',
  // أشياء وعلامات
  'ألوان','ماركات سيارات','ماركات جوالات','شركات','تطبيقات','أفلام','مسلسلات','برامج تلفزيونية',
  'آلات موسيقية','أدوات مطبخ','ملابس','أثاث منزل','وسائل نقل','مواد دراسية','لغات','كواكب',
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
  playerJoin()  { beep(660, 0.12, 'sine', 0.14); },
  roundStart()  { seq([{f:400,d:0.09,at:0},{f:600,d:0.09,at:80},{f:900,d:0.18,at:160}]); },
  timeUp()      { sweep(480, 90, 0.75, 'sawtooth', 0.28); },
  adjReject()   { beep(220, 0.18, 'square', 0.15); },
  adjAccept()   { beep(660, 0.12, 'sine', 0.15); },
  scored()      { seq([{f:523,d:0.12,at:0},{f:659,d:0.12,at:110},{f:784,d:0.22,at:220}]); },
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
  adjMode: 'round',         // 'round' | 'duel' — which scorer the adjudication panel feeds
  prevPlayerCount: 0,
  gulagPending: null,       // { playerId, nickname } awaiting a decision
  duelBoxes: {},            // playerId → chips container element
  duelTickInterval: null,
  config: { mode: 'solo', roundSeconds: 30, duelSeconds: 20, teamCount: 2, teams: [] },
  chatOpen: false,
  chatUnread: 0,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Avatar chip markup (image data-URL or emoji/text fallback)
function avatarHTML(avatar, extraClass = '') {
  const cls = `avatar-chip ${extraClass}`.trim();
  if (avatar && avatar.startsWith('data:image/'))
    return `<span class="${cls}"><img src="${escapeHtml(avatar)}" alt=""></span>`;
  return `<span class="${cls}">${escapeHtml(avatar || '🙂')}</span>`;
}

function teamColor(teamId) {
  return (state.config.teams || []).find(t => t.id === teamId)?.color || null;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
}

function showHostPhase(phase) {
  state.phase = phase;
  const allPanels = ['panel-no-room','panel-room-info','panel-right',
                     'panel-adjudication','panel-leaderboard','panel-final',
                     'panel-duel','panel-duel-result'];
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
    case 'no-room':     show('panel-no-room'); break;
    case 'lobby':       show('panel-room-info'); show('panel-right'); show('round-controls'); break;
    case 'round':       show('panel-room-info'); show('panel-right'); break;
    case 'adjudication':show('panel-room-info'); show('panel-right'); show('panel-adjudication'); break;
    case 'duel_adjudication': show('panel-room-info'); show('panel-right'); show('panel-adjudication'); break;
    case 'results':     show('panel-room-info'); show('panel-right'); show('panel-leaderboard'); break;
    case 'duel':        show('panel-room-info'); show('panel-right'); show('panel-duel'); break;
    case 'duel_result': show('panel-room-info'); show('panel-right'); show('panel-duel-result'); break;
    case 'finished':    show('panel-final'); break;
  }
}

function setConnectionStatus(status) {
  const dot   = document.getElementById('host-status-dot');
  const label = document.getElementById('host-conn-label');
  if (!dot) return;
  dot.className = `status-dot ${status}`;
  label.textContent = status === 'connected' ? 'متصل'
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
  socket.emit('host:create_room', { key: state.hostKey }, (res) => {
    if (res.ok) {
      state.roomCode = res.code;
      localStorage.setItem('hostRoomCode', res.code);
      setupRoomView(res.code);
      applyConfigToControls({ mode: 'solo', roundSeconds: 30, duelSeconds: 20, teamCount: 2, teams: [] });
      loadChatHistory([]);
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
    if (res.config) applyConfigToControls(res.config);
    if (res.chat) loadChatHistory(res.chat);
    renderPlayerList(res.players);

    switch (res.phase) {
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
        renderTeamStandings('lb-team-standings', res.teamLeaderboard);
        showHostPhase('results');
        break;
      case 'finished':
        if (res.leaderboard) renderFinal(res.leaderboard);
        renderTeamStandings('final-team-standings', res.teamLeaderboard);
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
  if (typeof QRCode !== 'undefined') {
    QRCode.toDataURL(joinUrl, { width: 200, margin: 1, color: { dark: '#f59e0b', light: '#1a1a35' } }, (err, url) => {
      if (!err) document.getElementById('qr-img').src = url;
    });
  }
}

// ─── Player list ──────────────────────────────────────────────────────────────

function renderPlayerList(players) {
  const list  = document.getElementById('player-list');
  const badge = document.getElementById('player-count-badge');
  badge.textContent = `${players.length} / 20`;

  // Ready summary (shown in the lobby)
  const readyBadge = document.getElementById('ready-badge');
  const readyCount = players.filter(p => p.ready).length;
  const showReady = state.phase === 'lobby' && players.length > 0;
  readyBadge.classList.toggle('hidden', !showReady);
  if (showReady) readyBadge.textContent = `✅ ${readyCount}/${players.length}`;

  // Play join sound when count increases
  if (players.length > state.prevPlayerCount) sfx.playerJoin();
  state.prevPlayerCount = players.length;

  if (!players.length) {
    list.innerHTML = '<p class="text-muted" style="font-size:0.9rem;">لم ينضم أحد بعد…</p>';
    return;
  }

  list.innerHTML = '';
  players.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = `player-row${p.connected ? '' : ' offline'}`;
    if (p.status === 'out')   row.classList.add('player-out');
    if (p.status === 'gulag') row.classList.add('player-gulag');
    if (p.ready)              row.classList.add('player-ready');
    row.style.setProperty('--row-delay', `${idx * 50}ms`);
    row.classList.add('lb-row-enter');
    const tc = teamColor(p.teamId);
    if (tc) row.style.borderInlineStartColor = tc;
    const badge = p.status === 'out' ? ' 💀' : p.status === 'gulag' ? ' ⛓️' : '';
    const tick  = p.ready ? ' <span class="player-ready-tick" title="جاهز">✅</span>' : '';
    const teamDot = tc ? `<span class="team-dot" style="background:${tc}"></span>` : '';
    row.innerHTML = `
      <span class="${p.connected ? 'online-dot' : 'offline-dot'}"></span>
      ${avatarHTML(p.avatar, 'avatar-sm')}
      ${teamDot}
      <span class="player-name">${escapeHtml(p.nickname)}${badge}${tick}</span>
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
  const btn     = document.getElementById('btn-start-round');
  if (cat) { display.textContent = `الفئة: ${cat}`; display.classList.remove('hidden'); btn.disabled = false; }
  else     { display.classList.add('hidden'); btn.disabled = true; }
}

// ─── Start round ──────────────────────────────────────────────────────────────

document.getElementById('btn-start-round').addEventListener('click', () => {
  if (!state.selectedCategory) return;
  document.getElementById('round-error').textContent = '';
  document.getElementById('btn-start-round').disabled = true;

  socket.emit('host:start_round', { code: state.roomCode, category: state.selectedCategory }, (res) => {
    if (res?.ok) {
      sfx.roundStart();
      showHostPhase('round');
    } else {
      document.getElementById('round-error').textContent = res?.error || 'حدث خطأ';
      document.getElementById('btn-start-round').disabled = false;
    }
  });
});

// ─── Game configuration (mode / timers / teams) ──────────────────────────────

const MODE_HINTS = {
  solo:  'الجميع يتنافسون فردياً، مع نظام الإقصاء (Gulag).',
  teams: 'اللاعبون يُوزّعون على الفرق وتُجمع نقاطهم — لا إقصاء.',
  rapid: 'جولات سريعة وقصيرة (افتراضي 15 ثانية).',
};

function pushConfig(extra = {}) {
  const payload = {
    code: state.roomCode,
    roundSeconds: Number(document.getElementById('round-seconds').value),
    duelSeconds: Number(document.getElementById('duel-seconds').value),
    ...extra,
  };
  socket.emit('host:configure', payload, (res) => {
    if (res?.ok && res.config) applyConfigToControls(res.config);
  });
}

function applyConfigToControls(config) {
  state.config = config;
  document.querySelectorAll('#mode-grid .mode-btn').forEach(b =>
    b.classList.toggle('selected', b.dataset.mode === config.mode));
  document.querySelectorAll('#team-count-grid .mode-btn').forEach(b =>
    b.classList.toggle('selected', Number(b.dataset.teams) === config.teamCount));
  document.getElementById('round-seconds').value = config.roundSeconds;
  document.getElementById('duel-seconds').value = config.duelSeconds;
  document.getElementById('mode-hint').textContent = MODE_HINTS[config.mode] || '';
  document.getElementById('team-count-group').classList.toggle('hidden', config.mode !== 'teams');
  document.getElementById('duel-seconds-group').classList.toggle('hidden', config.mode === 'teams');
}

document.querySelectorAll('#mode-grid .mode-btn').forEach(btn =>
  btn.addEventListener('click', () => pushConfig({ mode: btn.dataset.mode })));
document.querySelectorAll('#team-count-grid .mode-btn').forEach(btn =>
  btn.addEventListener('click', () => pushConfig({ teamCount: Number(btn.dataset.teams) })));
document.getElementById('round-seconds').addEventListener('change', () => pushConfig());
document.getElementById('duel-seconds').addEventListener('change', () => pushConfig());

// ─── Adjudication ─────────────────────────────────────────────────────────────

socket.on('round:ended', ({ groups, category, roundNumber }) => {
  sfx.timeUp();
  state.adjMode = 'round';
  renderAdjudicationPanel(groups, category, roundNumber);
  showHostPhase('adjudication');
});

function renderAdjudicationPanel(groups, category, roundNumber) {
  document.getElementById('adj-category').textContent = category;
  document.getElementById('adj-round-num').textContent = roundNumber;

  state.adjState = {};
  groups.forEach(g => { state.adjState[g.key] = true; });
  updateAdjStats(groups);

  const list = document.getElementById('adj-list');
  list.innerHTML = '';

  groups.forEach((g, idx) => {
    const row = document.createElement('div');
    row.className = 'adj-row lb-row-enter';
    row.style.setProperty('--row-delay', `${idx * 40}ms`);
    row.dataset.key   = g.key;
    row.dataset.label = g.displayLabel;

    row.innerHTML = `
      <button class="adj-toggle valid" title="تبديل">✓</button>
      <span class="adj-label">${escapeHtml(g.displayLabel)}</span>
      <span class="adj-count">${g.playerCount} ${g.playerCount === 1 ? 'لاعب' : 'لاعبين'}</span>
    `;

    row.querySelector('.adj-toggle').addEventListener('click', (e) => {
      const key   = row.dataset.key;
      state.adjState[key] = !state.adjState[key];
      const valid = state.adjState[key];
      e.target.classList.toggle('valid',   valid);
      e.target.classList.toggle('invalid', !valid);
      e.target.textContent = valid ? '✓' : '✗';
      row.classList.toggle('rejected', !valid);

      // Shake on reject, brief pop on accept
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
      row.classList.toggle('hidden', !!q && !row.dataset.label.includes(q));
    });
  };
}

function updateAdjStats(groups) {
  const valid   = groups.filter(g => state.adjState[g.key] !== false).length;
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
  const event = state.adjMode === 'duel' ? 'host:score_duel' : 'host:score_round';
  socket.emit(event, { code: state.roomCode, decisions }, () => {
    document.getElementById('btn-score-round').disabled = false;
  });
});

// ─── Leaderboard ──────────────────────────────────────────────────────────────

socket.on('round:results', ({ leaderboard, teamLeaderboard, roundNumber }) => {
  sfx.scored();
  renderLeaderboard(leaderboard, roundNumber);
  renderTeamStandings('lb-team-standings', teamLeaderboard);
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
    tr.innerHTML = `
      <td class="rank-cell">${entry.rank}</td>
      <td class="name-cell"><span class="name-with-avatar">${avatarHTML(entry.avatar, 'avatar-sm')}${escapeHtml(entry.nickname)}</span></td>
      <td class="delta-cell ${cls} delta-pop" style="animation-delay:${idx*70+300}ms">${sign}${entry.roundScore}</td>
      <td class="score-cell">${entry.totalScore}</td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('btn-new-round').addEventListener('click', () => {
  socket.emit('host:new_round', { code: state.roomCode }, (res) => {
    if (res?.ok) {
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
  sfx.adjReject();
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
    box.innerHTML = `<div class="duel-box-name">${avatarHTML(p.avatar, 'avatar-sm')} ${escapeHtml(p.nickname)}</div><div class="duel-box-chips chips-area"></div>`;
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
  sfx.roundStart();
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
    // finished → the room-wide game:finished event renders the final screen
  });
});

// ─── Final screen ─────────────────────────────────────────────────────────────

socket.on('game:finished', ({ leaderboard, teamLeaderboard }) => {
  renderFinal(leaderboard);
  renderTeamStandings('final-team-standings', teamLeaderboard);
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
    tr.innerHTML = `
      <td class="rank-cell">${entry.rank}</td>
      <td class="name-cell"><span class="name-with-avatar">${avatarHTML(entry.avatar, 'avatar-sm')}${escapeHtml(entry.nickname)}</span></td>
      <td class="score-cell">${entry.totalScore}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Team standings ───────────────────────────────────────────────────────────

function renderTeamStandings(containerId, teamLeaderboard) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!teamLeaderboard || !teamLeaderboard.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = `<div class="team-standings-title">🏆 ترتيب الفرق</div>` +
    teamLeaderboard.map(t => `
      <div class="team-row" style="border-inline-start-color:${t.color}">
        <span class="team-rank">${t.rank}</span>
        <span class="team-dot" style="background:${t.color}"></span>
        <span class="team-name">${escapeHtml(t.name)}</span>
        <span class="team-members">${t.members} لاعب</span>
        <span class="team-score">${t.totalScore}</span>
      </div>`).join('');
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
  const top3  = leaderboard.slice(0, 3);
  if (!top3.length) return;
  const slots   = [top3[1], top3[0], top3[2]];
  const classes  = ['second','first','third'];
  const medals   = ['🥈','🥇','🥉'];
  const labels   = ['2','1','3'];
  slots.forEach((entry, i) => {
    if (!entry) return;
    const div = document.createElement('div');
    div.className = `podium-item ${classes[i]}`;
    div.innerHTML = `
      <span class="podium-emoji">${medals[i]}</span>
      ${avatarHTML(entry.avatar)}
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
    const el   = document.createElement('div');
    const size = Math.random() * 10 + 5;
    el.style.cssText = [
      `position:fixed`,`width:${size}px`,`height:${size}px`,
      `background:${colors[Math.floor(Math.random()*colors.length)]}`,
      `left:${Math.random()*100}vw`,`top:-12px`,
      `border-radius:${Math.random()>0.5?'50%':'2px'}`,
      `z-index:9999`,`pointer-events:none`,
      `animation:confetti-fall ${Math.random()*2+2.5}s linear forwards`,
      `animation-delay:${Math.random()*2}s`,
    ].join(';');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }
}

// ─── Chat ───────────────────────────────────────────────────────────────────

function toggleChat(open) {
  state.chatOpen = open;
  document.getElementById('chat-drawer').classList.toggle('hidden', !open);
  if (open) {
    state.chatUnread = 0;
    updateChatBadge();
    setTimeout(() => document.getElementById('chat-input').focus(), 50);
    const box = document.getElementById('chat-messages');
    box.scrollTop = box.scrollHeight;
  }
}
function updateChatBadge() {
  const b = document.getElementById('chat-unread');
  if (!b) return;
  b.textContent = state.chatUnread;
  b.classList.toggle('hidden', state.chatUnread === 0);
}
function appendChatMessage(msg) {
  const box = document.getElementById('chat-messages');
  const empty = box.querySelector('.chat-empty');
  if (empty) empty.remove();
  const mine = msg.isHost;
  const div = document.createElement('div');
  div.className = `chat-msg${mine ? ' mine' : ''}${msg.isHost ? ' host-msg' : ''}`;
  div.innerHTML = `
    <div class="chat-msg-head">
      ${avatarHTML(msg.avatar, 'avatar-sm')}
      <span class="chat-msg-name">${escapeHtml(msg.nickname)}</span>
    </div>
    <div class="chat-msg-body">${escapeHtml(msg.text)}</div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function loadChatHistory(messages) {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  box.innerHTML = '';
  if (!messages || !messages.length) {
    box.innerHTML = '<p class="chat-empty">لا توجد رسائل بعد.</p>';
    return;
  }
  messages.forEach(appendChatMessage);
}
function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat:send', { code: state.roomCode, text });
  input.value = '';
  input.focus();
}

document.getElementById('chat-btn').addEventListener('click', () => toggleChat(!state.chatOpen));
document.getElementById('chat-close').addEventListener('click', () => toggleChat(false));
document.getElementById('chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

socket.on('chat:message', (msg) => {
  appendChatMessage(msg);
  if (!state.chatOpen && !msg.isHost) { state.chatUnread += 1; updateChatBadge(); }
});

// ─── Connection ───────────────────────────────────────────────────────────────

socket.on('disconnect', () => setConnectionStatus('reconnecting'));
socket.on('connect_error', () => setConnectionStatus('disconnected'));
socket.on('connect', () => {
  setConnectionStatus('connected');
  if (state.hostKey && state.roomCode) tryRejoinRoom();
});
