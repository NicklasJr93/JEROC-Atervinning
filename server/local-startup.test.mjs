import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { portAvailable, startLocalServer, supportsLocalRuntime } from '../scripts/local-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const isolatedEnv = directory => ({ PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: '',
  SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: 'Private-Local-Startup-Test-2026!', JEROC_DEMO_AUTO_SESSION: 'false',
  JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite'), JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite'),
  JEROC_ENVIRONMENT_DB_PATH: join(directory, 'environment.sqlite'), JEROC_TERMINAL_DB_PATH: join(directory, 'terminal.sqlite'),
  JEROC_DOCUMENT_DB_PATH: join(directory, 'documents.sqlite'), JEROC_ARTICLE_MEDIA_DB_PATH: join(directory, 'media.sqlite'),
  JEROC_TENANT_DATA_DIR: directory });

test('local launchers support the same verified Node 24 LTS range', () => {
  for (const version of ['24.19.0', '24.19.1', '24.20.0']) assert.equal(supportsLocalRuntime(version), true, version);
  for (const version of ['22.12.0', '22.13.0', '24.18.9', '25.0.0', '24.19.0-rc.1', 'invalid'])
    assert.equal(supportsLocalRuntime(version), false, version);
});

test('owned local server serves real web and API before becoming ready and closes cleanly', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-local-startup-'));
  const server = startLocalServer({ root, port: 0, env: isolatedEnv(directory), stdio: 'pipe', timeoutMs: 10000 });
  let output = '';
  server.child.stdout.on('data', value => { output += value; });
  server.child.stderr.on('data', value => { output += value; });
  try {
    const { url, port } = await server.ready;
    assert.ok(port > 0);
    assert.equal(await portAvailable(port), false);
    const health = await fetch(`${url}/readyz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ready' });
    const html = await fetch(url);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    const api = await fetch(`${url}/api/employee/demo-config`);
    assert.equal(api.status, 200);
    assert.match(api.headers.get('content-type'), /application\/json/);
    assert.equal((await api.json()).enabled, false);
    assert.equal((await fetch(`${url}/api/employee/session?view=bootstrap`)).status, 401);
    await server.stop();
    assert.equal(server.child.exitCode, 0, output);
    assert.equal(await portAvailable(port), true);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('another ready HTTP server cannot satisfy readiness without this child IPC', { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-foreign-startup-'));
  let requests = 0;
  const foreign = createServer((req, res) => {
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ready' }));
  });
  foreign.listen(0, '127.0.0.1');
  await once(foreign, 'listening');
  const entry = join(directory, 'not-a-server.mjs');
  await writeFile(entry, 'setInterval(() => {}, 1000);');
  const server = startLocalServer({ root, entry, port: foreign.address().port, env: { PATH: process.env.PATH },
    stdio: 'ignore', timeoutMs: 400 });
  try {
    await assert.rejects(server.ready, /blev inte redo/);
    await server.stop();
    assert.equal(requests, 0);
    assert.equal((await fetch(`http://127.0.0.1:${foreign.address().port}/readyz`)).status, 200);
  } finally {
    await server.stop();
    await new Promise(done => foreign.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});

test('readiness waits for a healthy API after the owned listening signal', { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-warming-startup-'));
  const entry = join(directory, 'warming.mjs');
  await writeFile(entry, `
    import { createServer } from 'node:http';
    let checks = 0;
    const server = createServer((req, res) => {
      checks += 1;
      if (checks === 1) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<title>JEROC · Gårdsappen</title>');
        return;
      }
      res.writeHead(checks < 3 ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: checks < 3 ? 'unavailable' : 'ready', checks }));
    });
    server.listen(0, '127.0.0.1', () => process.send({ type: 'scrapplanner:ready', port: server.address().port }));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `);
  const server = startLocalServer({ root, entry, port: 0, env: { PATH: process.env.PATH }, stdio: 'ignore', timeoutMs: 3000 });
  try {
    const { url } = await server.ready;
    assert.ok((await (await fetch(`${url}/readyz`)).json()).checks >= 4);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an interrupted start stops its owned child instead of leaving a background process', { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-aborted-startup-'));
  const entry = join(directory, 'waiting.mjs');
  await writeFile(entry, 'setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const server = startLocalServer({ root, entry, port: 0, env: { PATH: process.env.PATH },
    signal: controller.signal, stdio: 'ignore' });
  controller.abort();
  try {
    await assert.rejects(server.ready, /avbröts/);
    await server.stop();
    assert.ok(server.child.exitCode !== null || server.child.signalCode !== null);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a child that exits before readiness fails promptly', { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-exited-startup-'));
  const entry = join(directory, 'exited.mjs');
  await writeFile(entry, 'process.exit(3);');
  const server = startLocalServer({ root, entry, port: 0, env: { PATH: process.env.PATH }, stdio: 'ignore' });
  try { await assert.rejects(server.ready, /stannade innan/); }
  finally { await server.stop(); await rm(directory, { recursive: true, force: true }); }
});
