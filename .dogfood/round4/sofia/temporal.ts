// temporal.ts — a bitemporal, event-sourced layer over @lenke/core.
//
// Two time axes:
//   * VALID TIME    — business reality, modeled as DATA: REPORTS_TO edges carry
//                     validFrom / validTo (null = still open). "As-of date D"
//                     org-chart queries are plain GQL range predicates.
//   * TRANSACTION   — what the store *believed* and when. Modeled as an
//     TIME           append-only EVENT LOG captured from `@graph/mutate`, with
//                     wall-clock txTime + a monotonic seq. Reconstruct any past
//                     transaction state by replaying the log (optionally from the
//                     nearest snapshot checkpoint).
//
// The two compose: reconstruct tx-state at seq S, THEN run a valid-time as-of
// query on that graph => full bitemporal "as of when we knew it, as of when it
// was true".

import { Graph, Vertex, Edge } from '@lenke/core';
import { serialize, deserialize } from '@lenke/serialization';

// ---------------------------------------------------------------------------
// Event-log record shapes
// ---------------------------------------------------------------------------

export type EventOp =
  | { kind: 'addVertex'; id: string; labels: string[]; properties: Record<string, unknown> }
  | { kind: 'removeVertex'; id: string }
  | {
      kind: 'addEdge';
      id: string;
      from: string;
      to: string;
      labels: string[];
      properties: Record<string, unknown>;
    }
  | { kind: 'removeEdge'; id: string; from: string; to: string }
  | { kind: 'setVertexProp'; id: string; key: string; value: unknown; previous: unknown }
  | { kind: 'removeVertexProp'; id: string; key: string; previous: unknown }
  | { kind: 'setVertexProps'; id: string; next: Record<string, unknown> }
  // edge-prop ops carry endpoints too: the event is keyed by edge id, but an
  // entity audit trail must resolve "which of Carol's edges closed" — so we
  // snapshot from/to at emit time (the pre-commit edge still has them).
  | {
      kind: 'setEdgeProp';
      id: string;
      from: string;
      to: string;
      key: string;
      value: unknown;
      previous: unknown;
    }
  | { kind: 'removeEdgeProp'; id: string; from: string; to: string; key: string; previous: unknown }
  | { kind: 'addVertexLabel'; id: string; label: string }
  | { kind: 'removeVertexLabel'; id: string; label: string };

export interface EventRecord {
  seq: number; // monotonic, 1-based (transaction-time ordering)
  txId: number; // groups the ops of one engine.tx() call (a "commit")
  txTime: string; // wall-clock ISO when the op was appended
  validAt: string | null; // business date this commit is "about"
  actor: string;
  reason: string;
  op: EventOp;
}

interface TxContext {
  txId: number;
  validAt: string | null;
  actor: string;
  reason: string;
}

interface Snapshot {
  seq: number; // this snapshot reflects the graph after applying events 1..seq
  ndjson: string;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export class TemporalEngine {
  readonly graph: Graph;
  readonly log: EventRecord[] = [];
  private snapshots: Snapshot[] = [];
  private seq = 0;
  private txCounter = 0;
  private ctx: TxContext | null = null;
  private detach: () => void;

  constructor(graph = new Graph()) {
    this.graph = graph;
    this.detach = graph.on('@graph/mutate', (e) => this.capture(e.value.original));
  }

  /** Run a batch of mutations as one logical transaction, stamped with metadata. */
  tx<T>(meta: { validAt?: string | null; actor: string; reason: string }, fn: () => T): T {
    const prev = this.ctx;
    this.ctx = {
      txId: ++this.txCounter,
      validAt: meta.validAt ?? null,
      actor: meta.actor,
      reason: meta.reason,
    };
    try {
      return fn();
    } finally {
      this.ctx = prev;
    }
  }

  private capture(o: { type: string; value: any }) {
    const ctx = this.ctx ?? { txId: 0, validAt: null, actor: 'system', reason: 'untracked' };
    const op = this.normalize(o);
    if (!op) return;
    this.log.push({
      seq: ++this.seq,
      txId: ctx.txId,
      txTime: new Date().toISOString(),
      validAt: ctx.validAt,
      actor: ctx.actor,
      reason: ctx.reason,
      op,
    });
  }

  // Turn a raw graph event (fired PRE-COMMIT — the element is fully built but
  // not yet inserted) into a self-contained, replayable op. For removals we read
  // the still-present pre-commit value so the audit trail keeps the old value.
  private normalize(o: { type: string; value: any }): EventOp | null {
    const v = o.value;
    switch (o.type) {
      case '@graph/VertexAdded': {
        const vx = v as Vertex;
        return {
          kind: 'addVertex',
          id: vx.id,
          labels: [...vx.labels],
          properties: { ...vx.properties },
        };
      }
      case '@graph/VertexRemoved':
        return { kind: 'removeVertex', id: (v as Vertex).id };
      case '@graph/EdgeAdded': {
        const ed = v as Edge;
        return {
          kind: 'addEdge',
          id: ed.id,
          from: ed.from.id,
          to: ed.to.id,
          labels: [...ed.labels],
          properties: { ...ed.properties },
        };
      }
      case '@graph/EdgeRemoved': {
        const ed = v as Edge;
        return { kind: 'removeEdge', id: ed.id, from: ed.from.id, to: ed.to.id };
      }
      case '@graph/VertexPropertyChanged':
        return {
          kind: 'setVertexProp',
          id: v.vertex.id,
          key: v.key,
          value: v.value,
          previous: v.previous,
        };
      case '@graph/VertexPropertiesChanged':
        return { kind: 'setVertexProps', id: v.vertex.id, next: { ...v.next } };
      case '@graph/VertexPropertyRemoved':
        return {
          kind: 'removeVertexProp',
          id: v.vertex.id,
          key: v.key,
          previous: v.vertex.getProperty(v.key),
        };
      case '@graph/EdgePropertyChanged':
        return {
          kind: 'setEdgeProp',
          id: v.edge.id,
          from: v.edge.from.id,
          to: v.edge.to.id,
          key: v.key,
          value: v.value,
          previous: v.previous,
        };
      case '@graph/EdgePropertyRemoved':
        return {
          kind: 'removeEdgeProp',
          id: v.edge.id,
          from: v.edge.from.id,
          to: v.edge.to.id,
          key: v.key,
          previous: v.edge.getProperty(v.key),
        };
      case '@graph/LabelAddedToVertex':
        return { kind: 'addVertexLabel', id: v.vertex.id, label: v.label };
      case '@graph/LabelRemovedFromVertex':
        return { kind: 'removeVertexLabel', id: v.vertex.id, label: v.label };
      default:
        return null; // edge label / batch-remove events not exercised here
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots as checkpoints
  // -------------------------------------------------------------------------

  /** Checkpoint the current graph at the current seq (serialize to ndjson). */
  checkpoint(): void {
    this.snapshots.push({ seq: this.seq, ndjson: serialize(this.graph, 'ndjson') });
  }

  currentSeq(): number {
    return this.seq;
  }

  snapshotSeqs(): number[] {
    return this.snapshots.map((s) => s.seq);
  }

  // -------------------------------------------------------------------------
  // Reconstruction (transaction-time time-travel)
  // -------------------------------------------------------------------------

  /**
   * Rebuild the graph as it was after transaction `targetSeq`, by starting from
   * the nearest snapshot checkpoint with seq <= targetSeq and replaying the log
   * tail. Returns a fresh, independent Graph (no events wired).
   */
  reconstructAt(targetSeq: number): { graph: Graph; fromSnapshot: number; replayed: number } {
    let base = new Graph();
    let baseSeq = 0;
    const snap = this.snapshots.filter((s) => s.seq <= targetSeq).sort((a, b) => b.seq - a.seq)[0];
    if (snap) {
      base = deserialize(snap.ndjson, 'ndjson', new Graph());
      baseSeq = snap.seq;
    }
    let replayed = 0;
    for (const rec of this.log) {
      if (rec.seq <= baseSeq) continue;
      if (rec.seq > targetSeq) break;
      applyOp(base, rec.op);
      replayed++;
    }
    return { graph: base, fromSnapshot: baseSeq, replayed };
  }

  /** Reconstruct the transaction-state at a wall-clock instant. */
  reconstructAsOfTxTime(txTime: string): { graph: Graph; fromSnapshot: number; replayed: number } {
    let seq = 0;
    for (const rec of this.log) {
      if (rec.txTime <= txTime) seq = rec.seq;
      else break;
    }
    return this.reconstructAt(seq);
  }

  // -------------------------------------------------------------------------
  // Audit trail
  // -------------------------------------------------------------------------

  /** Every logged op that touched a given element id, in transaction order. */
  auditFor(id: string): EventRecord[] {
    return this.log.filter((r) => opTouches(r.op, id));
  }

  persist(dir: string): { logPath: string; snapPath: string } {
    const logPath = `${dir}/event-log.json`;
    const snapPath = `${dir}/checkpoints.json`;
    Bun.write(logPath, JSON.stringify(this.log, null, 2));
    Bun.write(snapPath, JSON.stringify(this.snapshots, null, 2));
    return { logPath, snapPath };
  }

  dispose() {
    this.detach();
  }
}

// ---------------------------------------------------------------------------
// Op application (pure — used by replay)
// ---------------------------------------------------------------------------

function applyOp(g: Graph, op: EventOp): void {
  switch (op.kind) {
    case 'addVertex':
      g.addVertex({ id: op.id, labels: op.labels, properties: op.properties });
      return;
    case 'removeVertex':
      g.removeVertex(op.id);
      return;
    case 'addEdge': {
      const from = g.getVertexById(op.from)!;
      const to = g.getVertexById(op.to)!;
      g.addEdge({ id: op.id, from, to, labels: op.labels, properties: op.properties });
      return;
    }
    case 'removeEdge': {
      const e = g.getEdgeById(op.id);
      if (e) g.removeEdge(e);
      return;
    }
    case 'setVertexProp':
      g.getVertexById(op.id)?.setProperty(op.key, op.value);
      return;
    case 'setVertexProps':
      g.getVertexById(op.id)?.setProperties(op.next);
      return;
    case 'removeVertexProp':
      g.getVertexById(op.id)?.removeProperty(op.key);
      return;
    case 'setEdgeProp':
      g.getEdgeById(op.id)?.setProperty(op.key, op.value);
      return;
    case 'removeEdgeProp':
      g.getEdgeById(op.id)?.removeProperty(op.key);
      return;
    case 'addVertexLabel':
      g.getVertexById(op.id)?.addLabel(op.label);
      return;
    case 'removeVertexLabel':
      g.getVertexById(op.id)?.removeLabel(op.label);
      return;
  }
}

function opTouches(op: EventOp, id: string): boolean {
  if ('id' in op && op.id === id) return true;
  if ('from' in op && (op.from === id || op.to === id)) return true;
  return false;
}
