type Timer = ReturnType<typeof setTimeout>;

export function createStreamingTextCoalescer({
  publish,
  delayMs = 50,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(timer),
}: {
  publish(text: string): void;
  delayMs?: number;
  schedule?: (callback: () => void, delay: number) => Timer;
  cancel?: (timer: Timer) => void;
}) {
  let latest = "";
  let timer: Timer | null = null;
  let disposed = false;

  return {
    update(text: string, complete: boolean): void {
      if (disposed) return;
      latest = text;
      if (complete) {
        if (timer) cancel(timer);
        timer = null;
        publish(text);
        return;
      }
      if (timer) return;
      timer = schedule(() => {
        timer = null;
        if (!disposed) publish(latest);
      }, delayMs);
    },
    dispose(): void {
      disposed = true;
      if (timer) cancel(timer);
      timer = null;
    },
  };
}
