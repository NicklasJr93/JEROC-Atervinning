import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { latestAttestedVismaCards, attestedVismaPrefill } from './visma-weightcard.mjs';

export const attestedFixture = () => ({ id: randomUUID(), cardId: 3016, version: 2, status: 'attested', approvedAt: '2026-10-10T20:00:00Z',
  approvedMethod: 'staff_checked_id_demo', approvedHash: 'a'.repeat(64), attestedAt: '2026-10-10T22:30:00Z', attestedBy: 'Anna',
  snapshot: { hash: 'a'.repeat(64), card: { id: 3016, yard: 'Norrtälje', paymentDetails: { method: 'bank', bank: 'Testbank', clearing: '1234', account: '111-222 333', holder: 'Frysta firman AB' } },
    customer: { id: 'customer-1', name: 'Frysta firman AB', type: 'Företag', number: '559000-0000', customerNumber: 'K-1001',
      address: 'Kundgatan 1, 761 41 Norrtälje', postalCode: '', city: '', phone: '0700000000', email: 'test@example.invalid', contactPerson: 'Kajsa' },
    rows: [{ articleId: 'copper-1', name: 'Koppar klass 1', weight: 2, price: 50, amount: 100 },
      { articleId: 'lead-battery', name: 'Blybatterier', weight: 10, price: 4, amount: 40 }],
    gross: 140, offset: 40, net: 100, reference: 'Projekt låst', origin: 'Ursprungsgatan 9, 111 22 Stockholm', deliveredAt: '2026-10-09T10:00:00Z', paymentMethod: 'bank' } });

test('only the latest current version with valid customer approval and attest proof is eligible', () => {
  const original = attestedFixture();
  assert.deepEqual(latestAttestedVismaCards([original]), [original]);
  for (const patch of [{ status: 'approved' }, { status: 'cancelled' }, { approvedHash: 'b'.repeat(64) }, { attestedAt: undefined }, { approvedMethod: undefined }])
    assert.deepEqual(latestAttestedVismaCards([{ ...original, ...patch }]), []);
  assert.deepEqual(latestAttestedVismaCards([original, { ...original, id: randomUUID(), version: 3, status: 'waiting' }]), []);
});

test('prefill uses frozen identity, bank and material amounts; invoice gross differs from net after offset', () => {
  const approval = attestedFixture(), before = structuredClone(approval);
  const prefill = attestedVismaPrefill(approval);
  assert.deepEqual(approval, before, 'Reading must not change the signing snapshot');
  assert.equal(prefill.supplier.Name, 'Frysta firman AB');
  assert.equal(prefill.supplier.CorporateIdentityNumber, '5590000000');
  assert.equal(prefill.supplier.Address1, 'Kundgatan 1'); assert.equal(prefill.supplier.City, 'Norrtälje');
  assert.equal(prefill.supplier.PostalCode, '761 41');
  assert.equal(prefill.supplier.BankAccountNumber, '111222333'); assert.equal(prefill.supplier.Clearing, '1234');
  assert.equal(prefill.draft.InvoiceDate, '2026-10-11', 'Invoice date is the Stockholm date of final attest');
  assert.equal(prefill.draft.InvoiceNumber, 'AV-3016-V2'); assert.equal(prefill.draft.TotalAmount, 140);
  assert.equal(prefill.source.net, 100); assert.equal(prefill.source.offset, 40);
  assert.deepEqual(prefill.draft.Rows.map(row => [row.DebitAmount, row.CreditAmount]), [[100, 0], [40, 0], [0, 140]]);
  assert.equal(prefill.draft.Rows.every(row => row.AccountNumber === undefined), true, 'Never invent accounts not read from the company');
  assert.equal(prefill.supplier.TermsOfPaymentId, undefined); assert.equal(prefill.draft.SupplierId, undefined);
  assert.equal(prefill.draft.Vat, undefined, 'A company card does not establish VAT handling');
  assert.equal(prefill.draft.SkipSendToBank, true);
});

test('private seller identity is not put in the corporate number field and nonbank payouts do not transfer bank profiles', () => {
  const approval = attestedFixture();
  approval.snapshot.customer.type = 'Privatperson'; approval.snapshot.customer.number = '19900101-0000';
  approval.snapshot.paymentMethod = 'swish'; approval.snapshot.card.paymentDetails = { method: 'swish', phone: '0700000000', recipient: 'Privatpersonen' };
  approval.snapshot.customer.paymentProfile = { method: 'bank', clearing: '9999', account: 'old-customer-profile' };
  const prefill = attestedVismaPrefill(approval);
  assert.equal(prefill.supplier.CorporateIdentityNumber, undefined); assert.equal(prefill.supplier.BankAccountNumber, undefined);
  assert.equal(prefill.draft.Vat, 0); assert.equal(JSON.stringify(prefill).includes('19900101'), false);
});

test('inconsistent monetary snapshots cannot become a prefilled invoice; large cards retain every material in the source summary', () => {
  const approval = attestedFixture(); approval.snapshot.gross = 141;
  assert.throws(() => attestedVismaPrefill(approval), failure => failure.code === 'visma_source_incomplete');
  const large = attestedFixture(); large.snapshot.rows = Array.from({ length: 100 }, (_, index) => ({ articleId: `article-${index}`, name: `Material ${index}`, weight: 1, price: 1, amount: 1 }));
  Object.assign(large.snapshot, { gross: 100, offset: 0, net: 100 });
  const prefill = attestedVismaPrefill(large);
  assert.equal(prefill.source.rows.length, 100); assert.equal(prefill.draft.Rows.length, 2);
  assert.equal(prefill.draft.Rows[0].DebitAmount, 100);
});
