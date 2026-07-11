/**
 * Access to lenke's Neo4j-admin-import-style *paired-file* CSV API.
 *
 * The README (packages/serialization/README.md:63) says:
 *   "The CSV codec also exposes its node/edge halves directly (`encodeNodes`,
 *    `decodeNodes`, `encodeEdges`, `decodeEdges`, and their `*Stream` variants)"
 *
 * ...but as shipped they are NOT reachable from the package:
 *   - not on the `@lenke/serialization` root barrel (only `csvCodec` is),
 *   - not methods of `csvCodec` (it only carries name/encode/decode/*Stream),
 *   - and the package `exports` map has no `./csv` subpath, so a deep import of
 *     `@lenke/serialization/src/csv/...` is blocked ("Cannot find module").
 *
 * The ONLY way to reach them is to import the source module by absolute path,
 * which is what this shim does. (Logged per instructions: reached into SOURCE.)
 */
export {
  encodeNodes,
  decodeNodes,
  encodeEdges,
  decodeEdges,
  encodeNodesStream,
  encodeEdgesStream,
  decodeNodesStream,
  decodeEdgesStream,
} from '/home/shawn/projects/pl-graph/packages/serialization/src/csv/index.ts';
