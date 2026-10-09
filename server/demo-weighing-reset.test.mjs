import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPricingStore } from './pricing.mjs';
import { createTerminalDemoRepository, initialTerminalState,
  migrateTerminalDemoWeighings, TERMINAL_WEIGHING_DEMO_VERSION } from './terminal-demo-storage.mjs';

test('reset removes weighing snapshots and reservations but preserves terminal accounts and settings', () => {
  const state = initialTerminalState();
  delete state.weighingDemoVersion;
  state.terminals = [{ id: 'terminal-1', name: 'Bevarad terminal', password: { salt: 'salt', digest: 'hash' } }];
  state.terminalSessions = [{ tokenHash: 'device-cookie', terminalId: 'terminal-1' }];
  state.staffSessions = [{ tokenHash: 'staff-cookie', actualUserId: 'admin' }];
  state.defaults = [{ userId: 'kajsa', siteId: 'norrtalje', terminalId: 'terminal-1' }];
  state.approvals = [{ id: 'old-approval', cardId: 2041, terminalId: 'terminal-1', status: 'waiting' }];
  state.requests = [{ key: 'old-send', approvalId: 'old-approval' }];
  state.audit = [{ action: 'terminal.created', terminalId: 'terminal-1' },
    { action: 'approval.sent', cardId: 2041, approvalId: 'old-approval' }];
  const kept = structuredClone({ terminals: state.terminals, terminalSessions: state.terminalSessions,
    staffSessions: state.staffSessions, defaults: state.defaults });

  assert.equal(migrateTerminalDemoWeighings(state), true);
  assert.equal(state.weighingDemoVersion, TERMINAL_WEIGHING_DEMO_VERSION);
  assert.deepEqual(state.approvals, []);
  assert.deepEqual(state.requests, []);
  for (const [key, value] of Object.entries(kept)) assert.deepEqual(state[key], value);
  assert.equal(state.audit.some((entry) => entry.action === 'terminal.created'), true);
  assert.equal(state.audit.some((entry) => entry.action === 'approval.sent'), false);
  assert.equal(state.audit.filter((entry) => entry.action === 'demo.weighings_reset').length, 1);
  state.approvals.push({ id: 'new-approval', cardId: 2050, status: 'waiting' });
  const afterFirstReset = structuredClone(state);
  assert.equal(migrateTerminalDemoWeighings(state), false);
  assert.deepEqual(state, afterFirstReset);
});

test('one-time terminal reset persists across reopening and retains subsequent work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-reset-test-'));
  const filename = join(directory, 'terminal.sqlite');
  let repository = await createTerminalDemoRepository({ filename, env: {} });
  try {
    await repository.transact((state) => {
      delete state.weighingDemoVersion;
      state.terminals.push({ id: 'retained-terminal', name: 'Terminal 1' });
      state.approvals.push({ id: 'obsolete', cardId: 2041, status: 'waiting' });
      state.requests.push({ key: 'obsolete-send', approvalId: 'obsolete' });
    });
    const migrated = await repository.transact((state) => structuredClone(state));
    assert.equal(migrated.weighingDemoVersion, TERMINAL_WEIGHING_DEMO_VERSION);
    assert.deepEqual(migrated.approvals, []);
    assert.deepEqual(migrated.requests, []);
    await repository.transact((state) => state.approvals.push({ id: 'fresh', cardId: 2050, status: 'waiting' }));
    await repository.close();
    repository = await createTerminalDemoRepository({ filename, env: {} });
    const reopened = await repository.transact((state) => structuredClone(state));
    assert.equal(reopened.approvals[0].id, 'fresh');
    assert.equal(reopened.terminals[0].id, 'retained-terminal');
    assert.equal(reopened.audit.filter((entry) => entry.action === 'demo.weighings_reset').length, 1);
  } finally {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('fresh pricing seeds contain no completed weighings or volume and metadata excludes price data', () => {
  const store = createPricingStore({ now: () => new Date('2026-10-09T10:00:00Z') });
  const principal = store.principal('admin');
  assert.equal(store.volume('customer-build', 'copper-1', '2026-10-09'), 0);
  for (const cardId of [2038, 2039, 2040, 2041]) assert.deepEqual(store.snapshots(principal, cardId), []);
  assert.deepEqual(store.getArticleForEnvironment('lead-battery'), { id: 'lead-battery', name: 'Blybatterier', active: true });
  assert.equal(store.getArticleForEnvironment('unknown'), null);
  assert.equal(JSON.stringify(store.getArticleForEnvironment('copper-1')).includes('price'), false);
});

test('environment-only article readers receive no prices, formulas, customer data or price history', () => {
  const store = createPricingStore({ now: () => new Date('2026-10-09T10:00:00Z') });
  const admin = store.principal('admin');
  store.saveUsers({ users: [...store.read(admin).users, {
    id: 'environment-reader', name: 'Miljöläsare', level: 'Medarbetare',
    permissions: ['environmentRead'], maxAttest: 0, ownAttest: false,
  }] }, admin);
  const visible = store.read(store.principal('environment-reader'));
  assert.equal(visible.articles.length > 0, true);
  for (const article of visible.articles) {
    assert.deepEqual(article.prices, { A: null, B: null, C: null });
    assert.equal(article.baseSekKg, null);
    assert.equal(article.base, undefined);
    assert.equal(article.tiers, undefined);
  }
  for (const key of ['articleHistory', 'lme', 'customerPrices', 'customers', 'users', 'audit']) {
    assert.deepEqual(visible[key], []);
  }
  assert.equal(visible.ledger, undefined);
});
