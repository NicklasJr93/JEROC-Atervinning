import { expect, type Page } from '@playwright/test';
import type { OfficeCard, OfficeData } from '../../src/office/model';

/** Amend a genuine shared demo card after withdrawing its previous review.
 * A browser cache mutation must never be mistaken for a server-side correction. */
export async function changeOfficeCard(page: Page, cardId: number, change: (card: OfficeCard) => void) {
  const headers = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
  async function read(): Promise<OfficeData> {
    const response = await page.request.get('/api/application/office', { headers });
    expect(response.ok()).toBe(true);
    return (await response.json()).data;
  }
  let base = await read();
  const previous = base.cards.find(card => card.id === cardId)!;
  if (previous.customerApproval && ['waiting', 'id_requested', 'approved'].includes(previous.customerApproval.status)) {
    const cancelled = await page.request.post(`/api/terminal-demo/approvals/${previous.customerApproval.id}/cancel`, { data: {} });
    expect(cancelled.ok(), await cancelled.text()).toBe(true);
    base = await read();
  }
  const next = structuredClone(base);
  change(next.cards.find(card => card.id === cardId)!);
  const saved = await page.request.post('/api/application/office', { headers, data: { base, next } });
  expect(saved.ok(), await saved.text()).toBe(true);
}
