/**
 * What does one per-hop ADJACENCY LOOKUP cost, and what would a flat index save?
 *
 * TS multi-hop counts are the widest real gap in the bench — `count 4-hop` 84.58x native,
 * `count 3-hop` 65.61x, `count 2-hop` 39.19x, with one row out so no carrier explains them. The
 * diagnosis (the sweep at item 795) traced three components and found two already spent; the third
 * is `edgesFromByLabel.get(nodeId)` then `.get(type)` — "a nested map costs two by construction".
 * That left the layout change as the only remaining lever and gave it NO number. This gives it one,
 * without building anything.
 *
 * Arms, all answering the same question — the bucket size for one (node, type) pair — over the same
 * 200,000 pairs in the same order, so the only difference is the index layout:
 *
 *   nested        `Map<string, Map<string, Set>>`   what the engine has: two string lookups
 *   concat        `Map<string, Set>`                one lookup, key built per call by concatenation
 *   numeric       `Map<number, Set>`                one lookup, ids and types ALREADY interned
 *   CONTROL       the inner (short-key) lookup alone, as a floor
 *
 * `numeric` is the flat-index direction's CEILING in TypeScript: it assumes the interning such an
 * index brings with it and measures nothing else. `concat` is the cheap half-measure that needs no
 * interning — and it is 2x WORSE than what it replaces, which is the result that stops it being
 * re-proposed.
 *
 *   bun run probe:adjlayout
 *   ADJ_N=1000000 ADJ_TYPES=32 bun run probe:adjlayout
 *
 * WHAT IT DOES NOT SAY. These are standalone maps, not the engine. The hot loop looks up once per
 * middle EDGE rather than once per node, and `side()` does more than the lookup, so a ratio here is
 * the lookup's own ratio and not a query's. One arm per process (item 762), structures built
 * OUTSIDE the timed region, 14 reps, the first three dropped, median of the plateau.
 */
const N = Number(process.env.ADJ_N ?? 200_000);
const TYPES = Number(process.env.ADJ_TYPES ?? 8);
const REPS = 14;
const DROP = 3;

const ids = Array.from({ length: N }, (_, i) => `v${i}`);
const types = Array.from({ length: TYPES }, (_, t) => `T${t}`);
/** The (node, type) pairs each arm looks up, in one fixed order for every arm. */
const probes = Array.from({ length: N }, (_, i) => [i, i % TYPES] as const);

type Arm = { build: () => unknown; read: (x: unknown) => number };

const ARMS: Record<string, Arm> = {
  nested: {
    build: () => {
      const m = new Map<string, Map<string, Set<number>>>();

      for (let i = 0; i < N; i += 1) {
        const inner = new Map<string, Set<number>>();

        inner.set(types[i % TYPES], new Set([i]));
        m.set(ids[i], inner);
      }

      return m;
    },
    read: (x) => {
      const m = x as Map<string, Map<string, Set<number>>>;
      let n = 0;

      for (const [i, t] of probes) {
        n += m.get(ids[i])?.get(types[t])?.size ?? 0;
      }

      return n;
    },
  },
  concat: {
    build: () => {
      const m = new Map<string, Set<number>>();

      for (let i = 0; i < N; i += 1) {
        m.set(`${ids[i]}\u0000${types[i % TYPES]}`, new Set([i]));
      }

      return m;
    },
    read: (x) => {
      const m = x as Map<string, Set<number>>;
      let n = 0;

      for (const [i, t] of probes) {
        n += m.get(`${ids[i]}\u0000${types[t]}`)?.size ?? 0;
      }

      return n;
    },
  },
  numeric: {
    build: () => {
      const m = new Map<number, Set<number>>();

      for (let i = 0; i < N; i += 1) {
        m.set(i * TYPES + (i % TYPES), new Set([i]));
      }

      return m;
    },
    read: (x) => {
      const m = x as Map<number, Set<number>>;
      let n = 0;

      for (const [i, t] of probes) {
        n += m.get(i * TYPES + t)?.size ?? 0;
      }

      return n;
    },
  },
  'CONTROL inner only': {
    build: () => {
      const inner = new Map<string, Set<number>>();

      for (const t of types) {
        inner.set(t, new Set([1]));
      }

      return inner;
    },
    read: (x) => {
      const m = x as Map<string, Set<number>>;
      let n = 0;

      for (const [, t] of probes) {
        n += m.get(types[t])?.size ?? 0;
      }

      return n;
    },
  },
};

const one = process.env.ADJ_ONE;

if (one !== undefined) {
  const arm = ARMS[one];

  if (arm === undefined) {
    console.error(`unknown arm ${one}`);
    process.exit(2);
  }

  const built = arm.build();
  const series: number[] = [];
  let answer = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    answer = arm.read(built);
    series.push(performance.now() - t0);
  }

  const plateau = series.slice(DROP).sort((a, b) => a - b);

  console.log(`${one}\t${(plateau[Math.floor(plateau.length / 2)] ?? 0).toFixed(2)}\t${answer}`);
} else {
  console.log(
    `\n=== adjacency lookup layouts, ${N} lookups, ${TYPES} types, median of ${REPS - DROP} ===\n`,
  );

  for (const name of Object.keys(ARMS)) {
    const r = Bun.spawnSync({
      cmd: [process.argv[0] ?? 'bun', import.meta.path],
      env: { ...process.env, ADJ_ONE: name },
      stdout: 'pipe',
      stderr: 'inherit',
    });
    const [arm, ms, answer] = new TextDecoder().decode(r.stdout).trim().split('\t');

    if (!r.success || arm === undefined) {
      console.log(`  ${name.padEnd(20)} FAILED (exit ${r.exitCode})`);
      continue;
    }

    console.log(
      `  ${arm.padEnd(20)} ${ms?.padStart(8)}ms  ${((Number(ms) * 1e6) / N).toFixed(1)} ns/lookup  answer=${answer}`,
    );
  }
}
