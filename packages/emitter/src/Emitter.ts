import { EmitterEvent } from './EmitterEvent.js';

type NullaryFn<T = any> = () => T;

export type Listener<T extends EmitterEvent<string, any>> = (event: T) => any;

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

  private enabled: boolean;

  private readonly onError: (error: unknown, event: any) => void;

  // Default `enabled: false` so a freshly-constructed emitter is silent. The
  // primary use case is hydrating a graph from serialized state — listeners
  // shouldn't see a flood of synthetic events for the historical mutations.
  // Callers explicitly `.enable()` once hydration is complete.
  constructor(params: EmitterOptions = {}) {
    const { enabled = false, onError } = params;
    this.listeners = new Map();
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

  on<TType extends Key, TEvent extends TypeMap[TType]>(
    type: TType,
    listener: Listener<TEvent>,
  ): NullaryFn {
    const listeners = this.listenersFor(type);
    listeners.add(listener);

    return () => listeners.delete(listener);
  }

  once<TType extends Key, TEvent extends TypeMap[TType]>(
    type: TType,
    listener: Listener<TEvent>,
  ): NullaryFn {
    const listeners = this.listenersFor(type);
    const wrapped: StoredListener = (event) => {
      listeners.delete(wrapped);
      listener(event);
    };
    listeners.add(wrapped);

    return () => listeners.delete(wrapped);
  }

  emit<TType extends Key, TEvent extends TypeMap[TType]>(event: TEvent): TEvent {
    if (!this.enabled) {
      return event;
    }

    // Snapshot before iterating: listeners that subscribe/unsubscribe inside a
    // handler don't affect the current emission. Without this, a handler that
    // re-subscribes for the same event would loop indefinitely on a single
    // emit. `new Set(undefined)` yields an empty Set, so the missing-key case
    // needs no fallback.
    for (const listener of new Set(this.listeners.get(event.type))) {
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
}
