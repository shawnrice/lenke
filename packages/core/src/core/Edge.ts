import { EmitterEvent } from '@pl-graph/emitter';
import { rando } from '@pl-graph/utils';

import type { Graph } from './Graph.js';
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

  get properties(): Record<string, unknown> {
    return this.#graph?.elementProperties.get(this.#id) ?? {};
  }

  set properties(properties: Record<string, unknown>) {
    this.#graph!.elementProperties.set(this.id, { ...properties });
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

  getProperty(prop: string): unknown {
    return this.properties[prop];
  }

  setProperty(key: string, value: unknown): void {
    const event = this.#graph?.emit(
      new EmitterEvent('@graph/EdgePropertyChanged', {
        edge: this,
        key,
        value,
      }),
    );

    if (event?.defaultPrevented) {
      return;
    }

    const previous = this.properties;
    this.properties = { ...previous, [key]: value };
    this.#graph?.reindexEdgeProperty(this, key, previous[key], value);
  }

  setProperties(props: Record<string, unknown>): void {
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
    this.properties = { ...previous, ...props };

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
    this.properties = Object.fromEntries(Object.entries(previous).filter(([k]) => key !== k));
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
    this.properties = Object.fromEntries(
      Object.entries(previous).filter(([k]) => !keys.includes(k)),
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
    return {
      id: this.id,
      from: this.from.id,
      to: this.to.id,
      labels: Array.from(this.labels),
      properties: this.properties,
    };
  }
}
