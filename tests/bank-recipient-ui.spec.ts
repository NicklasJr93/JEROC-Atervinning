import { expect, test, type Page } from '@playwright/test';
import type { PaymentDetails } from '../src/payment-details';

async function editor(page: Page, value: PaymentDetails, readOnly = false) {
  await page.route('**/__bank-recipient-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><main class="office" id="test-root"></main><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => value => value;
    window.__vite_plugin_react_preamble_installed__ = true;
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { default: PaymentEditor } = await import('/src/office/PaymentEditor.tsx');
    window.saved = null; window.currentDraft = null;
    const props = ${JSON.stringify({ value, bankOnly: true, disabled: readOnly })};
    createRoot(document.getElementById('test-root')).render(React.createElement(PaymentEditor, { ...props,
      onDraftChange: value => { window.currentDraft = value; }, onSave: value => { window.saved = value; return true; } }));
  </script></body></html>` }));
  await page.goto('/__bank-recipient-fixture');
  await expect(page.locator(readOnly ? '.office-payment-readonly' : '.office-payment-editor')).toBeVisible();
}
const legacy: PaymentDetails = { method: 'bank', bank: 'Roslagens Sparbank', clearing: '8327', account: '001234567890', holder: 'Testkund' };

test('äldre svenska konton läses som bankkonto utan att den frysta uppgiften ändras', async ({ page }) => {
  await editor(page, legacy, true);
  await expect(page.locator('.office-payment-readonly')).toContainText('Svenskt bankkonto');
  await expect(page.locator('.office-payment-readonly')).toContainText('001234567890');
  await expect(page.getByRole('combobox')).toHaveCount(0);
  expect(legacy.bankType).toBeUndefined();
});

test('byte till bankgiro rensar kontonummer och avvisar fel kontrollsiffra före sparning', async ({ page }) => {
  await editor(page, legacy);
  await expect(page.getByLabel('Mottagartyp', { exact: true })).toHaveValue('account');
  await page.getByLabel('Mottagartyp', { exact: true }).selectOption('bankgiro');
  await expect(page.getByLabel('Kontonummer', { exact: true })).toHaveCount(0);
  await page.getByLabel('Bankgironummer', { exact: true }).fill('123-4567');
  await page.getByRole('button', { name: 'Spara betalningsuppgift', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('kontrollsiffra');
  expect(await page.evaluate(() => (window as unknown as { saved: unknown }).saved)).toBeNull();
  await page.getByLabel('Bankgironummer', { exact: true }).fill('123-4566');
  await page.getByRole('button', { name: 'Spara betalningsuppgift', exact: true }).click();
  const saved = await page.evaluate(() => (window as unknown as { saved: PaymentDetails }).saved);
  expect(saved).toMatchObject({ method: 'bank', bankType: 'bankgiro', bankgiro: '1234566', holder: 'Testkund' });
  expect(saved.clearing).toBeUndefined(); expect(saved.account).toBeUndefined(); expect(saved.iban).toBeUndefined();
});

test('IBAN normaliseras och andra bankfält finns endast när de hör till vald typ', async ({ page }) => {
  await editor(page, legacy);
  await page.getByLabel('Mottagartyp', { exact: true }).selectOption('iban');
  await page.getByLabel('IBAN', { exact: true }).fill('se45 5000 0000 0583 9825 7466');
  await page.getByText('Fler mottagaruppgifter', { exact: true }).click();
  await page.getByLabel('BIC / SWIFT (vid behov)', { exact: true }).fill('swedsess');
  await page.getByLabel('Bankland (vid behov)', { exact: true }).fill('se');
  await page.getByRole('button', { name: 'Spara betalningsuppgift', exact: true }).click();
  const saved = await page.evaluate(() => (window as unknown as { saved: PaymentDetails }).saved);
  expect(saved).toMatchObject({ bankType: 'iban', iban: 'SE4550000000058398257466', bic: 'SWEDSESS', bankCountry: 'SE' });
  expect(saved.account).toBeUndefined();
  await page.getByLabel('Mottagartyp', { exact: true }).selectOption('plusgiro');
  expect(await page.evaluate(() => (window as unknown as { currentDraft: PaymentDetails }).currentDraft)).not.toHaveProperty('iban');
  await expect(page.getByLabel('BIC / SWIFT (vid behov)', { exact: true })).toHaveCount(0);
});
