// Shared, versioned completeness checks. These validate supplied invoice data;
// they do not verify registration, identity or the facts with an authority.
import { assert, validDate } from './core.js';

export const INVOICE_REQUIREMENTS_VERSION = 1;
export const invoiceSellerVatRequired = (lines, vatMode = 'standard') => vatMode !== 'standard' || !Array.isArray(lines) || !lines.length || lines.some(line => line.vatRate !== 0);
export const normalizeVatNumber = value => String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
export function validSwedishVatNumber(value) {
  const vat = normalizeVatNumber(value);
  if (!/^SE\d{10}01$/.test(vat)) return false;
  const digits = vat.slice(2, 12);
  return [...digits].reduce((total, digit, index) => {
    const product = Number(digit) * (index % 2 ? 1 : 2);
    return total + Math.floor(product / 10) + product % 10;
  }, 0) % 10 === 0;
}
// Only recognize well-formed Swedish identities. Free-form imported references
// (including DEMO) are not guessed or silently rewritten.
function swedishOrganisationIdentity(value) {
  if (typeof value !== 'string') return undefined;
  const digits = value.replace(/[\s-]/g, '');
  const short = digits.length === 10 ? digits : digits.length === 12 && digits.startsWith('16') ? digits.slice(2) : '';
  return /^[2-9]\d[2-9]\d{7}$/.test(short) && validSwedishVatNumber(`SE${short}01`) ? short : undefined;
}
function swedishIdentityForVat(value) {
  if (typeof value !== 'string') return undefined;
  const digits = value.replace(/[\s+-]/g, '');
  if (!/^\d{10}(?:\d{2})?$/.test(digits)) return undefined;
  const short = digits.slice(-10);
  if (!validSwedishVatNumber(`SE${short}01`)) return undefined;
  const organisation = /^[2-9]\d[2-9]\d{7}$/.test(short);
  if (organisation) return digits.length === 10 || digits.startsWith('16') ? short : undefined;
  const day = Number(short.slice(4, 6));
  const actualDay = day > 60 ? day - 60 : day;
  const monthDay = `${short.slice(2,4)}-${String(actualDay).padStart(2,'0')}`;
  const years = digits.length === 12 ? [digits.slice(0,4)] : [`19${short.slice(0,2)}`, `20${short.slice(0,2)}`];
  return years.some(year => validDate(`${year}-${monthDay}`)) ? short : undefined;
}
const filled = value => typeof value === 'string' && value.trim().length > 0;
export function normalizePerformance(value) {
  if (value === undefined || value === null) return undefined;
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Utförandeuppgifterna är ogiltiga.');
  assert(['invoice-date', 'date', 'period', 'advance-payment'].includes(value.mode), 'Välj datum eller period för leverans/utförande.');
  assert(value.confirmed === undefined || typeof value.confirmed === 'boolean', 'Datumets bekräftelse är ogiltig.');
  const out = { mode: value.mode, confirmed: value.confirmed === true };
  for (const key of value.mode === 'period' ? ['from', 'to'] : value.mode === 'invoice-date' ? [] : ['date']) {
    const date = value[key] ?? '';
    assert(date === '' || validDate(date), 'Leverans-/utförandedatumet är ogiltigt.');
    out[key] = date;
  }
  return out;
}
export function getInvoiceIssuanceIssues({ seller = {}, customer = {}, date, performance, vatMode = 'standard', sellerVatRequired = true } = {}) {
  const issues = [];
  for (const [party, name] of [[seller, 'Säljaren'], [customer, 'Köparen']]) {
    if (!filled(party.name)) issues.push(`${name}: fullständigt namn saknas.`);
    if (!filled(party.address)) issues.push(`${name}: gatuadress saknas.`);
    if (!filled(party.postalCode)) issues.push(`${name}: postnummer saknas.`);
    else if ((party.country ?? 'SE') === 'SE' && !/^\d{3}\s?\d{2}$/.test(party.postalCode.trim())) issues.push(`${name}: ange svenskt postnummer med fem siffror.`);
    if (!filled(party.city)) issues.push(`${name}: ort saknas.`);
    if (!/^[A-Z]{2}$/.test(party.country ?? '')) issues.push(`${name}: landkod saknas eller är ogiltig.`);
  }
  if (!['AB','sole-trader','other'].includes(seller.legalForm)) issues.push('Ange säljarens bolagsform i företagsuppgifterna.');
  if (seller.legalForm === 'AB') {
    if (!swedishOrganisationIdentity(seller.orgNumber)) issues.push('Aktiebolagets giltiga svenska organisationsnummer saknas.');
    if (!filled(seller.registeredOffice)) issues.push('Aktiebolagets styrelsesäte saknas.');
    if (typeof seller.inLiquidation !== 'boolean') issues.push('Ange om aktiebolaget är under likvidation.');
  }
  if ((sellerVatRequired || filled(seller.vatNumber)) && !validSwedishVatNumber(seller.vatNumber)) issues.push('Säljarens svenska momsregistreringsnummer saknas eller är ogiltigt (SE + 12 siffror).');
  if ((vatMode === 'reverse-construction' || filled(customer.vatNumber)) && !validSwedishVatNumber(customer.vatNumber)) issues.push(vatMode === 'reverse-construction' ? 'Köparens svenska momsregistreringsnummer krävs vid omvänd byggmoms.' : 'Köparens angivna momsregistreringsnummer är ogiltigt.');
  // ML 17:24 identifies the supplier/customer VAT identity; ABL 28:5 also
  // requires a limited company's registration number on invoices. This is only
  // a consistency check between supplied numbers, never a registry lookup.
  for (const [party, name] of [[seller, 'Säljarens'], [customer, 'Köparens']]) {
    const identity = party.country === 'SE' ? swedishIdentityForVat(party.orgNumber) : undefined;
    if (identity && validSwedishVatNumber(party.vatNumber) && normalizeVatNumber(party.vatNumber).slice(2,12) !== identity) {
      issues.push(`${name} organisations-/personnummer och momsregistreringsnummer avser olika svenska identitetsnummer.`);
    }
  }
  if (!validDate(date)) issues.push('Fakturadatumet är ogiltigt.');
  if (!performance || performance.confirmed !== true) issues.push('Bekräfta datum/period för leverans eller utförande, eller datum för mottaget förskott.');
  else if (!['invoice-date', 'date', 'period', 'advance-payment'].includes(performance.mode)) issues.push('Välj hur leverans-/utförandedatumet ska anges.');
  else if (performance.mode === 'period') {
    if (!validDate(performance.from) || !validDate(performance.to) || performance.from > performance.to) issues.push('Utförandeperioden måste ha giltigt start- och slutdatum i rätt ordning.');
  } else if (performance.mode !== 'invoice-date' && !validDate(performance.date)) issues.push('Ange ett giltigt leverans-/utförande- eller förskottsdatum.');
  if (performance?.mode === 'advance-payment' && validDate(performance.date) && validDate(date) && performance.date > date) issues.push('Datum för mottaget förskott får inte ligga efter fakturadatumet.');
  return issues;
}
export function assertInvoiceIssuanceReady(spec) {
  const issues = getInvoiceIssuanceIssues(spec);
  assert(issues.length === 0, `Fakturan behöver kompletteras före utfärdande: ${issues.join(' ')}`);
  return true;
}
export function invoicePerformanceText(performance, invoiceDate) {
  if (!performance || performance.confirmed !== true) return '';
  if (performance.mode === 'invoice-date') return `Leverans/utförande: ${invoiceDate}`;
  if (performance.mode === 'date') return `Leverans/utförande: ${performance.date}`;
  if (performance.mode === 'period') return `Utförandeperiod: ${performance.from}–${performance.to}`;
  if (performance.mode === 'advance-payment') return `Mottaget förskott: ${performance.date}`;
  return '';
}
