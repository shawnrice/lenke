import { isTimingEnabled } from './timingEnabled.js';

export const timer = (name: string): (() => void) => {
  if (!isTimingEnabled()) {
    return () => {};
  }

  const start = performance.now();

  return () => {
    const end = performance.now();
    console.info(`[TIMER] ${name} took ${end - start}ms`);
  };
};
