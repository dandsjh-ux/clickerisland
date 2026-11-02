# 🏝️ Clicker Island Wars

A multiplayer browser game built with **three.js** and **Socket.IO**. Answer island-themed English quiz questions (Year 3 to Year 7) to earn coins, build up your island's defences and army, then raid rival islands during timed PVP rounds. Knock out every enemy **Central Command** to win.

Works on desktop and mobile browsers (touch controls, bottom-sheet UI, safe-area aware).

## Game loop

| Phase | Default length | What you do |
|---|---|---|
| 🔨 Build | 10 min | Answer quizzes, tap for coins, collect Coin Mints, build and upgrade walls, turrets, traps and guard posts, and train troops and ships |
| ⚔️ PVP | 3 min | Pick an enemy island and deploy land troops on its beach or warships in its outer sea. Your own defences fight off invaders automatically |

Phases repeat for the chosen number of rounds. A player whose Central Command is destroyed is eliminated, and the last island standing wins. If the rounds run out first, the highest **War Score** wins (+10 per building destroyed, +50 per Command, +1 per invader your defences stop). The host sets build time, PVP time, rounds and max players in the lobby.

## Earning coins (quiz first!)

- **📚 Quiz:** 127 island-themed English questions across Years 3–7 (25–26 per year): grammar, punctuation, spelling, vocabulary, figurative language and inference. Rewards scale with difficulty: Y3 40, Y4 60, Y5 85, Y6 115, Y7 150 coins. A streak adds +10% per correct answer in a row (up to +50%), and the Island Library adds +15% per level. A wrong answer shows the correct one with an explanation, then pauses for a moment.
- **👆 Tap:** tap the coin button or your Central Command (+1 per tap, upgradable to +10, rate-limited on the server).
- **🪙 Coin Mints** fill up over time. Tap them to collect.
- **Loot and bounty:** destroying enemy buildings pays loot, and your defences earn a bounty for every invader they stop.

## Buildings

| Defence | Role |
|---|---|
| 🧱 Wall | Blocks land troops (5 visual tiers by level) |
| 💣 Cannon | Hits troops and ships |
| 🏹 Archer Tower | Fast, long-range shots at troops and ships |
| 🎯 Mortar | Splash damage against groups of troops, with a minimum range |
| 🗼 Coastal Battery | Heavy anti-ship guns with very long range |
| 💂 Guard Post | Sends out defender units that fight invaders, then return and respawn |
| 📌 Spike Trap / 💥 Bomb Trap | Hidden land traps (spikes re-arm, bombs fire once) |
| 🌀 Sea Mine | Hidden mine in the shallows that blasts ships |

Economy and army buildings: Central Command (2×2, has a small built-in cannon), Coin Mint, Island Library, Barracks (troop space), Shipyard (ship space). Upgrading the Command unlocks more of each building and higher levels.

## Units

| Land (deploy on the beach) | Sea (deploy in the outer sea) |
|---|---|
| 🗡️ Raider: cheap melee | 🚤 Gunboat: fast, short range |
| 🏹 Archer: shoots over walls | ⛵ Frigate: balanced |
| 🪨 Brute: tank that targets defences | 🚢 Battleship: long-range splash |
| 🧨 Sapper: blows up walls | |

Ships can only reach buildings near the coast, so you need land troops to finish off a central Command. Each unit type can be upgraded up to level 5, capped by your Barracks/Shipyard level.

## Controls

- **Desktop:** drag to pan, right-drag to rotate, scroll to zoom. Keys: `Q` quiz, `B` build, `A` army, `Space` tap, `1`–`4` answer, `Enter` next question, `H` home, `Esc` cancel.
- **Mobile:** drag to pan, pinch to zoom and rotate. When placing a building, the first tap previews it and a second tap (or ✔ Here) confirms.

## Run locally

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. To try multiplayer on one machine, open a second browser tab (each tab is a separate player) and join with the 4-letter room code. **Play vs Bots** gives you an instant AI opponent.

## Deploy to Render

1. Push this folder to a GitHub or GitLab repository.
2. In Render, choose **New → Blueprint** and select the repo (it reads `render.yaml`), or choose **New → Web Service** with:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/healthz`
3. Share the URL. Players use **Quick Match** or a room code (the 📋 button copies an invite link).

Notes:
- Render provides `PORT` automatically and supports WebSockets on web services.
- All game state is in memory. A redeploy or restart ends games in progress, and free instances sleep when idle (the first visit after that takes a few seconds to wake up).
- Run a single instance. Rooms live in one process, so horizontal scaling would need a shared adapter such as Redis.

## Project structure

```
server/
  index.js      Express static server + Socket.IO connection handling
  game.js       Rooms, players, phases, economy and every validated action
  battle.js     10 Hz server-side battle simulation (A* land pathing, sea BFS, defences, traps, guards)
  bot.js        AI opponent (answers quizzes, builds a walled base, raids during PVP)
  questions.js  Year 3–7 question bank (first answer is correct; options are shuffled server-side)
shared/
  config.js     Game rules shared by server and client (stats, costs, limits, grid)
public/
  index.html, css/style.css
  js/main.js    Client app: networking, HUD, panels, input modes
  js/world.js   three.js scene: terrain, water shader, buildings, units, effects, picking
  js/models.js  Procedural low-poly models (merged per model for few draw calls)
  js/sfx.js     Synthesised sound effects
```

The server is authoritative. Clients only send intents (tap, answer, build, deploy), and quiz answers never leave the server until a question has been answered.

## Tuning

Everything balance-related lives in `shared/config.js`: building and unit stats, costs, limits per Command level, quiz rewards, streak bonus, tap rate and starting resources. Add questions in `server/questions.js` (put the correct answer first).
