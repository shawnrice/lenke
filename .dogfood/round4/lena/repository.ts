/**
 * Repository — typed CRUD helpers that translate the silent core veto into a
 * thrown `ConstraintError`, and orchestrate multi-write operations that the
 * event layer alone can't express atomically (e.g. "insert a post AND its
 * author edge, or neither").
 */
import { Graph, type Vertex } from '@lenke/core';

import { Schema, ConstraintError, type EntityDef } from './schema.js';

export class Repository {
  constructor(
    private readonly graph: Graph,
    private readonly schema: Schema,
  ) {}

  private assertClean(rolledBack?: () => void): void {
    const violations = this.schema.drain();
    if (violations.length > 0) {
      rolledBack?.();
      throw new ConstraintError(violations);
    }
  }

  /** Apply entity defaults to a partial property bag. */
  private withDefaults(entity: EntityDef, props: Record<string, unknown>): Record<string, unknown> {
    const out = { ...props };
    for (const [key, def] of Object.entries(entity.properties)) {
      if (def.default !== undefined && !(key in out)) out[key] = def.default;
    }
    return out;
  }

  /** Create a vertex of `label`; throws ConstraintError if any listener vetoes. */
  create(label: string, props: Record<string, unknown>): Vertex {
    const entity = this.schema.entities.get(label);
    if (!entity) throw new Error(`unknown entity '${label}'`);
    const v = this.graph.addVertex({
      labels: [label],
      properties: this.withDefaults(entity, props),
    });
    // On veto the vertex was NOT attached: detect via id lookup, then throw.
    this.assertClean();
    if (!this.graph.getVertexById(v.id)) {
      // No violation recorded but not attached — shouldn't happen, but be safe.
      throw new Error(`create ${label} failed (vetoed with no recorded violation)`);
    }
    return v;
  }

  /**
   * Delete a vertex, cascading to `to` vertices reachable by any relationship
   * marked `cascadeDelete`. lenke's core already cascades edges when a vertex is
   * removed, but *vertex*-to-vertex cascade (delete a User -> delete their Posts)
   * is application policy the framework must implement itself.
   */
  deleteCascade(v: Vertex): void {
    const toRemove: Vertex[] = [];
    const collect = (vertex: Vertex): void => {
      for (const rel of this.schema.relationships) {
        if (!rel.cascadeDelete) continue;
        if (!vertex.labels.has(rel.from)) continue;
        for (const edge of vertex.edgesFromByLabel(rel.label)) {
          const child = edge.to;
          if (!toRemove.includes(child)) {
            toRemove.push(child);
            collect(child);
          }
        }
      }
    };
    collect(v);
    // Remove children first, then the root. removeVertex cascades incident edges.
    for (const child of toRemove) this.graph.removeVertex(child);
    this.graph.removeVertex(v);
  }

  /** Set a property; throws on veto (the write silently no-ops otherwise). */
  set(v: Vertex, key: string, value: unknown): void {
    v.setProperty(key, value);
    this.assertClean();
  }

  /** Connect two vertices with an edge; throws on cardinality veto. */
  link(from: Vertex, label: string, to: Vertex, props: Record<string, unknown> = {}): void {
    const edge = this.graph.addEdge({ from, to, labels: [label], properties: props });
    this.assertClean();
    if (!this.graph.getEdgeById(edge.id)) {
      throw new Error(`link :${label} failed (vetoed with no recorded violation)`);
    }
  }

  /**
   * Atomic multi-write: create a vertex and immediately link it to a required
   * owner. If either the vertex constraints or the edge cardinality fail, the
   * whole operation is rolled back (the vertex is removed) and we throw. This is
   * the "a post must belong to exactly one author" invariant that a single
   * event can't guarantee (a bare INSERT of a Post has no author edge yet).
   */
  createWithOwner(args: {
    label: string;
    props: Record<string, unknown>;
    edgeLabel: string;
    owner: Vertex;
  }): Vertex {
    const entity = this.schema.entities.get(args.label);
    if (!entity) throw new Error(`unknown entity '${args.label}'`);

    const v = this.graph.addVertex({
      labels: [args.label],
      properties: this.withDefaults(entity, args.props),
    });
    // Roll back the vertex if its own constraints failed.
    this.assertClean(() => {
      if (this.graph.getVertexById(v.id)) this.graph.removeVertex(v);
    });

    const edge = this.graph.addEdge({
      from: args.owner,
      to: v,
      labels: [args.edgeLabel],
      properties: {},
    });
    // If the edge was vetoed (cardinality), roll back BOTH the edge (already
    // not attached) and the just-created vertex.
    this.assertClean(() => {
      this.graph.removeVertex(v);
    });
    if (!this.graph.getEdgeById(edge.id)) {
      this.graph.removeVertex(v);
      throw new Error(`createWithOwner: edge :${args.edgeLabel} vetoed`);
    }
    return v;
  }
}
