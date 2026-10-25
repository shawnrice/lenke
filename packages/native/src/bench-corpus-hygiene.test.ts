import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The bench corpus must not carry a row that was only meant to exist for one measurement.
 *
 * This test exists because that happened. Item 736 added a depth-5 quantified row to run an
 * ablation, labelled it `TEMPORARY … Remove before commit`, and committed it (`069e3707`). It
 * survived four more commits and was found at item 746 — sitting directly above a comment asserting
 * "THERE IS DELIBERATELY NO DEPTH-5 ROW", so the file contradicted itself in adjacent lines.
 *
 * The cost is not cosmetic. `REPS` is 5 and does not adapt, and that row measured 16,325.9 ms per
 * rep at 20,000 vertices (item 732), so it added ~82 s to a sweep that takes 17 s without it — and
 * the default `BENCH_N` is ten times larger. Item 732's rule is the one it broke: a regression sweep
 * nobody runs because it takes a quarter-hour catches nothing.
 *
 * Reading the source as TEXT rather than importing it is deliberate: importing builds the
 * 200,000-vertex fixtures at module scope, which is minutes of work to assert on a string.
 */
const BENCHES = ['bench.ts', 'bench-usage.ts', 'bench-gremlin.ts'] as const;

const read = (file: string): string | null => {
  try {
    return readFileSync(join(import.meta.dir, '..', file), 'utf8');
  } catch {
    // A bench file may be renamed or removed; the hygiene rule is about the ones that exist.
    return null;
  }
};

describe('the bench corpus carries no temporary rows', () => {
  test('no row NAME is marked temporary', () => {
    for (const file of BENCHES) {
      const src = read(file);

      if (src === null) {
        continue;
      }

      const names = [...src.matchAll(/name:\s*'([^']*)'/g)].map((m) => m[1]);

      // Not an empty-set pass: if the extraction stops matching, the test must fail rather than
      // silently assert nothing. `bench.ts` has dozens of rows.
      if (file === 'bench.ts') {
        expect(names.length).toBeGreaterThan(20);
      }

      for (const name of names) {
        expect(name).not.toMatch(/\bTEMP\b|\bTEMPORARY\b|\bTMP\b/i);
      }
    }
  });

  test('no row is left behind its own "remove before commit" marker', () => {
    for (const file of BENCHES) {
      const src = read(file);

      if (src === null) {
        continue;
      }

      // The marker I wrote at item 736 and then committed, verbatim in spirit: any note saying a
      // row is to be removed means the row is still there.
      expect(src).not.toMatch(/remove before commit/i);
    }
  });
});
