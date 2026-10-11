import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationRepository } from './application-storage.mjs';

test('a local finance read joins its in-flight review transaction without mutating it or deadlocking', { timeout: 5000 }, async () => {
  const repository = await createApplicationRepository({ env: {}, filename: ':memory:', seed: () => ({ office: { customer: { vatRegistered: false } }, vismaIntegration: { revision: 1 } }) });
  try {
    await repository.transact(async state => {
      state.office.customer.vatRegistered = true;
      const result = await repository.read(snapshot => {
        assert.equal(snapshot.office.customer.vatRegistered, true);
        assert.equal(snapshot.vismaIntegration, undefined);
        snapshot.office.customer.vatRegistered = false;
        return true;
      }, { domains: ['office'] });
      assert.equal(result, true);
      assert.equal(state.office.customer.vatRegistered, true);
      assert.equal(await repository.read(snapshot => snapshot.vismaIntegration.revision, { domains: ['vismaIntegration'] }), 1);
    });
    assert.equal(await repository.read(state => state.office.customer.vatRegistered), true);
  } finally { await repository.close(); }
});
