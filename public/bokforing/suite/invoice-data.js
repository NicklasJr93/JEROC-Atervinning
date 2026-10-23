// Invoice-specific document fields. No lookup or transmission to an external
// register happens here; issued documents keep their own customer/seller data.
import { assert, validDate } from './core.js';
import { normalizeVatNumber, normalizePerformance } from './invoice-requirements.js';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, maximum = 300, required = false) => {
  assert(typeof value === 'string' && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), `${label} har fel format eller är för lång.`);
  const cleaned = value.trim();
  assert(!required || cleaned.length > 0, `${label} saknas.`);
  return cleaned;
};
const field = (input, key, fallback = '') => own(input, key) ? input[key] : fallback;
const email = (value, label) => {
  const cleaned = text(value, label, 254);
  assert(!cleaned || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned), `${label} är inte en giltig e-postadress.`);
  return cleaned;
};

function party(input, fallback, label, { seller = false } = {}) {
  assert(record(input), `${label} har fel format.`);
  const out = {
    name: text(field(input, 'name', fallback.name ?? ''), `${label}: namn`, 150, true),
    orgNumber: text(field(input, 'orgNumber', fallback.orgNumber ?? ''), `${label}: organisationsnummer`, 50),
    address: text(field(input, 'address', fallback.address ?? ''), `${label}: adress`, 300),
    email: email(field(input, 'email', fallback.email ?? ''), `${label}: e-post`),
    address2: text(field(input, 'address2', fallback.address2 ?? ''), `${label}: adressrad 2`, 300),
    postalCode: text(field(input, 'postalCode', fallback.postalCode ?? ''), `${label}: postnummer`, 30),
    city: text(field(input, 'city', fallback.city ?? ''), `${label}: ort`, 150),
    country: field(input, 'country', fallback.country ?? 'SE'),
    vatNumber: normalizeVatNumber(text(field(input, 'vatNumber', fallback.vatNumber ?? ''), `${label}: momsregistreringsnummer`, 40)),
  };
  if (!seller) Object.assign(out, {
    address2: text(field(input, 'address2', fallback.address2 ?? ''), `${label}: adressrad 2`, 300),
    postalCode: text(field(input, 'postalCode', fallback.postalCode ?? ''), `${label}: postnummer`, 30),
    city: text(field(input, 'city', fallback.city ?? ''), `${label}: ort`, 150),
    country: field(input, 'country', fallback.country ?? 'SE'),
    phone: text(field(input, 'phone', fallback.phone ?? ''), `${label}: telefon`, 50),
    reminderEmail: email(field(input, 'reminderEmail', fallback.reminderEmail ?? ''), `${label}: e-post för påminnelser`),
  });
  if (seller) {
    out.legalForm = field(input, 'legalForm', fallback.legalForm);
    out.registeredOffice = text(field(input, 'registeredOffice', fallback.registeredOffice ?? ''), 'Styrelsens sätesort', 150);
    out.inLiquidation = own(input, 'inLiquidation') ? input.inLiquidation : fallback.inLiquidation;
    assert(out.inLiquidation === undefined || typeof out.inLiquidation === 'boolean', 'Likvidationsuppgiften är ogiltig.');
  }
  if (seller) assert(out.country === 'SE', 'Den här fakturaversionen kräver svensk säljaradress.');
  if (!seller) assert(out.country === 'SE', 'Den här fakturaversionen stödjer svenska adresser.');
  return out;
}

function normalizedDelivery(input) {
  assert(record(input), 'Leveransuppgifterna har fel format.');
  const out = {};
  for (const key of ['name', 'address', 'address2', 'postalCode', 'city', 'method', 'terms']) {
    out[key] = text(field(input, key), `Leverans: ${key}`, key === 'postalCode' ? 30 : 300);
  }
  out.country = field(input, 'country', 'SE');
  assert(out.country === 'SE', 'Den här fakturaversionen stödjer svenska leveransadresser.');
  out.date = field(input, 'date');
  assert(out.date === '' || validDate(out.date), 'Leveransdatumet är ogiltigt.');
  return out;
}

export function normalizeInvoiceDetails(state, payload) {
  assert(record(payload), 'Fakturauppgifterna saknas.');
  const customer = state.customers.find(item => item.id === payload.customerId);
  assert(customer, 'Kunden finns inte.');
  const input = payload.details ?? {};
  assert(record(input), 'Fakturans dokumentuppgifter har fel format.');
  const days = validDate(payload.date) && validDate(payload.dueDate)
    ? (Date.parse(`${payload.dueDate}T00:00:00Z`) - Date.parse(`${payload.date}T00:00:00Z`)) / 86400000 : 30;
  const paymentTermsDays = field(input, 'paymentTermsDays', Number.isInteger(days) && days >= 0 && days <= 365 ? days : 30);
  assert(Number.isInteger(paymentTermsDays) && paymentTermsDays >= 0 && paymentTermsDays <= 365, 'Betalningsvillkoret ska vara 0–365 dagar.');
  const priceModes = Array.isArray(payload.lines) ? [...new Set(payload.lines.map(line => line.unitPriceIncludesVat ?? false))] : [];
  assert(priceModes.length <= 1, 'Alla rader på fakturan ska använda samma prisinställning för moms.');
  const pricesIncludeVat = field(input, 'pricesIncludeVat', priceModes[0] ?? false);
  assert(typeof pricesIncludeVat === 'boolean' && priceModes.every(mode => mode === pricesIncludeVat), 'Prisernas momsinställning ska överensstämma med fakturaraderna.');
  const details = {
    paymentTermsDays,
    ourReference: text(field(input, 'ourReference'), 'Vår referens', 150),
    customerReference: text(field(input, 'customerReference'), 'Er referens', 150),
    customerOrderNumber: text(field(input, 'customerOrderNumber'), 'Ert ordernummer', 100),
    costCenter: text(field(input, 'costCenter'), 'Kostnadsställe', 100),
    invoiceText: text(field(input, 'invoiceText'), 'Fakturatext', 4000),
    priceListName: text(field(input, 'priceListName'), 'Prislistans namn', 100),
    customer: party(input.customer ?? {}, customer, 'Fakturamottagare'),
    delivery: normalizedDelivery(input.delivery ?? {}),
    // Seller identity is supplied by the company, not arbitrary invoice input.
    seller: party({}, state.company, 'Säljare', { seller: true }),
    pricesIncludeVat,
    language: field(input, 'language', 'sv'),
  };
  const performance = normalizePerformance(input.performance);
  if (performance !== undefined) details.performance = performance;
  assert(typeof details.pricesIncludeVat === 'boolean', 'Prisernas momsinställning är ogiltig.');
  assert(details.language === 'sv', 'Den här fakturaversionen stödjer svenska dokument.');
  return details;
}

export function validateInvoiceDetails(details) {
  assert(record(details), 'Fakturans dokumentuppgifter har fel format.');
  assert(Number.isInteger(details.paymentTermsDays) && details.paymentTermsDays >= 0 && details.paymentTermsDays <= 365, 'Betalningsvillkoret är ogiltigt.');
  for (const [key, maximum] of [['ourReference',150],['customerReference',150],['customerOrderNumber',100],['costCenter',100],['invoiceText',4000],['priceListName',100]]) {
    text(details[key], key, maximum);
  }
  party(details.customer, {}, 'Fakturamottagare');
  normalizedDelivery(details.delivery);
  party(details.seller, {}, 'Säljare', { seller: true });
  if (details.performance !== undefined) normalizePerformance(details.performance);
  if (details.requirementsVersion !== undefined) assert(details.requirementsVersion === 1, 'Fakturans kravversion stöds inte.');
  assert(typeof details.pricesIncludeVat === 'boolean' && details.language === 'sv', 'Fakturans språk- eller momsinställning är ogiltig.');
  return details;
}
