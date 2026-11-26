// Item 1920 — DOES THE FUSED PATH RUNG AGREE WITH THE GENERIC PATH, ELEMENT BY ELEMENT, AT SCALE?
//
// THIS EXISTS BECAUSE THE NUMBER LOOKED TOO GOOD. The workload screen's `path: hop path` row went
// 124.55 -> 8.40 ms, which is FASTER than `hop1: values` (45.75) and faster than the hand-written
// ceiling this fusion was priced against (26.11). A row count alone cannot tell a correct fusion
// from one that builds 600,000 cheap WRONG arrays, so the contents are compared here.
//
// (The explanation turned out to be ordinary: the ceiling probe walked the adjacency SETS — the
// bucket arm — while the engine takes the CSR arm on the second ask, and a dense `Int32Array` walk
// is much cheaper than iterating 200,000 `Set`s. The ceiling was a bucket-arm ceiling, not the
// walk's.)
//
// THE ORACLE IS A DECLINING SPELLING, so there is no second implementation to be wrong in the
// same way: `path()` followed by a `limit` ABOVE the row count asks the identical question, and the
// gate refuses it because the plan is then four steps.
//
//     bun pathfuse-parity-1920.mjs
import { Graph } from '@lenke/core';
import { V, in_, limit, out, path, toArray, traversal } from '@lenke/gremlin';

const N = Number(process.env.N ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 4);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { n: i % 8 } });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: e % 7 },
  });
}

const BIG = 100_000_000;

/** One path rendered as the ids it holds, so a wrong END is visible rather than a wrong count. */
const render = (p) =>
  Array.isArray(p) ? `[${p.map((e) => String(e?.id ?? e)).join(' ')}]` : String(p);

const ROWS = [
  { name: 'out E', fused: [out('E'), path()], generic: [out('E'), path(), limit(BIG)] },
  { name: 'in E', fused: [in_('E'), path()], generic: [in_('E'), path(), limit(BIG)] },
  { name: 'out F', fused: [out('F'), path()], generic: [out('F'), path(), limit(BIG)] },
];

let bad = 0;

for (const { name, fused, generic } of ROWS) {
  // A FRESH GRAPH PER ROW would reset the second-ask policy; instead each row is asked TWICE so
  // both the cold (bucket) and warm (CSR) arms are compared — item 1891's reason, and item 1914
  // found three untested paths by missing exactly this.
  for (const pass of ['cold', 'warm']) {
    const a = toArray(traversal(V(), ...fused), g);
    const b = toArray(traversal(V(), ...generic), g);

    let firstDiff = -1;

    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      const x = a[i];
      const y = b[i];
      const same =
        Array.isArray(x) &&
        Array.isArray(y) &&
        x.length === y.length &&
        x.every((el, j) => el === y[j]);

      if (!same) {
        firstDiff = i;
        break;
      }
    }

    const ok = a.length === b.length && firstDiff === -1;

    if (!ok) {
      bad += 1;
    }

    const shape = a.length > 0 && Array.isArray(a[0]) ? `len=${a[0].length}` : 'NOT AN ARRAY';

    console.log(
      `${name.padEnd(7)} ${pass.padEnd(5)} fused ${String(a.length).padStart(7)} rows (${shape})  ` +
        `generic ${String(b.length).padStart(7)}  ${ok ? 'identical' : `DIFFERS at ${firstDiff}`}`,
    );

    if (!ok && firstDiff >= 0) {
      console.log(`    fused ${render(a[firstDiff])}   generic ${render(b[firstDiff])}`);
    }
  }
}

// AND THE PATH ELEMENTS MUST BE THE REAL VERTICES, not copies: `path()` yields the traversed
// elements themselves, and a fusion that rebuilt them would compare equal by id while being a
// different object — which `select`/`where(neq)` downstream would see. Identity is the contract.
const [one] = toArray(traversal(V(), out('E'), path()), g);

console.log(
  `\npath[0] identity: ${one[0] === g.getVertexById(one[0].id) ? 'the graph vertex itself' : 'a copy'}` +
    `   path[1]: ${one[1] === g.getVertexById(one[1].id) ? '' : 'a copy'}`,
);
console.log(bad === 0 ? `\nall ${ROWS.length * 2} comparisons identical` : `\n${bad} DIFFER`);
process.exit(bad === 0 ? 0 : 1);
