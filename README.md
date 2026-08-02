# The Mind — online

A real-time multiplayer web version of the cooperative card game **The Mind**, built for
playing with friends over a video call (Zoom / Meet / FaceTime). Everyone opens the app
in a browser, joins the same room code, and plays together while talking on the call.

- 2–6 players (official rules for 2–4; 5–6 use the 4-player level count)
- Server-authoritative: nobody can peek at another player's cards, even with devtools
- Reconnect-safe: drop off the wifi, reopen the page, and you're back in your seat
- No accounts, no build step, one tiny dependency (`ws`)

## Run it locally

```bash
npm install
npm start
```

Open http://localhost:3000 — create a room, then open more tabs (or phones on the same
network) and join with the room code.

The port defaults to `3000`; set `PORT` to change it.

## Deploy for free (so friends can join over the internet)

The app is a single Node process serving HTTP + WebSockets on one port — it works
out of the box on any Node host. Three easy options:

### Render

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Web Service**, pick the repo.
3. Runtime **Node**, build command `npm install`, start command `npm start`.
4. Choose the **Free** instance type and deploy. Share the `https://….onrender.com` URL.

(Free instances sleep when idle — the first visit may take ~30s to wake up.)

### Railway

1. On [railway.app](https://railway.app): **New Project → Deploy from GitHub repo**.
2. Railway auto-detects Node and runs `npm start`. Add a public domain under
   **Settings → Networking → Generate Domain**.

### Fly.io

```bash
fly launch   # accept the defaults; it detects Node and sets internal port 3000
fly deploy
```

All three give you HTTPS, which the app automatically uses for secure WebSockets (`wss://`).

## How to play on a video call (30 seconds)

1. Start your Zoom/Meet call as usual.
2. One player opens the app, clicks **Create a room**, and reads the 5-letter room code
   aloud (or pastes the invite link in the chat).
3. Everyone else opens the same URL — on a laptop next to the call or on their phone —
   enters their name and the code, and joins.
4. The host hits **Start game**. Before each level everyone clicks
   **"I'm ready — hand on the table"**; then your cards appear.
5. Play your lowest card when it *feels* right. Talk, laugh, groan, stare into the
   camera — but **never say anything about your numbers**. That's the whole game.

## Rules recap

- The deck is 1–100. In level *N* everyone gets *N* cards. All cards must be played to
  the central pile in ascending order — no turns, no talking about numbers.
- Only your **lowest** card is ever playable.
- Play too early (someone still holds a lower card) → the team loses a life, all lower
  cards are auto-discarded face-up, and everyone re-readies before play resumes.
- **Shuriken (★):** anyone can propose one; if *everyone* agrees, each player throws
  away their lowest card face-up.
- Levels to win: 2 players → 12, 3 players → 10, 4+ players → 8.
  Starting lives = player count (max 4); 1 starting shuriken.
- Completing a level grants: level 2 → +1★, 3 → +1❤, 5 → +1★, 6 → +1❤, 8 → +1★, 9 → +1❤.
- Lives at 0 → game over. Clear the last level → you are one mind. 🏆

## Development

```
server.js        — authoritative game server (http static files + ws game protocol)
public/          — zero-build frontend (index.html, style.css, app.js)
test/simulate.js — end-to-end 3-player simulation against a running server
```

Run the tests with the server running:

```bash
npm start &          # terminal 1
npm test             # terminal 2 (URL=ws://host:port to point elsewhere)
```

The simulation covers room create/join, ready checks, in-order play, a forced mistake
(life loss + face-up auto-discard + re-ready pause), declined and unanimous shuriken
votes, level rewards, disconnect → pause → token reconnect, and verifies that no
client ever receives another player's card values.
