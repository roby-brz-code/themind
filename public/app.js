'use strict';

/* The Mind — client. Vanilla JS, no build step.
 * The server is authoritative; this file only renders state and sends intents. */

(() => {
  const $ = (sel) => document.querySelector(sel);

  const SESSION_KEY = 'themind_session';

  let ws = null;
  let state = null;          // last server state
  let lastEventId = 0;       // for one-shot event animations
  let pendingAction = null;  // message to send once the socket opens
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let intentionalClose = false;
  let iAmReadyClicked = false;

  // ---------- session ----------
  const loadSession = () => {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
  };
  const saveSession = (s) => localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  const clearSession = () => localStorage.removeItem(SESSION_KEY);

  // ---------- websocket ----------
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}`;
  }

  function connect(action) {
    pendingAction = action || pendingAction;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      if (ws.readyState === WebSocket.OPEN && pendingAction) {
        ws.send(JSON.stringify(pendingAction));
        pendingAction = null;
      }
      return;
    }
    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      reconnectDelay = 1000;
      if (pendingAction) {
        ws.send(JSON.stringify(pendingAction));
        pendingAction = null;
      } else {
        const sess = loadSession();
        if (sess) ws.send(JSON.stringify({ type: 'rejoin', code: sess.code, token: sess.token }));
      }
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleMessage(msg);
    };

    ws.onclose = () => {
      ws = null;
      if (intentionalClose) { intentionalClose = false; return; }
      const sess = loadSession();
      if (sess && state) {
        setHomeStatus('Connection lost — reconnecting…');
        toast('Connection lost — reconnecting…', 'bad');
        scheduleReconnect();
      } else if (sess) {
        scheduleReconnect();
      }
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
      connect();
    }, reconnectDelay);
  }

  function sendMsg(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // ---------- message handling ----------
  function handleMessage(msg) {
    if (msg.type === 'joined') {
      saveSession({ code: msg.code, token: msg.token, name: msg.name });
      setHomeStatus('');
      setHomeError('');
      return;
    }
    if (msg.type === 'state') {
      const prev = state;
      state = msg;
      processEvents(prev, msg);
      render();
      return;
    }
    if (msg.type === 'error') {
      const fatal = /Session expired|no longer exists|Room not found|game is in progress|name is already taken|Room is full/i.test(msg.message);
      if (!state) {
        // Still on the home screen.
        if (msg.action === 'rejoin') {
          clearSession();
          setHomeStatus('');
          if (!/no longer exists|Session expired/.test(msg.message)) setHomeError(msg.message);
        } else {
          setHomeError(msg.message);
        }
        if (fatal) { intentionalClose = true; if (ws) ws.close(); ws = null; }
      } else {
        toast(msg.message, 'bad');
      }
    }
  }

  function processEvents(prev, s) {
    const fresh = (s.events || []).filter((ev) => ev.id > lastEventId);
    if (!prev) {
      // First state after (re)connect: don't replay old animations.
      lastEventId = fresh.length ? fresh[fresh.length - 1].id : lastEventId;
      return;
    }
    for (const ev of fresh) {
      lastEventId = ev.id;
      animateEvent(ev, s);
    }
  }

  function animateEvent(ev, s) {
    const me = s.you;
    switch (ev.kind) {
      case 'cardPlayed':
        if (ev.playerId !== me) toast(`${ev.name} played ${ev.card}`, 'good');
        break;
      case 'mistake': {
        flash('life-lost');
        shake();
        bump('#hud-lives');
        const lost = ev.busted.flatMap((b) => b.cards).sort((a, b) => a - b).join(', ');
        toast(`💔 ${ev.name} played ${ev.card} too early — lost a life! Discarded: ${lost}`, 'bad', 5000);
        break;
      }
      case 'shurikenProposed':
        if (ev.playerId !== me) toast(`★ ${ev.name} proposes a shuriken`, 'gold');
        break;
      case 'shurikenDeclined':
        toast(ev.reason === 'disconnect'
          ? 'Shuriken vote cancelled (player disconnected)'
          : `${ev.name} declined the shuriken`, 'gold');
        break;
      case 'shurikenUsed': {
        flash('shuriken');
        bump('#hud-shurikens');
        const cards = ev.discarded.map((d) => `${d.name}: ${d.card}`).join(' · ');
        toast(`★ Shuriken! Lowest cards thrown: ${cards}`, 'gold', 5000);
        break;
      }
      case 'levelComplete':
        if (ev.reward === 'life') bump('#hud-lives');
        if (ev.reward === 'shuriken') bump('#hud-shurikens');
        break;
      case 'playerJoined': toast(`${ev.name} joined the room`); break;
      case 'playerLeft': toast(`${ev.name} left the room`); break;
      case 'playerDisconnected': toast(`${ev.name} disconnected`, 'bad'); break;
      case 'playerReconnected': toast(`${ev.name} is back!`, 'good'); break;
      default: break;
    }
  }

  // ---------- tiny effect helpers ----------
  function toast(text, cls = '', ms = 3200) {
    const el = document.createElement('div');
    el.className = `toast ${cls}`;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 350);
    }, ms);
  }

  function flash(cls) {
    const el = $('#flash');
    el.className = '';
    void el.offsetWidth; // restart animation
    el.className = cls;
  }

  function shake() {
    const el = $('#screen-game');
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }

  function bump(sel) {
    const el = $(sel);
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  const setHomeError = (t) => { $('#home-error').textContent = t || ''; };
  const setHomeStatus = (t) => { $('#home-status').textContent = t || ''; };

  // ---------- rendering ----------
  function showScreen(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
    $(id).classList.remove('hidden');
  }

  function render() {
    if (!state) { showScreen('#screen-home'); return; }
    if (state.phase === 'lobby') {
      renderLobby();
      showScreen('#screen-lobby');
      return;
    }
    renderGame();
    showScreen('#screen-game');
  }

  function me() { return state.players.find((p) => p.id === state.you); }
  const iAmActingHost = () => state.actingHostId === state.you;

  function renderLobby() {
    $('#lobby-code').textContent = state.code;
    const list = $('#lobby-players');
    list.innerHTML = '';
    for (const p of state.players) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = p.name;
      li.appendChild(name);
      if (p.id === state.you) {
        const you = document.createElement('span');
        you.className = 'you-tag';
        you.textContent = '(you)';
        li.appendChild(you);
      }
      if (p.isHost) {
        const host = document.createElement('span');
        host.className = 'host-tag';
        host.textContent = '👑 host';
        li.appendChild(host);
      }
      list.appendChild(li);
    }
    const n = state.players.length;
    const isHost = iAmActingHost();
    $('#btn-start').classList.toggle('hidden', !isHost);
    $('#btn-start').disabled = n < 2;
    $('#lobby-hint').textContent =
      n < 2 ? 'Waiting for at least one more player…'
        : isHost ? `${n} players in — start when everyone's on the call.`
          : 'Waiting for the host to start the game…';
  }

  function renderGame() {
    const s = state;
    const my = me();

    // HUD
    $('#hud-level').textContent = `Level ${s.level} / ${s.totalLevels}`;
    $('#hud-code').textContent = s.code;
    $('#hud-lives').textContent = s.lives <= 6 ? '❤'.repeat(Math.max(s.lives, 0)) || '💔' : `❤ × ${s.lives}`;
    $('#hud-shurikens').textContent = s.shurikens <= 5 ? ('★'.repeat(s.shurikens) || '☆') : `★ × ${s.shurikens}`;

    renderOpponents(s);
    renderPile(s);
    renderHand(s, my);
    renderPauseBanner(s);
    renderOverlays(s, my);
  }

  function renderOpponents(s) {
    const wrap = $('#opponents');
    wrap.innerHTML = '';
    for (const p of s.players) {
      if (p.id === s.you) continue;
      const el = document.createElement('div');
      el.className = 'opponent' + (p.connected ? '' : ' disconnected');

      const name = document.createElement('div');
      name.className = 'opp-name';
      name.innerHTML = p.isHost ? `<span class="crown">👑</span> ` : '';
      name.appendChild(document.createTextNode(p.name));
      el.appendChild(name);

      const backs = document.createElement('div');
      backs.className = 'opp-backs';
      if (p.revealed && p.revealed.length) {
        // Game over: show what they were holding.
        for (const c of p.revealed) {
          const chip = document.createElement('span');
          chip.className = 'discard-chip';
          chip.style.textDecoration = 'none';
          chip.textContent = c;
          backs.appendChild(chip);
        }
      } else if (p.cardCount > 0) {
        for (let i = 0; i < Math.min(p.cardCount, 8); i++) {
          backs.appendChild(Object.assign(document.createElement('div'), { className: 'card-back' }));
        }
        const n = document.createElement('span');
        n.className = 'back-count';
        n.textContent = p.cardCount;
        backs.appendChild(n);
      } else {
        const done = document.createElement('span');
        done.className = 'no-cards';
        done.textContent = 'no cards';
        backs.appendChild(done);
      }
      el.appendChild(backs);

      const status = document.createElement('div');
      status.className = 'opp-status';
      if (!p.connected) { status.textContent = 'reconnecting…'; status.classList.add('bad'); }
      else if (s.phase === 'readyCheck') { status.textContent = p.ready ? 'ready ✓' : 'not ready'; status.classList.toggle('ok', p.ready); }
      else if (s.vote) { status.textContent = p.voted ? 'agreed ★' : 'deciding…'; status.classList.toggle('ok', p.voted); }
      el.appendChild(status);

      if (p.discards.length) {
        const d = document.createElement('div');
        d.className = 'discard-row';
        for (const c of p.discards) {
          const chip = document.createElement('span');
          chip.className = 'discard-chip';
          chip.textContent = c;
          d.appendChild(chip);
        }
        el.appendChild(d);
      }
      wrap.appendChild(el);
    }
  }

  function renderPile(s) {
    const pile = $('#pile');
    pile.innerHTML = '';
    if (!s.pile.length) {
      const slot = document.createElement('div');
      slot.className = 'pile-slot';
      slot.textContent = '1–100';
      pile.appendChild(slot);
    } else {
      const cards = s.pile.slice(-3);
      cards.forEach((c, i) => {
        const el = document.createElement('div');
        const depth = cards.length - 1 - i; // 0 = top
        el.className = 'pile-card' + (depth === 0 ? ' top-card' : ` under-${depth}`);
        el.innerHTML = `<span class="corner">${c}</span>${c}`;
        pile.appendChild(el);
      });
    }
    $('#pile-caption').textContent = s.pileCount
      ? `${s.pileCount} card${s.pileCount === 1 ? '' : 's'} played`
      : 'Play cards in ascending order';
  }

  function renderHand(s, my) {
    const hand = $('#hand');
    hand.innerHTML = '';
    const canPlay = s.phase === 'playing' && !s.vote && s.players.every((p) => p.connected);

    if (s.hand === null) {
      // Cards dealt but hidden until everyone is ready.
      for (let i = 0; i < s.handCount; i++) {
        const back = document.createElement('div');
        back.className = 'card-back';
        back.style.width = '58px';
        back.style.height = '84px';
        back.style.marginLeft = i ? '-20px' : '0';
        back.style.alignSelf = 'center';
        hand.appendChild(back);
      }
    } else if (s.hand.length === 0) {
      const note = document.createElement('div');
      note.className = 'hand-empty-note';
      note.textContent = ['gameOver', 'won', 'levelComplete'].includes(s.phase) ? '' : 'All your cards are out — cheer the others on! 🎉';
      hand.appendChild(note);
    } else {
      const n = s.hand.length;
      const spread = Math.min(5, 36 / n);
      s.hand.forEach((c, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hand-card' + (i === 0 && canPlay ? ' playable' : '');
        btn.disabled = !(i === 0 && canPlay);
        btn.innerHTML = `<span class="corner">${c}</span>${c}`;
        const angle = (i - (n - 1) / 2) * spread;
        const lift = Math.abs(i - (n - 1) / 2) * (n > 1 ? 6 : 0);
        btn.style.transform = `rotate(${angle}deg) translateY(${lift}px)`;
        btn.style.zIndex = i + 1;
        if (i === 0 && canPlay) {
          btn.addEventListener('click', () => {
            btn.classList.add('leaving');
            sendMsg({ type: 'playCard' });
          }, { once: true });
        }
        hand.appendChild(btn);
      });
    }

    // Own discards + shuriken button
    const myDis = $('#my-discards');
    myDis.innerHTML = '';
    if (my && my.discards.length) {
      for (const c of my.discards) {
        const chip = document.createElement('span');
        chip.className = 'discard-chip';
        chip.textContent = c;
        myDis.appendChild(chip);
      }
    }
    const shBtn = $('#btn-shuriken');
    shBtn.classList.toggle('hidden', !(s.phase === 'playing' && !s.vote && s.shurikens > 0));
  }

  function renderPauseBanner(s) {
    const banner = $('#pause-banner');
    const gone = s.players.filter((p) => !p.connected);
    const showPause = gone.length && ['playing'].includes(s.phase);
    if (showPause) {
      banner.innerHTML = `<span class="spin">⏳</span> Game paused — waiting for <b>${gone.map((p) => escapeHtml(p.name)).join(', ')}</b> to reconnect`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  function renderOverlays(s, my) {
    // Ready check
    const readyOv = $('#overlay-ready');
    if (s.phase === 'readyCheck') {
      readyOv.classList.remove('hidden');
      const lifeLost = s.readyReason === 'lifeLost';
      $('#ready-title').textContent = lifeLost ? '💔 Life lost — regroup' : `Level ${s.level}`;
      $('#ready-sub').textContent = lifeLost
        ? 'Take a breath together. Play resumes when everyone puts a hand back on the table.'
        : `Each player gets ${s.level} card${s.level === 1 ? '' : 's'}. They stay face-down until everyone is ready.`;
      const list = $('#ready-list');
      list.innerHTML = '';
      for (const p of s.players) {
        const li = document.createElement('li');
        const nm = document.createElement('span');
        nm.textContent = p.name + (p.id === s.you ? ' (you)' : '');
        const st = document.createElement('span');
        st.className = 'state';
        if (!p.connected) { st.textContent = 'disconnected'; st.classList.add('bad'); }
        else if (p.ready) { st.textContent = 'ready ✓'; st.classList.add('ok'); }
        else st.textContent = 'not ready';
        li.append(nm, st);
        list.appendChild(li);
      }
      const amReady = my && my.ready;
      if (!amReady) iAmReadyClicked = false;
      $('#btn-ready').classList.toggle('hidden', !!amReady);
      $('#btn-ready').disabled = iAmReadyClicked;
      $('#ready-waiting').classList.toggle('hidden', !amReady);
    } else {
      readyOv.classList.add('hidden');
      iAmReadyClicked = false;
    }

    // Shuriken vote
    const voteOv = $('#overlay-vote');
    if (s.vote && s.phase === 'playing') {
      voteOv.classList.remove('hidden');
      const proposer = s.players.find((p) => p.id === s.vote.proposerId);
      $('#vote-text').textContent = `${proposer ? proposer.name : 'Someone'} wants to throw a shuriken (${s.shurikens} left).`;
      const list = $('#vote-list');
      list.innerHTML = '';
      for (const p of s.players) {
        const li = document.createElement('li');
        const nm = document.createElement('span');
        nm.textContent = p.name + (p.id === s.you ? ' (you)' : '');
        const st = document.createElement('span');
        st.className = 'state' + (p.voted ? ' ok' : '');
        st.textContent = p.voted ? 'agreed ★' : 'deciding…';
        li.append(nm, st);
        list.appendChild(li);
      }
      const iVoted = my && my.voted;
      $('#vote-buttons').classList.toggle('hidden', !!iVoted);
      $('#vote-waiting').classList.toggle('hidden', !iVoted);
    } else {
      voteOv.classList.add('hidden');
    }

    // Level complete
    const levelOv = $('#overlay-level');
    if (s.phase === 'levelComplete') {
      levelOv.classList.remove('hidden');
      $('#level-done-title').textContent = `✨ Level ${s.level} complete!`;
      $('#level-reward').textContent =
        s.lastReward === 'life' ? '+1 life ❤' : s.lastReward === 'shuriken' ? '+1 shuriken ★' : '';
      const isHost = iAmActingHost();
      $('#btn-next-level').classList.toggle('hidden', !isHost);
      $('#btn-next-level').textContent = `Deal level ${s.level + 1} →`;
      $('#level-waiting').classList.toggle('hidden', isHost);
    } else {
      levelOv.classList.add('hidden');
    }

    // End of game
    const endOv = $('#overlay-end');
    if (s.phase === 'gameOver' || s.phase === 'won') {
      endOv.classList.remove('hidden');
      endOv.classList.toggle('won', s.phase === 'won');
      endOv.classList.toggle('lost', s.phase === 'gameOver');
      if (s.phase === 'won') {
        $('#end-title').textContent = '🏆 You are one mind!';
        $('#end-sub').textContent = `You conquered all ${s.totalLevels} levels together.`;
      } else {
        $('#end-title').textContent = '💔 Game over';
        $('#end-sub').textContent = `Out of lives on level ${s.level}. The cards everyone still held are shown on the table.`;
      }
      const isHost = iAmActingHost();
      $('#btn-play-again').classList.toggle('hidden', !isHost);
      $('#end-waiting').classList.toggle('hidden', isHost);
    } else {
      endOv.classList.add('hidden');
    }
  }

  function escapeHtml(t) {
    const d = document.createElement('span');
    d.textContent = t;
    return d.innerHTML;
  }

  // ---------- UI wiring ----------
  $('#btn-create').addEventListener('click', () => {
    const name = $('#name-input').value.trim();
    if (!name) return setHomeError('Enter your name first');
    setHomeError('');
    setHomeStatus('Creating room…');
    connect({ type: 'create', name });
  });

  $('#btn-join').addEventListener('click', joinRoom);
  $('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('#name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-create').click(); });

  function joinRoom() {
    const name = $('#name-input').value.trim();
    const code = $('#code-input').value.trim().toUpperCase();
    if (!name) return setHomeError('Enter your name first');
    if (code.length < 4) return setHomeError('Enter the room code');
    setHomeError('');
    setHomeStatus('Joining room…');
    connect({ type: 'join', name, code });
  }

  $('#btn-copy').addEventListener('click', async () => {
    const link = `${location.origin}/?room=${state ? state.code : ''}`;
    try {
      await navigator.clipboard.writeText(`Join my game of The Mind! ${link} — room code ${state.code}`);
      toast('Invite copied to clipboard', 'good');
    } catch {
      toast(`Room code: ${state.code}`);
    }
  });

  $('#btn-start').addEventListener('click', () => sendMsg({ type: 'start' }));
  $('#btn-ready').addEventListener('click', () => {
    iAmReadyClicked = true;
    $('#btn-ready').disabled = true;
    sendMsg({ type: 'ready' });
  });
  $('#btn-shuriken').addEventListener('click', () => sendMsg({ type: 'proposeShuriken' }));
  $('#btn-vote-yes').addEventListener('click', () => sendMsg({ type: 'voteShuriken', agree: true }));
  $('#btn-vote-no').addEventListener('click', () => sendMsg({ type: 'voteShuriken', agree: false }));
  $('#btn-next-level').addEventListener('click', () => sendMsg({ type: 'nextLevel' }));
  $('#btn-play-again').addEventListener('click', () => sendMsg({ type: 'playAgain' }));

  function leaveRoom() {
    intentionalClose = true;
    clearSession();
    if (ws) ws.close();
    ws = null;
    state = null;
    lastEventId = 0;
    setHomeStatus('');
    render();
  }
  $('#btn-leave').addEventListener('click', leaveRoom);
  $('#btn-end-leave').addEventListener('click', leaveRoom);

  // ---------- boot ----------
  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('#code-input').value = params.get('room').toUpperCase();

  const sess = loadSession();
  if (sess) {
    if (sess.name) $('#name-input').value = sess.name;
    setHomeStatus('Reconnecting to your game…');
    connect();
  }

  render();
})();
