import { isDeepStrictEqual } from 'node:util';
import { bankRecipientType, bankRecipientError, normalizePaymentDetails } from '../dist-server/domain-models.mjs';
import { bankPaymentCreditorAccount } from './openpayments-client.mjs';

const echoedReferenceMatches = (actual, expected) => actual && expected && typeof actual === 'object' &&
  Object.keys(expected).every(key => isDeepStrictEqual(actual[key], expected[key]));
const cents = value => {
  const match = String(value ?? '').match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : NaN;
};

/** Only server-owned, reread sandbox ACSC evidence can reach PDF/accounting.
 * A POST acceptance, browser callback or frontend paid flag is insufficient. */
export function verifiedBankPaymentProof(job) {
  const sent = job?.request?.payload, paid = job?.providerResult;
  if (job?.provider !== 'openpayments' || job.mode !== 'sandbox' || job.simulation !== true || job.kind !== 'card'
    || job.status !== 'simulated_paid' || paid?.status !== 'ACSC' || paid.transactionStatus !== 'ACSC'
    || !job.providerPaymentId || paid.paymentId !== job.providerPaymentId || job.providerPaymentReference !== paid.paymentId
    || !sent || !job.providerInstructionUUID || !Number.isSafeInteger(job.amountCents) || job.amountCents <= 0
    || job.currency !== 'SEK' || job.paymentDetails?.method !== 'bank' || bankRecipientError(job.paymentDetails)
    || paid.datePaidSource !== 'sandbox_confirmation' || !job.verifiedAt) return false;
  const payment = normalizePaymentDetails(job.paymentDetails), type = bankRecipientType(payment);
  // The original bank instruction stays frozen across adapter updates. Missing
  // version denotes the historical separate clearing/account contract.
  const payloadVersion = job.payloadVersion === undefined ? 1 : job.payloadVersion;
  if (![1, 2].includes(payloadVersion)) return false;
  const account = bankPaymentCreditorAccount(payment, payloadVersion);
  if (['bankgiro', 'plusgiro'].includes(type)) {
    const giro = { giroNumber: payment[type], giroType: type === 'bankgiro' ? 'BANKGIRO' : 'PLUSGIRO' };
    if (sent.creditorAccount !== undefined || job.providerProduct !== 'swedish-giro' || !isDeepStrictEqual(sent.creditorGiro, giro) || !echoedReferenceMatches(paid.creditorGiro, giro)) return false;
  } else if (!account || sent.creditorGiro !== undefined || job.providerProduct !== 'domestic' || !isDeepStrictEqual(sent.creditorAccount, account) || !echoedReferenceMatches(paid.creditorAccount, account)) return false;
  if (paid.creditorName !== payment.holder || sent.creditorName !== payment.holder
    || sent.instructedAmount?.currency !== 'SEK' || paid.instructedAmount?.currency !== 'SEK'
    || cents(sent.instructedAmount.amount) !== job.amountCents || cents(paid.instructedAmount.amount) !== job.amountCents
    || !echoedReferenceMatches(paid.debtorAccount, sent.debtorAccount)) return false;
  for (const field of ['remittanceInformationUnstructured', 'ocrRef', 'invoiceRef'])
    if (sent[field] !== undefined && sent[field] !== paid[field]) return false;
  const datePaid = Date.parse(paid.datePaid), verified = Date.parse(job.verifiedAt);
  return Number.isFinite(datePaid) && Number.isFinite(verified) && datePaid <= verified + 5000;
}
