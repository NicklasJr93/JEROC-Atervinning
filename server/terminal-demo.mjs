import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createPricingStore, PricingError, money } from './pricing.mjs';
import { createTerminalDemoRepository, TerminalDemoError } from './terminal-demo-storage.mjs';
import { afterDatabaseCommit } from './database-runtime.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

const expectedStaffIdentity = new AsyncLocalStorage();

const DEFAULT_SITES = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }];
const ACTIVE = ['waiting', 'id_requested'];
const STAFF_COOKIE = 'jeroc_terminal_demo_staff';
const TERMINAL_COOKIE = 'jeroc_terminal_demo_device';
const STAFF_AGE = 24 * 60 * 60 * 1000;
const TERMINAL_AGE = 30 * 24 * 60 * 60 * 1000;
const ONLINE_AGE = 35000;
const DISCONNECT_AGE = 90000;
const TERMS_VERSION = 'jeroc-demo-seller-v1';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const copy = (value) => structuredClone(value);
const text = z.string().trim().min(1).max(200);
const id = z.string().min(1).max(100);
const siteId = id.regex(/^[a-zA-Z0-9_-]+$/);
const password = z.string().min(8).max(128);
const username = z.string().trim().min(2).max(80).regex(/^[a-zA-Z0-9_.-]+$/).transform((value) => value.toLowerCase());
const paymentSchema = z.object({
  method: z.enum(['bank', 'swish', 'cash', 'balance']), bank: z.string().max(100).optional(),
  clearing: z.string().max(20).optional(), account: z.string().max(100).optional(),
  holder: z.string().max(200).optional(), phone: z.string().max(40).optional(), recipient: z.string().max(200).optional(),
});
const inputRow = z.object({
  articleId: id, weight: z.number().finite().positive().max(1e9), price: z.number().finite().nonnegative().max(1e9),
  tier: z.enum(['A', 'B', 'C', 'Eget']),
}).passthrough();
const customerSchema = z.object({
  id, name: text, type: z.enum(['Företag', 'Privatperson', 'BRF']),
  number: z.string().max(100), customerNumber: z.string().max(100),
  phone: z.string().max(100), email: z.string().max(200), address: z.string().max(500).optional(),
  paymentProfile: paymentSchema.optional(),
}).passthrough();
const cardSchema = z.object({
  id: z.number().int().nonnegative(), customerId: id,
  status: z.enum(['new', 'complement', 'customer', 'attest', 'ready', 'paid', 'balance']),
  kind: z.enum(['delivery', 'correction']).optional(),
  yard: text, siteId: siteId.optional(), date: z.string().max(100).refine((value) => Number.isFinite(Date.parse(value))),
  reference: z.string().max(1000), origin: z.string().trim().min(1).max(1000),
  pricingSnapshotId: id, rows: z.array(inputRow).min(1).max(100), paymentDetails: paymentSchema.optional(),
  audit: z.array(z.record(z.unknown())).max(1000).default([]),
}).passthrough();
const settlementRow = z.object({
  articleId: id, name: text, weight: z.number().finite().positive().max(1e9),
  price: z.number().finite().nonnegative().max(1e9), amount: z.number().finite().nonnegative().max(1e15),
}).strict();
const sendSchema = z.object({
  card: cardSchema, customer: customerSchema, terminalId: id, siteId,
  rows: z.array(settlementRow).min(1).max(100), offset: z.number().finite().nonnegative().max(1e15),
  correctionIds: z.array(z.number().int().nonnegative()).max(100), idempotencyKey: id,
}).strict();
const validate = (schema, payload) => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new TerminalDemoError('Kontrollera de ifyllda uppgifterna.');
  return parsed.data;
};
const can = (principal, right) => principal.user.level !== 'Medarbetare' || principal.user.permissions.includes(right);
const demand = (principal, ...rights) => {
  if (rights.some((right) => !can(principal, right))) throw new TerminalDemoError('Du saknar behörighet för detta moment.', 403, 'forbidden');
};
const canSeeMoney = (principal) => ['attest', 'pay', 'reports'].some((right) => can(principal, right))
  || ['prices', 'priceA', 'priceB', 'priceC', 'customerPrices'].every((right) => can(principal, right));
const demandMoney = (principal) => {
  if (!canSeeMoney(principal)) throw new TerminalDemoError('Du saknar behörighet att granska hela avräkningens priser.', 403, 'financial_visibility_required');
};
const demandAdmin = (principal) => {
  if (principal.user.level !== 'Systemadmin') throw new TerminalDemoError('Endast Systemadmin kan hantera kundterminaler.', 403, 'forbidden');
};
const allowedSites = (principal, sites) => sites.filter((site) => !Array.isArray(principal.user.siteIds) || principal.user.siteIds.includes(site.id));
const demandSite = (principal, value, sites) => {
  if (!allowedSites(principal, sites).some((site) => site.id === value)) throw new TerminalDemoError('Du saknar åtkomst till denna anläggning.', 403, 'forbidden');
};
const demandActiveSite = (principal, value, sites) => {
  demandSite(principal, value, sites);
  if (sites.find((site) => site.id === value)?.active === false) throw new TerminalDemoError('Anläggningen är avaktiverad. Välj en aktiv anläggning.', 409, 'site_inactive');
};
const passwordHash = (value) => {
  const salt = randomBytes(16).toString('hex');
  return { salt, digest: scryptSync(value, salt, 64).toString('hex') };
};
const checkPassword = (value, stored) => {
  const calculated = scryptSync(value, stored.salt, 64);
  const expected = Buffer.from(stored.digest, 'hex');
  return calculated.length === expected.length && timingSafeEqual(calculated, expected);
};
const audit = (state, now, action, principal, details = {}) => {
  state.revision += 1;
  state.audit.push({ id: randomUUID(), at: now.toISOString(), action,
    ...(principal ? { actualUserId: principal.actor.id, effectiveUserId: principal.user.id, actor: principal.user.name } : {}), ...details });
};
const activeApproval = (state, terminalId) => state.approvals.find((approval) => approval.terminalId === terminalId && ACTIVE.includes(approval.status));
const releaseApproval = (state, approval, status, now, principal, reason) => {
  approval.status = status; approval.updatedAt = now.toISOString();
  if (reason) approval.comment = reason;
  audit(state, now, `approval.${status}`, principal, { approvalId: approval.id, cardId: approval.cardId, version: approval.version });
};

function cleanup(state, now, sites) {
  state.staffSessions = state.staffSessions.filter((session) => Date.parse(session.expiresAt) > now.getTime());
  state.terminalSessions = state.terminalSessions.filter((session) => Date.parse(session.expiresAt) > now.getTime());
  state.loginAttempts = state.loginAttempts.filter((attempt) => Date.parse(attempt.at) > now.getTime() - 10 * 60 * 1000);
  for (const approval of state.approvals.filter((value) => ACTIVE.includes(value.status))) {
    const terminal = state.terminals.find((value) => value.id === approval.terminalId);
    if (Date.parse(approval.expiresAt) <= now.getTime() || !terminal?.active
      || !sites.some((site) => site.id === approval.siteId && site.active !== false)
      || (terminal.lastSeen && now.getTime() - Date.parse(terminal.lastSeen) > DISCONNECT_AGE)) {
      releaseApproval(state, approval, 'expired', now, undefined, 'Kundvisningen har gått ut. Skicka en ny kundvisning.');
    }
  }
}

function terminalDTO(state, terminal, now, sites) {
  const approval = activeApproval(state, terminal.id);
  const hasSession = state.terminalSessions.some((session) => session.terminalId === terminal.id && Date.parse(session.expiresAt) > now.getTime());
  return { id: terminal.id, name: terminal.name, username: terminal.username, siteId: terminal.siteId,
    active: terminal.active, online: terminal.active && sites.some((site) => site.id === terminal.siteId && site.active !== false) && hasSession && Boolean(terminal.lastSeen) && now.getTime() - Date.parse(terminal.lastSeen) < ONLINE_AGE,
    busy: Boolean(approval), ...(approval ? { activeApprovalId: approval.id } : {}), ...(terminal.lastSeen ? { lastSeen: terminal.lastSeen } : {}) };
}

function approvalDTO(approval, principal, revision) {
  const result = copy(approval);
  if (revision !== undefined) result.revision = revision;
  delete result.expiresAt; delete result.correctionIds; delete result.approvedHash; delete result.approvedMethod; delete result.siteSnapshot;
  // The original persisted review snapshot is never mutated. These OfficeCard
  // fields form a workflow projection for existing office queues only.
  result.snapshot.card.status = approval.status === 'approved' ? 'attest'
    : approval.status === 'attested' ? (approval.snapshot.paymentMethod === 'balance' ? 'balance' : 'ready')
      : ACTIVE.includes(approval.status) ? 'customer' : 'complement';
  result.snapshot.card.preparedBy = approval.effectiveUserId;
  if (approval.approvedAt) result.snapshot.card.idVerified = true;
  if (approval.attestedUserId) result.snapshot.card.approvedBy = approval.attestedUserId;
  result.snapshot.card.audit = [
    ...result.snapshot.card.audit,
    { at: approval.createdAt, actor: approval.sentBy, actualUserId: approval.actualUserId, effectiveUserId: approval.effectiveUserId,
      text: `Avräkning version ${approval.version} fryst och visad för kund på terminal.` },
    ...(approval.approvedAt ? [{ at: approval.approvedAt, actor: approval.approvedBy,
      text: `Kundgodkännande version ${approval.version} bekräftat efter kontroll av fysisk legitimation.` }] : []),
    ...(approval.attestedAt ? [{ at: approval.attestedAt, actor: approval.attestedBy,
      text: `Avräkning version ${approval.version} internt attesterad av JEROC. Utbetalning hanteras separat.` }] : []),
  ];
  delete result.attestedUserId;
  if (!['paymentDetails', 'pay', 'attest'].some((right) => can(principal, right))) {
    // Price visibility does not grant access to payment credentials. Redact all
    // copies on this response only; the frozen original and its hash remain
    // unchanged for authorized accounting staff and later workflow checks.
    for (const owner of [result.snapshot.card, result.snapshot.card.customerSnapshot, result.snapshot.customer]) {
      if (!owner) continue;
      if (owner.paymentDetails) owner.paymentDetails = { method: result.snapshot.paymentMethod };
      if (owner.paymentProfile) owner.paymentProfile = { method: result.snapshot.paymentMethod };
    }
    result.snapshot.card.payment = { bank: 'Bankkonto', swish: 'Swish', cash: 'Kontant', balance: 'Spara på saldo' }[result.snapshot.paymentMethod];
  }
  return result;
}

function publicApproval(approval, revision) {
  if (!approval) return null;
  const snapshot = approval.snapshot;
  return { id: approval.id, version: approval.version, status: approval.status, updatedAt: approval.updatedAt, ...(revision === undefined ? {} : {revision}), ...(approval.displayedAt ? {displayedAt:approval.displayedAt} : {}),
    snapshot: { cardId: approval.cardId, version: approval.version, customerName: snapshot.customer.name,
      customerNumber: snapshot.customer.customerNumber, siteName: snapshot.card.yard,
      rows: copy(snapshot.rows), gross: snapshot.gross, offset: snapshot.offset, net: snapshot.net,
      paymentMethod: snapshot.paymentMethod, reference: snapshot.reference, origin: snapshot.origin,
      deliveredAt: snapshot.deliveredAt, termsVersion: snapshot.termsVersion, hash: snapshot.hash } };
}

/** A shared DEMO service: office identities are deliberately selected demo users,
 * not production authentication. Terminal passwords and sessions are real, and
 * business state always commits to the configured durable database. */
export function createTerminalDemoStore({ repository, principalStore = createPricingStore(), siteProvider = () => DEFAULT_SITES, environmentApprovalCheck, now = () => new Date(), approvalAge = 15 * 60 * 1000 } = {}) {
  if (!repository) throw new Error('A durable terminal repository is required.');
  const presenceTimers = new Map();
  const schedulePresenceExpiry = terminalId => {
    const previous=presenceTimers.get(terminalId);
    if(previous){clearTimeout(previous.offline);clearTimeout(previous.disconnected);}
    const offline=setTimeout(()=>{
      // This invalidation carries no device/customer fields. A different
      // instance may have refreshed presence meanwhile; readers recheck it.
      void repository.events?.publish({domain:'terminal-presence',revision:now().getTime()}).catch(()=>{});
    },ONLINE_AGE+1);offline.unref();
    const disconnected=setTimeout(()=>{
      presenceTimers.delete(terminalId);
      void service.sweep().catch(()=>{});
    },DISCONNECT_AGE+1);disconnected.unref();
    presenceTimers.set(terminalId,{offline,disconnected});
  };
  const transaction = async (operation) => {
    // The persisted environment catalog is read per operation. A shared mutable
    // cache could leak a concurrent request's facility scope or stale settings.
    const catalog = (await siteProvider()).map(site => ({ ...site, id: site.id, name: site.name, active: site.active !== false }));
    // Obtain the immutable catalog before taking the terminal reservation lock.
    // Awaiting another repository while holding SQLite's synchronous lock would
    // block a concurrent local connection from completing its transaction.
    const run = () => repository.transact((state) => {
      const time = now(); cleanup(state, time, catalog); return operation(state, time, catalog);
    });
    return principalStore.runFresh ? principalStore.runFresh(run) : run();
  };
  const readOperation = async (operation, options) => {
    return (repository.read ?? repository.transact).call(repository, state => {
      const run = async () => {
        // These reads share one PostgreSQL snapshot, including current staff
        // permissions and facility scope. SQLite reads hold no write lock.
        const catalog = (await siteProvider()).map(({id:siteId,name,active}) => ({id:siteId,name,active:active!==false}));
        const value = copy(state), time = now(); cleanup(value,time,catalog);
        return operation(value,time,catalog);
      };
      return principalStore.runFresh ? principalStore.runFresh(run) : run();
    },options);
  };
  const staff = (state, value, time) => {
    if (!value) throw new TerminalDemoError('Välj ett demokonto på kontoret.', 401, 'staff_session_required');
    const session = state.staffSessions.find((item) => item.tokenHash === hash(value) && Date.parse(item.expiresAt) > time.getTime());
    if (!session) throw new TerminalDemoError('Kontorets demosession har gått ut. Logga in igen.', 401, 'staff_session_required');
    // Re-resolve on every call: revoking a permission takes effect immediately.
    const expected = expectedStaffIdentity.getStore();
    if (expected && (expected.actualUserId !== session.actualUserId || expected.effectiveUserId !== session.effectiveUserId))
      throw new TerminalDemoError('Kontorets aktiva användare har ändrats. Försök igen i den aktuella vyn.',409,'staff_identity_changed');
    return principalStore.principal(session.actualUserId, session.effectiveUserId);
  };
  const device = (state, value, time, seen = false) => {
    const session = value && state.terminalSessions.find((item) => item.tokenHash === hash(value) && Date.parse(item.expiresAt) > time.getTime());
    const terminal = session && state.terminals.find((item) => item.id === session.terminalId && item.active);
    if (!terminal) throw new TerminalDemoError('Logga in på terminalen.', 401, 'terminal_session_required');
    if (seen) terminal.lastSeen = time.toISOString();
    return terminal;
  };
  const getApproval = (state, approvalId, principal, sites) => {
    const approval = state.approvals.find((item) => item.id === approvalId);
    if (!approval) throw new TerminalDemoError('Kundvisningen finns inte.', 404, 'not_found');
    demandSite(principal, approval.siteId, sites); return approval;
  };
  const findTerminal = (state, terminalId, principal, sites) => {
    const terminal = state.terminals.find((item) => item.id === terminalId);
    if (!terminal) throw new TerminalDemoError('Terminalen finns inte.', 404, 'not_found');
    demandSite(principal, terminal.siteId, sites); return terminal;
  };
  const cancelTerminal = (state, terminalId, time, principal, reason) => {
    state.terminalSessions = state.terminalSessions.filter((session) => session.terminalId !== terminalId);
    const approval = activeApproval(state, terminalId);
    if (approval) releaseApproval(state, approval, 'cancelled', time, principal, reason);
  };
  const service = {
    projections: cardId => readOperation(state => state.approvals.map(approval => approvalDTO(approval, {user: {level: "Systemadmin"}},state.revision)),{projections:true,...(cardId===undefined?{}:{cardId})}),
    // Internal document source only. Never return confirmation hashes or private
    // approval fields through the public terminal API.
    documentProjections: () => readOperation(state => structuredClone(state.approvals),{projections:true}),
    repository,
    // Server-only callback. Holding the terminal aggregate lock prevents a
    // cancelled/superseded customer version from winning a concurrent receipt.
    withApprovedCard(input, operation) {
      return transaction(async (state) => {
        const approval = state.approvals.filter(item => item.cardId === input.cardId).at(-1);
        if (!approval || approval.snapshot.card.sourceId !== input.sourceId || approval.siteId !== input.siteId)
          throw new TerminalDemoError('Kunden behöver godkänna kortets aktuella avräkning före mottagningsbekräftelse.', 409, 'customer_approval_required');
        if (input.approvalExceptionReason) {
          if (approval.status !== 'change_requested') throw new TerminalDemoError('En mottagningsavvikelse kan bara registreras när kunden begärt ändring.', 409, 'receipt_exception_not_allowed');
        } else if (!['approved', 'attested'].includes(approval.status) || approval.approvedHash !== approval.snapshot.hash)
          throw new TerminalDemoError('Kunden behöver godkänna kortets aktuella avräkning före mottagningsbekräftelse.', 409, 'customer_approval_required');
        if (!input.approvalExceptionReason && (input.originAddress ?? input.lastPlace.address).trim() !== approval.snapshot.origin.trim())
          throw new TerminalDemoError('Ursprunget har ändrats efter kundens avräkning. Skicka en ny version för kundgodkännande.', 409, 'customer_approval_mismatch');
        return operation(copy(approval));
      });
    },
    async staffSession(payload, previousToken) {
      const request = validate(z.object({ actualUserId: id, effectiveUserId: id }).strict(), payload);
      const principal = principalStore.principal(request.actualUserId, request.effectiveUserId);
      const secret = token();
      await transaction((state, time, catalog) => {
        if (previousToken) state.staffSessions = state.staffSessions.filter((session) => session.tokenHash !== hash(previousToken));
        state.staffSessions.push({ tokenHash: hash(secret), ...request, expiresAt: new Date(time.getTime() + STAFF_AGE).toISOString() });
      });
      return { token: secret, result: { demo: true, actualUserId: principal.actor.id, effectiveUserId: principal.user.id } };
    },
    read(staffToken, filterSite) {
      return readOperation((state, time, catalog) => {
        const principal = staff(state, staffToken, time); demand(principal, 'customerApprovalRead');
        if (filterSite && filterSite !== 'all') demandSite(principal, filterSite, catalog);
        const sites = allowedSites(principal, catalog).filter((site) => !filterSite || filterSite === 'all' || site.id === filterSite);
        const visible = new Set(sites.map((site) => site.id));
        return { configured: true, actualUserId:principal.actor.id, effectiveUserId:principal.user.id, revision: state.revision, sites: copy(sites),
          terminals: state.terminals.filter((terminal) => visible.has(terminal.siteId)).map((terminal) => terminalDTO(state, terminal, time, catalog)),
          approvals: canSeeMoney(principal) ? state.approvals.filter((approval) => visible.has(approval.siteId)).map((approval) => approvalDTO(approval, principal,state.revision)) : [],
          defaults: state.defaults.filter((value) => visible.has(value.siteId) && (value.userId === principal.user.id || principal.user.level === 'Systemadmin')).map(copy) };
      },{staffState:true,staffHash:hash(staffToken??''),...(filterSite&&filterSite!=='all'?{siteId:filterSite}:{})});
    },
    createTerminal(payload, staffToken) {
      const request = validate(z.object({ name: text, username, password, siteId }).strict(), payload);
      const secret = passwordHash(request.password);
      return transaction((state, time, catalog) => {
        const principal = staff(state, staffToken, time); demandAdmin(principal); demandActiveSite(principal, request.siteId, catalog);
        if (state.terminals.some((terminal) => terminal.username === request.username)) throw new TerminalDemoError('Inloggningsnamnet används redan.', 409, 'username_taken');
        if (state.terminals.length >= 100) throw new TerminalDemoError('Demon har redan 100 terminaler.', 409, 'demo_limit');
        const terminal = { id: randomUUID(), name: request.name, username: request.username, siteId: request.siteId, active: true, password: secret };
        state.terminals.push(terminal); audit(state, time, 'terminal.created', principal, { terminalId: terminal.id });
        return terminalDTO(state, terminal, time, catalog);
      });
    },
    updateTerminal(terminalId, payload, staffToken) {
      const request = validate(z.object({ name: text.optional(), active: z.boolean().optional(), password: password.optional() }).strict(), payload);
      const secret = request.password ? passwordHash(request.password) : undefined;
      return transaction((state, time, catalog) => {
        const principal = staff(state, staffToken, time); demandAdmin(principal);
        const terminal = findTerminal(state, terminalId, principal, catalog);
        if (request.active === true) demandActiveSite(principal, terminal.siteId, catalog);
        if (request.name) terminal.name = request.name;
        if (request.active !== undefined) terminal.active = request.active;
        if (secret) terminal.password = secret;
        if (secret || request.active === false) cancelTerminal(state, terminal.id, time, principal, secret ? 'Terminalens lösenord återställdes.' : 'Terminalen avaktiverades.');
        audit(state, time, secret ? 'terminal.password_reset' : 'terminal.updated', principal, { terminalId });
        return terminalDTO(state, terminal, time, catalog);
      });
    },
    releaseTerminal(terminalId, staffToken) {
      return transaction((state, time, catalog) => {
        const principal = staff(state, staffToken, time); demandAdmin(principal);
        const terminal = findTerminal(state, terminalId, principal, catalog);
        cancelTerminal(state, terminalId, time, principal, 'Systemadmin avslutade terminalsessionen.');
        audit(state, time, 'terminal.session_released', principal, { terminalId }); return terminalDTO(state, terminal, time, catalog);
      });
    },
    defaultTerminal(payload, staffToken) {
      const request = validate(z.object({ siteId, terminalId: id.nullable() }).strict(), payload);
      return transaction((state, time, catalog) => {
        const principal = staff(state, staffToken, time); demand(principal, 'prepare'); demandSite(principal, request.siteId, catalog);
        if (request.terminalId) {
          demandActiveSite(principal, request.siteId, catalog);
          const terminal = findTerminal(state, request.terminalId, principal, catalog);
          if (!terminal.active || terminal.siteId !== request.siteId) throw new TerminalDemoError('Välj en aktiv terminal på rätt anläggning.');
        }
        state.defaults = state.defaults.filter((value) => value.userId !== principal.user.id || value.siteId !== request.siteId);
        if (request.terminalId) state.defaults.push({ userId: principal.user.id, ...request });
        audit(state, time, 'terminal.default_updated', principal, { siteId: request.siteId, terminalId: request.terminalId });
        return { saved: true };
      });
    },
    async login(payload, previousToken, source = '') {
      const request = validate(z.object({ username, password: z.string().min(1).max(128) }).strict(), payload);
      const secret = token(); const attemptKey = hash(`${request.username}:${source}`);
      // Failed attempts must commit instead of rolling back with a thrown error.
      const result = await transaction((state, time, catalog) => {
        if (state.loginAttempts.filter((attempt) => attempt.key === attemptKey).length >= 5) return { error: new TerminalDemoError('För många inloggningsförsök. Vänta tio minuter.', 429, 'rate_limited') };
        const terminal = state.terminals.find((value) => value.username === request.username && value.active);
        const fallback = { salt: 'unavailable-terminal-demo', digest: '00'.repeat(64) };
        const valid = checkPassword(request.password, terminal?.password ?? fallback);
        if (!terminal || !valid) {
          state.loginAttempts.push({ key: attemptKey, at: time.toISOString() });
          return { error: new TerminalDemoError('Fel inloggningsnamn eller lösenord.', 401, 'invalid_credentials') };
        }
        if (!catalog.some((site) => site.id === terminal.siteId && site.active !== false)) return { error: new TerminalDemoError('Anläggningen är avaktiverad. Kontakta Systemadmin.', 409, 'site_inactive') };
        const active = state.terminalSessions.find((session) => session.terminalId === terminal.id);
        if (active && (!previousToken || active.tokenHash !== hash(previousToken))) return { error: new TerminalDemoError('Terminalkontot används redan på en annan enhet. Be Systemadmin avsluta sessionen.', 409, 'terminal_session_in_use') };
        state.terminalSessions = state.terminalSessions.filter((session) => session.terminalId !== terminal.id);
        state.loginAttempts = state.loginAttempts.filter((attempt) => attempt.key !== attemptKey);
        state.terminalSessions.push({ terminalId: terminal.id, tokenHash: hash(secret), expiresAt: new Date(time.getTime() + TERMINAL_AGE).toISOString() });
        terminal.lastSeen = time.toISOString(); audit(state, time, 'terminal.login', undefined, { terminalId: terminal.id });
        return { revision:state.revision, connectionId:hash(state.terminalSessions.find(session=>session.terminalId===terminal.id)?.tokenHash ?? terminal.id).slice(0,24), terminal: terminalDTO(state, terminal, time, catalog), siteName: catalog.find((site) => site.id === terminal.siteId)?.name ?? terminal.siteId,
          approval: publicApproval(activeApproval(state, terminal.id),state.revision) };
      });
      if (result.error) throw result.error;
      return { token: secret, result };
    },
    session(deviceToken) {
      return readOperation((state, time, catalog) => {
        const terminal = device(state, deviceToken, time);
        return { revision:state.revision, connectionId:hash(state.terminalSessions.find(session=>session.terminalId===terminal.id)?.tokenHash ?? terminal.id).slice(0,24), terminal: terminalDTO(state, terminal, time, catalog), siteName: catalog.find((site) => site.id === terminal.siteId)?.name ?? terminal.siteId,
          approval: publicApproval(activeApproval(state, terminal.id),state.revision) };
      },{deviceHash:hash(deviceToken??'')});
    },
    async heartbeat(deviceToken) {
      const terminalId=await readOperation((state,time)=>device(state,deviceToken,time,false).id,{deviceHash:hash(deviceToken??'')});
      await repository.touchPresence?.(terminalId,now().toISOString());
      schedulePresenceExpiry(terminalId);
      return {alive:true};
    },
    async sweep() {
      const needed=await (repository.read??repository.transact).call(repository,async state=>{
        const catalog=(await siteProvider()).map(({id,name,active})=>({id,name,active:active!==false}));
        const value=copy(state);cleanup(value,now(),catalog);return value.revision!==state.revision;
      },{maintenance:true});
      if(needed)await transaction(()=>{});
    },
    async staffValidity(staffToken) {return readOperation((state,time)=>{const p=staff(state,staffToken,time);demand(p,'customerApprovalRead');return {actualUserId:p.actor.id,effectiveUserId:p.user.id};},{staffHash:hash(staffToken??'')});},
    close() {for(const timers of presenceTimers.values()){clearTimeout(timers.offline);clearTimeout(timers.disconnected);}presenceTimers.clear();},
    logout(deviceToken) {
      return transaction((state, time, catalog) => {
        const terminal = device(state, deviceToken, time);
        cancelTerminal(state, terminal.id, time, undefined, 'Terminalen loggades ut.');
        audit(state, time, 'terminal.logout', undefined, { terminalId: terminal.id }); return { loggedOut: true };
      });
    },
    send(payload, staffToken, preparedIdentity, requireStaffSession = false) {
      const request = validate(sendSchema, payload);
      return transaction((state, time, catalog) => {
        const principal = preparedIdentity && !requireStaffSession ? principalStore.principal(preparedIdentity.actorId,preparedIdentity.userId) : staff(state, staffToken, time);
        if (preparedIdentity && (principal.actor.id !== preparedIdentity.actorId || principal.user.id !== preparedIdentity.userId)) throw new TerminalDemoError('Kontorets aktiva användare har ändrats. Försök igen i den aktuella vyn.',409,'staff_identity_changed');
        demand(principal, 'prepare', 'customerApprovalRead'); demandMoney(principal); demandSite(principal, request.siteId, catalog);
        const fingerprint = hash(JSON.stringify(request));
        const existingRequest = state.requests.find((entry) => entry.key === request.idempotencyKey && entry.userId === principal.user.id);
        if (existingRequest) {
          if (existingRequest.fingerprint !== fingerprint) throw new TerminalDemoError('Utskickets ID används för ett annat underlag.', 409, 'idempotency_conflict');
          return approvalDTO(state.approvals.find((entry) => entry.id === existingRequest.approvalId), principal,state.revision);
        }
        demandActiveSite(principal, request.siteId, catalog);
        const previous = state.approvals.filter((entry) => entry.cardId === request.card.id).at(-1);
        if (previous?.status === 'attested' || ['ready', 'paid', 'balance'].includes(request.card.status)) throw new TerminalDemoError('Ett attesterat eller avslutat kort kan inte ersättas. Använd rättelseflödet.', 409, 'card_locked');
        if (request.card.kind === 'correction') throw new TerminalDemoError('Rättelser använder fortfarande det befintliga rättelseflödet.', 409, 'correction_flow');
        const terminal = findTerminal(state, request.terminalId, principal, catalog);
        const terminalView = terminalDTO(state, terminal, time, catalog);
        const selectedSite = catalog.find((site) => site.id === request.siteId);
        const cardMatchesSite = request.card.siteId ? request.card.siteId === request.siteId : request.card.yard === selectedSite?.name;
        if (!terminal.active || terminal.siteId !== request.siteId || !cardMatchesSite) throw new TerminalDemoError('Kort och terminal måste tillhöra samma anläggning.', 409, 'site_mismatch');
        if (!terminalView.online) throw new TerminalDemoError('Terminalen är offline. Logga in på terminalen eller välj en annan.', 409, 'terminal_offline');
        const busy = activeApproval(state, terminal.id);
        if (busy && busy.cardId !== request.card.id) throw new TerminalDemoError('Terminal upptagen. Välj en annan terminal.', 409, 'terminal_busy');
        if (request.card.customerId !== request.customer.id) throw new TerminalDemoError('Kunden stämmer inte med invägningskortet.');
        const pricing = principalStore.getSnapshotForApproval?.(request.card.pricingSnapshotId);
        if (!pricing || String(pricing.cardId) !== String(request.card.id) || pricing.customerId !== request.customer.id) throw new TerminalDemoError('Prisunderlaget saknas eller stämmer inte. Färdigställ kortets priser på nytt.', 409, 'pricing_snapshot_missing');
        if (pricing.rows.length !== request.card.rows.length || pricing.rows.length !== request.rows.length) throw new TerminalDemoError('Materialraderna stämmer inte med det låsta prisunderlaget.', 409, 'pricing_mismatch');
        const articles = principalStore.read(principal).articles;
        const rows = pricing.rows.map((row, index) => {
          const input = request.card.rows[index], displayed = request.rows[index];
          if (row.price == null || [input, displayed].some((value) => value.articleId !== row.articleId || value.weight !== row.weight || value.price !== row.price)
            || money(row.weight * row.price) !== displayed.amount) throw new TerminalDemoError('Vikt eller pris har ändrats efter prisfrysningen.', 409, 'pricing_mismatch');
          return { articleId: row.articleId, name: articles.find((article) => article.id === row.articleId)?.name ?? displayed.name,
            weight: row.weight, price: row.price, amount: money(row.weight * row.price) };
        });
        const gross = money(rows.reduce((sum, row) => sum + row.amount, 0));
        if (gross !== pricing.total || request.offset > gross) throw new TerminalDemoError('Avräkningsbeloppet stämmer inte med prisunderlaget.', 409, 'pricing_mismatch');
        if (request.offset > 0 && !request.correctionIds.length) throw new TerminalDemoError('Kvittningen måste hänvisa till rättelseunderlag.');
        if (request.offset > 0 && state.approvals.some((approval) => ['waiting', 'id_requested', 'approved', 'attested'].includes(approval.status)
          && approval.cardId !== request.card.id && approval.correctionIds.some((value) => request.correctionIds.includes(value)))) {
          throw new TerminalDemoError('Detta rättelsesaldo används redan av en annan kundavräkning.', 409, 'offset_reserved');
        }
        const payment = request.card.paymentDetails ?? request.customer.paymentProfile;
        if (!payment || (payment.method === 'bank' && (!payment.clearing?.trim() || !payment.account?.trim() || !payment.holder?.trim()))
          || (payment.method === 'swish' && (!payment.phone?.trim() || !payment.recipient?.trim()))) throw new TerminalDemoError('Komplettera betalningsuppgifterna innan kunden granskar avräkningen.', 422, 'payment_details_required');
        const originalCard = copy(request.card);
        originalCard.siteId = request.siteId;
        originalCard.yard = selectedSite.name;
        originalCard.preparedBy = principal.user.id;
        originalCard.customerSnapshot = copy(request.customer);
        originalCard.paymentDetails = copy(payment);
        originalCard.rows = originalCard.rows.map((row, index) => ({ ...row, price: rows[index].price, weight: rows[index].weight }));
        originalCard.pricingTotal = gross;
        const snapshot = { card: originalCard, customer: copy(request.customer), rows, gross,
          offset: money(request.offset), net: money(gross - request.offset), paymentMethod: payment.method,
          reference: request.card.reference, origin: request.card.origin, deliveredAt: request.card.date, termsVersion: TERMS_VERSION };
        snapshot.hash = hash(JSON.stringify(snapshot));
        // Cancel the old session only after all validation succeeds. Reservation
        // and supersession happen atomically under the repository's DB lock.
        if (previous && previous.status !== 'cancelled') releaseApproval(state, previous, 'cancelled', time, principal, 'Ersatt av en ny granskningsversion.');
        const approval = { id: randomUUID(), cardId: request.card.id, siteId: request.siteId, terminalId: terminal.id,
          version: (previous?.version ?? 0) + 1, status: 'waiting', createdAt: time.toISOString(), updatedAt: time.toISOString(),
          expiresAt: new Date(time.getTime() + approvalAge).toISOString(), sentBy: principal.user.name,
          actualUserId: principal.actor.id, effectiveUserId: principal.user.id, correctionIds: request.correctionIds, siteSnapshot: copy(selectedSite), snapshot };
        state.approvals.push(approval);
        state.requests.push({ key: request.idempotencyKey, userId: principal.user.id, fingerprint, approvalId: approval.id });
        audit(state, time, 'approval.sent', principal, { approvalId: approval.id, cardId: approval.cardId, terminalId: terminal.id, version: approval.version });
        return approvalDTO(approval, principal,state.revision);
      });
    },
    respond(approvalId, payload, deviceToken) {
      const request = validate(z.object({ action: z.enum(['id_requested', 'change_requested']), comment: z.string().trim().max(2000).optional(), termsAccepted: z.boolean() }).strict(), payload);
      return transaction((state, time, catalog) => {
        const terminal = device(state, deviceToken, time);
        const approval = activeApproval(state, terminal.id);
        if (!approval || approval.id !== approvalId) throw new TerminalDemoError('Kundvisningen har ersatts eller avslutats.', 409, 'stale_approval');
        if (request.action === 'id_requested' && !request.termsAccepted) throw new TerminalDemoError('Bekräfta säljarens intygande först.');
        if (request.action === 'change_requested' && !request.comment) throw new TerminalDemoError('Beskriv vad som behöver ändras.');
        if (approval.status === 'id_requested' && request.action === 'id_requested') return publicApproval(approval,state.revision);
        approval.status = request.action; approval.updatedAt = time.toISOString();
        if (request.comment) approval.comment = request.comment;
        if (request.action === 'id_requested') approval.termsAcceptedAt = time.toISOString();
        audit(state, time, `approval.${request.action}`, undefined, { terminalId: terminal.id, approvalId, version: approval.version });
        return publicApproval(approval,state.revision);
      });
    },
    displayed(approvalId,payload,deviceToken) {
      const request=validate(z.object({version:z.number().int().positive(),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),payload);
      return transaction((state,time)=>{
        const terminal=device(state,deviceToken,time,false),approval=activeApproval(state,terminal.id);
        if(!approval||approval.id!==approvalId||approval.version!==request.version||approval.snapshot.hash!==request.snapshotHash)throw new TerminalDemoError('Kundvisningen har ersatts eller avslutats.',409,'stale_approval');
        if(!approval.displayedAt){approval.displayedAt=time.toISOString();approval.updatedAt=time.toISOString();audit(state,time,'approval.displayed',undefined,{terminalId:terminal.id,approvalId,version:approval.version});}
        return publicApproval(approval,state.revision);
      });
    },
    cancel(approvalId, staffToken) {
      return transaction((state, time, catalog) => {
        const principal = staff(state, staffToken, time); demand(principal, 'prepare'); demandMoney(principal);
        const approval = getApproval(state, approvalId, principal, catalog);
        if (approval.status === 'attested') throw new TerminalDemoError('Kortet är redan attesterat. Använd rättelseflödet.', 409, 'card_locked');
        if (approval.status !== 'cancelled') releaseApproval(state, approval, 'cancelled', time, principal, 'Kundvisningen avslutades av kontoret.');
        return approvalDTO(approval, principal,state.revision);
      });
    },
    confirmId(approvalId, staffToken) {
      return transaction((state, time, catalog) => {
        const principal = staff(state, staffToken, time); demand(principal, 'prepare', 'verifyId'); demandMoney(principal);
        const approval = getApproval(state, approvalId, principal, catalog);
        if (approval.status === 'approved') return approvalDTO(approval, principal,state.revision);
        if (approval.status !== 'id_requested') throw new TerminalDemoError('Kunden måste först välja legitimation och bekräfta intygandet på terminalen.', 409, 'id_not_requested');
        approval.status = 'approved'; approval.approvedBy = principal.user.name; approval.approvedAt = time.toISOString();
        approval.approvedMethod = 'staff_checked_id_demo'; approval.approvedHash = approval.snapshot.hash; approval.updatedAt = time.toISOString();
        audit(state, time, 'approval.approved_by_staff', principal, { approvalId, version: approval.version, hash: approval.snapshot.hash, method: approval.approvedMethod });
        return approvalDTO(approval, principal,state.revision);
      });
    },
    attest(approvalId, staffToken) {
      return transaction(async (state, time, catalog) => {
        const principal = staff(state, staffToken, time); demand(principal, 'attest');
        const approval = getApproval(state, approvalId, principal, catalog);
        if (approval.status === 'attested') return approvalDTO(approval, principal,state.revision);
        if (approval.status !== 'approved' || approval.approvedHash !== approval.snapshot.hash) throw new TerminalDemoError('Aktuell avräkningsversion måste vara kundgodkänd före intern attest.', 409, 'customer_approval_required');
        if (!principal.user.ownAttest && (principal.user.id === approval.effectiveUserId || principal.actor.id === approval.actualUserId)) throw new TerminalDemoError('Du får inte attestera ditt eget underlag.', 403, 'own_attest_forbidden');
        if (approval.snapshot.gross > principal.user.maxAttest) throw new TerminalDemoError('Beloppet överstiger din attestgräns.', 403, 'attest_limit');
        let receipt;
        if (environmentApprovalCheck) {
          try { receipt = await environmentApprovalCheck(copy(approval)); } catch (error) {
            if (error.status && error.code) throw new TerminalDemoError(error.message, error.status, error.code);
            throw error;
          }
        }
        approval.status = 'attested'; approval.attestedBy = principal.user.name; approval.attestedUserId = principal.user.id;
        approval.attestedAt = time.toISOString(); approval.updatedAt = time.toISOString();
        audit(state, time, 'approval.internally_attested', principal, { approvalId, version: approval.version, hash: approval.snapshot.hash, ...(receipt?.required ? { environmentReceipt: receipt } : {}) });
        return approvalDTO(approval, principal,state.revision);
      });
    },
  };
  return service;
}

const MAX_BODY = 256 * 1024;
function cookie(req, name) {
  for (const value of (req.headers.cookie ?? '').split(';')) {
    const split = value.indexOf('=');
    if (value.slice(0, split).trim() === name) return value.slice(split + 1).trim();
  }
  return undefined;
}
function setCookie(req, res, name, value, age, env) {
  const secure = Boolean(env.RENDER || req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https');
  const attributes=`HttpOnly; SameSite=Strict; Max-Age=${Math.floor(age / 1000)}${secure ? '; Secure' : ''}`;
  // Compound application commands need the same authenticated office cookie.
  // Delete its legacy narrower cookie so it cannot shadow the new session.
  res.setHeader('Set-Cookie',name===STAFF_COOKIE
    ? [`${name}=${value}; Path=/; ${attributes}`,`${name}=; Path=/api/terminal-demo; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`]
    : `${name}=${value}; Path=/api/terminal-demo; ${attributes}`);
}
function json(res, status, value, head = false) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(head ? undefined : JSON.stringify(value));
}
function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new TerminalDemoError('Anropet måste komma från samma webbplats.', 403, 'origin_forbidden');
  if (!req.headers.origin) return;
  let origin;
  try { origin = new URL(req.headers.origin); } catch { throw new TerminalDemoError('Ogiltigt ursprung.', 403, 'origin_forbidden'); }
  if (origin.host !== req.headers.host) throw new TerminalDemoError('Anropet måste komma från samma webbplats.', 403, 'origin_forbidden');
}
async function body(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new TerminalDemoError('Använd application/json.', 415);
  if (Number(req.headers['content-length']) > MAX_BODY) throw new TerminalDemoError('Anropet är för stort.', 413);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new TerminalDemoError('Anropet är för stort.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new TerminalDemoError('Ogiltig JSON.'); }
}

export function createTerminalDemoApi({ principalStore = createPricingStore(), repository, siteProvider, environmentApprovalCheck, onApprovalChanged, env = process.env, now = () => new Date(), approvalAge } = {}) {
  let repositoryPromise, storePromise, jobsRunning, jobTimer, maintenanceTimer, backgroundStarted = false, closed = false;
  const eventStreams = new Set();
  const getStore = () => {
    if (!storePromise) {
      repositoryPromise = repository ? Promise.resolve(repository) : createTerminalDemoRepository({ env });
      storePromise = repositoryPromise.then(value => createTerminalDemoStore({ repository: value, principalStore, siteProvider, environmentApprovalCheck, now, approvalAge }));
      const attempt = storePromise;
      attempt.then(() => afterDatabaseCommit(startBackground), () => {
        if (storePromise === attempt) { storePromise = undefined; repositoryPromise = undefined; }
      });
    }
    return storePromise;
  };
  // The persistent queue is part of the approval transaction. The worker owns a
  // fenced lease and archives its immutable milestone, even if the current card
  // is later cancelled. A failed archive remains pending across server restarts.
  const drainJobs = async () => {
    if (!onApprovalChanged || closed) return;
    if (jobsRunning) return jobsRunning;
    jobsRunning = (async () => {
      const repo = await repositoryPromise;
      while (!closed) {
        const job = await repo.claimDocumentJob(now().toISOString());
        if (!job) break;
        let failure;
        try { await onApprovalChanged(job.approval, { stage: job.stage, jobId: job.id, sourceHash: job.sourceHash, siteSnapshot: job.siteSnapshot }); }
        catch (error) { failure = error; }
        await repo.finishDocumentJob(job, failure, now().toISOString());
        if (failure) break;
      }
    })().finally(() => { jobsRunning = undefined; });
    return jobsRunning;
  };
  const scheduleJobs = () => afterDatabaseCommit(() => {
    if (!closed && onApprovalChanged) setImmediate(() => { void drainJobs().catch(() => console.warn('PDF-arkivering väntar på återförsök.')); });
  });
  function startBackground() {
    if (closed || backgroundStarted) return;
    backgroundStarted = true;
    if (onApprovalChanged) {
      scheduleJobs();
      jobTimer = setInterval(() => { void drainJobs().catch(() => console.warn('PDF-arkivering väntar på återförsök.')); }, 10000); jobTimer.unref();
    }
    maintenanceTimer = setInterval(() => { void getStore().then(store => store.sweep()).catch(() => {}); }, 15000); maintenanceTimer.unref();
  }
  async function stream(req, res, store, staffToken, deviceToken, selectedSite, terminalStream) {
    const expected = expectedStaffIdentity.getStore();
    const reader = terminalStream ? () => store.session(deviceToken) : () => expectedStaffIdentity.run(expected, () => store.read(staffToken, selectedSite));
    const baselineChanges=new Map();let deliverChange;
    // Subscribe before the snapshot read: a commit that races the baseline is
    // reconciled immediately instead of waiting for the recovery interval.
    const unsubscribe=store.repository.events.subscribe(change=>{
      if(deliverChange)deliverChange(change);else baselineChanges.set(change.domain,change);
    });
    let initial;
    try {
      await store.repository.events.ready();
      if (terminalStream) await store.heartbeat(deviceToken);
      initial=await reader();
    }catch(error){unsubscribe();throw error;}
    const identity = terminalStream ? { connectionId: initial.connectionId } : { actualUserId: initial.actualUserId, effectiveUserId: initial.effectiveUserId };
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Referrer-Policy': 'no-referrer' });
    res.flushHeaders();
    let fingerprint = hash(JSON.stringify(initial)), reading = false, pending, stopped = false;
    const write = (event, value, eventId = randomUUID()) => { if (!stopped && !res.destroyed) res.write(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(value)}\n\n`); };
    write('state', initial);
    const refresh = async (eventId, force = false) => {
      if (stopped || res.destroyed) return;
      if (reading) { pending = { eventId, force }; return; }
      reading = true;
      try {
        const value = await reader();
        // A session epoch never inherits the previous display, even with a
        // higher aggregate revision after a controlled device takeover.
        if (terminalStream && value.connectionId !== identity.connectionId) throw new TerminalDemoError('Terminalsessionen har ersatts.', 401);
        if (!terminalStream && (value.actualUserId !== identity.actualUserId || value.effectiveUserId !== identity.effectiveUserId)) throw new TerminalDemoError('Kontorets session har ersatts.',401);
        const next = hash(JSON.stringify(value));
        if (force || next !== fingerprint) { fingerprint = next; write('state', value, eventId); }
      } catch { write('session-ended', {}); close(); }
      finally { reading = false; if (pending && !stopped) { const next=pending; pending=undefined; void refresh(next.eventId,next.force); } }
    };
    deliverChange = change => {
      if (stopped) return;
      write('change', { ...change, ...identity }, change.eventId);
      if (['terminal','terminal-presence','application'].includes(change.domain)) void refresh(change.eventId);
    };
    let checking = false;
    const safety = setInterval(async () => {
      if (checking || stopped) return;
      checking = true;
      try {
        if (terminalStream) await store.heartbeat(deviceToken);
        else {
          const current = await expectedStaffIdentity.run(expected,()=>store.staffValidity(staffToken));
          if (current.actualUserId !== identity.actualUserId || current.effectiveUserId !== identity.effectiveUserId) throw new TerminalDemoError('Sessionen har ersatts.',401);
        }
        write('heartbeat', identity);
      } catch { write('session-ended', {}); close(); }
      finally { checking = false; }
    },15000); safety.unref();
    // Recovery bounds a lost notification. Healthy streams otherwise read only
    // on changes; there is no 2-second aggregate poll or presence rewrite.
    const recovery = setInterval(() => { void refresh(); },30000); recovery.unref();
    const close = () => { if (stopped) return; stopped=true; unsubscribe(); clearInterval(safety); clearInterval(recovery); eventStreams.delete(close); if (!res.destroyed) res.end(); };
    eventStreams.add(close); res.on('close',close);
    for(const change of baselineChanges.values())deliverChange(change);
    baselineChanges.clear();
  }
  const handle = async (req, res, url) => {
    if (!url.pathname.startsWith('/api/terminal-demo')) return false;
    try {
      checkOrigin(req);
      const store = await getStore();
      const route = url.pathname.slice('/api/terminal-demo'.length);
      const staffToken = cookie(req, STAFF_COOKIE), deviceToken = cookie(req, TERMINAL_COOKIE);
      const read = req.method === 'GET' || req.method === 'HEAD';
      const head = req.method === 'HEAD';
      if (read && route === '/state') json(res, 200, await store.read(staffToken, url.searchParams.get('siteId')), head);
      else if (read && route === '/session') json(res, 200, await store.session(deviceToken), head);
      else if (req.method === 'GET' && route === '/events') await stream(req,res,store,staffToken,deviceToken,url.searchParams.get('siteId'),false);
      else if (req.method === 'GET' && route === '/terminal-events') await stream(req,res,store,staffToken,deviceToken,undefined,true);
      else if (req.method === 'POST' && route === '/heartbeat') { await body(req); json(res,200,await store.heartbeat(deviceToken)); }
      else if (req.method === 'POST' && route === '/staff-session') {
        const result = await store.staffSession(await body(req), staffToken);
        setCookie(req, res, STAFF_COOKIE, result.token, STAFF_AGE, env); json(res, 200, result.result);
      } else if (req.method === 'POST' && route === '/login') {
        const result = await store.login(await body(req), deviceToken, req.socket.remoteAddress ?? '');
        setCookie(req, res, TERMINAL_COOKIE, result.token, TERMINAL_AGE, env); json(res, 200, result.result);
      } else if (req.method === 'POST' && route === '/logout') {
        await body(req); const result = await store.logout(deviceToken);
        setCookie(req, res, TERMINAL_COOKIE, '', 0, env); json(res, 200, result);
      } else if (req.method === 'POST' && route === '/terminals') json(res, 201, await store.createTerminal(await body(req), staffToken));
      else if (req.method === 'PUT' && route === '/defaults') json(res, 200, await store.defaultTerminal(await body(req), staffToken));
      else if (req.method === 'POST' && route === '/approvals') {
        const result = await store.send(await body(req), staffToken); scheduleJobs(); json(res, 201, result);
      } else {
        const terminal = route.match(/^\/terminals\/([^/]+)(?:\/(release))?$/);
        const approval = route.match(/^\/approvals\/([^/]+)\/(cancel|confirm-id|attest|respond|displayed)$/);
        if (terminal && req.method === 'PATCH' && !terminal[2]) json(res, 200, await store.updateTerminal(terminal[1], await body(req), staffToken));
        else if (terminal && req.method === 'POST' && terminal[2] === 'release') { await body(req); json(res, 200, await store.releaseTerminal(terminal[1], staffToken)); }
        else if (approval && req.method === 'POST') {
          const value = await body(req), action = approval[2];
          const result = action === 'respond' ? await store.respond(approval[1], value, deviceToken)
            : action === 'displayed' ? await store.displayed(approval[1],value,deviceToken)
              : action === 'cancel' ? await store.cancel(approval[1], staffToken)
                : action === 'confirm-id' ? await store.confirmId(approval[1], staffToken) : await store.attest(approval[1], staffToken);
          scheduleJobs(); json(res, 200, result);
        } else throw new TerminalDemoError('API-vyn finns inte eller metoden stöds inte.', 404, 'not_found');
      }
    } catch (error) {
      if (res.headersSent) { res.end(); return true; }
      const known = error instanceof TerminalDemoError || error instanceof PricingError;
      const unavailable = !known && ['ECONNREFUSED', 'ENOTFOUND', '57P01', '28P01', '3D000'].includes(error.code);
      json(res, known ? error.status : 503, { configured: false,
        error: known ? error.message : 'Terminalernas databas kunde inte nås. Kontrollera serverns databasinställningar.',
        code: known ? error.code ?? 'invalid_request' : unavailable ? 'setup_required' : 'storage_unavailable', demo: true });
    }
    return true;
  };
  const api = (req,res,url) => {
    const actualUserId=req.headers['x-terminal-actual-user'],effectiveUserId=req.headers['x-terminal-effective-user'];
    return expectedStaffIdentity.run(actualUserId||effectiveUserId?{actualUserId,effectiveUserId}:undefined,()=>handle(req,res,url));
  };
  api.initialize = async () => { await getStore(); };
  api.sendPrepared = async (payload,identity,req) => {
    const expected=req?{actualUserId:req.headers['x-terminal-actual-user']??identity.actorId,effectiveUserId:req.headers['x-terminal-effective-user']??identity.userId}:undefined;
    const result=await expectedStaffIdentity.run(expected,async()=>(await getStore()).send(payload,req?cookie(req,STAFF_COOKIE):undefined,identity,Boolean(req)));
    scheduleJobs();return result;
  };
  api.withApprovedCard = async (input, operation) => (await getStore()).withApprovedCard(input, operation);
  api.projections = async cardId => (await getStore()).projections(cardId);
  api.documentProjections = async () => (await getStore()).documentProjections();
  api.drainDocumentJobs = async () => { await getStore(); return drainJobs(); };
  api.documentJobs = async () => { await getStore(); return (await repositoryPromise).documentJobs(); };
  api.close = async () => {
    closed=true; clearInterval(jobTimer); clearInterval(maintenanceTimer);
    for (const close of [...eventStreams]) close();
    if (jobsRunning) await jobsRunning.catch(()=>{});
    if(storePromise)await storePromise.then(store=>store.close()).catch(()=>{});
    if (repositoryPromise) await repositoryPromise.then(value => value.close()).catch(() => {});
  };
  return api;
}
