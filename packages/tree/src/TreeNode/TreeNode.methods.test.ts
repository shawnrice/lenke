/* eslint-disable max-lines-per-function */
// Broad behavioral coverage for the TreeNode surface that the contract/traversal
// suites don't already pin: removal in all its shapes, the upward queries
// (depth/root/ancestors), membership, value mutation, JSON shape, custom
// serialize/deserialize (and its error paths), and the static helpers.
import { describe, expect, test } from 'bun:test';

import { ErrorCode, hasErrorCode } from '@lenke/errors';

import { TreeNode } from './TreeNode.js';
import type { SerializedTreeNode } from './types.js';

const caughtFrom = (fn: () => void): unknown => {
  try {
    fn();

    return undefined;
  } catch (e) {
    return e;
  }
};

//        a
//       / \
//      b   c
//     / \
//    d   e
const build = (): Record<'a' | 'b' | 'c' | 'd' | 'e', TreeNode<string>> => {
  const a = TreeNode.from('a', 'a');
  const b = a.createChild('b', 'b');
  const c = a.createChild('c', 'c');
  const d = b.createChild('d', 'd');
  const e = b.createChild('e', 'e');

  return { a, b, c, d, e };
};

describe('TreeNode upward queries', () => {
  test('root resolves from any node; isRoot only on the root', () => {
    const { a, d } = build();

    expect(d.root).toBe(a);
    expect(a.isRoot()).toBe(true);
    expect(d.isRoot()).toBe(false);
  });

  test('depth counts edges to the root', () => {
    const { a, b, d } = build();

    expect(a.depth).toBe(0);
    expect(b.depth).toBe(1);
    expect(d.depth).toBe(2);
  });

  test('ancestors / getAncestors are ordered root-first', () => {
    const { a, b, d } = build();

    expect(d.getAncestors()).toEqual([a, b]);
    expect(d.ancestors.map((n) => n.id)).toEqual(['a', 'b']);
    expect(a.getAncestors()).toEqual([]);
  });
});

describe('TreeNode membership & children', () => {
  test('contains is true for any descendant, false otherwise', () => {
    const { a, c, d } = build();

    expect(a.contains(d)).toBe(true); // grandchild
    expect(a.contains(c)).toBe(true); // child
    expect(c.contains(d)).toBe(false); // unrelated branch
    expect(d.contains(a)).toBe(false); // upward is not "contains"
  });

  test('hasChild / childCount / children reflect direct children only', () => {
    const { a, b, c, d } = build();

    expect(a.hasChild(b)).toBe(true);
    expect(a.hasChild(d)).toBe(false); // grandchild
    expect(a.childCount).toBe(2);
    expect(a.children).toEqual([b, c]); // insertion order
  });

  test('setValue maps the value in place and returns the node', () => {
    const { d } = build();
    const ret = d.setValue((v) => `${v}!`);

    expect(d.value).toBe('d!');
    expect(ret).toBe(d);
  });
});

describe('TreeNode breadth/depth filters', () => {
  test('filterBreadthFirst yields matches level by level', () => {
    const { a } = build();
    const ids = Array.from(a.filterBreadthFirst((n) => n.id !== 'a')).map((n) => n.id);

    expect(ids).toEqual(['b', 'c', 'd', 'e']);
  });

  test('filterDepthFirst yields matches in pre-order', () => {
    const { a } = build();
    const ids = Array.from(a.filterDepthFirst((n) => n.childCount === 0)).map((n) => n.id);

    expect(ids).toEqual(['d', 'e', 'c']); // leaves, pre-order
  });
});

describe('TreeNode.remove / removeTreeNode shapes', () => {
  test('removing a lone root returns null', () => {
    const root = TreeNode.from('only');

    expect(root.remove()).toBeNull();
  });

  test('removing a root with one child promotes the child to root', () => {
    const root = TreeNode.from('root', 'root');
    const child = root.createChild('child', 'child');

    const next = root.remove();

    expect(next).toBe(child);
    expect(child.parent).toBeNull();
    expect(child.isRoot()).toBe(true);
  });

  test('removing a root with multiple children throws InvalidTree', () => {
    const { a } = build(); // a has b and c

    expect(
      hasErrorCode(
        caughtFrom(() => a.remove()),
        ErrorCode.InvalidTree,
      ),
    ).toBe(true);
  });

  test('removing a leaf detaches it and returns the root', () => {
    const { a, b, d } = build();

    expect(d.remove()).toBe(a);
    expect(d.parent).toBeNull();
    expect(b.children.map((n) => n.id)).toEqual(['e']);
  });

  test('removing a middle node reparents its children to the grandparent', () => {
    const { a, b, d, e } = build();

    expect(b.remove()).toBe(a);
    expect(b.parent).toBeNull();
    // d and e move up under a, alongside the surviving c
    expect(a.children.map((n) => n.id).sort()).toEqual(['c', 'd', 'e']);
    expect(d.parent).toBe(a);
    expect(e.parent).toBe(a);
  });
});

describe('TreeNode.toJSON shape', () => {
  test('nests children and records each parentId', () => {
    const { a } = build();
    const json = a.toJSON();

    expect(json.id).toBe('a');
    expect(json.parentId).toBeNull();
    expect(json.children.map((c) => c.id)).toEqual(['b', 'c']);

    const [b] = json.children;
    expect(b.parentId).toBe('a');
    expect(b.children.map((c) => c.id)).toEqual(['d', 'e']);
    expect(b.children[0].parentId).toBe('b');
  });
});

describe('TreeNode clone helpers', () => {
  test('cloneEntireTree clones from the root regardless of the calling node', () => {
    const { a, d } = build();
    const whole = d.cloneEntireTree();

    expect(whole.id).toBe('a'); // rooted at a, not d
    expect(TreeNode.equals(a, whole)).toBe(true);
    expect(whole).not.toBe(a);
  });
});

describe('TreeNode serialize / deserialize', () => {
  test('serialize emits a flat, breadth-first record array with parent links', () => {
    const { a } = build();
    const rows = a.serialize();

    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e']); // breadth-first
    expect(rows[0].parentId).toBeNull(); // root
    expect(rows.find((r) => r.id === 'd')?.parentId).toBe('b');
  });

  test('deserialize applies a custom value parser to each node', () => {
    const serialized: SerializedTreeNode<string>[] = [
      { id: 'r', parentId: null, value: 'a' },
      { id: 'x', parentId: 'r', value: 'b' },
      { id: 'y', parentId: 'r', value: 'c' },
    ];

    const restored = TreeNode.deserialize(serialized, (v) => v.toUpperCase());

    expect(restored.value).toBe('A');
    expect(restored.castDepthFirstValue()).toEqual(['A', 'B', 'C']);
  });

  test('serialize transforms the value type (number → string)', () => {
    const root = TreeNode.from(1, 'r');
    root.createChild(2, 'x');
    root.createChild(3, 'y');

    // R is inferred as string from the transform; rows are SerializedTreeNode<string>.
    const rows = root.serialize((n) => `#${n}`);

    expect(rows.map((r) => r.value)).toEqual(['#1', '#2', '#3']);
    // a string row feeds straight back into a number tree via the inverse parse
    const restored = TreeNode.deserialize(rows, (s) => Number(s.slice(1)));
    expect(restored.castDepthFirstValue()).toEqual([1, 2, 3]);
  });

  test('serialize ↔ deserialize round-trip a different storage type end to end', () => {
    type Point = { x: number; y: number };
    const root = TreeNode.from<Point>({ x: 1, y: 2 }, 'r');
    root.createChild({ x: 3, y: 4 }, 'c');

    // store each Point as a compact "x,y" string, then rebuild it
    const rows = TreeNode.serialize(root, (p) => `${p.x},${p.y}`);
    const restored = TreeNode.deserialize(rows, (s): Point => {
      const [x, y] = s.split(',').map(Number);

      return { x, y };
    });

    expect(restored.value).toEqual({ x: 1, y: 2 });
    expect(restored.getDescendantById('c')?.value).toEqual({ x: 3, y: 4 });
  });

  test('deserialize rejects more than one root', () => {
    const twoRoots: SerializedTreeNode<string>[] = [
      { id: 'a', parentId: null, value: 'a' },
      { id: 'b', parentId: null, value: 'b' },
    ];

    expect(
      hasErrorCode(
        caughtFrom(() => TreeNode.deserialize(twoRoots)),
        ErrorCode.InvalidTree,
      ),
    ).toBe(true);
  });

  test('deserialize rejects an empty input (no root)', () => {
    expect(
      hasErrorCode(
        caughtFrom(() => TreeNode.deserialize([])),
        ErrorCode.InvalidTree,
      ),
    ).toBe(true);
  });
});

describe('TreeNode static helpers', () => {
  test('from creates a parentless root with the given id', () => {
    const node = TreeNode.from('x', 'fixed-id');

    expect(node.id).toBe('fixed-id');
    expect(node.parent).toBeNull();
    expect(node.value).toBe('x');
  });

  test('from mints a random id when none is given', () => {
    const a = TreeNode.from('x');
    const b = TreeNode.from('x');

    expect(a.id).not.toBe(b.id);
  });

  test('equals honours a custom value comparator', () => {
    const a = TreeNode.from('HELLO', 'r');
    const b = TreeNode.from('hello', 'r');

    expect(TreeNode.equals(a, b)).toBe(false); // Object.is by default
    expect(TreeNode.equals(a, b, (x, y) => x.toLowerCase() === y.toLowerCase())).toBe(true);
  });

  test('toString renders the value', () => {
    expect(TreeNode.from('hi').toString()).toBe('TreeNode<"hi">');
  });
});
