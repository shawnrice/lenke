/**
 * IS THE BOUNDED REACHABILITY RUNG'S ANSWER THE GENERAL MATCHER'S ANSWER? (item 1848)
 *
 * Item 1848 let `detectReachableShortcut` take a BOUNDED quantifier (`{1,3}`), which used to be
 * refused and sent to path enumeration at 165.5 ms for 8 rows. The new arm is a depth-capped BFS
 * keyed on SHORTEST distance, and its soundness argument — "a vertex whose shortest distance is
 * `d` is reachable by a walk of length `d`, so it is in the answer exactly when `1 <= d <= max`" —
 * is exactly the kind of reasoning that is convincing and wrong.
 *
 * ⚠️ SO THE ORACLE IS THE GENERAL MATCHER, REACHED BY FORCING THE RUNG TO DECLINE. Comparing the
 * rung against itself in another spelling proves nothing if both spellings take it; the first
 * check of this change did that and was self-consistent while saying nothing. This runs each query
 * twice — once with the detector live, once with it returning `null` — and compares the SETS.
 *
 * ⚠️ THE ARMS ARE ASSERTED by a marker in the built dist, and the FIXTURES are the ones where a
 * shortest-distance search can go wrong: a self-loop, a 2-cycle, a 3-cycle, a diamond with two
 * path lengths to the same vertex, and a chain long enough to exceed every bound tested.
 *
 *     bun bounded-reach-oracle.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gql/src/executor/reachability.ts`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1848-reach.ts`;
const MARKER = 'BOUNDED_REACH_ORACLE_1848';

const ANCHOR = `export const detectReachableShortcut = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ReachFn | null => {`;

const MODES = ['', 'TRAIL ', 'WALK ', 'SIMPLE ', 'ACYCLIC '];
const QUANTS = ['{1,1}', '{1,2}', '{1,3}', '{1,4}', '{1,5}', '{0,2}', '{0,3}', '{2,3}', '{1,}'];

/**
 * Each fixture names the hazard it carries. A shortest-distance search is exact only if a vertex
 * reachable at some length in range is reachable at its SHORTEST length too — these are the shapes
 * where that could fail.
 */
const FIXTURES = {
  'self-loop + 2-cycle + 3-cycle': [
    ['1', 'a', 'a'],
    ['2', 'a', 'b'],
    ['3', 'b', 'a'],
    ['4', 'b', 'c'],
    ['5', 'c', 'd'],
    ['6', 'd', 'b'],
  ],
  'diamond, two lengths to one vertex': [
    ['1', 'a', 'b'],
    ['2', 'a', 'c'],
    ['3', 'b', 'd'],
    ['4', 'c', 'e'],
    ['5', 'e', 'd'],
  ],
  'long chain past every bound': [
    ['1', 'a', 'b'],
    ['2', 'b', 'c'],
    ['3', 'c', 'd'],
    ['4', 'd', 'e'],
    ['5', 'e', 'f'],
    ['6', 'f', 'g'],
    ['7', 'g', 'h'],
  ],
  'disconnected + back edge': [
    ['1', 'a', 'b'],
    ['2', 'b', 'c'],
    ['3', 'c', 'a'],
    ['4', 'e', 'f'],
    ['5', 'g', 'g'],
  ],
};

const build = () => execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

const markerInDist = () =>
  readFileSync(`${ROOT}/packages/gql/dist/esm/index.mjs`, 'utf8').includes(MARKER);

const child = (edges) => {
  const src = `
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
for (const id of ['a','b','c','d','e','f','g','h']) {
  g.addVertex({ id, labels: ['T'], properties: { n: id } });
}
for (const [id, f, t] of ${JSON.stringify(edges)}) {
  g.addEdge({ id, from: g.getVertexById(f), to: g.getVertexById(t), labels: ['E'] });
}
const MODES = ${JSON.stringify(MODES)};
const QUANTS = ${JSON.stringify(QUANTS)};
const out = {};
for (const mode of MODES) {
  for (const q of QUANTS) {
    for (const [tag, tail] of [['rows','RETURN DISTINCT b.n AS x'], ['count','RETURN count(DISTINCT b) AS x']]) {
      const text = 'MATCH ' + mode + '(a:T)-[:E]->' + q + '(b:T) ' + tail;
      try {
        out[mode + q + '|' + tag] = query(g, text).map((r) => Object.values(r).map(String).join('/')).sort().join(',');
      } catch (e) {
        out[mode + q + '|' + tag] = 'ERR:' + String(e.message).slice(0, 60);
      }
    }
  }
}
process.stdout.write(JSON.stringify(out));
`;

  return JSON.parse(
    execFileSync('bun', ['--input-type=module', '-e', src], {
      cwd: `${ROOT}/packages/native`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
};

copyFileSync(SRC, PRISTINE);

try {
  // ── ARM 1: the rung live ──────────────────────────────────────────────────────────────────────
  build();

  if (markerInDist()) {
    throw new Error('ARM ASSERTION FAILED: the live arm already carries the mutant marker');
  }

  const live = {};

  for (const [name, edges] of Object.entries(FIXTURES)) {
    live[name] = child(edges);
  }

  // ── ARM 2: the rung forced to decline ─────────────────────────────────────────────────────────
  const s = readFileSync(PRISTINE, 'utf8');

  if (s.split(ANCHOR).length - 1 !== 1) {
    throw new Error('anchor not found exactly once — the probe needs updating');
  }

  writeFileSync(
    SRC,
    s.replace(ANCHOR, `${ANCHOR}\n  if (String(clauses) !== '${MARKER}') {\n    return null;\n  }`),
  );
  build();

  if (!markerInDist()) {
    throw new Error('ARM ASSERTION FAILED: the general arm does NOT carry the mutant marker');
  }

  console.log('# bounded-reach-oracle — the rung against the GENERAL MATCHER, arms asserted\n');

  let disagreements = 0;
  let compared = 0;

  for (const [name, edges] of Object.entries(FIXTURES)) {
    const general = child(edges);
    const bad = [];

    for (const key of Object.keys(live[name])) {
      compared += 1;

      if (live[name][key] !== general[key]) {
        bad.push(`${key}: rung=[${live[name][key]}] general=[${general[key]}]`);
      }
    }

    disagreements += bad.length;
    console.log(`## ${name}`);
    console.log(bad.length === 0 ? '   all agree' : bad.map((b) => `   ⚠️ ${b}`).join('\n'));
  }

  const verdict = disagreements === 0 ? ' — the bounded arm matches the general matcher' : ' ⚠️';

  console.log(`\n# ${compared} comparisons, ${disagreements} disagreement(s)${verdict}`);
} finally {
  copyFileSync(PRISTINE, SRC);
  build();
  console.log('# restored and rebuilt');
}
