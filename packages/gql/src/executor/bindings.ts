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
import type { Graph, Vertex } from '@lenke/core';

import type { RelPattern } from '../ast.js';
import type { LabelExpr } from '../ast.js';
import { matchesLabel } from '../graph-queries.js';
import type { Binding, Bound, CPredicate, CUnit } from './core.js';
import type { CNode, Params } from './core.js';
import { satisfies } from './predicates.js';

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

/**
 * ⚠️ MOVED DOWN FROM `matching.ts` (item 1666). `core.ts` needed `matchNode` and nothing else from
 * `matching.ts`, while `matching.ts` needed two back — one of the four mutual import pairs. These
 * belong here on their own terms: both take a `Binding` and return an extended one or `null`, which
 * is exactly what this module is.
 *
 * ⚠️ `matchNodeLabelled` EXISTS SO A CALLER CAN SKIP THE LABEL TEST. A caller that already resolved
 * the effective label (item 1623) passes `undefined` for a vacuous one, and the test is not run at
 * all — see `effectiveLabel` in `labels.ts`. `matchNode` is the convenience form that always tests.
 * Collapsing the two would reinstate a test the elision exists to remove.
 */
export const matchNode = (
  binding: Binding,
  node: CNode,
  vertex: Vertex,
  params: Params,
  graph: Graph,
): Binding | null => matchNodeLabelled(binding, node, vertex, params, graph, node.label);
/**
 * `matchNode` with the label test given EXPLICITLY, so a caller that has already resolved the
 * effective label (item 1623) can pass `undefined` for a vacuous one and skip the test.
 *
 * ⚠️ IT IS A SEPARATE PARAMETER AND NOT A MUTATED `CNode`: the compiled plan is reused across
 * executions and across GRAPHS, and vacuity is a property of the graph. Writing the elided label
 * back onto the node would make the second execution's answer depend on the first graph's label
 * distribution, which is a wrong answer and not a slow one.
 */
export const matchNodeLabelled = (
  binding: Binding,
  node: CNode,
  vertex: Vertex,
  params: Params,
  graph: Graph,
  label: LabelExpr | undefined,
): Binding | null => {
  if (!matchesLabel(vertex, label)) {
    return null;
  }

  if (!consistent(binding, node.variable, vertex)) {
    return null;
  }

  // THE ELEMENT-DIRECT CONJUNCTS FIRST, BEFORE ANY ALLOCATION. `withBinding` copies the
  // incoming binding into a fresh `Map`, and on a scan that is once per CANDIDATE for a
  // predicate that rejects nearly all of them: instrumented over
  // `MATCH (u:User) WHERE u.name = $n` at 20,000 nodes, this allocated 20,000 bindings and
  // rejected 19,999 of them (item 631). A read of that shape claims a fast-path rung and never
  // arrives here at all, which is why an unindexed WRITE cost ~3.0x the identical read.
  //
  // Sound because `eqProps`/`cmpProps` read the property off the ELEMENT and their value side
  // is CLOSED (`asPropCompare`'s own requirement), so neither can read the variable this is
  // about to bind. Everything else still waits for `bound`.
  const bound = withBinding(binding, node.variable, vertex);

  if (!satisfies(vertex, node.pred, bound, params, graph)) {
    return null;
  }

  return bound;
};
