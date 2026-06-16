import { ErrorCode, PlGraphError } from '@pl-graph/errors';
import { identity } from '@pl-graph/utils';
import { TreeNode } from './TreeNode.js';
import type { SerializedTreeNode } from './types.js';

export const deserialize = <T>(
  serialized: SerializedTreeNode<T>[],
  deserializeValue: (x: any) => T = identity,
): TreeNode<T> => {
  const nodeMap = new Map<string, TreeNode<T>>();

  let root: TreeNode<T> | null = null;

  for (const x of serialized) {
    if (x.parentId && nodeMap.has(x.parentId)) {
      const parent = nodeMap.get(x.parentId)!;
      const child = parent.createChild(deserializeValue(x.value), x.id);
      nodeMap.set(child.id, child);
    } else {
      if (root) {
        throw new PlGraphError('More than one root', { code: ErrorCode.InvalidTree });
      }

      root = TreeNode.from(deserializeValue(x.value), x.id);
      nodeMap.set(root.id, root);
    }
  }

  if (!root) {
    throw new PlGraphError('Failed to find a root node', { code: ErrorCode.InvalidTree });
  }

  return root;
};
