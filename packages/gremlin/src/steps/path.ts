import type { Direction, Plan } from '../ast.js';
import {
  appendStep,
  buildPlan,
  type ByableStep,
  type ColumnSym,
  COLUMN_TO_KIND,
  makeByable,
  type Pop,
  POP_TO_STR,
  type Step,
  type StepFn,
  type SubPlan,
} from './framework.js';

// Yield the path of values seen by each traverser. With `.by(...)` modulators,
// each path element is projected through the modulator round-robin.
export const path = (): ByableStep<Extract<Step, { kind: 'path' }>> =>
  makeByable<Extract<Step, { kind: 'path' }>>((bys) => ({ kind: 'path', bys }));

// Labeled positions / projection.
// `as` is a TS keyword, so we expose it as `as_` (cf. `in_`).
export const as_ = (label: string): StepFn => appendStep({ kind: 'as', label });

// `select(label, ...)` recalls values tagged via prior `as_(label)`. With
// `Pop.first | last | all`, controls which tagged value is returned when a
// label has been bound multiple times (typical inside `repeat()`).
export function select(...labels: string[]): ByableStep<Extract<Step, { kind: 'select' }>>;
export function select(
  pop: (typeof Pop)[keyof typeof Pop],
  ...labels: string[]
): ByableStep<Extract<Step, { kind: 'select' }>>;
export function select(column: ColumnSym): StepFn;
export function select(
  ...args: [ColumnSym] | [string | (typeof Pop)[keyof typeof Pop], ...string[]] | string[]
): ByableStep<Extract<Step, { kind: 'select' }>> | StepFn {
  // `select(Column.keys)` / `select(Column.values)`: extract a Map's keys/values.
  if (typeof args[0] === 'symbol' && COLUMN_TO_KIND.has(args[0])) {
    return appendStep({ kind: 'selectColumn', column: COLUMN_TO_KIND.get(args[0])! });
  }

  let pop: 'first' | 'last' | 'all' = 'last';
  let labels: readonly string[];

  if (typeof args[0] === 'symbol') {
    pop = POP_TO_STR.get(args[0]) ?? 'last';
    labels = args.slice(1) as string[];
  } else {
    labels = args as string[];
  }

  return makeByable<Extract<Step, { kind: 'select' }>>((bys) => ({
    kind: 'select',
    labels,
    pop,
    bys,
  }));
}

// Terminal: collect paths into a nested Map. With `.by(...)` modulators,
// each path element is keyed by its projection (round-robin).
export const tree = (): ByableStep<Extract<Step, { kind: 'tree' }>> =>
  makeByable<Extract<Step, { kind: 'tree' }>>((bys) => ({ kind: 'tree', bys }));

// `shortestPath()` configuration tokens, used with `.with(option, value)`.
export const ShortestPath = {
  /** A sub-traversal selecting the destination vertices. */
  target: Symbol('ShortestPath.target'),
  /**
   * Which incident edges the search follows, as a `Direction`: `Direction.BOTH`
   * (default, undirected — TinkerPop's default), `Direction.OUT`, or
   * `Direction.IN`. TinkerPop's `ShortestPath.edges` modulator.
   */
  edges: Symbol('ShortestPath.edges'),
} as const;

/** A `shortestPath()` step builder, configurable via `.with(...)`. */
export type ShortestPathStep = StepFn & {
  readonly with: (option: symbol, value: SubPlan | Direction) => ShortestPathStep;
};

const makeShortestPath = (target?: Plan, direction?: Direction): ShortestPathStep =>
  Object.assign(
    appendStep({
      kind: 'shortestPath',
      ...(target ? { target } : {}),
      ...(direction ? { direction } : {}),
    }) as StepFn,
    {
      with: (option: symbol, value: SubPlan | Direction): ShortestPathStep => {
        if (option === ShortestPath.target) {
          return makeShortestPath(buildPlan(value as SubPlan), direction);
        }

        if (option === ShortestPath.edges) {
          return makeShortestPath(target, value as Direction);
        }

        return makeShortestPath(target, direction);
      },
    },
  );

// Emit the shortest vertex path(s) from each source vertex to the destinations
// (all reachable vertices by default; restrict the targets with a sub-traversal
// built from bare step fns or `pipe(...)` — there is no anonymous-`__` builder:
// `shortestPath().with(ShortestPath.target, has('name', 'josh'))`). Unweighted
// BFS over incident edges.
export const shortestPath = (): ShortestPathStep => makeShortestPath();
