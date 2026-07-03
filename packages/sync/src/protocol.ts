/**
 * The lenke live-query wire protocol, v1.
 *
 * The frontend asks **declaratively**: the primitive is a standing query, not a
 * fetch. All messages are tagged plain data — nothing callable ever crosses —
 * so the same protocol rides any port-shaped transport: a Worker `postMessage`
 * channel in the browser, a WebSocket to a server host. Conformance is
 * **structural**: a host conforms by emitting these tags; consumers may write
 * the same shapes down independently with no dependency in either direction.
 *
 * v1 is deliberately brutal-minimal (~6 messages). Arrow-buffer negotiation,
 * row diffs, and resumable subscriptions are extensions, not v1.
 *
 * ```
 * client → host:  subscribe   { sub, query, params?, deps?, window? }
 * host → client:  rows        { sub, rows, version, complete }   // now, then on change
 * client → host:  unsubscribe { sub }
 * client → host:  query       { req, query, params? }            // one-shot
 * host → client:  result      { req, rows | error }
 * client → host:  mutate      { req, gql, params? }
 * host → client:  ack         { req, ok, error? }                // UI effect arrives via rows pushes
 * host → client:  status      { connected, pendingWrites, protocol }
 * ```
 *
 * `params` everywhere is a flat object of `$name` bindings. Values bind to
 * already-parsed param slots engine-side and never touch the GQL parser — the
 * wire's injection-safety contract. Send values as params; never build query
 * text from user input.
 */

import type { QueryParams, Row } from '@lenke/native';

/** A failure crossing the wire: the stable code is the contract, the message is free to change. */
export type WireError = {
  code: string;
  message: string;
};

// ---------------------------------------------------------------------------
// client → host
// ---------------------------------------------------------------------------

/**
 * Open a standing query. The host answers with a `rows` push immediately, then
 * again whenever a mutation moves one of the query's dependency epochs.
 * Re-subscribing with the same `sub` replaces the subscription (that is how a
 * windowed grid scrolls: same `sub`, new `window`).
 */
export type SubscribeMessage = {
  type: 'subscribe';
  /** Client-chosen subscription id, unique per connection. */
  sub: string;
  /** GQL text (values belong in `params`, not in the text). */
  query: string;
  /** `$name` bindings — part of the standing query's identity. */
  params?: QueryParams;
  /**
   * Dependency tokens (labels / edge-types / property-keys) for epoch-gated
   * invalidation. Omitted → the host infers them from the query text
   * (over-grabbing is safe; it only costs a recompute).
   */
  deps?: readonly string[];
  /** Windowed read for grids. Reserved in v1 — carried but not yet interpreted. */
  window?: { offset: number; limit: number };
};

/** Tear down a standing query. */
export type UnsubscribeMessage = {
  type: 'unsubscribe';
  sub: string;
};

/** One-shot query (loaders, event handlers) — answered once with `result`. */
export type QueryMessage = {
  type: 'query';
  /** Client-chosen request id. */
  req: string;
  query: string;
  /** `$name` bindings. */
  params?: QueryParams;
};

/**
 * Apply a mutation. The host answers `ack` with only success/failure — the UI
 * effect arrives through `rows` pushes on whichever subscriptions the mutation
 * touched, exactly as if another client had written.
 */
export type MutateMessage = {
  type: 'mutate';
  req: string;
  /** Mutating GQL (`INSERT` / `SET` / `REMOVE` / `DELETE`); values ride `params`. */
  gql: string;
  /** `$name` bindings. */
  params?: QueryParams;
};

export type ClientMessage = SubscribeMessage | UnsubscribeMessage | QueryMessage | MutateMessage;

// ---------------------------------------------------------------------------
// host → client
// ---------------------------------------------------------------------------

/**
 * A subscription push: the current result of a standing query. Sent once on
 * subscribe and again on every relevant change. On a subscription failure
 * (bad query, rejected params) this carries `error` instead of `rows`, and the
 * subscription is closed.
 */
export type RowsMessage = {
  type: 'rows';
  sub: string;
  rows?: Row[];
  /** The graph's mutation version at snapshot time. */
  version?: number;
  /**
   * Whether the underlying scope is fully loaded. A query over a
   * partially-synced collection must distinguish "no results" from "not loaded
   * yet" or the UI cannot render skeletons honestly. Always `true` until the
   * demand-fill sync loop lands.
   */
  complete?: boolean;
  error?: WireError;
};

/** The single answer to a one-shot `query`. */
export type ResultMessage = {
  type: 'result';
  req: string;
  rows?: Row[];
  error?: WireError;
};

/** The answer to a `mutate` — success/failure only; data flows via `rows`. */
export type AckMessage = {
  type: 'ack';
  req: string;
  ok: boolean;
  error?: WireError;
};

/** Host status — sent on attach; a built-in subscription in later versions. */
export type StatusMessage = {
  type: 'status';
  connected: boolean;
  pendingWrites: number;
  /** Protocol version for forward-compat negotiation. */
  protocol: 1;
};

export type HostMessage = RowsMessage | ResultMessage | AckMessage | StatusMessage;

export type SyncMessage = ClientMessage | HostMessage;

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------

const CLIENT_TYPES = new Set(['subscribe', 'unsubscribe', 'query', 'mutate']);
const HOST_TYPES = new Set(['rows', 'result', 'ack', 'status']);

/** Cheap structural gate: is this a tagged message at all? (Not a validator.) */
const tagOf = (msg: unknown): string | null => {
  if (typeof msg !== 'object' || msg === null) {
    return null;
  }

  const t = (msg as { type?: unknown }).type;

  return typeof t === 'string' ? t : null;
};

export const isClientMessage = (msg: unknown): msg is ClientMessage => {
  const t = tagOf(msg);

  return t !== null && CLIENT_TYPES.has(t);
};

export const isHostMessage = (msg: unknown): msg is HostMessage => {
  const t = tagOf(msg);

  return t !== null && HOST_TYPES.has(t);
};
