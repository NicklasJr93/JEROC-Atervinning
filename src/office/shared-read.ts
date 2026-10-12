import { currentPlatformSession } from '../platform/session';

type ReadFlight = {
  controller: AbortController;
  promise: Promise<unknown>;
  consumers: number;
  settled: boolean;
};

// Share only an in-flight read, never a saved response. Keys include the full
// principal/permission scope in each client; each consumer receives its own
// copy so editing one workspace cannot mutate another workspace's projection.
const reads = new Map<string, ReadFlight>();
const scopedReadKey = (key: string) => {
  const session = currentPlatformSession();
  return session?.authenticated ? `${session.organisationId}:${session.generation}:${key}` : key;
};

export function invalidateOfficeReads(prefix: string) {
  prefix = scopedReadKey(prefix);
  for (const key of reads.keys()) if (key.startsWith(prefix)) reads.delete(key);
}

export function sharedOfficeRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  key = scopedReadKey(key);
  if (signal?.aborted) return Promise.reject(new DOMException('Hämtningen avbröts.', 'AbortError'));
  let flight = reads.get(key);
  if (!flight) {
    const controller = new AbortController();
    const entry: ReadFlight = { controller, promise: Promise.resolve(), consumers: 0, settled: false };
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    entry.promise = Promise.resolve().then(() => load(controller.signal)).finally(() => {
      entry.settled = true;
      window.clearTimeout(timeout);
      if (reads.get(key) === entry) reads.delete(key);
    });
    reads.set(key, entry);
    flight = entry;
  }
  const active = flight;
  active.consumers += 1;
  return new Promise<T>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return false;
      released = true;
      signal?.removeEventListener('abort', abort);
      active.consumers -= 1;
      if (!active.consumers && !active.settled) {
        if (reads.get(key) === active) reads.delete(key);
        active.controller.abort();
      }
      return true;
    };
    const abort = () => { if (release()) reject(new DOMException('Hämtningen avbröts.', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    active.promise.then(
      value => {
        if (!release()) return;
        try { resolve(structuredClone(value) as T); } catch (failure) { reject(failure); }
      },
      failure => { if (release()) reject(failure); },
    );
  });
}
