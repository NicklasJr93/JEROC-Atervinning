import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { EnvironmentError } from './environment-storage.mjs';
import { resolvePricingPrincipal } from './pricing.mjs';
import { latestAttestedVismaCards } from './visma-weightcard.mjs';
import { assertNoCrossManagedPayment } from './managed-payment-guard.mjs';
import { can, normalizePhoneNumber, normalizePersonalNumber, customerIdentifierError, normalizePaymentDetails } from '../dist-server/domain-models.mjs';

const DOMAIN = 'swishPayments', LEASE_MS = 45_000, POLL_MS = 3_000;
const copy = value => structuredClone(value);
const fail = (message, status = 422, code = 'swish_invalid') => { throw new EnvironmentError(message, status, code); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const equal = (a, b) => isDeepStrictEqual(a, b);
const text = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const uuid = z.string().uuid();
// Spiris CompanyIdentifier is opaque text; only resource IDs such as bank
// accounts are UUIDs. Preserve its exact value for the verified company pin.
const spirisCompanyId = z.string().refine(value => Boolean(value.trim()));
const paymentSchema = z.object({ method: z.enum(['swish', 'bank', 'cash', 'balance']), phone: z.string().max(100).optional(),
  recipient: z.string().max(200).optional(), personalNumber: z.string().max(30).optional(), bank: z.string().max(100).optional(),
  clearing: z.string().max(20).optional(), account: z.string().max(100).optional(), holder: z.string().max(200).optional(),
  bankType: z.enum(['account', 'bankgiro', 'plusgiro', 'iban']).optional(), bankgiro: z.string().max(30).optional(),
  plusgiro: z.string().max(30).optional(), iban: z.string().max(50).optional(), bic: z.string().max(20).optional(),
  bankCountry: z.string().max(10).optional(), beneficiaryAddress: z.string().max(500).optional(), ocr: z.string().max(100).optional() }).strict();
const sourceSchema = z.object({ approvalId: z.string().min(1).max(100), version: z.number().int().positive(), hash: z.string().min(1).max(128) }).strict();
const startSchema = z.object({ cardId: z.number().int().positive(), source: sourceSchema.optional(), paymentDetails: paymentSchema.optional(),
  reason: z.string().trim().max(1000).optional(), retryOf: uuid.optional() }).strict();
const sandboxSchema = z.object({ amount: z.union([z.number().finite(), z.string().max(30)]), paymentDetails: paymentSchema,
  message: z.string().max(50).optional(), idempotencyKey: uuid }).strict();
const settingsSchema = z.object({ enabled: z.boolean(), registerSpirisPayment: z.boolean().optional(), spirisBankAccountId: uuid.nullable().optional(),
  bookkeepingEnabled: z.boolean().optional(), spirisCompanyId: spirisCompanyId.nullable().optional() }).strict();
const initialSettings = () => ({ enabled: false, bookkeepingEnabled: false, registerSpirisPayment: false, revision: 0 });
const initial = organisationId => ({ version: 1, organisationId, settings: initialSettings(), jobs: {}, audit: [], workIds: [], nextWorkAt: null });
const blocking = job => !['rejected', 'failed', 'cancelled'].includes(job.status);
const terminal = job => ['simulated_paid', 'rejected', 'failed', 'blocked', 'cancelled'].includes(job.status);
const nextAt = (clock, delay = POLL_MS) => new Date(clock.getTime() + delay).toISOString();
const neverDispatched = job => !job.sentAt && !job.response && !job.verifiedAt && !job.providerResult
  && !job.providerPaymentReference && !job.events?.some(item => item.action === 'payment_sent');
const recoveryCandidate = job => job.kind === 'card' && job.status === 'blocked' && neverDispatched(job);

function safeError(error, fallbackCode = 'swish_preflight_failed', fallbackMessage = 'Utbetalningen behöver granskas innan den kan fortsätta.') {
  const supplied = error?.details ?? {}, details = {};
  if (supplied.provider === 'spiris') details.provider = 'spiris';
  if (typeof supplied.field === 'string' && supplied.field.length <= 100
    && /^(TotalAmount|Vat|VatHigh|VatMedium|VatLow|RemainingAmountInvoiceCurrency|RemainingAmount|Rows\[\d+\]\.(DebitAmount|DebetAmount|CreditAmount))$/.test(supplied.field))
    details.field = supplied.field;
  if (['null', 'array', 'number', 'string', 'undefined', 'boolean', 'object', 'bigint', 'function', 'symbol'].includes(supplied.valueType))
    details.valueType = supplied.valueType;
  return { code: text(error?.code, 100) || fallbackCode, message: text(error?.message, 300) || fallbackMessage,
    ...(Object.keys(details).length ? { details } : {}) };
}

/** Convert exact decimal kronor to integer öre without silently rounding input.
 * JS numbers originate from a signed server snapshot; strings support sandbox
 * input and provider readback. A third decimal is always rejected. */
export function swishMoneyToCents(value) {
  const decimal = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  const match = decimal.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!match) fail('Beloppet ska anges i kronor med högst två decimaler.', 422, 'swish_amount_invalid');
  const result = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result <= 0 || result > 15_000_000)
    fail('Swish-utbetalningen måste vara större än 0 och högst 150 000 kr.', 422, 'swish_amount_invalid');
  return result;
}
const amountString = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

function normalizeDetails(details = {}, customer = {}) {
  // Typed bank instructions use the shared ÄL 109 canonical recipient model.
  // Keep pre-109 bank snapshots byte-compatible: changing their normalization
  // would invalidate already reserved Swish jobs and immutable revision proofs.
  const normalized = details.method === 'bank' && details.bankType ? normalizePaymentDetails(details) : details;
  return Object.fromEntries(Object.entries({ ...normalized,
    ...(details.method === 'swish' ? { phone: normalizePhoneNumber(details.phone ?? ''), recipient: text(details.recipient || customer.name),
      personalNumber: normalizePersonalNumber(details.personalNumber ?? customer.number ?? '') } : {}),
  }).filter(([, value]) => value !== undefined));
}
function validateSwish(details) {
  if (details.method !== 'swish') fail('I denna etapp kan endast Swish testas. Bank, kontant och saldo skickas inte.', 409, 'swish_method_unsupported');
  if (!/^\+467[02369]\d{7}$/.test(details.phone ?? '') && details.phone !== '+46711111132')
    fail('Ange mottagarens svenska mobilnummer för Swish.', 422, 'swish_phone_invalid');
  if (!/^\d{12}$/.test(details.personalNumber ?? '')) fail('Swish Utbetalning behöver personnumret med 12 siffror, inklusive århundrade.', 422, 'swish_personal_number_invalid');
  const error = customerIdentifierError('Privatperson', details.personalNumber);
  if (error) fail(error, 422, 'swish_personal_number_invalid');
  if (!details.recipient?.trim()) fail('Ange mottagarens namn.', 422, 'swish_recipient_missing');
}
function editableDetails(details) {
  return Object.fromEntries(Object.entries(details).filter(([key]) => ['method', 'phone', 'recipient', 'personalNumber', 'bank', 'clearing', 'account', 'holder',
    'bankType', 'bankgiro', 'plusgiro', 'iban', 'bic', 'bankCountry', 'beneficiaryAddress', 'ocr'].includes(key)));
}
function safeProviderData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data == null ? null : String(data).slice(0, 200);
  // This trace belongs to authenticated payment staff. Never return transport
  // credentials, signatures, callback secrets or unbounded provider content.
  return Object.fromEntries(['payoutInstructionUUID', 'payerPaymentReference', 'paymentReference', 'payerAlias', 'payeeAlias', 'payeeSSN', 'amount', 'currency',
    'status', 'dateCreated', 'datePaid', 'errorCode', 'errorMessage', 'message'].filter(key => data[key] !== undefined)
    .map(key => [key, typeof data[key] === 'string' ? data[key].slice(0, 300) : data[key]]));
}
function publicJob(job) {
  if (!job) return null;
  return copy({ ...Object.fromEntries(['id', 'organisationId', 'kind', 'mode', 'simulation', 'source', 'sourceSnapshotHash', 'sourceSnapshot', 'amount', 'amountCents', 'currency',
    'paymentDetails', 'originalPaymentDetails', 'reason', 'recipient', 'status', 'bookkeepingStatus', 'bookkeeping', 'createdAt', 'updatedAt', 'verifiedAt', 'finishedAt',
    'providerInstructionUUID', 'providerPaymentReference', 'request', 'response', 'events', 'error', 'documentRevision', 'spirisBankAccountId', 'spirisCompanyId', 'retryOf',
    'reservedBy', 'revisionActor', 'pollSuspended', 'nextCheckAt', 'bookkeepingEnabled',
    'paymentConfirmationDocument', 'paymentDocumentStatus', 'paymentDocumentError', 'bookingProof', 'preflightStatus', 'preflightCheckedAt']
    .filter(key => job[key] !== undefined).map(key => [key, job[key]])),
    canResume: Boolean(recoveryCandidate(job) && job.preflightStatus === 'ready' && !job.lease) });
}

/** Tenant-bound durable MSS journal. A signed approval is the only amount
 * authority. Overrides are a separate payment instruction, never edits to the
 * card/customer/approval. Provider I/O always happens after reservation commit.
 * MSS success stays simulated: this module never creates office.payments and
 * never sets a source card to real or demo paid. */
export function createSwishPayments({ getRepository, sourceProvider = async () => [], client, env = process.env, now = () => new Date(),
  authorizeContext = async () => {}, onVerifiedPayment, onPrepared, onPaymentConfirmed,
  assertPaymentReady = async () => fail('Bokför underlaget i Spiris före utbetalning.', 409, 'swish_invoice_unbooked'),
  sitesProvider = async () => [] } = {}) {
  if (typeof getRepository !== 'function' || !client) throw new TypeError('getRepository och Swish-klient krävs.');
  const organisationId = env.SCRAPPILOT_ORGANISATION_ID ?? env.JEROC_TENANT_ID ?? 'jeroc-demo';
  const clock = () => new Date(now());
  let processing = null;
  const domain = (state, create = false) => {
    if (!state[DOMAIN]) { if (!create) return initial(organisationId); state[DOMAIN] = initial(organisationId); }
    const value = state[DOMAIN];
    if (value.organisationId !== organisationId) fail('Betalningsjournalen tillhör ett annat bolag.', 403, 'swish_tenant_mismatch');
    return value;
  };
  const read = async (operation, paths) => {
    const repository = await getRepository();
    return paths && repository.readProjection ? repository.readProjection(state => operation(domain(state)), { domain: DOMAIN, paths })
      : repository.read(state => operation(domain(state)), { domains: [DOMAIN] });
  };
  function indexWork(value) {
    const active = Object.values(value.jobs).filter(item => !terminal(item) && !item.pollSuspended || documentWork(item) || bookkeepingWork(item));
    const due = item => item.status === 'simulated_paid' ? [
      ...(documentWork(item) ? [item.paymentDocumentLease?.expiresAt ?? item.paymentDocumentNextCheckAt ?? item.createdAt] : []),
      ...(bookkeepingWork(item) ? [item.bookkeepingLease?.expiresAt ?? item.bookkeepingNextCheckAt ?? item.createdAt] : []),
    ].sort()[0] ?? item.createdAt : item.lease?.expiresAt ?? item.nextCheckAt ?? item.createdAt;
    active.sort((a, b) => due(a).localeCompare(due(b)));
    value.workIds = active.map(item => item.id);
    value.nextWorkAt = active.length ? due(active[0]) : null;
  }
  function documentWork(item) {
    return Boolean(onPaymentConfirmed && item.status === 'simulated_paid' && item.kind === 'card'
      && item.paymentDocumentStatus !== 'archived' && (item.paymentDocumentAttempts ?? 0) < 5);
  }
  function bookkeepingWork(item) {
    return item.status === 'simulated_paid' && item.kind === 'card' && item.registerSpirisPayment
      && !['registered', 'blocked', 'failed', 'paused'].includes(item.bookkeepingStatus);
  }
  async function verifiedBooking(source, { fresh = false, previous } = {}) {
    const result = await assertPaymentReady(source, { fresh });
    if (result?.status !== 'booked' || !result.companyId || !result.generation || !result.invoiceId)
      fail('Bokför underlaget i Spiris före utbetalning.', 409, 'swish_invoice_unbooked');
    const proof = { companyId: result.companyId, generation: result.generation, invoiceId: result.invoiceId, draftId: result.draftId ?? null };
    if (previous && !equal(previous, proof))
      fail('Spiris-fakturan eller kopplingen har ändrats. Utbetalningen behöver granskas.', 409, 'swish_booking_changed');
    return proof;
  }
  const transaction = async operation => (await getRepository()).transact((state, revision, audit) => {
    const value = domain(state, true), result = operation(value, state, audit); indexWork(value); return result;
  });
  function scoped(context) {
    if (context?.organisationId !== organisationId || !context.actorId || !context.effectiveUserId || !context.sessionKey)
      fail('En aktiv betalningssession för detta bolag krävs.', 403, 'swish_forbidden');
  }
  function principalIn(state, context, { admin = false, siteId } = {}) {
    scoped(context);
    const principal = resolvePricingPrincipal(state.pricing?.users ?? [], context.actorId, context.effectiveUserId);
    for (const user of [principal.actor, principal.user]) {
      if (!can(user, admin ? 'integrationsManage' : 'pay')) fail(admin ? 'Behörighet att hantera integrationer krävs.' : 'Behörighet att göra utbetalningar krävs.', 403, 'swish_forbidden');
      if (admin && Array.isArray(user.siteIds) || siteId && Array.isArray(user.siteIds) && !user.siteIds.includes(siteId))
        fail('Du saknar åtkomst till betalningens anläggning.', 403, 'swish_site_forbidden');
    }
    return principal;
  }
  async function authorize(context, options) {
    scoped(context); await authorizeContext(context);
    return (await getRepository()).read(state => principalIn(state, context, options), { domains: ['pricing'] });
  }
  function event(job, action, context, details = {}) {
    job.events.push({ id: randomUUID(), at: clock().toISOString(), action,
      actualUserId: context?.actorId ?? 'service:swish', effectiveUserId: context?.effectiveUserId ?? 'service:swish', ...copy(details) });
    job.updatedAt = clock().toISOString();
  }
  async function configuration() {
    const result = await client.configurationStatus();
    // The transport does not expose production; a substituted/misconfigured
    // adapter cannot turn a test action into a real transfer.
    if (result.mode !== 'mss') return { ...result, ready: false, issues: [...(result.issues ?? []), 'Endast Swish MSS-testmiljö stöds i denna etapp.'] };
    return result;
  }
  const currentApproval = async cardId => latestAttestedVismaCards(await sourceProvider({ cardId }))
    .find(approval => String(approval.cardId) === String(cardId));
  function sourceFrom(approval) {
    const snapshot = approval.snapshot, card = snapshot.card, customer = snapshot.customer;
    if (!card || !customer || String(card.id) !== String(approval.cardId) || !card.siteId || !customer.id || !snapshot.hash)
      fail('Den attesterade avräkningens låsta uppgifter behöver kompletteras.', 409, 'swish_source_incomplete');
    const amountCents = swishMoneyToCents(snapshot.net);
    const gross = swishMoneyToCents(snapshot.gross), offset = snapshot.offset;
    if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0 || Math.round(offset * 100) !== offset * 100
      || gross - Math.round(offset * 100) !== amountCents)
      fail('Avräkningens frysta totalbelopp och kvittning stämmer inte.', 409, 'swish_source_amount_invalid');
    // Offset requires allocation/reconciliation of correction balances. Do not
    // invent a partial supplier-invoice payment mapping in the first version.
    if (offset !== 0) fail('Avräkningar med kvittning behöver separat betalningsavstämning och kan inte Swish-testas ännu.', 409, 'swish_offset_unsupported');
    return { source: { cardId: approval.cardId, approvalId: approval.id, version: approval.version, hash: snapshot.hash,
      siteId: card.siteId, customerId: customer.id, customerName: customer.name, customerType: customer.type,
      attestedAt: approval.attestedAt, attestedBy: approval.attestedBy, number: `AV-${approval.cardId}-V${approval.version}` },
      snapshot: copy(snapshot), customer: copy(customer), amountCents, originalPaymentDetails: normalizeDetails(card.paymentDetails ?? customer.paymentProfile, customer) };
  }
  function assertOffice(state, source) {
    assertNoCrossManagedPayment(state, source.source.cardId, DOMAIN);
    const card = state.office?.cards?.find(value => String(value.id) === String(source.source.cardId));
    if (!card || card.kind === 'correction') fail('Det ursprungliga viktkortet saknas.', 409, 'swish_source_missing');
    if (state.office.payments?.some(value => String(value.cardId) === String(card.id)) || card.status === 'paid' || card.status === 'balance')
      fail('Kortet har redan en betalning eller är sparat på saldo.', 409, 'swish_already_paid');
    const frozen = source.snapshot.card;
    if (card.customerId !== frozen.customerId || card.origin !== frozen.origin || card.reference !== frozen.reference
      || !equal(card.rows?.map(row => [row.articleId, row.weight, row.price]), frozen.rows?.map(row => [row.articleId, row.weight, row.price]))
      || !equal(card.paymentDetails, frozen.paymentDetails) || card.pricingSnapshotId !== frozen.pricingSnapshotId)
      fail('Viktkortet har ändrats efter kundgodkännande och attest. Hämta en ny verifierad version.', 409, 'swish_source_changed');
    if (card.customerApproval && (card.customerApproval.id !== source.source.approvalId || card.customerApproval.version !== source.source.version))
      fail('Kortets attestversion har ändrats.', 409, 'swish_source_changed');
    return card;
  }
  function requestFor(job, config, message) {
    return { payoutInstructionUUID: job.providerInstructionUUID, payerPaymentReference: `SP${job.id.replaceAll('-', '').slice(0, 28)}`,
      payerAlias: config.merchantAlias, payeeAlias: job.paymentDetails.phone.slice(1), payeeSSN: job.paymentDetails.personalNumber,
      amount: amountString(job.amountCents), currency: 'SEK', payoutType: 'PAYOUT', instructionDate: clock().toISOString(),
      message: text(message ?? job.source?.number ?? 'ScrapPilot MSS-test', 50),
      ...(config.certificate?.serialNumber ? { signingCertificateSerialNumber: config.certificate.serialNumber } : {}) };
  }
  async function initialize() { await transaction(() => undefined); }
  async function integrationStatus() {
    // The catalog must stay a local, tiny read. Checking/downloading public
    // test certificates is reserved for opening the explicit Swish settings.
    const value = await read(item => ({ settings: copy(item.settings ?? initialSettings()), connection: copy(item.connection ?? null) }),
      [['organisationId'], ['settings'], ['connection']]);
    const configured = env.SWISH_ENVIRONMENT === 'mss' && value.settings.enabled;
    return { mode: env.SWISH_ENVIRONMENT === 'mss' ? 'test' : 'disabled', configured,
      connected: Boolean(configured && value.connection?.lastVerifiedAt), lastCheckedAt: value.connection?.lastCheckedAt ?? null,
      simulation: true, missing: configured ? [] : [env.SWISH_ENVIRONMENT !== 'mss' ? 'Aktivera Swish MSS i servermiljön.' : 'Aktivera Swish MSS-test i Integrationer.'] };
  }
  async function settings(context) {
    await authorize(context, { admin: true });
    return { settings: await read(value => copy(value.settings)), configuration: await configuration(), mode: 'mss', simulation: true,
      defaults: { amount: '10.00', paymentDetails: { method: 'swish', phone: '+46711111132', personalNumber: '197709306828', recipient: 'Swish MSS testmottagare' },
        message: 'ScrapPilot MSS-test' } };
  }
  async function saveSettings(input, context) {
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) {
      if (parsed.error.issues.some(issue => issue.path[0] === 'spirisBankAccountId'))
        fail('Spiris-kontots ID har fel format. Hämta konton från Spiris och välj kontot igen.', 422, 'swish_bank_account_invalid');
      if (parsed.error.issues.some(issue => issue.path[0] === 'spirisCompanyId'))
        fail('Spiris-företagets ID saknas eller har fel format. Hämta konton från Spiris igen.', 422, 'swish_company_invalid');
      fail('Kontrollera Swish-inställningarna.');
    }
    await authorize(context, { admin: true });
    await transaction((value, state, audit) => {
      principalIn(state, context, { admin: true });
      const enabled = parsed.data.bookkeepingEnabled ?? parsed.data.registerSpirisPayment ?? value.settings.bookkeepingEnabled ?? false;
      value.settings = { ...value.settings, ...parsed.data, bookkeepingEnabled: enabled, registerSpirisPayment: enabled,
        revision: value.settings.revision + 1, updatedAt: clock().toISOString(),
        updatedBy: { actualUserId: context.actorId, effectiveUserId: context.effectiveUserId } };
      const item = { id: randomUUID(), at: clock().toISOString(), action: 'swish_settings_saved', actualUserId: context.actorId,
        effectiveUserId: context.effectiveUserId, revision: value.settings.revision, enabled: value.settings.enabled };
      value.audit.push(item); audit?.push(item);
    });
    return settings(context);
  }
  async function prepare(cardId, context) {
    await authorize(context);
    const approval = await currentApproval(cardId);
    if (!approval) fail('Kortet måste vara kundgodkänt och internt attesterat före utbetalning.', 409, 'swish_source_unattested');
    const source = sourceFrom(approval); await authorize(context, { siteId: source.source.siteId });
    const repository = await getRepository();
    const data = await repository.read(state => {
      principalIn(state, context, { siteId: source.source.siteId }); assertOffice(state, source);
      const value = domain(state), existingJob = Object.values(value.jobs).filter(job => job.source?.cardId === source.source.cardId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return { settings: copy(value.settings), existingJob: publicJob(existingJob) };
    }, { domains: ['pricing', 'office', DOMAIN, 'bankPayments'] });
    const config = await configuration(), issues = [];
    if (!data.settings.enabled) issues.push('Aktivera Swish MSS-test under Integrationer först.');
    if (!config.ready) issues.push(...(config.missing ?? []), ...(config.issues ?? []));
    if (source.customer.type !== 'Privatperson') issues.push('Swish Utbetalning stöder endast privatpersoner. Företagskunder behöver bankutbetalning.');
    let bookingProof = null;
    try { bookingProof = await verifiedBooking(source.source); } catch (error) { issues.push(error.message); }
    const canInitiate = issues.length === 0 && !(data.existingJob && blocking(data.existingJob));
    try { validateSwish(source.originalPaymentDetails); } catch (error) { issues.push(error.message); }
    if (data.existingJob && blocking(data.existingJob)) issues.push('Detta kort har redan en reserverad eller genomförd Swish-testutbetalning.');
    return { cardId, source: source.source, sourceSnapshotHash: source.snapshot.hash, amount: source.amountCents / 100, amountCents: source.amountCents,
      currency: 'SEK', originalPaymentDetails: source.originalPaymentDetails, paymentDetails: copy(source.originalPaymentDetails),
      customer: { id: source.customer.id, name: source.customer.name, type: source.customer.type, number: source.customer.number },
      canStart: issues.length === 0, canInitiate, issues, simulation: true, mode: 'mss', configuration: config, bookingProof, ...data };
  }
  async function start(input, context) {
    const parsed = startSchema.safeParse(input); if (!parsed.success) fail('Kontrollera betalningsinstruktionen.');
    const request = parsed.data; await authorize(context);
    const approval = await currentApproval(request.cardId);
    if (!approval) fail('Kortet måste vara kundgodkänt och internt attesterat före utbetalning.', 409, 'swish_source_unattested');
    const source = sourceFrom(approval); await authorize(context, { siteId: source.source.siteId });
    if (request.source && ['approvalId', 'version', 'hash'].some(field => request.source[field] !== source.source[field]))
      fail('Attestversionen har ändrats. Öppna utbetalningsrutan på nytt.', 409, 'swish_source_changed');
    if (source.customer.type !== 'Privatperson') fail('Swish Utbetalning stöder endast privatpersoner.', 409, 'swish_customer_unsupported');
    const details = normalizeDetails(request.paymentDetails ?? source.originalPaymentDetails, source.customer); validateSwish(details);
    if (details.personalNumber !== normalizePersonalNumber(source.customer.number ?? ''))
      fail('Mottagarens personnummer måste matcha kunden i den attesterade avräkningen. Kundens identitet är låst.', 409, 'swish_recipient_identity_changed');
    const modified = !equal(editableDetails(details), editableDetails(source.originalPaymentDetails));
    if (modified && !request.reason?.trim()) fail('Ange en orsak när betalningssätt eller mottagaruppgifter ändras.', 422, 'swish_override_reason_required');
    const bookingProof = await verifiedBooking(source.source);
    const config = await configuration();
    if (!config.ready) fail('Swish MSS-testmiljön är inte färdigkonfigurerad.', 409, 'swish_not_configured');
    const result = await transaction((value, state, audit) => {
      principalIn(state, context, { siteId: source.source.siteId }); assertOffice(state, source);
      if (!value.settings.enabled) fail('Swish MSS-test är inte aktiverat.', 409, 'swish_disabled');
      const previous = Object.values(value.jobs).filter(job => job.source?.cardId === source.source.cardId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (previous) {
        if (blocking(previous)) return publicJob(previous);
        if (request.retryOf !== previous.id) return publicJob(previous);
        if (!['rejected', 'failed'].includes(previous.status)) fail('Utfallet måste granskas innan ett nytt försök kan skapas.', 409, 'swish_retry_forbidden');
      } else if (request.retryOf) fail('Det tidigare betalningsförsöket saknas.', 409, 'swish_retry_forbidden');
      const timestamp = clock().toISOString(), id = randomUUID();
      const job = { id, organisationId, kind: 'card', mode: 'mss', simulation: true, source: source.source,
        sourceSnapshotHash: source.snapshot.hash, sourceSnapshot: source.snapshot, amountCents: source.amountCents, amount: source.amountCents / 100,
        bookingProof, paymentDocumentStatus: 'pending',
        currency: 'SEK', paymentDetails: details, originalPaymentDetails: source.originalPaymentDetails, reason: request.reason ?? '',
        recipient: { name: details.recipient, phone: details.phone, personalNumber: details.personalNumber },
        spirisBankAccountId: value.settings.spirisBankAccountId ?? null,
        spirisCompanyId: value.settings.spirisCompanyId ?? null,
        registerSpirisPayment: value.settings.bookkeepingEnabled, bookkeepingEnabled: value.settings.bookkeepingEnabled,
        settingsRevision: value.settings.revision,
        authorization: { actorId: context.actorId, effectiveUserId: context.effectiveUserId, siteId: source.source.siteId },
        reservedBy: { actualUserId: context.actorId, effectiveUserId: context.effectiveUserId,
          actualUserName: state.pricing.users.find(user => user.id === context.actorId)?.name ?? context.actorId,
          effectiveUserName: state.pricing.users.find(user => user.id === context.effectiveUserId)?.name ?? context.effectiveUserId },
        providerInstructionUUID: randomUUID().replaceAll('-', '').toUpperCase(), status: 'queued', bookkeepingStatus: value.settings.bookkeepingEnabled ? 'pending' : 'not_requested',
        createdAt: timestamp, updatedAt: timestamp, events: [], ...(previous ? { retryOf: previous.id } : {}) };
      job.revisionActor = { actualUserId: job.reservedBy.actualUserId, effectiveUserId: job.reservedBy.effectiveUserId,
        name: job.reservedBy.effectiveUserName, actualName: job.reservedBy.actualUserName };
      job.request = { method: 'POST', path: '/swish-cpcapi/api/v1/payouts', payload: requestFor(job, config) };
      job.instructionHash = hash(job.request.payload);
      value.jobs[id] = job;
      event(job, 'payment_reserved', context, { text: 'Swish-testutbetalning reserverad. Belopp och attestversion är låsta.' });
      if (modified) event(job, 'payment_details_overridden', context, { text: 'Betalningsuppgifter ändrade med orsak.', reason: job.reason,
        before: source.originalPaymentDetails, after: details });
      audit?.push({ action: 'swish_payment_reserved', paymentId: id, cardId: request.cardId, amountCents: job.amountCents,
        actualUserId: context.actorId, effectiveUserId: context.effectiveUserId, at: timestamp, reason: job.reason });
      return publicJob(job);
    });
    return result;
  }
  async function sandboxSend(input, context) {
    const parsed = sandboxSchema.safeParse(input); if (!parsed.success) fail('Kontrollera testutbetalningens uppgifter.');
    await authorize(context, { admin: true });
    const details = normalizeDetails(parsed.data.paymentDetails); validateSwish(details);
    const amountCents = swishMoneyToCents(parsed.data.amount), config = await configuration();
    if (!config.ready) fail('Swish MSS-testmiljön är inte färdigkonfigurerad.', 409, 'swish_not_configured');
    return transaction((value, state) => {
      principalIn(state, context, { admin: true });
      if (!value.settings.enabled) fail('Aktivera Swish MSS-test först.', 409, 'swish_disabled');
      const existing = Object.values(value.jobs).find(job => job.kind === 'sandbox' && job.idempotencyKey === parsed.data.idempotencyKey);
      const fingerprint = hash([amountCents, details, parsed.data.message ?? '']);
      if (existing) { if (existing.fingerprint !== fingerprint) fail('Testnyckeln används redan för andra uppgifter.', 409, 'swish_idempotency_conflict'); return publicJob(existing); }
      const id = parsed.data.idempotencyKey, timestamp = clock().toISOString();
      if (value.jobs[id]) fail('Testnyckeln används redan av ett annat betalningsförsök.', 409, 'swish_idempotency_conflict');
      const job = { id, organisationId, kind: 'sandbox', mode: 'mss', simulation: true, idempotencyKey: parsed.data.idempotencyKey, fingerprint,
        amount: amountCents / 100, amountCents, currency: 'SEK', paymentDetails: details, originalPaymentDetails: details,
        recipient: { name: details.recipient, phone: details.phone, personalNumber: details.personalNumber },
        authorization: { actorId: context.actorId, effectiveUserId: context.effectiveUserId, admin: true },
        providerInstructionUUID: randomUUID().replaceAll('-', '').toUpperCase(), status: 'queued', bookkeepingStatus: 'not_requested', bookkeepingEnabled: false,
        bookkeeping: { reason: 'Fristående simulatorprov har ingen avräkning och bokförs inte.' }, createdAt: timestamp, updatedAt: timestamp, events: [] };
      job.request = { method: 'POST', path: '/swish-cpcapi/api/v1/payouts', payload: requestFor(job, config, parsed.data.message) };
      job.instructionHash = hash(job.request.payload); value.jobs[id] = job;
      event(job, 'payment_reserved', context, { text: 'Fristående Swish MSS-prov reserverat. Inga verkliga pengar flyttas.' });
      return publicJob(job);
    });
  }
  async function authorizeJob(id, context) {
    if (!uuid.safeParse(id).success) fail('Betalningsförsöket saknas.', 404, 'swish_job_missing');
    const item = await read(value => copy(value.jobs[id] ?? null));
    if (!item) fail('Betalningsförsöket saknas.', 404, 'swish_job_missing');
    await authorize(context, { admin: item.kind === 'sandbox', siteId: item.source?.siteId }); return item;
  }
  async function job(id, context) { return publicJob(await authorizeJob(id, context)); }
  async function getCardJobs(cardId, context) {
    await authorize(context);
    const items = await read(value => Object.values(value.jobs).filter(job => String(job.source?.cardId) === String(cardId)).map(copy));
    if (items.length) await authorize(context, { siteId: items[0].source.siteId });
    else {
      await (await getRepository()).read(state => {
        const card = state.office?.cards?.find(value => String(value.id) === String(cardId));
        if (!card) fail('Viktkortet saknas.', 404, 'swish_source_missing'); principalIn(state, context, { siteId: card.siteId });
      }, { domains: ['office', 'pricing'] });
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicJob);
  }
  async function readVerifiedPayment(id) {
    if (!uuid.safeParse(id).success) return null;
    return read(value => { const item = value.jobs[id]; return item?.status === 'simulated_paid' && item.verifiedAt && item.providerResult?.status === 'PAID' ? copy(item) : null; });
  }
  function workerContext(job) {
    return { organisationId, actorId: job.authorization.actorId, effectiveUserId: job.authorization.effectiveUserId,
      sessionKey: 'durable-swish-instruction' };
  }
  const activeLease = item => Boolean(item.lease && Date.parse(item.lease.expiresAt) > clock().getTime());
  const resumedQueued = item => item.status === 'queued' && neverDispatched(item)
    && item.events?.some(entry => entry.action === 'payment_resumed');
  const recoveryFingerprint = item => hash([item.source, item.sourceSnapshotHash, item.sourceSnapshot, item.amount, item.amountCents, item.currency,
    item.paymentDetails, item.originalPaymentDetails, item.recipient, item.bookingProof, item.authorization, item.request,
    item.instructionHash, item.providerInstructionUUID, item.spirisCompanyId, item.spirisBankAccountId,
    item.bookkeepingEnabled, item.registerSpirisPayment]);
  function assertRecoveryState(value, state, item, context, source) {
    // The caller cannot elevate the original payment instruction's authority.
    principalIn(state, context, { siteId: source.source.siteId });
    principalIn(state, workerContext(item), { siteId: source.source.siteId });
    assertOffice(state, source);
    if (!value.settings.enabled) fail('Swish MSS-test är inte aktiverat.', 409, 'swish_disabled');
    if ((value.settings.spirisCompanyId ?? null) !== (item.spirisCompanyId ?? null)
      || (value.settings.spirisBankAccountId ?? null) !== (item.spirisBankAccountId ?? null)
      || Boolean(value.settings.bookkeepingEnabled) !== Boolean(item.bookkeepingEnabled))
      fail('Spiris-inställningarna har ändrats sedan utbetalningen reserverades.', 409, 'swish_settings_changed');
    if (!equal(source.source, item.source) || !equal(source.snapshot, item.sourceSnapshot)
      || source.snapshot.hash !== item.sourceSnapshotHash || source.amountCents !== item.amountCents
      || item.amount !== item.amountCents / 100 || item.currency !== 'SEK'
      || !equal(source.originalPaymentDetails, item.originalPaymentDetails))
      fail('Den låsta avräkningen har ändrats. Utbetalningen behöver granskas.', 409, 'swish_source_changed');
    validateSwish(item.paymentDetails);
    if (item.paymentDetails.personalNumber !== normalizePersonalNumber(source.customer.number ?? '')
      || !equal(item.recipient, { name: item.paymentDetails.recipient, phone: item.paymentDetails.phone, personalNumber: item.paymentDetails.personalNumber }))
      fail('Den låsta mottagarinstruktionen har ändrats.', 409, 'swish_instruction_changed');
    const payload = item.request?.payload;
    if (!payload || item.request.method !== 'POST' || item.request.path !== '/swish-cpcapi/api/v1/payouts'
      || hash(payload) !== item.instructionHash || payload.payoutInstructionUUID !== item.providerInstructionUUID
      || payload.amount !== amountString(item.amountCents) || payload.currency !== item.currency
      || payload.payeeAlias !== item.paymentDetails.phone.slice(1) || payload.payeeSSN !== item.paymentDetails.personalNumber
      || !item.bookingProof?.companyId || !item.bookingProof?.generation || !item.bookingProof?.invoiceId)
      fail('Den sparade betalningsinstruktionen har ändrats.', 409, 'swish_instruction_changed');
  }
  async function inspectRecovery(item, context) {
    const approval = await currentApproval(item.source.cardId);
    if (!approval) fail('Kortet saknar sin ursprungliga attest.', 409, 'swish_source_changed');
    const source = sourceFrom(approval);
    await authorize(context, { siteId: source.source.siteId });
    await (await getRepository()).read(state => assertRecoveryState(domain(state), state, item, context, source),
      { domains: [DOMAIN, 'pricing', 'office', 'bankPayments'] });
    await verifiedBooking(item.source, { fresh: true, previous: item.bookingProof });
    const config = await configuration();
    if (!config.ready || config.merchantAlias !== item.request.payload.payerAlias)
      fail('Swish-testanslutningen har ändrats. Instruktionen skickas inte.', 409, 'swish_configuration_changed');
    return { source, fingerprint: recoveryFingerprint(item) };
  }
  function recordPreflight(item, error, context, audit) {
    item.lease = null;
    item.preflightStatus = error ? 'blocked' : 'ready';
    item.preflightCheckedAt = clock().toISOString();
    item.error = error ? safeError(error) : null;
    const action = error ? 'payment_preflight_blocked' : 'payment_preflight_ready';
    event(item, action, context, { text: error ? item.error.message : 'Förkontrollen är klar. Utbetalningen är fortfarande spärrad och måste fortsättas uttryckligen.',
      ...(error ? { error: copy(item.error) } : {}) });
    audit?.push({ action: `swish_${action}`, paymentId: item.id, cardId: item.source.cardId,
      actualUserId: context.actorId, effectiveUserId: context.effectiveUserId, at: item.preflightCheckedAt,
      ...(error ? { error: copy(item.error) } : {}) });
  }
  async function refreshBlocked(item, context) {
    if (!recoveryCandidate(item) || activeLease(item)) return publicJob(item);
    let inspection, failure;
    try { inspection = await inspectRecovery(item, context); } catch (error) { failure = error; }
    return transaction((value, state, audit) => {
      const saved = value.jobs[item.id];
      if (!saved) fail('Betalningsförsöket saknas.', 404, 'swish_job_missing');
      principalIn(state, context, { siteId: saved.source?.siteId });
      if (!recoveryCandidate(saved) || activeLease(saved)) return publicJob(saved);
      if (!failure) {
        try {
          if (recoveryFingerprint(saved) !== inspection.fingerprint)
            fail('Den sparade betalningsinstruktionen har ändrats.', 409, 'swish_instruction_changed');
          assertRecoveryState(value, state, saved, context, inspection.source);
        } catch (error) { failure = error; }
      }
      recordPreflight(saved, failure, context, audit);
      return publicJob(saved);
    });
  }
  async function resume(id, context) {
    const item = await authorizeJob(id, context);
    if (activeLease(item) || !(recoveryCandidate(item) && item.preflightStatus === 'ready' || resumedQueued(item)))
      fail('Kontrollera den spärrade utbetalningen först. Endast en verifierad instruktion som aldrig skickats kan fortsätta.', 409, 'swish_resume_forbidden');
    let inspection;
    try { inspection = await inspectRecovery(item, context); }
    catch (error) {
      await transaction((value, state, audit) => {
        const saved = value.jobs[id];
        principalIn(state, context, { siteId: saved?.source?.siteId });
        if (saved && recoveryCandidate(saved) && !activeLease(saved)) recordPreflight(saved, error, context, audit);
      });
      throw error;
    }
    const result = await transaction((value, state, audit) => {
      const saved = value.jobs[id];
      if (!saved) fail('Betalningsförsöket saknas.', 404, 'swish_job_missing');
      principalIn(state, context, { siteId: saved.source?.siteId });
      if (activeLease(saved) || !(recoveryCandidate(saved) && saved.preflightStatus === 'ready' || resumedQueued(saved)))
        fail('Utbetalningen kan inte fortsätta i sitt nuvarande läge.', 409, 'swish_resume_forbidden');
      try {
        if (recoveryFingerprint(saved) !== inspection.fingerprint)
          fail('Den sparade betalningsinstruktionen har ändrats.', 409, 'swish_instruction_changed');
        assertRecoveryState(value, state, saved, context, inspection.source);
      } catch (error) {
        if (recoveryCandidate(saved)) recordPreflight(saved, error, context, audit);
        return { error };
      }
      if (resumedQueued(saved)) return { job: publicJob(saved) };
      saved.status = 'queued'; saved.lease = null; saved.error = null;
      delete saved.preflightStatus; delete saved.preflightCheckedAt;
      saved.nextCheckAt = null; saved.pollSuspended = false;
      event(saved, 'payment_resumed', context, { text: 'Den ursprungliga Swish-testinstruktionen köades igen efter verifierad förkontroll. Inget skickades av denna åtgärd.' });
      audit?.push({ action: 'swish_payment_resumed', paymentId: id, cardId: saved.source.cardId,
        actualUserId: context.actorId, effectiveUserId: context.effectiveUserId, at: saved.updatedAt });
      return { job: publicJob(saved) };
    });
    if (result.error) throw result.error;
    return result.job;
  }
  async function reserveWork(id, force = false) {
    return transaction((value, state) => {
      const item = value.jobs[id]; if (!item || terminal(item)) return null;
      if (!force && item.pollSuspended) return null;
      if (item.lease && Date.parse(item.lease.expiresAt) > clock().getTime()) return null;
      if (item.status === 'in_flight') {
        item.status = 'unknown'; item.error = { code: 'SWISH_UNKNOWN_OUTCOME', message: 'Svaret saknas. Endast status för samma instruktion hämtas; utbetalningen skickas inte igen.' };
        event(item, 'payment_outcome_unknown', undefined, { text: item.error.message });
      }
      if (!force && item.nextCheckAt && Date.parse(item.nextCheckAt) > clock().getTime()) return null;
      if (item.status === 'queued' && !neverDispatched(item)) {
        item.status = 'blocked'; item.error = { code: 'swish_resume_forbidden', message: 'Instruktionen har redan skickats eller fått ett providersvar. Den skickas inte igen.' };
        event(item, 'payment_blocked', undefined, { text: item.error.message }); return null;
      }
      const dispatch = item.status === 'queued' && !item.sentAt;
      if (dispatch) {
        try { principalIn(state, workerContext(item), { admin: item.kind === 'sandbox', siteId: item.source?.siteId }); }
        catch (error) { item.status = 'blocked'; item.error = { code: 'swish_authorization_revoked', message: error.message }; event(item, 'payment_blocked', undefined, { text: error.message }); return null; }
        if (!value.settings.enabled) { item.status = 'blocked'; item.error = { code: 'swish_disabled', message: 'Swish-test stängdes av innan utbetalningen skickades.' }; return null; }
        if (item.kind === 'card') {
          try { assertOffice(state, { source: item.source, snapshot: item.sourceSnapshot }); }
          catch (error) { item.status = 'blocked'; item.error = { code: error.code, message: error.message }; event(item, 'payment_blocked', undefined, { text: error.message }); return null; }
        }
      }
      item.lease = { id: randomUUID(), expiresAt: nextAt(clock(), LEASE_MS) };
      return { job: copy(item), leaseId: item.lease.id, dispatch };
    });
  }
  async function updateReserved(id, leaseId, mutate) {
    return transaction(value => { const item = value.jobs[id]; if (!item || item.lease?.id !== leaseId) return null; mutate(item, value); return copy(item); });
  }
  async function beforeDispatch(reservation) {
    const { job: item, leaseId } = reservation;
    let currentSource;
    if (item.kind === 'card') {
      const current = await currentApproval(item.source.cardId);
      if (!current || current.id !== item.source.approvalId || current.version !== item.source.version || current.snapshot.hash !== item.source.hash) {
        await updateReserved(item.id, leaseId, saved => { saved.status = 'blocked'; saved.lease = null; saved.error = { code: 'swish_source_changed', message: 'Attestversionen har ändrats innan betalningen skickades.' }; event(saved, 'payment_blocked', undefined, { text: saved.error.message }); });
        return false;
      }
      try { currentSource = sourceFrom(current); }
      catch (error) {
        await updateReserved(item.id, leaseId, saved => { saved.status = 'blocked'; saved.lease = null; saved.error = safeError(error);
          event(saved, 'payment_blocked', undefined, { text: saved.error.message, error: copy(saved.error) }); }); return false;
      }
    }
    try {
      const config = await configuration();
      if (!config.ready || config.merchantAlias !== item.request.payload.payerAlias) fail('Swish-testanslutningen har ändrats. Instruktionen skickas inte.', 409, 'swish_configuration_changed');
      if (onPrepared && item.kind === 'card' && !item.documentPreparedAt) {
        const revision = await onPrepared(publicJob(item));
        await updateReserved(item.id, leaseId, saved => { saved.documentPreparedAt = clock().toISOString(); if (revision) saved.documentRevision = copy(revision);
          event(saved, 'payment_document_prepared', undefined, { text: 'Avräkningens betalningsuppgifter har arkiverats före Swish-testet.' }); });
      }
    } catch (error) {
      await updateReserved(item.id, leaseId, saved => { saved.status = 'blocked'; saved.lease = null; saved.error = { code: error.code ?? 'swish_document_failed', message: text(error.message, 300) || 'Betalningsunderlaget kunde inte arkiveras.' }; event(saved, 'payment_blocked', undefined, { text: saved.error.message }); }); return false;
    }
    if (item.kind === 'card') {
      const current = await currentApproval(item.source.cardId);
      if (!current || current.id !== item.source.approvalId || current.version !== item.source.version || current.snapshot.hash !== item.source.hash) {
        await updateReserved(item.id, leaseId, saved => { saved.status = 'blocked'; saved.lease = null;
          saved.error = { code: 'swish_source_changed', message: 'Attestversionen ändrades medan betalningsunderlaget arkiverades. Inget skickades till Swish.' };
          event(saved, 'payment_blocked', undefined, { text: saved.error.message }); });
        return false;
      }
      try { currentSource = sourceFrom(current); }
      catch (error) {
        await updateReserved(item.id, leaseId, saved => { saved.status = 'blocked'; saved.lease = null; saved.error = safeError(error);
          event(saved, 'payment_blocked', undefined, { text: saved.error.message, error: copy(saved.error) }); }); return false;
      }
    }
    // Recheck current authorization in the same short commit that marks the
    // instruction sent. A revoked queued instruction never reaches Swish.
    if (item.kind === 'card') {
      try { await verifiedBooking(item.source, { fresh: true, previous: item.bookingProof }); }
      catch (error) {
        await updateReserved(item.id, leaseId, saved => { saved.status = 'blocked'; saved.lease = null;
          saved.error = safeError(error, 'swish_invoice_unbooked');
          event(saved, 'payment_blocked', undefined, { text: saved.error.message, error: copy(saved.error) }); });
        return false;
      }
    }
    return transaction((value, state) => {
      const saved = value.jobs[item.id]; if (saved?.lease?.id !== leaseId) return false;
      try { principalIn(state, workerContext(saved), { admin: saved.kind === 'sandbox', siteId: saved.source?.siteId });
        if (!value.settings.enabled) fail('Swish-test har stängts av.', 409, 'swish_disabled');
        if (saved.kind === 'card') assertRecoveryState(value, state, saved, workerContext(saved), currentSource);
      } catch (error) { saved.status = 'blocked'; saved.lease = null; saved.error = safeError(error, 'swish_forbidden');
        event(saved, 'payment_blocked', undefined, { text: saved.error.message, error: copy(saved.error) }); return false; }
      if (hash(saved.request.payload) !== saved.instructionHash) fail('Den sparade betalningsinstruktionen har ändrats.', 409, 'swish_instruction_changed');
      saved.status = 'in_flight'; saved.sentAt = clock().toISOString(); event(saved, 'payment_sent', undefined, { text: 'Instruktionen skickas till Swish MSS. Inga riktiga pengar flyttas.' }); return true;
    });
  }
  function verifyInstructionResponse(item, result) {
    const data = result.data, sent = item.request.payload;
    if (result.environment && result.environment !== 'mss' || !data) return false;
    const identity = ['payoutInstructionUUID', 'payerPaymentReference', 'payerAlias', 'payeeAlias', 'payeeSSN', 'currency'];
    if (identity.some(field => String(data[field] ?? '') !== String(sent[field]))) return false;
    let cents; try { cents = swishMoneyToCents(data.amount); } catch { return false; }
    return cents === item.amountCents;
  }
  function verifyPaid(item, result) {
    const data = result.data;
    if (!verifyInstructionResponse(item, result) || data.status !== 'PAID') return false;
    const paidAt = Date.parse(data.datePaid);
    return typeof data.paymentReference === 'string' && Boolean(data.paymentReference.trim())
      && Number.isFinite(paidAt) && paidAt <= clock().getTime() + 5000;
  }
  async function settle(reservation, result) {
    const item = await updateReserved(reservation.job.id, reservation.leaseId, (saved, value) => {
      value.connection = { ...(value.connection ?? {}), lastCheckedAt: clock().toISOString() };
      saved.response = { method: reservation.dispatch ? 'POST' : 'GET', httpStatus: result.statusCode ?? null, data: safeProviderData(result.data) };
      saved.lease = null;
      if (!reservation.dispatch) saved.pollCount = (saved.pollCount ?? 0) + 1;
      if (result.ok && result.data?.status === 'PAID') {
        if (!verifyPaid(saved, result)) {
          saved.status = 'unknown'; saved.error = { code: 'SWISH_RESPONSE_MISMATCH', message: 'Swish-svaret matchar inte den låsta instruktionen. Ingen utbetalning eller bokföring bekräftas.' };
          saved.failedPolls = (saved.failedPolls ?? 0) + 1;
          saved.pollSuspended = saved.failedPolls >= 8 || (saved.pollCount ?? 0) >= 40;
          saved.nextCheckAt = saved.pollSuspended ? null : nextAt(clock(), 60_000);
          event(saved, 'payment_response_mismatch', undefined, { text: saved.error.message }); return;
        }
        saved.status = 'simulated_paid'; saved.verifiedAt = clock().toISOString(); saved.finishedAt = saved.verifiedAt;
        value.connection.lastVerifiedAt = saved.verifiedAt;
        saved.providerResult = copy(result.data); saved.providerPaymentReference = result.data.paymentReference; saved.error = null;
        saved.nextCheckAt = null; event(saved, 'payment_simulated_paid', undefined, { text: 'Swish MSS bekräftade testutbetalningen. Detta är en simulering.' });
        return;
      }
      if (result.ok && ['CREATED', 'DEBITED', 'PENDING'].includes(result.data?.status)) {
        saved.status = 'pending'; saved.error = null; saved.nextCheckAt = nextAt(clock());
        if ((saved.pollCount ?? 0) >= 40 || clock().getTime() - Date.parse(saved.createdAt) >= 86_400_000) {
          saved.status = 'unknown'; saved.pollSuspended = true; saved.nextCheckAt = null;
          saved.error = { code: 'SWISH_RECONCILIATION_REQUIRED', message: 'Automatisk statuskontroll har pausats. Kontrollera samma instruktion manuellt; skapa ingen ny utbetalning.' };
        }
        event(saved, 'payment_pending', undefined, { text: 'Swish har tagit emot testinstruktionen. Genomförandet inväntas.' }); return;
      }
      if (result.ok && result.data?.status === 'ERROR') {
        if (!verifyInstructionResponse(saved, result)) {
          saved.status = 'unknown'; saved.nextCheckAt = nextAt(clock(), 60_000); saved.failedPolls = (saved.failedPolls ?? 0) + 1;
          saved.pollSuspended = saved.failedPolls >= 8;
          saved.error = { code: 'SWISH_RESPONSE_MISMATCH', message: 'Avvisningen matchar inte den sparade instruktionen. Ett nytt utbetalningsförsök är spärrat.' };
          event(saved, 'payment_response_mismatch', undefined, { text: saved.error.message }); return;
        }
        saved.status = 'rejected'; saved.finishedAt = clock().toISOString(); saved.nextCheckAt = null;
        saved.error = { code: text(result.data.errorCode, 100) || 'SWISH_REJECTED', message: text(result.data.errorMessage, 300) || 'Swish avvisade testutbetalningen.' };
        event(saved, 'payment_rejected', undefined, { text: saved.error.message }); return;
      }
      if (reservation.dispatch && !result.uncertain && !result.ok && Number(result.statusCode) >= 400 && Number(result.statusCode) < 500 && result.statusCode !== 409) {
        saved.status = 'rejected'; saved.finishedAt = clock().toISOString(); saved.nextCheckAt = null;
        saved.error = { code: text(result.error?.code, 100) || 'SWISH_REJECTED', message: text(result.error?.message, 300) || 'Swish avvisade testinstruktionen.' };
        event(saved, 'payment_rejected', undefined, { text: saved.error.message }); return;
      }
      if (reservation.dispatch && !result.ok && !result.uncertain && ['swish_invalid_payload', 'swish_not_configured', 'swish_signing_failed', 'swish_invalid_signing_certificate'].includes(result.error?.code)) {
        saved.status = 'failed'; saved.finishedAt = clock().toISOString(); saved.nextCheckAt = null;
        saved.error = { code: result.error.code, message: text(result.error.message, 300) || 'Instruktionen skickades inte till Swish.' };
        event(saved, 'payment_not_sent', undefined, { text: saved.error.message }); return;
      }
      // 201 normally contains a reference, not a final PAID proof. Every other
      // uncertain response is recoverable only through GET of this same UUID.
      saved.status = result.ok ? 'pending' : 'unknown'; saved.nextCheckAt = nextAt(clock(), result.ok ? POLL_MS : 30_000);
      saved.error = result.ok ? null : { code: text(result.error?.code, 100) || 'SWISH_UNKNOWN_OUTCOME',
        message: text(result.error?.message, 300) || 'Utfallet är okänt. Samma instruktion kontrolleras utan ny utbetalning.' };
      if (!result.ok) saved.failedPolls = (saved.failedPolls ?? 0) + Number(!reservation.dispatch);
      if ((saved.failedPolls ?? 0) >= 8 || (saved.pollCount ?? 0) >= 40 || clock().getTime() - Date.parse(saved.createdAt) >= 86_400_000) {
        saved.pollSuspended = true; saved.nextCheckAt = null;
        saved.error = { code: 'SWISH_RECONCILIATION_REQUIRED', message: 'Automatisk statuskontroll har pausats. Utfallet måste stämmas av manuellt mot samma instruktion.' };
      }
      event(saved, result.ok ? 'payment_pending' : 'payment_outcome_unknown', undefined, { text: saved.error?.message ?? 'Swish-testet inväntar ett verifierat slutligt svar.' });
    });
    if (item?.status === 'simulated_paid') {
      await synchronizePaymentDocument(item.id);
      await synchronizeBookkeeping(item.id);
    }
    return item;
  }
  async function synchronizePaymentDocument(id, { force = false } = {}) {
    if (!onPaymentConfirmed) return;
    const reservation = await transaction(value => {
      const saved = value.jobs[id];
      if (!saved || saved.kind !== 'card' || saved.status !== 'simulated_paid' || saved.providerResult?.status !== 'PAID'
        || saved.paymentDocumentStatus === 'archived' || saved.paymentDocumentLease && Date.parse(saved.paymentDocumentLease.expiresAt) > clock().getTime()) return null;
      if (!force && ((saved.paymentDocumentAttempts ?? 0) >= 5 || saved.paymentDocumentNextCheckAt && Date.parse(saved.paymentDocumentNextCheckAt) > clock().getTime())) return null;
      saved.paymentDocumentLease = { id: randomUUID(), expiresAt: nextAt(clock(), LEASE_MS) };
      saved.paymentDocumentStatus = 'pending'; saved.paymentDocumentAttempts = (saved.paymentDocumentAttempts ?? 0) + 1;
      return { job: copy(saved), leaseId: saved.paymentDocumentLease.id };
    });
    if (!reservation) return;
    let result, failure;
    try { result = await onPaymentConfirmed(copy(reservation.job)); if (!result?.documentId) throw new Error('PDF-bekräftelsen kunde inte arkiveras.'); }
    catch (error) { failure = text(error.message, 300) || 'Betalningsbekräftelsens PDF behöver följas upp.'; }
    await transaction(value => {
      const saved = value.jobs[id]; if (saved?.paymentDocumentLease?.id !== reservation.leaseId) return;
      saved.paymentDocumentLease = null;
      saved.paymentDocumentStatus = failure ? 'failed' : 'archived'; saved.paymentDocumentError = failure ?? null;
      saved.paymentDocumentNextCheckAt = failure && saved.paymentDocumentAttempts < 5 ? nextAt(clock(), 60_000) : null;
      if (result && !failure) saved.paymentConfirmationDocument = copy(result);
      event(saved, failure ? 'payment_confirmation_pdf_failed' : 'payment_confirmation_pdf_archived', undefined,
        { text: failure ?? 'Ny avräknings-PDF med verifierad Swish-testbekräftelse är arkiverad.' });
    });
  }
  async function synchronizeBookkeeping(id, { force = false } = {}) {
    if (!onVerifiedPayment) return;
    const reservation = await transaction(value => {
      const saved = value.jobs[id];
      if (!saved || saved.status !== 'simulated_paid' || saved.kind !== 'card' || !saved.registerSpirisPayment
        || saved.bookkeepingStatus === 'registered' || saved.bookkeepingLease && Date.parse(saved.bookkeepingLease.expiresAt) > clock().getTime()) return null;
      if (!force && saved.bookkeepingNextCheckAt && Date.parse(saved.bookkeepingNextCheckAt) > clock().getTime()) return null;
      saved.bookkeepingLease = { id: randomUUID(), expiresAt: nextAt(clock(), LEASE_MS) };
      return { job: copy(saved), lease: saved.bookkeepingLease.id };
    });
    if (!reservation) return;
    let result;
    try { result = await onVerifiedPayment(copy(reservation.job), { force }); }
    catch (error) { result = { status: 'unknown', reason: text(error.message, 300) || 'Betalningsbokföringens svar saknas.' }; }
    await transaction(value => {
      const saved = value.jobs[id]; if (saved?.bookkeepingLease?.id !== reservation.lease) return;
      saved.bookkeepingLease = null;
      const previousStatus = saved.bookkeepingStatus, previousResult = saved.bookkeeping;
      saved.bookkeepingStatus = ['registered', 'waiting_booked', 'paused', 'unknown', 'failed', 'blocked', 'pending'].includes(result?.status) ? result.status : 'unknown';
      saved.bookkeeping = copy(result ?? { status: 'unknown' });
      saved.bookkeepingNextCheckAt = ['registered', 'blocked', 'failed', 'paused'].includes(saved.bookkeepingStatus) ? null : nextAt(clock(), 300_000);
      if (previousStatus !== saved.bookkeepingStatus || previousResult?.paymentId !== saved.bookkeeping?.paymentId || previousResult?.reason !== saved.bookkeeping?.reason)
        event(saved, 'payment_bookkeeping_updated', undefined, { text: saved.bookkeepingStatus === 'registered'
          ? 'Den simulerade Swish-betalningen är registrerad i Spiris sandbox.' : result?.reason ?? 'Spiris-betalningsbokföring inväntas.', status: saved.bookkeepingStatus });
    });
  }
  async function run(id, force = false) {
    const reservation = await reserveWork(id, force); if (!reservation) return;
    if (reservation.dispatch && !await beforeDispatch(reservation)) return;
    let result;
    try { result = reservation.dispatch ? await client.createPayout(copy(reservation.job.request.payload))
      : await client.getPayout(reservation.job.providerInstructionUUID); }
    catch (error) { result = { ok: false, uncertain: true, environment: 'mss', error: { code: 'SWISH_TRANSPORT_ERROR', message: text(error.message, 300) || 'Swish-svaret saknas.' } }; }
    await settle(reservation, result);
  }
  async function refresh(id, context) {
    const existing = await authorizeJob(id, context);
    if (existing.status === 'simulated_paid') {
      await synchronizePaymentDocument(id, { force: true });
      await synchronizeBookkeeping(id, { force: true });
    }
    else if (existing.status === 'blocked') await refreshBlocked(existing, context);
    else if (!terminal(existing) && existing.status !== 'queued') await run(id, true);
    return job(id, context);
  }
  async function processQueuedPayments({ limit = 10 } = {}) {
    if (processing) return processing;
    processing = (async () => {
      const index = await read(value => ({ workIds: value.workIds ?? [], nextWorkAt: value.nextWorkAt }), [['organisationId'], ['workIds'], ['nextWorkAt']]);
      if (!index.workIds.length || index.nextWorkAt && Date.parse(index.nextWorkAt) > clock().getTime()) return 0;
      const selected = index.workIds.slice(0, Math.min(50, limit));
      const ids = await read(value => selected.map(id => value.jobs[id]).filter(Boolean)
        .filter(item => item.status === 'simulated_paid' ? documentWork(item) && (!item.paymentDocumentNextCheckAt || Date.parse(item.paymentDocumentNextCheckAt) <= clock().getTime())
          || bookkeepingWork(item) && (!item.bookkeepingNextCheckAt || Date.parse(item.bookkeepingNextCheckAt) <= clock().getTime())
          : !item.pollSuspended && (!item.nextCheckAt || Date.parse(item.nextCheckAt) <= clock().getTime()))
        .map(item => ({ id: item.id, paid: item.status === 'simulated_paid' })), [['organisationId'], ...selected.map(id => ['jobs', id])]);
      for (const item of ids) { if (item.paid) { await synchronizePaymentDocument(item.id); await synchronizeBookkeeping(item.id); } else await run(item.id); }
      return ids.length;
    })();
    try { return await processing; } finally { processing = null; }
  }
  async function assertNoManagedPayment(cardId, state) {
    const lookup = value => Object.values(value.jobs).find(item => String(item.source?.cardId) === String(cardId) && blocking(item));
    const existing = state ? lookup(domain(state)) : await read(lookup);
    if (existing) fail('Kortet har en reserverad eller genomförd Swish-testutbetalning. Den manuella demoutbetalningen är spärrad.', 409, 'swish_payment_reserved');
  }
  return { initialize, integrationStatus, settings, saveSettings, prepare, start, sandboxSend, job, getCardJobs, refresh, resume, processQueuedPayments,
    assertNoManagedPayment, readVerifiedPayment, synchronizeBookkeeping, synchronizePaymentDocument };
}
