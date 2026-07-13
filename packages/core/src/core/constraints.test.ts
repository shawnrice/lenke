import { describe, expect, test } from 'bun:test';

import { ErrorCode, hasErrorCode } from '@lenke/errors';

import { parseDate } from '../temporal.js';
import { Graph } from './Graph.js';

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }

  return undefined;
};

const isCV = (fn: () => unknown): boolean =>
  hasErrorCode(thrown(fn), ErrorCode.ConstraintViolation);

describe('R-CONSTRAINTS: required', () => {
  test('declaring over already-violating data throws', () => {
    const g = new Graph();
    g.addVertex({ id: 'a', labels: ['User'], properties: {} }); // no email
    expect(isCV(() => g.createRequiredConstraint('User', 'email'))).toBe(true);
  });

  test('addVertex is rejected when a required key is absent or null', () => {
    const g = new Graph();
    g.addVertex({ id: 'seed', labels: ['User'], properties: { email: 's@x.io' } });
    g.createRequiredConstraint('User', 'email');

    expect(isCV(() => g.addVertex({ id: 'b', labels: ['User'], properties: {} }))).toBe(true);
    expect(
      isCV(() => g.addVertex({ id: 'c', labels: ['User'], properties: { email: null } })),
    ).toBe(true);
    // present (even '' / false / 0) satisfies; the write commits
    expect(
      g.addVertex({ id: 'd', labels: ['User'], properties: { email: '' } }).getProperty('email'),
    ).toBe('');
    // a vertex without the constrained label is unaffected
    expect(g.addVertex({ id: 'e', labels: ['Bot'], properties: {} })).toBeTruthy();
  });

  test('a required key cannot be nulled or removed', () => {
    const g = new Graph();
    const v = g.addVertex({ id: 'u', labels: ['User'], properties: { email: 'u@x.io' } });
    g.createRequiredConstraint('User', 'email');

    expect(isCV(() => v.setProperty('email', null))).toBe(true);
    expect(isCV(() => v.removeProperty('email'))).toBe(true);
    expect(isCV(() => v.setProperties({ email: null, name: 'U' }))).toBe(true);
    expect(isCV(() => v.removeProperties(['email']))).toBe(true);
    // a non-required key is free to change
    v.setProperty('name', 'U');
    expect(v.getProperty('name')).toBe('U');
    // the required key survived every rejected write
    expect(v.getProperty('email')).toBe('u@x.io');
  });

  test('adding a label brings its required keys into force', () => {
    const g = new Graph();
    g.createRequiredConstraint('User', 'email');
    const p = g.addVertex({ id: 'p', labels: ['Person'], properties: {} });
    expect(isCV(() => g.addLabelToVertex('User', p))).toBe(true); // missing email
    p.setProperty('email', 'p@x.io');
    expect(g.addLabelToVertex('User', p)).toBeTruthy(); // now satisfied
  });

  test('the constraint registry is queryable', () => {
    const g = new Graph();
    g.createRequiredConstraint('User', 'email');
    g.createRequiredConstraint('User', 'name');
    expect(g.hasRequiredConstraint('User', 'email')).toBe(true);
    expect(g.hasRequiredConstraint('User', 'age')).toBe(false);
    expect(g.requiredKeys('User')).toEqual(['email', 'name']);
    expect(g.requiredConstraints()).toEqual([
      ['User', 'email'],
      ['User', 'name'],
    ]);
    g.dropRequiredConstraint('User', 'email');
    expect(g.requiredKeys('User')).toEqual(['name']);
  });
});

describe('R-CONSTRAINTS: type', () => {
  test('declaring over wrong-typed data throws', () => {
    const g = new Graph();
    g.addVertex({ id: 'a', labels: ['P'], properties: { age: 'old' } });
    expect(isCV(() => g.createTypeConstraint('P', 'age', 'number'))).toBe(true);
  });

  test('addVertex/setProperty reject a wrong-typed value; null/absent are exempt', () => {
    const g = new Graph();
    g.createTypeConstraint('P', 'age', 'number');
    g.createTypeConstraint('P', 'name', 'string');
    g.createTypeConstraint('P', 'dob', 'date');
    g.createTypeConstraint('P', 'tags', 'list');

    expect(isCV(() => g.addVertex({ id: 'a', labels: ['P'], properties: { age: 'forty' } }))).toBe(
      true,
    );
    expect(isCV(() => g.addVertex({ id: 'b', labels: ['P'], properties: { name: 5 } }))).toBe(true);
    expect(isCV(() => g.addVertex({ id: 'c', labels: ['P'], properties: { dob: 'nope' } }))).toBe(
      true,
    );
    expect(isCV(() => g.addVertex({ id: 'l', labels: ['P'], properties: { tags: 'x' } }))).toBe(
      true,
    );

    // right type commits; a matching temporal/list is fine
    const ok = g.addVertex({
      id: 'ok',
      labels: ['P'],
      properties: { age: 40, name: 'A', dob: parseDate('2000-01-01'), tags: ['x'] },
    });
    expect(ok.getProperty('age')).toBe(40);
    // null and absent are type-exempt (use `required` for presence)
    expect(g.addVertex({ id: 'n', labels: ['P'], properties: { age: null } })).toBeTruthy();
    expect(g.addVertex({ id: 'm', labels: ['P'], properties: {} })).toBeTruthy();

    // setProperty enforces the type; null is still exempt
    expect(isCV(() => ok.setProperty('age', 'x'))).toBe(true);
    ok.setProperty('age', 41);
    expect(ok.getProperty('age')).toBe(41);
    ok.setProperty('age', null); // exempt
    expect(ok.getProperty('age')).toBeNull();
  });

  test('the registry is queryable', () => {
    const g = new Graph();
    g.createTypeConstraint('P', 'age', 'number');
    g.createTypeConstraint('P', 'name', 'string');
    expect(g.typeConstraint('P', 'age')).toBe('number');
    expect(g.typeConstraint('P', 'missing')).toBeUndefined();
    expect(g.typeConstraints()).toEqual([
      ['P', 'age', 'number'],
      ['P', 'name', 'string'],
    ]);
    g.dropTypeConstraint('P', 'age');
    expect(g.typeConstraint('P', 'age')).toBeUndefined();
  });
});

// V3 (Rafael, r7): a unique constraint used to be enforced only on the GQL
// `INSERT`/`SET` path — the direct `addVertex`/`setProperty` API bypassed it,
// yielding count=2 with no throw. It's now a core invariant at the mutation
// chokepoint, so every write path agrees.
describe('R-CONSTRAINTS: unique (direct-API enforcement, V3)', () => {
  test('addVertex rejects a duplicate under a unique constraint', () => {
    const g = new Graph();
    g.createUniqueConstraint('User', 'email');

    g.addVertex({ id: 'a', labels: ['User'], properties: { email: 'x@y.io' } });

    expect(
      isCV(() => g.addVertex({ id: 'b', labels: ['User'], properties: { email: 'x@y.io' } })),
    ).toBe(true);
    // A different value, a different label, and null are all fine.
    expect(
      g.addVertex({ id: 'c', labels: ['User'], properties: { email: 'z@y.io' } }),
    ).toBeTruthy();
    expect(
      g.addVertex({ id: 'd', labels: ['Other'], properties: { email: 'x@y.io' } }),
    ).toBeTruthy();
    expect(g.addVertex({ id: 'n1', labels: ['User'], properties: { email: null } })).toBeTruthy();
    expect(g.addVertex({ id: 'n2', labels: ['User'], properties: { email: null } })).toBeTruthy();
    // The rejected insert left no trace.
    const emails = [...g.getVerticesByLabel('User')].filter(
      (v) => v.getProperty('email') === 'x@y.io',
    );
    expect(emails).toHaveLength(1);
  });

  test('setProperty rejects a collision under a unique constraint', () => {
    const g = new Graph();
    g.createUniqueConstraint('User', 'email');
    g.addVertex({ id: 'a', labels: ['User'], properties: { email: 'x@y.io' } });
    const b = g.addVertex({ id: 'b', labels: ['User'], properties: { email: 'z@y.io' } });

    expect(isCV(() => b.setProperty('email', 'x@y.io'))).toBe(true);
    // Re-setting a vertex's own value is not a self-collision.
    b.setProperty('email', 'z@y.io');
    expect(b.getProperty('email')).toBe('z@y.io');
  });
});

// Edge-side constraints are a direct mirror of the vertex ones, keyed by edge
// TYPE, enforced at the addEdge gate + Edge property mutators + addLabelToEdge,
// and deferred to commit inside a transaction (R-TX). Byte-identical to Rust.
describe('R-CONSTRAINTS: edge unique/required/type', () => {
  // Two anchor vertices for edges; every edge below runs between them (parallel
  // edges are fine — an LPG allows many edges between the same pair).
  const anchors = (g: Graph): [ReturnType<Graph['addVertex']>, ReturnType<Graph['addVertex']>] => [
    g.addVertex({ labels: ['N'], properties: {} }),
    g.addVertex({ labels: ['N'], properties: {} }),
  ];
  const edge = (
    g: Graph,
    a: ReturnType<Graph['addVertex']>,
    b: ReturnType<Graph['addVertex']>,
    type: string,
    properties: Record<string, unknown>,
  ) => g.addEdge({ from: a, to: b, labels: [type], properties });

  test('declaring over already-violating edges throws (unique/required/type)', () => {
    const g = new Graph();
    const [a, b] = anchors(g);
    edge(g, a, b, 'FOLLOWS', { tag: 'x' });
    edge(g, a, b, 'FOLLOWS', { tag: 'x' });
    expect(isCV(() => g.createEdgeUniqueConstraint('FOLLOWS', 'tag'))).toBe(true);

    edge(g, a, b, 'REL', {}); // no `since`
    expect(isCV(() => g.createEdgeRequiredConstraint('REL', 'since'))).toBe(true);

    edge(g, a, b, 'TYP', { since: 'old' });
    expect(isCV(() => g.createEdgeTypeConstraint('TYP', 'since', 'number'))).toBe(true);
  });

  test('the addEdge gate enforces unique (null/other-type/other-value exempt)', () => {
    const g = new Graph();
    const [a, b] = anchors(g);
    g.createEdgeUniqueConstraint('FOLLOWS', 'tag');
    edge(g, a, b, 'FOLLOWS', { tag: 'x' });

    expect(isCV(() => edge(g, a, b, 'FOLLOWS', { tag: 'x' }))).toBe(true);
    // A different value, a different type, and null are all fine.
    expect(edge(g, a, b, 'FOLLOWS', { tag: 'y' })).toBeTruthy();
    expect(edge(g, a, b, 'LIKES', { tag: 'x' })).toBeTruthy();
    expect(edge(g, a, b, 'FOLLOWS', { tag: null })).toBeTruthy();
    expect(edge(g, a, b, 'FOLLOWS', { tag: null })).toBeTruthy();
    // The rejected insert left no trace: exactly one FOLLOWS tag='x'.
    const x = [...g.getEdgesByLabel('FOLLOWS')].filter((e) => e.getProperty('tag') === 'x');
    expect(x).toHaveLength(1);
  });

  test('the addEdge gate enforces required + type; setProperty too', () => {
    const g = new Graph();
    const [a, b] = anchors(g);
    g.createEdgeRequiredConstraint('REL', 'since');
    g.createEdgeTypeConstraint('REL', 'since', 'number');

    expect(isCV(() => edge(g, a, b, 'REL', {}))).toBe(true); // missing required
    expect(isCV(() => edge(g, a, b, 'REL', { since: null }))).toBe(true); // null required
    expect(isCV(() => edge(g, a, b, 'REL', { since: 'old' }))).toBe(true); // wrong type
    const e = edge(g, a, b, 'REL', { since: 2020 }); // ok

    // A required key cannot be nulled or removed; a wrong type is rejected.
    expect(isCV(() => e.setProperty('since', null))).toBe(true);
    expect(isCV(() => e.removeProperty('since'))).toBe(true);
    expect(isCV(() => e.setProperty('since', 'nope'))).toBe(true);
    e.setProperty('since', 2021); // right type, present
    expect(e.getProperty('since')).toBe(2021);
  });

  test('setProperty enforces edge unique; self-set is not a collision', () => {
    const g = new Graph();
    const [a, b] = anchors(g);
    g.createEdgeUniqueConstraint('FOLLOWS', 'tag');
    edge(g, a, b, 'FOLLOWS', { tag: 'x' });
    const e2 = edge(g, a, b, 'FOLLOWS', { tag: 'y' });

    expect(isCV(() => e2.setProperty('tag', 'x'))).toBe(true);
    e2.setProperty('tag', 'y'); // re-setting its own value is fine
    expect(e2.getProperty('tag')).toBe('y');
  });

  test('adding an edge type brings its required keys into force', () => {
    const g = new Graph();
    const [a, b] = anchors(g);
    g.createEdgeRequiredConstraint('AUDITED', 'at');
    const e = edge(g, a, b, 'PLAIN', {}); // lacks `at`
    expect(isCV(() => g.addLabelToEdge('AUDITED', e))).toBe(true);
    e.setProperty('at', 1);
    expect(g.addLabelToEdge('AUDITED', e)).toBeTruthy(); // now satisfied
  });

  test('the edge registries are queryable', () => {
    const g = new Graph();
    g.createEdgeUniqueConstraint('FOLLOWS', 'tag');
    g.createEdgeRequiredConstraint('FOLLOWS', 'since');
    g.createEdgeTypeConstraint('FOLLOWS', 'since', 'number');
    expect(g.hasEdgeUniqueConstraint('FOLLOWS', 'tag')).toBe(true);
    expect(g.edgeUniqueKeys('FOLLOWS')).toEqual(['tag']);
    expect(g.edgeUniqueConstraintList()).toEqual([['FOLLOWS', 'tag']]);
    expect(g.hasEdgeRequiredConstraint('FOLLOWS', 'since')).toBe(true);
    expect(g.edgeRequiredKeys('FOLLOWS')).toEqual(['since']);
    expect(g.edgeTypeConstraint('FOLLOWS', 'since')).toBe('number');
    expect(g.edgeTypeConstraintList()).toEqual([['FOLLOWS', 'since', 'number']]);
    g.dropEdgeUniqueConstraint('FOLLOWS', 'tag');
    expect(g.hasEdgeUniqueConstraint('FOLLOWS', 'tag')).toBe(false);
  });

  test('DEFERRED: an intermediate edge violation resolved before commit commits; unresolved rolls back', () => {
    const g = new Graph();
    const [a, b] = anchors(g);
    g.createEdgeRequiredConstraint('REL', 'since');
    g.createEdgeUniqueConstraint('REL', 'tag');

    // Resolved-before-commit: an edge inserted without its required key, and two
    // edges that momentarily share a unique value, both settle before commit.
    g.transaction((tx) => {
      const e1 = tx.addEdge({
        from: a,
        to: b,
        labels: ['REL'],
        properties: { since: 1, tag: 'x' },
      });
      // A sibling that momentarily collides on `tag`, then is disambiguated.
      const e2 = tx.addEdge({
        from: a,
        to: b,
        labels: ['REL'],
        properties: { since: 2, tag: 'x' },
      });
      e2.setProperty('tag', 'y');
      // An edge added missing its required key, then given it before commit.
      const e3 = tx.addEdge({ from: a, to: b, labels: ['REL'], properties: { tag: 'z' } });
      e3.setProperty('since', 3);
      expect(e1.getProperty('tag')).toBe('x');
    });
    expect(g.edgeCount).toBe(3); // all three committed

    // Unresolved required violation → the whole transaction rolls back.
    expect(
      isCV(() =>
        g.transaction((tx) => {
          tx.addEdge({ from: a, to: b, labels: ['REL'], properties: { tag: 'w' } }); // never given `since`
        }),
      ),
    ).toBe(true);
    expect(g.edgeCount).toBe(3); // rolled back — no new edge

    // Unresolved unique collision → rolls back too.
    expect(
      isCV(() =>
        g.transaction((tx) => {
          tx.addEdge({ from: a, to: b, labels: ['REL'], properties: { since: 9, tag: 'x' } }); // dup of e1.tag
        }),
      ),
    ).toBe(true);
    expect(g.edgeCount).toBe(3);
  });
});
