import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PricingError } from './pricing.mjs';
import { officeSchema, normalizeCustomerDetails, validateCustomerDetails, customerIdentityKey,
  normalizePhoneNumber, phoneNumberError, paymentDetailsSchema, normalizePaymentDetails, bankRecipientError,
  normalizeAddress, addressError, formatAddress } from '../dist-server/domain-models.mjs';

const TTL = 30 * 60_000, WINDOW = 15 * 60_000, ACTIVE = ['waiting', 'submitted', 'unknown'];
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const fail = (message, status = 409, code = 'customer_intake_conflict') => { throw Object.assign(new PricingError(message, status), { code }); };
const unavailable = () => fail('Kundformuläret är inte tillgängligt längre. Be personalen öppna ett nytt.', 410, 'customer_intake_unavailable');
const text = length => z.string().trim().max(length).regex(/^[^\u0000-\u001f\u007f]*$/, 'Ange vanlig text utan kontrolltecken.');
const uuid = z.string().uuid(), id = text(100).min(1), tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const customerSchema = z.object({ type: z.enum(['Företag', 'Privatperson', 'BRF']), name: text(200).min(1), number: text(40).min(1),
  phone: text(100), email: z.union([z.literal(''), text(200).email()]), address: text(500), postalCode: text(20), city: text(200),
  countryCode: z.literal('SE'), paymentProfile: paymentDetailsSchema.omit({ phone: true, recipient: true }).strict().refine(value => value.method === 'bank', 'Endast bankuppgifter kan lämnas i kundformuläret.').optional(),
  reference: text(200).optional(),
  originDetails: z.object({ address: text(300), postalCode: text(20), city: text(200), countryCode: z.literal('SE') }).strict().optional(),
}).strict();
const createSchema = z.object({ draftId: id, channel: z.enum(['terminal', 'sms']), terminalId: id.optional(), phone: text(100).optional(),
  requestId: uuid, expectedCustomerId: id.nullable().optional() }).strict();
const commandSchema = z.object({ id: uuid, requestId: uuid }).strict();
const submitSchema = z.object({ requestId: uuid, customer: customerSchema }).strict();
const can = (user, right) => user?.active !== false && Boolean(user?.id) && (user.level === 'Systemadmin' || user.level === 'VD' || user.permissions?.includes(right));
const domains = ['metadata', 'pricing', 'office', 'mobile', 'personnel', 'personnelAuth', 'employeeTime', 'fleet', 'transport', 'logistics', 'customerIntake'];
const domain = state => {
  state.customerIntake ??= { version: 1, sessions: [], requests: [], attempts: [], audit: [] };
  for (const key of ['sessions', 'requests', 'attempts', 'audit']) state.customerIntake[key] ??= [];
  return state.customerIntake;
};
const clearProposal = row => { delete row.proposal; };
const cancelRow = (row, status, at) => { row.status = status; row.closedAt = at; clearProposal(row); };
const draftSite = (state, draft) => draft?.siteId ?? state.metadata?.mobileDraftSites?.[draft?.id];
function bindingValid(state, row, { applied = false, ready = false } = {}) {
  const draft = state.mobile?.drafts?.find(value => value.id === row.draftId);
  return Boolean(draft && (ready || draft.status !== 'ready') && draft.number === row.draftNumber && draft.createdAt === row.draftCreatedAt
    && draftSite(state, draft) === row.siteId && (draft.customerId ?? null) === (applied ? row.appliedCustomerId : row.originalCustomerId));
}
/** Called by the normal mobile writer before assigning a changed draft. Rows,
 * weights and updatedAt deliberately do not participate in this capability. */
export function guardCustomerIntakeDraftChange(state, before, after, { now = () => new Date() } = {}) {
  if (!before || !state.customerIntake) return;
  const at = new Date(typeof now === 'function' ? now() : now).toISOString();
  const rows = state.customerIntake.sessions.filter(row => row.draftId === before.id && ACTIVE.includes(row.status));
  for (const row of rows) if (row.expiresAt <= at) cancelRow(row, 'expired', at);
  const unresolved = rows.filter(row => ACTIVE.includes(row.status));
  const selectionChanged = !after || (after.customerId ?? null) !== (before.customerId ?? null)
    || draftSite(state, after) !== draftSite(state, before) || after.createdAt !== before.createdAt || after.number !== before.number;
  if (selectionChanged) { for (const row of unresolved) cancelRow(row, 'cancelled', at); return; }
  if (after.status === 'ready' && before.status !== 'ready' && unresolved.length)
    fail('Granska kundens uppgifter eller avbryt kundformuläret innan vägningen färdigställs.', 409, 'customer_intake_pending');
}
function normalizedCustomer(input) {
  const parsed = customerSchema.safeParse(input);
  if (!parsed.success) fail(parsed.error.issues.map(issue => issue.message).join(' '), 422, 'customer_intake_invalid');
  const customer = normalizeCustomerDetails(parsed.data);
  customer.name = parsed.data.name.normalize('NFKC').trim(); customer.email = parsed.data.email.normalize('NFKC').trim();
  if (customer.reference !== undefined) customer.reference = customer.reference.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (customer.originDetails) {
    const issue = addressError(customer.originDetails); if (issue) fail(issue, 422, 'customer_intake_invalid');
    customer.originDetails = normalizeAddress(customer.originDetails);
    if (!formatAddress(customer.originDetails)) delete customer.originDetails;
  }
  if (customer.paymentProfile) {
    customer.paymentProfile = normalizePaymentDetails(customer.paymentProfile);
    const error = bankRecipientError(customer.paymentProfile); if (error) fail(error, 422, 'customer_intake_invalid');
  }
  const error = validateCustomerDetails(customer); if (error) fail(error, 422, 'customer_intake_invalid');
  if (!customerSchema.safeParse(customer).success) fail('Kontrollera de normaliserade kunduppgifternas längd och format.', 422, 'customer_intake_invalid');
  return customer;
}
const mobileCustomer = customer => Object.fromEntries(['id', 'name', 'type', 'number', 'phone', 'email', 'address', 'postalCode', 'city', 'countryCode',
  'vatRegistered', 'paymentTermDays', 'references', 'origins', 'registrations'].filter(key => customer[key] !== undefined).map(key => [key, clone(customer[key])]));
const patch = draft => Object.fromEntries(['id', 'customerId', 'reference', 'origin', 'originDetails', 'customerSelectionsSavedAt', 'updatedAt']
  .filter(key => draft[key] !== undefined).map(key => [key, clone(draft[key])]));

export function createCustomerIntakeService({ repository, authorizeStaff, terminalAccess, registerLink, deliverSms, companyProfileProvider,
  now = () => new Date() } = {}) {
  if (!repository?.read || !repository?.transact || typeof authorizeStaff !== 'function') throw new TypeError('Kundformuläret behöver bolagets lagring och personalbehörighet.');
  const at = () => new Date(typeof now === 'function' ? now() : now).toISOString();
  const smsConfigured = () => deliverSms?.configured === true && typeof deliverSms === 'function' && typeof registerLink === 'function';
  function audit(state, principal, action, row) {
    const data = domain(state); data.audit.push({ id: randomUUID(), at: at(), action, intakeId: row.id, draftId: row.draftId,
      actualUserId: principal?.actor.id, effectiveUserId: principal?.user.id });
    if (data.audit.length > 10_000) data.audit.splice(0, data.audit.length - 10_000);
  }
  async function staff(state, req, write, siteId) {
    const value = await authorizeStaff(req, state, { write }), principal = value?.principal ?? value;
    if (![principal?.actor, principal?.user].every(user => (write ? ['view', 'prepare', 'customers'] : ['view', 'prepare']).every(right => can(user, right))))
      fail('Både faktiskt och effektivt konto behöver behörighet att komplettera vägningar och kunder.', 403, 'customer_intake_forbidden');
    if (siteId && [principal.actor, principal.user].some(user => Array.isArray(user.siteIds) && !user.siteIds.includes(siteId)))
      fail('Vägningens anläggning ligger utanför din behörighet.', 403, 'customer_intake_forbidden');
    return principal;
  }
  const staffIdentity = principal => ({ actorId: principal.actor.id, userId: principal.user.id });
  function prune(state) {
    const data = domain(state), current = at(), cutoff = Date.parse(current) - WINDOW;
    for (const row of data.sessions) {
      if (ACTIVE.includes(row.status) && (row.expiresAt <= current || !bindingValid(state, row))) cancelRow(row, row.expiresAt <= current ? 'expired' : 'cancelled', current);
      if (row.channel === 'sms' && row.status === 'waiting' && ['reserved', 'sending'].includes(row.delivery?.status)
        && Date.parse(row.delivery.startedAt ?? row.createdAt) < Date.parse(current) - 120_000) { row.status = 'unknown'; row.delivery.status = 'unknown'; }
    }
    data.attempts = data.attempts.filter(value => Date.parse(value.at) > cutoff);
    const closed = data.sessions.filter(row => !ACTIVE.includes(row.status));
    const remove = new Set(closed.filter(row => Date.parse(row.closedAt ?? row.appliedAt ?? row.createdAt) < Date.parse(current) - 86_400_000).map(row => row.id));
    for (const row of closed.slice(0, Math.max(0, closed.length - 500))) remove.add(row.id);
    if (remove.size) { data.sessions = data.sessions.filter(row => !remove.has(row.id)); data.requests = data.requests.filter(row => !remove.has(row.intakeId)); }
  }
  function request(state, input, operation, principal, fingerprint) {
    const data = domain(state), old = data.requests.find(value => value.requestId === input.requestId);
    if (old && (old.operation !== operation || old.fingerprint !== fingerprint || old.actualUserId !== principal.actor.id || old.effectiveUserId !== principal.user.id))
      fail('Förfrågans ID används för en annan åtgärd.', 409, 'customer_intake_request_conflict');
    return old;
  }
  function remember(state, input, operation, principal, fingerprint, row) {
    domain(state).requests.push({ requestId: input.requestId, operation, fingerprint, intakeId: row.id,
      actualUserId: principal.actor.id, effectiveUserId: principal.user.id, at: at() });
  }
  function dto(state, row) {
    const matches = row.proposal ? state.office?.customers?.filter(value => customerIdentityKey(value.type, value.number) === customerIdentityKey(row.proposal.type, row.proposal.number)) ?? [] : [];
    const customer = row.originalCustomerId ? state.office?.customers?.find(value => value.id === row.originalCustomerId) : matches.length === 1 ? matches[0] : undefined;
    const proposal = row.proposal && Object.fromEntries(Object.entries(row.proposal).filter(([key]) => key !== 'paymentProfile'));
    return { id: row.id, draftId: row.draftId, channel: row.channel, status: row.status, expiresAt: row.expiresAt,
      ...(row.terminalName ? { terminalName: row.terminalName } : {}),
      ...(row.recipient ? { recipientMasked: `${row.recipient.slice(0, 3)}${'•'.repeat(Math.max(4, row.recipient.length - 5))}${row.recipient.slice(-2)}` } : {}),
      ...(proposal ? { proposal: clone(proposal), hasPaymentProfile: Boolean(row.proposal.paymentProfile),
        bankWillBeSaved: Boolean(row.proposal.paymentProfile && !customer?.paymentProfile) } : {}),
      ...(customer ? { existingCustomerName: customer.name } : {}) };
  }
  const publicDto = row => ({ intake: { id: row.id, status: row.status === 'unknown' ? 'waiting' : row.status, expiresAt: row.expiresAt }, company: { name: row.companyName } });
  async function terminal(state, row, identity, operation, callback) {
    if (typeof terminalAccess?.withIntakeTerminal !== 'function') fail('Kundterminalen är inte tillgänglig.', 503, 'customer_intake_terminal_unavailable');
    return terminalAccess.withIntakeTerminal({ terminalId: row.terminalId, siteId: row.siteId, intakeId: row.id,
      ...(row.terminalConnectionId ? { connectionId: row.terminalConnectionId } : {}), expiresAt: row.expiresAt, operation }, identity, callback);
  }
  async function release(state, row, identity) {
    if (row.channel !== 'terminal' || row.terminalReleased) return;
    // The terminal adapter reconciles expired/replaced reservations as a safe
    // no-op. Authentication failures must abort, never be swallowed inside a
    // shared PostgreSQL transaction.
    await terminal(state, row, identity, 'release', () => { row.terminalReleased = true; });
  }
  function liveRow(state, token) {
    if (!tokenSchema.safeParse(token).success) return unavailable();
    const row = domain(state).sessions.find(value => value.channel === 'sms' && value.tokenHash === hash(token));
    if (!row || row.expiresAt <= at() || !['waiting', 'submitted', 'unknown', 'applied'].includes(row.status)
      || !bindingValid(state, row, { applied: row.status === 'applied' })) return unavailable();
    return row;
  }
  function submitInState(state, row, input) {
    const parsed = submitSchema.safeParse(input);
    if (!parsed.success) fail('Kontrollera kunduppgifterna och försök igen.', 422, 'customer_intake_invalid');
    const customer = normalizedCustomer(parsed.data.customer), fingerprint = hash(customer);
    if (row.submission) {
      if (row.submission.requestId !== input.requestId || row.submission.fingerprint !== fingerprint)
        fail('Kunduppgifterna är redan lämnade. Be personalen öppna ett nytt formulär för att ändra dem.', 409, 'customer_intake_already_submitted');
      return publicDto(row);
    }
    if (!['waiting', 'unknown'].includes(row.status)) return unavailable();
    row.proposal = customer; row.submission = { requestId: input.requestId, fingerprint, at: at() }; row.status = 'submitted';
    audit(state, undefined, 'customer-intake.submitted', row);
    return publicDto(row);
  }
  const service = {
    async create(input, req) {
      const parsed = createSchema.safeParse(input);
      if (!parsed.success) fail('Välj vägning och sätt att öppna kundformuläret.', 422, 'customer_intake_invalid');
      input = parsed.data;
      if (input.channel === 'terminal' && (!input.terminalId || input.phone !== undefined)
        || input.channel === 'sms' && (input.terminalId !== undefined || !input.phone)) fail('Välj en kundterminal eller ett mobilnummer.', 422, 'customer_intake_invalid');
      if (input.channel === 'sms') { input.phone = normalizePhoneNumber(input.phone); const error = phoneNumberError(input.phone, { required: true }); if (error) fail(error, 422, 'customer_intake_invalid'); }
      if (input.channel === 'sms' && !smsConfigured()) fail('SMS-utskick är inte tillgängliga.', 503, 'customer_intake_sms_unavailable');
      const company = await companyProfileProvider?.(), token = input.channel === 'sms' ? randomBytes(32).toString('base64url') : undefined;
      let created;
      const reservation = await repository.transact(async state => {
        prune(state);
        const draft = state.mobile?.drafts?.find(value => value.id === input.draftId);
        if (!draft || draft.status === 'ready') fail('Välj en pågående vägning.', 409, 'customer_intake_draft_unavailable');
        const siteId = draftSite(state, draft); if (!siteId) fail('Vägningen saknar anläggning.', 422, 'customer_intake_invalid');
        const principal = await staff(state, req, true, siteId), fingerprint = hash(input);
        const old = request(state, input, 'create', principal, fingerprint);
        if (old) { const row = domain(state).sessions.find(value => value.id === old.intakeId); if (!row) return unavailable(); return { intake: dto(state, row) }; }
        if (input.expectedCustomerId !== undefined && input.expectedCustomerId !== (draft.customerId ?? null)) fail('Kundvalet ändrades. Läs in vägningen och försök igen.');
        for (const closed of domain(state).sessions.filter(row => row.draftId === draft.id && ['cancelled', 'expired'].includes(row.status)))
          await release(state, closed, staffIdentity(principal));
        if (domain(state).sessions.some(row => row.draftId === draft.id && ACTIVE.includes(row.status))) fail('Vägningen har redan ett öppet kundformulär.', 409, 'customer_intake_pending');
        if (domain(state).sessions.filter(row => ACTIVE.includes(row.status)).length >= 1000 || domain(state).requests.length >= 10_000)
          fail('Många kundformulär är öppna. Avsluta äldre förfrågningar och försök igen.', 429, 'customer_intake_capacity');
        const current = at(), row = { id: randomUUID(), draftId: draft.id, siteId, draftNumber: draft.number, draftCreatedAt: draft.createdAt,
          originalCustomerId: draft.customerId ?? null, channel: input.channel, status: 'waiting', createdAt: current,
          expiresAt: new Date(Date.parse(current) + TTL).toISOString(), companyName: String(company?.name || state.metadata?.organisation?.name || 'Företaget').slice(0, 200),
          createdBy: staffIdentity(principal), ...(token ? { tokenHash: hash(token), recipient: input.phone, delivery: { status: 'reserved' } } : { terminalId: input.terminalId }) };
        if (input.channel === 'sms') {
          const attempts = domain(state).attempts;
          if (attempts.length >= 100 || attempts.filter(value => value.actorId === principal.actor.id).length >= 20
            || attempts.filter(value => value.recipientHash === hash(input.phone)).length >= 5) fail('För många SMS-förfrågningar. Vänta en stund.', 429, 'customer_intake_rate_limit');
          attempts.push({ actorId: principal.actor.id, recipientHash: hash(input.phone), at: current });
        }
        const commit = terminalInfo => {
          if (terminalInfo) { row.terminalName = terminalInfo.name; row.terminalConnectionId = terminalInfo.connectionId; }
          domain(state).sessions.push(row); remember(state, input, 'create', principal, fingerprint, row); audit(state, principal, 'customer-intake.created', row);
          created = clone(row); return { intake: dto(state, row) };
        };
        return input.channel === 'terminal' ? terminal(state, row, staffIdentity(principal), 'claim', commit) : commit();
      });
      if (!created || created.channel !== 'sms') return reservation;
      let outcome = 'failed', attempted = false;
      try {
        await registerLink({ tokenHash: created.tokenHash, intakeId: created.id, expiresAt: created.expiresAt });
        const claimed = await repository.transact(async state => {
          const row = domain(state).sessions.find(value => value.id === created.id);
          if (!row || !ACTIVE.includes(row.status) || !bindingValid(state, row) || row.expiresAt <= at()) return false;
          await staff(state, req, true, row.siteId);
          row.delivery = { status: 'sending', startedAt: at() }; return true;
        });
        if (!claimed) return service.read({ draftId: input.draftId }, req).then(value => ({ intake: value.intake }));
        attempted = true;
        const receipt = await deliverSms({ to: created.recipient, requestId: input.requestId, companyName: created.companyName, token,
          intakeId: created.id, createdAt: created.createdAt, expiresAt: created.expiresAt });
        outcome = receipt?.status === 'unknown' ? 'unknown' : 'sent';
      } catch (error) { outcome = attempted && (error.code?.includes('outcome_unknown') || !Number.isInteger(error.status)) ? 'unknown' : 'failed'; }
      return repository.transact(async state => {
        const row = domain(state).sessions.find(value => value.id === created.id);
        if (!row) return { intake: reservation.intake };
        await staff(state, req, false, row.siteId);
        row.delivery = { ...row.delivery, status: outcome };
        if (['waiting', 'unknown'].includes(row.status)) row.status = outcome === 'sent' ? 'waiting' : outcome;
        return { intake: dto(state, row) };
      });
    },
    async read({ draftId }, req) {
      if (!id.safeParse(draftId).success) fail('Välj en vägning.', 422, 'customer_intake_invalid');
      return repository.transact(async state => {
        prune(state);
        const draft = state.mobile?.drafts?.find(value => value.id === draftId), rows = domain(state).sessions.filter(row => row.draftId === draftId), row = rows.at(-1);
        const siteId = draftSite(state, draft) ?? row?.siteId;
        if (!siteId) fail('Vägningen finns inte.', 404, 'customer_intake_draft_unavailable');
        const principal = await staff(state, req, false, siteId);
        for (const closed of rows.filter(value => ['cancelled', 'expired'].includes(value.status))) await release(state, closed, staffIdentity(principal));
        const terminals = typeof terminalAccess?.listIntakeTerminals === 'function' ? await terminalAccess.listIntakeTerminals(staffIdentity(principal), siteId) : [];
        return { intake: row ? dto(state, row) : null, terminals: terminals.map(value => ({ id: value.id, name: value.name, siteId: value.siteId, available: value.online === true && !value.busy })), smsConfigured: smsConfigured() };
      });
    },
    async cancel(input, req) {
      if (!commandSchema.safeParse(input).success) fail('Välj kundformuläret som ska avbrytas.', 422, 'customer_intake_invalid');
      return repository.transact(async state => {
        prune(state); const row = domain(state).sessions.find(value => value.id === input.id); if (!row) return unavailable();
        const principal = await staff(state, req, true, row.siteId), fingerprint = hash({ id: input.id });
        const old = request(state, input, 'cancel', principal, fingerprint);
        if (row.status === 'applied') fail('Kunduppgifterna är redan använda på vägningen.');
        if (!old) { cancelRow(row, 'cancelled', at()); remember(state, input, 'cancel', principal, fingerprint, row); audit(state, principal, 'customer-intake.cancelled', row); }
        await release(state, row, staffIdentity(principal)); return { intake: dto(state, row) };
      });
    },
    async apply(input, req) {
      if (!commandSchema.safeParse(input).success) fail('Välj kunduppgifterna som ska användas.', 422, 'customer_intake_invalid');
      return repository.transact(async (state, revision) => {
        prune(state); const row = domain(state).sessions.find(value => value.id === input.id); if (!row) return unavailable();
        const principal = await staff(state, req, true, row.siteId), fingerprint = hash({ id: input.id });
        request(state, input, 'apply', principal, fingerprint);
        if (row.status === 'applied') {
          if (!bindingValid(state, row, { applied: true, ready: true })) fail('Vägningens kund har ändrats. Läs in uppgifterna igen.');
          const customer = state.office.customers.find(value => value.id === row.appliedCustomerId);
          if (!customer) fail('Den kopplade kunden finns inte längre.');
          return { intake: dto(state, row), customer: mobileCustomer(customer), draftPatch: patch(state.mobile.drafts.find(value => value.id === row.draftId)), revision };
        }
        if (row.status !== 'submitted' || !row.proposal || row.expiresAt <= at() || !bindingValid(state, row)) return unavailable();
        const proposal = normalizedCustomer(row.proposal), identity = customerIdentityKey(proposal.type, proposal.number);
        const matches = state.office.customers.filter(value => customerIdentityKey(value.type, value.number) === identity);
        if (matches.length > 1) fail('Flera kunder har samma identitet. Kontrollera kundregistret innan uppgifterna används.', 409, 'customer_intake_ambiguous_customer');
        let customer = matches[0];
        if (row.originalCustomerId && customer?.id !== row.originalCustomerId) fail('Kundens identitet stämmer inte med vägningens kundval. Avbryt formuläret och välj rätt kund.', 409, 'customer_intake_identity_conflict');
        if (!customer) {
          if (proposal.paymentProfile && ![principal.actor, principal.user].every(user => can(user, 'paymentDetails')))
            fail('Både faktiskt och effektivt konto behöver behörighet att registrera betalningsuppgifter.', 403, 'customer_intake_payment_forbidden');
          const id = `customer-${randomUUID()}`, event = { at: at(), actor: principal.user.name ?? principal.user.id,
            actualUserId: principal.actor.id, effectiveUserId: principal.user.id, text: 'Kund skapad efter personalens granskning av kundformulär.' };
          customer = officeSchema.shape.customers.removeDefault().element.parse({ ...proposal, id, customerNumber: id,
            ...(proposal.type === 'Privatperson' ? { vatRegistered: false } : {}), contactPerson: '', references: [], origins: [], registrations: [], audit: [event] });
          state.office.customers.push(customer);
          state.pricing.customers = state.office.customers.map(({ id, name }) => ({ id, name }));
          state.mobile.customers = state.office.customers.map(mobileCustomer);
        } else if (!customer.paymentProfile && proposal.paymentProfile) {
          if (![principal.actor, principal.user].every(user => can(user, 'paymentDetails')))
            fail('Både faktiskt och effektivt konto behöver behörighet att registrera betalningsuppgifter.', 403, 'customer_intake_payment_forbidden');
          customer.paymentProfile = clone(proposal.paymentProfile);
          customer.audit = [...(customer.audit ?? []), { at: at(), actor: principal.user.name ?? principal.user.id,
            actualUserId: principal.actor.id, effectiveUserId: principal.user.id, text: 'Saknade bankuppgifter sparade efter personalens granskning av kundformulär.' }];
        }
        const draft = state.mobile.drafts.find(value => value.id === row.draftId);
        draft.customerId = customer.id; draft.customerSelectionsSavedAt = at();
        // Only the explicitly reviewed values from step four change the
        // weighing. Skipping that step preserves staff's current selections.
        if (proposal.reference) draft.reference = proposal.reference;
        if (proposal.originDetails) { draft.originDetails = clone(proposal.originDetails); draft.origin = formatAddress(proposal.originDetails); }
        const selectionKey = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('sv-SE');
        for (const [field, value, label] of [['references', proposal.reference, 'Referens'],
          ['origins', proposal.originDetails && formatAddress(proposal.originDetails), 'Ursprungsadress']]) {
          if (!value) continue;
          customer[field] ??= [];
          if (customer[field].some(previous => selectionKey(field === 'origins' ? formatAddress(previous) : previous) === selectionKey(value))) continue;
          customer[field].push(value);
          customer.audit ??= [];
          customer.audit.push({ at: at(), actor: principal.user.name ?? principal.user.id,
            actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
            text: `${label} sparad efter personalens granskning av kundformulär: ${value}.` });
        }
        state.mobile.customers = state.office.customers.map(mobileCustomer);
        row.status = 'applied'; row.appliedCustomerId = customer.id; row.appliedAt = at(); clearProposal(row);
        remember(state, input, 'apply', principal, fingerprint, row); audit(state, principal, 'customer-intake.applied', row);
        await release(state, row, staffIdentity(principal));
        return { intake: dto(state, row), customer: mobileCustomer(customer), draftPatch: patch(draft), revision };
      }, { committedRevision: true });
    },
    async publicRead(token) {
      const result = await repository.transact(state => {
        prune(state);
        try { return { value: publicDto(liveRow(state, token)) }; } catch (error) { return { error }; }
      });
      if (result.error) throw result.error; return result.value;
    },
    async submit(token, input) {
      const result = await repository.transact(state => {
        prune(state);
        try { return { value: submitInState(state, liveRow(state, token), input) }; } catch (error) { return { error }; }
      });
      if (result.error) throw result.error; return result.value;
    },
    async terminalRead(device) {
      return repository.transact(async state => {
        prune(state);
        for (const closed of domain(state).sessions.filter(value => value.channel === 'terminal' && value.terminalId === device?.id
          && value.siteId === device?.siteId && ['cancelled', 'expired'].includes(value.status))) await release(state, closed, device);
        const row = domain(state).sessions.find(value => value.channel === 'terminal' && value.terminalId === device?.id && value.siteId === device?.siteId && ACTIVE.includes(value.status));
        if (!row) return { intake: null };
        if (!bindingValid(state, row)) return unavailable();
        return terminal(state, row, device, 'use', () => publicDto(row));
      });
    },
    async terminalSubmit(device, input) {
      const parsed = z.object({ id: uuid, requestId: uuid, customer: customerSchema }).strict().safeParse(input);
      if (!parsed.success) fail('Kontrollera kunduppgifterna och försök igen.', 422, 'customer_intake_invalid');
      return repository.transact(async state => {
        prune(state); const row = domain(state).sessions.find(value => value.id === input.id && value.channel === 'terminal');
        if (!row || row.terminalId !== device?.id || row.siteId !== device?.siteId || !ACTIVE.includes(row.status) || !bindingValid(state, row)) return unavailable();
        return terminal(state, row, device, 'use', () => submitInState(state, row, { requestId: input.requestId, customer: input.customer }));
      });
    },
  };
  return Object.freeze(service);
}
