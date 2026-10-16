import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { test } from 'node:test';
import { initialApplicationState } from './application.mjs';
import { ensurePersonnel } from './personnel.mjs';
import { ensureLogistics } from './logistics.mjs';
import { ensurePortalDemoAccounts, portalDemoConfig, portalDemoAccountAllowed } from './portal-demo.mjs';

const env = { SCRAPPILOT_ORGANISATION_ID: 'jeroc-demo' };
const fixtures = [
  { kind: 'driver', username: 'demo.chauffor', password: 'ChaufforDemo2026!', subject: 'person-oskar' },
  { kind: 'carrier', username: 'demo.akeri', password: 'AkeriDemo2026!', subject: 'carrier-roslagen' },
  { kind: 'customer', username: 'demo.kund', password: 'KundDemo2026!', subject: 'customer-build' },
];
const idFor = kind => `portal-demo-${kind}-v1`;
const accounts = (state, kind) => kind === 'driver' ? state.personnelAuth.accounts : state.logisticsAuth.accounts;
const accountFor = (state, kind) => accounts(state, kind).find(account => account.id === idFor(kind));
const subjectFor = (state, kind) => kind === 'driver'
  ? state.personnel.people.find(person => person.id === 'person-oskar')
  : kind === 'carrier' ? state.personnel.companies.find(company => company.id === 'carrier-roslagen')
    : state.office.customers.find(customer => customer.id === 'customer-build');
function stateForDemo() {
  const state = initialApplicationState();
  const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }];
  ensurePersonnel(state, sites); ensureLogistics(state, { sites });
  return state;
}

test('original JEROC fixtures seed three separate portal accounts with public demo credentials and private stored hashes', () => {
  for (const configuration of [{}, env]) {
    const state = stateForDemo(); ensurePortalDemoAccounts(state, configuration);
    assert.equal(state.metadata.portalDemoSeedVersion, 1);
    for (const expected of fixtures) {
      const account = accountFor(state, expected.kind);
      assert.ok(account, expected.kind); assert.equal(account.demoFixture, 'portal-demo-v1');
      assert.equal(account.username, expected.username); assert.equal(account.active, true);
      assert.equal(expected.kind === 'driver' ? account.personId : account.subjectId, expected.subject);
      if (expected.kind !== 'driver') assert.equal(account.kind, expected.kind);
      assert.equal(scryptSync(expected.password, account.password.salt, 64).toString('hex'), account.password.digest);
      assert.equal(JSON.stringify(account).includes(expected.password), false);
      const config = portalDemoConfig(state, expected.kind, configuration);
      assert.equal(config.companyId, 'jeroc-demo'); assert.equal(config.companyName, 'JEROC Återvinning AB');
      assert.equal(config.enabled, true); assert.equal(config.accounts.length, 1);
      assert.deepEqual(Object.keys(config.accounts[0]).sort(), ['id', 'label', 'password', 'username']);
      assert.equal(config.accounts[0].id, idFor(expected.kind)); assert.ok(config.accounts[0].label);
      assert.equal(config.accounts[0].username, expected.username); assert.equal(config.accounts[0].password, expected.password);
      assert.equal(portalDemoAccountAllowed(state, expected.kind, account, configuration), true);
    }
  }
});

test('portal demo config is read-only before and after seeding and returns independent public values', () => {
  const state = stateForDemo(), unseeded = JSON.stringify(state);
  for (const { kind } of fixtures) {
    const config = portalDemoConfig(state, kind, env);
    assert.equal(config.enabled, false); assert.deepEqual(config.accounts, []);
  }
  assert.equal(JSON.stringify(state), unseeded, 'Reading config must not initialize accounts or a seed marker');
  ensurePortalDemoAccounts(state, env); const seeded = JSON.stringify(state);
  for (const { kind } of fixtures) {
    const config = portalDemoConfig(state, kind, env);
    config.accounts[0].username = 'changed-public-copy'; config.accounts.push({ id: 'extra' });
    portalDemoAccountAllowed(state, kind, accountFor(state, kind), env);
    assert.notEqual(portalDemoConfig(state, kind, env).accounts[0].username, 'changed-public-copy');
  }
  assert.equal(JSON.stringify(state), seeded);
});

test('incidental fixture edits retain demo access while replacing a synthetic identity email hides its credentials', () => {
  const state = stateForDemo(), driver = subjectFor(state, 'driver'), carrier = subjectFor(state, 'carrier'), customer = subjectFor(state, 'customer');
  Object.assign(driver, { revision: 7, phone: '0709990000', address: 'Updated demo driver address', vehicleId: 'another-demo-vehicle', siteIds: ['norrtalje', 'rimbo'] });
  Object.assign(state.transport.drivers.find(value => value.id === 'oskar'), { name: 'Oskar Lind', color: '#654321', vehicleId: 'another-demo-vehicle' });
  Object.assign(customer, { number: '5560000167', vatRegistered: true, address: 'Updated demo customer address', phone: '0709990001',
    references: ['Updated test reference'], audit: [{ at: '2026-10-16T10:00:00Z', text: 'Fixture customer updated' }], revision: 3 });
  Object.assign(carrier, { number: '5560000167', phone: '0709990002', contact: 'Updated demo contact' });
  const identities = structuredClone({ driver, carrier, customer });
  ensurePortalDemoAccounts(state, env);
  for (const expected of fixtures) {
    assert.equal(portalDemoConfig(state, expected.kind, env).enabled, true, expected.kind);
    assert.equal(portalDemoConfig(state, expected.kind, env).accounts[0].username, expected.username);
    assert.equal(portalDemoAccountAllowed(state, expected.kind, accountFor(state, expected.kind), env), true);
    assert.deepEqual(subjectFor(state, expected.kind), identities[expected.kind], 'Seeding preserves incidental subject edits');
    const customized = structuredClone(state);
    subjectFor(customized, expected.kind).email = 'contact@realbusiness.se';
    assert.equal(portalDemoConfig(customized, expected.kind, env).enabled, false, expected.kind);
    assert.deepEqual(portalDemoConfig(customized, expected.kind, env).accounts, []);
    assert.equal(portalDemoAccountAllowed(customized, expected.kind, accountFor(customized, expected.kind), env), false);
  }
  assert.deepEqual(accountFor(state, 'driver').siteIds, ['norrtalje', 'rimbo']);
});

test('missing original subjects, a foreign tenant or the disabled demo flag never seed public accounts', () => {
  const cases = [
    { configuration: { ...env, JEROC_DEMO_AUTO_SESSION: 'false' } },
    { configuration: { SCRAPPILOT_ORGANISATION_ID: 'another-company' } },
    { configuration: { ...env, JEROC_TENANT_ID: 'another-company' } },
    { configuration: {}, change: state => { state.metadata.organisation = { id: 'another-company', name: 'Another company' }; } },
    ...['pricingSeed', 'officeSeed', 'transportSeed'].map(key => ({ configuration: env, change: state => { delete state.metadata[key]; } })),
    { configuration: env, change: state => {
      state.personnel.people = state.personnel.people.filter(person => person.id !== 'person-oskar');
      state.personnel.companies = state.personnel.companies.filter(company => company.id !== 'carrier-roslagen');
      state.office.customers = state.office.customers.filter(customer => customer.id !== 'customer-build');
    } },
  ];
  for (const { configuration, change } of cases) {
    const state = stateForDemo(); change?.(state); ensurePortalDemoAccounts(state, configuration);
    assert.equal(state.personnelAuth.accounts.length, 0); assert.equal(state.logisticsAuth.accounts.length, 0);
    for (const { kind } of fixtures) {
      const config = portalDemoConfig(state, kind, configuration);
      assert.equal(config.enabled, false); assert.deepEqual(config.accounts, []);
    }
  }
});

test('portal demo initialization preserves hashes and its one-time marker prevents deleted accounts from returning', () => {
  const state = stateForDemo(); ensurePortalDemoAccounts(state, env);
  const first = JSON.stringify(state); ensurePortalDemoAccounts(state, env); ensurePortalDemoAccounts(state, env);
  assert.equal(JSON.stringify(state), first, 'Repeated startup must not rotate hashes or rewrite seeded accounts');
  for (const { kind } of fixtures) {
    const collection = accounts(state, kind), index = collection.findIndex(account => account.id === idFor(kind));
    collection.splice(index, 1);
  }
  ensurePortalDemoAccounts(state, env);
  assert.equal(state.metadata.portalDemoSeedVersion, 1);
  for (const { kind } of fixtures) {
    assert.equal(accountFor(state, kind), undefined); assert.deepEqual(portalDemoConfig(state, kind, env).accounts, []);
  }
});

test('existing subject and username accounts retain their credentials and never become public demo entries', () => {
  for (const expected of fixtures) for (const conflict of ['subject', 'username']) {
    const state = stateForDemo();
    const existing = { id: `custom-${expected.kind}`, username: conflict === 'username' ? expected.username : 'private.user', active: true,
      password: { salt: 'private-salt', digest: 'private-existing-hash' },
      ...(expected.kind === 'driver' ? { personId: conflict === 'subject' ? expected.subject : 'private-person' }
        : { kind: expected.kind, subjectId: conflict === 'subject' ? expected.subject : 'private-subject' }) };
    accounts(state, expected.kind).push(existing); const before = structuredClone(existing);
    ensurePortalDemoAccounts(state, env);
    assert.deepEqual(accounts(state, expected.kind).find(account => account.id === existing.id), before, `${expected.kind}/${conflict}`);
    assert.equal(accountFor(state, expected.kind), undefined, `${expected.kind}/${conflict}`);
    assert.deepEqual(portalDemoConfig(state, expected.kind, env).accounts, []);
    assert.equal(portalDemoAccountAllowed(state, expected.kind, existing, env), true, 'Ordinary private accounts remain outside demo restrictions');
  }
});

test('inactive, rotated, renamed, repointed and unmarked demo accounts are hidden without restoring their public credentials', () => {
  for (const { kind } of fixtures) for (const change of ['inactive', 'rotated', 'renamed', 'repointed', 'unmarked']) {
    const state = stateForDemo(); ensurePortalDemoAccounts(state, env); const account = accountFor(state, kind);
    if (change === 'inactive') account.active = false;
    if (change === 'rotated') account.password.digest = scryptSync('Private-Rotated-Password-2026!', account.password.salt, 64).toString('hex');
    if (change === 'renamed') account.username = 'private.renamed';
    if (change === 'repointed') account[kind === 'driver' ? 'personId' : 'subjectId'] = 'another-subject';
    if (change === 'unmarked') delete account.demoFixture;
    const before = JSON.stringify(state);
    assert.deepEqual(portalDemoConfig(state, kind, env).accounts, [], `${kind}/${change}`);
    assert.equal(portalDemoConfig(state, kind, env).enabled, false, `${kind}/${change}`);
    ensurePortalDemoAccounts(state, env); assert.equal(JSON.stringify(state), before, `${kind}/${change}`);
    if (change === 'rotated') {
      assert.equal(portalDemoAccountAllowed(state, kind, account, env), true, 'Rotating a demo password permits private login while the gate stays enabled');
      assert.equal(portalDemoAccountAllowed(state, kind, account, { ...env, JEROC_DEMO_AUTO_SESSION: 'false' }), false);
    }
    if (change === 'unmarked') assert.equal(portalDemoAccountAllowed(state, kind, account, env), true);
  }
});

test('customized original subjects and missing driver links hide demo credentials and reject marked demo authentication', () => {
  for (const { kind } of fixtures) {
    const state = stateForDemo(); ensurePortalDemoAccounts(state, env);
    subjectFor(state, kind).name = 'Customized real subject';
    const before = JSON.stringify(state);
    assert.equal(portalDemoConfig(state, kind, env).enabled, false, kind);
    assert.deepEqual(portalDemoConfig(state, kind, env).accounts, []);
    assert.equal(portalDemoAccountAllowed(state, kind, accountFor(state, kind), env), false);
    assert.equal(JSON.stringify(state), before);
  }
  for (const change of [
    state => { delete state.personnel.people.find(person => person.id === 'person-oskar').driverId; },
    state => { delete state.transport.drivers.find(driver => driver.id === 'oskar').personId; },
  ]) {
    const state = stateForDemo(); ensurePortalDemoAccounts(state, env); change(state);
    assert.deepEqual(portalDemoConfig(state, 'driver', env).accounts, []);
    assert.equal(portalDemoAccountAllowed(state, 'driver', accountFor(state, 'driver'), env), false);
  }
});

test('disabling demos or changing company hides seeded credentials and prevents every marked account from authenticating', () => {
  const state = stateForDemo(); ensurePortalDemoAccounts(state, env); const before = JSON.stringify(state);
  for (const configuration of [{ ...env, JEROC_DEMO_AUTO_SESSION: 'false' }, { SCRAPPILOT_ORGANISATION_ID: 'another-company' }]) {
    for (const { kind } of fixtures) {
      assert.equal(portalDemoConfig(state, kind, configuration).enabled, false);
      assert.deepEqual(portalDemoConfig(state, kind, configuration).accounts, []);
      assert.equal(portalDemoAccountAllowed(state, kind, accountFor(state, kind), configuration), false);
    }
  }
  assert.equal(JSON.stringify(state), before);
});
