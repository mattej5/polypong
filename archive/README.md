# Archive — the first PolyPong build

This directory is the original PolyPong, kept for reference. **It is not built,
not tested, and not run.** The working project is at the repository root.

It is here because it is worth reading, not because it is worth reviving.

## Why it was replaced

It worked, and then it stopped being changeable. Four pages (`/`, `/play`,
`/admin`, `/solo`) with overlapping roles and a projector key to authorise a
second screen. Three independent things that could each stop the world — a
pause flag, a hazard-placement hold, and a quiz freeze — which all wanted to be
true at the same moment, an elimination, and deadlocked each other there. Four
of the nine commits in this history are fixes for that one collision.

The rewrite did not fix those bugs. It removed the shapes that produced them:
two routes instead of four, one freeze concept instead of three, and no
player-aimed placement phase at all. See `SPEC.md` at the root, particularly
the invariants in §2.

## What was worth keeping

Most of it, honestly. The following ported across nearly unchanged, because it
had been tuned against real play and was right:

- `src/geometry.js` — the arena builder, and `rightSign`, which is the single
  reason `D` means "your right" on every wall of an eight-sided polygon.
- `src/config.js` — every gameplay constant, and the seat hue ordering, which
  is spaced so no two players on adjacent walls land in the same colour band at
  any player count from 2 to 8.
- `src/game.js` — ball physics, paddle spin, splitters, the anti-orbit release.
- `src/net/interp.js` — snapshot interpolation, and its explanation of why
  interpolating is what stops a ball passing through a paddle and why
  extrapolating cannot be repaired by clamping.
- `src/render.js` — additive glow instead of `shadowBlur`, which is what let it
  run on a school Chromebook at all.

The comments in these files explaining *why* were carried into the new build
along with the code. They were the most valuable thing in this directory.

## Running it

Don't. If you must, it needs Node and `pnpm install`, and it serves on port
5180. The saved question sets that used to live at `server/question-sets.json`
are still on disk locally but are deliberately not committed — they carry
answer keys.
