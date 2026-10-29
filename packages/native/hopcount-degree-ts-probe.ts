/**
 * Is the TS 3-hop count a CLOSED FORM or a WALK? (item 1193)
 *
 * The bench sweep shows `count 3-hop` at ts 326.5ms against ffi 4.8ms — 67.7x, the largest
 * ts/ffi ratio in the corpus whose absolute time is big enough to matter. But `shortcuts.ts`'s
 * header says TS HAS the chain closed forms (`threeHopSide`, `productCountOf`,
 * `threeSegmentCount`, `walkLevelCount`), so "the fast path is missing" is a guess, not a finding.
 *
 * THE DISCRIMINATING EXPERIMENT is a DEGREE SWEEP at fixed N, because the two hypotheses scale
 * differently in degree and identically in N:
 *
 *   closed form    cost ∝ N          (per-vertex arithmetic; degree is a NUMBER it reads)
 *   walk           cost ∝ N · deg³   (it enumerates the paths)
 *
 * At degree 2 vs 5 that is flat vs (5/2)³ = 15.6x. Varying N alone cannot tell them apart —
 * both are linear in N — which is why the sweep varies degree and holds N fixed.
 *
 * The answer count is printed as the fixture's own statistic: a 3-hop chain count is 25·|E| for a
 * uniform degree-5 graph whatever the in-degree distribution, so the count being RIGHT validates
 * nothing about the generator (item 702) — but it does confirm both arms answer the same question.
 *
 *   cd packages/native && bun hopcount-degree-ts-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

const N = Number(process.env.HC_N ?? 50_000);
const REPS = Number(process.env.HC_REPS ?? 7);

let seed = 0x2f6e2b1;
const nextInt = (bound: number): number => {
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;

  return seed % bound;
};

const build = (deg: number): TsGraph => {
  seed = 0x2f6e2b1;
  const lines: string[] = [];

  for (let i = 0; i < N; i += 1) {
    lines.push(`{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${i % 90}}}`);
  }

  let e = 0;

  for (let i = 0; i < N; i += 1) {
    for (let d = 0; d < deg; d += 1) {
      lines.push(
        `{"type":"edge","id":"e${e}","from":"v${i}","to":"v${nextInt(N)}","labels":["KNOWS"],"properties":{}}`,
      );
      e += 1;
    }
  }

  return tsDeserialize(lines.join('\n'), 'ndjson', new TsGraph());
};

const med = (xs: number[]): number => {
  const warm = xs.slice(3).toSorted((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)];
};

const Q3 = 'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) RETURN count(*) AS c';
const Q1 = 'MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c';

console.log(`\n# ${N} nodes, degree swept, ts engine, median of ${REPS} dropping 3`);
console.log('\n  deg   3-hop(ms)   1-hop(ms)   3-hop answer        vs deg 2');

let base = 0;

for (const deg of [2, 3, 5]) {
  const g = build(deg);
  const run = (q: string): number => {
    const s: number[] = [];

    for (let r = 0; r < REPS; r += 1) {
      const t = performance.now();

      tsQuery(g, q);
      s.push(performance.now() - t);
    }

    return med(s);
  };
  const t3 = run(Q3);
  const t1 = run(Q1);
  const answer = JSON.stringify(tsQuery(g, Q3));

  if (deg === 2) {
    base = t3;
  }

  console.log(
    `  ${String(deg).padEnd(4)} ${t3.toFixed(1).padStart(9)} ${t1.toFixed(1).padStart(11)}   ` +
      `${answer.slice(0, 18).padEnd(18)}  ${(t3 / base).toFixed(2)}x`,
  );
}

console.log('\n  flat in degree => CLOSED FORM; ~(deg/2)^3 => a WALK');
