# @pl-graph/tree

> Generic tree data structures for JavaScript/TypeScript: a mutable `TreeNode` and a value-carrying `Trie`.

This package provides two tree structures. `TreeNode<T>` is a general n-ary tree with stable node ids, multiple traversal orders, structure-preserving `map`/`fold`, cloning, and (de)serialization. `Trie<T>` is a prefix tree that stores an arbitrary value per key, built for fast prefix lookups such as autocomplete. Reach for it when you need ordered hierarchical data with explicit traversal control, or key/value prefix search.

## Install

```bash
bun add @pl-graph/tree
```

## Usage

```ts
import { TreeNode, Trie } from '@pl-graph/tree';

// --- TreeNode ---
const root = TreeNode.from(1);
const a = root.createChild(2);
const b = root.createChild(3);
a.createChild(4);

root.castDepthFirst(); // [root, a, 4, b] as TreeNode<number>[]
root.castBreadthFirstValue(); // [1, 2, 3, 4]

// Structure-preserving map: same shape and ids, new values
const doubled = root.map((n) => n * 2); // TreeNode<number>

// Bottom-up fold (catamorphism): sum every value in the tree
const total = root.fold((value, childResults) => value + childResults.reduce((x, y) => x + y, 0)); // 10

// Round-trip through a flat record array
const records = TreeNode.serialize(root);
const restored = TreeNode.deserialize(records);

// --- Trie ---
const trie = Trie.from([
  ['word', 1],
  ['words', 2],
  ['work', 3],
]);

trie.has('word'); // true  (full word)
trie.hasPartial('wor'); // true  (prefix only)
trie.get('wor')?.char; // 'r'   (TrieNode at the prefix)

// Autocomplete: every full word under a prefix
Array.from(trie.descendantsOf('wor'), (node) => [node.word, node.value]);
// [['word', 1], ['words', 2], ['work', 3]]

trie.toMap(); // Map { 'word' => 1, 'words' => 2, 'work' => 3 }
```

## `TreeNode<T>`

A mutable n-ary tree node. Every node has a `rando()`-generated `id` (override per node), a `value`, a `parent`, and ordered `children`. Getters return copies of collections to discourage direct mutation; mutate through the methods.

Construction:

- `TreeNode.from<T>(value, id?): TreeNode<T>` — create a parentless (root) node.
- `node.createChild(value, id?): TreeNode<T>` — create and attach a child, returns the new child.
- `node.addChild(child): this` — attach an existing **parentless** node; throws on a cycle, a node with a parent, or self.
- `node.clone()` / `node.cloneEntireTree()` — deep copy from this node (or the whole tree), ids preserved.

Structure & navigation: `id`, `value`, `parent`, `root`, `children`, `childCount`, `ancestors`, `depth`, `isRoot()`, `hasChild(n)`, `contains(n)`, `getAncestors()`, `getDescendantById(id)`.

Mutation: `removeChild(n)`, `detach()` (cut this node and its subtree loose), `remove()` (remove this node, splicing children up to the parent; returns the new root or `null`), `setValue(fn)`.

Traversal (generators): `depthFirst()` (pre-order, also the default iterator), `breadthFirst()`, `postOrder()`, `filterDepthFirst(pred)`, `filterBreadthFirst(pred)`, `forEach(fn)`.

Cast to arrays: `castDepthFirst()`, `castBreadthFirst()`, `castPostOrder()` (and `…Value()` variants that strip to `T[]`), `toArray()`.

Transform & combine: `map<R>(fn): TreeNode<R>` (same shape/ids, new values), `fold<R>((value, childResults) => R): R` (bottom-up catamorphism).

Serialization & equality:

- `node.serialize<R>(serializeValue?): SerializedTreeNode<R>[]` / static `TreeNode.serialize(node, serializeValue?)`.
- `TreeNode.deserialize<S, T>(records, deserializeValue?): TreeNode<T>`.
- `node.toJSON(): TreeNodeJSON` (nested form, `JSON.stringify`-friendly).
- `node.equals(other, comparator?)` / static `TreeNode.equals(a, b, comparator?)` — compares ids, parent ids, and values (`Object.is` by default).

## `Trie<T>`

A prefix tree that stores one value per key. Each `TrieNode` holds a single-character `char`; only end-of-word nodes carry a `word` and `value`. Tracks `words` and `nodes` counts.

Construction:

- `new Trie<T>()`
- `Trie.from(iterable: Iterable<[string, T]>)`, `Trie.fromArray(pairs)`, `Trie.fromMap(map)`.

Mutation: `add(key, value): this` (insert or update), `remove(key): this`.

Lookup:

- `has(key)` — `key` is present as a full word.
- `hasPartial(key)` — `key` is present as a prefix (or full word).
- `get(key): TrieNode<T> | null` — the node at the end of `key`, matching partial paths.
- `keyHasValue(key, value)` — `===` value check at `key`.

Iteration: `descendantsOf(key)` (full-word nodes under a prefix — the autocomplete primitive), `entries()`, `keys()`, `values()`, `toArray()`, `toMap()`. Iteration follows child-insertion order, not key-insertion order; sort the result if you need a specific order.

### `TrieNode<T>`

The node type returned by `Trie.get` / `Trie.descendantsOf`: `char`, `word` (full text when end-of-word, else `null`), `value` (`T | null`), `isEndOfWord`, `count` (words passing through), `children: Map<string, TrieNode<T>>`, and a `descendants()` generator yielding all descendant end-of-word nodes.

## License

Apache-2.0
