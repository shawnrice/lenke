// Cross-engine differential for the unique-constraint primitive: the SAME
// createUniqueConstraint + INSERT/SET sequence runs on BOTH the TS engine
// (@lenke/core + @lenke/gql) and the Rust core (over bun:ffi), asserting the two
// agree on every write outcome (the same ConstraintViolation, or both succeed)
// AND on the resulting graph state byte-for-byte. This is the divergence
// tripwire the parallel unit tests can't be. See docs/design/gql-extensions.md.
//
// Run: bun test packages/native/src/constraint-conformance.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiBackend } from './backend-ffi.js';
import { graphFromFormat } from './graph.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-core/target/release/liblenke_core.${LIB_EXT}`,
  import.meta.url,
).pathname;
const hasLib = existsSync(LIB);

if (!hasLib) {
  // eslint-disable-next-line no-console
  console.warn(`[constraint] skipping: ${LIB} not found — run \`bun run build:rust\`.`);
}

const suite = hasLib ? describe : describe.skip;

// A seed node of an unrelated label — both engines start byte-identical, and
// `Acct` / `Other` are a clean namespace for the constraint.
const SEED = '{"type":"node","id":"seed","labels":["Seed"],"properties":{}}';

type Outcome = { ok: true } | { code: unknown };

const outcome = (run: () => unknown): Outcome => {
  try {
    run();

    return { ok: true };
  } catch (e) {
    return { code: (e as { code?: unknown }).code };
  }
};

suite('unique-constraint differential (TS vs native)', () => {
  // One identical write sequence, applied to whichever engine drives it.
  const SCRIPT: Array<{ label: string; sql: string }> = [
    { label: 'insert first Acct', sql: `INSERT (:Acct {email: 'a@x.io', name: 'A'})` },
    { label: 'duplicate email → violation', sql: `INSERT (:Acct {email: 'a@x.io', name: 'B'})` },
    { label: 'different email ok', sql: `INSERT (:Acct {email: 'b@x.io', name: 'B'})` },
    { label: 'different label ok', sql: `INSERT (:Other {email: 'a@x.io'})` },
    { label: 'null email #1 (exempt)', sql: `INSERT (:Acct {email: null, name: 'N1'})` },
    { label: 'null email #2 (exempt)', sql: `INSERT (:Acct {email: null, name: 'N2'})` },
    {
      label: 'SET collision → violation',
      sql: `MATCH (n:Acct {email: 'b@x.io'}) SET n.email = 'a@x.io'`,
    },
    { label: 'SET self ok', sql: `MATCH (n:Acct {email: 'b@x.io'}) SET n.email = 'b@x.io'` },
  ];

  test('every write outcome and the final state agree across engines', () => {
    const tsGraph = tsDeserialize(SEED, 'ndjson', new Graph());
    tsGraph.createUniqueConstraint('Acct', 'email');

    const backend = createFfiBackend(LIB);
    const nativeGraph = graphFromFormat(backend, SEED, 'ndjson');
    nativeGraph.createUniqueConstraint('Acct', 'email');

    for (const { label, sql } of SCRIPT) {
      const ts = outcome(() => tsQuery(tsGraph, sql));
      const native = outcome(() => nativeGraph.query(sql));

      expect(native, `outcome mismatch: ${label}`).toEqual(ts);
    }

    // The resulting graph must be byte-identical too — same Accts, same values.
    const READ = `MATCH (n:Acct) RETURN n.name, n.email ORDER BY n.name`;
    const tsRows = JSON.stringify(tsQuery(tsGraph, READ));
    const nativeRows = JSON.stringify(nativeGraph.query(READ));

    expect(nativeRows).toEqual(tsRows);
  });

  test('declare-time rejection agrees across engines (pre-existing duplicates)', () => {
    const dup = [
      '{"type":"node","id":"1","labels":["Acct"],"properties":{"email":"dup@x.io"}}',
      '{"type":"node","id":"2","labels":["Acct"],"properties":{"email":"dup@x.io"}}',
    ].join('\n');

    const tsGraph = tsDeserialize(dup, 'ndjson', new Graph());
    const backend = createFfiBackend(LIB);
    const nativeGraph = graphFromFormat(backend, dup, 'ndjson');

    const ts = outcome(() => tsGraph.createUniqueConstraint('Acct', 'email'));
    const native = outcome(() => nativeGraph.createUniqueConstraint('Acct', 'email'));

    expect(native).toEqual(ts);
  });

  test('_MERGE outcomes and final state agree across engines', () => {
    // Exercises every disposition + WHERE-gate + the no-constraint error, run on
    // both engines, comparing each outcome and the final graph byte-for-byte.
    const script = [
      `_MERGE (u:Acct {email: 'm@x.io', name: 'A'}) _ON_CREATE SET u.created = 1`, // create
      `_MERGE (u:Acct {email: 'm@x.io', name: 'B'})`, // clobber payload
      `_MERGE (u:Acct {email: 'm@x.io', name: 'IGN'}) _ON_UPDATE SET u.name = 'Upd'`, // replace
      `_MERGE (u:Acct {email: 'm@x.io', name: 'IGN2'}) _ON_UPDATE_NOTHING`, // no-op
      `_MERGE (u:Acct {email: 'k@x.io', v: 1})`, // create #2
      `_MERGE (u:Acct {email: 'k@x.io'}) _ON_UPDATE SET u.v = 9 WHERE u.v < 9`, // LWW: applies
      `_MERGE (u:Acct {email: 'k@x.io'}) _ON_UPDATE SET u.v = 2 WHERE u.v < 2`, // LWW: no-op
      `_MERGE (u:Nope {k: 1})`, // no constraint → error (both InvalidGraphOp)
    ];

    const tsGraph = tsDeserialize(SEED, 'ndjson', new Graph());
    tsGraph.createUniqueConstraint('Acct', 'email');
    const backend = createFfiBackend(LIB);
    const nativeGraph = graphFromFormat(backend, SEED, 'ndjson');
    nativeGraph.createUniqueConstraint('Acct', 'email');

    for (const sql of script) {
      const ts = outcome(() => tsQuery(tsGraph, sql));
      const native = outcome(() => nativeGraph.query(sql));

      expect(native, `_MERGE outcome mismatch: ${sql}`).toEqual(ts);
    }

    const READ = `MATCH (u:Acct) RETURN u.email, u.name, u.v, u.created ORDER BY u.email`;
    expect(JSON.stringify(nativeGraph.query(READ))).toEqual(JSON.stringify(tsQuery(tsGraph, READ)));
  });
});
