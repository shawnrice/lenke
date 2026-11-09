/**
 * THE NDJSON DECODE'S REAL PHASE SPLIT (item 1731).
 *
 * Item 1730's entry carried "parse is 78 ms of 3385 and the APPLY phase is 3306, 97.7%" onto the
 * NDJSON row. That measurement (item 1259) is the PG-TEXT path, where `tokenize` is a separate
 * phase producing a `string[]`. NDJSON has no tokenizer: `parseLine` does a full `JSON.parse` per
 * line. This measures the split for NDJSON with the real codec, nothing carried.
 *
 *   split    -- `input.split('\n')` alone
 *   parse    -- split + JSON.parse every line into the two arrays, i.e. `decode`'s first loop
 *   decode   -- the real exported `decode`
 *
 * MEASURED 200,000 nodes / 1,000,000 edges, min of 5 (item 1731):
 *
 *     split            50.9 ms     1.4%
 *     split+parse     944.9 ms    25.6%     <- the carried figure said 2.3%
 *     decode         3693.1 ms
 *     apply (resid)              74.4%     <- the carried figure said 97.7%
 *
 * So the NDJSON parse share is ELEVEN TIMES the figure that was being carried, and "the apply
 * phase is essentially all of it" is false for this format. The lesson is the one item 1730 had
 * already recorded about a per-operation constant and did not apply to a phase SPLIT: a phase
 * attribution is a measurement of the FORMAT it was taken on. pg-text and csv tokenize into a
 * `string[]`; ndjson, pg-json and graphson each run a structural parser per record, and nobody
 * has split those two.
 *
 * Run from packages/native so `@lenke/*` resolve to their dists.
 */
import { Graph } from '@lenke/core';
import { ndjsonCodec } from '@lenke/serialization';

const NODES = Number(process.env.NODES ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 5);

const lines = [];

for (let i = 0; i < NODES; i += 1) {
  lines.push(
    `{"type":"node","id":"v${i}","labels":["P","Q"],"properties":{"n":${i},"s":"name-${i}","b":true}}`,
  );
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const from = e % NODES;
  const rep = Math.floor(e / NODES);

  lines.push(
    `{"type":"edge","id":"e${e}","from":"v${from}","to":"v${(from * 7919 + rep * 104_729 + rep * rep) % NODES}","labels":["E"],"properties":{"w":${e % 97}}}`,
  );
}

const input = lines.join('\n');

const timeMin = (label, fn) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();
    const out = fn();

    series.push(performance.now() - t);

    if (out === undefined) {
      throw new Error(`${label} produced nothing`);
    }
  }

  return {
    label,
    min: Number(Math.min(...series).toFixed(1)),
    series: series.map((x) => Number(x.toFixed(1))),
  };
};

const rows = [];

rows.push(timeMin('split', () => input.split('\n').length));

rows.push(
  timeMin('split+parse', () => {
    const nodes = [];
    const edges = [];

    for (const line of input.split('\n')) {
      const r = line === '' ? null : JSON.parse(line);

      if (r?.type === 'node') {
        nodes.push(r);
      } else if (r?.type === 'edge') {
        edges.push(r);
      }
    }

    return nodes.length + edges.length;
  }),
);

rows.push(
  timeMin('decode', () => {
    const g = ndjsonCodec.decode(input, new Graph());

    return g.vertexCount + g.edgeCount;
  }),
);

for (const r of rows) {
  console.log(JSON.stringify(r));
}

const [split, parse, decode] = rows.map((r) => r.min);

console.log(
  JSON.stringify({
    lines: lines.length,
    splitShare: `${((split / decode) * 100).toFixed(1)}%`,
    parseShare: `${((parse / decode) * 100).toFixed(1)}%`,
    applyShare: `${(((decode - parse) / decode) * 100).toFixed(1)}%`,
  }),
);
