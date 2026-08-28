# PolyPong

A classroom multiplayer Pong game. The teacher runs one app on their Mac; students join
from their Chromebooks by typing an address into a browser. Nobody installs anything.

Full behaviour is specified in [SPEC.md](SPEC.md). This file is only about running it.

---

## For the teacher

### First time only

1. Double-click **PolyPong.command**.
2. macOS will refuse to open it, because the app is not signed by Apple. This is expected.
   **Right-click** the file, choose **Open**, then click **Open** in the dialog. You only do
   this once, ever.
3. macOS asks whether to allow incoming network connections. **Click Allow.**
   If you click Deny, the app still runs but no student can reach it, and nothing on screen
   will tell you why. If students cannot connect, this is the first thing to check:
   System Settings → Network → Firewall → Options.

### Every class

1. Double-click **PolyPong.command**. Your browser opens the teacher page.
2. The student address is shown in large type at the top, like `http://10.0.1.42:5080/play`.
   Write it on the board. **Check it every period** — the last number can change when the
   school network hands your Mac a new address.
3. Students type that address, enter a name, and wait.
4. Set the arena size, choose whether to use questions, and press **Start**.

### The buttons

| Button | What it does |
|---|---|
| **Start** | Begins a match with the current settings. Bots fill any seats students have not claimed. |
| **End game** | Stops the match now. Everyone returns to the lobby and keeps their name and seat. |
| **Rematch** | New match, same students, same settings. |
| **Close now** | Only appears while a question is up. Closes it without waiting for stragglers. |
| **Quit** | Shuts the whole thing down. |

Settings are locked while a match is running. End the game to change them.

### Before you rely on it in class

Run the connectivity check **in the actual room, on the actual network**, before you build
a lesson around this. Some school networks block devices from talking to each other, and if
yours does, no setting in this app can fix it.

1. Start PolyPong on your Mac.
2. On one student Chromebook, go to `http://<your-ip>:5080/health`.
3. If that page loads and shows a green connection, the network allows it. If it does not
   load, the network is blocking device-to-device traffic and you should talk to whoever
   runs it before planning around this.

Takes about a minute. Worth doing on a prep period rather than discovering it with 25
students watching.

---

## For students

Type the address your teacher wrote on the board. Enter a name. Wait for the game to start.

- **A** moves your paddle left. **D** moves it right.
- You are always at the bottom of your own screen, no matter where you are on your teacher's.
- Everyone starts with three lives. Lose them all and you are out — unless you get a question
  right.

---

## Development

Requires [Bun](https://bun.com).

```bash
bun install
bun run dev        # http://localhost:5080
bun test           # the whole suite
bun run typecheck
```

### Building the shipping app

```bash
bash scripts/build.sh
```

Produces `dist/PolyPong.command` plus binaries for Apple Silicon and Intel. The `.command`
file picks the right one at launch, so one folder works on either Mac.

### Layout

```
src/shared/     pure logic — no Bun, no DOM, no filesystem, no clock of its own
  sim/          the authoritative physics
  match.ts      seats, phases, question orchestration
  quiz.ts       CSV parsing and the question engine
src/server/     the only place that touches HTTP, sockets, or files
src/client/     the two browser pages
test/           runs headless; the game is playable with no browser at all
```

`src/shared/` may not import from `src/server/` or `src/client/`, and may not touch any
runtime API. That rule is enforced by `test/boundary.test.ts`, not by good intentions — the
previous version of this project died of exactly that tangle.
