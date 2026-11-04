/**
 * Profile a WINDOW of a process, not the whole process.
 *
 * WHY. `node --cpu-prof` profiles from start to exit, so a probe's one-time fixture build is in every
 * profile. At 20,000 elements with 2,000 reps that is ~5% and harmless. At 200,000 elements with 120
 * reps it INVERTS the ranking: item 1362's first 200k run put `getVertexById`, `indexEdgeLabel`,
 * `commitElementLabels` and `getEdgeById` at the top of every shape — all of them the LOAD, none of
 * them the query — and the shape's own hot frames fell below them. The audit has hit this before
 * ("windowed past the fixture build — the load is 4s of a 5.8s profile and swamped [the rest]").
 *
 * Raising reps is not the fix: it makes the build a smaller fraction but costs time quadratically in
 * the thing being swept, and the whole point of the sweep is to reach sizes where that is expensive.
 *
 * So: drive the profiler through `node:inspector` and start it AFTER the fixture is built.
 *
 *     import { profileWindow } from './windowed-profile.mjs';
 *     const g = build();                                   // NOT profiled
 *     const out = await profileWindow(process.env.PROF_OUT, () => {
 *       for (let i = 0; i < REPS; i += 1) { sink += run(g); }
 *       return sink;
 *     });
 *
 * The file it writes is an ordinary `.cpuprofile` that `runtime-profile-analyze.mjs` reads unchanged.
 * With no path given it just runs the body, so a probe works with or without windowing.
 */
import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';

/**
 * Run `body` with the CPU profiler active, writing the profile to `outPath`.
 *
 * `interval` is microseconds per sample, matching `--cpu-prof-interval`. The default 1000 (1 kHz) is
 * Node's own, kept so a windowed profile and a whole-process one are comparable.
 */
export const profileWindow = async (outPath, body, interval = 1000) => {
  if (outPath === undefined || outPath === '') {
    return body();
  }

  const session = new Session();

  session.connect();

  const post = (method, params) =>
    new Promise((resolve, reject) => {
      session.post(method, params, (err, res) => (err ? reject(err) : resolve(res)));
    });

  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval });
  await post('Profiler.start');

  // NOT a try/finally that throws: a `throw` inside `finally` OVERWRITES whatever the body was
  // doing, so a probe that failed mid-window would surface as "captured no samples" and the real
  // error would be lost. Stop the profiler either way, then re-raise the body's error FIRST.
  let result;
  let bodyError;

  try {
    result = body();
  } catch (err) {
    bodyError = err;
  }

  const { profile } = await post('Profiler.stop');

  session.disconnect();

  if (bodyError !== undefined) {
    // A caught value is `unknown`, so it is wrapped rather than rethrown bare — `only-throw-error`
    // is right that a non-Error throw loses the stack.
    throw bodyError instanceof Error
      ? bodyError
      : new Error('profile window body threw a non-Error', { cause: bodyError });
  }

  // ASSERTED, not written and trusted: a window that captured no samples would produce a profile of
  // nothing and read as "every frame is cold", which is the failure this helper exists to stop.
  if (!Array.isArray(profile?.samples) || profile.samples.length === 0) {
    throw new Error(`profile window captured NO samples — ${outPath} would be of nothing`);
  }

  writeFileSync(outPath, JSON.stringify(profile), 'utf8');

  return result;
};
