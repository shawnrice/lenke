// Materialized inference (forward-chaining) + edge-case probes flagged by the charter.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { buildOntology, closureReflexive } from './ontology';

function fresh() {
  const o = buildOntology();
  return o;
}

console.log('############ A. Zero-hop `*` + endpoint LABEL filter ############');
{
  const { g } = fresh();
  // D_bottom is a :Class. `*(s:Class)` at zero hop -> does start (a Class) get included?
  const withLabel = (
    query(
      g,
      `MATCH (x:Class {name:'D_bottom'})-[:SUBCLASS_OF]->*(s:Class) RETURN DISTINCT s.name AS n`,
    ) as any[]
  )
    .map((r) => r.n)
    .sort();
  console.log(
    '*(s:Class)  includes self D_bottom?',
    withLabel.includes('D_bottom'),
    JSON.stringify(withLabel),
  );
  // Now filter endpoint to a label the START does NOT have (:Property). Zero-hop start is a Class,
  // so does the zero-hop row survive? Expect: start excluded because it fails the endpoint label.
  const withOther = (
    query(
      g,
      `MATCH (x:Class {name:'D_bottom'})-[:SUBCLASS_OF]->*(s:Property) RETURN DISTINCT s.name AS n`,
    ) as any[]
  )
    .map((r) => r.n)
    .sort();
  console.log('*(s:Property) rows (start is a Class, not Property):', JSON.stringify(withOther));
}

console.log(
  '\n############ B. var-length WHERE filters ENDPOINT only (known capability gap) ############',
);
{
  const { g, parents } = fresh();
  // "superclasses of D_bottom whose name starts with D" — WHERE on endpoint works:
  const endpointFilter = (
    query(
      g,
      `MATCH (x:Class {name:'D_bottom'})-[:SUBCLASS_OF]->+(s) WHERE s.name STARTS WITH 'D' RETURN DISTINCT s.name AS n`,
    ) as any[]
  )
    .map((r) => r.n)
    .sort();
  console.log('endpoint WHERE (name STARTS WITH D):', JSON.stringify(endpointFilter));
  // But you CANNOT say "stop climbing when you hit a class named D_left" (intermediate filter).
  // The WHERE cannot see intermediate nodes; there is no per-hop predicate in the var-length pattern.
  console.log(
    '  -> no way to prune INTERMEDIATE nodes in the var-length pattern (must post-filter or use Gremlin repeat().until()).',
  );
}

console.log(
  '\n############ C. MATERIALIZE inferred TYPE edges (forward-chain 1 step) ############',
);
{
  const { g } = fresh();
  const beforeType = (
    query(g, `MATCH (i:Individual)-[:TYPE]->(c) RETURN count(*) AS c`) as any[]
  )[0].c;
  // Does INSERT from a MATCH reuse the bound vertices (not create new ones)?
  // Rule: i -TYPE-> c , c -SUBCLASS_OF-> p  ==>  i -TYPE-> p (one forward-chain step).
  let inserted: any;
  try {
    inserted = query(
      g,
      `MATCH (i:Individual)-[:TYPE]->(c:Class)-[:SUBCLASS_OF]->(p:Class) INSERT (i)-[:TYPE]->(p)`,
    );
    console.log('INSERT-from-MATCH ran. result:', JSON.stringify(inserted)?.slice(0, 120));
  } catch (e: any) {
    console.log('INSERT-from-MATCH THREW:', e?.code ?? e?.name, e?.message?.slice(0, 160));
  }
  const afterVerts = (query(g, `MATCH (n) RETURN count(*) AS c`) as any[])[0].c;
  const afterType = (query(g, `MATCH (i:Individual)-[:TYPE]->(c) RETURN count(*) AS c`) as any[])[0]
    .c;
  console.log(
    `TYPE edges: before=${beforeType} after=${afterType}  (delta=${afterType - beforeType})`,
  );

  // Check: did INSERT create NEW duplicate vertices for i/p, or reuse the bound ones?
  const nIndiv = (query(g, `MATCH (i:Individual) RETURN count(*) AS c`) as any[])[0].c;
  console.log(
    `#Individual vertices after materialize = ${nIndiv} (should be unchanged = 3002 if INSERT reused bound vars)`,
  );

  // Verify the forward-chain worked for one instance: diamondInst was TYPE D_bottom;
  // after 1 step it should also be TYPE D_left and D_right (direct parents), but NOT yet D_top (2 hops).
  const nowTypes = (
    query(
      g,
      `MATCH (i:Individual {name:'diamondInst'})-[:TYPE]->(c) RETURN DISTINCT c.name AS n`,
    ) as any[]
  )
    .map((r) => r.n)
    .sort();
  console.log('diamondInst materialized TYPEs after 1 step:', JSON.stringify(nowTypes));
  console.log(
    '  -> D_top (2 hops up) is ABSENT: single INSERT is one forward-chain step, NOT full closure.',
  );
}

console.log(
  '\n############ D. NO-FIXPOINT CEILING: iterate materialization to closure in a JS loop ############',
);
{
  const { g, parents, typeOf } = fresh();
  // Full closure of TYPE requires repeating the 1-step rule until no new edges (no in-engine fixpoint).
  let round = 0;
  let added = Infinity;
  while (added > 0 && round < 20) {
    const before = (query(g, `MATCH (i:Individual)-[:TYPE]->(c) RETURN count(*) AS c`) as any[])[0]
      .c;
    query(
      g,
      `MATCH (i:Individual)-[:TYPE]->(c:Class)-[:SUBCLASS_OF]->(p:Class) INSERT (i)-[:TYPE]->(p)`,
    );
    // dedup: engine may create duplicate TYPE edges each round; count DISTINCT pairs instead
    const distinct = new Set<string>(
      (query(g, `MATCH (i:Individual)-[:TYPE]->(c) RETURN i.name AS i, c.name AS c`) as any[]).map(
        (r) => r.i + '|' + r.c,
      ),
    ).size;
    const after = (query(g, `MATCH (i:Individual)-[:TYPE]->(c) RETURN count(*) AS c`) as any[])[0]
      .c;
    added = after - before;
    round++;
    console.log(
      `  round ${round}: raw TYPE edges ${before} -> ${after} (distinct pairs=${distinct})`,
    );
    if (round >= 12) break;
  }
  // Verify one instance's full inferred type set == JS reflexive ancestor closure of its declared class.
  const declared = typeOf.get('diamondInst')![0];
  const jsClosure = closureReflexive(parents, declared);
  const materialized = new Set<string>(
    (
      query(
        g,
        `MATCH (i:Individual {name:'diamondInst'})-[:TYPE]->(c) RETURN DISTINCT c.name AS n`,
      ) as any[]
    ).map((r) => r.n),
  );
  const ok =
    jsClosure.size === materialized.size && [...jsClosure].every((x) => materialized.has(x));
  console.log(`  diamondInst fully-materialized TYPE set == JS reflexive closure? ${ok}`);
  console.log(`    JS=${JSON.stringify([...jsClosure].sort())}`);
  console.log(`    materialized=${JSON.stringify([...materialized].sort())}`);
  console.log(
    '  NOTE: engine re-inserts duplicate TYPE edges each round (INSERT is not idempotent; there is no MERGE for edges w/o a unique key). Growth is why we track DISTINCT pairs.',
  );
}
