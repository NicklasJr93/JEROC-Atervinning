import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DocumentError } from './storage.mjs';

export const DOCUMENT_TEMPLATE_VERSION = 'jeroc-a4-1';
const copy = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const documentHash = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
const fail = (message, status = 409, code = 'invalid_document') => { throw new DocumentError(message, status, code); };
const can = (principal, right) => principal?.user?.active !== false && (principal?.user?.level !== 'Medarbetare' || principal.user.permissions?.includes(right));
const authenticated = principal => { if (!principal?.actor?.id || !principal?.user?.id || !['Medarbetare', 'VD', 'Systemadmin'].includes(principal.user.level) || principal.actor.active === false || principal.user.active === false) fail('Logga in i kontoret för att öppna dokument.', 401, 'authentication_required'); };
const demand = (principal, right) => { authenticated(principal); if (!can(principal, right)) fail('Du saknar behörighet till dokumentet.', 403, 'forbidden'); };
const moneyVisible = principal => ['attest', 'pay', 'reports'].some(right => can(principal, right)) || ['prices', 'priceA', 'priceB', 'priceC', 'customerPrices'].every(right => can(principal, right));
const demandSite = (principal, siteId) => { authenticated(principal); if (!siteId || Array.isArray(principal.user.siteIds) && !principal.user.siteIds.includes(siteId)) fail('Du saknar åtkomst till dokumentets anläggning.', 403, 'site_forbidden'); };
const demandSettlement = (principal, siteId) => { demand(principal, 'view'); demandSite(principal, siteId); if (!moneyVisible(principal)) fail('Du saknar behörighet att se hela avräkningens priser.', 403, 'financial_visibility_required'); };
const visibleSite = (principal, siteId) => Boolean(siteId) && (!Array.isArray(principal.user.siteIds) || principal.user.siteIds.includes(siteId));
const demandReceipt = principal => { if (!['pay', 'reports'].some(right => can(principal, right))) fail('Du saknar behörighet till betalningsjournalen.', 403, 'forbidden'); };
const demandTransport = principal => { demand(principal, 'transportRead'); if (Array.isArray(principal.user.siteIds)) fail('Transportplaneringen saknar ännu säker anläggningsindelning. Dokumenten kräver tillgång till alla anläggningar.', 403, 'transport_scope_unavailable'); };
const short = z.string().trim().max(300).default('');
const partySchema = z.object({ name: short, number: short, address: short, postalCode: short, city: short }).strict();
const dateText = z.string().trim().max(40).default('').refine(value => !value || /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value)), 'Ange ett giltigt datum.');
const rowSchema = z.object({ articleId: short.optional(), name: short, wasteCode: z.string().trim().max(20).default('').refine(value => !value || /^\d{6}$/.test(value.replace(/[ *]/g, '')), 'Avfallskoden ska ha sex siffror.'), weight: z.number().finite().positive().max(1e9).nullable() }).strict();
export const transportDocumentInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(), siteId: z.string().trim().min(1).max(100), direction: z.enum(['pickup', 'outbound']),
  sender: partySchema, receiver: partySchema, carrier: partySchema, driver: short, registration: short,
  startAt: dateText, requestedAt: dateText, handling: z.string().trim().max(5000).default(''), reference: short,
  rows: z.array(rowSchema).min(1).max(100),
}).strict();
function parse(schema, input) { const value = schema.safeParse(input); if (!value.success) fail(value.error.issues.map(issue => issue.message).join(' '), 422, 'invalid_input'); return value.data; }
const party = source => ({ name: source?.name ?? '', number: source?.number ?? '', address: source?.address ?? '', postalCode: source?.postalCode ?? '', city: source?.city ?? '' });
const siteFor = (sources, card) => (sources.sites ?? []).find(site => site.id === card?.siteId || !card?.siteId && site.name === card?.yard);
const companyFor = (sources, site) => ({ name: sources.company?.name ?? 'JEROC Återvinning AB', number: sources.company?.number ?? '', vat: sources.company?.vat ?? '', address: site?.address ?? sources.company?.address ?? '', postalCode: site?.postalCode ?? sources.company?.postalCode ?? '', city: site?.city ?? sources.company?.city ?? '' });
const latestApproval = (sources, cardId) => (sources.approvals ?? []).filter(approval => String(approval.cardId) === String(cardId)).sort((left, right) => right.version - left.version)[0];
const validApproved = approval => ['approved', 'attested'].includes(approval.status) && Boolean(approval.approvedAt && approval.approvedMethod) && approval.approvedHash === approval.snapshot.hash;
const titleFor = (kind, stage) => kind === 'transport' ? 'Transportdokument · utkast' : kind === 'receipt' ? 'Utbetalningskvitto · demo' : stage === 'final' ? 'Avräkningsnota · JEROC-attesterad' : stage === 'reviewed' ? 'Avräkningsnota · kundgodkänd, preliminär' : 'Avräkningsnota · preliminär';
export const documentMetadata = record => Object.fromEntries(Object.entries({ id: record.id, kind: record.kind, sourceId: record.sourceId, sourceVersion: record.sourceVersion, stage: record.stage, siteId: record.siteId, title: record.title, sourceHash: record.sourceHash, pdfHash: record.pdfHash, templateVersion: record.templateVersion, createdAt: record.createdAt, bytes: record.bytes, downloadUrl: `/api/documents/${encodeURIComponent(record.id)}/download` }).filter(([, value]) => value !== undefined));

function approvalSnapshot(approval, sources, stage) {
  const value = approval.snapshot, card = value.card, customer = value.customer;
  if (!value.hash || !card || !customer || !value.rows?.length) fail('Den låsta avräkningsversionen saknas.', 409, 'snapshot_missing');
  if (stage === 'reviewed' && !validApproved(approval) || stage === 'final' && !(approval.status === 'attested' && validApproved(approval) && approval.attestedAt)) fail(stage === 'final' ? 'Intern attest krävs före slutlig avräkningsnota.' : 'Kundgodkännande krävs för denna dokumentversion.', 409, 'approval_required');
  const site = siteFor(sources, { ...card, siteId: approval.siteId });
  if (!site) fail('Avräkningens anläggning saknas.', 409, 'site_missing');
  const payment = card.paymentDetails ?? customer.paymentProfile;
  const privateSeller = customer.type === 'Privatperson' || customer.kind === 'private' || customer.type === 'private';
  return {
    type: 'settlement', status: stage, id: `AV-${card.id}-V${approval.version}`, version: approval.version,
    issuedAt: stage === 'final' ? approval.attestedAt : stage === 'reviewed' ? approval.approvedAt : approval.createdAt,
    sourceId: String(card.id), sourceHash: value.hash, site: copy(site), company: companyFor(sources, site),
    customer: { ...party(customer), ...(privateSeller ? { number: '' } : {}), customerNumber: customer.customerNumber, type: customer.type },
    rows: value.rows.map(row => ({ articleId: row.articleId, name: row.name, weight: row.weight, price: row.price, amount: row.amount })),
    totalWeight: value.rows.reduce((sum, row) => sum + row.weight, 0), materialTotal: value.gross, adjustment: 0, settlementTotal: value.gross,
    gross: value.gross, offset: value.offset, net: value.net, reference: value.reference, origin: value.origin, deliveredAt: value.deliveredAt, receivedAt: value.deliveredAt,
    termsVersion: value.termsVersion,
    ...(stage !== 'preliminary' && validApproved(approval) ? { approval: { method: approval.approvedMethod ?? 'staff_checked_id_demo', person: approval.approvedBy, verifiedBy: approval.approvedBy, at: approval.approvedAt, version: approval.version } } : {}),
    ...(stage === 'final' ? { attest: { name: approval.attestedBy, at: approval.attestedAt } } : {}),
    payment: { method: payment?.method ?? value.paymentMethod, label: { bank: 'Bankkonto', swish: 'Swish', cash: 'Kontant', balance: 'Spara på saldo' }[value.paymentMethod], maskedAccount: payment?.account ? `•••• ${payment.account.replace(/\s/g, '').slice(-4)}` : '', recipient: payment?.holder ?? payment?.recipient ?? customer.name },
    tax: { mode: privateSeller ? 'private' : 'unverified', label: privateSeller ? 'Privat försäljning · inköpsnota' : 'Momshantering behöver fastställas' },
    selfBilling: { agreed: false }, demo: true,
  };
}
function missingTransport(draft) {
  const missing = [];
  for (const [key, label] of [['sender', 'Lämnare'], ['receiver', 'Mottagare'], ['carrier', 'Transportör']]) {
    if (!draft[key]?.name) missing.push(`${label}: namn`);
    if (!draft[key]?.address) missing.push(`${label}: adress`);
    if (!draft[key]?.number) missing.push(`${label}: organisationsnummer`);
  }
  if (!draft.startAt) missing.push('Transportdatum');
  if (!draft.driver) missing.push('Förare');
  if (!draft.registration) missing.push('Fordon');
  draft.rows.forEach((row, index) => { if (!row.name) missing.push(`Rad ${index + 1}: material`); if (!row.wasteCode) missing.push(`Rad ${index + 1}: avfallskod`); if (row.weight == null) missing.push(`Rad ${index + 1}: faktisk vikt`); });
  return missing;
}

/** Source callbacks run before archive transactions: never nest business/terminal DB locks. */
export function createDocumentService({ repository, sourceProvider, renderPdf, now = () => new Date(), templateVersion = DOCUMENT_TEMPLATE_VERSION }) {
  if (!repository || !sourceProvider || !renderPdf) throw new TypeError('Dokumentarkivet behöver databas, källadapter och PDF-renderare.');
  async function archive(snapshot, kind, sourceId, sourceVersion, stage, siteId, principal) {
    const sourceHash = snapshot.sourceHash ?? documentHash(snapshot);
    const key = { kind, sourceId: String(sourceId), sourceVersion, stage, sourceHash, templateVersion };
    const previous = await repository.transact(database => database.sameDocument(key));
    if (previous) return documentMetadata(previous);
    // Rendering can be expensive. Do it outside DB locks, then deduplicate under
    // the UNIQUE constraint so two processes cannot persist two originals.
    const pdf = Buffer.from(await renderPdf(copy(snapshot)));
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || pdf.length > 20 * 1024 * 1024) fail('PDF-filen kunde inte framställas.', 503, 'pdf_generation_failed');
    const record = { id: randomUUID(), ...key, siteId, title: titleFor(kind, stage), createdAt: now().toISOString(), createdBy: principal?.user?.id ?? 'system', actualUserId: principal?.actor?.id ?? 'system', pdfHash: documentHash(pdf), bytes: pdf.length, snapshot: copy(snapshot) };
    return repository.transact(async database => {
      const result = await database.insertDocument(record, pdf);
      if (result.inserted) await database.audit({ id: randomUUID(), at: record.createdAt, action: 'document.archived', documentId: record.id, kind, sourceId: String(sourceId), sourceHash, pdfHash: record.pdfHash, actualUserId: record.actualUserId, effectiveUserId: record.createdBy });
      return documentMetadata(result.record);
    });
  }
  async function frozenApprovalDocument(approval, sources, stage) {
    const snapshot = approvalSnapshot(approval, sources, stage);
    if (stage !== 'preliminary') {
      const originals = await repository.transact(database => database.documents('settlement', approval.cardId));
      const first = originals.find(record => record.stage === 'preliminary' && record.sourceVersion === approval.version && record.sourceHash === approval.snapshot.hash);
      if (first) { snapshot.company = copy(first.snapshot.company); snapshot.site = copy(first.snapshot.site); }
    }
    return snapshot;
  }
  function currentDraft(card, sources, principal, prior) {
    if (card.kind === 'correction') fail('Rättelsekort behöver ett separat granskat dokumentflöde.', 409, 'correction_flow');
    if (!card.customerId || !card.origin?.trim()) fail('Välj kund och fyll i ursprungsadress före förhandsvisningen.', 422, 'draft_incomplete');
    const customer = card.customerSnapshot ?? sources.office?.customers?.find(value => value.id === card.customerId);
    if (!customer) fail('Kunden saknas i serverns kundregister.', 409, 'customer_missing');
    if (card.financialPending || card.pricingRowsPending || !card.rows?.length || card.rows.some(row => row.pricePending || !Number.isFinite(row.price) || row.price < 0 || !Number.isFinite(row.weight) || row.weight <= 0)) fail('Beräkna och spara fullständiga priser innan avräkningen förhandsvisas.', 409, 'prices_required');
    const site = siteFor(sources, card);
    if (!site) fail('Viktkortets anläggning saknas.', 409, 'site_missing');
    const rows = card.rows.map(row => ({ articleId: row.articleId, name: row.articleName ?? sources.pricing?.articles?.find(article => article.id === row.articleId)?.name ?? row.articleId, weight: row.weight, price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 }));
    const gross = Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
    const cardCopy = copy(card); delete cardCopy.audit; delete cardCopy.customerApproval;
    const snapshot = { card: cardCopy, customer: copy(customer), rows, gross, offset: 0, net: gross, paymentMethod: card.paymentDetails?.method ?? customer.paymentProfile?.method,
      reference: card.reference, origin: card.origin, deliveredAt: card.date, termsVersion: 'Förhandsvisning före kundgranskning' };
    snapshot.hash = documentHash(snapshot);
    return { id: `draft-${card.id}-${snapshot.hash.slice(0, 24)}`, cardId: card.id, siteId: site.id, version: (prior?.version ?? 0) + 1, status: 'draft', createdAt: now().toISOString(), actualUserId: principal.actor.id, effectiveUserId: principal.user.id, snapshot };
  }
  async function settlementSources(cardId, principal) {
    const sources = await sourceProvider();
    const approval = latestApproval(sources, cardId);
    const card = sources.office?.cards?.find(card => String(card.id) === String(cardId)) ?? approval?.snapshot?.card;
    if (!card) fail('Viktkortet finns inte.', 404, 'source_not_found');
    const site = siteFor(sources, card);
    demandSettlement(principal, card.siteId ?? approval?.siteId ?? site?.id);
    return { sources, approval, card };
  }
  async function ensureApproval(approval, suppliedSources) {
    const sources = suppliedSources ?? await sourceProvider();
    // Public office DTOs omit parts of the signing proof. Hooks pass only the ID;
    // resolve the authoritative committed record, never trust caller PDF fields.
    const stored = sources.approvals?.find(value => value.id === approval.id);
    if (!stored) fail('Den sparade kundgranskningsversionen saknas.', 409, 'snapshot_missing');
    approval = stored;
    const actor = { actor: { id: approval.actualUserId ?? 'system' }, user: { id: approval.effectiveUserId ?? 'system' } };
    const stages = ['preliminary', ...(validApproved(approval) ? ['reviewed'] : []), ...(approval.status === 'attested' && approval.attestedAt && validApproved(approval) ? ['final'] : [])];
    const documents = [];
    for (const stage of stages) documents.push(await archive(await frozenApprovalDocument(approval, sources, stage), 'settlement', approval.cardId, approval.version, stage, approval.siteId, actor));
    return documents;
  }
  async function list({ kind, sourceId }, principal) {
    if (!['settlement', 'receipt', 'transport'].includes(kind) || !sourceId) fail('Ange dokumenttyp och käll-ID.', 422, 'invalid_input');
    if (kind === 'settlement') {
      const { sources, card } = await settlementSources(sourceId, principal);
      for (const approval of (sources.approvals ?? []).filter(value => String(value.cardId) === String(card.id) && visibleSite(principal, value.siteId))) await ensureApproval(approval, sources);
    } else if (kind === 'transport') { demandTransport(principal); const sources = await sourceProvider(); if (!sources.transport?.orders?.some(order => order.id === sourceId)) fail('Arbetsordern finns inte.', 404, 'source_not_found'); }
    else { await receiptSources(sourceId, principal); }
    return { documents: (await repository.transact(database => database.documents(kind, sourceId))).filter(record => visibleSite(principal, record.siteId)).map(documentMetadata), demo: true, storage: repository.kind };
  }
  async function generateSettlement(cardId, input, principal) {
    const { sources, approval: existing, card } = await settlementSources(cardId, principal);
    const stage = input?.stage ?? (existing?.status === 'attested' ? 'final' : existing && validApproved(existing) ? 'reviewed' : 'preliminary');
    if (!['preliminary', 'reviewed', 'final'].includes(stage)) fail('Ogiltig dokumentstatus.', 422, 'invalid_input');
    const useDraft = stage === 'preliminary' && (!existing || ['cancelled', 'expired', 'change_requested'].includes(existing.status) && ['new', 'complement'].includes(card.status));
    const approval = useDraft ? currentDraft(card, sources, principal, existing) : existing;
    if (!approval) fail('Kundgodkännande och intern attest behövs före denna dokumentversion.', 409, 'approval_required');
    demandSettlement(principal, approval.siteId);
    const snapshot = await frozenApprovalDocument(approval, sources, stage);
    return { document: await archive(snapshot, 'settlement', cardId, approval.version, stage, approval.siteId, principal), demo: true };
  }
  async function receiptSources(paymentId, principal) {
    const sources = await sourceProvider(), payment = sources.office?.payments?.find(value => String(value.id) === String(paymentId));
    if (!payment) fail('Utbetalningsjournalen saknar denna betalning.', 404, 'source_not_found');
    const card = sources.office.cards.find(value => value.id === payment.cardId), approval = card && latestApproval(sources, card.id);
    if (!card || !approval || approval.status !== 'attested') fail('Betalningen saknar verifierbart attesterat underlag.', 409, 'attest_required');
    demandSettlement(principal, approval.siteId);
    demandReceipt(principal);
    return { sources, payment, card, approval };
  }
  async function generateReceipt(paymentId, principal) {
    const { sources, payment, card, approval } = await receiptSources(paymentId, principal);
    const base = await frozenApprovalDocument(approval, sources, 'final');
    const snapshot = { ...base, type: 'receipt', status: 'final', id: payment.reference ?? `KV-${payment.id}`, sourceId: String(payment.id), sourceHash: documentHash({ approvalHash: approval.snapshot.hash, payment }), issuedAt: payment.date, net: payment.amount,
      payment: { ...base.payment, paidAt: payment.date, reference: payment.reference, recipient: base.customer.name, registeredBy: payment.actor, amount: payment.amount, offset: payment.offset ?? 0, label: 'Manuellt registrerad demoutbetalning' } };
    return { document: await archive(snapshot, 'receipt', paymentId, approval.version, 'final', approval.siteId, principal), demo: true };
  }
  async function initialTransport(orderId, principal) {
    demandTransport(principal);
    const sources = await sourceProvider(), order = sources.transport?.orders?.find(order => order.id === orderId);
    if (!order) fail('Arbetsordern finns inte.', 404, 'source_not_found');
    const saved = await repository.transact(database => database.transportDraft(orderId));
    if (saved) return { draft: { ...saved, missing: missingTransport(saved) }, sources, order };
    const site = sources.sites?.find(site => site.id === order.siteId) ?? sources.sites?.find(site => site.active !== false);
    if (!site) fail('Ange en mottagningsanläggning först.', 409, 'site_missing');
    const driver = sources.transport.drivers?.find(value => value.id === order.driverId);
    const carrier = sources.personnel?.companies?.find(value => value.id === driver?.companyId);
    const customer = sources.office?.customers?.find(value => value.id === order.customerId);
    const draft = { orderId, version: 0, siteId: site.id, direction: 'pickup', sender: { ...party(customer), name: customer?.name ?? order.customerName, address: order.address, city: order.city }, receiver: party(companyFor(sources, site)),
      carrier: carrier ? party(carrier) : driver && !driver.companyId ? party(companyFor(sources, site)) : party(), driver: driver?.name ?? '', registration: sources.transport.vehicles?.find(value => value.id === order.vehicleId)?.registration ?? '',
      startAt: order.date ?? '', requestedAt: order.requestedDate ?? '', handling: order.notes ?? '', reference: order.id, rows: [{ name: order.material ?? '', wasteCode: '', weight: null }], updatedAt: order.updatedAt };
    return { draft: { ...draft, missing: missingTransport(draft) }, sources, order };
  }
  async function transport(orderId, principal) { const { draft, sources } = await initialTransport(orderId, principal); return { draft, sites: sources.sites.filter(site => site.active !== false).map(site => ({ id: site.id, name: site.name, party: party(companyFor(sources, site)) })), documents: (await repository.transact(database => database.documents('transport', orderId))).map(documentMetadata), demo: true }; }
  async function saveTransport(orderId, input, principal) {
    demandTransport(principal); demand(principal, 'transportPlan');
    const request = parse(transportDocumentInputSchema, input), { sources } = await initialTransport(orderId, principal);
    if (!sources.sites?.some(site => site.id === request.siteId && site.active !== false)) fail('Välj en aktiv anläggning.', 422, 'site_missing');
    demandSite(principal, request.siteId);
    return repository.transact(async database => {
      await database.lockTransport(orderId);
      const current = await database.transportDraft(orderId);
      if ((current?.version ?? 0) !== request.expectedVersion) fail('Transportdokumentet ändrades i en annan session. Läs in den senaste versionen.', 409, 'version_conflict');
      const { expectedVersion, ...fields } = request;
      // Repeating an identical form creates no revision, but never accepts a stale version.
      if (current && documentHash(Object.fromEntries(Object.keys(fields).map(key => [key, current[key]]))) === documentHash(fields)) return { draft: { ...current, missing: missingTransport(current) }, demo: true };
      const draft = { orderId, version: expectedVersion + 1, ...fields, updatedAt: now().toISOString(), updatedBy: principal.user.id, actualUserId: principal.actor.id };
      await database.insertTransportDraft(draft); await database.audit({ id: randomUUID(), at: draft.updatedAt, action: 'transport_document.draft_saved', orderId, version: draft.version, actualUserId: principal.actor.id, effectiveUserId: principal.user.id });
      return { draft: { ...draft, missing: missingTransport(draft) }, demo: true };
    });
  }
  async function generateTransport(orderId, principal) {
    demandTransport(principal);
    const { draft, sources } = await initialTransport(orderId, principal);
    if (!draft.version) fail('Spara transportdokumentets uppgifter innan PDF skapas.', 409, 'draft_required');
    const site = sources.sites.find(site => site.id === draft.siteId);
    const snapshot = { type: 'transport', status: 'draft', id: `TD-${orderId}-V${draft.version}`, version: draft.version, issuedAt: draft.updatedAt, sourceId: orderId, sourceHash: documentHash(draft), site: copy(site), company: companyFor(sources, site), sender: draft.sender, receiver: draft.receiver, carrier: draft.carrier,
      rows: draft.rows.map(row => ({ ...row, wasteCode: row.wasteCode.replace(/[ *]/g, '') })), totalWeight: draft.rows.reduce((sum, row) => sum + (row.weight ?? 0), 0), reference: draft.reference, missing: draft.missing,
      transport: { direction: draft.direction, driver: draft.driver, registration: draft.registration, startAt: draft.startAt, requestedAt: draft.requestedAt, handling: draft.handling, signatures: [] }, demo: true };
    return { document: await archive(snapshot, 'transport', orderId, draft.version, 'draft', draft.siteId, principal), draft, demo: true };
  }
  async function download(documentId, principal) {
    authenticated(principal);
    const record = await repository.transact(database => database.document(documentId, true));
    if (!record) fail('Dokumentet finns inte.', 404, 'document_not_found');
    if (record.kind === 'transport') { demandTransport(principal); demandSite(principal, record.siteId); }
    else { demandSettlement(principal, record.siteId); if (record.kind === 'receipt') demandReceipt(principal); }
    if (documentHash(record.pdf) !== record.pdfHash) fail('Dokumentets kontrollsumma stämmer inte. Originalet lämnas orört.', 503, 'file_integrity_error');
    return record;
  }
  return { list, generateSettlement, generateReceipt, transport, saveTransport, generateTransport, download, ensureApproval };
}
