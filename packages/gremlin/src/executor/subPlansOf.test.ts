import { describe, expect, test } from 'bun:test';

import { coalesce, choose, map, optional, order, out, path, repeat, union, V } from '../steps.js';
import { traversal } from '../traversal.js';
import { planReadsPath } from './runtime.js';

// ⚠️ `subPlansOf` NO LONGER EXISTS — item 1504 folded it into `stepReadsPath` (in `ast.ts`), where
// the plan-bearing fields are now read at plan CONSTRUCTION instead of walked at execution. The
// filename is kept so this file's history stays findable; what it guards is unchanged and still
// load-bearing.
//
// `stepReadsPath` lists the plan-bearing fields on a Step, and `Plan.readsPath` ORs them as the plan
// is built. If a new sub-plan field is added to the AST but NOT to that list, a `path()` buried in
// that sub-plan goes unseen and path tracking is silently disabled — an EMPTY path, not an error.
// Each case below hides a `path()` inside one plan-bearing field, so `planReadsPath` must report
// `true`; a dropped field flips it to `false` and fails here.
//
// It earns its keep: a mutant that ignored the `bys` traversals survived
// `plan-reads-path.test.ts` and was caught only by this file.
describe('subPlansOf covers every plan-bearing Step field', () => {
  const readsPath = (...steps: Parameters<typeof traversal>): boolean =>
    planReadsPath(traversal(...steps));

  test('repeat body / until / emit', () => {
    expect(readsPath(V(), repeat(traversal(path())).times(1))).toBe(true);
    expect(readsPath(V(), repeat(traversal(out())).until(traversal(path())))).toBe(true);
    expect(readsPath(V(), repeat(traversal(out())).emit(traversal(path())).times(1))).toBe(true);
  });

  test('optional / map plan', () => {
    expect(readsPath(V(), optional(traversal(path())))).toBe(true);
    expect(readsPath(V(), map(traversal(path())))).toBe(true);
  });

  test('choose test / thenPlan / elsePlan', () => {
    expect(readsPath(V(), choose(traversal(path()), traversal(out())))).toBe(true);
    expect(readsPath(V(), choose(traversal(out()), traversal(path())))).toBe(true);
    expect(readsPath(V(), choose(traversal(out()), traversal(out()), traversal(path())))).toBe(
      true,
    );
  });

  test('union / coalesce plans', () => {
    expect(readsPath(V(), union(traversal(path()), traversal(out())))).toBe(true);
    expect(readsPath(V(), coalesce(traversal(out()), traversal(path())))).toBe(true);
  });

  test('by-traversal (bys)', () => {
    expect(readsPath(V(), order().by(traversal(path())))).toBe(true);
  });

  test('a plan with no embedded path() does not read the path', () => {
    expect(readsPath(V(), union(traversal(out()), traversal(out())))).toBe(false);
  });
});
