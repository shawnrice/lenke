/**
 * DOES THE FUSED `optional(<hop>)` WALK ANSWER WHAT THE GENERIC PIPELINE ANSWERS? (item 1884)
 *
 * The twin of `edge-filtered-oracle-1883.mjs`, same device and same reasons: the rung displaces the
 * traverser pipeline, so the complete statement of its contract is "the same queries, both routes,
 * identical sequences", and both arms are reached by the SAME traversal text — which no unit test
 * can express.
 *
 *   PRE  — the rung's call site replaced by `void 0` in the BUILT dist, so every query runs the
 *          pipeline it ran before item 1884 (which already had `optional-hop.ts`'s fused STEP).
 *   POST — the shipped build.
 *
 * ORDER IS COMPARED, NOT THE MULTISET — Gremlin stream order is a TinkerPop contract and the
 * differential fuzzer compares Gremlin results ORDERED.
 *
 * AND `undefined` IS DISTINGUISHED FROM `null` IN THE COMPARISON. A dropped row and a stored
 * null are different answers, and item 1884's first test file let a mutant live because `toEqual`
 * ignores `undefined` entries; `JSON.stringify` would collapse them the same way, so the battery
 * maps `undefined` to a marker string before serializing.
 *
 * THE FIXTURES INCLUDE VERTICES THAT EXERCISE THE EMPTY BRANCH — isolated vertices, vertices
 * whose only edges are of the other type, and vertices whose far ends lack the projected key, which
 * is the case where `optional` must emit NOTHING rather than itself.
 *
 *     bun optional-oracle-1884.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const DIST = `${ROOT}/packages/gremlin/dist/esm/index.mjs`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1884-oracle-dist.mjs`;
const CALL = 'optionalHopValues(effective, graph)';
const KILLED = '(void 0 /* KILL_1884 */)';
const CHILD = `${ROOT}/packages/native/zz-optional-battery-1884.mjs`;

/**
 * The battery. Every spelling the route census named, each over three fixture shapes — and a
 * handful the rung DECLINES, as controls: if a control's two arms ever differ, the harness itself
 * is broken rather than the rung.
 */
const battery = `
import { Graph } from '@lenke/core';
import { V, both, count, id, in_, optional, order, out, toArray, traversal, values } from '@lenke/gremlin';

const fixtures = {
  // Fanout 3 over two edge types, a third of vertices isolated, some missing the projected key.
  mixed: { n: 120, fanout: 3, types: ['E', 'E', 'F'], skip: 3 },
  // Dense single type: the empty branch almost never fires.
  dense: { n: 90, fanout: 4, types: ['E'], skip: 0 },
  // Very sparse: the empty branch is the common case.
  sparse: { n: 60, fanout: 1, types: ['E', 'F'], skip: 4 },
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
      if (spec.skip > 0 && i % spec.skip === 0) {
        continue;
      }

      g.addEdge({
        id: 'e' + String(e),
        from: g.getVertexById('v' + String(i)),
        to: g.getVertexById('v' + String((i * 7 + 3 + hop * 2654435761) % spec.n)),
        labels: [spec.types[e % spec.types.length]],
        properties: { w: e % 7 },
      });
      e += 1;
    }
  }

  // A self-loop, and an edge INTO an isolated vertex so it has an in-edge but no out-edge.
  g.addEdge({ id: 'self', from: g.getVertexById('v1'), to: g.getVertexById('v1'), labels: ['E'], properties: {} });

  return g;
};

const QUERIES = {
  'optional out values': () => traversal(V(), optional(traversal(out('E'))), values('n')),
  'optional out values absent key': () => traversal(V(), optional(traversal(out('E'))), values('other')),
  'optional out values string key': () => traversal(V(), optional(traversal(out('E'))), values('s')),
  'optional out id': () => traversal(V(), optional(traversal(out('E'))), id()),
  'optional out bare': () => traversal(V(), optional(traversal(out('E')))),
  'optional in values': () => traversal(V(), optional(traversal(in_('E'))), values('n')),
  'optional in id': () => traversal(V(), optional(traversal(in_('E'))), id()),
  'optional both values': () => traversal(V(), optional(traversal(both('E'))), values('n')),
  'optional untyped out values': () => traversal(V(), optional(traversal(out())), values('n')),
  'optional multi-type out values': () => traversal(V(), optional(traversal(out('E', 'F'))), values('n')),
  'optional F out values': () => traversal(V(), optional(traversal(out('F'))), values('n')),
  'optional out values count': () => traversal(V(), optional(traversal(out('E'))), values('n'), count()),
  // The CHAIN arm (item 1887): two and three steps, each direction, and a mixed chain.
  'optional chain2 values': () => traversal(V(), optional(traversal(out('E'), out('E'))), values('n')),
  'optional chain2 id': () => traversal(V(), optional(traversal(out('E'), out('E'))), id()),
  'optional chain2 bare': () => traversal(V(), optional(traversal(out('E'), out('E')))),
  'optional chain3 values': () => traversal(V(), optional(traversal(out('E'), out('E'), out('E'))), values('n')),
  'optional chain2 in': () => traversal(V(), optional(traversal(in_('E'), in_('E'))), values('n')),
  'optional chain2 both': () => traversal(V(), optional(traversal(both('E'), both('E'))), values('n')),
  'optional chain2 mixed': () => traversal(V(), optional(traversal(out('E'), in_('E'))), values('n')),
  'optional chain2 untyped': () => traversal(V(), optional(traversal(out(), out())), values('n')),
  'optional chain2 multi-type': () => traversal(V(), optional(traversal(out('E', 'F'), out('E', 'F'))), values('n')),
  'optional out values order': () => traversal(V(), optional(traversal(out('E'))), values('n'), order()),
  // CONTROLS the rung declines.
  'CONTROL out values': () => traversal(V(), out('E'), values('n')),
  
  'CONTROL seeded optional': () => traversal(V('v1'), optional(traversal(out('E'))), values('n')),
  'CONTROL optional values two keys': () => traversal(V(), optional(traversal(out('E'))), values('n', 's')),
};

const results = {};
const claimed = {};

for (const [fname, spec] of Object.entries(fixtures)) {
  const g = build(spec);

  for (const [qname, make] of Object.entries(QUERIES)) {
    const before = globalThis.__OHV_1884 ?? 0;
    let got;

    try {
      got = toArray(make(), g).map((x) => {
        if (x === undefined) {
          return '<<undefined>>';
        }

        return x !== null && typeof x === 'object' && 'id' in x ? '@' + String(x.id) : x;
      });
    } catch (err) {
      got = ['RAISED:' + String(err).slice(0, 40)];
    }

    results[fname + ' | ' + qname] = got;
    claimed[fname + ' | ' + qname] = (globalThis.__OHV_1884 ?? 0) - before;
  }
}

process.stdout.write(JSON.stringify({ results, claimed, claims: globalThis.__OHV_1884 ?? 0 }));

`;

const COUNTER = `((__r) => { if (__r !== undefined) { globalThis.__OHV_1884 = (globalThis.__OHV_1884 ?? 0) + 1; } return __r; })(${CALL})`;

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

  // PRE: the kill switch ALONE. The first cut wrote `${KILLED} ?? ${COUNTER}` so the arm could
  // also COUNT its (expected zero) claims — and `??` on `void 0` falls straight through, so the
  // "killed" arm called the rung 51 times. The arm assertion caught it, which is the whole reason
  // it is there; the PRE arm's proof is the KILL_1884 marker plus a counter that is never set.
  writeFileSync(DIST, pristine.replace(CALL, KILLED));

  if (!readFileSync(DIST, 'utf8').includes('KILL_1884')) {
    throw new Error('ARM ASSERTION FAILED: the PRE arm is not the killed build');
  }

  pre = runChild();

  if (pre.claims !== 0) {
    throw new Error(`ARM ASSERTION FAILED: the PRE arm took the rung ${String(pre.claims)} times`);
  }

  // POST: the shipped build, with the counter only.
  writeFileSync(DIST, pristine.replace(CALL, COUNTER));

  if (readFileSync(DIST, 'utf8').includes('KILL_1884')) {
    throw new Error('ARM ASSERTION FAILED: the POST arm still carries the kill switch');
  }

  post = runChild();

  if (post.claims === 0) {
    throw new Error('ARM ASSERTION FAILED: the POST arm never took the rung');
  }
} finally {
  copyFileSync(PRISTINE, DIST);
  // THE GENERATED CHILD IS REMOVED HERE. It has to live in `packages/native` for `@lenke/*` to
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
  console.log(`\n${name}\n   generic: ${a}\n   fused:   ${b}`);
}

console.log(bad.length === 0 ? '\nevery pair identical' : `\n${String(bad.length)} DIVERGENCE(S)`);

if (bad.length > 0) {
  process.exitCode = 1;
}
