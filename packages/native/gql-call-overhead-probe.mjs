/**
 * WHAT DOES A WARM `query()` CALL COST BEFORE IT TOUCHES THE GRAPH?
 *
 * The GQL analogue of `gremlin-plan-overhead-probe.mjs` (item 1503), and it exists because item
 * 1508 spent two measurements on a fixture that could not show the answer. `parse-plan-probe.mjs`'
 * `warm q` column looked like per-call overhead — its `hop` row returns ZERO rows, so what else
 * could 1091 ns be? — but that shape is `MATCH (a:P)-[:E]->(b:P)` over a 200-vertex graph: it
 * iterates 200 vertices looking for outgoing edges and finds none. 200 iterations at ~5 ns each IS
 * the number. A fixed cost of a few tens of ns is invisible in it, which is why removing work
 * measured flat twice.
 *
 * ⚠️ SO THE FIXTURE HERE IS AS SMALL AS THE LANGUAGE ALLOWS, and the arms are ordered by how much
 * graph they touch, so the fixed cost can be read off the DIFFERENCES rather than guessed at:
 *
 *   - `floor`  — `RETURN 1 AS v`. No graph access at all. This is the pure per-call cost: cache
 *                lookup, param handling, plan lookup, row construction.
 *   - `param`  — the same with a bound `$x`, so the param path is exercised rather than skipped.
 *   - `one`    — a count over a ONE-vertex graph: the smallest call that reaches the executor's
 *                scan machinery.
 *   - `onerow` — one vertex PROJECTED, so a row is built from an element.
 *   - `ten`    — the same count over ten vertices. `ten - one` prices one vertex of iteration, and
 *                that is what says whether a given arm is dominated by the fixed cost or the loop.
 *
 * Each arm is a warm, cached text (parsed twice before timing, per `seenOnce`'s admission filter).
 *
 *     node gql-call-overhead-probe.mjs
 *     PROF_ARM=floor PROF_OUT=/tmp/x.cpuprofile node gql-call-overhead-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { profileWindow } from './windowed-profile.mjs';

const REPS = Number(process.env.REPS ?? 50_000);
const DROP = Number(process.env.DROP ?? 3);
const ROUNDS = Number(process.env.ROUNDS ?? 9);

const graphOf = (n) => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } });
  }

  return g;
};

const g1 = graphOf(1);
const g10 = graphOf(10);

/**
 * ⚠️ THE CONTROL FOR ITEM 1509'S GATE, and the arm where it can only LOSE.
 *
 * Item 1509 skips the parse cache's LRU `delete`+`set` while the cache is below `PARSE_CACHE_CAP`,
 * because nothing is evicted there so the recency order it maintains is never read. When the cache
 * is FULL that reasoning stops applying: the pair runs as before, plus the gate's own size read and
 * compare. So this arm fills the cache past its cap and then hammers ONE text, which is the steady
 * state where every hit pays the full price. It must measure flat against the ungated build —
 * anything else means the gate costs more than the bookkeeping it is skipping.
 */
const FILLERS = [];

for (let i = 0; i < 80; i += 1) {
  FILLERS.push(`RETURN ${i} AS fill${i}`);
}

const fillCache = () => {
  for (const t of FILLERS) {
    query(g1, t);
    query(g1, t);
  }
};

const ARMS = {
  floor: [g1, 'RETURN 1 AS v', undefined],
  param: [g1, 'RETURN $x AS v', { x: 1 }],
  one: [g1, 'MATCH (n:P) RETURN count(*) AS c', undefined],
  onerow: [g1, 'MATCH (n:P) RETURN n.k AS k', undefined],
  ten: [g10, 'MATCH (n:P) RETURN count(*) AS c', undefined],
  full: [g1, FILLERS[40], undefined],
  // ⚠️ THE LIFT-CACHE GAP (item 1540). A text whose literals `normalizeLiterals` ADMITS is parsed
  // and cached under the LIFTED text (`LET x = $__ap0 RETURN x`), so `parseCacheHit(originalText)`
  // misses on EVERY repeat call and the ~865 ns tokenize is paid again, forever. Verified by
  // querying the lifted text directly after four calls of the literal form: the cache size stays 1,
  // so the key it holds is the lifted one.
  //
  //   letlit   LET x = 5 RETURN x    1094.4 / 1099.8 ns/call
  //   letparam LET x = $p RETURN x    303.4 /  278.9        <- 3.6-3.9x, the SAME plan
  //   letlit2  one more literal LET  1463.8 / 1483.3        <- ~+370 per lifted literal
  //
  // `RETURN 1 AS v` (the `floor` arm) ESCAPES at ~100 ns because its literal position is not in the
  // allowlist, so no lift happens and the ORIGINAL text is what gets cached. The gap is exactly
  // "did a lift happen", which makes the queries auto-parameterization exists to help the only ones
  // that never hit the cache.
  //
  // It is a SMALL-QUERY cost and the sizing says so: on `MATCH (n:P) WHERE n.k = 5 RETURN n.k`
  // (~2,062 rows) the literal and param spellings are 3.95 ms against 3.83 ms — 2.3%, noise. This
  // taxes the serving workload (`bun run bench:usage`), not row production.
  letlit: [g1, 'LET x = 5 RETURN x', undefined],
  letparam: [g1, 'LET x = $p RETURN x', { p: 5 }],
  letlit2: [g1, 'LET x = 1 LET y = 2 RETURN y', undefined],
};

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[(s.length - 1) >> 1];
};

const timeRound = (fn) => {
  const t0 = performance.now();

  for (let i = 0; i < REPS; i += 1) {
    fn();
  }

  return ((performance.now() - t0) * 1e6) / REPS;
};

// Warm every cache before a single number is taken: a text is admitted on its SECOND sighting
// (`seenOnce`), so one call is not enough and an unwarmed arm would measure the parse.
/**
 * ⚠️ `full` RUNS IN ITS OWN PROCESS, and that is not tidiness. Saturating the cache changes the
 * regime for EVERY arm, not just this one: a 64-entry `Map` makes `get` itself measurably slower
 * than a 6-entry one, and filling it for all arms moved `floor` from 97 to 151 ns before anything
 * was being measured. So the fill happens only when `full` is the selected arm (`ARM=full`), and
 * `full` is excluded from an unfiltered run. Item 737's one-shape-per-process rule.
 */
const ONLY = process.env.ARM;
const names = ONLY === undefined ? Object.keys(ARMS).filter((n) => n !== 'full') : [ONLY];

if (ONLY === 'full') {
  fillCache();
}

for (const name of names) {
  const [g, text, params] = ARMS[name];

  query(g, text, params);
  query(g, text, params);
}

const out = {};

for (const name of names) {
  const [g, text, params] = ARMS[name];
  const rounds = [];

  for (let r = 0; r < ROUNDS; r += 1) {
    rounds.push(timeRound(() => query(g, text, params)));
  }

  out[name] = med(rounds.slice(DROP));
}

const profArm = process.env.PROF_ARM ?? 'floor';
const [pg, ptext, pparams] = ARMS[profArm];

await profileWindow(process.env.PROF_OUT, () => {
  for (let i = 0; i < REPS * 3; i += 1) {
    query(pg, ptext, pparams);
  }

  return 0;
});

console.log(`\nGQL WARM CALL OVERHEAD — REPS=${REPS} ROUNDS=${ROUNDS} (median, ns per call)\n`);

for (const name of names) {
  console.log(`${name.padEnd(9)}${out[name].toFixed(1).padStart(9)}`);
}

console.log(`\nper vertex of iteration (ten - one)/9: ${((out.ten - out.one) / 9).toFixed(1)} ns`);
console.log(
  `scan machinery over the floor (one - floor): ${(out.one - out.floor).toFixed(1)} ns\n`,
);
