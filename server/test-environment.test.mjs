import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { browserTestEnvironment, browserTestMarker } from '../scripts/test-environment.mjs';

test('browser startup replaces inherited production storage and strips provider credentials', () => {
  const runId = randomUUID(), directory = join(tmpdir(), 'scrapplanner-browser-test-fixture');
  const env = browserTestEnvironment({ PATH: '/fixture/bin', NODE_EXTRA_CA_CERTS: '/fixture/ca.pem',
    HTTPS_PROXY: 'http://fixture-proxy:8080', DATABASE_URL: 'postgres://production.invalid/private',
    JEROC_TEST_DATABASE_URL: 'postgres://other.invalid/private', JEROC_APPLICATION_DB_PATH: '/private/application.sqlite',
    JEROC_TENANT_DATA_DIR: '/private/tenants', SCRAPPLANNER_DEPLOYMENT_MODE: 'pilot',
    TELEMATICS_SQLITE_PATH: '/private/telematics.sqlite', TELEMATICS_DATABASE_URL: 'postgres://private.invalid/telematics',
    RENDER: 'true', RENDER_API_KEY: 'private-render', RESEND_API_KEY: 'private-resend',
    ELKS_API_USERNAME: 'private-elks', ELKS_API_PASSWORD: 'private-elks-password',
    GOOGLE_MAPS_BROWSER_API_KEY: 'private-maps', SCB_API_KEY: 'private-scb',
    ROARING_CONSUMER_SECRET: 'private-roaring', VISMA_CLIENT_SECRET: 'private-visma',
    NVV_CLIENT_PFX_BASE64: 'private-pfx', EXPO_TOKEN: 'private-expo',
    SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: 'private-admin', NODE_OPTIONS: '--require=/private/inject.cjs',
  }, directory, runId);
  assert.equal(env.PATH, '/fixture/bin'); assert.equal(env.NODE_EXTRA_CA_CERTS, '/fixture/ca.pem');
  assert.equal(env.HTTPS_PROXY, 'http://fixture-proxy:8080');
  assert.equal(env.NODE_ENV, 'test'); assert.equal(env.SCRAPPLANNER_DEPLOYMENT_MODE, 'demo');
  assert.equal(env.EXPO_GO_ENABLED, 'false'); assert.equal(env.JEROC_TENANT_DATA_DIR, directory);
  assert.equal(env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD, 'Browser-Isolation-Initial-2026!');
  assert.equal(dirname(env.TELEMATICS_SQLITE_PATH), directory);
  const paths = Object.entries(env).filter(([key]) => key.endsWith('_DB_PATH'));
  assert.equal(paths.length, 9);
  for (const [, value] of paths) assert.equal(dirname(value), directory);
  for (const key of ['DATABASE_URL', 'JEROC_TEST_DATABASE_URL', 'RENDER', 'RENDER_API_KEY',
    'RESEND_API_KEY', 'ELKS_API_USERNAME', 'ELKS_API_PASSWORD', 'GOOGLE_MAPS_BROWSER_API_KEY',
    'SCB_API_KEY', 'ROARING_CONSUMER_SECRET', 'VISMA_CLIENT_SECRET', 'NVV_CLIENT_PFX_BASE64',
    'EXPO_TOKEN', 'TELEMATICS_DATABASE_URL', 'NODE_OPTIONS']) assert.equal(env[key], undefined, key);
  assert.deepEqual(browserTestMarker(env), { kind: 'scrapplanner-browser-test', runId, disposable: true });
  assert.equal(JSON.stringify(env).includes('private-'), false);
});

test('browser test identity requires a per-run marker and an explicit isolated path', () => {
  assert.throws(() => browserTestEnvironment({}, './.data', randomUUID()), /absolute disposable/);
  assert.throws(() => browserTestEnvironment({}, tmpdir(), 'shared-marker'), /per-run marker/);
  assert.throws(() => browserTestMarker({}), /not a disposable/);
  const first = browserTestEnvironment({}, join(tmpdir(), 'browser-first'), randomUUID());
  const second = browserTestEnvironment({}, join(tmpdir(), 'browser-second'), randomUUID());
  assert.notEqual(browserTestMarker(first).runId, browserTestMarker(second).runId);
  assert.notEqual(first.JEROC_APPLICATION_DB_PATH, second.JEROC_APPLICATION_DB_PATH);
});
