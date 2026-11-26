/**
 * **IS `getVertexById` STILL O(1) AT SCALE, OR DOES IT GROW? (item 2281)** The growth sweep measured
 * 83 ns at 10k rising to 372 ns at 160k — 4.5x over 16x in N. That is the user's standing constraint, so it
 * needs a floor before it is called a defect. Two confounds are visible before measuring:
 *
 * **1. A 160k-entry Map does not fit in cache.** Random lookups miss, and that cost is unavoidable for
 *    ANY hash map — it is O(1) in operations, not in cache misses. The floor below is a raw `Map.get` over
 *    the same keys at the same N, so whatever the memory hierarchy charges is charged to BOTH arms.
 *
 * **2. MY OWN KEYS GREW WITH N.** `v9999` is 5 chars and `v159999` is 7 — and string hashing is O(len),
 *    so part of that 4.5x was me making the keys longer. Every id here is FIXED-WIDTH (`v0000123`), which
 *    removes the term entirely.
 *
 * If the floor rises the same way, there is nothing to fix and the constraint holds. If `getVertexById`
 * rises FASTER than the floor, the gap is ours.
 */
import { Graph } from '@lenke/core';

const SIZES = [10_000, 20_000, 40_000, 80_000, 160_000];
const REPS = 9;
const PROBE = 20_000;

const med = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

const lcg = (seed: number) => {
  let s = seed | 0;

  return (): number => {
    s = (Math.imul(s, 1_103_515_245) + 12_345) | 0;

    return (s >>> 1) % 1_000_000_007;
  };
};

/* FIXED WIDTH, so key length is constant across every N in the sweep. */
const idOf = (i: number): string => `v${String(i).padStart(7, '0')}`;

console.log(
  `  N        getVertexById   SAME map.get   ratio   tiny-value map   (median of ${REPS}, ns/op)`,
);

for (const N of SIZES) {
  const api: number[] = [];
  const raw: number[] = [];
  const mir: number[] = [];

  for (let rep = 0; rep < REPS; rep += 1) {
    const g = new Graph();
    const mirror = new Map<string, { id: string }>();

    for (let i = 0; i < N; i += 1) {
      const id = idOf(i);

      g.addVertex({ id, labels: ['T'], properties: { k: i % 977 } });
      mirror.set(id, { id });
    }

    const rnd = lcg(0xc0ffee + rep);
    const keys: string[] = [];

    for (let i = 0; i < PROBE; i += 1) {
      keys.push(idOf(rnd() % N));
    }

    /* Alternate which arm goes first, so neither pays the cold-cache entry cost every time. */
    const apiFirst = rep % 2 === 0;
    let seenA = 0;
    let seenB = 0;
    let seenC = 0;

    const runApi = (): number => {
      const t = performance.now();

      for (const k of keys) {
        if (g.getVertexById(k) !== undefined) {
          seenA += 1;
        }
      }

      return ((performance.now() - t) * 1e6) / PROBE;
    };

    /*
     * **THE MIRROR MAP WAS AN UNFAIR FLOOR.** `getVertexById` is literally
     * `this.verticesById.get(id) ?? null` — one lookup, no box cache — so a 2.81x gap could not be the
     * wrapper. The mirror stored tiny `{id}` objects while the real map holds full Vertex objects, which is
     * a different memory profile at the SAME entry count. The fair floor is THE SAME MAP: identical
     * entries, identical values, only the call wrapper differs.
     */
    const store = g.verticesById;

    const runRaw = (): number => {
      const t = performance.now();

      for (const k of keys) {
        if (store.get(k) !== undefined) {
          seenB += 1;
        }
      }

      return ((performance.now() - t) * 1e6) / PROBE;
    };

    const runMirror = (): number => {
      const t = performance.now();

      for (const k of keys) {
        if (mirror.get(k) !== undefined) {
          seenC += 1;
        }
      }

      return ((performance.now() - t) * 1e6) / PROBE;
    };

    if (apiFirst) {
      api.push(runApi());
      raw.push(runRaw());
    } else {
      raw.push(runRaw());
      api.push(runApi());
    }

    mir.push(runMirror());

    if (seenA !== PROBE || seenB !== PROBE || seenC !== PROBE) {
      throw new Error(`guard: api=${seenA} raw=${seenB} mirror=${seenC} of ${PROBE}`);
    }
  }

  const a = med(api);
  const r = med(raw);

  console.log(
    `  ${String(N).padEnd(8)} ${a.toFixed(1).padStart(10)}      ${r.toFixed(1).padStart(9)}   ${(
      a / r
    ).toFixed(2)}x      ${med(mir).toFixed(1).padStart(8)}`,
  );
}
