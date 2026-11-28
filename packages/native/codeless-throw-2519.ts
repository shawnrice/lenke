import { formatFor } from '@lenke/cli';
import { ErrorCode } from '@lenke/errors';
import { TOOLS } from '@lenke/mcp';
import { deserialize } from '@lenke/serialization';

/*
 * Item 2519: the SAME user mistake — a bad serialization format name — carries `E_UNKNOWN_FORMAT`
 * through the library and NO CODE through the CLI and MCP front doors.
 *
 * ## HOW THE 105 CODE-LESS THROWS NARROWED TO THIS
 *
 * Item 2518 counted 105 `throw new Error(` against 307 coded and flagged `native`'s 91 as the worry.
 * Triaging by whether the file is SHIPPED (under a package's `src/`) rather than one of my own probe
 * scripts collapses that number:
 *
 *     native   91 code-less  ->   2 shipped (89 are top-level probe scripts I wrote)
 *     cli       7            ->   7
 *     mcp       3            ->   3
 *     react     2            ->   2
 *     gql       2            ->   1
 *     TOTAL   105            ->  15 shipped
 *
 * And 13 of those 15 are structurally fine, mostly SAFE BY TYPE rather than by reachability:
 *
 *   - `gql/executor/expr-analysis.ts` assigns `const unhandled: never = e` first, so the compiler
 *     proves the arm unreachable; it fires only if someone adds an `Expr` kind without a case.
 *   - `native/src/abi.ts` is a load-time ABI assert (a stale build artifact, not user input).
 *   - `native/src/fixture-branching.ts` is the bench fixture-degeneracy guard from items 1516/1518.
 *   - the two `react` ones are "used outside its provider", a developer error at mount.
 *   - the CLI's argv parsing ones report to a terminal, where a human reads the message.
 *
 * ## THE TWO THAT ARE NOT FINE
 *
 * `@lenke/serialization` raises a proper `LenkeError` with `ErrorCode.UnknownFormat` for an unknown
 * format, and `serialization/src/errors.test.ts` asserts that code. But `cli/src/io.ts` and
 * `mcp/src/tools.ts` each PRE-VALIDATE the format against their own `FORMATS` list and throw a plain
 * `Error` — so the library's coded error is never reached for that input, and the registry's promise
 * that "the CODE is the contract" holds through one door and not the others.
 *
 * The MCP one is the one that matters: it is served to LLM clients, the same reason item 2518's
 * guide fix mattered.
 *
 * Every row prints the code that actually arrives. The library row is the CONTROL — it shows the
 * code the other two should carry, so a run where IT reads NO CODE means the probe is wrong.
 */
const line = (label: string, got: string): void => {
  const cols = [label.padEnd(46), got];

  console.log(`  ${cols.join(' ')}`);
};

const codeOf = (fn: () => unknown): string => {
  try {
    fn();

    return 'NO THROW';
  } catch (e) {
    const c = (e as { code?: string }).code;

    return c ?? 'NO CODE  <- breaks the registry contract';
  }
};

const BAD = 'no-such-format';

console.log('# One user mistake, three doors. Which carry E_UNKNOWN_FORMAT?\n');
console.log(`  the code the condition HAS: ${ErrorCode.UnknownFormat}\n`);

line(
  'LIBRARY deserialize() [CONTROL]',
  codeOf(() => deserialize('{}', BAD as never)),
);
line(
  'CLI formatFor(file, override)',
  codeOf(() => formatFor('x.ndjson', BAD)),
);
line(
  'CLI formatFor — undetectable extension',
  codeOf(() => formatFor('x.unknownext')),
);

/*
 * The MCP tool's method is `handle` and it is ASYNC. A first version of this probe called a
 * non-existent `run()`, and the resulting TypeError reported as "NO CODE" — a finding that was
 * entirely the probe's. The library CONTROL could not catch it, because it never exercises the MCP
 * call path: a control validates the instrument, not every row's mechanism. Hence the explicit
 * "method missing" row below, which fails loudly instead of looking like a result.
 */
const asyncCodeOf = async (fn: () => unknown): Promise<string> => {
  try {
    await fn();

    return 'NO THROW';
  } catch (e) {
    const c = (e as { code?: string }).code;

    if (e instanceof TypeError) {
      return `PROBE BUG (TypeError): ${e.message.slice(0, 44)}`;
    }

    return c ?? 'NO CODE  <- breaks the registry contract';
  }
};

const runTool = TOOLS.find((t) => t.name === 'gql_run');

if (runTool === undefined || typeof runTool.handle !== 'function') {
  line('MCP gql_run', 'TOOL OR handle() MISSING — the probe is wrong');
} else {
  line(
    'MCP gql_run with a bad format',
    await asyncCodeOf(() =>
      runTool.handle({ query: 'MATCH (n) RETURN count(*) AS c', data: '{}', format: BAD }),
    ),
  );
  /*
   * THE PRODUCTIVE CONTROL: a GOOD format on the same call path must not throw at all, which is what
   * shows the new coded throw fires only for the bad format. It needs VALID ndjson — a first version
   * passed `'{}'` and the row read `E_INVALID_SHAPE`, throwing for a reason unrelated to the change
   * and so proving nothing about over-firing.
   */
  const OK_NDJSON = '{"type":"node","id":"1","labels":["P"],"properties":{"n":1}}';

  line(
    'MCP gql_run, GOOD format [CONTROL: NO THROW]',
    await asyncCodeOf(() =>
      runTool.handle({
        query: 'MATCH (n) RETURN count(*) AS c',
        data: OK_NDJSON,
        format: 'ndjson',
      }),
    ),
  );
}

console.log('\n  The CONTROL must carry the code — if it reads NO CODE the probe is wrong.');
console.log('  Any OTHER row reading NO CODE is the finding: the same mistake, a weaker contract.');
