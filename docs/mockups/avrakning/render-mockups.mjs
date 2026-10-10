// Standalone design rendering. Uses local demo files, never the JEROC backend.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = dirname(fileURLToPath(import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const file = resolve(folder, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(folder + '/')) { res.writeHead(403); res.end(); return; }
  try { res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream'); res.end(await readFile(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1.5, locale: 'sv-SE' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (!req.url().startsWith(base + '/')) errors.push('External request: ' + req.url()); });
  for (const [state, name] of [['final', '01_Avrakningsnota_A4'], ['preliminary', '02_Avrakningsnota_Preliminar_A4']]) {
    await page.goto(`${base}/index.html?capture=1&state=${state}`);
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.locator('.a4').evaluate(el => ({ footerBottom: el.querySelector('.document-footer').getBoundingClientRect().bottom, width: el.scrollWidth, clientWidth: el.clientWidth, imagesLoaded: [...el.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0) }));
    if (layout.footerBottom > 1097 || layout.width > layout.clientWidth || !layout.imagesLoaded) throw new Error(`${state} A4 layout/asset issue: ${JSON.stringify(layout)}`);
    if (await page.locator('.materials tbody tr').count() !== 10) throw new Error('Expected ten material rows');
    const content = (await page.locator('.a4').innerText()).replace(/[\u00a0\u202f]/g, ' ');
    for (const value of ['37 479', '37 329', '36 829', '3 033', 'Omvänd betalningsskyldighet', 'SEK']) if (!content.includes(value)) throw new Error(`${state} document lacks ${value}`);
    if (content.includes('Registrerad i Visma') || content.includes('LF-482') || content.includes('0 % moms')) throw new Error('Document claims an integration result or zero-rate tax');
    if (state === 'final') {
      if (!content.includes('HR-2026-001') || !content.includes('Sofia Lundin') || !content.includes('Hasse Nilsson')) throw new Error('Final document lacks invoice/approval example');
      for (const identifier of ['AV-2026-00128', 'HR-2026-001', 'INV-2026-00456']) if (content.split(identifier).length !== 2) throw new Error('Repeated main identifier: ' + identifier);
    } else if (!content.includes('PRELIMINÄR') || !content.includes('EJ BOKFÖRD') || content.includes('HR-2026-001')) throw new Error('Preliminary document claims a final invoice');
    await page.screenshot({ path: join(folder, name + '.png') });
    await page.pdf({ path: join(folder, name + '.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
    console.log(`${state}: ten rows, amounts/status/identifiers/assets and A4 layout checked; PNG and PDF rendered.`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
