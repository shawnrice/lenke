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

  test('_MERGE edge form outcomes and final state agree across engines', () => {
    const tsGraph = tsDeserialize(SEED, 'ndjson', new Graph());
    const backend = createFfiBackend(LIB);
    const nativeGraph = graphFromFormat(backend, SEED, 'ndjson');

    for (const g of [tsGraph, nativeGraph]) {
      g.createUniqueConstraint('User', 'id');
      g.createUniqueConstraint('Team', 'id');
    }

    const script = [
      `INSERT (:User {id: 'u1'}), (:Team {id: 't1'})`,
      `_MERGE (u:User {id:'u1'})-[m:MEMBER {since: 1}]->(t:Team {id:'t1'}) _ON_CREATE SET m.role = 'admin'`, // create
      `_MERGE (u:User {id:'u1'})-[m:MEMBER {since: 2}]->(t:Team {id:'t1'})`, // clobber edge props
      `_MERGE (u:User {id:'u1'})-[m:MEMBER {since: 9}]->(t:Team {id:'t1'}) _ON_UPDATE_NOTHING`, // no-op
      `_MERGE (u:User {id:'u1'})-[m:MEMBER]->(t:Team {id:'nope'})`, // missing endpoint → error
    ];

    for (const sql of script) {
      const ts = outcome(() => tsQuery(tsGraph, sql));
      const native = outcome(() => nativeGraph.query(sql));

      expect(native, `edge _MERGE mismatch: ${sql}`).toEqual(ts);
    }

    const READ = `MATCH (:User)-[m:MEMBER]->(:Team) RETURN m.since, m.role`;
    expect(JSON.stringify(nativeGraph.query(READ))).toEqual(JSON.stringify(tsQuery(tsGraph, READ)));
  });
});

suite('required-constraint differential (TS vs native)', () => {
  // Same INSERT/SET/REMOVE/label sequence on both engines, comparing every write
  // outcome (same ConstraintViolation, or both succeed) + the final state.
  const SCRIPT: Array<{ label: string; sql: string }> = [
    { label: 'insert with required ok', sql: `INSERT (:Acct {email: 'a@x.io', name: 'A'})` },
    { label: 'insert missing required → violation', sql: `INSERT (:Acct {name: 'B'})` },
    { label: 'insert null required → violation', sql: `INSERT (:Acct {email: null, name: 'C'})` },
    { label: 'different label unaffected', sql: `INSERT (:Other {name: 'O'})` },
    {
      label: 'set required to null → violation',
      sql: `MATCH (n:Acct {email: 'a@x.io'}) SET n.email = null`,
    },
    {
      label: 'set required to a new value ok',
      sql: `MATCH (n:Acct {email: 'a@x.io'}) SET n.email = 'a2@x.io'`,
    },
    {
      label: 'remove required → violation',
      sql: `MATCH (n:Acct {email: 'a2@x.io'}) REMOVE n.email`,
    },
    {
      label: 'set a non-required key ok',
      sql: `MATCH (n:Acct {email: 'a2@x.io'}) SET n.name = 'AA'`,
    },
    // Adding the constrained label to a node missing the key → violation.
    { label: 'seed a Person without email', sql: `INSERT (:Person {name: 'P'})` },
    { label: 'add :Acct to it → violation', sql: `MATCH (p:Person {name: 'P'}) SET p:Acct` },
  ];

  test('every write outcome and the final state agree across engines', () => {
    const tsGraph = tsDeserialize(SEED, 'ndjson', new Graph());
    tsGraph.createRequiredConstraint('Acct', 'email');

    const backend = createFfiBackend(LIB);
    const nativeGraph = graphFromFormat(backend, SEED, 'ndjson');
    nativeGraph.createRequiredConstraint('Acct', 'email');

    for (const { label, sql } of SCRIPT) {
      const ts = outcome(() => tsQuery(tsGraph, sql));
      const native = outcome(() => nativeGraph.query(sql));

      expect(native, `outcome mismatch: ${label}`).toEqual(ts);
    }

    const READ = `MATCH (n:Acct) RETURN n.name, n.email ORDER BY n.name`;
    expect(JSON.stringify(nativeGraph.query(READ))).toEqual(JSON.stringify(tsQuery(tsGraph, READ)));
  });

  test('declare-time rejection agrees across engines (existing data missing the key)', () => {
    const missing = [
      '{"type":"node","id":"1","labels":["Acct"],"properties":{"email":"a@x.io"}}',
      '{"type":"node","id":"2","labels":["Acct"],"properties":{"name":"no-email"}}',
    ].join('\n');

    const tsGraph = tsDeserialize(missing, 'ndjson', new Graph());
    const backend = createFfiBackend(LIB);
    const nativeGraph = graphFromFormat(backend, missing, 'ndjson');

    const ts = outcome(() => tsGraph.createRequiredConstraint('Acct', 'email'));
    const native = outcome(() => nativeGraph.createRequiredConstraint('Acct', 'email'));

    expect(native).toEqual(ts);
    expect(ts).toEqual({ code: 'E_CONSTRAINT_VIOLATION' });
  });
});

suite('type-constraint differential (TS vs native)', () => {
  // A `number` type constraint on Acct.age: the same INSERT/SET sequence on both
  // engines, comparing each write outcome + the final state.
  const SCRIPT: Array<{ label: string; sql: string }> = [
    { label: 'insert right type ok', sql: `INSERT (:Acct {age: 30, name: 'A'})` },
    { label: 'insert wrong type → violation', sql: `INSERT (:Acct {age: 'old', name: 'B'})` },
    { label: 'insert null (exempt) ok', sql: `INSERT (:Acct {age: null, name: 'N'})` },
    { label: 'insert absent (exempt) ok', sql: `INSERT (:Acct {name: 'X'})` },
    { label: 'different label unaffected', sql: `INSERT (:Other {age: 'text'})` },
    {
      label: 'set wrong type → violation',
      sql: `MATCH (n:Acct {name: 'A'}) SET n.age = 'nope'`,
    },
    {
      label: 'set right type ok',
      sql: `MATCH (n:Acct {name: 'A'}) SET n.age = 31`,
    },
    {
      label: 'set null (exempt) ok',
      sql: `MATCH (n:Acct {name: 'A'}) SET n.age = null`,
    },
  ];

  test('every write outcome and the final state agree across engines', () => {
    const tsGraph = tsDeserialize(SEED, 'ndjson', new Graph());
    tsGraph.createTypeConstraint('Acct', 'age', 'number');

    const backend = createFfiBackend(LIB);
    const nativeGraph = graphFromFormat(backend, SEED, 'ndjson');
    nativeGraph.createTypeConstraint('Acct', 'age', 'number');

    for (const { label, sql } of SCRIPT) {
      const ts = outcome(() => tsQuery(tsGraph, sql));
      const native = outcome(() => nativeGraph.query(sql));

      expect(native, `outcome mismatch: ${label}`).toEqual(ts);
    }

    const READ = `MATCH (n:Acct) RETURN n.name, n.age ORDER BY n.name`;
    expect(JSON.stringify(nativeGraph.query(READ))).toEqual(JSON.stringify(tsQuery(tsGraph, READ)));
  });

  test('declare-time rejection agrees across engines (existing data has wrong type)', () => {
    const wrong = [
      '{"type":"node","id":"1","labels":["Acct"],"properties":{"age":30}}',
      '{"type":"node","id":"2","labels":["Acct"],"properties":{"age":"old"}}',
    ].join('\n');

    const tsGraph = tsDeserialize(wrong, 'ndjson', new Graph());
    const backend = createFfiBackend(LIB);
    const nativeGraph = graphFromFormat(backend, wrong, 'ndjson');

    const ts = outcome(() => tsGraph.createTypeConstraint('Acct', 'age', 'number'));
    const native = outcome(() => nativeGraph.createTypeConstraint('Acct', 'age', 'number'));

    expect(native).toEqual(ts);
    expect(ts).toEqual({ code: 'E_CONSTRAINT_VIOLATION' });
  });

  test('unknown scalar type name is rejected (InvalidValue) across engines', () => {
    const tsGraph = tsDeserialize(SEED, 'ndjson', new Graph());
    const backend = createFfiBackend(LIB);
    const nativeGraph = graphFromFormat(backend, SEED, 'ndjson');

    const ts = outcome(() => tsGraph.createTypeConstraint('Acct', 'age', 'int' as never));
    const native = outcome(() => nativeGraph.createTypeConstraint('Acct', 'age', 'int' as never));

    expect(native).toEqual(ts);
    expect(ts).toEqual({ code: 'E_INVALID_VALUE' });
  });
});
