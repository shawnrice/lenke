import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.js';

// `toJSON` sorts an element's labels so it serializes byte-identically to the native engine,
// whose columnar store canonicalizes to sorted order. Both `toJSON`s said so in a comment and
// NOTHING TESTED IT: with the sort deleted outright, the entire suite still passed (item 398,
// mutants M2 and M3 — the second only disagrees with the real code for an element holding
// EXACTLY TWO labels, which is why both are here).
//
// Insertion order is deliberately reverse-alphabetical, so an unsorted result is the input
// order and is visibly wrong rather than accidentally right.
describe('toJSON emits labels in sorted order', () => {
  const graph = (): Graph => new Graph();

  test('a two-label vertex sorts them — the boundary the size guard chooses', () => {
    const g = graph();
    const v = g.addVertex({ id: 'v', labels: ['Zebra', 'Alpha'], properties: {} });

    expect((v.toJSON() as { labels: string[] }).labels).toEqual(['Alpha', 'Zebra']);
  });

  test('a three-label vertex sorts them', () => {
    const g = graph();
    const v = g.addVertex({ id: 'v', labels: ['Zebra', 'Mid', 'Alpha'], properties: {} });

    expect((v.toJSON() as { labels: string[] }).labels).toEqual(['Alpha', 'Mid', 'Zebra']);
  });

  test('a two-label edge sorts them', () => {
    const g = graph();
    const a = g.addVertex({ id: 'a', labels: ['V'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['V'], properties: {} });
    const e = g.addEdge({ id: 'e', from: a, to: b, labels: ['ZEE', 'AYE'], properties: {} });

    expect((e.toJSON() as { labels: string[] }).labels).toEqual(['AYE', 'ZEE']);
  });

  test('a three-label edge sorts them', () => {
    const g = graph();
    const a = g.addVertex({ id: 'a', labels: ['V'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['V'], properties: {} });
    const e = g.addEdge({ id: 'e', from: a, to: b, labels: ['ZEE', 'MID', 'AYE'], properties: {} });

    expect((e.toJSON() as { labels: string[] }).labels).toEqual(['AYE', 'MID', 'ZEE']);
  });

  test('one label and no labels are unchanged', () => {
    const g = graph();
    const v = g.addVertex({ id: 'v', labels: ['Only'], properties: {} });
    const w = g.addVertex({ id: 'w', labels: [], properties: {} });

    expect((v.toJSON() as { labels: string[] }).labels).toEqual(['Only']);
    expect((w.toJSON() as { labels: string[] }).labels).toEqual([]);
  });

  test('the endpoints are the edge’s own, not transposed', () => {
    // Item 397 swapped `from`/`to` to read these ids off the edge instead of resolving the
    // vertices; this pins the direction at the unit level, where the cross-engine
    // byte-identity tests pin it only end to end.
    const g = graph();
    const a = g.addVertex({ id: 'a', labels: ['V'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['V'], properties: {} });
    const e = g.addEdge({ id: 'e', from: a, to: b, labels: ['R'], properties: {} });
    const json = e.toJSON() as { from: string; to: string };

    expect(json.from).toBe('a');
    expect(json.to).toBe('b');
  });
});
