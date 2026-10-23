// Commercial workflows share the existing invoice, project and inventory models.
// Schedules only create drafts. No email, payment or tax filing is sent.
import { transact, appendEntry, nextId, addActivity, assert, cents, validDate, requireOpenPeriod } from './core.js';
import { createInvoice, getInvoiceTotals, getInvoiceOutstanding, invoiceBookingSnapshot, recordProjectItem } from './sales.js';
import { recordStockMovement } from './inventory.js';
import { calculateLineAmounts } from './rot.js';
import { fiscalPeriodForDate } from './fiscal-periods.js';
import { revenuePrincipal, revenueTarget } from './revenue-credit.js';

const collections = ['commercialArticles', 'commercialPrices', 'commercialInvoiceOrigins', 'recurringPlans', 'commercialReminders', 'projectStockLinks', 'revenueSchedules', 'projectWorkpapers'];
const txt = (value, label, max = 300) => { assert(typeof value === 'string' && value.trim() && value.length <= max, `Ange ${label} (högst ${max} tecken).`); return value.trim(); };
const safeDate = value => { assert(validDate(value), 'Ange ett giltigt datum.'); return value; };
const sum = values => values.reduce((n, value) => cents(n + value), 0);
const row = (account, debitCents, creditCents) => ({ account, debitCents, creditCents });
const snapshot = value => JSON.stringify(value);
const get = (items, id, label) => { const item = (items ?? []).find(candidate => candidate.id === id); assert(item, `${label} finns inte.`); return item; };
const ensure = state => { for (const key of collections) state[key] ??= []; return state; };
const fingerprint = ({ id, name, number, kind, unit, unitCents, vatRate, revision }) => ({ id, name, number, kind, unit, unitCents, vatRate, revision });
const invoiceLine = item => ({ description: item.name, kind: item.kind, quantity: item.quantity, unitCents: item.unitCents, vatRate: item.vatRate, articleNumber: item.number, unit: item.unit });
const monthIndex = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
const monthName = index => `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
const target = (amount, index, periods) => Number((BigInt(amount) * BigInt(index) + BigInt(Math.floor(periods / 2))) / BigInt(periods));

function apply(state, fn) {
  validateCommercialState(state);
  const result = transact(state, draft => { ensure(draft); fn(draft); });
  validateCommercialState(result);
  return result;
}

export function anchoredMonthDate(startDate, offset) {
  safeDate(startDate);
  assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1200, 'Ogiltigt månadsintervall.');
  const month = monthName(monthIndex(startDate) + offset);
  const [year, number] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return `${month}-${String(Math.min(Number(startDate.slice(8, 10)), lastDay)).padStart(2, '0')}`;
}

function cleanArticle(payload, current = {}) {
  assert(['labor', 'material', 'other'].includes(payload.kind), 'Välj arbete, material eller övrigt.');
  assert([0, 6, 12, 25].includes(payload.vatRate), 'Välj 0, 6, 12 eller 25 procent moms.');
  return { ...current, number: txt(payload.number, 'artikelnummer', 100), name: txt(payload.name, 'benämning'), kind: payload.kind,
    unit: txt(payload.unit, 'enhet', 30), unitCents: cents(payload.unitCents, false), vatRate: payload.vatRate,
    active: payload.active === undefined ? true : payload.active === true, revision: (current.revision ?? 0) + 1 };
}

export function saveArticle(state, payload) {
  return apply(state, draft => {
    const existing = payload.id ? get(draft.commercialArticles, payload.id, 'Artikeln') : null;
    const value = cleanArticle(payload, existing ?? {});
    assert(!draft.commercialArticles.some(item => item.id !== existing?.id && item.number.toLocaleLowerCase('sv') === value.number.toLocaleLowerCase('sv')), 'Artikelnumret används redan.');
    if (existing) Object.assign(existing, value);
    else draft.commercialArticles.push({ id: nextId(draft, 'article'), ...value });
    addActivity(draft, `Artikel ${value.number} ${existing ? 'uppdaterad' : 'upplagd'}`);
  });
}

export function setArticleActive(state, id, active) {
  return apply(state, draft => { const article = get(draft.commercialArticles, id, 'Artikeln'); article.active = active === true; addActivity(draft, `Artikel ${article.number} ${article.active ? 'aktiverad' : 'inaktiverad'}`, id); });
}

export function saveCustomerPrice(state, payload) {
  return apply(state, draft => {
    get(draft.customers, payload.customerId, 'Kunden'); get(draft.commercialArticles, payload.articleId, 'Artikeln');
    const existing = draft.commercialPrices.find(item => item.customerId === payload.customerId && item.articleId === payload.articleId);
    const value = { customerId: payload.customerId, articleId: payload.articleId, unitCents: cents(payload.unitCents, false), revision: (existing?.revision ?? 0) + 1 };
    if (existing) Object.assign(existing, value); else draft.commercialPrices.push({ id: nextId(draft, 'customer-price'), ...value });
    addActivity(draft, 'Kundspecifikt artikelpris uppdaterat', payload.customerId);
  });
}

export function articleLines(state, customerId, selections) {
  get(state.customers, customerId, 'Kunden');
  assert(Array.isArray(selections) && selections.length > 0 && selections.length <= 100, 'Välj 1–100 artikelrader.');
  return selections.map(selection => {
    const article = get(state.commercialArticles, selection.articleId, 'Artikeln');
    assert(article.active, 'Artikeln är inaktiverad.');
    assert(typeof selection.quantity === 'number' && selection.quantity > 0 && selection.quantity <= 1_000_000 && Math.abs(selection.quantity * 100 - Math.round(selection.quantity * 100)) < 0.000001, 'Antalet ska vara positivt med högst två decimaler.');
    const price = (state.commercialPrices ?? []).find(item => item.customerId === customerId && item.articleId === article.id);
    return { ...fingerprint(article), quantity: selection.quantity, unitCents: price?.unitCents ?? article.unitCents, priceId: price?.id ?? null, priceRevision: price?.revision ?? null };
  });
}

function appendInvoice(draft, payload, lines, source = {}) {
  const next = createInvoice(draft, { customerId: payload.customerId, projectId: payload.projectId || null, date: payload.date, dueDate: payload.dueDate, vatMode: 'standard', details: payload.details, lines: lines.map(invoiceLine) });
  Object.assign(draft, next);
  const invoice = draft.invoices.at(-1);
  draft.commercialInvoiceOrigins.push({ id: nextId(draft, 'invoice-origin'), invoiceId: invoice.id, lines: structuredClone(lines), lineSnapshot: snapshot(invoice.lines), ...source });
  return invoice;
}

export function createArticleInvoice(state, payload) {
  return apply(state, draft => {
    const lines = articleLines(draft, payload.customerId, payload.items);
    const invoice = appendInvoice(draft, payload, lines);
    addActivity(draft, 'Fakturautkast skapat från artikelregister och kundpriser', invoice.id);
  });
}

export function createRecurringPlan(state, payload) {
  return apply(state, draft => {
    safeDate(payload.startDate);
    assert([1, 3, 6, 12].includes(payload.intervalMonths), 'Välj ett intervall på 1, 3, 6 eller 12 månader.');
    assert(Number.isInteger(payload.dueDays) && payload.dueDays >= 0 && payload.dueDays <= 365, 'Betalningsvillkoret ska vara 0–365 dagar.');
    if (payload.endDate) assert(safeDate(payload.endDate) >= payload.startDate, 'Slutdatum får inte ligga före första fakturadatum.');
    if (payload.projectId) { const project = get(draft.projects, payload.projectId, 'Projektet'); assert(project.customerId === payload.customerId, 'Projektet tillhör en annan kund.'); }
    const lines = articleLines(draft, payload.customerId, payload.items);
    const plan = { id: nextId(draft, 'recurring'), name: txt(payload.name, 'planens namn', 150), customerId: payload.customerId, projectId: payload.projectId || null,
      startDate: payload.startDate, endDate: payload.endDate || null, intervalMonths: payload.intervalMonths, dueDays: payload.dueDays, lines, active: true, generated: [] };
    plan.definitionSnapshot = planSnapshot(plan);
    draft.recurringPlans.push(plan);
    addActivity(draft, `Återkommande fakturaplan ${plan.name} skapad`, plan.id);
  });
}
const planSnapshot = plan => snapshot([plan.name, plan.customerId, plan.projectId, plan.startDate, plan.endDate, plan.intervalMonths, plan.dueDays, plan.lines]);
export const nextRecurringDate = plan => anchoredMonthDate(plan.startDate, plan.generated.length * plan.intervalMonths);
const addDays = (date, days) => { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };

export function generateRecurringInvoices(state, { asOf, planId = null }) {
  safeDate(asOf);
  return apply(state, draft => {
    const plans = planId ? [get(draft.recurringPlans, planId, 'Fakturaplanen')] : draft.recurringPlans;
    let generated = 0;
    for (let plan of plans) {
      if (!plan.active) continue;
      let date = nextRecurringDate(plan);
      while (date <= asOf && (!plan.endDate || date <= plan.endDate)) {
        assert(++generated <= 120, 'Skapa högst 120 fakturautkast åt gången. Välj ett tidigare brytdatum.');
        requireOpenPeriod(draft, date);
        const invoice = appendInvoice(draft, { customerId: plan.customerId, projectId: plan.projectId, date, dueDate: addDays(date, plan.dueDays) }, plan.lines, { planId: plan.id, scheduledDate: date });
        plan = get(draft.recurringPlans, plan.id, 'Fakturaplanen');
        plan.generated.push({ date, invoiceId: invoice.id });
        date = nextRecurringDate(plan);
      }
    }
    if (generated) addActivity(draft, `${generated} återkommande fakturautkast skapade; inget utfärdat eller skickat`);
  });
}

export function setRecurringActive(state, id, active) {
  return apply(state, draft => { const plan = get(draft.recurringPlans, id, 'Fakturaplanen'); plan.active = active === true; addActivity(draft, `Fakturaplan ${plan.name} ${plan.active ? 'aktiverad' : 'pausad'}`, id); });
}

export function getReminderAmount(invoice) {
  const outstanding = getInvoiceOutstanding(invoice);
  if (!invoice.rot) return outstanding;
  // The expected tax-authority portion is never a customer reminder amount.
  const customerPaid = sum(invoice.payments.filter(payment => payment.payer === 'customer').map(payment => payment.amountCents));
  return Math.max(0, Math.min(outstanding, getInvoiceTotals(invoice).customerCents - customerPaid));
}

export function prepareReminder(state, { invoiceId, date, note }) {
  return apply(state, draft => {
    const invoice = get(draft.invoices, invoiceId, 'Fakturan');
    assert(invoice.kind === 'invoice' && invoice.status === 'issued' && getReminderAmount(invoice) > 0, 'Påminnelsen kräver en utfärdad faktura med obetald kundandel.');
    assert(safeDate(date) > invoice.dueDate, 'Påminnelsedatum ska ligga efter förfallodagen.');
    assert(!(draft.commercialReminders.some(item => item.invoiceId === invoiceId && item.date === date)), 'En påminnelse för fakturan och dagen finns redan.');
    const record = { id: nextId(draft, 'reminder-plan'), invoiceId, date, outstandingCents: getReminderAmount(invoice), note: txt(note, 'påminnelsetext', 2000), status: 'prepared' };
    record.snapshot = snapshot([record.invoiceId, record.date, record.outstandingCents, record.note]);
    draft.commercialReminders.push(record);
    invoice.reminders.push({ id: record.id, date, note: `Förberedd påminnelse; inget skickat. ${record.note}` });
    addActivity(draft, `Påminnelse för ${invoice.number} förberedd; inget skickat`, invoiceId);
  });
}

export function issueProjectStock(state, payload) {
  return apply(state, draft => {
    const project = get(draft.projects, payload.projectId, 'Projektet'); assert(project.status === 'active', 'Projektet är inte aktivt.');
    const item = get(draft.inventoryItems, payload.inventoryItemId, 'Lagerartikeln');
    const unitCents = cents(payload.unitCents, false);
    assert([0, 6, 12, 25].includes(payload.vatRate ?? 25), 'Ogiltig momssats.');
    const reason = txt(payload.reason, 'uttagets orsak');
    const next = recordStockMovement(draft, item.id, { date: payload.date, kind: 'out', quantity: payload.quantity, reason: `${project.name}: ${reason}` });
    Object.assign(draft, next);
    const movement = get(draft.inventoryItems, item.id, 'Lagerartikeln').movements.at(-1);
    const projectNext = recordProjectItem(draft, { projectId: project.id, description: item.name, kind: 'material', quantity: payload.quantity, unitCents, vatRate: payload.vatRate ?? 25 });
    Object.assign(draft, projectNext);
    const projectItem = get(draft.projects, project.id, 'Projektet').items.at(-1);
    const link = { id: nextId(draft, 'project-stock'), projectId: project.id, projectItemId: projectItem.id, inventoryItemId: item.id, movementId: movement.id, date: payload.date,
      quantity: payload.quantity, unitCostCents: item.unitCostCents, costCents: Number((BigInt(item.unitCostCents) * BigInt(Math.round(payload.quantity * 100)) + 50n) / 100n), projectItemSnapshot: snapshot(projectItem), movementSnapshot: snapshot(movement) };
    link.snapshot = snapshot([link.projectId, link.projectItemId, link.inventoryItemId, link.movementId, link.date, link.quantity, link.unitCostCents, link.costCents]);
    draft.projectStockLinks.push(link);
    addActivity(draft, `Lageruttag kopplat till ${project.name}; bokförd lagerförändring sker vid lagervärdering`, link.id);
  });
}

const revenueSnapshot = item => snapshot([item.invoiceId, item.date, item.amountCents, item.revenueAccount, item.startMonth, item.months, item.name]);
export function createRevenueSchedule(state, payload) {
  return apply(state, draft => {
    const invoice = get(draft.invoices, payload.invoiceId, 'Fakturan');
    assert(invoice.status === 'issued' && invoice.kind === 'invoice', 'Välj en utfärdad kundfaktura.');
    assert(!invoice.rot && !(invoice.settlementCreditCents > 0), 'ROT eller krediterad faktura kräver ett separat granskat periodiseringsflöde.');
    assert(invoice.bookingSnapshot === invoiceBookingSnapshot(invoice), 'Fakturans bokförda uppgifter har ändrats.');
    requireOpenPeriod(draft, payload.date); assert(payload.date >= invoice.date, 'Periodiseringen får inte dateras före fakturan.');
    assert(fiscalPeriodForDate(draft, invoice.date)?.start === fiscalPeriodForDate(draft, payload.date)?.start,
      'En ny intäktsperiodisering måste skapas i fakturans räkenskapsår. Ett avslutat års intäkt kräver ett separat granskat rättelseflöde.');
    const amountCents = cents(payload.amountCents, false);
    assert(sum(draft.revenueSchedules.filter(item => item.invoiceId === invoice.id).map(item => item.amountCents)) + amountCents <= getInvoiceTotals(invoice).netCents,
      'Intäkten är redan periodiserad eller beloppet överstiger fakturans netto.');
    assert(/^\d{4}-(?:0[1-9]|1[0-2])$/.test(payload.startMonth) && validDate(`${payload.startMonth}-01`) && payload.startMonth >= payload.date.slice(0, 7), 'Ange en startmånad tidigast bokföringsmånaden.');
    assert(Number.isInteger(payload.months) && payload.months >= 1 && payload.months <= 120, 'Ange 1–120 månader.');
    const revenueAccount = invoice.vatMode === 'reverse-construction' ? '3231' : '3000';
    const item = { id: nextId(draft, 'revenue-plan'), invoiceId: invoice.id, name: txt(payload.name, 'periodiseringens namn', 150), date: payload.date, amountCents, revenueAccount, startMonth: payload.startMonth, months: payload.months, postings: [], status: 'active' };
    item.entryId = appendEntry(draft, { date: item.date, description: `Förutbetald intäkt · ${item.name}`, sourceType: 'revenue-deferral', sourceId: item.id, rows: [row(revenueAccount, amountCents, 0), row('2990', 0, amountCents)] }).id;
    item.snapshot = revenueSnapshot(item); draft.revenueSchedules.push(item);
    addActivity(draft, `Intäktsperiodisering skapad, ${item.months} månader`, item.id);
  });
}

export function recognizeRevenueMonth(state, id, { date }) {
  return apply(state, draft => {
    const item = get(draft.revenueSchedules, id, 'Intäktsperiodiseringen');
    assert(item.status === 'active', 'Periodiseringen är färdig.'); requireOpenPeriod(draft, date);
    assert((draft.settlements??[]).filter(record=>record.kind==='credit'&&record.side==='customer'&&record.documentId===item.invoiceId).every(record=>date>=record.date),'Intäktsföringen får inte bakdateras före senaste kredit; periodisera färdigt tidigare månader före kreditering.');
    const month = monthName(monthIndex(item.startMonth) + item.postings.length);
    assert(date.slice(0, 7) === month && date >= item.date, `Bokför nästa planerade månad ${month}.`);
    const principal=revenuePrincipal(draft,item).principalCents;
    assert(principal>0,'Periodiseringen är helt krediterad.');
    const amountCents=revenueTarget(principal,item.postings.length+1,item.months)-revenueTarget(principal,item.postings.length,item.months);
    const entryId = amountCents ? appendEntry(draft, { date, description: `Intäktsföring ${month} · ${item.name}`, sourceType: 'revenue-recognition', sourceId: `${item.id}:${month}`, rows: [row('2990', amountCents, 0), row(item.revenueAccount, 0, amountCents)] }).id : null;
    item.postings.push({ month, date, amountCents, entryId, ...(!entryId?{entryCount:draft.entries.length}: {}) });
    if (item.postings.length === item.months) item.status = 'completed';
    addActivity(draft, `Intäkt för ${month} förd enligt plan`, item.id);
  });
}

export function getRevenueDueMonths(state, throughMonth = state.company.fiscalYearEnd.slice(0, 7)) {
  assert(/^\d{4}-(?:0[1-9]|1[0-2])$/.test(throughMonth), 'Kontrollmånaden är ogiltig.');
  return (state.revenueSchedules ?? []).flatMap(item => {
    if(revenuePrincipal(state,item).principalCents===0)return [];
    const due = [];
    for (let index = item.postings.length; index < item.months; index++) {
      const month = monthName(monthIndex(item.startMonth) + index);
      if (month > throughMonth) break;
      due.push({ scheduleId: item.id, name: item.name, month });
    }
    return due;
  });
}

export function addProjectWorkpaper(state, payload) {
  return apply(state, draft => {
    get(draft.projects, payload.projectId, 'Projektet'); safeDate(payload.date);
    assert(Number.isInteger(payload.completionBps) && payload.completionBps >= 0 && payload.completionBps <= 10000, 'Färdigställandegraden ska vara 0–100 procent.');
    const paper = { id: nextId(draft, 'project-workpaper'), projectId: payload.projectId, date: payload.date, completedCostCents: cents(payload.completedCostCents), agreedRevenueCents: cents(payload.agreedRevenueCents), completionBps: payload.completionBps,
      reviewNote: txt(payload.reviewNote, 'bedömning och vald redovisningsprincip', 2000), reviewer: txt(payload.reviewer, 'granskare', 150), status: 'review-note' };
    paper.snapshot = snapshot([paper.projectId, paper.date, paper.completedCostCents, paper.agreedRevenueCents, paper.completionBps, paper.reviewNote, paper.reviewer]);
    draft.projectWorkpapers.push(paper); addActivity(draft, 'Bedömningsunderlag för pågående arbete sparat; ingen automatisk bokning', paper.id);
  });
}

export function validateCommercialState(state) {
  for (const key of collections) {
    if (state[key] === undefined) continue;
    assert(Array.isArray(state[key]) && state[key].length <= 20000 && new Set(state[key].map(item => item.id)).size === state[key].length, `Ogiltiga eller dubbla poster i ${key}.`);
    state[key].forEach(item => assert(item && typeof item.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(item.id), 'Ogiltigt kommersiellt ID.'));
  }
  const articleNumbers = new Set();
  for (const article of state.commercialArticles ?? []) {
    const normalized = cleanArticle(article, { revision: article.revision - 1 });
    assert(snapshot(normalized) === snapshot(article) || ['number', 'name', 'kind', 'unit', 'unitCents', 'vatRate', 'active', 'revision'].every(key => normalized[key] === article[key]), 'Artikeln innehåller ogiltiga uppgifter.');
    assert(typeof article.active === 'boolean' && Number.isInteger(article.revision) && article.revision > 0, 'Artikelns version är ogiltig.');
    const key = article.number.toLocaleLowerCase('sv'); assert(!articleNumbers.has(key), 'Dubbelt artikelnummer.'); articleNumbers.add(key);
  }
  const priceKeys = new Set();
  for (const price of state.commercialPrices ?? []) {
    get(state.customers, price.customerId, 'Prisets kund'); get(state.commercialArticles, price.articleId, 'Prisets artikel'); cents(price.unitCents, false);
    const key = `${price.customerId}:${price.articleId}`; assert(!priceKeys.has(key) && Number.isInteger(price.revision) && price.revision > 0, 'Dubbelt eller ogiltigt kundpris.'); priceKeys.add(key);
  }
  const origins = new Set();
  for (const origin of state.commercialInvoiceOrigins ?? []) {
    const invoice = get(state.invoices, origin.invoiceId, 'Artikelutkastet'); assert(!origins.has(origin.invoiceId), 'Fakturan har dubbla artikelursprung.'); origins.add(origin.invoiceId);
    assert(Array.isArray(origin.lines) && origin.lines.length > 0, 'Artikelursprunget saknar rader.');
    origin.lines.forEach(line => {
      get(state.commercialArticles, line.id, 'Ursprungsartikeln'); cents(line.unitCents, false);
      assert(Number.isInteger(line.revision) && line.revision > 0, 'Artikelursprungets version är ogiltig.');
      txt(line.name, 'ursprunglig artikelbenämning'); txt(line.number, 'ursprungligt artikelnummer', 100); txt(line.unit, 'ursprunglig enhet', 30);
      calculateLineAmounts(invoiceLine(line));
    });
    // Drafts can be edited in the ordinary invoice editor. Provenance preserves the creation snapshot.
    assert(origin.lineSnapshot === snapshot(origin.lines.map(invoiceLine)), 'Artikelursprungets frysta rader har ändrats.');
    if (origin.planId) get(state.recurringPlans, origin.planId, 'Fakturaplanen');
    assert(invoice.kind === 'invoice', 'Artikelursprunget hör till en kreditfaktura.');
  }
  const scheduleInvoices = new Set();
  for (const plan of state.recurringPlans ?? []) {
    get(state.customers, plan.customerId, 'Planens kund'); txt(plan.name, 'planens namn', 150); safeDate(plan.startDate);
    assert([1, 3, 6, 12].includes(plan.intervalMonths) && Number.isInteger(plan.dueDays) && plan.dueDays >= 0 && plan.dueDays <= 365 && typeof plan.active === 'boolean', 'Fakturaplanens intervall eller status är ogiltig.');
    assert(!plan.endDate || (safeDate(plan.endDate) >= plan.startDate), 'Fakturaplanens slutdatum är ogiltigt.');
    assert(plan.definitionSnapshot === planSnapshot(plan) && Array.isArray(plan.generated) && plan.generated.length <= 1200, 'Fakturaplanens ursprungliga definition har ändrats.');
    for (const [index, generated] of plan.generated.entries()) {
      const date = anchoredMonthDate(plan.startDate, index * plan.intervalMonths);
      assert(generated.date === date && (!plan.endDate || date <= plan.endDate) && !scheduleInvoices.has(generated.invoiceId), 'Dubblerad eller feldaterad återkommande faktura.'); scheduleInvoices.add(generated.invoiceId);
      const invoice = get(state.invoices, generated.invoiceId, 'Återkommande fakturan');
      const origin = (state.commercialInvoiceOrigins ?? []).find(item => item.invoiceId === invoice.id && item.planId === plan.id);
      assert(origin?.scheduledDate === date && origin.lineSnapshot === snapshot(plan.lines.map(invoiceLine)), 'Fakturans koppling till planen har ändrats.');
    }
  }
  for (const reminder of state.commercialReminders ?? []) {
    const invoice = get(state.invoices, reminder.invoiceId, 'Påminnelsens faktura');
    assert(safeDate(reminder.date) > invoice.dueDate && reminder.status === 'prepared', 'Påminnelsens datum eller status är ogiltigt.'); cents(reminder.outstandingCents, false);
    assert(reminder.snapshot === snapshot([reminder.invoiceId, reminder.date, reminder.outstandingCents, reminder.note]), 'Påminnelsens ursprung har ändrats.');
    assert(invoice.reminders.some(item => item.id === reminder.id && item.date === reminder.date), 'Påminnelsen saknar fakturakoppling.');
  }
  const movementIds = new Set(); const projectItemIds = new Set();
  for (const link of state.projectStockLinks ?? []) {
    const project = get(state.projects, link.projectId, 'Uttagets projekt');
    const item = get(state.inventoryItems, link.inventoryItemId, 'Uttagets lagerartikel');
    const movement = get(item.movements, link.movementId, 'Lageruttaget'); const projectItem = get(project.items, link.projectItemId, 'Projektmaterialet');
    assert(!movementIds.has(movement.id) && !projectItemIds.has(projectItem.id), 'Ett lageruttag har kopplats flera gånger.'); movementIds.add(movement.id); projectItemIds.add(projectItem.id);
    assert(link.movementSnapshot === snapshot(movement) && link.projectItemSnapshot === snapshot(projectItem), 'Lageruttagets eller projektmaterialets uppgifter har ändrats.');
    assert(movement.kind === 'out' && movement.date === link.date && movement.quantity === link.quantity && projectItem.quantity === link.quantity && projectItem.kind === 'material', 'Projektkopplingen motsvarar inte lageruttaget.');
    assert(link.unitCostCents === item.unitCostCents && link.costCents === Number((BigInt(link.unitCostCents) * BigInt(Math.round(link.quantity * 100)) + 50n) / 100n), 'Projektmaterialets kostnad är ogiltig.');
    assert(link.snapshot === snapshot([link.projectId, link.projectItemId, link.inventoryItemId, link.movementId, link.date, link.quantity, link.unitCostCents, link.costCents]), 'Lagerlänkens värden har ändrats.');
  }
  const entryIds = new Set(); let deferred = 0;
  const claim = (id, type, sourceId, date, rows) => {
    const entry = get(state.entries, id, 'Periodiseringens verifikation');
    assert(!entryIds.has(id) && entry.sourceType === type && entry.sourceId === sourceId && entry.date === date && snapshot(entry.rows) === snapshot(rows), 'Intäktsperiodiseringens verifikation har ändrats.'); entryIds.add(id);
  };
  const allocated = new Map();
  for (const item of state.revenueSchedules ?? []) {
    const invoice = get(state.invoices, item.invoiceId, 'Periodiseringens faktura');
    assert(invoice.kind === 'invoice' && invoice.status === 'issued' && !invoice.rot, 'Periodiseringen kräver en utfärdad faktura utan ROT.');
    assert(item.snapshot === revenueSnapshot(item) && item.revenueAccount === (invoice.vatMode === 'reverse-construction' ? '3231' : '3000'), 'Periodiseringens grunduppgifter har ändrats.');
    cents(item.amountCents, false); safeDate(item.date); assert(item.date >= invoice.date, 'Periodiseringen ligger före fakturan.');
    assert(fiscalPeriodForDate(state, invoice.date)?.start === fiscalPeriodForDate(state, item.date)?.start, 'Intäktsperiodiseringen tillhör inte fakturans räkenskapsår.');
    assert(/^\d{4}-(?:0[1-9]|1[0-2])$/.test(item.startMonth) && item.startMonth >= item.date.slice(0, 7) && Number.isInteger(item.months) && item.months >= 1 && item.months <= 120 && Array.isArray(item.postings) && item.postings.length <= item.months, 'Periodiseringsplanen är ogiltig.');
    allocated.set(invoice.id, (allocated.get(invoice.id) ?? 0) + item.amountCents); assert(allocated.get(invoice.id) <= getInvoiceTotals(invoice).netCents, 'Fakturans intäkt har periodiserats flera gånger.');
    claim(item.entryId, 'revenue-deferral', item.id, item.date, [row(item.revenueAccount, item.amountCents, 0), row('2990', 0, item.amountCents)]);
    let recognized = 0;
    for (const [index, posting] of item.postings.entries()) {
      const month = monthName(monthIndex(item.startMonth) + index);
      const principal=posting.entryId?revenuePrincipal(state,item,posting.entryId).principalCents:posting.entryCount!==undefined?revenuePrincipal({...state,settlements:(state.settlements??[]).filter(record=>state.entries.findIndex(entry=>entry.id===record.entryId)<posting.entryCount)},item).principalCents:item.amountCents;
      const amount=revenueTarget(principal,index+1,item.months)-revenueTarget(principal,index,item.months);
      assert(posting.month === month && safeDate(posting.date).slice(0, 7) === month && posting.date >= item.date && posting.amountCents === amount, 'Intäktsföringens månad eller belopp stämmer inte.');
      if (amount) claim(posting.entryId, 'revenue-recognition', `${item.id}:${month}`, posting.date, [row('2990', amount, 0), row(item.revenueAccount, 0, amount)]);
      else assert(posting.entryId === null && (posting.entryCount===undefined||Number.isSafeInteger(posting.entryCount)&&posting.entryCount>=0&&posting.entryCount<=state.entries.length), 'Ett nollbelopp ska inte skapa en verifikation.');
      recognized += amount;
    }
    const current=revenuePrincipal(state,item);
    recognized-=current.recognizedCreditCents;
    assert((current.principalCents===0?'cancelled':item.postings.length===item.months?'completed':'active')===item.status,'Periodiseringens status stämmer inte.');
    assert(recognized>=0&&recognized<=current.principalCents,'Periodiseringens krediterade intäkt är fel.');
    deferred+=current.principalCents-recognized;
  }
  for (const paper of state.projectWorkpapers ?? []) {
    get(state.projects, paper.projectId, 'Underlagets projekt'); safeDate(paper.date); cents(paper.completedCostCents); cents(paper.agreedRevenueCents);
    assert(Number.isInteger(paper.completionBps) && paper.completionBps >= 0 && paper.completionBps <= 10000 && paper.status === 'review-note', 'Projektbedömningens färdigställandegrad är ogiltig.');
    txt(paper.reviewNote, 'granskningsanteckning', 2000); txt(paper.reviewer, 'granskare', 150);
    assert(paper.snapshot === snapshot([paper.projectId, paper.date, paper.completedCostCents, paper.agreedRevenueCents, paper.completionBps, paper.reviewNote, paper.reviewer]), 'Projektbedömningen har ändrats.');
  }
  return { entryIds, accountAdjustments: { '2990': -deferred } };
}
