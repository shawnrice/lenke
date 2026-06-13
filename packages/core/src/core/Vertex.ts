import { EmitterEvent } from '@pl-graph/emitter';
import { rando } from '@pl-graph/utils';

import type { Edge } from './Edge.js';
import type { Graph } from './Graph.js';

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
    const { id = rando(), labels = [], graph, properties = {} } = params;
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

  get properties(): Record<string, unknown> {
    return this.#graph?.elementProperties.get(this.#id) ?? {};
  }

  set properties(properties: Record<string, unknown>) {
    this.#graph!.elementProperties.set(this.#id, { ...properties });
  }

  getProperty(key: string): unknown {
    return this.properties[key];
  }

  setProperty(key: string, value: unknown): void {
    const event = this.#graph?.emit(
      new EmitterEvent('@graph/VertexPropertyChanged', { vertex: this, key, value }),
    );

    if (event?.defaultPrevented) {
      return;
    }

    this.properties = { ...this.properties, [key]: value };
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

    this.properties = { ...this.properties, ...props };
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

    this.properties = Object.fromEntries(
      Object.entries(this.properties).filter(([k]) => key !== k),
    );
  }

  removeProperties(keys: string[]): void {
    const event = this.#graph?.emit(
      new EmitterEvent('@graph/VertexPropertiesRemoved', { vertex: this, keys }),
    );

    if (event?.defaultPrevented) {
      return;
    }

    this.properties = Object.fromEntries(
      Object.entries(this.properties).filter(([k]) => !keys.includes(k)),
    );
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
    return {
      id: this.id,
      labels: Array.from(this.labels),
      properties: this.properties,
    };
  }
}
