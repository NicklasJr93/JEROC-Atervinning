import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureEquipment, equipmentProjection, equipmentCommand, employeeEquipmentProjection } from './equipment.mjs';

const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true },
  { id: 'closed', name: 'Stängd', active: false }];
const user = (id, overrides = {}) => ({ id, name: id, level: 'Medarbetare', permissions: ['equipmentRead', 'equipmentWrite'], active: true, ...overrides });
const principal = (effective = user('manager'), actual = effective) => ({ actor: actual, user: effective });
const full = principal(user('admin', { level: 'Systemadmin', permissions: [] }));
const employee = (id, siteIds = ['norrtalje'], overrides = {}) => ({ id, userId: `user-${id}`, name: id, kind: 'employee', active: true,
  role: 'Gårdsarbetare', team: 'Gården', siteIds, email: `${id}@example.invalid`, phone: '0700000000', address: 'Hemadress', salary: 999999, ...overrides });
const state = () => ({ personnel: { people: [employee('niklas'), employee('anna'), employee('rimbo-person', ['rimbo']),
  employee('inactive', ['norrtalje'], { active: false }), employee('external', ['norrtalje'], { kind: 'external' })] } });
const save = (value, p = full, fields = {}, audit = [], extra = {}) => equipmentCommand(value, p, { action: 'item.save',
  item: { inventoryNumber: 'EQ-001', name: 'Telefon', category: 'phone', siteId: 'norrtalje', serialNumber: 'IMEI-001', ...fields }, ...extra }, audit, sites);
const command = (value, payload, p = full, audit = []) => equipmentCommand(value, p, payload, audit, sites);
const create = (value, fields) => save(value, full, fields).data.items.at(-1);
const errorStatus = status => error => error.status === status;

test('initial domain has no seeded equipment and projection is whitelisted', () => {
  const value = state(), data = ensureEquipment(value);
  assert.deepEqual(data, { version: 1, revision: 0, items: [], assignments: [], events: [] });
  const view = equipmentProjection(value, full, {}, sites);
  assert.deepEqual(view.data.items, []);
  assert.deepEqual(view.sites.map(site => site.id), ['norrtalje', 'rimbo']);
  assert.deepEqual(view.people.map(person => person.id), ['niklas', 'anna', 'rimbo-person']);
  for (const person of view.people) assert.deepEqual(Object.keys(person).sort(), ['active', 'id', 'name', 'role', 'siteIds', 'team']);
  assert.equal(JSON.stringify(view).includes('999999'), false);
  assert.equal(JSON.stringify(view).includes('Hemadress'), false);
});

test('issue and return keep server timestamps, actor identities and one complete historical loan', () => {
  const value = state(), audit = [], item = create(value), p = principal(user('acting-manager'), user('real-admin', { level: 'Systemadmin' }));
  const before = Date.now();
  const issued = command(value, { action: 'item.issue', id: item.id, revision: item.revision, personId: 'niklas', note: 'Med laddare' }, p, audit);
  assert.equal(issued.data.items[0].status, 'issued');
  const loan = issued.data.assignments[0];
  assert.equal(loan.issuedActualUserId, 'real-admin'); assert.equal(loan.issuedEffectiveUserId, 'acting-manager');
  assert.ok(Date.parse(loan.issuedAt) >= before && Date.parse(loan.issuedAt) <= Date.now());
  assert.equal(loan.issueNote, 'Med laddare'); assert.equal(loan.siteId, 'norrtalje');
  const returned = command(value, { action: 'item.return', id: item.id, revision: 2, condition: 'maintenance', note: 'Skärmen sprucken' }, p, audit);
  assert.equal(returned.data.items[0].status, 'maintenance');
  assert.equal(returned.data.assignments[0].returnCondition, 'maintenance');
  assert.equal(returned.data.assignments[0].returnNote, 'Skärmen sprucken');
  assert.equal(returned.data.assignments[0].returnedEffectiveUserId, 'acting-manager');
  assert.equal(returned.data.assignments.length, 1);
  assert.ok(returned.data.events.every(event => event.at));
  assert.equal(audit.length, 2);
  assert.equal(JSON.stringify(audit).includes('Med laddare'), false);
  assert.equal(JSON.stringify(audit).includes('IMEI'), false);
  assert.equal(value.personnel.audit, undefined);
});

test('CAS blocks competing issue, stale changes and duplicate return without mutating history', () => {
  const value = state(), item = create(value);
  command(value, { action: 'item.issue', id: item.id, revision: 1, personId: 'niklas' });
  const before = structuredClone(value.equipment);
  assert.throws(() => command(value, { action: 'item.issue', id: item.id, revision: 1, personId: 'anna' }), errorStatus(409));
  assert.throws(() => command(value, { action: 'item.issue', id: item.id, revision: 2, personId: 'anna' }), errorStatus(409));
  assert.throws(() => save(value, full, { id: item.id, revision: 1, name: 'Stale edit' }), errorStatus(409));
  assert.throws(() => save(value, full, { ...item, revision: 1 }), errorStatus(422)); // server-owned fields are never accepted
  assert.deepEqual(value.equipment, before);
  command(value, { action: 'item.return', id: item.id, revision: 2 });
  const afterReturn = structuredClone(value.equipment);
  assert.throws(() => command(value, { action: 'item.return', id: item.id, revision: 3 }), errorStatus(409));
  assert.deepEqual(value.equipment, afterReturn);
});

test('assigned equipment cannot move or change assignment through item.save', () => {
  const value = state(), item = create(value);
  command(value, { action: 'item.issue', id: item.id, revision: 1, personId: 'niklas' });
  assert.throws(() => save(value, full, { id: item.id, revision: 2, siteId: 'rimbo' }), errorStatus(409));
  assert.throws(() => save(value, full, { id: item.id, revision: 2, status: 'available' }), errorStatus(422));
  const corrected = save(value, full, { id: item.id, revision: 2, name: 'Telefon med skal' });
  assert.equal(corrected.data.items[0].status, 'issued');
  assert.equal(corrected.data.assignments[0].itemName, 'Telefon');
  assert.equal(corrected.data.items[0].revision, 3);
});

test('inventory numbers are canonical and unique across the organisation and strict commands prevent tampering', () => {
  const value = state(), item = create(value, { inventoryNumber: ' eq-001 ' });
  assert.equal(item.inventoryNumber, 'EQ-001');
  assert.throws(() => create(value, { inventoryNumber: 'eq-001', siteId: 'rimbo' }), errorStatus(409));
  assert.throws(() => create(value, { inventoryNumber: 'EQ-002', status: 'issued' }), errorStatus(422));
  assert.throws(() => create(value, { inventoryNumber: 'EQ-002', holderId: 'anna' }), errorStatus(422));
  assert.throws(() => command(value, { action: 'item.issue', id: item.id, revision: 1, personId: 'niklas', issuedAt: '2000-01-01T00:00:00Z' }), errorStatus(422));
  assert.throws(() => command(value, { action: 'item.delete', id: item.id }), errorStatus(422));
  assert.throws(() => create(value, { inventoryNumber: 'EQ-002', siteId: 'closed' }), errorStatus(422));
});

test('separate permissions require both actual and effective principal even for elevated roles', () => {
  const value = state();
  for (const p of [principal(user('vd', { level: 'VD', permissions: [] })),
    principal(user('reader', { permissions: ['equipmentRead'] }), user('without-rights', { permissions: [] })),
    principal(user('inactive-admin', { level: 'Systemadmin', active: false }))]) {
    assert.throws(() => equipmentProjection(value, p, {}, sites), errorStatus(403));
    assert.throws(() => save(value, p), errorStatus(403));
  }
  const reader = principal(user('reader', { permissions: ['equipmentRead'] }));
  assert.deepEqual(equipmentProjection(value, reader, {}, sites).capabilities, ['equipmentRead']);
  assert.throws(() => save(value, reader), errorStatus(403));
  assert.equal(save(value, full).data.items.length, 1);
});

test('sites are intersected across principals, people choices and assignees', () => {
  const value = state(), item = create(value), other = create(value, { inventoryNumber: 'EQ-002', siteId: 'rimbo' });
  const scoped = principal(user('effective', { siteIds: ['norrtalje', 'rimbo'] }), user('actual', { siteIds: ['norrtalje'] }));
  const view = equipmentProjection(value, scoped, {}, sites);
  assert.deepEqual(view.data.items.map(item => item.id), [item.id]);
  assert.deepEqual(view.people.map(person => person.id), ['niklas', 'anna']);
  assert.deepEqual(view.sites.map(site => site.id), ['norrtalje']);
  assert.throws(() => equipmentProjection(value, scoped, { siteId: 'rimbo' }, sites), errorStatus(403));
  assert.throws(() => command(value, { action: 'item.issue', id: other.id, revision: 1, personId: 'rimbo-person' }, scoped), errorStatus(403));
  assert.throws(() => command(value, { action: 'item.issue', id: item.id, revision: 1, personId: 'rimbo-person' }, scoped), errorStatus(403));
  assert.throws(() => command(value, { action: 'item.issue', id: item.id, revision: 1, personId: 'rimbo-person' }), errorStatus(422));
});

test('inactive and external people and unavailable equipment cannot be issued', () => {
  const value = state(), item = create(value);
  for (const personId of ['inactive', 'external']) assert.throws(() => command(value, { action: 'item.issue', id: item.id, revision: 1, personId }), errorStatus(422));
  const retired = create(value, { inventoryNumber: 'EQ-002', status: 'retired' });
  assert.throws(() => command(value, { action: 'item.issue', id: retired.id, revision: 1, personId: 'niklas' }), errorStatus(409));
});

test('historical loans and events stay at the original site when item and employee move', () => {
  const value = state(), item = create(value);
  command(value, { action: 'item.issue', id: item.id, revision: 1, personId: 'niklas', note: 'Historisk not' });
  command(value, { action: 'item.return', id: item.id, revision: 2 });
  save(value, full, { id: item.id, revision: 3, siteId: 'rimbo' });
  value.personnel.people.find(person => person.id === 'niklas').siteIds = ['rimbo'];
  const oldSite = equipmentProjection(value, principal(user('old-site', { siteIds: ['norrtalje'] })), {}, sites);
  assert.equal(oldSite.data.items.length, 0); assert.equal(oldSite.data.assignments.length, 1);
  assert.equal(oldSite.data.assignments[0].siteId, 'norrtalje'); assert.equal(oldSite.data.events.length, 3);
  const newSite = equipmentProjection(value, principal(user('new-site', { siteIds: ['rimbo'] })), {}, sites);
  assert.equal(newSite.data.items.length, 1); assert.equal(newSite.data.assignments.length, 0);
  assert.equal(newSite.data.events.length, 1); assert.equal(JSON.stringify(newSite).includes('Historisk not'), false);
});

test('employee view contains only current own equipment and own loan history, without another holder or actor names', () => {
  const value = state(), item = create(value), person = value.personnel.people[0], own = user(person.userId, { permissions: [] });
  command(value, { action: 'item.issue', id: item.id, revision: 1, personId: 'niklas', note: 'Egen laddare' });
  let view = employeeEquipmentProjection(value, person, principal(own));
  assert.equal(view.items.length, 1); assert.equal(view.assignments.length, 1); assert.equal(view.events.length, 1);
  command(value, { action: 'item.return', id: item.id, revision: 2 });
  command(value, { action: 'item.issue', id: item.id, revision: 3, personId: 'anna', note: 'Annas hemliga not' });
  view = employeeEquipmentProjection(value, person, principal(own));
  assert.equal(view.items.length, 0); assert.equal(view.assignments.length, 1); assert.equal(view.events.length, 2);
  assert.equal(view.assignments[0].itemName, 'Telefon');
  assert.equal(view.assignments[0].issuedBy, undefined);
  assert.equal(JSON.stringify(view).includes('anna'), false); assert.equal(JSON.stringify(view).includes('admin'), false);
  assert.equal(JSON.stringify(view).includes('Annas hemliga not'), false);
});

test('employee identity, active profile and permissions are freshly checked after site or account changes', () => {
  const value = state(), item = create(value), person = value.personnel.people[0], own = user(person.userId, { siteIds: ['norrtalje'], permissions: [] });
  command(value, { action: 'item.issue', id: item.id, revision: 1, personId: 'niklas' });
  assert.throws(() => employeeEquipmentProjection(value, person, principal(user('user-anna'))), errorStatus(403));
  assert.equal(employeeEquipmentProjection(value, person, principal(own)).items.length, 1);
  own.siteIds = ['rimbo'];
  assert.deepEqual(employeeEquipmentProjection(value, person, principal(own)).items, []);
  assert.deepEqual(employeeEquipmentProjection(value, person, principal(own)).assignments, []);
  person.active = false;
  assert.throws(() => employeeEquipmentProjection(value, { ...person, active: true }, principal(own)), errorStatus(403));
});

test('requestId handles unknown delivery retries without double issue and rejects altered or impersonated retries', () => {
  const value = state(), audit = [], item = create(value), payload = { action: 'item.issue', id: item.id, revision: 1,
    personId: 'niklas', requestId: 'request-unique-1' };
  command(value, payload, full, audit);
  const before = structuredClone(value.equipment);
  const replay = command(value, payload, full, audit);
  assert.equal(replay.data.items[0].status, 'issued'); assert.deepEqual(value.equipment, before); assert.equal(audit.length, 1);
  assert.equal(replay.data.events.some(event => event.commandHash || event.requestId), false);
  assert.throws(() => command(value, { ...payload, personId: 'anna' }), errorStatus(409));
  assert.throws(() => command(value, payload, principal(user('other-admin', { level: 'Systemadmin' }))), errorStatus(409));
  assert.deepEqual(value.equipment, before);
});
