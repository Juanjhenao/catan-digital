# Colonos — Digital Catan

**A complete implementation of the Catan board game in TypeScript**, with a procedurally drawn 3D board, bots at three difficulty levels and local-network multiplayer with an authoritative server.

### ▶ [Play in your browser](https://juanjhenao.github.io/catan-digital/)

No install needed: play against bots or hot-seat on the same device. Local-network multiplayer needs the server from this repo (`npm run lan`).

![Match between four bots](docs/demo.gif)

![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)
![Vitest](https://img.shields.io/badge/tests-243_passing-2ea44f?logo=vitest&logoColor=white)

---

## Features

- **Full base-game rules**: snake-order setup, production, bank scarcity, the 7 with discards and the robber, all five development cards with their restrictions, 4:1 / 3:1 / 2:1 maritime trade, player-to-player trading, longest road and largest army with tie-breaking.
- **5–6 player extension**: 30-tile board, 11 harbors and an expanded deck.
- **Local-network multiplayer**: one machine hosts, everyone else joins from a browser with a four-letter room code. Automatic reconnection to the same seat.
- **Hot-seat mode** with a privacy shield between players.
- **Easy, normal and hard bots** that fill empty seats.
- **3D board with a free camera** (orbit, zoom-to-cursor, pan), click-to-build with ghost-piece preview, 3D dice, chat, a move timer and synthesized sound.
- **Zero assets**: not a single image or audio file. Everything is drawn with canvas and SVG, and every sound comes from Web Audio.

## Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5 (strict), ES2022 |
| Build & dev server | Vite 5 |
| Rendering | Canvas 2D with a custom 3D projection, SVG |
| Audio | Web Audio API (oscillators and filtered noise) |
| Networking | WebSocket (`ws`) on the same HTTP port that serves the game |
| Testing | Vitest, jsdom, node-canvas, fuzzing with `tsx` |
| Deployment | GitHub Actions → GitHub Pages (tests gate every deploy) |

## Technical highlights

### 1. Pure, deterministic rules engine
`src/engine/` never touches the DOM, never calls `Math.random` and never reads the clock. Its interface is a reducer:

```ts
const state  = createGame(players, { seed });      // deterministic match
const moves  = getLegalActions(state, playerId);   // everything they can do
const result = applyAction(state, moves[0]);       // (state, action) -> state
```

Randomness lives inside the state (a seeded mulberry32 generator), so a whole match can be rebuilt from the seed plus the action list. That shape made bots and networking almost free: a bot is just a function that picks among legal actions, and the server re-validates every move with the same `validate()` the client uses — no duplicated logic. → [`src/engine/`](src/engine)

### 2. Authoritative server with per-player state redaction
Clients only *propose* moves. Before sending state to each player, the server strips what that player isn't allowed to see: other players' hands, other players' development cards, the deck order, and **the RNG state**, which would let anyone compute every future dice roll. Redacted fields are left empty rather than faked, and public counts travel separately. A test guards against any new secret field leaking. → [`src/net/redact.ts`](src/net/redact.ts), [`server/room.ts`](server/room.ts)

### 3. Hex geometry without floating point
Instead of computing corners as floats and deciding with an epsilon whether two of them match, the board uses a doubled **integer** grid (`X = 2q + r, Y = 3r`): neighboring hexes produce literally the same pair for a shared corner, so vertex identity is plain integer equality. Harbors aren't hand-placed: the code walks the island's perimeter along single-hex edges and spaces them evenly, and the same code serves both board sizes. → [`src/engine/hex.ts`](src/engine/hex.ts), [`src/engine/board.ts`](src/engine/board.ts)

### 4. Invariant-based testing, fuzzing and the real UI
243 tests across 12 files. The most valuable ones aren't unit tests:
- **Self-play fuzzer**: random bots play full 2–6 player matches, checking after every action that bank + hands = initial total, no counts go negative, pieces add up, the stored longest road matches a recomputation from scratch, and no two buildings are ever adjacent.
- **Bot tournaments**: verify that difficulty levels mean something (hard beats normal, normal beats easy).
- **Clicking through the real UI**: with jsdom and a mocked canvas, a full match is played through the buttons.
- **End-to-end networking** with a real server and real WebSocket clients.

## Getting started

Requires Node.js 18+.

```bash
npm install
npm run dev        # local match at http://localhost:5173
npm run lan        # build and start the server for local-network play
npm test           # 243 tests
npm run fuzz 500   # 500 bot matches checking invariants
npm run build      # production build in dist/
```

> **Network scope:** designed for a trusted network. Traffic is unencrypted and the only access control is the room code; don't expose it to the internet as-is.

## Project structure

```
src/
  engine/   rules engine: pure TypeScript, no DOM, no external randomness
  ai/       bot contract, random and heuristic bots, self-play loop
  net/      protocol, state redaction and WebSocket client with reconnection
  ui/       3D scene, procedural art, sound and match controller
server/     HTTP + WebSocket on one port; rooms and the authoritative match
tools/      headless board-to-PNG rendering, fuzzer and bot tournaments
tests/      rules, board, bots, UI and networking
```

The full design document, covering every rules and UI decision, is in [`docs/DISENO.md`](docs/DISENO.md).

---

*Non-commercial personal project. Not affiliated with or endorsed by Catan GmbH; "Catan" is a trademark of its respective owners.*
