import { describe, expect, test } from 'bun:test';

import { TreeNode } from './TreeNode.js';

//        a
//       / \
//      b   c
//     / \
//    d   e
const build = (): TreeNode<string> => {
  const a = TreeNode.from('a', 'a');
  const b = a.createChild('b', 'b');
  a.createChild('c', 'c');
  b.createChild('d', 'd');
  b.createChild('e', 'e');

  return a;
};

describe('TreeNode traversal orders', () => {
  test('pre-order (depthFirst): parent before children', () => {
    expect(build().castDepthFirstValue()).toEqual(['a', 'b', 'd', 'e', 'c']);
  });

  test('breadth-first: level by level', () => {
    expect(build().castBreadthFirstValue()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('post-order: children before parent (bottom-up)', () => {
    expect(build().castPostOrderValue()).toEqual(['d', 'e', 'b', 'c', 'a']);
  });
});

describe('TreeNode.map (structure-preserving)', () => {
  test('rebuilds the same shape and ids with transformed values', () => {
    const a = build();
    const upper = a.map((s) => s.toUpperCase());

    expect(upper.castDepthFirstValue()).toEqual(['A', 'B', 'D', 'E', 'C']);
    // same shape + ids
    expect([...upper].map((n) => n.id)).toEqual([...a].map((n) => n.id));
    // original is untouched (new tree)
    expect(a.castDepthFirstValue()).toEqual(['a', 'b', 'd', 'e', 'c']);
  });

  test('can change the value type', () => {
    const lengths = build().map((s) => s.length);
    expect(lengths.value).toBe(1);
    expect(lengths.castDepthFirstValue().every((n) => n === 1)).toBe(true);
  });
});

describe('TreeNode.fold (bottom-up catamorphism)', () => {
  test('counts nodes from child results', () => {
    const count = build().fold<number>((_v, kids) => 1 + kids.reduce((a, b) => a + b, 0));
    expect(count).toBe(5);
  });

  test('computes height', () => {
    const height = build().fold<number>((_v, kids) => 1 + Math.max(0, ...kids));
    expect(height).toBe(3); // a -> b -> d
  });

  test('a leaf folds with no child results', () => {
    const leaf = TreeNode.from('x');
    expect(leaf.fold<number>((_v, kids) => kids.length)).toBe(0);
  });
});

describe('TreeNode serialize / deserialize / clone / search', () => {
  test('serialize → deserialize round-trips structurally', () => {
    const a = build();
    const restored = TreeNode.deserialize(TreeNode.serialize(a));
    expect(TreeNode.equals(a, restored)).toBe(true);
    expect(restored.castDepthFirstValue()).toEqual(['a', 'b', 'd', 'e', 'c']);
  });

  test('clone is equal but a distinct instance', () => {
    const a = build();
    const c = a.clone();
    expect(c).not.toBe(a);
    expect(TreeNode.equals(a, c)).toBe(true);
  });

  test('getDescendantById finds a node or returns null', () => {
    const a = build();
    expect(a.getDescendantById('e')?.value).toBe('e');
    expect(a.getDescendantById('nope')).toBeNull();
  });
});
