// Light agency workflow for fictional, browser-local demonstration accounts.
// A personal number finds an existing account; it is neither a password nor
// verified identity. Production authorization must be enforced on the server.
export const PERMISSIONS = Object.freeze([
  { id: 'read', label: 'Läsa och granska' },
  { id: 'bookkeeping', label: 'Bokföra och fakturera' },
  { id: 'payroll', label: 'Hantera lön' },
  { id: 'closing', label: 'Moms, periodlåsning och bokslut' },
  { id: 'payments', label: 'Registrera betalningar' },
  { id: 'export', label: 'Exportera underlag' },
].map(Object.freeze));
const permissionIds = new Set(PERMISSIONS.map(item => item.id));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const copy = value => structuredClone(value);
const idValid = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(value);
const textValid = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const isoValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function normalizePersonalNumber(value) {
  check(typeof value === 'string', 'Ange personnumret med tolv siffror: ÅÅÅÅMMDD-XXXX.');
  const trimmed = value.trim();
  check(/^(?:\d{12}|\d{8}-\d{4})$/.test(trimmed), 'Ange personnumret med tolv siffror: ÅÅÅÅMMDD-XXXX.');
  const number = trimmed.replace('-', '');
  const date = `${number.slice(0, 4)}-${number.slice(4, 6)}-${number.slice(6, 8)}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  check(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date, 'Personnumret innehåller ett ogiltigt datum.');
  const sum = [...number.slice(2)].reduce((total, digit, index) => {
    const product = Number(digit) * (index % 2 === 0 ? 2 : 1);
    return total + Math.floor(product / 10) + product % 10;
  }, 0);
  check(sum % 10 === 0, 'Personnumrets kontrollsiffra stämmer inte.');
  return number;
}
export function formatPersonalNumber(value) {
  const number = normalizePersonalNumber(value);
  return `${number.slice(0, 8)}-${number.slice(8)}`;
}
export function maskPersonalNumber(value) {
  return `${normalizePersonalNumber(value).slice(0, 8)}-••••`;
}
function normalizePermissions(values) {
  check(Array.isArray(values) && values.length <= PERMISSIONS.length, 'Välj giltiga behörigheter.');
  check(values.every(value => permissionIds.has(value)) && new Set(values).size === values.length, 'Behörigheterna innehåller ett okänt eller upprepat val.');
  return PERMISSIONS.filter(item => item.id === 'read' || values.includes(item.id)).map(item => item.id);
}
const findUser = (state, id) => state.users.find(item => item.id === id);
const findCompany = (state, id) => state.companies.find(item => item.id === id);
function activeUser(state, id) {
  const user = findUser(state, id);
  check(user?.active === true, 'Demopersonen finns inte eller är inaktiverad.');
  return user;
}
function owner(state, actorId, companyId) {
  activeUser(state, actorId);
  const company = findCompany(state, companyId);
  check(company && company.ownerId === actorId, 'Bara bolagets ägare får hantera denna åtkomst.');
  return company;
}
function invitation(state, id) {
  const item = state.invitations.find(entry => entry.id === id);
  check(item, 'Inbjudan finns inte.');
  return item;
}
function recipient(state, actorId, item) {
  const user = activeUser(state, actorId);
  check(item.recipientId === actorId && user.agencyId === item.agencyId, 'Bara den inbjudna byråmedarbetaren får besvara inbjudan.');
  return user;
}
function agencyAdmin(state, actorId) {
  const user = activeUser(state, actorId);
  const agency = state.agencies.find(item => item.id === user.agencyId);
  check(agency?.adminIds.includes(actorId), 'Bara byråns administratör får ändra byråpersonalen.');
  return agency;
}
function nextId(state, prefix) { state.sequence += 1; return `${prefix}-${state.sequence}`; }
function instant(options) {
  const now = typeof options?.now === 'function' ? options.now() : options?.now ?? new Date().toISOString();
  check(isoValid(now), 'Händelsens tidpunkt är ogiltig.');
  return now;
}
function record(state, type, label, actorId, now, details = {}) {
  state.activity.push({ id: nextId(state, 'agency-event'), type, label, actorId, createdAt: now, ...copy(details) });
}
function transact(state, callback, options) {
  validateAgencyState(state);
  const next = copy(state), now = instant(options);
  callback(next, now);
  check(next.sequence >= state.sequence, 'Byråhistorikens nummerserie får inte flyttas bakåt.');
  check(state.activity.every((item, index) => JSON.stringify(item) === JSON.stringify(next.activity[index])), 'Tidigare byråhändelser får inte ändras eller raderas.');
  validateAgencyState(next);
  return next;
}

export function createAgencyState() {
  return {
    schemaVersion: 1, sequence: 0,
    users: [
      { id: 'user-ake', name: 'Åke · demoperson', personalNumber: '209001010017', agencyId: null, active: true },
      { id: 'user-bjork', name: 'Björk · demoperson', personalNumber: '209002020023', agencyId: null, active: true },
      { id: 'user-jenny', name: 'Jenny · demoperson', personalNumber: '209003030039', agencyId: 'lexratio', active: true },
      { id: 'user-anki', name: 'Anki · demoperson', personalNumber: '209004040045', agencyId: 'lexratio', active: true },
    ],
    agencies: [{ id: 'lexratio', name: 'Lexratio · demobyrå', adminIds: ['user-jenny'] }],
    companies: [
      { id: 'company-ake', name: 'Åkes Hantverk AB', ownerId: 'user-ake' },
      { id: 'company-bjork', name: 'Björks El AB', ownerId: 'user-bjork' },
    ],
    invitations: [], activity: [],
  };
}

export function inviteMember(state, { actorId, companyId, personalNumber, permissions }, options) {
  return transact(state, (next, now) => {
    owner(next, actorId, companyId);
    const number = normalizePersonalNumber(personalNumber);
    const user = next.users.find(item => item.personalNumber === number);
    check(user?.active && user.agencyId, 'Ingen aktiv byråmedarbetare med detta personnummer finns i demoregistret.');
    check(user.id !== actorId, 'Du kan inte bjuda in dig själv.');
    check(!next.invitations.some(item => item.companyId === companyId && item.recipientId === user.id && ['pending', 'accepted'].includes(item.status)), 'Personen har redan en väntande inbjudan eller aktiv åtkomst till bolaget.');
    const item = { id: nextId(next, 'invitation'), companyId, recipientId: user.id, agencyId: user.agencyId,
      createdBy: actorId, permissions: normalizePermissions(permissions), status: 'pending', createdAt: now, updatedAt: now, decidedAt: null };
    next.invitations.push(item);
    record(next, 'invitation-created', 'Inbjudan till byråmedarbetare skapad.', actorId, now,
      { companyId, recipientId: user.id, invitationId: item.id, permissions: item.permissions });
  }, options);
}
export function acceptInvitation(state, { actorId, invitationId }, options) {
  return transact(state, (next, now) => {
    const item = invitation(next, invitationId);
    recipient(next, actorId, item);
    check(item.status === 'pending', 'Bara en väntande inbjudan kan accepteras.');
    check(findUser(next, findCompany(next, item.companyId).ownerId)?.active, 'Bolagets ägare är inaktiverad.');
    item.status = 'accepted'; item.updatedAt = now; item.decidedAt = now;
    record(next, 'invitation-accepted', 'Byråmedarbetaren accepterade inbjudan.', actorId, now,
      { companyId: item.companyId, recipientId: item.recipientId, invitationId });
  }, options);
}
export function declineInvitation(state, { actorId, invitationId }, options) {
  return transact(state, (next, now) => {
    const item = invitation(next, invitationId);
    recipient(next, actorId, item);
    check(item.status === 'pending', 'Bara en väntande inbjudan kan avböjas.');
    item.status = 'declined'; item.updatedAt = now; item.decidedAt = now;
    record(next, 'invitation-declined', 'Byråmedarbetaren avböjde inbjudan.', actorId, now,
      { companyId: item.companyId, recipientId: item.recipientId, invitationId });
  }, options);
}
export function revokeInvitation(state, { actorId, invitationId }, options) {
  return transact(state, (next, now) => {
    const item = invitation(next, invitationId);
    owner(next, actorId, item.companyId);
    check(['pending', 'accepted'].includes(item.status), 'Bara en väntande inbjudan eller aktiv åtkomst kan återkallas.');
    item.status = 'revoked'; item.updatedAt = now; item.decidedAt = now;
    record(next, 'invitation-revoked', 'Bolagsägaren återkallade inbjudan eller åtkomsten.', actorId, now,
      { companyId: item.companyId, recipientId: item.recipientId, invitationId });
  }, options);
}
export function updatePermissions(state, { actorId, invitationId, permissions }, options) {
  return transact(state, (next, now) => {
    const item = invitation(next, invitationId);
    owner(next, actorId, item.companyId);
    check(['pending', 'accepted'].includes(item.status), 'Återkallad eller avböjd åtkomst kan inte ändras. Skapa en ny inbjudan.');
    const normalized = normalizePermissions(permissions);
    check(JSON.stringify(item.permissions) !== JSON.stringify(normalized), 'Behörigheterna är redan inställda så.');
    item.permissions = normalized; item.updatedAt = now;
    record(next, 'permissions-updated', 'Bolagsägaren uppdaterade behörigheterna.', actorId, now,
      { companyId: item.companyId, recipientId: item.recipientId, invitationId, permissions: normalized });
  }, options);
}
export function registerAgencyUser(state, { actorId, name, personalNumber }, options) {
  return transact(state, (next, now) => {
    const agency = agencyAdmin(next, actorId);
    check(textValid(name), 'Ange ett namn på byråmedarbetaren.');
    const number = normalizePersonalNumber(personalNumber);
    check(!next.users.some(item => item.personalNumber === number), 'Personnumret finns redan i demoregistret.');
    const user = { id: nextId(next, 'agency-user'), name: name.trim(), personalNumber: number, agencyId: agency.id, active: true,
      createdBy: actorId, createdAt: now };
    next.users.push(user);
    record(next, 'user-registered', 'En demomedarbetare registrerades hos byrån.', actorId, now, { recipientId: user.id });
  }, options);
}
export function setAgencyUserActive(state, { actorId, userId, active }, options) {
  return transact(state, (next, now) => {
    const agency = agencyAdmin(next, actorId), user = findUser(next, userId);
    check(user && user.agencyId === agency.id, 'Personen tillhör inte din byrå.');
    check(typeof active === 'boolean' && active !== user.active, 'Välj en annan giltig personalstatus.');
    check(user.id !== actorId || active, 'Du kan inte inaktivera ditt eget administratörskonto.');
    check(active || !agency.adminIds.includes(userId) || agency.adminIds.some(id => id !== userId && findUser(next, id)?.active), 'Byrån måste ha minst en aktiv administratör.');
    user.active = active;
    // Removing a staff member ends their outstanding company assignments. A
    // later reactivation must not silently restore earlier company access.
    if (!active) {
      for (const item of next.invitations.filter(entry => entry.recipientId === userId && ['pending', 'accepted'].includes(entry.status))) {
        item.status = 'revoked'; item.updatedAt = now; item.decidedAt = now;
        record(next, 'invitation-revoked', 'Åtkomst återkallad när byråmedarbetaren inaktiverades.', actorId, now,
          { companyId: item.companyId, recipientId: userId, invitationId: item.id });
      }
    }
    record(next, active ? 'user-activated' : 'user-deactivated', active ? 'Byråmedarbetaren aktiverades.' : 'Byråmedarbetaren inaktiverades.', actorId, now, { recipientId: userId });
  }, options);
}

export function hasPermission(state, userId, companyId, permission) {
  validateAgencyState(state);
  if (permission !== 'manage' && !permissionIds.has(permission)) return false;
  const user = findUser(state, userId), company = findCompany(state, companyId);
  if (!user?.active || !company) return false;
  if (company.ownerId === userId) return true;
  if (permission === 'manage' || !user.agencyId) return false;
  return state.invitations.some(item => item.companyId === companyId && item.recipientId === userId && item.agencyId === user.agencyId && item.status === 'accepted' && item.permissions.includes(permission));
}
export function getCompanyAccess(state, userId) {
  validateAgencyState(state);
  return state.companies.filter(item => hasPermission(state, userId, item.id, 'read')).map(copy);
}

export function validateAgencyState(state) {
  check(state && state.schemaVersion === 1 && Number.isSafeInteger(state.sequence) && state.sequence >= 0 && state.sequence <= 1_000_000, 'Byrådemons format eller nummerserie är ogiltig.');
  for (const name of ['users', 'agencies', 'companies', 'invitations', 'activity']) check(Array.isArray(state[name]) && state[name].length <= 10000, 'Byrådemons register är ogiltigt.');
  const ids = new Set();
  for (const item of [...state.users, ...state.agencies, ...state.companies, ...state.invitations, ...state.activity]) {
    check(item && idValid(item.id) && !ids.has(item.id), 'Registret innehåller ett ogiltigt eller upprepat ID.'); ids.add(item.id);
    const sequence = /^(?:invitation|agency-event|agency-user)-(\d+)$/.exec(item.id);
    if (sequence) check(Number(sequence[1]) <= state.sequence && Number(sequence[1]) > 0, 'Byrådemons nummerserie ligger efter ett registrerat ID.');
  }
  const numbers = new Set();
  for (const user of state.users) {
    check(textValid(user.name) && typeof user.active === 'boolean' && (user.agencyId === null || state.agencies.some(item => item.id === user.agencyId)), 'En demopersons uppgifter är ogiltiga.');
    check(normalizePersonalNumber(user.personalNumber) === user.personalNumber && !numbers.has(user.personalNumber), 'Registret innehåller ett felaktigt eller upprepat personnummer.'); numbers.add(user.personalNumber);
    if (user.createdAt !== undefined) check(isoValid(user.createdAt) && findUser(state, user.createdBy)?.agencyId === user.agencyId, 'Registreringen av byråmedarbetaren är ogiltig.');
  }
  for (const agency of state.agencies) {
    check(textValid(agency.name) && Array.isArray(agency.adminIds) && agency.adminIds.length > 0 && new Set(agency.adminIds).size === agency.adminIds.length && agency.adminIds.every(id => findUser(state, id)?.agencyId === agency.id) && agency.adminIds.some(id => findUser(state, id)?.active), 'Byrån saknar giltiga administratörer.');
  }
  for (const company of state.companies) check(textValid(company.name) && findUser(state, company.ownerId), 'Bolaget saknar giltigt namn eller ägare.');
  const assignments = new Set();
  for (const item of state.invitations) {
    const user = findUser(state, item.recipientId), company = findCompany(state, item.companyId);
    check(company && company.ownerId === item.createdBy && user?.agencyId === item.agencyId && user.id !== company.ownerId, 'Inbjudans bolag, mottagare eller byrå stämmer inte.');
    check(['pending', 'accepted', 'declined', 'revoked'].includes(item.status), 'Inbjudans status är ogiltig.');
    check(JSON.stringify(normalizePermissions(item.permissions)) === JSON.stringify(item.permissions), 'Inbjudans behörigheter är ogiltiga eller saknar läsrätt.');
    check(isoValid(item.createdAt) && isoValid(item.updatedAt) && item.updatedAt >= item.createdAt && (item.decidedAt === null || isoValid(item.decidedAt) && item.decidedAt >= item.createdAt && item.decidedAt <= item.updatedAt), 'Inbjudans tidpunkter är ogiltiga.');
    check((item.status === 'pending') === (item.decidedAt === null), 'Inbjudans beslut och status stämmer inte.');
    if (['pending', 'accepted'].includes(item.status)) {
      const key = `${item.companyId}:${item.recipientId}`;
      check(user.active && !assignments.has(key), 'Samma person har dubbla aktiva bolagsuppdrag eller är inaktiverad.'); assignments.add(key);
    }
  }
  const histories = new Map(), activeStates = new Map(state.users.map(user => [user.id, true]));
  const eventKeys = new Set(['id', 'type', 'label', 'actorId', 'createdAt', 'companyId', 'recipientId', 'invitationId', 'permissions']);
  for (const event of state.activity) {
    check(Object.keys(event).every(key => eventKeys.has(key)) && textValid(event.label) && findUser(state, event.actorId) && isoValid(event.createdAt), 'Byråhistoriken innehåller en ogiltig händelse.');
    if (event.invitationId) {
      const item = state.invitations.find(value => value.id === event.invitationId);
      check(item && event.companyId === item.companyId && event.recipientId === item.recipientId, 'Byråhistorikens inbjudan stämmer inte.');
      const history = histories.get(item.id);
      if (event.type === 'invitation-created') {
        check(!history && event.actorId === item.createdBy && event.createdAt === item.createdAt, 'Inbjudan har en ogiltig skapandehändelse.');
        histories.set(item.id, { status: 'pending', permissions: normalizePermissions(event.permissions), updatedAt: event.createdAt, decidedAt: null });
      } else {
        check(history && event.createdAt >= history.updatedAt, 'Inbjudans historik är i fel ordning.');
        if (event.type === 'permissions-updated') {
          check(['pending', 'accepted'].includes(history.status) && event.actorId === item.createdBy, 'Behörighetsändringen är ogiltig.'); history.permissions = normalizePermissions(event.permissions);
        } else if (['invitation-accepted', 'invitation-declined'].includes(event.type)) {
          check(history.status === 'pending' && event.actorId === item.recipientId, 'Inbjudans svar är ogiltigt.');
          history.status = event.type === 'invitation-accepted' ? 'accepted' : 'declined'; history.decidedAt = event.createdAt;
        } else if (event.type === 'invitation-revoked') {
          const actor = findUser(state, event.actorId), agency = state.agencies.find(value => value.id === item.agencyId);
          check(['pending', 'accepted'].includes(history.status) && (event.actorId === item.createdBy || actor.agencyId === item.agencyId && agency.adminIds.includes(actor.id)), 'Återkallelsen är ogiltig.');
          history.status = 'revoked'; history.decidedAt = event.createdAt;
        } else check(false, 'Byråhistoriken innehåller en okänd inbjudanshändelse.');
        history.updatedAt = event.createdAt;
      }
    } else {
      const user = findUser(state, event.recipientId), actor = findUser(state, event.actorId);
      const agency = state.agencies.find(value => value.id === actor?.agencyId);
      check(user && agency?.adminIds.includes(actor.id) && user.agencyId === agency.id && !event.companyId && !event.permissions, 'Byråhistorikens personalhändelse är ogiltig.');
      check(['user-registered', 'user-activated', 'user-deactivated'].includes(event.type), 'Byråhistoriken innehåller en okänd händelse.');
      if (event.type === 'user-registered') check(user.createdBy === actor.id && user.createdAt === event.createdAt, 'Personalregistreringens historik stämmer inte.');
      else activeStates.set(user.id, event.type === 'user-activated');
    }
  }
  for (const item of state.invitations) {
    const history = histories.get(item.id);
    check(history && history.status === item.status && history.updatedAt === item.updatedAt && history.decidedAt === item.decidedAt && JSON.stringify(history.permissions) === JSON.stringify(item.permissions), 'Inbjudans sparade uppgifter stämmer inte med historiken.');
  }
  for (const user of state.users) {
    check(activeStates.get(user.id) === user.active, 'Demopersonens status saknar en historikhändelse.');
    if (user.createdAt !== undefined) check(state.activity.filter(event => event.type === 'user-registered' && event.recipientId === user.id).length === 1, 'Demopersonens registreringshistorik saknas.');
  }
  return state;
}
