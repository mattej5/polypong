# PolyPong — Specification

Version 1.0 · 2026-08-27
Status: approved for build pending final review

A LAN-hosted classroom multiplayer Pong. A teacher runs one app on their Mac; students
join from Chromebooks by typing an IP into a browser. Everyone plays on a shared polygon
arena. Optionally, elimination triggers a multiple-choice question that can cost a life or
buy one back.

This document is the contract. Where the code and this document disagree, this document is
wrong or the code is wrong — one of them gets fixed, they never both stand.

---

## 1. Constraints that shape everything

These are not preferences. Every design decision below traces back to one of them.

| # | Constraint | Consequence |
|---|---|---|
| C1 | Students cannot install software | Browser only. No extensions, no native app, no login. |
| C2 | Students are on school Chromebooks | Modest CPU/GPU. Canvas 2D only. No WebGL, no shadowBlur, no per-frame allocation. Keyboard input only. |
| C3 | Teacher hosts from their own Mac | Single self-contained binary. No Node install, no terminal, no npm. |
| C4 | Students reach it by typing an IP | `http://<mac-ip>:5080/play`. Plain HTTP. No DNS, no certificates, no cloud. |
| C5 | It has to survive a real class period | No state can wait forever on a student. Every blocking phase has a server-side deadline. |
| C6 | The old build died of tangle, not of bugs | Hard module boundaries, enforced by test, not by discipline. |

### Non-goals for v1

- Hosted/cloud multiplayer (architecture must not preclude it — see §10.1 — but it is not built)
- Touch or mobile layouts
- Windows or ChromeOS hosting
- Accounts, persistence of student identity across days, gradebook export
- Free-response questions. Multiple choice only, 2–4 options.
- Audio on student devices

---

## 2. Invariants — the things that must be true

Each of these maps to at least one automated test (§12). If a change breaks one, the change
is wrong.

**Liveness**

- **I1.** No reachable state can block forever on a client. Every phase that waits on a
  human has a server-owned deadline that fires without any client message.
- **I2.** A match started with any legal configuration always terminates in a winner, a
  draw, or a teacher-issued end. There is no configuration that produces an unbounded match.
- **I3.** A question chain is bounded at depth 2. An elimination question may trigger at
  most one follow-up revive question, and that follow-up can trigger nothing.
- **I4.** A disconnected student never stalls anything — not the match, not an open question,
  not a countdown.

**Correctness of play**

- **I5.** On every arena size 2–8, for every seat, pressing `D` moves that player's paddle
  toward the right side of *their own screen*, and `A` toward the left. This holds for every
  wall of the polygon and both walls of the 2-player rectangle.
- **I6.** Every client renders its own wall at the bottom of its viewport, with the arena
  interior above it. The teacher's view is the canonical unrotated orientation.
- **I7.** The ball never passes through a paddle. Not at any speed, not on any client, not
  under interpolation.
- **I8.** All clients agree on the outcome of every collision, because no client simulates
  one. The server is the only simulation.

**Access**

- **I9.** `/` is reachable only from the loopback interface. Any other origin receives a 302
  to `/play`.
- **I10.** A WebSocket claiming `role: "teacher"` is refused unless its socket peer address
  is loopback. The HTTP redirect is not the enforcement; this is.
- **I11.** An answer key never crosses the wire to a non-teacher connection while its
  question is open.

**Structure**

- **I12.** `src/shared/**` imports nothing from `src/server/**` or `src/client/**`, and
  references no runtime API — no `Bun`, no `node:*`, no `window`, no `document`, no
  `Date.now`, no `fs`. It is pure logic driven by an injected clock.
- **I13.** The physics simulation has no knowledge of questions, seats, sockets, or names.
  It exposes commands and emits events; `Match` orchestrates.

---

## 3. Roles and routes

Two routes. That is the entire surface. The old build's four pages, projector keys, and
solo mode are deleted.

| Route | Who | Behaviour |
|---|---|---|
| `/` | Teacher | Settings, roster, live arena, question sets, scoreboard. Loopback only; everyone else is redirected to `/play`. |
| `/play` | Students | Name entry → lobby → rotated arena + question modal. |

The teacher projects `/` from their own machine. There is no separate projector screen and
no second device to authorise.

---

## 4. Hosting and distribution

- Single macOS binary built with `bun build --compile --target=bun-darwin-arm64`. An x64
  build is produced from the same source for Intel Macs.
- Launcher is a `.command` file (or `.app` wrapper) the teacher double-clicks. On launch the
  app binds port 5080, opens the default browser to `http://localhost:5080/`, and prints the
  LAN URL to its own window.
- The teacher page shows the student join URL in large type, permanently, at the top:
  `http://10.0.1.42:5080/play`. It is meant to be copied onto a whiteboard.
- Client HTML/JS/CSS are embedded in the binary. Nothing is read from disk at runtime except
  saved data.
- Writable state lives in `~/Library/Application Support/PolyPong/`:
  - `question-sets.json` — saved sets
  - `settings.json` — last-used match settings
  Writes are serialised and atomic (temp file + rename), so a crash mid-save never leaves a
  half-written file.

**First-run friction, documented in the README, not solved in code:**
1. Gatekeeper blocks the unsigned binary. The teacher right-clicks → Open → Open, once, ever.
2. macOS Firewall may prompt to allow incoming connections. They must click Allow, or no
   student can reach the server.

---

## 5. The game

### 5.1 Arena

- **3–8 players:** a regular n-gon. Every edge is one player's goal wall.
- **2 players:** a rectangle. Two opposite edges are goals; the other two are solid,
  unownable walls, rendered in a deliberately dull grey so they read as "not a player".
- Arena geometry is derived entirely from the set of living players plus the viewport. It is
  rebuilt whenever that set changes.
- All server coordinates are **arena units**: origin at the arena centre, `1.0` = arena
  radius. Pixel sizes never cross the wire.

### 5.2 Per-player rotation (I6)

Every client renders the full arena — all players, all balls, all hazards — rotated so the
client's own wall is at the bottom.

- The client computes `θ = atan2(myEdge.mid) - π/2` and applies `rotate(-θ)` to the canvas
  transform about the arena centre. Everything else is drawn in shared arena coordinates.
- The rotated arena's axis-aligned bounding box is fit to the viewport with a single uniform
  scale and letterboxed. For the 2-player rectangle this means each player sees a tall court
  with themselves at the bottom and their opponent at the top; it is smaller on screen than
  the teacher's horizontal view, and that is correct, not a bug.
- When the arena shape changes (an elimination), the shape snaps but `θ` is eased over 250 ms
  so players are not disoriented.
- Teacher and spectator views use `θ = 0`, the canonical unrotated arena: for a polygon that
  puts seat 0 at the bottom. The 2-player court is the one exception — it stays horizontal
  with seat 0 on the left, because a teacher watching two players expects to see ordinary
  Pong, not a tall court belonging to nobody on that screen.

### 5.3 Controls

- `A` = move toward the player's own screen-left. `D` = own screen-right. Nothing else.
- The client sends only `-1 | 0 | +1` in **its own screen frame**. The server multiplies by
  that edge's `rightSign` — the sign of `dir` that agrees with the inward normal rotated 90° —
  to convert into arena space. This is the single place the mapping exists, and I5 tests it
  exhaustively.
- Local paddle prediction: the client moves its own paddle immediately on keypress and
  reconciles against the next authoritative snapshot. Every other paddle is interpolated.

### 5.4 Lives, elimination, victory

- Each player starts with **3 lives**.
- Conceding a ball costs 1 life. Conceding a *hot* ball (one that has passed through a sun)
  costs 2.
- 0 lives → eliminated. Their wall is removed, the arena shrinks to the next polygon, the
  ball is cleared, and a hazard is auto-placed (§5.5).
- Last player standing wins. If a question kills everyone remaining at once, the match ends
  as a draw.
- On match end: winner banner on every screen, plus a **session scoreboard** — finish order,
  matches won, and questions correct/attempted per student — that persists across matches
  until the app quits. The screen holds there. Nothing advances automatically; the teacher
  presses Rematch or End game.

### 5.5 Hazards

Auto-placed by the server. No player aims anything. The old aim-and-drop placement phase is
deleted — it was the source of most deadlocks and it fought with the question modal.

- On each elimination, one hazard spawns at a random legal position: at least
  `0.14 R` clear of every wall and `0.30 R` clear of the arena centre.
- Every third elimination spawns a **sun**; otherwise a **black hole**.
- **Black hole:** pulls the ball toward its core, strength falling off linearly to zero at
  the field edge.
- **Sun:** pushes the ball away, adds speed, and heats it. A hot ball costs 2 lives for
  `sunHeat` seconds.
- **Anti-orbit:** a ball that has been continuously inside one field for longer than
  `fieldGripMax` seconds stops being affected by that field until it leaves. Without this,
  balls fall into stable orbits and the round never ends.
- Hazards are repositioned, never destroyed, when the arena shrinks: each is clamped back
  inside the new polygon and pushed off the centre.

### 5.6 Ball physics

All carried over from the old build, which had these tuned and working.

- **Paddle spin:** the return angle depends on where on the paddle the ball landed and how
  fast the paddle was moving. Tangential velocity is clamped so a return can never travel
  nearly parallel to the wall.
- **Speed gain:** each paddle hit multiplies speed by `ballSpeedGain`, capped.
- **Splitters:** every `splitEvery` rounds a splitter node spawns. A ball touching it clones
  into 2–3 balls, hard-capped at 7 balls on the table.
- **Stall breaker:** once a round exceeds `stallTimeout` seconds, ball speed climbs steadily
  and the speed cap rises with it, so rallies terminate.
- **Sub-stepping:** each tick is divided so no ball moves more than `0.02 R` per sub-step.
  This is what makes I7 true on the server.

---

## 6. Questions

Enabled or disabled by one toggle on the teacher page. Disabled means plain Pong and no
question code runs at all.

### 6.1 When a question fires

**On every elimination**, and only then. There is no rally cadence and no timed cadence.

### 6.2 Who answers, and what it costs

Two kinds of question. The kind is decided by the server, not authored into the set.

**Class question** — fires on a ball-caused elimination.

| Who | Correct | Wrong | No answer |
|---|---|---|---|
| Alive player | nothing | **−1 life** | counts as wrong |
| The player just eliminated (if they have revives left) | **revived with 1 life** | permanently out | permanently out |
| Permanently-out player | not asked | — | — |
| Spectator | not asked | — | — |

**Revive question** — fires only if the class question dropped one or more alive players to
zero lives.

| Who | Correct | Wrong | No answer |
|---|---|---|---|
| Player(s) who just hit zero from the class question | survive with 1 life | permanently out | permanently out |
| Everyone else | sees a "waiting — someone is answering to get back in" modal, cannot answer | — | — |

Because no living player is at risk during a revive question, the chain terminates (I3).

A player is asked at most once per question. A player with no revives remaining is not asked
and does not block anything.

### 6.3 Revive budget

The teacher sets **revives per student per match** on the root page. Default **1**, range
0–3. Once spent, elimination is permanent and no revive chance is offered. This is the
mechanism that makes I2 true.

### 6.4 Question lifecycle — the exact sequence

The match is frozen for its entire duration. The ball does not move.

1. **ASK.** Every eligible client shows the modal. Ineligible clients show a waiting modal
   naming who is answering. The countdown starts.
2. **CLOSE.** The question closes at the first of: every eligible player has answered; the
   timer expires; the teacher presses *Close now*. The teacher panel shows a live
   answered/total count and who is outstanding.
3. **REVEAL.** For `RESULT_HOLD` (3 s) every screen shows the correct answer and what that
   student chose. Life changes are applied here.
4. **ANNOUNCE.** A banner states what happened, in plain words: `RILEY IS OUT`,
   `JORDAN IS BACK IN`, `SAM LOST A LIFE`. Held for 2 s.
5. **If step 3 created new zero-life players:** go to step 1 as a revive question.
6. **RESUME.** A `3 · 2 · 1` countdown on every screen, then the ball is served.

Steps 3, 4, and 6 are not decoration. Serving the instant the modal closes was the single
worst-feeling bug of the old build and this sequence exists to prevent its return.

The ball is served fresh from the centre after an elimination. It is never resumed
mid-flight after a question, because the arena has changed shape underneath it.

### 6.5 Question sets

- Teacher panel on `/`: upload or paste CSV, name the set, save. Saved sets are listed with
  name and question count; one set is selected per match. Sets persist across app restarts.
- A blank CSV template is downloadable from the same panel.
- CSV columns: `question, optionA, optionB, optionC, optionD, correct`. `correct` is the
  letter `A`–`D`. Options C and D may be blank for a two-option question. A malformed row is
  reported by line number and skipped; it never crashes the import.
- Questions are drawn without replacement within a match. When the set is exhausted it
  reshuffles.
- The correct answer is held server-side. It is never sent to a student client until that
  question is closed (I11).

---

## 7. Teacher console (`/`)

One page, three regions.

**Settings** (editable only in the lobby, locked during a match)

| Setting | Range | Default |
|---|---|---|
| Arena size | 2–8 | 4 |
| Questions | on/off | on |
| Question set | one of the saved sets | first set |
| Question timer | 10–120 s | 30 s |
| Revives per student | 0–3 | 1 |
| Lives | 3–5 | 3 |

Bots fill whatever seats are unclaimed at the moment **Start** is pressed. Arena size 6 with
4 students joined = 4 humans + 2 bots. Students beyond the arena size are spectators.

**Roster** — every joined student, live:

- name, seat colour, lives remaining
- alive / dead / permanently out
- connected / dropped (bot driving)
- questions correct / attempted this session
- **Remove** and **Rename** actions per row

**Controls**

- **Start** — begins a match with the current settings.
- **End game** — stops the match immediately, returns everyone to the lobby with seats,
  names, and the session scoreboard intact. Does not quit the app.
- **Rematch** — new match, same roster, same settings.
- **Close now** — visible only while a question is open.
- **Quit** — shuts down the server and exits, after telling every client the session ended.

**Arena view** — the live game, canonical orientation, full CRT effects. Audio (hits,
eliminations, question chime) plays here and only here.

---

## 8. Student client (`/play`)

**Name entry.** One field, one button. Names are trimmed, capped at 10 characters, and must
be unique within the session; a collision gets a numeric suffix. A join token is stored in
`localStorage` for reconnection.

**Lobby.** Their name and seat colour, the list of everyone joined, and a "waiting for your
teacher to start" line.

**In match — seated.** The rotated arena, filling the screen. Overlaid:

- their own name, colour, and lives, bottom-centre against their own wall
- every wall labelled with its owner's name and life pips (§9), so nobody has to identify
  themselves by colour alone
- the banner and countdown, mirrored from the server
- the question modal when one is open

**In match — spectator or late join.** Students who join after Start, or beyond the arena
size, see a "waiting for the next game" screen. They do not see the arena and do not receive
questions. They are seated automatically at the next Start if a seat is free.

**Disconnection.** If a Chromebook sleeps or the tab reloads, a bot takes the paddle
immediately and the seat is held. Reconnecting with the stored token within the same match
hands the paddle back with lives intact. A dropped student is removed from the pending
answer set of any open question, so "everyone has answered" still terminates (I4).

---

## 9. Visual specification

Keep the CRT vector look. It is fast, distinctive, and already tuned.

- Pure black arena interior. Every non-black pixel is something you can hit, own, or die to.
- Glow is **additive, never blurred**: the same path stroked three times under
  `globalCompositeOperation = 'lighter'` — wide and faint, then narrower, then thin and full.
  No `shadowBlur` and no gradients anywhere. This is a hard performance rule for C2.
- One hue per seat, fixed saturation and lightness, from a hue order chosen so that no two
  seats on adjacent walls land in the same colour band at any player count from 2 to 8.
- Solid unownable walls are a desaturated grey, visibly not a player colour.

**Readability layer (new in v1).** Colour is never the only channel:

- every wall carries its owner's name in legible mono type, oriented readably in the
  viewer's rotated frame
- lives are drawn as discrete pips next to the name, not as a colour or a bar
- the player's own wall additionally carries a bright inner underline
- banner text is plain classroom English: `RILEY IS OUT`, not `ELIMINATION`

**Performance budget** (measured on the oldest Chromebook available before the feature is
considered done): 60 fps at 8 players with 7 balls, 4 hazards, and particles active.

---

## 10. Architecture

### 10.1 Layering

```
src/
  shared/            ← pure logic, zero runtime APIs (I12)
    protocol.ts      ← wire message types, discriminated unions
    config.ts        ← all tuning constants in one place
    geometry.ts      ← vectors, edges, buildArena, rightSign
    sim/
      game.ts        ← authoritative physics. Knows nothing of seats or questions (I13)
      paddle.ts  ball.ts  hazards.ts  ai.ts
    match.ts         ← Room: seats, phases, quiz orchestration. No I/O.
    quiz.ts          ← CSV parsing, question selection, scoring
  server/
    main.ts          ← Bun.serve, WS upgrade, 60 Hz clock, browser launch
    storage.ts       ← the only file that touches the filesystem
  client/
    net/             ← socket, snapshot interpolation, paddle prediction
    view/            ← CRT renderer, rotation transform, HUD
    teacher/         ← console page
    play/            ← student page
test/
```

**Why this shape, given C6.** The old build tangled because gameplay, presentation,
questions, and transport could all reach each other. Here:

- `shared/` is driven by an injected `dt`. It can be run headlessly at 1000× speed under
  `bun test`, which is what makes §12 possible.
- `Game` never learns what a question is. `Match` calls `game.freeze()`, `game.revive(seat)`,
  and listens for `onEliminated`. If questions were deleted tomorrow, `Game` would not change.
- `storage.ts` is the only filesystem access, injected into `Match` as a `persist()` callback.
  Moving the whole thing to a hosted server later means replacing `server/` and nothing else
  (fallback path, §14).

An import-boundary test enforces I12 mechanically. Discipline is not the mechanism.

### 10.2 Networking

- **Tick:** 60 Hz fixed server simulation.
- **Snapshots:** 30 Hz broadcast, in arena units, ~500 bytes. At 8 seated clients plus
  spectators this is trivially inside a LAN's capacity.
- Every snapshot carries the room's own accumulated simulation clock — not a wall clock — so
  clients interpolate against the server's timeline and network jitter never reaches the
  render clock.
- **Clients never simulate.** They interpolate between two snapshots that the server actually
  produced, rendering slightly in the past. Nothing is ever extrapolated. This is what makes
  I7 true on the client: both endpoints of any blend are states in which the ball was in
  front of the paddle, and the arena is convex, so every point between them is too.
- **Balls are matched by id, not array index**, across snapshots. Index is not stable across
  a split or a goal, and matching by index makes one ball skate across the arena.
- Two snapshots are blended only when they describe the same world *shape* — same phase,
  same round, same alive set, same life counts, same hazard count. Otherwise the earlier one
  is held. Blending across a rebuild teleports things.
- Broadcast uses Bun's native WebSocket pub/sub topics rather than a manual socket loop.

### 10.3 Phase machine

`LOBBY → COUNTDOWN → PLAYING → (QUESTION → REVEAL → ANNOUNCE)* → RESUME → PLAYING → … → MATCH_OVER`

- `PLAYING` is the only phase in which the ball moves.
- `QUESTION`, `REVEAL`, `ANNOUNCE`, `RESUME`, and `COUNTDOWN` each own a server-side timer
  that advances them with no client input whatsoever (I1).
- Teacher **End game** is legal from every phase and always lands in `LOBBY`.
- There is exactly one freeze concept. The old build had a pause flag, a placement hold, and
  a quiz freeze that could each independently stop the world, and they collided. Here, phase
  alone determines whether the ball moves.

---

## 11. Defaults

| Name | Value |
|---|---|
| HTTP/WS port | 5080 |
| Server tick | 60 Hz |
| Snapshot rate | 30 Hz |
| Max seats | 8 |
| Default arena size | 4 |
| Lives | 3 |
| Revives per student per match | 1 |
| Question timer | 30 s |
| Result hold | 3 s |
| Announce hold | 2 s |
| Resume countdown | 3 s |
| Serve delay after a point | 0.7 s |
| Max balls on table | 7 |
| Target match length | 3–5 minutes |

Tuning constants for ball speed, paddle size, hazard strength, spin transfer, and glow
layers are ported unchanged from the old build's `config.ts` and live in exactly one file.

---

## 12. Testing

Headless, required, written with the feature and not after it. Everything in `shared/` runs
under `bun test` with no browser and no sockets.

**Liveness**

- Play 200 full matches at every arena size 2–8, with questions on and off, driving every
  client with a randomised policy that includes *never answering* and *disconnecting
  mid-question*. Assert every match terminates. (I1, I2, I4)
- Assert no question chain ever exceeds depth 2. (I3)
- Fuzz the phase machine: from every phase, apply every teacher action and every client
  message, assert the machine is still live. (I1)

**Play**

- For every arena size 2–8 and every seat, assert `D` moves the paddle toward that player's
  screen-right and `A` toward screen-left, checked in rendered screen coordinates after the
  rotation transform, not in arena coordinates. (I5, I6)
- Fire balls at every paddle at maximum speed from every angle; assert none passes through.
  Run the same assertion against the interpolated client path, not just the server path. (I7)

**Access**

- Non-loopback `GET /` returns 302 to `/play`. (I9)
- Non-loopback WS `hello role:"teacher"` is refused. (I10)
- No message sent to a student or spectator contains an answer key while its question is
  open, asserted by scanning every outbound payload during a full quiz match. (I11)

**Structure**

- Import-boundary test: no file in `shared/` imports from `server/` or `client/`, or
  references `Bun`, `node:`, `window`, `document`, `Date.now`, or `Math.random` directly.
  (I12, I13)

**Rules**

- Table-driven tests for §6.2: for each of the four participant kinds × correct/wrong/timeout,
  assert the resulting lives and alive state.

---

## 13. Build order

Each milestone ends in something that runs and is tested. Nothing is stubbed forward.

1. **Skeleton and boundary.** Repo, TypeScript, Bun server on 5080, two routes, loopback
   gating, the import-boundary test. Ends with: an empty teacher page and student page,
   access control proven.
2. **Simulation.** `geometry`, `sim/`, arena construction, ball physics, paddle spin, bots.
   Headless only, no rendering. Ends with: a bot-vs-bot match playing to a winner under
   `bun test`, I5 and I7 green.
3. **Transport and rendering.** Snapshots, interpolation, prediction, the CRT renderer,
   per-player rotation. Ends with: real students on Chromebooks playing a plain Pong match
   with bots, at 60 fps, with the readability layer in.
4. **Teacher console.** Settings, roster with all four actions, Start/End/Rematch/Quit, live
   arena, audio, join URL display. Ends with: a full class period runnable with questions off.
5. **Questions.** CSV import, saved sets, the phase machine of §6.4, revive budget,
   scoreboard. Ends with: §12 rules tests green and a real lesson runnable.
6. **Packaging.** `bun build --compile` for arm64 and x64, `.command` launcher, application
   support directory, README covering Gatekeeper and the firewall prompt.
7. **Classroom dry run.** §14 R1 verified in the actual room before it is relied on in a
   lesson.

---

## 14. Risks

**R1 — School Wi-Fi may block device-to-device traffic. Untested. Highest risk in the
project.** Many school networks enable client isolation, in which case no student can reach
the teacher's Mac and no amount of code fixes it.
*Mitigation:* a `/health` page that a single Chromebook can hit to confirm reachability in
under a minute. Run it in the actual room, on the actual network, before building a lesson
around this. Architecturally, §10.1 keeps `shared/` free of runtime APIs so the whole thing
can be lifted onto a hosted server later without touching game logic — but that fallback is
not built in v1.

**R2 — Gatekeeper blocks the unsigned binary.** One-time right-click → Open. Documented, not
solved. Solving it properly costs an Apple Developer account.

**R3 — macOS Firewall prompt.** The teacher must click Allow on first launch. If they click
Deny, nothing works and the failure is silent from the student side. The teacher page should
detect zero connections and say so.

**R4 — Chromebook render performance.** Eight players, seven balls, particles, and a rotated
full arena is more than the old build asked of a student device. Measured in milestone 3, not
at the end. If it misses budget, the student render path sheds particle count and glow layers
before it sheds frame rate.

**R5 — The Mac's IP changes between class periods.** DHCP lease renewal invalidates the URL
written on the board. The teacher page always shows the current address; the README says to
re-check it each period.

**R6 — The teacher's Mac sleeps mid-class.** Wi-Fi power management drops connections. The
app should assert a "prevent sleep" request while a match is running.

---

## 15. Reuse from the old repository

`github.com/mattej5/polypong` is a good source. Roughly 60% ports across with type
annotations and no behavioural change:

| Ports nearly verbatim | Ports with changes | Deleted |
|---|---|---|
| `geometry.js` — vectors, `makeEdge`, `rightSign`, `buildArena`, `clampInside` | `game.js` — physics core keeps, placement state machine goes | `admin.js` / `admin.html` — replaced by the new console |
| `config.js` — every tuning constant and the hue table | `render.js` — beam primitives keep, add rotation and the readability layer | `arena.html`, `index.html` — routes deleted |
| `entities.js`, `ai.js` | `room.js` — seat/reconnect logic keeps, quiz orchestration is rewritten to §6 | The hazard aim/ghost/placement subsystem |
| `net/interp.js`, `net/predict.js` | `quiz.js` — CSV parsing keeps, the engine is rewritten | The projector display key and `role: "display"` |

The old repo's comments explaining *why* — the `rightSign` derivation, why interpolation
rather than extrapolation, why balls carry ids, why hues are ordered as they are — are worth
carrying across with the code. They are the most valuable thing in that repository.
