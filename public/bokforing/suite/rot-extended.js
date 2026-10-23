// Multi-person allocations and proportional applications for the 2026 ROT demo.
// The original invoice remains frozen; identity, eligibility and capacity are
// user-reviewed information, not data returned by Skatteverket.
import { assert, cents, validDate, nextId, addActivity, appendEntry, requireOpenPeriod, transact } from './core.js';
import { calculateRot } from './rot.js';
import { getInvoiceTotals } from './sales.js';
import { getRotCreditState, rotCreditHistoricalInvoice, validateRotCreditEvents } from './rot-credit.js';

export const ROT_EXTENDED_SOURCE = 'https://www.skatteverket.se/foretagorganisationer/sjalvservice/svarpavanligafragor/rotochrutarbete/foretagrotochrutarbetefaq/narskajagsomutforareansokaomutbetalningdakundenbetalatbaraendelavfakturabeloppetexempelvisviddelfaktureringochvadhanderombetalningargorspabadasidornaavettarsskifte.5.71004e4c133e23bf6db800013003.html';
const cap = 5_000_000;
const sum = values => values.reduce((a, b) => cents(a + b), 0);
const txt = (value, title, max = 160) => { assert(typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value), `Ange ${title}.`); return value.trim(); };
const personKey = value => value.replace(/[\s-]/g, '').toUpperCase();
const dateCheck = value => assert(validDate(value), 'Ange ett giltigt datum.');
const whole = value => { cents(value); assert(value % 100 === 0, 'ROT-belopp anges i hela kronor.'); return value; };
const invoiceFor = (state, id) => { const invoice = state.invoices.find(item => item.id === id); assert(invoice?.kind === 'invoice' && invoice.status === 'issued' && invoice.rot, 'Välj en utfärdad ROT-faktura.'); return invoice; };
const planFor = (state, id) => { const plan = state.rotPlans?.find(item => item.id === id); assert(plan, 'ROT-fördelningen saknas.'); return plan; };
const appFor = (state, id) => { const app = state.rotApplications?.find(item => item.id === id); assert(app, 'ROT-delbegäran saknas.'); return app; };
const planSnapshot = plan => JSON.stringify([plan.id, plan.invoiceId, plan.date, plan.paymentYear, plan.property, plan.reservedCents, plan.customerPortionCents, plan.participants]);
const requestSnapshot = app => JSON.stringify([app.id, app.planId, app.date, app.paymentYear, app.basisPayments, app.basisPaidCents, app.requestedCents, app.personLines, app.workCompletedConfirmed, app.electronicPaymentConfirmed]);
const decisionSnapshot = decision => JSON.stringify([decision.date, decision.personLines, decision.reason]);
const repaymentSnapshot = item => JSON.stringify([item.id, item.applicationId, item.invoiceId, item.date, item.amountCents, item.reason, item.reference, item.entryId, item.bankEventId]);

function participantValues(input) {
  assert(Array.isArray(input) && input.length >= 1 && input.length <= 10, 'Ange 1–10 personer i ROT-fördelningen.');
  const keys = new Set();
  return input.map(person => {
    const personId = txt(person.personId, 'personidentifierare', 100), key = personKey(personId);
    assert(!keys.has(key), 'Samma person får bara anges en gång.'); keys.add(key);
    const allocationCents = whole(person.allocationCents), availableCents = whole(person.availableCents);
    assert(allocationCents > 0 && allocationCents <= Math.min(cap, availableCents), 'Personens ROT-del överstiger uppgivet utrymme eller årstaket.');
    assert(person.eligibleConfirmed === true, 'Bekräfta ägande och övriga ROT-villkor för varje person.');
    return { personId, name: txt(person.name, 'personens namn'), allocationCents, availableCents, eligibleConfirmed: true };
  });
}

function allocationAt(plan, paidCents, previouslyRequested = new Map()) {
  const applied = Math.min(paidCents, plan.customerPortionCents);
  const target = Math.floor(Number(BigInt(plan.reservedCents) * BigInt(applied) / BigInt(plan.customerPortionCents)) / 100) * 100;
  const amounts = plan.participants.map(person => Math.floor(Number(BigInt(person.allocationCents) * BigInt(applied) / BigInt(plan.customerPortionCents)) / 100) * 100);
  let remainder = target - sum(amounts);
  const ranked = plan.participants.map((person, index) => ({ index, remainder: BigInt(person.allocationCents) * BigInt(applied) % (BigInt(plan.customerPortionCents) * 100n) })).sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const { index } of ranked) if (remainder >= 100 && amounts[index] + 100 <= plan.participants[index].allocationCents) { amounts[index] += 100; remainder -= 100; }
  assert(remainder === 0, 'ROT-fördelningen kunde inte summeras i hela kronor.');
  // Largest-remainder apportionment can reduce one person's share as the
  // cumulative payment increases. A submitted share cannot be withdrawn by a
  // later request. Preserve those floors, removing any excess from the most
  // overallocated participant who still has an unsubmitted share.
  const floors = plan.participants.map(person => previouslyRequested.get(personKey(person.personId)) ?? 0);
  assert(sum(floors) <= target, 'Tidigare ROT-begäranden överstiger betald andel.');
  amounts.forEach((amount, index) => { amounts[index] = Math.max(amount, floors[index]); });
  let excess = sum(amounts) - target;
  while (excess > 0) {
    let selected = -1, largest;
    for (let index = 0; index < amounts.length; index++) {
      if (amounts[index] <= floors[index]) continue;
      const over = BigInt(amounts[index]) * BigInt(plan.customerPortionCents) - BigInt(plan.participants[index].allocationCents) * BigInt(applied);
      // On equal surplus retain the earlier participant's rounding priority.
      if (selected < 0 || over > largest || over === largest && index > selected) { selected = index; largest = over; }
    }
    assert(selected >= 0, 'ROT-fördelningen kan inte minska tidigare begärda personbelopp.');
    amounts[selected] -= 100; excess -= 100;
  }
  return plan.participants.map((person, index) => ({ personId: person.personId, amountCents: amounts[index] }));
}

function entitlement(state, plan) {
  const apps = (state.rotApplications ?? []).filter(item => item.planId === plan.id);
  const denied = sum(apps.filter(app => app.decision).map(app => app.requestedCents - sum(app.decision.personLines.map(person => person.approvedCents))));
  const returned = sum((state.rotRepayments ?? []).filter(item => item.invoiceId === plan.invoiceId).map(item => item.amountCents));
  return plan.reservedCents - denied - returned;
}

function syncInvoice(state, plan) {
  const invoice = invoiceFor(state, plan.invoiceId);
  invoice.rot.approvedCents = entitlement(state, plan);
  invoice.rotRepaymentCents = sum((state.rotRepayments ?? []).filter(item => item.invoiceId === invoice.id).map(item => item.amountCents));
  const paid = sum(invoice.payments.map(item => item.amountCents));
  invoice.rot.status = paid - invoice.rotRepaymentCents === getInvoiceTotals(invoice).grossCents ? 'settled' : 'awaiting-customer';
}

function validateOriginalRotApplications(state) {
  const plans = state.rotPlans ?? [], apps = state.rotApplications ?? [], repayments = state.rotRepayments ?? [];
  assert(Array.isArray(plans) && Array.isArray(apps) && Array.isArray(repayments) && plans.length <= 20000 && apps.length <= 20000 && repayments.length <= 20000, 'ROT-historiken har fel format.');
  const planIds = new Set(), invoiceIds = new Set(), appIds = new Set(), repaymentIds = new Set(), used = new Map(), claimedEntryIds = new Set();
  for (const plan of plans) {
    assert(typeof plan.id === 'string' && !planIds.has(plan.id) && !invoiceIds.has(plan.invoiceId), 'ROT-fördelningen finns flera gånger.'); planIds.add(plan.id); invoiceIds.add(plan.invoiceId);
    const invoice = invoiceFor(state, plan.invoiceId); dateCheck(plan.date);
    assert(plan.date >= invoice.date && plan.paymentYear === 2026 && invoice.rot.paymentYear === 2026 && plan.property === invoice.rot.property, 'ROT-planens datum, bostad eller betalningsår är ogiltigt.');
    assert(!invoice.rot.claimId && !state.rotClaims.some(item => item.invoiceId === invoice.id), 'ROT-fakturan får inte ha både äldre begäran och delbegäranden.');
    assert(!invoice.creditId && !(state.settlements ?? []).some(item => item.side === 'customer' && item.documentId === invoice.id), 'Krediterad ROT-faktura kräver särskild avstämning.');
    const people = participantValues(plan.participants);
    assert(JSON.stringify(people) === JSON.stringify(plan.participants) && sum(people.map(person => person.allocationCents)) === plan.reservedCents && plan.reservedCents === invoice.rot.reservedCents && plan.reservedCents <= calculateRot(invoice).deductionCents, 'ROT-personernas fördelning stämmer inte med fakturans frysta avdrag.');
    assert(plan.customerPortionCents === getInvoiceTotals(invoice).grossCents - plan.reservedCents && plan.customerPortionCents > 0, 'ROT-planens kundandel är fel.');
    assert(plan.bookingSnapshot === planSnapshot(plan), 'ROT-fördelningen får inte skrivas över efter att den sparats.');
    for (const person of people) { const key = `${plan.paymentYear}:${personKey(person.personId)}`, prior = used.get(key) ?? { amount: 0, capacity: cap }; prior.amount += person.allocationCents; prior.capacity = Math.min(prior.capacity, person.availableCents); used.set(key, prior); }
  }
  // Existing single-person invoices keep reserving their capacity alongside plans.
  for (const invoice of state.invoices) if (invoice.rot && invoice.kind === 'invoice' && invoice.status === 'issued' && !invoiceIds.has(invoice.id)) {
    const key = `${invoice.rot.paymentYear}:${personKey(invoice.rot.personId)}`, prior = used.get(key) ?? { amount: 0, capacity: cap };
    prior.amount += invoice.rot.approvedCents ?? invoice.rot.reservedCents ?? 0; prior.capacity = Math.min(prior.capacity, invoice.rot.availableCents); used.set(key, prior);
  }
  for (const value of used.values()) assert(value.amount <= value.capacity && value.amount <= cap, 'Personens sammanlagda ROT-reservationer överstiger uppgivet årsutrymme.');
  const previous = new Map();
  for (const app of apps) {
    assert(typeof app.id === 'string' && !appIds.has(app.id), 'ROT-delbegärans ID är ogiltigt eller dubbelt.'); appIds.add(app.id);
    const plan = planFor(state, app.planId), invoice = invoiceFor(state, plan.invoiceId); dateCheck(app.date);
    assert(app.paymentYear === plan.paymentYear && app.date <= `${app.paymentYear + 1}-01-31` && app.workCompletedConfirmed === true && app.electronicPaymentConfirmed === true, 'ROT-delbegärans år, tidsfrist eller bekräftelser saknas.');
    assert(Array.isArray(app.basisPayments) && app.basisPayments.length > 0 && new Set(app.basisPayments.map(item => item.id)).size === app.basisPayments.length, 'ROT-delbegärans betalningsunderlag saknas eller är dubbelt.');
    for (const basis of app.basisPayments) { const payment = invoice.payments.find(item => item.id === basis.id); assert(payment?.payer === 'customer' && payment.date === basis.date && payment.amountCents === basis.amountCents && payment.date <= app.date && payment.date.slice(0, 4) === String(app.paymentYear), 'ROT-underlaget hänvisar till en ändrad eller felaktig kundbetalning.'); }
    assert(app.basisPaidCents === sum(app.basisPayments.map(item => item.amountCents)), 'ROT-begärans betalningssumma har ändrats.');
    const prior = previous.get(plan.id) ?? { requested: new Map(), date: plan.date, basis: new Set() };
    assert(app.date >= prior.date && [...prior.basis].every(id => app.basisPayments.some(item => item.id === id)), 'ROT-delbegäranden måste följa datum och tidigare betalningsunderlag.');
    const cumulative = allocationAt(plan, app.basisPaidCents, prior.requested);
    const expected = cumulative.map(person => ({ personId: person.personId, amountCents: person.amountCents - (prior.requested.get(personKey(person.personId)) ?? 0) }));
    assert(expected.every(person => person.amountCents >= 0) && JSON.stringify(app.personLines) === JSON.stringify(expected) && app.requestedCents === sum(expected.map(person => person.amountCents)) && app.requestedCents > 0, 'ROT-delbegäran överstiger betald andel eller använder samma del flera gånger.');
    assert(app.bookingSnapshot === requestSnapshot(app), 'ROT-delbegärans ursprungliga underlag har ändrats.');
    for (const person of cumulative) prior.requested.set(personKey(person.personId), person.amountCents); prior.date = app.date; prior.basis = new Set(app.basisPayments.map(item => item.id)); previous.set(plan.id, prior);
    if (app.decision) {
      dateCheck(app.decision.date); assert(app.decision.date >= app.date && Array.isArray(app.decision.personLines) && app.decision.personLines.length === app.personLines.length, 'ROT-beslutets datum eller personer är ogiltiga.');
      app.decision.personLines.forEach((person, index) => { whole(person.approvedCents); assert(person.personId === app.personLines[index].personId && person.approvedCents <= app.personLines[index].amountCents, 'Godkänt ROT överstiger begärt belopp för personen.'); });
      const approved = sum(app.decision.personLines.map(person => person.approvedCents));
      if (approved < app.requestedCents) txt(app.decision.reason, 'orsak till avslaget', 300);
      assert(app.decision.bookingSnapshot === decisionSnapshot(app.decision), 'Det registrerade ROT-beslutet har ändrats.');
      const paid = invoice.payments.filter(payment => payment.rotApplicationId === app.id);
      assert(Array.isArray(app.receiptIds) && JSON.stringify(app.receiptIds) === JSON.stringify(paid.map(payment => payment.id)), 'ROT-utbetalningarnas koppling till delbegäran är fel.');
      assert(sum(paid.map(payment => payment.amountCents)) <= approved, 'ROT-utbetalningen överstiger godkänt belopp.');
      paid.forEach(payment => assert(payment.payer === 'tax' && payment.date >= app.decision.date, 'ROT-utbetalningen saknar föregående beslut.'));
    } else assert(!(app.receiptIds?.length) && !invoice.payments.some(payment => payment.rotApplicationId === app.id), 'ROT-utbetalning kräver ett registrerat beslut.');
  }
  for (const item of repayments) {
    assert(typeof item.id === 'string' && !repaymentIds.has(item.id), 'ROT-återbetalningen finns flera gånger.'); repaymentIds.add(item.id);
    const app = appFor(state, item.applicationId), plan = planFor(state, app.planId), invoice = invoiceFor(state, plan.invoiceId); dateCheck(item.date); cents(item.amountCents, false); txt(item.reason, 'orsak till återbetalningen', 300); txt(item.reference, 'återbetalningsreferens', 100);
    assert(item.invoiceId === invoice.id && app.decision && item.date >= app.decision.date, 'ROT-återbetalningens faktura eller datum är fel.');
    const received = sum(invoice.payments.filter(payment => payment.rotApplicationId === app.id && payment.date <= item.date).map(payment => payment.amountCents));
    const returned = sum(repayments.slice(0, repayments.indexOf(item) + 1).filter(other => other.applicationId === app.id).map(other => other.amountCents)); assert(returned <= received, 'Återbetalningen överstiger mottaget ROT-belopp.');
    const entry = state.entries.find(entry => entry.id === item.entryId);
    assert(entry?.sourceType === 'rot-repayment' && entry.sourceId === item.id && entry.date === item.date && JSON.stringify(entry.rows) === JSON.stringify([{ account: '1510', debitCents: item.amountCents, creditCents: 0 }, { account: '1930', debitCents: 0, creditCents: item.amountCents }]), 'ROT-återbetalningens verifikation saknas eller har ändrats.');
    const bank = state.bankTransactions.find(event => event.id === item.bankEventId); assert(bank?.matchedEntryId === entry.id && bank.account === '1930' && bank.amountCents === -item.amountCents && bank.date === item.date, 'ROT-återbetalningens bankhändelse är fel.');
    assert(item.bookingSnapshot === repaymentSnapshot(item), 'ROT-återbetalningens underlag har ändrats.'); claimedEntryIds.add(entry.id);
  }
  for (const plan of plans) {
    const invoice = invoiceFor(state, plan.invoiceId);
    assert(invoice.rot.approvedCents === entitlement(state, plan), 'ROT-fakturans aktuella avdrag stämmer inte med beslut och återkrav.');
    assert((invoice.rotRepaymentCents ?? 0) === sum(repayments.filter(item => item.invoiceId === invoice.id).map(item => item.amountCents)), 'ROT-fakturans återbetalade belopp är fel.');
    const settled = sum(invoice.payments.map(item => item.amountCents)) - (invoice.rotRepaymentCents ?? 0) === getInvoiceTotals(invoice).grossCents;
    assert(invoice.rot.status === (settled ? 'settled' : 'awaiting-customer'), 'ROT-fakturans status stämmer inte med betalningarna.');
    assert(!invoice.payments.some(payment => payment.payer === 'tax' && !apps.some(app => app.id === payment.rotApplicationId && app.planId === plan.id)), 'ROT-betalningen saknar giltig delbegäran.');
  }
  return { claimedEntryIds, receivableAdjustmentCents: sum(repayments.map(item => item.amountCents)) };
}

export function validateRotApplications(state) {
  const corrected=new Set((state.rotCreditEvents??[]).map(item=>item.invoiceId));
  if(!corrected.size)return validateOriginalRotApplications(state);
  validateRotCreditEvents(state);
  const historical={...state,invoices:state.invoices.map(invoice=>rotCreditHistoricalInvoice(state,invoice)),
    settlements:(state.settlements??[]).filter(item=>!corrected.has(item.documentId))};
  return validateOriginalRotApplications(historical);
}

export function createRotPlan(state, invoiceId, payload) {
  validateRotApplications(state);
  return transact(state, draft => {
    const invoice = invoiceFor(draft, invoiceId);
    assert(!getRotCreditState(draft,invoiceId),'Använd ROT-rättelseflödet för den krediterade fakturan.');
    assert(!draft.rotPlans?.some(item => item.invoiceId === invoiceId) && !draft.rotClaims.some(item => item.invoiceId === invoiceId) && !invoice.payments.some(item => item.payer === 'tax'), 'Fakturan har redan en ROT-fördelning eller begäran.');
    dateCheck(payload.date); assert(payload.date >= invoice.date && invoice.rot.paymentYear === 2026, 'Denna regelversion stöder ROT-betalningar 2026.');
    const participants = participantValues(payload.participants), reservedCents = invoice.rot.reservedCents;
    assert(sum(participants.map(person => person.allocationCents)) === reservedCents, 'Personernas fördelning ska summera till fakturans frysta ROT-avdrag.');
    const plan = { id: nextId(draft, 'rot-plan'), invoiceId, date: payload.date, paymentYear: 2026, property: invoice.rot.property, reservedCents, customerPortionCents: getInvoiceTotals(invoice).grossCents - reservedCents, participants };
    plan.bookingSnapshot = planSnapshot(plan); (draft.rotPlans ??= []).push(plan); draft.rotApplications ??= []; draft.rotRepayments ??= []; syncInvoice(draft, plan);
    addActivity(draft, `ROT för ${invoice.number} fördelat på ${participants.length} granskade personer.`, invoiceId); validateRotApplications(draft);
  });
}

export function prepareRotApplication(state, planId, payload) {
  validateRotApplications(state);
  return transact(state, draft => {
    const plan = planFor(draft, planId), invoice = invoiceFor(draft, plan.invoiceId); dateCheck(payload.date);
    assert(!getRotCreditState(draft,invoice.id),'Använd ROT-rättelseflödet för den krediterade fakturan.');
    assert(payload.workCompletedConfirmed === true && payload.electronicPaymentConfirmed === true, 'Bekräfta utfört arbete och elektronisk kundbetalning.');
    assert(payload.date <= `${plan.paymentYear + 1}-01-31`, 'Begäran ska lämnas senast 31 januari efter betalningsåret.');
    const basisPayments = invoice.payments.filter(payment => payment.payer === 'customer' && payment.date <= payload.date && payment.date.slice(0, 4) === String(plan.paymentYear)).map(({ id, date, amountCents }) => ({ id, date, amountCents }));
    const basisPaidCents = sum(basisPayments.map(item => item.amountCents)); assert(basisPaidCents > 0, 'Registrera kundens elektroniska delbetalning först.');
    const previous = (draft.rotApplications ?? []).filter(item => item.planId === planId);
    const previouslyRequested = new Map(plan.participants.map(person => [personKey(person.personId), sum(previous.flatMap(app => app.personLines.filter(line => personKey(line.personId) === personKey(person.personId)).map(line => line.amountCents)))]));
    const cumulative = allocationAt(plan, basisPaidCents, previouslyRequested);
    const personLines = cumulative.map(person => ({ personId: person.personId, amountCents: person.amountCents - previouslyRequested.get(personKey(person.personId)) }));
    const requestedCents = sum(personLines.map(person => person.amountCents)); assert(requestedCents > 0, 'Det finns ingen ny betald ROT-andel att begära.');
    const app = { id: nextId(draft, 'rot-part'), planId, date: payload.date, paymentYear: plan.paymentYear, basisPayments, basisPaidCents, requestedCents, personLines, workCompletedConfirmed: true, electronicPaymentConfirmed: true, receiptIds: [] };
    app.bookingSnapshot = requestSnapshot(app); draft.rotApplications.push(app); addActivity(draft, `ROT-delbegäran förberedd för ${invoice.number}; inget skickat.`, app.id); validateRotApplications(draft);
  });
}

export function decideRotApplication(state, id, payload) {
  validateRotApplications(state);
  return transact(state, draft => {
    const app = appFor(draft, id); assert(!getRotCreditState(draft,planFor(draft,app.planId).invoiceId),'Använd ROT-rättelseflödet för den krediterade fakturan.'); assert(!app.decision, 'ROT-delbegäran har redan ett beslut.');
    const personLines = app.personLines.map(person => ({ personId: person.personId, approvedCents: whole(payload.approvedByPerson?.[person.personId] ?? person.amountCents) }));
    app.decision = { date: payload.date, personLines, reason: String(payload.reason ?? '').trim() }; app.decision.bookingSnapshot = decisionSnapshot(app.decision);
    syncInvoice(draft, planFor(draft, app.planId)); addActivity(draft, 'Demobeslut registrerat för ROT-delbegäran; avslag återstår hos kunden.', id); validateRotApplications(draft);
  });
}

export function receiveRotApplicationPayment(state, id, { date, amountCents, reference }) {
  validateRotApplications(state);
  return transact(state, draft => {
    const app = appFor(draft, id), plan = planFor(draft, app.planId), invoice = invoiceFor(draft, plan.invoiceId);
    assert(!getRotCreditState(draft,invoice.id),'Använd ROT-rättelseflödet för den krediterade fakturan.');
    assert(app.decision, 'Registrera ROT-beslutet före utbetalningen.'); requireOpenPeriod(draft, date); assert(date >= app.decision.date, 'Utbetalningen får inte ligga före beslutet.'); cents(amountCents, false);
    const ref = txt(reference, 'unik utbetalningsreferens', 100); assert(!invoice.payments.some(item => item.reference === ref), 'Utbetalningsreferensen är redan registrerad.');
    const approved = sum(app.decision.personLines.map(person => person.approvedCents)), received = sum(invoice.payments.filter(item => item.rotApplicationId === id).map(item => item.amountCents)); assert(received + amountCents <= approved, 'Utbetalningen överstiger godkänt ROT.');
    const paymentId = nextId(draft, 'customer-payment');
    const entry = appendEntry(draft, { date, description: `ROT-delutbetalning ${invoice.number}`, sourceType: 'customer-payment', sourceId: paymentId, rows: [{ account: '1930', debitCents: amountCents, creditCents: 0 }, { account: '1510', debitCents: 0, creditCents: amountCents }] });
    const bankEventId = nextId(draft, 'bank'); invoice.payments.push({ id: paymentId, date, amountCents, payer: 'tax', entryId: entry.id, reference: ref, bankEventId, rotApplicationId: id });
    draft.bankTransactions.push({ id: bankEventId, date, account: '1930', amountCents, description: `ROT-delutbetalning ${invoice.number}`, matchedEntryId: entry.id }); app.receiptIds.push(paymentId); syncInvoice(draft, plan);
    addActivity(draft, `ROT-delutbetalning registrerad för ${invoice.number}.`, id); validateRotApplications(draft);
  });
}

export function repayRotApplication(state, id, { date, amountCents, reason, reference }) {
  validateRotApplications(state);
  return transact(state, draft => {
    const app = appFor(draft, id), plan = planFor(draft, app.planId), invoice = invoiceFor(draft, plan.invoiceId); assert(!getRotCreditState(draft,invoice.id),'Använd ROT-rättelseflödet för den krediterade fakturan.'); requireOpenPeriod(draft, date); cents(amountCents, false);
    const ref = txt(reference, 'unik återbetalningsreferens', 100); txt(reason, 'orsak till återbetalningen', 300);
    assert(!(draft.rotRepayments ?? []).some(item => item.reference === ref), 'Återbetalningen är redan registrerad.');
    const record = { id: nextId(draft, 'rot-repay'), applicationId: id, invoiceId: invoice.id, date, amountCents, reason, reference: ref };
    const entry = appendEntry(draft, { date, description: `Återbetalat ROT ${invoice.number} · ${reason}`, sourceType: 'rot-repayment', sourceId: record.id, rows: [{ account: '1510', debitCents: amountCents, creditCents: 0 }, { account: '1930', debitCents: 0, creditCents: amountCents }] });
    record.entryId = entry.id; record.bankEventId = nextId(draft, 'bank'); record.bookingSnapshot = repaymentSnapshot(record); (draft.rotRepayments ??= []).push(record);
    draft.bankTransactions.push({ id: record.bankEventId, date, account: '1930', amountCents: -amountCents, description: `Återbetalat ROT ${invoice.number}`, matchedEntryId: entry.id }); syncInvoice(draft, plan);
    addActivity(draft, `ROT återbetalat; ${invoice.number} har motsvarande kundfordran igen.`, record.id); validateRotApplications(draft);
  });
}

export function getRotApplicationOverview(state, plan) {
  const invoice = invoiceFor(state, plan.invoiceId), applications = (state.rotApplications ?? []).filter(item => item.planId === plan.id);
  return { invoice, applications, approvedCents: sum(applications.flatMap(app => app.decision?.personLines.map(person => person.approvedCents) ?? [])), requestedCents: sum(applications.map(app => app.requestedCents)), entitlementCents: entitlement(state, plan), repaidCents: invoice.rotRepaymentCents ?? 0 };
}
