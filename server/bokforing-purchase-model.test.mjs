import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyState } from '../public/bokforing/suite/core.js';
import { createBill, updateBillDraft, bookBill, payBill, creditBill, copyBillPayload, getBillBookingRows, addBillAttachments, getBillAttachments } from '../public/bokforing/suite/operations.js';
import { billSnapshot, normalizeBillDetails, normalizeBillAttachments } from '../public/bokforing/suite/purchase-data.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

const input = extra => ({ supplier: 'Leverantör Demo AB', number: 'L-100', date: '2026-10-23', dueDate: '2026-11-22', netCents: 10000, vatRate: 25, vatMode: 'standard', account: '4010', ...extra });
const file = extra => ({ id: 'document-1', name: 'Faktura L-100.pdf', type: 'application/pdf', size: 1234, sha256: 'a'.repeat(64), createdAt: '2026-10-23T09:00:00.000Z', source: 'file', ...extra });
const draft = extra => createBill(createEmptyState(), input(extra));
const last = state => state.bills.at(-1);
const booked = extra => { const state = draft(extra); return bookBill(state, last(state).id); };

test('supplier document details and attachment metadata persist and freeze without changing journal totals', () => {
  const details = { paymentReference: ' 1234567890 ', bankgiro: '123-4567', plusgiro: '98765-4', iban: 'SE-DEMO-ONLY', ourReference: 'Åke', supplierReference: 'Lisa', costCenter: 'Snickeri', description: 'Faktura för material', supplier: { orgNumber: 'DEMO', address: 'Testgatan 1', postalCode: '12345', city: 'Teststad', country: 'SE', email: 'leverantor@example.test', phone: '0101234567' } };
  const payload = input({ details, attachments: [file()] }), originalPayload = structuredClone(payload);
  const pending = createBill(createEmptyState(), payload), pendingCopy = structuredClone(pending);
  const state = bookBill(pending, last(pending).id), bill = last(state);
  assert.deepEqual(payload, originalPayload);
  assert.deepEqual(pending, pendingCopy);
  assert.equal(bill.details.paymentReference, '1234567890');
  assert.equal(bill.details.supplier.city, 'Teststad');
  assert.deepEqual(bill.attachments, [file()]);
  assert.equal(bill.bookingSnapshot, billSnapshot(bill));
  assert.deepEqual(state.entries[0].rows, getBillBookingRows(bill));
  assert.equal(bill.totalCents, 12500);
  validateSuiteState(state);
  for (const mutate of [b => { b.details.description = 'Ny text'; }, b => { b.attachments[0].sha256 = 'b'.repeat(64); }, b => { b.attachments[0].name = 'Utbytt faktura.pdf'; }]) {
    const tampered = structuredClone(state); mutate(last(tampered));
    assert.throws(() => validateSuiteState(tampered), /uppgifter har ändrats/);
    assert.throws(() => payBill(tampered, bill.id, { date: '2026-10-24', amountCents: 1 }), /får inte ändras/);
  }
});

test('old supplier snapshots remain byte-identical and work after restoration and payment', () => {
  let state = booked(), bill = last(state);
  const legacySnapshot = JSON.stringify([bill.supplier, bill.number, bill.date, bill.dueDate, bill.netCents, bill.vatRate, bill.vatMode, bill.account, bill.vatCents, bill.totalCents, bill.reverseConfirmed, bill.projectId ?? null]);
  assert.equal(bill.details, undefined); assert.equal(bill.attachments, undefined);
  assert.equal(bill.bookingSnapshot, legacySnapshot);
  state = JSON.parse(JSON.stringify(state)); validateSuiteState(state);
  state = payBill(state, bill.id, { date: '2026-10-24', amountCents: 1000 });
  assert.equal(last(state).bookingSnapshot, legacySnapshot);
  validateSuiteState(state);
});

test('supplier draft editing recalculates preview and posting without changing prior state', () => {
  const before = draft({ details: { ourReference: 'Före' }, attachments: [file()] });
  const original = structuredClone(before), id = last(before).id;
  let state = updateBillDraft(before, id, { netCents: 20000, vatRate: 12, account: '6540', details: { ourReference: 'Efter' }, attachments: [] });
  assert.deepEqual(before, original);
  assert.equal(last(state).id, id); assert.equal(last(state).number, 'L-100');
  assert.equal(last(state).netCents, 20000); assert.equal(last(state).vatCents, 2400); assert.equal(last(state).totalCents, 22400);
  assert.equal(last(state).details.ourReference, 'Efter'); assert.deepEqual(last(state).attachments, []);
  assert.equal(state.entries.length, 0); validateSuiteState(state);
  const preview = getBillBookingRows(last(state));
  state = bookBill(state, id);
  assert.deepEqual(state.entries[0].rows, preview);
  validateSuiteState(state);
  assert.throws(() => updateBillDraft(state, id, { netCents: 1 }), /utkast/);
});

test('editing rejects supplier-number duplicates, invalid dates and unsupported expense accounts atomically', () => {
  let state = draft(); state = createBill(state, input({ number: 'L-101' }));
  const id = last(state).id, before = structuredClone(state);
  for (const payload of [{ number: 'l-100', supplier: 'leverantör demo ab' }, { dueDate: '2026-10-22' }, { account: '1930' }, { netCents: 12.1 }]) assert.throws(() => updateBillDraft(state, id, payload));
  assert.deepEqual(state, before);
  validateSuiteState(updateBillDraft(state, id, { number: 'L-101' }));
});

test('reverse-construction preview needs no confirmation but booking still requires review', () => {
  const state = draft({ vatMode: 'reverse-construction', netCents: 3 });
  const preview = getBillBookingRows(last(state));
  assert.deepEqual(preview, [
    { account: '4425', debitCents: 3, creditCents: 0 }, { account: '2647', debitCents: 1, creditCents: 0 },
    { account: '2614', debitCents: 0, creditCents: 1 }, { account: '2440', debitCents: 0, creditCents: 3 },
  ]);
  assert.throws(() => bookBill(state, last(state).id), /Bekräfta/);
  const tiny = draft({ vatMode: 'reverse-construction', netCents: 1, reverseConfirmed: true });
  validateSuiteState(bookBill(tiny, last(tiny).id));
});

test('copying a supplier invoice produces an independent unnumbered payload without linked documents', () => {
  const state = booked({ details: { description: 'Återanvänd kontering' }, attachments: [file()] }), original = structuredClone(state);
  const copy = copyBillPayload(last(state), { date: '2026-10-24', dueDate: '2026-11-23' });
  assert.equal(copy.number, ''); assert.equal(copy.id, undefined); assert.equal(copy.entryId, undefined); assert.equal(copy.payments, undefined);
  assert.deepEqual(copy.attachments, []); assert.equal(copy.date, '2026-10-24'); assert.equal(copy.reverseConfirmed, false);
  copy.details.description = 'Egen ny beskrivning';
  assert.deepEqual(state, original);
  assert.throws(() => createBill(state, copy), /fakturanummer/);
  const next = createBill(state, { ...copy, number: 'L-101' });
  assert.equal(next.bills.length, 2); assert.equal(last(next).status, 'draft'); validateSuiteState(next);
});

test('document and attachment metadata rejects malformed formats, duplicates and oversized uploads', () => {
  assert.equal(normalizeBillDetails().supplier.country, 'SE');
  for (const details of [null, [], { supplier: { email: 'inte-epost' } }, { supplier: { country: 'US' } }, { ourReference: 'A'.repeat(151) }, { description: '\u0000' }]) assert.throws(() => draft({ details }));
  for (const attachments of [null, [file({ type: 'text/html' })], [file({ size: 0 })], [file({ size: 15 * 1024 * 1024 + 1 })], [file({ sha256: 'fake' })], [file({ createdAt: '2026-02-30T09:00:00.000Z' })], [file({ source: 'email' })], [file(), file()], Array.from({ length: 21 }, (_, i) => file({ id: `doc-${i}` }))]) assert.throws(() => draft({ attachments }));
  assert.equal(normalizeBillAttachments([file({ source: 'camera', type: 'image/jpeg' })])[0].source, 'camera');
});

test('attachment metadata preserves the exact uploaded filename through draft, booking and restoration', () => {
  const attachment = file({ name: '  Faktura med blanksteg.pdf  ' });
  const pending = draft({ attachments: [attachment] });
  assert.equal(last(pending).attachments[0].name, attachment.name);
  const state = bookBill(pending, last(pending).id);
  assert.equal(getBillAttachments(last(state))[0].name, attachment.name);
  const restored = JSON.parse(JSON.stringify(state));
  validateSuiteState(restored);
  assert.equal(getBillAttachments(last(restored))[0].name, attachment.name);
  assert.equal(billSnapshot(last(restored)), last(restored).bookingSnapshot);
});

test('later reminder attachments preserve the original booked document, journal and supplier debt', () => {
  const before = booked({ attachments: [file()] }), original = structuredClone(before), id = last(before).id;
  const reminder = file({ id: 'reminder-1', name: 'Påminnelse.pdf', sha256: 'b'.repeat(64) });
  let state = addBillAttachments(before, id, [reminder]);
  assert.deepEqual(before, original);
  assert.equal(last(state).bookingSnapshot, last(before).bookingSnapshot);
  assert.deepEqual(last(state).attachments, [file()]);
  assert.deepEqual(last(state).additionalAttachments, [reminder]);
  assert.deepEqual(getBillAttachments(last(state)), [file(), reminder]);
  assert.deepEqual(state.entries, before.entries); assert.equal(last(state).totalCents, last(before).totalCents);
  validateSuiteState(state);
  const again = file({ id: 'reminder-2', name: 'Ny påminnelse.png', type: 'image/png', source: 'camera', sha256: 'c'.repeat(64) });
  state = addBillAttachments(state, id, [again]); validateSuiteState(state);
  assert.equal(getBillAttachments(last(state)).length, 3);
  assert.equal(last(state).bookingSnapshot, last(before).bookingSnapshot);
  assert.throws(() => addBillAttachments(state, id, [reminder]), /flera gånger/);
  assert.throws(() => addBillAttachments(state, id, []), /minst ett/);
  const changed = structuredClone(state); last(changed).additionalAttachments[0].sha256 = 'd'.repeat(64);
  assert.throws(() => validateSuiteState(changed), /kompletterande underlag har ändrats/);
});

test('legacy and credited supplier bills accept append-only supplements; drafts edit their attachment list', () => {
  let state = booked(), bill = last(state), snapshot = bill.bookingSnapshot;
  state = creditBill(state, bill.id, { date: '2026-10-24', reason: 'Kreditunderlag inkom' });
  const entries = structuredClone(state.entries);
  state = addBillAttachments(state, bill.id, [file({ name: 'Kreditnota.pdf' })]);
  assert.equal(last(state).bookingSnapshot, snapshot); assert.equal(last(state).status, 'credited');
  assert.deepEqual(state.entries, entries); validateSuiteState(state);
  const pending = draft(); assert.throws(() => addBillAttachments(pending, last(pending).id, [file()]), /utkastet/);
});

test('supplement limits apply across original and added documents, and rollback leaves the ledger unchanged', () => {
  const attachments = Array.from({ length: 19 }, (_, i) => file({ id: `original-${i}` }));
  const initial = booked({ attachments }), id = last(initial).id;
  const state = addBillAttachments(initial, id, [file({ id: 'last-allowed' })]), before = structuredClone(state);
  assert.equal(getBillAttachments(last(state)).length, 20);
  assert.throws(() => addBillAttachments(state, id, [file({ id: 'too-many' })]), /Högst 20/);
  assert.deepEqual(state, before); validateSuiteState(state);
});
