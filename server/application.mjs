import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createApplicationRepository } from './application-storage.mjs';
import { createPricingStore, resolvePricingPrincipal, PricingError } from './pricing.mjs';
import { createPricingApi } from './pricing-api.mjs';
import { createTransportOutbox, createTransportIntegrationsApi } from './transport-integrations.mjs';
import { ensurePersonnel, personnelCommand, personnelProjection, personnelCan, validatePersonnelTransportChange, refreshStaffingTasks, createDriverApi } from './personnel.mjs';
import { createLogisticsApi, validateLogisticsTransportChange, synchronizeLogisticsIncomingStock } from './logistics.mjs';
import { createMobileEmployeeApi, ensureMobileEmployeeAccounts, hasEmployeeSession, employeeRequestPrincipal } from './mobile-employee-api.mjs';
import { ensureEmployeeTime, refreshEmployeeTimeNorms } from './employee-time.mjs';
import { allocateWeighingNumber } from './work-order-weighing.mjs';
import { prepareCustomerReview } from './customer-review.mjs';
import { measureDatabaseWork } from './database-runtime.mjs';
import { mobileRecordPayload } from './mobile-records.mjs';
import { createMobilePricingProjection, mobileBusinessDate } from './mobile-pricing-projection.mjs';
import { officeSchema, seedOffice, migrateOffice, storeSchema, isComplete, rowWeight, transportSchema, seedTransport, articles, recordPayment, validPaymentDetails } from '../dist-server/domain-models.mjs';

const clone = value => structuredClone(value);
const equal = (a, b) => isDeepStrictEqual(a === undefined ? a : JSON.parse(JSON.stringify(a)), b === undefined ? b : JSON.parse(JSON.stringify(b)));
const fail = (message, status = 409) => { throw new PricingError(message, status); };
const can = (p, right) => p.user.level !== 'Medarbetare' || p.user.permissions.includes(right);
const demand = (p, right) => { if (!can(p, right)) fail('Du saknar behörighet för detta moment.', 403); };
const visible = (p, card) => !p.user.siteIds || p.user.siteIds.includes(card.siteId ?? (card.yard === 'Rimbo' ? 'rimbo' : 'norrtalje'));
const mobileCustomers = customers => customers.map(({ id, name, type, number, phone, email, address, references, origins, registrations }) => ({ id, name, type, number, phone, email, address, references, origins, registrations }));
const mobileDraftSite = (state, draft) => state.metadata.mobileDraftSites?.[draft.id]
  ?? state.office.cards.find(card => card.sourceId === draft.id)?.siteId ?? 'norrtalje';
const mobileDraftVisible = (state, principal, draft) => !principal.user.siteIds || principal.user.siteIds.includes(mobileDraftSite(state, draft));
const mobileView = (state, principal) => ({ ...state.mobile, drafts: state.mobile.drafts.filter(draft => mobileDraftVisible(state, principal, draft)) });
const officeRowSchema = officeSchema.shape.cards.element.shape.rows.element;
const materialCommandSchema = z.object({
  cardId: z.number().int().positive(), expectedRows: z.array(officeRowSchema).max(100),
  operation: z.enum(['add', 'remove', 'weight']), rowIndex: z.number().int().nonnegative().optional(),
  articleId: z.string().trim().min(1).max(100).optional(), weight: z.number().finite().min(0).max(1e9).optional(),
}).strict();

// Match row identities independently of their array position. Removing the
// first row or replacing one article must not conceal another weight/price edit.
function materialRowChanges(before, after) {
  const remaining = after.map((row, index) => ({ row, index })), pairs = [], removed = [];
  const unmatched = [];
  for (const row of before) {
    const index = remaining.findIndex(candidate => equal(candidate.row, row));
    if (index >= 0) pairs.push({ before: row, after: remaining.splice(index, 1)[0].row });
    else unmatched.push(row);
  }
  for (const row of unmatched) {
    let index = remaining.findIndex(candidate => candidate.row.articleId === row.articleId && candidate.row.weight === row.weight);
    if (index < 0) index = remaining.findIndex(candidate => candidate.row.articleId === row.articleId);
    if (index >= 0) pairs.push({ before: row, after: remaining.splice(index, 1)[0].row });
    else removed.push(row);
  }
  return { pairs, removed, added: remaining.map(candidate => candidate.row) };
}
function demandMaterialChanges(principal, before, after) {
  const changes = materialRowChanges(before, after);
  if (changes.added.length) demand(principal, 'weighingAddArticle');
  if (changes.removed.length) demand(principal, 'weighingRemoveArticle');
  if (changes.pairs.some(pair => pair.before.weight !== pair.after.weight)) demand(principal, 'weighingEditWeight');
  return changes;
}
export const initialApplicationState = () => {
  const pricing = createPricingStore().exportState();
  const office = migrateOffice(seedOffice()); office.users = clone(pricing.users);
  return { metadata: { version: 1, nextCard: 3000, importedDomains: [], pricingSeed: clone(pricing), officeSeed: clone(office), transportSeed: seedTransport() }, pricing, office,
    mobile: { version: 1, drafts: [], customers: mobileCustomers(office.customers) },
    transport: seedTransport(), workOrderWeighing: { version: 1, drafts: {} }, outbox: [], imports: [] };
};

// Field-level optimistic merge. Independent fields and independent records can
// be edited concurrently; a stale change to the same field is never overwritten.
export function mergeRecord(current, base, next) {
  if (!base) {
    if (current && !equal(current, next)) fail('Posten finns redan med andra uppgifter. Ladda om och kontrollera.');
    return clone(current ?? next);
  }
  if (!current) fail('Posten har tagits bort i en annan session.');
  const result = clone(current);
  for (const field of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (equal(base[field], next[field])) continue;
    if (!equal(current[field], base[field]) && !equal(current[field], next[field])) fail('Uppgiften ändrades i en annan session. Ladda om och kontrollera.');
    if (next[field] === undefined) delete result[field]; else result[field] = clone(next[field]);
  }
  return result;
}
function changedRecords(current, base, next, key = row => row.id) {
  const old = new Map(base.map(row => [key(row), row])), wanted = new Map(next.map(row => [key(row), row]));
  const changes = [];
  for (const id of new Set([...old.keys(), ...wanted.keys()])) if (!equal(old.get(id), wanted.get(id))) {
    const index = current.findIndex(row => key(row) === id), record = current[index];
    if (!wanted.has(id)) {
      if (!equal(record, old.get(id))) fail('Posten ändrades i en annan session.');
      changes.push({ before: record, after: null, index });
    } else changes.push({ before: record, after: mergeRecord(record, old.get(id), wanted.get(id)), index });
  }
  return changes;
}
function applyChanges(current, changes) {
  const result = [...current];
  for (const change of changes) {
    const id = change.before?.id ?? change.after.id;
    const index = result.findIndex(row => row.id === id);
    if (!change.after) { if (index >= 0) result.splice(index, 1); }
    else if (index < 0) result.push(change.after); else result[index] = change.after;
  }
  return result;
}
function reflectApprovals(office, approvals, seedCards = []) {
  const latest = new Map();
  for (const a of approvals) if (!latest.has(a.cardId) || latest.get(a.cardId).version < a.version) latest.set(a.cardId, a);
  for (const a of latest.values()) {
    const index = office.cards.findIndex(card => card.id === a.cardId);
    let previous = office.cards[index];
    const card = officeSchema.shape.cards.element.parse({ ...a.snapshot.card, siteId: a.siteId, customerSnapshot: a.snapshot.customer });
    if (previous && card.sourceId && previous.sourceId && card.sourceId !== previous.sourceId) {
      if (!equal(previous, seedCards.find(row => row.id === previous.id))) continue;
      previous = undefined;
    }
    // Sending a review freezes prices in the pricing/terminal repositories before
    // the office projection is read. A mobile placeholder must bind to that
    // verified first snapshot, rather than be mistaken for a later price edit.
    // Binding happens once per new review and only for the same current draft.
    const newReview = previous && previous.customerApproval?.id !== a.id &&
      (!previous.customerApproval || previous.customerApproval.version < a.version);
    const draftMatches = previous && previous.sourceId === card.sourceId && previous.customerId === card.customerId &&
      previous.origin === card.origin && previous.reference === card.reference && previous.date === card.date &&
      (previous.siteId ? previous.siteId === card.siteId : previous.yard === card.yard) &&
      (!previous.paymentDetails || equal(previous.paymentDetails, card.paymentDetails)) &&
      equal(previous.rows.map(r => [r.articleId, r.weight]), card.rows.map(r => [r.articleId, r.weight]));
    const samePrices = previous && equal(previous.rows.map(r => r.price), card.rows.map(r => r.price));
    const pendingPrices = previous && (previous.financialPending || previous.pricingRowsPending || previous.rows.some(r => r.pricePending));
    if (newReview && draftMatches && (samePrices || pendingPrices) &&
      !['ready', 'paid', 'balance'].includes(previous.status) && ['waiting', 'id_requested', 'approved', 'attested'].includes(a.status)) {
      previous = { ...previous, rows: card.rows.map(row => ({ ...row, pricePending: false })),
        pricingSnapshotId: card.pricingSnapshotId, pricingTotal: card.pricingTotal ?? a.snapshot.gross, accounting: card.accounting,
        financialPending: false, pricingRowsPending: false, preparedBy: card.preparedBy,
        customerSnapshot: card.customerSnapshot, paymentDetails: card.paymentDetails, payment: card.payment };
    }
    // A changed current draft retains its edits until a new review is sent.
    const same = previous && previous.sourceId === card.sourceId && previous.customerId === card.customerId &&
      previous.origin === card.origin && previous.reference === card.reference && equal(previous.paymentDetails, card.paymentDetails) &&
      equal(previous.rows.map(r => [r.articleId, r.weight, r.price]), card.rows.map(r => [r.articleId, r.weight, r.price]));
    const projection = {
      ...(previous ?? card), customerApproval: { id: a.id, version: a.version, status: a.status, updatedAt: a.updatedAt,
        approvedBy: a.approvedBy, approvedAt: a.approvedAt, attestedBy: a.attestedBy, attestedAt: a.attestedAt },
    };
    // Terminal DTOs carry genuine workflow events. Merge those on the server so
    // clients never have to write a possibly redacted projection back to storage.
    projection.audit = [...(previous?.audit ?? [])];
    for (const event of card.audit) if (!projection.audit.some(old => old.at === event.at && old.actor === event.actor && old.text === event.text))
      projection.audit.push(clone(event));
    if (same || !previous) {
      projection.idVerified = ['approved', 'attested'].includes(a.status);
      if (a.status === 'attested' && !['paid', 'balance'].includes(previous?.status)) {
        projection.status = card.paymentDetails?.method === 'balance' ? 'balance' : 'ready';
        projection.approvedBy = card.approvedBy;
      }
      else if (a.status === 'approved' && !['ready', 'paid', 'balance'].includes(previous?.status)) projection.status = 'attest';
      else if (['waiting', 'id_requested'].includes(a.status)) projection.status = 'customer';
      else if (['change_requested', 'cancelled', 'expired'].includes(a.status) && !['ready', 'paid', 'balance'].includes(previous?.status)) projection.status = 'complement';
    } else if (!['paid', 'balance'].includes(previous.status)) {
      projection.status = 'complement'; projection.idVerified = false;
    }
    if (index < 0) office.cards.push(projection); else office.cards[index] = projection;
  }
}
function approvalValid(card, approvals, required) {
  const a = approvals.find(a => a.id === card.customerApproval?.id);
  if (!a || a.status !== required || a.version !== card.customerApproval.version || a.cardId !== card.id) return false;
  const original = a.snapshot.card;
  return original.sourceId === card.sourceId && original.customerId === card.customerId && original.origin === card.origin && original.reference === card.reference &&
    card.pricingSnapshotId === original.pricingSnapshotId && card.pricingTotal === a.snapshot.gross && equal(original.rows.map(r => [r.articleId, r.weight, r.price]), card.rows.map(r => [r.articleId, r.weight, r.price])) && equal(original.paymentDetails, card.paymentDetails);
}
const financial = p => ['reports', 'attest', 'pay'].some(right => can(p, right));
function officeView(state, p) {
  const result = clone(state.office); result.users = clone(state.pricing.users);
  result.cards = result.cards.filter(card => visible(p, card));
  const ids = new Set(result.cards.map(card => card.id));
  result.payments = can(p, 'reports') || can(p, 'pay') ? result.payments.filter(payment => ids.has(payment.cardId)) : [];
  result.corrections = can(p, 'corrections') || financial(p) ? result.corrections.filter(row => ids.has(row.cardId)) : [];
  for (const card of result.cards) {
    const moneyVisible = financial(p) || card.rows.every(row => can(p, 'prices') && can(p, 'customerPrices') &&
      (row.tier === 'Eget' || can(p, `price${row.tier}`)));
    if (!moneyVisible) { card.financialPending = true; delete card.pricingTotal; delete card.accounting; card.rows = card.rows.map(row => ({ ...row, price: 0, pricePending: true })); }
    if (!can(p, 'paymentDetails') && !financial(p)) { delete card.paymentDetails; card.payment = ''; if (card.customerSnapshot) delete card.customerSnapshot.paymentProfile; }
  }
  if (!can(p, 'paymentDetails') && !financial(p)) for (const customer of result.customers) delete customer.paymentProfile;
  return result;
}
async function validateOffice(state, base, next, p, approvals, guardMaterialChange) {
  demand(p, 'view');
  const current = state.office;
  const readable = officeView(state, p);
  for (const old of base.cards) {
    const original = current.cards.find(card => card.id === old.id), view = readable.cards.find(card => card.id === old.id), target = next.cards.find(card => card.id === old.id);
    if (!original || !view) continue;
    for (const field of ['financialPending', 'pricingTotal', 'accounting', 'paymentDetails', 'payment', 'customerSnapshot']) if (equal(old[field], view[field]) && !equal(old[field], original[field])) {
      if (target && equal(target[field], old[field])) { if (original[field] === undefined) delete target[field]; else target[field] = clone(original[field]); }
      if (original[field] === undefined) delete old[field]; else old[field] = clone(original[field]);
    }
    old.rows.forEach((row, i) => {
      if (!original.rows[i] || !view.rows[i]) return;
      for (const field of ['price', 'pricePending']) if (equal(row[field], view.rows[i][field]) && !equal(row[field], original.rows[i][field])) {
        const changedRow = target?.rows.find(candidate => candidate.articleId === row.articleId && candidate.weight === row.weight)
          ?? (target?.rows[i]?.articleId === row.articleId ? target.rows[i] : undefined);
        if (changedRow?.articleId === row.articleId && equal(changedRow[field], row[field])) { if (original.rows[i][field] === undefined) delete changedRow[field]; else changedRow[field] = original.rows[i][field]; }
        if (original.rows[i][field] === undefined) delete row[field]; else row[field] = original.rows[i][field];
      }
    });
  }
  const changes = changedRecords(current.cards, base.cards, next.cards);
  for (const { before, after } of changes) {
    if (!after) fail('Viktkort och deras historik får inte raderas.');
    if (before && (!equal(after.workOrderId, before.workOrderId) || before.workOrderId && !equal(after.sourceId, before.sourceId))) fail('Arbetsorderkopplingen och dess källidentitet styrs av den färdigställda vägningen.');
    if (!before && after.workOrderId) {
      const linked = state.workOrderWeighing?.drafts?.[after.workOrderId];
      if (!linked || linked.status !== 'completed' || linked.cardId !== after.id || linked.id !== after.sourceId) fail('Ett kopplat invägningskort skapas genom arbetsorderns färdigställda vägning.');
    }
    if (!visible(p, after) || before && !visible(p, before)) fail('Du saknar åtkomst till anläggningen.', 403);
    if (!before) {
      demand(p, after.kind === 'correction' ? 'attest' : 'prepare');
      if (after.accounting) fail('Ekonomiunderlaget beräknas och låses av servern.');
    }
    else {
      const fields = new Set(Object.keys(after).filter(field => !equal(after[field], before[field])));
      if (!equal(after.accounting, before.accounting)) fail('Den låsta ekonomiversionen får inte ändras från formuläret.');
      const activeApproval=approvals.find(approval=>approval.id===before.customerApproval?.id && approval.cardId===before.id && approval.version===before.customerApproval?.version);
      if(activeApproval && ['approved','attested'].includes(activeApproval.status) && ['customerId','customerSnapshot','origin','reference','rows','paymentDetails','payment','pricingTotal','pricingSnapshotId'].some(field=>fields.has(field))) fail('Kundens godkända version är låst. Avbryt godkännandet och skapa en ny version före ändring.');
      // Server-managed approval fields are accepted only if identical to the projection.
      if (fields.has('customerApproval') && !equal(after.customerApproval, before.customerApproval)) fail('Kundgodkännande styrs av terminalprocessen.');
      if (fields.has('idVerified') && after.idVerified && !approvalValid(after, approvals, 'approved') && !approvalValid(after, approvals, 'attested')) fail('Identiteten måste verifieras i kundgodkännandet.');
      for (const field of ['customerId', 'customerSnapshot', 'origin', 'reference', 'registration', 'gross', 'tare', 'deduction', 'preparedBy']) if (fields.has(field)) demand(p, 'prepare');
      for (const field of ['paymentDetails', 'payment']) if (fields.has(field)) demand(p, 'paymentDetails');
      if (fields.has('rows')) {
        const material = demandMaterialChanges(p, before.rows, after.rows);
        if (material.pairs.some(({ before: old, after: row }) => row.price !== old.price || row.tier !== old.tier ||
            row.manualOverride !== old.manualOverride || row.source !== old.source || row.pricePending !== old.pricePending) ||
          material.added.some(row => row.price !== 0 || !row.pricePending || row.manualOverride || row.source)) demand(p, 'changePrice');
        if (material.added.length || material.removed.length || material.pairs.some(pair => pair.before.weight !== pair.after.weight)) {
          if (before.customerApproval && !['cancelled', 'expired', 'change_requested'].includes(before.customerApproval.status))
            fail('Ändra material och vikt med materialkommandot så att kundgodkännandet återkallas samtidigt.');
          if (guardMaterialChange) await guardMaterialChange({ cardId: before.id, ...(before.sourceId ? { sourceId: before.sourceId } : {}) }, () => undefined);
          after.idVerified = false; delete after.pricingSnapshotId; delete after.approvedBy;
          after.pricingRowsPending = true;
          after.audit.push({ at: new Date().toISOString(), actor: p.user.name, actualUserId: p.actor.id, effectiveUserId: p.user.id,
            text: `Material och vikt ändrade: ${before.rows.map(row => `${row.articleId} ${row.weight} kg`).join(', ') || 'tomt'} → ${after.rows.map(row => `${row.articleId} ${row.weight} kg`).join(', ') || 'tomt'}.` });
        }
      }
      if (['ready', 'paid', 'balance'].includes(before.status) && ['customerId', 'origin', 'reference', 'rows', 'pricingTotal', 'pricingSnapshotId'].some(field => fields.has(field))) fail('Attesterade original ändras med en rättelse.');
      if (['customerId', 'origin', 'reference', 'rows', 'paymentDetails', 'payment', 'pricingTotal', 'pricingSnapshotId'].some(field => fields.has(field))) delete after.accounting;
    }
    if (!before && after.kind === 'correction') {
      const correction = next.corrections.find(row => row.id === after.sourceCorrectionId);
      const receipt = correction && state.pricing.snapshots.find(row => row.cardId === correction.serverId && row.sourceSnapshotId && row.approvedBy === p.user.id);
      if (!correction || correction.status !== 'approved' || correction.resultCardId !== after.id || !receipt || receipt.total !== after.pricingTotal || receipt.customerId !== after.customerId || after.rows.length !== receipt.rows.length || !after.rows.every((row, i) => row.articleId === receipt.rows[i].articleId && row.weight === receipt.rows[i].weight && row.price === receipt.rows[i].price)) fail('Rättelsekortet saknar verifierad intern attest.');
    }
    if (['attest', 'ready', 'paid', 'balance'].includes(after.status)) {
      const required = after.status === 'attest' ? 'approved' : 'attested';
      if (after.kind !== 'correction' && !(before && ['ready', 'paid', 'balance'].includes(before.status)) && !approvalValid(after, approvals, required)) fail('Aktuell version måste kundgodkännas och attesteras i rätt ordning.');
      if (!after.customerId || !after.origin.trim() || !validPaymentDetails(after.paymentDetails) || !after.idVerified) fail('Komplettera kund, ursprung, betalningsuppgifter och ID.');
    }
    if (after.status === 'balance' && before?.status !== 'balance') { demand(p, 'attest'); if (after.paymentDetails?.method !== 'balance') fail('Välj Spara på saldo före attest.'); }
    if (after.status === 'paid' && before?.status !== 'paid') demand(p, 'pay');
  }
  const customerContact = customer => {
    if (!customer) return undefined;
    const { audit: _audit, paymentProfile: _profile, ...details } = customer;
    return details;
  };
  const customerSaveText = (before, after) => {
    const contactChanged = !before || !equal(customerContact(before), customerContact(after));
    const paymentChanged = !equal(before?.paymentProfile, after.paymentProfile);
    return contactChanged && paymentChanged ? 'Kunduppgifter och betalningsprofil uppdaterade.'
      : paymentChanged ? 'Betalningsprofil uppdaterad.' : 'Kunduppgifter uppdaterade.';
  };
  for (const after of next.customers) {
    const before = base.customers.find(customer => customer.id === after.id);
    const history = before?.audit ?? [];
    if (after.audit.length < history.length || !equal(after.audit.slice(0, history.length), history))
      fail('Kundens ändringshistorik kan inte skrivas över.');
    // Older office clients send one general save entry. Validate that limited
    // compatibility input, then author every persisted event on the server.
    const supplied = after.audit.slice(history.length);
    if (supplied.length > 1 || supplied.some(event => event.text !== customerSaveText(before, after) ||
        event.actualUserId !== p.actor.id || event.effectiveUserId !== p.user.id))
      fail('Kundens ändringshistorik skapas av servern.');
    // Exclude browser-created audit entries from field merges and retries. The
    // canonical history remains the server's current history in mergeRecord.
    after.audit = clone(before ? history : current.customers.find(customer => customer.id === after.id)?.audit ?? history);
    if (!before && after.vatRegistered === undefined) after.vatRegistered = after.type !== 'Privatperson';
    if (after.type === 'Privatperson' && (after.vatRegistered !== undefined || !before || before.type !== 'Privatperson'))
      after.vatRegistered = false;
  }
  const customerChanges = changedRecords(current.customers, base.customers, next.customers);
  if (customerChanges.length) demand(p, 'customers');
  if (customerChanges.some(change => !equal(change.before?.paymentProfile, change.after?.paymentProfile))) demand(p, 'paymentDetails');
  if (customerChanges.some(change => !change.after)) fail('Kunder med historik får inte raderas.');
  for (const { before, after } of customerChanges) {
    if (equal(before, after)) continue;
    const history = before?.audit ?? [];
    const at = new Date().toISOString();
    const event = text => ({ at, actor: p.user.name, actualUserId: p.actor.id, effectiveUserId: p.user.id, text });
    after.audit = [...clone(history), event(customerSaveText(before, after))];
    if (!equal(before?.vatRegistered, after.vatRegistered)) {
      const vat = value => value === undefined ? 'Ej angivet' : value ? 'Ja' : 'Nej';
      after.audit.push(event(`Momsregistrering ändrad: ${vat(before?.vatRegistered)} → ${vat(after.vatRegistered)}.`));
    }
    if (!equal(before?.paymentTermDays, after.paymentTermDays)) {
      const terms = value => value === undefined ? 'Integrationens standard' : value === 0 ? 'Direkt (0 dagar)' : `${value} ${value === 1 ? 'dag' : 'dagar'}`;
      after.audit.push(event(`Betalningsvillkor ändrade: ${terms(before?.paymentTermDays)} → ${terms(after.paymentTermDays)}.`));
    }
  }
  const correctionChanges = changedRecords(current.corrections, base.corrections, next.corrections);
  if (correctionChanges.length) demand(p, correctionChanges.every(change => change.after?.status === 'approved') ? 'attest' : 'corrections');
  for (const change of correctionChanges) {
    if (!change.after || !current.cards.some(card => card.id === change.after.cardId) || !visible(p, current.cards.find(card => card.id === change.after.cardId) ?? {})) fail('Rättelsen saknar ett tillåtet underlag.');
    if (change.before?.status === 'approved' && !equal(change.before, change.after)) fail('Godkända rättelser är låsta.');
    if (change.after.status === 'approved' && change.before?.status !== 'approved') {
      demand(p, 'attest');
      const original = current.cards.find(card => card.id === change.after.cardId);
      const price = original?.rows.find(row => row.articleId === change.after.articleId)?.price;
      const receipt = state.pricing.snapshots.find(row => row.cardId === change.after.serverId && row.sourceSnapshotId === original?.pricingSnapshotId && row.approvedBy === p.user.id);
      const delta = Math.round(change.after.weightDelta * price * 100) / 100;
      if (change.before?.status !== 'attest' || !receipt || receipt.total !== delta || change.after.amountDelta !== delta || change.after.unitPrice !== price || !receipt.rows.some(row => row.articleId === change.after.articleId && row.weight === change.after.weightDelta)) fail('Rättelsen måste motsvara ett verifierat prisunderlag och originalpris.');
      if (Math.abs(change.after.amountDelta ?? 0) > p.user.maxAttest) fail('Rättelsen överstiger din attestgräns.', 403);
      if (!p.user.ownAttest && [change.before?.actualUserId, change.before?.effectiveUserId, change.before?.submittedBy].some(id => id === p.user.id || id === p.actor.id)) fail('Du får inte attestera ditt eget underlag.', 403);
    }
  }
  const paymentChanges = changedRecords(current.payments, base.payments, next.payments);
  if (paymentChanges.length) demand(p, 'pay');
  for (const change of paymentChanges) {
    if (change.before && !equal(change.before, change.after) || !change.after) fail('Betalningsjournalen kan inte skrivas över.');
    const pay = change.after, card = current.cards.find(card => card.id === pay.cardId);
    if (!card || !visible(p, card)) fail('Utbetalningen saknar tillåtet underlag.', 403);
    if (current.payments.some(existing => existing.cardId === pay.cardId && existing.id !== pay.id)) fail('Viktkortet har redan en registrerad utbetalning.');
    if (!change.before) {
      const expected = recordPayment(current, pay.cardId, { actualUser: p.actor, user: p.user }, pay.paymentDetails, pay.reference).payments.at(-1);
      if (expected.amount !== pay.amount || expected.offset !== pay.offset || expected.customerId !== pay.customerId || expected.method !== pay.method) fail('Utbetalningens belopp eller betalningssätt stämmer inte med underlaget.');
    }
  }
  const result = { ...current, cards: applyChanges(current.cards, changes), customers: applyChanges(current.customers, customerChanges), corrections: applyChanges(current.corrections, correctionChanges), payments: applyChanges(current.payments, paymentChanges), users: clone(state.pricing.users) };
  for (const card of result.cards) if (card.status === 'paid' && !result.payments.some(payment => payment.cardId === card.id)) fail('Utbetald status kräver en betalningsjournal.');
  state.office = officeSchema.parse(result);
}
function mobileToOffice(state, draft, p) {
  if (draft.status !== 'ready') return;
  if (!isComplete(draft) || draft.pendingWeight || draft.vehicleInput) fail('Vägningen är inte färdig.');
  const existing = state.office.cards.find(card => card.sourceId === draft.id);
  if (existing) return; // Stable source ID is the submission idempotency key.
  const vehicle = draft.rows.find(row => row.method === 'vehicle');
  state.office.cards.push(officeSchema.shape.cards.element.parse({
    id: draft.number, sourceId: draft.id, siteId: mobileDraftSite(state, draft), status: 'new', yard: mobileDraftSite(state, draft) === 'rimbo' ? 'Rimbo' : 'Norrtälje', weigher: p.user.name, date: draft.updatedAt,
    customerId: draft.customerId, customerSnapshot: state.office.customers.find(customer => customer.id === draft.customerId),
    reference: draft.reference, origin: draft.origin, registration: vehicle?.registration, gross: vehicle?.gross, tare: vehicle?.tare, deduction: vehicle?.deduction,
    rows: draft.rows.map(row => ({ articleId: row.articleId, articleName: articles.find(a => a.id === row.articleId)?.name ?? row.articleId, weight: rowWeight(row), tier: 'C', price: 0, pricePending: true })),
    payment: '', idVerified: false, financialPending: true,
    audit: [{ at: new Date().toISOString(), actor: p.user.name, actualUserId: p.actor.id, effectiveUserId: p.user.id, text: 'Färdig vägning mottagen från mobilappen. Ingen attest eller utbetalning gjord.' }],
  }));
}
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail('Använd application/json.', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) fail('Underlaget är för stort.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('Ogiltig JSON.', 400); }
}
function requestPrincipal(store, req) {
  const actor = req.headers['x-demo-mobile'] === 'niklas' && req.url.includes('/mobile') ? 'mobile-demo' : req.headers['x-demo-actor']; const user = actor === 'mobile-demo' ? actor : req.headers['x-demo-user'] ?? actor;
  if (typeof actor !== 'string' || typeof user !== 'string') fail('Välj ett demokonto.', 401);
  if (actor === 'mobile-demo' && user === actor) return { actor: { id: actor, name: 'Niklas' }, user: { id: actor, name: 'Niklas', level: 'Medarbetare', permissions: ['view', 'prepare', 'customers'], siteIds: ['norrtalje'] } };
  return store.principal(actor, user);
}

export function createApplicationService({ repository, env = process.env, projections, approvalProvider = async () => [], sendCustomerReview,
  withMaterialChangeApproval, guardMaterialChange, siteProvider = async () => [{id:'norrtalje',name:'Norrtälje',active:true},{id:'rimbo',name:'Rimbo',active:true}], environmentProvider,
  accountingSettingsProvider, accountingCardStatusProvider, validateArticleMedia } = {}) {
  projections ??= approvalProvider;
  const mobilePricingProjection = createMobilePricingProjection();
  const context = new AsyncLocalStorage(); let fallback = createPricingStore(); let repoPromise;
  const getRepo = () => repoPromise ??= (repository ? Promise.resolve(repository) : createApplicationRepository({ env, seed: initialApplicationState }))
    .then(async value => {
      // Legacy personnel seeding changes planning IDs/timestamps. Persist it
      // once at startup; never generate a different plan in each read-copy.
      await value.transact(state => {
        ensurePersonnel(state); refreshStaffingTasks(state);
        ensureEmployeeTime(state); ensureMobileEmployeeAccounts(state);
        // Persist catalog upgrades once. Existing article revisions, financial
        // snapshots and category IDs are retained by the pricing migration.
        state.pricing = createPricingStore({ initialState: state.pricing }).exportState();
      });
      return value;
    }).catch(error => { repoPromise = undefined; throw error; });
  const principalStore = new Proxy({}, { get: (_, key) => key === 'runFresh' ? withPrincipal : key === 'runFreshPrincipal' ? withPrincipalOnly : typeof (context.getStore()?.pricing ?? fallback)[key] === 'function' ? (...args) => (context.getStore()?.pricing ?? fallback)[key](...args) : undefined });
  async function withPrincipalOnly(operation) {
    if (context.getStore()) return operation();
    const repository = await getRepo();
    const users = repository.readProjection
      ? await repository.readProjection(state => state.pricing.users, { domain: 'pricing', paths: [['users']] })
      : await (repository.read ? repository.read(state => clone(state.pricing.users), { domains: ['pricing'] })
        : repository.transact(state => clone(state.pricing.users)));
    return context.run({ principalOnly: true, pricing: { principal: (actor, user) => resolvePricingPrincipal(users, actor, user) } }, operation);
  }
  async function withPrincipal(operation) {
    // All checks in one request use its freshly loaded principal. Re-entering
    // from terminal/environment must not reload the entire application again.
    if (context.getStore() && !context.getStore().principalOnly) return operation();
    const repository = await getRepo();
    const state = await (repository.read
      ? repository.read(state => clone(state.pricing), { domains: ['pricing'] })
      : repository.transact(state => clone(state.pricing)));
    const pricing = createPricingStore({ initialState: state }); fallback = pricing;
    return context.run({ pricing }, operation);
  }
  async function businessApi(req, res, url) {
    if (!url.pathname.startsWith('/api/application/')) return false;
    try {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail('Anropet måste komma från samma webbplats.', 403);
      const routeDomain = url.pathname.slice('/api/application/'.length);
      const mobilePricesOnly = routeDomain === 'mobile-prices';
      const domain = mobilePricesOnly ? 'mobile' : routeDomain;
      if (domain === 'revision') {
        if (req.method !== 'GET') fail('Metoden stöds inte.', 405);
        const view = url.searchParams.get('domain');
        if (!['office', 'mobile', 'transport'].includes(view)) fail('API-vyn finns inte.', 404);
        const repository = await getRepo();
        const project = (state, revision) => {
          const pricing = { principal: (actor, user) => resolvePricingPrincipal(state.pricing.users, actor, user) };
          let principal;
          if (view === 'mobile' && hasEmployeeSession(req)) principal = employeeRequestPrincipal(state, req);
          else {
            if (view === 'mobile' && env.RENDER) fail('Logga in i appen med ditt personalkonto.', 401);
            principal = requestPrincipal(pricing, req);
          }
          if (principal.actor.id === 'mobile-demo' && view !== 'mobile') fail('Mobilkontot får bara använda mobilflödet.', 403);
          demand(principal, view === 'transport' ? 'transportRead' : 'view');
          if (view === 'transport' && Array.isArray(principal.user.siteIds)) fail('Du saknar åtkomst till hela transportplaneringen.', 403);
          return { revision, domain: view, ...(view === 'mobile' ? { businessDate: new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit',
          }).format(new Date()) } : {}) };
        };
        const result = hasEmployeeSession(req) && view === 'mobile'
          ? await repository.read(project, { domains: ['pricing', 'personnel', 'personnelAuth'] })
          : repository.readProjection
            ? await repository.readProjection(project, { domain: 'pricing', paths: [['users']] })
            : await repository.read(project, { domains: ['pricing'] });
        json(res, 200, result); return true;
      }
      if (/^office\/accounting\/cards\/[1-9]\d{0,11}$/.test(domain)) {
        if (req.method !== 'GET') fail('Metoden stöds inte.', 405);
        const cardId = Number(domain.split('/').at(-1)), repository = await getRepo();
        await repository.read(state => {
          const principal = requestPrincipal(createPricingStore({ initialState: state.pricing }), req);
          demand(principal, 'view');
          if (!financial(principal)) fail('Ekonomibehörighet krävs för att läsa överföringsstatus.', 403);
          const card = state.office.cards.find(value => value.id === cardId);
          if (!card || !visible(principal, card)) fail('Invägningskortet kunde inte visas.', 404);
        }, { domains: ['office', 'pricing'] });
        json(res, 200, { export: accountingCardStatusProvider ? await accountingCardStatusProvider(cardId) : null }); return true;
      }
      if (domain === 'office/material') {
        if (req.method !== 'POST') fail('Metoden stöds inte.', 405);
        const input = materialCommandSchema.parse(await body(req)), repository = await getRepo();
        const run = () => repository.transact(async (state, revision, audit) => {
          const pricing = createPricingStore({ initialState: state.pricing }), principal = requestPrincipal(pricing, req);
          if (principal.actor.id === 'mobile-demo') fail('Mobilkontot får bara använda mobilflödet.', 403);
          demand(principal, 'view');
          return context.run({ pricing }, async () => {
            const approvals = await projections(input.cardId);
            reflectApprovals(state.office, approvals, state.metadata.officeSeed?.cards);
            const card = state.office.cards.find(value => value.id === input.cardId);
            if (!card) fail('Invägningskortet finns inte.', 404);
            if (!visible(principal, card)) fail('Du saknar åtkomst till anläggningen.', 403);
            if (card.kind === 'correction' || ['ready', 'paid', 'balance'].includes(card.status) || card.customerApproval?.status === 'attested')
              fail('Attesterade original ändras med en rättelse.');
            const readable = officeView(state, principal).cards.find(value => value.id === card.id);
            if (!equal(input.expectedRows, readable.rows)) fail('Material eller vikt ändrades i en annan session. Läs in kortet igen.');
            const before = clone(card.rows), rows = clone(before);
            if (input.operation === 'add') {
              demand(principal, 'weighingAddArticle');
              if (!input.articleId || input.rowIndex !== undefined || !(input.weight > 0) || rows.length >= 100)
                fail('Välj artikel och ange en vikt större än 0 kg.', 422);
              const article = pricing.getArticleForEnvironment(input.articleId);
              if (!article || !article.active) fail('Välj en aktiv artikel ur artikelregistret.', 422);
              rows.push({ articleId: input.articleId, articleName: article.name,
                weight: input.weight, tier: 'C', price: 0, pricePending: true });
            } else {
              if (input.articleId !== undefined || input.rowIndex === undefined || !rows[input.rowIndex]) fail('Välj en befintlig materialrad.', 422);
              if (input.operation === 'remove') {
                demand(principal, 'weighingRemoveArticle');
                if (input.weight !== undefined) fail('Borttagning tar inte emot en ny vikt.', 422);
                rows.splice(input.rowIndex, 1);
              } else {
                demand(principal, 'weighingEditWeight');
                if (input.weight === undefined) fail('Ange en ny vikt.', 422);
                if (input.weight === 0) { demand(principal, 'weighingRemoveArticle'); rows.splice(input.rowIndex, 1); }
                else rows[input.rowIndex].weight = input.weight;
              }
            }
            if (equal(before, rows)) return { data: officeView(state, principal), cardProjection: readable, revision, approval: readable.customerApproval ?? null };
            let quote, pricingPending = false;
            try { quote = rows.length ? pricing.quoteForOfficeMaterial({ customerId: card.customerId, deliveredAt: card.date,
              excludeCardId: String(card.id), rows: rows.map(({ articleId, weight }) => ({ articleId, weight })) }) : { rows: [] }; }
            catch (error) {
              // A missing historical LME quote must not erase the measured
              // article. Retain prior prices, explicitly leave the new row
              // unpriced, and require a complete price calculation for review.
              if (input.operation !== 'add' || !(error instanceof PricingError) || error.status !== 422 ||
                !error.message.startsWith('LME-pris saknas för ')) throw error;
              pricingPending = true;
            }
            const pricedRows = pricingPending ? rows : quote.rows.map((value, index) => {
              const row = rows[index], preservePrice = !row.pricePending && (row.manualOverride || !row.source);
              return { ...row, price: preservePrice ? row.price : value.price, pricePending: false,
                tier: preservePrice ? row.tier : value.tier === 'Special' ? 'Eget' : value.tier,
                source: preservePrice ? row.source : value.source,
                volumeBefore: value.volumeBefore, volumeWithDelivery: value.volumeWithDelivery };
            });
            const total = Math.round(pricedRows.reduce((sum, row) => sum + Math.round(row.weight * row.price * 100) / 100, 0) * 100) / 100;
            const guardInput = { cardId: card.id, ...(card.sourceId ? { sourceId: card.sourceId } : {}),
              siteId: card.siteId ?? (card.yard === 'Rimbo' ? 'rimbo' : 'norrtalje'), expectedRows: before,
              operation: input.operation, ...(input.weight === undefined ? {} : { weight: input.weight }),
              ...(card.customerApproval ? { approvalId: card.customerApproval.id } : {}) };
            const apply = ({ cancel } = {}) => {
              const write = () => {
                const cancelled = cancel?.();
                card.rows = pricedRows; card.pricedAt = card.date;
                if (pricingPending) delete card.pricingTotal; else card.pricingTotal = total;
              delete card.accounting;
                card.financialPending = pricingPending; card.pricingRowsPending = pricingPending; card.idVerified = false;
                delete card.pricingSnapshotId; delete card.approvedBy;
                card.status = card.status === 'new' && !card.customerApproval ? 'new' : 'complement';
                if (cancelled) reflectApprovals(state.office, [cancelled]);
                const updated = state.office.cards.find(value => value.id === card.id);
                updated.idVerified = false;
                const time = new Date().toISOString(), from = input.rowIndex === undefined ? undefined : before[input.rowIndex];
                const articleId = input.articleId ?? from.articleId;
                const articleName = pricing.getArticleForEnvironment(articleId)?.name ?? articleId;
                const text = input.operation === 'add' ? `Artikel tillagd: ${articleName}, ${input.weight} kg.`
                  : input.operation === 'remove' || input.weight === 0 ? `${articleName} borttagen: ${from.weight} kg → 0 kg.`
                    : `${articleName}: vikt ändrad från ${from.weight} kg till ${input.weight} kg.`;
                updated.audit.push({ at: time, actor: principal.user.name, actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
                  text: `${text}${cancelled ? ' Tidigare kundgodkännande återkallat; ny kundgranskning krävs.' : ''}` });
                state.office = officeSchema.parse(state.office);
                synchronizeLogisticsIncomingStock(state);
                audit.push({ action: 'weighing.material.changed', cardId: card.id, operation: input.operation,
                  before, after: clone(pricedRows), actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
                  ...(cancelled ? { cancelledApprovalId: cancelled.id } : {}) });
                const data = officeView(state, principal), projection = data.cards.find(value => value.id === card.id);
                return { data, cardProjection: projection, revision, approval: projection.customerApproval ?? null };
              };
              return guardMaterialChange ? guardMaterialChange(guardInput, write) : write();
            };
            if (withMaterialChangeApproval) return withMaterialChangeApproval(guardInput,
              { actorId: principal.actor.id, userId: principal.user.id }, apply);
            if (card.customerApproval && !['cancelled', 'expired', 'change_requested'].includes(card.customerApproval.status))
              fail('Kundterminalens serverkoppling för materialändringar saknas.', 503);
            return apply();
          });
        }, { committedRevision: true });
        const result = await (repository.runInTransaction ? repository.runInTransaction(run) : run());
        json(res, 200, result); return true;
      }
      if (domain === 'customer-review') {
        if (req.method !== 'POST') fail('Metoden stöds inte.', 405);
        if (!sendCustomerReview) fail('Kundterminalens serverkoppling saknas.', 503);
        const input = await body(req), repository = await getRepo();
        const run = () => repository.transact(async (state, revision, audit) => {
          const pricing = createPricingStore({ initialState: state.pricing });
          const principal = requestPrincipal(pricing, req);
          return context.run({ pricing }, async () => {
            const currentApprovals = await projections(input.cardId);
            reflectApprovals(state.office, currentApprovals, state.metadata.officeSeed?.cards);
            return prepareCustomerReview({ state, input, principal, send: (payload, identity) => sendCustomerReview(payload, identity, req),
              runWithPricing: (pricing, callback) => context.run({ pricing }, callback),
              reflectApprovals, officeView, revision, audit, accountingSettingsProvider });
          });
        }, { committedRevision: true });
        const started = performance.now();
        const { result, metrics } = await measureDatabaseWork(() => repository.runInTransaction ? repository.runInTransaction(run) : run());
        res.setHeader('Server-Timing', [`review;dur=${(performance.now() - started).toFixed(1)}`,
          `db_pool;dur=${metrics.poolWaitMs.toFixed(1)}`, `db_sql;dur=${metrics.sqlMs.toFixed(1)}`,
          `db_lock_query;dur=${metrics.lockQueryMs.toFixed(1)}`, `db_commit;dur=${metrics.commitMs.toFixed(1)}`,
          `db_queries;desc="${metrics.sqlCount}"`].join(', '));
        json(res, 200, result); return true;
      }
      if (domain === 'personnel') {
        if (!['GET','POST'].includes(req.method)) fail('Metoden stöds inte.',405);
        const command = req.method === 'POST' ? await body(req) : null;
        const planning = url.searchParams.get('view') === 'planning';
        if (planning && command) fail('Planeringsvyn är endast läsbar.',405);
        const sites = await siteProvider();
        const repository = await getRepo();
        const operate = (state,_,audit=[])=>{
          const pricing=createPricingStore({initialState:state.pricing}),p=requestPrincipal(pricing,req);
          if(p.actor.id==='mobile-demo')fail('Mobilkontot saknar åtkomst till personal.',403);
          if(!personnelCan(p,planning?'transportRead':'personnelRead'))fail('Du saknar behörighet att läsa personal.',403);
          ensurePersonnel(state);refreshStaffingTasks(state);
          const preview=command?personnelCommand(state,p,command,audit,sites):undefined;
          if(command) refreshEmployeeTimeNorms(state);
          return {...personnelProjection(state,p,planning,sites),...(preview?{preview}:{})};
        };
        const result = req.method === 'GET' && repository.read
          ? await repository.read(operate, { domains: ['pricing', 'personnel', 'transport'] })
          : await repository.transact(operate);
        json(res,200,result);return true;
      }
      if (domain === 'import-pricing') {
        if (req.method !== 'POST') fail('Metoden stöds inte.', 405);
        const payload = await body(req);
        const result = await (await getRepo()).transact((state, _, audit) => {
          const pricing = createPricingStore({ initialState: state.pricing }); const p = requestPrincipal(pricing, req);
          if (p.user.level !== 'Systemadmin') fail('Endast Systemadmin kan importera prisregistret.', 403);
          const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
          if (state.metadata.pricingImportHash === hash) return { imported: true, duplicate: true };
          // An infrastructure upgrade must not look like a human price edit.
          // Ignore only an exact unchanged server-created bootstrap identity.
          const bootstrapUsers = state.metadata.mobileEmployeeBootstrapUsers ?? [];
          const comparable = clone(state.pricing);
          comparable.users = comparable.users.filter(user => !bootstrapUsers.some(original => original.id === user.id && equal(original, user)));
          if (state.metadata.pricingImportHash || !equal(comparable, state.metadata.pricingSeed)) fail('Prisregistret har redan ändrats. Importen behöver granskas manuellt.');
          state.pricing = pricing.validateMigration(payload.pricing, p);
          state.pricing.users = state.pricing.users.filter(user => !bootstrapUsers.some(original => original.id === user.id)).concat(clone(bootstrapUsers));
          // Validate migration records without running any delivery adapter.
          const box = createTransportOutbox();
          for (const entry of payload.outbox ?? []) {
            box.prepare({ events: [entry.event] }, pricing.principal(entry.event.actualUserId, entry.event.effectiveUserId));
          }
          state.outbox = clone(payload.outbox ?? []); state.metadata.pricingImportHash = hash;
          state.imports.push({ hash, domain: 'pricing', original: clone(payload), at: new Date().toISOString(), actor: p.actor.id });
          audit.push({ action: 'legacy.pricing.imported', hash, actualUserId: p.actor.id });
          return { imported: true, deliveryEnabled: false };
        });
        json(res, 200, result); return true;
      }
      if (!['office', 'mobile', 'transport'].includes(domain)) fail('API-vyn finns inte.', 404);
      if (!['GET', 'POST'].includes(req.method)) fail('Metoden stöds inte.', 405);
      if (mobilePricesOnly && req.method !== 'GET') fail('Kundpriserna är en läsvy.', 405);
      let payload = req.method === 'POST' ? await body(req) : null;
      const compactMobileWrite = payload?.kind === 'records';
      if (compactMobileWrite) {
        if (domain !== 'mobile') fail('Postkommandot gäller bara mobilens vägningar.', 422);
        payload = mobileRecordPayload(payload);
      }
      if (payload?.kind === 'import') payload = { importData: payload.data };
      if (payload?.kind === 'archive') payload = { archiveData: payload.data };
      const approvals = domain === 'office' && req.method !== 'GET' ? await projections() : [];
      const repository = await getRepo();
      const operate = async (state, revision, audit = []) => {
        const pricing = createPricingStore({ initialState: state.pricing });
        let importConflicts = 0;
        let p;
        if (domain === 'mobile' && hasEmployeeSession(req)) {
          p = employeeRequestPrincipal(state, req, { enforceGate: req.method !== 'GET' });
          if (!p.user.permissions.includes('prepare') && p.user.level === 'Medarbetare') fail('Du saknar behörighet för gårdsarbete.', 403);
        } else {
          if (domain === 'mobile' && env.RENDER) fail('Logga in i appen med ditt personalkonto.', 401);
          p = requestPrincipal(pricing, req);
        }
        if (p.actor.id === 'mobile-demo' && domain !== 'mobile') fail('Mobilkontot får bara använda mobilflödet.', 403);
        demand(p, domain === 'transport' ? 'transportRead' : 'view');
        if (mobilePricesOnly) {
          const customerId = url.searchParams.get('customerId');
          if (!customerId || !state.office.customers.some(customer => customer.id === customerId)) fail('Välj en befintlig kund för prisuppslaget.', 422);
          return { ...mobilePricingProjection({ ...state.pricing, customers: state.office.customers.map(({ id, name }) => ({ id, name })) },
            { catalog: false, prices: true, customerIds: [customerId] }), revision, storage: 'database' };
        }
        if(domain==='transport')ensurePersonnel(state);
        // Read projections on this same PostgreSQL snapshot, reusing the live
        // pricing principal already selected above instead of another roundtrip.
        const currentApprovals = domain === 'office' && req.method === 'GET'
          ? await context.run({ pricing }, () => projections()) : approvals;
        reflectApprovals(state.office, currentApprovals, state.metadata.officeSeed?.cards);
        state.office.users = clone(state.pricing.users);
        if (payload?.archiveData) {
          const hash = createHash('sha256').update(JSON.stringify(payload.archiveData)).digest('hex');
          if (!state.imports.some(row => row.hash === hash)) state.imports.push({ hash, domain, actor: p.actor.id, at: new Date().toISOString(), original: clone(payload.archiveData), conflict: true });
        }
        if (payload?.importData) {
          const hash = createHash('sha256').update(JSON.stringify(payload.importData)).digest('hex');
          if (!state.imports.some(record => record.hash === hash && record.domain === domain)) {
            // Retain an immutable full copy before attempting a merge. Historic
            // financial states cannot be activated by a browser data import.
            state.imports.push({ hash, domain, at: new Date().toISOString(), actor: p.actor.id, original: clone(payload.importData) });
            const schema = domain === 'office' ? officeSchema : domain === 'mobile' ? storeSchema : transportSchema;
            const imported = schema.parse(domain === 'office' ? migrateOffice(payload.importData) : payload.importData);
            if (domain === 'mobile') {
              for (const draft of imported.drafts) if (!state.mobile.drafts.some(old => old.id === draft.id)) {
                demand(p, 'prepare');
                const copy = clone(draft); copy.number = allocateWeighingNumber(state);
                state.metadata.mobileDraftSites ??= {}; state.metadata.mobileDraftSites[copy.id] = p.user.siteIds?.[0] ?? 'norrtalje';
                state.mobile.drafts.push(copy); mobileToOffice(state, copy, p);
              }
            } else if (domain === 'office') {
              if (!can(p, 'prepare')) importConflicts += imported.cards.length;
              for (const card of imported.cards) {
                if (!can(p, 'prepare')) continue;
                if (!visible(p, card)) continue;
                const index = state.office.cards.findIndex(old => old.sourceId === card.sourceId || old.id === card.id);
                const untouched = index >= 0 && equal(state.office.cards[index], state.metadata.officeSeed?.cards.find(old => old.id === card.id));
                if (index >= 0 && !untouched) { if (!equal(state.office.cards[index], card)) importConflicts++; continue; }
                if (card.workOrderId) { importConflicts++; continue; } // Preserve in the import archive; only canonical AO finalization creates this link.
                if (['attest', 'ready', 'paid', 'balance'].includes(card.status)) { importConflicts++; continue; }
                const copy = clone(card); copy.status = 'complement'; copy.idVerified = false; delete copy.customerApproval; delete copy.approvedBy; delete copy.paidAt;
                if (index >= 0) state.office.cards[index] = copy; else state.office.cards.push(copy);
              }
              reflectApprovals(state.office, approvals, state.metadata.officeSeed?.cards);
            }
            if (domain === 'transport' && !equal(state.transport, state.metadata.transportSeed) && !equal(state.transport, imported)) importConflicts++;
            if (domain === 'transport' && equal(state.transport, state.metadata.transportSeed)) {
              if (can(p, 'transportPlan')) state.transport = imported; else importConflicts++;
            }
            if (domain !== 'transport') for (const customer of imported.customers) if (!state.office.customers.some(old => old.id === customer.id)) {
              if (!can(p, 'customers')) { importConflicts++; continue; }
              state.office.customers.push(officeSchema.shape.customers.removeDefault().element.parse({ ...customer, customerNumber: customer.customerNumber ?? customer.id, audit: customer.audit ?? [] }));
            }
            audit.push({ action: 'legacy.import.archived', domain, hash, actualUserId: p.actor.id, effectiveUserId: p.user.id });
          }
        }
        if (payload?.base && payload?.next) {
          if (domain === 'office') await validateOffice(state, officeSchema.parse(payload.base), officeSchema.parse(payload.next), p, approvals, guardMaterialChange);
          else if (domain === 'mobile') {
            demand(p, 'prepare');
            const base = storeSchema.parse(payload.base), next = storeSchema.parse(payload.next);
            for (const draft of next.drafts) if (!base.drafts.some(old => old.id === draft.id)) {
              const existing = state.mobile.drafts.find(old => old.id === draft.id); if (existing) draft.number = existing.number;
            }
            const changes = changedRecords(state.mobile.drafts, base.drafts, next.drafts);
            for (const change of changes) {
              if (change.before && !mobileDraftVisible(state, p, change.before)) fail('Vägningen tillhör en annan anläggning.', 403);
              if (change.before?.status === 'ready' && !equal(change.before, change.after)) fail('Färdiga vägningar är låsta.');
              if (change.after && !change.before) {
                change.after.number = allocateWeighingNumber(state);
                state.metadata.mobileDraftSites ??= {}; state.metadata.mobileDraftSites[change.after.id] = p.user.siteIds?.[0] ?? 'norrtalje';
              }
            }
            state.mobile.drafts = applyChanges(state.mobile.drafts, changes);
            const customers = changedRecords(mobileCustomers(state.office.customers), base.customers, next.customers);
            for (const { after } of customers) {
              demand(p, 'customers'); if (!after) fail('Kunder får inte raderas.');
              const index = state.office.customers.findIndex(customer => customer.id === after.id), old = state.office.customers[index];
              const customer = officeSchema.shape.customers.removeDefault().element.parse({ ...old, ...after,
                ...(!old && { vatRegistered: after.type !== 'Privatperson' }),
                customerNumber: old?.customerNumber ?? after.id, audit: old?.audit ?? [] });
              if (index < 0) state.office.customers.push(customer); else state.office.customers[index] = customer;
            }
            for (const { after } of changes) if (after) mobileToOffice(state, after, p);
          } else {
            demand(p, 'transportPlan');
            if (Array.isArray(p.user.siteIds)) fail('Transportplanering saknar anläggningsindelning. Använd ett konto med tillgång till alla anläggningar.', 403);
            const base = transportSchema.parse(payload.base), next = transportSchema.parse(payload.next);
            if (!equal(state.transport, base)) fail('Planeringen ändrades av en annan användare. Ladda om före bokning.');
            validatePersonnelTransportChange(state,base,next);
            validateLogisticsTransportChange(state,base,next);
            for (const event of next.events.filter(event => !state.transport.events.some(old => old.id === event.id))) if (event.actualUserId !== p.actor.id || event.effectiveUserId !== p.user.id) fail('Transporthändelsens användare stämmer inte med sessionen.', 403);
            for (const old of state.transport.events) if (!next.events.some(event => event.id === old.id && equal(event, old))) fail('Transporthistoriken kan inte skrivas över.');
            state.transport = next;
            refreshStaffingTasks(state);
          }
          audit.push({ action: 'business.changed', domain, actualUserId: p.actor.id, effectiveUserId: p.user.id });
        }
        // Physical incoming quantities and their correction history are saved
        // in the same real command. A logistics GET only projects current stock.
        if (req.method === 'POST' && domain !== 'transport' && (payload?.importData || payload?.base && payload?.next))
          synchronizeLogisticsIncomingStock(state);
        // One canonical customer registry also supplies the pricing engine.
        state.pricing.customers = state.office.customers.map(({ id, name }) => ({ id, name }));
        state.mobile.customers = mobileCustomers(state.office.customers);
        state.metadata.nextCard = Math.max(state.metadata.nextCard, ...state.office.cards.map(card => card.id + 1));
        if (domain === 'transport' && Array.isArray(p.user.siteIds)) fail('Du saknar åtkomst till hela transportplaneringen.', 403);
        const mobilePrices = domain === 'mobile' && !compactMobileWrite
          ? mobilePricingProjection(state.pricing, { prices: url.searchParams.get('prices') !== 'none' }) : {};
        return { data: clone(domain === 'office' ? officeView(state, p) : domain === 'mobile' ? mobileView(state, p) : state[domain]), ...mobilePrices, ...(domain === 'mobile' ? { businessDate: mobileBusinessDate(new Date()) } : {}), revision, storage: 'database', storageKind: (await getRepo()).kind, demo: true, deliveryEnabled: false,
          importConflicts, importArchived: Boolean(payload?.importData), importNotice: payload?.importData ? 'Tidigare testdata har arkiverats på servern. Befintliga serverkort och ekonomiska original har inte skrivits över.' : undefined };
      };
      const result = await (req.method === 'GET' && repository.read
        ? repository.read(operate, { domains: ['metadata', 'pricing', 'office', 'mobile', ...(domain === 'mobile' && hasEmployeeSession(req) ? ['personnel', 'personnelAuth', 'employeeTime', 'transport'] : []), ...(domain === 'transport' ? ['transport', 'personnel'] : [])] })
        : repository.transact(operate, { committedRevision: true }));
      json(res, 200, result);
    } catch (error) {
      const known = error instanceof PricingError || Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
      if (!known && error.name !== 'ZodError') console.error('Business API failure:', error.stack);
      json(res, known ? error.status : error.name === 'ZodError' ? 422 : 503, { error: known ? error.message : error.name === 'ZodError' ? 'Kontrollera de ändrade uppgifterna.' : 'Gemensam databas kunde inte nås. Ändringen har inte bekräftats sparad.', ...(error.code ? { code: error.code } : {}), ...(error.gate ? { gate: error.gate } : {}) });
    }
    return true;
  }
  async function durableApi(req, res, url) {
    const pricingRoute = url.pathname.startsWith('/api/pricing/'); const outboxRoute = url.pathname.startsWith('/api/transport/');
    if (!pricingRoute && !outboxRoute) return false;
    // Buffer the response until COMMIT. A failed transaction must not claim a
    // successful write or send headers before the durable commit succeeds.
    let status = 200, headers = {}, response;
    const buffered = { writeHead(code, fields) { status = code; headers = { ...headers, ...fields }; }, setHeader(key, value) { headers[key] = value; }, end(value) { response = value; } };
    try {
      const repository = await getRepo();
      const operate = async (state, _, audit = []) => {
        const pricing = createPricingStore({ initialState: state.pricing });
        const outbox = createTransportOutbox({ initialState: state.outbox });
        await context.run({ pricing }, () => pricingRoute ? createPricingApi({ store: pricing, validateMediaReferences: validateArticleMedia })(req, buffered, url) : createTransportIntegrationsApi({ principalStore: pricing, outbox })(req, buffered, url));
        if (status < 400) {
          const next = pricing.exportState();
          if (!equal(next, state.pricing)) audit.push({ action: 'pricing.changed', actualUserId: req.headers['x-demo-actor'], effectiveUserId: req.headers['x-demo-user'] });
          state.pricing = next; state.outbox = outbox.exportState();
          // Personnel permissions have a single durable authoritative source.
          state.office.users = clone(next.users);
          fallback = pricing;
        }
      };
      if (req.method === 'GET' && repository.read) await repository.read(operate, { domains: ['pricing', 'outbox', 'office'] });
      else await repository.transact(operate);
      if (response) { try { const value = JSON.parse(response); value.memoryOnly = false; value.storage = 'database'; value.storageKind = (await getRepo()).kind; response = JSON.stringify(value); } catch {} }
      res.writeHead(status, headers); res.end(response);
    } catch { json(res, 503, { error: 'Databasen kunde inte bekräfta ändringen. Försök igen.', memoryOnly: false }); }
    return true;
  }
  const driverApi = createDriverApi({getRepository:getRepo,readBody:body,json});
  const employeeApi = createMobileEmployeeApi({getRepository:getRepo,readBody:body,json,siteProvider});
  const logisticsApi = createLogisticsApi({getRepository:getRepo,readBody:body,json,siteProvider,environmentProvider});
  const api = async (req, res, url) => await employeeApi(req,res,url) || await logisticsApi(req,res,url) || await driverApi(req,res,url) || await durableApi(req, res, url) || await businessApi(req, res, url);
  Object.assign(api, { principalStore, withPrincipal, businessApi, durableApi, getRepository: getRepo, close: async () => { if (repoPromise) await (await repoPromise).close(); } });
  return api;
}
