const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || 'host123';

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O, 0, I, 1
const ROOM_CODE_LENGTH = 4;
const ROOM_CAP = 20;
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS) || 30;
const HOST_GRACE_MS = 10 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 1000;

// Allowed bounds for host-configurable timers (seconds)
const ROUND_SECONDS_MIN = 10, ROUND_SECONDS_MAX = 120;
const DUEL_SECONDS_MIN = 10,  DUEL_SECONDS_MAX = 60;
const RAPID_ROUND_SECONDS = 15;   // default round length in Rapid-Fire mode

// Chat
const CHAT_MAX_LEN = 240;
const CHAT_HISTORY = 60;        // messages kept per room for reconnects
const CHAT_MIN_INTERVAL_MS = 600;

// Avatars: an emoji string, or a (downscaled) data-URL. Capped to keep payloads sane.
const AVATAR_MAX_LEN = 120 * 1024;

// Teams (2–4). Round-robin assignment; new joiners fill the smallest team.
const TEAM_DEFS = [
  { id: 'red',    name: 'الفريق الأحمر',  color: '#ef4444' },
  { id: 'blue',   name: 'الفريق الأزرق',  color: '#3b82f6' },
  { id: 'green',  name: 'الفريق الأخضر',  color: '#10b981' },
  { id: 'yellow', name: 'الفريق الأصفر',  color: '#f59e0b' },
];

// ─── Gulag (1v1 elimination) tuning ───────────────────────────────────────────
const DUEL_SECONDS = Number(process.env.DUEL_SECONDS) || 20;  // length of a gulag duel
const GULAG_FAST_THRESHOLD = 6;     // > this many active players ⇒ a drop every round
const GULAG_CADENCE_SLOW = 2;       // otherwise, a drop every N main rounds
const DUEL_CATEGORIES = [
  'فواكه','خضار','دول','حيوانات','أكلات','ألوان','مهن','مدن سعودية',
];

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeAvatar(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';
  if (s.length > AVATAR_MAX_LEN) return '';
  // Allow short emoji/text avatars or downscaled image data-URLs only.
  if (s.startsWith('data:image/')) return s;
  return s.slice(0, 8);
}

// ─── Arabic normalization (§8) ────────────────────────────────────────────────
//
// Test assertions — all three raw forms normalize to the same key:
//   «تُفَّاحة»  → strip diacritics → «تفاحة»  → ة→ه → «تفاحه»
//   «التفاحة»  →                     ة→ه → «التفاحه» → strip ال → «تفاحه»
//   «تفاحه »   → trim                                          → «تفاحه»
// All produce key: «تفاحه» ✓

const STRIP_AL = true; // strips leading ال — may over-merge place names; flip false if needed

function normalizeArabic(raw) {
  let s = String(raw);
  s = s.trim().replace(/\s+/g, ' ');                                         // 1 trim/collapse
  s = s.replace(/ـ/g, '');                                              // 2 tatweel ـ
  s = s.replace(/[ؐ-ًؚ-ٰٟ]/g, '');                  // 3 diacritics/tashkeel
  s = s.replace(/[أإآٱ]/g, 'ا');                    // 4 alef variants → ا
  s = s.replace(/ى/g, 'ي');                                         // 5 ى → ي
  s = s.replace(/ة/g, 'ه');                                         // 6 ة → ه
  s = s.replace(/ؤ/g, 'و');                                         // 7a ؤ → و
  s = s.replace(/ئ/g, 'ي');                                         // 7b ئ → ي
  s = s.replace(/ء/g, '');                                               // 7c remove standalone ء
  s = s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)); // 8 Arabic-Indic → Western
  s = s.replace(/[^؀-ۿݐ-ݿA-Za-z0-9 ]/g, '');            // 9 remove punct/emoji
  s = s.toLowerCase();                                                         // 10 lowercase Latin
  if (STRIP_AL) s = s.replace(/^ال/, '');                                    // 11 strip definite article
  return s.trim();
}

// ─── Answer grouping (§7) ─────────────────────────────────────────────────────

function groupAnswers(round) {
  // Per-player dedup: first raw form for each normalized key wins
  const perPlayerDeduped = new Map(); // playerId → [{key, raw}]
  for (const [playerId, answers] of round.answers) {
    const seen = new Map();
    for (const raw of answers) {
      const t = raw.trim();
      if (!t) continue;
      const key = normalizeArabic(t);
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, t);
    }
    perPlayerDeduped.set(playerId, [...seen.entries()].map(([key, raw]) => ({ key, raw })));
  }

  // Cross-player grouping
  const groupMap = new Map();
  for (const [playerId, answers] of perPlayerDeduped) {
    for (const { key, raw } of answers) {
      if (!groupMap.has(key)) groupMap.set(key, { rawCounts: new Map(), playerIds: new Set() });
      const g = groupMap.get(key);
      g.playerIds.add(playerId);
      g.rawCounts.set(raw, (g.rawCounts.get(raw) || 0) + 1);
    }
  }

  const groups = [];
  for (const [key, g] of groupMap) {
    let maxC = 0, displayLabel = key;
    for (const [raw, c] of g.rawCounts) if (c > maxC) { maxC = c; displayLabel = raw; }
    groups.push({ key, displayLabel, playerCount: g.playerIds.size, playerIds: [...g.playerIds] });
  }
  groups.sort((a, b) => b.playerCount - a.playerCount);

  return { groups, perPlayerDeduped };
}

// ─── Scoring (§9) ─────────────────────────────────────────────────────────────

function computeScores(room, adjMap, perPlayerDeduped, groups) {
  // adjMap: Map<key, boolean> — missing key defaults to valid (true)
  const groupInfo = new Map(
    groups.map(g => [g.key, { valid: adjMap.get(g.key) !== false, playerCount: g.playerCount }])
  );

  const roundScores = new Map();
  for (const [playerId, answers] of perPlayerDeduped) {
    let score = 0;
    for (const { key } of answers) {
      const info = groupInfo.get(key);
      if (!info) continue;
      if (!info.valid)                score -= 1;
      else if (info.playerCount === 1) score += 2;
      else                             score += 1;
    }
    roundScores.set(playerId, score);
    room.scores.set(playerId, (room.scores.get(playerId) ?? 0) + score);
  }
  return roundScores;
}

function buildLeaderboard(room, roundScores) {
  return [...room.players.values()]
    .map(p => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatar: p.avatar || '',
      teamId: p.teamId || null,
      roundScore: roundScores?.get(p.playerId) ?? 0,
      totalScore: room.scores.get(p.playerId) ?? 0,
    }))
    .sort((a, b) => b.totalScore - a.totalScore || b.roundScore - a.roundScore)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

// ─── Teams ──────────────────────────────────────────────────────────────────

function teamDef(id) {
  return TEAM_DEFS.find(t => t.id === id) || null;
}

// Pick the team (within the active count) holding the fewest players
function smallestTeam(room) {
  const counts = new Map(room.teamIds.map(id => [id, 0]));
  for (const p of room.players.values()) {
    if (p.teamId && counts.has(p.teamId)) counts.set(p.teamId, counts.get(p.teamId) + 1);
  }
  let best = room.teamIds[0], min = Infinity;
  for (const id of room.teamIds) {
    const c = counts.get(id) ?? 0;
    if (c < min) { min = c; best = id; }
  }
  return best;
}

// Round-robin (re)assign every current player across the active teams
function assignTeams(room) {
  const ids = [...room.players.keys()];
  ids.forEach((pid, i) => {
    const p = room.players.get(pid);
    p.teamId = room.teamIds[i % room.teamIds.length];
  });
}

function buildTeamLeaderboard(room, roundScores) {
  const agg = new Map(room.teamIds.map(id => [id, { roundScore: 0, totalScore: 0, members: 0 }]));
  for (const p of room.players.values()) {
    if (!p.teamId || !agg.has(p.teamId)) continue;
    const a = agg.get(p.teamId);
    a.totalScore += room.scores.get(p.playerId) ?? 0;
    a.roundScore += roundScores?.get(p.playerId) ?? 0;
    a.members += 1;
  }
  return room.teamIds
    .map(id => {
      const d = teamDef(id), a = agg.get(id);
      return { teamId: id, name: d?.name || id, color: d?.color || '#888', ...a };
    })
    .sort((x, y) => y.totalScore - x.totalScore || y.roundScore - x.roundScore)
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

// Final standings for a gulag game: champion first, then knock-outs newest → oldest
function buildGulagFinal(room) {
  const champ = activePlayers(room);
  const order = [
    ...champ.map(p => p.playerId),                 // survivor(s) on top
    ...[...room.eliminationOrder].reverse(),       // last eliminated ranks higher
    ...(room.gulagWaiting ? [room.gulagWaiting] : []),
  ];
  const seen = new Set();
  return order
    .filter(id => !seen.has(id) && seen.add(id) && room.players.has(id))
    .map((id, i) => {
      const p = room.players.get(id);
      return {
        playerId: id,
        nickname: p.nickname,
        avatar: p.avatar || '',
        teamId: p.teamId || null,
        totalScore: room.scores.get(id) ?? 0,
        rank: i + 1,
      };
    });
}

// ─── Express + Socket.IO ──────────────────────────────────────────────────────

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () =>
      ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function playerListPayload(room) {
  return [...room.players.values()].map(p => ({
    playerId: p.playerId,
    nickname: p.nickname,
    avatar: p.avatar || '',
    teamId: p.teamId || null,
    ready: !!p.ready,
    connected: p.connected,
    status: p.status,
    score: room.scores.get(p.playerId) ?? 0,
  }));
}

// Compact public profile for embedding in rosters/leaderboards
function publicProfile(room, playerId) {
  const p = room.players.get(playerId);
  if (!p) return { playerId, nickname: '—', avatar: '', teamId: null };
  return { playerId, nickname: p.nickname, avatar: p.avatar || '', teamId: p.teamId || null };
}

function broadcastPlayerList(room) {
  const sock = room.hostSocketId ? io.sockets.sockets.get(room.hostSocketId) : null;
  if (sock) sock.emit('room:player_list', playerListPayload(room));
}

function emitToRoom(room, event, data) {
  io.to(`room:${room.code}`).emit(event, data);
}

// Public game configuration shared with every client
function roomConfig(room) {
  return {
    mode: room.mode,
    roundSeconds: room.roundSeconds,
    duelSeconds: room.duelSeconds,
    teamCount: room.teamCount,
    teams: room.mode === 'teams'
      ? room.teamIds.map(id => { const d = teamDef(id); return { id, name: d.name, color: d.color }; })
      : [],
  };
}

function emitRoomConfig(room) {
  emitToRoom(room, 'room:config', roomConfig(room));
}

// Team metadata for a single player (or null)
function playerTeam(room, playerId) {
  const p = room.players.get(playerId);
  if (!p?.teamId) return null;
  const d = teamDef(p.teamId);
  return d ? { id: d.id, name: d.name, color: d.color } : null;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

function pushChat(room, msg) {
  room.chat.push(msg);
  if (room.chat.length > CHAT_HISTORY) room.chat.shift();
  emitToRoom(room, 'chat:message', msg);
}

// ─── Gulag helpers ─────────────────────────────────────────────────────────────

function hostSock(room) {
  return room.hostSocketId ? io.sockets.sockets.get(room.hostSocketId) : null;
}

function activePlayers(room) {
  return [...room.players.values()].filter(p => p.status === 'active');
}

function emitToPlayers(room, playerIds, event, data) {
  for (const id of playerIds) {
    const p = room.players.get(id);
    const s = p?.socketId ? io.sockets.sockets.get(p.socketId) : null;
    if (s) s.emit(event, data);
  }
}

// Spectators during a MAIN round = anyone in the gulag or knocked out (+ host)
function emitToSpectators(room, event, data) {
  const ids = [...room.players.values()]
    .filter(p => p.status === 'gulag' || p.status === 'out')
    .map(p => p.playerId);
  emitToPlayers(room, ids, event, data);
  hostSock(room)?.emit(event, data);
}

// Audience of a DUEL = everyone except the two duelers (+ host)
function emitToDuelAudience(room, event, data) {
  const duelers = new Set(room.duel?.players || []);
  const ids = [...room.players.values()]
    .filter(p => !duelers.has(p.playerId))
    .map(p => p.playerId);
  emitToPlayers(room, ids, event, data);
  hostSock(room)?.emit(event, data);
}

// public profile for every active player — used to build spectator boxes
function activeRoster(room) {
  return activePlayers(room).map(p => ({
    playerId: p.playerId, nickname: p.nickname, avatar: p.avatar || '', teamId: p.teamId || null,
  }));
}

function answersToObject(answersMap) {
  const out = {};
  for (const [pid, arr] of answersMap) out[pid] = [...arr];
  return out;
}

// Snapshot a spectator needs to rebuild their live view after a reconnect
function buildSpectateInfo(room) {
  if (room.phase === 'round') {
    return {
      isDuel: false, category: room.round.category, endsAt: room.round.endsAt,
      roundNumber: room.roundNumber, players: activeRoster(room),
      answers: answersToObject(room.round.answers),
    };
  }
  if (room.phase === 'duel') {
    const [a, b] = room.duel.players;
    return {
      isDuel: true, category: room.duel.category, endsAt: room.duel.endsAt,
      players: [publicProfile(room, a), publicProfile(room, b)],
      answers: answersToObject(room.duel.answers),
    };
  }
  return null;
}

// Snapshot for a duelist reconnecting mid-duel
function buildDuelInfo(room, playerId) {
  if (room.phase !== 'duel' || !room.duel.players.includes(playerId)) return null;
  const oppId = room.duel.players.find(id => id !== playerId);
  return {
    category: room.duel.category, endsAt: room.duel.endsAt,
    opponent: room.players.get(oppId)?.nickname,
    myAnswers: [...(room.duel.answers.get(playerId) || [])],
  };
}

// Lowest-ranked active player: fewest total points, then fewest this-round points
function lastPlaceActive(room, roundScores) {
  const active = activePlayers(room);
  if (!active.length) return null;
  return active
    .map(p => ({
      p,
      total: room.scores.get(p.playerId) ?? 0,
      round: roundScores?.get(p.playerId) ?? 0,
    }))
    .sort((a, b) => a.total - b.total || a.round - b.round)[0].p;
}

// Players still in contention (anyone not knocked out)
function inContention(room) {
  return [...room.players.values()].filter(p => p.status !== 'out');
}

// After a scored main round, decide whether to propose sending someone to the gulag
function maybeProposeGulag(room, roundScores) {
  if (room.mode === 'teams') return;             // teams play to a cumulative score, no eliminations
  const active = activePlayers(room);
  if (inContention(room).length <= 1) return;   // a champion already remains
  if (active.length < 1) return;

  // Normally we need ≥2 active to keep the game going. But if only one active
  // player is left while someone waits in the gulag, force the deciding duel.
  const forceFinal = active.length === 1 && room.gulagWaiting !== null;
  if (active.length < 2 && !forceFinal) return;

  room.roundsSinceGulag += 1;
  const cadence = active.length > GULAG_FAST_THRESHOLD ? 1 : GULAG_CADENCE_SLOW;
  if (!forceFinal && room.roundsSinceGulag < cadence) return;

  const target = lastPlaceActive(room, roundScores);
  if (!target) return;
  room.pendingGulag = target.playerId;
  hostSock(room)?.emit('gulag:prompt', {
    playerId: target.playerId,
    nickname: target.nickname,
    willDuel: room.gulagWaiting !== null,   // true ⇒ accepting starts a duel immediately
    waitingNickname: room.gulagWaiting ? room.players.get(room.gulagWaiting)?.nickname : null,
  });
}

// ─── Duel lifecycle ────────────────────────────────────────────────────────────

function startDuel(room, p1Id, p2Id) {
  const p1 = room.players.get(p1Id), p2 = room.players.get(p2Id);
  if (!p1 || !p2) return;
  const category = DUEL_CATEGORIES[Math.floor(Math.random() * DUEL_CATEGORIES.length)];
  const secs = room.duelSeconds || DUEL_SECONDS;
  const endsAt = Date.now() + secs * 1000;
  room.phase = 'duel';
  room.duel = {
    players: [p1Id, p2Id], category, startedAt: Date.now(), endsAt,
    answers: new Map(), scored: false, groupResult: null, result: null,
  };

  emitToPlayers(room, [p1Id], 'duel:started',
    { category, endsAt, opponent: p2.nickname });
  emitToPlayers(room, [p2Id], 'duel:started',
    { category, endsAt, opponent: p1.nickname });
  emitToDuelAudience(room, 'duel:spectate_start', {
    category, endsAt,
    players: [publicProfile(room, p1Id), publicProfile(room, p2Id)],
  });

  room.duel.timer = setTimeout(() => endDuel(room), secs * 1000);
  let remaining = secs;
  room.duel.tickInterval = setInterval(() => {
    remaining -= 1;
    emitToRoom(room, 'duel:tick', { remaining });
    if (remaining <= 0) clearInterval(room.duel.tickInterval);
  }, 1000);
}

function endDuel(room) {
  if (room.phase !== 'duel') return;
  clearInterval(room.duel.tickInterval);
  clearTimeout(room.duel.timer);
  room.phase = 'duel_adjudication';

  const { groups, perPlayerDeduped } = groupAnswers(room.duel);
  room.duel.groupResult = { groups, perPlayerDeduped };

  const [p1Id, p2Id] = room.duel.players;
  hostSock(room)?.emit('duel:ended', {
    groups,
    category: room.duel.category,
    players: [publicProfile(room, p1Id), publicProfile(room, p2Id)],
  });
  emitToRoom(room, 'duel:time_up', {});
}

// Tally a duel from the host's validity decisions and resolve a winner
function resolveDuel(room, adjMap) {
  const { groups, perPlayerDeduped } = room.duel.groupResult;
  const groupInfo = new Map(
    groups.map(g => [g.key, { valid: adjMap.get(g.key) !== false, playerCount: g.playerCount }])
  );
  const tally = new Map(); // playerId → { score, valid }
  for (const [playerId, answers] of perPlayerDeduped) {
    let score = 0, valid = 0;
    for (const { key } of answers) {
      const info = groupInfo.get(key);
      if (!info) continue;
      if (!info.valid)                { score -= 1; }
      else if (info.playerCount === 1) { score += 2; valid += 1; }
      else                             { score += 1; valid += 1; }
    }
    tally.set(playerId, { score, valid });
  }

  const [p1Id, p2Id] = room.duel.players;
  const a = tally.get(p1Id) || { score: 0, valid: 0 };
  const b = tally.get(p2Id) || { score: 0, valid: 0 };
  let winnerId, loserId;
  if (a.score !== b.score)        { winnerId = a.score > b.score ? p1Id : p2Id; }
  else if (a.valid !== b.valid)   { winnerId = a.valid > b.valid ? p1Id : p2Id; }
  else                            { winnerId = Math.random() < 0.5 ? p1Id : p2Id; } // dead tie → coin flip
  loserId = winnerId === p1Id ? p2Id : p1Id;

  return { winnerId, loserId, scores: { [p1Id]: a.score, [p2Id]: b.score } };
}

// ─── Round end ────────────────────────────────────────────────────────────────

function endRound(room) {
  if (room.phase !== 'round') return;
  clearInterval(room.round.tickInterval);
  clearTimeout(room.round.timer);
  room.phase = 'adjudication';

  const { groups, perPlayerDeduped } = groupAnswers(room.round);
  room.round.groupResult = { groups, perPlayerDeduped };

  const hostSock = room.hostSocketId ? io.sockets.sockets.get(room.hostSocketId) : null;
  if (hostSock) {
    hostSock.emit('round:ended', {
      groups,
      category: room.round.category,
      roundNumber: room.roundNumber,
    });
  }

  emitToRoom(room, 'round:time_up', {});
  emitToSpectators(room, 'spectate:round_end', {});
}

// ─── GC: collect stale rooms ──────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.hostLastSeenAt > HOST_GRACE_MS) {
      for (const p of room.players.values()) {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.emit('room:closed');
      }
      if (room.round?.timer) clearTimeout(room.round.timer);
      if (room.round?.tickInterval) clearInterval(room.round.tickInterval);
      rooms.delete(code);
    }
  }
}, GC_INTERVAL_MS);

// ─── Socket events ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  // HOST: validate key
  socket.on('host:authenticate', ({ key }, cb) => {
    cb(key === HOST_KEY ? { ok: true } : { ok: false, error: 'مفتاح خاطئ' });
  });

  // HOST: create room
  socket.on('host:create_room', ({ key }, cb) => {
    if (key !== HOST_KEY) return cb({ ok: false, error: 'غير مصرح' });
    const code = generateRoomCode();
    rooms.set(code, {
      code,
      hostSocketId: socket.id,
      hostLastSeenAt: Date.now(),
      players: new Map(),
      kickedIds: new Set(),
      phase: 'lobby',
      round: null,
      roundNumber: 0,
      scores: new Map(),
      // ── Game config (host-tunable in the lobby) ──
      mode: 'solo',                       // 'solo' | 'teams' | 'rapid'
      roundSeconds: ROUND_SECONDS,
      duelSeconds: DUEL_SECONDS,
      teamCount: 2,
      teamIds: TEAM_DEFS.slice(0, 2).map(t => t.id),
      chat: [],                           // recent chat messages
      // ── Gulag state ──
      gulagWaiting: null,      // playerId currently waiting in the gulag for an opponent
      pendingGulag: null,      // playerId proposed for the gulag, awaiting host decision
      roundsSinceGulag: 0,     // main rounds elapsed since the last drop
      eliminationOrder: [],    // playerIds in the order they were knocked out
      duel: null,              // active duel state, see startDuel()
    });
    socket.join(`room:${code}`);
    socket.data.isHost = true;
    socket.data.hostRoomCode = code;
    cb({ ok: true, code });
  });

  // HOST: configure game (lobby only) — mode, timers, team count
  socket.on('host:configure', ({ code, mode, roundSeconds, duelSeconds, teamCount }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (room.phase !== 'lobby') return cb?.({ ok: false, error: 'لا يمكن التغيير الآن' });

    // Mode/teams may only change before the first round is played.
    if (mode && room.roundNumber === 0 && ['solo', 'teams', 'rapid'].includes(mode)) {
      room.mode = mode;
      if (mode === 'rapid') room.roundSeconds = RAPID_ROUND_SECONDS;
    }
    if (teamCount && room.roundNumber === 0) {
      room.teamCount = clampInt(teamCount, 2, TEAM_DEFS.length, room.teamCount);
      room.teamIds = TEAM_DEFS.slice(0, room.teamCount).map(t => t.id);
    }
    if (roundSeconds !== undefined)
      room.roundSeconds = clampInt(roundSeconds, ROUND_SECONDS_MIN, ROUND_SECONDS_MAX, room.roundSeconds);
    if (duelSeconds !== undefined)
      room.duelSeconds = clampInt(duelSeconds, DUEL_SECONDS_MIN, DUEL_SECONDS_MAX, room.duelSeconds);

    if (room.mode === 'teams') assignTeams(room);
    else for (const p of room.players.values()) p.teamId = null;

    broadcastPlayerList(room);
    emitRoomConfig(room);
    cb?.({ ok: true, config: roomConfig(room) });
  });

  // HOST: reconnect to existing room
  socket.on('host:rejoin_room', ({ key, code }, cb) => {
    if (key !== HOST_KEY) return cb({ ok: false, error: 'غير مصرح' });
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'الغرفة غير موجودة' });
    room.hostSocketId = socket.id;
    room.hostLastSeenAt = Date.now();
    socket.join(`room:${code}`);
    socket.data.isHost = true;
    socket.data.hostRoomCode = code;

    const isGulagGame = room.eliminationOrder.length > 0 || room.gulagWaiting !== null;
    let duelPlayers = null;
    if (room.duel) {
      const [a, b] = room.duel.players;
      duelPlayers = [
        { playerId: a, nickname: room.players.get(a)?.nickname },
        { playerId: b, nickname: room.players.get(b)?.nickname },
      ];
    }
    cb({
      ok: true,
      players: playerListPayload(room),
      config: roomConfig(room),
      chat: room.chat,
      phase: room.phase,
      roundNumber: room.roundNumber,
      adjGroups: room.phase === 'adjudication' ? room.round?.groupResult?.groups : null,
      adjCategory: room.phase === 'adjudication' ? room.round?.category : null,
      leaderboard: ['results', 'finished'].includes(room.phase)
        ? (room.phase === 'finished' && isGulagGame ? buildGulagFinal(room) : buildLeaderboard(room, new Map()))
        : null,
      teamLeaderboard: (room.mode === 'teams' && ['results', 'finished'].includes(room.phase))
        ? buildTeamLeaderboard(room, new Map()) : null,
      // ── Gulag / duel restoration ──
      pendingGulag: room.pendingGulag ? {
        playerId: room.pendingGulag,
        nickname: room.players.get(room.pendingGulag)?.nickname,
        willDuel: room.gulagWaiting !== null,
        waitingNickname: room.gulagWaiting ? room.players.get(room.gulagWaiting)?.nickname : null,
      } : null,
      duelSpectate: room.phase === 'duel'
        ? { category: room.duel.category, endsAt: room.duel.endsAt, players: duelPlayers, answers: answersToObject(room.duel.answers) }
        : null,
      duelGroups: room.phase === 'duel_adjudication'
        ? { groups: room.duel.groupResult?.groups, category: room.duel.category, players: duelPlayers }
        : null,
      duelResult: room.phase === 'duel_result' && room.duel?.result ? {
        winnerId: room.duel.result.winnerId,
        loserId: room.duel.result.loserId,
        winnerNick: room.players.get(room.duel.result.winnerId)?.nickname,
        loserNick: room.players.get(room.duel.result.loserId)?.nickname,
        champion: activePlayers(room).length <= 1,
      } : null,
    });
  });

  // HOST: kick player
  socket.on('host:kick', ({ code, playerId }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;
    const player = room.players.get(playerId);
    if (!player) return;
    room.kickedIds.add(playerId);
    room.players.delete(playerId);
    room.scores.delete(playerId);
    if (room.gulagWaiting === playerId) room.gulagWaiting = null;
    if (room.pendingGulag === playerId) room.pendingGulag = null;
    const s = io.sockets.sockets.get(player.socketId);
    if (s) { s.emit('player:kicked'); s.leave(`room:${code}`); }
    broadcastPlayerList(room);
  });

  // HOST: start a round
  socket.on('host:start_round', ({ code, category }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (room.phase !== 'lobby') return cb?.({ ok: false, error: 'الغرفة ليست في وضع الانتظار' });

    room.roundNumber += 1;
    for (const p of room.players.values()) p.ready = false;   // ready resets each round
    const secs = room.roundSeconds || ROUND_SECONDS;
    const endsAt = Date.now() + secs * 1000;
    room.phase = 'round';
    room.round = { category, startedAt: Date.now(), endsAt, answers: new Map(), scored: false, groupResult: null };

    emitToRoom(room, 'round:started', { category, endsAt, roundNumber: room.roundNumber });
    emitToSpectators(room, 'spectate:round_start',
      { category, endsAt, roundNumber: room.roundNumber, players: activeRoster(room) });

    room.round.timer = setTimeout(() => endRound(room), secs * 1000);
    let remaining = secs;
    room.round.tickInterval = setInterval(() => {
      remaining -= 1;
      emitToRoom(room, 'round:tick', { remaining });
      if (remaining <= 0) clearInterval(room.round.tickInterval);
    }, 1000);

    cb?.({ ok: true, endsAt, roundNumber: room.roundNumber });
  });

  // HOST: score a round (idempotent — double-call is a no-op)
  socket.on('host:score_round', ({ code, decisions }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (room.phase !== 'adjudication') return cb?.({ ok: false, error: 'ليس وقت الاحتساب' });
    if (room.round.scored) return cb?.({ ok: true, alreadyScored: true });

    room.round.scored = true;
    const adjMap = new Map((decisions || []).map(d => [d.key, d.valid]));
    const { groups, perPlayerDeduped } = room.round.groupResult;
    const roundScores = computeScores(room, adjMap, perPlayerDeduped, groups);
    room.phase = 'results';

    const leaderboard = buildLeaderboard(room, roundScores);
    const teamLeaderboard = room.mode === 'teams' ? buildTeamLeaderboard(room, roundScores) : null;
    emitToRoom(room, 'round:results', { leaderboard, teamLeaderboard, roundNumber: room.roundNumber });
    broadcastPlayerList(room);
    maybeProposeGulag(room, roundScores);
    cb?.({ ok: true, leaderboard, teamLeaderboard });
  });

  // HOST: respond to a gulag proposal (accept = send the player down)
  socket.on('host:gulag_decision', ({ code, accept }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    const targetId = room.pendingGulag;
    room.pendingGulag = null;
    room.roundsSinceGulag = 0;
    if (!accept || !targetId) return cb?.({ ok: true, accepted: false });

    const target = room.players.get(targetId);
    if (!target || target.status !== 'active') return cb?.({ ok: true, accepted: false });
    target.status = 'gulag';
    broadcastPlayerList(room);

    if (room.gulagWaiting === null) {
      // First one down — wait for an opponent
      room.gulagWaiting = targetId;
      emitToPlayers(room, [targetId], 'gulag:entered', { waiting: true });
      cb?.({ ok: true, accepted: true, duel: false });
    } else {
      // Someone is already waiting — start the duel
      const opponentId = room.gulagWaiting;
      room.gulagWaiting = null;
      emitToPlayers(room, [targetId], 'gulag:entered', { waiting: false });
      startDuel(room, opponentId, targetId);
      cb?.({ ok: true, accepted: true, duel: true });
    }
  });

  // HOST: score a duel and resolve the winner
  socket.on('host:score_duel', ({ code, decisions }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (room.phase !== 'duel_adjudication') return cb?.({ ok: false, error: 'ليس وقت الاحتساب' });
    if (room.duel.scored) return cb?.({ ok: true, alreadyScored: true });
    room.duel.scored = true;

    const adjMap = new Map((decisions || []).map(d => [d.key, d.valid]));
    const { winnerId, loserId, scores } = resolveDuel(room, adjMap);
    room.duel.result = { winnerId, loserId };

    const winner = room.players.get(winnerId);
    const loser  = room.players.get(loserId);
    if (winner) winner.status = 'active';
    if (loser)  { loser.status = 'out'; room.eliminationOrder.push(loserId); }
    room.phase = 'duel_result';
    broadcastPlayerList(room);

    // Last player standing? Champion → game over.
    const champion = activePlayers(room).length <= 1;
    const payload = {
      winnerId, loserId,
      winnerNick: winner?.nickname, loserNick: loser?.nickname,
      scores, champion,
    };
    emitToRoom(room, 'duel:result', payload);
    cb?.({ ok: true, ...payload });
  });

  // HOST: leave the duel result screen — either crown the champion or resume play
  socket.on('host:resume_lobby', ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (room.phase !== 'duel_result') return cb?.({ ok: false });
    room.duel = null;

    const active = activePlayers(room);
    if (active.length <= 1) {
      room.phase = 'finished';
      const leaderboard = buildGulagFinal(room);
      emitToRoom(room, 'game:finished', { leaderboard });
      return cb?.({ ok: true, finished: true, leaderboard });
    }
    room.phase = 'lobby';
    emitToRoom(room, 'round:reset', {});
    cb?.({ ok: true, finished: false });
  });

  // HOST: reset to lobby for new round
  socket.on('host:new_round', ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (room.phase !== 'results') return cb?.({ ok: false });
    room.phase = 'lobby';
    room.round = null;
    emitToRoom(room, 'round:reset', {});
    cb?.({ ok: true });
  });

  // HOST: end the game
  socket.on('host:end_game', ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    room.phase = 'finished';
    const leaderboard = buildLeaderboard(room, new Map());
    const teamLeaderboard = room.mode === 'teams' ? buildTeamLeaderboard(room, new Map()) : null;
    emitToRoom(room, 'game:finished', { leaderboard, teamLeaderboard });
    cb?.({ ok: true });
  });

  // PLAYER: submit answer during round
  socket.on('player:submit_answer', ({ code, answer }) => {
    const room = rooms.get(code);
    if (!room) return;
    const playerId = socket.data.playerId;
    const player = playerId ? room.players.get(playerId) : null;
    if (!player) return;
    const t = (answer || '').trim();
    if (!t) return;

    if (room.phase === 'round' && player.status === 'active') {
      if (Date.now() > room.round.endsAt) return;                   // late — silently drop
      if (!room.round.answers.has(playerId)) room.round.answers.set(playerId, []);
      room.round.answers.get(playerId).push(t);
      socket.emit('player:answer_received', { answer: t });
      // Live feed to the gulag/knocked-out spectators (never to active rivals)
      emitToSpectators(room, 'spectate:answer', { playerId, nickname: player.nickname, answer: t });
    } else if (room.phase === 'duel' && room.duel.players.includes(playerId)) {
      if (Date.now() > room.duel.endsAt) return;
      if (!room.duel.answers.has(playerId)) room.duel.answers.set(playerId, []);
      room.duel.answers.get(playerId).push(t);
      socket.emit('player:answer_received', { answer: t });
      emitToDuelAudience(room, 'duel:spectate_answer', { playerId, nickname: player.nickname, answer: t });
    }
  });

  // PLAYER: join / reconnect
  socket.on('player:join', ({ code, nickname, playerId, avatar }, cb) => {
    const upperCode = (code || '').toUpperCase();
    const room = rooms.get(upperCode);
    if (!room) return cb({ ok: false, error: 'الغرفة غير موجودة' });

    // Reconnect: existing player
    if (playerId && room.players.has(playerId)) {
      if (room.kickedIds.has(playerId)) return cb({ ok: false, error: 'تمت إزالتك من الغرفة' });
      const player = room.players.get(playerId);
      player.socketId = socket.id;
      player.connected = true;
      socket.join(`room:${upperCode}`);
      socket.data.playerId = playerId;
      socket.data.roomCode = upperCode;
      broadcastPlayerList(room);
      const isDueler = room.phase === 'duel' && room.duel.players.includes(playerId);
      const isSpectator = player.status === 'gulag' || player.status === 'out';
      return cb({
        ok: true,
        playerId,
        nickname: player.nickname,
        avatar: player.avatar || '',
        status: player.status,
        ready: !!player.ready,
        config: roomConfig(room),
        team: playerTeam(room, playerId),
        chat: room.chat,
        phase: room.phase,
        roundInfo: (room.phase === 'round' && player.status === 'active') ? {
          category: room.round.category,
          endsAt: room.round.endsAt,
          roundNumber: room.roundNumber,
          myAnswers: room.round.answers.get(playerId) || [],
        } : null,
        duelInfo: isDueler ? buildDuelInfo(room, playerId) : null,
        spectateInfo: (isSpectator && (room.phase === 'round' || room.phase === 'duel'))
          ? buildSpectateInfo(room) : null,
        leaderboard: ['results', 'finished'].includes(room.phase)
          ? (room.phase === 'finished' && (room.eliminationOrder.length > 0 || room.gulagWaiting !== null)
              ? buildGulagFinal(room) : buildLeaderboard(room, new Map()))
          : null,
        roundNumber: room.roundNumber,
      });
    }

    if (playerId && room.kickedIds.has(playerId)) return cb({ ok: false, error: 'تمت إزالتك من الغرفة' });
    if (room.players.size >= ROOM_CAP) return cb({ ok: false, error: 'الغرفة ممتلئة' });

    let nick = (nickname || '').trim().slice(0, 20);
    if (!nick) return cb({ ok: false, error: 'الاسم مطلوب' });

    const existingNicks = new Set([...room.players.values()].map(p => p.nickname));
    if (existingNicks.has(nick)) {
      let i = 2;
      while (existingNicks.has(`${nick}${i}`)) i++;
      nick = `${nick}${i}`;
    }

    const newId = randomUUID();
    const player = {
      playerId: newId, nickname: nick, avatar: sanitizeAvatar(avatar),
      socketId: socket.id, connected: true, status: 'active', ready: false, teamId: null,
    };
    room.players.set(newId, player);
    room.scores.set(newId, 0);
    if (room.mode === 'teams') player.teamId = smallestTeam(room);
    socket.join(`room:${upperCode}`);
    socket.data.playerId = newId;
    socket.data.roomCode = upperCode;
    broadcastPlayerList(room);

    cb({
      ok: true, playerId: newId, nickname: nick, avatar: player.avatar, status: 'active',
      ready: false, config: roomConfig(room), team: playerTeam(room, newId), chat: room.chat,
      phase: room.phase, roundInfo: null, leaderboard: null,
    });
  });

  // PLAYER: toggle ready (lobby only)
  socket.on('player:set_ready', ({ code, ready }, cb) => {
    const room = rooms.get(code);
    const playerId = socket.data.playerId;
    const player = room?.players.get(playerId);
    if (!room || !player) return cb?.({ ok: false });
    player.ready = !!ready;
    broadcastPlayerList(room);
    cb?.({ ok: true, ready: player.ready });
  });

  // PLAYER: update name / avatar (allowed any time, even after joining)
  socket.on('player:update_profile', ({ code, nickname, avatar }, cb) => {
    const room = rooms.get(code);
    const playerId = socket.data.playerId;
    const player = room?.players.get(playerId);
    if (!room || !player) return cb?.({ ok: false });

    if (typeof nickname === 'string') {
      let nick = nickname.trim().slice(0, 20);
      if (nick && nick !== player.nickname) {
        const taken = new Set([...room.players.values()].filter(p => p.playerId !== playerId).map(p => p.nickname));
        if (taken.has(nick)) { let i = 2; while (taken.has(`${nick}${i}`)) i++; nick = `${nick}${i}`; }
        player.nickname = nick;
      }
    }
    if (avatar !== undefined) player.avatar = sanitizeAvatar(avatar);

    broadcastPlayerList(room);
    emitToRoom(room, 'player:profile_updated',
      { playerId, nickname: player.nickname, avatar: player.avatar || '' });
    cb?.({ ok: true, nickname: player.nickname, avatar: player.avatar || '' });
  });

  // CHAT: a message from a player or the host
  socket.on('chat:send', ({ code, text }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false });
    const isHost = room.hostSocketId === socket.id;
    const player = !isHost ? room.players.get(socket.data.playerId) : null;
    if (!isHost && !player) return cb?.({ ok: false });

    const now = Date.now();
    const last = socket.data.lastChatAt || 0;
    if (now - last < CHAT_MIN_INTERVAL_MS) return cb?.({ ok: false, error: 'مهلاً' });
    socket.data.lastChatAt = now;

    const body = String(text || '').trim().slice(0, CHAT_MAX_LEN);
    if (!body) return cb?.({ ok: false });

    pushChat(room, {
      id: randomUUID(),
      playerId: isHost ? 'host' : player.playerId,
      nickname: isHost ? 'المضيف' : player.nickname,
      avatar: isHost ? '🎙️' : (player.avatar || ''),
      isHost,
      teamId: isHost ? null : (player.teamId || null),
      text: body,
      ts: now,
    });
    cb?.({ ok: true });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const { playerId, roomCode, hostRoomCode } = socket.data;
    if (hostRoomCode) {
      const room = rooms.get(hostRoomCode);
      if (room?.hostSocketId === socket.id) room.hostLastSeenAt = Date.now();
    }
    if (playerId && roomCode) {
      const room = rooms.get(roomCode);
      if (room?.players.has(playerId)) {
        const p = room.players.get(playerId);
        p.connected = false;
        p.socketId = null;
        broadcastPlayerList(room);
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Host:   http://localhost:${PORT}/host  (key: ${HOST_KEY})`);
});
