/**
 * Do the two SURFACE LANGUAGES cost the same for the same question?
 *
 * `MATCH (n) WHERE n.k > 10 RETURN count(*)` and `g.V().has('k', gt(10)).count()` ask one question
 * of one engine. CLAUDE.md's central claim is that equivalent spellings must cost the same, and the
 * two existing probes check it WITHIN a language: `spelling-probe.ts` compares GQL spellings to GQL
 * spellings, and the native `spelling_probe` compares plans. Nothing compared the two TS surfaces —
 * which is how item 797's 2.24x went unnoticed until it turned up in `bench:gremlin` by accident.
 *
 * ONE SHAPE PER PROCESS, and that is the whole reason this file exists rather than three more
 * groups in `spelling-probe.ts`. Item 800 built those groups and reverted them: in a single process
 * the ~40 GQL groups run first, so a GQL member arrives with megamorphic dispatch sites while its
 * Gremlin twin is the first Gremlin query in the process and arrives clean. Measured, same binary:
 * every Gremlin member was stable across isolated and in-sweep runs (2.64 -> 2.54, 25.10 -> 21.81)
 * and every GQL member roughly DOUBLED (4.51 -> 8.84, 23.87 -> 54.67). The ratios a single-process
 * sweep prints for a cross-language pair are substantially its own run order.
 *
 * So the parent re-executes itself once per SPELLING — not once per pair — and each child times one
 * query in a process that has run no other. That is item 762's rule and `scalarfn-probe.ts`'s
 * design.
 *
 *   bun run probe:surface                # every pair
 *   bun run probe:surface filtered       # pairs whose name contains a substring
 *   SURFACE_N=1000000 bun run probe:surface
 *
 * Per spelling: 14 reps, the first three dropped as JIT warm-up, the MEDIAN of the plateau. Not the
 * min — item 762 found the TS general path plateaus high and emits a rare fast rep, so `min`
 * estimates two arms differently.
 *
 * THE ANSWERS ARE PRINTED AND COMPARED BY COUNT, not by shape: GQL returns `[{"c":N}]` where
 * Gremlin returns `[N]`, so a structural comparison would flag every pair forever. The engines'
 * agreement on VALUES is the conformance suites' job; this probe's job is the cost, and printing
 * the extracted number is what stops a pair silently measuring two different questions.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, count, gt, has, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.SURFACE_N ?? 200_000);
const REPS = Number(process.env.SURFACE_REPS ?? 14);
const DROP = 3;
const EDGES_PER = 3;
/** A pair whose slower side is under this many ms is not compared — see the verdict below. */
const FLOOR_MS = Number(process.env.SURFACE_FLOOR ?? 1);

/** One spelling: a label, the surface it belongs to, and how to run it. */
type Spelling = {
  readonly surface: 'gql' | 'grm';
  readonly text: string;
  readonly run: (g: Graph) => unknown;
};

const gql = (text: string): Spelling => ({
  surface: 'gql',
  text,
  run: (g) => query(g, text),
});

/** A pair of spellings that MUST be the same question, and the label the output groups them under. */
const PAIRS: readonly (readonly [string, Spelling, Spelling])[] = [
  [
    // Item 797's question, and the one that found the gap. UNLABELLED on both sides: a first
    // version of item 800's groups put `hasLabel('P')` on the Gremlin side and `:P` on the GQL
    // side, which is a DIFFERENT question — one extra per-vertex step on one surface — and its
    // reading could not be set beside 797's. The labelled pair below keeps the label as the
    // variable instead.
    'filtered node count, unlabelled',
    gql('MATCH (n) WHERE n.k > 10 RETURN count(*) AS c'),
    {
      surface: 'grm',
      text: "g.V().has('k', gt(10)).count()",
      run: (g) => toArray(traversal(V(), has('k', gt(10)), count()), g),
    },
  ],
  [
    'filtered node count, labelled',
    gql('MATCH (n:P) WHERE n.k > 10 RETURN count(*) AS c'),
    {
      surface: 'grm',
      text: "g.V().hasLabel('P').has('k', gt(10)).count()",
      run: (g) => toArray(traversal(V(), hasLabel('P'), has('k', gt(10)), count()), g),
    },
  ],
  [
    // NOT A BOUNDING PAIR, and item 929 measured why rather than reading its name. An unfiltered
    // edge count is answered O(1) from a size on BOTH surfaces: at 200,000 vertices / 600,000 edges
    // it reads 0.00 against 0.01 ms, and at 800,000 / 2,400,000 — four times the graph — it reads
    // 0.00 against 0.01 again. It never walks an edge, so it is a SECOND O(1) control beside
    // `CONTROL unfiltered count`, and the `too fast to compare (raise SURFACE_N)` verdict it earns
    // gives advice that cannot work: no N makes a constant-time answer take a millisecond.
    //
    // It was carrying the claim "it is the node-scan filter shape or it is nothing" (item 800's
    // one-hop group showing no gap), and that claim was resting on a pair that measures nothing.
    // `one-hop count, FILTERED` below is the pair that actually bounds it.
    'CONTROL one-hop count (O(1) both surfaces)',
    gql('MATCH (a:P)-[:E]->(b) RETURN count(*) AS c'),
    {
      surface: 'grm',
      text: "g.V().hasLabel('P').out('E').count()",
      run: (g) => toArray(traversal(V(), hasLabel('P'), out('E'), count()), g),
    },
  ],
  [
    // THE REAL BOUNDING PAIR (item 929). A predicate on the FAR end cannot be answered from a
    // size, so this one walks all 600,000 edges on both surfaces. It is what decides whether the
    // filtered-count gap above is specific to the NODE-SCAN filter shape or is a general property
    // of GQL's filter path — the question the O(1) pair above was wrongly credited with answering.
    'one-hop count, FILTERED',
    gql('MATCH (a:P)-[:E]->(b) WHERE b.k > 10 RETURN count(*) AS c'),
    {
      surface: 'grm',
      text: "g.V().hasLabel('P').out('E').has('k', gt(10)).count()",
      run: (g) => toArray(traversal(V(), hasLabel('P'), out('E'), has('k', gt(10)), count()), g),
    },
  ],
  [
    // A PROJECTION rather than an aggregate, so the row-building path is compared too — a count
    // returns one value and can hide a per-row difference entirely.
    'project one property',
    gql('MATCH (n:P) RETURN n.k AS k'),
    {
      surface: 'grm',
      text: "g.V().hasLabel('P').values('k')",
      run: (g) => toArray(traversal(V(), hasLabel('P'), values('k')), g),
    },
  ],
  [
    // CONTROL: an unfiltered count, which both surfaces answer from a bucket size. A pair that
    // is O(1) on both sides cannot show a scan difference, so it is here to prove the harness
    // reports parity when parity is the truth.
    'CONTROL unfiltered count',
    gql('MATCH (n) RETURN count(*) AS c'),
    {
      surface: 'grm',
      text: 'g.V().count()',
      run: (g) => toArray(traversal(V(), count()), g),
    },
  ],
];

const build = (): Graph => {
  const g = new Graph();
  const made: ReturnType<Graph['addVertex']>[] = [];

  for (let i = 0; i < N; i += 1) {
    made.push(
      g.addVertex({
        id: `v${i}`,
        labels: i % 3 === 0 ? ['P', 'Q'] : ['P'],
        properties: { k: i % 50, s: `s${i % 7}` },
      }),
    );
  }

  // BOTH ENDPOINTS SCATTERED by different multipliers — `spelling-probe.ts` records why: with
  // `from` in creation order and `to` permuted, one adjacency map is walked sequentially and the
  // other jumped around, which made every from-driven spelling look ~2x faster than its twin
  // (items 164, 286, 287). A cross-surface probe would read that as a surface difference.
  for (let e = 0; e < N * EDGES_PER; e += 1) {
    g.addEdge({
      labels: ['E'],
      from: made[(e * 104729) % N],
      to: made[(e * 15485863) % N],
    });
  }

  return g;
};

/** The number a spelling answered, however its surface wraps it. */
const answerOf = (rows: unknown): string => {
  if (!Array.isArray(rows)) {
    return JSON.stringify(rows);
  }

  // THE ROW COUNT FIRST. A first version read the single value out of the FIRST row whatever the
  // length, so a 200,000-row projection reported `0` — the first row's `k` — against Gremlin's
  // `200000 rows`, and the pair flagged ANSWERS DIFFER on a difference that was mine. A summary
  // that can disagree with itself is worse than none.
  if (rows.length !== 1) {
    return `${rows.length} rows`;
  }

  const [first] = rows as unknown[];

  if (typeof first === 'object' && first !== null) {
    const vals = Object.values(first as Record<string, unknown>);

    return vals.length === 1 ? String(vals[0]) : '1 row';
  }

  return String(first);
};

const timeOne = (s: Spelling): void => {
  const g = build();
  const series: number[] = [];
  let answer = '';

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = s.run(g);

    series.push(performance.now() - t0);
    answer = answerOf(rows);
  }

  const plateau = series.slice(DROP).sort((x, y) => x - y);
  const median = plateau[Math.floor(plateau.length / 2)] ?? 0;

  console.log(`${s.surface}\t${median.toFixed(2)}\t${answer}\t${s.text}`);
};

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const selected = PAIRS.filter(([name]) => only.length === 0 || only.some((o) => name.includes(o)));

if (process.env.SURFACE_ONE !== undefined) {
  // The CHILD: one spelling, this process, nothing else measured in it.
  const [pairIndex, which] = process.env.SURFACE_ONE.split(':');
  const pair = PAIRS[Number(pairIndex)];

  if (pair === undefined) {
    console.error(`unknown pair ${pairIndex}`);
    process.exit(2);
  }

  timeOne(which === 'gql' ? pair[1] : pair[2]);
} else {
  console.log(
    `\n=== TS surface comparison, ${N} vertices / ${N * EDGES_PER} edges, median of ${REPS - DROP} ===`,
  );
  console.log('(one spelling per PROCESS — see the header for why)\n');

  for (const pair of selected) {
    const index = PAIRS.indexOf(pair);
    // `timings`, not `out` — `out` is the imported Gremlin STEP, and shadowing it here would
    // read as a traversal call three lines later.
    const timings: Record<string, { ms: number; answer: string; text: string }> = {};

    // The ORDER the two arms run in, flippable so rounds can be ALTERNATED. Item 928 ran this
    // probe three times and its two filtered-count pairs disagreed by up to 1.75x, with the
    // GREMLIN arm alone moving 1.48x between runs; no cause was established. Alternating the arms
    // is what removes "the machine drifted in the ~2s between arm A and arm B" as a candidate,
    // which a fixed order cannot. Default is unchanged, so an unset environment reads as before.
    const order = (process.env.SURFACE_ORDER ?? 'gql,grm').split(',');

    // VALIDATED, not trusted: a typo'd `SURFACE_ORDER` would leave `timings.gql` undefined, and the
    // pair-level `continue` below would then skip the pair in silence — a run that measures nothing
    // and prints a clean report. Three checks in this session returned a reassuring answer instead
    // of failing (a `noclobber` append that wrote nothing, a comparator that compared zero rows, a
    // zsh split that ran one iteration), so this one fails loudly.
    if (order.length !== 2 || !order.includes('gql') || !order.includes('grm')) {
      console.error(`SURFACE_ORDER must be a permutation of gql,grm — got ${order.join(',')}`);
      process.exit(2);
    }

    for (const which of order) {
      const r = Bun.spawnSync({
        cmd: [process.argv[0] ?? 'bun', import.meta.path],
        env: { ...process.env, SURFACE_ONE: `${index}:${which}` },
        stdout: 'pipe',
        stderr: 'inherit',
      });

      const [surface, ms, answer, text] = new TextDecoder().decode(r.stdout).trim().split('\t');

      if (!r.success || surface === undefined) {
        console.log(`  ${pair[0]}  ${which} FAILED (exit ${r.exitCode})`);
        continue;
      }

      timings[surface] = { ms: Number(ms), answer: answer ?? '', text: text ?? '' };
    }

    const a = timings.gql;
    const b = timings.grm;

    if (a === undefined || b === undefined) {
      continue;
    }

    const ratio = a.ms / Math.max(b.ms, 0.001);
    // A FLOOR, for item 124's reason: a ratio between two sub-millisecond timings is the clock's
    // resolution, not a measurement. Both surfaces answer an unfiltered or shortcut-eligible count
    // from a bucket size, so those pairs read 0.00 against 0.01 — and a first version printed
    // "Infinityx faster" for them, which is the meaningless ratio `spelling-probe.ts` keeps
    // `FLOOR_MS` to suppress.
    const tooFast = Math.max(a.ms, b.ms) < FLOOR_MS;
    let verdict: string;

    if (tooFast) {
      verdict = `too fast to compare (both under ${FLOOR_MS}ms — raise SURFACE_N)`;
    } else if (ratio >= 1) {
      verdict = `GQL ${ratio.toFixed(2)}x slower`;
    } else {
      verdict = `GQL ${(1 / ratio).toFixed(2)}x faster`;
    }

    const agree = a.answer === b.answer ? '' : `  ⚠️ ANSWERS ${a.answer} vs ${b.answer}`;

    console.log(`  ${pair[0]}${agree}`);
    console.log(
      `    gql  ${a.ms.toFixed(2).padStart(8)}ms  answer=${a.answer.padEnd(8)} ${a.text}`,
    );
    console.log(
      `    grm  ${b.ms.toFixed(2).padStart(8)}ms  answer=${b.answer.padEnd(8)} ${b.text}`,
    );
    console.log(`    -> ${verdict}\n`);
  }
}
