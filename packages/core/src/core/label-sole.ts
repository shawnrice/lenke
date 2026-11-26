/**
 * `LabelBox.sole`'s derivation, in its own module (item 2085).
 *
 * **WHY IT IS NOT IN `Graph.ts` WITH THE TYPE IT SERVES.** `Vertex` and `Edge` already import
 * `Graph` as `import type`, which is erased and creates no runtime edge. Importing a VALUE from
 * `Graph.ts` turned that into a real cycle and `import/no-cycle` refused it — correctly, since
 * `Graph.ts` imports both elements back. A leaf module both sides can import is the fix the lint
 * itself suggests, and it is the same reason `propOf` lives in a value-accessor layer rather than
 * beside the bindings it reads.
 */

/**
 * A label set's sole member, or `undefined` for zero or many.
 *
 * `size === 1` IS CHECKED FIRST so `values()` is never called on an empty set, and the
 * two-or-more case returns `undefined` rather than an arbitrary member: a reader that treated "some
 * label" as "the label" would answer a single-label test wrongly for a multi-labelled element.
 */
export const soleLabelOf = (labels: Set<string>): string | undefined => {
  if (labels.size !== 1) {
    return undefined;
  }

  const [one] = labels;

  return one;
};
