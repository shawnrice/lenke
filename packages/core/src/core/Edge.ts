import { EmitterEvent } from '@lenke/emitter';
import { rando, sortedByKey } from '@lenke/utils';

import type { Graph } from './Graph.js';
import { validatePropertyKey, validatePropertyValue } from './validate.js';
import { Vertex } from './Vertex.js';

export type AddEdgeParams = {
  id?: string;
  from: Vertex;
  graph: Graph;
  to: Vertex;
  labels: string[];
  properties: Record<string, unknown>;
};

export class Edge {
  #id: string;
  #from: string;
  #to: string;
  #graph: Graph | null;

  /**
   * TypeCheck if something is an `Edge`
   */
  static isEdge(x: unknown): x is Edge {
    return x instanceof Edge;
  }

  constructor(params: AddEdgeParams) {
    const { id = rando(), from, graph, to, labels, properties } = params;
    this.#id = id;
    this.#graph = graph;
    this.labels = labels;
    // The setter already defensively copies into the graph's element map;
    // spreading here as well would clone the properties a second time.
    this.properties = properties;
    this.#from = from instanceof Vertex ? from.id : from;
    this.#to = to instanceof Vertex ? to.id : to;
  }

  get id(): string {
    return this.#id;
  }

  get graph(): Graph {
    return this.#graph!;
  }

  set graph(graph: Graph) {
    this.#graph = graph;
  }

  get from(): Vertex {
    return this.#graph!.getVertexById(this.#from)!;
  }

  get to(): Vertex {
    return this.#graph!.getVertexById(this.#to)!;
  }

  get labels(): Set<string> {
    return this.#graph?.elementLabels.get(this.id) ?? new Set();
  }

  set labels(labels: string[] | Set<string>) {
    this.#graph!.elementLabels.set(this.id, new Set(labels));
  }

  /**
   * The edge's property bag — the graph's live internal object, frozen.
   * **Read-only**: a top-level write (`e.properties.weight = 2`) throws, because
   * it would bypass the event/veto system and leave any `PropertyIndex` stale.
   * Always write via {@link setProperty}/{@link setProperties}/{@link removeProperty}.
   * (Freeze is shallow — nested array/object *values* are not protected.)
   */
  get properties(): Record<string, unknown> {
    return this.#graph?.elementProperties.get(this.#id) ?? {};
  }

  set properties(properties: Record<string, unknown>) {
    // Public setter: the caller may keep a reference to `properties`, so copy
    // defensively before committing.
    this.#commitProperties({ ...properties });
  }

  /**
   * Store an already-fresh bag as this edge's properties, frozen. The bag
   * becomes the graph's owned state — callers pass ownership and must not mutate
   * it afterward. Freezing turns a stray external `e.properties.x = …` into a
   * loud throw instead of silent index corruption; the internal write paths
   * always build a new bag, so freezing never breaks them. Used directly by the
   * mutators (which already build a fresh object) to avoid a redundant copy.
   */
  #commitProperties(bag: Record<string, unknown>): void {
    this.#graph!.elementProperties.set(this.#id, Object.freeze(bag));
  }

  addLabel(label: string): Edge | null {
    return this.#graph?.addLabelToEdge(label, this) ?? null;
  }

  removeLabel(label: string): Edge | null {
    return this.#graph?.removeLabelFromEdge(label, this) ?? null;
  }

  hasLabel(...labels: string[]): boolean {
    return labels.some((label) => this.labels.has(label));
  }

  hasProperty(prop: string): boolean {
    return prop in this.properties;
  }

  /**
   * Read a property value. Pass a type to skip the cast — `e.getProperty<number>
   * ('weight')` returns `number` instead of `unknown` — an opt-in, caller-side
   * assertion (nothing is validated), the same "trust me" contract as GQL
   * `query<R>`. Returns `undefined` for an absent key and the stored value
   * (which may be `null`) for a present one; annotate `<number | undefined>` if
   * the key might be absent. Defaults to `unknown` (unchanged).
   */
  getProperty<T = unknown>(prop: string): T {
    return this.properties[prop] as T;
  }

  setProperty(key: string, value: unknown): void {
    validatePropertyKey(key);
    validatePropertyValue(value);
    const previousValue = this.properties[key]; // read before the write; undefined if absent
    const event = this.#graph?.emit(
      new EmitterEvent('@graph/EdgePropertyChanged', {
        edge: this,
        key,
        value,
        previous: previousValue,
      }),
    );

    if (event?.defaultPrevented) {
      return;
    }

    const previous = this.properties;
    this.#commitProperties({ ...previous, [key]: value });
    this.#graph?.reindexEdgeProperty(this, key, previous[key], value);
  }

  setProperties(props: Record<string, unknown>): void {
    for (const key of Object.keys(props)) {
      validatePropertyValue(props[key]);
    }

    const event = this.#graph?.emit(
      new EmitterEvent('@graph/EdgePropertiesChanged', {
        edge: this,
        next: props,
      }),
    );

    if (event?.defaultPrevented) {
      return;
    }

    const previous = this.properties;
    this.#commitProperties({ ...previous, ...props });

    for (const key of Object.keys(props)) {
      this.#graph?.reindexEdgeProperty(this, key, previous[key], props[key]);
    }
  }

  removeProperty(key: string): void {
    if (!this.hasProperty(key)) {
      return;
    }

    const event = this.#graph?.emit(
      new EmitterEvent('@graph/EdgePropertyRemoved', { edge: this, key }),
    );

    if (event?.defaultPrevented) {
      return;
    }

    const previous = this.properties;
    this.#commitProperties(Object.fromEntries(Object.entries(previous).filter(([k]) => key !== k)));
    this.#graph?.reindexEdgeProperty(this, key, previous[key], undefined);
  }

  removeProperties(keys: string[]): void {
    const event = this.#graph?.emit(
      new EmitterEvent('@graph/EdgePropertiesRemoved', { edge: this, keys }),
    );

    if (event?.defaultPrevented) {
      return;
    }

    const previous = this.properties;
    this.#commitProperties(
      Object.fromEntries(Object.entries(previous).filter(([k]) => !keys.includes(k))),
    );

    for (const key of keys) {
      this.#graph?.reindexEdgeProperty(this, key, previous[key], undefined);
    }
  }

  /**
   * Removes the reference from this to the graph container
   */
  evict(): void {
    this.#graph = null;
  }

  toJSON(): Record<string, unknown> {
    // Sorted labels + property keys so a returned edge serializes
    // byte-identically to the native engine (see Vertex.toJSON). Top-level
    // field order (`id, from, to, labels, properties`) matches native's edge
    // `Value::Map` layout in gql/eval.rs.
    return {
      id: this.id,
      from: this.from.id,
      to: this.to.id,
      labels: Array.from(this.labels).sort(),
      properties: sortedByKey(this.properties),
    };
  }
}
