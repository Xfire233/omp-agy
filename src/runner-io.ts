export function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return operationWithDeadline(ms, label, () => promise);
}

/** Scope one deadline across staging, pipe operations, and readiness. */
export async function operationWithDeadline<T>(ms: number, label: string, run: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  parent?.throwIfAborted();
  const clock = new AbortController();
  const signal = parent ? AbortSignal.any([parent, clock.signal]) : clock.signal;
  const interrupted = Promise.withResolvers<never>();
  const abort = () => interrupted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => clock.abort(new Error(label)), ms);
  try {
    // Defer invocation so even a synchronous exception is observed by the race.
    return await Promise.race([interrupted.promise, Promise.resolve().then(() => { signal.throwIfAborted(); return run(signal); })]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
