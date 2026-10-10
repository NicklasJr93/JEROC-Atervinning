import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDocumentRepository } from './documents/storage.mjs';
import { createDocumentService, documentHash } from './documents/model.mjs';

test('logistics PDF archives the current frozen load, preserves the draft and checks site and signature versions', async () => {
  const repository = await createDocumentRepository({ env: {}, filename: ':memory:' });
  const place = { name: 'JEROC', number: '5591234567', address: 'Ängsvägen 19', postalCode: '76141', city: 'Norrtälje' };
  const frozen = { from: place, to: { ...place, name: 'Testmottagare', address: 'Testgatan 2' },
    driverId: 'driver', vehicleId: 'vehicle', rows: [{ articleId: 'lead-battery', name: 'Blybatterier', plannedKg: 100, actualKg: 92,
      hazardous: true, wasteCode: '160601' }], handling: 'Förvaras upprätt.' };
  const document = { version: 3, hash: documentHash(frozen), preparedAt: '2026-10-10T08:00:00.000Z', snapshot: frozen, signatures: [] };
  const detail = { orderId: 'AO-100', siteId: 'norrtalje', document, materialRows: frozen.rows, from: frozen.from, to: frozen.to,
    execution: { stage: 'loaded' }, updatedAt: document.preparedAt };
  const sources = { sites: [{ id: 'norrtalje', name: 'Norrtälje', ...place }], personnel: { companies: [] },
    transport: { orders: [{ id: 'AO-100', siteId: 'norrtalje', action: 'outbound', driverId: 'driver', vehicleId: 'vehicle' }],
      drivers: [{ id: 'driver', name: 'Föraren' }], vehicles: [{ id: 'vehicle', registration: 'ABC123' }] },
    logistics: { details: { 'AO-100': detail } } };
  const principal = { actor: { id: 'office', active: true }, user: { id: 'office', name: 'Kontoret', level: 'Medarbetare',
    permissions: ['workOrdersRead'], siteIds: ['norrtalje'], active: true } };
  const service = createDocumentService({ repository, sourceProvider: async () => structuredClone(sources),
    renderPdf: async snapshot => Buffer.from('%PDF-' + JSON.stringify(snapshot)) });
  try {
    const draft = await service.generateTransport('AO-100', principal);
    assert.equal(draft.document.stage, 'draft');
    const oldBytes = (await service.download(draft.document.id, principal)).pdf;
    assert.ok(oldBytes.toString().includes('"weight":92'));
    assert.equal((await service.transport('AO-100', principal)).draft.managed, true);
    await assert.rejects(() => service.generateTransport('AO-100', { ...principal, user: { ...principal.user, siteIds: ['rimbo'] } }), error => error.status === 403);
    detail.execution = { stage: 'departed', departedAt: '2026-10-10T09:00:00.000Z' };
    document.signatures = ['sender', 'carrier'].map(role => ({ role, actorName: role, at: detail.execution.departedAt,
      documentVersion: 2, documentHash: document.hash }));
    await assert.rejects(() => service.generateTransport('AO-100', principal), error => error.code === 'signature_required');
    document.signatures.forEach(signature => { signature.documentVersion = 3; });
    const final = await service.generateTransport('AO-100', principal);
    assert.equal(final.document.stage, 'final');
    assert.notEqual(final.document.id, draft.document.id);
    assert.equal((await service.generateTransport('AO-100', principal)).document.id, final.document.id);
    assert.deepEqual((await service.download(draft.document.id, principal)).pdf, oldBytes);
    assert.equal((await service.list({ kind: 'transport', sourceId: 'AO-100' }, principal)).documents.length, 2);
  } finally { await repository.close(); }
});
