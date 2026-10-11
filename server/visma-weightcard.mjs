import { EnvironmentError } from './environment-storage.mjs';

const money = value => Math.round(value * 100) / 100;
const text = (value, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const invalid = message => { throw new EnvironmentError(message, 409, 'visma_source_incomplete'); };

export function latestAttestedVismaCards(approvals = []) {
  const latest = new Map();
  for (const approval of approvals) {
    const key = String(approval.cardId);
    if (!latest.has(key) || approval.version > latest.get(key).version) latest.set(key, approval);
  }
  return [...latest.values()].filter(approval => approval.status === 'attested' && approval.attestedAt && approval.approvedAt &&
    approval.approvedMethod && approval.snapshot?.hash && approval.approvedHash === approval.snapshot.hash &&
    approval.snapshot.card?.kind !== 'correction').sort((a, b) => b.attestedAt.localeCompare(a.attestedAt));
}

export function attestedVismaSummary(approval) {
  const snapshot = approval.snapshot;
  return { cardId: approval.cardId, approvalId: approval.id, version: approval.version, hash: snapshot.hash,
    customerName: snapshot.customer?.name ?? '', customerType: snapshot.customer?.type ?? '', siteName: snapshot.card?.yard ?? '',
    attestedAt: approval.attestedAt, attestedBy: approval.attestedBy ?? '', gross: snapshot.gross, offset: snapshot.offset, net: snapshot.net };
}

// Read only the frozen signing snapshot. Live customer/article records and an
// office card's mutable status cannot substitute for the terminal attest proof.
export function attestedVismaPrefill(approval) {
  const snapshot = approval.snapshot, customer = snapshot.customer, card = snapshot.card;
  if (!customer?.name || !card || !Array.isArray(snapshot.rows) || !snapshot.rows.length ||
    !Number.isFinite(Date.parse(approval.attestedAt))) invalid('Den attesterade avräkningens låsta uppgifter behöver kompletteras.');
  const rows = snapshot.rows.map(row => {
    if (!Number.isFinite(row.weight) || row.weight <= 0 || !Number.isFinite(row.price) || row.price < 0 || !Number.isFinite(row.amount) || row.amount < 0)
      invalid('Den attesterade avräkningen saknar fullständiga materialbelopp.');
    return { articleId: row.articleId, name: text(row.name), weight: row.weight, price: row.price, amount: money(row.amount) };
  });
  const gross = money(rows.reduce((sum, row) => sum + row.amount, 0)), offset = snapshot.offset ?? 0;
  if (![snapshot.gross, snapshot.net, offset].every(Number.isFinite) || gross !== money(snapshot.gross) ||
    offset < 0 || offset > gross || money(gross - offset) !== money(snapshot.net)) invalid('Avräkningens totalbelopp eller kvittning stämmer inte med dess låsta rader.');
  const privateSeller = customer.type === 'Privatperson';
  const number = `AV-${card.id}-V${approval.version}`;
  const invoiceDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(approval.attestedAt));
  const supplier = { Name: text(customer.name, 50), CountryCode: 'SE', CurrencyCode: 'SEK', IsActive: true,
    UsesAutomaticSupplierInvoiceApproval: false, UsesAutomaticInvoicePostToLedger: false,
    Note: text(`JEROC kund ${customer.customerNumber ?? customer.id ?? ''} · ${number}\nReferens: ${snapshot.reference ?? ''}\nUrsprung: ${snapshot.origin ?? ''}`, 4000) };
  const add = (key, value, max) => { const parsed = text(value, max); if (parsed) supplier[key] = parsed; };
  add('SupplierNumber', customer.customerNumber, 16);
  if (!privateSeller) add('CorporateIdentityNumber', customer.number?.replace(/[^\d]/g, ''), 20);
  // Customer address is the supplier address; material origin is not a billing address.
  const address = text(customer.address), embedded = address.match(/^(.+?)[,\s]+(\d{3}\s?\d{2})\s+([^,]+)$/);
  add('Address1', embedded ? embedded[1] : address, 50);
  add('PostalCode', customer.postalCode || embedded?.[2], 10);
  add('City', customer.city || embedded?.[3], 50);
  add('EmailAddress', customer.email, 255); add('Telephone', customer.phone, 50); add('ContactPersonName', customer.contactPerson, 50);
  const payment = card.paymentDetails ?? customer.paymentProfile;
  if (snapshot.paymentMethod === 'bank' && payment?.method === 'bank') {
    add('Clearing', payment.clearing?.replace(/\D/g, ''), 5);
    add('BankAccountNumber', payment.account?.replace(/[\s-]/g, ''), 50);
    add('BankName', payment.bank, 50); supplier.BankCountryCode = 'SE';
  }
  const purchaseRows = rows.length <= 99 ? rows.map((row, index) => ({ DebitAmount: row.amount, CreditAmount: 0, LineNumber: index + 1,
    TransactionText: text(`${row.name} · ${row.weight} kg × ${row.price} kr`, 100) }))
    : [{ DebitAmount: gross, CreditAmount: 0, LineNumber: 1, TransactionText: text(`${number} · ${rows.length} materialrader`, 100) }];
  const draft = { IsCreditInvoice: false, InvoiceNumber: number, InvoiceDate: invoiceDate, TotalAmount: gross, CurrencyCode: 'SEK',
    IsDomestic: true, SkipSendToBank: true, Message: number.slice(0, 25),
    ...(privateSeller ? { Vat: 0 } : {}),
    Rows: [...purchaseRows, { DebitAmount: 0, CreditAmount: gross, LineNumber: purchaseRows.length + 1, TransactionText: text(`Leverantörsskuld ${number}`, 100) }] };
  return { source: { ...attestedVismaSummary(approval), number, reference: snapshot.reference, origin: snapshot.origin, deliveredAt: snapshot.deliveredAt,
    paymentMethod: snapshot.paymentMethod, paymentRecipient: payment?.holder ?? payment?.recipient ?? customer.name, rows },
    supplier, draft, notes: [
      ...(!privateSeller ? ['Momshantering är inte fastställd på viktkortet. Ange moms och kontrollera konteringen inför fakturautkaststestet.'] : []),
      ...(offset > 0 ? [`Kvittning ${money(offset)} kr hanteras separat. Fakturautkastets belopp är hela inköpet ${gross} kr; att betala är ${money(snapshot.net)} kr.`] : []),
      ...(rows.length > 99 ? ['Konteringen sammanfattas i en inköpsrad; alla material finns i kortets sammanställning.'] : []),
    ] };
}
