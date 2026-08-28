// The starter sets ship inside the binary and are what a teacher sees on
// first launch. A row with an unquoted comma parses as garbage and is silently
// skipped, so the set quietly loses a question and nobody finds out until a
// lesson is running. That happened once; this is the guard.

import { describe, expect, test } from 'bun:test';
import { SAMPLE_SETS } from '../src/shared/sample-sets';
import { parseCsv } from '../src/shared/quiz';

describe('bundled sample sets', () => {
  test('every row parses cleanly', () => {
    for (const set of SAMPLE_SETS) {
      const { questions, issues } = parseCsv(set.csv);
      // Report the set and the offending lines, not just a count.
      expect({ set: set.name, issues }).toEqual({ set: set.name, issues: [] });
      expect(questions.length).toBeGreaterThanOrEqual(8);
    }
  });

  test('no set silently loses a row to a comma', () => {
    for (const set of SAMPLE_SETS) {
      // One data row per non-empty line after the header.
      const lines = set.csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
      expect(parseCsv(set.csv).questions.length).toBe(lines.length - 1);
    }
  });

  test('every question has 2-4 options and a correct index inside them', () => {
    for (const set of SAMPLE_SETS) {
      for (const q of parseCsv(set.csv).questions) {
        expect(q.options.length).toBeGreaterThanOrEqual(2);
        expect(q.options.length).toBeLessThanOrEqual(4);
        expect(q.correct).toBeGreaterThanOrEqual(0);
        expect(q.correct).toBeLessThan(q.options.length);
      }
    }
  });
});
