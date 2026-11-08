/**
 * COUNTING A VAR-LENGTH PATH WITHOUT WALKING IT — the closed-form rung for `-[:T]->{m,n}`.
 *
 * ⚠️ THE LARGEST SELF-CONTAINED UNIT IN `shortcuts.ts`, and it was found by ownership rather than by
 * theme (item 1669). `shortcuts.ts` is not a tangle — 169 of its 173 symbols sit in no cycle at all
 * — it is a flat fan-out from 13 `detect*` entry points over ~10,000 lines of helpers. So the
 * question that yields a module boundary is not "what is cyclic" but "who can REACH this": 17
 * helpers here are reachable from `detectVarLengthCount` and from nothing else, which makes them its
 * machinery rather than the file\'s.
 *
 * ⚠️ THE TRAIL TABLES ARE THE SUBTLE PART AND THEY ARE WHY THIS IS ONE MODULE. A WALK may revisit;
 * a TRAIL may not reuse an edge. So a closed-form count over a walk is a degree recurrence, while
 * the same count over a trail must SUBTRACT the paths that reuse an edge — which at depth 3 is
 * `reusedTrailsAt3` and at depth 4 needs the pair multiplicities in `Trail4Tables`. Those
 * corrections are only correct TOGETHER with the recurrence they correct; separating them would let
 * one be changed without the other, and the failure mode is a wrong COUNT, not a slow one.
 *
 * `depth4Admissible` and `mirrorAdmissible` are the guards that decide when the closed form may be
 * used at all. They stay here for the same reason.
 */

import type { Edge, Graph, Vertex } from '@lenke/core';

import type { Clause, PathPattern } from '../ast.js';
import { edgesOfTypes, relTypeNames } from './adjacency.js';
import type { Params, Row } from './core.js';
import { plainNode } from './hop-sides.js';
import { inlineHolds } from './inline-gate.js';
import { vacuousLabel } from './labels.js';
import { alwaysTrue, chainGatesOf, countStarColumn, gateWith } from './shortcuts.js';

/**
 * A one-hop count whose ONLY constraint is a label on one end: the DEGREE SUM over that end's
 * label bucket, or `null` when neither walk fits and the caller must keep its per-edge walk.
 *
 * The unfiltered branch of {@link buildOneHopCount} had two rungs — the O(1) bucket size when
 * BOTH ends are unconstrained, and a per-edge walk testing both endpoints' labels otherwise —
 * so a start label `vacuousLabel` could not elide fell off a cliff. At 200,000 vertices and
 * 600,000 `E` edges, min of 9 over three alternated rounds:
 *
 *   MATCH (a)-[:E]->(b)   RETURN count(*)     0.001 ms   <- bucket size, unchanged
 *   MATCH (a:P)-[:E]->(b) RETURN count(*)    44.734 ms -> 18.048 ms   2.48x
 *   MATCH (a)-[:E]->(b:P) RETURN count(*)   156.784 ms -> 35.777 ms   4.38x
 *   MATCH (a:P)<-[:E]-(b) RETURN count(*)   160.251 ms -> 35.880 ms   4.47x
 *   MATCH (a:Q)-[:E]->(b) RETURN count(*)    36.981 ms ->  7.530 ms   4.91x
 *   MATCH (a:S)-[:E]->(b) RETURN count(*)    30.736 ms ->  0.004 ms   7684x
 *
 * The `:S` row is the one that settles that this was a missing rung and not a tuning question:
 * FOUR vertices with ZERO edges, and the query scanned 600,000 edges to find none. A label is
 * a per-vertex constraint; nothing about the degree-sum walk ever needed a predicate.
 *
 * Both walks are REUSED rather than reimplemented, with the inline branch's bare-predicate
 * device: they take their constraint from `pa`/`pb` and apply `pred.fn` on top, so an
 * always-TRUE predicate reduces each to "iterate the label bucket, sum the degree". The
 * alternative — a third loop — is what this file has already paid for once: the far endpoint
 * sat on the per-edge tally for eight items because its fit rule was a separate copy.
 *
 * MODULE SCOPE, AND THAT IS MEASURED, NOT STYLISTIC. Written inline in the closure
 * `buildOneHopCount` returns, this cost the two spellings that ALREADY took the walk a
 * consistent 0.95-0.96x — `clause WHERE start` and `inline start`, slower in all three rounds,
 * on a path whose only textual change was one extra disjunct evaluated once per query. Hoisted,
 * they return to 1.00-1.01x. That is `ts-closure-size-is-load-bearing` for the FOURTH time in
 * this file (items 119, 141, 159), and the first time it was predicted by the note at the call
 * site rather than discovered.
 */
/**
 * `count(*)` over a bounded var-length OUT hop, by DEGREE ARITHMETIC in O(V + E) rather than by
 * enumerating the O(paths) walks (item 573).
 *
 * The native engine has answered this shape algebraically since item 64 (`try_degree_algebra`);
 * TS enumerated, and the gap is ALGORITHMIC rather than the data-layout ceiling item 566
 * measured. Priced at 40,000 vertices / 120,000 edges, one case per process:
 *
 *   MATCH (a:P)-[:T]->{1,2}(y) RETURN count(*)              ts 300.22ms   nv 0.61   491x
 *   MATCH (a:P)((x)-[e:T]->(y)){1,2} RETURN count(*)           252.74          0.65  391x
 *
 * 479,998 paths against a V+E of 160,000, so enumeration is doing ~3x the work a closed form
 * needs — before the per-element constant.
 *
 * THE ARITHMETIC, for `max <= 2` and `Dir::Out`, mirroring the native function so the two cannot
 * drift: a 1-hop path is one wanted out-edge of a source whose target passes; a 2-hop path
 * `s -> y -> z` is one such edge times `y`'s own PASSING out-degree. A TRAIL then excludes the
 * single path that reuses the same edge, `s -> s -> s` over a self-loop, which `deg(s)` counted;
 * a WALK permits it and makes no correction. `{0,n}` adds the zero-length path per source, whose
 * endpoint is the SOURCE itself and so is the one row an endpoint test applies to directly.
 *
 * WALK/TRAIL ONLY. The degree algebra counts node-repeating paths, which SIMPLE and ACYCLIC
 * forbid — those have to enumerate, and `pattern.mode` is checked for exactly that.
 *
 * `set.size` is what makes the degree precompute cheap: a vertex's wanted out-degree is a sum of
 * per-label set sizes, O(#types) rather than O(degree) — so the whole first pass is O(V) when no
 * endpoint test needs a per-neighbour look. An endpoint test forces the per-neighbour walk and
 * the pass becomes O(E), which is still the closed form's budget.
 */
/**
 * The second hop's route decision, with no graph in it (item 585).
 *
 * Returns the number of vertices the FORWARD route would have to compute a degree for — which is
 * also the budget the inverted route must come in under — or `null` when the forward route is
 * cheap enough that the O(V) predicate sweep inversion needs is not worth paying.
 *
 * Extracted and exported for its own unit test for a specific reason: the decision is a PERF
 * choice and both answers are correct, so every mutation of it SURVIVES the differential tests.
 * Item 585 ran three such mutants (always invert; drop the `max >= 2` guard; invert for a vacuous
 * test) and all three passed 11 pinned cases, as they had to. Arithmetic that no differential test
 * can reach either gets its own test or gets no teeth at all.
 */
export const invertedHopBudget = (
  vertexCount: number,
  edgeCount: number,
  srcCount: number,
): number | null => {
  if (vertexCount === 0) {
    return null;
  }

  const avgDeg = edgeCount / vertexCount;
  // Every source reaches about `avgDeg` vertices at hop 1, capped by the graph: that is how many
  // distinct vertices `degreeOf` would be called for.
  const reachedEst = Math.min(vertexCount, srcCount * avgDeg);

  // Each of those costs about `avgDeg` edge visits. Below one visit per vertex the forward route
  // is already cheaper than the sweep that would decide against it.
  return reachedEst * avgDeg > vertexCount ? reachedEst : null;
};
/**
 * Does a SAMPLE of the endpoint test rule inversion out (item 585)?
 *
 * The full sweep is O(V) predicate calls, and when the test passes nearly everything that sweep
 * is pure loss: it runs, finds `passing` above the budget, and declines. Measured at 200,000
 * vertices, a test passing every vertex cost 3-8% for exactly that. Sampling the first
 * `sampleSize` vertices caps the loss at `sampleSize` calls.
 *
 * `true` means "do not even sweep". The projected passing count is `passed / sampleSize * V`, and
 * inversion is ruled out when that projection REACHES the budget — the same comparison the exact
 * check will make, just made early on an estimate.
 *
 * The comparison is deliberately tie-inclusive, and the first version of this got the margin
 * BACKWARDS. I required the projection to exceed the budget by a factor of two, reasoning that a
 * prefix of an insertion-ordered map is not a random sample so a close call should resolve to the
 * sweep. But the budget is capped at the vertex count, so a test that passes everything projects
 * EXACTLY the budget and never two times it: the check could not fire for the one case it was
 * built for. Dead on arrival, caught by writing its test.
 *
 * Erring the other way is safe in a way erring toward the sweep is not. If the prefix is
 * unrepresentative — passing everything in the first 1024 and little after — this skips a win and
 * runs the FORWARD route, which is what the engine did before item 585 at all. The downside is a
 * missed optimization; there is no wrong answer and no regression against the old route. And a
 * sample that says "invert" still gets the exact `passing.length < budget` check afterwards, so
 * this can only ever skip work, never choose the inverted route on its own.
 */
export const sampleRulesOutInversion = (
  sampleSize: number,
  passedInSample: number,
  vertexCount: number,
  budget: number,
): boolean => {
  if (sampleSize === 0 || sampleSize >= vertexCount) {
    return false; // nothing sampled, or the sample WAS the sweep — let the exact check decide
  }

  return (passedInSample / sampleSize) * vertexCount >= budget;
};
export type DegreeCountSpec = {
  types: string[] | undefined;
  min: number;
  max: number;
  isTrail: boolean;
  /** Walk the IN-adjacency instead of the out-adjacency — the mirror spelling (item 744). */
  inward: boolean;
  startName: string | undefined;
  passes: (v: Vertex) => boolean;
  /** True when `passes` cannot reject, so the degree is a set SIZE rather than a walk. */
  passesIsVacuous: boolean;
};
/** Bundled, not eight positional parameters: the arity limit, and the same reason
 *  `buildOneHopCount` bundles its `ends`. */
/**
 * `count(*)` over a bounded WALK of ANY depth, counted by LEVELS (item 588) — the TypeScript twin
 * of native's `walk_levels_total`.
 *
 *   u_0(v) = 1 if the endpoint test passes v, else 0
 *   u_j(v) = sum over wanted out-edges v -> y of u_{j-1}(y)
 *
 * so the answer is `sum over sources s, over j in min..=max, of u_j(s)`, one pass over the graph
 * per level instead of one per PATH. Specialize it to max = 2 by hand and it is
 * `varLengthDegreeCount`'s arithmetic term for term: `u_1(s)` is the passing out-degree its
 * `degreeOf` memoizes and `u_2(s)` the sum of neighbours' passing out-degrees.
 *
 * Item 587 shipped this in native, where the bench then priced the TS side of the SAME shape at
 * `ts 8362.9ms against ffi 5.6` — the largest TS/native gap in `bun run bench`, because TS had no
 * depth-3 rung at all and enumerated every path.
 *
 * THE LEVELS ARE DENSE ARRAYS OVER A FLATTENED ADJACENCY (item 589), not maps over vertices. Item
 * 588 shipped this as `Map<Vertex, number>` and left TS at 115x native, ASSERTING the map was the
 * cause. Measured rather than assumed, at 60,000 vertices / 180,000 edges:
 *
 *   cost is linear in depth          23.83 ms per level, intercept 3.12 ms
 *   walk the adjacency only           3.34 ms
 *   ... + one Map.get per edge       19.05        so the map is 15.71 of the 23.83
 *   ... + Map.get INDEX, dense read  19.52        going THROUGH a map to get an index is as slow
 *   one Map.set per vertex            2.30
 *   ------------------------------------------
 *   BUILD a CSR once (E map lookups) 18.28        one level's worth, paid once
 *   dense read from the built CSR     0.10 ms per level
 *   dense write per vertex            0.18
 *
 * So depth k goes from ~23.8k to ~18.3 + 0.3k. The map had to be removed from the per-level loop
 * ENTIRELY for that — resolving an index through a map per edge costs the same 19.5ms, which is why
 * the neighbour indices are precomputed instead of looked up.
 *
 * `Float64Array` holds exactly what the map held: a JS number IS an f64, and the sums run in the
 * same adjacency order, so this is a layout change and not a semantic one.
 *
 * WALK ONLY, exactly as in native. A trail forbids reusing an edge, which is not a function of the
 * current level: `u_j` would have to know which edges the walk already used, making it a map over
 * walks rather than over vertices.
 */
/**
 * The walks of length 3 from `v` that REUSE an edge — subtracted from `u_3(v)` to turn a walk count
 * into a trail count (item 601).
 *
 * MODULE SCOPE, not a closure inside `walkLevelCount`. Two reasons and they agree: the lint
 * complexity cap refused the enclosing function at 36, and [[ts-closure-size-is-load-bearing]]
 * records that a walk written INLINE in a returned closure gave UNRELATED queries a new slow mode
 * (4x). The arrays come in as parameters so nothing is captured.
 *
 * `off`/`nbr` are the flattened wanted-type adjacency, `pass` is `u_0` (the endpoint mask as 0/1),
 * `selfLoops[v]` the number of `v -> v` edges and `passDeg[v]` the PASSING out-degree.
 */
export const reusedTrailsAt3 = (
  v: number,
  off: Int32Array,
  nbr: Int32Array,
  pass: Float64Array,
  selfLoops: Float64Array,
  passDeg: Float64Array,
): number => {
  const end = off[v + 1];
  // e0 == e1: a self-loop at `v`, then any passing edge out of `v`. The walk ends at that third
  // edge's target, which is why the factor is the passing out-degree and not the raw one.
  let bad = selfLoops[v] * passDeg[v];

  for (let k = off[v]; k < end; k += 1) {
    const b = nbr[k];

    if (pass[b] === 0) {
      continue; // both remaining cases end at `b`
    }

    // e1 == e2: a self-loop at the landing, taken twice.
    bad += selfLoops[b];

    // e0 == e2: an edge back from `b` to `v`, then THIS edge again. COUNTED, not a boolean — two
    // parallel `v -> b` edges make `e0, b -> v, e2` a valid trail when `e0 !== e2`, so there is
    // one bad walk per reverse edge and "does a reverse edge exist" is the wrong question. A
    // mutant written that way is caught only by a fixture with parallel edges.
    const bEnd = off[b + 1];

    for (let j = off[b]; j < bEnd; j += 1) {
      if (nbr[j] === v) {
        bad += 1;
      }
    }
  }

  // All three equal: a self-loop at `v` used three times, ending back at `v`. Each of the three
  // terms above removed it once, so it comes back twice.
  return bad - 2 * selfLoops[v] * pass[v];
};
/**
 * Everything depth 4 needs beyond the depth-3 tables — bundled for the reason this file already
 * bundles `DegreeCountSpec` and native bundles `Trail3Tables`: the arity limit, and the
 * alternative is positional soup (item 692).
 */
export type Trail4Tables = {
  off: Int32Array;
  nbr: Int32Array;
  selfLoops: Float64Array;
  /** `walk_2(v)`, snapshotted before the level loop overwrote it. */
  walk2: Float64Array;
  /** `t3(v) = walk_3(v) − reusedTrailsAt3(v)`, the per-source depth-3 count. */
  t3: Float64Array;
  /** `m(u,v)` — the ordered-pair edge multiplicity, O(1) off an O(E) map. */
  mult: (u0: number, v0: number) => number;
};
/**
 * `u3(b, a)` — the 3-trails STARTING AT `b` that USE a given edge `a → b` (item 692).
 *
 * A trail uses each edge at most once, so that edge sits in exactly ONE of the three positions.
 * The cases are therefore DISJOINT and simply add, which is what replaces inclusion-exclusion over
 * depth 4's six equality events and its 63 intersections (item 600 declined to derive those; item
 * 687 sidestepped them). Validated 600/600 against brute force with 8/8 mutants caught (item 689).
 *
 * EDGE-IDENTITY-FREE, and that is load-bearing: this CSR carries neighbours only, so parallel edges
 * are indistinguishable slots and no `f ≠ e0` test could be written directly. Every such exclusion
 * reduces to a ±1 correction keyed on whether the edge LEAVES `b` — i.e. on `a === b`.
 *
 * Derived for a TRIVIAL endpoint mask, which is why the caller is gated on `passesIsVacuous`.
 */
export const usedTrailsAt3 = (b: number, a: number, t: Trail4Tables): number => {
  const { off, nbr, selfLoops, walk2, mult } = t;
  const bEnd = off[b + 1];
  const od = bEnd - off[b];
  const loops = selfLoops[b];
  let total = 0;
  let acc = 0;

  if (a === b) {
    // The edge is a SELF-LOOP at `b`, so it leaves `b` and competes with f1 and f2.
    //   f0 = e0: e0, then a 2-trail from b avoiding e0
    //   f1 = e0: a self-loop f0 ≠ e0, then e0, then f2 ∉ {f0, e0}
    total += walk2[b] - loops * od + (loops - 1) * (od - 2);
    total += (loops - 1) * (od - 2);

    // f2 = e0: a 2-trail b→c→b, then e0. The one f0 that IS e0 is removed AFTER the sum rather
    // than skipped inside it — that is what keeps this free of edge identities.
    for (let j = off[b]; j < bEnd; j += 1) {
      const c = nbr[j];

      acc += c === b ? loops - 2 : mult(c, b);
    }

    return total + acc - (loops - 2);
  }

  // The edge does not leave `b`, so it can be neither f0 nor f2 and only the landing tests matter.
  total += mult(b, a) * (od - 1);

  for (let j = off[b]; j < bEnd; j += 1) {
    acc += mult(nbr[j], a);
  }

  return total + acc;
};
/** `T4(s)` — the 4-trails starting at `s`, as `Σ_{e0: s→b} [ t3(b) − u3(b, s) ]` (item 692). */
export const trailsAt4From = (s: number, t: Trail4Tables): number => {
  const end = t.off[s + 1];
  let total = 0;

  for (let k = t.off[s]; k < end; k += 1) {
    const b = t.nbr[k];

    total += t.t3[b] - usedTrailsAt3(b, s, t);
  }

  return total;
};
/**
 * The ordered-pair edge multiplicity `m(u,v)`, as a lookup over an O(E) map.
 *
 * This is the "auxiliary O(E) structure" item 600b named and declined to assume. With it depth 4's
 * expensive term costs `Σ_b in(b)·out(b)` — the TWO-walk count — in lookups, where probing the
 * adjacency for the same number costs the THREE-walk count: item 689 measured 197x against
 * enumeration where item 686's adjacency-probing estimate predicted ~78x.
 *
 * A Map, against this function's own rule that "no level consults a Map at all" — that rule
 * protects depths 1-3, which never reach here. The alternative is a neighbour-SORTED CSR, which
 * item 688 priced as the wrong trade for TypeScript specifically, since this CSR is rebuilt per
 * QUERY while native's is a persistent overlay.
 */
export const pairMultiplicities = (
  off: Int32Array,
  nbr: Int32Array,
): ((u0: number, v0: number) => number) => {
  // ABLATION (item 1453): the multiplicity of (u, v) is how many times v appears in u's CSR
  // neighbour slice, which the slice itself answers. No Map, no boxed keys, no allocation.
  return (u0, v0) => {
    let seen = 0;
    const end = off[u0 + 1];

    for (let k = off[u0]; k < end; k += 1) {
      if (nbr[k] === v0) {
        seen += 1;
      }
    }

    return seen;
  };
};
/**
 * The per-LEVEL trail correction: what to SUBTRACT from the walk count at level `len`.
 *
 * PER LEVEL and not once per range, which is the distinction item 602 records — a correction
 * applied once for the whole range answers `{3,3}` correctly and `{1,3}` wrongly. Level 1 needs
 * none, since one edge cannot repeat.
 */
export const trailCorrectionAt = (
  len: number,
  srcIdx: Int32Array,
  u: Float64Array,
  csr: { off: Int32Array; nbr: Int32Array },
  masks: { pass: Float64Array; selfLoops: Float64Array; passDeg: Float64Array },
  tables4: Trail4Tables | undefined,
): number => {
  const { pass, selfLoops, passDeg } = masks;
  let bad = 0;

  // LEVEL 2: the one path that reuses a self-loop, `s -> s -> s`, and only when the endpoint
  // passes — the correction the `max <= 2` closed form already applied.
  if (len === 2) {
    for (const si of srcIdx) {
      bad += selfLoops[si] * pass[si];
    }
  } else if (len === 3) {
    // NOT gated on `tables4`: depth 3 never builds it, and gating here would silently drop the
    // level-3 correction for `max === 3` — caught by the brute-force oracle on the first run.
    for (const si of srcIdx) {
      bad += reusedTrailsAt3(si, csr.off, csr.nbr, pass, selfLoops, passDeg);
    }
  } else if (len === 4 && tables4 !== undefined) {
    // LEVEL 4 (item 692): `walk4(s) − T4(s)`, by the identity validated at items 687 and 689.
    for (const si of srcIdx) {
      bad += u[si] - trailsAt4From(si, tables4);
    }
  }

  return bad;
};
/**
 * Depth 4's tables, built at the end of LEVEL 3 — where `u` still holds `walk_3` (item 692).
 *
 * `reusedTrailsAt3` runs once per VERTEX, not once per edge: the identity needs `t3` at every
 * landing, and a landing is reached by `in(b)` different edges. That makes this O(V + the 2-walk
 * count), the same order as the depth-3 route's own work rather than a new asymptote (item 688).
 */
export const buildTrail4Tables = (
  walk3: Float64Array,
  csr: { off: Int32Array; nbr: Int32Array },
  masks: { pass: Float64Array; selfLoops: Float64Array; passDeg: Float64Array },
  walk2: Float64Array,
  mult: (u0: number, v0: number) => number,
): Trail4Tables => {
  const { off, nbr } = csr;
  const { pass, selfLoops, passDeg } = masks;
  const t3 = new Float64Array(walk3.length);

  for (let v = 0; v < walk3.length; v += 1) {
    t3[v] = walk3[v] - reusedTrailsAt3(v, off, nbr, pass, selfLoops, passDeg);
  }

  return { off, nbr, selfLoops, walk2, t3, mult };
};
/**
 * The depth-3/4 trail correction's masks, all three O(V + E) off the CSR.
 *
 * `pass` is `u_0` — the endpoint mask as 0/1, captured BEFORE the level loop overwrites `u`.
 * `selfLoops[v]` counts wanted `v -> v` edges, and `passDeg[v]` is the PASSING out-degree, which is
 * what the `e0 == e1` term needs: that walk ends at the third edge's target, so the factor is the
 * passing out-degree and not the raw one. All three are built with the same mask the level loop
 * uses, so a correction can never count an edge the walk would not have traversed.
 */
export const buildTrailMasks = (
  u0: Float64Array,
  csr: { off: Int32Array; nbr: Int32Array },
): { pass: Float64Array; selfLoops: Float64Array; passDeg: Float64Array } => {
  const { off, nbr } = csr;
  const pass = Float64Array.from(u0);
  const selfLoops = new Float64Array(pass.length);
  const passDeg = new Float64Array(pass.length);

  for (let v = 0; v < pass.length; v += 1) {
    const end = off[v + 1];
    let sl = 0;
    let pd = 0;

    for (let k = off[v]; k < end; k += 1) {
      const y = nbr[k];

      if (y === v) {
        sl += 1;
      }

      pd += pass[y];
    }

    selfLoops[v] = sl;
    passDeg[v] = pd;
  }

  return { pass, selfLoops, passDeg };
};
/** The flattened adjacency the level recurrence reads. Built once, then READ ONLY — every write to
 *  `off`, `nbr`, `order` and `idx` lives in {@link buildCsr}, which is what makes it cacheable. */
type CsrTables = {
  order: readonly Vertex[];
  idx: ReadonlyMap<Vertex, number>;
  off: Int32Array;
  nbr: Int32Array;
};

/**
 * ONE PASS to number the vertices, then the adjacency FLATTENED into neighbour indices. After this
 * no level consults a Map at all, which is the whole point — see the ablation in the module header.
 *
 * PREALLOCATED to the graph's edge count and filled in ONE pass. Built as a `number[]` with `push`
 * and then `Int32Array.from`, the same CSR cost ~55ms instead of ~20 — boxing, array growth, and
 * then a full copy — which showed up as the whole route reading 58ms flat in depth where the
 * per-level work is 0.3ms. The wanted-type filter can only keep FEWER edges than the graph has, so
 * `edgeCount` is a safe bound and the slack is never touched.
 */
const buildCsr = (graph: Graph, inward: boolean, types: string[] | undefined): CsrTables => {
  // THE ONLY THING DIRECTION CHANGES (item 744): which adjacency box the CSR is built from, and
  // which end of each edge is the neighbour. Everything downstream — the level recurrence, and the
  // depth-3/4 trail correction via `buildTrailMasks` and `buildTrail4Tables` — takes `{off, nbr}`
  // and never consults the graph again, so it inherits the direction for free.
  const edgesOf = (v: Vertex): Iterable<Edge> => {
    const box = inward ? v.adjTo : v.adjFrom;

    return box === undefined ? [] : edgesOfTypes(box, types);
  };
  const order = [...graph.verticesById.values()];
  const idx = new Map<Vertex, number>();

  for (let i = 0; i < order.length; i += 1) {
    idx.set(order[i], i);
  }

  const off = new Int32Array(order.length + 1);
  const nbr = new Int32Array(graph.edgeCount);
  let at = 0;

  for (let i = 0; i < order.length; i += 1) {
    off[i] = at;

    for (const e of edgesOf(order[i])) {
      nbr[at] = idx.get(inward ? e.from : e.to) ?? 0;
      at += 1;
    }
  }

  off[order.length] = at;

  return { order, idx, off, nbr };
};

/**
 * THE CSR, REUSED ACROSS QUERIES (item 1676). Item 1571 instrumented this route and found 86.3% of
 * a bounded var-length count going into a structure that is discarded the moment the query returns,
 * so the second identical query rebuilds it from scratch. The ablation in the module header is why:
 * the build is one level's worth of Map lookups and each level after it is ~0.1 ms.
 *
 * ⚠️ THE KEY IS `graph.topologyVersion`, AND NOTHING ELSE WOULD DO. `graph.version` and
 * `graph.epoch(name)` advance on a DEFERRED, veto-checked step — both read 0 through a sequence of
 * mutations and move only after a task drain — so a cache keyed on either serves a stale structure
 * to the ordinary `g.addEdge(...); query(g, …)` shape. `vertexCount`/`edgeCount` advance eagerly
 * but a delete plus an add leaves both unchanged while the topology differs. `topologyVersion` was
 * built for this (items 1674/1675) and bumps on vertex adds and removes, edge adds and removes, AND
 * edge-LABEL writes — the last because the adjacency boxes are keyed by edge type, so
 * `addLabelToEdge` re-buckets what `types` selects without touching `insertEdge`.
 *
 * ⚠️ AND THE SHAPE IS PART OF THE KEY, because `nbr` is DIRECTION- AND TYPE-FILTERED. Two
 * queries differing only in `-[:E]->` vs `<-[:E]-`, or in the edge types they name, need different
 * neighbour arrays from the same topology.
 *
 * ⚠️ `types` IS NOT SORTED INTO THE KEY, deliberately. Two spellings naming the same types in a
 * different order are semantically equivalent, so sharing an entry is tempting — but `edgesOfTypes`
 * iterates `types` IN ORDER, so the two orders produce `nbr` arrays that differ in position. The
 * count itself is a sum and would survive, but the depth-3/4 trail corrections read `nbr` positionally
 * via `pairMultiplicities`, and f64 sums in a different order are not required to agree bit for bit.
 * Byte-identity is a hard invariant here, so the conservative key is the one that ships.
 *
 * A `WeakMap` so a discarded graph is collectable, and a per-shape `Map` inside it so a workload
 * alternating two directions or two type filters does not thrash a single slot.
 */
const MAX_SHAPES = 8;

const csrCache = new WeakMap<Graph, { tv: number; byShape: Map<string, CsrTables> }>();

const csrFor = (graph: Graph, inward: boolean, types: string[] | undefined): CsrTables => {
  const tv = graph.topologyVersion;
  let entry = csrCache.get(graph);

  if (entry === undefined || entry.tv !== tv) {
    // A single stale generation is dropped WHOLE rather than per shape: every shape built from the
    // old topology is equally invalid, and keeping the map would leak one entry per shape per write.
    entry = { tv, byShape: new Map() };
    csrCache.set(graph, entry);
  }

  const key = `${inward ? '<' : '>'}${types === undefined ? '*' : types.join('\u0000')}`;
  const hit = entry.byShape.get(key);

  if (hit !== undefined) {
    return hit;
  }

  // ⚠️ CAPPED, BECAUSE THE RETENTION IS NOT SMALL AND NOTHING ELSE BOUNDS IT. Each entry holds
  // `order` (V references), `idx` (a V-entry Map) and two typed arrays sized V+1 and E — on the order
  // of 2 MB for a 50,000-vertex, 150,000-edge graph — and it lives as long as the graph does. A
  // generation is dropped whole on any topology write, so growth needs MANY distinct shapes with no
  // write between them, which is exactly what a report sweeping one query per edge type does. Past
  // the cap the generation is cleared rather than evicted one entry at a time: there is no recency
  // information worth keeping here, every entry costs one rebuild to recover, and a clear cannot
  // degrade into holding the cap's worth of cold entries forever.
  if (entry.byShape.size >= MAX_SHAPES) {
    entry.byShape.clear();
  }

  const built = buildCsr(graph, inward, types);
  entry.byShape.set(key, built);

  return built;
};

export const walkLevelCount = (graph: Graph, spec: DegreeCountSpec): number => {
  const { types, min, max, isTrail, inward, startName, passes } = spec;
  // The flattened adjacency, from the cross-query cache — see {@link csrFor}. The tables are READ
  // ONLY from here down, which is the property that lets them be shared.
  const { order, idx, off, nbr } = csrFor(graph, inward, types);
  // f64 accumulators, which is what the Map held: a JS number IS an f64, so this stores the same
  // bits and sums in the same adjacency order. Not a semantic change, a layout one.
  let u = new Float64Array(order.length);
  let next = new Float64Array(order.length);

  for (let i = 0; i < order.length; i += 1) {
    u[i] = passes(order[i]) ? 1 : 0;
  }

  const src = startName === undefined ? order : [...(graph.verticesByLabel.get(startName) ?? [])];
  // The sources' indices, resolved ONCE. They are read at every level, and when the start label is
  // absent that is one map lookup per vertex per level — the same cost this route exists to remove.
  const srcIdx = new Int32Array(src.length);

  for (let i = 0; i < src.length; i += 1) {
    srcIdx[i] = idx.get(src[i]) ?? 0;
  }

  let total = 0;

  // THE TRAIL CORRECTION (item 601), for `max === 3` only. A trail forbids reusing an EDGE, which
  // the level recurrence cannot express — `u_j` would have to know which edges the walk already
  // used. But at depth 3 the walks to exclude are exactly those where two of `e0, e1, e2`
  // coincide, and each case collapses to a countable term:
  //
  //   e0 == e1  forces a == b == c, i.e. a SELF-LOOP at the source, then any third edge out of it
  //   e1 == e2  is its mirror: an edge out, then a self-loop at the landing taken twice
  //   e0 == e2  forces a == c and b == d — the 2-cycle `a -> b -> a` reusing the first edge
  //   all three equal is a self-loop used three times, subtracted by all three terms above, so it
  //   returns with coefficient 2
  //
  // Each endpoint test applies at the walk's LAST node, which is why the terms carry different
  // `pass` factors: `e0 == e1` ends at the third edge's target, `e1 == e2` and `e0 == e2` end at
  // the landing `b`, and the triple case ends back at the source.
  //
  // Verified against brute-force triple enumeration over 400 random graphs admitting SELF-LOOPS
  // and PARALLEL EDGES (item 600) — parallel edges are what break a naive version, because two
  // parallel `a -> b` edges make `e0, b -> a, e2` a VALID trail when `e0 !== e2`, and the
  // `e0 == e2` term must subtract only the one walk whose third edge is literally the first.
  //
  // `selfLoops` and the PASSING out-degree are O(V + E) off the CSR. The `e0 == e2` term is not:
  // it needs the multiplicity of an ordered pair and this adjacency is in edge-insertion order,
  // so it probes the landing's segment and costs the TWO-WALK count. That is still a factor of
  // the average degree below enumerating three-walks, which is the whole win (item 600b corrects
  // an earlier claim that it was O(V + E)).
  // DEPTH 2 joins the level recurrence at item 699. It used to take the `max <= 2` closed form,
  // which is the SAME arithmetic over the Map-based adjacency rather than the flat CSR — and
  // measured SLOWER than depth 3 while counting a third as many paths (15.4 ms against 9.2 at
  // 50,000 vertices / degree 3). Its correction is the one-self-loop term the old path already
  // applied, and it is already in `trailCorrectionAt`'s `len === 2` branch.
  //
  // Relaxing the dispatch bound WITHOUT this line answers the WALK count — 450,000 against the
  // trail's 449,998 — which is item 692's mistake exactly, caught here by printing the answers
  // beside the times (item 600's rule) rather than by any timing.
  const trail2 = isTrail && max === 2;
  const trail3 = isTrail && max === 3;
  // DEPTH 4 (item 692) reuses every depth-3 table and adds three things of its own. It is gated on
  // `passesIsVacuous` because the depth-4 terms were derived for a TRIVIAL endpoint mask (items
  // 687-689) and nothing validates them against a filtered one; the detector refuses otherwise.
  const trail4 = isTrail && max === 4;
  const trailCorr = trail2 || trail3 || trail4;
  const trailMasks = trailCorr ? buildTrailMasks(u, { off, nbr }) : undefined;

  // DEPTH 4's extra state, built only when `trail4` so no shallower depth pays for it. See
  // `pairMultiplicities` for why a Map is the right trade here and the wrong one for native.
  const mult = trail4 ? pairMultiplicities(off, nbr) : undefined;
  // `u` is swapped per level, so without this the depth-4 terms would read a vector that has
  // already been overwritten.
  let walk2Snap: Float64Array | undefined;
  let tables4: Trail4Tables | undefined;

  // The ZERO-LENGTH path, whose endpoint is the SOURCE — one row per source row. `src` may hold a
  // vertex more than once, so this counts rows rather than summing `u_0` over distinct vertices.
  if (min === 0) {
    for (const s of src) {
      if (passes(s)) {
        total += 1;
      }
    }
  }

  for (let len = 1; len <= max; len += 1) {
    for (let v = 0; v < order.length; v += 1) {
      const end = off[v + 1];
      let acc = 0;

      for (let k = off[v]; k < end; k += 1) {
        acc += u[nbr[k]];
      }

      next[v] = acc;
    }

    const swap = u;

    u = next;
    next = swap;

    // OUTSIDE the `len >= min` gate on purpose: the recurrence runs at every level whatever `min`
    // is, and `{4,4}` needs the level-2 and level-3 vectors even though neither is emitted.
    if (trail4) {
      if (len === 2) {
        walk2Snap = Float64Array.from(u);
      } else if (len === 3) {
        tables4 = buildTrail4Tables(u, { off, nbr }, trailMasks!, walk2Snap!, mult!);
      }
    }

    if (len >= min) {
      // AN INDEX LOOP, against `prefer-for-of`, and the exemption is measured rather than
      // asserted. `for (const i of srcIdx)` goes through the iterator protocol once per source
      // per LEVEL, and cost 0.97x at `{1,3}` and 0.92x at `{1,6}` over three alternated rounds,
      // one case per process — the penalty scaling with depth is the tell. I had written "within
      // noise of the indexed form" in this comment BEFORE measuring it, which was wrong.
      // oxlint-disable-next-line typescript/prefer-for-of -- 8% at depth 6; see the numbers above
      for (let i = 0; i < srcIdx.length; i += 1) {
        total += u[srcIdx[i]];
      }

      if (trailCorr) {
        total -= trailCorrectionAt(len, srcIdx, u, { off, nbr }, trailMasks!, tables4);
      }
    }
  }

  return total;
};
/**
 * Does this spec take the LEVEL RECURRENCE rather than the `max <= 2` closed form?
 *
 * A named predicate rather than an inline condition because it is the ROUTE CHOICE, and because
 * `varLengthDegreeCount` is at the lint complexity cap — an extra `||` in there is refused.
 *
 *   - a WALK at ANY depth: the recurrence is exact, nothing is forbidden (item 587/589).
 *   - a TRAIL at EXACTLY 3: the recurrence plus `reusedTrailsAt3`'s four-term correction
 *     (item 601). This is the DEFAULT spelling — `parsePathMode` returns `trail` with no keyword
 *     — so `-[:K]->{3}` lands here, and it is the shape that had no rung at all before.
 *   - a TRAIL at 4 or more: still refused. The correction grows a term per coinciding PAIR and
 *     the pairs start interacting; item 600 derived depth 3 and explicitly did not derive 4.
 *   - `max <= 2`: unchanged, runs the code it has always run.
 *
 * THE `spec.max === 3` CLAUSE IS A SECOND LINE OF DEFENCE, not the active guard, and a mutant
 * relaxing it to `spec.max >= 3` SURVIVES — including against the depth-4 test added for exactly
 * that. The reason is reachability: `detectVarLengthCount` already refuses `max > 3` for anything
 * but a walk, so a depth-4 trail never arrives here. The ACTIVE guard is that detector bound, and
 * mutating IT (to `max > 4`, or dropping the mode check) is CAUGHT.
 *
 * Kept anyway, for the same reason the `!spec.isTrail` clause was kept before this item: whoever
 * derives the depth-4 correction will relax the detector first, and this is then the one line
 * standing between a depth-4 trail and a depth-3 correction that does not apply to it. A guard
 * against a future relaxation is not the same as a guard against nothing — but it should not be
 * mistaken for the one under test, which is what cost this item a mutation round.
 */
export const takesTheLevelRecurrence = (spec: DegreeCountSpec): boolean =>
  spec.max >= 2 && (!spec.isTrail || spec.max <= 4);
export const varLengthDegreeCount = (graph: Graph, spec: DegreeCountSpec): number => {
  // DEPTH 3+ IS A DIFFERENT ALGORITHM, and it is dispatched here rather than in the detector so
  // that both of the detector's closures keep exactly the captures they had (item 583's split, and
  // [[ts-closure-size-is-load-bearing]] behind it). `max <= 2` runs the code it has always run.
  //
  // `!spec.isTrail` is UNREACHABLE TODAY and kept deliberately — a mutant removing it SURVIVES,
  // because `detectVarLengthCount` already refuses `max > 2` for anything but a walk, and the two
  // closures there are this function's only callers. Item 583 deleted a guard in exactly that
  // position as dead code; this one stays because the condition it duplicates is a RECORDED OPEN
  // TARGET. A trail past two hops needs its own inclusion-exclusion over edge-reuse shapes, and
  // whoever lands that will relax the detector's bound — at which point this is the one line
  // standing between a trail and the walk's arithmetic, which would answer 32 where the trail
  // answers 28. A guard against a future relaxation is not the same as a guard against nothing.
  //
  // THAT HAPPENED, AT ITEM 692, EXACTLY AS WRITTEN. The depth-4 closed form relaxed the detector's
  // bound to 4 and left this bound at 3, so a depth-4 trail fell through to the `max <= 2`
  // arithmetic and answered the WALK count — 3 where the trail answers 0 on a triangle. The
  // brute-force oracle (item 690) caught it on its first run. The bound is now `max <= 4`, and the
  // same note applies again to whoever lands depth 5.
  if (takesTheLevelRecurrence(spec)) {
    return walkLevelCount(graph, spec);
  }

  const { types, min, max, isTrail, startName, passes, passesIsVacuous } = spec;
  // `edgesOfTypes`, NOT a sum of per-label `set.size`. A MULTI-LABEL edge sits in several of
  // this box's buckets, so summing their sizes counts it once per label it carries — which is
  // what `multi-label-edges.test.ts` ("a reachability walk visits each edge once") caught,
  // answering 8 where the walk answers 3. That helper already dedupes through a `Set` and keeps
  // the O(1) routes for a single wanted type and a single-bucket graph, so the degree stays a
  // set SIZE in the common case and becomes a deduped walk only when it has to.
  //
  // My own `[:T|U]` sweep cases did NOT catch this: their T and U edges were disjoint, so right
  // and wrong agreed. Seventh coinciding fixture in this run of ticks, and the first the repo's
  // existing suite caught rather than a probe.
  const edgesOf = (v: Vertex): Iterable<Edge> => {
    const box = v.adjFrom;

    return box === undefined ? [] : edgesOfTypes(box, types);
  };
  // THE SECOND HOP, FORWARDS OR BACKWARDS (item 585).
  //
  // The quantity wanted is, per vertex, how many of its out-edges land somewhere that PASSES.
  // Walking out-edges pays one visit per edge IN THE GRAPH and is flat in how selective the
  // endpoint test is — item 584 measured that directly: rejecting every vertex (355.24ms) costs
  // nearly what accepting every vertex does (446.49), against 187.87 unfiltered.
  //
  // The same quantity accumulated BACKWARDS costs one visit per edge INTO A PASSING VERTEX. For
  // each passing `z`, every in-edge of `z` adds one to its source's count. That scales with
  // selectivity, which is the property the forward walk does not have.
  //
  // It is a CHOICE and not a replacement, because `degreeOf` is demand-driven: it computes a
  // degree only for vertices actually reached at hop 1, so a narrow start label can make the
  // forward route cost far less than O(E), while inversion is eager over every passing vertex.
  // The comparison is `reached x avg_deg` against `passing x avg_indeg` — and since in and out
  // degree average the same thing over a whole graph, that reduces to `passing` against
  // `reached`. Both thresholds below are cost ESTIMATES, not tuned knobs.
  const srcCount =
    startName === undefined ? graph.vertexCount : (graph.verticesByLabel.get(startName)?.size ?? 0);
  const reachedEst = invertedHopBudget(graph.vertexCount, graph.edgeCount, srcCount);
  let passdeg: Map<Vertex, number> | undefined;

  // The predicate sweep that gives `passing` is itself O(V) — 200,000 calls at the ~15ns item 584
  // priced is ~3ms against the ~240ms being decided about — but it is still wasted work when the
  // forward route was never going to touch many edges, hence the outer guard.
  if (!passesIsVacuous && max >= 2 && reachedEst !== null) {
    const passing: Vertex[] = [];
    // SAMPLE FIRST. `verticesById` is insertion-ordered, so this is a prefix and not a random
    // sample — which is why `sampleRulesOutInversion` wants a factor of two before it declines.
    const sampleSize = Math.min(1024, graph.vertexCount);
    let sampled = 0;
    let passedInSample = 0;
    let ruledOut = false;

    for (const v of graph.verticesById.values()) {
      if (sampled < sampleSize) {
        sampled += 1;

        if (passes(v)) {
          passedInSample += 1;
          passing.push(v);
        }

        if (
          sampled === sampleSize &&
          sampleRulesOutInversion(sampleSize, passedInSample, graph.vertexCount, reachedEst)
        ) {
          ruledOut = true;
          break;
        }

        continue;
      }

      if (passes(v)) {
        passing.push(v);

        // Stop as soon as inversion is known to LOSE. A test that passes everything cannot be
        // worth inverting, and without this bound the sweep is pure loss on exactly that shape:
        // the `TRUE for all` arm measured 361.48 against 371.54, ~3% for a decision that then
        // declined. The bound only bites when `reachedEst` is below the vertex count, i.e. when
        // the start label is narrow — which is also the case where the forward route was already
        // the right answer.
        if (passing.length >= reachedEst) {
          break;
        }
      }
    }

    if (!ruledOut && passing.length < reachedEst) {
      passdeg = new Map();

      for (const z of passing) {
        const box = z.adjTo;

        if (box === undefined) {
          continue;
        }

        // `edgesOfTypes` on the IN side for the same reason it is used on the out side: a
        // MULTI-LABEL edge sits in several buckets and must be counted once.
        for (const e of edgesOfTypes(box, types)) {
          passdeg.set(e.from, (passdeg.get(e.from) ?? 0) + 1);
        }
      }
    }
  }

  // The PASSING out-degree, memoized per vertex. Keyed on the vertex OBJECT: audit item 321
  // prices that at 30.5ns against 59.7 for the id string, and this is read once per edge.
  const deg = new Map<Vertex, number>();
  const degreeOf = (v: Vertex): number => {
    if (passdeg !== undefined) {
      // Already complete for every vertex with a passing out-neighbour; absent means zero.
      return passdeg.get(v) ?? 0;
    }

    const hit = deg.get(v);

    if (hit !== undefined) {
      return hit;
    }

    const it = edgesOf(v);
    let n: number;

    if (passesIsVacuous && it instanceof Set) {
      n = it.size; // the O(1) route: one wanted type, or a graph of one edge label
    } else {
      n = 0;

      for (const e of it) {
        if (passes(e.to)) {
          n += 1;
        }
      }
    }

    deg.set(v, n);

    return n;
  };
  const sources =
    startName === undefined
      ? graph.verticesById.values()
      : (graph.verticesByLabel.get(startName) ?? []);
  let total = 0;

  for (const s of sources) {
    // The zero-length path: its endpoint is the SOURCE.
    if (min === 0 && passes(s)) {
      total += 1;
    }

    if (max === 0) {
      continue;
    }

    for (const e of edgesOf(s)) {
      const y = e.to;

      if (min <= 1 && passes(y)) {
        total += 1; // the 1-hop path s -> y
      }

      if (max >= 2) {
        total += degreeOf(y);

        // A trail excludes the one path that reuses THIS edge, `s -> s -> s`, which
        // `degreeOf(s)` counted — and only when that endpoint passes.
        if (isTrail && y === s && passes(s)) {
          total -= 1;
        }
      }
    }
  }

  return total;
};
/**
 * `MATCH (a:A)-[:T]->{m,n}(b:B) RETURN count(*)` — answer it with {@link varLengthDegreeCount}.
 *
 * NARROW, and every condition earns its place:
 *
 * - **OUT only, `1 <= max <= 2`, WALK or TRAIL.** The arithmetic is the native engine's and
 *   carries its limits: an unbounded or deeper quantifier has no two-term closed form here, and
 *   SIMPLE / ACYCLIC forbid the node-repeating paths the degree product counts.
 * - **No `unit`.** The parenthesized GROUP spelling reaches this through item 569's
 *   `dropUnreadGroupBinds`, which turns a group whose bindings nothing reads into exactly this
 *   abbreviated form — so one implementation serves both spellings and they cannot diverge in
 *   cost. A group that still carries bindings keeps the walk, because a per-rep LIST is the
 *   answer rather than a filter. In the AST that is `hopFrom`; `unit` is the COMPILED shape.
 * - **No per-hop rel predicate** (`plainRel` minus its quantifier test) and **no clause WHERE**.
 *   A per-rep predicate folds into the native twin as a traversal mask (item 572); this is the
 *   TS side's first step and does not attempt it.
 * - **Endpoint LABEL is admitted**, as the `passes` test. A vacuous label is detected and
 *   `passesIsVacuous` keeps the degree a sum of set SIZES — item 566's note that a label which
 *   excludes nothing must not be allowed to turn a degree product into a per-edge scan.
 */
/**
 * The PATTERN half of {@link detectVarLengthCount}'s shape test — a lone bounded OUT var-length
 * hop between two bare nodes.
 *
 * Its own function because the detector sits on the complexity gate: inline, the chain read 38
 * against a maximum of 35. `tallyGroupShapes` and `genQuantifiedGroup` were split for the same
 * reason, and the gate has been right each time.
 *
 * `selector` DEFAULTS to the string 'walk' (all walks) rather than to undefined, so the guard is
 * `!== 'walk'`. Written as `!== undefined` it declines EVERY query — which is how this started,
 * and the measurement showed no change at all until it was found.
 *
 * The ENDPOINT node is no longer required to be plain (item 583): its constraint is carried as an
 * `InlinePred` and applied per reached endpoint. The detector decides whether it can be carried.
 */
export const degreeCountShape = (pattern: PathPattern): boolean => {
  if (
    pattern.pathVar !== undefined ||
    pattern.segments.length !== 1 ||
    (pattern.selector !== undefined && pattern.selector !== 'walk') ||
    !plainNode(pattern.start) ||
    (pattern.mode !== undefined && pattern.mode !== 'trail' && pattern.mode !== 'walk')
  ) {
    return false;
  }

  const [seg] = pattern.segments;
  // The ENDPOINT `node` is deliberately NOT read here (item 583) — its constraint is carried, not
  // refused, and `detectVarLengthCount` decides whether it can be.
  const { rel } = seg;

  return !(
    seg.hopFrom !== undefined ||
    seg.nested !== undefined ||
    rel.quantifier === undefined ||
    (rel.direction !== 'out' && rel.direction !== 'in') ||
    (rel.properties?.length ?? 0) > 0 ||
    rel.where !== undefined ||
    rel.variable !== undefined
  );
};
/**
 * Whether a depth-4 TRAIL may take the closed form (item 692) — true for every other shape.
 *
 * Depth 4 is admitted with no endpoint PREDICATE. Its terms were derived and validated for a
 * TRIVIAL endpoint mask (items 687-689) and nothing checks them against a filtered one — so a
 * carried predicate falls back to enumeration here, and a LABEL is admitted and decided at RUN TIME
 * by the closure, because a label every vertex carries is trivial and only the graph can say so
 * (item 1399). It used to refuse a label here too; that cost 11-13x and the measurements are below.
 *
 * ⚠️ THE MASK CONSTRAINT IS A CORRECTNESS CONSTRAINT, NOT CONSERVATISM — measured at item 1400.
 * Removing the closure's runtime decline, so a FILTERING label reaches the depth-4 terms, answers
 * **−3** on randomized multigraphs: with a non-trivial mask the correction subtracts more than the
 * walk count it corrects. Item 1399 had measured that same removal as "correct and 9.9x faster" on
 * two 100,000-vertex fixtures — out-degree 1, one long cycle, no self-loops, no parallel edges, i.e.
 * none of the structures the correction exists for. The guard in `trail-count-bruteforce.test.ts`
 * now covers this; do not relax it on the strength of a hand-built fixture.
 *
 * The test has to be STATIC. `passesIsVacuous` is the flag that actually matters, but it is a
 * QUERY-TIME value — it calls `vacuousLabel(graph, …)` — and `walkLevelCount` returns a number with
 * no way to decline once chosen. So this refuses on the SYNTAX, which is stricter than necessary: a
 * label every node happens to carry would be vacuous at runtime and is refused here anyway.
 *
 * ⚠️ THAT "STRICTER THAN NECESSARY" IS NOW PRICED AT 11-13x (item 1398), on a 100,000-vertex graph
 * where every vertex carries `P` so the label rejects nothing. Same answer, 400,000, every row:
 *
 *   MATCH ()-[:E]->{1,4}()           43.2 ms   closed form
 *   MATCH (a:P)-[:E]->{1,4}()        32.2 ms   closed form — a START label is fine
 *   MATCH ()-[:E]->{1,4}(b:P)       433.7 ms   DECLINED to the general matcher
 *   MATCH (a:P)-[:E]->{1,4}(b:P)    478.9 ms   DECLINED
 *   MATCH (a:P)-[:E]->{1,3}(b:P)     20.8 ms   depth 3 takes it WITH the far label
 *
 * A windowed profile of the declined row confirms the route, not just the cost: no
 * `walkLevelCount`, no `varLengthDegreeCount`, no `trailsAt4From` — it is `flatAdj` 36.6%,
 * `evalLabelExpr` 15.6%, `trailEnds` 14.6%, `walkSegments` 8.1%.
 *
 * THE GATE ITSELF IS CORRECT and must not be relaxed on its own: the depth-4 terms are derived for a
 * trivial mask, and item 692 already shipped that mistake once — the walk count, 450,000 against the
 * trail's 449,998, caught by printing answers beside times. Fixing this needs a way to DECLINE AFTER
 * CHOOSING, so the closure can test `vacuousLabel` with the graph in hand and fall back when the
 * label really does filter. That is an architecture change to how detectors hand back work, not a
 * predicate tweak, which is why it is priced here rather than taken.
 */
export const depth4Admissible = (
  max: number,
  mode: string | undefined,
  endPred: unknown,
): boolean => max !== 4 || mode === 'walk' || endPred === undefined;
/**
 * Whether the MIRROR spelling (`<-[:T]-{n,m}`) may take this route (item 744).
 *
 * `true` for every forward query. For a backward one it needs the LEVEL RECURRENCE, which is the
 * only route taught about direction: it builds a CSR from the named adjacency and hands `{off,
 * nbr}` on, so the trail correction inherits the direction. `takesTheLevelRecurrence` is
 * `max >= 2`, so a shallower or UNBOUNDED mirror would fall to the `max <= 2` arithmetic, whose
 * `degreeOf` reads the out-adjacency directly and would answer the FORWARD count for a backward
 * query.
 *
 * Its own function rather than three clauses inline, because `detectVarLengthCount` sits ON the
 * complexity gate — inline it read 36 against a maximum of 35, which is the same reason this file
 * already factors out `depth4Admissible`.
 *
 * 🛑 BOTH CLAUSES ARE REDUNDANT TODAY, which is why a mutant replacing this whole body with `true`
 * SURVIVES (item 744 recorded that survivor as unexplained; item 745 explains it):
 *
 *   - `max === 1` cannot reach here. `dropVacuousQuantifier` removes a `{1,1}` quantifier outright
 *     (`vacuousQuantifier`: `min === 1 && max === 1` plus a plain rel), so `degreeCountShape` then
 *     sees `rel.quantifier === undefined` and refuses the segment before this is consulted.
 *   - `max === null` is refused nine lines below, for BOTH directions, by the depth bound
 *     `max === null || max < 1 || (max > 4 && mode !== 'walk')`.
 *
 * It stays for the reason this file keeps `!spec.isTrail`: the hazard is real and the guard is
 * against a RELAXATION of either condition above. Below `max >= 2`, `varLengthDegreeCount` falls to
 * arithmetic whose `edgesOf` reads `v.adjFrom` directly, and it cannot decline once chosen — it
 * returns a number. So the only place to refuse is here, upstream, and item 692 is the record of
 * exactly this guard-against-a-future-relaxation being needed when the future arrived.
 */
export const mirrorAdmissible = (inward: boolean, max: number | null): boolean =>
  !inward || (max !== null && max >= 2);
export const detectVarLengthCount = (
  clauses: readonly Clause[],
  // `Row[] | undefined`, uniquely among the detectors: a depth-4 trail's endpoint label may be
  // VACUOUS, which only the graph can say, so this rung is admitted at compile time and declines at
  // run time (item 1399). `undefined` means "the general clause loop must run", which is the
  // contract `fastPath` already documented for a rung that does not exist at all.
): ((graph: Graph, params: Params) => Row[] | undefined) | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;

  if (m?.kind !== 'match' || m.optional || m.patterns.length !== 1 || ret?.kind !== 'return') {
    return null;
  }

  const column = countStarColumn(ret.projection);

  if (column === null || (ret.projection.orderBy ?? []).length > 0) {
    return null;
  }

  const [pattern] = m.patterns;

  if (!degreeCountShape(pattern)) {
    return null;
  }

  const [seg] = pattern.segments;
  const { rel, node } = seg;
  const { min, max } = rel.quantifier!;
  const inward = rel.direction === 'in';

  // Refusing here keeps a shallow or unbounded mirror on the route it has always taken, rather
  // than letting a relaxed bound meet arithmetic that was not relaxed with it — the mistake items
  // 692 and 699 both made one depth down.
  if (!mirrorAdmissible(inward, max)) {
    return null;
  }

  // DEPTH (item 588). `max > 2` was refused outright; a WALK now takes the level recurrence, so
  // only a TRAIL is still bounded at two. The bound is the trail CORRECTION: at two hops there is
  // exactly one way to reuse an edge and the closed form subtracts it, while at three there are
  // several interacting ways and no single term. Native drew the line in the same place at item
  // 587, which is what keeps the two engines on one answer.
  if (max === null || max < 1 || (max > 4 && pattern.mode !== 'walk')) {
    return null;
  }

  const types = relTypeNames(rel.label);

  if (types === null) {
    return null;
  }

  const endLabel = node.label;

  if (endLabel !== undefined && endLabel.kind !== 'label') {
    return null;
  }

  // THE ENDPOINT PREDICATE, from EITHER spelling, and the two must be one route (item 583).
  //
  // `(y WHERE y.age > 50)` and `(y) WHERE y.age > 50` are the same question. Carrying only the
  // inline one would have CREATED a cliff — 270.82ms against 334.13 before this, and the inline
  // side alone would have gone to ~45. Items 303/304 are the precedent and the warning: an
  // inline `{k: 1}` reached `inlineOf` through the pattern node while the identical clause
  // `WHERE` cost 4708.2ms against 33.9, "139x, item 125's bug class at the far end of the
  // family". `chainGatesOf` + `gateWith` is the composition they built for exactly this, so both
  // spellings reach the same `InlinePred` here.
  //
  // The predicate is applied per REACHED endpoint, not per node in the store — which is why this
  // needs no fault fallback where native's `node_pass_mask` does (items 570, 572). The rung
  // evaluates it on exactly the set the walk would.
  const gates =
    m.where === undefined ? undefined : chainGatesOf(m.where, pattern.start, pattern.segments);

  if (gates === null) {
    return null;
  }

  // A gate on the START is a filter on the SEED, which this rung does not carry — declining
  // keeps both of ITS spellings on the walk together rather than making a new cliff. Its INLINE
  // spelling needs no test here: `degreeCountShape` already requires `plainNode(pattern.start)`,
  // so a start carrying properties or an inline `WHERE` never reaches this function. A duplicate
  // guard here SURVIVED mutation for exactly that reason, which is what dead code looks like.
  if (
    pattern.start.variable !== undefined &&
    (gates?.get(pattern.start.variable)?.length ?? 0) > 0
  ) {
    return null;
  }

  const endPred = gateWith(
    node,
    node.variable === undefined ? undefined : gates?.get(node.variable),
  );

  if (endPred === null) {
    return null;
  }

  if (!depth4Admissible(max, pattern.mode, endPred)) {
    return null;
  }

  const startLabel = pattern.start.label;

  if (startLabel !== undefined && startLabel.kind !== 'label') {
    return null;
  }

  const isTrail = pattern.mode !== 'walk';

  // TWO closures, not one with a branch inside it. The predicate-free case — which is everything
  // item 573 already carried — keeps the closure it had, capturing exactly what it captured, and
  // the new one is reached only by a query that has a predicate. The reason is prophylactic, and
  // the honest version of the measurement is worth having here because the first reading looked
  // like more than it was. Written as ONE closure, the unfiltered control read 183.87 / 190.39 /
  // 182.44 against 210.01 / 184.26 / 219.62 over three alternated isolated rounds at 200,000
  // vertices: mins 1.01x apart, but the spread went 1.04x to 1.19x, which looked like
  // [[ts-closure-size-is-load-bearing]] — the slow mode this file has measured five times. Split,
  // the same harness read 178.84 / 190.05 / 171.92 against 193.15 / 181.37 / 190.49: mins 1.055x
  // apart with the PRISTINE side now the looser one. The two runs disagree about which side is
  // tighter, both gaps are under the ~10% noise floor, so the first reading was noise and the
  // split did not fix a measured regression. It is kept because an unfiltered query running
  // literally the code it ran before cannot produce an ambiguous reading like that again —
  // which is the cheap half of the lesson.
  if (endPred === undefined) {
    return (graph) => {
      // A VACUOUS endpoint label costs a per-edge test that cannot fail, which is the difference
      // between a degree product and a per-edge scan wearing one (item 566 / `effectiveLabel`).
      const eff =
        endLabel === undefined || vacuousLabel(graph, endLabel) ? undefined : endLabel.name;

      // DEPTH 4 DECLINES HERE, not in the detector (item 1399). Its terms are derived for a TRIVIAL
      // endpoint mask, so a label that really filters must not reach them — but a label every
      // vertex carries IS trivial, and refusing it on syntax cost **11-13x**: `{1,4}(b:P)` measured
      // 433.7 ms against 43.2 for the identical 400,000 answer, on a graph where every vertex is
      // `P`. `vacuousLabel` is a graph property, so this is the earliest point the question can be
      // asked; returning `undefined` sends the query to the general clause loop, which is where it
      // went before this item.
      if (max === 4 && isTrail && eff !== undefined) {
        return undefined;
      }

      return [
        {
          [column]: varLengthDegreeCount(graph, {
            types,
            min,
            max,
            isTrail,
            inward,
            startName: startLabel?.name,
            passes: eff === undefined ? alwaysTrue : (v: Vertex): boolean => v.labels.has(eff),
            passesIsVacuous: eff === undefined,
          }),
        },
      ];
    };
  }

  return (graph, params) => {
    const eff = endLabel === undefined || vacuousLabel(graph, endLabel) ? undefined : endLabel.name;
    // One binding map reused across endpoints — the idiom `buildNodeCount` already uses, since
    // `inlineHolds` overwrites the node's own variable per element.
    const binding = new Map<string, unknown>();
    const passes =
      eff === undefined
        ? (v: Vertex): boolean => inlineHolds(endPred, v, binding, params, graph)
        : (v: Vertex): boolean =>
            v.labels.has(eff) && inlineHolds(endPred, v, binding, params, graph);

    return [
      {
        [column]: varLengthDegreeCount(graph, {
          types,
          min,
          max,
          isTrail,
          inward,
          startName: startLabel?.name,
          passes,
          // A carried predicate is never vacuous — it is the whole reason this arm exists.
          passesIsVacuous: false,
        }),
      },
    ];
  };
};
