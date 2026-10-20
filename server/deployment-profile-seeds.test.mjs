import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialAdminProfileForDeployment } from './deployment-profile-seeds.mjs';

test('requested owner profile is confined to the named existing deployment', () => {
  const env = { RENDER_SERVICE_ID: 'srv-dbba71yf3r2c7384cm7g', SCRAPPLANNER_DEPLOYMENT_MODE: 'pilot', APP_URL: 'https://app.scrapplanner.com' };
  const seed = initialAdminProfileForDeployment(env);
  assert.equal(seed.id, 'platform-admin'); assert.equal(seed.email, 'nicklas@endorgroup.se');
  for (const changed of [{ RENDER_SERVICE_ID: 'another-service' }, { RENDER_SERVICE_ID: undefined },
    { APP_URL: 'https://other.example.test' }, { APP_URL: undefined }, { SCRAPPLANNER_DEPLOYMENT_MODE: 'demo' }])
    assert.equal(initialAdminProfileForDeployment({ ...env, ...changed }), undefined);
  assert.equal(initialAdminProfileForDeployment({}), undefined);
  // Each caller receives its own data; one seed cannot modify another instance.
  seed.email = 'someone-else@example.test';
  assert.equal(initialAdminProfileForDeployment(env).email, 'nicklas@endorgroup.se');
});
