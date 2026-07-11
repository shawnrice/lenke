import { describe, expect, test } from 'bun:test';

import { ErrorCode } from '@lenke/errors';

import { createTestSocialGraph } from './fixtures/createTestSocialGraph.js';
import { query } from './index.js';
import { parse } from './parser.js';

// The `_MERGE` keyed-upsert extension (node form). Behavior spec:
// docs/design/gql-extensions.md §2. Rust parity + differential land in later
// slices; this pins the TS semantics.
describe('GQL: _MERGE (keyed upsert, node form)', () => {
  const codeOf = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: unknown }).code;
    }

    throw new Error('expected a throw');
  };

  test('create path: inserts the pattern + runs _ON_CREATE', () => {
    const g = createTestSocialGraph();
    g.createUniqueConstraint('Acct', 'email');

    query(g, `_MERGE (u:Acct {email: 'a@x.io', name: 'A'}) _ON_CREATE SET u.created = 1`);

    expect(query(g, `MATCH (u:Acct {email: 'a@x.io'}) RETURN u.name, u.created`)).toEqual([
      { 'u.name': 'A', 'u.created': 1 },
    ]);
    expect(query(g, `MATCH (u:Acct) RETURN count(*) AS c`)).toEqual([{ c: 1 }]);
  });

  test('update path default = clobber payload; _ON_CREATE does not re-run; still one node', () => {
    const g = createTestSocialGraph();
    g.createUniqueConstraint('Acct', 'email');
    query(g, `_MERGE (u:Acct {email: 'a@x.io', name: 'A'}) _ON_CREATE SET u.created = 1`);

    // Same email present → clobber the payload (name), leave the key; created
    // stays (birth-only, not re-run), and no second node is created.
    query(g, `_MERGE (u:Acct {email: 'a@x.io', name: 'A2'})`);

    expect(query(g, `MATCH (u:Acct {email: 'a@x.io'}) RETURN u.name, u.created`)).toEqual([
      { 'u.name': 'A2', 'u.created': 1 },
    ]);
    expect(query(g, `MATCH (u:Acct) RETURN count(*) AS c`)).toEqual([{ c: 1 }]);
  });

  test('_ON_UPDATE SET replaces the default clobber (payload not written)', () => {
    const g = createTestSocialGraph();
    g.createUniqueConstraint('Acct', 'email');
    query(g, `_MERGE (u:Acct {email: 'a@x.io', name: 'A'})`);

    // The pattern payload `name: 'IGNORED'` is NOT written — the explicit
    // _ON_UPDATE replaces the default clobber entirely.
    query(
      g,
      `_MERGE (u:Acct {email: 'a@x.io', name: 'IGNORED'}) _ON_UPDATE SET u.name = 'FromUpdate'`,
    );

    expect(query(g, `MATCH (u:Acct {email: 'a@x.io'}) RETURN u.name`)).toEqual([
      { 'u.name': 'FromUpdate' },
    ]);
  });

  test('_ON_UPDATE_NOTHING leaves the existing element untouched', () => {
    const g = createTestSocialGraph();
    g.createUniqueConstraint('Acct', 'email');
    query(g, `_MERGE (u:Acct {email: 'a@x.io', name: 'A'})`);

    query(g, `_MERGE (u:Acct {email: 'a@x.io', name: 'IGNORED'}) _ON_UPDATE_NOTHING`);

    expect(query(g, `MATCH (u:Acct {email: 'a@x.io'}) RETURN u.name`)).toEqual([{ 'u.name': 'A' }]);
  });

  test('WHERE-gated update = last-write-wins (false predicate is a no-op)', () => {
    const g = createTestSocialGraph();
    g.createUniqueConstraint('Doc', 'id');
    query(g, `_MERGE (d:Doc {id: 1, v: 1, body: 'first'})`);

    // Incoming v (5) is newer than stored (1) → applies.
    query(g, `_MERGE (d:Doc {id: 1}) _ON_UPDATE SET d.v = 5, d.body = 'newer' WHERE d.v < 5`);
    expect(query(g, `MATCH (d:Doc {id: 1}) RETURN d.v, d.body`)).toEqual([
      { 'd.v': 5, 'd.body': 'newer' },
    ]);

    // Stored (5) is not < 3 → predicate false → no-op.
    query(g, `_MERGE (d:Doc {id: 1}) _ON_UPDATE SET d.v = 3, d.body = 'older' WHERE d.v < 3`);
    expect(query(g, `MATCH (d:Doc {id: 1}) RETURN d.v, d.body`)).toEqual([
      { 'd.v': 5, 'd.body': 'newer' },
    ]);
  });

  test('presence idiom: bare _MERGE clobbers, tracking the moving value', () => {
    const g = createTestSocialGraph();
    g.createUniqueConstraint('Presence', 'sid');
    query(g, `_MERGE (p:Presence {sid: 's1', x: 0, y: 0})`);
    query(g, `_MERGE (p:Presence {sid: 's1', x: 10, y: 20})`);

    expect(query(g, `MATCH (p:Presence) RETURN p.x, p.y`)).toEqual([{ 'p.x': 10, 'p.y': 20 }]);
    expect(query(g, `MATCH (p:Presence) RETURN count(*) AS c`)).toEqual([{ c: 1 }]);
  });

  test('no unique constraint on the label → error (can’t define the key)', () => {
    const g = createTestSocialGraph();
    expect(codeOf(() => query(g, `_MERGE (x:Nope {k: 1})`))).toBe(ErrorCode.InvalidGraphOp);
  });

  test('parse: conflicting update dispositions rejected', () => {
    expect(() =>
      parse(`_MERGE (u:Acct {email: 'a'}) _ON_UPDATE SET u.n = 1 _ON_UPDATE_NOTHING`),
    ).toThrow();
  });

  test('iso-strict dialect does not recognize _MERGE (extension gated off)', () => {
    // Under iso-strict, `_MERGE` is a plain identifier → no clause → syntax error.
    expect(() => parse(`_MERGE (u:Acct {email: 'a'})`, { dialect: 'iso-strict' })).toThrow();
    // …but it parses fine under the default (lenke) dialect.
    expect(() => parse(`_MERGE (u:Acct {email: 'a'})`)).not.toThrow();
  });
});
