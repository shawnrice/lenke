/**
 * Item 1074: what WOULD a multiplicity (degree-product) multi-hop count cost in TypeScript?
 *
 * `bun run bench` shows the engine's widest TS/native gaps on the plain multi-hop counts —
 * `count 3-hop` at **324.1 ms against 4.8** (68x) and `count 4-hop` at **597.7 against 6.5** (92x).
 * Native at 0.9 ns per walk cannot be enumerating, and `bench.ts`'s own comment names its
 * mechanism: "the tuned degree-product arms own the ungated chain".
 *
 * THE SEMANTICS THAT LICENSES IT, settled first (item 1074's cross-engine check): a CONCATENATED
 * multi-hop pattern is a WALK count — edges may repeat — where the QUANTIFIED spelling is a TRAIL.
 * On a fixture with a 2-cycle, depth 3 reads **8** concatenated against **6** quantified, and both
 * engines agree on both. So multiplicities are the right arithmetic for the concatenated form.
 *
 * WHAT THIS PROBE IS FOR. Native can accumulate into a `Vec<f64>` indexed by a dense `u32`; a TS
 * `Vertex` has no dense index, so the accumulator has to be a `Map` keyed by the object, or a
 * per-query index built first. That difference decides whether the algorithmic win survives the
 * language — and it is worth knowing BEFORE writing an engine arm for it.
 *
 * Three accumulators, against the engine's own cost as the baseline:
 *
 *   map       Map<Vertex, number>, one get+set per edge
 *   indexed   a per-query Vertex -> dense index Map, then two Float64Arrays
 *   fields    a scratch numeric field ON the vertex object (the fastest thing possible, and
 *             NOT a shippable design — it is here as the FLOOR, so the other two can be read
 *             against what the language can do at all)
 *
 * ```text
 * cd packages/native && bun walkcount-probe.ts
 * WC_N=200000 WC_DEG=3 WC_HOPS=3 bun walkcount-probe.ts
 * ```
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.WC_N ?? 200_000);
const DEG = Number(process.env.WC_DEG ?? 3);
const HOPS = Number(process.env.WC_HOPS ?? 3);
const REPS = Number(process.env.WC_REPS ?? 7);

const g = new TsGraph();
const vs: unknown[] = [];

for (let i = 0; i < N; i++) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
}

for (let i = 0; i < N; i++) {
  for (let d = 0; d < DEG; d++) {
    g.addEdge({
      id: `e${i}_${d}`,
      labels: ['KNOWS'],
      from: vs[i] as never,
      to: vs[(i * 7919 + d * 104_729) % N] as never,
      properties: {},
    });
  }
}

// The adjacency box holds EDGES, not vertices — the first cut of this probe treated them as
// vertices, so every arm answered 0 while reading 3-10x faster than the engine. An arm that does
// not do the work is always fast; the `assert` below is what makes that loud instead of silent.
type E = { to: V };
type V = { adjFrom?: Map<string, Set<E>> };

const bucket = (g as unknown as { verticesByLabel: Map<string, Iterable<V>> }).verticesByLabel.get(
  'Person',
) as Iterable<V>;

const check = (name: string, got: unknown, want: number): void => {
  if (got !== want) {
    throw new Error(
      `${name} answered ${String(got)}, want ${want} — the arm is not doing the work`,
    );
  }
};

const med = (f: () => unknown): { ms: number; got: unknown } => {
  const series: number[] = [];
  let got: unknown;

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();

    got = f();
    series.push(performance.now() - t0);
  }

  const w = series.slice(2).sort((a, b) => a - b);

  return { ms: w[Math.floor(w.length / 2)], got };
};

/** The engine as it stands — the baseline every arm below is trying to beat. */
const chain = Array.from({ length: HOPS }, (_, i) => `-[:KNOWS]->(n${i})`).join('');
const engine = med(() => tsQuery(g, `MATCH (a:Person)${chain} RETURN count(*) AS c`));

console.log(`N=${N} degree=${DEG} hops=${HOPS} walks=${N * DEG ** HOPS}`);
console.log(`${'arm'.padEnd(26)} ${'ms'.padStart(9)}   answer`);
console.log(
  `${'ENGINE (enumerates)'.padEnd(26)} ${engine.ms.toFixed(1).padStart(9)}   ${JSON.stringify(engine.got)}`,
);

// The engine's own answer is the oracle every arm is checked against.
const want = (engine.got as { c: number }[])[0].c;

// 1. A Map keyed by the vertex object.
const byMap = med(() => {
  let cur = new Map<V, number>();

  for (const v of bucket) {
    cur.set(v, 1);
  }

  for (let h = 0; h < HOPS; h++) {
    const next = new Map<V, number>();

    for (const [v, w] of cur) {
      const b = v.adjFrom?.get('KNOWS');

      if (b !== undefined) {
        for (const e of b) {
          const t = e.to;

          next.set(t, (next.get(t) ?? 0) + w);
        }
      }
    }

    cur = next;
  }

  let total = 0;

  for (const w of cur.values()) {
    total += w;
  }

  return total;
});

check('map', byMap.got, want);
console.log(
  `${'map<Vertex,number>'.padEnd(26)} ${byMap.ms.toFixed(1).padStart(9)}   ${String(byMap.got)}`,
);

// 2. A per-query dense index, then typed arrays. The index lookup is still a Map.get per edge.
const byIndexed = med(() => {
  const idx = new Map<V, number>();
  let n = 0;

  for (const v of bucket) {
    idx.set(v, n++);
  }

  let cur = new Float64Array(n);
  let next = new Float64Array(n);

  cur.fill(1);

  for (let h = 0; h < HOPS; h++) {
    next.fill(0);

    // The spread of one source's weight, hoisted out of the loop nest: inline it and the arm
    // nests six deep, which the lint gate refuses — and the shallower shape is the one an engine
    // arm would have anyway.
    const spread = (b: Set<E>, w: number, into: Float64Array): void => {
      for (const e of b) {
        const j = idx.get(e.to);

        if (j !== undefined) {
          into[j] += w;
        }
      }
    };

    for (const [v, i] of idx) {
      const w = cur[i];
      const b = w === 0 ? undefined : v.adjFrom?.get('KNOWS');

      if (b !== undefined) {
        spread(b, w, next);
      }
    }

    const swap = cur;

    cur = next;
    next = swap;
  }

  let total = 0;

  for (const w of cur) {
    total += w;
  }

  return total;
});

check('indexed', byIndexed.got, want);
console.log(
  `${'dense index + Float64'.padEnd(26)} ${byIndexed.ms.toFixed(1).padStart(9)}   ${String(byIndexed.got)}`,
);

// 3. THE FLOOR: a scratch field on the vertex itself. Not a shippable design — it mutates user
// objects and breaks under reentrancy — but it says what the language can do when the accumulator
// costs nothing, so the two arms above can be read against something.
const byField = med(() => {
  const all: (V & { __w?: number; __n?: number })[] = [];

  for (const v of bucket) {
    const x = v as V & { __w?: number; __n?: number };

    x.__w = 1;
    x.__n = 0;
    all.push(x);
  }

  for (let h = 0; h < HOPS; h++) {
    for (const v of all) {
      const w = v.__w;

      if (w !== 0 && w !== undefined) {
        const b = v.adjFrom?.get('KNOWS');

        if (b !== undefined) {
          for (const e of b) {
            const x = e.to as V & { __n?: number };

            x.__n = (x.__n ?? 0) + w;
          }
        }
      }
    }

    for (const v of all) {
      v.__w = v.__n;
      v.__n = 0;
    }
  }

  let total = 0;

  for (const v of all) {
    total += v.__w ?? 0;
  }

  return total;
});

check('field', byField.got, want);
console.log(
  `${'scratch field (FLOOR)'.padEnd(26)} ${byField.ms.toFixed(1).padStart(9)}   ${String(byField.got)}`,
);
