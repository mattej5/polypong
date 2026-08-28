// SPEC I12/I13, enforced mechanically rather than by discipline (SPEC C6).
//
// The previous build died of tangle. The rule that keeps this one honest is
// that src/shared/ is pure logic driven by an injected clock and an injected
// rng: it can therefore be run headlessly at 1000x speed under `bun test`,
// which is the only reason the liveness suite in SPEC §12 is possible at all.
// The moment one shared file reaches for Date.now, that stops being true and
// nobody notices until the fuzz tests quietly become useless.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const SHARED = join(ROOT, 'src', 'shared');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(path);
  }
  return out;
}

/** Punctuation after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_PUNCT = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<',
  '>',
]);

/** Keywords after which a `/` starts a regex literal. `return /x/.test(v)` is
 *  the exact shape in src/shared/quiz.ts, so this list is not hypothetical. */
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'void', 'delete', 'instanceof',
  'new', 'throw', 'await',
]);

function regexCanStartAfter(before: string): boolean {
  const trimmed = before.replace(/\s+$/, '');
  if (trimmed === '') return true;
  const last = trimmed.slice(-1);
  if (REGEX_AFTER_PUNCT.has(last)) return true;
  const word = /([A-Za-z_$][\w$]*)$/.exec(trimmed);
  return word !== null && REGEX_AFTER_KEYWORD.has(word[1] ?? '');
}

/**
 * Blanks out comments, string/template literals and regex literals so that a
 * comment *explaining* the ban — of which this codebase has several,
 * deliberately — does not trip the ban. Blanking rather than deleting keeps
 * line numbers intact, which is the difference between a useful failure and a
 * scavenger hunt.
 *
 * Regex literals have to be handled, not just strings: `/[",\r\n]/` in
 * quiz.ts contains a lone double quote, and a scanner that treats it as the
 * start of a string blanks the rest of the file and silently stops checking
 * it. A structural guard that quietly passes is worse than no guard.
 */
export function stripCommentsAndStrings(src: string, keepStrings = false): string {
  const out: string[] = [];
  let i = 0;
  const keep = (ch: string): void => {
    out.push(ch === '\n' ? '\n' : ' ');
  };
  while (i < src.length) {
    const ch = src[i] ?? '';
    const next = src[i + 1] ?? '';
    if (ch === '/' && next !== '/' && next !== '*') {
      if (regexCanStartAfter(out.join(''))) {
        keep(ch);
        i++;
        let inClass = false;
        while (i < src.length && src[i] !== '\n') {
          const c = src[i] ?? '';
          if (c === '\\') {
            keep(c);
            keep(src[i + 1] ?? '');
            i += 2;
            continue;
          }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          keep(c);
          i++;
        }
        if (src[i] === '/') {
          keep('/');
          i++;
          while (i < src.length && /[gimsuyd]/.test(src[i] ?? '')) keep(src[i++] ?? '');
        }
        continue;
      }
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') keep(src[i++] ?? '');
      continue;
    }
    if (ch === '/' && next === '*') {
      keep(ch);
      keep(next);
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) keep(src[i++] ?? '');
      if (i < src.length) {
        keep('*');
        keep('/');
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out.push(quote);
      i++;
      while (i < src.length) {
        const c = src[i] ?? '';
        if (c === '\\') {
          if (keepStrings) out.push(c, src[i + 1] ?? '');
          else {
            keep(c);
            keep(src[i + 1] ?? '');
          }
          i += 2;
          continue;
        }
        if (c === quote) break;
        if (keepStrings) out.push(c);
        else keep(c);
        i++;
      }
      out.push(quote);
      i++;
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}

interface Rule {
  /** Must be global; the scan reports every hit, not just the first. */
  pattern: RegExp;
  what: string;
  fix: string;
  /**
   * Import rules have to read the module specifier, which lives inside a
   * string literal — so they run against a copy with comments blanked but
   * strings intact. Everything else runs against the fully stripped copy, so a
   * comment or a message explaining the ban does not trip it. Getting this
   * backwards makes the import rules silently unmatchable, which is how a
   * boundary test ends up passing by not looking.
   */
  needsStrings?: true;
}

const RULES: Rule[] = [
  {
    pattern: /\bfrom\s+['"]([^'"]*\.\.\/(?:server|client)\/[^'"]*)['"]/g,
    what: 'imports out of src/shared into src/server or src/client',
    needsStrings: true,
    fix: 'Move the value you need into src/shared, or take it as a dependency on the function/class instead. shared/ is the layer both sides depend on; it depends on neither (SPEC §10.1).',
  },
  {
    pattern: /\bfrom\s+['"](bun|node:[a-z/]+)['"]/g,
    what: 'imports a runtime module',
    needsStrings: true,
    fix: 'Runtime modules belong in src/server/. Take the capability as an injected callback — that is how Match already gets persist() and rng().',
  },
  {
    pattern: /\brequire\s*\(\s*['"](bun|node:[a-z/]+)['"]\s*\)/g,
    what: 'requires a runtime module',
    needsStrings: true,
    fix: 'Runtime modules belong in src/server/. Take the capability as an injected callback.',
  },
  {
    pattern: /\bMath\.random\b/g,
    what: 'calls Math.random',
    fix: 'Use the injected `rng: Rng` from src/shared/config. A shared module that reaches for global randomness cannot be replayed, and the 200-match liveness fuzz in SPEC §12 stops being reproducible.',
  },
  {
    pattern: /\bDate\.now\b/g,
    what: 'calls Date.now',
    fix: 'Take `dt` from the caller. The adapter owns the clock (Match.tick(dt)); that is what lets a whole match run in milliseconds under bun test.',
  },
  {
    pattern: /\bnew\s+Date\b/g,
    what: 'constructs a Date',
    fix: 'Take `dt` from the caller. src/shared/ has no wall clock by design.',
  },
  {
    pattern: /\bperformance\.now\b/g,
    what: 'calls performance.now',
    fix: 'Take `dt` from the caller. src/shared/ has no wall clock by design.',
  },
  {
    pattern: /\bwindow\./g,
    what: 'touches window',
    fix: 'Browser globals belong in src/client/. Pass the value in, or move the code into the view layer.',
  },
  {
    pattern: /\bdocument\./g,
    what: 'touches document',
    fix: 'Browser globals belong in src/client/. Pass the value in, or move the code into the view layer.',
  },
  {
    pattern: /\blocalStorage\b/g,
    what: 'touches localStorage',
    fix: 'Persistence is injected. On the server it is storage.ts; on the client it is the net layer. src/shared/ never stores anything itself.',
  },
  {
    pattern: /\bfetch\s*\(/g,
    what: 'calls fetch',
    fix: 'src/shared/ does no I/O. Hand the result in, or move the call to src/server/ or src/client/net/.',
  },
  {
    pattern: /\bBun\./g,
    what: 'touches the Bun global',
    fix: 'The Bun global belongs in src/server/. src/shared/ must run unchanged in a browser and in a hosted worker (SPEC §14 R1).',
  },
];

describe('src/shared is free of runtime APIs (SPEC I12)', () => {
  const files = walk(SHARED);

  test('there are shared files to check', () => {
    // A silently empty walk would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(ROOT, file);
    test(rel, () => {
      const raw = readFileSync(file, 'utf8');
      const bare = stripCommentsAndStrings(raw).split('\n');
      const withStrings = stripCommentsAndStrings(raw, true).split('\n');
      const offences: string[] = [];

      for (const rule of RULES) {
        const lines = rule.needsStrings ? withStrings : bare;
        for (let n = 0; n < lines.length; n++) {
          const line = lines[n] ?? '';
          rule.pattern.lastIndex = 0;
          if (!rule.pattern.test(line)) continue;
          const source = (raw.split('\n')[n] ?? '').trim();
          offences.push(
            `${rel}:${n + 1} ${rule.what}\n` +
              `      ${source}\n` +
              `    Why it matters: ${rule.fix}`,
          );
        }
      }

      if (offences.length > 0) {
        throw new Error(
          `src/shared must not reach for a runtime API (SPEC I12).\n\n` +
            offences.join('\n\n') +
            `\n\nIf the code truly needs this capability, it is not shared code: ` +
            `move it to src/server/ or src/client/, or inject it as a dependency. ` +
            `Do not relax this test — it is the mechanism, not the paperwork.`,
        );
      }
    });
  }
});

describe('the comment stripper itself', () => {
  test('blanks line comments, block comments and strings but keeps line numbers', () => {
    const src = ['// Math.random is banned here', 'const a = 1;', '/* Date.now */', 'const s = "window.x";'].join(
      '\n',
    );
    const out = stripCommentsAndStrings(src);
    expect(out.split('\n')).toHaveLength(4);
    expect(out).not.toContain('Math.random');
    expect(out).not.toContain('Date.now');
    expect(out).not.toContain('window.');
    expect(out).toContain('const a = 1;');
  });

  test('still sees real code on the line after a comment', () => {
    const out = stripCommentsAndStrings('// note\nconst r = Math.random();');
    expect(out).toContain('Math.random');
  });

  test('a regex holding a quote does not swallow the rest of the file', () => {
    // Exactly the shape at src/shared/quiz.ts:204. Before this was handled the
    // lone " inside the character class opened a string and every later line
    // stopped being checked, so the guard passed by not looking.
    const src = ['return /[",\\r\\n]/.test(v);', 'const r = Math.random();'].join('\n');
    const out = stripCommentsAndStrings(src);
    expect(out).toContain('Math.random');
  });

  test('division is not mistaken for a regex literal', () => {
    const out = stripCommentsAndStrings('const w = a / b; document.title = w;');
    expect(out).toContain('document.');
  });

  test('a real regex assignment is blanked', () => {
    const out = stripCommentsAndStrings('const re = /window\\.x/g; const ok = 1;');
    expect(out).not.toContain('window.');
    expect(out).toContain('const ok = 1;');
  });

  test('does not run past an escaped quote', () => {
    const out = stripCommentsAndStrings('const s = "a\\"b"; const r = Math.random();');
    expect(out).toContain('Math.random');
  });
});
