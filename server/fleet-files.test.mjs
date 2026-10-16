import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import { createApplicationRepository } from './application-storage.mjs';
import { employeeRequestPrincipal } from './mobile-employee-api.mjs';
import { resolvePricingPrincipal } from './pricing.mjs';
import { attachPlatformContext } from './platform-auth.mjs';
import { tenantRuntimeEnvironment } from './tenant-runtime.mjs';
import { employeeFleetProjection, employeeFleetCommand, ingestFleetTrip } from './fleet.mjs';
import { createFleetFileRepository, createFleetFilesApi, prepareFleetFile, assertFleetFileReferences, MAX_FLEET_FILE_BYTES } from './fleet-files.mjs';

const png = () => sharp({ create: { width: 2400, height: 1000, channels: 3, background: '#ace' } }).png().withMetadata({ orientation: 6 }).toBuffer();
const pdf = () => new Promise(resolve => { const chunks = [], document = new PDFDocument(); document.on('data', chunk => chunks.push(chunk)); document.on('end', () => resolve(Buffer.concat(chunks))); document.text('Real fleet service document'); document.end(); });
const user = (id, permissions = [], siteIds) => ({ id, name: id, active: true, level: 'Medarbetare', permissions, ...(siteIds ? { siteIds } : {}) });
const seed = tokens => ({ pricing: { users: [{ ...user('admin'), level: 'Systemadmin' }, user('writer', ['fleetRead', 'fleetWrite'], ['north']), user('reader', ['fleetRead'], ['north']),
  user('south', ['fleetRead', 'fleetWrite'], ['south']), user('alice', [], ['north']), user('bob', [], ['south'])] },
  personnel: { people: [{ id: 'person-alice', userId: 'alice', active: true, kind: 'employee', name: 'Alice', siteIds: ['north'], vehicleId: 'vehicle-a' },
    { id: 'person-bob', userId: 'bob', active: true, kind: 'employee', name: 'Bob', siteIds: ['south'], vehicleId: 'vehicle-b' }] },
  personnelAuth: { accounts: [{ personId: 'person-alice', active: true }, { personId: 'person-bob', active: true }], sessions: Object.entries(tokens).map(([who, token]) => ({ kind: 'employee', personId: `person-${who}`, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: '2099-01-01T00:00:00Z' })) },
  transport: { vehicles: [{ id: 'vehicle-a', registration: 'AAA111', name: 'Alice vehicle', types: [] }, { id: 'vehicle-b', registration: 'BBB222', name: 'Bob vehicle', types: [] }, { id: 'same-site-unassigned', registration: 'CCC333', name: 'Other resource', types: [] }], orders: [] },
  fleet: { version: 1, revision: 0, profiles: { 'vehicle-a': { vehicleId: 'vehicle-a', siteId: 'north' }, 'vehicle-b': { vehicleId: 'vehicle-b', siteId: 'south' }, 'same-site-unassigned': { vehicleId: 'same-site-unassigned', siteId: 'north' } }, services: [], issues: [], inspections: [], trips: [], events: [], requests: [] } });

async function fixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-fleet-files-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite'), JEROC_FLEET_FILES_DB_PATH: join(directory, 'files.sqlite'), JEROC_TENANT_ID: 'company-a' };
  const tokens = { alice: randomUUID(), bob: randomUUID() }, repository = await createApplicationRepository({ env, seed: () => seed(tokens) });
  const files = await createFleetFileRepository({ env });
  let failCommit = false, uncertainCommit = false, beforeCommit, context, streamStarted;
  const wrapped = { ...repository, transact: async (operation, opts) => {
    const hook = beforeCommit; beforeCommit = undefined; if (hook) await hook();
    const result = await repository.transact(async (...args) => { const value = await operation(...args); if (failCommit) throw new Error('Injected transaction rollback'); return value; }, opts);
    if (uncertainCommit) throw new Error('Injected lost commit acknowledgement'); return result;
  } };
  const api = createFleetFilesApi({ env, getRepository: async () => wrapped, ownPrincipal: employeeRequestPrincipal,
    officePrincipal: (state, req) => { const actor = req.headers['x-demo-actor']; return actor ? resolvePricingPrincipal(state.pricing.users, actor, req.headers['x-demo-user'] ?? actor) : undefined; },
    fileRepository: files, json: (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }, ...options });
  const server = createServer((req, res) => {
    if (context) attachPlatformContext(req, structuredClone(context));
    if (streamStarted) { const iterator = req[Symbol.asyncIterator].bind(req); req[Symbol.asyncIterator] = () => { streamStarted(); return iterator(); }; }
    void api(req, res, new URL(req.url, 'http://localhost')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { actor, effective, employee, bytes, contentType = 'image/png', name = 'Fordon.png', method, headers = {} } = {}) => fetch(base + path, {
    method: method ?? (bytes ? 'POST' : 'GET'), headers: { ...(actor ? { 'X-Demo-Actor': actor, 'X-Demo-User': effective ?? actor } : {}), ...(employee ? { Cookie: `jeroc_employee=${tokens[employee] ?? employee}` } : {}),
      ...(bytes ? { 'Content-Type': contentType, 'X-File-Name': encodeURIComponent(name) } : {}), ...headers }, body: bytes, signal: AbortSignal.timeout(5000) });
  try { await run({ env, files, repository, request, base, tokens, api,
    failCommit: value => { failCommit = value; }, uncertainCommit: value => { uncertainCommit = value; }, beforeCommit: hook => { beforeCommit = hook; },
    platformContext: value => { context = value; }, streamStarted: callback => { streamStarted = callback; } }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await api.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('real PNG/JPEG/WebP inputs become bounded JPEGs without EXIF, while real PDF structure and declared types are validated', async () => {
  const image = await png(), prepared = await prepareFleetFile(image, 'image/png', '../../ Återvinning.png', 'photo'), info = await sharp(prepared.bytes).metadata();
  assert.equal(prepared.contentType, 'image/jpeg'); assert.equal(prepared.name, 'Återvinning.jpg'); assert.ok(info.width <= 1800 && info.height <= 1800); assert.equal(info.exif, undefined); assert.equal(info.orientation, undefined);
  for (const [format, contentType] of [['jpeg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const bytes = await sharp(image)[format]().toBuffer(); assert.equal((await prepareFleetFile(bytes, contentType, 'photo', 'photo')).contentType, 'image/jpeg');
  }
  const document = await pdf(), saved = await prepareFleetFile(document, 'application/pdf', '../../service.pdf', 'document'); assert.deepEqual(saved.bytes, document); assert.equal(saved.name, 'service.pdf');
  for (const [bytes, type, kind] of [[image, 'image/jpeg', 'photo'], [document, 'image/png', 'photo'], [Buffer.from('<svg/>'), 'image/png', 'photo'], [Buffer.from('%PDF-1.7\n<script>alert(1)</script>\n%%EOF'), 'application/pdf', 'document'], [document.subarray(0, document.length - 20), 'application/pdf', 'document'], [document, 'application/pdf', 'photo']])
    await assert.rejects(prepareFleetFile(bytes, type, 'fake', kind), error => error.status === 415);
  await assert.rejects(prepareFleetFile(Buffer.alloc(MAX_FLEET_FILE_BYTES + 1), 'image/png', 'too-big.png', 'photo'), error => error.status === 413);
  await assert.rejects(prepareFleetFile(Buffer.alloc(0), 'image/png', 'empty.png', 'photo'), error => error.status === 413);
  await assert.rejects(prepareFleetFile(image, 'image/png', 'file.png', 'forged'), error => error.status === 422);
});

test('binary repository persists immutable bytes separately and enforces real-byte per-vehicle quotas', async () => {
  const files = await createFleetFileRepository({ env: { JEROC_FLEET_FILES_DB_PATH: ':memory:' }, vehicleByteLimit: 10, vehicleFileLimit: 2 });
  const record = (id, vehicleId = 'one') => ({ id, vehicleId, name: `${id}.pdf`, contentType: 'application/pdf', uploadedAt: '2026-10-16T09:00:00Z' });
  try {
    await files.insert(record('first'), Buffer.from('123456')); assert.equal((await files.file('first')).bytes.toString(), '123456');
    await assert.rejects(files.insert(record('second'), Buffer.from('12345')), error => error.status === 413); assert.equal((await files.list('one')).length, 1);
    await assert.rejects(files.insert(record('first'), Buffer.from('edit'))); assert.equal((await files.file('first')).bytes.toString(), '123456');
    await files.insert(record('second'), Buffer.from('1234')); await assert.rejects(files.insert(record('third'), Buffer.from('')), error => error.status === 413);
    await files.insert(record('other', 'two'), Buffer.from('separate')); assert.equal((await files.list('two')).length, 1);
  } finally { await files.close(); }
});

test('real employee cookies authorize only current own vehicles and cannot fall back to office headers or invent a person', async () => fixture(async f => {
  const image = await png();
  assert.equal((await f.request('/api/employee/fleet/files?vehicleId=vehicle-a&kind=photo', { actor: 'admin', bytes: image })).status, 401);
  assert.equal((await f.request('/api/employee/fleet/files?vehicleId=vehicle-b&kind=photo', { employee: 'alice', bytes: image })).status, 404);
  assert.equal((await f.request('/api/employee/fleet/files?vehicleId=same-site-unassigned&kind=photo', { employee: 'alice', bytes: image })).status, 404);
  assert.equal((await f.request('/api/employee/fleet/files?vehicleId=vehicle-a&kind=document', { employee: 'alice', bytes: await pdf(), contentType: 'application/pdf' })).status, 403);
  assert.equal((await f.request('/api/employee/fleet/files?vehicleId=vehicle-a&kind=photo', { employee: 'alice', bytes: image, headers: { 'X-Employee-Person': 'person-bob' } })).status, 409);
  const upload = await f.request('/api/employee/fleet/files?vehicleId=vehicle-a&kind=photo', { employee: 'alice', bytes: image, name: '../Motor\r\n photo.png' }); assert.equal(upload.status, 200, await upload.clone().text());
  const { file } = await upload.json(); assert.equal(file.name.includes('\r'), false); assert.equal(file.contentType, 'image/jpeg'); assert.ok(file.size > 0);
  assert.equal((await f.request(file.url, { employee: 'bob', actor: 'admin' })).status, 404);
  assert.equal((await f.request(file.url, { employee: 'invalid-cookie', actor: 'admin' })).status, 401);
  assert.equal((await f.request(`/api/fleet/files/${randomUUID()}`)).status, 401, 'File IDs must not disclose existence before authentication');
  const download = await f.request(file.url, { employee: 'alice' }); assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'image/jpeg'); assert.equal(download.headers.get('cache-control'), 'private, no-store'); assert.equal(download.headers.get('x-content-type-options'), 'nosniff'); assert.match(download.headers.get('content-security-policy'), /sandbox/); assert.match(download.headers.get('content-disposition'), /^inline;/);
  const stored = Buffer.from(await download.arrayBuffer()); assert.equal((await sharp(stored).metadata()).format, 'jpeg');
  const head = await f.request(file.url, { employee: 'alice', method: 'HEAD' }); assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0); assert.equal(Number(head.headers.get('content-length')), stored.length);
  const list = await (await f.request('/api/employee/fleet/files?vehicleId=vehicle-a&kind=photo', { employee: 'alice' })).json(); assert.equal(list.files.length, 1);
  const aggregate = await f.repository.read(state => JSON.stringify(state)); assert.equal(aggregate.includes(image.toString('base64')), false); assert.equal(aggregate.includes(stored.toString('base64')), false); assert.equal(aggregate.includes('"bytes"'), false);
}));

test('a real cookie loses current vehicle files after reassignment while an old own trip remains completable', async () => fixture(async f => {
  const image = await png(), upload = await f.request('/api/employee/fleet/files?vehicleId=vehicle-a&kind=photo', { employee: 'alice', bytes: image });
  assert.equal(upload.status, 200); const { file } = await upload.json();
  const req = { headers: { cookie: `jeroc_employee=${f.tokens.alice}` } };
  await f.repository.transact(state => {
    ingestFleetTrip(state, { id: 'alice-old-trip', vehicleId: 'vehicle-a', personId: 'person-alice', driverSource: 'app', source: 'device',
      startAt: '2020-01-01T08:00:00Z', endAt: '2020-01-01T08:30:00Z', quality: 'good' });
    delete state.personnel.people.find(person => person.id === 'person-alice').vehicleId;
    state.personnel.people.find(person => person.id === 'person-bob').siteIds.push('north');
    state.fleet.profiles['vehicle-a'].defaultDriverId = 'person-bob';
  });
  const before = await f.repository.read(state => employeeFleetProjection(state, employeeRequestPrincipal(state, req)));
  assert.deepEqual(before.vehicles, []); assert.deepEqual(before.profiles, {}); assert.equal(before.pendingTrips[0].id, 'alice-old-trip');
  assert.equal((await f.request(file.url, { employee: 'alice', actor: 'admin' })).status, 404);
  assert.equal((await f.request('/api/employee/fleet/files?vehicleId=vehicle-a', { employee: 'alice' })).status, 404);
  assert.equal((await f.request('/api/employee/fleet/files?vehicleId=vehicle-a&kind=photo', { employee: 'alice', bytes: image })).status, 404);
  const after = await f.repository.transact(state => employeeFleetCommand(state, employeeRequestPrincipal(state, req), { action: 'trip.complete', requestId: randomUUID(),
    expectedRevision: state.fleet.revision, tripId: 'alice-old-trip', expectedTripRevision: 1, classification: 'private' }));
  assert.equal(after.gate.blocked, false); assert.deepEqual(after.vehicles, []); assert.equal(after.saved.trip.classification, 'private');
  await assert.rejects(f.repository.transact(state => employeeFleetCommand(state, employeeRequestPrincipal(state, req), { action: 'driver.select', requestId: randomUUID(),
    expectedRevision: state.fleet.revision, vehicleId: 'vehicle-a', personId: 'person-alice' })), error => error.status === 403 && error.code === 'fleet_vehicle_forbidden');
  assert.equal((await f.request(file.url, { employee: 'alice' })).status, 404);
}));

test('office files enforce both live grants and site scopes; documents download as private attachments and hostile filters/origins fail', async () => fixture(async f => {
  const document = await pdf();
  assert.equal((await f.request('/api/fleet/files?vehicleId=vehicle-a&kind=document', { actor: 'reader', bytes: document, contentType: 'application/pdf' })).status, 403);
  assert.equal((await f.request('/api/fleet/files?vehicleId=vehicle-b&kind=document', { actor: 'writer', bytes: document, contentType: 'application/pdf' })).status, 404);
  assert.equal((await f.request('/api/fleet/files?vehicleId=vehicle-a&kind=document', { actor: 'admin', effective: 'reader', bytes: document, contentType: 'application/pdf' })).status, 403);
  const upload = await f.request('/api/fleet/files?vehicleId=vehicle-a&kind=document', { actor: 'writer', bytes: document, contentType: 'application/pdf', name: "../Förarens 'service'.pdf" }); assert.equal(upload.status, 200); const { file } = await upload.json();
  const download = await f.request(file.url, { actor: 'reader' }); assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.match(download.headers.get('content-disposition'), /%27/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), document);
  assert.equal((await f.request(file.url, { actor: 'south' })).status, 404);
  assert.equal((await f.request(file.url + '?vehicleId=vehicle-b', { actor: 'admin' })).status, 404);
  for (const path of ['/api/fleet/files?vehicleId=vehicle-a&tenantId=company-b', '/api/fleet/files?vehicleId=vehicle-a&vehicleId=vehicle-b', '/api/fleet/files?vehicleId=vehicle-a&kind=forged']) assert.equal((await f.request(path, { actor: 'admin' })).status, 422);
  assert.equal((await f.request(file.url, { actor: 'admin', headers: { Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await f.request(file.url, { actor: 'admin', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await f.request(file.url, { actor: 'admin', method: 'DELETE' })).status, 405);
  const state = await f.repository.read(state => state);
  assert.doesNotThrow(() => assertFleetFileReferences(state, 'vehicle-a', [file.url, 'Invoice/2026/17', 'https://workshop.example/document/17'], { kind: 'document' }));
  assert.throws(() => assertFleetFileReferences(state, 'vehicle-b', [file.url], { kind: 'document' }), error => error.status === 404);
  assert.throws(() => assertFleetFileReferences(state, 'vehicle-a', [file.url], { kind: 'photo' }), error => error.status === 404);
  assert.throws(() => assertFleetFileReferences(state, 'vehicle-a', [`/api/fleet/files/${randomUUID()}`], { kind: 'document' }), error => error.status === 404);
  for (const reference of ['javascript:alert(1)', 'data:text/html,evil', '/api/employee/sickness/files/secret', 'http://insecure.example/file', 'https://admin:password@example.invalid/private']) assert.throws(() => assertFleetFileReferences(state, 'vehicle-a', [reference], { kind: 'document' }));
}));

test('trusted platform image contexts work without custom headers and current tenant/user permissions are still reloaded', async () => fixture(async f => {
  const upload = await f.request('/api/fleet/files?vehicleId=vehicle-a&kind=photo', { actor: 'admin', bytes: await png() }); const { file } = await upload.json();
  const snapshots = await f.repository.read(state => ({ actualUser: state.pricing.users.find(user => user.id === 'admin'), user: state.pricing.users.find(user => user.id === 'reader') }));
  f.platformContext({ organisationId: 'company-a', ...snapshots }); assert.equal((await f.request(file.url)).status, 200, 'A browser img request uses authenticated gateway context');
  await f.repository.transact(state => { state.pricing.users.find(user => user.id === 'reader').permissions = []; });
  assert.equal((await f.request(file.url)).status, 403, 'A trusted old context does not preserve revoked tenant permissions');
  f.platformContext({ organisationId: 'company-b', ...snapshots }); assert.equal((await f.request(file.url)).status, 403);
  f.platformContext(undefined); assert.equal((await f.request(file.url, { headers: { 'X-Platform-Organisation-Id': 'company-a', 'X-Platform-User': 'admin' } })).status, 401, 'Headers cannot manufacture trusted context');
}));

test('permission changes during upload and actual transaction rollback cannot publish or retain unacknowledged binary files', async () => fixture(async f => {
  const image = await png();
  f.beforeCommit(() => f.repository.transact(state => { state.pricing.users.find(user => user.id === 'writer').permissions = ['fleetRead']; }));
  assert.equal((await f.request('/api/fleet/files?vehicleId=vehicle-a&kind=photo', { actor: 'writer', bytes: image })).status, 403);
  assert.equal((await f.files.list('vehicle-a')).length, 0);
  f.failCommit(true); assert.equal((await f.request('/api/fleet/files?vehicleId=vehicle-a&kind=photo', { actor: 'admin', bytes: image })).status, 503); f.failCommit(false);
  assert.equal((await f.files.list('vehicle-a')).length, 0); assert.equal(await f.repository.read(state => state.fleet.fileReceipts?.length ?? 0), 0);
  const orphan = { id: randomUUID(), vehicleId: 'vehicle-a', kind: 'photo', uploadedAt: new Date().toISOString(), contentType: 'image/jpeg', name: 'orphan.jpg', url: '/unused' }; await f.files.insert(orphan, image);
  assert.equal((await f.request(`/api/fleet/files/${orphan.id}`, { actor: 'admin' })).status, 404); assert.deepEqual((await (await f.request('/api/fleet/files?vehicleId=vehicle-a', { actor: 'admin' })).json()).files, []);
  f.uncertainCommit(true); assert.equal((await f.request('/api/fleet/files?vehicleId=vehicle-a&kind=photo', { actor: 'admin', bytes: image })).status, 503); f.uncertainCommit(false);
  const acknowledged = (await f.files.list('vehicle-a')).find(record => record.id !== orphan.id); assert.ok(acknowledged, 'A committed upload survives a lost acknowledgement');
  assert.equal((await f.request(acknowledged.url, { actor: 'admin' })).status, 200);
}));

test('tenant runtime chooses distinct binary stores, and guessing a file ID in another company cannot fetch its bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-fleet-tenants-'));
  const envA = tenantRuntimeEnvironment({ JEROC_TENANT_DATA_DIR: directory }, { id: 'company-a' }), envB = tenantRuntimeEnvironment({ JEROC_TENANT_DATA_DIR: directory }, { id: 'company-b' });
  const a = await createFleetFileRepository({ env: envA }), b = await createFleetFileRepository({ env: envB });
  try {
    assert.notEqual(envA.JEROC_FLEET_FILES_DB_PATH, envB.JEROC_FLEET_FILES_DB_PATH);
    const id = randomUUID(); await a.insert({ id, vehicleId: 'same-canonical-id', uploadedAt: new Date().toISOString() }, Buffer.from('private-a'));
    assert.equal(await b.file(id), undefined); assert.deepEqual(await b.list('same-canonical-id'), []); assert.equal((await stat(envA.JEROC_FLEET_FILES_DB_PATH)).mode & 0o777, 0o600);
    const postgres = tenantRuntimeEnvironment({ DATABASE_URL: 'postgresql://user:password@localhost/db?options=public' }, { id: 'company-a', storageSchema: 'jeroc_t_1234567890abcdef' });
    assert.equal(new URL(postgres.DATABASE_URL).searchParams.get('options'), '-c search_path=jeroc_t_1234567890abcdef');
  } finally { await a.close(); await b.close(); await rm(directory, { recursive: true, force: true }); }
});

test('slow upload timeout and concurrent upload bounds reject without publishing any partial file', async () => fixture(async f => {
  let started; const reading = new Promise(resolve => { started = resolve; }); f.streamStarted(started);
  const response = new Promise((resolve, reject) => {
    const request = httpRequest(f.base + '/api/employee/fleet/files?vehicleId=vehicle-a&kind=photo', { method: 'POST', headers: { Cookie: `jeroc_employee=${f.tokens.alice}`, 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked' } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { request.end(); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }); }); });
    request.on('error', reject); request.write(Buffer.from([137, 80, 78, 71]));
  });
  await reading; f.streamStarted(undefined);
  assert.equal((await f.request('/api/employee/fleet/files?vehicleId=vehicle-a&kind=photo', { employee: 'alice', bytes: await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer() })).status, 429);
  assert.equal((await response).status, 408); assert.equal((await f.files.list('vehicle-a')).length, 0);
}, { concurrentUploadLimit: 1, uploadTimeoutMs: 150 }));
