'use strict';

/* The Mind — client. Vanilla JS, no build step.
 * The server is authoritative; this file only renders state and sends intents. */

(() => {
  const $ = (sel) => document.querySelector(sel);

  const SESSION_KEY = 'themind_session';
  const AVATAR_KEY = 'themind_avatar';

  // Keep in sync with the server's allowed sets (server validates anyway).
  const AVATARS = ['🦊', '🐼', '🐸', '🦉', '🐙', '🦄', '🐯', '🐨', '🐺', '🦁', '🐵', '🐹'];
  const EMOTES = ['🙌', '👏', '🔥', '😱', '😅', '❤️', '🤯', '🎉'];

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

  function avatarOf(s, playerId) {
    const p = s.players.find((x) => x.id === playerId);
    return p && p.avatar ? p.avatar : '';
  }

  function animateEvent(ev, s) {
    const me = s.you;
    switch (ev.kind) {
      case 'cardPlayed':
        if (ev.playerId !== me) {
          flyCardToPile(ev.playerId);
          toast(`${avatarOf(s, ev.playerId)} ${ev.name} played ${ev.card}`, 'good');
        }
        break;
      case 'mistake': {
        if (ev.playerId !== me) flyCardToPile(ev.playerId);
        flash('life-lost');
        shake();
        bump('#hud-lives');
        const lost = ev.busted.flatMap((b) => b.cards).sort((a, b) => a - b).join(', ');
        toast(`💔 ${ev.name} played ${ev.card} too early — lost a life! Discarded: ${lost}`, 'bad', 5000);
        break;
      }
      case 'starProposed':
        if (ev.playerId !== me) toast(`★ ${ev.name} proposes a star`, 'gold');
        break;
      case 'starDeclined':
        toast(ev.reason === 'disconnect'
          ? 'Star vote cancelled (player disconnected)'
          : `${ev.name} declined the star`, 'gold');
        break;
      case 'starUsed': {
        flash('star');
        bump('#hud-stars');
        const cards = ev.discarded.map((d) => `${d.name}: ${d.card}`).join(' · ');
        toast(`★ Star! Lowest cards thrown: ${cards}`, 'gold', 5000);
        break;
      }
      case 'concentrate':
        if (ev.playerId !== me) toast(`🧘 ${ev.name} asks everyone to concentrate`, 'gold');
        break;
      case 'emote':
        floatEmote(ev.playerId, ev.emote, s);
        break;
      case 'levelComplete':
        if (ev.reward === 'life') bump('#hud-lives');
        if (ev.reward === 'star') bump('#hud-stars');
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

  /** Where a player visually "sits": their seat card, or my hand area for me. */
  function seatEl(playerId) {
    if (state && playerId === state.you) return $('#me-area');
    return document.querySelector(`.opponent[data-player-id="${playerId}"]`) || $('#table');
  }

  /** An emote rises from the sender's seat and fades out. Purely cosmetic. */
  function floatEmote(playerId, emote, s) {
    const seat = seatEl(playerId);
    if (!seat) return;
    const r = seat.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'emote-float';
    el.textContent = emote;
    el.style.left = `${r.left + r.width / 2 + (Math.random() * 40 - 20)}px`;
    el.style.top = `${r.top}px`;
    document.body.appendChild(el);
    const from = s && playerId !== s.you ? avatarOf(s, playerId) : '';
    if (from) {
      const tag = document.createElement('span');
      tag.className = 'emote-from';
      tag.textContent = from;
      el.appendChild(tag);
    }
    setTimeout(() => el.remove(), 1900);
  }

  /** A face-down card flies from an opponent's fan to the pile and flips. */
  function flyCardToPile(playerId) {
    const seat = document.querySelector(`.opponent[data-player-id="${playerId}"]`);
    const fan = seat && seat.querySelector('.card-back');
    const pile = $('#pile');
    if (!fan || !pile) return;
    const from = fan.getBoundingClientRect();
    const to = pile.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'card-back fly-card';
    ghost.style.left = `${from.left}px`;
    ghost.style.top = `${from.top}px`;
    ghost.style.width = `${from.width}px`;
    ghost.style.height = `${from.height}px`;
    document.body.appendChild(ghost);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const scale = (to.width * 0.85) / from.width;
    requestAnimationFrame(() => {
      ghost.style.transform = `translate(${dx}px, ${dy}px) rotateY(540deg) scale(${scale})`;
      ghost.style.opacity = '0';
    });
    setTimeout(() => ghost.remove(), 600);
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
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = p.avatar || '';
      li.appendChild(av);
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
    $('#hud-stars').textContent = s.stars <= 5 ? ('★'.repeat(s.stars) || '☆') : `★ × ${s.stars}`;

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
      el.dataset.playerId = p.id;

      const name = document.createElement('div');
      name.className = 'opp-name';
      name.innerHTML = p.isHost ? `<span class="crown">👑</span> ` : '';
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = p.avatar || '';
      name.appendChild(av);
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
        // Hearthstone-style fan: one face-down back per held card, arced.
        const n = Math.min(p.cardCount, 12);
        const spread = Math.min(9, 60 / n);
        for (let i = 0; i < n; i++) {
          const back = document.createElement('div');
          back.className = 'card-back fanned';
          const angle = (i - (n - 1) / 2) * spread;
          const lift = Math.abs(i - (n - 1) / 2) * (n > 1 ? 2.2 : 0);
          back.style.transform = `rotate(${angle}deg) translateY(${lift}px)`;
          back.style.zIndex = i + 1;
          backs.appendChild(back);
        }
        const badge = document.createElement('span');
        badge.className = 'back-count';
        badge.textContent = p.cardCount;
        backs.appendChild(badge);
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

    // Everything revealed this level, in order — plays and face-up discards.
    const hist = $('#pile-history');
    hist.innerHTML = '';
    for (const h of s.history || []) {
      const chip = document.createElement('span');
      chip.className = `hist-chip ${h.kind}`;
      chip.title = h.kind === 'discard' ? 'discarded face-up' : 'played';
      chip.textContent = h.card;
      hist.appendChild(chip);
    }
    hist.classList.toggle('hidden', !(s.history || []).length);
    if (hist.lastChild) hist.scrollLeft = hist.scrollWidth;
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
        if (i === 0 && canPlay) makePlayable(btn);
        hand.appendChild(btn);
      });
    }

    // Own discards + action bar buttons
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
    const starBtn = $('#btn-star');
    starBtn.classList.toggle('hidden', !(s.phase === 'playing' && !s.vote && s.stars > 0));
    $('#btn-concentrate').classList.toggle('hidden', !(s.phase === 'playing' && !s.vote));
    $('#emote-bar').classList.toggle('hidden', !['playing', 'readyCheck'].includes(s.phase));
  }

  // ---------- drag / click to play ----------
  let cardPlayed = false; // guards against double-sends per rendered card

  function playCardNow(btn) {
    if (cardPlayed) return;
    cardPlayed = true;
    btn.classList.add('leaving');
    sendMsg({ type: 'playCard' });
  }

  function overPile(x, y) {
    const r = $('#pile').getBoundingClientRect();
    const pad = 30; // generous drop zone
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  }

  /** Click OR pointer-drag the lowest card onto the pile. */
  function makePlayable(btn) {
    cardPlayed = false;
    const baseTransform = btn.style.transform;
    let startX = 0, startY = 0, dragging = false, moved = false;

    btn.addEventListener('click', () => { if (!moved) playCardNow(btn); });

    btn.addEventListener('pointerdown', (e) => {
      if (btn.disabled || cardPlayed) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      btn.setPointerCapture(e.pointerId);
    });

    btn.addEventListener('pointermove', (e) => {
      if (!dragging || cardPlayed) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 8) return; // still a tap
      moved = true;
      btn.classList.add('dragging');
      btn.style.transform = `translate(${dx}px, ${dy}px) rotate(0deg) scale(1.06)`;
      $('#pile').classList.toggle('drop-target', overPile(e.clientX, e.clientY));
    });

    const finish = (e, cancelled) => {
      if (!dragging) return;
      dragging = false;
      $('#pile').classList.remove('drop-target');
      if (!moved) return; // plain tap → the click handler plays it
      if (!cancelled && overPile(e.clientX, e.clientY)) {
        btn.style.transform = '';
        playCardNow(btn);
      } else {
        // Snap back into the fan.
        btn.classList.add('snapping');
        btn.style.transform = baseTransform;
        setTimeout(() => btn.classList.remove('dragging', 'snapping'), 220);
      }
    };
    btn.addEventListener('pointerup', (e) => finish(e, false));
    btn.addEventListener('pointercancel', (e) => finish(e, true));
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
      const concentrate = s.readyReason === 'concentrate';
      const caller = concentrate ? s.players.find((p) => p.id === s.concentratorId) : null;
      $('#ready-title').textContent = lifeLost ? '💔 Life lost — regroup'
        : concentrate ? '🧘 Concentrate'
          : `Level ${s.level}`;
      $('#ready-sub').textContent = lifeLost
        ? 'Take a breath together. Play resumes when everyone puts a hand back on the table.'
        : concentrate
          ? `${caller ? `${caller.avatar || ''} ${caller.name}`.trim() : 'Someone'} asks everyone to concentrate — hands on the table. Play resumes when everyone is ready again.`
          : `Each player gets ${s.level} card${s.level === 1 ? '' : 's'}. They stay face-down until everyone is ready.`;
      const list = $('#ready-list');
      list.innerHTML = '';
      for (const p of s.players) {
        const li = document.createElement('li');
        const nm = document.createElement('span');
        nm.className = 'with-avatar';
        nm.textContent = `${p.avatar || ''} ${p.name}${p.id === s.you ? ' (you)' : ''}`.trim();
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

    // Star vote
    const voteOv = $('#overlay-vote');
    if (s.vote && s.phase === 'playing') {
      voteOv.classList.remove('hidden');
      const proposer = s.players.find((p) => p.id === s.vote.proposerId);
      $('#vote-text').textContent = `${proposer ? `${proposer.avatar || ''} ${proposer.name}`.trim() : 'Someone'} wants to throw a star (${s.stars} left).`;
      const list = $('#vote-list');
      list.innerHTML = '';
      for (const p of s.players) {
        const li = document.createElement('li');
        const nm = document.createElement('span');
        nm.textContent = `${p.avatar || ''} ${p.name}${p.id === s.you ? ' (you)' : ''}`.trim();
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
        s.lastReward === 'life' ? '+1 life ❤' : s.lastReward === 'star' ? '+1 star ★' : '';
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

  // ---------- avatar picker ----------
  let myAvatar = localStorage.getItem(AVATAR_KEY);
  if (!AVATARS.includes(myAvatar)) {
    myAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
  }

  function renderAvatarPicker() {
    const picker = $('#avatar-picker');
    picker.innerHTML = '';
    for (const a of AVATARS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'avatar-option' + (a === myAvatar ? ' selected' : '');
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', a === myAvatar ? 'true' : 'false');
      btn.textContent = a;
      btn.addEventListener('click', () => {
        myAvatar = a;
        localStorage.setItem(AVATAR_KEY, a);
        renderAvatarPicker();
      });
      picker.appendChild(btn);
    }
  }
  renderAvatarPicker();

  // ---------- emote bar ----------
  let lastEmoteSent = 0;
  const emoteBar = $('#emote-bar');
  for (const e of EMOTES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emote-btn';
    btn.textContent = e;
    btn.title = 'Send to everyone';
    btn.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastEmoteSent < 1000) return; // mirror the server's rate limit
      lastEmoteSent = now;
      sendMsg({ type: 'emote', emote: e });
    });
    emoteBar.appendChild(btn);
  }

  // ---------- UI wiring ----------
  $('#btn-create').addEventListener('click', () => {
    const name = $('#name-input').value.trim();
    if (!name) return setHomeError('Enter your name first');
    setHomeError('');
    setHomeStatus('Creating room…');
    connect({ type: 'create', name, avatar: myAvatar });
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
    connect({ type: 'join', name, code, avatar: myAvatar });
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
  $('#btn-star').addEventListener('click', () => sendMsg({ type: 'proposeStar' }));
  $('#btn-concentrate').addEventListener('click', () => sendMsg({ type: 'concentrate' }));
  $('#btn-vote-yes').addEventListener('click', () => sendMsg({ type: 'voteStar', agree: true }));
  $('#btn-vote-no').addEventListener('click', () => sendMsg({ type: 'voteStar', agree: false }));
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
