// Item 1922 — CAN AN ELEMENT CHANGE WHILE `tree()` IS KEYING IT?
//
// `treeStep` keys every path position by `JSON.stringify(node.toJSON())` — the canonical
// `{id, labels, properties}` rendering that is the byte-identity contract with the Rust engine. That
// is **744 ms of a 1013 ms shape** (measured: `tree().by(k)`, which skips `treeKey`, is 269.67), and
// a per-element MEMO would collapse 1,200,000 serializations into ~200,000 distinct ones.
//
// ⚠️ BUT A MEMO IS ONLY SOUND IF THE ELEMENT CANNOT CHANGE MID-BUILD. The stream is pulled lazily,
// so a mutation step UPSTREAM of `tree()` runs interleaved with the tree insertion: an element keyed
// early, then mutated, then keyed again would get a STALE key from a memo and a fresh one without.
// `Graph` has no synchronous mutation counter (`version`/`epoch` advance on a microtask DRAIN —
// [[graph-counters-are-async]]), so the memo cannot be invalidated reactively.
//
// So the question is whether the case is REACHABLE at all. Asked rather than reasoned about.
//
//     bun treekey-mutation-probe-1922.mjs
import { Graph } from '@lenke/core';
import { V, out, property, toArray, traversal, tree } from '@lenke/gremlin';

const build = () => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c']) {
    g.addVertex({ id, labels: ['P'], properties: { n: id } });
  }

  const vx = (i) => g.getVertexById(i);

  g.addEdge({ id: 'e1', from: vx('a'), to: vx('b'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: vx('b'), to: vx('c'), labels: ['E'], properties: {} });
  // `b` is both a FAR end (of e1) and a NEAR end (of e2).
  //
  // ⚠️ THAT IS NOT ENOUGH TO SEE A STALE MEMO, which item 1922's mutation run proved the hard way:
  // on an acyclic chain the property step reaches the far end BEFORE `tree` keys it, so every
  // element is mutated before its FIRST keying and a memo stores the already-mutated key.
  // `treememo-stale-probe-1922.mjs` has the cyclic fixture that CAN discriminate.

  return g;
};

const CASES = [
  ['plain tree', () => traversal(V(), out('E'), tree())],
  // A mutation step BEFORE the hop: every vertex gets a new property as the stream is pulled.
  ['property() then hop then tree', () => traversal(V(), property('z', 1), out('E'), tree())],
  // A mutation step BETWEEN the hop and the tree.
  ['hop then property() then tree', () => traversal(V(), out('E'), property('z', 2), tree())],
];

for (const [name, make] of CASES) {
  const g = build();
  let verdict;

  try {
    const rows = toArray(make(), g);
    const keys = Object.keys(rows[0] ?? {});

    verdict = `${rows.length} row(s), ${keys.length} top-level key(s)`;
    // Does any key still carry the PRE-mutation rendering? If `z` appears in some keys and not
    // others, the element was keyed on both sides of its own mutation — the case a memo changes.
    const withZ = keys.filter((k) => k.includes('"z"')).length;

    verdict += `, ${withZ} of them mention the new property`;
  } catch (e) {
    verdict = `threw ${String(e).slice(0, 60)}`;
  }

  console.log(`${name.padEnd(30)} ${verdict}`);
}

console.log(
  '\n⚠️ IF A MUTATION STEP CAN SIT UPSTREAM AND THE KEYS STRADDLE IT, a memo must be gated on the\n' +
    '   plan having no mutation step. If the engine refuses such plans, or the keys are uniform, the\n' +
    '   memo is unconditional and the gate would be dead code.',
);
