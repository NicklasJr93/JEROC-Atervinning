import assert from 'node:assert/strict';
import test from 'node:test';
import { readSpirisInvoiceBalance } from './visma-invoice-balance.mjs';
import { moneyToCents } from './visma-accounting.mjs';

const invoice = patch => ({ IsCreditInvoice: false, Status: 1, CurrencyCode: 'SEK', TotalAmount: 240,
  RemainingAmountInvoiceCurrency: -240, RemainingAmount: -240, ...patch });

test('signed supplier balances preserve their sign and exact debt magnitude, including paid zero', () => {
  assert.deepEqual(readSpirisInvoiceBalance(invoice()), { cents: 24000, signedCents: -24000 });
  assert.deepEqual(readSpirisInvoiceBalance(invoice({ RemainingAmountInvoiceCurrency: 240 })), { cents: 24000, signedCents: 24000 });
  assert.deepEqual(readSpirisInvoiceBalance(invoice({ RemainingAmountInvoiceCurrency: -240.23 })), { cents: 24023, signedCents: -24023 });
  assert.deepEqual(readSpirisInvoiceBalance(invoice({ RemainingAmountInvoiceCurrency: 0 })), { cents: 0, signedCents: 0 });
  assert.deepEqual(readSpirisInvoiceBalance(invoice(), 'RemainingAmount'), { cents: 24000, signedCents: -24000 });
});

test('signed semantics never apply to credit invoices, unbooked invoices or other money fields', () => {
  for (const patch of [{ IsCreditInvoice: true }, { IsCreditInvoice: undefined }, { Status: 0 }, { Status: 2 },
    { CurrencyCode: 'EUR' }, { TotalAmount: -240 }, { TotalAmount: 0 }, { TotalAmount: '240' }])
    assert.throws(() => readSpirisInvoiceBalance(invoice(patch)), error => error.code === 'visma_payment_invoice_mismatch');
  assert.throws(() => readSpirisInvoiceBalance(invoice(), 'TotalAmount'), TypeError);
  assert.throws(() => moneyToCents(-240), error => error.code === 'accounting_amount_invalid');
});

test('malformed, unsafe and fractional-cent balances remain blocked with safe field diagnostics', () => {
  for (const value of [null, undefined, '', '240', '-240.00', NaN, Infinity, -240.001, Number.MAX_SAFE_INTEGER, 0.1 + 0.2]) {
    assert.throws(() => readSpirisInvoiceBalance(invoice({ RemainingAmountInvoiceCurrency: value })), error => {
      assert.deepEqual(error.details, { provider: 'spiris', field: 'RemainingAmountInvoiceCurrency',
        valueType: value === null ? 'null' : typeof value });
      assert.equal(error.status, 409); return true;
    });
  }
});
