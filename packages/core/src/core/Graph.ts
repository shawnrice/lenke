import { Emitter, EmitterEvent } from '@pl-graph/emitter';
import { timer } from '@pl-graph/utils';

import { Edge } from './Edge.js';
import { Vertex } from './Vertex.js';

import type { GraphEvent, GraphEvents, GraphEventType } from './GraphEvents.js';

type AddVertexParams = {
  id?: string;
  labels: string[];
  properties: Record<string, unknown>;
};

type AddEdgeArgs = {
  id?: string;
  from: Vertex;
  to: Vertex;
  labels: string[];
  properties: Record<string, unknown>;
};

type GraphOptions = {
  eagerSnapshot: boolean;
};

/**
 * A Property-Label graph.
 *
 * Vertices and Edges are concrete (non-generic) classes. Property types are
 * `Record<string, unknown>` at this layer; cast at the application boundary
 * if you need typed access (`vertex.properties as Person`), or wrap the
 * graph with a schema-aware layer.
 */
export class Graph {
  verticesById: Map<string, Vertex>;
  verticesByLabel: Map<string, Set<Vertex>>;
  vertices: Set<Vertex>;

  edgesById: Map<string, Edge>;
  edges: Set<Edge>;
  edgesByLabel: Map<string, Set<Edge>>;
  edgesFromByLabel: Map<string, Map<string, Set<Edge>>>;
  edgesToByLabel: Map<string, Map<string, Set<Edge>>>;
  edgesByVertex: Map<string, Set<Edge>>;

  eagerSnapshot: boolean;

  elementLabels: Map<string, Set<string>>;
  elementProperties: Map<string, Record<string, unknown>>;

  private readonly listeners: Set<() => unknown>;

  public nextSnapshot: Graph | null;

  private nextSnapshotIsStale: boolean;
  private createNextSnapshot: number | undefined;

  emitter: Emitter<keyof GraphEvents, GraphEvents>;

  constructor(options: Partial<GraphOptions> = {}) {
    this.verticesById = new Map();
    this.vertices = new Set();
    this.edgesById = new Map();
    this.verticesByLabel = new Map();
    this.edges = new Set();
    this.edgesFromByLabel = new Map();
    this.edgesToByLabel = new Map();
    this.edgesByVertex = new Map();
    this.edgesByLabel = new Map();

    this.elementLabels = new Map();
    this.elementProperties = new Map();

    this.eagerSnapshot = options.eagerSnapshot ?? true;

    this.nextSnapshot = null;
    this.nextSnapshotIsStale = true;
    this.emitter = new Emitter({ enabled: true });

    this.listeners = new Set();

    this.createNextSnapshot = undefined;

    const callback = () => {
      this.prepareNextSnapshotLazy();
    };

    const markIsStale = (event: GraphEvent) => {
      const doTheWork = () => {
        if (event.defaultPrevented) {
          return;
        }

        this.nextSnapshotIsStale = true;

        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
          window.cancelIdleCallback(this.createNextSnapshot!);
          this.createNextSnapshot = window.requestIdleCallback(callback);
        } else {
          globalThis.clearTimeout(this.createNextSnapshot);
          globalThis.setTimeout(callback, 1);
        }
      };

      queueMicrotask(doTheWork);
    };

    const graphMutationEvents: GraphEventType[] = [
      '@graph/VertexAdded',
      '@graph/VertexRemoved',
      '@graph/EdgeAdded',
      '@graph/EdgeRemoved',
      '@graph/LabelAddedToVertex',
      '@graph/LabelRemovedFromVertex',
      '@graph/LabelAddedToEdge',
      '@graph/LabelRemovedFromEdge',
      '@graph/VertexPropertyChanged',
      '@graph/VertexPropertiesChanged',
      '@graph/VertexPropertyRemoved',
      '@graph/VertexPropertiesRemoved',
      '@graph/EdgePropertyChanged',
      '@graph/EdgePropertiesChanged',
      '@graph/EdgePropertyRemoved',
      '@graph/EdgePropertiesRemoved',
    ];

    const onMutate = (event: GraphEventType) => {
      this.emit(new EmitterEvent('@graph/mutate', { original: event }));
    };

    graphMutationEvents.forEach((type) => {
      // The same listener is registered against many event types; we erase
      // the per-event listener type here.
      this.on(type, markIsStale as never);
      this.on(type, onMutate as never);
    });

    if (this.eagerSnapshot) {
      this.prepareNextSnapshotLazy();
    }
  }

  get size(): number {
    return this.vertices.size;
  }

  get vertexCount(): number {
    return this.vertices.size;
  }

  get stats(): Record<'vertices' | 'edges', Record<string, number>> {
    return {
      vertices: Object.fromEntries(
        Array.from(this.verticesByLabel.entries()).map(([key, value]) => [key, value.size]),
      ),
      edges: Object.fromEntries(
        Array.from(this.edgesByLabel.entries()).map(([key, value]) => [key, value.size]),
      ),
    };
  }

  get edgeCount(): number {
    return this.edges.size;
  }

  public subscribe = (callback: () => unknown): (() => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };

  /**
   * Clones the graph as well as all the vertices and edges
   */
  public clone = (options: Partial<GraphOptions> = {}): Graph => {
    const next = new Graph(options);
    next.disableEvents();

    next.verticesById = new Map(this.verticesById);
    next.vertices = new Set(this.vertices);
    next.edgesById = new Map(this.edgesById);
    next.verticesByLabel = new Map(this.verticesByLabel);
    next.edges = new Set(this.edges);
    next.edgesFromByLabel = new Map(this.edgesFromByLabel);
    next.edgesToByLabel = new Map(this.edgesToByLabel);
    next.edgesByVertex = new Map(this.edgesByVertex);
    next.edgesByLabel = new Map(this.edgesByLabel);
    next.elementLabels = new Map(this.elementLabels);
    next.elementProperties = new Map(this.elementProperties);

    return next;
  };

  public truncate = (): void => {
    this.verticesById = new Map();
    this.vertices = new Set();
    this.edgesById = new Map();
    this.verticesByLabel = new Map();
    this.edges = new Set();
    this.edgesFromByLabel = new Map();
    this.edgesToByLabel = new Map();
    this.edgesByVertex = new Map();
    this.edgesByLabel = new Map();
    this.elementLabels = new Map();
    this.elementProperties = new Map();

    this.nextSnapshot = null;
  };

  private readonly notify = (): void => {
    for (const listener of this.listeners) {
      listener();
    }
  };

  private readonly prepareNextSnapshot = (): Graph => {
    if (this.nextSnapshot && !this.nextSnapshotIsStale) {
      return this.nextSnapshot;
    }

    const timeSnapshotCreation = timer(
      `Cloning the graph with ${this.vertexCount} vertices and ${this.edgeCount} edges`,
    );

    this.nextSnapshot = this.clone({ eagerSnapshot: false });
    timeSnapshotCreation();
    this.nextSnapshotIsStale = false;

    this.notify();

    return this.nextSnapshot;
  };

  private readonly prepareNextSnapshotLazy = (): void => {
    const rIC: (cb: () => unknown, opts?: IdleRequestOptions) => unknown =
      typeof window !== 'undefined' && 'requestIdleCallback' in window
        ? window.requestIdleCallback
        : (cb) => setTimeout(cb, 1);
    rIC(() => this.prepareNextSnapshot(), { timeout: undefined });
  };

  public snapshot = (): Graph => {
    return this.prepareNextSnapshot();
  };

  /* Mutation methods */

  /**
   * Adds a Vertex to the Graph. Accepts either an existing Vertex or params
   * to construct a new one.
   */
  public addVertex = (params: AddVertexParams | Vertex): Vertex => {
    if (params.id && this.getVertexById(params.id)) {
      return this.getVertexById(params.id)!;
    }

    const vertex = Vertex.isVertex(params) ? params : new Vertex({ ...params, graph: this });

    const event = this.emit(new EmitterEvent('@graph/VertexAdded', vertex));

    if (event.defaultPrevented) {
      return vertex;
    }

    this.vertices.add(vertex);
    this.verticesById.set(vertex.id, vertex);

    for (const label of vertex.labels) {
      this.indexVertexLabel(label, vertex);
    }

    return vertex;
  };

  /**
   * Removes a Vertex from the Graph. Also removes any edges the Vertex was
   * part of.
   */
  public removeVertex = (vertex: Vertex | string): Vertex | null => {
    if (typeof vertex === 'string') {
      const found = this.verticesById.get(vertex);
      if (!found) {
        return null;
      }
      return this.removeVertex(found);
    }

    const event = this.emit(new EmitterEvent('@graph/VertexRemoved', vertex));

    if (event.defaultPrevented) {
      return vertex;
    }

    const edges = this.edgesByVertex.get(vertex.id) ?? new Set();

    for (const edge of edges) {
      this.removeEdge(edge);
    }

    for (const label of vertex.labels) {
      this.deIndexVertexLabel(label, vertex);
    }

    this.vertices.delete(vertex);
    this.verticesById.delete(vertex.id);

    vertex.evict();

    return vertex;
  };

  public addLabelToVertex = (label: string, vertex: Vertex): Vertex => {
    const event = this.emit(new EmitterEvent('@graph/LabelAddedToVertex', { label, vertex }));

    if (event.defaultPrevented) {
      return vertex;
    }

    this.indexVertexLabel(label, vertex);
    const next = new Set(this.elementLabels.get(vertex.id) ?? []);
    next.add(label);
    this.elementLabels.set(vertex.id, next);

    return vertex;
  };

  public removeLabelFromVertex = (label: string, vertex: Vertex): Vertex => {
    const event = this.emit(new EmitterEvent('@graph/LabelRemovedFromVertex', { label, vertex }));

    if (event.defaultPrevented) {
      return vertex;
    }

    this.deIndexVertexLabel(label, vertex);
    const next = new Set(this.elementLabels.get(vertex.id) ?? []);
    next.delete(label);
    this.elementLabels.set(vertex.id, next);
    return vertex;
  };

  /**
   * Adds an Edge to the Graph. Accepts either an existing Edge or params to
   * construct a new one.
   */
  public addEdge = (params: AddEdgeArgs | Edge): Edge => {
    if (params.id && this.getEdgeById(params.id)) {
      return this.getEdgeById(params.id)!;
    }

    const edge = Edge.isEdge(params) ? params : new Edge({ ...params, graph: this });

    if (!edge.from || !edge.to) {
      console.error('Cannot create edge with missing vertices.');
      return edge;
    }

    const event = this.emit(new EmitterEvent('@graph/EdgeAdded', edge));

    if (event.defaultPrevented) {
      return edge;
    }

    this.edges.add(edge);
    this.edgesById.set(edge.id, edge);

    for (const label of edge.labels) {
      this.indexEdgeLabel(label, edge);
    }

    if (!this.edgesByVertex.has(edge.to.id)) {
      this.edgesByVertex.set(edge.to.id, new Set());
    }

    if (!this.edgesByVertex.has(edge.from.id)) {
      this.edgesByVertex.set(edge.from.id, new Set());
    }

    this.edgesByVertex.get(edge.to.id)?.add(edge);
    this.edgesByVertex.get(edge.from.id)?.add(edge);

    return edge;
  };

  public removeEdge = (edge: Edge): Edge => {
    const event = this.emit(new EmitterEvent('@graph/EdgeRemoved', edge));

    if (event.defaultPrevented) {
      return edge;
    }

    for (const label of edge.labels) {
      this.deIndexEdgeLabel(label, edge);
    }

    this.edgesByVertex.get(edge.to.id)?.delete(edge);
    this.edgesByVertex.get(edge.from.id)?.delete(edge);

    this.edgesById.delete(edge.id);
    this.edges.delete(edge);

    edge.evict();

    return edge;
  };

  public addLabelToEdge = (label: string, edge: Edge): Edge => {
    if (edge.labels.has(label)) {
      return edge;
    }

    const event = this.emit(new EmitterEvent('@graph/LabelAddedToEdge', { label, edge }));

    if (event.defaultPrevented) {
      return edge;
    }

    const next = new Set(this.elementLabels.get(edge.id) ?? []);
    next.add(label);
    this.elementLabels.set(edge.id, next);

    this.indexEdgeLabel(label, edge);

    return edge;
  };

  public removeLabelFromEdge = (label: string, edge: Edge): Edge => {
    if (!edge.labels.has(label)) {
      return edge;
    }

    const event = this.emit(new EmitterEvent('@graph/LabelRemovedFromEdge', { label, edge }));

    if (event.defaultPrevented) {
      return edge;
    }

    const next = new Set(this.elementLabels.get(edge.id) ?? []);
    next.delete(label);
    this.elementLabels.set(edge.id, next);

    this.deIndexEdgeLabel(label, edge);

    return edge;
  };

  /* Query methods */

  public hasVertex = (vertex: Vertex | string): boolean => {
    if (typeof vertex === 'string') {
      return this.verticesById.has(vertex);
    }

    return this.vertices.has(vertex);
  };

  public owns = (x: Vertex | Edge): boolean => {
    return (Vertex.isVertex(x) && this.vertices.has(x)) || (Edge.isEdge(x) && this.edges.has(x));
  };

  public getVertexById = (id: string): Vertex | null => {
    return this.verticesById.get(id) ?? null;
  };

  public getEdgeById = (id: string): Edge | null => {
    return this.edgesById.get(id) ?? null;
  };

  public getVerticesByLabel = (label: string): Set<Vertex> => {
    return new Set(this.verticesByLabel.get(label) ?? []);
  };

  public getEdgesByLabel = (label: string): Set<Edge> => {
    return new Set(this.edgesByLabel.get(label) ?? []);
  };

  /* Event Emitter Proxy */

  public eventsEnabled = (): boolean => {
    return this.emitter.isEnabled();
  };

  public enableEvents = (): void => {
    this.emitter.enable();
  };

  public disableEvents = (): void => {
    this.emitter.disable();
  };

  public on = <T extends keyof GraphEvents>(
    type: T,
    listener: (event: GraphEvents[T]) => unknown,
  ): void => {
    this.emitter.on(type, listener);
  };

  public once = <T extends keyof GraphEvents>(
    type: T,
    listener: (event: GraphEvents[T]) => unknown,
  ): void => {
    this.emitter.once(type, listener);
  };

  public emit = <T extends EmitterEvent<any, any>>(event: T): T => {
    return this.emitter.emit(event as never) as T;
  };

  /* Internal Methods */

  private readonly indexVertexLabel = (label: string, vertex: Vertex): void => {
    if (!this.verticesByLabel.has(label)) {
      this.verticesByLabel.set(label, new Set());
    }

    this.verticesByLabel.get(label)?.add(vertex);
  };

  private readonly deIndexVertexLabel = (label: string, vertex: Vertex): void => {
    if (
      this.verticesByLabel.get(label)?.delete(vertex) &&
      this.verticesByLabel.get(label)?.size === 0
    ) {
      this.verticesByLabel.delete(label);
    }
  };

  private readonly indexEdgeLabel = (label: string, edge: Edge) => {
    if (!this.edgesByLabel.has(label)) {
      this.edgesByLabel.set(label, new Set());
    }

    this.edgesByLabel.get(label)!.add(edge);

    if (!this.edgesFromByLabel.has(edge.from.id)) {
      this.edgesFromByLabel.set(edge.from.id, new Map());
    }

    const edgesFrom = this.edgesFromByLabel.get(edge.from.id)!;

    if (!edgesFrom.has(label)) {
      edgesFrom.set(label, new Set());
    }

    edgesFrom.get(label)!.add(edge);

    if (!this.edgesToByLabel.has(edge.to.id)) {
      this.edgesToByLabel.set(edge.to.id, new Map());
    }

    const edgesTo = this.edgesToByLabel.get(edge.to.id)!;

    if (!edgesTo.has(label)) {
      edgesTo.set(label, new Set());
    }

    edgesTo.get(label)!.add(edge);
  };

  private readonly deIndexEdgeLabel = (label: string, edge: Edge) => {
    this.edgesByLabel.get(label)?.delete(edge);

    const fromId = edge.from.id;
    if (
      this.edgesFromByLabel.get(fromId)?.get(label)?.delete(edge) &&
      this.edgesFromByLabel.get(fromId)?.get(label)?.size === 0
    ) {
      this.edgesFromByLabel.get(fromId)?.delete(label);
    }

    const toId = edge.to.id;
    if (
      this.edgesToByLabel.get(toId)?.get(label)?.delete(edge) &&
      this.edgesToByLabel.get(toId)?.get(label)?.size === 0
    ) {
      this.edgesToByLabel.get(toId)?.delete(label);
    }
  };
}
