/**
 * WHY `out('E','F')` COSTS 1.86x `out('E')` ON AN IDENTICAL EDGE SET — priced against hand floors,
 * OUTSIDE the engine file, because editing that file is what defeated the last attempt (item 1441).
 *
 * Item 1440 measured the gap and then failed to price it: an isolated two-arm A/B inside
 * `packages/gremlin/src/executor/hop-values.ts` reported 0.3-7.8% on every target while
 * `hopyieldsingle` — the `oneType` branch, which the change does not touch — moved **16.3% at 4/4
 * concordance**. Item 1413 hit the same effect in the same file in the opposite direction (controls
 * REGRESSING 3.5% and 5.8%). So that file carries a ~16% arbitrarily-signed perturbation term, and
 * no in-file A/B can resolve a sub-16% branch question. That is the blocker this probe removes.
 *
 * THE TRICK IS THAT THE QUESTION NEEDS NO EDIT. The 1.86x exists at HEAD. What is unknown is whether
 * it is INTRINSIC to walking two buckets instead of one, or engine overhead on top of that. Hand
 * floors answer that without touching the engine, so there is nothing to perturb:
 *
 *   engine-single    V().out('E').values('k')        the engine's `oneType` branch
 *   engine-multi     V().out('E','F').values('k')    the engine's `manyTypes` branch
 *   floor-single     hand walk, one bucket
 *   floor-multi      hand walk MIRRORING `manyTypes`: pushes `undefined` for absent types,
 *                    indexes `buckets[i]`, runs the earlier-buckets dedupe scan
 *   floor-multi-lean hand walk with item 1440's DECLINED change: only present non-empty buckets
 *                    pushed, and a tight no-dedupe loop when exactly one survives
 *
 * ⚠️ `floor-multi-lean` IS THE POINT. It prices the reverted change where no perturbation can reach
 * it. If it lands at `floor-single` while `floor-multi` stays high, item 1440's A/B was drowned and
 * the change was right — a correction worth having. If it lands at `floor-multi`, the change was
 * genuinely worthless and the 1.86x is elsewhere. Either way the answer is no longer confounded.
 *
 * At `MULTILABEL=0` no `F` edge exists, so every arm must produce the SAME multiset of values. The
 * digest is checked rather than the row count, because item 1430 recorded a 12x arm that agreed on
 * count and disagreed on content.
 *
 *   ARM=engine-multi NODES=100000 REPS=11 node gremlin-multitype-floor-probe.mjs
 *
 * ONE ARM PER PROCESS (item 762): arms that redistribute call sites flatter themselves in a shared
 * process, and the giveaway is exactly the control-moves-more pattern that killed item 1440.
 */
import { PerformanceObserver } from 'node:perf_hooks';

import { Graph } from '@lenke/core';
import { V, both, out, toArray, traversal, values } from '@lenke/gremlin';

import { profileWindow } from './windowed-profile.mjs';

const ARM = process.env.ARM ?? 'engine-single';
const NODES = Number(process.env.NODES ?? 100_000);
const REPS = Number(process.env.REPS ?? 11);
const DROP = Number(process.env.DROP ?? 3);
const STRIDE = process.env.STRIDE ?? 'small';
/** 0 = no `F` edge at all, so the spellings are equivalent. 3 = every third edge carries both. */
const MULTILABEL = Number(process.env.MULTILABEL ?? 0);
const FANOUT = Number(process.env.FANOUT ?? 1);

if (STRIDE !== 'small' && STRIDE !== 'random') {
  throw new Error(`STRIDE must be 'small' or 'random', got ${STRIDE}`);
}

const ARMS = [
  'engine-single',
  'engine-multi',
  'floor-single',
  'floor-multi',
  'floor-multi-lean',
  'floor-multi-pair',
  'engine-both',
  'floor-both',
  'floor-both-pick',
];

/**
 * ⚠️ THE `both` ARMS ANSWER A DIFFERENT MULTISET — twice as many rows — so the digest invariant is
 * PER GROUP, not global. An analysis that pooled them would report a false disagreement, or worse,
 * accept an arm that silently changed group.
 */
const GROUP = ARM.includes('both') ? 'both' : 'out';

if (!ARMS.includes(ARM)) {
  throw new Error(`unknown ARM ${ARM}; have ${ARMS.join(',')}`);
}

const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < NODES; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } }));
  }

  for (let k = 0; k < NODES * FANOUT; k += 1) {
    const i = k % NODES;
    const hop = Math.floor(k / NODES);

    g.addEdge({
      id: `e${k}`,
      from: vs[STRIDE === 'random' ? (k * 7919) % NODES : i],
      to: vs[
        STRIDE === 'random'
          ? ((k % NODES) * 104_729 + hop * 977) % NODES
          : (i * 7 + 3 + hop * 2_654_435_761) % NODES
      ],
      labels: MULTILABEL > 0 && k % MULTILABEL === 0 ? ['E', 'F'] : ['E'],
      properties: { w: k % 13 },
    });
  }

  return g;
};

const g = build();

/** One bucket, the shape `oneType` takes. */
const floorSingle = () => {
  const acc = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      const value = edge.to.properties['k'];

      if (value !== undefined) {
        acc.push(value);
      }
    }
  }

  return acc;
};

const TYPES = ['E', 'F'];

/** MIRRORS `manyTypes`: `undefined` pushed for absent types, `buckets[i]`, dedupe scan. */
const floorMulti = () => {
  const acc = [];
  const buckets = [];

  for (const v of g.vertices) {
    const byLabel = v.adjFrom;

    if (byLabel === undefined) {
      continue;
    }

    buckets.length = 0;

    for (const t of TYPES) {
      buckets.push(byLabel.get(t));
    }

    for (let i = 0; i < buckets.length; i += 1) {
      const bucket = buckets[i];

      if (bucket === undefined) {
        continue;
      }

      for (const edge of bucket) {
        let earlier = false;

        for (let j = 0; j < i; j += 1) {
          if (buckets[j]?.has(edge) === true) {
            earlier = true;

            break;
          }
        }

        if (earlier) {
          continue;
        }

        const value = edge.to.properties['k'];

        if (value !== undefined) {
          acc.push(value);
        }
      }
    }
  }

  return acc;
};

/** Item 1440's DECLINED change, priced here instead of inside the perturbing file. */
const floorMultiLean = () => {
  const acc = [];
  const buckets = [];

  for (const v of g.vertices) {
    const byLabel = v.adjFrom;

    if (byLabel === undefined) {
      continue;
    }

    buckets.length = 0;

    for (const t of TYPES) {
      const bucket = byLabel.get(t);

      if (bucket !== undefined && bucket.size > 0) {
        buckets.push(bucket);
      }
    }

    if (buckets.length === 1) {
      for (const edge of buckets[0]) {
        const value = edge.to.properties['k'];

        if (value !== undefined) {
          acc.push(value);
        }
      }

      continue;
    }

    for (let i = 0; i < buckets.length; i += 1) {
      const bucket = buckets[i];

      for (const edge of bucket) {
        let earlier = false;

        for (let j = 0; j < i; j += 1) {
          if (buckets[j].has(edge)) {
            earlier = true;

            break;
          }
        }

        if (earlier) {
          continue;
        }

        const value = edge.to.properties['k'];

        if (value !== undefined) {
          acc.push(value);
        }
      }
    }
  }

  return acc;
};

/**
 * NO PER-VERTEX ARRAY AT ALL: exactly two types, both `get`s hoisted into locals.
 *
 * `floor-multi-lean` measured IDENTICAL to `floor-multi` (11.81 both), which refuted the
 * absent-bucket skip — but both still build a `buckets` array per vertex and iterate `TYPES` with a
 * `for...of`. This arm removes the array and the iterator while answering the same multiset, so it
 * separates "two buckets is intrinsically dearer" from "the per-vertex array scaffolding is the
 * cost". Two types is the overwhelmingly common multi-type spelling, so a specialization here would
 * be reachable in the engine if it pays.
 */
const floorMultiPair = () => {
  const acc = [];

  for (const v of g.vertices) {
    const byLabel = v.adjFrom;

    if (byLabel === undefined) {
      continue;
    }

    const b0 = byLabel.get('E');
    const b1 = byLabel.get('F');

    if (b1 === undefined) {
      if (b0 === undefined) {
        continue;
      }

      for (const edge of b0) {
        const value = edge.to.properties['k'];

        if (value !== undefined) {
          acc.push(value);
        }
      }

      continue;
    }

    if (b0 !== undefined) {
      for (const edge of b0) {
        const value = edge.to.properties['k'];

        if (value !== undefined) {
          acc.push(value);
        }
      }
    }

    for (const edge of b1) {
      // The earlier-buckets rule with two buckets is one membership test against `b0`.
      if (b0?.has(edge) === true) {
        continue;
      }

      const value = edge.to.properties['k'];

      if (value !== undefined) {
        acc.push(value);
      }
    }
  }

  return acc;
};

/**
 * `both('E')` BY HAND with the property read INLINE — no `pick` closure (item 1443).
 *
 * `hopbothyield` is 190.4 ns/row against `out('E')`'s 56.9, **3.35x per row**, even though item 1432
 * already gave it a hand walk. Per-row decomposition of its profile put `drain` itself at 98 ns/row
 * against the single-type drain's 17.6 — 5.6x — with `get from` at 10.77% while `get to` was 0.26%,
 * though both buckets are walked. The structural difference from `oneType` is that `pick` is called
 * from TWO sites here (`edge.to` and `edge.from`) instead of one.
 *
 * So: this arm inlines the read, `floor-both-pick` keeps the closure, and the pair of them separates
 * "two call sites defeat the closure" from "two passes are intrinsically dearer".
 */
const floorBoth = () => {
  const acc = [];

  for (const v of g.vertices) {
    const outBucket = v.adjFrom?.get('E');

    if (outBucket !== undefined) {
      for (const edge of outBucket) {
        const value = edge.to.properties['k'];

        if (value !== undefined) {
          acc.push(value);
        }
      }
    }

    const inBucket = v.adjTo?.get('E');

    if (inBucket !== undefined) {
      for (const edge of inBucket) {
        const value = edge.from.properties['k'];

        if (value !== undefined) {
          acc.push(value);
        }
      }
    }
  }

  return acc;
};

/** The same walk THROUGH a `pick`-shaped closure, called from both sites, as the engine does. */
const pickFar = (far) => far.properties['k'];

const floorBothPick = () => {
  const acc = [];

  for (const v of g.vertices) {
    const outBucket = v.adjFrom?.get('E');

    if (outBucket !== undefined) {
      for (const edge of outBucket) {
        const value = pickFar(edge.to);

        if (value !== undefined) {
          acc.push(value);
        }
      }
    }

    const inBucket = v.adjTo?.get('E');

    if (inBucket !== undefined) {
      for (const edge of inBucket) {
        const value = pickFar(edge.from);

        if (value !== undefined) {
          acc.push(value);
        }
      }
    }
  }

  return acc;
};

const single = traversal(V(), out('E'), values('k'));
const bothT = traversal(V(), both('E'), values('k'));
const multi = traversal(V(), out('E', 'F'), values('k'));

const RUN = {
  'engine-single': () => toArray(single, g),
  'engine-multi': () => toArray(multi, g),
  'floor-single': floorSingle,
  'floor-multi': floorMulti,
  'floor-multi-lean': floorMultiLean,
  'floor-multi-pair': floorMultiPair,
  'engine-both': () => toArray(bothT, g),
  'floor-both': floorBoth,
  'floor-both-pick': floorBothPick,
};

const run = RUN[ARM];

let gcMs = 0;
let gcCount = 0;
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gcMs += e.duration;
    gcCount += 1;
  }
});

obs.observe({ entryTypes: ['gc'] });

const series = [];
let rowCount = 0;
/** Order-independent, so an arm may legally emit in a different order and still be checked. */
let digest = 0;
let sink = 0;

const measure = () => {
  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = run();
    const dt = performance.now() - t0;

    series.push(dt);
    sink += rows.length;
    rowCount = rows.length;

    let d = 0;

    for (const x of rows) {
      d += Number(x);
    }

    digest = d;
  }

  return sink;
};

await profileWindow(process.env.PROF_OUT, measure);

obs.disconnect();

const kept = series.slice(DROP).sort((a, b) => a - b);
const at = (f) => kept[Math.min(kept.length - 1, Math.floor(f * kept.length))];

console.log(
  JSON.stringify({
    arm: ARM,
    group: GROUP,
    nodes: NODES,
    fanout: FANOUT,
    stride: STRIDE,
    multilabel: MULTILABEL,
    reps: REPS,
    rowCount,
    digest,
    median: Number(at(0.5).toFixed(3)),
    p25: Number(at(0.25).toFixed(3)),
    p75: Number(at(0.75).toFixed(3)),
    min: Number(kept[0].toFixed(3)),
    max: Number(kept[kept.length - 1].toFixed(3)),
    gcMs: Number(gcMs.toFixed(1)),
    gcCount,
    series: series.map((x) => Number(x.toFixed(2))),
  }),
);
