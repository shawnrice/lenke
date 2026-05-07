import { identity } from '@pl-graph/utils';
import type { TreeNode } from './TreeNode.js';
import type { SerializedTreeNode } from './types.js';

export const serialize = <T>(
  node: TreeNode<T>,
  serializeValue = identity,
): SerializedTreeNode<T>[] =>
  node.castBreadthFirst().map((x) => ({
    id: x.id,
    parentId: x.parent?.id ?? null,
    value: serializeValue(x.value),
  }));
