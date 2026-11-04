/**
 * Does `--heap-prof` report the bytes this process actually allocates? CALIBRATION, not a finding.
 *
 * Item 1360 named the sampling heap profiler as the instrument for the write path's 12.4-20.7% GC
 * share, which a CPU profile cannot attribute. The first two runs of it reported **1.7-1.9 MiB total
 * for a process that creates 200,000 vertices and 300,000 edges**, dominated by Node's module loader
 * — and dropping the sampling interval 16x (16384 -> 1024 bytes) did not raise the total at all. One
 * of those two facts is the instrument lying, so it gets proved against a known quantity before any
 * number from it is written down. Same discipline as proving a mutation harness kills before
 * trusting it with a mutant.
 *
 *     ALLOC=retained|garbage node --heap-prof --heap-prof-dir=$D \
 *         --heap-prof-name=cal-<arm>.heapprofile --heap-prof-interval=1024 heap-prof-calibrate.mjs
 *
 * Each arm allocates ~128 MiB in 64-byte-ish objects through ONE named function, so a working
 * profiler must attribute a large share to `burn`:
 *
 *   retained  every object kept alive in one array — survives to the profile dump
 *   garbage   every object dropped immediately — dies in the nursery
 *
 * If `retained` shows up and `garbage` does not, the profiler is reporting LIVE bytes rather than
 * allocated bytes, and it cannot answer the GC question at all.
 */
const ARM = process.env.ALLOC ?? 'retained';
const TARGET_MIB = 128;
const PER_OBJ = 64;
const COUNT = Math.floor((TARGET_MIB * 1024 * 1024) / PER_OBJ);

/** The ONE named allocation site. A working profiler attributes most of the bytes here. */
const burn = (keep) => {
  const held = [];
  let sink = 0;

  for (let i = 0; i < COUNT; i += 1) {
    // A small object with a few fields — the shape the engine allocates per element.
    const obj = { a: i, b: i + 1, c: `s${i & 1023}`, d: null };

    if (keep) {
      held.push(obj);
    } else {
      sink += obj.a;
    }
  }

  return keep ? held.length : sink;
};

const t0 = performance.now();
const out = burn(ARM === 'retained');
const ms = performance.now() - t0;

if (out === 0) {
  throw new Error('allocated nothing — calibration would be of nothing');
}

console.log(
  JSON.stringify({
    arm: ARM,
    objects: COUNT,
    approxMiB: TARGET_MIB,
    ms: Number(ms.toFixed(1)),
    out,
  }),
);
