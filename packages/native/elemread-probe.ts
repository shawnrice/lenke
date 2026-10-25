/**
 * Where does a per-element property read actually go?
 *
 * Every filtered walk in the TS engine does the same two things per element: it gets the element
 * from a collection, and it reads one property off it. Item 802's ladder priced that pair at
 * 9.6-11.1 ns a vertex and attributed it to "a property read and compare" — which is wrong, and
 * this probe is what shows it. The read alone is ~1.8 ns and the walk alone is ~2.0; together they
 * are 9.6. **Most of the cost is in the pairing, not in either half**, and that is invisible to any
 * instrument that measures one of them.
 *
 * The arms are built so that each pair of them differs in ONE thing:
 *
 *   walk map values     the walk with NO read at all — the floor for iterating `verticesById`
 *   walk map + read     the same walk plus `v.properties.k` — the engine's own shape
 *   walk label bucket   the same read over the label `Set` instead of the id `Map`
 *   walk ARRAY + read   the same read over a dense array of the SAME vertex objects
 *   graph CONST/DYN     the property bags EXTRACTED into an array first, then read in order
 *   literal, frozen     the same two keys as plain and as frozen object literals
 *   map get             the same two keys in a `Map` per element — the alternative layout
 *
 * `CONST key` against `DYN key` is in here because item 805 expected it to detect V8 DICTIONARY
 * mode: on a fast-mode object a literal-key load is an inline-cache hit where a computed key goes
 * through the keyed-load stub. It does NOT — the two are equal in every arm, including the
 * plain-object-literal reference that is certainly fast-mode — because a hoisted `const key = 'k'`
 * is as constant to V8 as the literal. **So that pair cannot diagnose object shape, and the equality
 * item 802 read as suspicious is nothing.** It stays as the record of a refuted reading.
 *
 *   bun run probe:elemread
 *   DICT_N=1000000 bun run probe:elemread
 *
 * ONE ARM PER PROCESS (item 762's rule), objects built OUTSIDE the timed region, 14 reps, the first
 * three dropped as JIT warm-up, the MEDIAN of the plateau. The absolute numbers are a machine's;
 * what this probe is for is the ratios BETWEEN arms.
 */
import { Graph } from '@lenke/core';

const N = Number(process.env.DICT_N ?? 200_000);
const REPS = 14;
const DROP = 3;

type Row = Record<string, unknown>;

/** The engine's own vertices, as a filtered walk sees them. */
const fromGraph = (): Row[] => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 50, s: `s${i % 7}` } });
  }

  const out: Row[] = [];

  for (const v of g.verticesById.values()) {
    out.push(v.properties);
  }

  return out;
};

/** A plain object literal with the same two keys, built in one shape — the fast-mode reference. */
const fromLiteral = (): Row[] => {
  const out: Row[] = [];

  for (let i = 0; i < N; i += 1) {
    out.push({ k: i % 50, s: `s${i % 7}` });
  }

  return out;
};

/** The same literal, then FROZEN — the shape the engine may be producing. */
const fromFrozen = (): Row[] => {
  const out: Row[] = [];

  for (let i = 0; i < N; i += 1) {
    out.push(Object.freeze({ k: i % 50, s: `s${i % 7}` }));
  }

  return out;
};

/** A Map per element, the alternative representation. */
const fromMap = (): Map<string, unknown>[] => {
  const out: Map<string, unknown>[] = [];

  for (let i = 0; i < N; i += 1) {
    out.push(
      new Map<string, unknown>([
        ['k', i % 50],
        ['s', `s${i % 7}`],
      ]),
    );
  }

  return out;
};

type Arm = { build: () => readonly unknown[]; read: (rows: readonly unknown[]) => number };

const sumConst = (rows: readonly unknown[]): number => {
  let n = 0;

  for (const r of rows) {
    n += (r as { k: number }).k;
  }

  return n;
};

const sumDyn = (rows: readonly unknown[]): number => {
  const key = 'k';
  let n = 0;

  for (const r of rows) {
    n += (r as Row)[key] as number;
  }

  return n;
};

const sumMap = (rows: readonly unknown[]): number => {
  let n = 0;

  for (const r of rows) {
    n += (r as Map<string, unknown>).get('k') as number;
  }

  return n;
};

/** The engine's vertex MAP, not an array of its property bags — what a tally actually walks. */
const graphOf = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 50, s: `s${i % 7}` } });
  }

  return g;
};

const ARMS: Record<string, Arm> = {
  // WALKING, not reading. Item 802's ladder attributed ~10 ns/vertex to "a property read and
  // compare"; these arms separate the walk from the read.
  'walk map values': {
    build: () => [graphOf()],
    read: (rows) => {
      let n = 0;

      for (const _v of (rows[0] as Graph).verticesById.values()) {
        n += 1;
      }

      return n;
    },
  },
  'walk map + read': {
    build: () => [graphOf()],
    read: (rows) => {
      let n = 0;

      for (const v of (rows[0] as Graph).verticesById.values()) {
        n += (v.properties as { k: number }).k;
      }

      return n;
    },
  },
  'walk label bucket': {
    build: () => [graphOf()],
    read: (rows) => {
      let n = 0;

      for (const v of (rows[0] as Graph).verticesByLabel.get('P') ?? []) {
        n += (v.properties as { k: number }).k;
      }

      return n;
    },
  },
  'walk ARRAY + read': {
    build: () => [[...graphOf().verticesById.values()]],
    read: (rows) => {
      // `for...of` over the array, matching the Map arms, so the ONLY difference between this
      // arm and `walk map + read` is the collection — not the access form.
      const vs = rows[0] as { properties: { k: number } }[];
      let n = 0;

      for (const v of vs) {
        n += v.properties.k;
      }

      return n;
    },
  },
  'graph   CONST key': { build: fromGraph, read: sumConst },
  'graph   DYN key': { build: fromGraph, read: sumDyn },
  'literal CONST key': { build: fromLiteral, read: sumConst },
  'literal DYN key': { build: fromLiteral, read: sumDyn },
  'frozen  CONST key': { build: fromFrozen, read: sumConst },
  'frozen  DYN key': { build: fromFrozen, read: sumDyn },
  'map     get': { build: fromMap, read: sumMap },
};

const one = process.env.DICT_ONE;

if (one !== undefined) {
  const arm = ARMS[one];

  if (arm === undefined) {
    console.error(`unknown arm ${one}`);
    process.exit(2);
  }

  // BUILT OUTSIDE THE TIMED REGION. A first version built inside it, where construction is the
  // larger term and would have swamped the read this probe is about.
  const rows = arm.build();
  const series: number[] = [];
  let answer = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    answer = arm.read(rows);
    series.push(performance.now() - t0);
  }

  const plateau = series.slice(DROP).sort((x, y) => x - y);

  console.log(`${one}\t${(plateau[Math.floor(plateau.length / 2)] ?? 0).toFixed(2)}\t${answer}`);
} else {
  console.log(
    `\n=== property-read shape, ${N} objects, median of ${REPS - DROP}, one arm/process ===`,
  );
  console.log('(objects built OUTSIDE the timed region — only the per-element read is timed)\n');

  for (const name of Object.keys(ARMS)) {
    const r = Bun.spawnSync({
      cmd: [process.argv[0] ?? 'bun', import.meta.path],
      env: { ...process.env, DICT_ONE: name },
      stdout: 'pipe',
      stderr: 'inherit',
    });
    const [arm, ms, answer] = new TextDecoder().decode(r.stdout).trim().split('\t');

    if (!r.success || arm === undefined) {
      console.log(`  ${name.padEnd(20)} FAILED (exit ${r.exitCode})`);
      continue;
    }

    console.log(`  ${arm.padEnd(20)} ${ms?.padStart(8)}ms  answer=${answer}`);
  }
}
