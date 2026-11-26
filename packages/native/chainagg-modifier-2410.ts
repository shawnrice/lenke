/**
 * ITEM 2409'S LEFTOVER: THE SAME RETIRED REFUSAL ON THE *PATH-WALK* RUNGS.
 *
 * Item 2409 admitted `sum`/`avg` to `chain-fold-levels.ts` as a multiplicity-weighted fold (849x).
 * That rung is deliberately NARROW — no relationship variable, no inline properties, no clause
 * `WHERE`, no union types, no label expression, and the fold's argument must read only the FAR node.
 * Everything it declines falls to `chain-projection.ts`'s `detectChainFoldedAggregate` and
 * `hop2-projection.ts`'s `detectHop2FoldedAggregate` — and BOTH still carry item 1830's
 * `ORDER_INVARIANT_AGGREGATES`, which refuses `sum`/`avg` on the byte-identity argument item 2401
 * retired.
 *
 * ⚠️ SO THIS PROBE IS ABOUT THE *MODIFIER*, NOT THE AGGREGATE. `plain` is the control that item 2409
 * already took: it must now be fast for `sum`, and if it is not, nothing below can be read. Each
 * other modifier is one reason the level fold declines, and the question for each is whether the
 * path-walk rung underneath it has a gap.
 *
 * ⚠️ ARM PARITY, per items 2326/2328/2335. `countx` (`count(far.n)`) is the ADMITTED order-invariant
 * fold that reads the SAME property through the SAME rung, so `sum` against `countx` is
 * fold-vs-no-fold rather than read-vs-no-read. `min` is the admitted comparison arm. Timing CANNOT
 * tell "declined" from "more work" ([[rung-precedence-decides-speed]]) — a throw at the admission
 * point is what settles the route, and this probe only says where to put one.
 *
 * ⚠️ AND THE FLOOR. `rows` materializes every row the aggregate reduces. An aggregate costing MORE
 * than its own floor is the item 2157/1918 signal; one sitting at it has nothing left to win.
 *
 *     MOD=plain|where|relvar|union|inline|labelexpr|neararg SHAPE=sum bun chainagg-modifier-2410.ts
 *     HOPS=2 MOD=where SHAPE=countx bun chainagg-modifier-2410.ts
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 14);
const HOPS = Number(process.env.HOPS ?? 3);
const SHAPE = process.env.SHAPE ?? 'sum';
const MOD = process.env.MOD ?? 'plain';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: String(i + 1),
    // `Q` on every vertex keeps a label EXPRESSION arm non-vacuous in the pattern while leaving the
    // walk's size identical to the plain arm's, so the modifier is the only thing that varies.
    labels: i % 2 === 0 ? ['T', 'Q'] : ['T'],
    // `n` is a small integer and `f` an inexact float. An integer sum in f64 is EXACT whatever the
    // order, so only `f` can expose a re-association at all.
    properties: { n: i % 8, f: (i % 8) * 0.1, g: 1 },
  });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1))!,
    // Splits on the REPEAT INDEX — CLAUDE.md's functional-graph fix.
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1))!,
    // Two edge types so a UNION arm has something to union, with `E` on all of them so the walk
    // itself is unchanged.
    labels: e % 3 === 0 ? ['E', 'F'] : ['E'],
    properties: { w: e % 7 },
  });
}

const names = ['a', 'b', 'c', 'd', 'e'];
const vars = names.slice(0, HOPS + 1);
const far = vars[HOPS];

/**
 * Each modifier is ONE reason `chain-fold-levels.ts` declines, read off its own `levelOf`/admission:
 * a relationship variable, inline properties, a clause `WHERE`, union types, a label expression, and
 * an argument that does not read the far node.
 */
const patternOf = (): { pattern: string; where: string } => {
  const plain = vars.map((v) => `(${v}:T)`);

  switch (MOD) {
    case 'relvar':
      return { pattern: plain.join('-[r:E]->'), where: '' };
    case 'union':
      return { pattern: plain.join('-[:E|F]->'), where: '' };
    case 'inline':
      return {
        pattern: plain.map((p, i) => (i === 1 ? `(${vars[1]}:T {g: 1})` : p)).join('-[:E]->'),
        where: '',
      };
    case 'labelexpr':
      return {
        pattern: plain.map((p, i) => (i === 1 ? `(${vars[1]}:T|Q)` : p)).join('-[:E]->'),
        where: '',
      };
    case 'where':
      return { pattern: plain.join('-[:E]->'), where: ` WHERE ${vars[0]}.g = 1` };
    case 'neararg':
    case 'plain':
    default:
      return { pattern: plain.join('-[:E]->'), where: '' };
  }
};

// `neararg` aggregates the START node's property instead of the far end's — the level recurrence
// cannot express it (its multiplicity vector is indexed by the FAR vertex), so the path-walk rung is
// the only rung that could.
const arg = MOD === 'neararg' ? vars[0] : far;

const RETURNS: Record<string, string> = {
  // THE TARGET and its float twin, the one that can actually re-associate.
  sum: `sum(${arg}.n)`,
  avg: `avg(${arg}.n)`,
  sumf: `sum(${arg}.f)`,
  // THE ADMITTED ARMS (item 1830): same rung, same property read, order-invariant.
  min: `min(${arg}.n)`,
  countx: `count(${arg}.n)`,
  // THE FLOOR: materialize every row the aggregate reduces.
  rows: `${arg}.n`,
  // CONTROL the change cannot reach: a closed-form tally over the same walk.
  bare: 'count(*)',
};

const { pattern, where } = patternOf();
const text = `MATCH ${pattern}${where} RETURN ${RETURNS[SHAPE]} AS x`;
const ser: number[] = [];
let answer = '';

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const out = query(g, text, {}) as unknown[];
  const ms = performance.now() - t0;

  answer = out.length <= 2 ? JSON.stringify(out) : `${out.length} rows`;

  // Drop the first three as JIT warm-up; median of the rest, per CLAUDE.md's TS-path rule.
  if (r >= 3) {
    ser.push(ms);
  }
}

const sorted = [...ser].sort((a, b) => a - b);

console.log(
  `${MOD.padEnd(9)} ${SHAPE.padEnd(7)} hops=${HOPS} N=${NODES} reps=${ser.length}  ` +
    `median ${sorted[sorted.length >> 1].toFixed(2)} ms  min ${sorted[0].toFixed(2)}  answer ${answer}`,
);
console.log(`  ${text}`);
console.log(`  series ${ser.map((x) => x.toFixed(1)).join(' ')}`);
