// Item 1933 — DOES GQL `SET` COST SCALE WITH ROW WIDTH, as [[ts-set-is-o-width]] says?
//
// GQL `SET` costs 639 ns a row against Gremlin `property`'s 119 and a host-side floor of 69 — 5.38x
// and 9.3x. THE PROFILE'S TOP FRAMES ARE NOT THE CAUSE: it puts 22.6% in `deferConstraint` +
// `runDeferredChecks`, but wrapping 20,000 host-side property writes in an explicit transaction
// (which is what makes those fire) costs 77 ns a row against 69 without — 8 ns, not 140.
// [[frame-attribution-trap]], caught by a control rather than by reading the profile harder.
//
// SO TEST THE DOCUMENTED MECHANISM INSTEAD. `ts-set-is-o-width` records that TS `SET` makes
// three O(K) passes a write where K is the ROW WIDTH, against native's O(1) columnar. If that is
// what 639 ns is, the per-row cost RISES WITH THE NUMBER OF PROPERTIES THE VERTEX ALREADY HAS —
// and Gremlin's `property` should not, or the two would not differ.
//
// THE CONTROL IS THE GREMLIN ARM AT EVERY WIDTH, not just at one. A cost that rises on both is
// the data layout; one that rises only on GQL is the SET path.
//
//     bun setwidth-sweep-1933.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { property, toArray, traversal, V } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20000);
const REPS = Number(process.env.REPS ?? 7);
const WIDTHS = (process.env.WIDTHS ?? '1,2,4,8,16,32').split(',').map(Number);

const build = (width) => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    const props = { n: i % 97 };

    for (let p = 1; p < width; p += 1) {
      props[`p${String(p)}`] = i % 13;
    }

    g.addVertex({ id: String(i + 1), labels: ['T'], properties: props });
  }

  return g;
};

const time = (width, fn) => {
  const ser = [];

  for (let r = 0; r < REPS + 2; r += 1) {
    const g = build(width);
    const t0 = performance.now();

    fn(g);

    const ms = performance.now() - t0;

    if (r >= 2) {
      ser.push(ms);
    }
  }

  ser.sort((a, b) => a - b);

  return ser[ser.length >> 1];
};

const gql = (g) => query(g, 'MATCH (n:T) SET n.n = 1', {});
const grem = (g) => toArray(traversal(V(), property('n', 1)), g);
const host = (g) => {
  for (const v of g.vertices) {
    v.properties = { ...v.properties, n: 1 };
  }
};

console.log(`${NODES} vertices, median of ${REPS}, fresh graph per rep. ns a row:\n`);
console.log('width    gql SET    gremlin    host    gql/grem');
console.log('-'.repeat(50));

const first = {};

for (const width of WIDTHS) {
  const a = (time(width, gql) * 1e6) / NODES;
  const b = (time(width, grem) * 1e6) / NODES;
  const c = (time(width, host) * 1e6) / NODES;

  if (first.gql === undefined) {
    first.gql = a;
    first.grem = b;
    first.host = c;
  }

  console.log(
    `${String(width).padStart(5)} ${a.toFixed(0).padStart(10)} ${b.toFixed(0).padStart(10)} ` +
      `${c.toFixed(0).padStart(7)} ${(a / b).toFixed(2).padStart(11)}x`,
  );
}

console.log(
  `\nGROWTH from width ${String(WIDTHS[0])} to ${String(WIDTHS[WIDTHS.length - 1])}: ` +
    'a path that is O(1) in width is FLAT here; one that is O(K) rises with it.',
);
