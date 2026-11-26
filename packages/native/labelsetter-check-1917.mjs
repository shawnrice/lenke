// Item 1917 — DOES THE LABEL-INDEX BLOCKER STILL HOLD?
//
// `effectiveLabel` drops a label test when the label is VACUOUS (carried by every vertex), decided
// per execution by reading `graph.verticesByLabel.get(l).size === vertexCount`. Item 1917 priced
// extending that elision to the var-length walk's END NODE at **~11%** of the row — and the repo's
// own standing note says a new elision reading `verticesByLabel` must not be added without raising
// an OPEN owner decision first: the public `v.labels = [...]` setter was recorded as NOT maintaining
// that index, which would make every such elision a latent wrong answer.
//
// A "NOT BUILT BECAUSE X" NOTE IS A CLAIM ABOUT X, and three such claims were found overstated in
// one earlier session. So this asks the setter directly rather than trusting the note.
import { Graph } from '@lenke/core';

const g = new Graph();
const a = g.addVertex({ id: 'a', labels: ['T'], properties: { n: 1 } });

g.addVertex({ id: 'b', labels: ['T'], properties: { n: 2 } });

console.log(
  `before: verticesByLabel T = ${g.verticesByLabel.get('T')?.size}  vertexCount = ${g.vertexCount}`,
);

let threw = '';

try {
  a.labels = ['U'];
} catch (e) {
  threw = String(e).slice(0, 120);
}

if (threw !== '') {
  console.log(`\nthe setter THREW: ${threw}`);
  console.log('BLOCKER DOES NOT HOLD THIS WAY — the public setter refuses, so no elision can be');
  console.log('   desynchronized through it. Check the other mutators before concluding.');
} else {
  const tSize = g.verticesByLabel.get('T')?.size ?? 0;

  console.log(`\nafter a.labels = ['U']:`);
  console.log(`  verticesByLabel T = ${tSize}`);
  console.log(`  verticesByLabel U = ${g.verticesByLabel.get('U')?.size ?? 0}`);
  console.log(
    `  a.labels          = ${JSON.stringify(a.labels)}  ` +
      `ctor=${a.labels?.constructor?.name}  as array=${JSON.stringify([...(a.labels ?? [])])}  ` +
      `hasLabel(U)=${String(a.hasLabel?.('U'))}  hasLabel(T)=${String(a.hasLabel?.('T'))}`,
  );
  console.log(
    tSize === g.vertexCount
      ? `  BLOCKER HOLDS: T still reads as VACUOUS (size ${tSize} === vertexCount ${g.vertexCount})\n` +
          `     though a is now U — so an elision reading this index would drop a test it must keep.`
      : '  index maintained by the setter',
  );
}

// And the supported mutators, for contrast: if these DO maintain it, the gap is the setter alone.
const g2 = new Graph();
const c = g2.addVertex({ id: 'c', labels: ['T'], properties: {} });

g2.addVertex({ id: 'd', labels: ['T'], properties: {} });
g2.removeLabelFromVertex?.('T', c);

const has = typeof g2.removeLabelFromVertex === 'function' ? '' : '   [no such method on Graph]';

console.log(
  `\nvia removeLabelFromVertex: verticesByLabel T = ${g2.verticesByLabel.get('T')?.size ?? 0} (vertexCount ${g2.vertexCount})${has}`,
);
