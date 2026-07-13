// The audit/versioning layer, built on @lenke/core events + @lenke/sync WriteLog
// + @lenke/serialization snapshots. Reusable by the HR scenario.
import { Graph } from '@lenke/core';
import type { GraphEvent } from '@lenke/core';
import { query } from '@lenke/gql';
import { serialize, deserialize, graphContentEqual } from '@lenke/serialization';
import { createWriteLog, type WriteLog } from '@lenke/sync';

const EVENT_TYPES = [
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
] as const;

// An append-only event record. Everything is captured SYNCHRONOUSLY at emit time
// (element refs are live — deferring the read loses removed state, see probes).
export type AuditRecord = {
  seq: number; // event ordinal (transaction-time surrogate)
  txId: number; // groups events committed in one logical "change"
  wallTime: string; // when it was recorded
  validTime: string | null; // business effective date (bitemporal valid-time)
  actor: string; // who did it
  type: string;
  entityId: string | null; // vertex/edge id, if determinable
  entityKind: 'vertex' | 'edge' | null;
  // The reversible delta, snapshotted (primitives only, no live refs):
  key?: string;
  value?: unknown;
  previous?: unknown;
  keys?: string[];
  next?: Record<string, unknown>;
  label?: string;
  // For add/remove: the full property snapshot captured at emit time.
  snapshot?: { labels: string[]; properties: Record<string, unknown> } | null;
};

export type Statement = { text: string; params?: Record<string, unknown> };

export class AuditLedger {
  readonly records: AuditRecord[] = [];
  readonly writeLog: WriteLog = createWriteLog({ capacity: 100_000 });
  private seq = 0;
  private txId = 0;
  private origin: number;
  private offs: Array<() => void> = [];
  // id-stable snapshots keyed by post-tx seq (the reconstruction path that works)
  readonly ndjsonByTx = new Map<number, string>();
  private ctx: { validTime: string | null; actor: string } = { validTime: null, actor: 'system' };

  constructor(private graph: Graph) {
    this.origin = this.writeLog.register();
    this.attach();
  }

  private attach() {
    this.offs = EVENT_TYPES.map((t) =>
      this.graph.on(t as any, (e: GraphEvent) => this.capture(e as any)),
    );
  }

  detach() {
    this.offs.forEach((o) => o());
    this.offs = [];
  }

  private capture(e: any) {
    const v = e.value;
    const rec: AuditRecord = {
      seq: ++this.seq,
      txId: this.txId,
      wallTime: new Date().toISOString(),
      validTime: this.ctx.validTime,
      actor: this.ctx.actor,
      type: e.type,
      entityId: null,
      entityKind: null,
    };
    switch (e.type) {
      case '@graph/VertexAdded':
      case '@graph/VertexRemoved':
        rec.entityId = v.id;
        rec.entityKind = 'vertex';
        rec.snapshot = { labels: [...v.labels], properties: { ...v.properties } }; // SYNC read
        break;
      case '@graph/EdgeAdded':
      case '@graph/EdgeRemoved':
        rec.entityId = v.id;
        rec.entityKind = 'edge';
        rec.snapshot = { labels: [...v.labels], properties: { ...v.properties } };
        break;
      case '@graph/VertexPropertyChanged':
        rec.entityId = v.vertex.id;
        rec.entityKind = 'vertex';
        rec.key = v.key;
        rec.value = v.value;
        rec.previous = v.previous;
        break;
      case '@graph/EdgePropertyChanged':
        rec.entityId = v.edge.id;
        rec.entityKind = 'edge';
        rec.key = v.key;
        rec.value = v.value;
        rec.previous = v.previous;
        break;
      case '@graph/VertexPropertiesChanged':
        rec.entityId = v.vertex.id;
        rec.entityKind = 'vertex';
        rec.next = { ...v.next };
        // Best-effort previous: read live ref BEFORE commit (works because
        // events fire pre-commit). This is the workaround for the missing
        // `previous` on bulk events.
        rec.previous = Object.fromEntries(
          Object.keys(v.next).map((k) => [k, v.vertex.getProperty(k)]),
        );
        break;
      case '@graph/VertexPropertyRemoved':
        rec.entityId = v.vertex.id;
        rec.entityKind = 'vertex';
        rec.key = v.key;
        rec.previous = v.vertex.getProperty(v.key); // workaround: read pre-commit
        break;
      case '@graph/VertexPropertiesRemoved':
        rec.entityId = v.vertex.id;
        rec.entityKind = 'vertex';
        rec.keys = [...v.keys];
        rec.previous = Object.fromEntries(v.keys.map((k: string) => [k, v.vertex.getProperty(k)]));
        break;
      case '@graph/LabelAddedToVertex':
      case '@graph/LabelRemovedFromVertex':
        rec.entityId = v.vertex.id;
        rec.entityKind = 'vertex';
        rec.label = v.label;
        break;
      case '@graph/LabelAddedToEdge':
      case '@graph/LabelRemovedFromEdge':
        rec.entityId = v.edge.id;
        rec.entityKind = 'edge';
        rec.label = v.label;
        break;
    }
    this.records.push(rec);
  }

  // A "transaction" = one or more GQL statements committed with a shared
  // valid-time + actor. Statements go into the WriteLog (statement journal);
  // events are captured automatically; an id-stable ndjson snapshot is taken.
  commit(meta: { validTime?: string | null; actor?: string }, statements: Statement[]) {
    this.txId++;
    this.ctx = { validTime: meta.validTime ?? null, actor: meta.actor ?? 'system' };
    for (const s of statements) {
      query(this.graph, s.text, s.params);
      this.writeLog.append(this.origin, { text: s.text, params: s.params });
    }
    this.ndjsonByTx.set(this.seq, serialize(this.graph, 'ndjson'));
    this.ctx = { validTime: null, actor: 'system' };
    return { seq: this.seq, txId: this.txId };
  }

  // --- reconstruction paths ---

  // (1) id-stable: rebuild from the ndjson snapshot taken at/just-before seq N.
  reconstructFromSnapshot(atSeq: number): Graph | null {
    let best: { seq: number; nd: string } | null = null;
    for (const [seq, nd] of this.ndjsonByTx) {
      if (seq <= atSeq && (!best || seq > best.seq)) best = { seq, nd };
    }
    return best ? deserialize(best.nd, 'ndjson') : null;
  }

  // (2) statement replay: re-run WriteLog statements up to seq into a fresh graph.
  // NOTE: mints fresh UUIDs → NOT id-equal to the original (see findings).
  reconstructFromStatements(uptoWriteLogSeq: number): Graph {
    const g = new Graph();
    const entries = this.writeLog.since(0) ?? [];
    for (const e of entries) {
      if (e.seq > uptoWriteLogSeq) break;
      query(g, e.write.text, e.write.params);
    }
    return g;
  }

  // entity history: every recorded change touching an entity id.
  history(entityId: string): AuditRecord[] {
    return this.records.filter((r) => r.entityId === entityId);
  }
}

// Content equality that IGNORES ids (for verifying statement-replay, which the
// stock graphContentEqual cannot do because it compares by id).
export function graphContentEqualIgnoringIds(a: Graph, b: Graph): boolean {
  const canonNodes = (g: Graph) =>
    [...g.vertices]
      .map((v) => JSON.stringify([[...v.labels].sort(), sortObj(v.properties)]))
      .sort();
  const canonEdges = (g: Graph) =>
    [...g.edges]
      .map((e) =>
        JSON.stringify([
          [...e.from.labels].sort(),
          sortObj(e.from.properties),
          [...e.to.labels].sort(),
          sortObj(e.to.properties),
          [...e.labels].sort(),
          sortObj(e.properties),
        ]),
      )
      .sort();
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((s, i) => s === y[i]);
  return eq(canonNodes(a), canonNodes(b)) && eq(canonEdges(a), canonEdges(b));
}

function sortObj(o: Record<string, unknown>) {
  return Object.keys(o)
    .sort()
    .map((k) => [k, o[k]]);
}

export { graphContentEqual };
