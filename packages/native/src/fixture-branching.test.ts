import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { assertBranching } from './fixture-branching.js';

/**
 * ⚠️ NO GENERATOR IN THIS CORPUS MAY USE A TARGET THAT IS INVARIANT UNDER `k -> k + N` (item 1633).
 *
 * `to = (a * k + b) % N` is invariant under `k -> k + N`, and every generator here loops
 * `for (k = 0; k < N * FANOUT; k++)`, so one vertex's FANOUT edges are exactly `k0, k0+N, k0+2N, …`
 * — and all of them land on the SAME target. The graph is FUNCTIONAL: full out-degree, ONE distinct
 * out-neighbour, and every degree statistic perfect.
 *
 * This has now happened TWELVE times in this corpus. Items 1516/1518 found it in the GQL bench's
 * fixture and six probes; item 1632 found it in `bench:gremlin`'s main fixture — the primary Gremlin
 * instrument — where it was making multi-hop yielding rows **2.4-6.2x** too fast, because five
 * parallel edges to one vertex are five reads of one cache line; and item 1633 found the remaining
 * nine. CLAUDE.md's standing rule is to count the DISTINCT endpoints before trusting a number off a
 * fixture.
 *
 * ⚠️ A COMMENT DID NOT STOP IT. `hop-rows-floor-probe.mjs` has carried a nine-line warning about
 * exactly this since item 1518 and nine other files kept the defect anyway, so this is a TEST.
 *
 * It forbids the corpus's own degenerate spellings by text rather than inspecting behaviour, which is
 * a deliberate trade: it cannot catch a NEW multiplier, but it runs with no fixture build and it
 * catches the copy-paste that produced every instance so far. `assertBranching` is the behavioural
 * check, for a probe to call on its own numbers.
 *
 * ⚠️ `readFileSync`, NOT `grep` — CLAUDE.md records that grep silently skips files it decides are
 * binary, and this corpus has files with non-ASCII characters in their comments.
 */
const ROOT = join(import.meta.dir, '..');

/** The exact spellings that produced a functional graph, in the variable names this corpus uses. */
const DEGENERATE = [
  '(k * 104_729) % N',
  '(k * 104729) % N',
  '(e * 104_729) % NODES',
  '(e * 104729) % NODES',
  '(k * 104_729) % NODES',
  '(n * 104_729) % N',
];

/**
 * ⚠️ WHERE THE FORM IS HARMLESS, WITH THE REASON. The invariance only bites when a vertex's edges
 * are strided by N, which needs (a) more than one edge per vertex and (b) a FLAT loop over
 * `k < N * fanout`. Three shapes break one of those, and each is listed with why rather than
 * silently excluded — an allowlist without reasons becomes a place to hide the next instance.
 */
const ALLOWED = new Map<string, string>([
  // ONE edge per vertex. Degree 1 cannot branch, so there is nothing for the stride to collapse.
  [
    'bench.ts|`{"type":"edge","id":"e{k}","labels":["KNOWS"],"from":"v{(k * 7919) % N}","to":"v{(k * 104_729) % N}","properties":{}}`,',
    'hopSparseDoc is the deliberate ONE-edge-per-node twin (item 1345 degree gate)',
  ],
  [
    'direction-spelling-probe.ts|`{"type":"edge","id":"e{k}","labels":["KNOWS"],"from":"v{(k * 7919) % N}","to":"v{(k * 104_729) % N}","properties":{}}`,',
    'one edge per vertex',
  ],
  [
    'present-spelling-probe.ts|`{"type":"edge","id":"e{k}","labels":["KNOWS"],"from":"v{(k * 7919) % N}","to":"v{(k * 104_729) % N}","properties":{}}`,',
    'one edge per vertex',
  ],
  [
    'literal-param-gate-probe.mjs|to: g.getVertexById(ids[(e * 104_729) % NODES]),',
    'one edge per vertex',
  ],
  // Fanout defaults to 1; raising the knob makes the opt-in arm the caller's business.
  [
    "cross-engine-chain3-probe.mjs|to: STRIDE === 'small' ? vs[(i * 7 + 3) % N] : vs[(k * 104_729) % N],",
    'FANOUT defaults to 1',
  ],

  // A NESTED loop: the inner `d < DEG` gives one vertex's edges CONSECUTIVE k, not k0, k0+N, …, so
  // `k -> k + N` never relates two edges of the same vertex and the invariance cannot apply.
  [
    'label-arity-probe.ts|`{"type":"edge","id":"e{k}","labels":["{ty}"],"from":"v{i}","to":"v{(k * 104_729) % N}","properties":{}}`,',
    "nested per-vertex loop — a vertex's edges have consecutive k",
  ],
]);

const sources = (): [string, string][] => {
  const out: [string, string][] = [];

  for (const dir of [ROOT, join(ROOT, 'src')]) {
    for (const name of readdirSync(dir)) {
      if (!/\.(ts|mjs)$/.test(name) || name.endsWith('.test.ts')) {
        continue;
      }

      out.push([name, readFileSync(join(dir, name), 'utf8')]);
    }
  }

  return out;
};

describe('no fixture generator is invariant under k -> k + N', () => {
  test('the corpus carries none of the degenerate spellings', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();

    for (const [name, body] of sources()) {
      const lines = body.split('\n');

      for (const [i, line] of lines.entries()) {
        const trimmed = line.trim();
        // ⚠️ A DOC COMMENT MAY QUOTE THE BAD FORM to explain why it is bad — item 1632's own fix
        // does, and so does this file. So a hit only counts outside a comment line.
        const isComment =
          trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');

        if (isComment || !DEGENERATE.some((bad) => line.includes(bad))) {
          continue;
        }

        // Keyed on the LINE TEXT, not its number: an edit above shifts every number (it did, the
        // first time this ran), while the text changes exactly when the code does — which is when
        // the entry should be re-reviewed rather than silently carried.
        const at = `${name}|${trimmed.replaceAll('$', '')}`;

        seen.add(at);

        if (!ALLOWED.has(at)) {
          offenders.push(`${name}:${i + 1}  ${trimmed.slice(0, 90)}`);
        }
      }
    }

    expect(offenders).toEqual([]);

    // ⚠️ AND EVERY ALLOWLIST ENTRY MUST STILL MATCH SOMETHING. An entry whose line moved or whose
    // code was fixed would otherwise sit there excusing a line number that now means something
    // else — which is how an allowlist turns into the hiding place this one is meant not to be.
    expect([...ALLOWED.keys()].filter((at) => !seen.has(at))).toEqual([]);
  });

  test('the screen reads a real corpus, so an empty result means something', () => {
    // Guards the glob: if `sources()` ever returns nothing the test above passes vacuously, which is
    // precisely the failure mode this whole item is about.
    const names = sources().map(([n]) => n);

    expect(names.length).toBeGreaterThan(20);
    expect(names).toContain('bench-gremlin.ts');
    expect(names).toContain('bench.ts');
  });
});

describe('assertBranching', () => {
  const FROM = (n: number) => (k: number) => (k * 7919) % n;

  test("accepts the corpus's fixed form", () => {
    const n = 2000;

    expect(() =>
      assertBranching('fixed', n, 5, (k) => [
        FROM(n)(k),
        ((k % n) * 104_729 + Math.floor(k / n) * 977) % n,
      ]),
    ).not.toThrow();
  });

  test('⚠️ REJECTS the degenerate form — proving the guard has teeth', () => {
    const n = 2000;

    expect(() =>
      assertBranching('degenerate', n, 5, (k) => [FROM(n)(k), (k * 104_729) % n]),
    ).toThrow(/DEGENERATE/);
  });

  test('a fanout of 1 is accepted, because degree 1 cannot branch', () => {
    const n = 2000;

    expect(() =>
      assertBranching('fanout-1', n, 1, (k) => [FROM(n)(k), (k * 104_729) % n]),
    ).not.toThrow();
  });
});
