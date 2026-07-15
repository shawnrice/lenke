import { ErrorCode, LenkeError } from '@lenke/errors';
import { List } from '@lenke/list';

import type { Edge } from './Edge.js';
import type { Vertex, VertexJSON } from './Vertex.js';

/** One element of a walked path — a vertex or the edge between two vertices. */
export type PathElement = Vertex | Edge;

/** A `{vertex, edge}` step, the shape pattern-expansion already produces. */
export type PathStep = { edge: Edge; vertex: Vertex };

/**
 * Canonical JSON for a path (byte-identical to the native engine). `vertices`
 * and `edges` reuse the element serialization; `length` is the **hop count**
 * (number of edges) — this differs from the class's List `length` (see
 * {@link Path}).
 */
export type PathJSON = {
  vertices: VertexJSON[];
  edges: ReturnType<Edge['toJSON']>[];
  length: number;
};

/**
 * An ordered walk through the graph: vertices joined by the edges between them,
 * `v₀ –e₀→ v₁ –e₁→ … vₖ`. This is the value a `SHORTEST`/quantified path pattern
 * binds and returns.
 *
 * Built on {@link List}, so it iterates lazily and carries all the list
 * combinators. **Iterating a path yields its elements interleaved** — vertex,
 * edge, vertex, …, vertex — so a `for…of` walks the path as you'd trace it by
 * hand. A single-vertex path (zero hops) iterates just that vertex.
 *
 * Two "length" notions, kept distinct so neither is a footgun:
 * - `length` / `size` — the **element count** (`2·hops + 1`), the List contract
 *   (so `count()`, `take()`, etc. stay correct).
 * - `hops` — the **edge count**, the graph-theoretic path length; this is what
 *   `PathJSON.length` reports.
 *
 * The structured `vertices` / `edges` accessors are the direct backing for the
 * path-accessor functions.
 */
export class Path extends List<PathElement> {
  readonly vertices: readonly Vertex[];
  readonly edges: readonly Edge[];

  /**
   * @param vertices the visited vertices in order (at least one)
   * @param edges the edges between consecutive vertices (`vertices.length - 1`)
   */
  constructor(vertices: readonly Vertex[], edges: readonly Edge[]) {
    if (vertices.length !== edges.length + 1) {
      throw new LenkeError(
        `a path needs one more vertex than edge: got ${vertices.length} vertices, ${edges.length} edges`,
        { code: ErrorCode.InvalidValue },
      );
    }

    // Interleave vertex, edge, vertex, … vertex. Closes over the params (not
    // `this`), so it is safe to hand to `super` before the fields are assigned.
    const walk = function* (): Generator<PathElement, void> {
      for (const [i, vertex] of vertices.entries()) {
        if (i > 0) {
          yield edges[i - 1];
        }

        yield vertex;
      }
    };

    super(walk, vertices.length + edges.length);
    this.vertices = vertices;
    this.edges = edges;
  }

  /** Build a path from a start vertex and the `{edge, vertex}` steps of a walk. */
  static fromSteps(start: Vertex, steps: readonly PathStep[]): Path {
    const vertices = [start, ...steps.map((s) => s.vertex)];
    const edges = steps.map((s) => s.edge);

    return new Path(vertices, edges);
  }

  /** The first vertex of the walk. */
  get start(): Vertex {
    return this.vertices[0];
  }

  /** The last vertex of the walk. */
  get end(): Vertex {
    return this.vertices[this.vertices.length - 1];
  }

  /** The graph-theoretic path length: the number of edges (hops). */
  get hops(): number {
    return this.edges.length;
  }

  toJSON(): PathJSON {
    return {
      vertices: this.vertices.map((v) => v.toJSON()),
      edges: this.edges.map((e) => e.toJSON()),
      length: this.edges.length,
    };
  }

  toString(): string {
    return `Path { ${this.vertices.length} vertices, ${this.edges.length} edges }`;
  }
}
