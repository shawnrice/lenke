// Item 1915 — does the sub-plan-existence fusion answer what the GENERIC path answers?
//
// 🔑 THE ORACLE HAS NO KILL SWITCH. `singleHopExistence` requires `plan.steps.length === 1`, so
// appending a step that cannot change the answer forces the DECLINE while leaving the question
// identical: `where(out(E), limit(1000))` is `where(out(E))` on any vertex of degree < 1000. Each
// pair below is (fused spelling, declining spelling) and they must agree exactly.
//
// ⚠️ THE FIXTURE IS BUILT FOR THE DISCRIMINATIONS, not for size. Every arm of the gate needs a
// vertex that separates it from every other arm:
//   - `a` has out-E only                 -> out E yes, in E no
//   - `b` has in-E only                  -> out E no,  in E yes
//   - `c` has out-F only                 -> out E no,  out F yes, untyped out yes
//   - `d` has a SELF-LOOP on E           -> out and in both yes off ONE edge
//   - `e` is ISOLATED                    -> every arm no
//   - `f` had its only E edge REMOVED    -> isolated BY A DIFFERENT ROUTE than `e`
//
// ⚠️ `f` IS NOT THE "PRESENT BUT EMPTY BUCKET" CASE, which is what it was written to be.
// `emptybucket-probe-1915.mjs` found core DELETES a bucket as it empties, so after the removal `f`
// has no `E` bucket at all. The arm is kept because it reaches a different path to the same state —
// the adjacency-box memo being dropped and refetched — and the startup line below prints which case
// it actually is instead of assuming.
import { Graph } from '@lenke/core';
import {
  V,
  and,
  both,
  bothE,
  filter,
  in_,
  inE,
  limit,
  not,
  or,
  out,
  outE,
  toArray,
  traversal,
  values,
  where,
} from '@lenke/gremlin';

const g = new Graph();

for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
  g.addVertex({ id, labels: ['P'], properties: { n: id } });
}

const vx = (id) => g.getVertexById(id);

g.addEdge({ id: 'e1', from: vx('a'), to: vx('b'), labels: ['E'], properties: {} });
g.addEdge({ id: 'e2', from: vx('c'), to: vx('a'), labels: ['F'], properties: {} });
g.addEdge({ id: 'e3', from: vx('d'), to: vx('d'), labels: ['E'], properties: {} });
// `f` gets an E edge and loses it, which leaves a zero-size `E` bucket on its adjacency box.
g.addEdge({ id: 'e4', from: vx('f'), to: vx('a'), labels: ['E'], properties: {} });
g.removeEdge(g.getEdgeById('e4'));

// Which case arm `f` really is, printed rather than assumed.
const fset = vx('f').adjFrom?.get('E');

const fcase =
  fset === undefined ? 'DELETED (f is isolated via the removal path)' : `PRESENT size=${fset.size}`;

console.log(`fixture: after removing f's only E edge, its 'E' bucket is ${fcase}`);

const sub = (...steps) => traversal(...steps);

// [name, fused plan, declining plan]
const CASES = [
  ['where out E', where(sub(out('E'))), where(sub(out('E'), limit(1000)))],
  ['where out F', where(sub(out('F'))), where(sub(out('F'), limit(1000)))],
  ['where out any', where(sub(out())), where(sub(out(), limit(1000)))],
  ['where in E', where(sub(in_('E'))), where(sub(in_('E'), limit(1000)))],
  ['where both E', where(sub(both('E'))), where(sub(both('E'), limit(1000)))],
  ['where both any', where(sub(both())), where(sub(both(), limit(1000)))],
  ['where out E|F', where(sub(out('E', 'F'))), where(sub(out('E', 'F'), limit(1000)))],
  ['where outE E', where(sub(outE('E'))), where(sub(outE('E'), limit(1000)))],
  ['where inE E', where(sub(inE('E'))), where(sub(inE('E'), limit(1000)))],
  ['where bothE E', where(sub(bothE('E'))), where(sub(bothE('E'), limit(1000)))],
  ['filter out E', filter(sub(out('E'))), filter(sub(out('E'), limit(1000)))],
  ['not out E', not(sub(out('E'))), not(sub(out('E'), limit(1000)))],
  ['not out F', not(sub(out('F'))), not(sub(out('F'), limit(1000)))],
  ['and out E', and(sub(out('E'))), and(sub(out('E'), limit(1000)))],
  [
    'and out E + in F',
    and(sub(out('E')), sub(in_('F'))),
    and(sub(out('E'), limit(1000)), sub(in_('F'))),
  ],
  [
    'or out E + out F',
    or(sub(out('E')), sub(out('F'))),
    or(sub(out('E'), limit(1000)), sub(out('F'))),
  ],
  [
    'and out E + out F',
    and(sub(out('E')), sub(out('F'))),
    and(sub(out('E'), limit(1000)), sub(out('F'))),
  ],
];

let bad = 0;

for (const [name, fused, generic] of CASES) {
  const got = toArray(traversal(V(), fused, values('n')), g);
  const want = toArray(traversal(V(), generic, values('n')), g);
  const okRaw = JSON.stringify(got) === JSON.stringify(want);

  if (!okRaw) {
    bad += 1;
  }

  console.log(
    `${okRaw ? '  ok  ' : '  ❌  '} ${name.padEnd(20)} fused ${JSON.stringify(got).padEnd(26)} generic ${JSON.stringify(want)}`,
  );
}

console.log(bad === 0 ? `\nALL ${CASES.length} AGREE` : `\n❌ ${bad} DISAGREE`);
process.exit(bad === 0 ? 0 : 1);
