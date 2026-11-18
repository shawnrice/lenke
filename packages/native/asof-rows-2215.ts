/**
 * ITEM 2215 — the AS-OF *rows* shape, floored. One arm per PROCESS (`ARM=` env), because item 2214
 * measured five shapes in sequence and the first paid JIT warm-up the rest inherited, manufacturing a
 * 2.6x that did not exist.
 *
 * ⚠️ THE FLOOR MUST BUILD THE SAME ROWS — two string properties per row. A floor that only counts would
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

const arm = process.env.ARM ?? 'engine';
const run = (): unknown => {
  if (arm === 'floor') {
    return floor();
  }

  if (arm === 'count') {
    return countOnly();
  }

  const r = tsQuery(g, Q) as unknown as { rows?: unknown[] };

  return r.rows ?? r;
};

let sink = 0;

for (let w = 0; w < 4; w += 1) {
  sink += JSON.stringify(run()).length;
}

const t0 = performance.now();
const I = Number(process.env.ITER ?? 25);

for (let i = 0; i < I; i += 1) {
  sink += JSON.stringify(run()).length;
}

const got = run() as unknown[];

console.log(
  `  ${arm.padEnd(7)} ${(((performance.now() - t0) * 1000) / I).toFixed(0).padStart(8)} us   rows=${Array.isArray(got) ? got.length : got}  (sink ${sink > 0 ? 'ok' : 'ZERO'})`,
);
