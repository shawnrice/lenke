/**
 * Real **Apache Arrow IPC** egress for lenke query results — the interop bridge
 * to DuckDB / Polars / pandas / any Arrow consumer.
 *
 * {@link RustGraph.queryArrow} returns lenke's compact in-process columnar blob
 * (`ARW1`); its typed buffers already ARE Arrow's columnar layout (little-endian,
 * LSB-first validity bitmap, `i32` Utf8 offsets). This module layers the standard
 * Arrow IPC flatbuffer framing on top, exactly as the `ARW1` design anticipated —
 * it reconstructs a genuine {@link Table} and serializes it with `apache-arrow`'s
 * reference encoder, so the bytes are what `pyarrow.ipc`, `polars.read_ipc`, and
 * DuckDB's `read_arrow` read.
 *
 * `apache-arrow` is an **optional peer dependency** — install it only if you use
 * this subpath (`@lenke/native/arrow`); the core `@lenke/native` never imports it.
 */
import { ErrorCode, LenkeError } from '@lenke/errors';
import {
  Bool,
  Float64,
  makeData,
  makeVector,
  Table,
  tableToIPC,
  Utf8,
  type Vector,
} from 'apache-arrow';

// ARW1 column type tags (mirrors crates/lenke-core/src/arrow.rs and graph.ts).
const ARW_FLOAT64 = 1;
const ARW_BOOL = 2;
const ARW_UTF8 = 3;

const HEADER_LEN = 24;
const COLDESC_LEN = 40;

/** Copy `len` bytes at absolute offset `off` in `blob` into a fresh ArrayBuffer —
 * gives the typed-array view guaranteed 8-byte alignment (a view straight over the
 * blob can fault when its byteOffset isn't aligned to the element size). */
const sliceBuffer = (blob: Uint8Array, off: number, len: number): ArrayBuffer =>
  blob.buffer.slice(blob.byteOffset + off, blob.byteOffset + off + len) as ArrayBuffer;

/**
 * Reconstruct a real Apache Arrow {@link Table} from an `ARW1` columnar blob (the
 * output of {@link RustGraph.queryArrow} / `lnk_query_arrow`). Zero parse of the
 * cell values — the blob's numeric/bool/utf8 buffers and validity bitmap are Arrow's
 * own physical layout, so each becomes an `arrow.Data` directly. Float64, Bool, and
 * Utf8 columns are supported (the tags `ARW1` emits); nulls carry through via the
 * validity bitmap.
 */
export const arrowTable = (blob: Uint8Array): Table => {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const td = new TextDecoder();

  if (blob.length < HEADER_LEN || td.decode(blob.subarray(0, 4)) !== 'ARW1') {
    throw new LenkeError('lenke: not an ARW1 arrow blob', { code: ErrorCode.Ffi });
  }

  const nrows = Number(dv.getBigUint64(8, true));
  const ncols = Number(dv.getBigUint64(16, true));
  const columns: Record<string, Vector> = {};

  for (let c = 0; c < ncols; c += 1) {
    const d = HEADER_LEN + c * COLDESC_LEN;
    const type = dv.getUint32(d, true);
    const nullCount = dv.getUint32(d + 4, true);
    const nameOff = dv.getUint32(d + 8, true);
    const nameLen = dv.getUint32(d + 12, true);
    const validityOff = dv.getUint32(d + 16, true);
    const validityLen = dv.getUint32(d + 20, true);
    const buf1Off = dv.getUint32(d + 24, true);
    const buf1Len = dv.getUint32(d + 28, true);
    const buf2Off = dv.getUint32(d + 32, true);
    const buf2Len = dv.getUint32(d + 36, true);
    const name = td.decode(blob.subarray(nameOff, nameOff + nameLen));

    // ARW1's validity bitmap is Arrow's exact null bitmap (LSB-first, 1 = valid);
    // length 0 ⇒ no nulls, so no bitmap and nullCount 0.
    const nullBitmap =
      validityLen === 0 ? undefined : new Uint8Array(sliceBuffer(blob, validityOff, validityLen));

    if (type === ARW_FLOAT64) {
      columns[name] = makeVector(
        makeData({
          type: new Float64(),
          length: nrows,
          nullCount,
          nullBitmap,
          data: new Float64Array(sliceBuffer(blob, buf1Off, buf1Len)),
        }),
      );
    } else if (type === ARW_BOOL) {
      // Arrow Bool is itself a LSB-first bitmap — the same shape ARW1 emits.
      columns[name] = makeVector(
        makeData({
          type: new Bool(),
          length: nrows,
          nullCount,
          nullBitmap,
          data: new Uint8Array(sliceBuffer(blob, buf1Off, buf1Len)),
        }),
      );
    } else if (type === ARW_UTF8) {
      columns[name] = makeVector(
        makeData({
          type: new Utf8(),
          length: nrows,
          nullCount,
          nullBitmap,
          valueOffsets: new Int32Array(sliceBuffer(blob, buf1Off, buf1Len)),
          data: new Uint8Array(sliceBuffer(blob, buf2Off, buf2Len)),
        }),
      );
    } else {
      throw new LenkeError(`lenke: arrow column '${name}' has unknown type ${type}`, {
        code: ErrorCode.Ffi,
      });
    }
  }

  return new Table(columns);
};

/**
 * Serialize an `ARW1` columnar blob to **Arrow IPC** bytes — the standard,
 * flatbuffer-framed encapsulated-message format DuckDB / Polars / pandas read.
 * `format` picks the IPC stream layout (default — `pyarrow.ipc.open_stream`,
 * `polars.read_ipc_stream`) or the file / Feather-v2 layout (`read_feather`,
 * `pyarrow.ipc.open_file`). Feed a query straight through:
 * `toArrowIPC(graph.queryArrow('MATCH (n:P) RETURN n.name, n.age'))`.
 */
export const toArrowIPC = (blob: Uint8Array, format: 'stream' | 'file' = 'stream'): Uint8Array =>
  tableToIPC(arrowTable(blob), format);
