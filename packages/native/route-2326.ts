/**
 * **WHICH RUNG DOES EACH SHAPE TAKE? (item 2326)** A differential profile put `propOf` at 9.05 ns a row
 * on the seeked projection against 1.82 on the whole-scan one — 82% of the gap. `propOf` is three
 * operations, so it cannot be 5x dearer by itself; the likely explanation is that the SCAN has a fused
 * projection rung reading `props[key]` inline and only calls `propOf` on a remainder, while the SEEK has
 * no such fusion. Mechanism guesses have been punished repeatedly this session, so this reads the
 * compiled route instead of assuming it.
 */
import { parseQuery } from '@lenke/gql';

/*
 * DELIBERATE REACH-IN, which the boundaries rule asks be justified inline: `compileLinear` is INTERNAL
 * to @lenke/gql and reading the chosen route is exactly what this probe exists for. Going through the
 * public entry point would not expose it, and a probe is the one place where coupling to an internal is
 * the point — it must break loudly when the internal moves.
 */
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- a route probe must read the internal compiler
import { compileLinear } from '../gql/src/executor/rewrites.ts';

const SHAPES = {
  seekProject: 'MATCH (u:User) WHERE u.score = $s RETURN u.name AS n',
  scanProject: 'MATCH (u:User) RETURN u.name AS n',
  seekCount: 'MATCH (u:User) WHERE u.score = $s RETURN count(*) AS c',
};

for (const [name, text] of Object.entries(SHAPES)) {
  /*
   * `parseQuery` is typed as returning `Statement`, whose `parts` is not on the public type — this
   * probe deliberately reaches into the parsed shape to read the chosen route, so the cast is the point
   * rather than a shortcut. If `parts` ever moves, this throws at runtime rather than reporting a
   * wrong route silently.
   */
  const { parts } = parseQuery(text) as unknown as { parts: readonly unknown[] };

  if (parts === undefined || parts.length === 0) {
    throw new Error(`no linear part parsed for ${name}`);
  }

  const linear = parts[0] as Parameters<typeof compileLinear>[0];
  const compiled = compileLinear(linear) as Record<string, unknown>;
  const live = Object.entries(compiled)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k]) => k);

  console.log(`  ${name.padEnd(12)} ${live.join(', ')}`);
}
