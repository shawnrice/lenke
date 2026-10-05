import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './backend-ffi-engine.js';
import { graphFromNdjson } from './graph.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXT}`,
  import.meta.url,
).pathname;
const hasLib = existsSync(LIB);

if (!hasLib) {
  // eslint-disable-next-line no-console
  console.warn(`[edge-pattern] skipping: ${LIB} not found — run \`bun run build:rust\`.`);
}

const suite = hasLib ? describe : describe.skip;

// `a -[:E]-> b`, plus an isolated `c` so a Both-direction pattern cannot be mistaken for
// "every pair of vertices".
const DOC = [
  '{"type":"node","id":"a","labels":["L"],"properties":{"n":1}}',
  '{"type":"node","id":"b","labels":["L"],"properties":{"n":2}}',
  '{"type":"node","id":"c","labels":["L"],"properties":{"n":3}}',
  '{"type":"edge","id":"e","labels":["E"],"from":"a","to":"b","properties":{}}',
].join('\n');

/**
 * Every ISO `<abbreviated edge pattern>` paired with the full-bracket form it must equal:
 *
 *   <abbreviated edge pattern> ::=
 *       <left arrow> | <tilde> | <right arrow> | <left arrow tilde>
 *     | <tilde right arrow> | <left minus right> | <minus sign>
 *
 * Native raised `E_SYNTAX` on all seven abbreviated forms AND on three of the seven full forms
 * until audit item 166, while the TS engine answered every one and agreed with itself — so this
 * was the equivalent-spellings rule violated ACROSS engines rather than within one.
 *
 * Deliberately a DETERMINISTIC conformance test rather than entries in the differential fuzzer's
 * targeted band: that band is `pick`ed from, so 18 added queries diluted every other shape's
 * share and pushed `hopUntypedNonZero` under its floor on some seeds — the dilution items 115,
 * 125 and 152 each hit. Here the coverage is exact and costs no other shape anything.
 */
const PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ['pointing left', '<-', '<-[]-'],
  ['undirected', '~', '~[]~'],
  ['pointing right', '->', '-[]->'],
  ['left or undirected', '<~', '<~[]~'],
  ['undirected or right', '~>', '~[]~>'],
  ['left or right', '<->', '<-[]->'],
  ['any direction', '-', '-[]-'],
];

/** Spellings in NEITHER grammar — both engines must refuse, and refuse the same way. */
const NOT_ISO = [
  // Cypher arrows. `--` is in fact the ISO SIMPLE COMMENT INTRODUCER, so `-->` and `--` leave
  // the statement without its RETURN rather than being rejected as a delimiter — which is what
  // item 164 mis-diagnosed as a silently-accepted Cypherism.
  '-->',
  '--',
  '<--',
  '<-->',
  '===',
  // An abbreviated-only delimiter cannot open a BRACKETED pattern: it carries no variable,
  // type or properties.
  '->[]->',
  '<->[]-',
  '~>[]~',
  '->[r:E]->',
];

suite('edge-pattern differential (TS vs native)', () => {
  const engines = () => {
    const ts = tsDeserialize(DOC, 'ndjson', new Graph());
    const native = graphFromNdjson(createFfiEngineBackend(LIB), DOC);

    return { ts, native };
  };

  const both = (g: ReturnType<typeof engines>, sql: string) => {
    const read = (run: () => unknown): string => {
      try {
        return JSON.stringify(run());
      } catch (e) {
        return `THROW ${String((e as { code?: unknown }).code)}`;
      }
    };

    return { ts: read(() => tsQuery(g.ts, sql)), native: read(() => g.native.query(sql)) };
  };

  test('each abbreviated form agrees with its full spelling, on BOTH engines', () => {
    const g = engines();

    for (const [name, abbrev, full] of PAIRS) {
      const a = both(g, `MATCH (x:L)${abbrev}(y:L) RETURN count(*) AS c`);
      const f = both(g, `MATCH (x:L)${full}(y:L) RETURN count(*) AS c`);

      // Within each engine the two spellings are the same query.
      expect(a.ts, `${name}: ts \`${abbrev}\` vs \`${full}\``).toEqual(f.ts);
      expect(a.native, `${name}: native \`${abbrev}\` vs \`${full}\``).toEqual(f.native);
      // And across engines, which is the invariant that was broken.
      expect(a.native, `${name}: \`${abbrev}\` across engines`).toEqual(a.ts);
      expect(f.native, `${name}: \`${full}\` across engines`).toEqual(f.ts);
    }
  });

  test('the directions themselves are right, not merely equal', () => {
    // A count cannot tell `->` from `<-` — both count EDGES — which is why a mutant swapping
    // the two survived 960 native tests. Only a bound endpoint distinguishes them, so read one.
    const g = engines();

    for (const [sql, want] of [
      [`MATCH (x:L {n: 1})->(y:L) RETURN y.n AS v`, 2],
      [`MATCH (x:L {n: 2})<-(y:L) RETURN y.n AS v`, 1],
      [`MATCH (x:L {n: 1})-(y:L) RETURN y.n AS v`, 2],
      [`MATCH (x:L {n: 2})-(y:L) RETURN y.n AS v`, 1],
    ] as const) {
      const r = both(g, sql);

      expect(r.native, `across engines: ${sql}`).toEqual(r.ts);
      expect(JSON.parse(r.ts), sql).toEqual([{ v: want }]);
    }

    // The empty directions: nothing points at `a`, and `b` has no out-edge.
    for (const sql of [
      `MATCH (x:L {n: 1})<-(y:L) RETURN y.n AS v`,
      `MATCH (x:L {n: 2})->(y:L) RETURN y.n AS v`,
    ]) {
      const r = both(g, sql);

      expect(r.native, `across engines: ${sql}`).toEqual(r.ts);
      expect(JSON.parse(r.ts), sql).toEqual([]);
    }
  });

  test('a Both-direction abbreviated hop does not reach the isolated vertex', () => {
    // `c` has no edges at all. A pattern that counted vertex PAIRS rather than edges would
    // include it, and every direction above would read 2 instead of 1.
    const g = engines();
    const r = both(g, `MATCH (x:L)-(y:L) WHERE y.n = 3 RETURN count(*) AS c`);

    expect(r.native).toEqual(r.ts);
    expect(JSON.parse(r.ts)).toEqual([{ c: 0 }]);
  });

  test('spellings in neither grammar are refused by both engines', () => {
    const g = engines();

    for (const spelling of NOT_ISO) {
      const r = both(g, `MATCH (x:L)${spelling}(y:L) RETURN count(*) AS c`);

      expect(r.ts, `ts must refuse \`${spelling}\``).toMatch(/^THROW/);
      expect(r.native, `native must refuse \`${spelling}\``).toMatch(/^THROW/);
      expect(r.native, `same refusal for \`${spelling}\``).toEqual(r.ts);
    }
  });

  test('abbreviated hops chain, and mix with full ones in one pattern', () => {
    const chain = [
      DOC,
      '{"type":"edge","id":"e2","labels":["E"],"from":"b","to":"c","properties":{}}',
    ].join('\n');
    const g = {
      ts: tsDeserialize(chain, 'ndjson', new Graph()),
      native: graphFromNdjson(createFfiEngineBackend(LIB), chain),
    };

    for (const sql of [
      `MATCH (x:L)->(y:L)->(z:L) RETURN count(*) AS c`,
      `MATCH (x:L)-[]->(y:L)->(z:L) RETURN count(*) AS c`,
      `MATCH (x:L)->(y:L)-[]->(z:L) RETURN count(*) AS c`,
    ]) {
      const r = both(g, sql);

      expect(r.native, `across engines: ${sql}`).toEqual(r.ts);
      expect(JSON.parse(r.ts), sql).toEqual([{ c: 1 }]);
    }
  });
});
