import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDeploymentProfile } from './deployment-profile.mjs';

const pilot = { SCRAPPLANNER_DEPLOYMENT_MODE: 'pilot', DATABASE_URL: 'postgresql://fixture.invalid/pilot', SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: 'private-bootstrap-fixture-only' };

test('existing deployments retain demo behavior until pilot is explicitly selected', () => {
  assert.equal(readDeploymentProfile({ NODE_ENV: 'production' }).mode, 'demo');
  assert.equal(readDeploymentProfile({}).pilot, false);
  assert.throws(() => readDeploymentProfile({ SCRAPPLANNER_DEPLOYMENT_MODE: 'piolt' }), /SCRAPPLANNER_DEPLOYMENT_MODE/);
});
test('pilot refuses missing or non-PostgreSQL storage and unusable admin secrets', () => {
  for (const database of [undefined, '', 'sqlite://local/pilot', 'https://example.com/database'])
    assert.throws(() => readDeploymentProfile({ ...pilot, DATABASE_URL: database }), /PostgreSQL/);
  for (const password of [undefined, '', 'short', 'x'.repeat(201)])
    assert.throws(() => readDeploymentProfile({ ...pilot, SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: password }), /PLATFORM_ADMIN_PASSWORD/);
});
test('pilot public origins cannot contain credentials, insecure protocols or paths', () => {
  for (const key of ['APP_URL', 'MOBILE_URL']) {
    for (const url of ['http://example.com', 'javascript:alert(1)', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?redirect=other', 'https://example.com/#fragment'])
      assert.throws(() => readDeploymentProfile({ ...pilot, [key]: url }), /HTTPS/);
  }
  assert.throws(() => readDeploymentProfile({ ...pilot, MOBILE_URL: 'https://app.scrapplanner.com' }), /olika/);
  assert.deepEqual(readDeploymentProfile(pilot), { mode: 'pilot', pilot: true, appOrigin: 'https://app.scrapplanner.com', mobileOrigin: 'https://mobile.scrapplanner.com' });
});
