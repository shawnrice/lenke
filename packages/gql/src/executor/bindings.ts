/**
 * BINDINGS: adding a name to a row, and asking what a pattern unit exposes.
 *
 * The smallest leaf (item 1666) — 7 symbols, no value imports — and the most-reached-for: `matching.ts`
 * needed five of these back from `core.ts`, which was one of the import cycles.
 *
 * ⚠️ `withBinding` COPIES, AND `consistent` IS WHY. A matcher extends a row by name, and if two
 * pattern positions bind the same name they must agree rather than overwrite — `consistent` is that
 * check, and it is the reason this is a copy-on-extend `Map` rather than a mutable one. Item 1661's
 * surviving mutant was precisely a shared-instead-of-copied binding map; it was unobservable only
 * because the one clause path that writes in place (`insertVertexWithId`) is followed by a
 * projection that drops the leaked name.
 */

import type { Path } from '@lenke/core';

import type { RelPattern } from '../ast.js';
import type { Binding, Bound, CPredicate, CUnit } from './core.js';

export const withBinding = (
  binding: Binding,
  name: string | undefined,
  value: Bound | Path,
): Binding => {
  if (!name) {
    return binding;
  }

  const next = new Map(binding);
  next.set(name, value);

  return next;
};
/**
 * Is binding `value` to `name` consistent with what's already bound? An
 * unbound variable always binds; a bound one must refer to the same element
 * (this is what makes shared variables across patterns act as a join key).
 */
export const consistent = (binding: Binding, name: string | undefined, value: Bound): boolean => {
  if (!name) {
    return true;
  }

  const existing = binding.get(name);

  return existing === undefined || existing === value;
};
// ISO GQL: accessing a property that is absent — or a property of a NULL element
// (e.g. an unmatched OPTIONAL variable) — yields NULL, not `undefined`. Coalesce
// here so the whole pipeline (output rows, IS NULL, arithmetic) sees ISO's NULL.
export const propOf = (bound: unknown, key: string): unknown =>
  (bound as { properties?: Record<string, unknown> } | undefined)?.properties?.[key] ?? null;
/** Whether a unit binds any GROUP variable (source, an edge, a target, a `Sub`'s
 *  landing, or anything a nested sub-unit binds). Mirrors native `CUnit::exposes`. */
export const unitExposes = (u: CUnit): boolean =>
  u.startVar !== undefined ||
  u.elems.some((e) =>
    'hop' in e
      ? e.hop.targetVar !== undefined || e.hop.rel.variable !== undefined
      : e.sub.targetVar !== undefined || unitExposes(e.sub.unit),
  );
/** Whether every element is a plain hop (no nested `Sub`) — a flat unit binds group
 *  variables by the cheap `k`-stride over the flat walk, never per-hop steps. Mirrors
 *  native `CUnit::is_flat`. */
export const unitIsFlat = (u: CUnit): boolean => u.elems.every((e) => 'hop' in e);
export const hasPredicate = (pred: CPredicate): boolean =>
  pred.props.length > 0 ||
  pred.where !== undefined ||
  (pred.eqProps?.length ?? 0) > 0 ||
  (pred.truthProps?.length ?? 0) > 0 ||
  (pred.notTruthProps?.length ?? 0) > 0 ||
  (pred.cmpProps?.length ?? 0) > 0 ||
  (pred.pathProps?.length ?? 0) > 0 ||
  (pred.memberProps?.length ?? 0) > 0 ||
  (pred.nullProps?.length ?? 0) > 0 ||
  (pred.truthTestProps?.length ?? 0) > 0 ||
  (pred.labelTests?.length ?? 0) > 0 ||
  (pred.typedTests?.length ?? 0) > 0;
export const relHasPredicate = (rel: RelPattern): boolean =>
  (rel.properties?.length ?? 0) > 0 || rel.where !== undefined;
