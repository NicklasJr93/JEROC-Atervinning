import { parentPort } from 'node:worker_threads';
import { renderPdf } from './render.mjs';

parentPort.on('message', async ({ id, snapshot, options }) => {
  try {
    const pdf = Uint8Array.from(await renderPdf(snapshot, options));
    parentPort.postMessage({ id, pdf }, [pdf.buffer]);
  } catch {
    // Keep business content and local file paths out of the worker protocol.
    parentPort.postMessage({ id, failed: true });
  }
});
