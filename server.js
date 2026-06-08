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

// ─── Gulag (1v1 elimination) tuning ───────────────────────────────────────────
const DUEL_SECONDS = Number(process.env.DUEL_SECONDS) || 20;  // length of a gulag duel
const GULAG_FAST_THRESHOLD = 6;     // > this many active players ⇒ a drop every round
const GULAG_CADENCE_SLOW = 2;       // otherwise, a drop every N main rounds
const DUEL_CATEGORIES = [
  'فواكه','خضار','دول','حيوانات','أكلات','ألوان','مهن','مدن سعودية',
];

// ─── Arabic normalization (§8) ────────────────────────────────────────────────

const STRIP_AL = true; // strips leading ال — may over-merge place names; flip false if needed

function normalizeArabic(raw) {
  let s = String(raw);
  s = s.trim().replace(/\s+/g, ' ');
  s = s.replace(/ـ/g, '');
  s = s.replace(/[ؐ-ًؚ-ٰٟ]/g, '');
  s = s.replace(/[أإآٱ]/g, 'ا');
  s = s.replace(/ى/g, 'ي');
  s = s.replace(/ة/g, 'ه');
  s = s.replace(/ؤ/g, 'و');
  s = s.replace(/ئ/g, 'ي');
  s = s.replace(/ء/g, '');
  s = s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(/[^؀-ۿݐ-ݿA-Za-z0-9 ]/g, '');
  s = s.toLowerCase();
  if (STRIP_AL) s = s.replace(/^ال/, '');
  return s.trim();
}

// ─── Answer grouping (§7) ─────────────────────────────────────────────────────

function groupAnswers(round) {
  const perPlayerDeduped = new Map();
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

// Attach player nicknames to grouped answers so the host knows who submitted what.
function attachNicks(room, groups) {
  if (!groups) return [];
  return groups.map(g => ({
    ...g,
    playerNicks: (g.playerIds || [])
      .map(id => room.players.get(id)?.nickname)
      .filter(Boolean),
  }));
}

// ─── Scoring (§9) ─────────────────────────────────────────────────────────────

function computeScores(room, adjMap, perPlayerDeduped, groups) {
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
      roundScore: roundScores?.get(p.playerId) ?? 0,
      totalScore: room.scores.get(p.playerId) ?? 0,
    }))
    .sort((a, b) => b.totalScore - a.totalScore || b.roundScore - a.roundScore)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

function buildGulagFinal(room) {
  const champ = activePlayers(room);
  const order = [
    ...champ.map(p => p.playerId),
    ...[...room.eliminationOrder].reverse(),
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
    connected: p.connected,
    status: p.status,
    score: room.scores.get(p.playerId) ?? 0,
  }));
}

function broadcastPlayerList(room) {
  const sock = room.hostSocketId ? io.sockets.sockets.get(room.hostSocketId) : null;
  if (sock) sock.emit('room:player_list', playerListPayload(room));
}

function emitToRoom(room, event, data) {
  io.to(`room:${room.code}`).emit(event, data);
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

function emitToSpectators(room, event, data) {
  const ids = [...room.players.values()]
    .filter(p => p.status === 'gulag' || p.status === 'out')
    .map(p => p.playerId);
  emitToPlayers(room, ids, event, data);
  hostSock(room)?.emit(event, data);
}

function emitToDuelAudience(room, event, data) {
  const duelers = new Set(room.duel?.players || []);
  const ids = [...room.players.values()]
    .filter(p => !duelers.has(p.playerId))
    .map(p => p.playerId);
  emitToPlayers(room, ids, event, data);
  hostSock(room)?.emit(event, data);
}

function activeRoster(room) {
  return activePlayers(room).map(p => ({ playerId: p.playerId, nickname: p.nickname }));
}

function answersToObject(answersMap) {
  const out = {};
  for (const [pid, arr] of answersMap) out[pid] = [...arr];
  return out;
}

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
      players: [
        { playerId: a, nickname: room.players.get(a)?.nickname },
        { playerId: b, nickname: room.players.get(b)?.nickname },
      ],
      answers: answersToObject(room.duel.answers),
    };
  }
  return null;
}

function buildDuelInfo(room, playerId) {
  if (room.phase !== 'duel' || !room.duel.players.includes(playerId)) return null;
  const oppId = room.duel.players.find(id => id !== playerId);
  return {
    category: room.duel.category, endsAt: room.duel.endsAt,
    opponent: room.players.get(oppId)?.nickname,
    myAnswers: [...(room.duel.answers.get(playerId) || [])],
  };
}

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

function inContention(room) {
  return [...room.players.values()].filter(p => p.status !== 'out');
}

function maybeProposeGulag(room, roundScores) {
  const active = activePlayers(room);
  if (inContention(room).length <= 1) return;
  if (active.length < 1) return;

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
    willDuel: room.gulagWaiting !== null,
    waitingNickname: room.gulagWaiting ? room.players.get(room.gulagWaiting)?.nickname : null,
  });
}

// ─── Duel lifecycle ────────────────────────────────────────────────────────────

function startDuel(room, p1Id, p2Id) {
  const p1 = room.players.get(p1Id), p2 = room.players.get(p2Id);
  if (!p1 || !p2) return;
  const category = DUEL_CATEGORIES[Math.floor(Math.random() * DUEL_CATEGORIES.length)];
  const endsAt = Date.now() + DUEL_SECONDS * 1000;
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
    players: [{ playerId: p1Id, nickname: p1.nickname }, { playerId: p2Id, nickname: p2.nickname }],
  });

  room.duel.timer = setTimeout(() => endDuel(room), DUEL_SECONDS * 1000);
  let remaining = DUEL_SECONDS;
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
    groups: attachNicks(room, groups),
    category: room.duel.category,
    players: [
      { playerId: p1Id, nickname: room.players.get(p1Id)?.nickname },
      { playerId: p2Id, nickname: room.players.get(p2Id)?.nickname },
    ],
  });
  emitToRoom(room, 'duel:time_up', {});
}

function resolveDuel(room, adjMap) {
  const { groups, perPlayerDeduped } = room.duel.groupResult;
  const groupInfo = new Map(
    groups.map(g => [g.key, { valid: adjMap.get(g.key) !== false, playerCount: g.playerCount }])
  );
  const tally = new Map();
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
  else                            { winnerId = Math.random() < 0.5 ? p1Id : p2Id; }
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

  const hSock = room.hostSocketId ? io.sockets.sockets.get(room.hostSocketId) : null;
  if (hSock) {
    hSock.emit('round:ended', {
      groups: attachNicks(room, groups),
      category: room.round.category,
      roundNumber: room.roundNumber,
    });
  }

  emitToRoom(room, 'round:time_up', {});
  emitToSpectators(room, 'spectate:round_end', {});
}

// ─── GC ──────────────────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const hostAlive = room.hostSocketId && io.sockets.sockets.get(room.hostSocketId);
    if (hostAlive) { room.hostLastSeenAt = now; continue; }
    if (now - room.hostLastSeenAt > HOST_GRACE_MS) {
      for (const p of room.players.values()) {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.emit('room:closed');
      }
      if (room.round?.timer)        clearTimeout(room.round.timer);
      if (room.round?.tickInterval) clearInterval(room.round.tickInterval);
      if (room.duel?.timer)         clearTimeout(room.duel.timer);
      if (room.duel?.tickInterval)  clearInterval(room.duel.tickInterval);
      rooms.delete(code);
    }
  }
}, GC_INTERVAL_MS);

// ─── Socket events ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('host:authenticate', ({ key }, cb) => {
    cb(key === HOST_KEY ? { ok: true } : { ok: false, error: 'مفتاح خاطئ' });
  });

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
      lastRoundScores: null,
      gulagWaiting: null,
      pendingGulag: null,
      roundsSinceGulag: 0,
      eliminationOrder: [],
      duel: null,
    });
    socket.join(`room:${code}`);
    socket.data.isHost = true;
    socket.data.hostRoomCode = code;
    cb({ ok: true, code });
  });

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
      phase: room.phase,
      roundNumber: room.roundNumber,
      roundInfo: room.phase === 'round' && room.round ? {
        category: room.round.category,
        endsAt: room.round.endsAt,
      } : null,
      adjGroups: room.phase === 'adjudication'
        ? attachNicks(room, room.round?.groupResult?.groups || [])
        : null,
      adjCategory: room.phase === 'adjudication' ? room.round?.category : null,
      leaderboard: ['results', 'finished'].includes(room.phase)
        ? (room.phase === 'finished' && isGulagGame ? buildGulagFinal(room) : buildLeaderboard(room, room.lastRoundScores || new Map()))
        : null,
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
        ? { groups: attachNicks(room, room.duel.groupResult?.groups || []), category: room.duel.category, players: duelPlayers }
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

  socket.on('host:adjust_score', ({ code, playerId, delta }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (!room.players.has(playerId)) return cb?.({ ok: false, error: 'لاعب غير موجود' });
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) return cb?.({ ok: false });

    room.scores.set(playerId, (room.scores.get(playerId) ?? 0) + d);
    broadcastPlayerList(room);

    if (room.phase === 'results') {
      emitToRoom(room, 'round:results', {
        leaderboard: buildLeaderboard(room, room.lastRoundScores || new Map()),
        roundNumber: room.roundNumber,
      });
    } else if (room.phase === 'finished') {
      const isGulagGame = room.eliminationOrder.length > 0 || room.gulagWaiting !== null;
      const lb = isGulagGame ? buildGulagFinal(room) : buildLeaderboard(room, new Map());
      emitToRoom(room, 'game:finished', { leaderboard: lb });
    }
    cb?.({ ok: true, newScore: room.scores.get(playerId) });
  });

  socket.on('host:start_round', ({ code, category }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (room.phase !== 'lobby') return cb?.({ ok: false, error: 'الغرفة ليست في وضع الانتظار' });

    room.roundNumber += 1;
    const endsAt = Date.now() + ROUND_SECONDS * 1000;
    room.phase = 'round';
    room.round = { category, startedAt: Date.now(), endsAt, answers: new Map(), scored: false, groupResult: null };

    emitToRoom(room, 'round:started', { category, endsAt, roundNumber: room.roundNumber });
    emitToSpectators(room, 'spectate:round_start',
      { category, endsAt, roundNumber: room.roundNumber, players: activeRoster(room) });

    room.round.timer = setTimeout(() => endRound(room), ROUND_SECONDS * 1000);
    let remaining = ROUND_SECONDS;
    room.round.tickInterval = setInterval(() => {
      remaining -= 1;
      emitToRoom(room, 'round:tick', { remaining });
      if (remaining <= 0) clearInterval(room.round.tickInterval);
    }, 1000);

    cb?.({ ok: true, endsAt, roundNumber: room.roundNumber });
  });

  socket.on('host:score_round', ({ code, decisions }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (room.phase !== 'adjudication') return cb?.({ ok: false, error: 'ليس وقت الاحتساب' });
    if (room.round.scored) return cb?.({ ok: true, alreadyScored: true });

    room.round.scored = true;
    const adjMap = new Map((decisions || []).map(d => [d.key, d.valid]));
    const { groups, perPlayerDeduped } = room.round.groupResult;
    const roundScores = computeScores(room, adjMap, perPlayerDeduped, groups);
    room.lastRoundScores = roundScores;
    room.phase = 'results';

    const leaderboard = buildLeaderboard(room, roundScores);
    emitToRoom(room, 'round:results', { leaderboard, roundNumber: room.roundNumber });
    broadcastPlayerList(room);
    maybeProposeGulag(room, roundScores);
    cb?.({ ok: true, leaderboard });
  });

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
      room.gulagWaiting = targetId;
      emitToPlayers(room, [targetId], 'gulag:entered', { waiting: true });
      cb?.({ ok: true, accepted: true, duel: false });
    } else {
      const opponentId = room.gulagWaiting;
      room.gulagWaiting = null;
      emitToPlayers(room, [targetId], 'gulag:entered', { waiting: false });
      startDuel(room, opponentId, targetId);
      cb?.({ ok: true, accepted: true, duel: true });
    }
  });

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

    const champion = activePlayers(room).length <= 1;
    const payload = {
      winnerId, loserId,
      winnerNick: winner?.nickname, loserNick: loser?.nickname,
      scores, champion,
    };
    emitToRoom(room, 'duel:result', payload);
    cb?.({ ok: true, ...payload });
  });

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

  socket.on('host:new_round', ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (room.phase !== 'results') return cb?.({ ok: false });
    room.phase = 'lobby';
    room.round = null;
    emitToRoom(room, 'round:reset', {});
    cb?.({ ok: true });
  });

  socket.on('host:end_game', ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    room.phase = 'finished';
    const leaderboard = buildLeaderboard(room, new Map());
    emitToRoom(room, 'game:finished', { leaderboard });
    cb?.({ ok: true });
  });

  socket.on('player:submit_answer', ({ code, answer }) => {
    const room = rooms.get(code);
    if (!room) return;
    const playerId = socket.data.playerId;
    const player = playerId ? room.players.get(playerId) : null;
    if (!player) return;
    const t = (answer || '').trim();
    if (!t) return;

    if (room.phase === 'round' && player.status === 'active') {
      if (Date.now() > room.round.endsAt) return;
      if (!room.round.answers.has(playerId)) room.round.answers.set(playerId, []);
      room.round.answers.get(playerId).push(t);
      socket.emit('player:answer_received', { answer: t });
      emitToSpectators(room, 'spectate:answer', { playerId, nickname: player.nickname, answer: t });
    } else if (room.phase === 'duel' && room.duel.players.includes(playerId)) {
      if (Date.now() > room.duel.endsAt) return;
      if (!room.duel.answers.has(playerId)) room.duel.answers.set(playerId, []);
      room.duel.answers.get(playerId).push(t);
      socket.emit('player:answer_received', { answer: t });
      emitToDuelAudience(room, 'duel:spectate_answer', { playerId, nickname: player.nickname, answer: t });
    }
  });

  socket.on('player:join', ({ code, nickname, playerId }, cb) => {
    const upperCode = (code || '').toUpperCase();
    const room = rooms.get(upperCode);
    if (!room) return cb({ ok: false, error: 'الغرفة غير موجودة' });

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
        status: player.status,
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
              ? buildGulagFinal(room) : buildLeaderboard(room, room.lastRoundScores || new Map()))
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
    room.players.set(newId, { playerId: newId, nickname: nick, socketId: socket.id, connected: true, status: 'active' });
    room.scores.set(newId, 0);
    socket.join(`room:${upperCode}`);
    socket.data.playerId = newId;
    socket.data.roomCode = upperCode;
    broadcastPlayerList(room);

    cb({ ok: true, playerId: newId, nickname: nick, status: 'active', phase: room.phase, roundInfo: null, leaderboard: null });
  });

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
