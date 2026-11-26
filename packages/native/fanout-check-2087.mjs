/*
 * Item 2087 — count the DISTINCT endpoints before trusting an `n·f²` answer.
 *
 * CLAUDE.md records that six generators here had the form `to = (a*k + b) % N`, which is
 * INVARIANT under k -> k+N: one vertex's FANOUT edges then all land on the SAME target, out-degree
 * looks perfect, and a k-hop count is `f^k · N` BY CONSTRUCTION — so the count cannot validate the
 * fixture. This probe's generator splits on the repeat index (`hop`), which is the prescribed fix, but
 * "reading the generator" is exactly what the rule says not to rely on.
 */
const NODES = Number(process.env.NODES ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 3);

const targetsOf = new Map();

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);
  const to = (i * 7 + 3 + hop * 2654435761) % NODES;
  const seen = targetsOf.get(i) ?? new Set();

  seen.add(to);
  targetsOf.set(i, seen);
}

let branching = 0;
let collapsed = 0;

for (const [, seen] of targetsOf) {
  if (seen.size === FANOUT) {
    branching += 1;
  } else if (seen.size === 1 && FANOUT > 1) {
    collapsed += 1;
  }
}

const inDeg = new Map();

for (const [, seen] of targetsOf) {
  for (const t of seen) {
    inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
  }
}

console.log(
  `NODES=${NODES} FANOUT=${FANOUT}\n` +
    `  sources with ${FANOUT} DISTINCT targets : ${branching} / ${targetsOf.size}\n` +
    `  sources whose edges all COLLAPSE to one : ${collapsed}\n` +
    `  distinct targets reached overall        : ${inDeg.size} / ${NODES}\n` +
    `  VERDICT: ${branching === targetsOf.size ? 'BRANCHING — an n*f^2 count is real evidence' : 'DEGENERATE — n*f^2 is true by construction, do NOT validate with it'}`,
);
