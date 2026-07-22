import type { Store } from '@lenke/native';

import { applySchemaOp, type SchemaOp } from './protocol.js';
import type { WriteLog } from './writelog.js';

export type ApplySchemaOptions = {
  /** The shared CDC op log to publish the change to, so every replica replays the
   *  same declaration in order. Omit it to apply locally only. */
  writeLog?: WriteLog;
  /**
   * The origin id recorded on the log entry (for origin-skip). Server-initiated
   * schema is unattributed (`''`) so every subscribed client ingests it; an
   * optimistic client applying its OWN schema would pass its stable id so it
   * doesn't re-ingest its own change.
   */
  origin?: string;
};

/**
 * Apply a schema change (a constraint / validator / invariant / index — see
 * {@link SchemaOp}) to the authoritative store AND publish it to the CDC log, so
 * every replica replays the same declaration **in order** and stays in lock-step.
 *
 * This is the schema analogue of a `mutate`: data writes ride the log as
 * write-language text; schema rides it as a structured op. It's how a replica can
 * derive a `_MERGE` key or reject the same writes as the source — without it, a
 * replica is missing the constraints and a `_MERGE` replay throws.
 *
 * **Server-authoritative** (matching the statement-replication model — no CRDT):
 * the store is the single writer of schema; replicas *receive* it. Apply happens
 * first, so if existing data already violates the new constraint the store throws
 * and nothing is logged — a rejected schema change never reaches a replica.
 *
 * NOTE: `defineNode`/`defineEdge` are deliberately NOT replicable this way — they
 * bind a label to a host-side JS validator (not engine state). Their *writes*
 * replicate; a replica that runs local `.create()` defines the same schema in its
 * own app code. Pair them with an in-engine type/required constraint (which *does*
 * replicate here) if the engine itself should enforce a slice.
 */
export const applySchema = (store: Store, op: SchemaOp, options: ApplySchemaOptions = {}): void => {
  // Apply first: if existing data violates the new constraint this throws, so the
  // change is never published to a replica that would then diverge.
  store.mutate((g) => applySchemaOp(g, op));
  // Schema is graph-global and unscoped → forward to EVERY subscriber (no `tokens`
  // for interest routing, no `scope` for tenant filtering).
  options.writeLog?.append(options.origin ?? '', { text: '', schema: op });
};
