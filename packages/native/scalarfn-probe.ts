/**
 * What does ONE scalar function call cost per row in the PURE-TS engine, and is its name
 * specialized?
 *
 * `compileFunc` is a chain of specialization factories resolved once per `Expr::Call` —
 * `unaryNumCall`, `binaryNumCall`, `unaryStrCall`, `binaryStrCall`, `roundCall`, `nullifCall`
 * (items 760, 761, 769, 788) — and any name none of them claims falls to `bufferedScalarCall`,
 * which walks the whole dispatch chain and the `switch` per row. So "is this name specialized?" has
 * a measurable answer, and the answer is a per-row cost that separates into bands.
 *
 * This is the TS twin of `crates/lenke-engine/examples/scalarfn_bench` (item 783), and it exists
 * for the same reason: items 760, 761, 763, 769, 773 and 788 each rebuilt an ad-hoc harness to ask
 * this, six times for one question. The committed form also makes the next addition cheap — add the
 * name here, and the band it lands in says whether a factory claimed it.
 *
 * ONE SHAPE PER PROCESS, which matters more here than natively. Item 762 found that a multi-shape
 * in-process comparison flatters any change that REDISTRIBUTES call sites: in one process every
 * shape funnels through the same dispatch site, so the site is megamorphic and its inline caches
 * are useless, while a specialized closure measured alone keeps its own. The parent re-executes
 * itself once per shape rather than looping, so no shape pollutes another's dispatch.
 *
 *   bun run probe:scalar                 # every shape, each in its own process
 *   bun run probe:scalar upper char      # only shapes whose name contains a given substring
 *   SCALAR_N=1000000 bun run probe:scalar
 *
 * Per shape: 14 reps, the first three dropped as JIT warm-up, the MEDIAN of the plateau. NOT the
 * min — item 762 found the general scalar path plateaus high and emits a rare fast rep, so `min`
 * estimates the two bands differently and can hide a win.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.SCALAR_N ?? 200_000);
const REPS = Number(process.env.SCALAR_REPS ?? 14);
const DROP = 3;

/**
 * Every case is `count(f(…))` over the same rows, so the row count and the aggregate are identical
 * and the only difference is the expression.
 *
 * The fixture mixes ASCII and non-ASCII strings on purpose, as the native twin does: a length or
 * slice function behaves differently on each, so an all-ASCII fixture prices them as different
 * functions than they are.
 */
const SHAPES: readonly (readonly [string, string])[] = [
  // --- the floors, which every other row is read against -------------------------------------
  ['FLOOR no call', 'count(a.n)'],
  ['FLOOR string arg', 'count(a.s)'],
  // --- one-argument numeric: specialized by item 760 -----------------------------------------
  ['abs', 'count(abs(a.n))'],
  ['floor', 'count(floor(a.n))'],
  ['sqrt', 'count(sqrt(a.n))'],
  ['sign', 'count(sign(a.n))'],
  // --- two-argument numeric: specialized by 760, plus 788's two additions --------------------
  ['power', 'count(power(a.n, 2))'],
  ['mod', 'count(mod(a.n, 7))'],
  ['atan2', 'count(atan2(a.n, 2))'],
  ['round/1 (788)', 'count(round(a.n))'],
  ['round/2 (788)', 'count(round(a.n, 2))'],
  ['nullif (788)', 'count(nullif(a.n, 7.5))'],
  // --- one-argument string: specialized by item 761 ------------------------------------------
  ['upper', 'count(upper(a.s))'],
  ['char_length', 'count(char_length(a.s))'],
  ['byte_length', 'count(byte_length(a.s))'],
  // --- two-argument string: specialized by items 769/773 -------------------------------------
  ['contains', "count(contains(a.s, 'pad'))"],
  ['starts_with', "count(starts_with(a.s, 'pad'))"],
  ['split', "count(split(a.s, '-'))"],
  // --- NOT specialized by any factory: the band this probe exists to expose ------------------
  ['trim', 'count(trim(a.s))'],
  ['ltrim', 'count(ltrim(a.s))'],
  ['rtrim', 'count(rtrim(a.s))'],
  ['btrim', 'count(btrim(a.s))'],
  // The TWO-argument trim form, which keeps `callTrim` and the general path — the control for
  // item 790's arity test.
  ['btrim/2', "count(btrim(a.s, ' '))"],
  ['reverse', 'count(reverse(a.s))'],
  ['to_string', 'count(to_string(a.n))'],
  ['left', 'count(left(a.s, 3))'],
  ['right', 'count(right(a.s, 3))'],
  ['substring/2', 'count(substring(a.s, 1))'],
  ['substring/3', 'count(substring(a.s, 1, 3))'],
  ['replace', "count(replace(a.s, 'pad', 'X'))"],
  ['size', 'count(size(a.s))'],
  ['coalesce', 'count(coalesce(a.n, 7))'],
];

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    // A LEADING AND TRAILING SPACE on a third of the strings so the trim family has something to
    // strip, and a non-ASCII run on another third — a length or slice function behaves differently
    // on each, so an all-ASCII fixture prices them as different functions than they are.
    const bucket = i % 21;
    let s = `plain${i % 97}`;

    if (bucket <= 6) {
      s = `  pad${i % 97}  `;
    } else if (bucket <= 13) {
      s = `naïve-${i % 97}-ßé`;
    }

    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: (i % 1009) + 0.5, s } });
  }

  return g;
};

const runOne = (name: string, expr: string): void => {
  const g = build();
  const q = `MATCH (a:P) RETURN ${expr} AS c`;
  const series: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    try {
      query(g, q);
    } catch (e) {
      console.log(`  ${name.padEnd(16)}    SKIP  ${(e as Error).message.slice(0, 48)}`);

      return;
    }

    series.push(performance.now() - t0);
  }

  const plateau = series.slice(DROP).sort((x, y) => x - y);
  const median = plateau[Math.floor(plateau.length / 2)] ?? 0;

  console.log(
    `  ${name.padEnd(16)} ${median.toFixed(2).padStart(8)}ms  ${((median * 1e6) / N).toFixed(1).padStart(6)} ns/row`,
  );
};

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const selected = SHAPES.filter(([name]) => only.length === 0 || only.some((o) => name.includes(o)));

if (process.env.SCALAR_ONE !== undefined) {
  // The CHILD: one shape, this process, nothing else measured in it.
  const found = SHAPES.find(([name]) => name === process.env.SCALAR_ONE);

  if (found === undefined) {
    console.error(`unknown shape ${process.env.SCALAR_ONE}`);
    process.exit(2);
  }

  runOne(found[0], found[1]);
} else {
  console.log(`\n=== TS scalar function cost, ${N} rows, median of ${REPS - DROP} ===`);

  for (const [name] of selected) {
    // Re-exec rather than loop — see the header. `Bun.spawnSync` inherits stdout, so the child's
    // one line lands here in order.
    const r = Bun.spawnSync({
      cmd: [process.argv[0] ?? 'bun', import.meta.path],
      env: { ...process.env, SCALAR_ONE: name },
      stdout: 'inherit',
      stderr: 'inherit',
    });

    if (!r.success) {
      console.log(`  ${name.padEnd(16)}    FAILED (exit ${r.exitCode})`);
    }
  }
}
