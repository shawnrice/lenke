// Graph generator: Barabási–Albert-style preferential attachment (heavy-tailed
// in-degree => interesting PageRank/centrality), plus a few disconnected small
// components so connected-components has >1 answer. Emits NDJSON bytes.

export type GenResult = { bytes: Uint8Array; nVertices: number; nEdges: number };

export function generate(nVertices: number, mAttach: number, seed = 42): GenResult {
  // xorshift32 PRNG for reproducibility
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };

  const lines: string[] = [];
  // main BA graph over [0, nMain)
  const nMain = nVertices - 40; // reserve last 40 for disconnected structures
  const targets: number[] = []; // node ids repeated proportional to in-degree

  // seed clique of size mAttach+1
  for (let i = 0; i <= mAttach; i++) {
    lines.push(`{"type":"node","id":"${i}","labels":["V"],"properties":{"idx":${i}}}`);
    targets.push(i);
  }
  let edgeId = 0;
  for (let i = 1; i <= mAttach; i++) {
    for (let j = 0; j < i; j++) {
      const w = (rnd() * 10).toFixed(3);
      lines.push(
        `{"type":"edge","id":"e${edgeId++}","from":"${i}","to":"${j}","labels":["LINK"],"properties":{"weight":${w}}}`,
      );
      targets.push(i, j);
    }
  }

  for (let i = mAttach + 1; i < nMain; i++) {
    lines.push(`{"type":"node","id":"${i}","labels":["V"],"properties":{"idx":${i}}}`);
    // pick mAttach distinct existing targets by preferential attachment
    const chosen = new Set<number>();
    let guard = 0;
    while (chosen.size < mAttach && guard < mAttach * 8) {
      const t = targets[(rnd() * targets.length) | 0];
      if (t !== i) chosen.add(t);
      guard++;
    }
    for (const t of chosen) {
      const w = (rnd() * 10).toFixed(3);
      lines.push(
        `{"type":"edge","id":"e${edgeId++}","from":"${i}","to":"${t}","labels":["LINK"],"properties":{"weight":${w}}}`,
      );
      targets.push(i, t);
    }
  }

  // disconnected structures over [nMain, nVertices): 4 rings of 10
  for (let base = nMain; base < nVertices; base += 10) {
    for (let k = 0; k < 10; k++) {
      const id = base + k;
      lines.push(`{"type":"node","id":"${id}","labels":["V"],"properties":{"idx":${id}}}`);
    }
    for (let k = 0; k < 10; k++) {
      const a = base + k;
      const b = base + ((k + 1) % 10);
      const w = (rnd() * 10).toFixed(3);
      lines.push(
        `{"type":"edge","id":"e${edgeId++}","from":"${a}","to":"${b}","labels":["LINK"],"properties":{"weight":${w}}}`,
      );
    }
  }

  const text = lines.join('\n');
  return { bytes: new TextEncoder().encode(text), nVertices, nEdges: edgeId };
}
