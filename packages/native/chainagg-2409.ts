/**
 * ITEM 1880'S REFUSED HALF: `sum`/`avg` OVER A CHAIN, NOW THAT ITEM 2401 HAS RETIRED THE REASON.
 *
 * Item 1880 measured, at three hops over the same walk returning the same single row:
 *
 *     avg(d.n)  19.6 ms          min(d.n)  3.8 ms
 *     sum(d.n)  19.2             max(d.n)  3.6          5.2x
 *
 * and recorded the gap as "the mirror of a win": item 1830 gave `min`/`max`/`count(x)` a chain rung
 * and named itself "the order-INVARIANT half of item 1829's aggregate family". The other half was
 * refused because f64 addition is not associative and byte-identity with the Rust engine pinned the
 * summation order. `chain-projection.ts`'s `ORDER_INVARIANT_AGGREGATES` still carries that argument
 * verbatim, as does `hop2-projection.ts`'s copy of the same block.
 *
 * Item 2401 (owner ruling) replaced that invariant with a PRECISION contract: `sum`/`avg` are
 * accurate to within n*eps*sum|xi| and explicitly NOT bit-identical across engines, because a left
 * fold over a different walk order re-associates. Item 2400 freed the premise underneath it. So the
 * refusal's stated reason is gone — and item 2401 shipped only ONE site (`hop-projection.ts`), which
 * is why these rungs still read the way they do.
 *
 * THIS PROBE IS NOT A ROUTE CLAIM. Timing cannot tell "declined" from "more work"
 * ([[rung-precedence-decides-speed]]). `count(d.n)` is here as the ADMITTED order-invariant arm that
 * reads the same property, so the comparison is fold-vs-no-fold and not read-vs-no-read, which is
 * the arm-parity error items 2326/2328/2335 made a standing rule.
 *
 * AND THE FLOOR MATTERS. `RETURN d.n` materializes every row the aggregate reduces. An aggregate
 * costing MORE than that is the item 2157/1918 signal; one sitting at it has nothing to win.
 *
 *     SHAPE=sum|avg|min|max|countx|rows|bare bun chainagg-2409.ts
 *     HOPS=2 SHAPE=sum bun chainagg-2409.ts
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 14);
const HOPS = Number(process.env.HOPS ?? 3);
const SHAPE = process.env.SHAPE ?? 'sum';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: ['T'],
    // `n` is a small integer and `f` an inexact float. An integer sum in f64 is EXACT whatever the
    // order, so only `f` can expose a re-association at all — which is what makes the precision
    // contract, rather than bit-identity, the thing being measured against.
    properties: { n: i % 8, f: (i % 8) * 0.1 },
  });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1))!,
    // Splits on the REPEAT INDEX — CLAUDE.md's functional-graph fix. Without it one vertex's FANOUT
    // edges all land on the same target and the graph is functional, so a k-hop count is F^k * N by
    // construction and every branching claim is false while looking perfect.
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1))!,
    labels: ['E'],
    properties: { w: e % 7 },
  });
}

const names = ['a', 'b', 'c', 'd', 'e'];
const chain = names
  .slice(0, HOPS + 1)
  .map((v) => `(${v}:T)`)
  .join('-[:E]->');
const far = names[HOPS];

const RETURNS: Record<string, string> = {
  // THE TARGET and its float twin, the one that can actually re-associate.
  sum: `sum(${far}.n)`,
  avg: `avg(${far}.n)`,
  sumf: `sum(${far}.f)`,
  avgf: `avg(${far}.f)`,
  // THE ADMITTED ARM (item 1830). Order-invariant, same rung, SAME PROPERTY READ.
  min: `min(${far}.n)`,
  max: `max(${far}.n)`,
  // The order-invariant arm that is a FOLD rather than a comparison — the closest control to `sum`.
  countx: `count(${far}.n)`,
  // THE FLOOR: materialize every row the aggregate reduces.
  rows: `${far}.n`,
  // CONTROL the change cannot reach: a closed-form tally over the same walk.
  bare: 'count(*)',
};

const text = `MATCH ${chain} RETURN ${RETURNS[SHAPE]} AS x`;
const ser: number[] = [];
let answer = '';

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const out = query(g, text, {}) as unknown[];
  const ms = performance.now() - t0;

  answer = out.length <= 2 ? JSON.stringify(out) : `${out.length} rows`;

  // Drop the first three: they are visibly the JIT tiering up, and CLAUDE.md's TS-path rule is
  // median-of-the-rest, not min — the general scalar path plateaus high and emits a rare fast rep
  // that `min` would report as the whole reading.
  if (r >= 3) {
    ser.push(ms);
  }
}

const sorted = [...ser].sort((a, b) => a - b);

console.log(
  `${SHAPE.padEnd(7)} hops=${HOPS} N=${NODES} reps=${ser.length}  ` +
    `median ${sorted[sorted.length >> 1].toFixed(2)} ms  min ${sorted[0].toFixed(2)}  answer ${answer}`,
);
console.log(`  ${text}`);
console.log(`  series ${ser.map((x) => x.toFixed(1)).join(' ')}`);
