// Per-key async mutex. Serializes async functions that share a key so concurrent
// requests from both household members don't interleave edits on the shared Oda
// cart (the bot is a single process, so an in-process chain is sufficient and
// reliable). Each key holds a promise chain; new work runs after the previous.
const chains = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // Run fn whether or not the previous holder resolved or rejected.
  const result = prev.then(fn, fn);
  // Keep the chain going but swallow errors so one failure can't wedge the queue.
  chains.set(
    key,
    result.then(
      () => {},
      () => {},
    ),
  );
  return result;
}
