// Supplier document metadata for the local demo. Bank details are labels only;
// they are never used to initiate payments. Attachment bytes live separately.
import { assert, validDate } from './core.js';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, maximum = 300, required = false) => {
  assert(typeof value === 'string' && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), `${label} har fel format eller är för lång.`);
  const cleaned = value.trim();
  assert(!required || cleaned.length > 0, `${label} saknas.`);
  return cleaned;
};
const field = (input, name, fallback = '') => Object.prototype.hasOwnProperty.call(input, name) ? input[name] : fallback;
const detailFields = Object.freeze({ paymentReference: 100, bankgiro: 50, plusgiro: 50, iban: 50, ourReference: 150, supplierReference: 150, costCenter: 100, description: 4000 });

export function normalizeBillDetails(input = {}) {
  assert(record(input), 'Leverantörsfakturans dokumentuppgifter har fel format.');
  const details = Object.fromEntries(Object.entries(detailFields).map(([key, max]) => [key, text(field(input, key), key, max)]));
  const supplier = field(input, 'supplier', {});
  assert(record(supplier), 'Leverantörens kontaktuppgifter har fel format.');
  details.supplier = Object.fromEntries(Object.entries({ orgNumber: 50, address: 300, postalCode: 30, city: 150, email: 254, phone: 50 }).map(([key, max]) => [key, text(field(supplier, key), `Leverantör: ${key}`, max)]));
  details.supplier.country = field(supplier, 'country', 'SE');
  assert(details.supplier.country === 'SE', 'Den här inköpsversionen stödjer svenska leverantörsadresser.');
  assert(!details.supplier.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.supplier.email), 'Leverantörens e-postadress är ogiltig.');
  return details;
}

export function validateBillDetails(details) {
  normalizeBillDetails(details);
  return details;
}

export const BILL_ATTACHMENT_LIMIT = 20;
export const BILL_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
export const BILL_ATTACHMENT_TYPES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

export function normalizeBillAttachments(attachments) {
  assert(Array.isArray(attachments) && attachments.length <= BILL_ATTACHMENT_LIMIT, `Högst ${BILL_ATTACHMENT_LIMIT} underlag kan kopplas till fakturan.`);
  const ids = new Set();
  return attachments.map(item => {
    assert(record(item), 'Fakturans underlag har fel format.');
    assert(typeof item.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(item.id) && !ids.has(item.id), 'Underlagets ID är ogiltigt eller används flera gånger.');
    ids.add(item.id);
    assert(BILL_ATTACHMENT_TYPES.includes(item.type), 'Underlaget ska vara PDF, JPEG, PNG eller WebP.');
    assert(Number.isSafeInteger(item.size) && item.size > 0 && item.size <= BILL_ATTACHMENT_MAX_BYTES, 'Ett underlag får vara högst 15 MB och får inte vara tomt.');
    assert(typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256), 'Underlagets SHA-256-kontrollsumma är ogiltig.');
    assert(typeof item.createdAt === 'string' && validDate(item.createdAt.slice(0, 10)) && Number.isFinite(Date.parse(item.createdAt)) && new Date(item.createdAt).toISOString() === item.createdAt, 'Underlagets uppladdningstid är ogiltig.');
    assert(['file', 'camera'].includes(item.source), 'Underlagets källa är ogiltig.');
    text(item.name, 'Underlagets filnamn', 255, true);
    // Keep the exact uploaded filename so the metadata still identifies the
    // document stored in IndexedDB, including leading or trailing spaces.
    return { id: item.id, name: item.name, type: item.type, size: item.size, sha256: item.sha256, createdAt: item.createdAt, source: item.source };
  });
}

export function validateBillAttachments(attachments) {
  normalizeBillAttachments(attachments);
  return attachments;
}

export function getBillAttachments(bill) {
  assert(record(bill), 'Välj en leverantörsfaktura.');
  const original = bill.attachments === undefined ? [] : normalizeBillAttachments(bill.attachments);
  const additions = bill.additionalAttachments === undefined ? [] : normalizeBillAttachments(bill.additionalAttachments);
  return normalizeBillAttachments([...original, ...additions]);
}

export function validateBillAttachmentAdditions(bill) {
  getBillAttachments(bill);
  if (bill.additionalAttachments !== undefined || bill.additionalAttachmentsSnapshot !== undefined) {
    assert(['booked', 'credited'].includes(bill.status), 'Kompletterande underlag hör till en bokförd leverantörsfaktura.');
    assert(Array.isArray(bill.additionalAttachments) && bill.additionalAttachments.length > 0, 'Leverantörsfakturans kompletterande underlag saknas.');
    assert(bill.additionalAttachmentsSnapshot === JSON.stringify(normalizeBillAttachments(bill.additionalAttachments)), 'Leverantörsfakturans kompletterande underlag har ändrats.');
  }
  return bill;
}

export function billSnapshot(bill) {
  const values = [bill.supplier, bill.number, bill.date, bill.dueDate, bill.netCents, bill.vatRate, bill.vatMode,
    bill.account, bill.vatCents, bill.totalCents, bill.reverseConfirmed, bill.projectId ?? null];
  // Keep the original serialization for saved documents from earlier demos.
  if (bill.details !== undefined || bill.attachments !== undefined) values.push({
    details: bill.details === undefined ? null : normalizeBillDetails(bill.details),
    attachments: bill.attachments === undefined ? null : normalizeBillAttachments(bill.attachments),
  });
  return JSON.stringify(values);
}

export function copyBillPayload(bill, options = {}) {
  assert(record(bill), 'Välj en leverantörsfaktura att kopiera.');
  const date = options.date ?? bill.date, dueDate = options.dueDate ?? bill.dueDate;
  return {
    supplier: bill.supplier, number: '', date, dueDate, netCents: bill.netCents, vatRate: bill.vatRate,
    vatMode: bill.vatMode, account: bill.account, reverseConfirmed: false, projectId: bill.projectId ?? null,
    ...(bill.details === undefined ? {} : { details: normalizeBillDetails(bill.details) }),
    attachments: [],
  };
}
