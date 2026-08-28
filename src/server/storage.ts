// The only file in the project that touches a filesystem (SPEC §10.1).
//
// Match is handed a `persist(payload)` callback and never imports this. That
// is the whole reason the game can be lifted onto a hosted server later: the
// replacement for this file is a storage.put and nothing else changes.
//
// Two things here are load-bearing for a real classroom:
//   1. Every write is atomic (temp file, then rename). A teacher hitting Save
//      twice mid-lesson, or the app being force-quit, must never leave a
//      half-written JSON that fails to parse next period.
//   2. Every read is defensive. A missing file, an empty file, or a file a
//      curious teacher hand-edited into rubble yields defaults. Nothing in
//      here is allowed to throw on the boot path.

import { mkdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { MatchSettings } from '../shared/config';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../shared/config';
import type { PersistPayload, QuestionSetRecord } from '../shared/match';

/** SPEC §4. Overridable so tests never write into the real teacher's data. */
export const DATA_DIR =
  process.env['POLYPONG_DATA_DIR'] ?? join(homedir(), 'Library', 'Application Support', 'PolyPong');

const SETS_FILE = join(DATA_DIR, 'question-sets.json');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

// --------------------------------------------------------------- read side

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

async function readJson(path: string): Promise<unknown> {
  try {
    const text = await Bun.file(path).text();
    if (text.trim() === '') return undefined; // an empty file is a first run, not an error
    return JSON.parse(text) as unknown;
  } catch {
    // Missing, unreadable, or not JSON. All three mean "use defaults".
    return undefined;
  }
}

/** Drops any row that is not a usable set rather than failing the whole load:
 *  one corrupt row must not cost a teacher the other nine sets. */
function coerceSets(raw: unknown): QuestionSetRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionSetRecord[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const { id, name, csv } = item;
    if (typeof id !== 'string' || id === '') continue;
    if (typeof name !== 'string') continue;
    if (typeof csv !== 'string') continue;
    out.push({ id, name, csv });
  }
  return out;
}

export async function loadSets(): Promise<QuestionSetRecord[]> {
  const raw = await readJson(SETS_FILE);
  // Accept both a bare array and { sets: [...] }, because the shape written by
  // an older build should not cost the teacher their question sets.
  if (Array.isArray(raw)) return coerceSets(raw);
  if (isRecord(raw)) return coerceSets(raw['sets']);
  return [];
}

export async function loadSettings(): Promise<MatchSettings> {
  const raw = await readJson(SETTINGS_FILE);
  if (!isRecord(raw)) return { ...DEFAULT_SETTINGS };
  // sanitizeSettings already clamps every field and never throws, so anything
  // at all can be handed to it.
  return sanitizeSettings(raw as Partial<MatchSettings>, DEFAULT_SETTINGS);
}

// -------------------------------------------------------------- write side

// Every write goes through this one chain, so two saves a millisecond apart
// are ordered rather than racing over the same temp file.
let writing: Promise<void> = Promise.resolve();
let ensured = false;

async function ensureDir(): Promise<void> {
  if (ensured) return;
  await mkdir(DATA_DIR, { recursive: true });
  ensured = true;
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await ensureDir();
  // The temp name carries the pid so two PolyPong instances on one Mac cannot
  // rename each other's half-written file into place.
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await Bun.write(tmp, text);
    // rename() within a filesystem is atomic: readers see either the old file
    // or the new one, never a partial write.
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Match's `persist` callback (SPEC §10.1). Fire-and-forget by contract —
 * Match returns void — but the work is queued on `writing` so shutdown can
 * await it and a teacher's last save is never lost to the exit.
 */
export function persist(payload: PersistPayload): void {
  writing = writing
    .then(async () => {
      await writeAtomic(SETS_FILE, JSON.stringify(payload.sets, null, 2));
      await writeAtomic(SETTINGS_FILE, JSON.stringify(payload.settings, null, 2));
    })
    .catch((err: unknown) => {
      // Losing a save is bad; taking the running match down with it is worse.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ! could not save to ${DATA_DIR}: ${msg}`);
    });
}

/** Await every queued write. Called on shutdown before the process exits. */
export function flush(): Promise<void> {
  return writing;
}
