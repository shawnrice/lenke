import {
  appendStep,
  buildPlan,
  type FlatMapClosure,
  isSubPlan,
  type MapClosure,
  type ReducerClosure,
  type SideEffectClosure,
  type StepFn,
  type SubPlan,
} from './framework.js';

// `map(plan)` or `map(fn)`. Sub-plan: replace value with the plan's first
// output; drop traverser if empty. Closure: `(value, traverser) => unknown`.
export const map = (
  arg: SubPlan | MapClosure,
): StepFn =>
  isSubPlan(arg)
    ? appendStep({ kind: 'map', plan: buildPlan(arg) })
    : appendStep({ kind: 'mapFn', fn: arg as MapClosure });

// `flatMap(plan)` or `flatMap(fn)`. Sub-plan form yields each output of the
// plan. Closure form: `(value, traverser) => Iterable<unknown>`.
export const flatMap = (
  arg: SubPlan | FlatMapClosure,
): StepFn =>
  isSubPlan(arg)
    ? appendStep({ kind: 'flatMap', plan: buildPlan(arg) })
    : appendStep({ kind: 'flatMapFn', fn: arg as FlatMapClosure });

// `fold()` collects the stream into an array.
// `fold(seed, reducer)` reduces the stream with a closure.
export function fold(): StepFn;
export function fold(seed: unknown, reducer: ReducerClosure): StepFn;
export function fold(seed?: unknown, reducer?: ReducerClosure): StepFn {
  if (reducer === undefined) {
    return appendStep({ kind: 'fold' });
  }
  return appendStep({ kind: 'foldFn', seed, fn: reducer });
}

// Inverse of fold: spread an iterable value into the stream.
export const unfold = (): StepFn => appendStep({ kind: 'unfold' });

// Replace each traverser's value with a constant.
export const constant = (value: unknown): StepFn => appendStep({ kind: 'constant', value });

// Run a plan or closure for its effect, then yield the original traverser
// unchanged. Sub-plans accept a `StepFn` or `Plan`; closure form is
// `(value, traverser) => void`.
export const sideEffect = (
  arg: SubPlan | SideEffectClosure,
): StepFn =>
  isSubPlan(arg)
    ? appendStep({ kind: 'sideEffect', plan: buildPlan(arg) })
    : appendStep({ kind: 'sideEffectFn', fn: arg as SideEffectClosure });

// Annotate stream with positional indexes: yields `[value, index]` per traverser.
export const index = (): StepFn => appendStep({ kind: 'index' });
