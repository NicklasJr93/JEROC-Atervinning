import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createVismaClient, parseVismaSandboxInput, vismaOperationPath } from './visma-client.mjs';

// Spiris' Pagination guide documents $page and $pagesize on the wire. The
// browser-facing fields remain the validated page/pageSize application DTO.
test('all paginated operations translate typed pagination to documented Spiris query names', () => {
  for (const operation of ['fiscalYears', 'paymentTerms', 'vatCodes', 'costCenters', 'projects', 'suppliers', 'accounts']) {
    const parameters = { page: 2, pageSize: 100, ...(operation === 'accounts' ? { fiscalYearId: randomUUID() } : {}) };
    const path = vismaOperationPath(operation, parameters);
    const query = new URL(path, 'https://example.invalid').searchParams;
    assert.equal(query.get('$page'), '2', operation);
    assert.equal(query.get('$pagesize'), '100', operation);
    assert.equal(query.has('page'), false, operation);
    assert.equal(query.has('pageSize'), false, operation);
    assert.equal(query.size, 2, operation);
  }
  const draftQuery = new URL(vismaOperationPath('createDraft', { useDefaultVatCodes: false, calculateVatOnCostAccounts: false }), 'https://example.invalid').searchParams;
  assert.equal(draftQuery.get('useDefaultVatCodes'), 'false');
  assert.equal(draftQuery.get('calculateVatOnCostAccounts'), 'false');
});

test('client dispatches the requested second page while preserving the documented response metadata', async () => {
  const calls = [];
  const metadata = { CurrentPage: 2, PageSize: 100, TotalNumberOfPages: 2, TotalNumberOfResults: 101 };
  const client = createVismaClient({
    env: {
      VISMA_ENVIRONMENT: 'sandbox', VISMA_CLIENT_ID: 'fixture-only-client', VISMA_CLIENT_SECRET: 'fixture-only-secret',
      VISMA_REDIRECT_URI: 'https://example.invalid/api/integrations/visma/oauth/callback',
      VISMA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    },
    fetchImpl: async (value, options) => {
      const url = new URL(value); calls.push({ url, options });
      assert.equal(url.searchParams.get('$page'), '2');
      assert.equal(url.searchParams.get('$pagesize'), '100');
      return new Response(JSON.stringify({ Meta: metadata, Data: [{ Number: '2440' }] }), { status: 200 });
    },
  });
  const result = await client.request({ operation: 'accounts', parameters: { fiscalYearId: randomUUID(), page: 2, pageSize: 100 },
    accessToken: 'fixture-only-access', trackingId: randomUUID() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(result.outcome, 'accepted');
  assert.deepEqual(result.response.Meta, metadata);
});

test('wire query names cannot bypass the browser DTO allowlist', () => {
  assert.throws(() => parseVismaSandboxInput({ requestId: randomUUID(), idempotencyKey: randomUUID(), operation: 'suppliers',
    parameters: { $page: 2, $pagesize: 100 } }), error => error.code === 'visma_invalid');
  assert.throws(() => vismaOperationPath('supplier', { resourceId: randomUUID(), page: 2 }), error => error.code === 'visma_invalid');
});

test('documented 1,000-record pages are allowed without expanding the page-count bound', () => {
  const request = { requestId: randomUUID(), idempotencyKey: randomUUID(), operation: 'accounts', parameters: { fiscalYearId: randomUUID(), page: 100, pageSize: 1000 } };
  assert.equal(parseVismaSandboxInput(request).parameters.pageSize, 1000);
  assert.equal(new URL(vismaOperationPath('accounts', request.parameters), 'https://example.invalid').searchParams.get('$pagesize'), '1000');
  for (const parameters of [{ ...request.parameters, pageSize: 1001 }, { ...request.parameters, page: 101 }]) {
    assert.throws(() => parseVismaSandboxInput({ ...request, parameters }), error => error.code === 'visma_invalid');
    assert.throws(() => vismaOperationPath('accounts', parameters), error => error.code === 'visma_invalid');
  }
});
