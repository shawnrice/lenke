import { describe, expect, test } from 'bun:test';

import { ErrorCode, hasErrorCode } from '@lenke/errors';

import { Graph } from './Graph.js';
import { parseDate } from '../temporal.js';

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
    expect(isCV(() => g.addVertex({ id: 'l', labels: ['P'], properties: { tags: 'x' } }))).toBe(true);

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
