/* eslint-disable max-lines-per-function */
import { ErrorCode, hasErrorCode } from '@pl-graph/errors';

import { TreeNode } from './TreeNode.js';
import { describe, expect, test } from 'bun:test';

// Capture whatever a thunk throws (or undefined if it doesn't).
const caughtFrom = (fn: () => void): unknown => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
};

describe('TreeNode.addChild contract: argument must be parentless', () => {
  test('addChild accepts a freshly created (parentless) node', () => {
    const root = TreeNode.from('root');
    const child = TreeNode.from('child');

    expect(() => root.addChild(child)).not.toThrow();
    expect(child.parent).toBe(root);
    expect(root.children).toContain(child);
  });

  test('addChild accepts a detached subtree', () => {
    const a = TreeNode.from('a');
    const b = a.createChild('b');
    b.createChild('c');

    b.detach();
    const newRoot = TreeNode.from('newRoot');

    expect(() => newRoot.addChild(b)).not.toThrow();
    expect(b.parent).toBe(newRoot);
  });

  test('addChild rejects a node that already has a parent (same tree)', () => {
    const a = TreeNode.from('a');
    const b = a.createChild('b');
    const c = a.createChild('c');
    const d = b.createChild('d');

    expect(() => c.addChild(d)).toThrow(/parent/i);
  });

  test('addChild rejects a node that already has a parent (different tree)', () => {
    const treeA = TreeNode.from('a');
    const treeB = TreeNode.from('b');
    const childOfB = treeB.createChild('child');

    expect(() => treeA.addChild(childOfB)).toThrow(/parent/i);
  });

  test('addChild rejects adding this tree’s own root', () => {
    const root = TreeNode.from('root');
    const child = root.createChild('child');

    expect(() => child.addChild(root)).toThrow();
  });

  test('an invalid tree operation carries ErrorCode.InvalidTree (the code is the contract)', () => {
    const root = TreeNode.from('root');
    // self-as-child
    expect(hasErrorCode(caughtFrom(() => root.addChild(root)), ErrorCode.InvalidTree)).toBe(true);
    // cycle: adding the (parentless) root under one of its own descendants
    const child = root.createChild('child');
    expect(hasErrorCode(caughtFrom(() => child.addChild(root)), ErrorCode.InvalidTree)).toBe(true);
  });

  test('the move pattern (detach + addChild) works', () => {
    const a = TreeNode.from('a');
    const b = a.createChild('b');
    const c = a.createChild('c');
    const d = b.createChild('d');

    d.detach();
    c.addChild(d);

    expect(d.parent).toBe(c);
    expect(b.children).not.toContain(d);
    expect(c.children).toContain(d);
  });
});

describe('TreeNode.equals: structural comparison', () => {
  test('two structurally identical trees are equal', () => {
    const a1 = TreeNode.from('a', 'a');
    const b1 = a1.createChild('b', 'b');
    b1.createChild('d', 'd');

    const a2 = TreeNode.from('a', 'a');
    const b2 = a2.createChild('b', 'b');
    b2.createChild('d', 'd');

    expect(TreeNode.equals(a1, a2)).toBe(true);
  });

  test('trees with same DFS sequence but different shapes are NOT equal', () => {
    // Tree 1: a -> b -> d  (d is grandchild of a)
    const a1 = TreeNode.from('a', 'a');
    const b1 = a1.createChild('b', 'b');
    b1.createChild('d', 'd');

    // Tree 2: a -> [b, d]  (d is direct child of a)
    const a2 = TreeNode.from('a', 'a');
    a2.createChild('b', 'b');
    a2.createChild('d', 'd');

    // Both yield [a, b, d] in DFS pre-order with matching ids+values,
    // but they have different shapes
    expect(TreeNode.equals(a1, a2)).toBe(false);
  });
});

describe('TreeNode.removeChild guard: ignore non-children', () => {
  test('removeChild on an unrelated node does not clear that node’s parent', () => {
    const treeA = TreeNode.from('a');
    const childOfA = treeA.createChild('child');

    const treeB = TreeNode.from('b');

    treeB.removeChild(childOfA);

    expect(childOfA.parent).toBe(treeA);
    expect(treeA.children).toContain(childOfA);
  });

  test('removeChild on a node that is not a child of this is a noop', () => {
    const a = TreeNode.from('a');
    const b = a.createChild('b');
    const c = a.createChild('c');
    const d = b.createChild('d');

    c.removeChild(d);

    expect(d.parent).toBe(b);
    expect(b.children).toContain(d);
  });

  test('removeChild on an actual child still works', () => {
    const a = TreeNode.from('a');
    const b = a.createChild('b');

    a.removeChild(b);

    expect(b.parent).toBeNull();
    expect(a.children).not.toContain(b);
  });
});
