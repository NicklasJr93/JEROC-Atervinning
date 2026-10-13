import { bankRecipientType, bankRecipientError, normalizePaymentDetails } from '../dist-server/domain-models.mjs';

/** Map only the supplied frozen recipient. Supplier master-data never replaces
 * the customer-approved payout instructions. */
export function bankRecipientToSpiris(value) {
  if (value?.method !== 'bank') return {};
  const message = bankRecipientError(value);
  if (message) throw Object.assign(new Error(message), { status: 422, code: 'accounting_bank_recipient_invalid' });
  const payment = normalizePaymentDetails(value), type = bankRecipientType(payment);
  const result = {};
  const add = (key, input, length) => {
    const text = typeof input === 'string' ? input.trim() : '';
    if (text) result[key] = text.slice(0, length);
  };
  add('BankName', payment.bank, 50);
  if (type === 'account') {
    add('Clearing', payment.clearing, 5);
    add('BankAccountNumber', payment.account, 50);
    result.BankCountryCode = 'SE';
  } else if (type === 'bankgiro') {
    add('BankgiroNumber', payment.bankgiro, 10);
    result.BankCountryCode = 'SE';
  } else if (type === 'plusgiro') {
    add('PlusgiroNumber', payment.plusgiro, 10);
    result.BankCountryCode = 'SE';
  } else {
    add('BankIban', payment.iban, 50);
    add('BankBic', payment.bic, 50);
    result.BankCountryCode = payment.bankCountry || payment.iban.slice(0, 2);
  }
  return result;
}
