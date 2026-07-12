/**
 * graphene demo — a schema-validated graph data layer on @lenke/core.
 *
 * Domain: Users, Organizations, Posts, Memberships.
 * Constraints: unique User.email, required Post.title, a Post has exactly one
 * author (inbound cardinality 'one' on :AUTHORED), typed properties, strict
 * unknown-property rejection, and cascade-delete (User -> Posts).
 *
 * Run: bun demo.ts
 */
import { Graph } from '@lenke/core';
import { serialize, deserialize, graphContentEqual } from '@lenke/serialization';

import { migrate, type Migration } from './migrate.js';
import { from } from './query.js';
import { Repository } from './repository.js';
import { Schema, ConstraintError } from './schema.js';

const line = (s = '') => console.log(s);
const hr = (t: string) => line(`\n========== ${t} ==========`);

function expectReject(what: string, fn: () => void): void {
  try {
    fn();
    line(`  ✗ NOT REJECTED (bug): ${what}`);
  } catch (e) {
    if (e instanceof ConstraintError) {
      line(`  ✓ rejected: ${what}`);
      for (const v of e.violations) line(`      → [${v.kind}] ${v.message}`);
    } else {
      line(`  ✓ rejected (${(e as Error).name}): ${what} — ${(e as Error).message.split('\n')[0]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Schema V1 (initial): no Post.status, no User.username yet.
// ---------------------------------------------------------------------------
function schemaV1(): Schema {
  return new Schema()
    .entity({
      label: 'User',
      properties: {
        email: { type: 'string', required: true, unique: true },
        name: { type: 'string', required: true },
        age: { type: 'number' },
        role: { type: 'string', default: 'member' },
      },
    })
    .entity({
      label: 'Org',
      properties: {
        name: { type: 'string', required: true },
        plan: { type: 'string', default: 'free' },
      },
    })
    .entity({
      label: 'Post',
      properties: {
        title: { type: 'string', required: true },
        body: { type: 'string' },
      },
    })
    .relationship({
      label: 'AUTHORED',
      from: 'User',
      to: 'Post',
      inbound: 'one',
      cascadeDelete: true,
    })
    .relationship({ label: 'MEMBER_OF', from: 'User', to: 'Org' });
}

const graph = new Graph();
let schema = schemaV1().attach(graph);
let repo = new Repository(graph, schema);

// ---------------------------------------------------------------------------
// 1. Seed valid data
// ---------------------------------------------------------------------------
hr('1. SEED (valid writes)');
const acme = repo.create('Org', { name: 'Acme' });
const alice = repo.create('User', { email: 'alice@x.io', name: 'Alice', age: 34 });
const bob = repo.create('User', { email: 'bob@x.io', name: 'Bob', age: 28 });
repo.link(alice, 'MEMBER_OF', acme);
repo.link(bob, 'MEMBER_OF', acme);
const post1 = repo.createWithOwner({
  label: 'Post',
  props: { title: 'Hello', body: 'first' },
  edgeLabel: 'AUTHORED',
  owner: alice,
});
line(
  `  created Org=${acme.getProperty('name')}, Users=[Alice,Bob], Post="${post1.getProperty('title')}" by Alice`,
);
line(
  `  (role defaulted to '${alice.getProperty('role')}', plan defaulted to '${acme.getProperty('plan')}')`,
);

// ---------------------------------------------------------------------------
// 2. Constraint violations are REJECTED at write time (via event veto)
// ---------------------------------------------------------------------------
hr('2. CONSTRAINT VIOLATIONS (rejected)');
expectReject('duplicate unique email', () =>
  repo.create('User', { email: 'alice@x.io', name: 'Al2' }),
);
expectReject('missing required Post.title', () =>
  repo.createWithOwner({
    label: 'Post',
    props: { body: 'no title' },
    edgeLabel: 'AUTHORED',
    owner: bob,
  }),
);
expectReject('wrong type (age is string)', () =>
  repo.create('User', { email: 'c@x.io', name: 'C', age: '30' as unknown as number }),
);
expectReject('unknown property not in schema', () =>
  repo.create('User', { email: 'd@x.io', name: 'D', nickname: 'Dee' } as never),
);
expectReject('second author on a post (cardinality inbound=one)', () =>
  repo.link(bob, 'AUTHORED', post1),
);
expectReject('setting a duplicate email via update', () => repo.set(bob, 'email', 'alice@x.io'));
expectReject('removing a required property', () => {
  bob.removeProperty('name');
  const vs = schema.drain();
  if (vs.length) throw new ConstraintError(vs);
});

// Prove the graph was NOT mutated by the rejected writes.
line(`\n  User count still 2? ${graph.getVerticesByLabel('User').size === 2 ? 'yes ✓' : 'NO ✗'}`);
line(`  Bob.email untouched? ${bob.getProperty('email') === 'bob@x.io' ? 'yes ✓' : 'NO ✗'}`);
line(`  Bob.name untouched? ${bob.getProperty('name') === 'Bob' ? 'yes ✓' : 'NO ✗'}`);

// ---------------------------------------------------------------------------
// 3. Migrations transform the existing graph, then re-serialize
// ---------------------------------------------------------------------------
hr('3. MIGRATIONS');
// Give Bob a second post so migration-era data is richer.
schema.detach(); // run app-schema constraints off while we set up pre-migration state
const schemaSetup = schemaV1().attach(graph);
const repoSetup = new Repository(graph, schemaSetup);
repoSetup.createWithOwner({
  label: 'Post',
  props: { title: 'Bobs note', body: 'hi' },
  edgeLabel: 'AUTHORED',
  owner: bob,
});
schemaSetup.detach();

const migrations: Migration[] = [
  {
    // Add Post.status with a backfill default.
    id: '001_add_post_status',
    up({ byLabel }) {
      let n = 0;
      for (const p of byLabel('Post')) {
        if (!p.hasProperty('status')) {
          p.setProperty('status', 'published');
          n++;
        }
      }
      line(`  001: backfilled status='published' on ${n} Post(s)`);
    },
  },
  {
    // Rename label Org -> Organization.
    id: '002_rename_org_to_organization',
    up({ byLabel }) {
      const orgs = [...byLabel('Org')];
      for (const o of orgs) {
        o.addLabel('Organization');
        o.removeLabel('Org');
      }
      line(`  002: renamed ${orgs.length} Org -> Organization`);
    },
  },
  {
    // Retroactively add unique User.username: validate, backfill from email, index.
    id: '003_add_unique_username',
    up({ graph, byLabel }) {
      const users = [...byLabel('User')];
      const seen = new Set<string>();
      for (const u of users) {
        const uname = u.getProperty<string>('email').split('@')[0];
        if (seen.has(uname)) throw new Error(`003 aborted: duplicate username '${uname}'`);
        seen.add(uname);
        u.setProperty('username', uname);
      }
      graph.createVertexIndex('username'); // enable O(1) uniqueness seeks
      line(`  003: backfilled username on ${users.length} User(s) + built unique index`);
    },
  },
];

const ran = migrate(graph, migrations);
line(`  applied: [${ran.join(', ')}]`);
const ranAgain = migrate(graph, migrations);
line(`  re-run applied (should be empty, idempotent): [${ranAgain.join(', ')}]`);

// Re-serialize the migrated graph and prove a round-trip.
const text = serialize(graph, 'pg-json');
const restored = deserialize(text, 'pg-json', new Graph());
line(`  serialized migrated graph -> pg-json (${text.length} bytes)`);
line(`  round-trip content-equal? ${graphContentEqual(restored, graph) ? 'yes ✓' : 'NO ✗'}`);
line(
  `  sample post now: ${JSON.stringify(serialize(graph, 'pg-json').match(/"status":"[^"]+"/)?.[0])}`,
);

// ---------------------------------------------------------------------------
// 4. Attach V2 schema (post-migration) and prove new constraints hold
// ---------------------------------------------------------------------------
hr('4. POST-MIGRATION SCHEMA (V2) enforces new constraints');
const schemaV2 = schemaV1()
  .entity({
    label: 'User',
    properties: {
      email: { type: 'string', required: true, unique: true },
      name: { type: 'string', required: true },
      age: { type: 'number' },
      role: { type: 'string', default: 'member' },
      username: { type: 'string', required: true, unique: true },
    },
  })
  .entity({
    label: 'Post',
    properties: {
      title: { type: 'string', required: true },
      body: { type: 'string' },
      status: { type: 'string', default: 'draft' },
    },
  });
schemaV2.attach(graph);
const repo2 = new Repository(graph, schemaV2);
expectReject('duplicate username (new unique constraint)', () =>
  repo2.create('User', { email: 'evil@x.io', name: 'Evil', username: 'alice' } as never),
);
const carol = repo2.create('User', {
  email: 'carol@x.io',
  name: 'Carol',
  username: 'carol',
} as never);
line(`  created Carol with username=${carol.getProperty('username')} ✓`);

// ---------------------------------------------------------------------------
// 5. Fluent query builder -> GQL -> results
// ---------------------------------------------------------------------------
hr('5. QUERY BUILDER (compiles to GQL, runs it)');
const qb = from(graph, schemaV2, 'User').where('age', '>', 30).orderBy('name', 'ASC').limit(10);
const { gql, params } = qb.compile('name', 'email', 'username');
line(`  GQL: ${gql}`);
line(`  params: ${JSON.stringify(params)}`);
line(`  rows: ${JSON.stringify(qb.return('name', 'email', 'username'))}`);

const posts = from(graph, schemaV2, 'Post')
  .where('status', '=', 'published')
  .return('title', 'status');
line(`\n  published posts: ${JSON.stringify(posts)}`);

// ---------------------------------------------------------------------------
// 6. Cascade delete (hand-built vertex->vertex cascade)
// ---------------------------------------------------------------------------
hr('6. CASCADE DELETE (User -> authored Posts)');
const postsBefore = graph.getVerticesByLabel('Post').size;
repo2.deleteCascade(bob); // bob authored "Bobs note"
const postsAfter = graph.getVerticesByLabel('Post').size;
line(`  deleted Bob; Posts ${postsBefore} -> ${postsAfter} (his authored post cascaded)`);
line(
  `  Users now: ${JSON.stringify([...graph.getVerticesByLabel('User')].map((u) => u.getProperty('username')))}`,
);

line('\nDONE.');
