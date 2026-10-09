import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { seedOffice, type OfficeCard, type OfficeCustomer } from '../../src/office/model';
import type { TerminalApproval } from '../../src/office/terminal-demo-types';

type ReviewCard = Pick<OfficeCard, 'id' | 'sourceId' | 'origin'> & Partial<Omit<OfficeCard, 'rows'>> & {
  rows: { articleId: string; weight: number; price?: number; tier?: 'A' | 'B' | 'C' | 'Eget' }[];
};
/** Exercise the genuine local demo review/signoff API; never intercept approval
 * responses or install a browser-only customer-approved state. */
export async function approveCustomerCard(request: APIRequestContext, input: ReviewCard, options: { customer?: OfficeCustomer; siteId?: string; siteName?: string } = {}): Promise<TerminalApproval> {
  const seed = seedOffice();
  const customer = options.customer ?? seed.customers.find(item => item.id === (input.customerId ?? 'customer-build'))!;
  const siteId = options.siteId ?? input.siteId ?? 'norrtalje';
  const siteName = options.siteName ?? input.yard ?? 'Norrtälje';
  const actor = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
  const post = async (path: string, data: unknown, headers?: Record<string, string>) => {
    const response = await request.post(path, { data, headers });
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
    return response.json();
  };
  await post('/api/terminal-demo/staff-session', { actualUserId: 'admin', effectiveUserId: 'admin' });
  const unique = randomUUID().slice(0, 12);
  const terminal = await post('/api/terminal-demo/terminals', { name: `Godkännande E2E ${unique}`, username: `approval-${unique}`, password: 'local-test-only', siteId });
  await post('/api/terminal-demo/login', { username: terminal.username, password: 'local-test-only' });
  const archiveResponse = await request.get(`/api/pricing/snapshots?cardId=${input.id}`, { headers: actor });
  expect(archiveResponse.ok()).toBe(true);
  const { snapshots } = await archiveResponse.json();
  const deliveredAt = new Date((input.date ?? '2026-10-09T09:00:00Z').replace(' ', 'T')).toISOString();
  const snapshot = await post('/api/pricing/snapshots', { cardId: input.id, customerId: customer.id, deliveredAt,
    ...(snapshots.at(-1)?.id ? { supersedesSnapshotId: snapshots.at(-1).id } : {}),
    rows: input.rows.map(row => ({ articleId: row.articleId, weight: row.weight, ...(row.price === undefined ? {} : { override: { price: row.price, tier: row.tier ?? 'C', reason: 'Prissatt lokalt regressionstestunderlag' } }) })) }, actor);
  const rows = snapshot.rows.map((row: { articleId: string; weight: number; price: number; tier: string }) => ({ ...row, tier: row.tier === 'Special' ? 'Eget' : row.tier }));
  const card = { ...input, customerId: customer.id, siteId, yard: siteName, date: input.date ?? deliveredAt, reference: input.reference ?? '', status: 'complement',
    pricingSnapshotId: snapshot.id, pricingTotal: snapshot.total, rows, audit: input.audit ?? [], paymentDetails: input.paymentDetails ?? customer.paymentProfile ?? { method: 'cash' } };
  const sent = await post('/api/terminal-demo/approvals', { card, customer, terminalId: terminal.id, siteId,
    rows: rows.map((row: { articleId: string; weight: number; price: number }) => ({ articleId: row.articleId, name: row.articleId, weight: row.weight, price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 })),
    offset: 0, correctionIds: [], idempotencyKey: randomUUID() });
  await post(`/api/terminal-demo/approvals/${sent.id}/respond`, { action: 'id_requested', termsAccepted: true });
  return post(`/api/terminal-demo/approvals/${sent.id}/confirm-id`, {});
}
export async function approveCurrentOfficeCard(page: Page, cardId: number): Promise<TerminalApproval> {
  const response = await page.request.get('/api/application/office', { headers: { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' } });
  expect(response.ok()).toBe(true);
  const { data } = await response.json();
  const card = data.cards.find((item: OfficeCard) => item.id === cardId);
  expect(card).toBeTruthy();
  const customer = data.customers.find((item: OfficeCustomer) => item.id === card.customerId) ?? card.customerSnapshot;
  const approval = await approveCustomerCard(page.request, card, { customer });
  await page.reload();
  return approval;
}
