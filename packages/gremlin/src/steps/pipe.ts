import type { Plan } from '../ast.js';
import { STEP_FN, type StepFn } from './framework.js';

/**
 * Compose multiple step constructors into a single branded StepFn.
 *
 * Use to build sub-plans inline:
 *
 *     filter(pipe(label(), is(eq('PERSON'))))   // sub-plan form, branded
 *     filter((v) => v.id === 1)                 // closure form
 *
 * `traversal(...)` works in the same slots now, so reach for whichever is
 * more readable for the call site.
 */
export const pipe = (...steps: StepFn[]): StepFn => {
  const fn = (plan: Plan): Plan => steps.reduce((p, s) => s(p), plan);
  // A plain assignment for the reason `appendStep` records: `defineProperty` was 73% of plan
  // construction, and the symbol key makes non-enumerability unobservable (item 1577).
  (fn as unknown as Record<symbol, boolean>)[STEP_FN] = true;

  return fn;
};
