/**
 * DOES THE SIZE OF A CLOSURE'S CAPTURED ENVIRONMENT COST ANYTHING? (item 1639)
 *
 * ⚠️ WHY THIS EXISTS. Three consecutive items found a 1.2-2.0x gap between an engine walk and a hand
 * floor doing the same work, and per-frame ablation explained a minority each time:
 *
 * ```text
 *   item 1634  Gremlin depth-3 stacked walk     1.23x   ~60% across four causes; `pick` at 0%
 *   item 1636  GQL filtered hop (after 1.19x)   ~2.0x   a 41.5% arm realized ~19-30%
 *   item 1638  Gremlin two-hop + any filter     ~1.9x   the gate collapse is ~1.08x of it
 * ```
 *
 * The one candidate common to all three is the thing a hand floor structurally cannot reproduce: the
 * engine's walks are closures returned per compile that CAPTURE eight to ten locals
 * (graph, hops, runs, pick, drops, depth, leadGates, anyLead, t0, fwd0 in `stackedWalk`;
 * graph, params, binding, env, fl, seeded, proj, farPred, gate, startVar, cfar, typeName, out, farVar
 * in `filteredHopWalk`), where a floor captures two or three. `ts-closure-size-is-load-bearing`
 * records the effect as real — a walk inline in a returned closure gave UNRELATED queries a new 4x
 * slow mode — but nothing has ever measured the cost of the environment ITSELF.
 *
 * THE EXPERIMENT. Two byte-identical walks over the same graph, differing ONLY in how many locals
 * their enclosing closure captures:
 *
 *   lean   captures 3 (the graph, the type, the key) — the hand-floor shape
 *   fat    captures 14, the engine's count, referenced ONLY in a cold branch so V8 must keep them
 *          in the context object but the hot loop never touches them
 *   fatread  same 14, and the hot loop reads ONE of them per edge — the engine's actual pattern,
 *          which separates "a big context costs" from "reading through a big context costs"
 *
 * ⚠️ THE COLD REFERENCE IS LOAD-BEARING. A captured local that is never referenced anywhere is
 * dropped from the context entirely, so `fat` would silently BE `lean` and the arms would differ by
 * nothing — the null-result-that-looks-like-a-result this whole corpus keeps producing. Each extra
 * local is referenced in a branch guarded by a value the fixture never produces, and the probe
 * asserts the branch never fires.
 *
 * ONE ARM PER PROCESS (item 762), because items 1631/1634/1638 all measured cross-arm interference
 * in multi-arm processes, at up to 1.47x.
 *
 *     ARM=lean bun closure-env-probe.ts
 *     ARM=fat NODES=200000 FANOUT=5 REPS=12 bun closure-env-probe.ts
 */
import { Graph } from '@lenke/core';
import type { Edge, Vertex } from '@lenke/core';
import { V, gt, has, out, toArray, traversal, values } from '@lenke/gremlin';

import { assertBranching } from './src/fixture-branching.js';

const NODES = Number(process.env.NODES ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 12);
const DROP = Number(process.env.DROP ?? 3);
const ARM = process.env.ARM ?? 'lean';

const ARMS = ['lean', 'fat', 'fatread', 'engine1', 'floor1', 'engine2f', 'floor2f'];

if (!ARMS.includes(ARM)) {
  throw new Error(`unknown ARM ${ARM}; have ${ARMS.join(',')}`);
}

const endpoints = (k: number): readonly [number, number] => [
  (k * 7919) % NODES,
  ((k % NODES) * 104_729 + Math.floor(k / NODES) * 977) % NODES,
];

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `u${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
}

let edges = 0;

for (let k = 0; k < NODES * FANOUT; k += 1) {
  const [from, to] = endpoints(k);

  if (to === from) {
    continue;
  }

  g.addEdge({
    id: `e${k}`,
    from: g.getVertexById(`u${from}`) as Vertex,
    to: g.getVertexById(`u${to}`) as Vertex,
    labels: ['E'],
    properties: {},
  });
  edges += 1;
}

assertBranching('closure-env-probe', NODES, FANOUT, endpoints);

/** How many times a cold branch fired. MUST stay 0, or the arms are not doing the same work. */
let coldHits = 0;

/** THE LEAN SHAPE: three captured locals, which is what every hand floor in this corpus looks like. */
const lean = (): (() => number) => {
  const graph = g;
  const type = 'E';
  const key = 'k';

  return (): number => {
    let n = 0;

    for (const v of graph.vertices) {
      const bucket = v.adjFrom?.get(type);

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket as Iterable<Edge>) {
        const value = e.to.properties[key];

        if (value !== undefined) {
          n += 1;
        }
      }
    }

    return n;
  };
};

/**
 * THE FAT SHAPE: fourteen captured locals, the engine's count. Eleven are referenced ONLY in the cold
 * branch below, so the context object must hold them while the hot loop never reads them.
 */
const fat = (): (() => number) => {
  const graph = g;
  const type = 'E';
  const key = 'k';
  // The eleven extras, named after what `filteredHopWalk` and `stackedWalk` actually capture.
  const hops = [['E', true]] as const;
  const runs = [[], []] as const;
  const drops = true;
  const depth = 2;
  const leadGates: readonly ((x: Vertex) => boolean)[] = [];
  const anyLead = false;
  const fwd0 = true;
  const proj = { items: [key] };
  const farPred: unknown = undefined;
  const startVar = 'a';
  const cfar: unknown = undefined;

  return (): number => {
    let n = 0;

    for (const v of graph.vertices) {
      const bucket = v.adjFrom?.get(type);

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket as Iterable<Edge>) {
        const value = e.to.properties[key];

        if (value !== undefined) {
          n += 1;
        }
      }
    }

    // ⚠️ THE COLD REFERENCE. Never true on this fixture (asserted via `coldHits`), but it is what
    // keeps all eleven extras alive in the closure's context rather than optimized away.
    if (n < 0) {
      coldHits += 1;
      n +=
        hops.length +
        runs.length +
        (drops ? 1 : 0) +
        depth +
        leadGates.length +
        (anyLead ? 1 : 0) +
        (fwd0 ? 1 : 0) +
        proj.items.length +
        (farPred === undefined ? 0 : 1) +
        startVar.length +
        (cfar === undefined ? 0 : 1);
    }

    return n;
  };
};

/**
 * THE ENGINE'S ACTUAL PATTERN: the same fourteen-local context, and the hot loop READS one of the
 * extras per edge. Separates "a large context costs" from "reading through a large context costs" —
 * the engine does the latter (`hops[d]`, `runs[d + 1]`, `drops`, `pick` are all context reads inside
 * the loop).
 */
const fatread = (): (() => number) => {
  const graph = g;
  const type = 'E';
  const key = 'k';
  const hops = [['E', true]] as const;
  const runs = [[], []] as const;
  const drops = true;
  const depth = 2;
  const leadGates: readonly ((x: Vertex) => boolean)[] = [];
  const anyLead = false;
  const fwd0 = true;
  const proj = { items: [key] };
  const farPred: unknown = undefined;
  const startVar = 'a';
  const cfar: unknown = undefined;

  return (): number => {
    let n = 0;

    for (const v of graph.vertices) {
      const bucket = v.adjFrom?.get(type);

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket as Iterable<Edge>) {
        const value = e.to.properties[key];

        // ONE context read per edge, which is what the engine's walks do.
        if (value !== undefined && drops) {
          n += 1;
        }
      }
    }

    if (n < 0) {
      coldHits += 1;
      n +=
        hops.length +
        runs.length +
        depth +
        leadGates.length +
        (anyLead ? 1 : 0) +
        (fwd0 ? 1 : 0) +
        proj.items.length +
        (farPred === undefined ? 0 : 1) +
        startVar.length +
        (cfar === undefined ? 0 : 1);
    }

    return n;
  };
};

/**
 * ⚠️ ENGINE AGAINST FLOOR, IN ONE PROCESS, ONE MEASUREMENT AT A TIME (item 1640) — the experiment
 * item 1639 said to run before hunting a fifth lever.
 *
 * Items 1634, 1636 and 1638 each measured an engine walk 1.2-2.0x a hand floor and per-frame
 * ablation explained a minority every time (0 for 4, counting item 1639's refutation of the closure
 * environment). Item 1639 then found that TWO HAND-WRITTEN walks of the same shape, in two different
 * instruments, differ by **1.45x** — the same order as the gaps being attributed to the engine, and
 * the same order as the 1.47x run-to-run swing item 1638 measured inside one file.
 *
 * So the untested variable is the instrument. These two arms share this file's fixture builder, its
 * timing loop, its warm-up and its estimator; `ARM` selects one and the process does nothing else.
 * Whatever ratio they show is the engine's, with the harness held constant by construction.
 *
 * ⚠️ THE FLOOR MUST PUSH, NOT COUNT. `toArray` materialises an array, so a floor that increments a
 * counter is not doing the same work — and the `lean`/`fat`/`fatread` arms above DO count, which is
 * why they are not comparable with these two and why item 1639's note forbids cross-file comparison
 * in the first place.
 */
const engine1 = (): (() => number) => {
  const plan = traversal(V(), out('E'), values('k'));

  return (): number => toArray(plan, g).length;
};

const floor1 = (): (() => number) => {
  const graph = g;
  const type = 'E';
  const key = 'k';

  return (): number => {
    const acc: unknown[] = [];

    for (const v of graph.vertices) {
      const bucket = v.adjFrom?.get(type);

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket as Iterable<Edge>) {
        const value = e.to.properties[key];

        if (value !== undefined) {
          acc.push(value);
        }
      }
    }

    return acc.length;
  };
};

/**
 * ⚠️ THE TWO-HOP FILTERED PAIR, which is where item 1638 measured **1.97x** in a twelve-arm process
 * — the largest of the gaps this family keeps producing. Same query, same fixture, same harness, one
 * arm per process. If the ratio collapses here the gap was the instrument; if it holds, it is the
 * engine.
 */
const engine2f = (): (() => number) => {
  const plan = traversal(V(), out('E'), out('E'), has('k', gt(44)), values('k'));

  return (): number => toArray(plan, g).length;
};

const floor2f = (): (() => number) => {
  const graph = g;
  const type = 'E';

  return (): number => {
    const acc: unknown[] = [];

    for (const v of graph.vertices) {
      const b0 = v.adjFrom?.get(type);

      if (b0 === undefined) {
        continue;
      }

      for (const e0 of b0 as Iterable<Edge>) {
        const b1 = e0.to.adjFrom?.get(type);

        if (b1 === undefined) {
          continue;
        }

        for (const e1 of b1 as Iterable<Edge>) {
          const { k } = e1.to.properties;

          if (typeof k === 'number' && k > 44) {
            acc.push(k);
          }
        }
      }
    }

    return acc.length;
  };
};

const BUILD: Record<string, () => () => number> = {
  lean,
  fat,
  fatread,
  engine1,
  floor1,
  engine2f,
  floor2f,
};
const run = BUILD[ARM]();

let rows = 0;

for (let i = 0; i < 2; i += 1) {
  rows = run();
}

const series: number[] = [];

for (let i = 0; i < REPS; i += 1) {
  const t0 = performance.now();

  rows = run();
  series.push(performance.now() - t0);
}

if (coldHits !== 0) {
  throw new Error(`the cold branch FIRED ${coldHits} times — the arms are not doing the same work`);
}

const warm = series.slice(DROP).sort((a, b) => a - b);
const median = warm[Math.floor(warm.length / 2)];

console.log(
  JSON.stringify({
    arm: ARM,
    rows,
    edges,
    min: Number(Math.min(...series).toFixed(2)),
    median: Number(median.toFixed(2)),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
