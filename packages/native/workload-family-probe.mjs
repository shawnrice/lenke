/**
 * Is every realistic-workload family VALID and NON-VACUOUS on the differential fuzzer's fixture?
 *
 * Two different failures, and both are silent in a fuzzer:
 *
 *   - a family whose text does not PARSE errors on both engines, which the differential comparison
 *     reads as agreement ("both reject the input") and reports as a pass;
 *   - a family that parses and matches NOTHING compares an empty result against an empty result,
 *     which is the trap items 51 and 63 both fell into.
 *
 * So this prints, per family: how many of its draws parsed on each engine, how many returned rows,
 * and the first error text if any draw failed. Run it before wiring a family into the fuzzer.
 */

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';
import { WORKLOAD_FAMILIES, genWorkload } from './src/workload-queries.js';

const NDJSON = [
  '{"type":"node","id":"1","labels":["T"],"properties":{"n":3,"s":"a","x":-1,"st":"p","nu":5,"d":{"@date":"2024-01-02"},"m":{"k":1,"j":"q"}}}',
  '{"type":"node","id":"2","labels":["T"],"properties":{"n":7,"s":"z","x":4,"nu":null,"d":{"@date":"1999-12-31"},"m":{"k":2,"j":"r"}}}',
  '{"type":"node","id":"3","labels":["T","U"],"properties":{"n":5,"s":"m","x":2,"st":"w","nu":5,"d":{"@date":"2024-01-03"},"m":{"k":3,"j":"s"}}}',
  '{"type":"node","id":"4","labels":["T"],"properties":{"n":11,"s":"x","x":0,"nu":null,"d":{"@date":"2031-11-30"},"m":{"k":4,"j":"t"}}}',
  '{"type":"node","id":"5","labels":["T"],"properties":{"n":13,"s":"","x":3,"m":{"k":5,"j":"u"}}}',
  '{"type":"node","id":"6","labels":["T"],"properties":{"n":17,"nu":9,"s":"q","x":5,"d":{"@date":"2024-01-02"},"m":{"k":6,"j":"v"}}}',
  '{"type":"edge","id":"e1","labels":["E"],"from":"1","to":"2","properties":{"w":2}}',
  '{"type":"edge","id":"e2","labels":["E","F"],"from":"2","to":"3","properties":{"w":5}}',
  '{"type":"edge","id":"e3","labels":["E"],"from":"1","to":"3","properties":{"w":9}}',
  '{"type":"edge","id":"e6","labels":["E"],"from":"3","to":"1","properties":{"w":7}}',
  '{"type":"edge","id":"e4","labels":["E"],"from":"3","to":"4","properties":{"w":1}}',
  '{"type":"edge","id":"e5","labels":["F"],"from":"4","to":"5","properties":{"w":3}}',
  '{"type":"edge","id":"e7","labels":["F"],"from":"5","to":"5","properties":{"w":4}}',
].join('\n');

if (!nativeReady) {
  throw new Error('native lib is not built — run `bun run build` first');
}

const nat = graphFromNdjson(nativeBackend(), NDJSON);
const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());

const mulberry32 = (seed) => {
  let a = seed >>> 0;

  return () => {
    a |= 0;
    a = (a + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** Multiset-canonicalize a result, since row order is unspecified without a total ORDER BY. */
const canon = (j) =>
  JSON.stringify(
    JSON.parse(j)
      .map((row) => JSON.stringify(row))
      .sort((a, b) => a.localeCompare(b)),
  );

const DRAWS = Number(process.env.DRAWS ?? 400);
const stats = new Map();

for (let i = 0; i < DRAWS * WORKLOAD_FAMILIES.length; i += 1) {
  const w = genWorkload(mulberry32(i * 2654435761));
  const s = stats.get(w.family) ?? {
    n: 0,
    tsOk: 0,
    natOk: 0,
    rows: 0,
    agree: 0,
    err: undefined,
    texts: new Set(),
  };

  s.n += 1;
  s.texts.add(w.text);

  let a;
  let b;

  try {
    a = JSON.stringify(tsQuery(ts, w.text, w.params));
    s.tsOk += 1;
  } catch (e) {
    a = undefined;
    s.err ??= `ts: ${String(e?.code ?? e?.message ?? e).slice(0, 70)} :: ${w.text}`;
  }

  try {
    b = JSON.stringify(nat.query(w.text, w.params));
    s.natOk += 1;
  } catch (e) {
    b = undefined;
    s.err ??= `nat: ${String(e?.code ?? e?.message ?? e).slice(0, 70)} :: ${w.text}`;
  }

  if (a !== undefined && a !== '[]') {
    s.rows += 1;
  }

  if (a !== undefined && b !== undefined && canon(a) === canon(b)) {
    s.agree += 1;
  }

  stats.set(w.family, s);
}

console.log(
  `family           draws  tsOK  natOK  nonEmpty  agree  distinct-texts\n${'-'.repeat(76)}`,
);

let bad = 0;

for (const [name, s] of [...stats.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
  const vacuous = s.rows === 0;
  const broken = s.tsOk < s.n || s.natOk < s.n;

  if (vacuous || broken) {
    bad += 1;
  }

  console.log(
    `${name.padEnd(16)}${String(s.n).padStart(5)}${String(s.tsOk).padStart(6)}` +
      `${String(s.natOk).padStart(7)}${String(s.rows).padStart(10)}${String(s.agree).padStart(7)}` +
      `${String(s.texts.size).padStart(8)}  ${vacuous ? 'VACUOUS ' : ''}${broken ? 'BROKEN' : ''}`,
  );

  if (s.err) {
    console.log(`    first error: ${s.err}`);
  }
}

console.log(`\n${bad === 0 ? 'all families valid and non-vacuous' : `${bad} FAMILIES NEED WORK`}`);
