/*
 * Item 2090 — is `startFilteredHopValues` near its floor, or is the 1.3x recoverable?
 *
 * ⚠️ TWO DIFFERENT RUNGS, NOT ONE ROUTE GETTING SLOWER. With a vacuous label `dropVacuousLabels`
 * deletes the `hasLabel` and the plan reaches `hopValuesShortcut` (unfiltered); with a real one it
 * survives and `startFilteredHopValues` takes it. Filtering the starts is genuine extra work, so the
 * question is not the ratio between the rungs but whether the filtered one is near ITS OWN floor.
 *
 * ⚠️ REAL ENGINE VERTICES, from the engine's own containers (item 2084: a floor over plain objects
 * priced a different machine and hid 25% of a query).
 */
import { Graph } from '@lenke/core';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 11);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: i % 6 === 2 ? ['T', 'U'] : ['T'],
    properties: { n: i % 97 },
  });
}

g.addVertex({ id: 'vOFF', labels: ['Q'], properties: { n: -1 } });

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

const arms = {
  /*
   * THE FLOOR: scan, test the label, walk the typed adjacency, read the property. Nothing the engine
   * does not also have to do — no traverser, no closure chain, no dedupe.
   */
  floor: () => {
    const out = [];

    for (const v of g.vertices) {
      if (!v.labels.has('T')) {
        continue;
      }

      const byType = v.adjFrom?.get('E');

      if (byType === undefined) {
        continue;
      }

      for (const edge of byType) {
        const value = edge.to.properties.n;

        if (value !== undefined) {
          out.push(value);
        }
      }
    }

    return out.length;
  },
  /*
   * ⚠️ THE SAME WALK WITHOUT THE LABEL TEST — what the UNFILTERED rung's floor looks like. The
   * difference between this and `floor` is the label test's true cost on this shape, which is what
   * separates "the filtered rung is slow" from "filtering costs that much".
   */
  nolabel: () => {
    const out = [];

    for (const v of g.vertices) {
      const byType = v.adjFrom?.get('E');

      if (byType === undefined) {
        continue;
      }

      for (const edge of byType) {
        const value = edge.to.properties.n;

        if (value !== undefined) {
          out.push(value);
        }
      }
    }

    return out.length;
  },
  /*
   * ⚠️ THE ENGINE'S OWN SHAPE: a `pick` CLOSURE with a VARIABLE key, and `forward ? edge.to :
   * edge.from` evaluated PER EDGE on a loop-invariant. `pick` was the top profile frame at 27-29%.
   */
  enginelike: () => {
    const key = 'n';
    const forward = true;
    const pick = (v) => v.properties[key];
    const out = [];

    for (const v of g.vertices) {
      if (!v.labels.has('T')) {
        continue;
      }

      const byType = v.adjFrom?.get('E');

      if (byType === undefined) {
        continue;
      }

      for (const edge of byType) {
        const value = pick(forward ? edge.to : edge.from);

        if (value !== undefined) {
          out.push(value);
        }
      }
    }

    return out.length;
  },
  // ⚠️ THE TERNARY HOISTED, closure kept — isolates the per-edge branch on a loop-invariant.
  hoisted: () => {
    const key = 'n';
    const pick = (v) => v.properties[key];
    const out = [];

    for (const v of g.vertices) {
      if (!v.labels.has('T')) {
        continue;
      }

      const byType = v.adjFrom?.get('E');

      if (byType === undefined) {
        continue;
      }

      for (const edge of byType) {
        const value = pick(edge.to);

        if (value !== undefined) {
          out.push(value);
        }
      }
    }

    return out.length;
  },
  // ⚠️ CLOSURE GONE, variable key kept — isolates the call from the keyed load.
  nocall: () => {
    const key = 'n';
    const out = [];

    for (const v of g.vertices) {
      if (!v.labels.has('T')) {
        continue;
      }

      const byType = v.adjFrom?.get('E');

      if (byType === undefined) {
        continue;
      }

      for (const edge of byType) {
        const value = edge.to.properties[key];

        if (value !== undefined) {
          out.push(value);
        }
      }
    }

    return out.length;
  },
  // ⚠️ `soleLabel` instead of `labels.has` — item 2085's field read, to see if the test is the term.
  solelabel: () => {
    const out = [];

    for (const v of g.vertices) {
      if (v.soleLabel !== 'T' && !v.labels.has('T')) {
        continue;
      }

      const byType = v.adjFrom?.get('E');

      if (byType === undefined) {
        continue;
      }

      for (const edge of byType) {
        const value = edge.to.properties.n;

        if (value !== undefined) {
          out.push(value);
        }
      }
    }

    return out.length;
  },
};

const arm = process.env.ARM;

if (!(arm in arms)) {
  throw new Error(`ARM must be one of ${Object.keys(arms).join(', ')} — got ${String(arm)}`);
}

arms[arm]();

const series = [];
let rows = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  rows = arms[arm]();
  series.push(performance.now() - t0);
}

const kept = series.slice(3).sort((a, b) => a - b);

console.log(
  `${arm.padEnd(10)} median=${kept[Math.floor(kept.length / 2)].toFixed(2)} ms  rows=${rows}`,
);
