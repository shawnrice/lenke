import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

/**
 * DOES EVERY SORT SHAPE AGREE WITH NATIVE, AND WHICH RUNG SERVES IT? (item 1904)
 *
 * **THIS EXISTS BECAUSE ITEM 1903 FOUND A SHIPPED WRONG ANSWER BY ACCIDENT.** A hop sort key
 * reading an end the projection does not was ranked on NULL keys and came back in the walk's
 * arrival order — four of five end/key combinations diverged from native, `ORDER BY e.w LIMIT 3`
 * among them. It was found only because a perf gate routed a second spelling into the broken arm and
 * item 642's test happened to cover one case. Nothing systematic was asking.
 *
 * AND THE THREE STORES THAT SHOULD HAVE ASKED ARE EACH BLIND IN THE SAME WAY: the workload
 * corpus ordered only by the projection's ALIAS, the spelling probe's ordered groups all carried a
 * `LIMIT`, and the perf screen's fixture had so many ties that the wrong answer produced the SAME
 * first ten rows (and measured 7.6x FASTER). So this is a MATRIX over the axes those stores hold
 * fixed: which end the projection reads, which end the KEY reads, how the key is spelled, and which
 * window is on it.
 *
 * THE FIXTURE IS BUILT TO MAKE EVERY ORDER DIFFERENT FROM EVERY OTHER, which is the lesson item
 * 1903 paid for:
 *
 *   - `n` is DISTINCT, so the walk's arrival order is never a plausible answer;
 *   - each edge points at the vertex that REVERSES it, so the near and far ends order oppositely;
 *   - the rel's `w` ascends with neither, so a rel key is a third order;
 *   - `t` is a four-way TIE group, so tie order is exercised (observable between engines, item 605);
 *   - `nu` is null on a third, and `sp` is ABSENT on two thirds.
 *
 *     bun sort-matrix-1904.ts            # the matrix
 *     ROUTES=1 bun sort-matrix-1904.ts   # also print the rung census
 *
 * THE FIXTURE AND THE SHAPE LIST LIVE IN `src/sort-matrix.ts`, shared with
 * `src/sort-matrix.test.ts` — item 606's reason, which `ordered-rows.ts` records: "two copies of
 * this list is how one of them falls behind the other". AND THE TEST IS THE GUARD, not this
 * probe: item 1901 found a "start here" census had been DARK for ~15 items because nobody ran it.
 * What this file adds is the ROUTE census, which a test has no business asserting.
 */
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build, as `rung-precedence-census.mjs` does
import { compileLinear } from '../gql/src/executor/rewrites.ts';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- ditto
import { parse } from '../gql/src/parser.ts';
import { nativeBackend, nativeReady, resultsEqualInOrder } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';
import { sortMatrixNdjson, sortMatrixShapes } from './src/sort-matrix.js';

const N = Number(process.env.N ?? 48);
const SHOW_ROUTES = process.env.ROUTES === '1';

const rungsFor = (text: string): string => {
  try {
    const stmt = parse(text);

    if (!('parts' in stmt)) {
      return 'not-linear';
    }

    const lin = compileLinear(stmt.parts[0]) as Record<string, unknown> | undefined;

    if (lin === undefined) {
      return 'GENERAL';
    }

    const willing = Object.entries(lin)
      .filter(([k, v]) => v !== undefined && v !== null && k !== 'clauses' && k !== 'writes')
      .map(([k]) => k);

    return willing.length === 0 ? 'GENERAL' : willing[0];
  } catch {
    return 'parse-error';
  }
};

if (!nativeReady) {
  console.log('native engine not available — nothing to compare against');
} else {
  const doc = sortMatrixNdjson(N);
  const nat = graphFromNdjson(nativeBackend(), doc);
  const ts = tsDeserialize(doc, 'ndjson', new Graph());
  const all = sortMatrixShapes();
  const diverged: { text: string; a: unknown; b: unknown; rung: string }[] = [];
  const routes = new Map<string, number>();
  let errors = 0;
  let empty = 0;

  for (const text of all) {
    const rung = rungsFor(text);

    routes.set(rung, (routes.get(rung) ?? 0) + 1);

    let a: unknown;
    let b: unknown;

    try {
      a = tsQuery(ts, text);
    } catch (err) {
      a = `THREW ${String(err).split('\n')[0].slice(0, 60)}`;
    }

    try {
      b = nat.query(text);
    } catch (err) {
      b = `THREW ${String(err).split('\n')[0].slice(0, 60)}`;
    }

    if (typeof a === 'string' || typeof b === 'string') {
      if (a !== b) {
        diverged.push({ text, a, b, rung });
      } else {
        errors += 1;
      }

      continue;
    }

    // IN ORDER, not as a multiset: `ORDER BY` makes row order part of the answer, and tie order
    // is observable between the engines (item 605).
    // IT TAKES JSON STRINGS, not the arrays — the first cut passed objects and `JSON.parse`
    // choked on "[object Object]".
    if (!resultsEqualInOrder(JSON.stringify(a), JSON.stringify(b))) {
      diverged.push({ text, a, b, rung });
      continue;
    }

    if ((a as unknown[]).length === 0) {
      empty += 1;
    }
  }

  console.log(
    `# sort-matrix-1904  N=${String(N)}  ${String(all.length)} shapes  ` +
      `${String(errors)} raised on BOTH engines  ${String(empty)} empty (the LIMIT 0 arm)`,
  );
  console.log('');

  if (diverged.length === 0) {
    console.log('every shape agrees with native, IN ORDER');
  } else {
    console.log(`${String(diverged.length)} SHAPE(S) DIVERGE:`);

    for (const d of diverged) {
      console.log(`\n  ${d.text}      [${d.rung}]`);
      console.log(`    TS      ${JSON.stringify(d.a).slice(0, 150)}`);
      console.log(`    native  ${JSON.stringify(d.b).slice(0, 150)}`);
    }
  }

  if (SHOW_ROUTES) {
    console.log('\n# which rung FIRES, by count');

    for (const [rung, n] of [...routes.entries()].sort((x, y) => y[1] - x[1])) {
      console.log(`  ${String(n).padStart(4)}  ${rung}`);
    }
  }

  process.exitCode = diverged.length === 0 ? 0 : 1;
}
