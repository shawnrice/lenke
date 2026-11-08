/**
 * The GQL executor's public surface — a BARREL, and deliberately nothing else.
 *
 * ⚠️ WHY A BARREL RATHER THAN THE CODE ITSELF. This file was 12,046 lines, the largest in the
 * package after `executor/shortcuts.ts`, and 84 of its symbols are imported as `./executor.js` by
 * dozens of test files. Splitting it while keeping those imports working needs exactly one thing: a
 * re-export point that is NOT one of the modules being split. If the barrel were instead one of
 * those modules, every later extraction would create a cycle with it — the new module importing the
 * helpers it needs from the barrel while the barrel imported the new module back.
 *
 * ⚠️ AND THE CYCLE IS NOT HYPOTHETICAL — IT IS ALREADY HERE, which is almost certainly why the
 * split stalled half-done. Nine modules under `executor/` import from `../executor.js`, and the
 * code behind this barrel imports those nine back:
 *
 *     executor.ts  ->  executor/core.ts  ->  executor/{scalars,shortcuts,matching,clauses,…}.ts
 *          ^                                                      |
 *          +------------------------------------------------------+
 *
 * So the module graph has a cycle through this file today. ESM tolerates it because every reference
 * sits inside a function body and resolves at call time rather than at module evaluation — but that
 * is luck, not design, and it is why `executor/core.ts` is still 12,000 lines: there was nowhere to
 * put the next piece.
 *
 * WHAT BREAKS IT, measured rather than guessed. The nine siblings need **37 values and 29 types**
 * back from `core.ts`, and that union is the shared layer this package never had:
 *
 *     compareSort, isEdge, isElement, isVertex, valueKey, propOf, mapToArray, relTypeNames,
 *     satisfies, freePredicateVars, projectRow, … plus every `C*` compiled-shape type
 *
 * The 29 types are free — a `import type` is erased and creates no runtime edge. The values become
 * a leaf module nothing imports upward from. After that the layering is strictly downward and each
 * remaining extraction is a move rather than a negotiation: the planner family alone is 23 symbols
 * that export exactly ONE name (`compileLinear`) and import 33 from below.
 *
 * No logic lives in this file.
 */
export * from './executor/core.js';
export * from './executor/compile.js';
