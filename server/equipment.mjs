import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { PricingError } from './pricing.mjs';

const identifier = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/);
const revision = z.number().int().nonnegative();
const note = z.string().trim().max(1000);
const editableStatus = z.enum(['available', 'maintenance', 'retired']);
const itemInput = z.object({
  id: identifier.optional(),
  inventoryNumber: z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N}][\p{L}\p{N} ._/-]*$/u, 'Ange ett giltigt inventarienummer.'),
  name: z.string().trim().min(1).max(200),
  category: z.enum(['phone', 'tool', 'ppe', 'key', 'other']),
  siteId: identifier,
  serialNumber: z.string().trim().max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  status: editableStatus.optional(),
  revision: revision.optional(),
}).strict();
const requestId = identifier.optional();
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('item.save'), item: itemInput, requestId }).strict(),
  z.object({ action: z.literal('item.issue'), id: identifier, revision, personId: identifier, note: note.optional(), requestId }).strict(),
  z.object({ action: z.literal('item.return'), id: identifier, revision, condition: z.enum(['available', 'maintenance']).optional(), note: note.optional(), requestId }).strict(),
]);
const filterSchema = z.object({ siteId: identifier.optional(), personId: identifier.optional() }).strict();
const fail = (message, status = 409) => { throw new PricingError(message, status); };
const copy = value => structuredClone(value);
const uid = prefix => `${prefix}-${randomUUID()}`;
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) fail(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' '), 422);
  return result.data;
};
const identities = p => [p?.actor, p?.user];
const active = user => Boolean(user?.id) && user.active !== false;
const can = (user, permission) => active(user) && (user.level === 'Systemadmin' || user.permissions?.includes(permission));
const allowed = (p, permission) => identities(p).every(user => can(user, permission));
const siteVisible = (p, siteId) => identities(p).every(user => active(user) && (!Array.isArray(user.siteIds) || user.siteIds.includes(siteId)));
const personVisible = (p, person) => person.siteIds?.some(siteId => siteVisible(p, siteId));
const currentAssignment = (data, itemId) => data.assignments.find(value => value.itemId === itemId && !value.returnedAt);
const itemFields = item => ({ id: item.id, inventoryNumber: item.inventoryNumber, name: item.name, category: item.category,
  siteId: item.siteId, serialNumber: item.serialNumber ?? '', description: item.description ?? '', status: item.status,
  revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt });
const assignmentFields = assignment => ({ id: assignment.id, itemId: assignment.itemId, personId: assignment.personId,
  siteId: assignment.siteId, itemName: assignment.itemName, inventoryNumber: assignment.inventoryNumber,
  issuedAt: assignment.issuedAt, issuedBy: assignment.issuedBy, issuedActualUserId: assignment.issuedActualUserId,
  issuedEffectiveUserId: assignment.issuedEffectiveUserId, issueNote: assignment.issueNote,
  ...(assignment.returnedAt ? { returnedAt: assignment.returnedAt, returnedBy: assignment.returnedBy,
    returnedActualUserId: assignment.returnedActualUserId, returnedEffectiveUserId: assignment.returnedEffectiveUserId,
    returnCondition: assignment.returnCondition, returnNote: assignment.returnNote } : {}) });
const eventFields = event => ({ id: event.id, action: event.action, itemId: event.itemId, siteId: event.siteId,
  ...(event.personId ? { personId: event.personId } : {}), ...(event.assignmentId ? { assignmentId: event.assignmentId } : {}),
  at: event.at, actualUserId: event.actualUserId, effectiveUserId: event.effectiveUserId, actor: event.actor,
  text: event.text, ...(event.note ? { note: event.note } : {}) });

/** Equipment is a separate persisted domain, never seeded or projected through
 * general personnel, transport or mobile bootstrap data. */
export function ensureEquipment(state) {
  state.equipment ??= { version: 1, revision: 0, items: [], assignments: [], events: [] };
  const data = state.equipment;
  if (data.version !== 1 || !Number.isInteger(data.revision) || data.revision < 0 ||
      !['items', 'assignments', 'events'].every(key => Array.isArray(data[key])))
    fail('Utrustningsregistret har ett format som inte stöds.', 503);
  return data;
}

export function equipmentProjection(state, principal, filters = {}, siteCatalog = []) {
  if (!allowed(principal, 'equipmentRead')) fail('Du saknar behörighet att läsa utrustning.', 403);
  const { siteId, personId } = parse(filterSchema, filters), data = ensureEquipment(state);
  if (siteId && !siteVisible(principal, siteId)) fail('Du saknar åtkomst till anläggningen.', 403);
  const people = (state.personnel?.people ?? []).filter(person => personVisible(principal, person));
  if (personId && !people.some(person => person.id === personId)) fail('Personen finns inte inom din behörighet.', 403);
  const assignments = data.assignments.filter(assignment => siteVisible(principal, assignment.siteId) &&
    (!siteId || assignment.siteId === siteId) && (!personId || assignment.personId === personId));
  const ownItemIds = new Set(assignments.map(assignment => assignment.itemId));
  const items = data.items.filter(item => siteVisible(principal, item.siteId) && (!siteId || item.siteId === siteId) &&
    (!personId || ownItemIds.has(item.id))).map(itemFields);
  // Historical loans keep their original site even when a returned item moves.
  const events = data.events.filter(event => siteVisible(principal, event.siteId) && (!siteId || event.siteId === siteId) &&
    (!personId || event.personId === personId)).map(eventFields);
  return { data: { version: 1, revision: data.revision, items: copy(items), assignments: copy(assignments.map(assignmentFields)), events: copy(events) },
    people: copy(people.filter(person => person.active !== false && person.kind === 'employee' &&
      (!siteId || person.siteIds.includes(siteId))).map(({ id, name, role, team, siteIds, active }) => ({ id, name, role, team, siteIds: siteIds.filter(site => siteVisible(principal, site)), active }))),
    sites: siteCatalog.filter(site => site.active !== false && siteVisible(principal, site.id)).map(({ id, name }) => ({ id, name })),
    revision: data.revision, storage: 'database', capabilities: ['equipmentRead', 'equipmentWrite'].filter(right => allowed(principal, right)) };
}

function requireItem(data, principal, id, expectedRevision) {
  const item = data.items.find(value => value.id === id);
  if (!item) fail('Utrustningen finns inte längre.', 404);
  if (!siteVisible(principal, item.siteId)) fail('Du saknar åtkomst till utrustningens anläggning.', 403);
  if (item.revision !== expectedRevision) fail('Utrustningen har ändrats. Uppdatera sidan och försök igen.');
  return item;
}
function registeredSite(principal, siteCatalog, siteId) {
  if (!siteVisible(principal, siteId)) fail('Välj en anläggning inom din behörighet.', 403);
  if (!siteCatalog.some(site => site.id === siteId && site.active !== false)) fail('Välj en registrerad aktiv anläggning.', 422);
}
function record(data, principal, command, item, details, transactionAudit, now) {
  const event = { id: uid('equipment-event'), action: command.action, itemId: item.id, siteId: item.siteId, at: now,
    actualUserId: principal.actor.id, effectiveUserId: principal.user.id, actor: principal.user.name ?? '', ...details };
  if (command.requestId) Object.assign(event, { requestId: command.requestId, commandHash: createHash('sha256').update(JSON.stringify(command)).digest('hex') });
  data.events.push(event); data.revision++;
  // Generic transaction audit carries references only, never the item's serial
  // number, loan notes or person/contact payloads.
  transactionAudit.push({ id: event.id, domain: 'equipment', action: event.action, itemId: item.id,
    ...(event.personId ? { personId: event.personId } : {}), at: now,
    actualUserId: principal.actor.id, effectiveUserId: principal.user.id });
}

/** Caller executes inside the application repository transaction; item revisions
 * protect competing issue/return actions and requestId protects unknown retries. */
export function equipmentCommand(state, principal, value, transactionAudit = [], siteCatalog = []) {
  if (!allowed(principal, 'equipmentRead') || !allowed(principal, 'equipmentWrite')) fail('Du saknar behörighet att hantera utrustning.', 403);
  const command = parse(commandSchema, value), data = ensureEquipment(state);
  if (command.requestId) {
    const previous = data.events.find(event => event.requestId === command.requestId);
    if (previous) {
      if (previous.commandHash !== createHash('sha256').update(JSON.stringify(command)).digest('hex') ||
          previous.actualUserId !== principal.actor.id || previous.effectiveUserId !== principal.user.id)
        fail('Begäran har redan använts för en annan utrustningsåtgärd.');
      if (!siteVisible(principal, previous.siteId)) fail('Du saknar åtkomst till anläggningen.', 403);
      return equipmentProjection(state, principal, {}, siteCatalog);
    }
  }
  const now = new Date().toISOString();
  if (command.action === 'item.save') {
    const input = command.item, old = input.id && data.items.find(item => item.id === input.id);
    if (old) requireItem(data, principal, old.id, input.revision);
    else if (input.revision !== undefined && input.revision !== 0) fail('Ny utrustning kan inte ha en tidigare revision.', 422);
    registeredSite(principal, siteCatalog, input.siteId);
    const inventoryNumber = input.inventoryNumber.toLocaleUpperCase('sv-SE');
    if (data.items.some(item => item.id !== old?.id && item.inventoryNumber.trim().toLocaleUpperCase('sv-SE') === inventoryNumber))
      fail('Inventarienumret används redan.');
    const issued = old && currentAssignment(data, old.id);
    if (old?.status === 'issued' || issued) {
      if (!issued || old.status !== 'issued') fail('Utrustningens tilldelning behöver kontrolleras.');
      if (input.siteId !== old.siteId) fail('Återlämna utrustningen innan den flyttas till en annan anläggning.');
      if (input.status !== undefined) fail('Tilldelad utrustning måste återlämnas för att byta status.', 422);
    }
    const item = { id: old?.id ?? input.id ?? uid('equipment'), inventoryNumber, name: input.name, category: input.category,
      siteId: input.siteId, serialNumber: input.serialNumber ?? old?.serialNumber ?? '', description: input.description ?? old?.description ?? '',
      status: issued ? 'issued' : input.status ?? old?.status ?? 'available', revision: (old?.revision ?? 0) + 1,
      createdAt: old?.createdAt ?? now, updatedAt: now };
    if (old) data.items[data.items.indexOf(old)] = item; else data.items.push(item);
    record(data, principal, command, item, { text: old ? `Utrustning uppdaterad: ${item.inventoryNumber}.` : `Utrustning registrerad: ${item.inventoryNumber}.` }, transactionAudit, now);
  } else {
    const item = requireItem(data, principal, command.id, command.revision), loan = currentAssignment(data, item.id);
    if (command.action === 'item.issue') {
      registeredSite(principal, siteCatalog, item.siteId);
      if (item.status !== 'available' || loan) fail('Utrustningen är inte tillgänglig för utlämning.');
      const person = (state.personnel?.people ?? []).find(person => person.id === command.personId);
      if (!person || !personVisible(principal, person)) fail('Personen finns inte inom din behörighet.', 403);
      if (person.kind !== 'employee' || person.active === false) fail('Utrustning kan endast lämnas ut till en aktiv anställd.', 422);
      if (!person.siteIds.includes(item.siteId)) fail('Personen tillhör inte utrustningens anläggning.', 422);
      const assignment = { id: uid('equipment-loan'), itemId: item.id, personId: person.id, siteId: item.siteId,
        itemName: item.name, inventoryNumber: item.inventoryNumber, issuedAt: now, issuedBy: principal.user.name ?? '',
        issuedActualUserId: principal.actor.id, issuedEffectiveUserId: principal.user.id, issueNote: command.note ?? '' };
      data.assignments.push(assignment); item.status = 'issued'; item.revision++; item.updatedAt = now;
      record(data, principal, command, item, { personId: person.id, assignmentId: assignment.id,
        text: `Utrustning utlämnad: ${item.inventoryNumber}.`, note: command.note ?? '' }, transactionAudit, now);
    } else {
      if (item.status !== 'issued' || !loan) fail('Utrustningen är redan återlämnad eller saknar aktiv tilldelning.');
      if (!siteVisible(principal, loan.siteId)) fail('Du saknar åtkomst till tilldelningens anläggning.', 403);
      Object.assign(loan, { returnedAt: now, returnedBy: principal.user.name ?? '', returnedActualUserId: principal.actor.id,
        returnedEffectiveUserId: principal.user.id, returnCondition: command.condition ?? 'available', returnNote: command.note ?? '' });
      item.status = loan.returnCondition; item.revision++; item.updatedAt = now;
      record(data, principal, command, item, { personId: loan.personId, assignmentId: loan.id,
        text: `Utrustning återlämnad: ${item.inventoryNumber}.`, note: command.note ?? '' }, transactionAudit, now);
    }
  }
  return equipmentProjection(state, principal, {}, siteCatalog);
}

/** Own equipment needs the authenticated employee relation, not office rights.
 * Historical snapshots avoid leaking a later holder or another site's changes. */
export function employeeEquipmentProjection(state, personOrId, context = {}) {
  const person = (state.personnel?.people ?? []).find(person => person.id === (typeof personOrId === 'string' ? personOrId : personOrId?.id));
  if (!person || person.kind !== 'employee' || person.active === false || !person.userId ||
      person.userId !== context.user?.id || !identities(context).every(active))
    fail('Utrustningsvyn kräver en aktiv anställd med egen inloggning.', 403);
  const data = ensureEquipment(state), assignments = data.assignments.filter(assignment => assignment.personId === person.id &&
    person.siteIds.includes(assignment.siteId) && siteVisible(context, assignment.siteId));
  const ownLoanIds = new Set(assignments.map(assignment => assignment.id)), ownItemIds = new Set(assignments.filter(assignment => !assignment.returnedAt).map(assignment => assignment.itemId));
  const items = data.items.filter(item => ownItemIds.has(item.id) && person.siteIds.includes(item.siteId) && siteVisible(context, item.siteId)).map(itemFields);
  // Only events attached to this person's loans are visible. Item edits and
  // subsequent assignments to another employee never enter this projection.
  const events = data.events.filter(event => event.personId === person.id && ownLoanIds.has(event.assignmentId) &&
    siteVisible(context, event.siteId)).map(({ id, action, itemId, assignmentId, siteId, at, text, note }) =>
      ({ id, action, itemId, assignmentId, siteId, at, text, ...(note ? { note } : {}) }));
  const ownAssignments = assignments.map(assignment => {
    const value = assignmentFields(assignment);
    delete value.issuedBy; delete value.issuedActualUserId; delete value.issuedEffectiveUserId;
    delete value.returnedBy; delete value.returnedActualUserId; delete value.returnedEffectiveUserId;
    return value;
  });
  return { items: copy(items), assignments: copy(ownAssignments), events: copy(events), revision: data.revision };
}
