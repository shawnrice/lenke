/**
 * DO THE TWO DISTINCT KEY SPACES AGREE? — a CORRECTNESS probe (item 1873).
 *
 * Item 1873 set out to speed `count(DISTINCT x)` over a chain: it is the thinnest-margin rung of
 * all 50 (0.34x) and `RETURN DISTINCT x` over the same chain is **1.73x FASTER at materializing the
 * set than the count rung is at counting it** (3.42 against 5.91 ms). The fix looked like one line
 * — `detectHop2FoldedAggregate` already delegates to `detectHop2Projection` with a synthetic
 * projection, just with `distinct: false`, so flipping it would let the fused one-column DISTINCT
 * dedup DURING the walk instead of materializing 20,000 rows for the fold.
 *
 * ⚠️⚠️ BUT THE TWO PATHS KEY DIFFERENTLY, AND THAT MAKES IT A CORRECTNESS QUESTION FIRST.
 *
 *   `distinctCountFold`  keys every value through ONE string space: `Set<string>` of `valueKey(v)`.
 *   `addOneColumnKey`    keeps TWO spaces — primitives by SameValueZero, non-primitives by
 *                        `valueKey` — and items 1561/1562 put it that way ON PURPOSE, because the
 *                        STRING `'@v1'` and the VERTEX `v1` both render as `@v1`.
 *
 * So on a column mixing those two, the fold counts ONE and the fused DISTINCT counts TWO. One of
 * them is wrong, the Rust engine is the contract, and **the differential fuzzer may not cover this
 * at all** — `fuzzer-blind-to-one-column-group` records that every fuzzer's grouped shape is the
 * TWO-column form.
 *
 * This probe asks the engines directly, before any optimization is written. It is not a benchmark.
 *
 *     cd packages/native && bun distinct-count-keyspace-1873.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

/**
 * ⚠️ THE FIXTURE IS THE WHOLE EXPERIMENT. `v1` is a vertex whose id renders as `@v1`; `s` carries
 * the literal STRING `'@v1'`. A single key space collapses them; two spaces keep them apart. Every
 * other row is a control: plain duplicates that both spaces must agree on.
 */
/**
 * ⚠️ THE FIRST VERSION OF THIS FIXTURE DID NOT CREATE THE COLLISION AT ALL, and the probe answered
 * `6 = 6` and looked like agreement. The `CASE` yields the VERTEX when `n = 1` and the STRING
 * otherwise, so to put `v1` and the string `'@v1'` into ONE column they must sit on vertices with
 * DIFFERENT `n`: `v1` has `n = 1` (yields the vertex) and `v9` has `n = 9` with `s = '@v1'` (yields
 * the string). Without that pair the two key spaces are never asked to disagree — the same
 * "one fixture cannot test a branch" failure this session has hit repeatedly.
 */
const lines = [
  // n = 1 → the CASE yields the VERTEX. `v1` renders as `@v1`.
  '{"type":"node","id":"v1","labels":["L"],"properties":{"s":"zz","n":1}}',
  '{"type":"node","id":"v2","labels":["L"],"properties":{"s":"zz","n":1}}',
  // ⬇ THE COLLISION: n != 1 so the CASE yields the STRING, and that string is `@v1` — exactly what
  // `valueKey` renders the vertex above as.
  '{"type":"node","id":"v9","labels":["L"],"properties":{"s":"@v1","n":9}}',
  '{"type":"node","id":"v3","labels":["L"],"properties":{"s":"other","n":2}}',
  // The NUMBER 1 against the STRING '1', the same question one type down.
  '{"type":"node","id":"v4","labels":["L"],"properties":{"s":"1","n":4}}',
  '{"type":"node","id":"v5","labels":["L"],"properties":{"s":"1","n":5}}',
  // true / 'true' — and again for booleans.
  '{"type":"node","id":"v6","labels":["L"],"properties":{"s":"true","n":3}}',
  // Edges so the chain shapes have something to walk; a 6-cycle keeps every vertex reachable.
  // A cycle over the SIX `v1..v6` ids so every chain shape has something to walk. `v9` is left
  // off the cycle deliberately: it is the collision row and belongs to the NODE shapes, where no
  // edge is needed, so putting it on the cycle would only change the chain rows' counts.
  ...Array.from(
    { length: 6 },
    (_, i) =>
      `{"type":"edge","id":"e${String(i)}","labels":["R"],"from":"v${String(i + 1)}","to":"v${String(((i + 1) % 6) + 1)}"}`,
  ),
];
const doc = lines.join('\n');

const g = tsDeserialize(doc, 'ndjson', new TsGraph());

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;
const nat = graphFromNdjson(createFfiEngineBackend(LIB), doc);

/**
 * ⚠️ MIXING A STRING COLUMN WITH AN ELEMENT COLUMN NEEDS ONE EXPRESSION THAT YIELDS BOTH, which a
 * plain property read cannot do. `CASE` is how item 1843 built the same fixture for the fused
 * DISTINCT: the vertex itself for one half of the rows, the string for the other.
 */
const MIXED = 'CASE WHEN n.n = 1 THEN n ELSE n.s END';

const CASES: readonly (readonly [string, string])[] = [
  // The question. If the two key spaces disagree, these two must disagree too.
  ['node  count(DISTINCT <mixed>)', `MATCH (n:L) RETURN count(DISTINCT ${MIXED}) AS c`],
  ['node  size(collect(DISTINCT))', `MATCH (n:L) RETURN size(collect(DISTINCT ${MIXED})) AS c`],
  // And the ROW spelling, whose count is the same question asked a third way.
  ['node  RETURN DISTINCT <mixed>', `MATCH (n:L) RETURN DISTINCT ${MIXED} AS k`],
  // The chain widths item 1873 was going to change.
  [
    'hop2  count(DISTINCT far.s)',
    'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN count(DISTINCT c.s) AS c',
  ],
  ['hop2  RETURN DISTINCT far.s', 'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN DISTINCT c.s AS k'],
  // CONTROLS: plain columns where any sane keying agrees.
  ['node  count(DISTINCT n.s)', 'MATCH (n:L) RETURN count(DISTINCT n.s) AS c'],
  ['node  count(DISTINCT n.n)', 'MATCH (n:L) RETURN count(DISTINCT n.n) AS c'],
  ['node  count(DISTINCT n)', 'MATCH (n:L) RETURN count(DISTINCT n) AS c'],
];

/**
 * ⚠️ THE ROW RENDERING IS TYPE-TAGGED, and the first version was not — it `JSON.stringify`d the
 * values, so a TS vertex printed as `{"id":"v1",...}` and native's as something else entirely, and
 * the probe reported a "divergence" that was its own formatting. What matters here is the SHAPE of
 * the distinct set, so each value is rendered as `<type>:<key>` with elements reduced to their id.
 */
const tag = (v: unknown): string => {
  if (v !== null && typeof v === 'object' && 'id' in (v as Record<string, unknown>)) {
    return `elem:${String((v as { id: unknown }).id)}`;
  }

  return `${typeof v}:${String(v)}`;
};

const render = (rows: readonly Record<string, unknown>[]): string =>
  rows.length === 1 && 'c' in rows[0]
    ? String(rows[0].c)
    : `${String(rows.length)}: ${JSON.stringify(rows.map((r) => tag(r.k)).sort())}`;

console.log('');
console.log('shape                             ts                native            agree?');
console.log('--------------------------------------------------------------------------------');

let disagreements = 0;

for (const [name, text] of CASES) {
  let ts = '';
  let native = '';

  try {
    ts = render(tsQuery(g, text));
  } catch (e) {
    ts = `raise: ${(e as Error).message.slice(0, 22)}`;
  }

  try {
    native = render(nat.query(text));
  } catch (e) {
    native = `raise: ${(e as Error).message.slice(0, 22)}`;
  }

  const agree = ts === native;

  if (!agree) {
    disagreements += 1;
  }

  console.log(
    `${name.padEnd(33)} ${ts.slice(0, 17).padEnd(18)} ${native.slice(0, 17).padEnd(18)} ${
      agree ? 'yes' : '⚠️  NO'
    }`,
  );
}

console.log('');
console.log(
  disagreements === 0
    ? '# the engines agree on every case — the key spaces are reconcilable here.'
    : `# ⚠️ ${String(disagreements)} DISAGREEMENT(S) — a cross-engine divergence, not an optimization question.`,
);
