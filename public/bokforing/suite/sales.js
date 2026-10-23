import { transact, appendEntry, nextId, addActivity, assert, cents, validDate, requireOpenPeriod } from './core.js';
import { calculateLineAmounts, calculateRot, ROT_RULES_2026 } from './rot.js';
import { normalizeInvoiceDetails, validateInvoiceDetails } from './invoice-data.js';

const text = (value, label, max = 300) => {
  assert(typeof value === 'string' && value.trim() && value.length <= max, `${label} saknas eller är för lång.`);
  return value.trim();
};
const sum = values => values.reduce((total, value) => cents(total + value), 0);
const row = (account, debitCents = 0, creditCents = 0) => ({ account, debitCents, creditCents });
const customerFor = (state, id) => {
  const customer = state.customers.find(item => item.id === id);
  assert(customer, 'Kunden finns inte.');
  return customer;
};
const invoiceFor = (state, id) => {
  const invoice = state.invoices.find(item => item.id === id);
  assert(invoice, 'Fakturan finns inte.');
  return invoice;
};
const standardInvoice = (state, id) => {
  const invoice = invoiceFor(state, id);
  assert(invoice.kind === 'invoice' && invoice.status === 'issued', 'Åtgärden kräver en utfärdad kundfaktura.');
  assert(invoice.bookingSnapshot === invoiceBookingSnapshot(invoice), 'Den utfärdade fakturans uppgifter har ändrats. Läs in den sparade originalfakturan.');
  return invoice;
};
const normalizedPerson = value => String(value).replace(/[\s-]/g, '').toUpperCase();
const dateField = (value, label) => { assert(validDate(value), `${label} måste vara ett giltigt datum.`); return value; };

export function invoiceBookingSnapshot(invoice) {
  const rot = invoice.rot ? Object.fromEntries(['paymentYear', 'property', 'personId', 'eligibleConfirmed', 'availableCents', 'reservedCents', 'remainingCents'].map(key => [key, invoice.rot[key] ?? null])) : null;
  const snapshot = {
    id: invoice.id, number: invoice.number, kind: invoice.kind, originalInvoiceId: invoice.originalInvoiceId ?? null,
    customerId: invoice.customerId, projectId: invoice.projectId ?? null, date: invoice.date, dueDate: invoice.dueDate,
    vatMode: invoice.vatMode, buyerConstructionConfirmed: invoice.buyerConstructionConfirmed,
    lines: invoice.lines.map(line => {
      const { description, kind, quantity, unitCents, vatRate } = line;
      const frozen = { description, kind, quantity, unitCents, vatRate };
      for (const key of ['articleNumber', 'unit', 'discountBps', 'unitPriceIncludesVat', 'rotEligible', 'chargeType']) if (line[key] !== undefined) frozen[key] = line[key];
      return frozen;
    }),
    reason: invoice.reason ?? null, rot,
  };
  // Missing fields deliberately remain missing for pre-upgrade issued invoices:
  // their existing immutable snapshot remains byte-for-byte compatible.
  if (invoice.details !== undefined) snapshot.details = invoice.details;
  if (invoice.invoiceDiscountBps !== undefined) snapshot.invoiceDiscountBps = invoice.invoiceDiscountBps;
  if (invoice.copiedFromId !== undefined) snapshot.copiedFromId = invoice.copiedFromId;
  return JSON.stringify(snapshot);
}

function linesFor(lines) {
  assert(Array.isArray(lines) && lines.length >= 1 && lines.length <= 100, 'Ange 1–100 fakturarader.');
  const result = lines.map(line => {
    const clean = { description: text(line.description, 'Radbeskrivning'), kind: line.kind, quantity: line.quantity, unitCents: line.unitCents, vatRate: line.vatRate ?? 25 };
    for (const key of ['articleNumber', 'unit', 'discountBps', 'unitPriceIncludesVat', 'rotEligible', 'chargeType']) if (line[key] !== undefined) clean[key] = line[key];
    calculateLineAmounts(clean);
    return clean;
  });
  const charges = result.filter(line => line.chargeType).map(line => line.chargeType);
  assert(new Set(charges).size === charges.length, 'Frakt och fakturaavgift får bara förekomma en gång vardera.');
  return result;
}

function nextNumber(state, prefix, list) {
  const numbered = prefix === 'K' ? [...list, ...(state.settlements ?? [])] : list;
  const numbers = numbered.map(item => new RegExp(`^${prefix}-(\\d+)$`).exec(item.number ?? '')).filter(Boolean).map(match => Number(match[1]));
  return `${prefix}-${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}`;
}

function projectFor(state, id, customerId) {
  if (!id) return undefined;
  const project = state.projects.find(item => item.id === id);
  assert(project && project.customerId === customerId, 'Projektet saknas eller tillhör en annan kund.');
  return project;
}

export function getInvoiceTotals(invoice) {
  assert(invoice && Array.isArray(invoice.lines) && invoice.lines.length, 'Fakturan saknar rader.');
  assert(['standard', 'reverse-construction'].includes(invoice.vatMode), 'Ogiltig momstyp.');
  const lines = invoice.lines.map(line => calculateLineAmounts(line, invoice.vatMode, invoice.invoiceDiscountBps ?? 0));
  const netCents = sum(lines.map(line => line.netCents));
  const vatCents = sum(lines.map(line => line.vatCents));
  const grossCents = cents(netCents + vatCents);
  let rotCents = 0;
  if (invoice.rot) {
    const calculated = calculateRot(invoice);
    rotCents = invoice.rot.approvedCents ?? invoice.rot.reservedCents ?? calculated.deductionCents;
    cents(rotCents);
    assert(rotCents <= grossCents && rotCents <= calculated.deductionCents, 'ROT-beloppet överstiger fakturans arbetskostnad eller utrymme.');
  }
  return { netCents, vatCents, grossCents, rotCents, customerCents: grossCents - rotCents };
}

export function getInvoiceOutstanding(invoice) {
  if (invoice.kind === 'credit' || invoice.status === 'credited') return 0;
  const paid = sum((invoice.payments ?? []).map(payment => cents(payment.amountCents)));
  const credit = cents(invoice.settlementCreditCents ?? 0), refund = cents(invoice.settlementRefundCents ?? 0);
  const offsetIn = cents(invoice.settlementOffsetInCents ?? 0), offsetOut = cents(invoice.settlementOffsetOutCents ?? 0);
  const rotRepaid = cents(invoice.rotRepaymentCents ?? 0);
  return cents(Math.max(0, getInvoiceTotals(invoice).grossCents - paid - credit + refund + offsetOut - offsetIn + rotRepaid));
}

function validateRotRoom(state, invoice) {
  if (!invoice.rot) return;
  const person = normalizedPerson(invoice.rot.personId);
  const used = sum(state.invoices.filter(item => item.id !== invoice.id && item.kind === 'invoice' && item.status === 'issued' &&
    item.rot?.paymentYear === invoice.rot.paymentYear && normalizedPerson(item.rot.personId) === person)
    .map(item => item.rot.approvedCents ?? item.rot.reservedCents ?? 0));
  const budget = Math.min(invoice.rot.availableCents, ROT_RULES_2026.capCents);
  assert(used <= budget, 'Andra ROT-fakturor använder redan det uppgivna årsutrymmet.');
  invoice.rot.remainingCents = budget - used;
  const calculation = calculateRot(invoice);
  assert(calculation.deductionCents > 0, 'Inget ROT-utrymme återstår för fakturan.');
  invoice.rot.reservedCents = calculation.deductionCents;
}

function draftInvoice(state, payload) {
  customerFor(state, payload.customerId);
  projectFor(state, payload.projectId, payload.customerId);
  const date = dateField(payload.date, 'Fakturadatum');
  const dueDate = dateField(payload.dueDate, 'Förfallodag');
  assert(dueDate >= date, 'Förfallodagen får inte ligga före fakturadatum.');
  requireOpenPeriod(state, date);
  const vatMode = payload.vatMode ?? 'standard';
  assert(['standard', 'reverse-construction'].includes(vatMode), 'Välj en momstyp som stöds.');
  const invoice = {
    id: nextId(state, 'invoice'), number: '', kind: 'invoice', customerId: payload.customerId,
    projectId: payload.projectId || null, date, dueDate, status: 'draft', vatMode,
    buyerConstructionConfirmed: payload.buyerConstructionConfirmed === true,
    lines: linesFor(payload.lines), rot: payload.rot ? {
      paymentYear: payload.rot.paymentYear,
      property: text(payload.rot.property, 'Fastighetsuppgift', 150),
      personId: text(payload.rot.personId, 'Fiktiv ROT-identifierare', 100),
      eligibleConfirmed: payload.rot.eligibleConfirmed === true,
      availableCents: cents(payload.rot.availableCents),
    } : null,
    payments: [], reminders: [],
    details: normalizeInvoiceDetails(state, payload),
    invoiceDiscountBps: payload.invoiceDiscountBps ?? 0,
  };
  if (invoice.rot) {
    calculateRot(invoice);
  }
  getInvoiceTotals(invoice);
  return invoice;
}

function issueInDraft(state, id) {
  const invoice = invoiceFor(state, id);
  assert(invoice.kind === 'invoice' && invoice.status === 'draft', 'Fakturan är redan utfärdad eller krediterad.');
  customerFor(state, invoice.customerId);
  requireOpenPeriod(state, invoice.date);
  invoice.details = normalizeInvoiceDetails(state, invoice);
  validateInvoiceDetails(invoice.details);
  if (invoice.vatMode === 'reverse-construction') {
    assert(invoice.buyerConstructionConfirmed === true, 'Bekräfta köparens verksamhet och villkoren för omvänd byggmoms.');
    assert(!invoice.rot, 'Omvänd byggmoms och ROT får inte kombineras.');
  }
  validateRotRoom(state, invoice);
  const totals = getInvoiceTotals(invoice);
  assert(totals.grossCents > 0, 'Fakturans totalbelopp måste vara större än noll innan den utfärdas.');
  invoice.number = nextNumber(state, 'F', state.invoices);
  const rows = [row('1510', totals.grossCents), row(invoice.vatMode === 'reverse-construction' ? '3231' : '3000', 0, totals.netCents)];
  if (invoice.vatMode === 'standard') {
    for (const [rate, account] of [[25, '2611'], [12, '2621'], [6, '2631']]) {
      const amount = sum(invoice.lines.filter(line => line.vatRate === rate).map(line => calculateLineAmounts(line, invoice.vatMode, invoice.invoiceDiscountBps ?? 0).vatCents));
      if (amount) rows.push(row(account, 0, amount));
    }
  }
  const entry = appendEntry(state, { date: invoice.date, description: `Kundfaktura ${invoice.number}`, sourceType: 'invoice', sourceId: invoice.id, rows });
  invoice.entryId = entry.id;
  invoice.status = 'issued';
  if (invoice.rot) invoice.rot.status = 'awaiting-customer';
  invoice.bookingSnapshot = invoiceBookingSnapshot(invoice);
  addActivity(state, `Kundfaktura ${invoice.number} utfärdad och bokförd`, invoice.id);
}

export function createCustomer(state, payload) {
  return transact(state, draft => {
    const customer = { id: nextId(draft, 'customer'), name: text(payload.name, 'Kundnamn', 150), email: String(payload.email ?? '').trim(), address: String(payload.address ?? '').trim() };
    assert(customer.email.length <= 254 && customer.address.length <= 500, 'Kunduppgifterna är för långa.');
    if (customer.email) assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email), 'Ange en giltig e-postadress.');
    draft.customers.push(customer);
    addActivity(draft, `Kund ${customer.name} skapad`, customer.id);
  });
}

export function createProject(state, payload) {
  return transact(state, draft => {
    customerFor(draft, payload.customerId);
    const project = { id: nextId(draft, 'project'), name: text(payload.name, 'Projektnamn', 150), customerId: payload.customerId, budgetCents: cents(payload.budgetCents ?? 0), items: [], status: 'active' };
    draft.projects.push(project);
    addActivity(draft, `Projekt ${project.name} skapat`, project.id);
  });
}

export function recordProjectItem(state, payload) {
  return transact(state, draft => {
    const project = draft.projects.find(item => item.id === payload.projectId);
    assert(project && project.status === 'active', 'Projektet är inte aktivt.');
    const clean = linesFor([{ ...payload, vatRate: payload.vatRate ?? 25 }])[0];
    project.items.push({ ...clean, id: nextId(draft, 'project-item') });
    addActivity(draft, `Tid eller material registrerat i ${project.name}`, project.id);
  });
}

export function createQuote(state, payload) {
  return transact(state, draft => {
    customerFor(draft, payload.customerId);
    projectFor(draft, payload.projectId, payload.customerId);
    const date = dateField(payload.date, 'Offertdatum');
    const validUntil = dateField(payload.validUntil, 'Sista giltighetsdag');
    assert(validUntil >= date, 'Offertens sista giltighetsdag får inte ligga före offertdatum.');
    const quote = { id: nextId(draft, 'quote'), number: nextNumber(draft, 'O', draft.quotes), customerId: payload.customerId, projectId: payload.projectId || null, date, validUntil, lines: linesFor(payload.lines), status: 'draft' };
    draft.quotes.push(quote);
    addActivity(draft, `Offert ${quote.number} skapad`, quote.id);
  });
}

export function acceptQuote(state, id) {
  return transact(state, draft => {
    const quote = draft.quotes.find(item => item.id === id);
    assert(quote && quote.status === 'draft', 'Offerten är redan godkänd eller fakturerad.');
    quote.status = 'accepted';
    addActivity(draft, `Kundgodkännande registrerat för offert ${quote.number}`, quote.id);
  });
}

export function invoiceFromQuote(state, id, payload) {
  assert(state.company.method !== 'cash', 'Detta bolag använder kontantmetoden. Öppna arbetsytan Kontantmetoden för fakturor och betalningar.');
  return transact(state, draft => {
    const quote = draft.quotes.find(item => item.id === id);
    assert(quote && quote.status === 'accepted' && !quote.invoiceId, 'Godkänn offerten först. En offert kan bara faktureras en gång i demon.');
    const invoice = draftInvoice(draft, { ...payload, customerId: quote.customerId, projectId: quote.projectId, lines: quote.lines });
    invoice.sourceQuoteId = quote.id;
    draft.invoices.push(invoice);
    quote.invoiceId = invoice.id;
    quote.status = 'invoiced';
    addActivity(draft, `Fakturautkast skapat från offert ${quote.number}`, invoice.id);
  });
}

export function createInvoice(state, payload) {
  assert(state.company.method !== 'cash', 'Detta bolag använder kontantmetoden. Öppna arbetsytan Kontantmetoden för fakturor och betalningar.');
  return transact(state, draft => {
    const invoice = draftInvoice(draft, payload);
    draft.invoices.push(invoice);
    addActivity(draft, 'Kundfakturautkast skapat', invoice.id);
  });
}

export function updateInvoiceDraft(state, id, payload) {
  assert(state.company.method !== 'cash', 'Detta bolag använder kontantmetoden. Öppna arbetsytan Kontantmetoden för fakturor och betalningar.');
  return transact(state, draft => {
    const invoice = invoiceFor(draft, id);
    assert(invoice.status === 'draft' && invoice.kind === 'invoice', 'En utfärdad faktura kan inte skrivas om. Skapa en kreditfaktura.');
    const combined = { ...invoice, ...payload };
    if (payload.customerId && payload.customerId !== invoice.customerId && payload.details === undefined) delete combined.details;
    const replacement = draftInvoice(draft, combined);
    Object.assign(invoice, replacement, { id: invoice.id, sourceQuoteId: invoice.sourceQuoteId });
    addActivity(draft, 'Kundfakturautkast uppdaterat', invoice.id);
  });
}

export function issueInvoice(state, id) {
  assert(state.company.method !== 'cash', 'Detta bolag använder kontantmetoden. Öppna arbetsytan Kontantmetoden för fakturor och betalningar.'); return transact(state, draft => issueInDraft(draft, id)); }

export function copyInvoice(state, id, { date, dueDate }) {
  assert(state.company.method !== 'cash', 'Detta bolag använder kontantmetoden. Öppna arbetsytan Kontantmetoden för fakturor och betalningar.');
  return transact(state, draft => {
    const source = invoiceFor(draft, id);
    if (source.status !== 'draft') assert(source.bookingSnapshot === invoiceBookingSnapshot(source), 'Originalfakturans frysta uppgifter har ändrats.');
    const rot = source.rot ? Object.fromEntries(['paymentYear', 'property', 'personId', 'eligibleConfirmed', 'availableCents'].map(key => [key, source.rot[key]])) : null;
    const invoice = draftInvoice(draft, { customerId: source.customerId, projectId: source.projectId, date, dueDate,
      vatMode: source.vatMode, buyerConstructionConfirmed: source.buyerConstructionConfirmed,
      lines: structuredClone(source.lines), details: structuredClone(source.details), invoiceDiscountBps: source.invoiceDiscountBps ?? 0, rot });
    invoice.copiedFromId = source.id;
    draft.invoices.push(invoice);
    addActivity(draft, `Fakturautkast kopierat från ${source.number || 'utkast'}`, invoice.id);
  });
}

export function creditInvoice(state, id, { date, reason }) {
  assert(state.company.method !== 'cash', 'Detta bolag använder kontantmetoden. Öppna arbetsytan Kontantmetoden för fakturor och betalningar.');
  assert(!(state.rotCreditEvents ?? []).some(event => event.invoiceId === id), 'Fakturan har en ROT-rättelse. Hantera fler krediter i kredit- och återbetalningsflödet.');
  return transact(state, draft => {
    const invoice = standardInvoice(draft, id);
    assert(!invoice.settlementLastDate, 'Fakturan har redan krediter eller kvittningar. Använd kredit- och återbetalningsflödet.');
    assert(!(draft.revenueSchedules ?? []).some(item => item.invoiceId === id), 'Fakturans intäktsperiodisering behöver återföras innan fakturan krediteras.');
    assert(!(draft.rotPlans ?? []).some(item => item.invoiceId === id), 'ROT-fördelningen behöver hanteras i ett särskilt rättelseflöde innan fakturan krediteras.');
    dateField(date, 'Kreditdatum');
    assert(date >= invoice.date, 'Kreditdatum får inte ligga före originalfakturan.');
    assert(invoice.payments.length === 0, 'Denna demo krediterar bara helt obetalda fakturor. Hantera betalningen och återbetalningen separat före kreditering.');
    assert(!draft.rotClaims.some(claim => claim.invoiceId === id), 'En faktura med registrerad ROT-begäran kan inte krediteras i detta demoflöde.');
    const original = draft.entries.find(entry => entry.id === invoice.entryId);
    assert(original, 'Originalfakturans verifikation saknas.');
    const credit = structuredClone(invoice);
    Object.assign(credit, { id: nextId(draft, 'invoice-credit'), number: nextNumber(draft, 'K', draft.invoices), kind: 'credit', originalInvoiceId: id, date, dueDate: date, status: 'issued', payments: [], reminders: [], reason: text(reason, 'Krediteringsorsak') });
    credit.rot = null;
    delete credit.sourceQuoteId;
    const entry = appendEntry(draft, { date, description: `Kreditfaktura ${credit.number} för ${invoice.number}: ${credit.reason}`, sourceType: 'invoice-credit', sourceId: credit.id, correctsEntryId: original.id, rows: original.rows.map(item => row(item.account, item.creditCents, item.debitCents)) });
    credit.entryId = entry.id;
    credit.bookingSnapshot = invoiceBookingSnapshot(credit);
    draft.invoices.push(credit);
    invoice.status = 'credited';
    invoice.creditId = credit.id;
    addActivity(draft, `Faktura ${invoice.number} krediterad genom ${credit.number}`, invoice.id);
  });
}

export function receivePayment(state, id, { date, amountCents, payer = 'customer', reference = '', bankEventId = null }) {
  assert(state.company.method !== 'cash', 'Detta bolag använder kontantmetoden. Öppna arbetsytan Kontantmetoden för fakturor och betalningar.');
  return transact(state, draft => {
    const invoice = standardInvoice(draft, id);
    dateField(date, 'Betalningsdatum');
    requireOpenPeriod(draft, date);
    assert(date >= invoice.date, 'Betalningsdatum får inte ligga före fakturadatum.');
    assert(!invoice.settlementLastDate || date >= invoice.settlementLastDate, 'Betalningen får inte dateras före fakturans senaste kredit eller kvittning.');
    cents(amountCents);
    assert(amountCents > 0, 'Betalningen måste vara större än noll.');
    assert(['customer', 'tax'].includes(payer), 'Välj kund eller Skatteverket som betalare.');
    const rotCorrections = (draft.rotCreditEvents ?? []).filter(event => event.invoiceId === id);
    assert(payer !== 'tax' || !rotCorrections.length, 'Fakturan har en ROT-rättelse. Registrera Skatteverkets betalning i det korrigerade ROT-flödet.');
    assert(rotCorrections.every(event => date >= event.date), 'Betalningen får inte dateras före fakturans senaste ROT-rättelse.');
    assert(payer !== 'tax' || !(draft.rotPlans ?? []).some(plan => plan.invoiceId === id), 'Registrera utbetalningen i ROT-arbetsytan för fakturans delbegäran.');
    if (invoice.rot && payer === 'customer') assert(Number(date.slice(0, 4)) === invoice.rot.paymentYear, 'ROT-demon kräver att kundbetalningen ligger under det angivna betalningsåret.');
    const paymentReference = reference ? text(reference, 'Betalningsreferens', 100) : bankEventId ? `bank:${bankEventId}` : `${payer}:${date}:${amountCents}`;
    assert(!invoice.payments.some(payment => payment.reference === paymentReference), 'Betalningen är redan registrerad. Ange en unik referens om det är en annan betalning med samma datum och belopp.');
    const totals = getInvoiceTotals(invoice);
    const previouslyPaid = sum(invoice.payments.filter(payment => payment.payer === payer).map(payment => payment.amountCents));
    const limit = payer === 'tax' ? totals.rotCents : totals.customerCents;
    if (payer === 'tax') {
      assert(invoice.rot && invoice.rot.status === 'approved', 'Registrera en ROT-begäran och ett godkänt beslut före Skatteverkets betalning.');
      const claim = draft.rotClaims.find(item => item.id === invoice.rot.claimId);
      assert(claim?.status === 'approved' && validDate(claim.decisionDate) && date >= claim.decisionDate, 'Skatteverkets betalning får inte ligga före ROT-beslutet.');
    }
    assert(amountCents <= limit - previouslyPaid && amountCents <= getInvoiceOutstanding(invoice), 'Betalningen överstiger kvarvarande belopp för betalaren.');
    const bankEvent = bankEventId ? draft.bankTransactions.find(event => event.id === bankEventId) : null;
    if (bankEventId) {
      assert(bankEvent && !bankEvent.matchedEntryId, 'Bankhändelsen saknas eller är redan matchad.');
      assert(bankEvent.account === '1930' && bankEvent.date === date && bankEvent.amountCents === amountCents, 'Bankhändelsens konto, datum och belopp måste motsvara kundbetalningen.');
    }
    const paymentId = nextId(draft, 'customer-payment');
    const entry = appendEntry(draft, { date, description: `${payer === 'tax' ? 'ROT-utbetalning' : 'Kundbetalning'} ${invoice.number}`, sourceType: 'customer-payment', sourceId: paymentId, rows: [row('1930', amountCents), row('1510', 0, amountCents)] });
    const payment = { id: paymentId, date, amountCents, payer, entryId: entry.id, reference: paymentReference, bankEventId: bankEventId || nextId(draft, 'bank') };
    invoice.payments.push(payment);
    if (bankEvent) bankEvent.matchedEntryId = entry.id;
    else draft.bankTransactions.push({ id: payment.bankEventId, date, description: `${payer === 'tax' ? 'Skatteverket ROT' : customerFor(draft, invoice.customerId).name} · ${invoice.number}`, account: '1930', amountCents, matchedEntryId: entry.id });
    if (invoice.rot && getInvoiceOutstanding(invoice) === 0) invoice.rot.status = 'settled';
    addActivity(draft, `Betalning registrerad för ${invoice.number}`, invoice.id);
  });
}

export function recordReminder(state, id) {
  return transact(state, draft => {
    const invoice = standardInvoice(draft, id);
    assert(getInvoiceOutstanding(invoice) > 0, 'Fakturan är redan slutbetald.');
    const reminder = { id: nextId(draft, 'reminder'), date: new Date().toISOString().slice(0, 10), note: 'Förberedd demopåminnelse; inget har skickats.' };
    invoice.reminders.push(reminder);
    addActivity(draft, `Påminnelse förberedd för ${invoice.number}; inget skickat`, invoice.id);
  });
}

export function requestRot(state, id, { date, workCompletedConfirmed = false, electronicPaymentConfirmed = false }) {
  assert(!(state.rotCreditEvents ?? []).some(event => event.invoiceId === id), 'Fakturan har en ROT-rättelse. Förbered begäran i det korrigerade ROT-flödet.');
  return transact(state, draft => {
    const invoice = standardInvoice(draft, id);
    assert(!(draft.rotPlans ?? []).some(plan => plan.invoiceId === id), 'Förbered delbegäran i ROT-arbetsytan för den befintliga personfördelningen.');
    dateField(date, 'Begärandedatum');
    assert(invoice.rot && invoice.rot.status === 'awaiting-customer', 'Fakturan saknar en ROT-begäran att förbereda, eller så är begäran redan registrerad.');
    assert(workCompletedConfirmed === true, 'Bekräfta att arbetet är utfört innan ROT-underlaget förbereds.');
    assert(electronicPaymentConfirmed === true, 'Bekräfta att kundens betalning har gjorts elektroniskt.');
    const totals = getInvoiceTotals(invoice);
    const customerPayments = invoice.payments.filter(payment => payment.payer === 'customer');
    assert(sum(customerPayments.map(payment => payment.amountCents)) >= totals.customerCents, 'Kundens hela del måste vara betald innan ROT-begäran förbereds.');
    assert(date >= invoice.date && customerPayments.every(payment => date >= payment.date), 'Begärandedatum får inte ligga före kundens betalning.');
    assert(date <= `${invoice.rot.paymentYear + 1}-01-31`, 'ROT-begäran måste komma in senast den 31 januari året efter betalningen.');
    assert(!draft.rotClaims.some(claim => claim.invoiceId === id), 'ROT-begäran är redan registrerad.');
    const claim = { id: nextId(draft, 'rot-claim'), invoiceId: id, date, requestedCents: totals.rotCents, status: 'prepared', note: 'Demounderlag – ej inskickat till Skatteverket.' };
    draft.rotClaims.push(claim);
    invoice.rot.status = 'requested';
    invoice.rot.claimId = claim.id;
    invoice.rot.workCompletedConfirmed = true;
    invoice.rot.electronicPaymentConfirmed = true;
    addActivity(draft, `ROT-underlag för ${invoice.number} förberett; ej inskickat`, invoice.id);
  });
}

export function decideRot(state, id, { date, approvedCents, reason = '' }) {
  assert(!(state.rotCreditEvents ?? []).some(event => event.invoiceId === id), 'Fakturan har en ROT-rättelse. Registrera beslutet i det korrigerade ROT-flödet.');
  return transact(state, draft => {
    const invoice = standardInvoice(draft, id);
    assert(!(draft.rotPlans ?? []).some(plan => plan.invoiceId === id), 'Registrera beslutet i ROT-arbetsytan för fakturans delbegäran.');
    dateField(date, 'Beslutsdatum');
    assert(invoice.rot?.status === 'requested', 'Förbered ROT-begäran innan ett demobeslut registreras.');
    const claim = draft.rotClaims.find(item => item.id === invoice.rot.claimId);
    assert(claim && claim.status === 'prepared', 'ROT-begäran saknas eller har redan ett beslut.');
    cents(approvedCents);
    assert(approvedCents % 100 === 0, 'ROT-beslutets belopp ska anges i hela kronor.');
    assert(approvedCents <= claim.requestedCents, 'Godkänt belopp får inte överstiga begäran.');
    assert(date >= claim.date, 'Beslutsdatum får inte ligga före begäran.');
    if (approvedCents < claim.requestedCents) text(reason, 'Skäl till minskat ROT-belopp');
    claim.status = approvedCents ? 'approved' : 'denied';
    claim.approvedCents = approvedCents;
    claim.decisionDate = date;
    claim.reason = String(reason).trim();
    invoice.rot.approvedCents = approvedCents;
    invoice.rot.status = approvedCents ? 'approved' : 'denied';
    addActivity(draft, `Demobeslut ROT ${invoice.number}: ${approvedCents ? 'helt eller delvis godkänt' : 'avslag'}; eventuell rest betalas av kunden`, invoice.id);
  });
}
