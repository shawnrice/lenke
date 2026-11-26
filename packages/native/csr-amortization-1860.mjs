/**
 * WHAT DOES THE CHAIN CSR COST TO BUILD, AND HOW MANY QUERIES AMORTIZE IT? (item 1860)
 *
 * Item 1860's ceiling probe says a dense two-hop count would be 4.05x (51.32 -> 12.68 ms), and that
 * the CSR build is 254 ms — 20x the warm query it enables. Whether the win is real therefore turns
 * entirely on amortization, and `chainCsrFor` memoizes on `graph.topologyVersion`, so ANY topology
 * write drops the generation whole.
 *
 * MEASURED THROUGH THE ENGINE'S OWN BUILD, not the hand-rolled one. The ceiling probe's 254 ms is
 * my own CSR builder; `buildChainCsr` may be cheaper or dearer, and the decision depends on which.
 * The THREE-hop row already takes `slotChainCount`, so timing its first call in a fresh process
 * against its later ones prices the engine's real build directly.
 *
 * AND THE INTERLEAVED ARM IS THE ONE THAT DECIDES IT. A serving workload that writes between
 * reads invalidates the memo on every write, so the build is paid per read rather than once. If the
 * three-hop row is already slower under interleaving than it is cold, that exposure exists today and
 * widening it to the commonest two-hop shape is a different proposition from a free 4x.
 */
import { Graph as TsGraph } from '@lenke/core';
import { V, count, hasLabel, out, toArray, traversal } from '@lenke/gremlin';
import { deserialize as tsDeserialize } from '@lenke/serialization';

const N = Number(process.env.PROBE_N ?? 200_000);
const FANOUT = Number(process.env.PROBE_FANOUT ?? 5);

const lines = Array.from(
  { length: N },
  (_, i) => `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${i % 90}}}`,
);

for (let k = 0; k < N * FANOUT; k += 1) {
  const to = ((k % N) * 104_729 + Math.floor(k / N) * 977) % N;

  lines.push(
    `{"type":"edge","id":"e${k}","labels":["KNOWS"],"from":"v${(k * 7919) % N}","to":"v${to}","properties":{"w":${k % 7}}}`,
  );
}

const doc = lines.join('\n');
const g = tsDeserialize(doc, 'ndjson', new TsGraph());

const THREE = traversal(V(), hasLabel('Person'), out('KNOWS'), out('KNOWS'), out('KNOWS'), count());
const TWO = traversal(V(), hasLabel('Person'), out('KNOWS'), out('KNOWS'), count());

const once = (plan) => {
  const t0 = performance.now();
  const [answer] = toArray(plan, g);

  return { ms: performance.now() - t0, answer };
};

// THE COLD CALL — the only one in this process that can pay for the build.
const cold = once(THREE);
const warm = [once(THREE), once(THREE), once(THREE), once(THREE)];
const warmMin = Math.min(...warm.map((w) => w.ms));

console.log(`${N} vertices / ${N * FANOUT} edges`);
console.log(
  `  3-hop COLD (builds the CSR)   ${cold.ms.toFixed(2)} ms   answer ${String(cold.answer)}`,
);
console.log(`  3-hop WARM (min of 4)         ${warmMin.toFixed(2)} ms`);
/**
 * `cold - warm` IS NOT THE BUILD COST, and item 1860 quoted it as though it were — reporting
 * 221 ms for a build that is really ~158. The first call in a process also pays the JIT tiering up,
 * and item 1861 measured exactly how much: with the dense arm KILLED, so no CSR is built at all,
 * `cold - warm` still read **157 ms**. A subtraction that large cannot be attributed to one of two
 * things happening inside it. The INTERLEAVED arm below is the direct measurement, because by then
 * the code is warm and the only thing a write changes is that the memo must be rebuilt.
 */
console.log(
  `  => cold-warm (build AND JIT)   ${(cold.ms - warmMin).toFixed(2)} ms   NOT the build alone`,
);

// THE TWO-HOP ROW, which does NOT use the CSR today — the shape item 1860 declined.
const twoWarm = Math.min(once(TWO).ms, once(TWO).ms, once(TWO).ms);

console.log(`  2-hop today (min of 3)        ${twoWarm.toFixed(2)} ms   (no CSR)`);

/**
 * THE INTERLEAVED ARM. One `addVertex` with one edge advances `topologyVersion`, which drops the
 * memoized generation — so each read below pays the build again. This is the serving shape
 * `bun run bench:usage` exists for, and it is where a memo that costs 20x its query is dangerous
 * rather than merely cold once.
 */
let interleaved = 0;

for (let r = 0; r < 3; r += 1) {
  const v = g.addVertex({ id: `extra${r}`, labels: ['Person'], properties: { age: 1 } });

  g.addEdge({ id: `extraE${r}`, from: v, to: g.getVertexById('v0'), labels: ['KNOWS'] });

  const t0 = performance.now();

  toArray(THREE, g);
  interleaved += performance.now() - t0;
}

const interMean = interleaved / 3;

console.log(`  3-hop INTERLEAVED with a write ${interMean.toFixed(2)} ms   mean of 3`);
console.log(`  => a write costs this row      ${(interMean / warmMin).toFixed(2)}x its warm cost`);
/**
 * THE REBUILD, MEASURED DIRECTLY: the code is warm by now, so the only thing the write adds is the
 * rebuild. This is the number item 1695's criterion needs — "safe iff the walk costs more than the
 * rebuild" — and it is the one to quote, not `cold - warm` above.
 *
 * WITH THE DENSE ARM KILLED THIS GOES TO ~0 (444.41 against a 437.31 warm), which is the control
 * that says the subtraction really is isolating the rebuild rather than some other per-write cost.
 */
console.log(`  => ONE rebuild costs           ${(interMean - warmMin).toFixed(2)} ms   (direct)`);
console.log(
  `  => 1695's criterion: walk ${twoWarm.toFixed(0)} ms vs rebuild ${(interMean - warmMin).toFixed(0)} ms — two-hop ${twoWarm > interMean - warmMin ? 'PASSES' : 'FAILS'}`,
);
