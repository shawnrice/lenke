/**
 * DOES THE ONE-HOP CSR WALK ANSWER WHAT THE BUCKET WALK ANSWERS? (item 1889)
 *
 * The same two-build device as `optional-oracle-1884.mjs`: PRE replaces `hopValuesCsr`'s call site
 * in the BUILT dist with `void 0`, POST is shipped, both arms asserted by marker.
 *
 * ⚠️ AND EACH QUERY RUNS THREE TIMES, which this rung needs and the others did not. Its second-call
 * policy means call 1 is the BUCKET walk and call 2 the CSR — so the three calls cover the bucket
 * walk, the CSR's eager `drain` (what `toArray` uses) and the CSR's LAZY iterator (via `run`), and
 * a disagreement between them is reported as a result rather than hidden by comparing arms only.
 *
 *     bun hop-csr-oracle-1889.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const DIST = `${ROOT}/packages/gremlin/dist/esm/index.mjs`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1889-oracle-dist.mjs`;
const CALL = 'hopValuesCsr(effective, graph)';
const KILLED = '(void 0 /* KILL_1889 */)';
const CHILD = `${ROOT}/packages/native/zz-hop-csr-battery-1889.mjs`;

/**
 * The battery. Every spelling the route census named, each over three fixture shapes — and a
 * handful the rung DECLINES, as controls: if a control's two arms ever differ, the harness itself
 * is broken rather than the rung.
 */
const battery = `
import { Graph } from '@lenke/core';
import { V, both, count, id, in_, limit, order, out, run, toArray, traversal, values } from '@lenke/gremlin';

const fixtures = {
  mixed: { n: 120, fanout: 3, types: ['E', 'E', 'F'], two: true },
  dense: { n: 90, fanout: 4, types: ['E'], two: false },
  sparse: { n: 60, fanout: 1, types: ['E', 'F'], two: true },
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
      // Some edges carry BOTH types where the fixture asks for it, so a multi-type hop is
      // exercised against the arm that must refuse it.
      const labels = spec.two && e % 11 === 0 ? ['E', 'F'] : [spec.types[e % spec.types.length]];

      g.addEdge({
        id: 'e' + String(e),
        from: g.getVertexById('v' + String(i)),
        to: g.getVertexById('v' + String((i * 7 + 3 + hop * 2654435761) % spec.n)),
        labels,
        properties: { w: e % 7 },
      });
      e += 1;
    }
  }

  g.addEdge({ id: 'self', from: g.getVertexById('v1'), to: g.getVertexById('v1'), labels: ['E'], properties: {} });

  return g;
};

const QUERIES = {
  'out values': () => traversal(V(), out('E'), values('n')),
  'out values absent key': () => traversal(V(), out('E'), values('other')),
  'out values string key': () => traversal(V(), out('E'), values('s')),
  'out id': () => traversal(V(), out('E'), id()),
  'out bare': () => traversal(V(), out('E')),
  'in values': () => traversal(V(), in_('E'), values('n')),
  'in id': () => traversal(V(), in_('E'), id()),
  'out F values': () => traversal(V(), out('F'), values('n')),
  'out values order': () => traversal(V(), out('E'), values('n'), order()),
  'out values limit': () => traversal(V(), out('E'), values('n'), limit(7)),
  'out values count': () => traversal(V(), out('E'), values('n'), count()),
  // CONTROLS the rung refuses on every call.
  'CONTROL both values': () => traversal(V(), both('E'), values('n')),
  'CONTROL multi-type values': () => traversal(V(), out('E', 'F'), values('n')),
  'CONTROL untyped values': () => traversal(V(), out(), values('n')),
  'CONTROL seeded out values': () => traversal(V('v1'), out('E'), values('n')),
  'CONTROL two keys': () => traversal(V(), out('E'), values('n', 's')),
};

const results = {};
const claimed = {};
const mark = (x) => {
  if (x === undefined) {
    return '<<undefined>>';
  }

  return x !== null && typeof x === 'object' && 'id' in x ? '@' + String(x.id) : x;
};

for (const [fname, spec] of Object.entries(fixtures)) {
  const g = build(spec);

  for (const [qname, make] of Object.entries(QUERIES)) {
    const before = globalThis.__HVC_1889 ?? 0;
    let got;

    try {
      // ⚠️ THREE CALLS, because the rung DECLINES its own first call (the amortization policy). Call
      // 1 is the bucket walk, call 2 the CSR through 'toArray''s eager drain, call 3 the CSR
      // through the LAZY iterator via 'run' — and all three must agree, which is the real claim.
      const first = toArray(make(), g).map(mark);
      const second = toArray(make(), g).map(mark);
      const third = [...run(make(), g)].map(mark);

      got = JSON.stringify(first) === JSON.stringify(second) && JSON.stringify(second) === JSON.stringify(third)
        ? second
        : ['INTERNAL-DISAGREEMENT', first.length, second.length, third.length];
    } catch (err) {
      got = ['RAISED:' + String(err).slice(0, 40)];
    }

    results[fname + ' | ' + qname] = got;
    claimed[fname + ' | ' + qname] = (globalThis.__HVC_1889 ?? 0) - before;
  }
}

process.stdout.write(JSON.stringify({ results, claimed, claims: globalThis.__HVC_1889 ?? 0 }));

`;

const COUNTER = `((__r) => { if (__r !== undefined) { globalThis.__HVC_1889 = (globalThis.__HVC_1889 ?? 0) + 1; } return __r; })(${CALL})`;

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
  // it is there; the PRE arm's proof is the KILL_1889 marker plus a counter that is never set.
  writeFileSync(DIST, pristine.replace(CALL, KILLED));

  if (!readFileSync(DIST, 'utf8').includes('KILL_1889')) {
    throw new Error('ARM ASSERTION FAILED: the PRE arm is not the killed build');
  }

  pre = runChild();

  if (pre.claims !== 0) {
    throw new Error(`ARM ASSERTION FAILED: the PRE arm took the rung ${String(pre.claims)} times`);
  }

  // POST: the shipped build, with the counter only.
  writeFileSync(DIST, pristine.replace(CALL, COUNTER));

  if (readFileSync(DIST, 'utf8').includes('KILL_1889')) {
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
