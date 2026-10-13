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
const demandTransport = (principal, siteId) => {
  authenticated(principal);
  if (!can(principal, 'transportRead') && !can(principal, 'workOrdersRead')) fail('Du saknar behörighet till transportdokument.', 403, 'forbidden');
  if (siteId) demandSite(principal, siteId);
  else if (Array.isArray(principal.user.siteIds)) fail('Äldre arbetsorder saknar säker anläggningsindelning. Dokumenten kräver tillgång till alla anläggningar.', 403, 'transport_scope_unavailable');
};
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
const companyFor = (sources, site) => {
  const company = sources.company;
  if (company?.id && company.id !== 'jeroc-demo' && !company.name?.trim())
    fail('Bolagets dokumentprofil saknar företagsnamn.', 409, 'company_identity_missing');
  return { ...(company?.id && { id: company.id }), name: company?.name ?? 'JEROC Återvinning AB', number: company?.number ?? '', vat: company?.vat ?? '', address: site?.address ?? company?.address ?? '', postalCode: site?.postalCode ?? company?.postalCode ?? '', city: site?.city ?? company?.city ?? '' };
};
const latestApproval = (sources, cardId) => (sources.approvals ?? []).filter(approval => String(approval.cardId) === String(cardId)).sort((left, right) => right.version - left.version)[0];
const validApproved = approval => ['approved', 'attested'].includes(approval.status) && Boolean(approval.approvedAt && approval.approvedMethod) && approval.approvedHash === approval.snapshot.hash;
const titleFor = (kind, stage, company) => kind === 'transport' ? stage === 'final' ? 'Transportdokument · registrerad avfärd, demo' : 'Transportdokument · utkast' : kind === 'receipt' ? 'Utbetalningskvitto · demo' : stage === 'final' ? company?.id && company.id !== 'jeroc-demo' ? 'Avräkningsnota · internt attesterad' : 'Avräkningsnota · JEROC-attesterad' : stage === 'reviewed' ? 'Avräkningsnota · kundgodkänd, preliminär' : 'Avräkningsnota · preliminär';
export const documentMetadata = record => Object.fromEntries(Object.entries({ id: record.id, kind: record.kind, sourceId: record.sourceId, sourceVersion: record.sourceVersion, stage: record.stage, siteId: record.siteId, title: record.title, sourceHash: record.sourceHash, pdfHash: record.pdfHash, templateVersion: record.templateVersion, createdAt: record.createdAt, bytes: record.bytes,
  pdfVersion: record.snapshot?.paymentRevision?.version ?? 1,
  ...(record.snapshot?.paymentRevision ? { originalDocumentId: record.snapshot.paymentRevision.originalDocumentId,
    replacesDocumentId: record.snapshot.paymentRevision.replacesDocumentId, paymentRevision: true } : {}),
  downloadUrl: `/api/documents/${encodeURIComponent(record.id)}/download` }).filter(([, value]) => value !== undefined));

function approvalSnapshot(approval, sources, stage) {
  const value = approval.snapshot, card = value.card, customer = value.customer;
  const accounting = card.accounting;
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
    totalWeight: value.rows.reduce((sum, row) => sum + row.weight, 0), materialTotal: accounting?.baseTotal ?? value.gross, adjustment: 0, settlementTotal: value.gross,
    gross: value.gross, offset: value.offset, net: value.net, reference: value.reference, origin: value.origin, deliveredAt: value.deliveredAt, receivedAt: value.deliveredAt,
    termsVersion: value.termsVersion,
    ...(stage !== 'preliminary' && validApproved(approval) ? { approval: { method: approval.approvedMethod ?? 'staff_checked_id_demo', person: approval.approvedBy, verifiedBy: approval.approvedBy, at: approval.approvedAt, version: approval.version } } : {}),
    ...(stage === 'final' ? { attest: { name: approval.attestedBy, at: approval.attestedAt } } : {}),
    payment: { method: payment?.method ?? value.paymentMethod, label: { bank: 'Bankkonto', swish: 'Swish', cash: 'Kontant', balance: 'Spara på saldo' }[value.paymentMethod], maskedAccount: payment?.account ? `•••• ${payment.account.replace(/\s/g, '').slice(-4)}` : '', recipient: payment?.holder ?? payment?.recipient ?? customer.name },
    tax: accounting ? {
      mode: accounting.sellerVat > 0 ? 'standard' : accounting.lines.some(line => line.treatment === 'reverse25') ? 'reverse' : privateSeller ? 'private' : 'none',
      label: accounting.sellerVat > 0 ? 'Moms debiteras enligt avräkningens materialrader' : accounting.lines.some(line => line.treatment === 'reverse25') ? 'Omvänd betalningsskyldighet' : 'Ingen moms debiteras',
      amount: accounting.sellerVat,
    } : { mode: privateSeller ? 'private' : 'unverified', label: privateSeller ? 'Privat försäljning · inköpsnota' : 'Momshantering behöver fastställas' },
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
  const readArchive = operation => (repository.read ?? repository.transact).call(repository, operation);
  const rendering = new Map();
  async function archive(snapshot, kind, sourceId, sourceVersion, stage, siteId, principal) {
    const sourceHash = snapshot.sourceHash ?? documentHash(snapshot);
    const key = { kind, sourceId: String(sourceId), sourceVersion, stage, sourceHash, templateVersion };
    const inFlightKey = JSON.stringify(key);
    if (rendering.has(inFlightKey)) return rendering.get(inFlightKey);
    const pending = archiveOnce(snapshot, key, siteId, principal);
    rendering.set(inFlightKey, pending);
    try { return await pending; } finally { if (rendering.get(inFlightKey) === pending) rendering.delete(inFlightKey); }
  }
  async function archiveOnce(snapshot, key, siteId, principal) {
    const { kind, sourceId, stage, sourceHash } = key;
    const previous = await readArchive(database => database.sameDocument(key));
    if (previous) return documentMetadata(previous);
    // Rendering can be expensive. Do it outside DB locks, then deduplicate under
    // the UNIQUE constraint so two processes cannot persist two originals.
    const pdf = Buffer.from(await renderPdf(copy(snapshot)));
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || pdf.length > 20 * 1024 * 1024) fail('PDF-filen kunde inte framställas.', 503, 'pdf_generation_failed');
    const record = { id: randomUUID(), ...key, siteId, title: `${titleFor(kind, stage, snapshot.company)}${snapshot.paymentRevision ? ' · uppdaterade betalningsuppgifter' : ''}`, createdAt: now().toISOString(), createdBy: principal?.user?.id ?? 'system', actualUserId: principal?.actor?.id ?? 'system', pdfHash: documentHash(pdf), bytes: pdf.length, snapshot: copy(snapshot) };
    return repository.transact(async database => {
      const result = await database.insertDocument(record, pdf);
      if (result.inserted) await database.audit({ id: randomUUID(), at: record.createdAt, action: snapshot.paymentRevision ? 'document.payment_revision_archived' : 'document.archived', documentId: record.id, kind, sourceId: String(sourceId), sourceHash, pdfHash: record.pdfHash, actualUserId: record.actualUserId, effectiveUserId: record.createdBy,
        ...(snapshot.paymentRevision ? { paymentJobId: snapshot.paymentRevision.jobId, pdfVersion: snapshot.paymentRevision.version,
          originalDocumentId: snapshot.paymentRevision.originalDocumentId, replacesDocumentId: snapshot.paymentRevision.replacesDocumentId,
          financialSourceHash: snapshot.paymentRevision.financialSourceHash, reason: snapshot.paymentRevision.reason } : {}) });
      return documentMetadata(result.record);
    });
  }
  async function frozenApprovalDocument(approval, sources, stage) {
    const snapshot = approvalSnapshot(approval, sources, stage);
    if (stage !== 'preliminary') {
      const originals = await readArchive(database => database.documents('settlement', approval.cardId));
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
    const sources = await sourceProvider({ kind: 'settlement', sourceId: String(cardId) });
    const approval = latestApproval(sources, cardId);
    const card = sources.office?.cards?.find(card => String(card.id) === String(cardId)) ?? approval?.snapshot?.card;
    if (!card) fail('Viktkortet finns inte.', 404, 'source_not_found');
    const site = siteFor(sources, card);
    demandSettlement(principal, card.siteId ?? approval?.siteId ?? site?.id);
    return { sources, approval, card };
  }
  async function ensureApproval(approval, suppliedSources) {
    const sources = suppliedSources ?? await sourceProvider({ kind: 'approval', sourceId: String(approval.cardId), approvalId: approval.id });
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
  // Server-only durable job entry point. Unlike a public DTO hook, this uses
  // the immutable signing milestone captured in the approval transaction. A
  // later cancellation cannot erase the customer's reviewed PDF original.
  async function archiveApprovalJob(approval, job) {
    if (!['preliminary', 'reviewed', 'final'].includes(job?.stage) || !approval?.snapshot?.hash ||
      job.sourceHash !== approval.snapshot.hash) fail('PDF-jobbets låsta underlag stämmer inte.', 409, 'snapshot_missing');
    // New durable jobs contain the exact facility used when the signing
    // milestone committed. No mutable office/terminal snapshot is needed here.
    const sources = job.siteSnapshot ? { sites: [copy(job.siteSnapshot)], ...(job.companySnapshot && { company: copy(job.companySnapshot) }) }
      : await sourceProvider({ kind: 'approval-job', siteId: approval.siteId });
    const actor = { actor: { id: approval.actualUserId ?? 'system' }, user: { id: approval.effectiveUserId ?? 'system' } };
    const snapshot = await frozenApprovalDocument(copy(approval), sources, job.stage);
    return archive(snapshot, 'settlement', approval.cardId, approval.version, job.stage, approval.siteId, actor);
  }
  /** A payment override is a new immutable PDF, never a new settlement or
   * invoice. Only the trusted, committed payment reservation calls this hook.
   * Re-read the signing proof and copy an archived original, so job/caller
   * fields cannot alter any customer, material, price, date or tax information. */
  async function archivePaymentRevision(job) {
    const source = job?.source;
    if (!job?.id || !source?.approvalId || !source.cardId || !source.hash || !job.paymentDetails ||
      source.hash !== job.sourceSnapshotHash || !job.sourceSnapshot ||
      !job.revisionActor?.actualUserId || !job.revisionActor?.effectiveUserId)
      fail('Betalningsrevisionen saknar en låst betalningsinstruktion.', 409, 'payment_revision_source_missing');
    const sources = await sourceProvider({ kind: 'approval', sourceId: String(source.cardId), approvalId: source.approvalId });
    const approval = sources.approvals?.find(value => value.id === source.approvalId && String(value.cardId) === String(source.cardId));
    if (!approval || approval.version !== source.version || approval.siteId !== source.siteId ||
      approval.snapshot.hash !== source.hash || approval.status !== 'attested' || !validApproved(approval) || !approval.attestedAt ||
      documentHash(approval.snapshot) !== documentHash(job.sourceSnapshot))
      fail('Betalningsrevisionens attestversion stämmer inte.', 409, 'payment_revision_source_changed');
    if (!['swish', 'bank', 'cash', 'balance'].includes(job.paymentDetails.method))
      fail('Betalningsrevisionens betalningssätt stöds inte.', 422, 'payment_revision_method_invalid');
    const normalizePayment = details => Object.fromEntries(['method', 'phone', 'recipient', 'personalNumber', 'bank', 'clearing', 'account', 'holder']
      .filter(key => details?.[key] !== undefined && details[key] !== '').map(key => [key, details[key]]));
    if (documentHash(normalizePayment(job.paymentDetails)) === documentHash(normalizePayment(job.originalPaymentDetails))) return null;
    if (!job.reason?.trim()) fail('Ange orsak till ändrade betalningsuppgifter.', 422, 'payment_revision_reason_required');
    const principal = { actor: { id: job.revisionActor.actualUserId }, user: { id: job.revisionActor.effectiveUserId } };
    let records = await readArchive(database => database.documents('settlement', source.cardId));
    const existing = records.find(record => record.snapshot?.paymentRevision?.jobId === job.id);
    if (existing) {
      if (existing.snapshot.paymentRevision.financialSourceHash !== source.hash ||
        existing.snapshot.paymentRevision.instructionHash !== documentHash(normalizePayment(job.paymentDetails)))
        fail('Betalningsjobbet används redan för andra uppgifter.', 409, 'payment_revision_conflict');
      return { documentId: existing.id, version: existing.snapshot.paymentRevision.version,
        originalDocumentId: existing.snapshot.paymentRevision.originalDocumentId, document: documentMetadata(existing) };
    }
    let original = records.find(record => record.stage === 'final' && record.sourceVersion === source.version && record.sourceHash === source.hash && !record.snapshot?.paymentRevision);
    if (!original) {
      const archived = await archive(await frozenApprovalDocument(approval, sources, 'final'), 'settlement', source.cardId, source.version, 'final', source.siteId, principal);
      original = await readArchive(database => database.document(archived.id));
      records = await readArchive(database => database.documents('settlement', source.cardId));
    }
    const previous = records.filter(record => record.stage === 'final' && record.sourceVersion === source.version &&
      (record.sourceHash === source.hash || record.snapshot?.paymentRevision?.financialSourceHash === source.hash))
      .sort((a, b) => (b.snapshot?.paymentRevision?.version ?? 1) - (a.snapshot?.paymentRevision?.version ?? 1))[0] ?? original;
    const version = (previous.snapshot?.paymentRevision?.version ?? 1) + 1;
    const details = job.paymentDetails;
    const snapshot = copy(original.snapshot);
    snapshot.payment = { ...snapshot.payment, method: details.method, label: { bank: 'Bankkonto', swish: 'Swish', cash: 'Kontant', balance: 'Spara på saldo' }[details.method],
      recipient: details.recipient ?? details.holder ?? snapshot.customer.name,
      maskedAccount: details.method === 'swish' && details.phone ? `•••• ${details.phone.slice(-4)}` : details.account ? `•••• ${details.account.replace(/\s/g, '').slice(-4)}` : '' };
    snapshot.paymentRevision = { version, jobId: job.id, originalDocumentId: original.id, replacesDocumentId: previous.id,
      financialSourceHash: source.hash, instructionHash: documentHash(normalizePayment(details)), at: job.createdAt,
      actor: copy(job.revisionActor), reason: job.reason.trim(), mode: job.mode === 'mss' ? 'mss' : 'test', simulation: true };
    snapshot.sourceHash = documentHash({ originalDocumentId: original.id, financialSourceHash: source.hash, jobId: job.id,
      instructionHash: snapshot.paymentRevision.instructionHash });
    const document = await archive(snapshot, 'settlement', source.cardId, source.version, 'final', source.siteId, principal);
    // Another worker may already have won the immutable INSERT for this job.
    // Return the persisted revision number, never a locally calculated loser.
    return { documentId: document.id, version: document.pdfVersion ?? version, originalDocumentId: document.originalDocumentId ?? original.id, document };
  }
  async function list({ kind, sourceId }, principal) {
    if (!['settlement', 'receipt', 'transport'].includes(kind) || !sourceId) fail('Ange dokumenttyp och käll-ID.', 422, 'invalid_input');
    let expected = [];
    if (kind === 'settlement') {
      const { sources, card } = await settlementSources(sourceId, principal);
      expected = (sources.approvals ?? []).filter(value => String(value.cardId) === String(card.id) && visibleSite(principal, value.siteId) && value.snapshot?.hash)
        .flatMap(approval => ['preliminary', ...(validApproved(approval) ? ['reviewed'] : []), ...(approval.status === 'attested' && approval.attestedAt && validApproved(approval) ? ['final'] : [])]
          .map(stage => ({ stage, sourceVersion: approval.version, sourceHash: approval.snapshot.hash })));
    } else if (kind === 'transport') { const sources = await sourceProvider({ kind: 'transport', sourceId }); const order = sources.transport?.orders?.find(order => order.id === sourceId); if (!order) fail('Arbetsordern finns inte.', 404, 'source_not_found'); demandTransport(principal, order.siteId); }
    else { await receiptSources(sourceId, principal); }
    const records = (await readArchive(database => database.documents(kind, sourceId))).filter(record => visibleSite(principal, record.siteId));
    const pending = expected.some(value => !records.some(record => record.stage === value.stage && record.sourceVersion === value.sourceVersion && record.sourceHash === value.sourceHash && record.templateVersion === templateVersion));
    return { documents: records.map(documentMetadata), pending, demo: true, storage: repository.kind };
  }
  async function generateSettlement(cardId, input, principal) {
    const { sources, approval: existing, card } = await settlementSources(cardId, principal);
    const stage = input?.stage ?? (existing?.status === 'attested' ? 'final' : existing && validApproved(existing) ? 'reviewed' : 'preliminary');
    if (!['preliminary', 'reviewed', 'final'].includes(stage)) fail('Ogiltig dokumentstatus.', 422, 'invalid_input');
    const useDraft = stage === 'preliminary' && (!existing || ['cancelled', 'expired', 'change_requested'].includes(existing.status) && ['new', 'complement'].includes(card.status));
    if (useDraft && card.rows?.some(row => !row.articleName)) {
      const names = await sourceProvider({ kind: 'article-names', articleIds: [...new Set(card.rows.filter(row => !row.articleName).map(row => row.articleId))] });
      sources.pricing = names.pricing;
    }
    const approval = useDraft ? currentDraft(card, sources, principal, existing) : existing;
    if (!approval) fail('Kundgodkännande och intern attest behövs före denna dokumentversion.', 409, 'approval_required');
    demandSettlement(principal, approval.siteId);
    if (stage === 'final') {
      if (approval.status !== 'attested' || !validApproved(approval) || !approval.attestedAt)
        fail('Intern attest krävs före slutlig avräkningsnota.', 409, 'approval_required');
      const revisions = (await readArchive(database => database.documents('settlement', cardId)))
        .filter(record => record.stage === 'final' && record.sourceVersion === approval.version && record.snapshot?.paymentRevision?.financialSourceHash === approval.snapshot.hash)
        .sort((a, b) => b.snapshot.paymentRevision.version - a.snapshot.paymentRevision.version);
      if (revisions[0]) return { document: documentMetadata(revisions[0]), demo: true };
    }
    const snapshot = await frozenApprovalDocument(approval, sources, stage);
    return { document: await archive(snapshot, 'settlement', cardId, approval.version, stage, approval.siteId, principal), demo: true };
  }
  async function receiptSources(paymentId, principal) {
    const sources = await sourceProvider({ kind: 'receipt', sourceId: String(paymentId) }), payment = sources.office?.payments?.find(value => String(value.id) === String(paymentId));
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
    const sources = await sourceProvider({ kind: 'transport', sourceId: orderId }), order = sources.transport?.orders?.find(order => order.id === orderId);
    if (!order) fail('Arbetsordern finns inte.', 404, 'source_not_found');
    demandTransport(principal, order.siteId);
    const detail = sources.logistics?.details?.[orderId];
    if (detail) {
      const frozen = detail.document?.snapshot;
      const driver = sources.transport.drivers?.find(value => value.id === (frozen?.driverId ?? detail.assignedDriverId ?? order.driverId));
      const carrier = sources.personnel?.companies?.find(value => value.id === (frozen?.carrierId ?? detail.carrierId ?? driver?.companyId));
      const site = sources.sites?.find(value => value.id === detail.siteId);
      const rows = frozen?.rows ?? detail.materialRows;
      const draft = { orderId, version: detail.document?.version ?? 0, siteId: detail.siteId,
        direction: order.action === 'outbound' ? 'outbound' : 'pickup', managed: true,
        sender: party(frozen?.from ?? detail.from), receiver: party(frozen?.to ?? detail.to),
        carrier: carrier ? party(carrier) : party(companyFor(sources, site)), driver: driver?.name ?? '',
        registration: sources.transport.vehicles?.find(value => value.id === (frozen?.vehicleId ?? detail.assignedVehicleId ?? order.vehicleId))?.registration ?? '',
        startAt: detail.execution.departedAt ?? order.date ?? detail.confirmedWindow?.date ?? '', requestedAt: detail.requestedWindow?.date ?? '',
        handling: frozen?.handling ?? detail.handling, reference: orderId,
        rows: rows.map(row => ({ articleId: row.articleId, name: row.name, wasteCode: row.wasteCode, weight: row.actualKg ?? row.plannedKg })),
        updatedAt: detail.document?.preparedAt ?? detail.updatedAt,
      };
      return { draft: { ...draft, missing: [] }, sources, order, detail };
    }
    const saved = await readArchive(database => database.transportDraft(orderId));
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
  async function transport(orderId, principal) { const { draft, sources } = await initialTransport(orderId, principal); return { draft, sites: sources.sites.filter(site => site.active !== false).map(site => ({ id: site.id, name: site.name, party: party(companyFor(sources, site)) })), documents: (await readArchive(database => database.documents('transport', orderId))).map(documentMetadata), demo: true }; }
  async function saveTransport(orderId, input, principal) {
    demand(principal, 'transportPlan');
    const request = parse(transportDocumentInputSchema, input), { sources, detail } = await initialTransport(orderId, principal);
    if (detail) fail('Ändra transportuppgifterna på arbetsordern. Dokument och underskrifter följer dess aktuella version.', 409, 'managed_document');
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
    const { draft, sources, detail } = await initialTransport(orderId, principal);
    if (!draft.version) fail('Spara transportdokumentets uppgifter innan PDF skapas.', 409, 'draft_required');
    if (detail) {
      const document = detail.document;
      const departed = ['departed', 'delivered'].includes(detail.execution.stage);
      const hazardous = document.snapshot.rows.some(row => row.hazardous);
      const validSignatures = document.signatures.filter(signature => signature.documentVersion === document.version && signature.documentHash === document.hash);
      if (departed && hazardous && !['sender', 'carrier'].every(role => validSignatures.some(signature => signature.role === role)))
        fail('Underskrifter för den aktuella transportversionen saknas.', 409, 'signature_required');
      const stage = departed ? 'final' : 'draft';
      const site = sources.sites.find(value => value.id === detail.siteId);
      const snapshot = { type: 'transport', status: stage, id: `TD-${orderId}-V${document.version}`, version: document.version,
        issuedAt: departed ? detail.execution.departedAt : document.preparedAt, sourceId: orderId,
        site: copy(site), company: companyFor(sources, site), sender: draft.sender, receiver: draft.receiver, carrier: draft.carrier,
        rows: draft.rows, totalWeight: draft.rows.reduce((sum, row) => sum + (row.weight ?? 0), 0), reference: orderId,
        origin: [draft.sender.address, draft.sender.postalCode, draft.sender.city].filter(Boolean).join(', '), missing: [],
        transport: { direction: draft.direction, driver: draft.driver, registration: draft.registration, startAt: draft.startAt,
          requestedAt: draft.requestedAt, handling: draft.handling,
          signatures: validSignatures.map(signature => ({ role: signature.role, person: signature.actorName, at: signature.at,
            method: 'Testbekräftelse · demo', version: signature.documentVersion })) }, demo: true };
      return { document: await archive(snapshot, 'transport', orderId, document.version, stage, detail.siteId, principal), draft, demo: true };
    }
    const site = sources.sites.find(site => site.id === draft.siteId);
    const snapshot = { type: 'transport', status: 'draft', id: `TD-${orderId}-V${draft.version}`, version: draft.version, issuedAt: draft.updatedAt, sourceId: orderId, sourceHash: documentHash(draft), site: copy(site), company: companyFor(sources, site), sender: draft.sender, receiver: draft.receiver, carrier: draft.carrier,
      rows: draft.rows.map(row => ({ ...row, wasteCode: row.wasteCode.replace(/[ *]/g, '') })), totalWeight: draft.rows.reduce((sum, row) => sum + (row.weight ?? 0), 0), reference: draft.reference, missing: draft.missing,
      transport: { direction: draft.direction, driver: draft.driver, registration: draft.registration, startAt: draft.startAt, requestedAt: draft.requestedAt, handling: draft.handling, signatures: [] }, demo: true };
    return { document: await archive(snapshot, 'transport', orderId, draft.version, 'draft', draft.siteId, principal), draft, demo: true };
  }
  async function download(documentId, principal) {
    authenticated(principal);
    const record = await readArchive(database => database.document(documentId, true));
    if (!record) fail('Dokumentet finns inte.', 404, 'document_not_found');
    if (record.kind === 'transport') { demandTransport(principal, record.siteId); }
    else { demandSettlement(principal, record.siteId); if (record.kind === 'receipt') demandReceipt(principal); }
    if (documentHash(record.pdf) !== record.pdfHash) fail('Dokumentets kontrollsumma stämmer inte. Originalet lämnas orört.', 503, 'file_integrity_error');
    return record;
  }
  return { list, generateSettlement, generateReceipt, transport, saveTransport, generateTransport, download, ensureApproval, archiveApprovalJob, archivePaymentRevision };
}
