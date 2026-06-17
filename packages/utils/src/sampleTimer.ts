import { isTimingEnabled } from './timingEnabled.js';

export type SampleTimer = {
  getTimer: () => () => void;
  stats: () => void;
  reset: () => void;
};

const noop = () => {};
const noopSampleTimer: SampleTimer = {
  getTimer: () => noop,
  stats: noop,
  reset: noop,
};

export const sampleTimer = (name: string): SampleTimer => {
  if (!isTimingEnabled()) {
    return noopSampleTimer;
  }

  const samples: number[] = [];

  const getTimer = () => {
    const start = performance.now();
    return () => {
      const diff = performance.now() - start;
      samples.push(diff);
      console.info(`[TIMER] ${name} took ${diff}ms`);
    };
  };

  const stats = () => {
    const n = samples.length;
    if (n === 0) {
      console.info(`[TIMER] ${name}: 0 samples`);
      return;
    }

    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const x of samples) {
      sum += x;
      if (x < min) {
        min = x;
      }
      if (x > max) {
        max = x;
      }
    }
    const mean = sum / n;

    let sqSum = 0;
    for (const x of samples) {
      sqSum += (x - mean) ** 2;
    }
    const stdDev = Math.sqrt(sqSum / n);

    const sorted = [...samples].sort((a, b) => a - b);
    const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[(n - 1) / 2];

    console.info(
      `[TIMER] ${name} ${n} samples. Mean: ${mean}, Median: ${median}, StdDev: ${stdDev}, Min: ${min}, Max: ${max}`,
    );
  };

  const reset = () => {
    samples.length = 0;
  };

  return { getTimer, stats, reset };
};
