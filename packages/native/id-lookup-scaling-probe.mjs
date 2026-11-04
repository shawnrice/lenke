/**
 * IS GET-BY-ID ACTUALLY O(1)? — a scaling probe, because "it is a `Map`" is a claim about the source
 * and not about the build (item 1451).
 *
 * This is a standing requirement of the optimization work rather than a hypothesis: keep good O(1)
 * access to a vertex or edge by id. Nothing in `PROBES.md` measured it, so every statement about it
 * so far has been a reading of `Graph.ts` — and a `Map` can still disappoint in ways a read does not
 * show: a key type that forces hashing per lookup, a dictionary-mode fallback, a wrapper that scans,
 * or an accessor that rebuilds something per call.
 *
 * THE MEASUREMENT IS THE RATIO, NOT THE TIME. A per-lookup cost that is flat from 10k to 1M elements
 * is O(1); one that grows with `log N` or worse is not. Absolute ns/lookup is reported too, because a
 * flat-but-slow lookup is a different finding from a flat-and-fast one, and because the id path is
 * what external-id results, `_MERGE`, edge reconstruction on reload and every `from`/`to` resolution
 * go through.
 *
 * ⚠️ THE LOOKUP KEYS ARE DRAWN IN A SHUFFLED ORDER and the keys are the ids actually inserted. A
 * sequential sweep measures the allocator's layout as much as the map, and a miss-heavy sweep measures
 * the negative path — both are legitimate questions, so `MODE` selects:
 *
 *   hit      every lookup hits, keys visited in a large-stride permutation (the default)
 *   miss     every lookup misses — the negative path, which a `Map` answers without touching a value
 *   seq      keys visited in insertion order, as a locality CONTROL against `hit`
 *
 *   SIZES=10000,100000,1000000 MODE=hit node id-lookup-scaling-probe.mjs
 *
 * Vertices and edges are measured separately: they are different maps and the edge path additionally
 * resolves endpoints on construction, so a regression could land in one and not the other.
 */
import { Graph } from '@lenke/core';

const SIZES = (process.env.SIZES ?? '10000,100000,1000000').split(',').map(Number);
const REPS = Number(process.env.REPS ?? 7);
const DROP = Number(process.env.DROP ?? 2);
const MODE = process.env.MODE ?? 'hit';

if (!['hit', 'miss', 'seq'].includes(MODE)) {
  throw new Error(`MODE must be hit, miss or seq; got ${MODE}`);
}

/** Coprime with every size used here, so the walk is a permutation rather than a short cycle. */
const STRIDE = 104_729;

const build = (n) => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < n; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
  }

  // One edge per vertex, so the edge map is the same size and the comparison is per-element.
  for (let i = 0; i < n; i += 1) {
    g.addEdge({ id: `e${i}`, from: vs[i], to: vs[(i * 7 + 3) % n], labels: ['E'], properties: {} });
  }

  return g;
};

/** The ids to look up, in the order `MODE` asks for. Built once so the loop measures only lookup. */
const keysFor = (n, prefix) => {
  const keys = new Array(n);

  for (let i = 0; i < n; i += 1) {
    if (MODE === 'seq') {
      keys[i] = `${prefix}${i}`;
    } else if (MODE === 'miss') {
      // Same shape, same length class, never inserted.
      keys[i] = `${prefix}x${i}`;
    } else {
      keys[i] = `${prefix}${(i * STRIDE) % n}`;
    }
  }

  return keys;
};

/**
 * ⚠️ A MISS RETURNS `null`, NOT `undefined` — and this probe's own assertion is what found that out,
 * by reporting 10,000 hits on a sweep of keys that were never inserted. `!= null` covers both, which
 * is the only comparison that makes the hit count mean what it says.
 */
const timeLookups = (fn, keys) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    let found = 0;
    const t0 = performance.now();

    for (const k of keys) {
      if (fn(k) != null) {
        found += 1;
      }
    }

    const dt = performance.now() - t0;

    series.push(dt);

    // Asserted, not printed: a sweep that finds nothing when it should find everything would
    // otherwise measure the negative path and report it as the positive one.
    const want = MODE === 'miss' ? 0 : keys.length;

    if (found !== want) {
      throw new Error(`MODE=${MODE} expected ${want} hits, got ${found}`);
    }
  }

  const kept = series.slice(DROP).sort((a, b) => a - b);

  return kept[Math.floor(kept.length / 2)];
};

/**
 * ⚠️ THE CONTROL, AND WITHOUT IT THIS PROBE DRAWS THE WRONG CONCLUSION. A hash map at 1,000,000
 * entries is slower PER LOOKUP than at 10,000 whatever its complexity, because the table stops
 * fitting in cache — that is memory hierarchy, not an extra comparison. The first run of this probe
 * reported "NOT FLAT, per-lookup cost grows with N" at 4.91x and that verdict was unsound.
 *
 * The tell was already in the data: `seq` grew 2.4-2.9x and `hit` 3.8-4.9x on the same maps, and
 * locality cannot matter to an algorithmic term. So the question is not "is it flat" but "is it as
 * flat as a `Map` can be" — hence a raw `Map<string, number>` of the same size, with the same keys in
 * the same order, measured by the same function. If the engine tracks it, the engine's lookup IS the
 * map lookup and there is nothing between them to remove.
 */
const rows = [];

for (const n of SIZES) {
  const g = build(n);
  const vKeys = keysFor(n, 'v');
  const eKeys = keysFor(n, 'e');

  const raw = new Map();

  for (let i = 0; i < n; i += 1) {
    raw.set(`v${i}`, i);
  }

  const vMs = timeLookups((k) => g.getVertexById(k), vKeys);
  const eMs = timeLookups((k) => g.getEdgeById(k), eKeys);
  const rMs = timeLookups((k) => raw.get(k), vKeys);

  rows.push({ n, vNs: (vMs * 1e6) / n, eNs: (eMs * 1e6) / n, rNs: (rMs * 1e6) / n });
}

const [base] = rows;
const last = rows.at(-1);

const COLS = [10, 10, 10, 10, 7, 7];
const line = (cells) => cells.map((c, k) => String(c).padStart(COLS[k])).join(' ');

console.log(JSON.stringify({ mode: MODE, reps: REPS, sizes: SIZES }));
console.log(line(['elements', 'vertex ns', 'edge ns', 'raw Map', 'v/raw', 'e/raw']));

for (const r of rows) {
  console.log(
    line([
      r.n,
      r.vNs.toFixed(1),
      r.eNs.toFixed(1),
      r.rNs.toFixed(1),
      (r.vNs / r.rNs).toFixed(2),
      (r.eNs / r.rNs).toFixed(2),
    ]),
  );
}

// Growth of the ENGINE's per-lookup cost divided by the growth a raw `Map` shows over the same range.
// ~1 means the engine scales exactly as the map does, which is the real question — see the control's
// note above for why absolute growth is not.
const engineGrowth = Math.max(last.vNs / base.vNs, last.eNs / base.eNs);
const mapGrowth = last.rNs / base.rNs;

console.log(
  `\nover ${base.n} -> ${last.n} elements: engine grows ${engineGrowth.toFixed(2)}x per lookup, raw Map ${mapGrowth.toFixed(2)}x`,
);
console.log(`engine growth relative to the map: ${(engineGrowth / mapGrowth).toFixed(2)}x`);
console.log(
  engineGrowth / mapGrowth < 1.5
    ? 'The engine scales AS A MAP DOES — the growth is cache, not complexity. O(1) holds.'
    : 'The engine scales WORSE than a raw Map — something per-lookup is beyond the map itself.',
);
console.log(
  `constant factor over a raw Map at ${last.n}: vertex ${(last.vNs / last.rNs).toFixed(2)}x, edge ${(last.eNs / last.rNs).toFixed(2)}x`,
);
console.log(
  '\n\u26a0\ufe0f The SMALLEST size is warm-up noisy: at 10,000 the loop runs 10,000 times a rep and the',
);
console.log(
  '  reading comes out ABOVE the 100,000 one (non-monotonic). Treat the base row as indicative and',
);
console.log('  read the relative-to-map verdict, which is stable across all three modes.');
