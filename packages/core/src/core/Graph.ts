import { Emitter, EmitterEvent } from '@pl-graph/emitter';
import { timer } from '@pl-graph/utils';

import { Edge } from './Edge.js';
import { PropertyIndex, type RangeBound } from './PropertyIndex.js';
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

  edgesById: Map<string, Edge>;
  edgesByLabel: Map<string, Set<Edge>>;
  edgesFromByLabel: Map<string, Map<string, Set<Edge>>>;
  edgesToByLabel: Map<string, Map<string, Set<Edge>>>;

  eagerSnapshot: boolean;

  elementLabels: Map<string, Set<string>>;
  elementProperties: Map<string, Record<string, unknown>>;

  /** Opt-in secondary indexes over property values (see {@link PropertyIndex}). */
  vertexPropertyIndex: PropertyIndex<Vertex>;
  edgePropertyIndex: PropertyIndex<Edge>;

  private readonly listeners: Set<() => unknown>;

  public nextSnapshot: Graph | null;

  private nextSnapshotIsStale: boolean;
  private createNextSnapshot: number | undefined;

  // Reactive change tracking (mirrors the Rust core, for useSyncExternalStore):
  // `mutationVersion` is an O(1) "did anything change?" signal; `tokenEpochs`
  // are per-token (label / edge-type / property-key) counters for *selective*
  // invalidation — a selector that depends only on `name` recomputes only when
  // `epoch('name')` moved, not on every mutation. Both advance on the same
  // deferred, veto-checked step as snapshot-staleness, so a vetoed mutation
  // bumps nothing.
  private mutationVersion: number;
  private readonly tokenEpochs: Map<string, number>;

  emitter: Emitter<keyof GraphEvents, GraphEvents>;

  constructor(options: Partial<GraphOptions> = {}) {
    this.verticesById = new Map();
    this.edgesById = new Map();
    this.verticesByLabel = new Map();
    this.edgesFromByLabel = new Map();
    this.edgesToByLabel = new Map();
    this.edgesByLabel = new Map();

    this.elementLabels = new Map();
    this.elementProperties = new Map();

    this.vertexPropertyIndex = new PropertyIndex();
    this.edgePropertyIndex = new PropertyIndex();

    this.eagerSnapshot = options.eagerSnapshot ?? true;

    this.nextSnapshot = null;
    this.nextSnapshotIsStale = true;
    this.mutationVersion = 0;
    this.tokenEpochs = new Map();
    this.emitter = new Emitter({ enabled: true });

    this.listeners = new Set();

    this.createNextSnapshot = undefined;

    const callback = () => {
      this.prepareNextSnapshotLazy();
    };

    const markIsStale = (event: GraphEvent) => {
      // Capture the touched tokens NOW, synchronously, while the element is
      // still attached — a removal nulls the element's graph ref before the
      // deferred step below runs, so reading labels/keys there would throw.
      const tokens = this.tokensOf(event);
      const doTheWork = () => {
        if (event.defaultPrevented) {
          return;
        }

        // Advance the reactive counters — deferred so `defaultPrevented` is
        // final and a vetoed mutation bumps nothing.
        this.mutationVersion += 1;
        for (const token of tokens) {
          this.tokenEpochs.set(token, (this.tokenEpochs.get(token) ?? 0) + 1);
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

  /**
   * The graph's vertices, as a re-iterable view over `verticesById` (insertion
   * order). Not a stored `Set` — membership/identity lives in `verticesById`,
   * so iterating here costs nothing extra and inserts pay no second structure.
   */
  get vertices(): Iterable<Vertex> {
    return { [Symbol.iterator]: () => this.verticesById.values() };
  }

  /** The graph's edges, as a re-iterable view over `edgesById` (insertion order). */
  get edges(): Iterable<Edge> {
    return { [Symbol.iterator]: () => this.edgesById.values() };
  }

  get size(): number {
    return this.verticesById.size;
  }

  get vertexCount(): number {
    return this.verticesById.size;
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
    return this.edgesById.size;
  }

  public subscribe = (callback: () => unknown): (() => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };

  /**
   * Monotonic mutation counter — an O(1) "did anything change?" signal for
   * `useSyncExternalStore`-style snapshots. Advances on the same deferred,
   * veto-checked step as snapshot-staleness (so it reflects committed changes
   * by the time subscribers are notified).
   */
  get version(): number {
    return this.mutationVersion;
  }

  /**
   * The change epoch for a single token — a label, edge-type, or property-key
   * name (0 if never touched). A selector that depends only on specific tokens
   * can fingerprint `deps.map(epoch)` and recompute *only* when one of them
   * moved, instead of on every mutation.
   */
  public epoch = (name: string): number => this.tokenEpochs.get(name) ?? 0;

  /**
   * The tokens (label / edge-type / property-key names) a mutation event
   * touched — used to bump the right epochs. A topology change (add/remove an
   * element) touches that element's labels *and* property keys; a property
   * write touches just the key; a label change touches just the label. This
   * mirrors the Rust core's epoch rule, so `epoch('Person')` moves iff Person
   * membership changed and `epoch('age')` iff some age value changed.
   */
  private tokensOf(event: GraphEvent): string[] {
    const value = event.value as Record<string, any>;
    switch (event.type) {
      case '@graph/VertexAdded':
      case '@graph/VertexRemoved':
      case '@graph/EdgeAdded':
      case '@graph/EdgeRemoved': {
        const labels: string[] = value?.labels ? [...value.labels] : [];
        const keys: string[] = value?.properties ? Object.keys(value.properties) : [];
        return [...labels, ...keys];
      }
      case '@graph/LabelAddedToVertex':
      case '@graph/LabelRemovedFromVertex':
      case '@graph/LabelAddedToEdge':
      case '@graph/LabelRemovedFromEdge':
        return value?.label ? [value.label as string] : [];
      case '@graph/VertexPropertyChanged':
      case '@graph/EdgePropertyChanged':
      case '@graph/VertexPropertyRemoved':
      case '@graph/EdgePropertyRemoved':
        return value?.key ? [value.key as string] : [];
      case '@graph/VertexPropertiesChanged':
      case '@graph/EdgePropertiesChanged':
        return value?.next ? Object.keys(value.next) : [];
      case '@graph/VertexPropertiesRemoved':
      case '@graph/EdgePropertiesRemoved':
        return (value?.keys as string[]) ?? [];
      default:
        return [];
    }
  }

  /**
   * Clones the graph as well as all the vertices and edges
   */
  public clone = (options: Partial<GraphOptions> = {}): Graph => {
    const next = new Graph(options);
    next.disableEvents();

    next.verticesById = new Map(this.verticesById);
    next.edgesById = new Map(this.edgesById);
    next.verticesByLabel = new Map(this.verticesByLabel);
    next.edgesFromByLabel = new Map(this.edgesFromByLabel);
    next.edgesToByLabel = new Map(this.edgesToByLabel);
    next.edgesByLabel = new Map(this.edgesByLabel);
    next.elementLabels = new Map(this.elementLabels);
    next.elementProperties = new Map(this.elementProperties);

    // Structural copies so a mutation on either graph can't corrupt the other's
    // buckets; the cloned sets still point at the shared element instances.
    next.vertexPropertyIndex = this.vertexPropertyIndex.clone();
    next.edgePropertyIndex = this.edgePropertyIndex.clone();

    return next;
  };

  public truncate = (): void => {
    this.verticesById = new Map();
    this.edgesById = new Map();
    this.verticesByLabel = new Map();
    this.edgesFromByLabel = new Map();
    this.edgesToByLabel = new Map();
    this.edgesByLabel = new Map();
    this.elementLabels = new Map();
    this.elementProperties = new Map();

    // Keep declared indexes but drop their contents — `truncate` empties the
    // graph, not its schema.
    this.vertexPropertyIndex.clear();
    this.edgePropertyIndex.clear();

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

    this.verticesById.set(vertex.id, vertex);

    for (const label of vertex.labels) {
      this.indexVertexLabel(label, vertex);
    }

    this.vertexPropertyIndex.add(vertex, vertex.properties);

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

    for (const edge of this.incidentEdges(vertex.id)) {
      this.removeEdge(edge);
    }

    for (const label of vertex.labels) {
      this.deIndexVertexLabel(label, vertex);
    }

    // De-index properties while they're still readable (evict() severs the
    // vertex from the graph, after which `vertex.properties` reads empty).
    this.vertexPropertyIndex.remove(vertex, vertex.properties);

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

    this.edgesById.set(edge.id, edge);

    for (const label of edge.labels) {
      this.indexEdgeLabel(label, edge);
    }

    this.edgePropertyIndex.add(edge, edge.properties);

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

    this.edgePropertyIndex.remove(edge, edge.properties);

    this.edgesById.delete(edge.id);

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

  /* Property indexes */

  /**
   * Declare `key` as an indexed vertex property and backfill it from the
   * vertices already in the graph. Subsequent mutations keep it current.
   */
  public createVertexIndex = (key: string): void => {
    this.vertexPropertyIndex.createIndex(key);
    for (const vertex of this.verticesById.values()) {
      this.vertexPropertyIndex.addForKey(vertex, key, vertex.properties[key]);
    }
  };

  public dropVertexIndex = (key: string): void => {
    this.vertexPropertyIndex.dropIndex(key);
  };

  public createEdgeIndex = (key: string): void => {
    this.edgePropertyIndex.createIndex(key);
    for (const edge of this.edgesById.values()) {
      this.edgePropertyIndex.addForKey(edge, key, edge.properties[key]);
    }
  };

  public dropEdgeIndex = (key: string): void => {
    this.edgePropertyIndex.dropIndex(key);
  };

  /** The property keys currently indexed for vertices / edges. */
  public vertexIndexes = (): string[] => this.vertexPropertyIndex.indexedKeys();
  public edgeIndexes = (): string[] => this.edgePropertyIndex.indexedKeys();

  /** Vertices with `key === value`. Empty set if `key` isn't indexed. */
  public getVerticesByProperty = (key: string, value: unknown): Set<Vertex> => {
    return new Set(this.vertexPropertyIndex.equals(key, value) ?? []);
  };

  /** Vertices whose `key` falls within `bound`. Empty set if `key` isn't indexed. */
  public getVerticesByPropertyRange = (key: string, bound: RangeBound): Set<Vertex> => {
    return this.vertexPropertyIndex.range(key, bound) ?? new Set();
  };

  public getEdgesByProperty = (key: string, value: unknown): Set<Edge> => {
    return new Set(this.edgePropertyIndex.equals(key, value) ?? []);
  };

  public getEdgesByPropertyRange = (key: string, bound: RangeBound): Set<Edge> => {
    return this.edgePropertyIndex.range(key, bound) ?? new Set();
  };

  /**
   * Keep the vertex property index current after a property write actually
   * lands. Called by {@link Vertex} once a mutation clears its event guard, so
   * a prevented mutation never touches the index. No-ops for unindexed keys.
   */
  public reindexVertexProperty = (
    vertex: Vertex,
    key: string,
    oldValue: unknown,
    newValue: unknown,
  ): void => {
    this.vertexPropertyIndex.update(vertex, key, oldValue, newValue);
  };

  public reindexEdgeProperty = (
    edge: Edge,
    key: string,
    oldValue: unknown,
    newValue: unknown,
  ): void => {
    this.edgePropertyIndex.update(edge, key, oldValue, newValue);
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

  /**
   * Every edge incident to `id`, in either direction, reconstructed from the
   * directional label indexes (the union of every per-label bucket under the
   * vertex in `edgesFromByLabel` and `edgesToByLabel`). A `Set` dedupes the two
   * directions for self-loops. This is the cascade source for `removeVertex` —
   * it relies on the LPG invariant that every edge carries at least one label
   * (enforced by both the GQL and Gremlin layers), so it appears under some
   * bucket. We keep no separate per-vertex edge index, since vertex removal is
   * the only reader and it is far colder than the edge-insert path that index
   * would tax.
   */
  private readonly incidentEdges = (id: string): Set<Edge> => {
    const incident = new Set<Edge>();
    for (const byLabel of [this.edgesFromByLabel.get(id), this.edgesToByLabel.get(id)]) {
      for (const bucket of byLabel?.values() ?? []) {
        for (const edge of bucket) {
          incident.add(edge);
        }
      }
    }
    return incident;
  };

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
