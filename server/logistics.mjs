import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createPricingStore, PricingError } from './pricing.mjs';
import { ensurePersonnel, refreshStaffingTasks } from './personnel.mjs';
import { applyTransportChange, personnelPlanIssues, transportSchema } from '../dist-server/domain-models.mjs';

const copy = value => structuredClone(value);
const stamp = () => new Date().toISOString();
const uid = prefix => `${prefix}-${randomUUID()}`;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = (message, status = 409) => { throw new PricingError(message, status); };
const rights = ['workOrdersRead', 'workOrdersWrite', 'vesselsRead', 'vesselsWrite', 'warehouseRead', 'warehouseWrite', 'customerAccounts', 'carrierAccounts'];
const can = (principal, right) => principal.user.level !== 'Medarbetare' || principal.user.permissions.includes(right);
const demand = (principal, right) => { if (!can(principal, right)) fail('Du saknar behörighet för detta moment.', 403); };
const visible = (principal, siteId) => Boolean(siteId) && (!principal.user.siteIds || principal.user.siteIds.includes(siteId));
const demandSite = (state, principal, siteId) => { if (!visible(principal, siteId)) fail('Du saknar åtkomst till anläggningen.', 403); if (!state.logistics.sites.some(site => site.id === siteId && site.active !== false)) fail('Välj en aktiv anläggning.', 422); };
const actorOf = principal => ({ actor: principal.user.name, actualUserId: principal.actor.id, effectiveUserId: principal.user.id, canPlan: true });
const txt = z.string().trim().max(2000);
const identifier = z.string().trim().min(1).max(200);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value, 'Ange ett giltigt datum.');
const time = z.string().regex(/^\d{2}:\d{2}$/).refine(value => Number(value.slice(0, 2)) < 24 && Number(value.slice(3)) < 60);
const windowSchema = z.object({ date: day, from: time.optional(), to: time.optional() }).strict().refine(value => !value.from || !value.to || value.from < value.to, 'Tidsintervallets slut måste komma efter start.');
const placeSchema = z.object({ name: txt, address: txt, postalCode: txt, city: txt, number: txt.optional(), contact: txt.optional(), phone: txt.optional() }).strict();
const materialSchema = z.object({ articleId: identifier, plannedKg: z.number().finite().min(0).max(1000000000) }).strict();
const inputSchema = z.object({
  siteId: identifier, action: z.enum(['pickup', 'exchange', 'placement', 'outbound']), customerId: identifier.optional(),
  from: placeSchema, to: placeSchema, operator: z.enum(['own', 'external']).default('own'), carrierId: identifier.optional(),
  vesselId: identifier.optional(), replacementVesselId: identifier.optional(), agreementId: identifier.optional(),
  vesselType: z.enum(['container', 'battery', 'bin', 'cage']), vesselSize: txt.optional(),
  materialRows: z.array(materialSchema).max(100), requestedWindow: windowSchema.optional(),
  priority: z.enum(['normal', 'asap']).default('normal'), durationMinutes: z.number().int().min(15).max(480).multipleOf(15).default(60),
  handling: txt.default(''), notes: txt.default(''), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(),
  assignedDriverId: identifier.optional(), assignedVehicleId: identifier.optional(),
}).strict();
const actualRowsSchema = z.array(z.object({ articleId: identifier, actualKg: z.number().finite().positive().max(1000000000) }).strict()).max(100);
const requestSchema = z.object({ vesselId: identifier, type: z.enum(['pickup', 'exchange', 'earlier']), requestedDate: day.optional(), comment: txt, existingOrderId: identifier.optional(), idempotencyKey: identifier }).strict();
const vesselSchema = z.object({ id: identifier, name: identifier, type: z.enum(['container', 'battery', 'bin', 'cage']), size: txt.default(''), siteId: identifier, active: z.boolean().default(true), customerId: identifier.optional(), agreementId: identifier.optional(), place: placeSchema.optional(), status: z.enum(['available', 'placed', 'reserved', 'maintenance']).default('available'), fullness: z.number().min(0).max(100).optional(), materialArticleId: identifier.optional(), version: z.number().int().nonnegative().optional() }).strict();
const agreementSchema = z.object({ id: identifier, customerId: identifier, siteId: identifier, vesselId: identifier, active: z.boolean(), action: z.enum(['pickup', 'exchange']), intervalDays: z.number().int().min(0).max(366), nextDate: day, notes: txt, kind: z.enum(['rental', 'rolling']).optional(), rentalStart: day.optional(), rentalEnd: day.optional(), allowedActions: z.array(z.enum(['pickup', 'exchange'])).max(2).optional() }).strict();
const parse = (schema, input) => { const result = schema.safeParse(input); if (!result.success) fail(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' '), 422); return result.data; };
const emptyPlace = () => ({ name: '', address: '', postalCode: '', city: '' });
const customerPlace = customer => ({ name: customer.name, address: customer.address ?? '', postalCode: customer.postalCode ?? '', city: customer.city ?? '', number: customer.number ?? '', contact: customer.contactPerson ?? '', phone: customer.phone ?? '' });
const sitePlace = site => ({ name: `JEROC ${site.name}`, address: site.address ?? '', postalCode: site.postalCode ?? '', city: site.city ?? '', number: site.number ?? '' });
const openOrder = order => !['done', 'cancelled'].includes(order.status);
function audit(state, actor, action, details = {}, transactionAudit = []) {
  const row = { id: uid('logistics-event'), at: stamp(), action, actorId: actor.actualUserId ?? actor.id, actorName: actor.actor ?? actor.name, ...details };
  state.logistics.audit.push(row); state.logistics.revision += 1; transactionAudit.push({ ...row, domain: 'logistics' });
}
function orderAudit(state, order, detail, actor, action, text, transactionAudit = []) {
  const at = stamp(); detail.version += 1; detail.updatedAt = at; order.updatedAt = at;
  order.audit.push({ at, actor: actor.actor ?? actor.name, actualUserId: actor.actualUserId ?? actor.id, effectiveUserId: actor.effectiveUserId ?? actor.id, text });
  state.transport.revision += 1; audit(state, actor, action, { orderId: order.id, version: detail.version, text }, transactionAudit);
}
function articlesOf(state) {
  const latest = new Map();
  for (const article of state.pricing?.articleHistory ?? []) if (!latest.has(article.id) || Number(article.version ?? 0) >= Number(latest.get(article.id).version ?? 0)) latest.set(article.id, article);
  return [...latest.values()].filter(article => article.active !== false).map(article => {
    const classification = state.logistics.classifications.find(entry => entry.articleId === article.id);
    return { id: article.id, name: article.name, hazardous: classification?.hazardous === true, wasteCode: classification?.wasteCode ?? '', handlingInstructions: classification?.handlingInstructions ?? '' };
  });
}
function articleOf(state, id) { const article = articlesOf(state).find(article => article.id === id); if (!article) fail('Välj en aktiv artikel ur artikelregistret.', 422); return article; }
function synchronizeStock(state, environmentInventory) {
  const domain = state.logistics;
  const previousCount = domain.inventoryMovements.length;
  for (const movement of environmentInventory ?? []) {
    const id = `environment:${movement.id}`;
    if (domain.inventoryMovements.some(value => value.id === id)) continue;
    const classification = movement.classification ?? domain.classifications.find(value => value.articleId === movement.articleId);
    if (classification?.hazardous !== true && !movement.wasteCode) continue;
    const article = articlesOf(state).find(value => value.id === movement.articleId);
    domain.inventoryMovements.push({ id, siteId: movement.siteId, articleId: movement.articleId, articleName: article?.name ?? classification?.wasteDescription ?? movement.articleId,
      hazardous: true, wasteCode: movement.wasteCode ?? classification?.wasteCode ?? '', kg: Number(movement.weight), kind: 'receipt', sourceId: movement.id, at: movement.receivedAt ?? stamp(), actorId: 'environment', reason: 'Registrerad miljömottagning eller miljörättelse.' });
  }
  // Submitted yard cards are physical incoming weights, independent of financial
  // approval. Hazardous rows come exclusively from the environmental ledger.
  const projected = new Map();
  for (const card of state.office?.cards ?? []) {
    if (!card.sourceId || !Array.isArray(card.rows) || !card.rows.length) continue;
    const site = domain.sites.find(site => site.id === card.siteId || !card.siteId && site.name === card.yard);
    if (!site) continue;
    for (const row of card.rows) {
      const article = articlesOf(state).find(value => value.id === row.articleId);
      if (!article || article.hazardous) continue;
      const key = `${card.sourceId}:${site.id}:${row.articleId}`;
      const value = projected.get(key) ?? { sourceId: card.sourceId, siteId: site.id, articleId: row.articleId, articleName: article.name, wasteCode: article.wasteCode, hazardous: false, kg: 0, at: card.date };
      value.kg += row.weight; projected.set(key, value);
    }
  }
  for (const [key, value] of projected) {
    const previous = domain.incomingProjection[key]?.kg ?? 0;
    if (Math.abs(value.kg - previous) < 0.0000001) continue;
    domain.inventoryMovements.push({ ...value, id: uid('incoming'), kg: value.kg - previous, kind: 'receipt', actorId: 'yard', reason: previous ? 'Ändrad faktisk invägd mängd.' : 'Inskickad invägning från gården.' });
    domain.incomingProjection[key] = value;
  }
  for (const [key, previous] of Object.entries(domain.incomingProjection)) if (!projected.has(key) && previous.kg !== 0) {
    domain.inventoryMovements.push({ ...previous, id: uid('incoming-correction'), kg: -previous.kg, kind: 'receipt', at: stamp(), actorId: 'yard', reason: 'Tidigare invägd materialrad har tagits bort eller fått annan klassificering.' });
    domain.incomingProjection[key] = { ...previous, kg: 0 };
  }
  if (domain.inventoryMovements.length !== previousCount) domain.revision += 1;
}
export function ensureLogistics(state, context = {}) {
  ensurePersonnel(state);
  if (!state.logistics) {
    state.logistics = { version: 1, revision: 0, sites: [], classifications: [], vessels: [], agreements: [], requests: [], inventoryMovements: [], incomingProjection: {}, details: {}, deliveryOutbox: [], audit: [], idempotency: {} };
    state.logisticsAuth = { accounts: [], sessions: [], attempts: [] };
    // Do not invent physical stock, customer contracts, or historic orders.
  }
  state.logisticsAuth ??= { accounts: [], sessions: [], attempts: [] };
  state.logistics.deliveryOutbox ??= [];
  if (context.sites) state.logistics.sites = copy(context.sites);
  if (context.classifications) state.logistics.classifications = copy(context.classifications);
  for (const order of state.transport.orders) if (!order.siteId) {
    const ownSite = state.logistics.sites.find(site => site.city && site.city.toLowerCase() === order.city.toLowerCase()) ?? state.logistics.sites.find(site => site.id === 'norrtalje');
    if (ownSite) order.siteId = ownSite.id;
  }
  synchronizeStock(state, context.inventory);
  return state.logistics;
}
export function logisticsOutboundInventory(state) {
  return (state.logistics?.inventoryMovements ?? []).filter(movement => movement.kind === 'outbound' && movement.hazardous).map(movement => ({ id: movement.id, siteId: movement.siteId, articleId: movement.articleId, wasteCode: movement.wasteCode, weight: movement.kg }));
}
function detailFor(state, order, persist = true) {
  let detail = state.logistics.details[order.id]; if (detail) return detail;
  const site = state.logistics.sites.find(site => site.id === order.siteId) ?? state.logistics.sites.find(site => site.active !== false);
  if (!site) fail('Arbetsordern behöver en anläggning.', 422);
  const customer = state.office.customers.find(customer => customer.id === order.customerId);
  const driver = state.transport.drivers.find(driver => driver.id === order.driverId);
  const place = { ...(customer ? customerPlace(customer) : emptyPlace()), name: order.customerName, address: order.address, city: order.city };
  const external = order.operator === 'external' || Boolean(driver?.companyId);
  detail = { orderId: order.id, version: 1, siteId: site.id, operator: external ? 'external' : 'own', carrierId: driver?.companyId,
    source: 'office', from: order.action === 'outbound' ? sitePlace(site) : place, to: order.action === 'outbound' ? place : sitePlace(site), materialRows: [],
    requestedWindow: order.requestedDate ? { date: order.requestedDate } : undefined,
    confirmedWindow: order.date ? { date: order.date, from: `${Math.floor((order.startMinute ?? 0) / 60)}`.padStart(2, '0') + ':' + `${(order.startMinute ?? 0) % 60}`.padStart(2, '0') } : undefined,
    assignedDriverId: order.driverId, assignedVehicleId: order.vehicleId, carrierRequest: { status: external ? 'accepted' : 'draft', version: 1 },
    execution: { stage: order.status === 'done' ? 'delivered' : 'pending', officeCleared: false }, priority: 'normal', handling: order.notes ?? '', updatedAt: order.updatedAt };
  if (persist) state.logistics.details[order.id] = detail; return detail;
}
function orderAndDetail(state, id) {
  const order = state.transport.orders.find(order => order.id === id); if (!order) fail('Arbetsordern finns inte.', 404);
  return { order, detail: detailFor(state, order) };
}
function expected(detail, version) { if (!Number.isInteger(version) || version !== detail.version) fail('Uppdraget har ändrats. Hämta senaste versionen och försök igen.'); }
function stockOf(state) {
  const totals = new Map();
  const key = (siteId, articleId) => `${siteId}:${articleId}`;
  for (const movement of state.logistics.inventoryMovements) {
    const id = key(movement.siteId, movement.articleId), value = totals.get(id) ?? { siteId: movement.siteId, articleId: movement.articleId, articleName: movement.articleName, wasteCode: movement.wasteCode, hazardous: movement.hazardous, onHandKg: 0, reservedKg: 0, availableKg: 0 };
    value.onHandKg += movement.kg; totals.set(id, value);
  }
  for (const order of state.transport.orders.filter(order => order.action === 'outbound' && openOrder(order))) {
    const detail = state.logistics.details[order.id]; if (!detail || ['departed', 'delivered'].includes(detail.execution.stage)) continue;
    for (const row of detail.materialRows) {
      const id = key(detail.siteId, row.articleId), value = totals.get(id) ?? { siteId: detail.siteId, articleId: row.articleId, articleName: row.name, wasteCode: row.wasteCode, hazardous: row.hazardous, onHandKg: 0, reservedKg: 0, availableKg: 0 };
      value.reservedKg += row.plannedKg; totals.set(id, value);
    }
  }
  return [...totals.values()].map(value => ({ ...value, onHandKg: Math.round(value.onHandKg * 1000) / 1000, reservedKg: Math.round(value.reservedKg * 1000) / 1000, availableKg: Math.round((value.onHandKg - value.reservedKg) * 1000) / 1000 }));
}
function availableStock(state, siteId, articleId, excluding) {
  const stock = stockOf(state).find(row => row.siteId === siteId && row.articleId === articleId); let available = stock?.availableKg ?? 0;
  const detail = excluding && state.logistics.details[excluding];
  if (detail && !['departed', 'delivered'].includes(detail.execution.stage)) available += detail.materialRows.filter(row => row.articleId === articleId).reduce((sum, row) => sum + row.plannedKg, 0);
  return available;
}
function assertUnfinished(order, detail) { if (!openOrder(order) || ['departed', 'delivered'].includes(detail.execution.stage)) fail('Uppdraget är avslutat eller har avgått med last. Registrera en separat rättelse.'); }
function invalidateDocument(detail) { if (detail.document) { detail.documentHistory ??= []; detail.documentHistory.push(copy(detail.document)); } detail.document = undefined; detail.execution.officeCleared = false; }
function idempotent(state, actorId, action, key, body, operation) {
  if (!key || typeof key !== 'string' || key.length > 200) fail('En återförsöksnyckel behövs.', 422);
  const id = `${actorId}:${action}:${key}`, previous = state.logistics.idempotency[id], fingerprint = hash(body);
  if (previous) { if (previous.hash !== fingerprint) fail('Återförsöksnyckeln har redan använts med andra uppgifter.'); return copy(previous.result); }
  const result = operation(); state.logistics.idempotency[id] = { hash: fingerprint, result: copy(result), at: stamp() }; return result;
}
function normalizeInput(state, principal, input, excluding) {
  const value = parse(inputSchema, input); demandSite(state, principal, value.siteId);
  if (value.customerId && !state.office.customers.some(customer => customer.id === value.customerId)) fail('Kunden finns inte.', 422);
  if (!value.from.name || !value.from.address || !value.from.city || !value.to.name || !value.to.address || !value.to.city) fail('Ange avsändare och mottagare med adress och ort.', 422);
  if (value.operator === 'external') { if (!state.personnel.companies.some(company => company.id === value.carrierId)) fail('Välj ett registrerat åkeri.', 422); if (value.assignedDriverId || value.assignedVehicleId) fail('Åkeriet väljer förare och fordon när uppdraget accepterats.', 422); }
  else {
    value.carrierId = undefined;
    if (value.assignedDriverId) { const driver = state.transport.drivers.find(driver => driver.id === value.assignedDriverId); const person = state.personnel.people.find(person => person.driverId === driver?.id); if (!driver || driver.companyId || !person || person.id !== driver.personId || person.kind !== 'employee' || !person.active || !person.canDrive) fail('Välj en aktiv egen JEROC-förare.', 422); }
    if (value.assignedVehicleId && !state.transport.vehicles.some(vehicle => vehicle.id === value.assignedVehicleId && vehicle.types.includes(value.vesselType))) fail('Välj ett fordon som kan hantera kärltypen.', 422);
  }
  for (const [field, mustBeAvailable] of [['vesselId', false], ['replacementVesselId', true]]) if (value[field]) {
    const vessel = state.logistics.vessels.find(vessel => vessel.id === value[field]); if (!vessel || !vessel.active || vessel.siteId !== value.siteId) fail('Välj ett aktivt kärl på samma anläggning.', 422);
    if (vessel.type !== value.vesselType) fail('Kärlets typ stämmer inte med uppdraget.', 422);
    if (field === 'vesselId' && value.customerId && vessel.customerId && vessel.customerId !== value.customerId) fail('Kärlet hör till en annan kund.', 422);
    if (field === 'vesselId' && value.action === 'placement' && (vessel.status !== 'available' || vessel.customerId)) fail('Välj ett ledigt kärl för utställning.', 422);
    if (mustBeAvailable && (vessel.status !== 'available' || state.transport.orders.some(order => order.id !== excluding && openOrder(order) && state.logistics.details[order.id]?.replacementVesselId === vessel.id))) fail('Ersättningskärlet är redan reserverat eller utställt.');
  }
  if (value.vesselId && state.transport.orders.some(order => order.id !== excluding && openOrder(order) && state.logistics.details[order.id]?.vesselId === value.vesselId)) fail('Kärlet har redan ett aktivt uppdrag. Ändra det befintliga uppdraget i stället.');
  if (value.vesselId && value.vesselId === value.replacementVesselId) fail('Välj ett annat ersättningskärl.', 422);
  if (value.agreementId) { const agreement = state.logistics.agreements.find(agreement => agreement.id === value.agreementId); if (!agreement?.active || agreement.siteId !== value.siteId || agreement.customerId !== value.customerId || agreement.vesselId !== value.vesselId) fail('Avtalet hör inte till kundens kärl och anläggning.', 422); }
  if (value.action === 'outbound' && !value.materialRows.length) fail('Välj minst en artikel för utleveransen.', 422);
  const ids = new Set();
  const rows = value.materialRows.map(row => { if (ids.has(row.articleId)) fail('Samla samma artikel på en materialrad.', 422); ids.add(row.articleId); const article = articleOf(state, row.articleId); if (value.action === 'outbound' && (row.plannedKg <= 0 || row.plannedKg > availableStock(state, value.siteId, row.articleId, excluding) + 0.0001)) fail(`${article.name}: mängden överstiger det fria lagret.`, 422); return { ...row, name: article.name, hazardous: article.hazardous, wasteCode: article.wasteCode }; });
  return { ...value, materialRows: rows };
}
function createOrder(state, input, actor, source = 'office', transactionAudit = []) {
  const numbers = state.transport.orders.map(order => Number(order.id.replace(/^AO-/, ''))).filter(Number.isFinite); const id = `AO-${Math.max(1000, ...numbers) + 1}`; const at = stamp();
  const destination = input.action === 'outbound' || input.action === 'placement' ? input.to : input.from;
  const order = { id, siteId: input.siteId, operator: input.operator, customerId: input.customerId, customerName: destination.name, address: destination.address, city: destination.city,
    contact: destination.contact ?? '', phone: destination.phone ?? '', action: input.action, vesselType: input.vesselType, vesselSize: input.vesselSize ?? '',
    material: input.materialRows.map(row => row.name).join(', '), pickupVessel: input.vesselId ?? '', replacementVessel: input.replacementVesselId ?? '', notes: input.notes ?? '',
    lat: input.lat ?? 59.7578, lng: input.lng ?? 18.7105, durationMinutes: input.durationMinutes ?? 60, status: 'unbooked', requestedDate: input.requestedWindow?.date,
    audit: [], updatedAt: at, bookingVersion: 0 };
  const detail = { orderId: id, version: 0, siteId: input.siteId, operator: input.operator, carrierId: input.carrierId, vesselId: input.vesselId, replacementVesselId: input.replacementVesselId,
    agreementId: input.agreementId, source, materialRows: copy(input.materialRows), from: copy(input.from), to: copy(input.to), requestedWindow: copy(input.requestedWindow),
    assignedDriverId: input.assignedDriverId, assignedVehicleId: input.assignedVehicleId, carrierRequest: { status: 'draft', version: 1 }, execution: { stage: 'pending', officeCleared: false },
    priority: input.priority ?? 'normal', handling: input.handling ?? '', updatedAt: at };
  state.transport.orders.push(order); state.logistics.details[id] = detail;
  orderAudit(state, order, detail, actor, 'work_order.created', 'Arbetsorder skapad. Önskad tid är ännu inte bokad.', transactionAudit);
  return { orderId: id };
}
function publicOrder(state, order, external = false) {
  const detail = detailFor(state, order, false), value = { ...copy(order), detail: copy(detail) };
  if (external) { value.audit = []; delete value.confirmation; delete value.detail.documentHistory; }
  return value;
}
function officeState(state, principal) {
  const capabilities = rights.filter(right => can(principal, right)); const d = state.logistics;
  const sites = d.sites.filter(site => visible(principal, site.id)), siteIds = new Set(sites.map(site => site.id));
  const work = can(principal, 'workOrdersRead'), vessels = can(principal, 'vesselsRead'), warehouse = can(principal, 'warehouseRead');
  const orders = work ? state.transport.orders.filter(order => siteIds.has(order.siteId ?? d.details[order.id]?.siteId)).map(order => publicOrder(state, order)) : [];
  const allowedCustomerIds = new Set([...orders.map(order => order.customerId), ...d.vessels.filter(vessel => siteIds.has(vessel.siteId)).map(vessel => vessel.customerId)]);
  const customers = (state.office.customers ?? []).filter(customer => !principal.user.siteIds || allowedCustomerIds.has(customer.id)).map(({ id, name, number, address, postalCode, city, phone, email, contactPerson }) => ({ id, name, number, address, postalCode, city, phone, email, contactPerson }));
  const accounts = state.logisticsAuth.accounts.filter(account => can(principal, account.kind === 'customer' ? 'customerAccounts' : 'carrierAccounts') && (account.kind === 'carrier' ? !principal.user.siteIds : customers.some(customer => customer.id === account.subjectId))).map(({ password, ...account }) => account);
  return { demo: true, revision: d.revision, capabilities, sites, orders, vessels: vessels ? copy(d.vessels.filter(vessel => siteIds.has(vessel.siteId))) : [],
    agreements: vessels ? copy(d.agreements.filter(agreement => siteIds.has(agreement.siteId))) : [], requests: work ? copy(d.requests.filter(request => orders.some(order => order.id === request.orderId))) : [],
    stock: warehouse ? stockOf(state).filter(row => siteIds.has(row.siteId)) : [], inventoryMovements: warehouse ? copy(d.inventoryMovements.filter(movement => siteIds.has(movement.siteId))) : [],
    customers: work || vessels || can(principal, 'customerAccounts') ? customers : [], carriers: work || can(principal, 'carrierAccounts') ? copy(state.personnel.companies) : [],
    drivers: work ? copy(state.transport.drivers.filter(driver => !principal.user.siteIds || state.personnel.people.some(person => person.driverId === driver.id && person.siteIds.some(id => siteIds.has(id))))) : [],
    vehicles: work ? copy(state.transport.vehicles) : [], accounts: copy(accounts), articles: work || vessels || warehouse ? articlesOf(state) : [],
    deliveryOutbox: work ? copy(d.deliveryOutbox.filter(delivery => orders.some(order => order.id === delivery.orderId))) : [] };
}
function documentFingerprint(detail) { return hash({ from: detail.from, to: detail.to, carrierId: detail.carrierId, driverId: detail.assignedDriverId, vehicleId: detail.assignedVehicleId, rows: detail.materialRows, handling: detail.handling }); }
function prepareDocument(detail) {
  if (detail.materialRows.some(row => !row.actualKg)) fail('Registrera verkliga vikter innan transportdokumentet fastställs.', 422);
  if (!detail.assignedDriverId || !detail.assignedVehicleId) fail('Tilldela förare och fordon innan dokumentet fastställs.', 422);
  const fingerprint = documentFingerprint(detail);
  if (detail.document?.hash === fingerprint) return;
  detail.documentHistory ??= []; if (detail.document) detail.documentHistory.push(copy(detail.document));
  detail.document = { version: (detail.documentHistory.at(-1)?.version ?? 0) + 1, hash: fingerprint, preparedAt: stamp(), signatures: [], status: 'prepared', snapshot: { from: copy(detail.from), to: copy(detail.to), carrierId: detail.carrierId, driverId: detail.assignedDriverId, vehicleId: detail.assignedVehicleId, rows: copy(detail.materialRows), handling: detail.handling } };
}
function signDocument(detail, role, actor, version, method) {
  const document = detail.document;
  if (!document || document.version !== version || document.hash !== documentFingerprint(detail)) fail('Dokumentet har ändrats. Granska och förbered den aktuella versionen igen.');
  if (document.signatures.some(signature => signature.role === role && signature.actorId === actor.id && signature.documentVersion === version)) return;
  document.signatures = document.signatures.filter(signature => signature.role !== role);
  document.signatures.push({ role, actorId: actor.id, actorName: actor.name, at: stamp(), documentVersion: version, documentHash: document.hash, method });
}
function assertDeparture(state, order, detail) {
  if (!detail.execution.officeCleared) fail('Kontoret behöver frigöra uppdraget innan avfärd med last.', 422);
  if (detail.materialRows.some(row => !row.actualKg || row.actualKg <= 0)) fail('Verklig lastvikt saknas.', 422);
  if (detail.materialRows.length && detail.execution.stage !== 'loaded') fail('Bekräfta aktuell last innan avfärd.', 422);
  if (order.action === 'exchange' && detail.vesselId && !detail.replacementVesselId) fail('Välj ersättningskärl innan bytet genomförs.', 422);
  if (detail.operator === 'external' && detail.carrierRequest.status !== 'accepted') fail('Åkeriet behöver acceptera uppdraget.', 422);
  if (!detail.assignedDriverId || !detail.assignedVehicleId) fail('Förare och fordon måste vara tilldelade.', 422);
  const driver = state.transport.drivers.find(driver => driver.id === detail.assignedDriverId), person = state.personnel.people.find(person => person.driverId === driver?.id), vehicle = state.transport.vehicles.find(vehicle => vehicle.id === detail.assignedVehicleId);
  if (!driver || !person?.active || !person.canDrive || driver.personId !== person.id || !vehicle || !vehicle.types.includes(order.vesselType)) fail('Tilldelad förare eller fordon är inte längre tillgänglig.', 422);
  if (detail.operator === 'own' && order.status === 'booked') { const issues = personnelPlanIssues(state.personnel, state.transport, order.id, order); if (issues.length) fail(issues.join(' '), 422); }
  if (detail.operator === 'external' && (person.companyId !== detail.carrierId || driver.companyId !== detail.carrierId)) fail('Föraren tillhör inte längre det valda åkeriet.', 422);
  const transportDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  for (const requirement of [...(order.requiredCompetencies ?? []), ...(vehicle.requiredCompetencies ?? [])]) {
    const [type, code] = requirement.split(':');
    if (!state.personnel.competencies.some(competency => competency.personId === person.id && competency.verified && competency.type === type && competency.codes.includes(code) && competency.validFrom <= transportDay && (!competency.validTo || competency.validTo >= transportDay))) fail(`Föraren saknar giltig verifierad kompetens: ${requirement}.`, 422);
  }
  if (detail.materialRows.some(row => row.hazardous)) {
    const document = detail.document;
    if (!document || document.status !== 'prepared' || document.hash !== documentFingerprint(detail)) fail('Förbered ett aktuellt transportdokument innan avfärd.', 422);
    if (!['sender', 'carrier'].every(role => document.signatures.some(signature => signature.role === role && signature.documentVersion === document.version && signature.documentHash === document.hash))) fail('Lämnare och transportör behöver godkänna aktuell dokumentversion i demon.', 422);
  }
  if (order.action === 'outbound') for (const row of detail.materialRows) if (row.actualKg > availableStock(state, detail.siteId, row.articleId, order.id) + 0.0001) fail(`${row.name}: verklig last överstiger tillgängligt lager.`, 422);
}
function depart(state, order, detail, actor, transactionAudit) {
  if (['departed', 'delivered'].includes(detail.execution.stage)) return;
  assertDeparture(state, order, detail);
  if (order.action === 'outbound') for (const row of detail.materialRows) {
    const id = `outbound:${order.id}:${row.articleId}`;
    if (!state.logistics.inventoryMovements.some(movement => movement.id === id)) state.logistics.inventoryMovements.push({ id, siteId: detail.siteId, articleId: row.articleId, articleName: row.name, wasteCode: row.wasteCode, hazardous: row.hazardous, kg: -row.actualKg, kind: 'outbound', sourceId: order.id, at: stamp(), actorId: actor.actualUserId ?? actor.id, reason: 'Bekräftad avfärd med faktisk last.' });
  }
  detail.execution.stage = 'departed'; detail.execution.departedAt = stamp();
  orderAudit(state, order, detail, actor, 'transport.loaded_departure', 'Avfärd med last bekräftad. Faktisk mängd har registrerats en gång.', transactionAudit);
}
function deliver(state, order, detail, actor, transactionAudit) {
  if (detail.execution.stage === 'delivered') return;
  if (detail.execution.stage !== 'departed') fail('Bekräfta avfärd med last innan uppdraget slutförs.', 422);
  const vessel = state.logistics.vessels.find(vessel => vessel.id === detail.vesselId), replacement = state.logistics.vessels.find(vessel => vessel.id === detail.replacementVesselId);
  if (vessel && ['pickup', 'exchange'].includes(order.action)) { vessel.customerId = undefined; vessel.place = undefined; vessel.status = 'available'; vessel.fullness = 0; vessel.version += 1; }
  if (order.action === 'placement' && vessel) { vessel.customerId = order.customerId; vessel.place = copy(detail.to); vessel.status = 'placed'; vessel.version += 1; }
  if (replacement && order.action === 'exchange') { replacement.customerId = order.customerId; replacement.place = copy(detail.from); replacement.status = 'placed'; replacement.fullness = 0; replacement.version += 1; }
  detail.execution.stage = 'delivered'; detail.execution.deliveredAt = stamp(); order.status = 'done';
  orderAudit(state, order, detail, actor, 'work_order.completed', 'Uppdraget slutfört. Kärlens placering har uppdaterats.', transactionAudit);
  const agreement = state.logistics.agreements.find(agreement => agreement.id === detail.agreementId && agreement.active && agreement.kind !== 'rental');
  if (agreement) {
    const extra = state.logistics.requests.some(request => request.orderId === order.id && request.status === 'accepted' && request.type !== 'earlier');
    if (!extra) { const next = new Date(`${agreement.nextDate}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + agreement.intervalDays); agreement.nextDate = next.toISOString().slice(0, 10); }
    if (order.action === 'exchange' && replacement) { agreement.vesselId = replacement.id; replacement.agreementId = agreement.id; if (vessel) vessel.agreementId = undefined; }
    else if (order.action === 'pickup') { agreement.active = false; if (vessel) vessel.agreementId = undefined; }
    agreement.version += 1;
    if (agreement.active && !state.transport.orders.some(value => openOrder(value) && state.logistics.details[value.id]?.agreementId === agreement.id)) createOrder(state, agreementInput(state, agreement), actor, 'agreement', transactionAudit);
  }
}
export function driverOrderView(state, person, order) {
  if (!state.logistics?.details[order.id]) return order.driverId === person.driverId ? copy(order) : undefined;
  const detail = state.logistics.details[order.id];
  if ((detail.assignedDriverId ?? order.driverId) !== person.driverId || (detail.operator === 'external' && detail.carrierId !== person.companyId)) return undefined;
  return publicOrder(state, order, true);
}
export function applyDriverAction(state, person, orderId, command, transactionAudit = []) {
  ensureLogistics(state); const { order, detail } = orderAndDetail(state, orderId);
  if (!driverOrderView(state, person, order)) fail('Uppdraget är inte tilldelat dig.', 403);
  if (order.status === 'cancelled') fail('Uppdraget har avbrutits.');
  expected(detail, command.expectedVersion); const actor = { id: person.id, name: person.name };
  if (command.action === 'depart') depart(state, order, detail, actor, transactionAudit);
  else if (command.action === 'deliver') deliver(state, order, detail, actor, transactionAudit);
  else {
    assertUnfinished(order, detail);
    if (command.action === 'travel.empty') { detail.execution.stage = 'travelling_empty'; orderAudit(state, order, detail, actor, 'transport.empty_travel', 'Föraren är på väg till lastning. Ingen lagerförändring.', transactionAudit); }
    else if (command.action === 'arrive') { detail.execution.stage = 'at_pickup'; orderAudit(state, order, detail, actor, 'transport.arrived', 'Föraren är framme vid lastplatsen.', transactionAudit); }
    else if (command.action === 'load') { loadRows(detail, command.rows); orderAudit(state, order, detail, actor, 'transport.loaded', 'Verkliga lastvikter registrerade.', transactionAudit); }
    else if (command.action === 'sign') { signDocument(detail, 'carrier', actor, command.documentVersion, 'demo_account'); orderAudit(state, order, detail, actor, 'transport.document_signed_demo', 'Transportören har godkänt dokumentet i demo.', transactionAudit); }
    else fail('Åtgärden stöds inte.', 422);
  }
  return publicOrder(state, order, true);
}
function loadRows(detail, input) {
  const rows = parse(actualRowsSchema, input);
  if (new Set(rows.map(row => row.articleId)).size !== rows.length || rows.length !== detail.materialRows.length || detail.materialRows.some(row => !rows.some(value => value.articleId === row.articleId))) fail('Ange verklig vikt för varje materialrad.', 422);
  const next = detail.materialRows.map(row => ({ ...row, actualKg: rows.find(value => value.articleId === row.articleId).actualKg }));
  if (!isDeepStrictEqual(next, detail.materialRows)) invalidateDocument(detail);
  detail.materialRows = next; detail.execution.stage = 'loaded';
}
export function validateLogisticsTransportChange(state, base, next) {
  for (const order of next.orders.filter(order => !base.orders.some(previous => previous.id === order.id))) {
    if (order.operator === 'external' || order.action === 'outbound') fail('Skapa externa uppdrag och utleveranser i Arbetsordrar för korrekt lager- och transportkoppling.');
    if (!['unbooked', 'booked'].includes(order.status)) fail('Nya uppdrag får inte kringgå avfärds- och avslutsflödet.');
  }
  for (const order of next.orders.filter(order => !state.logistics?.details[order.id])) {
    const before = base.orders.find(previous => previous.id === order.id);
    if (before && ((order.operator === 'external' && before.operator !== 'external') || (order.action === 'outbound' && before.action !== 'outbound'))) fail('Ändra till extern transport eller utleverans i Arbetsordrar för korrekt lager- och transportkoppling.');
  }
  if (!state.logistics) return;
  for (const [id, detail] of Object.entries(state.logistics.details)) {
    const before = base.orders.find(order => order.id === id), after = next.orders.find(order => order.id === id); if (!before || isDeepStrictEqual(before, after)) continue;
    if (!after) fail('En gemensam arbetsorder får inte tas bort från planeraren. Avbryt den i Arbetsordrar.');
    if (detail.operator === 'external') fail('Extern transport planeras av åkeriet via Arbetsordrar.');
    if (['departed', 'delivered'].includes(detail.execution.stage)) fail('En avgången transport kan inte ändras i planeraren.');
    if (after.status !== before.status && ['on_way', 'done', 'cancelled'].includes(after.status)) fail('Använd arbetsorderns avfärds- och avslutsflöde.');
    const bookingChanged = ['date', 'startMinute', 'driverId', 'vehicleId', 'durationMinutes'].some(key => !isDeepStrictEqual(before[key], after[key]));
    if (bookingChanged) { detail.assignedDriverId = after.driverId; detail.assignedVehicleId = after.vehicleId; invalidateDocument(detail); detail.version += 1; detail.updatedAt = stamp(); }
    if (bookingChanged) detail.confirmedWindow = after.date ? { date: after.date, from: `${Math.floor((after.startMinute ?? 0) / 60)}`.padStart(2, '0') + ':' + `${(after.startMinute ?? 0) % 60}`.padStart(2, '0') } : undefined;
    for (const field of ['siteId', 'operator', 'customerId', 'customerName', 'address', 'city', 'contact', 'phone', 'action', 'vesselType', 'material', 'pickupVessel', 'replacementVessel']) if (!isDeepStrictEqual(before[field], after[field])) fail('Ändra uppdragets underlag i Arbetsordrar.');
  }
}

function respondCustomerRequest(state, principal, command, transactionAudit) {
  demand(principal, 'workOrdersWrite');
  const request = state.logistics.requests.find(request => request.id === command.requestId); if (!request) fail('Kundförfrågan finns inte.', 404);
  const { order, detail } = orderAndDetail(state, request.orderId); demandSite(state, principal, detail.siteId);
  if (request.version !== command.expectedVersion) fail('Kundförfrågan har ändrats. Hämta den senaste versionen.');
  if (request.status !== 'pending') fail('Kundförfrågan är redan besvarad.');
  request.status = command.accepted ? 'accepted' : 'declined'; request.respondedAt = stamp(); request.response = parse(txt, command.comment ?? ''); request.version += 1;
  if (command.accepted && request.requestedDate) { detail.requestedWindow = { date: request.requestedDate }; order.requestedDate = request.requestedDate; }
  // An accepted earlier wish still needs explicit replanning. Preserve the
  // confirmed slot and carrier decision rather than silently moving a booking.
  if (!command.accepted && detail.source === 'customer' && order.status === 'unbooked' && request.type !== 'earlier') order.status = 'cancelled';
  orderAudit(state, order, detail, actorOf(principal), 'customer_request.responded', command.accepted ? 'Kontoret har tagit emot kundens önskemål för planering.' : 'Kontoret har avböjt kundens förfrågan.', transactionAudit);
  return { orderId: order.id, requestId: request.id };
}
function saveVessel(state, principal, command, transactionAudit) {
  demand(principal, 'vesselsWrite'); const previous = state.logistics.vessels.find(vessel => vessel.id === command.vessel?.id);
  const vessel = parse(vesselSchema, { ...previous, ...command.vessel }); demandSite(state, principal, vessel.siteId);
  if (previous) demandSite(state, principal, previous.siteId);
  if ((previous?.version ?? 0) !== command.expectedVersion) fail('Kärlet har ändrats. Hämta den senaste versionen.');
  if (vessel.customerId && !state.office.customers.some(customer => customer.id === vessel.customerId)) fail('Kunden finns inte.', 422);
  if (vessel.status === 'placed' && (!vessel.customerId || !vessel.place?.address || !vessel.place?.city)) fail('Ett utställt kärl behöver kund och plats.', 422);
  if (vessel.materialArticleId) articleOf(state, vessel.materialArticleId);
  if (previous) {
    const placementChanged = ['customerId', 'place', 'siteId', 'status'].some(field => !isDeepStrictEqual(previous[field], vessel[field]));
    if (placementChanged && (previous.status === 'placed' || previous.customerId || state.transport.orders.some(order => openOrder(order) && [state.logistics.details[order.id]?.vesselId, state.logistics.details[order.id]?.replacementVesselId].includes(vessel.id)))) fail('Kärlets placering eller reservation ändras genom en utförd arbetsorder.');
  }
  vessel.version = (previous?.version ?? 0) + 1;
  if (previous) state.logistics.vessels[state.logistics.vessels.indexOf(previous)] = vessel; else state.logistics.vessels.push(vessel);
  audit(state, actorOf(principal), 'vessel.saved', { vesselId: vessel.id }, transactionAudit); return {};
}
function agreementInput(state, agreement) {
  const vessel = state.logistics.vessels.find(vessel => vessel.id === agreement.vesselId), customer = state.office.customers.find(customer => customer.id === agreement.customerId), site = state.logistics.sites.find(site => site.id === agreement.siteId);
  const article = vessel.materialArticleId && articleOf(state, vessel.materialArticleId);
  return { siteId: site.id, action: agreement.action, customerId: customer.id, from: vessel.place ?? customerPlace(customer), to: sitePlace(site), operator: 'own', vesselId: vessel.id, agreementId: agreement.id,
    vesselType: vessel.type, vesselSize: vessel.size, materialRows: article ? [{ articleId: article.id, plannedKg: 0, name: article.name, hazardous: article.hazardous, wasteCode: article.wasteCode }] : [],
    requestedWindow: { date: agreement.nextDate }, notes: agreement.notes, durationMinutes: 60, handling: article?.handlingInstructions ?? '' };
}
function saveAgreement(state, principal, command, transactionAudit) {
  demand(principal, 'vesselsWrite'); const agreement = parse(agreementSchema, command.agreement), previous = state.logistics.agreements.find(agreement => agreement.id === command.agreement.id);
  demandSite(state, principal, agreement.siteId); if (previous) demandSite(state, principal, previous.siteId);
  if ((previous?.version ?? 0) !== command.expectedVersion) fail('Avtalet har ändrats. Hämta den senaste versionen.');
  const vessel = state.logistics.vessels.find(vessel => vessel.id === agreement.vesselId);
  if (!vessel || vessel.siteId !== agreement.siteId || vessel.customerId !== agreement.customerId) fail('Avtalet måste gälla kundens utställda kärl på samma anläggning.', 422);
  if (state.logistics.agreements.some(value => value.id !== agreement.id && value.active && value.vesselId === agreement.vesselId) && agreement.active) fail('Kärlet har redan ett aktivt avtal.');
  if (agreement.kind !== 'rental' && agreement.intervalDays < 1) fail('Rullande avtal behöver ett intervall i dagar.', 422);
  if (agreement.rentalStart && agreement.rentalEnd && agreement.rentalStart > agreement.rentalEnd) fail('Hyresperiodens slut måste komma efter start.', 422);
  const saved = { ...agreement, version: (previous?.version ?? 0) + 1 };
  if (previous) state.logistics.agreements[state.logistics.agreements.indexOf(previous)] = saved; else state.logistics.agreements.push(saved);
  vessel.agreementId = saved.active ? saved.id : undefined; vessel.version += 1;
  audit(state, actorOf(principal), 'agreement.saved', { agreementId: saved.id }, transactionAudit);
  let result = {};
  if (saved.active && saved.kind !== 'rental' && !state.transport.orders.some(order => openOrder(order) && state.logistics.details[order.id]?.agreementId === saved.id)) result = createOrder(state, agreementInput(state, saved), actorOf(principal), 'agreement', transactionAudit);
  return result;
}
function saveAccount(state, principal, command, transactionAudit) {
  const input = parse(z.object({ id: identifier.optional(), kind: z.enum(['customer', 'carrier']), subjectId: identifier, username: z.string().trim().toLowerCase().min(3).max(80).regex(/^[a-z0-9._-]+$/), active: z.boolean(), password: z.string().min(10).max(200).optional() }).strict(), command.account);
  demand(principal, input.kind === 'customer' ? 'customerAccounts' : 'carrierAccounts');
  if (input.kind === 'carrier') { if (principal.user.siteIds) fail('Åkerikonton kräver tillgång till alla anläggningar.', 403); if (!state.personnel.companies.some(company => company.id === input.subjectId)) fail('Åkeriet finns inte.', 422); }
  else {
    if (!state.office.customers.some(customer => customer.id === input.subjectId)) fail('Kunden finns inte.', 422);
    if (principal.user.siteIds) fail('Kundkonton med gemensam kundåtkomst kräver tillgång till alla anläggningar.', 403);
  }
  const accounts = state.logisticsAuth.accounts, previous = input.id ? accounts.find(account => account.id === input.id) : accounts.find(account => account.kind === input.kind && account.subjectId === input.subjectId && account.username === input.username);
  if (input.id && !previous) fail('Kontot finns inte.', 404);
  if (previous && (previous.subjectId !== input.subjectId || previous.kind !== input.kind)) fail('Ett konto får inte flyttas mellan kunder eller åkerier.', 422);
  if (accounts.some(account => account.id !== previous?.id && account.username === input.username && account.kind === input.kind)) fail('Inloggningsnamnet används redan.');
  if (!previous && !input.password) fail('Ange lösenord för det nya kontot.', 422);
  let password = previous?.password;
  if (input.password) { const salt = randomBytes(24).toString('hex'); password = { salt, digest: scryptSync(input.password, salt, 64).toString('hex') }; }
  const account = { id: previous?.id ?? uid(`${input.kind}-account`), kind: input.kind, subjectId: input.subjectId, username: input.username, active: input.active,
    createdAt: previous?.createdAt ?? stamp(), updatedAt: stamp(), lastLoginAt: previous?.lastLoginAt, password };
  if (previous) accounts[accounts.indexOf(previous)] = account; else accounts.push(account);
  state.logisticsAuth.sessions = state.logisticsAuth.sessions.filter(session => session.accountId !== account.id);
  audit(state, actorOf(principal), 'portal_account.saved', { accountId: account.id, kind: account.kind, subjectId: account.subjectId }, transactionAudit); return {};
}
function officeCommand(state, principal, command, transactionAudit) {
  if (!command || typeof command.action !== 'string') fail('Välj en åtgärd.', 422);
  if (command.action === 'vessel.save') return saveVessel(state, principal, command, transactionAudit);
  if (command.action === 'agreement.save') return saveAgreement(state, principal, command, transactionAudit);
  if (command.action === 'account.save') return saveAccount(state, principal, command, transactionAudit);
  if (command.action === 'request.respond') return respondCustomerRequest(state, principal, command, transactionAudit);
  if (command.action === 'inventory.adjust') {
    demand(principal, 'warehouseWrite'); const input = parse(z.object({ siteId: identifier, articleId: identifier, kg: z.number().finite().min(-1000000000).max(1000000000).refine(value => value !== 0), reason: z.string().trim().min(3).max(2000), idempotencyKey: identifier }).strict(), Object.fromEntries(Object.entries(command).filter(([key]) => key !== 'action'))); demandSite(state, principal, input.siteId);
    const article = articleOf(state, input.articleId); if (article.hazardous) fail('Farligt avfall rättas i Miljörapportering för att bevara miljöoriginal och rapportunderlag.', 422);
    return idempotent(state, principal.actor.id, command.action, input.idempotencyKey, input, () => {
      const stock = stockOf(state).find(stock => stock.siteId === input.siteId && stock.articleId === input.articleId); if ((stock?.onHandKg ?? 0) + input.kg < (stock?.reservedKg ?? 0) - 0.0001) fail('Rättelsen lämnar mindre lager än redan reserverad mängd.', 422);
      state.logistics.inventoryMovements.push({ id: uid('stock-adjustment'), siteId: input.siteId, articleId: article.id, articleName: article.name, wasteCode: article.wasteCode, hazardous: false, kg: input.kg, kind: 'adjustment', sourceId: input.idempotencyKey, at: stamp(), actorId: principal.actor.id, reason: input.reason });
      audit(state, actorOf(principal), 'inventory.adjusted', { siteId: input.siteId, articleId: article.id, kg: input.kg, reason: input.reason }, transactionAudit); return {};
    });
  }
  demand(principal, 'workOrdersWrite');
  if (command.action === 'order.create') return idempotent(state, principal.actor.id, command.action, command.idempotencyKey, command.input, () => createOrder(state, normalizeInput(state, principal, command.input), actorOf(principal), command.input.action === 'outbound' ? 'warehouse' : 'office', transactionAudit));
  const { order, detail } = orderAndDetail(state, command.orderId); demandSite(state, principal, detail.siteId); expected(detail, command.expectedVersion);
  const actor = actorOf(principal);
  if (command.action === 'order.depart') { depart(state, order, detail, actor, transactionAudit); return { orderId: order.id }; }
  if (command.action === 'order.deliver') { deliver(state, order, detail, actor, transactionAudit); return { orderId: order.id }; }
  assertUnfinished(order, detail);
  if (command.action === 'order.edit') {
    const input = normalizeInput(state, principal, command.input, order.id);
    if (input.operator !== detail.operator && order.status !== 'unbooked') fail('Avboka kalenderbokningen innan du byter transportör.');
    const oldFingerprint = documentFingerprint(detail);
    const unchangedRows = isDeepStrictEqual(detail.materialRows.map(({ actualKg, ...row }) => row), input.materialRows);
    const changed = !isDeepStrictEqual({ from: detail.from, to: detail.to, materialRows: detail.materialRows.map(({ actualKg, ...row }) => row), carrierId: detail.carrierId, vesselId: detail.vesselId, replacementVesselId: detail.replacementVesselId }, { from: input.from, to: input.to, materialRows: input.materialRows, carrierId: input.carrierId, vesselId: input.vesselId, replacementVesselId: input.replacementVesselId });
    if (changed) { invalidateDocument(detail); detail.execution.stage = 'pending'; }
    const sameCarrier = input.operator === 'external' && detail.operator === 'external' && input.carrierId === detail.carrierId;
    Object.assign(detail, { siteId: input.siteId, operator: input.operator, carrierId: input.carrierId, vesselId: input.vesselId, replacementVesselId: input.replacementVesselId, agreementId: input.agreementId, materialRows: unchangedRows ? detail.materialRows : input.materialRows, from: input.from, to: input.to, requestedWindow: input.requestedWindow, priority: input.priority, handling: input.handling, assignedDriverId: input.operator === 'own' ? (order.status === 'booked' ? order.driverId : input.assignedDriverId) : sameCarrier ? detail.assignedDriverId : undefined, assignedVehicleId: input.operator === 'own' ? (order.status === 'booked' ? order.vehicleId : input.assignedVehicleId) : sameCarrier ? detail.assignedVehicleId : undefined });
    if (documentFingerprint(detail) !== oldFingerprint) invalidateDocument(detail);
    if (detail.operator === 'external') detail.carrierRequest = { status: 'draft', version: detail.carrierRequest.version + 1 };
    for (const delivery of state.logistics.deliveryOutbox.filter(delivery => delivery.orderId === order.id && delivery.status === 'prepared')) delivery.status = 'superseded';
    const destination = input.action === 'outbound' || input.action === 'placement' ? input.to : input.from;
    Object.assign(order, { siteId: input.siteId, operator: input.operator, customerId: input.customerId, action: input.action, customerName: destination.name, address: destination.address, city: destination.city, contact: destination.contact ?? '', phone: destination.phone ?? '', vesselType: input.vesselType, vesselSize: input.vesselSize ?? '', material: input.materialRows.map(row => row.name).join(', '), pickupVessel: input.vesselId ?? '', replacementVessel: input.replacementVesselId ?? '', requestedDate: input.requestedWindow?.date, notes: input.notes, durationMinutes: input.durationMinutes });
    orderAudit(state, order, detail, actor, 'work_order.updated', 'Arbetsorderns underlag ändrat. Tidigare dokument och svar bevaras i historiken.', transactionAudit);
  } else if (command.action === 'order.book') {
    demand(principal, 'transportPlan');
    if (detail.operator !== 'own') fail('Åkeriet bekräftar och bemannar externa uppdrag.', 422);
    const plan = parse(z.object({ date: day, startMinute: z.number().int().min(0).max(1425).multipleOf(15), durationMinutes: z.number().int().min(15).max(480).multipleOf(15), driverId: identifier, vehicleId: identifier }).strict(), command.plan);
    const driver = state.transport.drivers.find(driver => driver.id === plan.driverId); if (driver?.companyId) fail('Välj en egen JEROC-förare.', 422);
    const issues = personnelPlanIssues(state.personnel, state.transport, order.id, plan); if (issues.length) fail(issues.join(' '), 422);
    try { state.transport = applyTransportChange(state.transport, { type: order.status === 'unbooked' ? 'book' : 'reschedule', id: order.id, plan }, actor); } catch (error) { fail(error.message, 422); }
    const booked = state.transport.orders.find(value => value.id === order.id); detail.assignedDriverId = plan.driverId; detail.assignedVehicleId = plan.vehicleId; detail.confirmedWindow = { date: plan.date, from: `${Math.floor(plan.startMinute / 60)}`.padStart(2, '0') + ':' + `${plan.startMinute % 60}`.padStart(2, '0') }; invalidateDocument(detail);
    orderAudit(state, booked, detail, actor, 'work_order.booked', 'Egen förare och fordon bokade i den gemensamma planeraren.', transactionAudit); refreshStaffingTasks(state);
  } else if (command.action === 'order.cancel') {
    const reason = parse(z.string().trim().min(3).max(2000), command.reason); order.status = 'cancelled'; detail.carrierRequest.status = 'declined'; invalidateDocument(detail); delete state.transport.preliminary[order.id];
    for (const delivery of state.logistics.deliveryOutbox.filter(delivery => delivery.orderId === order.id && delivery.status === 'prepared')) delivery.status = 'cancelled';
    orderAudit(state, order, detail, actor, 'work_order.cancelled', `Arbetsordern avbruten: ${reason}`, transactionAudit);
  } else if (command.action === 'order.send') {
    if (detail.operator !== 'external' || !detail.carrierId) fail('Välj extern transportör först.', 422);
    if (detail.carrierRequest.status === 'sent') return { orderId: order.id };
    for (const delivery of state.logistics.deliveryOutbox.filter(delivery => delivery.orderId === order.id && delivery.status === 'prepared')) delivery.status = 'superseded';
    detail.carrierRequest = { ...detail.carrierRequest, status: 'sent', version: detail.carrierRequest.version + 1, sentAt: stamp(), proposedWindow: undefined };
    const carrier = state.personnel.companies.find(carrier => carrier.id === detail.carrierId);
    state.logistics.deliveryOutbox.push({ id: `carrier-request:${order.id}:${detail.carrierRequest.version}`, orderId: order.id, requestVersion: detail.carrierRequest.version, carrierId: detail.carrierId,
      channel: 'email', status: 'prepared', deliveryEnabled: false, recipient: carrier?.email ?? '', createdAt: stamp(), subject: `Transportförfrågan ${order.id} från JEROC`,
      text: `${order.id}: ${detail.from.name} → ${detail.to.name}. Önskad tid: ${detail.requestedWindow?.date ?? 'Så snart som möjligt'}. Öppna uppdraget i åkeriportalen och acceptera eller föreslå tid.`, portalPath: `/akeri?order=${encodeURIComponent(order.id)}` });
    orderAudit(state, order, detail, actor, 'carrier.request_prepared', 'Transportförfrågan finns i åkeriportalen. Inget mejl skickas i demo.', transactionAudit);
  } else if (command.action === 'order.confirmTime') {
    if (detail.operator !== 'external') fail('Egen körning får ny tid genom planering och bokning.', 422);
    detail.confirmedWindow = parse(windowSchema, command.window);
    if (detail.operator === 'external' && detail.carrierRequest.status === 'time_proposed') detail.carrierRequest.status = 'accepted';
    orderAudit(state, order, detail, actor, 'work_order.time_confirmed', 'Kontoret har bekräftat den överenskomna tiden.', transactionAudit);
  } else if (command.action === 'order.clearance') {
    if (typeof command.cleared !== 'boolean') fail('Ange om uppdraget är frigjort.', 422);
    detail.execution.officeCleared = command.cleared;
    orderAudit(state, order, detail, actor, 'transport.office_clearance', command.cleared ? 'Kontoret har frigjort uppdraget för avfärd.' : 'Kontorets frigörande har återkallats.', transactionAudit);
  } else if (command.action === 'order.load') { loadRows(detail, command.rows); orderAudit(state, order, detail, actor, 'transport.loaded', 'Verkliga lastvikter registrerade.', transactionAudit); }
  else if (command.action === 'order.document') { prepareDocument(detail); orderAudit(state, order, detail, actor, 'transport.document_prepared', 'Aktuell dokumentversion förberedd för demogodkännanden.', transactionAudit); }
  else if (command.action === 'order.sign') {
    const role = parse(z.enum(['sender', 'carrier']), command.role); signDocument(detail, role, { id: principal.user.id, name: principal.user.name }, command.documentVersion, 'demo_staff');
    orderAudit(state, order, detail, actor, 'transport.document_signed_demo', `${role === 'sender' ? 'Lämnaren' : 'Transportören'} bekräftad av personal i demo.`, transactionAudit);
  } else fail('Åtgärden stöds inte.', 422);
  return { orderId: order.id };
}
function customerState(state, customer) {
  const vessels = state.logistics.vessels.filter(vessel => vessel.customerId === customer.id && vessel.active);
  const orders = state.transport.orders.filter(order => order.customerId === customer.id && state.logistics.details[order.id]).map(order => {
    const value = publicOrder(state, order, true); delete value.detail.documentHistory; return value;
  });
  return { demo: true, customer: { id: customer.id, name: customer.name }, vessels: copy(vessels), agreements: copy(state.logistics.agreements.filter(agreement => agreement.customerId === customer.id && agreement.active)), requests: copy(state.logistics.requests.filter(request => request.customerId === customer.id)), orders };
}
function customerRequest(state, customer, command, transactionAudit) {
  const input = parse(requestSchema, command), actor = { id: `customer:${customer.id}`, name: customer.name };
  return idempotent(state, actor.id, 'customer.request', input.idempotencyKey, input, () => {
    const vessel = state.logistics.vessels.find(vessel => vessel.id === input.vesselId && vessel.customerId === customer.id && vessel.active); if (!vessel) fail('Kärlet är inte tilldelat ert företag.', 403);
    const agreement = state.logistics.agreements.find(agreement => agreement.id === vessel.agreementId && agreement.customerId === customer.id && agreement.active);
    if (input.type === 'pickup' && agreement?.allowedActions && !agreement.allowedActions.includes('pickup')) fail('Hämtning ingår inte i avtalet för kärlet. Kontakta JEROC.', 422);
    if (input.type === 'exchange' && (!agreement || agreement.kind === 'rental' || !(agreement.allowedActions ?? [agreement.action]).includes('exchange'))) fail('Byte ingår inte i avtalet för kärlet.', 422);
    let existing = input.existingOrderId ? state.transport.orders.find(order => order.id === input.existingOrderId) : state.transport.orders.find(order => openOrder(order) && order.customerId === customer.id && state.logistics.details[order.id]?.vesselId === vessel.id);
    if (existing && (existing.customerId !== customer.id || state.logistics.details[existing.id]?.vesselId !== vessel.id)) fail('Arbetsordern hör inte till ert kärl.', 403);
    if (existing && !openOrder(existing)) fail('Arbetsordern är redan avslutad.');
    if (input.type === 'earlier' && !existing) fail('Det finns inget planerat uppdrag att tidigarelägga.', 422);
    const duplicate = state.logistics.requests.find(request => request.customerId === customer.id && request.vesselId === vessel.id && request.status === 'pending');
    if (duplicate) return { requestId: duplicate.id, orderId: duplicate.orderId };
    if (existing && input.type !== 'earlier' && existing.status !== 'unbooked') fail('Kärlet har redan ett bokat uppdrag. Begär tidigareläggning på det befintliga uppdraget.');
    if (!existing) {
      const site = state.logistics.sites.find(site => site.id === vessel.siteId && site.active !== false); if (!site) fail('Kärlets anläggning är inte aktiv.', 422);
      const article = vessel.materialArticleId && articleOf(state, vessel.materialArticleId);
      const result = createOrder(state, { siteId: vessel.siteId, action: input.type === 'exchange' ? 'exchange' : 'pickup', customerId: customer.id, from: vessel.place ?? customerPlace(customer), to: sitePlace(site), operator: 'own', vesselId: vessel.id, agreementId: agreement?.id,
        vesselType: vessel.type, vesselSize: vessel.size, materialRows: article ? [{ articleId: article.id, plannedKg: 0, name: article.name, hazardous: article.hazardous, wasteCode: article.wasteCode }] : [], requestedWindow: input.requestedDate ? { date: input.requestedDate } : undefined, notes: input.comment, durationMinutes: 60, handling: article?.handlingInstructions ?? '' }, actor, 'customer', transactionAudit);
      existing = state.transport.orders.find(order => order.id === result.orderId);
    }
    const request = { id: uid('customer-request'), customerId: customer.id, vesselId: vessel.id, orderId: existing.id, type: input.type, requestedDate: input.requestedDate, comment: input.comment, status: 'pending', createdAt: stamp(), version: 1 };
    state.logistics.requests.push(request);
    audit(state, actor, 'customer_request.created', { requestId: request.id, orderId: existing.id, vesselId: vessel.id }, transactionAudit);
    return { requestId: request.id, orderId: existing.id };
  });
}
function carrierState(state, company) {
  const orders = state.transport.orders.filter(order => state.logistics.details[order.id]?.operator === 'external' && state.logistics.details[order.id]?.carrierId === company.id && state.logistics.details[order.id]?.carrierRequest.status !== 'draft').map(order => publicOrder(state, order, true));
  const people = state.personnel.people.filter(person => person.kind === 'external' && person.active && person.companyId === company.id && person.canDrive && person.driverId);
  const drivers = state.transport.drivers.filter(driver => people.some(person => person.driverId === driver.id && driver.personId === person.id && driver.companyId === company.id)).map(driver => ({ id: driver.id, personId: driver.personId, name: driver.name }));
  const vehicleIds = new Set(state.transport.drivers.filter(driver => driver.companyId === company.id).map(driver => driver.vehicleId));
  return { demo: true, company: copy(company), orders, drivers, vehicles: copy(state.transport.vehicles.filter(vehicle => vehicleIds.has(vehicle.id))) };
}
function carrierCommand(state, company, command, transactionAudit) {
  const { order, detail } = orderAndDetail(state, command.orderId); if (detail.operator !== 'external' || detail.carrierId !== company.id || detail.carrierRequest.status === 'draft') fail('Uppdraget är inte tilldelat ert åkeri.', 403);
  expected(detail, command.expectedVersion); assertUnfinished(order, detail); const actor = { id: `carrier:${company.id}`, name: company.name };
  if (command.action === 'request.respond') {
    if (!['sent', 'time_proposed'].includes(detail.carrierRequest.status)) fail('Förfrågan är redan besvarad.');
    const response = parse(z.enum(['accept', 'decline', 'propose']), command.response); const window = command.window ? parse(windowSchema, command.window) : undefined;
    if (response === 'propose' && !window) fail('Ange ett tidsförslag.', 422);
    detail.carrierRequest = { ...detail.carrierRequest, status: response === 'accept' ? 'accepted' : response === 'decline' ? 'declined' : 'time_proposed', respondedAt: stamp(), comment: parse(txt, command.comment ?? ''), proposedWindow: window };
    if (response === 'accept' && window) detail.confirmedWindow = window;
    orderAudit(state, order, detail, actor, `carrier.request_${response}`, response === 'accept' ? 'Åkeriet har accepterat transportuppdraget.' : response === 'decline' ? 'Åkeriet har tackat nej till uppdraget.' : 'Åkeriet har föreslagit en annan tid. Överenskommen tid är ännu oförändrad.', transactionAudit);
  } else if (command.action === 'order.assign') {
    if (detail.carrierRequest.status !== 'accepted') fail('Acceptera uppdraget innan ni bemannar det.', 422);
    const driver = state.transport.drivers.find(driver => driver.id === command.driverId), person = state.personnel.people.find(person => person.driverId === driver?.id), vehicle = state.transport.vehicles.find(vehicle => vehicle.id === command.vehicleId);
    if (!driver || driver.companyId !== company.id || person?.companyId !== company.id || person?.active !== true || !person.canDrive || driver.personId !== person.id) fail('Välj en aktiv chaufför från ert åkeri.', 403);
    if (!vehicle || !state.transport.drivers.some(driver => driver.companyId === company.id && driver.vehicleId === vehicle.id) || !vehicle.types.includes(order.vesselType)) fail('Välj ett lämpligt fordon från ert åkeri.', 403);
    detail.assignedDriverId = driver.id; detail.assignedVehicleId = vehicle.id; invalidateDocument(detail);
    orderAudit(state, order, detail, actor, 'carrier.driver_assigned', 'Åkeriet har utsett chaufför och fordon. Tid och kundönskemål är bevarade.', transactionAudit);
  } else if (command.action === 'order.sign') {
    signDocument(detail, 'carrier', actor, command.documentVersion, 'demo_account'); orderAudit(state, order, detail, actor, 'transport.document_signed_demo', 'Åkeriets ansvariga har godkänt transportdokumentet i demo.', transactionAudit);
  } else fail('Åtgärden stöds inte.', 422);
  return { orderId: order.id };
}
function passwordValid(password, stored) { if (!stored) return false; const actual = scryptSync(password, stored.salt, 64), expected = Buffer.from(stored.digest, 'hex'); return actual.length === expected.length && timingSafeEqual(actual, expected); }
function cookieValue(req, name) { return req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1); }
function portalSubject(state, kind, account) { return kind === 'customer' ? state.office.customers.find(customer => customer.id === account?.subjectId) : state.personnel.companies.find(company => company.id === account?.subjectId); }
function portalSession(state, req, kind) {
  const token = cookieValue(req, `jeroc_${kind}`), session = state.logisticsAuth.sessions.find(session => session.kind === kind && session.tokenHash === hash(token ?? '') && Date.parse(session.expiresAt) > Date.now());
  const account = state.logisticsAuth.accounts.find(account => account.id === session?.accountId && account.kind === kind), subject = portalSubject(state, kind, account);
  if (!session || !account?.active || !subject || account.subjectId !== session.subjectId) fail('Logga in igen för att fortsätta.', 401);
  return { session, account, subject };
}
export function createLogisticsApi({ getRepository, readBody, json, siteProvider = async () => [], environmentProvider = async () => ({ classifications: [], inventory: [] }) }) {
  return async (req, res, url) => {
    const office = url.pathname === '/api/logistics/office'; const match = url.pathname.match(/^\/api\/(customer|carrier)\/(session|login|logout|state|assets|orders|requests|actions)$/);
    if (!office && !match) return false;
    try {
      if (!['GET', 'POST'].includes(req.method)) fail('Metoden stöds inte.', 405);
      if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail('Anropet måste komma från samma webbplats.', 403);
      const payload = req.method === 'POST' ? await readBody(req) : undefined;
      // Resolve other stores before acquiring the business transaction lock.
      const [sites, environment] = await Promise.all([siteProvider(), environmentProvider()]);
      const result = await (await getRepository()).transact((state, _, transactionAudit) => {
        ensureLogistics(state, { sites: Array.isArray(sites) ? sites : sites.sites, ...environment });
        if (office) {
          const actor = req.headers['x-demo-actor'], user = req.headers['x-demo-user'] ?? actor;
          if (typeof actor !== 'string' || typeof user !== 'string') fail('Välj ett giltigt demokonto.', 401);
          const principal = createPricingStore({ initialState: state.pricing }).principal(actor, user);
          if (!rights.some(right => can(principal, right))) fail('Du saknar behörighet att öppna arbetsordrar, lager eller kärl.', 403);
          const commandResult = req.method === 'POST' ? officeCommand(state, principal, payload, transactionAudit) : undefined;
          return { value: { ...officeState(state, principal), ...(commandResult ? { result: commandResult } : {}) } };
        }
        const [, kind, path] = match, auth = state.logisticsAuth;
        auth.sessions = auth.sessions.filter(session => Date.parse(session.expiresAt) > Date.now());
        auth.attempts = auth.attempts.filter(attempt => Date.parse(attempt.at) > Date.now() - 15 * 60 * 1000);
        if (path === 'login') {
          if (req.method !== 'POST') fail('Metoden stöds inte.', 405);
          const input = parse(z.object({ username: z.string().trim().toLowerCase().min(1).max(80), password: z.string().min(1).max(200) }).strict(), payload), address = hash(req.socket.remoteAddress ?? 'unknown');
          if (auth.attempts.filter(attempt => attempt.kind === kind && attempt.address === address).length >= 12) fail('För många inloggningsförsök. Vänta 15 minuter.', 429);
          const account = auth.accounts.find(account => account.kind === kind && account.username === input.username), subject = portalSubject(state, kind, account);
          if (!account?.active || !subject || !passwordValid(input.password, account.password)) { auth.attempts.push({ kind, address, at: stamp() }); return { error: 'Fel inloggning eller inaktivt konto.', status: 401 }; }
          const token = randomBytes(32).toString('base64url'); auth.sessions.push({ kind, tokenHash: hash(token), accountId: account.id, subjectId: subject.id, expiresAt: new Date(Date.now() + 8 * 3600000).toISOString() }); account.lastLoginAt = stamp();
          audit(state, { id: `${kind}:${account.id}`, name: account.username }, 'portal.login', { kind, subjectId: subject.id }, transactionAudit);
          return { token, kind, value: kind === 'customer' ? { demo: true, customer: { id: subject.id, name: subject.name } } : { demo: true, company: copy(subject) } };
        }
        const { session, account, subject } = portalSession(state, req, kind);
        if (path === 'logout' && req.method === 'POST') { auth.sessions = auth.sessions.filter(value => value !== session); return { token: '', kind, value: { ok: true } }; }
        if (path === 'session' && req.method === 'GET') return { value: kind === 'customer' ? { demo: true, customer: { id: subject.id, name: subject.name } } : { demo: true, company: copy(subject) } };
        if (req.method === 'GET' && ['state', 'assets', 'orders'].includes(path)) return { value: kind === 'customer' ? customerState(state, subject) : carrierState(state, subject) };
        if (kind === 'customer' && path === 'requests' && req.method === 'POST') {
          const result = customerRequest(state, subject, payload, transactionAudit); return { value: { ...customerState(state, subject), request: copy(state.logistics.requests.find(request => request.id === result.requestId)), result } };
        }
        if (kind === 'carrier' && path === 'actions' && req.method === 'POST') { const result = carrierCommand(state, subject, payload, transactionAudit); return { value: { ...carrierState(state, subject), result } }; }
        fail('Portalsidan finns inte.', 404);
      });
      if (result.error) json(res, result.status, { error: result.error });
      else {
        if (result.token !== undefined) res.setHeader('Set-Cookie', `jeroc_${result.kind}=${result.token}; HttpOnly; Path=/api/${result.kind}; SameSite=Strict; Max-Age=${result.token ? 8 * 3600 : 0}${req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
        res.setHeader('Cache-Control', 'private, no-store'); json(res, 200, result.value);
      }
    } catch (error) { json(res, error instanceof PricingError ? error.status : 503, { error: error instanceof PricingError ? error.message : 'Arbetsordrar och lager kunde inte nås.' }); }
    return true;
  };
}
