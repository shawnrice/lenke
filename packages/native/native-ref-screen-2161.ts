/**
 * THE UNBENCHED-FEATURE SCREEN, WITH A NATIVE REFERENCE (item 2161).
 *
 * ⚠️⚠️ **ITEM 2160 IS WHY THIS EXISTS.** That item screened the same features with a TS-INTERNAL reference
 * ("feature X costs N times feature Y in TS") and flagged two at 24x and 8.2x. Both evaporated against the
 * cross-engine column:
 *
 * ```text
 *                            TS      ffi    ratio
 *     nodes(p)             691.7    342.5    2.02x   <- native pays 342 too: the work is INHERENT
 *     labels(a)             11.3     14.6    0.77x   <- TS is FASTER; no gap at all
 * ```
 *
 * 🔑 A TS-internal ratio nominates only WHICH RUNG serves a shape, never how much headroom exists. This
 * screen asks the question that matters instead: **for each shape with no bench row, what does native
 * charge?** Three instances of the old failure are recorded (items 234, 2160, and 2160's own two flags),
 * which is enough to change the instrument rather than remember the caveat.
 *
 * ⚠️ `bun` is required (it reads the FFI backend the same way `bench.ts` does), and `@lenke/*` resolve to
 * BUILT DIST — a source edit reaches this only after `nx build`.
 *
 *     cd packages/native && bun run native-ref-screen-2161.ts
 *     SCREEN_N=50000 bun run native-ref-screen-2161.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.SCREEN_N ?? 200_000);
const FANOUT = Number(process.env.SCREEN_FANOUT ?? 3);
/*
 * ⚠️⚠️⚠️ **13 REPS DROPPING 6, AND BOTH NUMBERS ARE MEASURED (item 2172).** This screen ran 5 reps
 * dropping 2 and NOMINATED A PHANTOM: it put `ORDER BY two keys` at a 5.2x floor-subtracted gap, which
 * a per-rep series refuted outright.
 *
 * ```text
 *     1 col 1 key   44.0 15.8 10.3 27.3 12.1 41.9 | 7.4 7.0 7.4 7.0 7.4 7.8 7.7 ...   settles ~7.4
 *     2 col 1 key   15.1 15.1  9.7 11.9 10.3 10.1 | 9.6 ... 9.7 10.8 9.3 9.6 ...      settles ~9.7
 *     2 col 2 key   33.0 18.3 16.8 16.5 17.2      | 11.4 10.3 10.7 10.9 10.8 ...      settles ~10.8
 * ```
 *
 * 🔑 **Warmup runs SIX reps deep, not two**, so a 5-rep window reported 6.22-16.00 ms for the SAME row
 * across three runs. Settled, the series is monotonic and the finding evaporates: a second COLUMN costs
 * +2.3 ms and a second KEY only +1.1 (native +0.95). ⚠️ There are also isolated GC spikes (56.6, 41.9)
 * well past warmup, which is why the estimator is a MEDIAN of the kept window rather than a mean or a min.
 */
const REPS = Number(process.env.SCREEN_REPS ?? 13);
const WARMUP = Number(process.env.SCREEN_WARMUP ?? 6);

/*
 * ⚠️⚠️⚠️ **PER-PROCESS MODE, AND IT IS THE DEFAULT BECAUSE IN-PROCESS TIMING NOMINATED THREE PHANTOMS**
 * (items 2172 and 2173). Raising the rep count was not enough: these shapes drift MONOTONICALLY for
 * dozens of reps inside one process, so no window separates them.
 *
 * ```text
 *     in-process, 20 reps          sum(a.k) 9.71   coalesce 9.52   "the coalesce is free"
 *     its own series ended         6.8 6.7 6.6     <- still FALLING at rep 20
 *     one shape per PROCESS        sum(a.k) 6.33    coalesce 7.29   +0.96, reproducible to the hundredth
 * ```
 *
 * 🔑 On that reading I refuted a lever that then shipped at **1.48x** (item 2173). Each child measures ITS
 * OWN floor from its own process, which is stricter than sharing one across rows.
 *
 * ⚠️ `SCREEN_INPROC=1` keeps the old single-process sweep — it is ~10x faster and fine for a smoke check,
 * but a NOMINATION from it is not trustworthy. `SCREEN_ROW=<n>` is the child mode the driver spawns.
 */
const ROW_REPS = Number(process.env.SCREEN_ROW_REPS ?? 40);
const ROW_KEEP = Number(process.env.SCREEN_ROW_KEEP ?? 15);
const ONE_ROW = process.env.SCREEN_ROW;
/*
 * ⚠️⚠️ **TWO CHILDREN PER ROW, BECAUSE ONE ISOLATED RUN IS STILL ONE READING** — the rule the TS spelling
 * probe prints for itself (item 1073), and this screen needed it too. Per-process timing fixed the DRIFT
 * but not the run-to-run spread: `COALESCE`'s marginal read **+2.36 then +3.37** on consecutive sweeps, so
 * a flag threshold of 2 ms sat inside the noise band and the row flagged on one run and not the other.
 *
 * 🔑 The estimator is the **MIN across rounds** of each side, which is what [[bench-methodology]] settled
 * on: a slow round can only be contamination, so the fastest is the closest to the real cost.
 */
const ROUNDS = Number(process.env.SCREEN_ROUNDS ?? 2);
const IN_PROC = process.env.SCREEN_INPROC === '1';

/** The bench's own doc shape, so a number here is comparable with a bench row. */
const doc = (() => {
  const lines: string[] = [];

  for (let i = 0; i < N; i += 1) {
    lines.push(
      `{"type":"node","id":"v${i}","labels":${i % 3 === 0 ? '["Person","Admin"]' : '["Person"]'},"properties":{"age":${i % 90},"k":${i % 97},"name":"person${i}","tags":["a","b"]}}`,
    );
  }

  let id = 0;

  /*
   * ⚠️ The repeat index `d` is load-bearing: `to = (a*k + b) % N` is invariant under `k -> k + N`, so a
   * flat loop sends one vertex's whole fan-out to the SAME target (items 1516/1518).
   */
  for (let d = 0; d < FANOUT; d += 1) {
    for (let i = 0; i < N; i += 2) {
      lines.push(
        `{"type":"edge","id":"e${id++}","labels":["KNOWS"],"from":"v${i}","to":"v${(i * 7 + 3 + d * 104_729) % N}","properties":{"w":${i % 7}}}`,
      );
    }
  }

  return lines.join('\n');
})();

/** Each row: a name and the query. The REFERENCE is native's own time for the same query. */
const ROWS: ReadonlyArray<readonly [string, string]> = [
  /*
   * ⚠️⚠️⚠️ **THE FLOOR, AND WITHOUT IT THIS SCREEN NOMINATES PHANTOMS (item 2172).** Item 2167 measured TS
   * reading 200,000 properties in 4.29 ms against native's 0.09 — **48x** — so a RAW ratio on any row that
   * touches a property is mostly that one floor. Subtracting it reorders the whole table:
   *
   * ```text
   *     shape          raw    marginal ts/nat   real
   *     COALESCE       8.5x   +4.83 / +2.91     1.7x   <- near parity, was the TOP flag
   *     CASE           4.5x   +2.28 / +1.27     1.8x   <- near parity, also flagged
   *     ORDER BY 2 key 3.7x   +7.86 / +1.52     (and the 7.86 was itself warmup — see REPS)
   *     DISTINCT 2 col 1.7x  +11.61 / +5.48     2.1x
   * ```
   *
   * 🔑 The two loudest flags were artefacts of the scan, not gaps. The Gremlin screen
   * (`gremlin-floor-screen-2168.ts`) has flagged on the MARGINAL since it was written; this one did not,
   * and three items' worth of flags here were the floor talking.
   */
  /*
   * ⚠️ `AS c` IS LOAD-BEARING, as it is on every row here. An UNALIASED column is named `expr` by TS and
   * `col0` by native, so the screen's own answer-agreement check voids the row — the values match
   * (200000), only the key differs.
   */
  ['FLOOR count(a.k)', 'MATCH (a:Person) RETURN count(a.k) AS c'],
  // ── String predicates, none of which has a bench row ──────────────────────────────────────────
  ['CONTAINS', 'MATCH (a:Person) WHERE a.name CONTAINS "999" RETURN count(*) AS c'],
  ['STARTS WITH', 'MATCH (a:Person) WHERE a.name STARTS WITH "person1" RETURN count(*) AS c'],
  ['ENDS WITH', 'MATCH (a:Person) WHERE a.name ENDS WITH "99" RETURN count(*) AS c'],
  // ── Scalars and list handling ─────────────────────────────────────────────────────────────────
  ['size() of a list prop', 'MATCH (a:Person) RETURN sum(size(a.tags)) AS c'],
  ['COALESCE', 'MATCH (a:Person) RETURN sum(coalesce(a.k, 0)) AS c'],
  ['IN a literal list', 'MATCH (a:Person) WHERE a.k IN [1, 2, 3] RETURN count(*) AS c'],
  ['CASE expression', 'MATCH (a:Person) RETURN sum(CASE WHEN a.k > 50 THEN 1 ELSE 0 END) AS c'],
  // ── Aggregates beyond item 2157's sum/avg ─────────────────────────────────────────────────────
  ['stddev_pop over a scan', 'MATCH (a:Person) RETURN stddev_pop(a.k) AS c'],
  ['percentile_cont', 'MATCH (a:Person) RETURN percentile_cont(a.k, 0.5) AS c'],
  ['collect over a scan', 'MATCH (a:Person) RETURN size(collect(a.k)) AS c'],
  // ── Set quantifiers and existence ─────────────────────────────────────────────────────────────
  [
    'EXISTS subquery',
    'MATCH (a:Person) WHERE EXISTS { MATCH (a)-[:KNOWS]->(b) } RETURN count(*) AS c',
  ],
  [
    'NOT EXISTS subquery',
    'MATCH (a:Person) WHERE NOT EXISTS { MATCH (a)-[:KNOWS]->(b) } RETURN count(*) AS c',
  ],
  // ── Ordering and paging, whose only row is item 2148's deep SKIP ──────────────────────────────
  ['ORDER BY two keys', 'MATCH (a:Person) RETURN a.k AS k, a.age AS g ORDER BY k, g LIMIT 10'],
  ['ORDER BY DESC', 'MATCH (a:Person) RETURN a.k AS k ORDER BY k DESC LIMIT 10'],
  ['DISTINCT two columns', 'MATCH (a:Person) RETURN DISTINCT a.k AS k, a.age AS g'],
];

/*
 * ⚠️ The FFI backend takes the cdylib's ABSOLUTE PATH, as `bench.ts` does. 🔑 And that artifact needs
 * `--features capi`: a bare `cargo build --release` overwrites it with a copy that has no `lnk_*` symbols.
 */
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${process.platform === 'darwin' ? 'dylib' : 'so'}`,
  import.meta.url,
).pathname;

const ffi = createFfiEngineBackend(LIB);
const nativeGraph = graphFromNdjson(ffi, doc) as {
  query: (t: string) => unknown;
  free: () => void;
};
const tsGraph = tsDeserialize(doc, 'ndjson', new TsGraph());

/** Strip whitespace and key quoting, so a rendering difference is not read as a different answer. */
const normalize = (s: string): string => s.replaceAll(/[\s"']/gu, '').toLowerCase();

/** The row's trailing mark: a nomination, a voided comparison, or nothing. */
const verdict = (flag: boolean, agree: boolean): string => {
  if (flag) {
    return '  <-- FLAG';
  }

  return agree ? '' : '  <-- VOID: answers differ';
};

const median = (xs: number[]): number => {
  const k = [...xs].sort((a, b) => a - b);

  return k[Math.floor(k.length / 2)];
};

/*
 * ⚠️⚠️ **THE ANSWER IS CAPTURED, NOT JUST THE TIME, AND THAT IS NOT OPTIONAL.** A prior EXISTS measurement
 * in this repo was declared VOID because the two arms ran the subquery over DIFFERENT candidate counts —
 * 20,000 against 207 — so the ratio compared different work. 🔑 Its post-mortem records that the guard
 * there "catches EMPTY, not WRONG", because a `count(*)` query returns exactly one row whatever the count
 * is. **So a ratio on this screen is only reportable when both engines agree on the ANSWER.**
 */
let floor = { ts: 0, nat: 0 };

const time = (fn: () => unknown): { ms: number | null; note: string; answer: string } => {
  const series: number[] = [];
  let answer = '';

  try {
    for (let r = 0; r < REPS; r += 1) {
      const t0 = performance.now();
      const rows = fn();

      series.push(performance.now() - t0);
      answer = JSON.stringify(rows).slice(0, 40);
    }
  } catch (err) {
    return {
      ms: null,
      note: String((err as { code?: string }).code ?? err).slice(0, 18),
      answer: '',
    };
  }

  // ⚠️ Drop the first two reps: they are the JIT tiering up, not the steady state.
  return { ms: median(series.slice(WARMUP)), note: '', answer };
};

/** The per-process estimator: `ROW_REPS` reps, median of the last `ROW_KEEP`. */
const timeLong = (fn: () => unknown): { ms: number | null; note: string; answer: string } => {
  const series: number[] = [];
  let answer = '';

  try {
    for (let r = 0; r < ROW_REPS; r += 1) {
      const t0 = performance.now();
      const rows = fn();

      series.push(performance.now() - t0);
      answer = JSON.stringify(rows).slice(0, 40);
    }
  } catch (err) {
    return {
      ms: null,
      note: String((err as { code?: string }).code ?? err).slice(0, 18),
      answer: '',
    };
  }

  return { ms: median(series.slice(Math.max(0, series.length - ROW_KEEP))), note: '', answer };
};

/*
 * THE CHILD: measure the FLOOR and ONE row in this fresh process, print a parseable line, exit.
 *
 * 🔑 The floor is re-measured here rather than passed in, so the subtraction is between two readings from
 * the SAME process — the only pairing item 2173 found reproducible.
 */
if (ONE_ROW !== undefined) {
  const idx = Number(ONE_ROW);
  const row = ROWS[idx];

  if (row === undefined) {
    console.log(`ROW ${idx} ABSENT`);
    nativeGraph.free();
    process.exit(0);
  }

  const [[fname, fq]] = ROWS;
  const ft = timeLong(() => tsQuery(tsGraph, fq));
  const fn2 = timeLong(() => nativeGraph.query(fq));
  const [name, q] = row;
  const t = idx === 0 ? ft : timeLong(() => tsQuery(tsGraph, q));
  const n = idx === 0 ? fn2 : timeLong(() => nativeGraph.query(q));

  console.log(
    `ROWDATA\t${idx}\t${name}\t${t.ms ?? `E:${t.note}`}\t${n.ms ?? `E:${n.note}`}\t${ft.ms ?? 0}\t${fn2.ms ?? 0}\t${normalize(t.answer) === normalize(n.answer) ? 'AGREE' : 'DIFFER'}\t${fname}`,
  );
  nativeGraph.free();
  process.exit(0);
}

/*
 * THE DRIVER: one child per row. ⚠️ It spawns THIS file with `SCREEN_ROW` set, so the rows, the fixture
 * and the queries cannot drift between the two modes — there is one definition of each.
 */
if (!IN_PROC) {
  nativeGraph.free();
  console.log(
    `\n  ${N} nodes / fanout ${FANOUT}, ONE PROCESS PER ROW, ${ROUNDS} rounds, min of (median of the last ${ROW_KEEP} of ${ROW_REPS})\n`,
  );
  console.log(
    `  ${'shape'.padEnd(24)} ${'ts'.padStart(9)} ${'native'.padStart(9)} ${'ratio'.padStart(8)} ${'marginal ts/nat'.padStart(16)}`,
  );

  const self = new URL(import.meta.url).pathname;

  for (let i = 0; i < ROWS.length; i += 1) {
    const lines: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const out = Bun.spawnSync({
        cmd: ['bun', 'run', self],
        env: { ...process.env, SCREEN_ROW: String(i), SCREEN_INPROC: '' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const got = new TextDecoder()
        .decode(out.stdout)
        .split('\n')
        .find((l) => l.startsWith('ROWDATA'));

      if (got !== undefined) {
        lines.push(got);
      }
    }

    if (lines.length === 0) {
      console.log(`  ${ROWS[i][0].padEnd(24)} ${'CHILD FAILED'.padStart(9)}`);
      continue;
    }

    /*
     * 🔑 MIN across rounds, per field. ⚠️ An ERROR in any round keeps the error — a shape that errors does
     * not sometimes answer, so a numeric reading beside it would mean the parse differed, not that it got
     * faster.
     */
    const cells = lines.map((l) => l.split('\t'));
    const minOf = (col: number): string => {
      const raws = cells.map((c) => c[col]);
      const err = raws.find((r) => r.startsWith('E:'));

      return err ?? String(Math.min(...raws.map(Number)));
    };
    const [[, , name]] = cells;
    const tsRaw = minOf(3);
    const natRaw = minOf(4);
    const fTs = minOf(5);
    const fNat = minOf(6);
    const agree = cells.every((c) => c[7] === 'AGREE') ? 'AGREE' : 'DIFFER';
    const tsMs = tsRaw.startsWith('E:') ? null : Number(tsRaw);
    const natMs = natRaw.startsWith('E:') ? null : Number(natRaw);
    const isFloor = i === 0;
    const mTs = (tsMs ?? 0) - Number(fTs);
    const mNat = (natMs ?? 0) - Number(fNat);
    const marginal =
      isFloor || tsMs === null || natMs === null ? '' : `+${mTs.toFixed(2)} / +${mNat.toFixed(2)}`;
    const flag = agree === 'AGREE' && !isFloor && mTs > 2 && mNat > 0.05 && mTs / mNat > 3;

    console.log(
      `  ${name.padEnd(24)} ${(tsMs === null ? tsRaw.slice(2) : tsMs.toFixed(2)).padStart(9)} ${(natMs === null ? natRaw.slice(2) : natMs.toFixed(2)).padStart(9)} ${(tsMs !== null && natMs !== null && natMs > 0 ? `${(tsMs / natMs).toFixed(1)}x` : '--').padStart(8)} ${marginal.padStart(16)}${flag ? '  <-- FLAG' : ''}${agree === 'DIFFER' && tsMs !== null && natMs !== null ? '  <-- VOID: answers differ' : ''}`,
    );
  }

  console.log(
    `\n  ⚠️ ONE PROCESS PER ROW (items 2172/2173: in-process timing nominated three phantoms, and one\n` +
      `  refutation it produced was itself wrong — the lever shipped at 1.48x). SCREEN_INPROC=1 for the\n` +
      `  fast single-process sweep, which is a smoke check and NOT a basis for nominating a target.\n`,
  );
  process.exit(0);
}

console.log(`\n  ${N} nodes / fanout ${FANOUT}, median of reps ${WARMUP + 1}-${REPS}\n`);
console.log(
  `  ${'shape'.padEnd(24)} ${'ts'.padStart(9)} ${'native'.padStart(9)} ${'ratio'.padStart(8)} ${'marginal ts/nat'.padStart(16)}`,
);

for (const [name, q] of ROWS) {
  const t = time(() => tsQuery(tsGraph, q));
  const n = time(() => nativeGraph.query(q));
  const ratio = t.ms !== null && n.ms !== null && n.ms > 0 ? t.ms / n.ms : null;
  /*
   * ⚠️ A FLOOR ON BOTH SIDES. Two sub-millisecond readings divide into nonsense — item 2157's screen
   * reported 71233x against a `count(*)` counter rung — so a ratio is only printed as a FLAG when the TS
   * side is over 5 ms and native's is over 0.5.
   */
  /*
   * ⚠️ A DISAGREEMENT VOIDS THE ROW. The two engines render values differently in places, so this is a
   * loose comparison — but a count that differs is a count over different candidates, which is exactly
   * the failure that voided an earlier EXISTS measurement.
   */
  const agree = t.answer === '' || n.answer === '' || normalize(t.answer) === normalize(n.answer);

  if (name.startsWith('FLOOR') && t.ms !== null && n.ms !== null) {
    floor = { ts: t.ms, nat: n.ms };
  }

  /*
   * ⚠️⚠️ **THE FLAG IS ON THE MARGINAL RATIO, NOT THE RAW ONE** (item 2172, following the Gremlin screen).
   * A row is nominated only when the work ABOVE the property scan is over 3x native's and over 2 ms in
   * absolute terms — that is what a change can actually reach.
   */
  const mTs = (t.ms ?? 0) - floor.ts;
  const mNat = (n.ms ?? 0) - floor.nat;
  const marginal =
    name.startsWith('FLOOR') || t.ms === null || n.ms === null
      ? ''
      : `+${mTs.toFixed(2)} / +${mNat.toFixed(2)}`;
  const flag = agree && !name.startsWith('FLOOR') && mTs > 2 && mNat > 0.05 && mTs / mNat > 3;

  console.log(
    `  ${name.padEnd(24)} ${(t.ms === null ? t.note : t.ms.toFixed(2)).padStart(9)} ${(n.ms === null ? n.note : n.ms.toFixed(2)).padStart(9)} ${(ratio === null ? '--' : `${ratio.toFixed(1)}x`).padStart(8)} ${marginal.padStart(16)}${verdict(flag, agree)}`,
  );

  if (!agree) {
    console.log(`      ts: ${t.answer}\n      nv: ${n.answer}`);
  }
}

nativeGraph.free();
console.log(
  `\n  ⚠️ A FLAG IS ON THE MARGINAL over the property-scan FLOOR, never the raw ratio (item 2172: the\n` +
    `  two loudest raw flags were 1.7-1.8x once the scan was subtracted). Item 2160 is why native is the\n` +
    `  reference at all, and item 2167 is why the floor has to come out.\n`,
);
