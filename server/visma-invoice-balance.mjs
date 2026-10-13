import { AccountingError, moneyToCents } from './visma-accounting.mjs';
import { EnvironmentError } from './environment-storage.mjs';

function balanceError(value, field, message, code = 'accounting_amount_invalid') {
  const error = new EnvironmentError(`Spiris-fältet ${field}: ${message}`, 409, code);
  error.details = { provider: 'spiris', field, valueType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value };
  return error;
}

/** Supplier liabilities may be returned with a negative sign by Spiris.
 * This interpretation applies ONLY to remaining balances on a normal booked
 * SEK supplier invoice. It never changes a payment amount, VAT, accounting row,
 * credit invoice or source snapshot. Callers still verify invoice identity,
 * exact full unpaid balance and payment status before any payment write.
 * Preserve the signed cents alongside the debt magnitude for reconciliation. */
export function readSpirisInvoiceBalance(invoice, field = 'RemainingAmountInvoiceCurrency') {
  if (!['RemainingAmountInvoiceCurrency', 'RemainingAmount'].includes(field))
    throw new TypeError('Only supplier invoice remaining amounts have signed balance semantics.');
  if (invoice?.IsCreditInvoice !== false || invoice.Status !== 1 || invoice.CurrencyCode !== 'SEK'
    || typeof invoice.TotalAmount !== 'number' || !Number.isFinite(invoice.TotalAmount) || invoice.TotalAmount <= 0)
    throw new EnvironmentError('Restbeloppet kräver en verifierad bokförd leverantörsfaktura i SEK med positivt totalbelopp. Kreditfakturor ingår inte.', 409, 'visma_payment_invoice_mismatch');
  const value = invoice[field];
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw balanceError(value, field, 'Det återstående beloppet måste vara ett ändligt tal. Kontrollera fakturan före utbetalning.', 'visma_payment_already_recorded');
  const magnitude = value < 0 ? -value : value;
  let cents;
  try { cents = moneyToCents(magnitude); }
  catch (error) {
    if (error instanceof AccountingError) throw balanceError(value, field, error.message, error.code);
    throw error;
  }
  if (cents / 100 !== magnitude)
    throw balanceError(value, field, 'Det återstående beloppet måste kunna uttryckas exakt i kronor och ören.');
  return { cents, signedCents: value < 0 ? -cents : cents };
}
