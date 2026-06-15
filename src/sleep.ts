/**
 * Abort-aware sleep. Resolves after `ms` milliseconds, or rejects immediately
 * if the (optional) signal is or becomes aborted. PLAN §5 requires that every
 * pause in the typing/poll loop route through a single abortable sleep so a
 * cancel or timeout interrupts mid-type.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error("aborted");
}
