import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserTestEnvironment, browserTestMarker } from './test-environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function serve() {
  if (!process.send || !process.connected)
    throw new Error('Start browser tests through the isolated wrapper, not the internal serve phase.');
  const marker = browserTestMarker(process.env);
  const env = browserTestEnvironment(process.env, process.env.SCRAPPLANNER_TEST_DATA_DIR, marker.runId);
  const { createServer } = await import('vite');
  const { startLocalServer } = await import('./local-server.mjs');
  const backend = startLocalServer({ root, port: 3000, env });
  let web, finish;
  const stopped = new Promise(resolve => { finish = resolve; });
  let stopping = false;
  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    try { await web?.close(); }
    finally {
      await backend.stop();
      if (process.connected) process.disconnect();
      process.exitCode = code;
      finish();
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { void stop(); });
  process.on('message', message => { if (message?.type === 'scrapplanner-test:stop') void stop(); });
  process.once('disconnect', () => { void stop(); });
  backend.child.once('exit', code => { if (!stopping) void stop(code || 1); });
  try {
    // Readiness is acknowledged by our child over IPC and then /readyz. An
    // unrelated process on the API port can never establish this marker.
    await backend.ready;
    if (stopping) return;
    web = await createServer({ root, envDir: false, server: { host: '127.0.0.1', port: 5173, strictPort: true },
      plugins: [{ name: 'scrapplanner-disposable-test-marker', configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split('?')[0] !== '/__scrapplanner_test__/marker') return next();
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(marker));
        });
      } }] });
    await web.listen();
    console.log('Browser tests use an isolated server and disposable local databases.');
    await stopped;
  } catch (error) {
    console.error('The isolated test server could not start:', error.message);
    await stop(1);
  }
}

async function launch() {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-browser-'));
  let child;
  try {
    const env = browserTestEnvironment(process.env, directory, process.env.SCRAPPLANNER_TEST_RUN_ID);
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], {
      cwd: root, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    let termination;
    const stop = () => {
      if (termination || child.exitCode !== null || child.signalCode !== null) return;
      // IPC gives Windows the same graceful cleanup as Unix signals.
      if (child.connected) child.send({ type: 'scrapplanner-test:stop' });
      else child.kill('SIGTERM');
      termination = setTimeout(() => child.kill('SIGKILL'), 10000);
      termination.unref();
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop);
    const [code, signal] = await once(child, 'exit');
    clearTimeout(termination);
    process.exitCode = code ?? (signal ? 1 : 0);
  } finally {
    // Only remove this run's directory after its backend and Vite have exited.
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv.includes('--serve')) await serve();
else await launch();
