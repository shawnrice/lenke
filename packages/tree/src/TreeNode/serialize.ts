import { identity } from '@lenke/utils';

import type { TreeNode } from './TreeNode.js';
import type { SerializedTreeNode } from './types.js';

/**
 * Serialize a tree to a flat, breadth-first record array. `serializeValue` may
 * transform each node value `T → R` (e.g. into a storage-friendly form); it
 * defaults to identity, in which case `R` is simply `T`.
 */
export const serialize = <T, R = T>(
  node: TreeNode<T>,
  serializeValue: (value: T) => R = identity as unknown as (value: T) => R,
): SerializedTreeNode<R>[] =>
  node.castBreadthFirst().map((x) => ({
    id: x.id,
    parentId: x.parent?.id ?? null,
    value: serializeValue(x.value),
  }));
