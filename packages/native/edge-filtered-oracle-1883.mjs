/**
 * DOES THE FUSED EDGE-PREDICATE WALK ANSWER WHAT THE GENERIC PIPELINE ANSWERS? (item 1883)
 *
 * ⚠️ THE UNIT TEST'S ORACLE IS HAND-COMPUTED AND SMALL; THIS ONE IS THE OTHER ENGINE PATH. The rung
 * displaces the generic traverser pipeline, so the only complete statement of its contract is "the
 * same queries, both routes, identical sequences". That cannot be written as a unit test, because
 * both arms are reached by the SAME traversal text — so this is a two-build differential, the
 * device `gremlin-walk-order-probe.mjs` uses:
 *
 *   PRE  — the rung's call site replaced by `undefined` in the BUILT dist: a kill switch, so every
 *          query below runs the generic pipeline it ran before item 1883.
 *   POST — the shipped build.
 *
 * ⚠️ ORDER IS COMPARED, NOT JUST THE MULTISET. Gremlin stream order is a TinkerPop contract and the
 * differential fuzzer compares Gremlin results ORDERED (unlike GQL, where row order is
 * unspecified). A reordering here would be a cross-engine failure, so the comparison is
 * `JSON.stringify` of the sequence.
 *
 * ⚠️ AND IT ASSERTS ITS OWN ARMS. CLAUDE.md: "`cp` with one of the two files never written leaves
 * the previous arm in place, and the 'after' reading is then the 'before' code — a null that looks
 * like a result." The kill switch is verified present in the dist before the PRE arm runs and
 * absent before the POST arm, and the PRE arm must report that the rung claimed NOTHING while the
 * POST arm must report that it claimed every query the battery means to cover.
 *
 *     bun edge-filtered-oracle-1883.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const DIST = `${ROOT}/packages/gremlin/dist/esm/index.mjs`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1883-dist.mjs`;
const CALL = 'edgeFilteredHopValues(effective, graph)';
const KILLED = '(void 0 /* KILL_1883 */)';
const CHILD = `${ROOT}/packages/native/zz-edge-filtered-battery-1883.mjs`;

/**
 * The battery. Every spelling the route census named, each over three fixture shapes — and a
 * handful the rung DECLINES, as controls: if a control's two arms ever differ, the harness itself
 * is broken rather than the rung.
 */
const battery = `
import { Graph } from '@lenke/core';
import { V, bothE, count, eq, gt, gte, has, id, inE, inV, lt, order, otherV, outE, outV, toArray, traversal, values, within } from '@lenke/gremlin';

const fixtures = {
  // Fanout 3 with two edge types and a missing property on every third edge.
  mixed: { n: 120, fanout: 3, types: ['E', 'E', 'F'], holes: 3, holeKey: true },
  // Single type, every edge carrying 'w' — the dense shape.
  dense: { n: 90, fanout: 4, types: ['E'], holes: 0, holeKey: false },
  // Sparse and self-looping, with far vertices missing the projected key.
  sparse: { n: 40, fanout: 1, types: ['E', 'F'], holes: 2, holeKey: false },
};

const build = (spec) => {
  const g = new Graph();

  for (let i = 0; i < spec.n; i += 1) {
    const properties = i % 5 === 3 ? { other: i } : { n: i % 11, s: 'k' + String(i % 4) };

    g.addVertex({ id: 'v' + String(i), labels: i % 3 === 0 ? ['T', 'U'] : ['T'], properties });
  }

  let e = 0;

  for (let hop = 0; hop < spec.fanout; hop += 1) {
    for (let i = 0; i < spec.n; i += 1) {
      const w = spec.holes > 0 && e % spec.holes === 0 ? {} : { w: [1, 2, 3, 5, 8, 13][e % 6] };

      g.addEdge({
        id: 'e' + String(e),
        from: g.getVertexById('v' + String(i)),
        to: g.getVertexById('v' + String((i * 7 + 3 + hop * 2654435761) % spec.n)),
        labels: [spec.types[e % spec.types.length]],
        properties: w,
      });
      e += 1;
    }
  }

  // A self-loop and an edge with NO properties at all, on a vertex that has others.
  g.addEdge({ id: 'self', from: g.getVertexById('v1'), to: g.getVertexById('v1'), labels: ['E'], properties: { w: 8 } });
  g.addEdge({ id: 'bare', from: g.getVertexById('v2'), to: g.getVertexById('v3'), labels: ['E'], properties: {} });

  return g;
};

const QUERIES = {
  'outE has gt inV values': () => traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n')),
  'outE has gte inV values': () => traversal(V(), outE('E'), has('w', gte(5)), inV(), values('n')),
  'outE has lt inV values': () => traversal(V(), outE('E'), has('w', lt(3)), inV(), values('n')),
  'outE has eq inV values': () => traversal(V(), outE('E'), has('w', eq(8)), inV(), values('n')),
  'outE has literal inV values': () => traversal(V(), outE('E'), has('w', 13), inV(), values('n')),
  'outE has within inV values': () => traversal(V(), outE('E'), has('w', within(1, 8)), inV(), values('n')),
  'outE has MISSING key inV values': () => traversal(V(), outE('E'), has('nope', gt(0)), inV(), values('n')),
  'outE has inV values other key': () => traversal(V(), outE('E'), has('w', gt(3)), inV(), values('s')),
  'outE has inV values absent key': () => traversal(V(), outE('E'), has('w', gt(3)), inV(), values('other')),
  'outE has inV id': () => traversal(V(), outE('E'), has('w', gt(3)), inV(), id()),
  'outE has inV bare': () => traversal(V(), outE('E'), has('w', gt(3)), inV()),
  'outE has has inV values': () => traversal(V(), outE('E'), has('w', gt(1)), has('w', lt(9)), inV(), values('n')),
  'outE has x3 inV values': () => traversal(V(), outE('E'), has('w', gt(1)), has('w', lt(13)), has('w', gte(3)), inV(), values('n')),
  'inE has outV values': () => traversal(V(), inE('E'), has('w', gt(3)), outV(), values('n')),
  'inE has outV id': () => traversal(V(), inE('E'), has('w', gt(3)), outV(), id()),
  'outE F has inV values': () => traversal(V(), outE('F'), has('w', gt(3)), inV(), values('n')),
  'outE has inV values count': () => traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n'), count()),
  'outE has inV values order': () => traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n'), order()),
  // CONTROLS the rung declines — their arms must agree trivially.
  'CONTROL outE inV values': () => traversal(V(), outE('E'), inV(), values('n')),
  'CONTROL bothE has otherV values': () => traversal(V(), bothE('E'), has('w', gt(3)), otherV(), values('n')),
  'CONTROL outE multi has inV': () => traversal(V(), outE('E', 'F'), has('w', gt(3)), inV(), values('n')),
  'CONTROL outE has outV values': () => traversal(V(), outE('E'), has('w', gt(3)), outV(), values('n')),
  'CONTROL seeded outE has inV': () => traversal(V('v1'), outE('E'), has('w', gt(3)), inV(), values('n')),
};

const out = {};
const claimed = {};

for (const [fname, spec] of Object.entries(fixtures)) {
  const g = build(spec);

  for (const [qname, make] of Object.entries(QUERIES)) {
    const before = globalThis.__EFHV_1883 ?? 0;
    let got;

    try {
      got = toArray(make(), g).map((x) => (x !== null && typeof x === 'object' && 'id' in x ? '@' + String(x.id) : x));
    } catch (err) {
      got = ['RAISED:' + String(err).slice(0, 40)];
    }

    out[fname + ' | ' + qname] = got;
    claimed[fname + ' | ' + qname] = (globalThis.__EFHV_1883 ?? 0) - before;
  }
}

process.stdout.write(JSON.stringify({ results: out, claimed, claims: globalThis.__EFHV_1883 ?? 0 }));
`;

const COUNTER = `((__r) => { if (__r !== undefined) { globalThis.__EFHV_1883 = (globalThis.__EFHV_1883 ?? 0) + 1; } return __r; })(${CALL})`;

const runChild = () => {
  const r = spawnSync('timeout', ['300', 'bun', CHILD], {
    cwd: `${ROOT}/packages/native`,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

  if (r.status !== 0) {
    throw new Error(`child failed (${String(r.status)}): ${String(r.stderr).slice(-1200)}`);
  }

  return JSON.parse(r.stdout);
};

copyFileSync(DIST, PRISTINE);
writeFileSync(CHILD, battery);

let pre;
let post;

try {
  const pristine = readFileSync(PRISTINE, 'utf8');

  if (pristine.split(CALL).length - 1 !== 1) {
    throw new Error('the rung call site is not in the dist exactly once — rebuild, then re-run');
  }

  // PRE: the kill switch ALONE. ⚠️ The first cut wrote `${KILLED} ?? ${COUNTER}` so the arm could
  // also COUNT its (expected zero) claims — and `??` on `void 0` falls straight through, so the
  // "killed" arm called the rung 51 times. The arm assertion caught it, which is the whole reason
  // it is there; the PRE arm's proof is the KILL_1883 marker plus a counter that is never set.
  writeFileSync(DIST, pristine.replace(CALL, KILLED));

  if (!readFileSync(DIST, 'utf8').includes('KILL_1883')) {
    throw new Error('ARM ASSERTION FAILED: the PRE arm is not the killed build');
  }

  pre = runChild();

  if (pre.claims !== 0) {
    throw new Error(`ARM ASSERTION FAILED: the PRE arm took the rung ${String(pre.claims)} times`);
  }

  // POST: the shipped build, with the counter only.
  writeFileSync(DIST, pristine.replace(CALL, COUNTER));

  if (readFileSync(DIST, 'utf8').includes('KILL_1883')) {
    throw new Error('ARM ASSERTION FAILED: the POST arm still carries the kill switch');
  }

  post = runChild();

  if (post.claims === 0) {
    throw new Error('ARM ASSERTION FAILED: the POST arm never took the rung');
  }
} finally {
  copyFileSync(PRISTINE, DIST);
  // ⚠️ THE GENERATED CHILD IS REMOVED HERE. It has to live in `packages/native` for `@lenke/*` to
  // resolve, so it cannot go in the scratchpad — and left behind it is a lint target the gate
  // fails on (which is how this line came to exist).
  rmSync(CHILD, { force: true });
}

const names = Object.keys(pre.results);
const bad = [];

for (const name of names) {
  const a = JSON.stringify(pre.results[name]);
  const b = JSON.stringify(post.results[name]);

  if (a !== b) {
    bad.push([name, a.slice(0, 160), b.slice(0, 160)]);
  }
}

console.log(`# ${String(names.length)} query/fixture pairs, both routes, ORDERED comparison`);
console.log(
  `# the rung claimed ${String(post.claims)} of them in the POST arm (0 in PRE, asserted)`,
);

// Which pairs the rung did NOT claim, so a reader can see the battery's real coverage rather than
// infer it from a total — a control is expected here, anything else is a decline worth knowing.
const unclaimed = names.filter((n) => (post.claimed?.[n] ?? 0) === 0);

console.log(
  `# unclaimed (${String(unclaimed.length)}): ${unclaimed
    .map((n) => n.split(' | ')[1])
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(', ')}`,
);

for (const [name, a, b] of bad) {
  console.log(`\n❌ ${name}\n   generic: ${a}\n   fused:   ${b}`);
}

console.log(
  bad.length === 0 ? '\n✅ every pair identical' : `\n⚠️ ${String(bad.length)} DIVERGENCE(S)`,
);

if (bad.length > 0) {
  process.exitCode = 1;
}
