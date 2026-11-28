import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { addV, property } from '../index.js';
import { traversal } from '../traversal.js';
import { run } from './index.js';

/*
 * Item 2515: `addV('')` must REJECT an empty label, and `addV()` must still mean "no labels".
 *
 * `addVStep` built its labels with `label ? [label] : []`. An empty string is FALSY, so `addV('')`
 * took the `[]` branch: the empty label was silently dropped, `Graph.addVertex` never saw one to
 * refuse, and an unlabelled vertex entered the model. The fix is `label === undefined ? [] : [label]`
 * — the distinction is "no label ARGUMENT" against "an EMPTY label", which truthiness conflates.
 *
 * ## WHY THIS WAS A DEFECT AND NOT A CHOICE
 *
 * Four references agreed on rejecting, and nothing pinned the old behaviour (no `addV('')` literal
 * existed anywhere in the repo):
 *
 *   - **TinkerPop 3.7.3** raises `IllegalArgumentException("Label can not be empty")` for `addV('')`
 *     and creates NO vertex — verified in the console, the vertex count stayed at 6.
 *   - **lenke's own Rust engine** raises "a vertex label must not be empty" for the same text.
 *   - **lenke's own TS core API** raises via `validateLabel` for `addVertex({ labels: [''] })`.
 *   - **lenke's own `property('')`** on this very surface raises the key equivalent.
 *
 * `GAPS.md` declares the rule and, read closely, named the gap itself: "enforced identically in the
 * Rust core (… at codec ingestion + `addV`/`addE`/`property`) and the TS core (… at
 * `addVertex`/`addEdge`/`addLabelTo*`/`setProperty`)" — `addV` appears in the Rust list and NOT the
 * TS one.
 *
 * `addE` was already correct: it passes `[step.label]` unconditionally, so an empty edge label always
 * reached the validator. Only `addV` had the falsy branch.
 */
describe('addV label validation (item 2515)', () => {
  test('addV("") REJECTS the empty label and creates no vertex', () => {
    const g = new Graph();

    expect(() => [...run(traversal(addV('')), g)]).toThrow('must be non-empty');
    expect(g.vertexCount).toBe(0);
  });

  /*
   * THE REGRESSION THIS FIX COULD HAVE CAUSED, and the reason the condition is `=== undefined`
   * rather than a truthiness test. `addV()` passes no label at all and must still produce an
   * UNLABELLED vertex — not an error, and not a vertex labelled `''`.
   *
   * (TinkerPop's `addV()` defaults to the label `vertex`; lenke's produces no labels. That is a
   * separate, pre-existing surface difference and this item does not touch it.)
   */
  test('addV() with NO argument still means "no labels"', () => {
    const g = new Graph();
    const rows = [...run(traversal(addV()), g)];

    expect(rows).toHaveLength(1);
    expect(g.vertexCount).toBe(1);
    expect([...[...g.vertices][0].labels]).toEqual([]);
  });

  test('addV("Q") is unaffected — the control', () => {
    const g = new Graph();
    const rows = [...run(traversal(addV('Q')), g)];

    expect(rows).toHaveLength(1);
    expect([...[...g.vertices][0].labels]).toEqual(['Q']);
  });

  test('a label containing :: is rejected too — the other half of validateLabel', () => {
    // GraphSON joins a node's labels with `::`, so such a label cannot round-trip. NOTE: TinkerPop
    // ACCEPTS `addV('a::b')` (verified: label reads back as `a::b`) — this is a deliberate lenke
    // extension documented in `GAPS.md`, not a conformance defect.
    const g = new Graph();

    expect(() => [...run(traversal(addV('a::b')), g)]).toThrow("cannot contain '::'");
    expect(g.vertexCount).toBe(0);
  });

  test('property("") still rejects — it always did, and is the sibling contract', () => {
    const g = new Graph();
    const v = traversal(addV('P'), property('', 1));

    expect(() => [...run(v, g)]).toThrow('property key must be non-empty');
  });
});
