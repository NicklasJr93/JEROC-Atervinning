import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { startLocalServer } from '../scripts/local-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('public bookkeeping demo serves its own assets without granting office access', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-bookkeeping-http-'));
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: '',
    SCRAPPLANNER_DEPLOYMENT_MODE: 'demo', JEROC_DEMO_AUTO_SESSION: 'false',
    SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: 'Isolated-Bookkeeping-Demo-Test-2026!',
    JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite'),
    JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite'),
    JEROC_ENVIRONMENT_DB_PATH: join(directory, 'environment.sqlite'),
    JEROC_TERMINAL_DB_PATH: join(directory, 'terminal.sqlite'),
    JEROC_DOCUMENT_DB_PATH: join(directory, 'documents.sqlite'),
    JEROC_ARTICLE_MEDIA_DB_PATH: join(directory, 'media.sqlite'),
    JEROC_TENANT_DATA_DIR: directory,
  };
  const server = startLocalServer({ root, port: 0, env, stdio: 'pipe', timeoutMs: 15000 });
  try {
    const { url } = await server.ready;
    for (const path of ['/bokforing', '/bokforing/', '/bokforing?company=not-a-real-company']) {
      const response = await fetch(`${url}${path}`, { redirect: 'error' });
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.equal(response.headers.get('set-cookie'), null, 'demo must not select a tenant or allocate an authenticated session');
      const html = await response.text();
      assert.match(html, /Bokföring/i);
      assert.match(html, /\/bokforing\/app\.js/);
      assert.match(html, /\/bokforing\/styles\.css/);
    }
    for (const [path, type] of [['styles.css', /text\/css/], ['app.js', /javascript/], ['model.js', /javascript/], ['storage.js', /javascript/]]) {
      const response = await fetch(`${url}/bokforing/${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), type);
      assert.ok((await response.text()).length > 100, path);
    }
    const head = await fetch(`${url}/bokforing`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(`${url}/bokforing`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${url}/bokforing/not-a-route`)).status, 404);
    assert.equal((await fetch(`${url}/api/employee/session?view=bootstrap`)).status, 401);
    const ready = await fetch(`${url}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'ready' });
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
