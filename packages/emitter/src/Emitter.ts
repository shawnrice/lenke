import { EmitterEvent } from './EmitterEvent.js';

// A listener is observation-only (it reacts, it can't veto — see `emit`), so its return is
// ignored: type it `void` rather than leaking `any`. `void` still accepts a listener that
// happens to return a value.
export type Listener<T extends EmitterEvent<string, any>> = (event: T) => void;

export type EmitterOptions = {
  enabled?: boolean;
  /**
   * Invoked when a listener throws. This isolates failures — one bad listener
   * can neither stop the other listeners nor break the caller. Events are
   * observation-only (a listener reacts, it can't veto), so `emit` must never
   * throw and every listener must get its turn. If omitted, a listener error is
   * re-thrown on a microtask, so it surfaces to the host's unhandled-error
   * handling without interrupting dispatch.
   */
  onError?: (error: unknown, event: EmitterEvent<string, any>) => void;
};

// Internal storage type. The public API (`Listener<TEvent>`) is precise per
// event variant, but a single `Set` can't be invariantly typed for many
// variants at once — TypeScript would force casts at every add/remove.
// Widening storage to `any`-event makes those casts go away without the `any`
// leaking to callers: every public method narrows the type back via its own
// generic.
type StoredListener = (event: any) => any;

// Payload type carried by a given event variant.
type PayloadOf<E> = E extends EmitterEvent<any, infer V> ? V : never;

/**
 * An Event Emitter
 */
export class Emitter<
  Key extends string = string,
  TypeMap extends Record<Key, EmitterEvent<Key, any>> = Record<Key, EmitterEvent<Key, any>>,
> {
  private readonly listeners: Map<Key, Set<StoredListener>>;

  // The dispatch snapshot per event type, rebuilt only when that type's listener set changes.
  // `emit` has to iterate a copy (see there), and allocating one per emit charges every write in
  // the host graph for a set that changes approximately never: audit item 313 found two listeners
  // subscribed to each of sixteen event types for the lifetime of a `Graph`, so the per-emit `new
  // Set(...)` was copying the same two functions a million times during an ingest. Invalidating on
  // subscribe/unsubscribe is the same snapshot semantics without the allocation.
  private readonly snapshots: Map<Key, readonly StoredListener[]>;

  private enabled: boolean;

  private readonly onError: (error: unknown, event: any) => void;

  // Default `enabled: false` so a freshly-constructed emitter is silent. The
  // primary use case is hydrating a graph from serialized state — listeners
  // shouldn't see a flood of synthetic events for the historical mutations.
  // Callers explicitly `.enable()` once hydration is complete.
  constructor(params: EmitterOptions = {}) {
    const { enabled = false, onError } = params;
    this.listeners = new Map();
    this.snapshots = new Map();
    this.enabled = enabled;
    // Default: surface a listener error on a microtask — visible to the host's
    // unhandled-error handling, but it never breaks dispatch or the caller.
    this.onError =
      onError ??
      ((error: unknown) => {
        queueMicrotask(() => {
          throw error;
        });
      });
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Whether anyone is currently subscribed to `type`. For a caller that has to BUILD the event
   * before it can emit it: with no listeners the event is unobservable, so the construction can
   * be skipped. (`on` allocates the bucket, and `off` leaves it behind empty, so the size has to
   * be checked and not just the key.)
   */
  hasListeners(type: Key): boolean {
    const set = this.listeners.get(type);

    return set !== undefined && set.size > 0;
  }

  on<TType extends Key, TEvent extends TypeMap[TType]>(
    type: TType,
    listener: Listener<TEvent>,
  ): () => void {
    this.listenersFor(type).add(listener);
    this.snapshots.delete(type);

    return () => this.detach(type, listener);
  }

  once<TType extends Key, TEvent extends TypeMap[TType]>(
    type: TType,
    listener: Listener<TEvent>,
  ): () => void {
    const wrapped: StoredListener = (event) => {
      this.detach(type, wrapped);
      listener(event);
    };

    this.listenersFor(type).add(wrapped);
    this.snapshots.delete(type);

    return () => this.detach(type, wrapped);
  }

  emit<TType extends Key, TEvent extends TypeMap[TType]>(event: TEvent): TEvent {
    if (!this.enabled) {
      return event;
    }

    // Iterate a snapshot, not the live set: listeners that subscribe or unsubscribe inside a
    // handler don't affect the current emission. Without that, a handler re-subscribing for the
    // same event would loop indefinitely on a single emit.
    //
    // The snapshot is CACHED and invalidated by `on` / `once` / `detach`, because it used to be a
    // `new Set(...)` built per emit over a listener set that changes approximately never — see
    // the field. Every path that can mutate the set clears the cache, which includes the one that
    // is easy to miss: a `once` wrapper detaching ITSELF mid-dispatch. The array it is detaching
    // from is this stable copy, so the remaining listeners of this emission still run, exactly as
    // they did when the copy was a Set.
    for (const listener of this.snapshotFor(event.type)) {
      try {
        listener(event);
      } catch (error) {
        // Isolate: a throwing listener must not stop the remaining listeners nor
        // break the caller. Events are observation-only, so every listener runs
        // regardless — a partial failure can't drop another listener's side
        // effect (an audit entry, a metric, a React re-render).
        this.onError(error, event);
      }
    }

    return event;
  }

  eventFrom<TType extends Key>(type: TType, payload: PayloadOf<TypeMap[TType]>): TypeMap[TType] {
    // The constructed event is structurally a `TypeMap[TType]` for the
    // expected case (TypeMap entries are `EmitterEvent<K, V>` aliases). TS
    // can't verify because `TypeMap[TType]` could in theory be any subtype of
    // `EmitterEvent<Key, any>` with extra fields the constructor doesn't set.
    // For the canonical "type alias map" usage this is a no-op cast.
    return new EmitterEvent(type, payload) as unknown as TypeMap[TType];
  }

  private listenersFor(type: Key): Set<StoredListener> {
    let set = this.listeners.get(type);

    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }

    return set;
  }

  /**
   * The single place a listener is removed, so the dispatch snapshot cannot outlive it. Every
   * unsubscribe comes through here — the closure `on` returns, the one `once` returns, and the
   * `once` wrapper detaching itself from inside a dispatch.
   */
  private detach(type: Key, listener: StoredListener): void {
    const set = this.listeners.get(type);

    if (set?.delete(listener) === true) {
      this.snapshots.delete(type);
    }
  }

  /** The cached dispatch list for `type`, built on the first emit after a subscription change. */
  private snapshotFor(type: Key): readonly StoredListener[] {
    const cached = this.snapshots.get(type);

    if (cached !== undefined) {
      return cached;
    }

    const set = this.listeners.get(type);
    // An unsubscribed type caches the empty array too: a write-heavy host emits events nothing is
    // listening for, and that should cost one Map hit rather than a fresh allocation each time.
    const snapshot: readonly StoredListener[] = set === undefined ? [] : [...set];

    this.snapshots.set(type, snapshot);

    return snapshot;
  }
}
