import { EmitterEvent } from '@lenke/emitter';
import { rando, sortedByKey } from '@lenke/utils';

import type { Edge } from './Edge.js';
import type { Graph } from './Graph.js';
import { validatePropertyKey } from './validate.js';

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
  }

  get id(): string {
    return this.#id;
  }

  get labels(): Set<string> {
    return this.#graph!.elementLabels.get(this.id) ?? new Set();
  }

  set labels(labels: string[] | Set<string>) {
    this.#graph!.elementLabels.set(this.id, new Set(labels));
  }

  /**
   * The vertex's property bag — the graph's live internal object, frozen.
   * **Read-only**: a top-level write (`v.properties.age = 40`) throws, because
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
   * Store an already-fresh bag as this vertex's properties, frozen. The bag
   * becomes the graph's owned state — callers pass ownership and must not mutate
   * it afterward. Freezing turns a stray external `v.properties.x = …` into a
   * loud throw instead of silent index corruption; the internal write paths
   * always build a new bag, so freezing never breaks them. Used directly by the
   * mutators (which already build a fresh object) to avoid a redundant copy.
   */
  #commitProperties(bag: Record<string, unknown>): void {
    this.#graph!.elementProperties.set(this.#id, Object.freeze(bag));
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
    const previousValue = this.properties[key]; // read before the write; undefined if absent
    const event = this.#graph?.emit(
      new EmitterEvent('@graph/VertexPropertyChanged', {
        vertex: this,
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
    this.#graph?.reindexVertexProperty(this, key, previous[key], value);
  }

  setProperties(props: Record<string, unknown>): void {
    const event = this.#graph?.emit(
      new EmitterEvent('@graph/VertexPropertiesChanged', {
        vertex: this,
        next: props,
      }),
    );

    if (event?.defaultPrevented) {
      return;
    }

    if (!this.#graph) {
      throw new Error('Vertex has no graph');
    }

    const previous = this.properties;
    this.#commitProperties({ ...previous, ...props });

    for (const key of Object.keys(props)) {
      this.#graph.reindexVertexProperty(this, key, previous[key], props[key]);
    }
  }

  removeProperty(key: string): void {
    if (!this.hasProperty(key)) {
      return;
    }

    const event = this.#graph?.emit(
      new EmitterEvent('@graph/VertexPropertyRemoved', { vertex: this, key }),
    );

    if (event?.defaultPrevented) {
      return;
    }

    const previous = this.properties;
    this.#commitProperties(Object.fromEntries(Object.entries(previous).filter(([k]) => key !== k)));
    this.#graph?.reindexVertexProperty(this, key, previous[key], undefined);
  }

  removeProperties(keys: string[]): void {
    const event = this.#graph?.emit(
      new EmitterEvent('@graph/VertexPropertiesRemoved', { vertex: this, keys }),
    );

    if (event?.defaultPrevented) {
      return;
    }

    const previous = this.properties;
    this.#commitProperties(
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
  }

  edgesFromByLabel(label: string): Set<Edge> {
    return this.#graph?.edgesFromByLabel.get(this.id)?.get(label) ?? new Set();
  }

  edgesToByLabel(label: string): Set<Edge> {
    return this.#graph?.edgesToByLabel.get(this.id)?.get(label) ?? new Set();
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
    return {
      id: this.id,
      labels: Array.from(this.labels).sort(),
      properties: sortedByKey(this.properties),
    };
  }
}
