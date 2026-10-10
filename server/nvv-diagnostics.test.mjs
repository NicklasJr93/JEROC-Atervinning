import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createNvvDiagnostics } from './nvv-diagnostics.mjs';
import { createNvvSandbox } from './nvv-sandbox.mjs';

const certificateA = { configured: true, validated: true, metadataAvailable: true, organisationName: 'Public test organisation A', organisationNumber: '5560000167', fingerprint256: 'PUBLIC-FINGERPRINT-A' };
const certificateB = { ...certificateA, organisationName: 'Public test organisation B', fingerprint256: 'PUBLIC-FINGERPRINT-B' };
const privateP12 = Buffer.from('SYNTHETIC_PRIVATE_P12_ONLY_IN_MEMORY').toString('base64');
const otherP12 = Buffer.from('SYNTHETIC_SECOND_PRIVATE_P12_ONLY_IN_MEMORY').toString('base64');
const aliasP12 = Buffer.from('SYNTHETIC_REENCRYPTED_SAME_CERTIFICATE').toString('base64');
const password = 'SYNTHETIC_CERTIFICATE_PASSWORD', aliasPassword = 'SYNTHETIC_REENCRYPTED_PASSWORD';
const clock = () => new Date('2026-10-10T15:00:00.000Z');
const payload = () => ({ verksamhetsutovare: '5560000167', avfall: { kod: '160601', mangd: 10 }, referens: 'Synthetic diagnostic fixture' });
const input = (operation = 'check', changes = {}) => ({ requestId: randomUUID(), idempotencyKey: randomUUID(), operation, ...(operation === 'submit' && { payload: payload() }), ...changes });
const certificateProfile = (p12Base64 = privateP12, passphrase = password) => ({ tls: 'tls12', certificate: { p12Base64, password: passphrase } });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture() {
  let state = { revision: 0, nvvSettings: [], nvvSandboxRuns: [], audit: [], receipts: [], reports: [], inventory: [], nvvReports: [], nvvJobs: [] };
  let tail = Promise.resolve(), lockDepth = 0, configuration = { mode: 'test', ready: true, missing: [], issues: [], certificate: certificateA };
  let behavior = async (operation, request, certificate) => operation === 'check'
    ? { mode: 'test', connected: true, checkedAt: clock().toISOString(), wasteCodes: [{ code: '160601', hazardous: true }], transportModes: [{ code: 'R' }], diagnostics: [{ method: 'GET', path: '/avfallstyper', httpStatus: 200, outcome: 'accepted', response: { count: 1 }, transport: { protocol: 'TLSv1.2' } }], clientCertificate: certificate }
    : operation === 'read'
      ? { mode: 'test', outcome: 'accepted', httpStatus: 200, response: { anteckningar: [] }, clientCertificate: certificate, transport: { protocol: 'TLSv1.2' } }
      : { mode: 'test', outcome: 'accepted', httpStatus: 201, avfallId: randomUUID(), response: {}, clientCertificate: certificate, transport: { protocol: 'TLSv1.2' } };
  const calls = [], profiles = [];
  const staff = (id, level = 'Systemadmin', siteIds) => ({ id, name: 'Synthetic staff', level, permissions: ['environmentIntegration', 'environmentRead'], ...(siteIds !== undefined && { siteIds }) });
  const principals = new Map([
    ['admin', { actor: staff('admin'), user: staff('admin') }],
    ['employee', { actor: staff('employee', 'Medarbetare'), user: staff('employee', 'Medarbetare') }],
    ['acting', { actor: staff('admin'), user: staff('director', 'VD') }],
    ['fake-actor', { actor: staff('employee', 'Medarbetare'), user: staff('admin') }],
    ['restricted-user', { actor: staff('admin'), user: staff('admin', 'Systemadmin', ['norrtalje']) }],
    ['restricted-actor', { actor: staff('admin', 'Systemadmin', []), user: staff('admin') }],
  ]);
  const principalFor = (current, token) => {
    const principal = principals.get(token);
    if (!principal) throw Object.assign(new Error('Session saknas.'), { status: 401, code: 'unauthorized' });
    return { principal: structuredClone(principal) };
  };
  const transaction = callback => {
    const job = tail.then(async () => {
      const next = structuredClone(state); lockDepth += 1;
      try { const result = await callback(next, clock()); state = next; return result; }
      finally { lockDepth -= 1; }
    });
    tail = job.catch(() => {}); return job;
  };
  const read = async callback => { await tail; return callback(structuredClone(state), clock()); };
  const client = {
    status: async () => structuredClone(configuration),
    async diagnosticSession(profile = {}) {
      profiles.push(structuredClone(profile));
      let certificate = configuration.certificate;
      if (profile.certificate) {
        const uploaded = profile.certificate;
        if (uploaded.p12Base64 === privateP12 && uploaded.password === password) certificate = certificateA;
        else if (uploaded.p12Base64 === aliasP12 && uploaded.password === aliasPassword) certificate = certificateA;
        else if (uploaded.p12Base64 === otherP12 && uploaded.password === password) certificate = certificateB;
        else throw Object.assign(new Error('Diagnostikprofilen är inte giltig för NVV TEST.'), { code: 'diagnostic_invalid' });
      }
      const invoke = async (operation, request) => {
        assert.equal(lockDepth, 0, 'External I/O must run after the reservation transaction has released its lock');
        assert.ok(state.nvvSandboxRuns.some(run => run.status === 'in_flight'), 'Persist the reservation before dispatch');
        calls.push({ operation, request: structuredClone(request), certificateFP: certificate.fingerprint256 });
        return behavior(operation, request, structuredClone(certificate));
      };
      return { status: async () => ({ ...structuredClone(configuration), certificate: structuredClone(certificate) }),
        check: request => invoke('check', request), read: request => invoke('read', request), submit: request => invoke('submit', request) };
    },
    submit() { throw new Error('Diagnostics must use an isolated client fork, never the ordinary sandbox adapter'); },
  };
  const create = () => createNvvDiagnostics({ transaction, read, principalFor, client });
  let api = create();
  return { get api() { return api; }, client, transaction, read, principalFor, calls, profiles,
    snapshot: () => structuredClone(state), restore: value => { state = structuredClone(value); },
    configure: value => { configuration = { ...configuration, ...value }; },
    behavior: value => { behavior = value; }, restart: () => { state = JSON.parse(JSON.stringify(state)); api = create(); } };
}

test('diagnostics require real and effective systemadmin with unrestricted facilities on sends and reads', async () => {
  const f = fixture();
  for (const token of ['employee', 'acting', 'fake-actor', 'restricted-user', 'restricted-actor']) {
    await assert.rejects(() => f.api.send(input(), token), error => error.status === 403);
    await assert.rejects(() => f.api.run(randomUUID(), token), error => error.status === 403);
    await assert.rejects(() => f.api.status(token), error => error.status === 403);
  }
  await assert.rejects(() => f.api.send(input(), 'missing-session'), error => error.status === 401);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.snapshot().nvvSandboxRuns, []); assert.deepEqual(f.snapshot().audit, []);
});

test('only ready TEST profiles can dispatch, never mock, disabled or production', async () => {
  const f = fixture();
  for (const mode of ['mock', 'disabled', 'production']) {
    f.configure({ mode }); await assert.rejects(() => f.api.send(input(), 'admin'), error => error.status === 409);
  }
  f.configure({ mode: 'test', ready: false });
  await assert.rejects(() => f.api.send(input(), 'admin'), error => error.status === 409);
  assert.equal(f.calls.length, 0); assert.equal(f.snapshot().nvvSandboxRuns.length, 0);
});

test('TLS/certificate overrides stay in memory while the persisted run carries only public identity', async () => {
  const f = fixture(), request = input('submit', { profile: certificateProfile() });
  const result = await f.api.send(request, 'admin');
  assert.equal(result.status, 'accepted'); assert.equal(result.diagnosticOperation, 'submit');
  assert.equal(result.method, 'POST'); assert.equal(result.path, '/insamlingar'); assert.deepEqual(result.payload, request.payload);
  assert.deepEqual(result.profile, { tls: 'tls12', certificateFP: certificateA.fingerprint256, certificateName: certificateA.organisationName });
  assert.deepEqual(f.profiles, [request.profile]); assert.equal(f.calls.length, 1);
  for (const serialized of [JSON.stringify(f.snapshot()), JSON.stringify(result), JSON.stringify(await f.api.run(result.id, 'admin'))]) {
    for (const secret of [privateP12, password]) assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('p12Base64'), false); assert.equal(serialized.includes('"password"'), false);
  }
  for (const key of ['receipts', 'reports', 'inventory', 'nvvReports', 'nvvJobs']) assert.deepEqual(f.snapshot()[key], []);
  assert.ok(f.snapshot().audit.length >= 2); assert.ok(f.snapshot().revision >= 2);
});

test('idempotency binds operation, payload and public certificate/TLS profile, not encrypted private bytes', async () => {
  const f = fixture(), request = input('submit', { profile: certificateProfile() });
  const first = await f.api.send(request, 'admin');
  const reencrypted = { ...request, profile: certificateProfile(aliasP12, aliasPassword) };
  assert.equal((await f.api.send(reencrypted, 'admin')).id, first.id); assert.equal(f.calls.length, 1);
  for (const change of [
    { profile: certificateProfile(otherP12) },
    { profile: { ...request.profile, tls: 'auto' } },
    { payload: { ...request.payload, avfall: { kod: '160601', mangd: 11 } } },
    { requestId: randomUUID() },
  ]) await assert.rejects(() => f.api.send({ ...request, ...change }, 'admin'), error => error.status === 409 && error.code === 'idempotency_conflict');
  const check = input('check'); await f.api.send(check, 'admin');
  await assert.rejects(() => f.api.send({ ...check, operation: 'read' }, 'admin'), error => error.status === 409 && error.code === 'idempotency_conflict');
  assert.equal(f.calls.length, 2); assert.equal(f.snapshot().nvvSandboxRuns.length, 2);
});

test('unknown timeout remains inspectable across restart and explicit retries never dispatch again', async () => {
  const f = fixture(); f.behavior(async () => { throw new Error('Synthetic connection timeout'); });
  const request = input('submit', { profile: certificateProfile() });
  const result = await f.api.send(request, 'admin');
  assert.equal(result.status, 'unknown'); assert.equal(f.calls.length, 1);
  f.restart(); assert.equal((await f.api.run(result.id, 'admin')).status, 'unknown');
  assert.equal((await f.api.send(request, 'admin')).status, 'unknown'); assert.equal(f.calls.length, 1);
  const serialized = JSON.stringify(f.snapshot()); assert.equal(serialized.includes(password), false); assert.equal(serialized.includes(privateP12), false);
});

test('concurrent duplicate diagnostics reserve one dispatch and release database locks during network I/O', async () => {
  const f = fixture(); let start, finish;
  const started = new Promise(resolve => { start = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  f.behavior(async () => { start(); await gate; return { mode: 'test', connected: true, wasteCodes: [], transportModes: [], diagnostics: [] }; });
  const request = input('check'), sending = f.api.send(request, 'admin'); await started;
  try {
    assert.equal((await f.api.send(request, 'admin')).status, 'in_flight');
    assert.equal((await f.api.run(request.requestId, 'admin')).status, 'in_flight'); assert.equal(f.calls.length, 1);
  } finally { finish(); }
  assert.equal((await sending).status, 'accepted'); assert.equal(f.calls.length, 1);
});

test('read returns bounded company/ombud summary and never persists submitter names or raw records', async () => {
  const f = fixture(), forbidden = ['SYNTHETIC_PRIVATE_SUBMITTER', 'SYNTHETIC_CUSTOMER_NAME', 'submitter@example.invalid'];
  f.behavior(async operation => {
    assert.equal(operation, 'read');
    return { mode: 'test', outcome: 'accepted', httpStatus: 200, response: { anteckningar: [
      { verksamhetsutovare: '5560000167', ombud: '5560065087', uppgiftslamnare: forbidden[0], verksamhetensNamn: forbidden[1], verksamhetensKontaktpersonEpost: forbidden[2], avfall: { kod: '160601', mangd: 10 } },
      { verksamhetsutovare: '5560000167', ombud: '5560065087', uppgiftslamnare: forbidden[0] },
    ] }, transport: { protocol: 'TLSv1.2' } };
  });
  const result = await f.api.send(input('read'), 'admin');
  assert.equal(result.status, 'accepted'); assert.equal(result.method, 'GET');
  assert.deepEqual(result.response, { count: 2, uniqueVerksamhetsutovare: ['5560000167'], uniqueOmbud: ['5560065087'] });
  assert.equal(f.calls[0].request.maxCount, 1);
  assert.equal(f.calls[0].request.from, '2026-10-10T14:50:00.000Z'); assert.equal(f.calls[0].request.to, '2026-10-10T15:01:00.000Z');
  for (const serialized of [JSON.stringify(result), JSON.stringify(f.snapshot())]) {
    for (const value of forbidden) assert.equal(serialized.includes(value), false);
    assert.equal(serialized.includes('uppgiftslamnare'), false);
  }
  assert.equal(Object.hasOwn(result.response, 'anteckningar'), false);
  assert.equal(Object.hasOwn(f.snapshot().nvvSandboxRuns[0].response, 'anteckningar'), false);
});

test('reading a submitted receipt uses only a confirmed diagnostic source with the same certificate identity', async () => {
  const f = fixture(), submit = await f.api.send(input('submit', { profile: certificateProfile() }), 'admin');
  const sourceId = submit.id, avfallId = submit.avfallId;
  assert.match(avfallId, /^[0-9a-f-]{36}$/i);
  f.behavior(async operation => {
    assert.equal(operation, 'read');
    return { mode: 'test', outcome: 'accepted', httpStatus: 200, response: { avfall: { avfallId, kod: '160601', mangd: 10 }, verksamhetsutovare: '5560000167', ombud: null,
      uppgiftslamnare: 'SYNTHETIC_SUBMITTER_MUST_NOT_BE_RETAINED', verksamhetensKontaktpersonNamn: 'SYNTHETIC_PERSON_MUST_NOT_BE_RETAINED' } };
  });
  const result = await f.api.send(input('read', { sourceRunId: sourceId, profile: certificateProfile() }), 'admin');
  assert.equal(result.status, 'accepted'); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].request.avfallId, avfallId);
  for (const marker of ['SYNTHETIC_SUBMITTER_MUST_NOT_BE_RETAINED', 'SYNTHETIC_PERSON_MUST_NOT_BE_RETAINED']) {
    assert.equal(JSON.stringify(result).includes(marker), false); assert.equal(JSON.stringify(f.snapshot()).includes(marker), false);
  }
  await assert.rejects(() => f.api.send(input('read', { sourceRunId: sourceId, profile: certificateProfile(otherP12) }), 'admin'));
  await assert.rejects(() => f.api.send(input('read', { sourceRunId: randomUUID(), profile: certificateProfile() }), 'admin'));
  assert.equal(f.calls.length, 2);
});

test('idempotent send still requires a configured TEST client while durable history remains readable', async () => {
  const f = fixture(), request = input('submit'), first = await f.api.send(request, 'admin');
  for (const config of [{ mode: 'disabled' }, { mode: 'test', ready: false }]) {
    f.configure(config);
    await assert.rejects(() => f.api.send(request, 'admin'), error => error.status === 409);
    assert.equal((await f.api.run(first.id, 'admin')).status, 'accepted');
    assert.equal((await f.api.status('admin')).ready, false);
  }
  assert.equal(f.calls.length, 1); assert.equal(f.snapshot().nvvSandboxRuns.length, 1);
});

test('provider acceptance is unverified without TEST mode, a success HTTP status and a valid waste ID', async () => {
  const f = fixture(), wasteId = randomUUID();
  for (const result of [
    { mode: 'test', httpStatus: 202, avfallId: wasteId },
    { mode: 'test', httpStatus: 400, avfallId: wasteId },
    { mode: 'mock', httpStatus: 201, avfallId: wasteId },
    { httpStatus: 201, avfallId: wasteId },
    { mode: 'test', httpStatus: 201, avfallId: 'invalid-waste-id' },
  ]) {
    f.behavior(async () => ({ ...result, outcome: 'accepted', response: {} }));
    const request = input('submit'), response = await f.api.send(request, 'admin');
    assert.equal(response.status, 'unknown'); assert.equal(Object.hasOwn(response, 'avfallId'), false);
    assert.equal((await f.api.send(request, 'admin')).status, 'unknown');
  }
  assert.equal(f.calls.length, 5);
});

test('read unwraps provider response containers, excludes personal identities and clips oversized results', async () => {
  const f = fixture(), privateIdentity = 'SYNTHETIC_PRIVATE_IDENTITY';
  f.behavior(async () => ({ mode: 'test', outcome: 'accepted', httpStatus: 200, response: { ResponseObject: [
    { verksamhetsutovare: '0001010000', ombud: '200001010000', uppgiftslamnare: privateIdentity },
    { verksamhetsutovare: '5560000167', ombud: '5560065087' },
  ] } }));
  const result = await f.api.send(input('read'), 'admin');
  assert.deepEqual(result.response, { count: 2, uniqueVerksamhetsutovare: [], uniqueOmbud: [] });
  assert.equal(JSON.stringify(f.snapshot()).includes(privateIdentity), false);
  assert.equal(Object.hasOwn(result.response, 'ResponseObject'), false);
});

test('provider echoes cannot archive uploaded certificate bytes or their password', async () => {
  const f = fixture();
  for (const outcome of ['accepted', 'rejected']) {
    f.behavior(async () => ({ mode: 'test', outcome, httpStatus: outcome === 'accepted' ? 201 : 400,
      avfallId: randomUUID(), response: { note: `${privateP12} ${password}`, nested: { value: password }, password },
      error: { code: 'SYNTHETIC_PROVIDER_ERROR', message: `${password} ${privateP12}` },
      trackingId: password, clientCertificate: { ...certificateA, organisationName: `${password} ${privateP12}` } }));
    const result = await f.api.send(input('submit', { profile: certificateProfile() }), 'admin');
    assert.equal(result.status, outcome);
    for (const serialized of [JSON.stringify(result), JSON.stringify(f.snapshot())]) {
      for (const secret of [privateP12, password]) assert.equal(serialized.includes(secret), false);
    }
  }
  await assert.rejects(() => f.api.send(input('submit', { profile: certificateProfile(), payload: { ...payload(), referens: password } }), 'admin'));
  assert.equal(f.calls.length, 2);
});

test('profile/payload injection and an unapproved uploaded identity cannot reserve or dispatch', async () => {
  const f = fixture();
  for (const request of [
    input('check', { payload: payload() }), input('read', { payload: { from: '2026-01-01' } }),
    input('submit', { payload: { ...payload(), url: 'https://wrong.invalid' } }),
    input('check', { profile: { tls: 'tls13' } }), input('check', { profile: { tls: 'auto', endpoint: 'https://wrong.invalid' } }),
    input('check', { profile: { tls: 'auto', certificate: { p12Base64: privateP12, password, headers: {} } } }),
    input('check', { profile: certificateProfile(Buffer.from('UNAPPROVED_CERTIFICATE').toString('base64')) }),
  ]) await assert.rejects(() => f.api.send(request, 'admin'));
  assert.equal(f.calls.length, 0); assert.equal(f.snapshot().nvvSandboxRuns.length, 0);
  assert.equal(f.snapshot().audit.length, 0);
});

test('diagnostics and the old sandbox have separate idempotency namespaces and run visibility', async () => {
  const f = fixture(), legacyId = randomUUID(), key = 'shared-key-between-tools';
  const before = f.snapshot(); before.nvvSandboxRuns.push({ id: legacyId, keyHash: hash(['admin', 'admin', key]), payloadHash: hash(payload()), status: 'accepted', method: 'POST', path: '/insamlingar', payload: payload(), startedAt: clock().toISOString(), finishedAt: clock().toISOString(), trackingId: randomUUID(), httpStatus: 201, response: {} }); f.restore(before);
  await assert.rejects(() => f.api.run(legacyId, 'admin'), error => error.status === 404);
  const result = await f.api.send(input('submit', { idempotencyKey: key }), 'admin');
  assert.equal(result.status, 'accepted'); assert.equal(f.calls.length, 1); assert.equal(f.snapshot().nvvSandboxRuns.length, 2);
  const sandbox = createNvvSandbox({ transaction: f.transaction, read: f.read, principalFor: f.principalFor, client: f.client });
  await assert.rejects(() => sandbox.run(result.id, 'admin'), error => error.status === 404);
  assert.equal((await sandbox.run(legacyId, 'admin')).id, legacyId);
  assert.deepEqual((await f.api.status('admin')).runs.map(run => run.id), [result.id]);
  assert.deepEqual((await sandbox.status('admin')).runs.map(run => run.id), [legacyId]);
});
