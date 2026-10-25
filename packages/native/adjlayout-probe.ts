/**
 * What does one per-hop ADJACENCY LOOKUP cost, and which part of it is available?
 *
 * TS multi-hop counts are the widest real gap in the bench — `count 4-hop` 84.58x native, 3-hop
 * 65.61x, 2-hop 39.19x, one row out so no carrier explains them. Item 795's sweep traced three
 * components, found two spent, and left the third — `edgesFromByLabel.get(nodeId)` then
 * `.get(type)`, "a nested map costs two by construction" — with no number. This prices it, and the
 * arms are built so that each pair differs in ONE thing:
 *
 *   nested      `Map<string, Map<string, Set>>`     what the engine has: two long-lived-key lookups
 *   concat      `Map<string, Set>`, key per call    one lookup, key CONCATENATED per lookup
 *   short keys  `Map<string, Set>`, key per call    one lookup, SHORT key, still built per lookup
 *   prekeyed    `Map<string, Set>`, key pre-built   one lookup, string key ALREADY in hand
 *   numeric     `Map<number, Set>`                  one lookup, ids and types INTERNED
 *   CONTROL     the inner 8-entry map alone         a tiny cache-resident map, not a lookup floor
 *
 * MEASURED (200,000 lookups, 8 types, one arm per process, median of 11, three rounds):
 *
 * ```text
 *   nested       49.6 / 54.2 / 68.3 ns/lookup
 *   concat      103.2 /107.5 /106.9
 *   short keys   83.5 / 83.9 / 90.7
 *   prekeyed     14.2 / 14.9 / 14.9
 *   numeric      14.2 / 14.6 / 15.6
 *   CONTROL       6.5 /  8.1 /  8.3
 * ```
 *
 * TWO RESULTS, and the first one retracts the framing this probe was built with (items 807, 808):
 *
 * **INTERNING IS WORTH NOTHING.** `prekeyed` and `numeric` are the same to within noise — a
 * long-lived STRING key costs what an SMI costs. The lever is "one lookup instead of two", not the
 * key's type, so there is no case here for an id→u32 intern table.
 *
 * **WHAT COSTS IS BUILDING A KEY PER LOOKUP.** `short keys` does ONE lookup in a 200,000-entry map
 * and is WORSE than nested's two — a fresh string is ~70 ns of allocation plus a hash that has
 * never been computed, where a long-lived string carries V8's cached hash. That is the mechanism
 * behind `concat` too, isolated.
 *
 * **So the lookup-level lever is 3.3-4.5x and it is NOT available.** Item 590 measured the
 * one-lookup version at the QUERY level at **1.5x**, and a per-query flattened CSR at **37.65 ms to
 * build, "no help at all"**. The one layout that gets a single lookup with keys already in hand is
 * the type-first inversion — **refuted at item 200 and user-confirmed closed**: it wins the typed
 * lookup 2.2-4.1x and loses get-by-id 1.4x at three edge types and 4.8x at twenty.
 *
 *   bun run probe:adjlayout
 *   ADJ_N=1000000 ADJ_TYPES=32 bun run probe:adjlayout
 *
 * The `CONTROL` arm is an 8-entry map and so is NOT a floor for "one lookup" — item 807 read it as
 * one and attributed ~45 ns to the outer lookup on that basis. The arithmetic holds; the 6.5 ns does
 * not generalize, and `prekeyed` is the arm that answers what one lookup really costs.
 *
 * These are standalone maps, not the engine: the hot loop looks up once per middle EDGE and `side()`
 * does more than the lookup, so a ratio here is the lookup's and not a query's. One arm per process
 * (item 762), built OUTSIDE the timed region, 14 reps, first three dropped, median of the plateau.
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
  // THE DISCRIMINATOR between the two effects 807 could not separate (item 808). `numeric` changes
  // TWO things at once: two lookups become one, AND the key becomes an SMI. This arm keeps the
  // single lookup and the STRING key, looking up through a PRE-BUILT key array so nothing is
  // concatenated per call. No engine could pre-build those keys — this arm is a measurement, not a
  // candidate — but it is the only way to tell "one lookup instead of two" from "interned ids".
  prekeyed: {
    build: () => {
      const m = new Map<string, Set<number>>();
      const keys: string[] = [];

      for (let i = 0; i < N; i += 1) {
        const k = `${ids[i]}\u0000${types[i % TYPES]}`;

        keys.push(k);
        m.set(k, new Set([i]));
      }

      return [m, keys] as const;
    },
    read: (x) => {
      const [m, keys] = x as readonly [Map<string, Set<number>>, string[]];
      let n = 0;

      for (let j = 0; j < probes.length; j += 1) {
        n += m.get(keys[j])?.size ?? 0;
      }

      return n;
    },
  },
  // A 200,000-entry map with a SHORT string key, so the key-length axis is separated from the
  // table-size axis too.
  'short keys': {
    build: () => {
      const m = new Map<string, Set<number>>();

      for (let i = 0; i < N; i += 1) {
        m.set(i.toString(36), new Set([i]));
      }

      return m;
    },
    read: (x) => {
      const m = x as Map<string, Set<number>>;
      let n = 0;

      for (const [i] of probes) {
        n += m.get(i.toString(36))?.size ?? 0;
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
