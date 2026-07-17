import { ErrorCode, LenkeError } from '@lenke/errors';

import type { Graph, Vertex } from './core/index.js';

/**
 * The [Standard Schema](https://standardschema.dev) v1 interface, inlined
 * (types-only, zero-dependency by design — the spec is meant to be copied). Any
 * validation library that implements it — Zod ≥3.24, Valibot, ArkType, … —
 * exposes a `~standard` property and is accepted here verbatim. lenke owns no
 * schema DSL of its own: you bring your validator, we consume the spec.
 *
 * We deliberately flatten the spec's `namespace` into standalone types (the lint
 * gate disallows TS namespaces) — the shape is otherwise identical.
 */
export type StandardSchemaV1<Input = unknown, Output = Input> = {
  readonly '~standard': StandardSchemaProps<Input, Output>;
};

type StandardSchemaProps<Input, Output> = {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
  readonly types?: { readonly input: Input; readonly output: Output } | undefined;
};

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

type StandardIssue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
};

/** The input type a Standard Schema accepts (what you pass to `create`). */
export type InferInput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['input'];

/** The output type a Standard Schema produces (what gets stored). */
export type InferOutput<S extends StandardSchemaV1> = NonNullable<
  S['~standard']['types']
>['output'];

/** Render a `key.0.name`-style path for an issue, for a legible error message. */
const formatPath = (issue: StandardIssue): string =>
  (issue.path ?? [])
    .map((seg) => (typeof seg === 'object' ? String(seg.key) : String(seg)))
    .join('.');

/**
 * Run a Standard Schema over `input`, throwing a `ConstraintViolation` that
 * lists every issue on failure. Awaits the validator — a Standard Schema may
 * validate asynchronously (regex/refinements/network), so this is always async
 * even for a synchronous schema.
 */
const validateWith = async <S extends StandardSchemaV1>(
  label: string,
  schema: S,
  input: InferInput<S>,
): Promise<InferOutput<S>> => {
  const result = await schema['~standard'].validate(input);

  if (result.issues) {
    const detail = result.issues
      .map((i) => {
        const at = formatPath(i);

        return at ? `${at}: ${i.message}` : i.message;
      })
      .join('; ');

    throw new LenkeError(`lenke: ${label} failed schema validation — ${detail}`, {
      code: ErrorCode.ConstraintViolation,
    });
  }

  return result.value;
};

/**
 * A label bound to a Standard Schema: `create` validates an input host-side and,
 * on success, writes it as a `label`-tagged vertex. `parse` validates without
 * writing. Reusable across graphs (the schema holds no graph).
 */
export type NodeSchema<S extends StandardSchemaV1> = {
  readonly label: string;
  readonly schema: S;
  /** Validate `input` (throwing `ConstraintViolation` on failure) without writing. */
  parse: (input: InferInput<S>) => Promise<InferOutput<S>>;
  /**
   * Validate `input`, then add it as a `label`-tagged vertex to `graph`. The
   * validated (parsed/coerced) OUTPUT is what gets stored, so a schema that
   * trims/defaults/coerces persists its normalized value.
   */
  create: (graph: Graph, input: InferInput<S>) => Promise<Vertex>;
};

/**
 * Bind a node `label` to any [Standard Schema](https://standardschema.dev) —
 * a Zod/Valibot/ArkType object schema, or anything exposing `~standard`. You
 * get the schema's own type inference for free (`create`'s input is typed) plus
 * validate-before-write, with no schema DSL to learn and no dependency added.
 *
 * This validates HOST-side, before the write — it guards `create` calls, not a
 * raw GQL `INSERT` or `mergeNdjson` (those write through the engine, which can't
 * run a JS schema). For in-engine, both-engine enforcement that also guards raw
 * writes, use the R-CONSTRAINTS surface (`createTypeConstraint` /
 * `createRequiredConstraint` / `createUniqueConstraint` / `createValidator`);
 * the two compose — a schema at the app boundary, constraints at the engine.
 *
 * @example
 * const User = defineNode('User', z.object({ name: z.string(), age: z.number().optional() }))
 * const v = await User.create(graph, { name: 'ada' }) // typed + validated, then stored
 */
export const defineNode = <S extends StandardSchemaV1>(
  label: string,
  schema: S,
): NodeSchema<S> => ({
  label,
  schema,
  parse: (input) => validateWith(label, schema, input),
  create: async (graph, input) => {
    const value = await validateWith(label, schema, input);

    return graph.addVertex({ labels: [label], properties: value as Record<string, unknown> });
  },
});
