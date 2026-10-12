import { Worker } from 'node:worker_threads';
import { DocumentError } from './storage.mjs';

/** One persistent PDF worker keeps PDFKit's CPU work off the HTTP event loop.
 * Waiting and active work are bounded; durable callers retry a rejected job. */
export function createPdfRenderer({ workerUrl = new URL('./render-worker.mjs', import.meta.url), maxQueued = 32, timeoutMs = 45000 } = {}) {
  if (!Number.isInteger(maxQueued) || maxQueued < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Ogiltiga gränser för PDF-renderaren.');
  const queue = [];
  let worker, active, nextId = 0, closed = false;
  const failure = (code = 'pdf_generation_failed') => new DocumentError(code === 'pdf_generation_busy'
    ? 'PDF-kön är full. Försök igen om en stund.'
    : code === 'pdf_generation_timeout' ? 'PDF-filen tog för lång tid att skapa. Försök igen.' : 'PDF-filen kunde inte framställas. Försök igen.', 503, code);
  function complete(job, error, pdf) {
    clearTimeout(job.timer);
    if (error) job.reject(error); else job.resolve(Buffer.from(pdf));
  }
  function abandon(current) {
    if (worker !== current) return;
    worker = undefined;
    if (active) { const job = active; active = undefined; complete(job, failure()); }
    void current.terminate().catch(() => {});
    pump();
  }
  function getWorker() {
    if (worker) return worker;
    const current = new Worker(workerUrl);
    worker = current;
    current.on('message', result => {
      if (worker !== current || !active || active.id !== result.id) return;
      const job = active; active = undefined;
      complete(job, result.failed || !(result.pdf instanceof Uint8Array) ? failure() : undefined, result.pdf);
      pump();
    });
    current.on('error', () => abandon(current));
    current.on('exit', () => abandon(current));
    return current;
  }
  function pump() {
    if (closed || active) return;
    const job = queue.shift();
    if (!job) { worker?.unref(); return; }
    active = job;
    try { const current = getWorker(); current.ref(); current.postMessage({ id: job.id, snapshot: job.snapshot }); }
    catch { if (worker) abandon(worker); else { active = undefined; complete(job, failure()); pump(); } }
  }
  function render(snapshot) {
    if (closed) return Promise.reject(failure());
    if (active && queue.length >= maxQueued) return Promise.reject(failure('pdf_generation_busy'));
    const frozen = structuredClone(snapshot);
    return new Promise((resolve, reject) => {
      const job = { id: ++nextId, snapshot: frozen, resolve, reject, timer: undefined };
      job.timer = setTimeout(() => {
        const error = failure('pdf_generation_timeout');
        if (active === job) {
          active = undefined; const previous = worker; worker = undefined;
          complete(job, error); if (previous) void previous.terminate().catch(() => {}); pump();
        } else {
          const index = queue.indexOf(job);
          if (index >= 0) { queue.splice(index, 1); complete(job, error); }
        }
      }, timeoutMs);
      queue.push(job); pump();
    });
  }
  async function close() {
    if (closed) return;
    closed = true;
    if (active) { complete(active, failure()); active = undefined; }
    for (const job of queue.splice(0)) complete(job, failure());
    const previous = worker; worker = undefined;
    if (previous) await previous.terminate();
  }
  return { render, close };
}

const renderer = createPdfRenderer();
export const renderPdf = snapshot => renderer.render(snapshot);
export const closePdfRenderer = () => renderer.close();
