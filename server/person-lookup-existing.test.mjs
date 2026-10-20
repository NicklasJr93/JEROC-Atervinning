import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasExistingPersonLookupCustomer } from './person-lookup-existing.mjs';

test('existing personal identities suppress provider calls without confusing explicit centuries or companies', () => {
  const state = { office: { customers: [{ number: '19900101-0017' }, { number: '5593593626' }] } };
  assert.equal(hasExistingPersonLookupCustomer(state, '199001010017'), true);
  assert.equal(hasExistingPersonLookupCustomer(state, '209001010017'), false);
  assert.equal(hasExistingPersonLookupCustomer(state, '5593593626'), false);
  assert.equal(hasExistingPersonLookupCustomer(state, '199001010018'), false);
  assert.equal(hasExistingPersonLookupCustomer({}, '199001010017'), false);
  state.office.customers[0].number = '900101-0017';
  assert.equal(hasExistingPersonLookupCustomer(state, '199001010017'), true);
  assert.equal(hasExistingPersonLookupCustomer(state, '209001010017'), true);
});
