import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { createSicknessFilesApi, createSicknessFileRepository, prepareSicknessFile, MAX_CERTIFICATE_BYTES } from './sickness-files.mjs';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\n%%EOF');
test('private certificate preparation validates MIME/size and strips image metadata', async () => {
  assert.equal((await prepareSicknessFile(pdf, 'application/pdf', '../../intyg.pdf')).name, 'intyg.pdf');
  await assert.rejects(prepareSicknessFile(Buffer.from('<svg/>'), 'application/pdf', 'wrong.pdf'), /giltig PDF/);
  await assert.rejects(prepareSicknessFile(pdf, 'text/html', 'wrong.html'), /PDF, JPEG eller PNG/);
  await assert.rejects(prepareSicknessFile(Buffer.alloc(MAX_CERTIFICATE_BYTES + 1), 'application/pdf', 'big.pdf'), error => error.status === 413);
  const image = await sharp({ create: { width: 2800, height: 1000, channels: 3, background: 'white' } }).png().withMetadata().toBuffer();
  const prepared = await prepareSicknessFile(image, 'image/png', 'intyg.png'), info = await sharp(prepared.bytes).metadata();
  assert.equal(info.width, 2400); assert.equal(info.exif, undefined); assert.equal(prepared.contentType, 'image/jpeg');
});

test('certificate store isolates case/person references and does not overwrite prior bytes', async () => {
  const repository = await createSicknessFileRepository({ filename: ':memory:', env: {} });
  try {
    const record = { id: 'one', caseId: 'illness', personId: 'alice', uploadedAt: '2026-10-13T08:00:00Z', contentType: 'application/pdf', name: 'intyg.pdf' };
    await repository.insert(record, pdf);
    assert.equal((await repository.file('one')).bytes.toString(), pdf.toString());
    assert.equal((await repository.list('illness', 'alice')).length, 1);
    assert.equal((await repository.list('illness', 'bob')).length, 0);
    await assert.rejects(repository.insert(record, Buffer.from('replacement')));
    assert.equal((await repository.file('one')).bytes.toString(), pdf.toString());
  } finally { await repository.close(); }
});

test('medical file API enforces own identity, both staff rights, scope, private download and access audit', async () => {
  let state = { pricing: {}, personnelAuth: {}, personnel: { people: [{ id: 'alice', userId: 'alice-user', kind: 'employee', siteIds: ['a'] }, { id: 'bob', userId: 'bob-user', kind: 'employee', siteIds: ['b'] }] }, employeeSickness: { revision: 1, cases: [{ id: 'alice-case', personId: 'alice' }, { id: 'bob-case', personId: 'bob' }], events: [] } };
  const audit = [];
  let failCommit = false;
  const repository = {
    read: async callback => callback(structuredClone(state)),
    transact: async callback => { const next = structuredClone(state), log = []; const result = await callback(next, 0, log); if (failCommit) throw new Error('Injected commit failure'); state = next; audit.push(...log); return result; },
  };
  const files = await createSicknessFileRepository({ filename: ':memory:', env: {} });
  const user = (id, permissions, siteIds) => ({ id, active: true, level: 'Medarbetare', permissions, ...(siteIds ? { siteIds } : {}) });
  const identities = {
    alice: { actor: user('alice-user', []), user: user('alice-user', []) },
    bob: { actor: user('bob-user', []), user: user('bob-user', []) },
    admin: { actor: { id: 'admin', level: 'Systemadmin' }, user: { id: 'admin', level: 'Systemadmin' } },
    readonly: { actor: user('readonly', ['personnelRead', 'absenceRead'], ['a']), user: user('readonly', ['personnelRead', 'absenceRead'], ['a']) },
    mixed: { actor: { id: 'admin', level: 'Systemadmin' }, user: user('reader', ['personnelRead', 'absenceRead'], ['a']) },
  };
  const principal = (_state, req) => identities[req.headers['x-test-identity']];
  const api = createSicknessFilesApi({ env: {}, getRepository: async () => repository, ownPrincipal: principal, officePrincipal: principal, fileRepository: files,
    json: (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); } });
  const server = createServer((req, res) => { void api(req, res, new URL(req.url, 'http://localhost')); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, identity, body, headers = {}) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'x-test-identity': identity, ...(body ? { 'Content-Type': 'application/pdf', 'X-File-Name': 'intyg.pdf' } : {}), ...headers }, ...(body ? { body } : {}) });
  try {
    assert.equal((await request('/api/employee/sickness/files?caseId=alice-case', 'bob')).status, 403);
    assert.equal((await request('/api/employee/sickness/files?caseId=alice-case', 'alice', pdf, { 'X-Employee-Person': 'bob' })).status, 409);
    assert.equal((await request('/api/employee/sickness/files?caseId=alice-case', 'alice', pdf, { Origin: 'https://wrong.test' })).status, 403);
    const upload = await request('/api/employee/sickness/files?caseId=alice-case', 'alice', pdf, { 'X-Employee-Person': 'alice' });
    assert.equal(upload.status, 201); const { file } = await upload.json();
    assert.equal(file.personId, undefined); assert.equal(file.createdBy, undefined); assert.equal(file.hash, undefined);
    assert.equal(state.employeeSickness.events[0].action, 'certificate.upload');
    failCommit = true;
    assert.equal((await request('/api/employee/sickness/files?caseId=alice-case', 'alice', pdf)).status, 503);
    failCommit = false;
    assert.equal((await files.list('alice-case', 'alice')).length, 1, 'failed application acknowledgement compensates the local archive insert');
    assert.equal((await (await request('/api/employee/sickness/files?caseId=alice-case', 'alice')).json()).files.length, 1);
    assert.equal((await request(`/api/employee/sickness/files/${file.id}`, 'bob')).status, 403);
    assert.equal((await request('/api/personnel/sickness/files?caseId=bob-case', 'readonly')).status, 403);
    assert.equal((await request('/api/personnel/sickness/files?caseId=alice-case', 'mixed', pdf)).status, 403);
    assert.equal((await request('/api/personnel/sickness/files?caseId=alice-case', 'readonly', pdf)).status, 403);
    const download = await request(`/api/personnel/sickness/files/${file.id}`, 'readonly');
    assert.equal(download.status, 200); assert.equal(download.headers.get('cache-control'), 'private, no-store');
    assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.match(download.headers.get('content-security-policy'), /sandbox/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
    assert.ok(audit.some(item => item.action === 'sickness.certificate.download' && item.actualUserId === 'readonly'));
    assert.equal((await request('/api/employee/sickness/files?caseId=alice-case&personId=alice', 'alice')).status, 422);
  } finally { await new Promise(resolve => server.close(resolve)); await api.close(); }
});
