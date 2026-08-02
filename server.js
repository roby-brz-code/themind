'use strict';

/**
 * The Mind — authoritative game server.
 *
 * Plain Node http server for static files + `ws` WebSocket server for the game.
 * All game state lives here. Clients only ever receive their own card values;
 * other players' hands are sent as counts. Every action is validated server-side.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const HEARTBEAT_MS = 30 * 1000;
const GC_INTERVAL_MS = 60 * 1000;
const ROOM_IDLE_TTL_MS = 30 * 60 * 1000; // no messages at all for 30 min
const ROOM_ABANDONED_TTL_MS = 10 * 60 * 1000; // everyone disconnected for 10 min

// Unambiguous room-code alphabet (no 0/O, 1/I/L).
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

// Rewards granted when the given level is COMPLETED.
const LEVEL_REWARDS = { 2: 'star', 3: 'life', 5: 'star', 6: 'life', 8: 'star', 9: 'life' };

// Avatars a player may pick; anything else falls back to a random one.
const AVATARS = ['🦊', '🐼', '🐸', '🦉', '🐙', '🦄', '🐯', '🐨', '🐺', '🦁', '🐵', '🐹'];

// Emotes players can broadcast during a game. Cosmetic only — never touch game state.
const EMOTES = ['🙌', '👏', '🔥', '😱', '😅', '❤️', '🤯', '🎉', '🍑', '🍆', '💦'];
const EMOTE_COOLDOWN_MS = 1000;

// A concentrate "hand on the table" hold auto-clears after this long as a safety
// net (e.g. the releasing message got lost, or the tab was backgrounded).
const CONCENTRATE_TTL_MS = 30 * 1000;

const levelsFor = (n) => (n <= 2 ? 12 : n === 3 ? 10 : 8);
const livesFor = (n) => Math.min(n, 4);

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Extensionless paths fall back to the app shell; real asset misses 404.
      if (!path.extname(filePath)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, shell) => {
          if (err2) return void res.writeHead(404).end('Not found');
          res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(shell);
        });
      } else {
        res.writeHead(404).end('Not found');
      }
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const rooms = new Map();

function makeCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

const newId = () => crypto.randomBytes(8).toString('hex');
const newToken = () => crypto.randomBytes(16).toString('hex');

function createRoom() {
  const room = {
    code: makeCode(),
    players: [],
    phase: 'lobby', // lobby | readyCheck | playing | levelComplete | gameOver | won
    readyReason: null, // levelStart | lifeLost
    level: 0,
    totalLevels: 0,
    lives: 0,
    stars: 0,
    pile: [],
    history: [], // everything revealed this level, in order: { card, kind: 'played'|'discard', playerId }
    vote: null, // { proposerId, votes: { [playerId]: true } }
    lastReward: null,
    eventSeq: 0,
    recentEvents: [],
    lastActivity: Date.now(),
    stats: createStats(), // per-room statistics; live as long as the room does
    playableSince: null, // reaction-time clock: when play last became possible
  };
  rooms.set(room.code, room);
  return room;
}

// ---------------------------------------------------------------------------
// Room statistics — counts and timings only, NEVER card values.
// `game` resets on every new game; `allTime` accumulates until the room dies.
// Keyed by stable player id, so reconnects keep a player's stats.
// ---------------------------------------------------------------------------

const newStatCounters = () => ({
  mistakes: 0, // times this player played a card while lower ones were held
  cardsPlayed: 0,
  reactionTotal: 0, // ms; sum over plays of (play time − when play became possible)
  reactionCount: 0,
  fastest: null, // ms, single quickest play
  slowest: null, // ms, single slowest play
  starsProposed: 0,
  emotes: 0,
});

function createStats() {
  return { game: { players: {} }, allTime: { games: [], players: {} } };
}

/** The [thisGame, allTime] counter pair for a player, created on first touch. */
function statPair(room, player) {
  const pair = [];
  for (const scope of [room.stats.game, room.stats.allTime]) {
    let s = scope.players[player.id];
    if (!s) s = scope.players[player.id] = { name: player.name, avatar: player.avatar, ...newStatCounters() };
    s.name = player.name; // keep the snapshot fresh for departed-player rows
    s.avatar = player.avatar;
    pair.push(s);
  }
  return pair;
}

function recordPlay(room, player, reactionMs, mistake) {
  for (const s of statPair(room, player)) {
    s.cardsPlayed += 1;
    s.reactionTotal += reactionMs;
    s.reactionCount += 1;
    if (s.fastest === null || reactionMs < s.fastest) s.fastest = reactionMs;
    if (s.slowest === null || reactionMs > s.slowest) s.slowest = reactionMs;
    if (mistake) s.mistakes += 1;
  }
}

function bumpStat(room, player, key) {
  for (const s of statPair(room, player)) s[key] += 1;
}

/**
 * (Re)start the reaction clock: play just became possible. Called on
 * ready-check completion, after each successful play, when a star vote
 * resolves, and when a paused game unpauses — so vote/pause time is never
 * counted as thinking time.
 */
function markPlayable(room) {
  room.playableSince = Date.now();
}

function recordGameEnd(room, result) {
  const games = room.stats.allTime.games;
  games.push({
    level: room.level,
    totalLevels: room.totalLevels,
    players: room.players.length,
    result, // 'won' | 'lost'
    at: Date.now(),
  });
  if (games.length > 20) games.splice(0, games.length - 20);
}

function statRow(room, id, s) {
  const inRoom = room.players.find((p) => p.id === id);
  return {
    id,
    name: s.name,
    avatar: s.avatar,
    present: !!inRoom,
    connected: !!(inRoom && inRoom.connected),
    mistakes: s.mistakes,
    cardsPlayed: s.cardsPlayed,
    avgMs: s.reactionCount ? Math.round(s.reactionTotal / s.reactionCount) : null,
    fastestMs: s.fastest,
    slowestMs: s.slowest,
    starsProposed: s.starsProposed,
    emotes: s.emotes,
  };
}

/** Sent only on request (`getStats`) — never bloats the state broadcast. */
function statsFor(room) {
  const { game, allTime } = room.stats;
  let bestLevel = allTime.games.reduce((m, g) => Math.max(m, g.level), 0);
  if (room.phase !== 'lobby') bestLevel = Math.max(bestLevel, room.level);
  return {
    type: 'stats',
    game: {
      level: room.level,
      totalLevels: room.totalLevels,
      phase: room.phase,
      players: room.players.map((p) =>
        statRow(room, p.id, game.players[p.id] || { name: p.name, avatar: p.avatar, ...newStatCounters() })),
    },
    allTime: {
      bestLevel,
      gamesPlayed: allTime.games.length,
      recentGames: allTime.games.slice(-10),
      players: Object.entries(allTime.players).map(([id, s]) => statRow(room, id, s)),
    },
  };
}

function createPlayer(name, isHost, avatar) {
  return {
    id: newId(),
    token: newToken(),
    name,
    avatar,
    isHost,
    connected: true,
    ws: null,
    hand: [],
    discards: [], // face-up discards this level, visible to everyone
    ready: false,
    lastEmoteAt: 0,
    concentrating: false, // press-and-hold "hand on the table" glow (cosmetic only)
    concentrateTimer: null,
  };
}

function emit(room, event) {
  room.eventSeq += 1;
  room.recentEvents.push({ id: room.eventSeq, ...event });
  if (room.recentEvents.length > 8) room.recentEvents.splice(0, room.recentEvents.length - 8);
}

function shuffledDeck() {
  const deck = Array.from({ length: 100 }, (_, i) => i + 1);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function dealLevel(room) {
  const deck = shuffledDeck();
  for (const p of room.players) {
    p.hand = deck.splice(0, room.level).sort((a, b) => a - b);
    p.discards = [];
    p.ready = false;
  }
  room.pile = [];
  room.history = [];
  room.vote = null;
  room.phase = 'readyCheck';
  room.readyReason = 'levelStart';
}

function startGame(room) {
  const n = room.players.length;
  room.totalLevels = levelsFor(n);
  room.lives = livesFor(n);
  room.stars = 1;
  room.level = 1;
  room.lastReward = null;
  room.stats.game = { players: {} }; // fresh "this game" section; all-time persists
  for (const p of room.players) statPair(room, p); // seed a row for everyone
  emit(room, { kind: 'gameStarted', players: n, totalLevels: room.totalLevels });
  dealLevel(room);
}

const allHandsEmpty = (room) => room.players.every((p) => p.hand.length === 0);

function completeLevel(room) {
  const reward = LEVEL_REWARDS[room.level] || null;
  if (reward === 'life') room.lives += 1;
  if (reward === 'star') room.stars += 1;
  room.lastReward = reward;
  room.vote = null;
  emit(room, { kind: 'levelComplete', level: room.level, reward });
  if (room.level >= room.totalLevels) {
    room.phase = 'won';
    emit(room, { kind: 'won' });
  } else {
    room.phase = 'levelComplete';
  }
  if (room.phase === 'won') recordGameEnd(room, 'won');
}

// The acting host: the real host, or the first connected player if the host
// is disconnected (so a vanished host can never strand the game).
function actingHost(room) {
  const host = room.players.find((p) => p.isHost);
  if (host && host.connected) return host;
  return room.players.find((p) => p.connected) || host || null;
}

// ---------------------------------------------------------------------------
// Per-player tailored state (never leaks other players' card values)
// ---------------------------------------------------------------------------

function stateFor(room, viewer) {
  const revealAll = room.phase === 'gameOver'; // on a loss, show what everyone was holding
  const showOwnHand =
    room.phase === 'playing' ||
    room.phase === 'levelComplete' ||
    room.phase === 'gameOver' ||
    room.phase === 'won' ||
    (room.phase === 'readyCheck' && room.readyReason === 'lifeLost');
  return {
    type: 'state',
    code: room.code,
    you: viewer.id,
    phase: room.phase,
    readyReason: room.readyReason,
    level: room.level,
    totalLevels: room.totalLevels,
    lives: room.lives,
    stars: room.stars,
    pile: room.pile.slice(-4),
    pileCount: room.pile.length,
    history: room.history, // face-up cards only — safe to share with everyone
    hand: showOwnHand ? viewer.hand : null,
    handCount: viewer.hand.length,
    lastReward: room.lastReward,
    vote: room.vote ? { proposerId: room.vote.proposerId } : null,
    actingHostId: actingHost(room)?.id ?? null,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      isHost: p.isHost,
      connected: p.connected,
      cardCount: p.hand.length,
      ready: p.ready,
      concentrating: p.concentrating === true,
      discards: p.discards,
      voted: room.vote ? room.vote.votes[p.id] === true : false,
      revealed: revealAll && p.id !== viewer.id ? p.hand : undefined,
    })),
    events: room.recentEvents,
  };
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  for (const p of room.players) send(p.ws, stateFor(room, p));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function fail(message) {
  const err = new Error(message);
  err.userMessage = message;
  throw err;
}

function cleanName(raw) {
  const name = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 16);
  if (!name) fail('Please enter a name');
  return name;
}

// Must be one of the allowed avatars; anything else gets a random one.
function cleanAvatar(raw) {
  return AVATARS.includes(raw) ? raw : AVATARS[crypto.randomInt(AVATARS.length)];
}

function attach(ws, room, player) {
  ws._room = room;
  ws._player = player;
  player.ws = ws;
}

function doCreate(ws, msg) {
  if (ws._room) fail('Already in a room');
  const name = cleanName(msg.name);
  const room = createRoom();
  const player = createPlayer(name, true, cleanAvatar(msg.avatar));
  room.players.push(player);
  attach(ws, room, player);
  send(ws, { type: 'joined', code: room.code, playerId: player.id, token: player.token, name });
  broadcast(room);
}

function doJoin(ws, msg) {
  if (ws._room) fail('Already in a room');
  const name = cleanName(msg.name);
  const code = String(msg.code || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) fail('Room not found — double-check the code');
  if (!['lobby', 'gameOver', 'won'].includes(room.phase)) fail('That game is in progress — wait for it to finish');
  if (room.players.length >= MAX_PLAYERS) fail(`Room is full (max ${MAX_PLAYERS} players)`);
  if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail('That name is already taken in this room');
  const player = createPlayer(name, false, cleanAvatar(msg.avatar));
  room.players.push(player);
  attach(ws, room, player);
  room.lastActivity = Date.now();
  emit(room, { kind: 'playerJoined', name });
  send(ws, { type: 'joined', code: room.code, playerId: player.id, token: player.token, name });
  broadcast(room);
}

function doRejoin(ws, msg) {
  const code = String(msg.code || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) fail('That room no longer exists');
  const player = room.players.find((p) => p.token === msg.token);
  if (!player) fail('Session expired — join the room again');
  // Kick a stale/duplicate connection for the same player.
  if (player.ws && player.ws !== ws && player.ws.readyState === player.ws.OPEN) {
    player.ws._room = null;
    player.ws._player = null;
    try { player.ws.close(4000, 'Replaced by a new connection'); } catch { /* ignore */ }
  }
  const wasDisconnected = !player.connected;
  attach(ws, room, player);
  player.connected = true;
  room.lastActivity = Date.now();
  if (wasDisconnected) {
    emit(room, { kind: 'playerReconnected', name: player.name });
    // Unpaused: don't count the disconnect pause as anyone's thinking time.
    if (room.phase === 'playing' && room.players.every((p) => p.connected)) markPlayable(room);
  }
  send(ws, { type: 'joined', code: room.code, playerId: player.id, token: player.token, name: player.name });
  broadcast(room);
}

function doStart(room, player) {
  if (actingHost(room) !== player) fail('Only the host can start the game');
  if (room.phase !== 'lobby') fail('The game has already started');
  if (room.players.length < MIN_PLAYERS) fail(`Need at least ${MIN_PLAYERS} players`);
  startGame(room);
}

function doReady(room, player) {
  if (room.phase !== 'readyCheck') fail('Nothing to ready up for right now');
  player.ready = true;
  if (room.players.every((p) => p.ready && p.connected)) {
    room.phase = 'playing';
    room.readyReason = null;
    markPlayable(room);
    emit(room, { kind: 'playBegins', level: room.level });
  }
}

function doPlayCard(room, player) {
  if (room.phase !== 'playing') fail('You can only play cards during a level');
  if (room.vote) fail('A star vote is in progress');
  if (room.players.some((p) => !p.connected)) fail('Game paused — waiting for a player to reconnect');
  if (player.hand.length === 0) fail('You have no cards left');

  // Reaction time: from when play last became possible to this play. The clock
  // is reset around ready-checks, star votes, and pauses, so none of that
  // counts as thinking time.
  const reactionMs = Math.max(1, Date.now() - (room.playableSince || Date.now()));

  const card = player.hand.shift(); // hands are kept sorted; only the lowest is ever playable
  room.pile.push(card);
  room.history.push({ card, kind: 'played', playerId: player.id });

  // A mistake: someone else still holds one or more lower cards.
  const busted = [];
  for (const p of room.players) {
    const lower = p.hand.filter((c) => c < card);
    if (lower.length) {
      p.hand = p.hand.filter((c) => c >= card);
      p.discards.push(...lower);
      for (const c of lower) room.history.push({ card: c, kind: 'discard', playerId: p.id });
      busted.push({ playerId: p.id, name: p.name, cards: lower });
    }
  }

  // The mistake is attributed to the player who played the too-high card.
  recordPlay(room, player, reactionMs, busted.length > 0);

  if (busted.length) {
    room.lives -= 1;
    emit(room, { kind: 'mistake', playerId: player.id, name: player.name, card, busted, livesLeft: room.lives });
    if (room.lives <= 0) {
      room.phase = 'gameOver';
      room.vote = null;
      recordGameEnd(room, 'lost');
      emit(room, { kind: 'gameOver', level: room.level });
      return;
    }
    if (allHandsEmpty(room)) {
      completeLevel(room);
      return;
    }
    // Pause: everyone must put a "hand on the table" again before play resumes.
    room.phase = 'readyCheck';
    room.readyReason = 'lifeLost';
    for (const p of room.players) p.ready = false;
  } else {
    emit(room, { kind: 'cardPlayed', playerId: player.id, name: player.name, card });
    if (allHandsEmpty(room)) completeLevel(room);
    else markPlayable(room); // next play's reaction clock starts now
  }
}

function doProposeStar(room, player) {
  if (room.phase !== 'playing') fail('Stars can only be proposed during a level');
  if (room.vote) fail('A star vote is already in progress');
  if (room.stars < 1) fail('No stars left');
  if (room.players.some((p) => !p.connected)) fail('Game paused — waiting for a player to reconnect');
  room.vote = { proposerId: player.id, votes: { [player.id]: true } };
  bumpStat(room, player, 'starsProposed');
  emit(room, { kind: 'starProposed', playerId: player.id, name: player.name });
}

function doVoteStar(room, player, agree) {
  if (!room.vote) fail('There is no star vote in progress');
  if (room.vote.votes[player.id]) fail('You already agreed');
  if (!agree) {
    room.vote = null;
    markPlayable(room); // vote time never counts as thinking time
    emit(room, { kind: 'starDeclined', playerId: player.id, name: player.name });
    return;
  }
  room.vote.votes[player.id] = true;
  if (room.players.every((p) => room.vote.votes[p.id])) {
    // Unanimous: use the star. Everyone discards their lowest card face-up.
    room.stars -= 1;
    room.vote = null;
    const discarded = [];
    for (const p of room.players) {
      if (p.hand.length) {
        const c = p.hand.shift();
        p.discards.push(c);
        room.history.push({ card: c, kind: 'discard', playerId: p.id });
        discarded.push({ playerId: p.id, name: p.name, card: c });
      }
    }
    emit(room, { kind: 'starUsed', discarded, starsLeft: room.stars });
    if (allHandsEmpty(room)) completeLevel(room);
    else markPlayable(room); // vote resolved — reaction clock restarts
  }
}

/** Clear a player's concentrate hold (and its safety timer). */
function clearConcentrate(player) {
  if (player.concentrateTimer) {
    clearTimeout(player.concentrateTimer);
    player.concentrateTimer = null;
  }
  player.concentrating = false;
}

/**
 * Press-and-hold "concentrate": purely cosmetic, like emotes. While held, every
 * client shows a glowing hand at the player's seat. Never pauses the game or
 * blocks plays. Auto-clears after CONCENTRATE_TTL_MS as a safety net.
 */
function doConcentrate(room, player, on) {
  if (room.phase === 'lobby') fail('Concentrate is for the game table');
  clearConcentrate(player);
  if (on) {
    player.concentrating = true;
    player.concentrateTimer = setTimeout(() => {
      player.concentrateTimer = null;
      if (player.concentrating) {
        player.concentrating = false;
        broadcast(room);
      }
    }, CONCENTRATE_TTL_MS);
  }
}

function doEmote(room, player, emote) {
  if (!EMOTES.includes(emote)) fail('That emote is not allowed');
  if (room.phase === 'lobby') fail('Emotes are for the game table');
  const now = Date.now();
  if (now - player.lastEmoteAt < EMOTE_COOLDOWN_MS) fail('Easy there — one emote per second');
  player.lastEmoteAt = now;
  bumpStat(room, player, 'emotes');
  // Cosmetic only: broadcast and move on, never touching game state.
  emit(room, { kind: 'emote', playerId: player.id, name: player.name, emote });
}

function doNextLevel(room, player) {
  if (actingHost(room) !== player) fail('Only the host can deal the next level');
  if (room.phase !== 'levelComplete') fail('The level is not complete');
  room.level += 1;
  room.lastReward = null;
  emit(room, { kind: 'levelDealt', level: room.level });
  dealLevel(room);
}

function doPlayAgain(room, player) {
  if (actingHost(room) !== player) fail('Only the host can start a new game');
  if (!['gameOver', 'won'].includes(room.phase)) fail('The game is still in progress');
  // Drop anyone who left for good; keep the connected group together.
  room.players = room.players.filter((p) => p.connected);
  if (!room.players.some((p) => p.isHost) && room.players.length) room.players[0].isHost = true;
  for (const p of room.players) {
    p.hand = [];
    p.discards = [];
    p.ready = false;
    clearConcentrate(p);
  }
  if (room.players.length < MIN_PLAYERS) {
    room.phase = 'lobby';
    room.readyReason = null;
    room.level = 0;
    room.pile = [];
    room.history = [];
    room.stats.game = { players: {} }; // this-game section resets; all-time persists
    emit(room, { kind: 'backToLobby' });
  } else {
    startGame(room);
  }
}

// ---------------------------------------------------------------------------
// WebSocket wiring
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws._room = null;
  ws._player = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      handleMessage(ws, msg);
    } catch (err) {
      if (err && err.userMessage) {
        send(ws, { type: 'error', message: err.userMessage, action: msg.type });
      } else {
        console.error('Unexpected error handling', msg.type, err);
        send(ws, { type: 'error', message: 'Something went wrong on the server', action: msg.type });
      }
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => { /* close will follow */ });
});

function handleMessage(ws, msg) {
  if (ws._room) ws._room.lastActivity = Date.now();

  switch (msg.type) {
    case 'create': return doCreate(ws, msg);
    case 'join': return doJoin(ws, msg);
    case 'rejoin': return doRejoin(ws, msg);
    case 'ping': return send(ws, { type: 'pong' });
    default: break;
  }

  const room = ws._room;
  const player = ws._player;
  if (!room || !player) fail('You are not in a room');

  // Read-only stats request: reply to the asker only, no state broadcast.
  if (msg.type === 'getStats') return send(ws, statsFor(room));

  switch (msg.type) {
    case 'start': doStart(room, player); break;
    case 'ready': doReady(room, player); break;
    case 'playCard': doPlayCard(room, player); break;
    case 'proposeStar': doProposeStar(room, player); break;
    case 'voteStar': doVoteStar(room, player, msg.agree === true); break;
    case 'concentrateStart': doConcentrate(room, player, true); break;
    case 'concentrateStop': doConcentrate(room, player, false); break;
    case 'emote': doEmote(room, player, msg.emote); break;
    case 'nextLevel': doNextLevel(room, player); break;
    case 'playAgain': doPlayAgain(room, player); break;
    default: fail('Unknown action');
  }
  broadcast(room);
}

function handleDisconnect(ws) {
  const room = ws._room;
  const player = ws._player;
  ws._room = null;
  ws._player = null;
  if (!room || !player || player.ws !== ws) return;
  player.ws = null;

  if (room.phase === 'lobby') {
    // In the lobby people come and go freely.
    room.players = room.players.filter((p) => p !== player);
    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }
    if (player.isHost) room.players[0].isHost = true;
    emit(room, { kind: 'playerLeft', name: player.name });
  } else {
    // Mid-game: keep the seat, pause play, allow reconnect via session token.
    player.connected = false;
    player.ready = false;
    clearConcentrate(player); // never leave a ghost hand glowing on the table
    if (room.vote) {
      room.vote = null;
      emit(room, { kind: 'starDeclined', name: player.name, reason: 'disconnect' });
    }
    emit(room, { kind: 'playerDisconnected', name: player.name });
  }
  room.lastActivity = Date.now();
  broadcast(room);
}

// Heartbeat: drop dead sockets so disconnects are detected promptly.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

// Garbage-collect stale rooms.
const gc = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = now - room.lastActivity;
    const abandoned = room.players.every((p) => !p.connected);
    if (idle > ROOM_IDLE_TTL_MS || (abandoned && idle > ROOM_ABANDONED_TTL_MS)) {
      for (const p of room.players) {
        if (p.ws) { try { p.ws.close(4001, 'Room expired'); } catch { /* ignore */ } }
      }
      rooms.delete(code);
    }
  }
}, GC_INTERVAL_MS);

heartbeat.unref();
gc.unref();

server.listen(PORT, () => {
  console.log(`The Mind server listening on http://localhost:${PORT}`);
});
