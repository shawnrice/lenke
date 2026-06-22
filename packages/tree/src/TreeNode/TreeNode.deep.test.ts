/* eslint-disable max-lines-per-function */
// Stack-safety: every traversal/rebuild/lookup on a TreeNode is iterative, so a
// pathologically deep (linked-list-shaped) tree can't overflow the call stack.
// Each of these would throw `RangeError: Maximum call stack size exceeded` under
// the old recursive implementations — they assert both "doesn't throw" and the
// correct result. DEPTH is comfortably past Node's default recursion limit.
import { describe, expect, test } from 'bun:test';

import { TreeNode } from './TreeNode.js';

const DEPTH = 50_000;

// A degenerate chain root(0) → n1(1) → … → leaf(DEPTH-1). Built with a loop
// (createChild is O(1) and non-recursive), so construction itself is safe.
const buildChain = (n: number): { root: TreeNode<number>; leaf: TreeNode<number> } => {
  const root = TreeNode.from(0, 'n0');
  let leaf = root;

  for (let i = 1; i < n; i++) {
    leaf = leaf.createChild(i, `n${i}`);
  }

  return { root, leaf };
};

describe('TreeNode deep-tree stack safety', () => {
  test('depthFirst / castDepthFirst walk a deep chain', () => {
    const { root } = buildChain(DEPTH);
    const values = root.castDepthFirstValue();

    expect(values).toHaveLength(DEPTH);
    expect(values[0]).toBe(0);
    expect(values[DEPTH - 1]).toBe(DEPTH - 1);
  });

  test('postOrder yields leaf-first on a deep chain', () => {
    const { root } = buildChain(DEPTH);
    const post = root.castPostOrderValue();

    expect(post).toHaveLength(DEPTH);
    expect(post[0]).toBe(DEPTH - 1); // deepest first
    expect(post[DEPTH - 1]).toBe(0); // root last
  });

  test('filterDepthFirst streams matches without recursing', () => {
    const { root } = buildChain(DEPTH);
    const evens = Array.from(root.filterDepthFirst((n) => n.value % 2 === 0));

    expect(evens).toHaveLength(DEPTH / 2);
  });

  test('breadthFirst walks a deep chain', () => {
    const { root } = buildChain(DEPTH);

    expect(root.castBreadthFirst()).toHaveLength(DEPTH);
  });

  test('getDescendantById finds the deepest node (and misses cleanly)', () => {
    const { root } = buildChain(DEPTH);

    expect(root.getDescendantById(`n${DEPTH - 1}`)?.value).toBe(DEPTH - 1);
    expect(root.getDescendantById('nope')).toBeNull();
  });

  test('root / isRoot / depth / getAncestors walk up a deep chain', () => {
    const { root, leaf } = buildChain(DEPTH);

    expect(leaf.root).toBe(root);
    expect(leaf.isRoot()).toBe(false);
    expect(root.isRoot()).toBe(true);
    expect(leaf.depth).toBe(DEPTH - 1);
    expect(leaf.getAncestors()).toHaveLength(DEPTH - 1);
  });

  test('contains reaches the deepest descendant', () => {
    const { root, leaf } = buildChain(DEPTH);

    expect(root.contains(leaf)).toBe(true);
  });

  test('map rebuilds a deep chain (and leaves the original untouched)', () => {
    const { root, leaf } = buildChain(DEPTH);
    const mapped = root.map((n) => n + 1);

    expect(mapped.castDepthFirstValue()).toHaveLength(DEPTH);
    expect(mapped.getDescendantById(`n${DEPTH - 1}`)?.value).toBe(DEPTH); // (DEPTH-1)+1
    expect(leaf.value).toBe(DEPTH - 1); // original unchanged
  });

  test('fold reduces a deep chain bottom-up', () => {
    const { root } = buildChain(DEPTH);

    const count = root.fold<number>((_v, kids) => 1 + kids.reduce((a, b) => a + b, 0));
    const height = root.fold<number>((_v, kids) => 1 + Math.max(0, ...kids));

    expect(count).toBe(DEPTH);
    expect(height).toBe(DEPTH);
  });

  test('clone copies a deep chain into an equal, distinct tree', () => {
    const { root } = buildChain(DEPTH);
    const copy = root.clone();

    expect(copy).not.toBe(root);
    expect(TreeNode.equals(root, copy)).toBe(true); // equals iterates, too
  });

  test('toJSON serializes a deep chain without recursing', () => {
    const { root } = buildChain(DEPTH);
    const json = root.toJSON();

    // Walk the nested JSON iteratively and confirm the full depth survived.
    let node = json;
    let depth = 1;

    while (node.children.length > 0) {
      [node] = node.children;
      depth += 1;
    }

    expect(depth).toBe(DEPTH);
    expect(node.value).toBe(DEPTH - 1);
  });

  test('serialize / deserialize round-trip a deep chain', () => {
    const { root } = buildChain(DEPTH);
    const restored = TreeNode.deserialize(TreeNode.serialize(root));

    expect(restored.castDepthFirst()).toHaveLength(DEPTH);
    expect(TreeNode.equals(root, restored)).toBe(true);
  });

  test('the cycle check walks deep ancestors without overflowing', () => {
    const { root, leaf } = buildChain(DEPTH);

    // root is an ancestor of leaf DEPTH-1 levels up → cycle, must be rejected by
    // the upward walk traversing the whole chain.
    expect(() => leaf.addChild(root)).toThrow();

    // a brand-new node is NOT an ancestor → the up-walk traverses the full chain
    // and correctly allows it.
    const fresh = TreeNode.from(-1, 'fresh');
    expect(() => leaf.addChild(fresh)).not.toThrow();
    expect(fresh.parent).toBe(leaf);
  });

  test('removeTreeNode rebalances using the iterative root walk', () => {
    const { root, leaf } = buildChain(DEPTH);
    const newRoot = leaf.remove(); // leaf removal returns the (deep) root

    expect(newRoot).toBe(root);
    expect(leaf.parent).toBeNull();
    expect(root.castDepthFirst()).toHaveLength(DEPTH - 1);
  });
});
