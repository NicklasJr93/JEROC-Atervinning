import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCOUNTS, STORAGE_KEY, assistantAnswer, bookDraft, createState,
  getReports, getSummary, getVatReport, matchBank, money, restoreState,
} from '../public/bokforing/model.js';

const office = state => state.documents.find(document => document.id === 'doc-office');
const rowsOf = document => structuredClone(document.rows);
const baseline = () => getSummary(createState());
const availableMatch = state => state.bankTransactions.find(transaction => !transaction.matchedEntryId && transaction.suggestedEntryId);

function assertPersistedIntegrity(state) {
  const accounts = new Set(ACCOUNTS.map(account => account.number));
  const entries = new Map(state.entries.map(entry => [entry.id, entry]));
  assert.equal(state.schemaVersion, 1);
  assert.equal(new Set(state.entries.map(entry => entry.number)).size, state.entries.length);
  for (const entry of state.entries) {
    assert.equal(entry.rows.reduce((sum, row) => sum + row.debitCents - row.creditCents, 0), 0);
    for (const row of entry.rows) {
      assert.ok(accounts.has(row.account));
      assert.ok(Number.isSafeInteger(row.debitCents));
      assert.ok(Number.isSafeInteger(row.creditCents));
    }
  }
  for (const document of state.documents) {
    assert.equal(state.entries.filter(entry => entry.documentId === document.id).length, document.status === 'booked' ? 1 : 0);
  }
  for (const event of state.bankTransactions) {
    if (event.matchedEntryId) assert.ok(entries.has(event.matchedEntryId));
  }
}

test('the synthetic company has balanced complete entries and consistent report totals', () => {
  const state = createState();
  const known = new Set(ACCOUNTS.map(account => account.number));
  assert.equal(state.company.name, 'Exempelbolaget AB');
  assert.equal(STORAGE_KEY, 'scrapplanner-bokforing-demo-v1');
  assert.equal(new Set(state.entries.map(entry => entry.number)).size, state.entries.length);
  for (const entry of state.entries) {
    assert.ok(entry.rows.length >= 2);
    let debit = 0;
    let credit = 0;
    for (const row of entry.rows) {
      assert.ok(known.has(row.account));
      assert.ok(Number.isSafeInteger(row.debitCents) && row.debitCents >= 0);
      assert.ok(Number.isSafeInteger(row.creditCents) && row.creditCents >= 0);
      assert.notEqual(row.debitCents > 0, row.creditCents > 0);
      debit += row.debitCents;
      credit += row.creditCents;
    }
    assert.equal(debit, credit, entry.number);
  }
  assert.deepEqual(getSummary(state), {
    bankCents: 28_450_000,
    revenueCents: 16_000_000,
    expenseCents: 11_180_000,
    resultCents: 4_820_000,
    draftCount: 8,
    bookedCount: 4,
    receivablesCents: 7_500_000,
    payablesCents: 7_500_000,
  });
  const report = getReports(state);
  assert.equal(report.revenueCents - report.expenseCents, report.resultCents);
  assert.equal(report.resultCents, getSummary(state).resultCents);
  assert.equal(report.accounts.reduce((sum, account) => sum + account.debitCents - account.creditCents, 0), 0);
});

test('booking the office invoice updates ledger, VAT and outstanding payable exactly once without mutating input', () => {
  const state = createState();
  const before = structuredClone(state);
  const document = office(state);
  const vatBefore = getVatReport(state);
  const next = bookDraft(state, document.id, rowsOf(document), document.version);
  assert.deepEqual(state, before);
  assert.notEqual(next, state);
  assert.equal(office(next).status, 'booked');
  assert.equal(office(next).version, document.version + 1);
  assert.equal(next.entries.length, state.entries.length + 1);
  assert.equal(next.entries.filter(entry => entry.documentId === document.id).length, 1);
  const summary = getSummary(next);
  assert.equal(summary.draftCount, 7);
  assert.equal(summary.bookedCount, 5);
  assert.equal(summary.bankCents, getSummary(state).bankCents);
  assert.equal(summary.payablesCents, getSummary(state).payablesCents + 125_000);
  assert.equal(summary.expenseCents, getSummary(state).expenseCents + 100_000);
  assert.equal(summary.resultCents, getSummary(state).resultCents - 100_000);
  assert.equal(getVatReport(next).inputVatCents, vatBefore.inputVatCents + 25_000);
  assert.equal(getVatReport(next).payableCents, vatBefore.payableCents - 25_000);
  assert.throws(() => bookDraft(next, document.id, rowsOf(document), office(next).version));
});

test('a stale approval cannot post a different draft version', () => {
  const state = createState();
  const before = structuredClone(state);
  const document = office(state);
  assert.throws(() => bookDraft(state, document.id, rowsOf(document), document.version + 1));
  assert.deepEqual(state, before);
});

test('invalid draft entries fail before any accounting or document state changes', async t => {
  const invalid = {
    'unbalanced cents': rows => { rows[0].debitCents += 1; },
    'fractional cents': rows => { rows[0].debitCents += 0.5; },
    'negative amount': rows => { rows[0].debitCents = -1; },
    'non-finite amount': rows => { rows[0].debitCents = Infinity; },
    'unsafe integer': rows => { rows[0].debitCents = Number.MAX_SAFE_INTEGER + 1; },
    'unknown account': rows => { rows[0].account = 'not-an-account'; },
    'both debit and credit': rows => { rows[0].debitCents += 10; rows[0].creditCents = 10; },
    'empty accounting row': rows => { rows.push({ account: '6110', debitCents: 0, creditCents: 0 }); },
    'changed invoice total despite balanced rows': rows => {
      rows[0].debitCents += 1_000;
      const payable = rows.find(row => row.account === '2440');
      payable.creditCents += 1_000;
    },
  };
  for (const [label, change] of Object.entries(invalid)) {
    await t.test(label, () => {
      const state = createState();
      const before = structuredClone(state);
      const document = office(state);
      const rows = rowsOf(document);
      change(rows);
      assert.throws(() => bookDraft(state, document.id, rows, document.version));
      assert.deepEqual(state, before);
    });
  }
  const state = createState();
  const document = office(state);
  assert.throws(() => bookDraft(state, 'missing-document', rowsOf(document), 1));
  assert.throws(() => bookDraft(state, document.id, [], document.version));
});

test('reverse VAT is reported on both sides while private purchase creates no VAT', () => {
  let state = createState();
  const reverse = state.documents.find(document => document.status === 'draft' && document.category === 'reverse');
  const privatePurchase = state.documents.find(document => document.status === 'draft' && document.category === 'private');
  assert.ok(reverse);
  assert.ok(privatePurchase);
  const before = getVatReport(state);
  state = bookDraft(state, reverse.id, rowsOf(reverse), reverse.version);
  const afterReverse = getVatReport(state);
  assert.equal(afterReverse.reverseBaseCents - before.reverseBaseCents, reverse.netCents);
  assert.ok(afterReverse.reverseOutputVatCents > before.reverseOutputVatCents);
  assert.equal(afterReverse.reverseOutputVatCents - before.reverseOutputVatCents,
    afterReverse.reverseInputVatCents - before.reverseInputVatCents);
  assert.equal(afterReverse.payableCents, before.payableCents);
  state = bookDraft(state, privatePurchase.id, rowsOf(privatePurchase), privatePurchase.version);
  assert.deepEqual(getVatReport(state), afterReverse);
});

test('bank matching reconciles an existing journal entry instead of creating a second posting', () => {
  const state = createState();
  const before = structuredClone(state);
  const transaction = availableMatch(state);
  assert.ok(transaction);
  const next = matchBank(state, transaction.id, transaction.suggestedEntryId);
  assert.deepEqual(state, before);
  assert.deepEqual(next.entries, state.entries);
  assert.deepEqual(getSummary(next), getSummary(state));
  assert.equal(next.bankTransactions.find(item => item.id === transaction.id).matchedEntryId, transaction.suggestedEntryId);
  assert.throws(() => matchBank(next, transaction.id, transaction.suggestedEntryId));
});

test('bank matching rejects missing references, mismatching amount and reuse of the same entry', () => {
  const state = createState();
  const transaction = availableMatch(state);
  const noBankEntry = state.entries.find(entry => !entry.rows.some(row => row.account === '1930'));
  assert.ok(noBankEntry);
  assert.throws(() => matchBank(state, 'missing-bank-event', transaction.suggestedEntryId));
  assert.throws(() => matchBank(state, transaction.id, 'missing-entry'));
  assert.throws(() => matchBank(state, transaction.id, noBankEntry.id));
  const changedAmount = structuredClone(state);
  changedAmount.bankTransactions.find(item => item.id === transaction.id).amountCents += 1;
  assert.throws(() => matchBank(changedAmount, transaction.id, transaction.suggestedEntryId));
  const withAnotherEvent = structuredClone(state);
  withAnotherEvent.bankTransactions.push({ ...transaction, id: 'duplicate-bank-event', matchedEntryId: null });
  const matched = matchBank(withAnotherEvent, transaction.id, transaction.suggestedEntryId);
  assert.throws(() => matchBank(matched, 'duplicate-bank-event', transaction.suggestedEntryId));
});

test('valid browser state survives restoration with the booked entry and without shared references', () => {
  const state = createState();
  const document = office(state);
  const booked = bookDraft(state, document.id, rowsOf(document), document.version);
  const serialized = JSON.parse(JSON.stringify(booked));
  const restored = restoreState(serialized);
  assert.deepEqual(restored, serialized);
  assert.equal(getSummary(restored).draftCount, 7);
  restored.documents[0].supplier = 'Changed in restored copy';
  assert.notEqual(serialized.documents[0].supplier, restored.documents[0].supplier);
});

test('damaged browser state is replaced by a fresh demo instead of importing corrupt accounting', async t => {
  const cases = {
    'unknown version': state => { state.schemaVersion = 999; },
    'fractional amount in ledger': state => { state.entries[0].rows[0].debitCents += 0.1; },
    'unknown account in ledger': state => { state.entries[0].rows[0].account = 'not-an-account'; },
    'booked document without its journal': state => { office(state).status = 'booked'; },
    'missing matched entry': state => { state.bankTransactions[0].matchedEntryId = 'missing-entry'; },
    'duplicate journal number': state => {
      state.entries.push({ ...structuredClone(state.entries[0]), id: 'duplicate-journal-number' });
    },
  };
  for (const [label, change] of Object.entries(cases)) {
    await t.test(label, () => {
      const damaged = createState();
      change(damaged);
      const restored = restoreState(damaged);
      assert.deepEqual(getSummary(restored), baseline());
      assertPersistedIntegrity(restored);
    });
  }
  for (const input of [null, [], {}, { schemaVersion: 1 }]) {
    const restored = restoreState(input);
    assert.deepEqual(getSummary(restored), baseline());
    assertPersistedIntegrity(restored);
  }
});

test('the demo assistant uses current amounts and returns internal view references', () => {
  const state = createState();
  const answer = assistantAnswer(state, 'Hur mycket finns på banken?', 'overview');
  assert.equal(typeof answer.text, 'string');
  assert.ok(answer.text.includes(money(getSummary(state).bankCents)));
  const document = office(state);
  const next = bookDraft(state, document.id, rowsOf(document), document.version);
  const vat = assistantAnswer(next, 'Vad blir momsrapporten?', 'vat');
  assert.ok(vat.text.includes(money(getVatReport(next).payableCents)));
  const allowedViews = new Set(['overview', 'documents', 'ledger', 'bank', 'vat', 'reports']);
  for (const reply of [answer, vat, assistantAnswer(next, 'Hej')]) {
    assert.ok(reply.text.length > 20);
    assert.ok(Array.isArray(reply.links));
    assert.ok(reply.links.every(link => typeof link.label === 'string' && allowedViews.has(link.view)));
  }
});
