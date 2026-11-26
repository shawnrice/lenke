// Item 1917 — HOW MUCH DOES `v.labels = [...]` BYPASS?
//
// Reading `Graph.ts`: `addLabelToVertex` / `removeLabelFromVertex` each call `indexVertexLabel` /
// `deIndexVertexLabel`, `emit(...)`, the constraint checks, and `recordUndo(...)`, and only THEN
// `commitElementLabels`. The setter calls `commitElementLabels` alone (or writes the label box
// directly, a documented shortcut taken for speed). So four things are skipped, not one.
//
// This measures which of the four actually diverge through the public API, so the decision about
// what to do is made on the full extent rather than on the one symptom that surfaced first.
//
//     bun labelsetter-extent-1917.mjs
//
// The three that diverge are pinned as `test.failing` in
// `packages/core/src/core/label-setter-bypass.test.ts`, which fails the day any of them is fixed.
import { Graph } from '@lenke/core';

const line = (what, viaSetter, viaMethod) => {
  const same = String(viaSetter) === String(viaMethod);

  console.log(
    `${what.padEnd(34)} setter=${String(viaSetter).padEnd(22)} ` +
      `method=${String(viaMethod).padEnd(22)}${same ? 'same' : 'DIVERGES'}`,
  );
};

/** Two vertices both labelled `T`, so `T` is VACUOUS — the state `effectiveLabel` acts on. */
const seed = () => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['T'], properties: {} });

  g.addVertex({ id: 'b', labels: ['T'], properties: {} });

  return { g, a };
};

/** The same T->U relabel, once through the setter and once through the supported mutators. */
const viaSetter = (s) => {
  s.a.labels = ['U'];
};

const viaMethods = (m) => {
  m.g.removeLabelFromVertex('T', m.a);
  m.g.addLabelToVertex('U', m.a);
};

const trial = (fn) => {
  try {
    fn();

    return 'ACCEPTED';
  } catch (e) {
    return `threw ${String(e).slice(0, 28)}`;
  }
};

const rolledBack = (g, fn) =>
  trial(() =>
    g.transaction(() => {
      fn();

      throw new Error('abort');
    }),
  );

// ---- 1. the vertex-label INDEX ----
{
  const s = seed();
  const m = seed();

  viaSetter(s);
  viaMethods(m);
  line(
    'verticesByLabel T after T->U',
    s.g.verticesByLabel.get('T')?.size ?? 0,
    m.g.verticesByLabel.get('T')?.size ?? 0,
  );
}

// ---- 2. EVENTS ----
{
  const s = seed();
  const m = seed();
  const sSeen = [];
  const mSeen = [];

  for (const [g, seen] of [
    [s.g, sSeen],
    [m.g, mSeen],
  ]) {
    g.on('@graph/LabelAddedToVertex', () => seen.push('added'));
    g.on('@graph/LabelRemovedFromVertex', () => seen.push('removed'));
  }

  viaSetter(s);
  viaMethods(m);
  line('events emitted', JSON.stringify(sSeen), JSON.stringify(mSeen));
}

// ---- 3. CONSTRAINTS: does adding a label bring its required keys into force? ----
{
  const s = seed();
  const m = seed();

  s.g.createRequiredKeys?.('U', ['mustHave']);
  m.g.createRequiredKeys?.('U', ['mustHave']);
  line(
    'required-key check on new label',
    trial(() => viaSetter(s)),
    trial(() => viaMethods(m)),
  );
}

// ---- 4. TRANSACTION ROLLBACK ----
{
  const s = seed();
  const m = seed();

  rolledBack(s.g, () => viaSetter(s));
  rolledBack(m.g, () => viaMethods(m));
  line(
    'labels after ROLLED BACK tx',
    JSON.stringify([...s.a.labels]),
    JSON.stringify([...m.a.labels]),
  );
  console.log('   (both should be ["T"] — the rollback must restore the original label)');
}
