// Event-driven undo/redo. The history NEVER wraps the graph API; it listens to
// `@graph/*` mutation events and, for each, records an INVERSE command. A user
// action is bracketed with `act(label, fn)` so a whole gesture (which may emit
// several events, e.g. a cascading vertex removal) undoes/redoes atomically.
//
// Two facts about the event system make this possible and are load-bearing:
//   1. events fire PRE-COMMIT (before the mutation is applied), so a handler can
//      read the element's *current* (old) value to reverse it — the payload of a
//      property-change event carries only the NEW value.
//   2. `removeVertex` emits `@graph/VertexRemoved` BEFORE cascading its incident
//      edges, so at handler time the edges are still present and can be captured;
//      the cascaded `@graph/EdgeRemoved` events are then folded away.
import type { Graph, Vertex, Edge } from '@lenke/core';

type Inverse = () => void;
type Txn = { label: string; cmds: Inverse[] };

type VertexSpec = { id: string; labels: string[]; properties: Record<string, unknown> };
type EdgeSpec = {
  id: string;
  from: string;
  to: string;
  labels: string[];
  properties: Record<string, unknown>;
};

const snapshotVertex = (v: Vertex): VertexSpec => ({
  id: v.id,
  labels: [...v.labels],
  properties: { ...v.properties },
});

const snapshotEdge = (e: Edge): EdgeSpec => ({
  id: e.id,
  from: e.from.id,
  to: e.to.id,
  labels: [...e.labels],
  properties: { ...e.properties },
});

export class History {
  private undoStack: Txn[] = [];
  private redoStack: Txn[] = [];
  private pending: Txn | null = null;
  private depth = 0;
  /** Edge ids already folded into a vertex-removal restore, to suppress their EdgeRemoved. */
  private cascadeEdgeIds = new Set<string>();
  private disposers: Array<() => void> = [];

  constructor(private graph: Graph) {
    this.wire();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabels(): string[] {
    return this.undoStack.map((t) => t.label);
  }

  /** Bracket a user gesture; all events it emits collapse into one undo entry. */
  act<T>(label: string, fn: () => T): T {
    if (this.pending) return fn(); // nested — join the parent txn
    this.pending = { label, cmds: [] };
    this.depth++;
    try {
      return fn();
    } finally {
      this.depth--;
      const txn = this.pending;
      this.pending = null;
      if (txn && txn.cmds.length > 0) {
        this.undoStack.push(txn);
        this.redoStack = []; // a fresh user action invalidates redo
      }
    }
  }

  undo(): boolean {
    const txn = this.undoStack.pop();
    if (!txn) return false;
    this.replayInto(txn, this.redoStack);
    return true;
  }

  redo(): boolean {
    const txn = this.redoStack.pop();
    if (!txn) return false;
    this.replayInto(txn, this.undoStack);
    return true;
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
  }

  /** Run a txn's inverse commands (reverse order) while recording the counter-txn. */
  private replayInto(txn: Txn, target: Txn[]): void {
    const prev = this.pending;
    this.pending = { label: txn.label, cmds: [] };
    try {
      for (let i = txn.cmds.length - 1; i >= 0; i--) txn.cmds[i]();
    } finally {
      const counter = this.pending;
      this.pending = prev;
      if (counter && counter.cmds.length > 0) target.push(counter);
    }
  }

  private record(cmd: Inverse): void {
    if (this.pending) this.pending.cmds.push(cmd);
  }

  private wire(): void {
    const g = this.graph;
    // NOTE: graph.on returns void (swallows the emitter's unsubscribe fn), so we
    // reach through graph.emitter to get disposers for teardown.
    const e = g.emitter;

    this.disposers.push(
      e.on('@graph/VertexAdded', (ev) => {
        const v = ev.value;
        this.record(() => g.removeVertex(v.id));
      }),

      e.on('@graph/EdgeAdded', (ev) => {
        const spec = snapshotEdge(ev.value);
        this.record(() => {
          const found = g.getEdgeById(spec.id);
          if (found) g.removeEdge(found);
        });
      }),

      e.on('@graph/VertexRemoved', (ev) => {
        // PRE-COMMIT: edges still present. Capture vertex + incident edges and
        // fold them into a single restore; suppress the cascaded EdgeRemoved.
        const v = ev.value;
        const vspec = snapshotVertex(v);
        const incident = new Set<Edge>();
        for (const label of edgeLabelsTouching(g, v.id)) {
          for (const ed of v.edgesFromByLabel(label)) incident.add(ed);
          for (const ed of v.edgesToByLabel(label)) incident.add(ed);
        }
        const especs = [...incident].map(snapshotEdge);
        for (const s of especs) this.cascadeEdgeIds.add(s.id);
        this.record(() => {
          g.addVertex({ id: vspec.id, labels: vspec.labels, properties: vspec.properties });
          for (const s of especs) restoreEdge(g, s);
        });
      }),

      e.on('@graph/EdgeRemoved', (ev) => {
        const id = ev.value.id;
        if (this.cascadeEdgeIds.has(id)) {
          this.cascadeEdgeIds.delete(id); // folded into the vertex restore
          return;
        }
        const spec = snapshotEdge(ev.value);
        this.record(() => restoreEdge(g, spec));
      }),

      e.on('@graph/VertexPropertyChanged', (ev) => {
        const { vertex, key } = ev.value;
        const had = vertex.hasProperty(key);
        const old = vertex.getProperty(key); // PRE-COMMIT: still the old value
        this.record(() => (had ? vertex.setProperty(key, old) : vertex.removeProperty(key)));
      }),

      e.on('@graph/VertexPropertyRemoved', (ev) => {
        const { vertex, key } = ev.value;
        const old = vertex.getProperty(key);
        this.record(() => vertex.setProperty(key, old));
      }),

      e.on('@graph/LabelAddedToVertex', (ev) => {
        const { vertex, label } = ev.value;
        this.record(() => g.removeLabelFromVertex(label, vertex));
      }),

      e.on('@graph/LabelRemovedFromVertex', (ev) => {
        const { vertex, label } = ev.value;
        this.record(() => g.addLabelToVertex(label, vertex));
      }),

      e.on('@graph/EdgePropertyChanged', (ev) => {
        const { edge, key } = ev.value;
        const had = edge.hasProperty(key);
        const old = edge.getProperty(key);
        this.record(() => (had ? edge.setProperty(key, old) : edge.removeProperty(key)));
      }),
    );
  }
}

function edgeLabelsTouching(g: Graph, vertexId: string): Set<string> {
  const labels = new Set<string>();
  for (const m of [g.edgesFromByLabel.get(vertexId), g.edgesToByLabel.get(vertexId)]) {
    for (const label of m?.keys() ?? []) labels.add(label);
  }
  return labels;
}

function restoreEdge(g: Graph, s: EdgeSpec): void {
  const from = g.getVertexById(s.from);
  const to = g.getVertexById(s.to);
  if (from && to) {
    g.addEdge({ id: s.id, from, to, labels: s.labels, properties: s.properties });
  }
}
