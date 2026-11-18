/**
 * ⚠️⚠️ **DOES COST PER OPERATION STAY FLAT AS THE GRAPH GROWS? (item 2281)** Every fixture in this repo
 * builds a graph and then reads it. An ingesting application does both at once — and the failure mode that
 * shape has, which a build-then-read fixture CANNOT see, is a per-operation cost that RISES with N. That
 * makes ingest quadratic, and it is invisible at any single size.
 *
 * 🔑 Three curves, because they fail differently:
 *
 *   write    marginal ns per addVertex/addEdge at size N        — rising => quadratic ingest
 *   byid     ns per getVertex(id) at size N                     — the standing O(1) constraint
 *   query    ns per row for a label scan at size N              — the control: SHOULD scale with N
 *
 * ⚠️ `query` is the NULL CONTROL: a whole-graph scan must cost more at a bigger N, so if it stays flat the
 * instrument is broken. `write` and `byid` are the ones that must be flat per operation.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const SIZES = [10_000, 20_000, 40_000, 80_000, 160_000];
const REPS = 7;
const PROBE = 2000;

const med = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

/* A deterministic LCG in integer math — f64 multiplication collapses the period (CLAUDE.md). */
const lcg = (seed: number) => {
  let s = seed | 0;

  return (): number => {
    s = (Math.imul(s, 1_103_515_245) + 12_345) | 0;

    return (s >>> 1) % 1_000_000_007;
  };
};

console.log(`  N        write ns/op   byid ns/op   query ns/row   (median of ${REPS})`);

for (const N of SIZES) {
  const writeNs: number[] = [];
  const byidNs: number[] = [];
  const queryNs: number[] = [];

  for (let rep = 0; rep < REPS; rep += 1) {
    const g = new Graph();
    const rnd = lcg(0x5eed + rep);

    /* Grow to N, then time the NEXT PROBE writes — the marginal cost AT size N, not the average. */
    for (let i = 0; i < N; i += 1) {
      g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 977 } });
    }

    for (let i = 0; i < N; i += 1) {
      g.addEdge({
        id: `e${i}`,
        from: g.getVertexById(`v${i}`)!,
        to: g.getVertexById(`v${rnd() % N}`)!,
        labels: ['E'],
        properties: {},
      });
    }

    /*
     * ⚠️ `from`/`to` take vertex OBJECTS, so a naive timed loop would be timing TWO LOOKUPS plus the
     * writes. Pre-resolving the targets keeps the write curve about writing — and a lookup term inside it
     * would have been indistinguishable from the rising cost this probe exists to detect.
     */
    const targets: ReturnType<Graph['getVertexById']>[] = [];

    for (let i = 0; i < PROBE; i += 1) {
      targets.push(g.getVertexById(`v${rnd() % N}`));
    }

    const w0 = performance.now();

    for (let i = 0; i < PROBE; i += 1) {
      const id = N + i;
      const v = g.addVertex({ id: `v${id}`, labels: ['T'], properties: { k: id % 977 } });

      g.addEdge({ id: `e${id}`, from: v, to: targets[i]!, labels: ['E'], properties: {} });
    }

    writeNs.push(((performance.now() - w0) * 1e6) / (PROBE * 2));

    /* by-id: pre-built shuffled keys, so the timed loop does a LOOKUP and nothing else (item 1969). */
    const keys: string[] = [];

    for (let i = 0; i < PROBE; i += 1) {
      keys.push(`v${rnd() % N}`);
    }

    let seen = 0;
    const b0 = performance.now();

    for (const k of keys) {
      if (g.getVertexById(k) !== undefined) {
        seen += 1;
      }
    }

    byidNs.push(((performance.now() - b0) * 1e6) / PROBE);

    const q0 = performance.now();
    const rows = query(g, 'MATCH (n:T) WHERE n.k = $k RETURN count(*) AS c', { k: 7 });

    queryNs.push(((performance.now() - q0) * 1e6) / (N + PROBE));

    if (seen !== PROBE || rows.length !== 1) {
      throw new Error(`guard: seen=${seen} rows=${rows.length}`);
    }
  }

  console.log(
    `  ${String(N).padEnd(8)} ${med(writeNs).toFixed(0).padStart(8)}      ${med(byidNs)
      .toFixed(0)
      .padStart(7)}      ${med(queryNs).toFixed(1).padStart(8)}`,
  );
}
