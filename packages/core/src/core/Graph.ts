import { Emitter, EmitterEvent } from '@lenke/emitter';
import { ErrorCode, LenkeError } from '@lenke/errors';

import { Edge } from './Edge.js';
import type { GraphEvent, GraphEvents, GraphEventType } from './GraphEvents.js';
import { PropertyIndex, type RangeBound } from './PropertyIndex.js';
import { validateElementNames, validateLabel } from './validate.js';
import { Vertex } from './Vertex.js';

type AddVertexParams = {
  id?: string;
  labels: string[];
  // Optional: a plain labeled vertex needs no properties (defaults to `{}`).
  properties?: Record<string, unknown>;
};

type AddEdgeArgs = {
  id?: string;
  from: Vertex;
  to: Vertex;
  labels: string[];
  // Optional: a plain labeled edge needs no properties (defaults to `{}`).
  properties?: Record<string, unknown>;
};

export type GraphOptions = {
  /**
   * Invoked when a graph-event listener or a `subscribe()` callback throws.
   * Isolation: one failing listener can neither stop the others nor break a
   * deferred `notify()` (which runs from an idle/timeout callback, where an
   * escaping throw would be an unhandled error with no context). Defaults to
   * re-throwing on a microtask — visible to the host's unhandled-error handling
   * without interrupting dispatch. Mirrors the Emitter's `onError`.
   */
  onError?: (error: unknown) => void;
};

/**
 * The scalar type a TYPE constraint (R-CONSTRAINTS) can require of a property
 * value — every stored non-null value maps to exactly one of these. `list` means
 * "an array" (element types are not constrained); the three temporals match the
 * `LocalDate`/`LocalDateTime`/`Duration` value classes.
 */
export type ScalarTypeName =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'duration'
  | 'list';

/** The set of accepted {@link ScalarTypeName}s, for runtime validation at the constraint boundary. */
const SCALAR_TYPE_NAMES: ReadonlySet<ScalarTypeName> = new Set([
  'string',
  'number',
  'boolean',
  'date',
  'datetime',
  'duration',
  'list',
]);

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

  // Single error sink for graph-event listeners and `subscribe()` callbacks —
  // see {@link GraphOptions.onError}.
  private readonly onError: (error: unknown) => void;

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

  constructor(options: GraphOptions = {}) {
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
    // Default: surface a listener error on a microtask — visible to the host's
    // unhandled-error handling, but it never breaks dispatch or a deferred notify.
    this.onError =
      options.onError ??
      ((error: unknown) => {
        queueMicrotask(() => {
          throw error;
        });
      });
    this.emitter = new Emitter({ enabled: true, onError: (error) => this.onError(error) });

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
        // Advance the reactive counters (deferred so a burst of mutations
        // coalesces into one React notify). A mutation event always means a
        // committed write — events are observation-only, nothing vetoes.
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

  /**
   * Total element count — vertices **plus** edges — as a quick "how big is
   * this?" scalar. For the per-type counts use {@link vertexCount} /
   * {@link edgeCount}; for the per-label breakdown use {@link stats}.
   */
  get size(): number {
    return this.verticesById.size + this.edgesById.size;
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
    // Emit a removal event for every element before clearing, so `truncate` — the
    // most destructive op — is visible to every listener/journal that already
    // handles `@graph/EdgeRemoved`/`@graph/VertexRemoved` (React sync, an audit
    // stream via `@graph/mutate`, the CDC WriteLog), with no special-casing.
    // Edges first, then vertices (a clean teardown order a journal can replay).
    // The elements are still live at emit time. Events are observation-only, so
    // these are notifications — nothing can veto the reset.
    const edges = [...this.edgesById.values()];
    const vertices = [...this.verticesById.values()];

    for (const edge of edges) {
      this.emit(new EmitterEvent('@graph/EdgeRemoved', edge));
    }

    for (const vertex of vertices) {
      this.emit(new EmitterEvent('@graph/VertexRemoved', vertex));
    }

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
    // Snapshot first: a subscriber that (un)subscribes from within its own
    // callback must not perturb the in-flight pass, and mutating the Set
    // mid-iteration is itself a hazard. Then isolate each subscriber — `notify`
    // runs from a deferred idle/timeout callback, so an escaping throw would skip
    // every later subscriber and surface as an unhandled error with no context.
    // Mirrors the Emitter's listener isolation.
    for (const listener of new Set(this.listeners)) {
      try {
        listener();
      } catch (error) {
        this.onError(error);
      }
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
    // Ingestion gate: reject a malformed label / property key before the Vertex
    // constructor writes it into the graph's element maps.
    validateElementNames(params.labels, params.properties ?? {});

    if (params.id && this.getVertexById(params.id)) {
      return this.getVertexById(params.id)!;
    }

    const vertex = Vertex.isVertex(params)
      ? params
      : new Vertex({ ...params, properties: params.properties ?? {}, graph: this });

    // Constraint gate: reject before emitting/committing, so a rejected write
    // leaves no trace and every write path (direct API, GQL, Gremlin, ingest)
    // is covered by one chokepoint.
    const missing = this.missingRequired(vertex.labels, vertex.properties);

    if (missing) {
      throw new LenkeError(
        `missing required property '${missing.key}' for label '${missing.label}'`,
        { code: ErrorCode.ConstraintViolation },
      );
    }

    const badType = this.typeViolation(vertex.labels, vertex.properties);

    if (badType) {
      throw new LenkeError(
        `property '${badType.key}' must be ${badType.expected} on '${badType.label}', got ${badType.got}`,
        { code: ErrorCode.ConstraintViolation },
      );
    }

    const dup = this.uniqueConflict(vertex.labels, vertex.properties, vertex);

    if (dup) {
      throw new LenkeError(
        `unique constraint on '${dup.label}.${dup.key}' violated by value ${JSON.stringify(dup.existing.properties[dup.key])}`,
        { code: ErrorCode.ConstraintViolation },
      );
    }

    this.emit(new EmitterEvent('@graph/VertexAdded', vertex));

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

    this.emit(new EmitterEvent('@graph/VertexRemoved', vertex));

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
    validateLabel(label);

    // Adding a label brings its required keys into force for this vertex.
    for (const key of this.vertexRequiredConstraints.get(label) ?? []) {
      if (!this.isPresent(vertex.properties[key])) {
        throw new LenkeError(
          `cannot add label '${label}': it requires property '${key}', which is missing`,
          { code: ErrorCode.ConstraintViolation },
        );
      }
    }

    this.emit(new EmitterEvent('@graph/LabelAddedToVertex', { label, vertex }));

    this.indexVertexLabel(label, vertex);
    const next = new Set(this.elementLabels.get(vertex.id) ?? []);
    next.add(label);
    this.elementLabels.set(vertex.id, next);

    return vertex;
  };

  public removeLabelFromVertex = (label: string, vertex: Vertex): Vertex => {
    this.emit(new EmitterEvent('@graph/LabelRemovedFromVertex', { label, vertex }));

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
    // Same gate as addVertex — validate before the Edge constructor writes.
    validateElementNames(params.labels, params.properties ?? {});

    if (params.id && this.getEdgeById(params.id)) {
      return this.getEdgeById(params.id)!;
    }

    if (Edge.isEdge(params)) {
      this.assertValidEdge(params.from, params.to, params.labels.size);

      return this.insertEdge(params);
    }

    // A missing `from`/`to` must surface as a coded error, not a raw TypeError
    // from dereferencing `params.to.id` below.
    if (!params.from || !params.to) {
      throw new LenkeError('Cannot add an edge with missing endpoint vertices.', {
        code: ErrorCode.MissingVertex,
      });
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

    return this.insertEdge(
      new Edge({ ...params, properties: params.properties ?? {}, graph: this }),
    );
  };

  /**
   * Reject an edge that can't be a valid LPG member: both endpoints must resolve
   * to vertices in this graph, and it must carry ≥1 label — the invariant the
   * removal cascade depends on (a label-less edge never lands in a label bucket,
   * so `incidentEdges`/`removeVertex` can't find it, leaving a dangling edge).
   */
  private assertValidEdge(from: Vertex | null, to: Vertex | null, labelCount: number): void {
    if (!from || !to) {
      throw new LenkeError('Cannot add an edge with missing endpoint vertices.', {
        code: ErrorCode.MissingVertex,
      });
    }

    if (labelCount === 0) {
      throw new LenkeError('Cannot add an edge with no labels: every edge must carry ≥1 label.', {
        code: ErrorCode.InvalidGraphOp,
      });
    }
  }

  /** Shared insertion tail: emit, then register the edge in the id and label indexes. */
  private readonly insertEdge = (edge: Edge): Edge => {
    this.emit(new EmitterEvent('@graph/EdgeAdded', edge));

    this.edgesById.set(edge.id, edge);

    for (const label of edge.labels) {
      this.indexEdgeLabel(label, edge);
    }

    this.edgePropertyIndex.add(edge, edge.properties);

    return edge;
  };

  public removeEdge = (edge: Edge): Edge => {
    this.emit(new EmitterEvent('@graph/EdgeRemoved', edge));

    for (const label of edge.labels) {
      this.deIndexEdgeLabel(label, edge);
    }

    this.edgePropertyIndex.remove(edge, edge.properties);

    this.edgesById.delete(edge.id);

    edge.evict();

    return edge;
  };

  public addLabelToEdge = (label: string, edge: Edge): Edge => {
    validateLabel(label);

    if (edge.labels.has(label)) {
      return edge;
    }

    this.emit(new EmitterEvent('@graph/LabelAddedToEdge', { label, edge }));

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

    this.emit(new EmitterEvent('@graph/LabelRemovedFromEdge', { label, edge }));

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

  /**
   * The first live edge of `label` from `from` to `to`, if any — the structural
   * key `_MERGE`'s edge form upserts on (ensures at most one such edge).
   * First-by-insertion-order, matching the Rust core.
   */
  public findEdge = (from: Vertex, to: Vertex, label: string): Edge | undefined => {
    for (const edge of this.edgesFromByLabel.get(from.id)?.get(label) ?? []) {
      if (edge.to === to) {
        return edge;
      }
    }

    return undefined;
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

  /* Unique constraints (declared over `(label, property key)`) */
  // At most one live vertex carrying `label` may hold a given non-null scalar
  // value for `key`. Backed by the vertex property index (so lookups seek). This
  // is the Pattern-B primitive `_MERGE` keys on; byte-identical to the Rust core.
  // See docs/design/gql-extensions.md §3.

  private readonly vertexUniqueConstraints = new Map<string, Set<string>>();

  /**
   * A value participates in uniqueness only if it's a non-null scalar — null and
   * lists/objects are exempt (SQL: NULLs distinct), matching the Rust `IdxKey`
   * domain so both engines agree on what a constraint can bucket.
   */
  private isUniqueKeyable = (value: unknown): value is string | number | boolean =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

  /**
   * Declare a UNIQUE constraint on `(label, key)`. Creates the backing vertex
   * index if absent, then registers it. Idempotent. Throws
   * {@link ErrorCode.ConstraintViolation} if the current data already violates it
   * — an already-broken constraint is meaningless (as SQL rejects the unique
   * index build).
   */
  public createUniqueConstraint = (label: string, key: string): void => {
    if (!this.vertexIndexes().includes(key)) {
      this.createVertexIndex(key);
    }

    const seen = new Set<unknown>();

    for (const vertex of this.getVerticesByLabel(label)) {
      const value = vertex.properties[key];

      if (!this.isUniqueKeyable(value)) {
        continue;
      }

      if (seen.has(value)) {
        throw new LenkeError(
          'existing data already violates the unique constraint being declared',
          { code: ErrorCode.ConstraintViolation },
        );
      }

      seen.add(value);
    }

    let keys = this.vertexUniqueConstraints.get(label);

    if (!keys) {
      keys = new Set();
      this.vertexUniqueConstraints.set(label, keys);
    }

    keys.add(key);
  };

  /**
   * Drop a unique constraint. The backing index is left in place (drop it via
   * {@link dropVertexIndex} if unwanted). Idempotent.
   */
  public dropUniqueConstraint = (label: string, key: string): void => {
    const keys = this.vertexUniqueConstraints.get(label);

    if (keys) {
      keys.delete(key);

      if (keys.size === 0) {
        this.vertexUniqueConstraints.delete(label);
      }
    }
  };

  /** Property keys under a unique constraint for `label` (sorted; empty if none). */
  public uniqueKeys = (label: string): string[] =>
    [...(this.vertexUniqueConstraints.get(label) ?? [])].sort();

  /** True iff `(label, key)` carries a unique constraint. */
  public hasUniqueConstraint = (label: string, key: string): boolean =>
    this.vertexUniqueConstraints.get(label)?.has(key) ?? false;

  /** Every declared unique constraint as sorted `[label, key]` pairs. */
  public uniqueConstraints = (): Array<[string, string]> =>
    [...this.vertexUniqueConstraints]
      .flatMap(([label, keys]) => [...keys].map((key): [string, string] => [label, key]))
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  // --- REQUIRED constraints (R-CONSTRAINTS) --------------------------------
  // A required `(label, key)` means: every vertex carrying `label` must have a
  // present, non-null value under `key`. Enforced at the core mutation boundary
  // (addVertex + property removal/null-set + addLabel), so every write path —
  // direct API, GQL, Gremlin, ingest — is covered. Byte-identical to the Rust
  // core. Declarative (no closures), so it mirrors across engines like `unique`.

  private readonly vertexRequiredConstraints = new Map<string, Set<string>>();

  /** Is a value "present" for a required constraint? Absent (`undefined`) and
   *  `null` both fail; every other stored value (incl. `''`, `0`, `false`, `[]`)
   *  satisfies presence. */
  private isPresent = (value: unknown): boolean => value !== undefined && value !== null;

  /**
   * Declare a REQUIRED constraint on `(label, key)`. Idempotent. Throws
   * {@link ErrorCode.ConstraintViolation} if any existing vertex with `label`
   * lacks a present, non-null `key` — an already-violated constraint is
   * meaningless.
   */
  public createRequiredConstraint = (label: string, key: string): void => {
    for (const vertex of this.getVerticesByLabel(label)) {
      if (!this.isPresent(vertex.properties[key])) {
        throw new LenkeError(
          `existing data already violates the required constraint being declared on (${label}, ${key})`,
          { code: ErrorCode.ConstraintViolation },
        );
      }
    }

    let keys = this.vertexRequiredConstraints.get(label);

    if (!keys) {
      keys = new Set();
      this.vertexRequiredConstraints.set(label, keys);
    }

    keys.add(key);
  };

  /** Drop a required constraint. Idempotent. */
  public dropRequiredConstraint = (label: string, key: string): void => {
    const keys = this.vertexRequiredConstraints.get(label);

    if (keys) {
      keys.delete(key);

      if (keys.size === 0) {
        this.vertexRequiredConstraints.delete(label);
      }
    }
  };

  /** Property keys required for `label` (sorted; empty if none). */
  public requiredKeys = (label: string): string[] =>
    [...(this.vertexRequiredConstraints.get(label) ?? [])].sort();

  /** True iff `(label, key)` carries a required constraint. */
  public hasRequiredConstraint = (label: string, key: string): boolean =>
    this.vertexRequiredConstraints.get(label)?.has(key) ?? false;

  /** Every declared required constraint as sorted `[label, key]` pairs. */
  public requiredConstraints = (): Array<[string, string]> =>
    [...this.vertexRequiredConstraints]
      .flatMap(([label, keys]) => [...keys].map((key): [string, string] => [label, key]))
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  /**
   * The first `(label, key)` a new element with these `labels`/`properties`
   * would violate by omitting a required key, or `undefined` if all satisfied.
   */
  public missingRequired = (
    labels: Iterable<string>,
    properties: Readonly<Record<string, unknown>>,
  ): { label: string; key: string } | undefined => {
    if (this.vertexRequiredConstraints.size === 0) {
      return undefined;
    }

    for (const label of labels) {
      for (const key of this.vertexRequiredConstraints.get(label) ?? []) {
        if (!this.isPresent(properties[key])) {
          return { label, key };
        }
      }
    }

    return undefined;
  };

  /** True iff `key` is required by any of `vertex`'s labels (so it can't be
   *  removed or set to null). */
  public isRequiredKey = (vertex: Vertex, key: string): boolean => {
    if (this.vertexRequiredConstraints.size === 0) {
      return false;
    }

    for (const label of vertex.labels) {
      if (this.vertexRequiredConstraints.get(label)?.has(key)) {
        return true;
      }
    }

    return false;
  };

  /** Throw if setting `vertex.key = value` would null out a required key. Called
   *  by the property mutators so every write path is guarded, not just the API. */
  public assertRequiredOnSet = (vertex: Vertex, key: string, value: unknown): void => {
    if (!this.isPresent(value) && this.isRequiredKey(vertex, key)) {
      throw new LenkeError(`cannot set required property '${key}' to null`, {
        code: ErrorCode.ConstraintViolation,
      });
    }
  };

  /** Throw if removing `vertex.key` would drop a required key. */
  public assertRequiredOnRemove = (vertex: Vertex, key: string): void => {
    if (this.isRequiredKey(vertex, key)) {
      throw new LenkeError(`cannot remove required property '${key}'`, {
        code: ErrorCode.ConstraintViolation,
      });
    }
  };

  // --- TYPE constraints (R-CONSTRAINTS) ------------------------------------
  // A type `(label, key, type)` means: every present, non-null value under `key`
  // on a vertex carrying `label` must be of the given scalar type. Null/absent
  // are exempt (a null has no type — use a `required` constraint for presence).
  // Enforced at the core mutation boundary; byte-identical to the Rust core.

  private readonly vertexTypeConstraints = new Map<string, Map<string, ScalarTypeName>>();

  /** The scalar type of a stored value, or `null` for null/absent (type-exempt). */
  private valueType = (v: unknown): ScalarTypeName | null => {
    if (v === undefined || v === null) {
      return null;
    }

    if (Array.isArray(v)) {
      return 'list';
    }

    const t = typeof v;

    if (t === 'string' || t === 'number' || t === 'boolean') {
      return t;
    }

    // Temporals carry a `kind` discriminant ('date' | 'datetime' | 'duration').
    if (typeof v === 'object' && 'kind' in v) {
      const k = (v as { kind: unknown }).kind;

      if (k === 'date' || k === 'datetime' || k === 'duration') {
        return k;
      }
    }

    return 'string'; // unreachable for a validated scalar value
  };

  /**
   * Declare a TYPE constraint on `(label, key)`. Idempotent (re-declaring
   * replaces). Throws {@link ErrorCode.ConstraintViolation} if any existing
   * vertex with `label` holds a present, non-null `key` of a different type.
   */
  public createTypeConstraint = (label: string, key: string, type: ScalarTypeName): void => {
    if (!SCALAR_TYPE_NAMES.has(type)) {
      throw new LenkeError(
        `unknown scalar type '${type}' for the type constraint on (${label}, ${key}); expected one of ${[...SCALAR_TYPE_NAMES].join(', ')}`,
        { code: ErrorCode.InvalidValue },
      );
    }

    for (const vertex of this.getVerticesByLabel(label)) {
      const got = this.valueType(vertex.properties[key]);

      if (got !== null && got !== type) {
        throw new LenkeError(
          `existing data already violates the type constraint being declared on (${label}, ${key}): found ${got}, expected ${type}`,
          { code: ErrorCode.ConstraintViolation },
        );
      }
    }

    let keys = this.vertexTypeConstraints.get(label);

    if (!keys) {
      keys = new Map();
      this.vertexTypeConstraints.set(label, keys);
    }

    keys.set(key, type);
  };

  /** Drop a type constraint. Idempotent. */
  public dropTypeConstraint = (label: string, key: string): void => {
    const keys = this.vertexTypeConstraints.get(label);

    if (keys) {
      keys.delete(key);

      if (keys.size === 0) {
        this.vertexTypeConstraints.delete(label);
      }
    }
  };

  /** The declared type for `(label, key)`, or `undefined`. */
  public typeConstraint = (label: string, key: string): ScalarTypeName | undefined =>
    this.vertexTypeConstraints.get(label)?.get(key);

  /** Every declared type constraint as sorted `[label, key, type]` triples. */
  public typeConstraints = (): Array<[string, string, ScalarTypeName]> =>
    [...this.vertexTypeConstraints]
      .flatMap(([label, keys]) =>
        [...keys].map(([key, type]): [string, string, ScalarTypeName] => [label, key, type]),
      )
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  /**
   * The first type violation a new element with these `labels`/`properties`
   * would cause, or `undefined`. Null/absent values are exempt.
   */
  public typeViolation = (
    labels: Iterable<string>,
    properties: Readonly<Record<string, unknown>>,
  ): { label: string; key: string; expected: ScalarTypeName; got: ScalarTypeName } | undefined => {
    if (this.vertexTypeConstraints.size === 0) {
      return undefined;
    }

    for (const label of labels) {
      const cs = this.vertexTypeConstraints.get(label);

      if (!cs) {
        continue;
      }

      for (const [key, type] of cs) {
        const got = this.valueType(properties[key]);

        if (got !== null && got !== type) {
          return { label, key, expected: type, got };
        }
      }
    }

    return undefined;
  };

  /** Throw if setting `vertex.key = value` would break a type constraint. Null
   *  is exempt (a null has no type — `required` governs presence). */
  public assertTypeOnSet = (vertex: Vertex, key: string, value: unknown): void => {
    if (this.vertexTypeConstraints.size === 0) {
      return;
    }

    const got = this.valueType(value);

    if (got === null) {
      return;
    }

    for (const label of vertex.labels) {
      const type = this.vertexTypeConstraints.get(label)?.get(key);

      if (type && got !== type) {
        throw new LenkeError(`property '${key}' must be ${type} on '${label}', got ${got}`, {
          code: ErrorCode.ConstraintViolation,
        });
      }
    }
  };

  /**
   * Throw if setting `vertex.key = value` would collide with another vertex
   * under a unique constraint. Called from the property-write chokepoint so the
   * direct API enforces the same invariant the GQL `SET` path does.
   */
  public assertUniqueOnSet = (vertex: Vertex, key: string, value: unknown): void => {
    const conflict = this.uniqueConflictOnSet(vertex, key, value);

    if (conflict) {
      throw new LenkeError(
        `unique constraint on '${conflict.label}.${key}' violated by value ${JSON.stringify(value)}`,
        { code: ErrorCode.ConstraintViolation },
      );
    }
  };

  /**
   * The single live vertex carrying `label` whose `key === value`, if any (≤1
   * under the constraint). The `_MERGE` create-vs-update decision. Null/list
   * values yield `undefined` (exempt).
   */
  public uniqueLookup = (label: string, key: string, value: unknown): Vertex | undefined => {
    if (!this.isUniqueKeyable(value)) {
      return undefined;
    }

    for (const vertex of this.vertexPropertyIndex.equals(key, value) ?? []) {
      if (vertex.hasLabel(label)) {
        return vertex;
      }
    }

    return undefined;
  };

  /**
   * If adding a vertex with `labels` + `properties` would break a unique
   * constraint, the offending `{ label, key, existing }`. Drives INSERT
   * enforcement; `exclude` skips one vertex. Only constrained keys present with a
   * non-null scalar value are checked.
   */
  public uniqueConflict = (
    labels: readonly string[],
    properties: Readonly<Record<string, unknown>>,
    exclude?: Vertex,
  ): { label: string; key: string; existing: Vertex } | undefined => {
    if (this.vertexUniqueConstraints.size === 0) {
      return undefined;
    }

    for (const label of labels) {
      for (const key of this.uniqueKeys(label)) {
        if (!(key in properties)) {
          continue;
        }

        const value = properties[key];

        if (!this.isUniqueKeyable(value)) {
          continue;
        }

        for (const vertex of this.vertexPropertyIndex.equals(key, value) ?? []) {
          if (vertex !== exclude && vertex.hasLabel(label)) {
            return { label, key, existing: vertex };
          }
        }
      }
    }

    return undefined;
  };

  /**
   * If setting `vertex.key = value` would break a unique constraint on one of
   * `vertex`'s labels, the offending `{ label, existing }`.
   */
  public uniqueConflictOnSet = (
    vertex: Vertex,
    key: string,
    value: unknown,
  ): { label: string; existing: Vertex } | undefined => {
    if (this.vertexUniqueConstraints.size === 0 || !this.isUniqueKeyable(value)) {
      return undefined;
    }

    for (const [label, keys] of this.vertexUniqueConstraints) {
      if (!keys.has(key) || !vertex.hasLabel(label)) {
        continue;
      }

      for (const other of this.vertexPropertyIndex.equals(key, value) ?? []) {
        if (other !== vertex && other.hasLabel(label)) {
          return { label, existing: other };
        }
      }
    }

    return undefined;
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

  /** Subscribe to a graph event. Returns an unsubscribe function (call it to detach). */
  public on = <T extends keyof GraphEvents>(
    type: T,
    listener: (event: GraphEvents[T]) => unknown,
  ): (() => void) => this.emitter.on(type, listener);

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
