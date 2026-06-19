import { Emitter, EmitterEvent } from '@pl-graph/emitter';
import { ErrorCode, PlGraphError } from '@pl-graph/errors';

import { Edge } from './Edge.js';
import type { GraphEvent, GraphEvents, GraphEventType } from './GraphEvents.js';
import { PropertyIndex, type RangeBound } from './PropertyIndex.js';
import { Vertex } from './Vertex.js';

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

  elementLabels: Map<string, Set<string>>;
  elementProperties: Map<string, Record<string, unknown>>;

  /** Opt-in secondary indexes over property values (see {@link PropertyIndex}). */
  vertexPropertyIndex: PropertyIndex<Vertex>;
  edgePropertyIndex: PropertyIndex<Edge>;

  private readonly listeners: Set<() => unknown>;

  // A `requestIdleCallback` handle (number) in the browser, or a `setTimeout`
  // handle in Node — the pending debounced subscriber notification, if any.
  private notifyHandle: ReturnType<typeof setTimeout> | number | undefined;

  // Reactive change tracking (mirrors the Rust core, for useSyncExternalStore):
  // `mutationVersion` is an O(1) "did anything change?" signal; `tokenEpochs`
  // are per-token (label / edge-type / property-key) counters for *selective*
  // invalidation — a selector that depends only on `name` recomputes only when
  // `epoch('name')` moved, not on every mutation. Both advance on the same
  // deferred, veto-checked step, so a vetoed mutation bumps nothing.
  private mutationVersion: number;
  private readonly tokenEpochs: Map<string, number>;

  emitter: Emitter<keyof GraphEvents, GraphEvents>;

  constructor() {
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

    this.mutationVersion = 0;
    this.tokenEpochs = new Map();
    this.emitter = new Emitter({ enabled: true });

    this.listeners = new Set();

    this.notifyHandle = undefined;

    // Coalesce subscriber notifications: many mutations in a tick collapse into
    // one deferred `notify()`. Idle-scheduled in the browser, a 1ms timer in Node.
    const scheduleNotify = () => {
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        window.cancelIdleCallback(this.notifyHandle as number);
        this.notifyHandle = window.requestIdleCallback(this.notify);
      } else {
        globalThis.clearTimeout(this.notifyHandle);
        // Store the handle so the next mutation's clearTimeout above actually
        // cancels this one — otherwise every mutation leaks a fresh timer and
        // the debounce never coalesces.
        this.notifyHandle = globalThis.setTimeout(this.notify, 1);
      }
    };

    const markMutated = (event: GraphEvent) => {
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

        scheduleNotify();
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
      this.on(type, markMutated as never);
      this.on(type, onMutate as never);
    });
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
  public clone = (): Graph => {
    const next = new Graph();
    next.disableEvents();

    // Recreate the declared (but empty) indexes so the backfill below populates
    // the clone's own buckets rather than aliasing the source's.
    for (const key of this.vertexPropertyIndex.indexedKeys()) {
      next.vertexPropertyIndex.createIndex(key);
    }

    for (const key of this.edgePropertyIndex.indexedKeys()) {
      next.edgePropertyIndex.createIndex(key);
    }

    // Deep copy: each vertex/edge is a *fresh* instance bound to `next`, with
    // its own labels and property bag. Nothing is shared with the source, so a
    // mutation on either graph can't reach into the other. Endpoints resolve to
    // the clone's own vertices by id.
    for (const vertex of this.verticesById.values()) {
      next.addVertex(
        new Vertex({
          id: vertex.id,
          labels: [...vertex.labels],
          properties: { ...vertex.properties },
          graph: next,
        }),
      );
    }

    for (const edge of this.edgesById.values()) {
      next.addEdge(
        new Edge({
          id: edge.id,
          from: next.getVertexById(edge.from.id)!,
          to: next.getVertexById(edge.to.id)!,
          labels: [...edge.labels],
          properties: { ...edge.properties },
          graph: next,
        }),
      );
    }

    if (this.eventsEnabled()) {
      next.enableEvents();
    }

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
  };

  private readonly notify = (): void => {
    for (const listener of this.listeners) {
      listener();
    }
  };

  /**
   * The graph to read for a `useSyncExternalStore` snapshot. Reads are served
   * from the live graph itself — no copy is made. Referential stability across
   * renders is provided by the consumer's epoch/version fingerprinting (see the
   * React `useGraphSelector` gate), not by isolating a frozen copy here. For an
   * independent, mutable copy of the graph use {@link clone} instead.
   */
  public snapshot = (): Graph => this;

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

    // Idempotent: dropping an already-removed vertex is a no-op. Without this,
    // a second removal re-emits `VertexRemoved` for an evicted vertex whose
    // `labels` getter dereferences a now-null graph → TypeError. (The string
    // overload above already short-circuits; this guards the object overload.)
    if (!this.verticesById.has(vertex.id)) {
      return null;
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

    if (Edge.isEdge(params)) {
      this.assertValidEdge(params.from, params.to, params.labels.size);

      return this.insertEdge(params);
    }

    // Validate the *params* before constructing: the `Edge` constructor eagerly
    // writes labels/properties into the graph's element maps via its setters, so
    // rejecting after construction would leave orphaned map entries behind.
    // `params.from`/`params.to` are vertices that must already live in this
    // graph — resolve them by id the same way the edge's getters will.
    this.assertValidEdge(
      this.getVertexById(params.from.id),
      this.getVertexById(params.to.id),
      params.labels.length,
    );

    return this.insertEdge(new Edge({ ...params, graph: this }));
  };

  /**
   * Reject an edge that can't be a valid LPG member: both endpoints must resolve
   * to vertices in this graph, and it must carry ≥1 label — the invariant the
   * removal cascade depends on (a label-less edge never lands in a label bucket,
   * so `incidentEdges`/`removeVertex` can't find it, leaving a dangling edge).
   */
  private assertValidEdge(from: Vertex | null, to: Vertex | null, labelCount: number): void {
    if (!from || !to) {
      throw new PlGraphError('Cannot add an edge with missing endpoint vertices.', {
        code: ErrorCode.MissingVertex,
      });
    }

    if (labelCount === 0) {
      throw new PlGraphError('Cannot add an edge with no labels: every edge must carry ≥1 label.', {
        code: ErrorCode.InvalidGraphOp,
      });
    }
  }

  /** Shared insertion tail: emit, then register the edge in the id and label indexes. */
  private readonly insertEdge = (edge: Edge): Edge => {
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
