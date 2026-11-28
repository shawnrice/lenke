import { run } from './src/executor.ts';
import { createTestTinkerGraph } from './src/fixtures/createTestTinkerGraph.ts';
import { V, has, math, project, values } from './src/index.ts';
import { traversal } from './src/traversal.ts';

/*
 * Item 2499: the `math()` and `project()` families, which had ZERO probe coverage and — for
 * `math()` — not a single mention in `CLOSED.md`. Both steps are exported; nobody had asked what
 * they do at the edges.
 *
 * ORACLE: TinkerPop 3.7.3, captured via
 * `podman run -i --rm docker.io/tinkerpop/gremlin-console:3.7.3`. The expectations below are its
 * literal output, not my reading of the docs.
 *
 * THREE FINDINGS, none of which had a pin anywhere in the repo (`cbrt`, `project FEWER` and
 * `by() list` return zero files; the `log2` hits are all complexity notation in perf docs):
 *
 *   1. **`log` is a NAMING divergence, not a missing function — and I claimed otherwise twice
 *      before checking the adjacent spelling.** Both lenke engines implement natural log as `ln`
 *      (`ln(e)` is 1, and `gremlin.rs`'s `is_unary_math_fn` lists `ln`); TinkerPop spells it `log`.
 *      The two engines AGREE with each other, so this is a TinkerPop conformance gap of the same
 *      class as item 2488's `startsWith` vs `startingWith`, NOT a cross-engine divergence.
 *      **`cbrt` and `log2` are the genuinely absent ones** — neither engine has them.
 *   2. **`math()` on a STRING returns NaN where TinkerPop raises** `IllegalStateException`.
 *   3. **`project()` with FEWER `by()`s than keys fills `{}` where TinkerPop CYCLES the `by()`
 *      list** — TinkerPop answers `[n:marko, a:marko]`, lenke `{n:marko, a:{}}`.
 *
 * Compared as a MULTISET with per-level sorting, and the ROW COUNT is reported because several rows
 * (H21 empty input, H26 cycling) are cardinality questions.
 */
const g = createTestTinkerGraph();

const one = (v: unknown): string => {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    if (v instanceof Map) {
      return `{${[...v.entries()]
        .map(([k, val]) => `${String(k)}:${one(val)}`)
        .sort()
        .join(',')}}`;
    }

    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}:${one(val)}`)
      .sort()
      .join(',')}}`;
  }

  if (Array.isArray(v)) {
    return `[${v.map(one).sort().join(',')}]`;
  }

  return String(v);
};

const canon = (rowsOut: readonly unknown[]): string =>
  `${rowsOut.length}:${rowsOut.map(one).sort().join(',')}`;

/* TinkerPop's own output, transcribed. `THROWS` means it raised; the class name is in the comment. */
const rows: Array<[string, () => unknown, string]> = [
  ['H01 _ + 1', () => traversal(V(), has('age'), values('age'), math('_ + 1')), '4:28,30,33,36'],
  ['H02 _ * 2', () => traversal(V(), has('age'), values('age'), math('_ * 2')), '4:54,58,64,70'],
  [
    'H03 _ / 2',
    () => traversal(V(), has('age'), values('age'), math('_ / 2')),
    '4:13.5,14.5,16,17.5',
  ],
  // ArithmeticException in TinkerPop — division by zero is an ERROR, not an infinity.
  ['H05 DIV BY ZERO', () => traversal(V(), has('age'), values('age'), math('_ / 0')), 'THROWS'],
  ['H06 ZERO DIV ZERO', () => traversal(V(), has('age'), values('age'), math('0 / 0')), 'THROWS'],
  ['H07 modulo', () => traversal(V(), has('age'), values('age'), math('_ % 10')), '4:2,5,7,9'],
  [
    'H08 power ^',
    () => traversal(V(), has('age'), values('age'), math('_ ^ 2')),
    '4:1024,1225,729,841',
  ],
  [
    'H09 precedence',
    () => traversal(V(), has('age'), values('age'), math('1 + _ * 2')),
    '4:55,59,65,71',
  ],
  [
    'H10 parens',
    () => traversal(V(), has('age'), values('age'), math('(1 + _) * 2')),
    '4:56,60,66,72',
  ],
  [
    'H11 unary minus',
    () => traversal(V(), has('age'), values('age'), math('-_')),
    '4:-27,-29,-32,-35',
  ],
  ['H12 abs', () => traversal(V(), has('age'), values('age'), math('abs(-_)')), '4:27,29,32,35'],
  [
    'H13 constant only',
    () => traversal(V(), has('age'), values('age'), math('1 + 1')),
    '4:2,2,2,2',
  ],
  // IllegalStateException in TinkerPop — an unbound name is an error, not a null.
  ['H16 MISSING var', () => traversal(V(), has('age'), values('age'), math('zzz + 1')), 'THROWS'],
  [
    'H17 sqrt',
    () => traversal(V(), has('age'), values('age'), math('sqrt(_)')),
    '4:5.196152422706632,5.385164807134504,5.656854249492381,5.916079783099616',
  ],
  /*
   * I PRE-LABELLED BOTH OF THESE AS POLICY DIVERGENCES AND WAS WRONG ON BOTH. The assumption was
   * that `numeric-model-f64` (NaN and the infinities map to null) would stop lenke returning
   * TinkerPop's `-Infinity` and `NaN`. That rule governs values on the way IN, not values COMPUTED
   * by an expression:
   *
   *   - `sqrt(-1)` returns `NaN` in lenke exactly as in TinkerPop. It AGREES — and labelling it a
   *     policy divergence would have buried a passing row as an excused one.
   *   - `log(0)` never reaches the numeric question: lenke throws "unknown function 'log'".
   *     `log` IS NOT IMPLEMENTED, which is a plain gap and nothing to do with the numeric model.
   *
   * Measure first, classify after: a row pre-labelled "expected divergence" is a row whose result
   * nobody reads.
   */
  /*
   * AND A THIRD MISTAKE ON THIS SAME ROW: I first set its expectation to `THROWS`, which made
   * lenke's "unknown function" error read as AGREEMENT. **TinkerPop does not throw here — it
   * returns `-Infinity` as a value.** The expectation is therefore TinkerPop's actual output, and
   * the row is a DIFFER whose cause is the missing function. An expectation written to match what
   * the engine happens to do is not an oracle.
   */
  [
    'H18 log(0) MISSING fn',
    () => traversal(V(), has('age'), values('age'), math('log(0)')),
    '4:-Infinity,-Infinity,-Infinity,-Infinity',
  ],
  /*
   * THE SPELLING EACH SIDE HAS, VERIFIED IN BOTH DIRECTIONS rather than asserted. I first wrote
   * this row's expectation as lenke's own output while claiming "TinkerPop has no `ln`" from
   * memory; the console settles it:
   *
   *     TinkerPop 3.7.3        ln(1)  IllegalStateException   log(1)  0.0
   *     lenke (both engines)   ln(1)  0                       log(1)  unknown function
   *
   * So each side REJECTS the other's spelling of natural log — a mutual naming divergence, not a
   * one-sided gap. `cbrt(8)` is 2.0 and `log2(8)` is 3.0 in TinkerPop and unknown in lenke, so
   * those two are the genuine absences.
   */
  [
    'H18b ln(1) lenke-only',
    () => traversal(V(), has('age'), values('age'), math('ln(1)')),
    'THROWS',
  ],
  [
    'H18c cbrt(8) absent',
    () => traversal(V(), has('age'), values('age'), math('cbrt(8)')),
    '4:2,2,2,2',
  ],
  [
    'H18d log2(8) absent',
    () => traversal(V(), has('age'), values('age'), math('log2(8)')),
    '4:3,3,3,3',
  ],
  [
    'H19 sqrt(-1)',
    () => traversal(V(), has('age'), values('age'), math('sqrt(-1)')),
    '4:NaN,NaN,NaN,NaN',
  ],
  // IllegalStateException in TinkerPop — math on a non-number is an error.
  ['H20 on a STRING', () => traversal(V(), has('name'), values('name'), math('_ + 1')), 'THROWS'],
  [
    'H21 EMPTY input',
    () => traversal(V(), has('nosuchkey'), values('nosuchkey'), math('_ + 1')),
    '0:',
  ],
  [
    'H23 project 2 by',
    () => traversal(V(), has('age'), project('n', 'a').by('name').by('age')),
    '4:{a:27,n:vadas},{a:29,n:marko},{a:32,n:josh},{a:35,n:peter}',
  ],
  [
    'H24 project 1 by',
    () => traversal(V(), has('age'), project('n').by('name')),
    '4:{n:josh},{n:marko},{n:peter},{n:vadas}',
  ],
  // TinkerPop CYCLES the by() list when there are fewer by()s than keys: [n:marko, a:marko].
  [
    'H26 project FEWER by',
    () => traversal(V(), has('age'), project('n', 'a').by('name')),
    '4:{a:josh,n:josh},{a:marko,n:marko},{a:peter,n:peter},{a:vadas,n:vadas}',
  ],
];

let agreed = 0;
let disagreed = 0;
let policy = 0;

for (const [label, build, tp] of rows) {
  let got: string;

  try {
    got = canon([...run(build() as never, g)]);
  } catch (e) {
    got = `THROWS: ${String((e as Error)?.message ?? e).slice(0, 34)}`;
  }

  const threw = got.startsWith('THROWS');
  let verdict: string;

  if (tp === 'POLICY') {
    verdict = 'policy';
    policy += 1;
  } else if (tp === 'THROWS') {
    verdict = threw ? 'agree' : 'DIFFER';
  } else {
    verdict = got === tp ? 'agree' : 'DIFFER';
  }

  if (verdict === 'agree') {
    agreed += 1;
  } else if (verdict === 'DIFFER') {
    disagreed += 1;
  }

  console.log(
    `  ${label.padEnd(23)} ${verdict.padEnd(6)} lenke=${got.slice(0, 46).padEnd(48)} TP=${tp.slice(0, 40)}`,
  );
}

console.log(
  `\n  ${agreed} agree, ${disagreed} DIFFER, ${policy} policy-divergence, of ${rows.length} rows`,
);
console.log('  Oracle: TinkerPop 3.7.3 console, output transcribed verbatim.');
