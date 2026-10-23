// Per-line supplier calculations. Values are whole öre; deductible VAT is an
// explicit reviewed input, not an automatic decision about entitlement.
import { assert, cents } from './core.js';

export const PURCHASE_EXPENSE_ACCOUNTS = Object.freeze(['4010', '5010', '5410', '5460', '6110', '6540', '6570', '6991']);
export const PURCHASE_VAT_MODES = Object.freeze(['standard', 'no-vat', 'reverse-construction']);
const round = (amount, numerator, denominator) => cents(Number((BigInt(amount) * BigInt(numerator) + BigInt(denominator / 2)) / BigInt(denominator)));
const debit = (account, amount) => ({ account, debitCents: amount, creditCents: 0 });
const credit = (account, amount) => ({ account, debitCents: 0, creditCents: amount });

export function normalizePurchaseLines(input) {
  assert(Array.isArray(input) && input.length >= 1 && input.length <= 100, 'Ange 1–100 konteringsrader.');
  return input.map((input, index) => {
    assert(input && typeof input === 'object' && !Array.isArray(input), `Konteringsrad ${index + 1} är ogiltig.`);
    const description = input.description ?? '';
    assert(typeof description === 'string' && description.trim().length <= 300 && !/[\u0000-\u001f]/.test(description), 'Radbeskrivningen är ogiltig eller för lång.');
    const vatMode = input.vatMode ?? 'standard';
    assert(PURCHASE_VAT_MODES.includes(vatMode), 'Välj en momstyp som stöds för konteringsraden.');
    const vatRate = input.vatRate ?? (vatMode === 'no-vat' ? 0 : 25);
    assert([0, 6, 12, 25].includes(vatRate), 'Välj 0, 6, 12 eller 25 procent moms per rad.');
    assert(vatMode !== 'no-vat' || vatRate === 0, 'En rad utan moms ska ha noll i momssats.');
    assert(vatMode !== 'reverse-construction' || vatRate === 25, 'Omvänd byggmoms stöder 25 procent.');
    const account = input.account ?? (vatMode === 'reverse-construction' ? '4425' : '4010');
    assert(vatMode === 'reverse-construction' ? account === '4425' : PURCHASE_EXPENSE_ACCOUNTS.includes(account), 'Kostnadskontot hör inte till radens inköpstyp.');
    const deductibleBps = input.deductibleBps ?? 10000;
    assert(Number.isSafeInteger(deductibleBps) && deductibleBps >= 0 && deductibleBps <= 10000, 'Avdragsrätten ska anges som 0–100 procent med högst två decimaler.');
    assert(input.reverseConfirmed === undefined || typeof input.reverseConfirmed === 'boolean', 'Bekräftelsen av omvänd byggmoms är ogiltig.');
    const projectId = input.projectId || null;
    assert(projectId === null || (typeof projectId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(projectId)), 'Radens projekt är ogiltigt.');
    return { description: description.trim(), account, netCents: cents(input.netCents, false), vatMode, vatRate,
      deductibleBps, reverseConfirmed: input.reverseConfirmed === true, ...(projectId ? { projectId } : {}) };
  });
}

export function calculatePurchaseLines(input, { requireConfirmation = false } = {}) {
  const lines = normalizePurchaseLines(input);
  let netCents = 0, vatCents = 0, deductibleVatCents = 0, reverseVatCents = 0, nonDeductibleVatCents = 0;
  const postings = [];
  for (const line of lines) {
    if (requireConfirmation && line.vatMode === 'reverse-construction') assert(line.reverseConfirmed, 'Bekräfta förutsättningarna för omvänd byggmoms på varje berörd rad innan bokföring.');
    const vat = line.vatMode === 'no-vat' ? 0 : round(line.netCents, line.vatRate, 100);
    const deductible = round(vat, line.deductibleBps, 10000);
    const nonDeductible = vat - deductible;
    netCents = cents(netCents + line.netCents);
    nonDeductibleVatCents = cents(nonDeductibleVatCents + nonDeductible);
    deductibleVatCents = cents(deductibleVatCents + deductible);
    postings.push(debit(line.account, cents(line.netCents + nonDeductible)));
    if (line.vatMode === 'standard') {
      vatCents = cents(vatCents + vat);
      if (deductible) postings.push(debit('2641', deductible));
    } else if (line.vatMode === 'reverse-construction') {
      reverseVatCents = cents(reverseVatCents + vat);
      if (deductible) postings.push(debit('2647', deductible));
      if (vat) postings.push(credit('2614', vat));
    }
  }
  const totalCents = cents(netCents + vatCents, false);
  postings.push(credit('2440', totalCents));
  return { lines, netCents, vatCents, totalCents, deductibleVatCents, reverseVatCents, nonDeductibleVatCents,
    rows: postings, vatMode: 'mixed', vatRate: 0, account: 'mixed',
    reverseConfirmed: lines.filter(line => line.vatMode === 'reverse-construction').every(line => line.reverseConfirmed) };
}

export function validatePurchaseLineTotals(bill, options) {
  const result = calculatePurchaseLines(bill.lines, options);
  for (const key of ['netCents', 'vatCents', 'totalCents', 'vatMode', 'vatRate', 'account', 'reverseConfirmed']) {
    assert(bill[key] === result[key], 'Leverantörsfakturans belopp eller momstyp stämmer inte med konteringsraderna.');
  }
  return result;
}
