import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PlatformError, platformPasswordHash } from './platform-auth.mjs';
import { personnelCan } from './personnel.mjs';

const DAY = 86_400_000, WINDOW = 15 * 60_000;
const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const normalize = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
const emailSchema = z.string().max(200).email();
const personIdSchema = z.string().min(1).max(100);
const commandSchema = z.object({ personId: personIdSchema, requestId: z.string().uuid() }).strict();
const temporarySchema = commandSchema.extend({ password: z.string().min(12).max(200).refine(value => value !== 'JerocDemo2026!', 'Välj ett privat lösenord.') }).strict();
const confirmSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), newPassword: z.string().min(12).max(200), confirmPassword: z.string().min(12).max(200) }).strict();
const fail = (message, status = 422, code = 'staff_invitation_invalid') => { throw new PlatformError(message, status, code); };
const changed = () => fail('Personens e-post, konto eller åtkomst har ändrats. Skicka en ny inbjudan.', 409, 'staff_invitation_changed');
const recovery = state => state.passwordRecovery ??= { requests: [], attempts: [] };
const profile = (person, user) => digest({ personId: person.id, userId: person.userId, kind: person.kind,
  email: normalize(person.email), active: person.active, userActive: user.active !== false,
  personSites: [...(person.siteIds ?? [])].sort(), userSites: Array.isArray(user.siteIds) ? [...user.siteIds].sort() : null });
export const staffCredentialFingerprint = account => account ? digest([account.personId, account.username, account.active, account.password, account.updatedAt]) : '';
const existingRecoveryFingerprint = (person, user, account) => digest([person.id, person.userId, person.active,
  user?.active, account.username, account.active, account.password, account.updatedAt]);

/** This runs against live tenant state on both password-sync phases. Permission
 * changes remain live; no role/grant is stored in the activation proof. */
export function validateStaffInvitationTarget(state, target) {
  const person = state.personnel?.people.find(value => value.id === target?.personId);
  const user = state.pricing?.users.find(value => value.id === target?.businessUserId);
  const account = state.personnelAuth?.accounts.find(value => value.personId === target?.personId);
  if (!person || !user || !account || person.kind !== 'employee' || person.active !== true || user.active === false
    || person.userId !== user.id || profile(person, user) !== target.profileFingerprint
    || account.staffInvitationIdentityId !== target.userId || account.username !== target.email) return changed();
  const marker = state.personnelAuth.passwordRecoveries?.find(value => value.personId === person.id && value.requestId === target.requestId);
  if (marker) {
    if (marker.fingerprint !== existingRecoveryFingerprint(person, user, account)) return changed();
  } else if (staffCredentialFingerprint(account) !== target.credentialFingerprint) return changed();
  return { person, user, account };
}

/** Server-selected tenant only. Contact data never grants identity until a
 * manager provisions this one-person, one-company invitation. */
export function createStaffInvitations({ auth, repository = auth?.repository, companyRepository, email, env = process.env,
  now = () => new Date() } = {}) {
  if (!auth?.resolveContext || !auth?.assertCompanyContext || !repository?.transact || typeof companyRepository !== 'function')
    throw new TypeError('Personalinbjudningar saknar autentisering eller lagring.');
  const app = new URL(env.APP_URL || 'https://app.scrapplanner.com');
  if (app.protocol !== 'https:' || app.username || app.password || app.pathname !== '/' || app.search || app.hash)
    throw new TypeError('APP_URL måste vara en HTTPS-adress utan sökväg.');
  const at = () => new Date(now()).toISOString();
  const audit = (state, context, action, values = {}) => state.audit.push({ id: randomUUID(), at: at(),
    actorId: context.actorId, effectiveUserId: context.effectiveUserId, organisationId: context.organisationId, action, ...values });
  async function selected(req, write) {
    const context = await auth.resolveContext(req, { writes: write });
    return { context, business: await companyRepository(context.company) };
  }
  function inspect(state, personId, context) {
    const actual = context.actualUser.id === '__platform-admin' && context.platformAdmin ? context.actualUser
      : state.pricing.users.find(value => value.id === context.actualUser.id);
    const effective = context.user.id === '__platform-admin' && context.platformAdmin ? context.user
      : state.pricing.users.find(value => value.id === context.user.id);
    if (![actual, effective].every(user => user && user.active !== false && personnelCan({ user }, 'users') && personnelCan({ user }, 'personnelRead')))
      fail('Både faktiskt och effektivt konto behöver behörighet att administrera personalens konton.', 403, 'staff_invitation_forbidden');
    const person = state.personnel?.people.find(value => value.id === personId);
    const user = state.pricing.users.find(value => value.id === person?.userId);
    if (!person || person.kind !== 'employee' || !user) fail('Välj en anställd med ett kopplat användarkonto.', 422);
    if (person.active !== true || user.active === false) fail('Aktivera personprofilen och användarkontot först.', 422);
    if (user.level === 'Systemadmin' && [actual, effective].some(value => value.level !== 'Systemadmin'))
      fail('Du kan inte skapa en systemadministratörs inloggning.', 403, 'staff_invitation_forbidden');
    if ([actual, effective].some(value => Array.isArray(value.siteIds)
      && (!Array.isArray(user.siteIds) || user.siteIds.some(id => !value.siteIds.includes(id))
        || person.siteIds.some(id => !value.siteIds.includes(id)))))
      fail('Personens anläggningar ligger utanför din behörighet.', 403, 'staff_invitation_forbidden');
    const parsed = emailSchema.safeParse(normalize(person.email));
    if (!parsed.success) fail('Ange en giltig e-postadress på personkortet innan du skapar inloggningen.', 422, 'staff_invitation_email_invalid');
    const account = state.personnelAuth?.accounts.find(value => value.personId === person.id);
    return { person: clone(person), user: clone(user), account: clone(account), email: parsed.data,
      profileFingerprint: profile(person, user) };
  }
  function linked(state, context, target) {
    const memberships = state.memberships.filter(value => value.organisationId === context.organisationId && value.businessUserId === target.user.id && value.active);
    if (memberships.length > 1) fail('Kontot har flera identitetskopplingar. Kontakta systemadministratören.', 409, 'staff_invitation_conflict');
    return state.users.find(value => value.id === memberships[0]?.userId);
  }
  function view(state, context, target) {
    const user = linked(state, context, target);
    if (user && (!user.staffInvitationIdentity || user.passwordChangedAt || !user.mustChangePassword)
      || target.account && !target.account.staffInvitationIdentityId)
      return { personId: target.person.id, status: 'active', email: target.email };
    const record = [...(state.passwordRecovery?.requests ?? [])].reverse().find(value => value.purpose === 'staff-invitation'
      && value.staffInvitationTarget?.companyId === context.organisationId && value.staffInvitationTarget?.personId === target.person.id);
    const stale = record && (record.staffInvitationTarget.profileFingerprint !== target.profileFingerprint
      || record.staffInvitationTarget.credentialFingerprint !== staffCredentialFingerprint(target.account));
    const status = !record ? 'not_invited' : stale ? 'failed' : record.status === 'temporary_password' ? 'temporary_password'
      : record.expiresAt <= at() ? 'expired' : record.status === 'sent' ? 'sent' : 'failed';
    return { personId: target.person.id, status, email: target.email, ...(record && { expiresAt: record.expiresAt }) };
  }
  async function read(personId, req) {
    if (!personIdSchema.safeParse(personId).success) fail('Välj en person.');
    const { context, business } = await selected(req, false);
    const target = await business.read(state => inspect(state, personId, context), { domains: ['pricing', 'personnel', 'personnelAuth'] });
    return repository.read(state => { auth.assertCompanyContext(state, req, context, false); return view(state, context, target); });
  }
  async function provision(input, req, manual = false) {
    const parsed = (manual ? temporarySchema : commandSchema).safeParse(input);
    if (!parsed.success) fail(manual ? 'Ange en person och ett tillfälligt lösenord med 12–200 tecken.' : 'Välj en person och försök skicka inbjudan igen.');
    if (!manual && (!email?.configured || typeof email.sendStaffInvitation !== 'function'))
      fail('Mejlinbjudan är inte tillgänglig. Kontakta systemadministratören.', 503, 'staff_invitation_unavailable');
    const { context, business } = await selected(req, true);
    const target = await business.read(state => inspect(state, parsed.data.personId, context), { domains: ['pricing', 'personnel', 'personnelAuth'] });
    let temporaryReplay;
    if (manual) {
      const previous = await repository.read(state => {
        auth.assertCompanyContext(state, req, context);
        const record = recovery(state).requests.find(value => value.requestId === parsed.data.requestId);
        const user = state.users.find(value => value.id === record?.userId);
        return record?.purpose === 'staff-invitation' && record.method === 'temporary' && record.status === 'temporary_password'
          && record.staffInvitationTarget?.companyId === context.organisationId && record.staffInvitationTarget.personId === target.person.id
          && record.recipientHash === digest(target.email) && user?.active && user.mustChangePassword && !user.passwordChangedAt
          ? { record: clone(record), user: clone(user) } : undefined;
      });
      if (previous) {
        const actual = await derive(parsed.data.password, previous.user.password.salt, 64), expected = Buffer.from(previous.user.password.digest, 'hex');
        if (actual.length === expected.length && timingSafeEqual(actual, expected))
          temporaryReplay = { userId: previous.user.id, passwordFingerprint: digest(previous.user.password) };
      }
    }
    const token = randomBytes(32).toString('base64url');
    const password = await platformPasswordHash(manual ? parsed.data.password : randomBytes(32).toString('base64url'));
    const reservation = await repository.transact(state => {
      auth.assertCompanyContext(state, req, context);
      const data = recovery(state);
      data.requests = data.requests.filter(value => value.purpose !== 'staff-invitation' || Date.parse(value.expiresAt) > Date.parse(at()) - DAY);
      if (data.requests.length >= 2000) fail('För många väntande inbjudningar. Försök igen senare.', 429, 'staff_invitation_rate_limit');
      const previous = data.requests.find(value => value.requestId === parsed.data.requestId);
      if (previous) {
        if (previous.purpose !== 'staff-invitation' || previous.staffInvitationTarget?.companyId !== context.organisationId
          || previous.staffInvitationTarget.personId !== target.person.id || previous.recipientHash !== digest(target.email)
          || previous.method !== (manual ? 'temporary' : 'email')) fail('Utskicks-ID:t har redan använts för en annan åtgärd.', 409, 'staff_invitation_conflict');
        if (previous.status === 'sent' && previous.expiresAt > at() && !manual
          && previous.staffInvitationTarget.profileFingerprint === target.profileFingerprint
          && previous.staffInvitationTarget.credentialFingerprint === staffCredentialFingerprint(target.account))
          return { reused: true, result: { ok: true, personId: target.person.id, status: 'sent', email: target.email, expiresAt: previous.expiresAt } };
        const replayUser = state.users.find(value => value.id === temporaryReplay?.userId);
        if (manual && temporaryReplay && replayUser?.active && replayUser.mustChangePassword && !replayUser.passwordChangedAt
          && digest(replayUser.password) === temporaryReplay.passwordFingerprint && previous.status === 'temporary_password'
          && previous.staffInvitationTarget.profileFingerprint === target.profileFingerprint
          && previous.staffInvitationTarget.credentialFingerprint === staffCredentialFingerprint(target.account))
          return { reused: true, result: { ok: true, personId: target.person.id, status: 'temporary_password', username: target.email, email: target.email } };
        fail('Försöket har redan behandlats. Uppdatera personen och gör ett nytt försök.', 409, 'staff_invitation_in_progress');
      }
      const old = linked(state, context, target);
      if (old && (!old.staffInvitationIdentity || old.passwordChangedAt || !old.mustChangePassword)
        || target.account && !target.account.staffInvitationIdentityId)
        fail('Personen har redan en inloggning. Använd Glömt lösenord för ett aktiverat konto.', 409, 'staff_invitation_already_active');
      if ((old?.passwordRecoveryPending || old?.passwordSyncPending) && old.passwordSyncLeaseUntil > at())
        fail('Kontot behandlas redan. Vänta och försök igen.', 409, 'staff_invitation_in_progress');
      if (state.users.some(value => value.id !== old?.id && (value.username === target.email || normalize(value.email) === target.email)))
        fail('E-postadressen används redan för en annan inloggning. Kontakta systemadministratören.', 409, 'staff_invitation_email_conflict');
      const attempts = state.staffInvitationAttempts ??= [];
      state.staffInvitationAttempts = attempts.filter(value => Date.parse(value.at) > Date.parse(at()) - WINDOW);
      const recent = state.staffInvitationAttempts;
      if (recent.length >= 100 || recent.filter(value => value.actorId === context.actorId).length >= 30
        || recent.filter(value => value.companyId === context.organisationId && value.personId === target.person.id).length >= 5)
        fail('För många inbjudningar. Vänta 15 minuter innan du försöker igen.', 429, 'staff_invitation_rate_limit');
      recent.push({ at: at(), actorId: context.actorId, companyId: context.organisationId, personId: target.person.id });
      const user = old ?? { id: `staff-${randomUUID()}`, businessId: target.user.id, createdAt: at(), platformAdmin: false, staffInvitationIdentity: true };
      Object.assign(user, { name: target.person.name, username: target.email, email: target.email, active: false, password: clone(password), mustChangePassword: true });
      delete user.passwordRecoveryPending; delete user.passwordSyncPending; delete user.passwordSyncLeaseUntil;
      if (!old) { state.users.push(user); state.memberships.push({ userId: user.id, organisationId: context.organisationId, businessUserId: target.user.id, active: true }); }
      state.sessions = state.sessions.filter(value => value.userId !== user.id);
      for (const value of data.requests) if (value.userId === user.id) value.status = 'superseded';
      const staffInvitationTarget = { companyId: context.organisationId, personId: target.person.id, businessUserId: target.user.id,
        userId: user.id, email: target.email, profileFingerprint: target.profileFingerprint, requestId: parsed.data.requestId };
      const createdAt = at();
      const record = { purpose: 'staff-invitation', requestId: parsed.data.requestId, userId: user.id, recipientHash: digest(target.email),
        tokenHash: digest(token), status: 'preparing', method: manual ? 'temporary' : 'email', createdAt, expiresAt: new Date(Date.parse(createdAt) + DAY).toISOString(), staffInvitationTarget };
      data.requests.push(record); audit(state, context, 'platform.staff_invitation_prepared', { personId: target.person.id, requestId: record.requestId });
      return { userId: user.id, record: clone(record), oldCredentialFingerprint: staffCredentialFingerprint(target.account) };
    });
    if (reservation.reused) return reservation.result;
    try {
      await auth.resolveContext(req, { writes: true });
      const bound = await business.transact(state => {
        const current = inspect(state, target.person.id, context);
        if (current.profileFingerprint !== target.profileFingerprint || staffCredentialFingerprint(current.account) !== reservation.oldCredentialFingerprint) return changed();
        if (state.personnelAuth.accounts.some(value => value.personId !== target.person.id && value.username === target.email))
          fail('E-postadressen används redan för en annan personalinloggning.', 409, 'staff_invitation_email_conflict');
        const account = { personId: target.person.id, username: target.email, password: clone(password), active: false,
          createdAt: current.account?.createdAt ?? at(), updatedAt: at(), staffInvitationIdentityId: reservation.userId };
        state.personnelAuth.accounts = state.personnelAuth.accounts.filter(value => value.personId !== target.person.id).concat(account);
        if (state.personnelAuth.passwordRecoveries)
          state.personnelAuth.passwordRecoveries = state.personnelAuth.passwordRecoveries.filter(value => value.personId !== target.person.id);
        state.personnelAuth.sessions = state.personnelAuth.sessions.filter(value => value.personId !== target.person.id);
        state.personnel.externalAccounts = state.personnelAuth.accounts.map(({ password, ...value }) => value);
        return { ...reservation.record.staffInvitationTarget, credentialFingerprint: staffCredentialFingerprint(account) };
      });
      await repository.transact(state => {
        auth.assertCompanyContext(state, req, context);
        const record = recovery(state).requests.find(value => value.requestId === parsed.data.requestId), user = state.users.find(value => value.id === reservation.userId);
        if (record?.status !== 'preparing' || !user || !user.mustChangePassword || user.passwordChangedAt) return changed();
        record.staffInvitationTarget = bound; user.staffInvitationTarget = clone(bound); user.active = true;
        const candidate = auth.passwordRecoveryCandidate(state, target.email, target.email, { allowPendingInvitation: true });
        if (candidate?.userId !== user.id) return changed();
        record.fingerprint = candidate.fingerprint; record.status = manual ? 'temporary_password' : 'sending';
      });
      if (manual) return { ok: true, personId: target.person.id, status: 'temporary_password', username: target.email, email: target.email };
      const url = new URL('/kontor/', app.origin); url.hash = `/activate-account?token=${token}`;
      await email.sendStaffInvitation({ to: target.email, requestId: parsed.data.requestId, name: target.person.name,
        companyName: context.company.name, username: target.email, activationUrl: url.href,
        createdAt: reservation.record.createdAt, expiresAt: reservation.record.expiresAt });
      await business.read(state => validateStaffInvitationTarget(state, bound), { domains: ['pricing', 'personnel', 'personnelAuth'] });
      return repository.transact(state => {
        auth.assertCompanyContext(state, req, context);
        const record = recovery(state).requests.find(value => value.requestId === parsed.data.requestId), user = state.users.find(value => value.id === reservation.userId);
        if (record?.status !== 'sending' || !user?.mustChangePassword || user.passwordChangedAt) return changed();
        record.status = 'sent'; audit(state, context, 'platform.staff_invitation_sent', { personId: target.person.id, requestId: record.requestId });
        return { ok: true, personId: target.person.id, status: 'sent', email: target.email, expiresAt: record.expiresAt };
      });
    } catch (error) {
      await repository.transact(state => {
        const record = recovery(state).requests.find(value => value.requestId === parsed.data.requestId);
        if (record && ['preparing', 'sending'].includes(record.status)) { record.status = 'failed'; audit(state, context, 'platform.staff_invitation_failed', { personId: target.person.id, requestId: record.requestId }); }
      });
      if (error instanceof PlatformError) throw error;
      fail('Inbjudan kunde inte skickas. Personen är sparad; försök skicka igen från personkortet.', 503, 'staff_invitation_send_failed');
    }
  }
  async function confirm(input, req) {
    await auth.initialize();
    const allowed = await repository.transact(state => {
      const time = Date.parse(at()), address = digest(req.socket?.remoteAddress ?? 'unknown');
      state.staffInvitationConfirmAttempts = (state.staffInvitationConfirmAttempts ?? []).filter(value => value.at > time - WINDOW);
      if (state.staffInvitationConfirmAttempts.length >= 200 || state.staffInvitationConfirmAttempts.filter(value => value.address === address).length >= 30) return false;
      state.staffInvitationConfirmAttempts.push({ at: time, address }); return true;
    });
    if (!allowed) fail('För många försök. Vänta en stund innan du försöker igen.', 429, 'staff_invitation_rate_limit');
    const parsed = confirmSchema.safeParse(input);
    if (!parsed.success) fail('Använd en giltig inbjudningslänk och minst 12 tecken i lösenordet.');
    const tokenHash = digest(parsed.data.token);
    const known = await repository.read(state => recovery(state).requests.some(value => value.tokenHash === tokenHash && value.purpose === 'staff-invitation'));
    if (!known) fail('Inbjudningslänken är ogiltig eller har gått ut. Be om en ny inbjudan.', 422, 'staff_invitation_invalid');
    return auth.completePasswordRecovery({ tokenHash, newPassword: parsed.data.newPassword, confirmPassword: parsed.data.confirmPassword });
  }
  return { read, send: (input, req) => provision(input, req), temporaryPassword: (input, req) => provision(input, req, true), confirm };
}
