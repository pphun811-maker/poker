# Digital Poker Table

![Demo screenshot](img/demo.png)

A browser-based poker table for Texas Hold'em. Play solo against bots or with friends. Each player
joins via QR code or link to use their own device, while the shared table handles the rest.

> **Unofficial modified version.** This repository is a personal, non-commercial modification of
> [Poker by Tehes](https://github.com/Tehes/poker): Chinese/English UI, single-player and bot
> changes, and an experimental AI-agent server. It is not the original project and is not
> affiliated with or endorsed by the original author.

---

## License and usage

This project is source-available, not open source.

You may view and modify the code for personal, educational, and non-commercial purposes.

If you publicly redistribute this project or a modified version of it, you must:

- link to the original project: [https://github.com/Tehes/poker](https://github.com/Tehes/poker)
- include a visible in-app attribution such as “Based on Poker by Tehes” with a link to the original project
- clearly mark your version as modified and unofficial

Commercial use, paid hosting, resale, and misleading rebranding are not allowed without prior written permission.

---

## 🎯 Key Features

- **No Setup Required**: No app install, no sign-ups, no lobby and no configuration. Just enter
  names and start playing.
- **Local Solo Saves**: Unfinished Solo vs Bots games are saved locally in the browser and can be
  continued later on the same device.
- **Private Player Views**: Human players can join on their own devices without exposing private
  information on the shared screen.
- **QR + Link Joining**: Each human seat provides both a QR code and a direct link for easy access.
- **Companion / Remote Table Switching**: Joined players can switch between a compact companion view
  and the full remote table.
- **Remote Player Actions**: In synced multiplayer games, the active player can act directly from
  their own device.
- **Turn Sound Alerts**: An optional cue signals human turns on the shared table in solo games and
  on the active player's device in multiplayer. The sound setting is saved per device.
- **Automatic Game Logic**: Handles blinds, bets, pots, side pots, and showdown evaluations.
- **Progressive Blinds**: Blinds increase every 6 hands using a hand-based formula with safe
  nice-step rounding, so the pace stays stable even short-handed or heads-up.
- **Side Pot Support**: Accurately resolves complex all-in scenarios.
- **Dynamic Positioning**: Turn order and bot strategy adapt as players fold.
- **Supports All Table Sizes**: From heads-up to full-ring games.
- **Responsive Design**: Optimized for tablets, phones, and desktops.
- **Smart Bet Slider**: The bet slider highlights invalid amounts in red while dragging and snaps to
  the minimum legal raise when released.
- **Fast & Offline-Ready**: Loads fast and works offline once cached.
- **Built‑in Bots**: Empty player slots are automatically filled with bots.
- **Fast Forward for Bot-Only Hands**: When no human can act in the current hand, a Fast Forward
  button lets you speed through the remaining bot action. If no humans have chips left after that,
  the game keeps fast-forwarding until a winner remains.
- **Smart Bot Play**: Bots use tournament-style heuristics with M-ratio pressure, pot odds,
  position, opponent tendencies, and context-aware postflop aggression instead of fixed charts or
  simulations.
- **Postflop Hand Labels**: When hole cards are visible on the table, the shared screen shows short
  postflop hand categories.
- **Bot Reveals**: After some uncontested postflop wins, bots may occasionally reveal one or both
  hole cards to create small TV-poker moments.
- **Session Stats Overlay**: After each completed hand, open a compact stats view with stack, hands
  won, showdown results, folds, and all-ins for all active players.
- **Winner Reactions**: After a pot win, the shared table may briefly show a face emoji above each
  main-pot winner. Reactions are based only on public information such as pot size, split pots,
  all-ins, visible hand strength, reveals, and stack swings.

---

## 🎮 Main Play Modes

The same table supports different ways to play. The mode depends only on how many humans join.

- **Solo vs Bots (Open Cards)**: One human plays directly on the shared device while bots fill the
  empty seats. This is the fastest way to play and learn.
- **Spectator / TV Poker**: No humans join. All seats are bots, hole cards are visible, and the
  table becomes a self-running poker show.
- **Multiplayer**: Two or more humans join. They can play in the same room or anywhere in the world.
  Players can join on their own devices via QR code or link while the shared table remains the
  central board. Online play uses the small relay described below; the host device keeps the game
  running and must stay open.
- **Hybrid Tables**: Humans and bots can mix freely. This makes it easy to run short-handed games,
  fill gaps, or teach new players without slowing the table down.

---

## 🚀 Getting Started

1. Open this URL on a shared device (e.g., tablet or laptop): 👉
   [https://pphun811-maker.github.io/poker/](https://pphun811-maker.github.io/poker/)

2. Add players by typing their names.

3. Start the game.

4. Human players can then join on their own devices via QR code or direct link. For remote friends,
   share the per-seat link after the first hand is dealt.

The table handles dealing, blinds, betting, and showdown automatically.

---

## 📶 Offline Use

The table works fully offline after the first complete load.

- **First visit online** – When opened once with an internet connection, all necessary assets (HTML,
  JS, CSS, SVGs, icons) are cached in the browser.
- **Service Worker** – Handles cache-first requests and serves offline content when the network is
  unavailable.
- **Core Assets Pre‑cached** – Core assets are precached during install; any additional resources
  are loaded and cached on demand.
- **Updates** – A new version is fetched and activated in the background; refreshing the page loads
  the updated assets.
- **Graceful QR Fallback** – In solo/local play the QR code can carry embedded hole-card data so the
  companion view remains usable without a relay. Online seats rely on the relay instead.

---

## 🛠️ Tech Stack

- **Vanilla HTML, CSS, and JavaScript** – no frameworks
- **Client-side game engine** – handles table state, betting flow, bots, showdown logic, and
  browserless engine test runs
- **Deno batch runners** – browserless engine batches for fast bot/engine validation, plus browser
  speedmode batches for end-to-end integration checks
- **Service Worker caching** – supports offline play after the first load
- **Optional Deno relay** – one small file (`server/sync.js`) keeps multiplayer remote seats and
  actions in sync; deploy it to Deno Deploy or run it locally
- **qr-creator** – QR code generation for device joining
- **pokersolver** – hand evaluation at showdown

---

## 🌐 Online Multiplayer Relay

GitHub Pages only serves static files, so online seats need one small relay. The relay lives in
`server/sync.js` as a single Deno file; GitHub Pages keeps hosting the client.

- **Host-authoritative**: the shared device runs the game engine. The relay stores the latest public
  table plus one private projection per human seat and hands remote actions back to the host.
- **Per-seat privacy**: every human seat gets a random token. A seat token can only read its own
  projection, so changing `seatIndex` in a URL cannot reveal another player's hole cards. Bot seats
  are never uploaded.
- **Host token**: state writes require the host token, so a guest cannot overwrite the table.
- **Solo and spectator games stay local** and keep a clean URL without `tableId`.
- **Solo saves are local-only**: unfinished Solo vs Bots games are stored in the browser on the
  shared device; multiplayer sync does not create persistent cloud sessions.
- **Human seats expose two entry points**: a QR code for the companion view (`hole-cards.html`) and
  a direct link for the full remote table (`remoteTable.html`). Both carry the seat token and relay
  URL, and can be switched at any time.
- **If the relay is unreachable**, the remote pages show a connection message; actions stay on the
  shared table.

### Deployment (pick one host)

The relay is one dependency-free Deno file. The included `Dockerfile` runs it on any Docker host,
and `render.yaml` is a ready Render blueprint.

**Option A — Render (recommended: free, no card, dashboard reachable from mainland networks)**

1. Push this repo to GitHub.
2. Open [Render](https://dashboard.render.com/) → **New** → **Blueprint** → connect the repo.
   Render reads `render.yaml`, builds the `Dockerfile`, and starts the service.
3. Copy the service URL, for example `https://poker-sync-xxxx.onrender.com`.
4. Set it in `js/syncConfig.js`, or open the host site once with `?sync=<url>`; seat links copy it
   to every guest device.

Render's free web service sleeps after about 15 minutes without traffic and wakes in about a minute.
Open `<url>/health` a minute before playing. Storage is in memory, so after a wake or restart start
a new table.

**Option B — Zeabur / Koyeb / Fly.io / your own VPS**

Use the same `Dockerfile`, expose port `8000`, and set `SYNC_STORAGE=memory` plus
`ALLOWED_ORIGINS=https://pphun811-maker.github.io`. Zeabur has an APAC free-credit tier; Koyeb and
Fly.io have small free/cheap instances. No code changes are needed.

**Option C — Deno Deploy (existing accounts only)**

The Deno team joined Cloudflare and Deno Deploy is being sunset (apps run until around April 2027),
so this is no longer the recommended path. If you already have it: connect the repo, set the
entrypoint to `server/sync.js`, provision a **Deno KV** database, and assign it to the app. KV is
needed because Deploy can run multiple instances; without it the relay is single-instance only.
`/health` reports `"storage":"kv"` when KV is active.

**Option D — Local relay + tunnel (no cloud account)**

Run `deno task sync`, then expose it with a tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

Use the printed HTTPS URL as `?sync=...`. The host PC must stay on, but there is no cold start and no
quota. If `trycloudflare.com` is blocked for your friends, use a mainland-friendly tunnel (cpolar,
NATAPP, 花生壳) or your own VPS.

### Local development

```bash
deno task sync            # relay on http://127.0.0.1:8787
python -m http.server 8000
# open http://127.0.0.1:8000/?sync=http://127.0.0.1:8787
```

Use HTTP for both the page and the relay. A GitHub Pages HTTPS page cannot call an HTTP relay
(mixed content).

### Relay configuration

- `ALLOWED_ORIGINS=https://your.site,https://other.site` overrides the CORS allowlist. It defaults to
  `https://pphun811-maker.github.io` plus localhost.
- Tables expire after 8 hours; a pending action expires after 15 minutes.
- Free hosts differ: Render sleeps after inactivity; Zeabur/Koyeb may scale to zero. In-memory
  storage resets on restart, so start a fresh table after a wake. A very long or very busy session
  can still hit a host's request limits.
- The relay sees the full table state, including hole cards, in memory/KV. It only serves one seat's
  projection per token. Self-host `server/sync.js` if that trust model does not fit.
- `deno task sync:test` covers projection, token isolation, actions, CORS, and cleanup.

### Limitations

- The host device must stay open; closing it ends the online table.
- Guests join after the hand is dealt, from the per-seat link/QR shown on the host table.
- The host browser is authoritative, so a technically savvy host can see all cards. This is the same
  trust model as shared-table play.

---

## 🤖 How It Works

- The shared device runs the main table.
- Human players can join their seats on their own devices.
- Empty seats are filled with bots automatically.
- The table manages:
  - **Dealer rotation** and automatic blind posting
  - **Progressive blinds** that increase every 6 hands with a formula-based, nice-step schedule
    (e.g., 10/20 -> 20/40 -> 30/60 -> 40/80 -> 50/100 -> 60/120)
  - Side pots and all-ins
  - Automatic showdown resolution

---

## Bot Behavior (Tournament Logic)

Bots play **plausible, tournament-style poker** based on heuristics, not simulations or hidden information.  
The goal is not solver-perfect play, but **realistic, hard-to-exploit decisions** that resemble human tournament strategy.

Core principles:

- **Tournament pressure (M-ratio)**  
  Short-stack zones drive shove, call, and raise behavior based on Harrington-style logic.

- **Private strength vs board strength**  
  Postflop decisions are based on how much the hole cards improve the board.  
  Bots distinguish between:
  - board-driven strength (shared by everyone)
  - true private edge (unique to the player)

- **Private-aware strength model**  
  Raw hand strength is adjusted by private edge, so bots don’t overvalue strong-looking boards  
  (e.g. trips on a paired board) and don’t undervalue real made hands.

- **Risk-aware decision making**  
  Calls and folds are influenced by:
  - pot odds
  - stack commitment
  - elimination risk  
  Expensive decisions require stronger justification, but strong private hands can override pure survival logic.

- **Position and table dynamics**  
  Bots adapt aggression based on position, number of opponents, and remaining players.

- **Opponent tendencies (lightweight reads)**  
  VPIP, aggression, fold rate, and showdown strength slightly shift thresholds without dominating decisions.

- **Board texture and draw equity**  
  Wet boards increase protection and reduce bluffing; dry boards enable more aggression.

- **Balanced bluffing and bluff-catching**  
  Bots do not only wait for value. They mix in bluffs and defend thin bluff-catch spots often enough to avoid becoming trivially exploitable.

- **Uncapped checked ranges**  
  A bot check after the flop does not automatically mean weakness. Strong value hands can sometimes
  check, either to continue normally against pressure or to raise when an opponent bets into them on
  the same street.

- **Bet-size-aware defense**  
  Bots react to bet size, pot odds, and minimum-defense pressure, so small and medium bets into
  checked ranges are less automatically profitable.

- **Marginal hands stay playable**  
  Thin showdown hands, small made hands, and weaker draws are handled more carefully instead of
  collapsing into automatic folds or automatic aggression.

- **Controlled initiative (checked-to play)**  
  When no one bets, bots selectively take the lead depending on position, board context, and opponent behavior.  
  Weak or risky spots are filtered out to avoid over-aggression.

- **Line consistency**  
  Simple betting plans (c-bet, barrel) are carried across streets but can be aborted on bad runouts.

- **Tournament-style preflop ranges and sizing**  
  Preflop choices use position, hand family, blind context, and fixed tournament-style sizing for
  opens, 3-bets, squeezes, and short-stack pressure.

- **Strict guardrails**  
  The system prevents unrealistic behavior:
  - no folding premium preflop hands  
  - no bluffing with made hands  
  - no absurd folds of strong private hands  
  - no broken multi-raise sequences  

---

## 🧠 Design Philosophy

- **Local-first**: Works without network once loaded.
- **Optional back-end sync**: Core state is client-side, with best-effort syncing when available.
- **Zero footprint**: No accounts, no sign-ups, no persistent cloud state.
- **Focus on flow**: The app enforces rules and turn order so you can focus on the game.
- **Tournament-style**: Progressive blinds keep games from stalling.

---

## 🐞 Debugging and Batch Testing

Set `DEBUG_FLOW` to `true` in `js/app.js` to print detailed, timestamped messages about the betting
flow. Enable this flag when investigating hangs or unexpected behavior.

### Automated Batch Runs

For repeatable bot-vs-bot runs with detailed decision logs and aggregate bot-behavior metrics, use
the browserless engine batch runner first:

```sh
deno task engine:batch
deno task engine:batch:equity
deno task engine:batch:500
deno task engine:batch:1000
```

`engineBatch` runs full bot tournaments directly through the pure engine without launching a
browser. It is the primary runner for bot tuning, poker-rule changes, tournament flow, outcome
joining, and large samples. It writes one log plus one JSON summary per run. By default the output
goes to `tmp/poker-engine-batch-YYYYMMDD-HHMMSS/` and includes a combined `summary.json`.
`deno task engine:batch` runs 100 tournaments by default; use the 500 or 1000 task when a bot-tuning
change is noisy and needs a larger sample.

`deno task engine:batch:equity` enables a slower diagnostic pass after each run. It enriches
postflop decisions with approximate current equity against the still-active players' actual hole
cards; Turn and River are exact, Flop is exact under the normal board cap, and Preflop stays off by
default because hand family, position, domination, and playability are usually more useful there.
Use `--equity-preflop` only when you explicitly want selective Preflop leak candidates included.

Use the browser speedmode runner only when you need an end-to-end browser smoke test:

```sh
deno task speedmode
deno task speedmode:10
```

`speedmodeBatch` starts a local static server, opens the table in headless Chrome with
`?speedmode=1&botdebug=detail`, and writes one log plus one JSON summary per run. By default the
output goes to `tmp/poker-speedmode-batch-YYYYMMDD-HHMMSS/`. Use it for app integration, DOM,
timer, notification, animation, bootstrap, and browser-context behavior.

Both runners share the same analysis layer. The detailed bot log includes tags such as `PMH`
(private made hand via positive edge), `Edge` (private score minus public board score), and `PRE`
(private raise edge at `>= 0.05`) to make postflop validation easier. `LT` distinguishes `none`,
`kicker`, `meaningful`, and `structural` lifts.

Recommended workflow: after bot logic, engine rules, or tournament-flow changes, run
`deno task engine:batch` first. If the direction still looks plausible but noisy, run
`engine:batch:500` or `engine:batch:1000`. After browser orchestration or UI-side-effect changes,
run `deno task speedmode` or `deno task speedmode:10`.

Useful overrides:

```sh
deno task engine:batch -- --runs=25 --max-hands=500
deno task engine:batch -- --out=tmp/poker-engine-latest
deno task engine:batch -- --equity --equity-limit=1000
deno task engine:batch -- --equity-preflop --runs=10
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" deno task speedmode -- --runs=3
deno task speedmode -- --out=tmp/poker-speedmode-latest
```

---

## 📋 Known Limitations

- Live syncing is best-effort; if the relay is unreachable, joined devices show a connection message
  and actions stay on the shared table.
- Saved games are local to the same browser/device and apply only to Solo vs Bots games.
- Online play requires the host tab to stay open and a deployed relay; seat links are bearer
  credentials, so share each one privately.
- The host browser is the dealer and can see all cards; online play is meant for trusted groups.
- The blind progression (formula-based increase every 6 hands) is not customizable.

---

## 🙌 Credits

- [pokersolver](https://github.com/goldfire/pokersolver) for hand ranking logic
- [qr-creator](https://github.com/nimiq/qr-creator) for QR code generation
