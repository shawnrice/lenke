import type { Plan } from '../ast.js';

import {
  appendStep,
  buildPlan,
  type ByableStep,
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
export function select(
  ...args: [string | (typeof Pop)[keyof typeof Pop], ...string[]] | string[]
): ByableStep<Extract<Step, { kind: 'select' }>> {
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
} as const;

/** A `shortestPath()` step builder, configurable via `.with(...)`. */
export type ShortestPathStep = StepFn & {
  readonly with: (option: symbol, value: SubPlan) => ShortestPathStep;
};

const makeShortestPath = (target?: Plan): ShortestPathStep =>
  Object.assign(appendStep({ kind: 'shortestPath', ...(target ? { target } : {}) }) as StepFn, {
    with: (option: symbol, value: SubPlan): ShortestPathStep =>
      option === ShortestPath.target ? makeShortestPath(buildPlan(value)) : makeShortestPath(target),
  });

// Emit the shortest vertex path(s) from each source vertex to the destinations
// (all reachable vertices by default; restrict with
// `.with(ShortestPath.target, __.has(...))`). Unweighted BFS over incident edges.
export const shortestPath = (): ShortestPathStep => makeShortestPath();
