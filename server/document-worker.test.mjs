import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPdfRenderer } from './documents/render-pool.mjs';

const workerUrl = new URL('data:text/javascript,' + encodeURIComponent(`
  import { parentPort } from 'node:worker_threads';
  parentPort.on('message', ({ id, snapshot }) => {
    if (snapshot.crash) throw new Error('worker failed');
    const end = Date.now() + (snapshot.blockFor || 0);
    while (Date.now() < end) {}
    const pdf = new TextEncoder().encode('%PDF-1.4\\n' + snapshot.name + '\\n%%EOF');
    parentPort.postMessage({ id, pdf }, [pdf.buffer]);
  });
`));

test('PDF worker freezes its input while CPU work leaves the HTTP event loop responsive', async () => {
  const renderer = createPdfRenderer({ workerUrl });
  try {
    const snapshot = { name: 'frozen-original', blockFor: 200 };
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const pending = renderer.render(snapshot);
    snapshot.name = 'changed-after-enqueue';
    const pdf = await pending;
    clearInterval(timer);
    assert.ok(ticks >= 5, `The main event loop only ran ${ticks} timer ticks during CPU rendering`);
    assert.match(pdf.toString(), /frozen-original/); assert.doesNotMatch(pdf.toString(), /changed-after-enqueue/);
  } finally { await renderer.close(); }
});

test('PDF queue has a hard bound rather than accumulating unbounded snapshots', async () => {
  const renderer = createPdfRenderer({ workerUrl, maxQueued: 0 });
  try {
    const first = renderer.render({ name: 'first', blockFor: 100 });
    await assert.rejects(renderer.render({ name: 'excess' }), error => error.status === 503 && error.code === 'pdf_generation_busy');
    assert.match((await first).toString(), /first/);
  } finally { await renderer.close(); }
});

test('timed-out and crashed PDF workers reject one job and recover for the next durable retry', async () => {
  const renderer = createPdfRenderer({ workerUrl, timeoutMs: 250 });
  try {
    await assert.rejects(renderer.render({ name: 'slow', blockFor: 1000 }), error => error.code === 'pdf_generation_timeout');
    assert.match((await renderer.render({ name: 'after-timeout' })).toString(), /after-timeout/);
    await assert.rejects(renderer.render({ crash: true }), error => error.code === 'pdf_generation_failed');
    assert.match((await renderer.render({ name: 'after-crash' })).toString(), /after-crash/);
  } finally { await renderer.close(); }
});

test('real background worker produces a native PDF from a prepared immutable settlement', async () => {
  const renderer = createPdfRenderer();
  try {
    const pdf = await renderer.render({ type: 'settlement', status: 'preliminary', id: 'AV-WORKER-1', version: 1,
      company: { name: 'JEROC Återvinning AB' }, customer: { name: 'Testkund' },
      rows: [{ name: 'Koppar klass 1', weight: 10, price: 50, amount: 500 }], totalWeight: 10, gross: 500, net: 500 });
    assert.ok(Buffer.isBuffer(pdf)); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 595\.28 841\.89\]/);
  } finally { await renderer.close(); }
});
