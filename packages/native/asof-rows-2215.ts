/**
 * ITEM 2215 — the AS-OF *rows* shape, floored. One arm per PROCESS (`ARM=` env), because item 2214
 * measured five shapes in sequence and the first paid JIT warm-up the rest inherited, manufacturing a
 * 2.6x that did not exist.
 *
 * THE FLOOR MUST BUILD THE SAME ROWS — two string properties per row. A floor that only counts would
 * charge the engine for materialization it is supposed to be doing (item 698's error, mirrored).
 */
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const PEOPLE = Number(process.env.PEOPLE ?? 40_000);
const COMPANIES = 2000;
const SPELLS = 4;
const T = 2010;

const g = new Graph();

for (let i = 0; i < PEOPLE; i += 1) {
  g.addVertex({ id: `p${i}`, labels: ['Person'], properties: { name: `person${i}` } });
}

for (let c = 0; c < COMPANIES; c += 1) {
  g.addVertex({ id: `c${c}`, labels: ['Company'], properties: { name: `co${c}` } });
}

let e = 0;

for (let s = 0; s < SPELLS; s += 1) {
  for (let i = 0; i < PEOPLE; i += 1) {
    const vf = 2000 + ((i * 7 + s * 13) % 25);

    g.addEdge({
      id: `w${e++}`,
      from: g.getVertexById(`p${i}`)!,
      to: g.getVertexById(`c${(i * 13 + s * 977) % COMPANIES}`)!,
      labels: ['WORKED_AT'],
      properties: { vf, vt: vf + 1 + ((i + s) % 6) },
    });
  }
}

const Q = `MATCH (p:Person)-[w:WORKED_AT]->(c:Company) WHERE w.vf <= ${T} AND w.vt > ${T} RETURN p.name AS p, c.name AS c`;

/** The floor: the same walk, the same interval test, and the SAME two-column rows built. */
const floor = (): { p: unknown; c: unknown }[] => {
  const out: { p: unknown; c: unknown }[] = [];

  for (const p of g.verticesByLabel.get('Person') ?? []) {
    for (const ed of g.edgesFromByLabel.get(p.id)?.get('WORKED_AT') ?? []) {
      if ((ed.properties.vf as number) <= T && (ed.properties.vt as number) > T) {
        out.push({ p: p.properties.name, c: ed.to.properties.name });
      }
    }
  }

  return out;
};

/*
 * --- THE REACHABILITY LADDER (item 2216) ------------------------------------------------------
 *
 * **A MEASURED GAP IS NOT A REACHABLE ONE.** Item 2215 measured 2.6x and named
 * `relBoundFilteredHopWalk`, but TWO refutations sit in that neighbourhood: the per-row binding `Map`
 * was built and REFUSED TWICE (items 2023/2024), and `propOf`'s residual is a hidden-class problem
 * needing codegen, which `no-runtime-codegen` forbids (item 2201).
 *
 * So each rung ADDS ONE PIECE of the engine's machinery to the bare floor. A rung that closes most of
 * the gap names the cause — and if that cause is already closed, the gap is NOT a target.
 */

/** Rung 1: the floor plus a per-edge binding `Map` write — the thing items 2023/2024 refused to remove. */
const floorWithBinding = (): { p: unknown; c: unknown }[] => {
  const out: { p: unknown; c: unknown }[] = [];
  const binding = new Map<string, unknown>();

  for (const p of g.verticesByLabel.get('Person') ?? []) {
    for (const ed of g.edgesFromByLabel.get(p.id)?.get('WORKED_AT') ?? []) {
      binding.set('p', p);
      binding.set('w', ed);
      binding.set('c', ed.to);

      if ((ed.properties.vf as number) <= T && (ed.properties.vt as number) > T) {
        out.push({ p: p.properties.name, c: ed.to.properties.name });
      }
    }
  }

  return out;
};

/* HOISTED: `consistent-function-scoping` — these capture nothing, so recreating them per call would
 * be measuring the wrong thing anyway. */
const readP = (b: Map<string, unknown>): unknown =>
  (b.get('p') as { properties: Record<string, unknown> }).properties.name;
const readC = (b: Map<string, unknown>): unknown =>
  (b.get('c') as { properties: Record<string, unknown> }).properties.name;

/** Rung 2: rung 1 plus the test and the projection read through CLOSURES, as a compiled plan does. */
const floorWithClosures = (): { p: unknown; c: unknown }[] => {
  const out: { p: unknown; c: unknown }[] = [];
  const binding = new Map<string, unknown>();
  /* Compiled once, exactly as the planner would — the per-row cost is the CALL, not the compile. */
  const pred = (b: Map<string, unknown>): boolean => {
    const w = b.get('w') as { properties: Record<string, unknown> };

    return (w.properties.vf as number) <= T && (w.properties.vt as number) > T;
  };

  for (const p of g.verticesByLabel.get('Person') ?? []) {
    for (const ed of g.edgesFromByLabel.get(p.id)?.get('WORKED_AT') ?? []) {
      binding.set('p', p);
      binding.set('w', ed);
      binding.set('c', ed.to);

      if (pred(binding)) {
        out.push({ p: readP(binding), c: readC(binding) });
      }
    }
  }

  return out;
};

/** The same walk but counting only — isolates MATERIALIZATION from the walk+filter. */
const countOnly = (): number => {
  let n = 0;

  for (const p of g.verticesByLabel.get('Person') ?? []) {
    for (const ed of g.edgesFromByLabel.get(p.id)?.get('WORKED_AT') ?? []) {
      if ((ed.properties.vf as number) <= T && (ed.properties.vt as number) > T) {
        n += 1;
      }
    }
  }

  return n;
};

/*
 * **CONSUME CHEAPLY: `JSON.stringify` INSIDE THE TIMED LOOP DILUTES THE RATIO TOWARD 1.0** (item 2227).
 * A large cost identical in both arms is added to numerator and denominator alike — stringifying 80,000
 * rows per iteration halved a measured gap (1.35x against the true 2.35x). It is the mirror of item
 * 2200's dead-code trap: consuming NOTHING lets the JIT delete the work, consuming EXPENSIVELY swamps it.
 */
const consume = (v: unknown): number => (Array.isArray(v) ? v.length : Number(v) || 1);

const arm = process.env.ARM ?? 'engine';
const run = (): unknown => {
  if (arm === 'floor') {
    return floor();
  }

  if (arm === 'count') {
    return countOnly();
  }

  if (arm === 'bind') {
    return floorWithBinding();
  }

  if (arm === 'closure') {
    return floorWithClosures();
  }

  const r = tsQuery(g, Q) as unknown as { rows?: unknown[] };

  return r.rows ?? r;
};

let sink = 0;

for (let w = 0; w < 4; w += 1) {
  sink += consume(run());
}

const t0 = performance.now();
const I = Number(process.env.ITER ?? 25);

for (let i = 0; i < I; i += 1) {
  sink += consume(run());
}

const got = run() as unknown[];

console.log(
  `  ${arm.padEnd(7)} ${(((performance.now() - t0) * 1000) / I).toFixed(0).padStart(8)} us   rows=${Array.isArray(got) ? got.length : got}  (sink ${sink > 0 ? 'ok' : 'ZERO'})`,
);
