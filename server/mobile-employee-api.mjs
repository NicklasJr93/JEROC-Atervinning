import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createPricingStore, PricingError } from './pricing.mjs';
import { ensurePersonnel, refreshStaffingTasks } from './personnel.mjs';
import { ensureLogistics, driverOrderView, applyDriverAction } from './logistics.mjs';
import { createTransportOutbox } from './transport-integrations.mjs';
import { applyTransportChange, personnelPlanIssues, normalizePhoneNumber, phoneNumberError } from '../dist-server/domain-models.mjs';
import { ensureEmployeeTime, enrollEmployeeTime, employeeTimeProjection, employeeTimeCommand,
  employeeTimeGate, employeeTimeRequirementCommand, employeeTimeLifecycle } from './employee-time.mjs';

const COOKIE = 'jeroc_employee';
const SESSION_HOURS = 8;
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 409, extra = {}) => { throw Object.assign(new PricingError(message, status), extra); };
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) fail(result.error.issues.map(issue => issue.message).join(' '), 422);
  return result.data;
};
const accountUsername = z.string().trim().toLowerCase().min(3).max(200).refine(value =>
  /^[a-z0-9._-]+$/.test(value) && value.length <= 80 || z.string().email().safeParse(value).success, 'Ange ett giltigt inloggningsnamn eller en e-postadress.');
function passwordHash(password) {
  const salt = randomBytes(24).toString('hex');
  return { salt, digest: scryptSync(password, salt, 64).toString('hex') };
}
const unknownPassword = passwordHash(randomBytes(32).toString('base64url'));
function passwordValid(password, stored) {
  const value = stored ?? unknownPassword;
  const actual = scryptSync(password, value.salt, 64), expected = Buffer.from(value.digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected) && Boolean(stored);
}
function cookieToken(req) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  return header.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}
export const hasEmployeeSession = req => cookieToken(req) !== undefined;
const timestamp = now => (typeof now === 'function' ? now() : now ?? new Date()).toISOString();

/** One known fictional account replaces the old browser-only Niklas login.
 * Existing credentials, custom identities and disabled users are never reset. */
export function ensureMobileEmployeeAccounts(state) {
  ensurePersonnel(state);
  state.personnelAuth ??= { accounts: [], sessions: [], attempts: [] };
  state.personnelAuth.accounts ??= []; state.personnelAuth.sessions ??= []; state.personnelAuth.attempts ??= [];
  ensureEmployeeTime(state);
  if (state.metadata?.mobileEmployeeSeedVersion >= 2) return;
  // Only the original demo aggregate may receive a fixture. An imported/custom
  // aggregate without that original seed must be provisioned explicitly.
  if (!state.metadata?.pricingSeed?.users?.some(user => user.id === 'admin' && user.name === 'Systemadmin')) return;
  const userId = 'mobile-demo', personId = 'person-mobile-demo';
  if (!state.pricing.users.some(user => user.id === userId) && !state.personnel.people.some(person => person.id === personId || person.userId === userId)
    && !state.personnelAuth.accounts.some(account => account.username === 'niklas')) {
  const bootstrapUser = { id: userId, name: 'Niklas', level: 'Medarbetare', permissions: ['view', 'prepare', 'customers'], siteIds: ['norrtalje'], maxAttest: 0, ownAttest: false, active: true };
  state.pricing.users.push(bootstrapUser);
  // The legacy importer can distinguish this exact additive fixture from a
  // genuinely edited user. Never infer trust from an existing name or ID.
  state.metadata.mobileEmployeeBootstrapUsers ??= [];
  state.metadata.mobileEmployeeBootstrapUsers.push(clone(bootstrapUser));
  state.personnel.people.push({ id: personId, userId, name: 'Niklas', kind: 'employee', active: true,
    role: 'Invägare', team: 'Gårdsplan', siteIds: ['norrtalje'], phone: '', email: '', address: '', canDrive: false, revision: 0 });
  state.personnel.employment.push({ personId, form: 'permanent', startDate: '2026-01-01', percentage: 100, hoursPerWeek: 40, revision: 0 });
  state.personnel.schedules.push({ id: `schedule-${personId}`, personId, weekdays: [1, 2, 3, 4, 5], startMinute: 420,
    endMinute: 960, lunchStart: 720, lunchEnd: 780, effectiveFrom: '2026-01-01', revision: 0 });
  const at = new Date().toISOString();
  state.personnelAuth.accounts.push({ personId, username: 'niklas', active: true, createdAt: at, updatedAt: at, password: passwordHash('Demo123!') });
  state.personnel.externalAccounts = state.personnelAuth.accounts.map(({ password, ...account }) => account);
  state.personnel.revision += 1;
  }
  const admin = state.pricing.users.find(user => user.id === 'admin' && user.name === 'Systemadmin' && user.level === 'Systemadmin');
  if (admin && !state.personnelAuth.accounts.some(account => account.username === 'admin' || state.personnel.people.find(person => person.id === account.personId)?.userId === admin.id)) {
    let person = state.personnel.people.find(person => person.userId === admin.id);
    if (!person && !state.personnel.people.some(person => person.id === 'person-mobile-admin')) {
      person = { id: 'person-mobile-admin', userId: admin.id, name: admin.name, kind: 'employee', active: admin.active !== false,
        role: 'Systemadmin', team: 'Kontor', siteIds: admin.siteIds ?? ['norrtalje', 'rimbo'], phone: '', email: '', address: '', canDrive: false, revision: 0 };
      state.personnel.people.push(person); state.personnel.revision += 1;
    }
    if (person?.active && person.id === 'person-mobile-admin' && person.name === 'Systemadmin') state.personnelAuth.accounts.push({ personId: person.id, username: 'admin', active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), password: passwordHash('JerocDemo2026!') });
  }
  state.personnel.externalAccounts = state.personnelAuth.accounts.map(({ password, ...account }) => account);
  state.metadata.mobileEmployeeSeedVersion = 2;
}

function sessionIdentity(state, req, { now } = {}) {
  const token = cookieToken(req);
  if (token === undefined) return undefined;
  const auth = state.personnelAuth;
  const at = timestamp(now);
  const session = auth?.sessions?.find(value => value.kind === 'employee' && value.tokenHash === hash(token) && value.expiresAt > at);
  const person = state.personnel?.people?.find(value => value.id === session?.personId);
  const account = auth?.accounts?.find(value => value.personId === person?.id);
  const user = person?.userId ? state.pricing?.users?.find(value => value.id === person.userId) : undefined;
  if (!session || !person?.active || person.kind !== 'employee' || !account?.active || person.userId && (!user || user.active === false))
    fail('Logga in igen för att använda appen.', 401);
  if (user?.siteIds && person.siteIds.some(id => !user.siteIds.includes(id))) fail('Personprofilens anläggningar matchar inte kontots behörighet.', 403);
  const employeeUser = user ?? { id: person.id, name: person.name, level: 'Medarbetare', permissions: ['view', ...(person.canDrive ? ['transportRead'] : [])], siteIds: person.siteIds };
  return { session, account, person, principal: { actor: employeeUser, user: employeeUser } };
}
function demandTimeComplete(state, person, now) {
  const gate = employeeTimeGate(state, person, { now });
  if (gate.blocked) fail('Registrera den saknade tiden innan du fortsätter arbetet.', 423, { code: 'EMPLOYEE_TIME_REQUIRED', gate });
}
/** A genuine cookie always takes precedence over browser-supplied demo headers.
 * A stale/invalid cookie throws; it may never fall back to a demo identity. */
export function employeeRequestPrincipal(state, req, { enforceGate = false, now } = {}) {
  const identity = sessionIdentity(state, req, { now });
  if (!identity) return undefined;
  if (enforceGate) demandTimeComplete(state, identity.person, now);
  return identity.principal;
}

const safePerson = (person, account) => Object.fromEntries(['id', 'name', 'kind', 'role', 'team', 'phone', 'email', 'employeeNumber', 'siteIds', 'userId', 'driverId']
  .filter(key => person[key] !== undefined).map(key => [key, clone(person[key])]).concat([['username', account.username]]));
const ownOrder = (state, person, id) => {
  const order = state.transport.orders.find(value => value.id === id);
  const driver = state.transport.drivers.find(value => value.id === person.driverId);
  if (!person.canDrive || !driver || driver.personId !== person.id || !order || !driverOrderView(state, person, order)) fail('Uppdraget är inte tilldelat dig.', 403);
  const siteId = state.logistics?.details[order.id]?.siteId ?? order.siteId;
  if (siteId && !person.siteIds.includes(siteId)) fail('Uppdragets anläggning ligger utanför din behörighet.', 403);
  return order;
};
const safeOrder = order => Object.fromEntries(['id', 'customerId', 'customerName', 'address', 'city', 'contact', 'phone', 'action', 'vesselType', 'material',
  'vesselSize', 'pickupVessel', 'replacementVessel', 'notes', 'lat', 'lng', 'durationMinutes', 'status', 'date', 'startMinute', 'driverId', 'vehicleId',
  'requestedDate', 'updatedAt', 'bookingVersion', 'requiredCompetencies', 'detail'].filter(key => order[key] !== undefined).map(key => [key, clone(order[key])]).concat([['audit', []]]));
function managePeople(state, identity) {
  const { person, principal } = identity, user = principal.user;
  const broad = user.level === 'Systemadmin' || user.level === 'VD' && user.permissions.includes('employmentWrite');
  if (user.level !== 'Systemadmin' && !user.permissions.includes('employmentWrite')) return [];
  return state.personnel.people.filter(value => value.kind === 'employee' && value.active && (broad || value.managerId === person.id)
    && (user.level === 'Systemadmin' || value.userId !== user.id)
    && (!user.siteIds || value.siteIds.every(id => user.siteIds.includes(id))));
}

export function createMobileEmployeeApi({ getRepository, readBody, json, siteProvider = async () => [], now = () => new Date(), env = process.env }) {
  const cookie = (res, token, req) => res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/api; SameSite=Strict; Max-Age=${token ? SESSION_HOURS * 3600 : 0}${req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/employee/')) return false;
    try {
      if (!['GET', 'POST'].includes(req.method)) fail('Metoden stöds inte.', 405);
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { fail('Anropet måste komma från samma webbplats.', 403); }
        const protocol = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
        if (origin.host !== req.headers.host || origin.protocol !== protocol) fail('Anropet måste komma från samma webbplats.', 403);
      }
      const path = url.pathname.slice('/api/employee/'.length), payload = req.method === 'POST' ? await readBody(req) : undefined;
      if (path === 'demo-config' && req.method === 'GET') {
        const repository = await getRepository();
        const config = await repository.read(state => {
          const enabled = env.JEROC_DEMO_AUTO_SESSION !== 'false' && state.metadata?.mobileEmployeeSeedVersion >= 2
            && state.metadata?.pricingSeed?.users?.some(user => user.id === 'admin' && user.name === 'Systemadmin');
          const available = (username, personId, userId, password) => {
            if (!enabled) return false;
            const account = state.personnelAuth?.accounts?.find(value => value.username === username && value.personId === personId);
            const person = state.personnel?.people?.find(value => value.id === personId && value.userId === userId);
            const user = state.pricing?.users?.find(value => value.id === userId);
            return Boolean(account?.active && person?.active && user && user.active !== false && passwordValid(password, account.password));
          };
          const companyId = env.SCRAPPILOT_ORGANISATION_ID ?? env.JEROC_TENANT_ID ?? 'jeroc-demo';
          return { companyId, companyName: state.metadata?.organisation?.name ?? (companyId === 'jeroc-demo' ? 'JEROC Återvinning AB' : ''), enabled: Boolean(enabled), accounts: {
            niklas: available('niklas', 'person-mobile-demo', 'mobile-demo', 'Demo123!'),
            admin: available('admin', 'person-mobile-admin', 'admin', 'JerocDemo2026!'),
          } };
        }, { domains: ['metadata', 'pricing', 'personnel', 'personnelAuth'] });
        res.setHeader('Cache-Control', 'no-store');
        json(res, 200, config); return true;
      }
      const siteCatalog = await siteProvider();
      const repository = await getRepository();
      const operate = (state, _, audit = []) => {
        // Login and startup persist all required identities and policies. Reads
        // use a snapshot and never take a write lock or prune authentication.
        if (req.method === 'POST') { ensureMobileEmployeeAccounts(state); ensureLogistics(state); }
        else ensureEmployeeTime(state);
        const at = timestamp(now), auth = state.personnelAuth;
        if (req.method === 'POST') {
          auth.sessions = auth.sessions.filter(value => value.expiresAt > at);
          auth.attempts = auth.attempts.filter(value => Date.parse(value.at) > Date.parse(at) - 15 * 60_000);
        }
        const overview = identity => {
          const { person, account, principal } = identity;
          const projection = employeeTimeProjection(state, person, { now, month: url.searchParams.get('month') ?? undefined, date: url.searchParams.get('date') ?? undefined, siteCatalog });
          const companyId = env.SCRAPPILOT_ORGANISATION_ID ?? env.JEROC_TENANT_ID ?? 'jeroc-demo';
          return { ...projection, companyId, companyName: state.metadata?.organisation?.name ?? (companyId === 'jeroc-demo' ? 'JEROC Återvinning AB' : ''), person: safePerson(person, account), sites: siteCatalog.filter(site => site.active !== false && person.siteIds.includes(site.id)).map(({ id, name, active }) => ({ id, name, active })),
            capabilities: { yardWork: principal.user.level !== 'Medarbetare' || principal.user.permissions.includes('prepare'), assignedOrders: Boolean(person.canDrive && person.driverId),
              employeeTime: true, manageTimeRequirements: managePeople(state, identity).length > 0,
              manageEmployeeAccounts: principal.user.level === 'Systemadmin' || principal.user.level === 'VD' } };
        };
        if (path === 'login') {
          if (req.method !== 'POST') fail('Metoden stöds inte.', 405);
          const input = parse(z.object({ username: z.string().trim().toLowerCase().min(1).max(200), password: z.string().min(1).max(200) }).strict(), payload);
          const address = hash(req.socket.remoteAddress ?? 'unknown');
          if (auth.attempts.filter(value => value.kind === 'employee' && value.address === address).length >= 12) fail('För många inloggningsförsök. Vänta 15 minuter.', 429);
          const account = auth.accounts.find(value => value.username === input.username), person = state.personnel.people.find(value => value.id === account?.personId);
          const user = person?.userId ? state.pricing.users.find(value => value.id === person.userId) : undefined;
          const validPassword = passwordValid(input.password, account?.password);
          if (!validPassword || !account?.active || !person?.active || person.kind !== 'employee' || person.userId && (!user || user.active === false)) {
            auth.attempts.push({ kind: 'employee', address, at }); return { failure: 'Fel inloggning eller inaktivt konto.' };
          }
          const token = randomBytes(32).toString('base64url');
          auth.sessions.push({ kind: 'employee', tokenHash: hash(token), personId: person.id, expiresAt: new Date(Date.parse(at) + SESSION_HOURS * 3600_000).toISOString() });
          account.lastLoginAt = at;
          enrollEmployeeTime(state, person, { now });
          audit.push({ action: 'employee.login', personId: person.id, actualUserId: user?.id ?? person.id, at });
          const identity = sessionIdentity(state, { ...req, headers: { ...req.headers, cookie: `${COOKIE}=${token}` } }, { now });
          return { token, value: overview(identity) };
        }
        const identity = sessionIdentity(state, req, { now });
        if (!identity) fail('Logga in för att använda appen.', 401);
        const { person, account, principal, session } = identity;
        if (path === 'logout' && req.method === 'POST') { auth.sessions = auth.sessions.filter(value => value !== session); return { token: '', value: { ok: true } }; }
        if (['session', 'bootstrap', 'overview', 'calendar'].includes(path) && req.method === 'GET') return { value: overview(identity) };
        if (path === 'profile' && req.method === 'POST') {
          const input = parse(z.object({ phone: z.string().trim().max(100), email: z.union([z.literal(''), z.string().trim().email().max(200)]) }).strict(), payload);
          const phoneError = phoneNumberError(input.phone);
          if (phoneError) fail(phoneError, 422);
          input.phone = normalizePhoneNumber(input.phone);
          Object.assign(person, input); person.revision += 1; state.personnel.revision += 1;
          audit.push({ action: 'employee.profile.updated', personId: person.id, actualUserId: principal.actor.id, at });
          return { value: overview(identity) };
        }
        if (path === 'password' && req.method === 'POST') {
          const input = parse(z.object({ currentPassword: z.string().min(1).max(200), password: z.string().min(10).max(200) }).strict(), payload);
          if (!passwordValid(input.currentPassword, account.password)) fail('Nuvarande lösenord är fel.', 403);
          account.password = passwordHash(input.password); account.updatedAt = at;
          auth.sessions = auth.sessions.filter(value => value.personId !== person.id || value === session);
          audit.push({ action: 'employee.password.updated', personId: person.id, actualUserId: principal.actor.id, at });
          return { value: overview(identity) };
        }
        if (path === 'requirements') {
          const people = managePeople(state, identity);
          if (!people.length) fail('Du saknar behörighet att hantera timkrav.', 403);
          if (req.method === 'POST') {
            if (!people.some(value => value.id === payload?.personId)) fail('Personen ligger utanför ditt personalansvar.', 403);
            employeeTimeRequirementCommand(state, principal, payload, audit, { now });
          }
          return { value: { ...overview(identity), people: people.map(value => ({ id: value.id, name: value.name, role: value.role, requirement: employeeTimeProjection(state, value, { now, siteCatalog }).requirement, canEdit: true })) } };
        }
        if (['accounts', 'accounts/save'].includes(path)) {
          if (principal.user.level !== 'Systemadmin' && principal.user.level !== 'VD') fail('Du saknar behörighet att administrera personalkonton.', 403);
          const people = state.personnel.people.filter(value => value.kind === 'employee' && (!principal.user.siteIds || value.siteIds.every(id => principal.user.siteIds.includes(id))));
          if (req.method === 'POST') {
            const input = parse(z.object({ personId: z.string().min(1).max(120), username: accountUsername, active: z.boolean(), password: z.string().min(10).max(200).optional() }).strict(), payload);
            const target = people.find(value => value.id === input.personId);
            if (!target) fail('Personen ligger utanför ditt personalansvar.', 403);
            let linkedUser = state.pricing.users.find(value => value.id === target.userId);
            if (target.userId && !linkedUser) fail('Personens kopplade användarkonto finns inte längre.', 422);
            if (!linkedUser) {
              const id = `staff-${hash(target.id).slice(0, 32)}`;
              if (state.pricing.users.some(value => value.id === id)) fail('Kontots identitet används redan. Koppla befintligt konto i Personal.', 422);
              const pricing = createPricingStore({ initialState: state.pricing });
              pricing.saveUsers({ users: [...state.pricing.users, { id, name: target.name, level: 'Medarbetare', permissions: ['view'], siteIds: target.siteIds,
                active: target.active, maxAttest: 0, ownAttest: false }] }, principal);
              state.pricing = pricing.exportState(); state.office.users = clone(state.pricing.users);
              target.userId = id; target.revision += 1; state.personnel.revision += 1;
              linkedUser = state.pricing.users.find(value => value.id === id);
            }
            if (principal.user.level !== 'Systemadmin' && linkedUser.level === 'Systemadmin') fail('Du kan inte ändra en systemadministratörs inloggning.', 403);
            if (input.active && (!target.active || linkedUser.active === false)) fail('Aktivera personen och användarkontot först.', 422);
            if (auth.accounts.some(value => value.personId !== target.id && value.username === input.username)) fail('Inloggningsnamnet används redan.', 422);
            const old = auth.accounts.find(value => value.personId === target.id);
            if (!old && !input.password) fail('Ange lösenord för det nya kontot.', 422);
            const saved = { personId: target.id, username: input.username, active: input.active, password: input.password ? passwordHash(input.password) : old.password,
              createdAt: old?.createdAt ?? at, updatedAt: at, lastLoginAt: old?.lastLoginAt };
            auth.accounts = auth.accounts.filter(value => value.personId !== target.id).concat(saved);
            auth.sessions = auth.sessions.filter(value => value.personId !== target.id);
            state.personnel.externalAccounts = auth.accounts.map(({ password, ...account }) => account);
            audit.push({ action: 'employee.account.updated', personId: target.id, actualUserId: principal.actor.id, at });
          }
          return { value: { ...overview(identity), people: people.map(value => {
            const credential = auth.accounts.find(account => account.personId === value.id);
            return { id: value.id, name: value.name, active: value.active, ...(credential ? { account: { username: credential.username, active: credential.active, lastLoginAt: credential.lastLoginAt } } : {}) };
          }) } };
        }
        if (['time', 'time/save', 'time/remove', 'leave/request', 'leave/cancel'].includes(path) && req.method === 'POST') {
          const command = path === 'time' ? payload : path === 'time/save' ? { action: 'time.save', entry: payload?.entry ?? payload }
            : path === 'time/remove' ? { action: 'time.remove', ...payload } : path === 'leave/request' ? { action: 'leave.request', request: payload?.request ?? payload } : { action: 'leave.cancel', ...payload };
          if (!['time.save', 'time.remove', 'leave.request', 'leave.cancel', 'order.start', 'order.stop'].includes(command?.action)) fail('Åtgärden stöds inte.', 422);
          if (command.action === 'order.start') { demandTimeComplete(state, person, now); ownOrder(state, person, command.orderId); }
          employeeTimeCommand(state, person, command, audit, { now, siteCatalog });
          return { value: overview(identity) };
        }
        if (path === 'orders' && req.method === 'GET') return { value: { ...overview(identity), orders: person.canDrive && person.driverId ? state.transport.orders
          .filter(order => !((state.logistics?.details[order.id]?.siteId ?? order.siteId)) || person.siteIds.includes(state.logistics?.details[order.id]?.siteId ?? order.siteId))
          .map(order => driverOrderView(state, person, order)).filter(Boolean).map(safeOrder) : [] } };
        const match = path.match(/^orders\/([^/]+)\/(start|stop|logistics|status)$/);
        if (match && req.method === 'POST') {
          const orderId = decodeURIComponent(match[1]), action = match[2];
          if (action === 'stop') {
            const input = parse(z.object({ breakMinutes: z.number().int().min(0).max(720).optional() }).strict(), payload);
            employeeTimeCommand(state, person, { action: 'order.stop', orderId, ...input }, audit, { now, siteCatalog }); return { value: overview(identity) };
          }
          demandTimeComplete(state, person, now); const order = ownOrder(state, person, orderId);
          if (action === 'start') { employeeTimeCommand(state, person, { action: 'order.start', orderId }, audit, { now, siteCatalog }); return { value: overview(identity) }; }
          if (action === 'logistics') {
            const updated = applyDriverAction(state, person, order.id, payload, audit);
            if (['travel.empty', 'depart'].includes(payload?.action)) employeeTimeLifecycle(state, person, orderId, 'start', audit, { now });
            if (payload?.action === 'deliver' && state.employeeTime.orderSessions.some(value => value.personId === person.id && value.orderId === orderId && !value.endedAt)) employeeTimeLifecycle(state, person, orderId, 'stop', audit, { now });
            refreshStaffingTasks(state); return { value: { ...overview(identity), order: safeOrder(updated) } };
          }
          const input = parse(z.object({ status: z.enum(['on_way', 'done']) }).strict(), payload);
          if (state.logistics?.details[order.id]) {
            const updated = applyDriverAction(state, person, order.id, { action: input.status === 'on_way' ? 'travel.empty' : 'deliver', expectedVersion: state.logistics.details[order.id].version }, audit);
            if (input.status === 'on_way' || state.employeeTime.orderSessions.some(value => value.personId === person.id && value.orderId === orderId && !value.endedAt)) employeeTimeLifecycle(state, person, orderId, input.status === 'on_way' ? 'start' : 'stop', audit, { now });
            refreshStaffingTasks(state); return { value: { ...overview(identity), order: safeOrder(updated) } };
          }
          if (order.status !== input.status) {
            if (input.status === 'on_way' && order.status !== 'booked' || input.status === 'done' && order.status !== 'on_way') fail('Uppdraget måste påbörjas innan det slutförs.');
            if (input.status === 'on_way') { const issues = personnelPlanIssues(state.personnel, state.transport, order.id, order); if (issues.length) fail(issues.join(' '), 422); }
            const known = new Set(state.transport.events.map(value => value.id));
            state.transport = applyTransportChange(state.transport, { type: 'status', id: order.id, status: input.status }, { canPlan: true, actor: person.name, actualUserId: principal.actor.id, effectiveUserId: principal.user.id });
            const events = state.transport.events.filter(value => !known.has(value.id));
            const box = createTransportOutbox({ initialState: state.outbox }); box.prepare({ events }, { actor: principal.actor, user: { ...principal.user, permissions: ['transportRead', 'transportPlan'] } }); state.outbox = box.exportState();
            audit.push(...events.map(event => ({ action: event.type, personId: person.id, orderId: order.id, at: event.at })));
          }
          if (input.status === 'on_way' || state.employeeTime.orderSessions.some(value => value.personId === person.id && value.orderId === orderId && !value.endedAt)) employeeTimeLifecycle(state, person, orderId, input.status === 'on_way' ? 'start' : 'stop', audit, { now });
          refreshStaffingTasks(state); return { value: { ...overview(identity), order: safeOrder(state.transport.orders.find(value => value.id === orderId)) } };
        }
        fail('Mobilsidan finns inte.', 404);
      };
      const result = req.method === 'GET' && repository.read
        ? await repository.read(operate, { domains: ['metadata', 'pricing', 'personnel', 'personnelAuth', 'employeeTime', 'transport', 'logistics'] })
        : await repository.transact(operate);
      if (result.failure) json(res, 401, { error: result.failure });
      else { if (result.token !== undefined) cookie(res, result.token, req); json(res, 200, result.value); }
    } catch (error) {
      json(res, error instanceof PricingError ? error.status : 503, { error: error instanceof PricingError ? error.message : 'Appens personaltjänst kunde inte nås.', ...(error.code ? { code: error.code } : {}), ...(error.gate ? { gate: error.gate } : {}) });
    }
    return true;
  };
}
