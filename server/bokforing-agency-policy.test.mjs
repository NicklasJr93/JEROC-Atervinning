import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgencyState, inviteMember, acceptInvitation, hasPermission } from '../public/bokforing/suite/agency.js';
import { requiredPermissions, neededViews, canView, isReadAction } from '../public/bokforing/suite/agency-policy.js';

function withJenny(permissions) {
  let state = createAgencyState();
  const personalNumber = state.users.find(user => user.id === 'user-jenny').personalNumber;
  state = inviteMember(state, { actorId: 'user-ake', companyId: 'company-ake', personalNumber, permissions });
  state = acceptInvitation(state, { actorId: 'user-jenny', invitationId: state.invitations.at(-1).id });
  return state;
}
const allowed = (state, query) => requiredPermissions(query).every(permission => hasPermission(state, 'user-jenny', 'company-ake', permission));
const set = values => new Set(values);

test('read-only reviewer can view accounting but cannot render payroll or closing workspaces', () => {
  const state = withJenny(['read']);
  for (const view of ['overview', 'sales', 'purchases', 'ledger', 'reports', 'bank']) assert.equal(canView(state, 'user-jenny', 'company-ake', view), true, view);
  for (const view of ['payroll', 'payroll-v2', 'close', 'year-end', 'declarations']) assert.equal(canView(state, 'user-jenny', 'company-ake', view), false, view);
  assert.equal(canView(state, 'user-jenny', 'company-bjork', 'sales'), false);
  assert.equal(canView(state, 'user-jenny', null, 'agency'), true);
  assert.equal(canView(state, 'unknown', null, 'agency'), false);
  assert.equal(canView(state, 'user-jenny', 'company-ake', 'future-admin-page'), false);
});

test('bookkeeping does not imply payroll, payment registration, exports or company management', () => {
  const state = withJenny(['bookkeeping']);
  for (const action of ['new-invoice', 'issue-invoice', 'book-bill', 'manual-entry', 'document-upload']) assert.equal(allowed(state, { view: 'sales', action }), true, action);
  for (const action of ['invoice-payment', 'bill-payment', 'book-bank', 'export-ledger', 'export-review', 'reset', 'company', 'new-employee']) assert.equal(allowed(state, { view: 'sales', action }), false, action);
});

test('payroll access can calculate and post wages but cannot record payments without payment scope', () => {
  const state = withJenny(['payroll']);
  assert.equal(canView(state, 'user-jenny', 'company-ake', 'payroll-v2'), true);
  for (const action of ['profile', 'create', 'post', 'reverse', 'vacation-year', 'annual-contribution-review']) assert.equal(allowed(state, { feature: 'payroll-v2', action }), true, action);
  for (const action of ['pay', 'settle-tax', 'recovery-payment', 'recovery-tax', 'annual-contribution-settle']) assert.equal(allowed(state, { feature: 'payroll-v2', action }), false, action);
  assert.equal(allowed(withJenny(['payroll', 'payments']), { feature: 'payroll-v2', action: 'pay' }), true);
  assert.equal(allowed(withJenny(['payments']), { feature: 'payroll-v2', action: 'pay' }), false);
});

test('tax declaration and ROT decisions are separate from bank movement', () => {
  const state = withJenny(['closing']);
  for (const action of ['file-vat', 'post-tax', 'prepare-rot', 'decide-rot', 'reverse-tax']) assert.equal(allowed(state, { feature: 'tax-v2', action }), true, action);
  for (const action of ['settle-vat', 'receive-rot', 'repay-rot', 'repay-corrected-rot']) assert.equal(allowed(state, { feature: 'tax-v2', action }), false, action);
  assert.equal(allowed(withJenny(['closing', 'payments']), { feature: 'tax-v2', action: 'repay-rot' }), true);
});

test('payment privilege cannot create credits, change payroll or grant more rights', () => {
  const state = withJenny(['payments']);
  assert.equal(allowed(state, { feature: 'settlements', action: 'refund' }), true);
  assert.equal(allowed(state, { feature: 'fx', action: 'pay' }), true);
  assert.equal(allowed(state, { feature: 'cash', action: 'payment' }), true);
  for (const [feature, action] of [['settlements', 'credit'], ['fx', 'credit'], ['cash', 'issue'], ['cash', 'start-cash'], ['payroll-v2', 'pay']]) assert.equal(allowed(state, { feature, action }), false, `${feature}/${action}`);
});

test('archive and full-state downloads require payroll and closing in addition to export', () => {
  assert.deepEqual(set(requiredPermissions({ action: 'export-review' })), set(['read', 'payroll', 'closing', 'export']));
  assert.deepEqual(set(requiredPermissions({ feature: 'year-end', action: 'export-year' })), set(['read', 'payroll', 'closing', 'export']));
  assert.deepEqual(set(requiredPermissions({ feature: 'declarations', action: 'export' })), set(['read', 'payroll', 'closing', 'export']));
  const state = withJenny(['closing', 'export']);
  assert.equal(allowed(state, { feature: 'year-end', action: 'calculate-tax' }), true);
  assert.equal(allowed(state, { feature: 'year-end', action: 'export-year' }), false);
  assert.equal(allowed(state, { action: 'export-review' }), false);
});

test('ordinary read does not include printing or file downloads', () => {
  const state = withJenny(['read']);
  for (const action of ['print-invoice', 'download-document', 'export-reports', 'export-ledger']) assert.equal(allowed(state, { action }), false);
  for (const feature of ['fx', 'cash']) assert.equal(allowed(state, { feature, action: 'print' }), false);
  for (const action of ['export', 'receipt']) assert.equal(allowed(state, { feature: 'sie', action }), false);
  assert.equal(allowed(state, { action: 'show-invoice' }), true);
  assert.equal(allowed(withJenny(['export']), { action: 'print-invoice' }), true);
});

test('unknown actions, missing generic feature context and unknown views fail closed', () => {
  for (const query of [{ action: 'new-super-admin' }, { action: 'pay' }, { form: 'confirm-action' }, { feature: 'new-feature', action: 'export', isDownload: true }, { feature: 'payroll-v2', action: 'new-write' }, { feature: 'payroll-v2', action: 'toString' }, { feature: '__proto__', action: 'export' }, { view: '__proto__' }, { view: 'invented' }, {}]) {
    assert.deepEqual(requiredPermissions(query), ['manage'], JSON.stringify(query));
    assert.equal(allowed(withJenny(['bookkeeping', 'payroll', 'closing', 'payments', 'export']), query), false);
  }
  assert.deepEqual(neededViews('invented'), ['manage']);
  assert.deepEqual(neededViews('__proto__'), ['manage']);
});

test('local form and page defaults still enforce their correct permission scope', () => {
  assert.deepEqual(requiredPermissions({ form: 'employee' }), ['read', 'payroll']);
  assert.deepEqual(requiredPermissions({ form: 'company' }), ['manage']);
  assert.deepEqual(requiredPermissions({ form: 'invoice-page' }), ['read', 'bookkeeping']);
  for (const form of ['document-picker', 'link-document', 'purchase-book']) assert.deepEqual(requiredPermissions({ form }), ['read', 'bookkeeping']);
  assert.deepEqual(requiredPermissions({ view: 'purchases' }), ['read', 'bookkeeping']);
  assert.deepEqual(requiredPermissions({ view: 'bank' }), ['read', 'payments']);
  assert.deepEqual(requiredPermissions({ view: 'year-end' }), ['read', 'closing']);
  assert.deepEqual(requiredPermissions({ feature: 'payroll-v2' }), ['read', 'payroll']);
});

test('restricted view cannot be sidestepped with a normally readable action', () => {
  const state = withJenny(['read', 'export']);
  assert.equal(allowed(state, { view: 'payroll-v2', action: 'show-entry' }), false);
  assert.equal(allowed(state, { view: 'declarations', action: 'export-reports', isDownload: true }), false);
  assert.deepEqual(set(requiredPermissions({ view: 'payroll-v2', action: 'show-entry', isDownload: true })), set(['read', 'payroll', 'export']));
});

test('all navigation exemptions exclude invoice printing and every export action', () => {
  for (const action of ['reload', 'show-invoice', 'select-inbox-document', 'document-zoom-in', 'vat-filter']) assert.equal(isReadAction(action), true);
  for (const action of ['print-invoice', 'download-document', 'export-ledger', 'export-review', 'new-invoice', 'unknown']) assert.equal(isReadAction(action), false);
});
