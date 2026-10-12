import { expect, test, type Locator, type Page } from '@playwright/test';
import type { PublicApproval, TerminalSessionState } from '../src/office/terminal-demo-types';

function customerApproval(id = 'approval-scroll', status: PublicApproval['status'] = 'waiting'): PublicApproval {
  const rows = Array.from({ length: 100 }, (_, index) => ({ articleId: `material-${index}`, name: `Materialrad ${index + 1}`, weight: 10, price: 5, amount: 50 }));
  return { id, version: 1, status, updatedAt: '2026-10-12T10:00:00.000Z', displayedAt: '2026-10-12T10:00:00.000Z',
    snapshot: { cardId: id === 'next-customer' ? 4002 : 4001, version: 1, customerName: 'Scrollkund', siteName: 'Norrtälje', rows,
      gross: 5000, offset: 0, net: 5000, paymentMethod: 'cash', reference: 'Lång avräkning', origin: 'Testgatan 1, Norrtälje',
      deliveredAt: '2026-10-12T09:00:00.000Z', termsVersion: 'demo-v1', hash: `${id}-snapshot` } };
}

async function fixture(page: Page) {
  await page.route('**/api/platform/tenant-context', route => route.fulfill({ json: { companyId: 'jeroc-demo', companyName: 'JEROC Återvinning AB' } }));
  await page.addInitScript(() => {
    const host = window as typeof window & { terminalStreams: EventTarget[] };
    host.terminalStreams = [];
    class Stream extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      onmessage = null;
      onerror = null;
      constructor() { super(); host.terminalStreams.push(this); }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, 'EventSource', { value: Stream });
  });
  let session: TerminalSessionState = {
    terminal: { id: 'scroll-terminal', name: 'Testterminal', username: 'scroll', siteId: 'norrtalje', active: true, online: true, busy: true },
    approval: customerApproval(), revision: 1, connectionId: 'scroll-connection',
  };
  let responseCount = 0;
  let responseGate: Promise<void> | undefined;
  await page.route('**/api/terminal-demo/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/respond')) {
      responseCount += 1;
      expect(route.request().postDataJSON()).toEqual({ action: 'id_requested', termsAccepted: true });
      await responseGate;
      session = { ...session, revision: (session.revision ?? 0) + 1, approval: { ...session.approval!, status: 'id_requested', updatedAt: '2026-10-12T10:01:00.000Z' } };
      await route.fulfill({ json: session.approval });
    } else if (path.endsWith('/session')) await route.fulfill({ json: session });
    else if (path.endsWith('/heartbeat')) await route.fulfill({ json: { alive: true, revision: session.revision } });
    else await route.fulfill({ json: {} });
  });
  const update = async (approval: PublicApproval | null) => {
    session = { ...session, approval, revision: (session.revision ?? 0) + 1 };
    await page.evaluate(payload => {
      const host = window as typeof window & { terminalStreams: EventTarget[] };
      host.terminalStreams.at(-1)?.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(payload) }));
    }, session);
  };
  await page.goto('/terminal');
  await expect(page.getByRole('heading', { name: 'Granska och godkänn din avräkning', exact: true })).toBeVisible();
  return { update, count: () => responseCount, holdResponse: () => { let release = () => {}; responseGate = new Promise<void>(resolve => { release = resolve; }); return release; } };
}

async function openIdAtBottom(page: Page) {
  await page.getByRole('checkbox').check();
  const action = page.getByRole('button', { name: 'Godkänn med legitimation', exact: true });
  await action.scrollIntoViewIfNeeded();
  const originalY = await page.evaluate(() => window.scrollY);
  expect(originalY).toBeGreaterThan(3000);
  await action.click();
  const dialog = page.getByRole('dialog', { name: 'Manuell verifiering', exact: true });
  await expect(dialog).toBeVisible();
  await expectViewportDialog(page, dialog);
  return { dialog, originalY };
}

async function expectViewportDialog(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(15);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height - 15);
  expect(Math.abs(box!.y + box!.height / 2 - viewport.height / 2)).toBeLessThan(2);
  expect(await dialog.evaluate(element => element.scrollTop)).toBe(0);
  expect(await dialog.evaluate(element => element.parentElement?.parentElement === document.body)).toBe(true);
}

test('ID-popupen följer skärmen på ett långt underlag och Avbryt återställer scroll och fokus', async ({ page }) => {
  const state = await fixture(page);
  // Reproduce a containing block created by a parent transform/animation.
  await page.locator('.terminal-app').evaluate(element => { element.style.transform = 'translateY(0)'; });
  const { dialog, originalY } = await openIdAtBottom(page);
  await expect(page.locator('body')).toHaveCSS('position', 'fixed');
  await dialog.getByRole('button', { name: 'Avbryt', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(originalY);
  await expect(page.getByRole('button', { name: 'Godkänn med legitimation', exact: true })).toBeFocused();
  expect(state.count()).toBe(0);
  // Each opening starts at the top of the dialog's own scroll area.
  await page.getByRole('button', { name: 'Godkänn med legitimation', exact: true }).click();
  await expectViewportDialog(page, page.getByRole('dialog', { name: 'Manuell verifiering', exact: true }));
});

test('ID-väntan ligger mitt i skärmen utan dubbla anrop och nästa kund släpper scrolllåset', async ({ page }) => {
  const state = await fixture(page);
  const release = state.holdResponse();
  const { dialog } = await openIdAtBottom(page);
  await dialog.getByRole('button', { name: 'Okej', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Skickar till personal…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  release();
  const waiting = page.getByRole('dialog', { name: 'Visa din legitimation', exact: true });
  await expect(waiting.getByRole('heading', { name: 'Inväntar personalens bekräftelse', exact: true })).toBeVisible();
  await expectViewportDialog(page, waiting);
  expect(state.count()).toBe(1);
  // Ordinary SSE updates must not steal focus or reset internal scrolling.
  await waiting.evaluate(element => { element.style.maxHeight = '170px'; element.scrollTop = 80; });
  const retainedScroll = await waiting.evaluate(element => element.scrollTop);
  await state.update({ ...customerApproval('approval-scroll', 'id_requested'), updatedAt: '2026-10-12T10:02:00.000Z' });
  await expect(waiting).toBeFocused();
  expect(await waiting.evaluate(element => element.scrollTop)).toBe(retainedScroll);
  await page.keyboard.press('Escape');
  await expect(waiting).toBeVisible();
  expect(state.count()).toBe(1);
  await state.update(customerApproval('next-customer'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveCSS('position', 'fixed');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByText('Invägningskort INV-4002', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'Godkänn med legitimation', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Bekräfta att du har granskat');
});

test('en återansluten terminal visar ID-instruktionen och personalens avslut stänger dialogen', async ({ page }) => {
  const state = await fixture(page);
  await page.evaluate(() => window.scrollTo(0, 3500));
  await state.update(customerApproval('approval-scroll', 'id_requested'));
  const waiting = page.getByRole('dialog', { name: 'Visa din legitimation', exact: true });
  await expectViewportDialog(page, waiting);
  await state.update(null);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Invänta personal', exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toHaveCSS('position', 'fixed');
  expect(state.count()).toBe(0);
});
