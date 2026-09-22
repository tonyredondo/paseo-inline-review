type Timer = ReturnType<typeof setTimeout>;

/** Idle fallback that quickly checks after activity, then backs off to one minute. */
export function createAdaptiveSweep({
  run,
  minimumMs = 2_500,
  maximumMs = 60_000,
  schedule = (callback: () => void, delay: number) => setTimeout(callback, delay),
  cancel = (timer: Timer) => clearTimeout(timer),
}: {
  run(): void;
  minimumMs?: number;
  maximumMs?: number;
  schedule?: (callback: () => void, delay: number) => Timer;
  cancel?: (timer: Timer) => void;
}) {
  let timer: Timer | null = null;
  let delay = minimumMs;
  let stopped = false;

  function arm(): void {
    if (stopped || timer) return;
    timer = schedule(() => {
      timer = null;
      if (stopped) return;
      run();
      delay = Math.min(maximumMs, delay * 2);
      arm();
    }, delay);
  }

  return {
    start(): void { arm(); },
    wake(): void {
      if (stopped) return;
      delay = minimumMs;
      if (timer) cancel(timer);
      timer = null;
      arm();
    },
    stop(): void {
      stopped = true;
      if (timer) cancel(timer);
      timer = null;
    },
    diagnostics: () => ({ scheduled: timer !== null, delay, stopped }),
  };
}
