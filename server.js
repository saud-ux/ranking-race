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
const ROUND_SECONDS = 30;
const HOST_GRACE_MS = 10 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 1000;

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
      roundScore: roundScores?.get(p.playerId) ?? 0,
      totalScore: room.scores.get(p.playerId) ?? 0,
    }))
    .sort((a, b) => b.totalScore - a.totalScore || b.roundScore - a.roundScore)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

// ─── Live race standings (§ live board) ───────────────────────────────────────

function computeStandings(room) {
  const liveKeys = room.round?.liveKeys;
  return [...room.players.values()]
    .map(p => ({
      playerId: p.playerId,
      nickname: p.nickname,
      count: liveKeys?.get(p.playerId)?.size ?? 0,
    }))
    .sort((a, b) => b.count - a.count)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

// Throttle standings broadcasts so a burst of submits coalesces into one emit
function scheduleStandingsBroadcast(room) {
  if (room._standingsScheduled) return;
  room._standingsScheduled = true;
  setTimeout(() => {
    room._standingsScheduled = false;
    if (room.phase === 'round') emitToRoom(room, 'round:standings', { standings: computeStandings(room) });
  }, 250);
}

// ─── Reveal sequence (§ suspenseful reveal) ───────────────────────────────────

function buildRevealItems(room, adjMap, groups) {
  const items = groups.map(g => {
    const valid  = adjMap.get(g.key) !== false;
    const points = !valid ? -1 : (g.playerCount === 1 ? 2 : 1);
    const tier   = !valid ? 'rejected' : (g.playerCount === 1 ? 'unique' : 'shared');
    return {
      label: g.displayLabel,
      count: g.playerCount,
      valid, points, tier,
      players: g.playerIds.map(id => room.players.get(id)?.nickname).filter(Boolean),
      playerIds: g.playerIds,
    };
  });
  const tierRank = { rejected: 0, shared: 1, unique: 2 };
  items.sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || b.count - a.count);
  return items;
}

function finalizeRound(room) {
  if (room.phase !== 'reveal') return;
  room.phase = 'results';
  const leaderboard = buildLeaderboard(room, room.round.roundScores);
  emitToRoom(room, 'round:results', { leaderboard, roundNumber: room.roundNumber });
  broadcastPlayerList(room);
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

// ─── Round end ────────────────────────────────────────────────────────────────

function endRound(room) {
  if (room.phase !== 'round') return;
  clearInterval(room.round.tickInterval);
  clearTimeout(room.round.timer);
  room.phase = 'adjudication';

  const { groups, perPlayerDeduped } = groupAnswers(room.round);
  room.round.groupResult = { groups, perPlayerDeduped };

  io.to(`host:${room.code}`).emit('round:ended', {
    groups,
    category: room.round.category,
    roundNumber: room.roundNumber,
  });

  emitToRoom(room, 'round:time_up', {});
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
    });
    socket.join(`room:${code}`);
    socket.join(`host:${code}`);
    socket.data.isHost = true;
    socket.data.hostRoomCode = code;
    cb({ ok: true, code });
  });

  // HOST: reconnect to existing room
  socket.on('host:rejoin_room', ({ key, code }, cb) => {
    if (key !== HOST_KEY) return cb({ ok: false, error: 'غير مصرح' });
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'الغرفة غير موجودة' });
    room.hostSocketId = socket.id;
    room.hostLastSeenAt = Date.now();
    socket.join(`room:${code}`);
    socket.join(`host:${code}`);
    socket.data.isHost = true;
    socket.data.hostRoomCode = code;

    const rv = room.round?.reveal;
    cb({
      ok: true,
      players: playerListPayload(room),
      phase: room.phase,
      roundNumber: room.roundNumber,
      category: room.round?.category ?? null,
      endsAt: room.phase === 'round' ? room.round?.endsAt : null,
      standings: room.phase === 'round' ? computeStandings(room) : null,
      adjGroups: room.phase === 'adjudication' ? room.round?.groupResult?.groups : null,
      adjCategory: room.phase === 'adjudication' ? room.round?.category : null,
      revealInfo: room.phase === 'reveal' && rv
        ? { items: rv.items.slice(0, rv.index + 1), index: rv.index, total: rv.items.length }
        : null,
      leaderboard: ['results', 'finished'].includes(room.phase) ? buildLeaderboard(room, new Map()) : null,
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
    const endsAt = Date.now() + ROUND_SECONDS * 1000;
    room.phase = 'round';
    room.round = { category, startedAt: Date.now(), endsAt, answers: new Map(), liveKeys: new Map(), scored: false, groupResult: null };

    emitToRoom(room, 'round:started', { category, endsAt, roundNumber: room.roundNumber });
    emitToRoom(room, 'round:standings', { standings: computeStandings(room) });

    room.round.timer = setTimeout(() => endRound(room), ROUND_SECONDS * 1000);
    let remaining = ROUND_SECONDS;
    room.round.tickInterval = setInterval(() => {
      remaining -= 1;
      emitToRoom(room, 'round:tick', { remaining });
      if (remaining <= 0) clearInterval(room.round.tickInterval);
    }, 1000);

    cb?.({ ok: true, endsAt, roundNumber: room.roundNumber });
  });

  // HOST: manually end the round early
  socket.on('host:end_round', ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (room.phase !== 'round') return cb?.({ ok: false, error: 'الجولة لم تبدأ' });
    endRound(room);
    cb?.({ ok: true });
  });

  // HOST: score a round → enter suspenseful reveal phase (idempotent)
  socket.on('host:score_round', ({ code, decisions }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (room.phase !== 'adjudication') return cb?.({ ok: false, error: 'ليس وقت الاحتساب' });
    if (room.round.scored) return cb?.({ ok: true, alreadyScored: true });

    room.round.scored = true;
    const adjMap = new Map((decisions || []).map(d => [d.key, d.valid]));
    const { groups, perPlayerDeduped } = room.round.groupResult;
    const roundScores = computeScores(room, adjMap, perPlayerDeduped, groups);
    room.round.roundScores = roundScores;

    // Build ordered reveal: rejected → shared (common first) → unique gems last
    room.round.reveal = { items: buildRevealItems(room, adjMap, groups), index: -1 };
    room.phase = 'reveal';

    emitToRoom(room, 'round:reveal_start', {
      category: room.round.category,
      roundNumber: room.roundNumber,
      total: room.round.reveal.items.length,
    });
    cb?.({ ok: true });
  });

  // HOST: reveal the next answer (or finalize to leaderboard when done)
  socket.on('host:reveal_advance', ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (room.phase !== 'reveal') return cb?.({ ok: false });
    const rv = room.round.reveal;
    rv.index += 1;
    if (rv.index < rv.items.length) {
      const last = rv.index === rv.items.length - 1;
      emitToRoom(room, 'round:reveal_item', {
        item: rv.items[rv.index], index: rv.index, total: rv.items.length, last,
      });
      cb?.({ ok: true, last });
    } else {
      finalizeRound(room);
      cb?.({ ok: true, finished: true });
    }
  });

  // HOST: skip the rest of the reveal → straight to leaderboard
  socket.on('host:reveal_skip', ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    if (room.phase !== 'reveal') return cb?.({ ok: false });
    finalizeRound(room);
    cb?.({ ok: true });
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
    emitToRoom(room, 'game:finished', { leaderboard });
    cb?.({ ok: true });
  });

  // PLAYER: submit answer during round
  socket.on('player:submit_answer', ({ code, answer }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'round') return;
    if (Date.now() > room.round.endsAt) return; // late — silently drop
    const playerId = socket.data.playerId;
    if (!playerId || !room.players.has(playerId)) return;
    const t = (answer || '').trim();
    if (!t) return;
    if (!room.round.answers.has(playerId)) room.round.answers.set(playerId, []);
    room.round.answers.get(playerId).push(t);

    // Live race tally — deduped normalized count (no words leaked, just counts)
    const liveKey = normalizeArabic(t);
    if (liveKey) {
      if (!room.round.liveKeys.has(playerId)) room.round.liveKeys.set(playerId, new Set());
      room.round.liveKeys.get(playerId).add(liveKey);
    }

    socket.emit('player:answer_received', { answer: t });
    scheduleStandingsBroadcast(room);
  });

  // PLAYER: join / reconnect
  socket.on('player:join', ({ code, nickname, playerId }, cb) => {
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
      const rvP = room.round?.reveal;
      return cb({
        ok: true,
        playerId,
        nickname: player.nickname,
        phase: room.phase,
        roundInfo: room.phase === 'round' ? {
          category: room.round.category,
          endsAt: room.round.endsAt,
          roundNumber: room.roundNumber,
          myAnswers: room.round.answers.get(playerId) || [],
          standings: computeStandings(room),
        } : null,
        revealInfo: room.phase === 'reveal' && rvP ? {
          category: room.round.category,
          roundNumber: room.roundNumber,
          items: rvP.items.slice(0, rvP.index + 1),
          index: rvP.index,
          total: rvP.items.length,
        } : null,
        leaderboard: ['results', 'finished'].includes(room.phase)
          ? buildLeaderboard(room, new Map()) : null,
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
    room.players.set(newId, { playerId: newId, nickname: nick, socketId: socket.id, connected: true });
    room.scores.set(newId, 0);
    socket.join(`room:${upperCode}`);
    socket.data.playerId = newId;
    socket.data.roomCode = upperCode;
    broadcastPlayerList(room);

    cb({ ok: true, playerId: newId, nickname: nick, phase: room.phase, roundInfo: null, leaderboard: null });
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
