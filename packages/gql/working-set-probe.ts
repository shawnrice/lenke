/**
 * Does the 41 ns floor rise to the in-situ 150-190 ns when the HEAP is the engine's? (item 1126)
 *
 * Item 1125 collected the pattern: three unrelated per-edge bodies (the GQL way-count sweep at 190
 * ns an edge, the Gremlin multiplicity walk at 158, the GQL 3-hop degree product at ~150) are each
 * 3.7-4.6x a micro built on the engine's own SHAPES — and every named suspect inside them has been
 * refuted individually. Item 1105 noted the likely reason once: "a probe whose working set is
 * smaller than the engine's UNDERSTATES a cache-sharing cost".
 *
 * Item 1104's probe already used the engine's shapes at the engine's N (200,000 vertices, Sets of 5
 * edge-likes, a 200,000-entry `Map<string,number>`, a `Float64Array`). What it did NOT have is the
 * engine's HEAP: a real `Vertex` carries frozen properties and labels, a real `Edge` carries a
 * labels `Set` and properties, and the adjacency is a `Map<id, Map<label, Set<Edge>>>` — so at the
 * same N the live bytes are far larger and every pointer chase is likelier to miss.
 *
 * So this probe runs the MINIMAL per-edge body over a REAL graph. That is the floor with the real
 * heap, and it is the number the three bodies should be compared against instead:
 *
 *   ARM 1  synthetic heap, minimal body   — reproduces item 1104's ~41 ns
 *   ARM 2  REAL graph, minimal body       — the same body, the engine's heap
 *   ARM 3  REAL graph, body + a degree read — what the 3-hop product's inner line actually does
 *
 * If ARM 2 lands near 150 ns, the residual is the heap and all three bodies are at their floor.
 * If it stays near 41, the residual is engine code and the hunt is still open.
 *
 *   cd packages/gql && bun working-set-probe.ts
 *   WS_N=200000 WS_DEG=5 bun working-set-probe.ts
 */
import { Graph } from '@lenke/core';

const N = Number(process.env.WS_N ?? 200_000);
const DEG = Number(process.env.WS_DEG ?? 5);
const REPS = Number(process.env.WS_REPS ?? 9);

/** Deterministic, in integer math — item 702's f64 LCG collapsed to an ~11k period. */
const lcg = (seed: number): (() => number) => {
  let s = seed;

  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;

    return s;
  };
};

const report = (name: string, touches: number, series: readonly number[]): void => {
  const warm = series.slice(3).toSorted((a, b) => a - b);
  const med = warm[Math.floor(warm.length / 2)];

  console.log(
    `  ${name.padEnd(42)} median ${med.toFixed(1).padStart(8)} ms   ${((med * 1e6) / touches).toFixed(1).padStart(6)} ns/touch`,
  );
};

const bench = (name: string, touches: number, f: () => number): void => {
  const series: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();
    const sink = f();

    series.push(performance.now() - t);

    if (sink === -1) {
      throw new Error('unreachable');
    }
  }

  report(name, touches, series);
};

console.log(`\n# ${N} vertices, degree ${DEG}, median of ${REPS} dropping 3\n`);

// ---------------------------------------------------------------- ARM 1: synthetic heap ---
{
  const ids = Array.from({ length: N }, (_, i) => `v${i}`);
  const slotOf = new Map<string, number>();

  for (let i = 0; i < N; i += 1) {
    slotOf.set(ids[i], i);
  }

  const next = lcg(12_345);
  const sets: Array<Set<{ toId: string }>> = [];

  for (let i = 0; i < N; i += 1) {
    const set = new Set<{ toId: string }>();

    for (let d = 0; d < DEG; d += 1) {
      set.add({ toId: `v${next() % N}` });
    }

    sets.push(set);
  }

  const ways = new Float64Array(N);

  bench('ARM 1 synthetic heap, minimal body', N * DEG, () => {
    let acc = 0;

    for (let i = 0; i < N; i += 1) {
      for (const e of sets[i]) {
        const to = slotOf.get(e.toId) ?? -1;

        ways[to] += 1;
        acc += to;
      }
    }

    return acc;
  });
}

// ------------------------------------------------------------------- ARMS 2 and 3: real graph ---
{
  const g = new Graph();
  const vs = Array.from({ length: N }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: i % 100, name: `person${i}` } }),
  );
  const next = lcg(12_345);

  for (let i = 0; i < N; i += 1) {
    for (let d = 0; d < DEG; d += 1) {
      g.addEdge({
        id: `e${i}_${d}`,
        labels: ['KNOWS'],
        from: vs[i],
        to: vs[next() % N],
        properties: {},
      });
    }
  }

  // The engine interns ids to slots exactly like this, and the slot table is the same size.
  const slotOf = new Map<string, number>();
  let k = 0;

  for (const v of g.verticesById.values()) {
    slotOf.set(v.id, k);
    k += 1;
  }

  const ways = new Float64Array(k);
  const index = g.edgesFromByLabel;

  bench('ARM 2 REAL graph, minimal body', N * DEG, () => {
    let acc = 0;

    for (const v of g.verticesById.values()) {
      const set = index.get(v.id)?.get('KNOWS');

      if (set === undefined) {
        continue;
      }

      for (const e of set) {
        const to = slotOf.get(e.toId) ?? -1;

        ways[to] += 1;
        acc += to;
      }
    }

    return acc;
  });

  // What the 3-hop product's inner line does: per middle edge, a DEGREE read of the far endpoint
  // (an id hash into the adjacency map, then a bucket size) and a multiply-add.
  bench('ARM 3 REAL graph, + per-edge degree read', N * DEG, () => {
    let acc = 0;

    for (const v of g.verticesById.values()) {
      const set = index.get(v.id)?.get('KNOWS');

      if (set === undefined) {
        continue;
      }

      for (const e of set) {
        acc += index.get(e.toId)?.get('KNOWS')?.size ?? 0;
      }
    }

    return acc;
  });
}
