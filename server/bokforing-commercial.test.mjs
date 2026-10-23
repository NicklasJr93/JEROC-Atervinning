import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, accountBalance, transact } from '../public/bokforing/suite/core.js';
import { createCustomer, createProject, issueInvoice, receivePayment, getInvoiceTotals } from '../public/bokforing/suite/sales.js';
import { createSuiteState } from '../public/bokforing/suite/seed.js';
import { createStockItem, recordStockMovement } from '../public/bokforing/suite/inventory.js';
import { saveArticle, saveCustomerPrice, setArticleActive, createArticleInvoice, createRecurringPlan, generateRecurringInvoices, anchoredMonthDate, prepareReminder, issueProjectStock, createRevenueSchedule, recognizeRevenueMonth, getRevenueDueMonths, addProjectWorkpaper, validateCommercialState } from '../public/bokforing/suite/commercial.js';
import { renderWorkspace, handleAction } from '../public/bokforing/suite/commercial-workspace.js';
import { closeYear } from '../public/bokforing/suite/finance.js';
import { openNextYear } from '../public/bokforing/suite/financial-years.js';
import { createCreditNote } from '../public/bokforing/suite/settlements.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

const setup = () => {
  let state = createCustomer(createEmptyState(), { name: 'Kunden AB', email: 'kund@example.invalid' });
  state = createProject(state, { name: 'Projekt A', customerId: state.customers[0].id });
  return saveArticle(state, { number: 'A100', name: 'Snickeri', kind: 'labor', unit: 'tim', unitCents: 50000, vatRate: 25 });
};
const selection = state => [{ articleId: state.commercialArticles[0].id, quantity: 2 }];
const invoice = (state, extra = {}) => createArticleInvoice(state, { customerId: state.customers[0].id, date: '2026-01-01', dueDate: '2026-01-31', items: selection(state), ...extra });
const plan = (state, extra = {}) => createRecurringPlan(state, { name: 'Månadstjänst', customerId: state.customers[0].id, startDate: '2026-01-31', intervalMonths: 1, dueDays: 30, items: selection(state), ...extra });

test('article customer price is snapshotted; later price edits do not alter invoices or plan rows', () => {
  let state = setup();
  state = saveCustomerPrice(state, { customerId: state.customers[0].id, articleId: state.commercialArticles[0].id, unitCents: 42000 });
  state = invoice(state);
  state = plan(state);
  const lines = structuredClone(state.invoices[0].lines);
  assert.equal(lines[0].unitCents, 42000);
  const article = state.commercialArticles[0];
  state = saveArticle(state, { ...article, unitCents: 60000 });
  state = saveCustomerPrice(state, { customerId: state.customers[0].id, articleId: article.id, unitCents: 45000 });
  assert.deepEqual(state.invoices[0].lines, lines);
  assert.equal(state.recurringPlans[0].lines[0].unitCents, 42000);
  assert.equal(state.commercialArticles[0].revision, 2);
  validateCommercialState(state);
});

test('duplicate articles, inactive selection and invalid customer prices are rejected atomically', () => {
  const state = setup(); const before = structuredClone(state);
  assert.throws(() => saveArticle(state, { ...state.commercialArticles[0], id: undefined, number: 'a100' }), /redan/);
  assert.throws(() => saveCustomerPrice(state, { customerId: 'unknown', articleId: state.commercialArticles[0].id, unitCents: 500 }), /finns inte/);
  assert.throws(() => invoice(setArticleActive(state, state.commercialArticles[0].id, false)), /inaktiverad/);
  assert.deepEqual(state, before);
});

test('month-end recurring drafts preserve anchor date and run idempotently', () => {
  assert.equal(anchoredMonthDate('2026-01-31', 1), '2026-02-28');
  assert.equal(anchoredMonthDate('2026-01-31', 2), '2026-03-31');
  let state = generateRecurringInvoices(plan(setup()), { asOf: '2026-03-31' });
  assert.deepEqual(state.invoices.map(item => item.date), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.ok(state.invoices.every(item => item.status === 'draft' && !item.entryId));
  state = generateRecurringInvoices(state, { asOf: '2026-03-31' });
  assert.equal(state.invoices.length, 3);
  assert.equal(state.recurringPlans[0].generated.length, 3);
  validateCommercialState(state);
});

test('generation of several periods rolls back in full when a later period is locked', () => {
  let state = plan(setup());
  state = transact(state, draft => draft.lockedPeriods.push('2026-03'));
  assert.throws(() => generateRecurringInvoices(state, { asOf: '2026-03-31' }), /låst/);
  assert.equal(state.invoices.length, 0);
  assert.equal(state.recurringPlans[0].generated.length, 0);
});

test('recurring end date and frozen definitions are enforced', () => {
  let state = generateRecurringInvoices(plan(setup(), { endDate: '2026-02-28' }), { asOf: '2026-04-30' });
  assert.equal(state.invoices.length, 2);
  state = structuredClone(state); state.recurringPlans[0].dueDays = 90;
  assert.throws(() => validateCommercialState(state), /definition/);
});

test('project stock issue is one atomic material movement with separate cost and selling price', () => {
  let state = setup();
  state = createStockItem(state, { name: 'Skruv', unit: 'st', unitCostCents: 125 });
  state = recordStockMovement(state, state.inventoryItems[0].id, { date: '2026-02-01', kind: 'in', quantity: 100, reason: 'Mottaget' });
  const payload = { projectId: state.projects[0].id, inventoryItemId: state.inventoryItems[0].id, date: '2026-02-02', quantity: 2.5, unitCents: 250, vatRate: 25, reason: 'Montage' };
  const original = structuredClone(state);
  assert.throws(() => issueProjectStock(state, { ...payload, quantity: 101 }), /överstiger/);
  assert.deepEqual(state, original);
  state = issueProjectStock(state, payload);
  assert.equal(state.inventoryItems[0].quantity, 97.5);
  assert.equal(state.projectStockLinks[0].costCents, 313);
  assert.equal(state.projects[0].items[0].unitCents, 250);
  assert.equal(state.entries.length, 0);
  validateCommercialState(state);
  state.projects[0].items[0].quantity = 20;
  assert.throws(() => validateCommercialState(state), /ändrats/);
});

test('revenue deferral preserves VAT and receivable and exact monthly rounding', () => {
  let state = invoice(setup()); state = issueInvoice(state, state.invoices[0].id);
  const vat = accountBalance(state, '2611'); const receivable = accountBalance(state, '1510');
  state = createRevenueSchedule(state, { invoiceId: state.invoices[0].id, name: 'Serviceavtal', date: '2026-01-01', amountCents: 100000, startMonth: '2026-01', months: 3 });
  assert.equal(accountBalance(state, '3000'), 0);
  assert.equal(accountBalance(state, '2990'), -100000);
  assert.throws(() => createRevenueSchedule(state, { invoiceId: state.invoices[0].id, name: 'Dubbel', date: '2026-01-01', amountCents: 1, startMonth: '2026-01', months: 1 }), /redan/);
  const id = state.revenueSchedules[0].id;
  assert.throws(() => recognizeRevenueMonth(state, id, { date: '2026-02-01' }), /2026-01/);
  for (const date of ['2026-01-31', '2026-02-28', '2026-03-31']) state = recognizeRevenueMonth(state, id, { date });
  assert.deepEqual(state.revenueSchedules[0].postings.map(item => item.amountCents), [33333, 33334, 33333]);
  assert.equal(accountBalance(state, '2990'), 0);
  assert.equal(accountBalance(state, '3000'), -100000);
  assert.equal(accountBalance(state, '2611'), vat); assert.equal(accountBalance(state, '1510'), receivable);
  assert.equal(state.revenueSchedules[0].status, 'completed');
  assert.throws(() => recognizeRevenueMonth(state, id, { date: '2026-04-30' }), /färdig/);
  validateCommercialState(state);
});

test('a one-cent deferral uses zero-posting months without zero-valued journals', () => {
  let state = invoice(setup()); state = issueInvoice(state, state.invoices[0].id);
  state = createRevenueSchedule(state, { invoiceId: state.invoices[0].id, name: 'Öresplan', date: '2026-01-01', amountCents: 1, startMonth: '2026-01', months: 3 });
  const id = state.revenueSchedules[0].id;
  for (const date of ['2026-01-31', '2026-02-28', '2026-03-31']) state = recognizeRevenueMonth(state, id, { date });
  assert.deepEqual(state.revenueSchedules[0].postings.map(item => item.amountCents), [0, 1, 0]);
  assert.equal(state.revenueSchedules[0].postings[0].entryId, null);
  validateCommercialState(state);
});

test('reminder prepares auditable record, rejects duplicates or unissued/not-overdue invoices', () => {
  let state = invoice(setup()); const id = state.invoices[0].id;
  assert.throws(() => prepareReminder(state, { invoiceId: id, date: '2026-02-01', note: 'Betala' }), /utfärdad/);
  state = issueInvoice(state, id);
  assert.throws(() => prepareReminder(state, { invoiceId: id, date: '2026-01-31', note: 'Betala' }), /efter/);
  state = prepareReminder(state, { invoiceId: id, date: '2026-02-01', note: 'Vänligen betala' });
  assert.equal(state.commercialReminders[0].status, 'prepared');
  assert.throws(() => prepareReminder(state, { invoiceId: id, date: '2026-02-01', note: 'Igen' }), /redan/);
  assert.equal(state.entries.length, 1);
});

test('a customer reminder excludes the expected tax-authority ROT portion', () => {
  let state = createSuiteState(); const rotInvoice = state.invoices.find(item => item.rot);
  state = issueInvoice(state, rotInvoice.id);
  const due = getInvoiceTotals(state.invoices.find(item => item.id === rotInvoice.id)).customerCents;
  state = receivePayment(state, rotInvoice.id, { date: '2026-11-01', amountCents: due, payer: 'customer' });
  assert.throws(() => prepareReminder(state, { invoiceId: rotInvoice.id, date: '2026-12-01', note: 'Felaktigt krav på väntad ROT' }), /obetald kundandel/);
});

test('ongoing work is explicitly a frozen assessment and creates no valuation', () => {
  let state = setup();
  state = addProjectWorkpaper(state, { projectId: state.projects[0].id, date: '2026-10-23', completedCostCents: 100000, agreedRevenueCents: 300000, completionBps: 5000, reviewNote: 'Bedömning kräver avtal och redovisningsprincip.', reviewer: 'Jenny' });
  assert.equal(state.projectWorkpapers[0].status, 'review-note'); assert.equal(state.entries.length, 0);
  validateCommercialState(state);
  state.projectWorkpapers[0].completedCostCents = 1;
  assert.throws(() => validateCommercialState(state), /ändrats/);
});

test('workspace and form dispatcher preserve escaped labels and real article operations', () => {
  let state = setup();
  state = handleAction(state, 'save-article', { number: 'B200', name: '<script>alert(1)</script>', kind: 'material', unit: 'st', unitCents: '10,50', vatRate: '12' });
  const html = renderWorkspace(state);
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('data-feature-form="commercial"'));
  assert.ok(html.includes('Intäktsperiodisering'));
  assert.equal(state.commercialArticles[1].unitCents, 1050);
});

const nextYear = state => {
  state = transact(state, draft => { draft.lockedPeriods = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`); });
  return openNextYear(closeYear(state, { date: '2026-12-31', confirmed: true }), { confirmed: true });
};

test('revenue plan continues across year end, but new deferral of historic revenue is blocked', () => {
  let state = setup(); state = saveArticle(state, { ...state.commercialArticles[0], vatRate: 0 });
  state = invoice(state, { date: '2026-12-01', dueDate: '2026-12-31' });
  const invoiceId = state.invoices[0].id;
  state = issueInvoice(state, invoiceId);
  state = createRevenueSchedule(state, { invoiceId, name: 'Vinterservice', date: '2026-12-01', amountCents: 100000, startMonth: '2026-12', months: 3 });
  const scheduleId = state.revenueSchedules[0].id;
  assert.deepEqual(getRevenueDueMonths(state).map(item => item.month), ['2026-12']);
  state = recognizeRevenueMonth(state, scheduleId, { date: '2026-12-31' });
  assert.deepEqual(getRevenueDueMonths(state), []);
  state = nextYear(state);
  const archived = structuredClone(state.fiscalYears[0]);
  state = recognizeRevenueMonth(state, scheduleId, { date: '2027-01-31' });
  assert.equal(state.revenueSchedules[0].postings.length, 2);
  assert.deepEqual(state.fiscalYears[0], archived);
  assert.equal(accountBalance(state, '2990'), -33333);
  assert.throws(() => createRevenueSchedule(state, { invoiceId, name: 'Efterhandsflytt', date: '2027-02-01', amountCents: 1, startMonth: '2027-02', months: 1 }), /räkenskapsår/);
  validateCommercialState(state);
  validateSuiteState(state);
});

test('recurring plan continues into a new fiscal year without duplicating December', () => {
  let state = setup(); state = saveArticle(state, { ...state.commercialArticles[0], vatRate: 0 });
  state = plan(state, { startDate: '2026-12-31' });
  state = generateRecurringInvoices(state, { asOf: '2026-12-31' });
  state = issueInvoice(state, state.invoices[0].id);
  state = nextYear(state);
  state = generateRecurringInvoices(state, { asOf: '2027-01-31' });
  assert.deepEqual(state.recurringPlans[0].generated.map(item => item.date), ['2026-12-31', '2027-01-31']);
  assert.equal(state.invoices.length, 2);
  validateCommercialState(state);
  validateSuiteState(state);
});

test('commercial invoices, stock links and deferred revenue pass the shared restore validator', () => {
  let state = invoice(setup()); state = issueInvoice(state, state.invoices[0].id);
  state = createRevenueSchedule(state, { invoiceId: state.invoices[0].id, name: 'Plan', date: '2026-01-01', amountCents: 1000, startMonth: '2026-01', months: 1 });
  state = plan(state); state = generateRecurringInvoices(state, { asOf: '2026-02-28' });
  state = createStockItem(state, { name: 'Reglar', unit: 'm', unitCostCents: 1000 });
  state = recordStockMovement(state, state.inventoryItems[0].id, { date: '2026-02-01', kind: 'in', quantity: 10, reason: 'Leverans' });
  state = issueProjectStock(state, { projectId: state.projects[0].id, inventoryItemId: state.inventoryItems[0].id, date: '2026-02-02', quantity: 2, unitCents: 2000, vatRate: 25, reason: 'Projekt' });
  validateSuiteState(state);
});

test('a credited invoice cannot receive a new revenue plan, and a planned invoice cannot be credited', () => {
  let state = invoice(setup()); state = issueInvoice(state, state.invoices[0].id);
  const payload = { side: 'customer', documentId: state.invoices[0].id, date: '2026-02-01', reason: 'Prisjustering', reference: 'CREDIT-1', lines: [{ index: 0, netCents: 100 }] };
  const credited = createCreditNote(state, payload);
  assert.throws(() => createRevenueSchedule(credited, { invoiceId: state.invoices[0].id, name: 'Ej möjlig', date: '2026-02-02', amountCents: 1000, startMonth: '2026-02', months: 1 }), /krediterad/);
  state = createRevenueSchedule(state, { invoiceId: state.invoices[0].id, name: 'Plan', date: '2026-01-01', amountCents: 1000, startMonth: '2026-01', months: 1 });
  assert.throws(() => createCreditNote(state, payload), /periodisering/);
});
