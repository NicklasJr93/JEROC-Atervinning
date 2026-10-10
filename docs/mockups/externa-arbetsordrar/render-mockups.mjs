// Renders only the standalone prototype: no mail, app or database calls.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const folder = dirname(fileURLToPath(import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const target = resolve(folder, `.${decodeURIComponent(new URL(req.url, 'http://localhost').pathname)}`);
  if (!target.startsWith(`${folder}/`)) { res.writeHead(403); res.end(); return; }
  try { const data = await readFile(target); res.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
const context = await browser.newContext({ locale: 'sv-SE', timezoneId: 'Europe/Stockholm', viewport: { width: 1600, height: 1080 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const problems = [];
page.on('pageerror', error => problems.push(error.message));
page.on('request', request => { if (!request.url().startsWith(`${origin}/`)) problems.push(`Unexpected request: ${request.url()}`); });
page.on('response', response => { if (response.status() >= 400) problems.push(`Asset failed: ${response.url()} (${response.status()})`); });
async function view(name) {
  if (page.url().startsWith(origin)) await page.evaluate(name => { location.hash = `view=${name}`; }, name);
  else await page.goto(`${origin}/index.html#view=${name}`);
  await page.locator('#content').waitFor();
  await page.waitForFunction(name => document.body.dataset.view === name && document.querySelector('#content')?.textContent.trim().length > 0, name);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.onload = resolve; image.onerror = resolve; })));
  });
}
async function screenshot(file) {
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`Horizontal overflow: ${file}`);
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; });
  await page.screenshot({ path: join(folder, file), fullPage: true });
}
const click = action => page.locator(`[data-action="${action}"]`).click();
async function stateIs(stage) {
  await page.waitForFunction(stage => window.mockupState.stage === stage, stage);
  const state = await page.evaluate(() => window.mockupState);
  if (state.stock !== 1680 || state.id !== 'AO-1048') throw new Error('Planning or empty travel changed physical stock/order identity.');
}
try {
  await view('office'); await screenshot('01_Kontoret_Transportforfragan.png');
  await click('send-request'); await stateIs('requested');
  await view('carrier'); await screenshot('02_Akeriet_Forfragan.png');
  await view('email'); await click('email-request'); await screenshot('04_Mejl_Transportforfragan.png');
  await click('email-open-carrier');
  if (!(await page.getByRole('dialog').innerText()).includes('Ingen riktig inloggning')) throw new Error('Email link falsely implies authenticated acceptance.');
  await click('demo-login-carrier'); await stateIs('requested');
  await click('propose');
  await page.locator('[data-field="modal-time"]').fill('10:30');
  await click('submit-proposal'); await stateIs('proposed');
  if (await page.locator('[data-action="assign"]').count()) throw new Error('Unconfirmed proposed time can be assigned.');
  await view('office'); await click('confirm-proposal'); await stateIs('accepted');
  await view('carrier'); await click('assign'); await stateIs('assigned');
  await page.setViewportSize({ width: 390, height: 844 });
  await view('driver');
  await page.locator('[data-field="driverChecked"]').check();
  await screenshot('03_Chaufforen_Uppdrag.png');
  await click('enroute'); await stateIs('enroute');
  await click('loading-ready'); await click('confirm-loading-ready'); await stateIs('loading_ready');
  for (const name of ['office', 'carrier', 'email']) {
    await view(name);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`Mobile overflow: ${name}`);
  }
  await page.setViewportSize({ width: 1600, height: 1080 });
  await view('office'); await click('reset'); await click('send-request');
  await view('carrier'); await click('decline'); await click('submit-decline'); await stateIs('declined');
  await view('office');
  if (!(await page.locator('.stock-numbers').innerText()).includes('0 kg')) throw new Error('Declined request retained reservation.');
  await click('reset'); await click('send-request');
  await click('revise'); await click('confirm-revise'); await stateIs('draft');
  await click('send-request'); await stateIs('requested');
  if (await page.evaluate(() => window.mockupState.revision) !== 2) throw new Error('Revision not advanced.');
  if (problems.length) throw new Error(problems.join('\n'));
  console.log('Four mockup PNGs rendered; request/email-link/proposal/confirmation/assignment/empty-travel/decline/revision checked. Narrow views and local-only assets pass. No mail/API/database calls.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
