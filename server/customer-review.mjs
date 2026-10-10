import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PricingError, createPricingStore } from './pricing.mjs';
import { officeSchema, validPaymentDetails, settlementPreview } from '../dist-server/domain-models.mjs';

const fail = (message, status = 409) => { throw new PricingError(message, status); };
const copy = structuredClone;
const can = (p, right) => p.user.level !== 'Medarbetare' || p.user.permissions.includes(right);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
// Compare the editable business fields, never browser-provided signing proof,
// audit history, redacted money or derived UI-only fields.
const expectedVersion = card => canonical(Object.fromEntries([
  'id', 'sourceId', 'kind', 'customerId', 'origin', 'reference', 'date', 'yard', 'siteId',
  'status', 'rows', 'paymentDetails', 'payment', 'pricingSnapshotId',
].map(key => [key, card[key]])));

/** A server command called inside the application's transaction. The terminal
 * repository joins its PostgreSQL client: prices, reservation and review have
 * one commit and all roll back when the terminal is busy or validation fails. */
export async function prepareCustomerReview({ state, input, principal, send, runWithPricing, reflectApprovals, officeView, revision, audit }) {
  if (!input || !Number.isSafeInteger(input.cardId) || input.cardId <= 0 ||
    !['terminalId', 'siteId', 'idempotencyKey'].every(key => typeof input[key] === 'string' && input[key].trim() && input[key].length <= 200))
    fail('Ange kort, terminal, anläggning och utskicks-ID.', 422);
  const expected = officeSchema.shape.cards.element.parse(input.expectedCard);
  if (expected.id !== input.cardId) fail('Kortets identitet stämmer inte.', 422);
  if (!['view', 'prepare', 'customerApprovalRead'].every(right => can(principal, right))) fail('Du saknar behörighet att skicka för kundgodkännande.', 403);
  const card = state.office.cards.find(card => card.id === input.cardId);
  if (!card) fail('Invägningskortet finns inte.', 404);
  const siteId = card.siteId ?? (card.yard === 'Rimbo' ? 'rimbo' : 'norrtalje');
  if (siteId !== input.siteId || principal.user.siteIds && !principal.user.siteIds.includes(siteId)) fail('Du saknar åtkomst till kortets anläggning.', 403);
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ card: expectedVersion(expected), terminalId: input.terminalId, siteId: input.siteId }))).digest('hex');
  const registry = state.customerReviewCommands ??= [];
  const previous = registry.find(command => command.key === input.idempotencyKey && command.actualUserId === principal.actor.id && command.effectiveUserId === principal.user.id);
  if (previous && previous.fingerprint !== fingerprint) fail('Utskickets ID används för ett annat underlag.');
  const pricing = createPricingStore({ initialState: state.pricing });
  let payload = previous?.payload;
  if (!previous) {
    const readable = officeView(state, principal).cards.find(value => value.id === card.id);
    if (!isDeepStrictEqual(expectedVersion(expected), expectedVersion(readable))) fail('Kortet ändrades i en annan session. Läs in kortet innan du skickar.');
    if (!['new', 'complement'].includes(card.status) || card.kind === 'correction') fail('Kortet måste vara öppet för komplettering innan en ny kundgranskning kan skickas.');
    const customer = state.office.customers.find(value => value.id === card.customerId);
    const payment = card.paymentDetails ?? customer?.paymentProfile;
    if (!customer || !card.origin?.trim() || !validPaymentDetails(payment)) fail('Komplettera kund, ursprungsadress och betalningsuppgifter före kundgodkännande.', 422);
    const older = pricing.snapshots(principal, String(card.id)).at(-1);
    const snapshot = pricing.snapshot({ cardId: String(card.id), customerId: card.customerId, deliveredAt: card.date,
      ...(older ? { supersedesSnapshotId: older.id } : {}),
      rows: card.rows.map(row => ({ articleId: row.articleId, weight: row.weight,
        ...(can(principal, 'changePrice') && !row.pricePending && (row.manualOverride || !row.source) ? {
          override: { price: row.price, tier: row.tier, reason: row.manualOverride ? 'Spårbar prisändring på viktkort' : 'Befintligt prissatt demounderlag' },
        } : {}),
      })),
    }, principal);
    if (snapshot.total == null || snapshot.rows.some(row => row.price == null)) fail('Kundvisningen kräver fullständiga priser och prisbehörighet.', 403);
    const rows = snapshot.rows.map((row, index) => ({ ...card.rows[index], price: row.price, pricePending: false,
      tier: row.tier === 'Special' ? 'Eget' : row.tier, source: row.source,
      volumeBefore: row.volumeBefore ?? undefined, volumeWithDelivery: row.volumeWithDelivery ?? undefined }));
    const frozen = { ...card, rows, siteId, pricingSnapshotId: snapshot.id, pricedAt: card.date,
      pricingTotal: snapshot.total, financialPending: false, pricingRowsPending: false,
      preparedBy: principal.user.id, customerSnapshot: copy(customer), paymentDetails: copy(payment) };
    const settlement = settlementPreview({ ...state.office, cards: state.office.cards.map(value => value.id === card.id ? { ...frozen, status: 'ready' } : value) }, card.id);
    payload = { card: frozen, customer: copy(customer), terminalId: input.terminalId, siteId,
      rows: rows.map(row => ({ articleId: row.articleId, name: row.articleName ?? row.articleId, weight: row.weight,
        price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 })),
      offset: settlement.offset, correctionIds: settlement.negativeCorrectionIds,
      idempotencyKey: `command-${createHash('sha256').update(JSON.stringify([principal.actor.id, principal.user.id, input.idempotencyKey])).digest('hex')}` };
  }
  // jsonb reorders object keys. Use the same canonical request on its first
  // send and all retries, including after a process restart.
  payload = canonical(payload);
  const approval = await runWithPricing(pricing, () => send(payload, { actorId: principal.actor.id, userId: principal.user.id }));
  state.pricing = pricing.exportState();
  if (!previous) {
    state.office.cards = state.office.cards.map(value => value.id === card.id ? copy(payload.card) : value);
    registry.push({ key: input.idempotencyKey, actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
      fingerprint, approvalId: approval.id, payload: copy(payload), at: new Date().toISOString() });
    audit.push({ action: 'customer-review.prepared', cardId: card.id, approvalId: approval.id,
      actualUserId: principal.actor.id, effectiveUserId: principal.user.id });
  }
  reflectApprovals(state.office, [approval]);
  return { approval, cardProjection: officeView(state, principal).cards.find(value => value.id === card.id), revision: revision + Number(!previous) };
}
