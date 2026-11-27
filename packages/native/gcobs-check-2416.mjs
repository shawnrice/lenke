/**
 * Does a `PerformanceObserver` on `gc` deliver entries in THIS runtime, and does it need the
 * buffered flag? A five-line calibration, because `allocprof-2416.mjs`'s `gcshare` arm reported
 * "0 collections" for a shape churning ~875 MiB per rep, which is not a believable zero.
 *
 * `PROBES.md` already records the drain hazard (entries arrive in a queued callback, so a
 * synchronous rep loop buffers every one and `disconnect()` fires first - item 1361 reported 0
 * pauses and 0.0% GC for a run really at 18.6%). This checks whether draining is SUFFICIENT.
 */
import { PerformanceObserver, performance } from 'node:perf_hooks';

const SINK = new Array(1024).fill(null);

const churn = (n) => {
  for (let i = 0; i < n; i += 1) {
    SINK[i & 1023] = { a: i, b: i + 1, c: `s${i & 1023}`, d: null };
  }

  return SINK.length;
};

for (const buffered of [false, true]) {
  let count = 0;
  let pause = 0;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      count += 1;
      pause += e.duration;
    }
  });

  obs.observe(buffered ? { entryTypes: ['gc'], buffered: true } : { entryTypes: ['gc'] });

  const t0 = performance.now();

  churn(4_000_000);

  const ms = performance.now() - t0;

  await new Promise((r) => setTimeout(r, 0));
  obs.disconnect();

  console.log(
    `buffered=${String(buffered)}  ${count} collections, ${pause.toFixed(1)} ms pause, ` +
      `window ${ms.toFixed(1)} ms  -> ${count === 0 ? 'DELIVERS NOTHING' : 'delivers'}`,
  );
}
