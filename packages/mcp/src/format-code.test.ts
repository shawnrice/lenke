import { describe, expect, test } from 'bun:test';

import { ErrorCode, hasErrorCode } from '@lenke/errors';

import { TOOLS } from './tools.js';

/*
 * Item 2519: an MCP tool handed a bad `format` must raise `ErrorCode.UnknownFormat`.
 *
 * `@lenke/errors` states the contract — "the **code is the contract**, not the message" — and
 * `@lenke/serialization` already raises `E_UNKNOWN_FORMAT` for exactly this mistake, with a test
 * pinning it. But `buildGraph` here PRE-VALIDATES `format` against its own `FORMATS` list before
 * calling `deserialize`, so the library's coded error was unreachable for that input and the tool
 * surfaced a plain `Error` with `code === undefined`.
 *
 * That matters more on this surface than on most: these errors are returned to LLM clients over the
 * MCP protocol, where the code is the machine-readable half. It is the same reason item 2518's guide
 * correction mattered — a wrong or missing code here misinforms a consumer that cannot read prose
 * intent.
 *
 * The rows assert `error.code` via `hasErrorCode`, never the message text (item 2518's code-swap
 * mutant showed a message assertion survives a code change).
 */
const OK_NDJSON = '{"type":"node","id":"1","labels":["P"],"properties":{"n":1}}';
const QUERY = 'MATCH (n) RETURN count(*) AS c';

const thrown = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();

    return undefined;
  } catch (e) {
    return e;
  }
};

describe('MCP tools carry ErrorCode.UnknownFormat for a bad format (item 2519)', () => {
  const tool = TOOLS.find((t) => t.name === 'gql_run');

  test('the tool under test exists and is callable — the instrument check', () => {
    expect(tool).toBeDefined();
    expect(typeof tool?.handle).toBe('function');
  });

  test('a bad format carries the CODE, not just a message', async () => {
    const e = await thrown(async () =>
      tool?.handle({ query: QUERY, data: OK_NDJSON, format: 'no-such-format' }),
    );

    expect(hasErrorCode(e, ErrorCode.UnknownFormat)).toBe(true);
  });

  /*
   * THE PRODUCTIVE CONTROL. A good format on the same path must not throw, which is what shows the
   * coded throw fires only for the bad format rather than for any call. It needs VALID ndjson — with
   * `'{}'` as the data this row raises `E_INVALID_SHAPE` and proves nothing about over-firing.
   */
  test('a GOOD format on the same path does not throw', async () => {
    const e = await thrown(async () =>
      tool?.handle({ query: QUERY, data: OK_NDJSON, format: 'ndjson' }),
    );

    expect(e).toBeUndefined();
  });

  test('omitting format defaults to ndjson and does not throw', async () => {
    const e = await thrown(async () => tool?.handle({ query: QUERY, data: OK_NDJSON }));

    expect(e).toBeUndefined();
  });
});
