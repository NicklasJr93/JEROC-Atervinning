import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PricingError, createPricingStore, money } from './pricing.mjs';
import { officeSchema, validPaymentDetails, settlementPreview, normalizeCustomerDetails, validateCustomerDetails,
  normalizePaymentDetails, normalizeOriginAddress, normalizeAddress } from '../dist-server/domain-models.mjs';
import { freezePurchaseAccounting } from './visma-accounting.mjs';
import { customerApprovalChannel } from './customer-approval-channel.mjs';

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
export async function prepareCustomerReview({ state, input, principal, send, runWithPricing, reflectApprovals, officeView, revision, audit, accountingSettings, accountingSettingsProvider }) {
  if (!input || !Number.isSafeInteger(input.cardId) || input.cardId <= 0 ||
    !['siteId', 'idempotencyKey'].every(key => typeof input[key] === 'string' && input[key].trim() && input[key].length <= 200))
    fail('Ange kort, anläggning och sätt att skicka kundgodkännandet.', 422);
  let delivery;
  try { delivery = customerApprovalChannel(input); } catch (error) { fail(error.message, 422); }
  const expected = officeSchema.shape.cards.element.parse(input.expectedCard);
  if (expected.id !== input.cardId) fail('Kortets identitet stämmer inte.', 422);
  if (!['view', 'prepare', 'customerApprovalRead'].every(right => can(principal, right))) fail('Du saknar behörighet att skicka för kundgodkännande.', 403);
  if (delivery.channel && delivery.channel !== 'terminal' && !['view', 'prepare', 'customerApprovalRead'].every(right => can({ user: principal.actor }, right)))
    fail('Både faktiskt och effektivt konto behöver behörighet att skicka kundgodkännande.', 403);
  const card = state.office.cards.find(card => card.id === input.cardId);
  if (!card) fail('Invägningskortet finns inte.', 404);
  const siteId = card.siteId ?? (card.yard === 'Rimbo' ? 'rimbo' : 'norrtalje');
  if (siteId !== input.siteId || principal.user.siteIds && !principal.user.siteIds.includes(siteId)
    || delivery.channel && delivery.channel !== 'terminal' && principal.actor.siteIds && !principal.actor.siteIds.includes(siteId)) fail('Du saknar åtkomst till kortets anläggning.', 403);
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ card: expectedVersion(expected), ...delivery, siteId: input.siteId }))).digest('hex');
  const registry = state.customerReviewCommands ??= [];
  const previous = registry.find(command => command.key === input.idempotencyKey && command.actualUserId === principal.actor.id && command.effectiveUserId === principal.user.id);
  if (previous && previous.fingerprint !== fingerprint) fail('Utskickets ID används för ett annat underlag.');
  const pricing = createPricingStore({ initialState: state.pricing });
  let payload = previous?.payload;
  if (!previous) {
    const readable = officeView(state, principal).cards.find(value => value.id === card.id);
    if (!isDeepStrictEqual(expectedVersion(expected), expectedVersion(readable))) fail('Kortet ändrades i en annan session. Läs in kortet innan du skickar.');
    if (!['new', 'complement'].includes(card.status) || card.kind === 'correction') fail('Kortet måste vara öppet för komplettering innan en ny kundgranskning kan skickas.');
    const storedCustomer = state.office.customers.find(value => value.id === card.customerId);
    const customer = storedCustomer && normalizeCustomerDetails(storedCustomer);
    const storedPayment = card.paymentDetails ?? customer?.paymentProfile;
    const payment = storedPayment && normalizePaymentDetails(storedPayment);
    if (!customer || !card.origin?.trim() || !validPaymentDetails(payment)) fail('Komplettera kund, ursprungsadress och betalningsuppgifter före kundgodkännande.', 422);
    const customerError = validateCustomerDetails(customer);
    if (customerError) fail(customerError, 422);
    if (accountingSettingsProvider) accountingSettings = await accountingSettingsProvider(customer);
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
    const frozen = { ...card, rows, siteId, origin: normalizeOriginAddress(card.origin), originDetails: normalizeAddress(card.origin), pricingSnapshotId: snapshot.id, pricedAt: card.date,
      pricingTotal: snapshot.total, financialPending: false, pricingRowsPending: false,
      preparedBy: principal.user.id, customerSnapshot: copy(customer), paymentDetails: copy(payment) };
    // Rebuild from authoritative prices, customer and article metadata. Browser
    // accounting fields and a cancelled version are never a new economic proof.
    delete frozen.accounting;
    const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(card.date));
    const catalog = pricing.read(principal, businessDate).articles;
    const accountingRows = rows.map(row => ({ articleId: row.articleId, name: catalog.find(value => value.id === row.articleId)?.name ?? row.articleName ?? row.articleId,
      weight: row.weight, price: row.price, amount: money(row.weight * row.price),
      taxCategory: catalog.find(value => value.id === row.articleId)?.taxCategory ?? 'review' }));
    if (accountingSettings?.enabled) frozen.accounting = freezePurchaseAccounting({ settings: accountingSettings, customer, rows: accountingRows, siteId });
    const settlement = settlementPreview({ ...state.office, cards: state.office.cards.map(value => value.id === card.id ? { ...frozen, status: 'ready' } : value) }, card.id);
    if (frozen.accounting) frozen.accounting = freezePurchaseAccounting({ settings: accountingSettings, customer, rows: accountingRows, siteId, offset: settlement.offset });
    payload = { card: frozen, customer: copy(customer), ...delivery, siteId,
      rows: rows.map(row => ({ articleId: row.articleId, name: row.articleName ?? row.articleId, weight: row.weight,
        price: row.price, amount: money(row.weight * row.price) })),
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
