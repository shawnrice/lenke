/**
 * `planToGremlin` — the Plan → Groovy-text emitter.
 *
 * This is what makes the typed fluent API portable: author once as a `Plan`, run
 * it directly on the TS engine, or emit Groovy and run the identical traversal on
 * the Rust core via `graph.gremlin(text)`. It also absorbs the two dialects'
 * spelling differences (`in_`/`dedupe` here, `in`/`dedup` in the text dialect), so
 * callers never see them.
 *
 * It lived inside `packages/native/src/gremlin-conformance.test.ts`, where the
 * cross-engine suite used it to prove both engines agree — implemented, tested,
 * and unreachable by anyone outside that file. Moved here and exported so the
 * portability story is actually usable.
 *
 * Kinds that cannot cross the text boundary — JS closures, non-finite literals —
 * throw `EmitUnsupported`, tagged so a caller can distinguish "TS-only superset"
 * from "gap in the emitter".
 */
import type { By, Plan, Predicate, Step } from './ast.js';

//
// The reason a case can't be dual-authored by hand: this derives the Groovy
// string mechanically from the same Plan the TS engine runs. Unsupported kinds
// throw with a tag so the runner can classify (tsOnly) vs surface (emitter gap).

type UnsupportedKind = 'closure' | 'nonfinite' | 'unsupported';

export class EmitUnsupported extends Error {
  constructor(
    readonly reason: UnsupportedKind,
    detail: string,
  ) {
    super(`planToGremlin: ${reason}: ${detail}`);
  }
}

/** True for the kinds that only exist in the TS superset (no native form). */
export const isTsOnly = (e: unknown): e is EmitUnsupported =>
  e instanceof EmitUnsupported && e.reason !== 'unsupported';

const emitLiteral = (v: unknown): string => {
  if (typeof v === 'string') {
    return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }

  if (typeof v === 'boolean') {
    return String(v);
  }

  if (typeof v === 'number') {
    // NaN / ±Infinity have no Groovy literal and can't survive JSON — this is
    // exactly why the NaN drifts are unreachable through this boundary.
    if (!Number.isFinite(v)) {
      throw new EmitUnsupported('nonfinite', `${v} has no Groovy literal`);
    }

    return String(v);
  }

  throw new EmitUnsupported('unsupported', `literal of type ${typeof v}`);
};

const emitPredicate = (p: Predicate): string => {
  switch (p.op) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return `${p.op}(${emitLiteral(p.value)})`;
    case 'within':
    case 'without':
      return `${p.op}(${p.values.map(emitLiteral).join(', ')})`;
    case 'between':
    case 'inside':
    case 'outside':
      return `${p.op}(${emitLiteral(p.min)}, ${emitLiteral(p.max)})`;
    case 'regex':
      return `regex(${emitLiteral(p.value)})`;
    case 'not':
      return `not(${emitPredicate(p.predicate)})`;
    default:
      // startsWith/containing/... — extend as the corpus grows.
      throw new EmitUnsupported('unsupported', `predicate ${p.op}`);
  }
};

const emitBy = (by: By): string => {
  switch (by.kind) {
    case 'identity':
      return by.direction ? `.by(${by.direction})` : '.by()';
    case 'key':
      return by.direction
        ? `.by(${emitLiteral(by.key)}, ${by.direction})`
        : `.by(${emitLiteral(by.key)})`;
    default:
      // traversal / token by()s — extend as the corpus grows.
      throw new EmitUnsupported('unsupported', `by(${by.kind})`);
  }
};

// A `.with(<option>, <value>)` modulator suffix, or '' when the field is unset.
const emitWith = (option: string, value: string | number | undefined): string =>
  value === undefined ? '' : `.with(${option}, ${emitLiteral(value)})`;

// OLAP algorithm steps → Groovy, reconstructing the `.with(...)` modulators from
// the step's config fields. Split out of `emitStep` to keep its complexity low.
const emitAlgoStep = (
  step: Extract<Step, { kind: 'pageRank' | 'connectedComponent' | 'peerPressure' }>,
): string => {
  switch (step.kind) {
    case 'pageRank': {
      const base = step.alpha === undefined ? 'pageRank()' : `pageRank(${emitLiteral(step.alpha)})`;

      return `${base}${emitWith('PageRank.propertyName', step.property)}${emitWith('PageRank.times', step.times)}`;
    }
    case 'connectedComponent':
      return `connectedComponent()${emitWith('ConnectedComponent.propertyName', step.property)}`;
    case 'peerPressure':
      return `peerPressure()${emitWith('PeerPressure.propertyName', step.property)}${emitWith('PeerPressure.times', step.times)}`;
  }
};

const emitStep = (step: Step): string => {
  switch (step.kind) {
    case 'V':
      return `V(${(step.ids ?? []).map(emitLiteral).join(', ')})`;
    case 'inject':
      return `inject(${step.values.map(emitLiteral).join(', ')})`;
    case 'out':
    case 'in':
    case 'both':
      return `${step.kind}(${step.labels.map(emitLiteral).join(', ')})`;
    case 'hasLabel':
      return `hasLabel(${step.labels.map(emitLiteral).join(', ')})`;
    case 'has':
      return `has(${emitLiteral(step.key)}, ${emitPredicate(step.pred)})`;
    case 'is':
      return `is(${emitPredicate(step.pred)})`;
    case 'values':
      return `values(${step.keys.map(emitLiteral).join(', ')})`;
    case 'dedupe':
      return `dedup(${(step.labels ?? []).map(emitLiteral).join(', ')})`;
    case 'constant':
      return `constant(${emitLiteral(step.value)})`;
    case 'count':
      return 'count()';
    case 'id':
    case 'label':
    case 'value':
    case 'sum':
    case 'min':
    case 'max':
    case 'mean':
    case 'fold':
    case 'unfold':
    case 'order':
    case 'identity':
      return `${step.kind}()`;
    // The TS-superset kinds: no native form. Classified tsOnly.
    case 'mapFn':
    case 'flatMapFn':
    case 'filterFn':
    case 'sideEffectFn':
    case 'foldFn':
      throw new EmitUnsupported('closure', step.kind);
    case 'math': {
      const bys = (step.bys ?? []).map(emitBy).join('');

      return `math(${emitLiteral(step.expr)})${bys}`;
    }
    case 'branch': {
      const opts = step.options
        .map((o) => `.option(${emitLiteral(o.match)}, ${emitSubPlan(o.plan)})`)
        .join('');
      const def = step.default ? `.option(none, ${emitSubPlan(step.default)})` : '';

      return `branch(${emitSubPlan(step.test)})${opts}${def}`;
    }
    default:
      throw new EmitUnsupported('unsupported', `step ${step.kind}`);
  }
};

// OLAP kinds route to `emitAlgoStep`; everything else to the core `emitStep`
// switch — kept separate so neither function's cyclomatic complexity grows.
const ALGO_KINDS = new Set<Step['kind']>(['pageRank', 'connectedComponent', 'peerPressure']);

const emitAnyStep = (step: Step): string => {
  // `as('label')` — kept out of `emitStep`'s switch to hold its complexity budget.
  if (step.kind === 'as') {
    return `as(${emitLiteral(step.label)})`;
  }

  return ALGO_KINDS.has(step.kind)
    ? emitAlgoStep(
        step as Extract<Step, { kind: 'pageRank' | 'connectedComponent' | 'peerPressure' }>,
      )
    : emitStep(step);
};

// An anonymous sub-traversal (no `g.` prefix): `out('KNOWS').values('name')`.
const emitSubPlan = (p: Plan): string => p.steps.map(emitAnyStep).join('.');

export const planToGremlin = (plan: Plan): string => `g.${plan.steps.map(emitAnyStep).join('.')}`;
