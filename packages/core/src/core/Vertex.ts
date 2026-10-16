import { EmitterEvent } from '@lenke/emitter';
import { ErrorCode, LenkeError } from '@lenke/errors';
import { rando, sortedByKey } from '@lenke/utils';

import type { Edge } from './Edge.js';
import type { Graph, LabelBox, PropBox } from './Graph.js';

/**
 * Bags wider than this memoize their key list on the {@link PropBox} (audit item 336). Below
 * it the memo measured flat and would only cost retained memory. See `propertyKeys`.
 */
const WIDE_BAG = 64;
import {
  normalizeProperties,
  normalizePropertyValue,
  validatePropertyKey,
  validatePropertyValue,
} from './validate.js';

export type VertexParams = {
  id?: string;
  labels: string[];
  graph: Graph;
  properties: Record<string, unknown>;
};

export type VertexJSON = {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
};

export class Vertex {
  #id: string;
  #graph: Graph | null;

  // This element's property box, cached after the first read. A direct reference, so a property
  // read costs a field load instead of a string-keyed `Map.get`; see `Graph.elementProperties`
  // for why it is a box and not the bag.
  #box: PropBox | undefined;

  // This element's label box, cached after the first read, for the same reason as `#box`. Kept
  // EMPTY whenever `#graph` is not the graph this box came from, which is what preserves the
  // throw on a detached vertex — see `get labels`.
  #lbox: LabelBox | undefined;

  // This vertex's out- and in-adjacency boxes, cached after the first read for the same reason as
  // `#box` and `#lbox`: the graph keys them by the vertex's ID STRING, and every consumer here
  // already holds the vertex OBJECT. Audit item 321 priced the three ways to reach an adjacency
  // over 200,000 vertices — a string key costs **59.7ns**, a Map keyed on the vertex object 30.5,
  // a `WeakMap` 43.8, and a cached reference **16.1** — so the box is 3.7x, and only a tenth of
  // that is the hash. The rest is locality: a field read reaches the adjacency from a cache line
  // the caller has already touched, where a string key hashes the characters and then probes a
  // 200,000-entry table.
  //
  // Safe to hold indefinitely because the graph's outer entries are only ever `set`, never
  // deleted: `insertEdge` creates a vertex's inner Map once and mutates it in place thereafter.
  // Both are dropped by `evict` and by `set graph`, exactly as `#lbox` is and for the same
  // reason — a box belongs to the graph whose map it came from.
  #adjFrom: Map<string, Set<Edge>> | undefined;

  #adjTo: Map<string, Set<Edge>> | undefined;

  static from(params: VertexParams): Vertex {
    return new Vertex(params);
  }

  /**
   * TypeCheck if something is a `Vertex`
   */
  static isVertex(x: unknown): x is Vertex {
    return x instanceof Vertex;
  }

  constructor(params: VertexParams) {
    const { id = rando(), labels, graph, properties } = params;
    this.#id = id;
    this.#graph = graph;
    // The `properties`/`labels` setters already defensively copy into the
    // graph's element maps, so spreading here too would clone a second time.
    this.properties = properties;
    this.labels = labels;
  }

  get graph(): Graph {
    return this.#graph!;
  }

  set graph(graph: Graph) {
    this.#graph = graph;
    // The cached boxes belong to the PREVIOUS graph's maps, so moving graphs must drop them or
    // the element would read the old graph's properties and labels.
    this.#box = undefined;
    this.#lbox = undefined;
    this.#adjFrom = undefined;
    this.#adjTo = undefined;
  }

  get id(): string {
    return this.#id;
  }

  // REJECTED lever — reading `this.#id` here (and in `edgesFromByLabel`/`edgesToByLabel`
  // below, and in `Edge`'s `labels`) instead of going through the public `id` getter. This
  // getter is 11.8% of a TypeScript CSV encode by `bun --cpu-prof` and `get properties`
  // already reads `this.#id` directly, so the extra hop looked like free money. It is not:
  // interleaved min of three, rebuilding both ways each round,
  //
  //     encode csv      131.6 / 132.9 / 156.6   ->  127.8 / 136.5 / 140.2
  //     encode pg-text  123.7 / 126.8 / 126.3   ->  122.5 / 128.2 / 123.7
  //     encode ndjson    78.6 /  77.3 /  68.7   ->   77.7 /  78.5 /  79.4
  //     IS LABELED scan  97.1 /  85.8 /  85.1   ->   92.4 /  84.9 /  91.8
  //
  // flat on every row, with the rounds disagreeing on the sign. JSC inlines a getter whose
  // whole body is a private-field read, so there was no redundant work to remove. What this
  // getter actually costs is the string-keyed `Map.get` and the `Set` the caller then
  // iterates, neither of which the rewrite touched.
  get labels(): Set<string> {
    // The label box, cached on first read exactly as `#box` is for properties, which is what
    // takes the string-keyed `Map.get` off this path (audit item 162).
    //
    // A DETACHED vertex has no cache — `evict` and `set graph` both clear it — so it still
    // dereferences a null graph here and throws the raw `TypeError` it always threw. `Edge`'s
    // twin returns an empty set instead; the two have never agreed, and this keeps both.
    this.#lbox ??= this.#graph!.elementLabels.get(this.id);

    return this.#lbox?.set ?? new Set();
  }

  set labels(labels: string[] | Set<string>) {
    const next = new Set(labels);

    // Already holding the box? Then there is nothing to look up — and the box is always the
    // CURRENT graph's, because `set graph` and `evict` are the only ways to leave one and both
    // clear it. This is what keeps a re-write off the map entirely (a 200,000-element re-write
    // measured 32.0ms through the funnel against 29.9ms for the old single `Map.set`).
    if (this.#lbox) {
      this.#lbox.set = next;

      return;
    }

    // Otherwise through the graph's funnel, which mutates the box rather than replacing the map
    // entry, so another instance for this id that has already cached the box sees the write.
    this.#graph!.commitElementLabels(this.id, next);
  }

  /**
   * The vertex's property bag — the graph's live internal object, frozen.
   * **Read-only**: a top-level write (`v.properties.age = 40`) throws, because
   * it would bypass the event/index maintenance and leave any `PropertyIndex` stale.
   * Always write via {@link setProperty}/{@link setProperties}/{@link removeProperty}.
   * (Freeze is shallow — nested array/object *values* are not protected.)
   */
  get properties(): Record<string, unknown> {
    if (!this.#graph) {
      return {};
    }

    // The box is cached on FIRST read and then never looked up again. `??=` rather than a
    // constructor assignment so an element built outside the normal path still shares the one
    // box for its id — the whole point of the indirection (see `Graph.elementProperties`).
    this.#box ??= this.#graph.elementProperties.get(this.#id);

    return this.#box?.bag ?? {};
  }

  set properties(properties: Record<string, unknown>) {
    // Public setter: the caller may keep a reference to `properties`, so copy
    // defensively before committing.
    this.#commitProperties({ ...properties });
  }

  /**
   * Store an already-fresh bag as this vertex's properties, frozen. The bag
   * becomes the graph's owned state — callers pass ownership and must not mutate
   * it afterward. Freezing turns a stray external `v.properties.x = …` into a
   * loud throw instead of silent index corruption; the internal write paths
   * always build a new bag, so freezing never breaks them. Used directly by the
   * mutators (which already build a fresh object) to avoid a redundant copy.
   */
  /**
   * This element's property key names, memoized on the shared {@link PropBox} (item 336).
   *
   * `undefined` when the element has no graph, mirroring `properties` returning `{}`. The list
   * is the box's, so every instance for this id shares one — and it is invalidated by the only
   * thing that can invalidate it, a write replacing `box.bag` below.
   */
  get propertyKeys(): readonly string[] | undefined {
    if (!this.#graph) {
      return undefined;
    }

    this.#box ??= this.#graph.elementProperties.get(this.#id);

    const box = this.#box;

    if (!box) {
      return undefined;
    }

    if (box.keys !== undefined) {
      return box.keys;
    }

    const keys = Object.keys(box.bag);

    // Memoized only above a WIDTH, because the memo is not free: it RETAINS the key array for
    // the bag's lifetime where the old code threw it away, which is ~8 bytes per property per
    // element. The measurements put the payoff entirely at the wide end — a width-256 delete
    // goes 3.00x, a transactional one 1.95x, and widths 4 / 16 / 64 come out flat — so below
    // the threshold a graph pays the memory and gets nothing. 64 is where the rows stop moving.
    if (keys.length > WIDE_BAG) {
      box.keys = keys;
    }

    return keys;
  }

  /**
   * `#commitProperties` for a bag whose values are ALREADY normalized — the write paths that
   * introduce at most a handful of new values, which is all of them but the public setter
   * (audit item 349).
   *
   * `normalizeProperties` walks every key on every call. On a single-property `SET` that is a
   * third O(K) pass next to the spread and the freeze, and it is provably redundant: a bag in
   * the box was normalized when it was stored, and item 335 established that a stored bag is
   * frozen and REPLACED rather than mutated. So only the values this write introduces can need
   * lifting, and the callers below normalize exactly those.
   *
   * The invariant is inductive and the whole correctness argument: every path into the box
   * normalizes what it adds — the public setter normalizes the lot (its bag is the caller's),
   * `setProperty` its one value, `setProperties` its `props`, and a removal adds nothing — so
   * every stored bag is fully normalized. Breaking any one of those makes this unsound, which
   * is why there is a mutant per path.
   */
  #commitNormalized(bag: Record<string, unknown>): void {
    // Single funnel for every property write — constructor, setProperty,
    // setProperties, removeProperty — so normalizing here lifts a tagged temporal
    // (`{"@date": …}`) to its instance no matter which path wrote it. Without it a
    // value round-tripped out of the graph and back in stored as a plain object
    // and silently compared equal to nothing. Returns the same bag when nothing
    // moved, so the common case costs one pass and no allocation.
    // A write to an element no longer in a graph (removed/detached, `#graph === null`) is a
    // coded error, not a raw `TypeError` on the null deref (constructor always has a graph).
    if (!this.#graph) {
      throw new LenkeError(
        'cannot write to a Vertex that is not in a graph (removed or detached)',
        {
          code: ErrorCode.InvalidGraphOp,
        },
      );
    }

    // REPLACE the box's bag rather than the map entry, so every instance holding this box —
    // there can be more than one for an id — sees the write. The bag itself stays frozen.
    const frozen = Object.freeze(bag);
    const box = this.#box ?? this.#graph.elementProperties.get(this.#id);

    if (box === undefined) {
      this.#box = { bag: frozen };
      this.#graph.elementProperties.set(this.#id, this.#box);

      return;
    }

    box.bag = frozen;
    // The memoized key list described a bag that no longer exists.
    box.keys = undefined;
    this.#box = box;
  }

  /** The normalizing funnel: for a bag whose values came from OUTSIDE the graph. */
  #commitProperties(bag: Record<string, unknown>): void {
    this.#commitNormalized(normalizeProperties(bag));
  }

  /**
   * Read a property value. Pass a type to skip the cast — `v.getProperty<string>
   * ('name')` returns `string` instead of `unknown` — an opt-in, caller-side
   * assertion (nothing is validated), the same "trust me" contract as GQL
   * `query<R>`. Returns `undefined` for an absent key and the stored value
   * (which may be `null`) for a present one; annotate `<string | undefined>` if
   * the key might be absent. Defaults to `unknown` (unchanged).
   */
  getProperty<T = unknown>(key: string): T {
    return this.properties[key] as T;
  }

  setProperty(key: string, value: unknown): void {
    validatePropertyKey(key);
    validatePropertyValue(value);
    this.#graph?.assertRequiredOnSet(this, key, value);
    this.#graph?.assertTypeOnSet(this, key, value);
    this.#graph?.assertUniqueOnSet(this, key, value);
    const g = this.#graph;
    const { id } = this;
    const had = key in this.properties;
    const previousValue = this.properties[key]; // read before the write; undefined if absent
    // Resolve the element fresh by id at replay time — a later remove+re-add in
    // the same transaction swaps the object identity, so a captured `this` would
    // be a stale, evicted handle.
    g?.recordUndo(
      had
        ? () => g.getVertexById(id)?.setProperty(key, previousValue)
        : () => g.getVertexById(id)?.removeProperty(key),
    );
    this.#graph?.emit(
      new EmitterEvent('@graph/VertexPropertyChanged', {
        vertex: this,
        key,
        value,
        previous: previousValue,
      }),
    );

    const previous = this.properties;
    // Only `value` is new, so only `value` needs lifting (item 349).
    this.#commitNormalized({ ...previous, [key]: normalizePropertyValue(value) });
    this.#graph?.reindexVertexProperty(this, key, previous[key], value);
  }

  setProperties(props: Record<string, unknown>): void {
    for (const key of Object.keys(props)) {
      validatePropertyValue(props[key]);
      this.#graph?.assertRequiredOnSet(this, key, props[key]);
      this.#graph?.assertTypeOnSet(this, key, props[key]);
      this.#graph?.assertUniqueOnSet(this, key, props[key]);
    }

    const previousValues = Object.fromEntries(
      Object.keys(props).map((key) => [key, this.properties[key]]),
    );
    const g = this.#graph;
    const { id } = this;
    const undoRestore = Object.keys(props).filter((key) => key in this.properties);
    const undoRemove = Object.keys(props).filter((key) => !(key in this.properties));
    const undoValues = Object.fromEntries(undoRestore.map((key) => [key, this.properties[key]]));
    g?.recordUndo(() => {
      const v = g.getVertexById(id);

      if (!v) {
        return;
      }

      if (undoRestore.length > 0) {
        v.setProperties(undoValues);
      }

      if (undoRemove.length > 0) {
        v.removeProperties(undoRemove);
      }
    });

    this.#graph?.emit(
      new EmitterEvent('@graph/VertexPropertiesChanged', {
        vertex: this,
        next: props,
        previous: previousValues,
      }),
    );

    if (!this.#graph) {
      throw new LenkeError(
        'cannot write to a Vertex that is not in a graph (removed or detached)',
        {
          code: ErrorCode.InvalidGraphOp,
        },
      );
    }

    const previous = this.properties;
    // `normalizeProperties` over `props` alone is O(|props|), not O(K) (item 349).
    this.#commitNormalized({ ...previous, ...normalizeProperties(props) });

    for (const key of Object.keys(props)) {
      this.#graph.reindexVertexProperty(this, key, previous[key], props[key]);
    }
  }

  removeProperty(key: string): void {
    if (!this.hasProperty(key)) {
      return;
    }

    this.#graph?.assertRequiredOnRemove(this, key);
    const g = this.#graph;
    const { id } = this;
    const previousValue = this.properties[key];
    g?.recordUndo(() => g.getVertexById(id)?.setProperty(key, previousValue));
    this.#graph?.emit(
      new EmitterEvent('@graph/VertexPropertyRemoved', {
        vertex: this,
        key,
        previous: previousValue,
      }),
    );

    const previous = this.properties;
    // A removal introduces no value at all, so nothing needs lifting (item 349).
    this.#commitNormalized(Object.fromEntries(Object.entries(previous).filter(([k]) => key !== k)));
    this.#graph?.reindexVertexProperty(this, key, previous[key], undefined);
  }

  removeProperties(keys: string[]): void {
    for (const key of keys) {
      if (key in this.properties) {
        this.#graph?.assertRequiredOnRemove(this, key);
      }
    }

    const g = this.#graph;
    const { id } = this;
    const removed = Object.fromEntries(
      keys.filter((key) => key in this.properties).map((key) => [key, this.properties[key]]),
    );
    g?.recordUndo(() => g.getVertexById(id)?.setProperties(removed));
    this.#graph?.emit(
      new EmitterEvent('@graph/VertexPropertiesRemoved', { vertex: this, keys, previous: removed }),
    );

    const previous = this.properties;
    this.#commitNormalized(
      Object.fromEntries(Object.entries(previous).filter(([k]) => !keys.includes(k))),
    );

    for (const key of keys) {
      this.#graph?.reindexVertexProperty(this, key, previous[key], undefined);
    }
  }

  hasProperty(key: string): boolean {
    return key in this.properties;
  }

  hasLabel(label: string): boolean {
    return this.labels.has(label);
  }

  addLabel(label: string): Vertex {
    this.#graph?.addLabelToVertex(label, this);

    return this;
  }

  removeLabel(label: string): Vertex {
    this.#graph?.removeLabelFromVertex(label, this);

    return this;
  }

  evict(): void {
    this.#graph = null;
    // Dropping the label box is what keeps `get labels` throwing on an evicted vertex: with no
    // cache it dereferences the now-null graph, exactly as it did before the box existed.
    this.#lbox = undefined;
    // The adjacency boxes go for the plainer reason: they point into the graph this vertex is
    // leaving, and a re-added vertex must read the live maps rather than the ones it remembered.
    this.#adjFrom = undefined;
    this.#adjTo = undefined;
  }

  /**
   * This vertex's out-adjacency by edge type, or `undefined` when it has no out-edges (or no
   * graph). `??=` caches only a box that EXISTS, so a zero-degree vertex re-reads the map and
   * picks up its first edge's box rather than remembering that it had none.
   */
  get adjFrom(): Map<string, Set<Edge>> | undefined {
    this.#adjFrom ??= this.#graph?.edgesFromByLabel.get(this.id);

    return this.#adjFrom;
  }

  /** In-adjacency twin of {@link Vertex.adjFrom}. */
  get adjTo(): Map<string, Set<Edge>> | undefined {
    this.#adjTo ??= this.#graph?.edgesToByLabel.get(this.id);

    return this.#adjTo;
  }

  edgesFromByLabel(label: string): Set<Edge> {
    return this.adjFrom?.get(label) ?? new Set();
  }

  edgesToByLabel(label: string): Set<Edge> {
    return this.adjTo?.get(label) ?? new Set();
  }

  toString(): string {
    return `Vertex (${this.id}) {}`;
  }

  toJSON(): VertexJSON {
    // Labels and property keys are emitted in sorted order so a returned
    // element serializes byte-identically to the native engine, whose columnar
    // store has no per-element key order and thus canonicalizes to sorted keys
    // (see `val_to_value`/`props_map` in gql/eval.rs). Top-level field order
    // (`id, labels, properties`) matches the native `Value::Map` layout.
    // `[...set]` rather than `Array.from(set)`, and no `sort()` below two labels: spread hits
    // the engine's fast path for an unmodified Set iterator where `Array.from` walks the generic
    // iterator protocol, and a one-element sort is a no-op that still enters the sort machinery.
    // 73.1 -> 35.2 ns/element, measured; audit item 398.
    const ls = this.labels;
    const labels = [...ls];

    if (ls.size > 1) {
      labels.sort();
    }

    return {
      id: this.id,
      labels,
      properties: sortedByKey(this.properties),
    };
  }
}
