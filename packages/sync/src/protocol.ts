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
 * v1 is deliberately brutal-minimal (~6 messages). Arrow-buffer negotiation and
 * resumable subscriptions remain extensions; **keyed row diffs** have landed as
 * a backward-compatible one (declare `key` on subscribe → patch/remove/order
 * pushes; without it, the full-`rows` v1 shape is unchanged).
 *
 * ```
 * client → host:  subscribe   { sub, query, deps, params?, key?, window? }
 * host → client:  rows        { sub, rows | (patch, remove, order), version, complete }  // now, then on change
 * client → host:  unsubscribe { sub }
 * client → host:  query       { req, query, params?, lang? }      // one-shot (gql | gremlin)
 * host → client:  result      { req, rows | values | error }
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
   * Dependency posture for epoch-gated invalidation — **required**, declared
   * explicitly (no silent omission, no host-side inference):
   * - `[...]` — recompute only when one of these label / edge-type /
   *   property-key epochs moves.
   * - `[]` — depends on nothing → never recomputes (a constant query).
   * - `null` — depends on everything → recompute on every change.
   *
   * A client that wants inference derives the array itself with
   * `inferDeps(query)` before subscribing. Demand-fill routes off the declared
   * tokens, so `[]`/`null` also mean "no collection to demand-fill".
   */
  deps: readonly string[] | null;
  /**
   * Row-identity column for **keyed diffs**. When present, the value of this
   * column identifies a row across pushes, so the host sends only what changed
   * (`patch` / `remove` / `order`) instead of the whole result each time. When
   * absent, every push carries the full `rows` — the shape a keyless query
   * (aggregates) needs, and the only one a minimal v1 consumer must understand.
   * Ignored for `lang: 'gremlin'` (Gremlin results aren't keyed rows).
   */
  key?: string;
  /**
   * Query language, default `'gql'`. `'gremlin'` makes this a standing Gremlin
   * traversal: pushes carry `values` (arbitrary JSON) instead of `rows`, full
   * each time (no keyed diffs). `deps` gating works identically. Gremlin has no
   * engine param binding — build the text with the `gremlin` tag / `escapeGremlin`
   * to interpolate values safely.
   */
  lang?: 'gql' | 'gremlin';
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
  /** `$name` bindings. Ignored for `lang: 'gremlin'` (Gremlin has no param binding). */
  params?: QueryParams;
  /**
   * Query language, default `'gql'`. `'gremlin'` runs the text through the
   * Gremlin engine and answers with `values` (arbitrary JSON) instead of
   * `rows`. Gremlin has no engine param binding, so interpolate values with the
   * `gremlin` tag / `escapeGremlin` (they escape into safe literals) rather than
   * string concatenation. (`client.gremlin` as a tagged template does this for
   * you.)
   */
  lang?: 'gql' | 'gremlin';
  /**
   * Result encoding, default `'json'`. `'arrow'` answers with an `arrow`
   * columnar blob instead of `rows` — smaller on the wire and decodable without
   * a JSON parse, worth it for large one-shot loads. Requires a **binary-capable
   * transport** (a Worker `MessagePort`, where the `Uint8Array` also transfers
   * zero-copy, or a binary WebSocket); a JSON-stringifying transport must keep
   * `'json'`. GQL only — Gremlin (`lang: 'gremlin'`) answers with `values`.
   */
  format?: 'json' | 'arrow';
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

/** One upsert in a keyed diff: the row's key value + the columns that changed
 *  (all columns when the row is new). The client merges `set` into the prior row. */
export type RowPatch = {
  key: unknown;
  set: Row;
};

/**
 * A subscription push: the current result of a standing query. Sent once on
 * subscribe and again on every relevant change. On a subscription failure
 * (bad query, rejected params) this carries `error` instead of rows, and the
 * subscription is closed.
 *
 * Two shapes, chosen by whether the subscription declared a `key`:
 * - **Keyless** — `rows` carries the full result every push (v1's only shape).
 * - **Keyed diff** — `patch` (upserts, changed cells only), `remove` (gone key
 *   values), and `order` (the full key order, present only when it changed);
 *   the client applies them onto its retained rows. `rows` is absent.
 */
export type RowsMessage = {
  type: 'rows';
  sub: string;
  /** Full result (keyless subscriptions). Absent on keyed-diff pushes. */
  rows?: Row[];
  /** Keyed diff: rows to upsert (changed cells only; all cells when new). */
  patch?: RowPatch[];
  /** Keyed diff: key values whose rows were removed. */
  remove?: unknown[];
  /** Keyed diff: the full key order after applying — sent only when it changed. */
  order?: unknown[];
  /** A `lang: 'gremlin'` subscription's result values (arbitrary JSON), full each push. */
  values?: unknown[];
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
  /** Rows for a GQL query. */
  rows?: Row[];
  /** ARW1 columnar blob for a `format: 'arrow'` query — the client decodes it to rows. */
  arrow?: Uint8Array;
  /** Result values for a `lang: 'gremlin'` query (arbitrary JSON). */
  values?: unknown[];
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
