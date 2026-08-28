// Entry point. Owns the clock, the LAN address, the browser launch, the sleep
// assertion, and shutdown. Everything it knows about the game it learned from
// the `Match` interface in src/shared/match.ts.

import { networkInterfaces } from 'node:os';

import { PORT, TIMING } from '../shared/config';
import { Match } from '../shared/match';
import { createSocketRegistry, startServer } from './http';
import { flush, loadSets, loadSettings, persist } from './storage';
import { SAMPLE_SETS } from '../shared/sample-sets';

/**
 * The number the teacher writes on the whiteboard (SPEC R5 — it can change
 * between class periods, so it is resolved at boot and shown on the page
 * rather than configured anywhere).
 *
 * en0 is the Mac's Wi-Fi in practice and is preferred when present; otherwise
 * the first non-internal IPv4 wins. Link-local 169.254.x means DHCP failed and
 * no student will reach it, so it is used only as a last resort.
 */
export function lanAddress(): string {
  const ifaces = networkInterfaces();
  const candidates: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      candidates.push({ name, address: net.address });
    }
  }
  const usable = candidates.filter((c) => !c.address.startsWith('169.254.'));
  const pool = usable.length > 0 ? usable : candidates;
  const wifi = pool.find((c) => c.name === 'en0');
  return (wifi ?? pool[0])?.address ?? 'localhost';
}

async function boot(): Promise<void> {
  const [saved, settings] = await Promise.all([loadSets(), loadSettings()]);
  // First launch on a teacher's Mac has no saved sets. Ship the starter
  // questions rather than presenting a console where questions are switched
  // on and nothing ever happens — an empty set list makes the whole quiz
  // feature silently inert, which reads as broken rather than as unconfigured.
  const sets = saved.length > 0 ? saved : SAMPLE_SETS.map((s) => ({ ...s }));

  const sockets = createSocketRegistry();
  const ip = lanAddress();
  const joinUrl = `http://${ip}:${PORT}/play`;

  const room = new Match({
    send: (id, msg) => sockets.send(id, msg),
    broadcast: (msg) => sockets.broadcast(msg),
    persist,
    onQuit: () => void shutdown('teacher quit'),
    // Math.random is legal here. The ban is on src/shared/ (SPEC I12), which
    // is exactly why Match takes the generator as a dependency.
    rng: Math.random,
    settings,
    sets,
    joinUrl,
  });

  const server = startServer({ port: PORT, room, sockets, lanAddress: ip });
  room.setJoinUrl(joinUrl);

  // Fixed clock. dt is measured, not assumed, because setInterval drifts under
  // load; but it is clamped, because a closed laptop lid produces one enormous
  // dt that would otherwise fast-forward the whole match in a single tick.
  let last = Bun.nanoseconds();
  const tickTimer = setInterval(() => {
    const now = Bun.nanoseconds();
    const dt = Math.min((now - last) / 1e9, 0.25);
    last = now;
    room.tick(dt);
  }, 1000 / TIMING.tickHz);

  // SPEC §14 R6. Wi-Fi power management drops every student when the Mac
  // sleeps, so hold it awake for as long as this process lives. Entirely
  // best-effort: a missing or refused caffeinate must not cost a lesson.
  let caffeine: { kill(): void } | null = null;
  try {
    caffeine = Bun.spawn(['caffeinate', '-dimsu', '-w', String(process.pid)], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ! could not prevent sleep (${msg}); the Mac may sleep mid-class`);
  }

  const teacherUrl = `http://localhost:${server.port}/`;
  console.log(
    `\n  POLYPONG\n` +
      `  ---------------------------------------------\n` +
      `  Teacher (this Mac) :  ${teacherUrl}\n` +
      `  Students join at   :  http://${ip}:${PORT}/play\n` +
      `  Network check      :  http://${ip}:${PORT}/health\n` +
      `  ---------------------------------------------\n` +
      `  Write the join address on the board. It can change\n` +
      `  between periods, so check this screen each time.\n\n` +
      `  Press Ctrl-C to quit.\n`,
  );

  try {
    Bun.spawn(['open', teacherUrl], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
  } catch {
    console.log(`  ! could not open a browser; go to ${teacherUrl} yourself`);
  }

  let shuttingDown = false;
  async function shutdown(why: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  shutting down (${why})`);
    clearInterval(tickTimer);
    // Match has already broadcast "session ended" by the time onQuit fires.
    // This pause is that message actually leaving the socket buffers; closing
    // immediately is how the old build left students staring at a dead arena.
    await Bun.sleep(150);
    await server.stop();
    // A save queued a moment ago must land before the process goes away.
    await flush();
    caffeine?.kill();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Guarded so this module can be imported (for `lanAddress`, or by a tool) without
// binding a port. `bun run src/server/main.ts` and the compiled binary both
// satisfy import.meta.main.
if (import.meta.main) await boot();
