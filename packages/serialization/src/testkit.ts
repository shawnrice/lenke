import { Graph } from '@pl-graph/core';

import type { PropertyValue } from './value.js';

/**
 * Shared test kit for serialization codecs: a deterministic random LPG graph
 * generator and a structural-equality check. Every codec's round-trip test uses
 * these so the fidelity bar is identical across formats —
 * `graphContentEqual(decode(encode(g)), g)` must hold for many seeds.
 */

const makeRng = (seed: number): (() => number) => {
  let s = seed >>> 0;

  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randomValue = (rand: () => number): PropertyValue => {
  const k = rand();

  if (k < 0.3) {
    return Math.floor(rand() * 400) - 200; // integer-valued number
  }

  if (k < 0.45) {
    return Math.round((rand() * 400 - 200) * 100) / 100; // float
  }

  if (k < 0.62) {
    return rand() < 0.5 ? 'plain' : `s${Math.floor(rand() * 1000)}`;
  }

  if (k < 0.74) {
    return rand() < 0.5;
  }

  if (k < 0.84) {
    return null;
  }

  const len = Math.floor(rand() * 4);
  const arr: PropertyValue[] = [];

  for (let i = 0; i < len; i += 1) {
    if (rand() < 0.5) {
      arr.push(Math.floor(rand() * 20));
    } else {
      arr.push(rand() < 0.5 ? 'a' : 'b');
    }
  }

  return arr;
};

const LABELS = ['Person', 'Software', 'Account', 'Thing', 'Tag'];
const EDGE_LABELS = ['KNOWS', 'CREATED', 'OWNS', 'LINKS'];
const NODE_KEYS = ['a', 'b', 'name', 'weight', 'tags', 'active'];

/** A deterministic random LPG graph: heterogeneous labels/props, parallel edges. */
export const randomLpgGraph = (seed: number): Graph => {
  const rand = makeRng(seed);
  const g = new Graph();
  g.disableEvents();

  const nodeCount = 3 + Math.floor(rand() * 14);
  const nodes = [];

  for (let i = 0; i < nodeCount; i += 1) {
    const labels = LABELS.filter(() => rand() < 0.4);
    const properties: Record<string, PropertyValue> = {};

    for (const key of NODE_KEYS) {
      if (rand() < 0.55) {
        properties[key] = randomValue(rand);
      }
    }

    nodes.push(g.addVertex({ id: `n${i}`, labels, properties }));
  }

  const edgeCount = Math.floor(rand() * nodeCount * 2);

  for (let i = 0; i < edgeCount; i += 1) {
    const from = nodes[Math.floor(rand() * nodes.length)];
    const to = nodes[Math.floor(rand() * nodes.length)];
    const labels = [EDGE_LABELS[Math.floor(rand() * EDGE_LABELS.length)]];
    const properties: Record<string, PropertyValue> = {};

    if (rand() < 0.6) {
      properties.w = randomValue(rand);
    }

    g.addEdge({ id: `e${i}`, from, to, labels, properties });
  }

  g.enableEvents();

  return g;
};

const sameMap = (x: Map<string, string>, y: Map<string, string>): boolean =>
  x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);

const canon = (labels: Iterable<string>, props: Record<string, unknown>): string => {
  const labelPart = JSON.stringify([...labels].sort());
  const propPart = JSON.stringify(
    Object.keys(props)
      .sort()
      .map((k) => [k, props[k]]),
  );

  return `${labelPart}|${propPart}`;
};

/**
 * Structural equality of two graphs in the LPG model: same node ids with the
 * same labels (as sets) and properties, and same edges by id with the same
 * endpoints, labels, and properties. Order-independent.
 */
export const graphContentEqual = (a: Graph, b: Graph): boolean => {
  const nodeMap = (g: Graph): Map<string, string> =>
    new Map([...g.vertices].map((v) => [String(v.id), canon(v.labels, v.properties)]));
  const edgeMap = (g: Graph): Map<string, string> =>
    new Map(
      [...g.edges].map((e) => [
        String(e.id),
        `${e.from.id}->${e.to.id}|${canon(e.labels, e.properties)}`,
      ]),
    );

  return sameMap(nodeMap(a), nodeMap(b)) && sameMap(edgeMap(a), edgeMap(b));
};
