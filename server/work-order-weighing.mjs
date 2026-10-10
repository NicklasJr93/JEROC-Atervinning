import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { PricingError } from './pricing.mjs';
import { officeSchema } from '../dist-server/domain-models.mjs';

const copy = value => structuredClone(value);
const fail = (message, status = 409) => { throw new PricingError(message, status); };
const identifier = z.string().trim().min(1).max(200);
const weight = z.number().finite().min(0).max(1e9).refine(value => Math.abs(value * 1000 - Math.round(value * 1000)) < .00001, 'Ange högst tre decimaler.');
const inputSchema = z.object({ customerId: identifier.optional(), origin: z.string().trim().max(2000), reference: z.string().trim().max(2000),
  rows: z.array(z.object({ articleId: identifier, weight: weight.optional() }).strict()).min(1).max(100) }).strict();

export function ensureWorkOrderWeighing(state) {
  state.workOrderWeighing ??= { version: 1, drafts: {} };
  state.workOrderWeighing.drafts ??= {};
  return state.workOrderWeighing;
}

/** The shared register reserves an INV number only for a real weighing here.
 * Existing ordinary mobile drafts keep their current allocation behaviour. */
export function allocateWeighingNumber(state) {
  const existing = [...(state.office?.cards ?? []).map(card => card.id), ...(state.mobile?.drafts ?? []).map(draft => draft.number),
    ...Object.values(state.workOrderWeighing?.drafts ?? {}).map(draft => draft.cardId)].filter(Number.isFinite);
  const number = Math.max(3000, Number(state.metadata.nextCard) || 0, ...existing.map(value => value + 1));
  state.metadata.nextCard = number + 1;
  return number;
}

const originOf = detail => [detail.from.address, detail.from.postalCode, detail.from.city].filter(Boolean).join(', ');
function material(row, articles, actual) {
  const article = articles.find(article => article.id === row.articleId);
  if (!article) fail('Välj en aktiv artikel ur artikelregistret.', 422);
  return { articleId: article.id, name: article.name, plannedKg: row.plannedKg ?? 0, hazardous: article.hazardous, wasteCode: article.wasteCode,
    ...(article.classificationVersion && { classificationVersion: article.classificationVersion }), ...(actual > 0 && { weight: actual }) };
}
function environmentalPreparation(rows) {
  const hazardous = rows.filter(row => row.hazardous).map(({ articleId, name, wasteCode, classificationVersion }) => ({ articleId, name, wasteCode, ...(classificationVersion && { classificationVersion }) }));
  return hazardous.length ? { status: 'prepared', rows: hazardous } : undefined;
}

/** Preparing a transport creates neither a physical receipt nor an office card.
 * Classification is a provisional snapshot; real receiving validates it later. */
export function syncWorkOrderWeighing(state, order, detail, articles) {
  const domain = ensureWorkOrderWeighing(state), existing = domain.drafts[order.id];
  const eligible = ['pickup', 'exchange'].includes(order.action) && detail.materialRows.length > 0 && order.status !== 'cancelled';
  if (!eligible) {
    if (existing?.status === 'prepared') delete domain.drafts[order.id];
    return domain.drafts[order.id];
  }
  if (existing && existing.status !== 'prepared') return existing;
  if (!existing && (order.status === 'done' || detail.execution.stage !== 'pending')) return;
  const rows = detail.materialRows.map(row => material(row, articles.some(article => article.id === row.articleId) ? articles
    : [...articles, { id: row.articleId, name: row.name, hazardous: row.hazardous, wasteCode: row.wasteCode }]));
  const values = { siteId: detail.siteId, customerId: order.customerId, origin: originOf(detail), reference: order.id, rows,
    environmentPreparation: environmentalPreparation(rows) };
  if (existing && isDeepStrictEqual(Object.fromEntries(Object.keys(values).map(key => [key, existing[key]])), values)) return existing;
  const at = new Date().toISOString();
  const draft = { ...(existing ?? { id: randomUUID(), workOrderId: order.id, status: 'prepared', version: 0, createdAt: at }), ...values,
    version: (existing?.version ?? 0) + 1, updatedAt: at };
  domain.drafts[order.id] = draft;
  return draft;
}

export const workOrderWeighing = (state, orderId) => state.workOrderWeighing?.drafts?.[orderId];
export function startWorkOrderWeighing(state, orderId) {
  const draft = workOrderWeighing(state, orderId);
  if (!draft) fail('Lägg till en materialrad och spara arbetsordern först.', 422);
  if (draft.status === 'completed') fail('Vägningen är färdigställd. Öppna invägningskortet.', 409);
  if (draft.status === 'prepared') { draft.status = 'started'; draft.startedAt = new Date().toISOString(); draft.updatedAt = draft.startedAt; draft.version++; }
  return draft;
}

export function saveWorkOrderWeighing(state, orderId, input, articles) {
  const result = inputSchema.safeParse(input);
  if (!result.success) fail('Kontrollera vägningen: ' + result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' '), 422);
  const value = result.data;
  if (new Set(value.rows.map(row => row.articleId)).size !== value.rows.length) fail('Samla samma artikel på en materialrad.', 422);
  if (value.customerId && !state.office.customers.some(customer => customer.id === value.customerId)) fail('Kunden finns inte.', 422);
  const draft = startWorkOrderWeighing(state, orderId);
  const rows = value.rows.map(row => material({ ...row, plannedKg: draft.rows.find(before => before.articleId === row.articleId)?.plannedKg ?? 0 }, articles, row.weight));
  Object.assign(draft, { rows, customerId: value.customerId, origin: value.origin, reference: value.reference,
    environmentPreparation: environmentalPreparation(rows), version: draft.version + 1, updatedAt: new Date().toISOString() });
  return draft;
}

export function completeWorkOrderWeighing(state, order, principal, articles) {
  const draft = workOrderWeighing(state, order.id);
  if (!draft) fail('Lägg till en materialrad och spara arbetsordern först.', 422);
  if (draft.status === 'completed') return { orderId: order.id, cardId: draft.cardId };
  if (!draft.origin.trim()) fail('Ange ursprungsadress före färdigställande.', 422);
  if (!draft.rows.length || draft.rows.some(row => !Number.isFinite(row.weight) || row.weight <= 0)) fail('Ange verklig positiv vikt för varje artikel före färdigställande.', 422);
  draft.rows.forEach(row => material(row, articles, row.weight));
  if (draft.customerId && !state.office.customers.some(customer => customer.id === draft.customerId)) fail('Kunden finns inte längre.', 422);
  const existing = state.office.cards.find(card => card.sourceId === draft.id || card.workOrderId === order.id);
  if (existing) fail('Arbetsordern har redan ett annat invägningskort. Kontrollera kopplingen.', 409);
  const at = new Date().toISOString(), site = state.logistics.sites.find(site => site.id === draft.siteId);
  const card = officeSchema.shape.cards.element.parse({
    id: allocateWeighingNumber(state), sourceId: draft.id, workOrderId: order.id, siteId: draft.siteId, status: 'new', yard: site?.name ?? 'Norrtälje', weigher: principal.user.name, date: at,
    customerId: draft.customerId, customerSnapshot: state.office.customers.find(customer => customer.id === draft.customerId), reference: draft.reference, origin: draft.origin,
    rows: draft.rows.map(row => ({ articleId: row.articleId, articleName: row.name, weight: row.weight, tier: 'C', price: 0, pricePending: true })),
    payment: '', idVerified: false, financialPending: true,
    audit: [{ at, actor: principal.user.name, actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
      text: `Faktisk vägning färdigställd från arbetsorder ${order.id}. Kundgodkännande, miljömottagning och attest återstår.` }],
  });
  state.office.cards.push(card);
  Object.assign(draft, { status: 'completed', completedAt: at, updatedAt: at, version: draft.version + 1, cardId: card.id });
  return { orderId: order.id, cardId: card.id };
}
