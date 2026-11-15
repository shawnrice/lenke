/**
 * WHAT DOES THE GQL SCREEN NOT ASK? (item 1901)
 *
 * ⚠️⚠️ **THIS IS ITEM 1898'S SWEEP, ON THE OTHER SURFACE.** That item added nine families the Gremlin
 * screen had never carried and found that **all five of the biggest shapes on the surface were among
 * them**. The GQL side never had the same sweep: item 1890 applied the SIZE lesson to the GQL grid,
 * and items 1879/1880 split the existing families until "the addressable time is exhausted" — a
 * conclusion that is only ever true of the shapes a screen HAS.
 *
 * ⚠️ EVERY SHAPE HERE WAS VERIFIED TO PARSE AND MATCH ROWS FIRST, by
 * `gql-coverage-probe-1901.mjs`. ISO-GQL is NOT Cypher and a candidate row is worthless two ways —
 * it may not parse, and it may parse and match nothing, which `workload-perf-screen.mjs` warns is a
 * BROKEN screen row rather than a fast family.
 *
 * ⚠️ ONE CHILD PROCESS PER SHAPE, which is `workload-perf-screen.mjs`'s discipline and not
 * decoration: item 1871 retracted a flag measured in a shared process, and item 737 refuted a 1.66x
 * that only existed in-sweep.
 *
 * ⚠️ THE CONTROLS ARE THE POINT OF COMPARISON, NOT THE FASTEST ROW. Three shapes from the EXISTING
 * corpus are carried here deliberately: the one-hop projection (item 1895's target, the most common
 * shape in the language), the deduped hop (item 1899's GQL fast side), and the `{2,3}` var-length
 * bound, which items 1879/1880 established as a documented CORRECTNESS refusal rather than a gap. A
 * new shape above the first two is a nomination; one merely above the third is not.
 *
 *     bun gql-coverage-screen-1901.mjs                  # the whole screen
 *     NODES=200000 bun gql-coverage-screen-1901.mjs
 *     SHAPE='top-k grouped' bun gql-coverage-screen-1901.mjs   # one shape, this process
 */
import { spawnSync } from 'node:child_process';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 7);
const SHAPE = process.env.SHAPE ?? '';

const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const X_POOL = [-1, 0, 2, 3, 4, 5];
const S_POOL = ['a', 'z', 'm', '', 'nope'];
const DATES = ['1999-12-31', '2024-01-02', '2024-01-03', '2031-11-30'];

/**
 * `[label, text, params]`. A `CONTROL` prefix marks a shape the corpus already carries.
 *
 * @type {[string, string, Record<string, unknown>][]}
 */
const SHAPES = [
  // --- the controls, from the families the screen already has ---
  ['CONTROL one-hop projection', 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x', {}],
  ['CONTROL deduped hop', 'MATCH (a:T)-[:E]->(b:T) RETURN DISTINCT b.n AS x', {}],
  ['CONTROL varlen {2,3} rows', 'MATCH (a:T)-[:E]->{2,3}(b:T) RETURN DISTINCT b.n AS x', {}],

  // ⚠️ THE FLOORS THE FIRST RUN LACKED. Item 1878's lesson, cited by 1879: a big absolute is not a
  // nomination until its own floor says what the shape costs WITHOUT the feature under suspicion.
  // `ORDER BY n.n + 1` and `ORDER BY x` sort identically here (adding 1 is monotone), so the pair is
  // an ordering-equivalent spelling and its gap is a real question rather than a comparison of
  // different answers.
  ['CONTROL order by bound name', 'MATCH (n:T) RETURN n.n AS x ORDER BY x', {}],
  ['CONTROL no order at all', 'MATCH (n:T) RETURN n.n AS x', {}],
  [
    'CONTROL grouped count, no top-k',
    'MATCH (a:T)-[:E]->(b:T) LET g = b.n RETURN g, count(*) AS c GROUP BY g',
    {},
  ],
  ['CONTROL varlen {1,3} rows', 'MATCH (a:T)-[:E]->{1,3}(b:T) RETURN DISTINCT b.n AS x', {}],
  // The UNSEEDED count takes `varLengthCount`; both SEEDED spellings reach no rung at all, so the
  // count shape is a MISSING RUNG rather than a spelling gap. Priced for the next item.
  ['CONTROL varlen count unseeded', 'MATCH (a:T)-[:E]->{1,3}(b:T) RETURN count(*) AS c', {}],
  // ⚠️⚠️ THE CLAUSE-`WHERE` vs INLINE SPELLING OF ONE SEEDED VAR-LENGTH QUERY (item 1906). The
  // inline form reaches `reachShortcut`; the clause form reaches NO rung. Same answer, same 8 rows,
  // and the clause form is SLOWER THAN NOT SEEDING AT ALL — which is `audit item 159`'s "a filter
  // that makes a query slower is a declined fast path, not the cost of filtering".
  [
    'VL seeded, clause WHERE',
    'MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p0 RETURN DISTINCT b.n AS x',
    { p0: 3 },
  ],
  [
    'VL seeded, INLINE',
    'MATCH (a:T {n: $p0})-[:E]->{1,3}(b:T) RETURN DISTINCT b.n AS x',
    { p0: 3 },
  ],
  [
    'VL seeded count, clause WHERE',
    'MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p0 RETURN count(*) AS c',
    { p0: 3 },
  ],
  [
    'VL seeded count, inline WHERE',
    'MATCH (a:T WHERE a.n = $p0)-[:E]->{1,3}(b:T) RETURN count(*) AS c',
    { p0: 3 },
  ],
  [
    'VL seeded count, INLINE',
    'MATCH (a:T {n: $p0})-[:E]->{1,3}(b:T) RETURN count(*) AS c',
    { p0: 3 },
  ],
  [
    'CONTROL seeded {1,3} rows',
    'MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p0 RETURN DISTINCT b.n AS x',
    { p0: 3 },
  ],

  // --- ordering by something other than a bound name ---
  ['order by EXPRESSION', 'MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1', {}],
  // The NODE twin of the skip-only refusal item 1905 took.
  ['NODE expr key, OFFSET no LIMIT', 'MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1 OFFSET 3', {}],
  ['NODE alias key, OFFSET no LIMIT', 'MATCH (n:T) RETURN n.n AS x ORDER BY x OFFSET 3', {}],
  // ⚠️⚠️ THE INVERSION ITEM 1901 FOUND: adding a WINDOW makes the expression key ACCEPTABLE. The
  // route census says `ORDER BY n.k + 1` reaches NO rung while `ORDER BY n.k + 1 LIMIT 3` reaches
  // `nodeProjection` — so the engine ALREADY evaluates an arbitrary expression sort key, and it is
  // the unwindowed form that refuses. That is backwards from the documented hazard, which is about
  // faulting on rows a window discards.
  ['order by expr + LIMIT', 'MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1 LIMIT 3', {}],
  ['order by alias + LIMIT', 'MATCH (n:T) RETURN n.n AS x ORDER BY x LIMIT 3', {}],
  ['HOP order by alias', 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY x', {}],
  ['HOP order by EXPRESSION', 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY b.n + 1', {}],
  // ⚠️ THE ONE SORT REFUSAL ITEM 1904'S MATRIX LEAVES STANDING (43 of its 320 shapes): a `SKIP`
  // with no `LIMIT`. Priced here so the next item has a number rather than a hunch.
  [
    'HOP expr key, OFFSET no LIMIT',
    'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY b.n + 1 OFFSET 3',
    {},
  ],
  [
    'HOP alias key, OFFSET no LIMIT',
    'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY x OFFSET 3',
    {},
  ],
  // ⚠️ ITEM 1063'S WINDOWED SUBJECTS, carried as the CONTROL SET for item 1903's flag fix. That fix
  // turns OFF the start-only walk's template-clone whenever the deferred arm is active, so these
  // rows are where a regression from it would land — in particular the start-only projection, whose
  // clone it is.
  [
    'CONTROL hop windowed expr key',
    'MATCH (a:T)-[:E]->(b:T) RETURN b.n + 1 AS c ORDER BY b.n + 1 LIMIT 10',
    {},
  ],
  [
    'CONTROL hop windowed, START-only proj',
    'MATCH (a:T)-[:E]->(b:T) RETURN a.n AS c ORDER BY b.n + 1 LIMIT 10',
    {},
  ],
  [
    'CONTROL hop windowed alias key',
    'MATCH (a:T)-[:E]->(b:T) RETURN b.n + 1 AS c ORDER BY c LIMIT 10',
    {},
  ],
  /*
   * The unwindowed start-only shape, which is what the wrong answer was found on.
   *
   * ⚠️⚠️ ITS NEIGHBOUR IS NOT ITS CONTROL (item 1930). This row (470.97) sits beside
   * `CONTROL hop windowed, START-only proj` (298.23) and reads as a 1.58x gap. It is not a pair:
   * the control carries `LIMIT 10` and returns TEN rows where this returns 800,000. Against its
   * genuine twin — `HOP order by EXPRESSION` at 456.92, the same shape projecting the far end
   * instead of the start — it costs nothing extra, which isolated arms confirm (126.11 against
   * 122.94). So this row is not a nomination, and the windowed CONTROL SET above must not be read
   * as one: those rows are there to catch a regression from item 1903's flag fix, not to price
   * these.
   */
  ['HOP start-only proj, far key', 'MATCH (a:T)-[:E]->(b:T) RETURN a.n AS c ORDER BY b.n + 1', {}],
  ['order by expr, two terms', 'MATCH (n:T) RETURN n.n AS x ORDER BY n.x * 2, n.n', {}],
  [
    'top-k grouped',
    'MATCH (a:T)-[:E]->(b:T) LET g = b.n RETURN g, count(*) AS c GROUP BY g ORDER BY c DESC LIMIT 3',
    {},
  ],
  ['deep paging', 'MATCH (n:T) RETURN n.n AS x ORDER BY x OFFSET 300 LIMIT 10', {}],

  // --- composition: more than one clause feeding the next ---
  [
    'two sequential MATCH',
    'MATCH (a:T) WHERE a.n = $p0 MATCH (a)-[:E]->(b:T) RETURN b.n AS x',
    { p0: 3 },
  ],
  ['chained LET', 'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 RETURN b AS x', {}],
  /*
   * ⚠️ THE SINGLE LET WAS MISSING, AND THAT OMISSION IS WHY `chained LET` SAT OPEN FOR 25 ITEMS.
   * The row above reads as "a CHAIN is expensive", so item 1901's entry priced the chain — and the
   * cost was in ONE binding all along: at item 1926 the single `LET` measured 54.99 ms against the
   * hand-folded `RETURN (n.n + 1) AS x`'s 9.26, because `boundExprs` admitted only
   * `cheapPureExpr` or a subquery and ARITHMETIC is neither. Now 8.33. The chain row cannot show
   * that, since BOTH spellings carry a standing `LET` either way.
   *
   * 🔑 So a screen row that composes a feature with itself needs the ONE-of-it row beside it, or
   * the composition takes the blame for the primitive.
   */
  ['single LET', 'MATCH (n:T) LET a = n.n + 1 RETURN a AS x', {}],
  ['single LET, hand-folded CONTROL', 'MATCH (n:T) RETURN (n.n + 1) AS x', {}],
  ['NEXT composition', 'MATCH (n:T) WHERE n.n = $p0 RETURN n.n AS x NEXT RETURN x AS y', { p0: 3 }],
  [
    'CALL inline scoped',
    'MATCH (a:T) WHERE a.n = $p0 CALL (a) { MATCH (a)-[:E]->(b:T) RETURN b.n AS bn } RETURN bn AS x',
    { p0: 3 },
  ],
  ['CALL procedure YIELD', 'CALL degree({}) YIELD node, degree RETURN degree AS x', {}],
  ['FILTER after a hop', 'MATCH (a:T)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x', { p0: 5 }],

  // --- values: maps, strings, paths ---
  ['map value returned', 'MATCH (n:T) RETURN n.m AS x', {}],
  ['map literal built', 'MATCH (n:T) RETURN {a: n.n, b: n.s} AS x', {}],
  ['WHERE on a map field', 'MATCH (n:T) WHERE n.m.k = $p0 RETURN n.n AS x', { p0: 3 }],
  ['string fn upper', 'MATCH (n:T) RETURN upper(n.s) AS x', {}],
  ['string fn char_length', 'MATCH (n:T) WHERE char_length(n.s) > 0 RETURN n.s AS x', {}],
  ['string fn trim', 'MATCH (n:T) RETURN trim(n.s) AS x', {}],
  ['label disjunction', 'MATCH (n:T|U) RETURN n.n AS x', {}],

  // --- paths as values ---
  [
    'any shortest',
    'MATCH ANY SHORTEST (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p0 RETURN b.n AS x',
    { p0: 3 },
  ],
  [
    'path value + edges()',
    'MATCH p = (a:T)-[:E]->{1,2}(b:T) WHERE a.n = $p0 RETURN edges(p) AS x',
    { p0: 3 },
  ],
  [
    'path accessor edges(p)[0]',
    'MATCH p = (a:T)-[:E]->{1,2}(b:T) WHERE a.n = $p0 RETURN edges(p)[0] AS x',
    { p0: 3 },
  ],
];

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    const properties = {
      n: N_POOL[i % N_POOL.length],
      x: X_POOL[i % X_POOL.length],
      s: S_POOL[i % S_POOL.length],
      nu: i % 3 === 1 ? null : (i % 9) + 1,
      d: { '@date': DATES[i % DATES.length] },
      m: { k: i % 7, j: `q${i % 5}` },
    };

    if (i % 3 === 0) {
      properties.st = `p${i % 11}`;
    }

    g.addVertex({ id: String(i + 1), labels: i % 6 === 2 ? ['T', 'U'] : ['T'], properties });
  }

  /*
   * ⚠️⚠️ `MIXED=1` MAKES THE FIXTURE NON-HOMOGENEOUS, AND WITHOUT IT THIS SCREEN MEASURES AN ARM A
   * REAL GRAPH CANNOT REACH (items 1934-1942). Every vertex above carries `T`, so `T` is VACUOUS —
   * `verticesByLabel.get('T').size === vertexCount` — and the GQL fast paths that elide a universal
   * label or drive the far end all engage. A real schema (`Person` and `Company`) never satisfies
   * that: ONE vertex lacking the label disqualifies it for the whole graph, permanently.
   *
   * 🔑 THE OFF-LABEL VERTEX IS ISOLATED, which is what makes the two modes COMPARABLE. It carries no
   * edges and a label nothing matches, so every shape's ANSWER is identical in both modes and only
   * `graph.vertexCount` differs — which is exactly what `vacuousLabel` compares against. Item 1935
   * got this wrong first by RELABELLING a vertex, which changed the `T` count and the edge set, and
   * its answer guard caught ratios of 1221x that were two different questions.
   *
   * So `MIXED=1 bun gql-coverage-screen-1901.mjs` against the default is a per-shape diff of
   * "vacuous arm" against "the arm a realistic graph gets", with the answers held fixed.
   */
  if (process.env.MIXED === '1') {
    g.addVertex({ id: 'offlabel', labels: ['Z'], properties: { n: 0, s: 'z', m: {} } });
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(String(i + 1)),
      // ⚠️ Splits on the REPEAT INDEX — CLAUDE.md's fix for the `(a*k+b) % N` degeneracy, where one
      // vertex's FANOUT edges all land on the same target and every k-hop count is `F^k * N` by
      // construction while every degree looks perfect.
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
      labels: hop % 4 === 3 ? ['F'] : ['E'],
      properties: { w: [1, 2, 3, 4, 5, 7, 9][e % 7] },
    });
  }

  return g;
};

const runOne = (text, params) => {
  const g = build();
  const ser = [];
  let rows = 0;

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();

    rows = query(g, text, params).length;

    const ms = performance.now() - t0;

    if (r >= 2) {
      ser.push(ms);
    }
  }

  ser.sort((a, b) => a - b);

  return { ms: ser[ser.length >> 1], rows };
};

if (SHAPE !== '') {
  const found = SHAPES.find(([label]) => label === SHAPE);

  if (found === undefined) {
    console.log(`no such shape: ${SHAPE}`);
    process.exitCode = 1;
  } else {
    const { ms, rows } = runOne(found[1], found[2]);

    console.log(`RESULT\t${ms.toFixed(2)}\t${String(rows)}`);
  }
} else {
  console.log(
    `# gql-coverage-screen NODES=${String(NODES)} FANOUT=${String(FANOUT)} reps=${String(REPS)}`,
  );
  console.log(
    '# one CHILD PROCESS per shape. CONTROL rows come from families the screen already has.',
  );
  console.log('');

  const results = [];

  for (const [label] of SHAPES) {
    const r = spawnSync('bun', [process.argv[1]], {
      env: { ...process.env, SHAPE: label },
      encoding: 'utf8',
      timeout: 600_000,
    });
    const text = `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`;
    const m = /RESULT\t([\d.]+)\t(\d+)/.exec(text);

    if (m === null) {
      results.push({ label, ms: Number.NaN, rows: -1, note: `✗ ${text.trim().slice(-90)}` });
      continue;
    }

    results.push({
      label,
      ms: Number(m[1]),
      rows: Number(m[2]),
      note: Number(m[2]) === 0 ? '⚠️ ZERO ROWS — a broken row, not a fast one' : '',
    });
  }

  results.sort((a, b) => (Number.isNaN(b.ms) ? -1 : b.ms) - (Number.isNaN(a.ms) ? -1 : a.ms));

  console.log('      ms      rows   shape');
  console.log('-'.repeat(74));

  for (const r of results) {
    const ms = Number.isNaN(r.ms) ? '     -' : r.ms.toFixed(2).padStart(8);

    console.log(`${ms}  ${String(r.rows).padStart(8)}   ${r.label}  ${r.note}`);
  }
}
