/**
 * A DOTTED conjunct beside a RAISING one: do the engines agree? (item 1169)
 *
 * Item 1168 shared the ORDERING KEY (a dotted access is non-raising in both), which fixed the
 * fuzzer's shape. It did not fix these, because a predicate attached to a MATCH never reaches
 * `filterPredicate` at all — `compilePredicate` LIFTS each conjunct into a typed bucket
 * (`eqProps`/`cmpProps`/`truthProps`/`notTruthProps`/`pathProps`) and `residual` is always
 * undefined, so the lifted lists are the only carriers and the order ACROSS buckets decides which
 * conjunct runs first.
 *
 * The buckets are ordered non-raising first — `eqProps` and `cmpProps` read and compare, while
 * `truthProps`/`notTruthProps` COERCE and so raise on a non-boolean — and item 900 appended
 * `pathProps` at the END, after the raising pair. So `n.s` coerced a string before the dotted
 * conjunct could drop the row, while the engine (whose `can_raise` calls a `Compare` over a
 * `Field` non-raising) hoisted it and never faulted.
 *
 *   cd packages/native && bun dotted-raise-cross-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const doc = [
  '{"type":"node","id":"1","labels":["T"],"properties":{"n":3,"s":"a","f":true,"m":{"k":1,"deep":{"z":9}}}}',
  '{"type":"node","id":"2","labels":["T"],"properties":{"n":7,"s":"b","f":false,"m":{"k":2,"deep":{"z":8}}}}',
].join('\n');

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;

const ts = tsDeserialize(doc, 'ndjson', new TsGraph());
const nat = graphFromNdjson(createFfiEngineBackend(LIB), doc);

const ask = (e: 'ts' | 'native', q: string): string => {
  try {
    const rows = (e === 'ts' ? tsQuery(ts, q) : nat.query(q)) as unknown[];

    return `ok [${[...rows]
      .map((x) => JSON.stringify(x))
      .sort()
      .join('|')}]`;
  } catch (err) {
    return `ERR ${String((err as { code?: string }).code ?? (err as Error).name)}`;
  }
};

const CASES: [string, string][] = [
  // The three shapes item 1168 left open: a dotted conjunct that settles every row, beside a
  // bare property whose coercion raises. Both orders, and the FILTER spelling.
  ['WHERE dotted=99 AND raising', 'MATCH (n:T) WHERE n.m.k = 99 AND n.s RETURN n.n AS x'],
  ['WHERE raising AND dotted=99', 'MATCH (n:T) WHERE n.s AND n.m.k = 99 RETURN n.n AS x'],
  ['FILTER dotted=99 AND raising', 'MATCH (n:T) FILTER n.m.k = 99 AND n.s RETURN n.n AS x'],
  [
    'WITH ... WHERE (reaches filterPredicate)',
    'MATCH (n:T) WITH n WHERE n.m.k = 99 AND n.s RETURN n.n AS x',
  ],
  // TWO levels deep, a different `pathOf` walk.
  ['WHERE deep=99 AND raising', 'MATCH (n:T) WHERE n.m.deep.z = 99 AND n.s RETURN n.n AS x'],
  // The NEGATED truth bucket, which sits beside `truthProps` and had the same relative order.
  ['WHERE dotted=99 AND NOT raising', 'MATCH (n:T) WHERE n.m.k = 99 AND NOT n.s RETURN n.n AS x'],
  // ORDERING ops, not just `=`, since `pathProps` carries any comparison.
  ['WHERE dotted>1000 AND raising', 'MATCH (n:T) WHERE n.m.k > 1000 AND n.s RETURN n.n AS x'],
  // CONTROLS the reorder cannot reach: the dotted conjunct MATCHES, so the raising sibling is
  // essential either way and BOTH engines must still raise.
  [
    '[ctl] dotted MATCHES, so raising is essential',
    'MATCH (n:T) WHERE n.m.k = 1 AND n.s RETURN n.n AS x',
  ],
  ['[ctl] raising alone', 'MATCH (n:T) WHERE n.s RETURN n.n AS x'],
  // [ctl] a BOOLEAN bare property is a legitimate truth test and must still filter correctly.
  ['[ctl] dotted + a real boolean prop', 'MATCH (n:T) WHERE n.m.k = 1 AND n.f RETURN n.n AS x'],
];

console.log('\n  case                                              ts              native');

let diverged = 0;

for (const [label, q] of CASES) {
  const a = ask('ts', q);
  const b = ask('native', q);

  if (a !== b) {
    diverged += 1;
  }

  console.log(`  ${label.padEnd(49)} ${a.padEnd(15)} ${b}${a === b ? '' : '  <- DIVERGE'}`);
}

console.log(`\n  ${diverged} of ${CASES.length} diverged`);

if (diverged > 0) {
  process.exit(1);
}
