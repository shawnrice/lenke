/**
 * What does `CAST(<NaN> AS BOOLEAN)` do in each engine? (item 1168)
 *
 * CI found this with the differential fuzzer at `FUZZ_SEED=1433311152`, reproducible:
 *
 *     MATCH (n:T) WHERE ((CAST(n.nan AS BOOLEAN) IS UNKNOWN) AND (n.m.k = 3)) RETURN n.n AS x
 *       ts:     err E_INVALID_VALUE
 *       native: ok [{"x":5}]
 *
 * One engine raises where the other answers, which is a byte-identity violation whichever is
 * right. This narrows it to the cast alone, across the numeric values a cast has to decide about,
 * and across the other cast TARGETS so the question is asked of the whole enum rather than the one
 * variant the fuzzer happened to hit.
 *
 *   cd packages/native && bun cast-nan-cross-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const doc = ['{"type":"node","id":"1","labels":["T"],"properties":{"v":1}}'].join('\n');

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;

const ts = tsDeserialize(doc, 'ndjson', new TsGraph());
const nat = graphFromNdjson(createFfiEngineBackend(LIB), doc);

/** The value under test arrives by SET, the only route that can store a non-finite. */
const seed = (expr: string): void => {
  const q = `MATCH (n:T) SET n.w = ${expr}`;

  tsQuery(ts, q);
  nat.query(q);
};

const ask = (engine: 'ts' | 'native', q: string): string => {
  try {
    const rows = engine === 'ts' ? tsQuery(ts, q) : nat.query(q);

    return `ok ${JSON.stringify(rows)}`;
  } catch (e) {
    const code = (e as { code?: string }).code ?? (e as Error).name;

    return `err ${String(code)}`;
  }
};

const VALUES: [string, string][] = [
  ['NaN        (sqrt(0 - 1))', 'sqrt(0 - 1)'],
  ['+Infinity  (1e400)', '1e400'],
  ['-Infinity  (0 - 1e400)', '0 - 1e400'],
  ['0', '0'],
  ['1', '1'],
  ['2.5', '2.5'],
  ['-3', '0 - 3'],
];

const TARGETS = ['BOOLEAN', 'INTEGER', 'FLOAT', 'STRING'];

console.log(
  '\n  CAST(<value> AS <target>) — one engine raising where the other answers is the bug\n',
);
console.log(`  ${'value'.padEnd(26)} ${'target'.padEnd(9)} ${'ts'.padEnd(22)} native`);

let diverged = 0;

for (const [label, expr] of VALUES) {
  seed(expr);

  for (const target of TARGETS) {
    const q = `MATCH (n:T) RETURN CAST(n.w AS ${target}) AS c`;
    const a = ask('ts', q);
    const b = ask('native', q);
    const same = a === b;

    if (!same) {
      diverged += 1;
    }

    console.log(
      `  ${label.padEnd(26)} ${target.padEnd(9)} ${a.padEnd(22)} ${b}${same ? '' : '   <- DIVERGE'}`,
    );
  }
}

console.log(`\n  ${diverged} of ${VALUES.length * TARGETS.length} diverged`);

if (diverged > 0) {
  process.exit(1);
}
