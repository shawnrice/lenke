/* eslint-disable consistent-this, no-param-reassign, no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-this-alias */

import { ErrorCode, PlGraphError } from '@pl-graph/errors';
import { equals } from '@pl-graph/fp/equals';
import { identity, rando } from '@pl-graph/utils';
import { deserialize } from './deserialize.js';
import { serialize } from './serialize.js';

type UnaryFn<T = any, R = T> = (x0: T) => R;
type BinaryFn<A = any, B = A, R = A> = (x0: A, x1: B) => R;

export type TreeNodeJSON = {
  id: string;
  value: any;
  parentId: string | null;
  children: TreeNodeJSON[];
};

export type SerializedTreeNode<T> = {
  id: string;
  value: T; // well a stringified version of this
  parentId: string | null;
};

/**
 * A simple tree class with a few bells
 *
 * A TreeNode has a value. All relevant information is stored as private properties and is
 * accessed via getters. The getters return copies of everything except the TreeNodes themselves
 * in order to discourage direct mutation.
 *
 * Controlling the tree is managed via the class methods.
 *
 * This tree supports a couple of expected operations:
 *
 *   - Add a tree node from a value
 *   - Add a pre-existing tree node to be a child of another tree node
 *   - Easy root tracking
 *   - Casting depth-first
 *   - Casting breadth-first
 *   - Remove a TreeNode, making its children
 *
 *
 * Do we add map / filter / reduce ?
 */

export class TreeNode<T> {
  #id: string;

  #parent: TreeNode<T> | null;

  #value: T;

  #children: Map<string, TreeNode<T>>;

  /**
   * Deserializes a serialized TreeNode<T>
   */
  static deserialize<T>(
    serialized: SerializedTreeNode<T>[],
    deserializeValue: (x: any) => T = identity,
  ): TreeNode<T> {
    return deserialize(serialized, deserializeValue);
  }

  /**
   * Serializes the Tree from the `TreeNode` down using the serializeValue function
   */
  static serialize<T>(node: TreeNode<T>, serializeValue = identity): SerializedTreeNode<T>[] {
    return serialize(node, serializeValue);
  }

  /**
   * Checks if two Trees are equal in value and id
   *
   * Note: this uses `Object.is` equality by default to check values
   */
  static equals<T>(
    a: TreeNode<T>,
    b: TreeNode<T>,
    comparator: BinaryFn<T, T, boolean> = Object.is,
  ): boolean {
    const inner = (x: TreeNode<T>, y: TreeNode<T>): boolean =>
      x.id === y.id &&
      (x.parent?.id ?? null) === (y.parent?.id ?? null) &&
      comparator(x.value, y.value);

    return equals(a, b, inner);
  }

  /**
   * Creates a TreeNode with no parent from a value and maybe an ID
   */
  static from<T>(value: T, id?: string | null): TreeNode<T> {
    return new TreeNode<T>(null, value, id);
  }

  /**
   * Removes a TreeNode from a Tree
   */
  static removeTreeNode<T>(node: TreeNode<T>): TreeNode<T> | null {
    if (node.isRoot() && node.childCount === 0) {
      // If we have a Tree made of a single TreeNode and we remove it, then we return null
      return null;
    }

    if (node.isRoot() && node.childCount === 1) {
      // So, now we are removing the root node, and there is one child
      const [child] = node.#children.values();

      if (!child) {
        return null;
      }

      child.#parent = null;
      node.#children.delete(child.id);

      // And the child is the new root, so return that
      return child;
    }

    if (node.isRoot() && node.childCount > 1) {
      // Otherwise, it we still try to remove the root which would result in multiple trees, then
      // we'll throw an error
      throw new PlGraphError('Cannot remove the root node from a tree when the root has multiple children', {
        code: ErrorCode.InvalidTree,
      });
    }

    const nextParent = node.parent;
    if (!nextParent) {
      // We should actually not get here with any well-formed tree
      throw new PlGraphError('Cannot remove a node that has no parent', { code: ErrorCode.InvalidTree });
    }

    // Here, we have a more normal use case of removing a leaf node or a branch
    node.detach();

    for (const child of node.children) {
      child.detach();
      nextParent.addChild(child);
    }

    return nextParent.root;
  }

  private constructor(parent: TreeNode<T> | null, value: T, id: string | null = null) {
    this.#value = value;
    this.#parent = parent ?? null;
    this.#id = id ?? rando();
    this.#children = new Map();
  }

  get id(): string {
    return this.#id;
  }

  get parent(): TreeNode<T> | null {
    return this.#parent ?? null;
  }

  get root(): TreeNode<T> {
    return this.#parent?.root ?? this;
  }

  get children(): TreeNode<T>[] {
    return Array.from(this.#children.values());
  }

  get childCount(): number {
    return this.#children.size;
  }

  get ancestors(): TreeNode<T>[] {
    return this.getAncestors();
  }

  get depth(): number {
    let count = 0;
    let node = this.#parent;
    while (node) {
      count++;
      node = node.#parent;
    }
    return count;
  }

  get value(): T {
    return this.#value;
  }

  /**
   * Adds a parentless TreeNode<T> as a child of this TreeNode<T>
   *
   * The argument must have no parent. If you want to move a node from elsewhere,
   * call `node.detach()` first.
   */
  addChild(node: TreeNode<T>): TreeNode<T> {
    if (node === this) {
      throw new PlGraphError('Cannot add a node as a child of itself', { code: ErrorCode.InvalidTree });
    }

    if (node.parent !== null) {
      throw new PlGraphError('Cannot add a node that already has a parent. Call detach() first to move it.', {
        code: ErrorCode.InvalidTree,
      });
    }

    if (node.contains(this)) {
      throw new PlGraphError('Cannot add a node whose subtree contains this node (would create a cycle)', {
        code: ErrorCode.InvalidTree,
      });
    }

    this.#children.set(node.id, node);
    node.#parent = this;

    return this;
  }

  /**
   * Removes a child. No-op if the node is not actually a child of this.
   *
   * @returns The current tree node
   */
  removeChild(node: TreeNode<T>): TreeNode<T> {
    if (!this.#children.has(node.id)) {
      return this;
    }

    this.#children.delete(node.id);
    node.#parent = null;

    return this;
  }

  /**
   * Adds a child
   *
   * @returns The new child TreeNode
   */
  createChild(value: T, id: string | null = null): TreeNode<T> {
    const node = new TreeNode(this, value, id);
    this.#children.set(node.id, node);
    return node;
  }

  /**
   * Checks if a TreeNode has the passed TreeNode as a child
   */
  hasChild(node: TreeNode<T>): boolean {
    return this.#children.has(node.id);
  }

  /**
   * Detaches this node and its children to be a SubTree
   */
  detach(): TreeNode<T> {
    if (this.#parent) {
      this.#parent?.removeChild(this);
      this.#parent = null;
    }

    return this;
  }

  /**
   * Removes this TreeNode from the Tree
   *
   * Returns the root of the Tree
   */
  remove(): TreeNode<T> | null {
    return TreeNode.removeTreeNode(this);
  }

  /**
   * Checks if a `TreeNode<T>` is a root
   */
  isRoot(): boolean {
    return this.root === this;
  }

  /**
   * Checks if a TreeNode contains another TreeNode as a descendant
   */
  contains(needle: TreeNode<T>): boolean {
    const queue: TreeNode<T>[] = Array.from(this.#children.values());
    let head = 0;

    while (head < queue.length) {
      const node = queue[head++];

      if (node === needle) {
        return true;
      }

      for (const child of node.#children.values()) {
        queue.push(child);
      }
    }

    return false;
  }

  /**
   * Depth first iterator for TreeNodes
   */
  *depthFirst(): Generator<TreeNode<T>> {
    yield this;

    for (const child of this.#children.values()) {
      yield* child.depthFirst();
    }
  }

  /**
   * Filter Breadth First, returns a generator of TreeNodes that match the predicate
   */
  *filterBreadthFirst(predicate: UnaryFn<TreeNode<T>, boolean>): Generator<TreeNode<T>> {
    const queue: TreeNode<T>[] = [this];
    let head = 0;

    while (head < queue.length) {
      const node = queue[head++];

      if (predicate(node)) {
        yield node;
      }

      for (const child of node.#children.values()) {
        queue.push(child);
      }
    }
  }

  /**
   * The iterator for a TreeNode is depth-first
   */
  *[Symbol.iterator](): Generator<TreeNode<T>, void> {
    yield* this.depthFirst();
  }

  /**
   * Casts the tree depth-first into an array of TreeNode<T>
   */
  castDepthFirst(): TreeNode<T>[] {
    return Array.from(this);
  }

  /**
   * Filter Depth First, returns a generator of TreeNodes that match the predicate
   */
  *filterDepthFirst(predicate: UnaryFn<TreeNode<T>, boolean>): Generator<TreeNode<T>> {
    if (predicate(this)) {
      yield this;
    }

    for (const child of this.#children.values()) {
      yield* child.filterDepthFirst(predicate);
    }
  }

  /**
   * Casts the tree depth-first into an array of T, stripping away
   * the TreeNode parts
   */
  castDepthFirstValue(): T[] {
    return this.castDepthFirst().map((x) => x.#value);
  }

  forEach(callback: UnaryFn<TreeNode<T>, any>): void {
    for (const node of this) {
      callback(node);
    }
  }

  /**
   * A breadth-first iterator for tree nodes
   */
  *breadthFirst(): Generator<TreeNode<T>> {
    const queue: TreeNode<T>[] = [this];
    let head = 0;

    while (head < queue.length) {
      const node = queue[head++];

      for (const child of node.#children.values()) {
        queue.push(child);
      }

      yield node;
    }
  }

  /**
   * Casts the tree breadth-first into an array of TreeNode<T>
   */
  castBreadthFirst(): TreeNode<T>[] {
    return Array.from(this.breadthFirst());
  }

  /**
   * Casts the tree breadth-first into an array of T, stripping away
   * the TreeNode parts
   */
  castBreadthFirstValue(): T[] {
    return this.castBreadthFirst().map((x) => x.#value);
  }

  /**
   * Searches depth-first for a TreeNode via an ID
   *
   * If no node is found, we return `null`
   */
  getDescendantById(id: string): TreeNode<T> | null {
    if (this.#children.has(id)) {
      return this.#children.get(id) as TreeNode<T>;
    }

    for (const child of this.#children.values()) {
      const node = child.getDescendantById(id);

      if (node) {
        return node;
      }
    }

    return null;
  }

  /**
   * Sets the value of the TreeNode to another T
   *
   * Returns the `TreeNode`
   */
  setValue(callback: UnaryFn<T>): TreeNode<T> {
    this.#value = callback(this.#value);

    return this;
  }

  /**
   * Post-order depth-first traversal: every child (recursively) is yielded
   * before its parent. This is the natural order for bottom-up evaluation —
   * `depthFirst` is pre-order (parent first), this is its mirror.
   */
  *postOrder(): Generator<TreeNode<T>> {
    for (const child of this.#children.values()) {
      yield* child.postOrder();
    }
    yield this;
  }

  /**
   * Casts the tree post-order into an array of `TreeNode<T>`.
   */
  castPostOrder(): TreeNode<T>[] {
    return Array.from(this.postOrder());
  }

  /**
   * Casts the tree post-order into an array of `T` (children before parents).
   */
  castPostOrderValue(): T[] {
    return this.castPostOrder().map((x) => x.#value);
  }

  /**
   * Structure-preserving map: a new tree of the **same shape and ids** with
   * every value transformed by `fn`. This is what `fp.map` over the iterator
   * cannot give you — `fp.map` yields a flat sequence of mapped values, losing
   * the tree; this rebuilds it.
   */
  map<R>(fn: UnaryFn<T, R>): TreeNode<R> {
    const next = TreeNode.from<R>(fn(this.#value), this.#id);
    for (const child of this.#children.values()) {
      next.addChild(child.map(fn));
    }
    return next;
  }

  /**
   * Bottom-up catamorphism: fold each node from its already-folded children.
   * `fn(value, childResults)` sees a node's value and the fold results of its
   * children (left-to-right). This is the genuine tree fold — a flat
   * `reduce` over a traversal can't express "combine a node with its subtrees".
   *
   * @example sum a number tree:  node.fold((v, kids) => v + kids.reduce((a, b) => a + b, 0))
   * @example height:             node.fold((_v, kids) => 1 + Math.max(0, ...kids))
   */
  fold<R>(fn: (value: T, childResults: R[]) => R): R {
    const childResults: R[] = [];
    for (const child of this.#children.values()) {
      childResults.push(child.fold(fn));
    }
    return fn(this.#value, childResults);
  }

  /**
   * Clones a SubTree starting at this node. Ids are preserved so the clone
   * is structurally identical to the source.
   */
  clone(): TreeNode<T> {
    const next = TreeNode.from(this.#value, this.#id);
    for (const child of this.#children.values()) {
      next.addChild(child.clone());
    }
    return next;
  }

  /**
   * Clones the entire tree, starting at the root, regardless of the node
   * that you call this from
   */
  cloneEntireTree(): TreeNode<T> {
    return this.root.clone();
  }

  /**
   * Gets all the ancestors of a node in order
   */
  getAncestors(): TreeNode<T>[] {
    const ancestors: TreeNode<T>[] = [];
    let node = this.#parent;
    while (node) {
      ancestors.push(node);
      node = node.#parent;
    }
    return ancestors.reverse();
  }

  toArray(): TreeNode<T>[] {
    return this.castDepthFirst();
  }

  /**
   * This isn't super helpful, but it prints this as a string
   */
  toString(): string {
    return `TreeNode<${JSON.stringify(this.value)}>`;
  }

  toJSON(): TreeNodeJSON {
    return {
      children: this.children.map((child) => child.toJSON()),
      id: this.#id,
      parentId: this.#parent?.id ?? null,
      value: this.#value,
    };
  }

  /**
   * Serializes a Tree into an array for easier storage / transport
   */
  serialize(serializeValue = identity): SerializedTreeNode<T>[] {
    return serialize(this, serializeValue);
  }

  /**
   * Checks if two Trees are the same for value and for id
   */
  equals(node: TreeNode<T>, comparator?: BinaryFn<T, T, boolean>): boolean {
    return TreeNode.equals<T>(this, node, comparator);
  }
}
