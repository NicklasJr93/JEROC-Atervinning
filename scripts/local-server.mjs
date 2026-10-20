import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function supportsLocalRuntime(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return Boolean(match && Number(match[1]) === 24 && Number(match[2]) >= 19);
}

export function requireLocalRuntime() {
  if (!supportsLocalRuntime()) {
    throw new Error(`ScrapPlanner behöver Node.js 24 LTS, minst 24.19.0 och lägre än 25. Du har ${process.versions.node}.`);
  }
}

export async function portAvailable(port) {
  return new Promise(accept => {
    const server = createServer();
    server.once('error', () => accept(false));
    server.listen(port, '0.0.0.0', () => server.close(() => accept(true)));
  });
}

/** Start the built web app and its API as one owned process. IPC identifies
 * this child before HTTP readiness is checked, so another service on the same
 * port cannot be mistaken for our backend. Never inspect branded HTML here. */
export function startLocalServer({ root, port, env = process.env, timeoutMs = 30000,
  signal, stdio = 'inherit', entry = 'server/index.mjs' }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Den lokala porten måste vara ett heltal mellan 0 och 65535.');
  const child = spawn(process.execPath, [resolve(root, entry)], {
    cwd: root,
    env: { ...env, PORT: String(port), EXPO_GO_ENABLED: 'false' },
    stdio: ['ignore', stdio, stdio, 'ipc'],
  });
  let ended = false, stopping, readySettled = false;
  const exited = new Promise(accept => {
    child.once('exit', () => { ended = true; accept(); });
    child.once('error', () => { ended = true; accept(); });
  });
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (ended) return;
      child.kill('SIGTERM');
      const force = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 5000);
      force.unref();
      try { await exited; } finally { clearTimeout(force); }
    })();
    return stopping;
  }
  const ready = new Promise((accept, reject) => {
    const timeout = setTimeout(() => fail(new Error('Appens databas och API blev inte redo i tid. Läs serverns felmeddelande.')), timeoutMs);
    const aborted = () => fail(new Error('Appstarten avbröts.'));
    const failed = error => fail(new Error(`Servern kunde inte starta: ${error.message}`));
    const closed = () => fail(new Error('Servern stannade innan appen blev redo.'));
    function cleanup() {
      clearTimeout(timeout);
      child.removeListener('error', failed);
      child.removeListener('exit', closed);
      child.removeListener('message', listening);
      signal?.removeEventListener('abort', aborted);
    }
    function fail(error) {
      if (readySettled) return;
      readySettled = true;
      cleanup();
      reject(error);
      void stop();
    }
    async function listening(message) {
      if (!message || message.type !== 'scrapplanner:ready' || !Number.isInteger(message.port)
        || message.port <= 0 || message.port > 65535 || port !== 0 && message.port !== port) return;
      child.removeListener('message', listening);
      const url = `http://127.0.0.1:${message.port}`;
      while (!readySettled && !ended && !stopping) {
        try {
          const response = await fetch(`${url}/readyz`, { redirect: 'error', signal: AbortSignal.timeout(1000) });
          if (response.ok && response.headers.get('content-type')?.includes('application/json')
            && (await response.json()).status === 'ready' && !ended && !readySettled && !stopping) {
            readySettled = true;
            cleanup();
            accept({ url, port: message.port });
            return;
          }
        } catch { /* Wait while this owned process opens its database. */ }
        await delay(100);
      }
    }
    child.once('error', failed);
    child.once('exit', closed);
    child.on('message', listening);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
  return { child, ready, stop };
}
