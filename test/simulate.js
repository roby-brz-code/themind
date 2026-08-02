'use strict';

/* End-to-end simulation of a 3-player game of The Mind against a running server.
 *
 * Usage: start the server (`npm start`), then `node test/simulate.js`
 * (or set URL=ws://host:port).
 *
 * Covers: create/join room, start, ready-check, playing a level in order,
 * a forced mistake (life loss + auto-discard + re-ready), a unanimous shuriken,
 * level rewards, disconnect/pause/reconnect via session token, and the
 * anti-cheat guarantee that other players' card values are never sent.
 */

const WebSocket = require('ws');
const assert = require('assert');

const URL = process.env.URL || 'ws://localhost:3000';
const STEP_TIMEOUT = 8000;

let checks = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  checks++;
  console.log(`  ✓ ${label}`);
}

class Client {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.state = null;
    this.joined = null;
    this.errors = [];
    this.stateWaiters = [];
    this.leakDetected = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => this.onMessage(JSON.parse(raw.toString())));
    });
  }

  onMessage(msg) {
    if (msg.type === 'joined') this.joined = msg;
    if (msg.type === 'error') this.errors.push(msg);
    if (msg.type === 'state') {
      this.state = msg;
      // Anti-cheat check: no other player's live hand values may ever appear,
      // except the explicit face-up reveal on game over.
      for (const p of msg.state?.players || msg.players || []) {
        if (p.id !== msg.you && p.hand !== undefined) {
          this.leakDetected = `state leaked "hand" for other player ${p.name}`;
        }
        if (p.id !== msg.you && p.revealed !== undefined && msg.phase !== 'gameOver') {
          this.leakDetected = `state leaked "revealed" outside gameOver for ${p.name}`;
        }
      }
      const waiters = this.stateWaiters;
      this.stateWaiters = [];
      for (const w of waiters) w();
    }
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  /** Resolve once the current (or a future) state matches pred. */
  until(pred, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for: ${label}\n  last state for ${this.name}: ` +
          JSON.stringify(this.state && { phase: this.state.phase, pileCount: this.state.pileCount, lives: this.state.lives })));
      }, STEP_TIMEOUT);
      const check = () => {
        if (this.state && pred(this.state)) {
          clearTimeout(timer);
          resolve(this.state);
          return true;
        }
        return false;
      };
      if (check()) return;
      const listen = () => { if (!check()) this.stateWaiters.push(listen); };
      this.stateWaiters.push(listen);
    });
  }

  waitError(label) {
    return new Promise((resolve, reject) => {
      const start = this.errors.length;
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for error: ${label}`)), STEP_TIMEOUT);
      const poll = setInterval(() => {
        if (this.errors.length > start) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(this.errors[this.errors.length - 1]);
        }
      }, 25);
    });
  }

  get hand() { return this.state.hand || []; }
  me() { return this.state.players.find((p) => p.id === this.state.you); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function everyone(clients, pred, label) {
  await Promise.all(clients.map((c) => c.until(pred, `${label} [${c.name}]`)));
}

async function readyAll(clients, label) {
  await everyone(clients, (s) => s.phase === 'readyCheck', `readyCheck before ${label}`);
  for (const c of clients) c.send({ type: 'ready' });
  await everyone(clients, (s) => s.phase === 'playing', `playing after ${label}`);
}

/** Play all remaining cards in globally ascending order until the level ends. */
async function playOutLevel(clients) {
  for (;;) {
    const done = clients[0].state.phase !== 'playing';
    if (done) return;
    const holders = clients.filter((c) => c.hand.length > 0);
    if (!holders.length) return;
    holders.sort((a, b) => a.hand[0] - b.hand[0]);
    const player = holders[0];
    const card = player.hand[0];
    const prevPile = player.state.pileCount;
    player.send({ type: 'playCard' });
    await everyone(clients, (s) => s.pileCount === prevPile + 1 || s.phase !== 'playing',
      `card ${card} on pile`);
    if (clients[0].state.phase !== 'playing') return;
  }
}

async function main() {
  console.log(`Simulating a 3-player game against ${URL}\n`);

  // ---------- create + join ----------
  console.log('1. Room creation and joining');
  const alice = new Client('Alice');
  const bob = new Client('Bob');
  const carol = new Client('Carol');
  const clients = [alice, bob, carol];

  await alice.connect();
  alice.send({ type: 'create', name: 'Alice' });
  await alice.until((s) => s.phase === 'lobby', 'Alice in lobby');
  const code = alice.state.code;
  ok(/^[A-HJ-NP-Z2-9]{5}$/.test(code), `room code "${code}" is 5 unambiguous chars`);
  ok(alice.joined.token && alice.joined.playerId, 'Alice got a session token');

  await bob.connect();
  await carol.connect();
  bob.send({ type: 'join', code: code.toLowerCase(), name: 'Bob' }); // lowercase code should work
  carol.send({ type: 'join', code, name: 'Carol' });
  await everyone(clients, (s) => s.players.length === 3, 'all three in lobby');
  ok(alice.state.players.filter((p) => p.isHost).length === 1 &&
     alice.state.players.find((p) => p.isHost).name === 'Alice', 'Alice is the only host');

  // Duplicate name rejected
  const dup = new Client('Dup');
  await dup.connect();
  dup.send({ type: 'join', code, name: 'bob' });
  const dupErr = await dup.waitError('duplicate name');
  ok(/taken/i.test(dupErr.message), 'duplicate name rejected');
  dup.ws.close();

  // Non-host cannot start
  bob.send({ type: 'start' });
  ok(/host/i.test((await bob.waitError('non-host start')).message), 'non-host cannot start the game');

  // ---------- start + level 1 ----------
  console.log('\n2. Game start, ready check, level 1');
  alice.send({ type: 'start' });
  await everyone(clients, (s) => s.phase === 'readyCheck' && s.level === 1, 'level 1 ready check');
  ok(alice.state.lives === 3 && alice.state.shurikens === 1, '3 players → 3 lives, 1 shuriken');
  ok(alice.state.totalLevels === 10, '3 players → 10 levels to win');
  ok(alice.state.hand === null && alice.state.handCount === 1, 'cards hidden until everyone is ready');

  // Playing before ready-up must fail
  carol.send({ type: 'playCard' });
  ok(/only play cards during a level/i.test((await carol.waitError('early play')).message),
    'cannot play a card during the ready check');

  await readyAll(clients, 'level 1');
  ok(clients.every((c) => c.hand.length === 1), 'level 1: everyone sees exactly 1 own card');
  const values = clients.map((c) => c.hand[0]);
  ok(new Set(values).size === 3 && values.every((v) => v >= 1 && v <= 100), `unique cards in 1–100 (${values.join(', ')})`);

  await playOutLevel(clients);
  await everyone(clients, (s) => s.phase === 'levelComplete', 'level 1 complete');
  ok(alice.state.lives === 3, 'no lives lost on a clean level');
  ok(alice.state.lastReward === null, 'level 1 grants no reward');

  // Non-host cannot deal next level
  bob.send({ type: 'nextLevel' });
  ok(/host/i.test((await bob.waitError('non-host nextLevel')).message), 'non-host cannot deal the next level');

  // ---------- level 2: forced mistake ----------
  console.log('\n3. Level 2 — forced mistake (life loss + auto-discard)');
  alice.send({ type: 'nextLevel' });
  await readyAll(clients, 'level 2');
  ok(clients.every((c) => c.hand.length === 2), 'level 2: everyone has 2 cards');

  // The player whose lowest card is highest plays first → guaranteed mistake.
  const sorted = [...clients].sort((a, b) => b.hand[0] - a.hand[0]);
  const offender = sorted[0];
  const playedCard = offender.hand[0];
  const expectedDiscards = clients
    .filter((c) => c !== offender)
    .flatMap((c) => c.hand.filter((v) => v < playedCard))
    .sort((a, b) => a - b);
  ok(expectedDiscards.length > 0, `test setup: ${offender.name} playing ${playedCard} while lower cards exist`);

  offender.send({ type: 'playCard' });
  await everyone(clients, (s) => s.lives === 2, 'life lost after mistake');
  await everyone(clients, (s) => s.phase === 'readyCheck' && s.readyReason === 'lifeLost',
    'game pauses for re-ready after life loss');
  const faceUp = alice.state.players.flatMap((p) => p.discards).sort((a, b) => a - b);
  ok(JSON.stringify(faceUp) === JSON.stringify(expectedDiscards),
    `all cards lower than ${playedCard} auto-discarded face-up (${faceUp.join(', ')})`);
  ok(alice.state.pile[alice.state.pile.length - 1] === playedCard, 'the mistaken card stays on the pile');
  const mistakeEv = alice.state.events.find((e) => e.kind === 'mistake');
  ok(mistakeEv && mistakeEv.card === playedCard, 'mistake event broadcast to everyone');

  for (const c of clients) c.send({ type: 'ready' });
  await everyone(clients, (s) => s.phase === 'playing', 'play resumes after re-ready');

  // ---------- disconnect / reconnect ----------
  console.log('\n4. Disconnect pauses the game; token reconnect restores the seat');
  const bobToken = bob.joined.token;
  const bobHandBefore = [...bob.hand];
  bob.ws.terminate();
  await everyone([alice, carol], (s) => s.players.some((p) => p.name === 'Bob' && !p.connected),
    'Bob marked disconnected');
  alice.send({ type: 'playCard' });
  ok(/paused/i.test((await alice.waitError('play while paused')).message),
    'playing is blocked while a player is disconnected');

  const bob2 = new Client('Bob');
  await bob2.connect();
  bob2.send({ type: 'rejoin', code, token: bobToken });
  await bob2.until((s) => s.phase === 'playing', 'Bob rejoined into the running game');
  await everyone([alice, carol], (s) => s.players.every((p) => p.connected), 'everyone connected again');
  ok(JSON.stringify(bob2.hand) === JSON.stringify(bobHandBefore), 'Bob got his exact hand back after reconnecting');
  clients[clients.indexOf(bob)] = bob2;
  const players2 = [alice, bob2, carol];

  // ---------- finish level 2, check reward ----------
  console.log('\n5. Finish level 2 — completion reward');
  await playOutLevel(players2);
  await everyone(players2, (s) => s.phase === 'levelComplete', 'level 2 complete');
  ok(alice.state.lastReward === 'shuriken', 'completing level 2 rewards a shuriken');
  ok(alice.state.shurikens === 2, 'shuriken count now 2 (1 start + level-2 reward)');
  ok(alice.state.lives === 2, 'lives still 2 (3 start − 1 mistake)');

  // ---------- level 3: shurikens (declined + unanimous) + reward check ----------
  console.log('\n6. Level 3 — declined shuriken, then unanimous shuriken');
  alice.send({ type: 'nextLevel' });
  await readyAll(players2, 'level 3');
  ok(players2.every((c) => c.hand.length === 3), 'level 3: everyone has 3 cards');

  bob2.send({ type: 'proposeShuriken' });
  await everyone(players2, (s) => !!s.vote, 'shuriken vote visible to everyone');
  carol.send({ type: 'voteShuriken', agree: false });
  await everyone(players2, (s) => !s.vote, 'a single decline cancels the vote');
  ok(alice.state.shurikens === 2, 'declined vote does not consume the shuriken');

  const shurikensBefore = alice.state.shurikens;
  const expectedLowest = players2.filter((c) => c.hand.length).map((c) => c.hand[0]).sort((a, b) => a - b);
  const discardsBefore = alice.state.players.flatMap((p) => p.discards).length;

  alice.send({ type: 'proposeShuriken' });
  await everyone(players2, (s) => !!s.vote, 'second shuriken vote opened');
  // A vote in progress blocks card plays.
  carol.send({ type: 'playCard' });
  ok(/vote/i.test((await carol.waitError('play during vote')).message), 'cannot play a card during a shuriken vote');

  bob2.send({ type: 'voteShuriken', agree: true });
  carol.send({ type: 'voteShuriken', agree: true });
  await everyone(players2, (s) => s.shurikens === shurikensBefore - 1, 'shuriken consumed after unanimous vote');
  const discardsAfter = alice.state.players.flatMap((p) => p.discards).length;
  ok(discardsAfter - discardsBefore === expectedLowest.length,
    'every player with cards discarded exactly one card');
  const shEv = alice.state.events.find((e) => e.kind === 'shurikenUsed');
  const thrown = shEv.discarded.map((d) => d.card).sort((a, b) => a - b);
  ok(JSON.stringify(thrown) === JSON.stringify(expectedLowest),
    `shuriken threw exactly the lowest cards, face-up (${thrown.join(', ')})`);
  ok(players2.every((c) => !c.state.vote), 'vote cleared after use');
  ok(players2.every((c) => c.hand.length === 2), 'everyone has 2 cards left after the shuriken');

  console.log('\n7. Finish level 3 — life reward');
  await playOutLevel(players2);
  await everyone(players2, (s) => s.phase === 'levelComplete', 'level 3 complete');
  ok(alice.state.lastReward === 'life' && alice.state.lives === 3, 'completing level 3 rewards +1 life');

  // ---------- anti-cheat ----------
  console.log('\n8. Information hiding');
  for (const c of players2) ok(!c.leakDetected, `${c.name} never received another player's card values (${c.leakDetected || 'clean'})`);

  for (const c of players2) c.ws.close();
  console.log(`\nALL TESTS PASSED (${checks} checks)`);
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
