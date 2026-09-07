import { appendStep, type Plan } from '../ast.js';
import type { StepFn } from './framework.js';

/**
 * OLAP algorithm steps (`pageRank` / `connectedComponent` / `peerPressure`).
 *
 * lenke computes these locally rather than dispatching to a distributed
 * GraphComputer, so `withComputer()` is accepted purely as a spec-currency
 * no-op. Each step runs the algorithm over the whole graph, writes a per-vertex
 * result to a property (the TinkerPop default name, or the one given via
 * `.with(<Algo>.propertyName, …)`), and passes the incoming traversers through
 * so a downstream step reads the result:
 *
 * ```ts
 * traversal(V(), pageRank(), order().by('gremlin.pageRankVertexProgram.pageRank', desc))
 * ```
 *
 * Composed as free functions via `traversal(...)` / `pipe(...)`, mirroring the
 * rest of this engine (there is no fluent source object, so `withComputer()` is
 * just another step).
 */

// `withComputer()` — marks OLAP intent in TinkerPop; lenke always computes
// in-process, so it adds no step.
export const withComputer = (): StepFn => (plan: Plan) => plan;

// ---- pageRank ----

/** `pageRank()` configuration tokens for `.with(option, value)`. */
export const PageRank = {
  /** Property the score is written to (default `gremlin.pageRankVertexProgram.pageRank`). */
  propertyName: Symbol('PageRank.propertyName'),
  /** Iteration count. */
  times: Symbol('PageRank.times'),
  /** Restrict the algorithm to edges of this label (default: all out-edges). */
  edges: Symbol('PageRank.edges'),
} as const;

type PageRankConfig = { property?: string; times?: number; alpha?: number; edgeLabel?: string };

/** A `pageRank()` step builder, configurable via `.with(...)`. */
export type PageRankStep = StepFn & {
  readonly with: (option: symbol, value: string | number) => PageRankStep;
};

const makePageRank = (config: PageRankConfig): PageRankStep =>
  Object.assign(appendStep({ kind: 'pageRank', ...config }) as StepFn, {
    with: (option: symbol, value: string | number): PageRankStep => {
      if (option === PageRank.propertyName) {
        return makePageRank({ ...config, property: String(value) });
      }

      if (option === PageRank.times) {
        return makePageRank({ ...config, times: Number(value) });
      }

      if (option === PageRank.edges) {
        return makePageRank({ ...config, edgeLabel: String(value) });
      }

      return makePageRank(config);
    },
  });

/**
 * PageRank over the whole graph. `alpha` is the damping factor (default 0.85);
 * `.with(PageRank.times, N)` sets the iteration count and
 * `.with(PageRank.propertyName, key)` the output property.
 */
export const pageRank = (alpha?: number): PageRankStep =>
  makePageRank(alpha !== undefined ? { alpha } : {});

// ---- connectedComponent ----

/** `connectedComponent()` configuration tokens for `.with(option, value)`. */
export const ConnectedComponent = {
  /** Property the component id is written to (default `gremlin.connectedComponentVertexProgram.component`). */
  propertyName: Symbol('ConnectedComponent.propertyName'),
  /** Restrict the algorithm to edges of this label (default: all edges). */
  edges: Symbol('ConnectedComponent.edges'),
} as const;

type ConnectedComponentConfig = { property?: string; edgeLabel?: string };

/** A `connectedComponent()` step builder, configurable via `.with(...)`. */
export type ConnectedComponentStep = StepFn & {
  readonly with: (option: symbol, value: string) => ConnectedComponentStep;
};

const makeConnectedComponent = (config: ConnectedComponentConfig): ConnectedComponentStep =>
  Object.assign(appendStep({ kind: 'connectedComponent', ...config }) as StepFn, {
    with: (option: symbol, value: string): ConnectedComponentStep => {
      if (option === ConnectedComponent.propertyName) {
        return makeConnectedComponent({ ...config, property: String(value) });
      }

      if (option === ConnectedComponent.edges) {
        return makeConnectedComponent({ ...config, edgeLabel: String(value) });
      }

      return makeConnectedComponent(config);
    },
  });

/** Weakly-connected components over the whole graph. */
export const connectedComponent = (): ConnectedComponentStep => makeConnectedComponent({});

// ---- peerPressure ----

/** `peerPressure()` configuration tokens for `.with(option, value)`. */
export const PeerPressure = {
  /** Property the cluster id is written to (default `gremlin.peerPressureVertexProgram.cluster`). */
  propertyName: Symbol('PeerPressure.propertyName'),
  /** Iteration count. */
  times: Symbol('PeerPressure.times'),
  /** Restrict the algorithm to edges of this label (default: all edges). */
  edges: Symbol('PeerPressure.edges'),
} as const;

type PeerPressureConfig = { property?: string; times?: number; edgeLabel?: string };

/** A `peerPressure()` step builder, configurable via `.with(...)`. */
export type PeerPressureStep = StepFn & {
  readonly with: (option: symbol, value: string | number) => PeerPressureStep;
};

const makePeerPressure = (config: PeerPressureConfig): PeerPressureStep =>
  Object.assign(appendStep({ kind: 'peerPressure', ...config }) as StepFn, {
    with: (option: symbol, value: string | number): PeerPressureStep => {
      if (option === PeerPressure.propertyName) {
        return makePeerPressure({ ...config, property: String(value) });
      }

      if (option === PeerPressure.times) {
        return makePeerPressure({ ...config, times: Number(value) });
      }

      if (option === PeerPressure.edges) {
        return makePeerPressure({ ...config, edgeLabel: String(value) });
      }

      return makePeerPressure(config);
    },
  });

/**
 * PeerPressure community detection over the whole graph.
 * `.with(PeerPressure.times, N)` sets the iteration count.
 */
export const peerPressure = (): PeerPressureStep => makePeerPressure({});
