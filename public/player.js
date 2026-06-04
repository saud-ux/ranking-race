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

// Resume on first interaction (required by mobile browsers)
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

// Swooping tone (freq ramp)
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
  submit()    { beep(900, 0.10, 'sine', 0.18); },
  tick()      { beep(560, 0.07, 'square', 0.10); },
  urgentTick(){ beep(880, 0.07, 'square', 0.14); },
  timeUp()    { sweep(480, 90, 0.75, 'sawtooth', 0.28); },
  roundStart(){ seq([{f:400,d:0.09,at:0},{f:600,d:0.09,at:80},{f:900,d:0.15,at:160}]); },
  goodScore() { seq([{f:523,d:0.12,at:0},{f:659,d:0.12,at:110},{f:784,d:0.22,at:220}]); },
  badScore()  { sweep(250, 120, 0.35, 'square', 0.18); },
  fanfare()   {
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
  avatar: localStorage.getItem('avatar') || '',
  team: null,                // { id, name, color } | null
  config: { mode: 'solo', roundSeconds: 30, duelSeconds: 20, teams: [] },
  phase: 'lobby',
  status: 'active',          // 'active' | 'gulag' | 'out'
  roundEndsAt: null,
  tickInterval: null,
  myAnswers: [],
  lastTickSec: -1,
  specTickInterval: null,    // countdown timer for the spectator view
  specBoxes: {},             // playerId → chips container element
  ready: false,
  chatOpen: false,
  chatUnread: 0,
  lastSpecPlayers: [],       // roster of the current spectator view
};

// ─── Avatars ──────────────────────────────────────────────────────────────────

const AVATAR_EMOJIS = ['🙂','😎','🤩','😺','🦊','🐼','🦁','🐧','🐸','🐯','🦄','👑','⚽','🎮','🍕','🌟','🔥','🚀','🎩','🐙'];

// Build the HTML for an avatar chip (image data-URL or emoji/text fallback)
function avatarHTML(avatar, extraClass = '') {
  const cls = `avatar-chip ${extraClass}`.trim();
  if (avatar && avatar.startsWith('data:image/'))
    return `<span class="${cls}"><img src="${escapeHtml(avatar)}" alt=""></span>`;
  return `<span class="${cls}">${escapeHtml(avatar || '🙂')}</span>`;
}

// Inner markup of an avatar (image or emoji) — for filling an existing chip element
function avatarInner(avatar) {
  if (avatar && avatar.startsWith('data:image/'))
    return `<img src="${escapeHtml(avatar)}" alt="">`;
  return escapeHtml(avatar || '🙂');
}

// Downscale an uploaded image to a small square JPEG data-URL
function downscaleImage(file, cb) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const S = 96;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = S;
      const ctx = canvas.getContext('2d');
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, S, S);
      cb(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => cb(null);
    img.src = reader.result;
  };
  reader.onerror = () => cb(null);
  reader.readAsDataURL(file);
}

// Wire an avatar picker: emoji grid + upload, syncing into a preview element
function setupAvatarPicker(optionsId, previewId, fileId, get, set) {
  const options = document.getElementById(optionsId);
  const preview = document.getElementById(previewId);
  function refresh() {
    const cur = get();
    if (cur && cur.startsWith('data:image/')) preview.innerHTML = `<img src="${escapeHtml(cur)}" alt="">`;
    else preview.textContent = cur || '🙂';
    options.querySelectorAll('.avatar-opt').forEach(b =>
      b.classList.toggle('selected', b.dataset.emoji === cur));
  }
  options.innerHTML = '';
  AVATAR_EMOJIS.forEach(em => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'avatar-opt'; b.dataset.emoji = em; b.textContent = em;
    b.addEventListener('click', () => { set(em); refresh(); });
    options.appendChild(b);
  });
  document.getElementById(fileId).addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    downscaleImage(file, dataUrl => { if (dataUrl) { set(dataUrl); refresh(); } });
    e.target.value = '';
  });
  refresh();
  return refresh;
}

// Small team badge HTML
function teamBadgeHTML(team) {
  if (!team) return '';
  return `<span class="team-badge" style="background:${team.color}">${escapeHtml(team.name)}</span>`;
}

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

// Idle screen for a non-active player (between rounds), based on their status
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
  socket.emit('player:join', { code, nickname, playerId, avatar: state.avatar }, (res) => {
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
    state.status = res.status || 'active';
    state.avatar = res.avatar || state.avatar || '';
    state.team = res.team || null;
    state.ready = !!res.ready;
    if (res.config) state.config = res.config;
    localStorage.setItem('playerId', res.playerId);
    localStorage.setItem('roomCode', state.roomCode);
    localStorage.setItem('nickname', res.nickname);
    localStorage.setItem('avatar', state.avatar);

    updateTopBar();
    if (res.chat) loadChatHistory(res.chat);
    showScreen('lobby');

    if (res.duelInfo) {
      enterDuel(res.duelInfo.category, res.duelInfo.endsAt, res.duelInfo.opponent, res.duelInfo.myAnswers || []);
    } else if (res.spectateInfo) {
      enterSpectate(res.spectateInfo);
    } else if (res.phase === 'round' && res.roundInfo) {
      enterRound(res.roundInfo.category, res.roundInfo.endsAt, res.roundInfo.myAnswers || []);
    } else if (res.phase === 'finished' && res.leaderboard) {
      lastFinalLeaderboard = res.leaderboard;
      lastFinalTeams = res.teamLeaderboard || null;
      renderFinal(res.leaderboard);
      renderTeamStandings('final-team-standings', res.teamLeaderboard);
      showGameState('final');
    } else if (state.status !== 'active') {
      showSpectatorIdle();
    } else if (res.phase === 'adjudication') {
      showGameState('ended');
    } else if (res.phase === 'results' && res.leaderboard) {
      renderLeaderboard(res.leaderboard, res.roundNumber);
      renderTeamStandings('results-team-standings', res.teamLeaderboard);
      showGameState('results');
    } else {
      updateWaitingUI();
      showGameState('waiting');
    }
  });
}

// ─── Top bar / waiting UI ───────────────────────────────────────────────────

function updateTopBar() {
  document.getElementById('display-nickname').textContent = state.nickname || '';
  document.getElementById('display-avatar').innerHTML = avatarInner(state.avatar);
  const teamEl = document.getElementById('display-team');
  if (state.team) {
    teamEl.textContent = state.team.name;
    teamEl.style.background = state.team.color;
    teamEl.classList.remove('hidden');
  } else {
    teamEl.classList.add('hidden');
  }
}

function modeLabel(mode) {
  return mode === 'teams' ? '👥 وضع الفرق' : mode === 'rapid' ? '⚡ نار سريعة' : '🏁 فردي';
}

function updateWaitingUI() {
  const badge = document.getElementById('mode-badge');
  if (badge) {
    badge.textContent = modeLabel(state.config?.mode);
    badge.classList.remove('hidden');
  }
  refreshReadyButton();
}

function refreshReadyButton() {
  const btn = document.getElementById('btn-ready');
  if (!btn) return;
  btn.textContent = state.ready ? 'جاهز ✅ (اضغط للإلغاء)' : 'أنا جاهز ✅';
  btn.classList.toggle('is-ready', state.ready);
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

// ─── Avatar pickers (join + profile) ──────────────────────────────────────────

let joinAvatar = state.avatar || '🙂';
setupAvatarPicker('join-avatar-options', 'join-avatar-preview', 'join-avatar-file',
  () => joinAvatar, v => { joinAvatar = v; });

let profileAvatarDraft = '';
const refreshProfilePicker = setupAvatarPicker('profile-avatar-options', 'profile-avatar-preview',
  'profile-avatar-file', () => profileAvatarDraft, v => { profileAvatarDraft = v; });

// ─── Profile edit modal ───────────────────────────────────────────────────────

function openProfileModal() {
  profileAvatarDraft = state.avatar || '🙂';
  document.getElementById('profile-name').value = state.nickname || '';
  refreshProfilePicker();
  document.getElementById('profile-modal').classList.remove('hidden');
}
function closeProfileModal() { document.getElementById('profile-modal').classList.add('hidden'); }

document.getElementById('btn-edit-profile').addEventListener('click', openProfileModal);
document.getElementById('btn-profile-cancel').addEventListener('click', closeProfileModal);
document.getElementById('btn-profile-save').addEventListener('click', () => {
  const nickname = document.getElementById('profile-name').value.trim();
  socket.emit('player:update_profile',
    { code: state.roomCode, nickname, avatar: profileAvatarDraft }, (res) => {
      if (res?.ok) {
        state.nickname = res.nickname;
        state.avatar = res.avatar;
        localStorage.setItem('nickname', state.nickname);
        localStorage.setItem('avatar', state.avatar);
        updateTopBar();
        closeProfileModal();
      }
    });
});

// ─── Ready toggle ─────────────────────────────────────────────────────────────

document.getElementById('btn-ready').addEventListener('click', () => {
  state.ready = !state.ready;
  refreshReadyButton();
  socket.emit('player:set_ready', { code: state.roomCode, ready: state.ready });
});

// ─── Config / profile-update events ───────────────────────────────────────────

socket.on('room:config', (config) => {
  state.config = config;
  if (config.mode === 'teams' && config.teams?.length) {
    // keep our team label fresh if it appears in the config (name/color may change)
    if (state.team) {
      const t = config.teams.find(x => x.id === state.team.id);
      if (t) state.team = t;
    }
  } else {
    state.team = null;
  }
  updateTopBar();
  if (state.phase === 'lobby' || document.getElementById('state-waiting'))
    updateWaitingUI();
});

socket.on('player:profile_updated', ({ playerId, nickname, avatar }) => {
  // Update any spectator box belonging to this player
  const box = state.specBoxes[playerId];
  if (box) {
    const nameEl = box.parentElement?.querySelector('.spec-box-name');
    if (nameEl) nameEl.innerHTML = `${avatarHTML(avatar, 'avatar-sm')} ${escapeHtml(nickname)}`;
  }
  if (playerId === state.playerId) {
    state.nickname = nickname; state.avatar = avatar; updateTopBar();
  }
});

// ─── Chat ───────────────────────────────────────────────────────────────────

function toggleChat(open) {
  state.chatOpen = open;
  document.getElementById('chat-drawer').classList.toggle('hidden', !open);
  if (open) {
    state.chatUnread = 0;
    updateChatBadge();
    const input = document.getElementById('chat-input');
    setTimeout(() => input.focus(), 50);
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
  const mine = msg.playerId === state.playerId;
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
  box.innerHTML = '';
  if (!messages || !messages.length) {
    box.innerHTML = '<p class="chat-empty">لا توجد رسائل بعد — كن أول من يكتب! 👋</p>';
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
  if (!state.chatOpen && msg.playerId !== state.playerId) {
    state.chatUnread += 1;
    updateChatBadge();
  }
});

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

// ─── Share results ────────────────────────────────────────────────────────────

let lastFinalLeaderboard = [];
let lastFinalTeams = null;

async function shareResults() {
  const lines = ['🏁 نتائج سباق التصنيف'];
  if (lastFinalTeams?.length) {
    lines.push('', '👥 الفرق:');
    lastFinalTeams.forEach(t => lines.push(`${t.rank}. ${t.name} — ${t.totalScore}`));
  }
  lines.push('', '🏆 اللاعبون:');
  lastFinalLeaderboard.slice(0, 10).forEach(e => {
    const medal = e.rank === 1 ? '🥇' : e.rank === 2 ? '🥈' : e.rank === 3 ? '🥉' : `${e.rank}.`;
    lines.push(`${medal} ${e.nickname} — ${e.totalScore}`);
  });
  const text = lines.join('\n');
  try {
    if (navigator.share) { await navigator.share({ title: 'سباق التصنيف', text }); return; }
    await navigator.clipboard.writeText(text);
    flashShareButton('نُسخت النتائج ✅');
  } catch {
    flashShareButton('تعذّرت المشاركة');
  }
}
function flashShareButton(msg) {
  const btn = document.getElementById('btn-share');
  const orig = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = orig; }, 1800);
}
document.getElementById('btn-share').addEventListener('click', shareResults);

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
  state.avatar = joinAvatar;
  getCtx(); // unlock audio on first interaction
  attemptJoin(code, nickname, null);
}

// ─── Round: enter ─────────────────────────────────────────────────────────────

function enterRound(category, endsAt, existingAnswers) {
  state.phase = 'round';
  state.roundEndsAt = endsAt;
  state.myAnswers = [...existingAnswers];
  state.lastTickSec = -1;

  document.getElementById('category-display').textContent = category;
  document.getElementById('answer-input').value = '';
  document.getElementById('answer-input').disabled = false;
  document.getElementById('btn-submit-answer').disabled = false;

  const area = document.getElementById('chips-area');
  area.innerHTML = '';
  state.myAnswers.forEach(a => addChip(a, false));

  showGameState('round');

  // Flash the round card green briefly
  const roundCard = document.querySelector('#state-round .card');
  if (roundCard) {
    roundCard.classList.remove('round-start-flash');
    void roundCard.offsetWidth; // reflow to restart animation
    roundCard.classList.add('round-start-flash');
  }

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
    const urgent = rem <= 10 && rem > 0;
    el.classList.toggle('urgent', urgent || rem === 0);

    // Play a tick sound once per second during last 10s
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
document.getElementById('answer-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitAnswer(); });

function submitAnswer() {
  const input = document.getElementById('answer-input');
  const answer = input.value.trim();
  if (!answer || state.phase !== 'round') return;
  socket.emit('player:submit_answer', { code: state.roomCode, answer });
  input.value = '';
  input.focus();
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
  if (state.status !== 'active') return;   // spectators get spectate:round_start instead
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
  state.ready = false;
  clearInterval(state.tickInterval);
  clearInterval(state.specTickInterval);
  if (state.status !== 'active') showSpectatorIdle();
  else { updateWaitingUI(); showGameState('waiting'); }
});

// ─── Gulag & duel (player) ──────────────────────────────────────────────────

socket.on('gulag:entered', () => {
  state.status = 'gulag';
  clearInterval(state.tickInterval);
  sfx.badScore();
  showGameState('gulagWait');   // a duel:started, if any, overrides immediately
});

function enterDuel(category, endsAt, opponent, existingAnswers) {
  state.phase = 'duel';
  state.roundEndsAt = endsAt;
  state.lastTickSec = -1;
  document.getElementById('duel-opponent').textContent = opponent || '—';
  document.getElementById('duel-category').textContent = category;
  const input = document.getElementById('duel-input');
  input.value = ''; input.disabled = false;
  document.getElementById('btn-duel-submit').disabled = false;
  const chips = document.getElementById('duel-chips');
  chips.innerHTML = '';
  (existingAnswers || []).forEach(a => prependChip(chips, a, false));
  showGameState('duel');
  startDuelCountdown(endsAt);
  input.focus();
}

socket.on('duel:started', ({ category, endsAt, opponent }) => {
  state.status = 'gulag';
  sfx.roundStart();
  enterDuel(category, endsAt, opponent, []);
});

function startDuelCountdown(endsAt) {
  clearInterval(state.tickInterval);
  const el = document.getElementById('duel-countdown');
  function tick() {
    const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.textContent = rem;
    el.classList.toggle('urgent', rem <= 10);
    if (rem <= 0) clearInterval(state.tickInterval);
  }
  tick();
  state.tickInterval = setInterval(tick, 250);
}

document.getElementById('btn-duel-submit').addEventListener('click', submitDuelAnswer);
document.getElementById('duel-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitDuelAnswer(); });

function submitDuelAnswer() {
  const input = document.getElementById('duel-input');
  const answer = input.value.trim();
  if (!answer || state.phase !== 'duel') return;
  socket.emit('player:submit_answer', { code: state.roomCode, answer });
  input.value = '';
  input.focus();
}

socket.on('duel:tick', ({ remaining }) => {
  const id = state.phase === 'duel' ? 'duel-countdown'
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
    msg.textContent = 'نجوت!'; msg.style.color = 'var(--success)';
    document.getElementById('duel-result-sub').textContent = 'ترجع للمنافسة — استعدّ للجولة القادمة.';
    showGameState('duelResult');
    sfx.goodScore();
  } else if (loserId === state.playerId) {
    state.status = 'out';
    document.getElementById('duel-result-emoji').textContent = '💀';
    const msg = document.getElementById('duel-result-msg');
    msg.textContent = 'خرجت من اللعبة'; msg.style.color = 'var(--danger)';
    document.getElementById('duel-result-sub').textContent = 'بتتفرّج على الباقين لين تنتهي اللعبة 👀';
    showGameState('duelResult');
    sfx.badScore();
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
  state.lastSpecPlayers = players;
  players.forEach(p => {
    const box = document.createElement('div');
    box.className = 'spec-box';
    box.innerHTML = `<div class="spec-box-name">${avatarHTML(p.avatar, 'avatar-sm')} ${escapeHtml(p.nickname)}</div><div class="spec-chips"></div>`;
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

socket.on('round:results', ({ leaderboard, teamLeaderboard, roundNumber }) => {
  state.phase = 'results';
  renderLeaderboard(leaderboard, roundNumber);
  renderTeamStandings('results-team-standings', teamLeaderboard);
  showGameState('results');

  // Play score sound based on own delta
  const mine = leaderboard.find(e => e.playerId === state.playerId);
  if (mine) {
    setTimeout(() => {
      if (mine.roundScore > 0) sfx.goodScore();
      else if (mine.roundScore < 0) sfx.badScore();
    }, 500);
  }
});

function renderLeaderboard(leaderboard, roundNumber) {
  document.getElementById('results-round-num').textContent = roundNumber;
  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = '';

  leaderboard.forEach((entry, idx) => {
    const tr = document.createElement('tr');
    const isMe = entry.playerId === state.playerId;
    if (isMe)       tr.className = 'my-row lb-row-enter';
    else if (idx===0) tr.className = 'rank-1-row lb-row-enter';
    else              tr.className = 'lb-row-enter';
    tr.style.setProperty('--row-delay', `${idx * 70}ms`);

    const sign = entry.roundScore > 0 ? '+' : '';
    const cls  = entry.roundScore > 0 ? 'delta-pos' : entry.roundScore < 0 ? 'delta-neg' : 'delta-zero';
    tr.innerHTML = `
      <td class="rank-cell">${entry.rank}</td>
      <td class="name-cell"><span class="name-with-avatar">${avatarHTML(entry.avatar, 'avatar-sm')}${escapeHtml(entry.nickname)}${isMe ? ' <span style="color:var(--accent);font-size:0.75rem;">(أنت)</span>' : ''}</span></td>
      <td class="delta-cell ${cls} delta-pop" style="animation-delay:${idx*70+300}ms">${sign}${entry.roundScore}</td>
      <td class="score-cell">${entry.totalScore}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Final screen ─────────────────────────────────────────────────────────────

socket.on('game:finished', ({ leaderboard, teamLeaderboard }) => {
  state.phase = 'finished';
  lastFinalLeaderboard = leaderboard || [];
  lastFinalTeams = teamLeaderboard || null;
  renderFinal(leaderboard);
  renderTeamStandings('final-team-standings', teamLeaderboard);
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
    const tr = document.createElement('tr');
    tr.className = [
      isMe ? 'my-row' : '',
      idx === 0 ? 'rank-1-row' : '',
      'lb-row-enter',
    ].filter(Boolean).join(' ');
    tr.style.setProperty('--row-delay', `${idx * 60}ms`);
    tr.innerHTML = `
      <td class="rank-cell">${entry.rank}</td>
      <td class="name-cell"><span class="name-with-avatar">${avatarHTML(entry.avatar, 'avatar-sm')}${escapeHtml(entry.nickname)}${isMe ? ' <span style="color:var(--accent);font-size:0.75rem;">(أنت)</span>' : ''}</span></td>
      <td class="score-cell">${entry.totalScore}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Podium ───────────────────────────────────────────────────────────────────

function renderPodium(containerId, leaderboard) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = '';
  const top3 = leaderboard.slice(0, 3);
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
    el.style.cssText = [
      `position:fixed`,`width:${size}px`,`height:${size}px`,
      `background:${colors[Math.floor(Math.random()*colors.length)]}`,
      `left:${Math.random()*100}vw`,`top:-12px`,
      `border-radius:${Math.random()>0.5?'50%':'2px'}`,
      `z-index:9999`,`pointer-events:none`,
      `animation:confetti-fall ${Math.random()*2+2.5}s linear forwards`,
      `animation-delay:${Math.random()*1.5}s`,
    ].join(';');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5500);
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
