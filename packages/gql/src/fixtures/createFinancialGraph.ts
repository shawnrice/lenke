import { Graph } from '@lenke/core';

/**
 * The running example from the GQL / SQL/PGQ research literature (Francis,
 * Gheerbrant, Libkin, Marsault, Martens, Murlak, et al.) — a *financial network
 * layered over a social one*, used to motivate the "money-laundering" query:
 * find a pair of friends in the same city who move money to each other via a
 * common friend who lives elsewhere.
 *
 * The published papers fix the schema but not the data, so this is a concrete
 * instance chosen to make that query (and a handful of others) return a known,
 * hand-computed result.
 *
 *   Person {name, city}            Account {name, type}
 *   ───────────────────            ────────────────────
 *   alice  London (p1)             acc-alice  checking (a1)
 *   bob    London (p2)             acc-bob    checking (a2)
 *   carol  Paris  (p3)             acc-carol  savings  (a3)
 *   dave   London (p4)             acc-dave   checking (a4)
 *   erin   Berlin (p5)             — erin owns nothing, knows no one —
 *
 *   FRIENDS (modelled one-way, queried undirected):
 *     alice ~FRIENDS~ bob      (same city: London)
 *     alice ~FRIENDS~ carol    (cross-city: London/Paris)
 *     bob   ~FRIENDS~ dave     (same city: London)
 *
 *   OWNS:  alice→acc-alice, bob→acc-bob, carol→acc-carol, dave→acc-dave
 *
 *   TRANSFER {amount}:
 *     acc-alice → acc-carol   1000   (t1 of the laundering trail)
 *     acc-carol → acc-bob      900   (t2; note 900 < 1000)
 *     acc-dave  → acc-alice    500
 *
 * The laundering trail alice→carol→bob (friends alice/bob in London, carol the
 * Paris intermediary, decreasing amounts) is the one match of the motivating
 * query.
 */
export const createFinancialGraph = (): Graph => {
  const g = new Graph();
  g.disableEvents();

  const alice = g.addVertex({
    id: 'p1',
    labels: ['Person'],
    properties: { name: 'alice', city: 'London' },
  });
  const bob = g.addVertex({
    id: 'p2',
    labels: ['Person'],
    properties: { name: 'bob', city: 'London' },
  });
  const carol = g.addVertex({
    id: 'p3',
    labels: ['Person'],
    properties: { name: 'carol', city: 'Paris' },
  });
  const dave = g.addVertex({
    id: 'p4',
    labels: ['Person'],
    properties: { name: 'dave', city: 'London' },
  });
  // erin is intentionally isolated: no account, no friendships, no transfers.
  g.addVertex({ id: 'p5', labels: ['Person'], properties: { name: 'erin', city: 'Berlin' } });

  const accAlice = g.addVertex({
    id: 'a1',
    labels: ['Account'],
    properties: { name: 'acc-alice', type: 'checking' },
  });
  const accBob = g.addVertex({
    id: 'a2',
    labels: ['Account'],
    properties: { name: 'acc-bob', type: 'checking' },
  });
  const accCarol = g.addVertex({
    id: 'a3',
    labels: ['Account'],
    properties: { name: 'acc-carol', type: 'savings' },
  });
  const accDave = g.addVertex({
    id: 'a4',
    labels: ['Account'],
    properties: { name: 'acc-dave', type: 'checking' },
  });

  g.addEdge({ id: 'f1', from: alice, to: bob, labels: ['FRIENDS'], properties: { since: 2019 } });
  g.addEdge({ id: 'f2', from: alice, to: carol, labels: ['FRIENDS'], properties: { since: 2020 } });
  g.addEdge({ id: 'f3', from: bob, to: dave, labels: ['FRIENDS'], properties: { since: 2021 } });

  g.addEdge({ id: 'o1', from: alice, to: accAlice, labels: ['OWNS'], properties: {} });
  g.addEdge({ id: 'o2', from: bob, to: accBob, labels: ['OWNS'], properties: {} });
  g.addEdge({ id: 'o3', from: carol, to: accCarol, labels: ['OWNS'], properties: {} });
  g.addEdge({ id: 'o4', from: dave, to: accDave, labels: ['OWNS'], properties: {} });

  g.addEdge({
    id: 't1',
    from: accAlice,
    to: accCarol,
    labels: ['TRANSFER'],
    properties: { amount: 1000 },
  });
  g.addEdge({
    id: 't2',
    from: accCarol,
    to: accBob,
    labels: ['TRANSFER'],
    properties: { amount: 900 },
  });
  g.addEdge({
    id: 't3',
    from: accDave,
    to: accAlice,
    labels: ['TRANSFER'],
    properties: { amount: 500 },
  });

  g.enableEvents();

  return g;
};
