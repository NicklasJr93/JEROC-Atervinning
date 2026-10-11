import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const folder = dirname(fileURLToPath(import.meta.url));
const source = resolve(folder, '../../../public/mockups/spiris-integration');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = resolve(source, `.${new URL(req.url, 'http://localhost').pathname}`);
  if (!path.startsWith(`${source}/`)) { res.writeHead(403); res.end(); return; }
  try { const data = await readFile(path); res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1640, height: 1160 }, locale: 'sv-SE', timezoneId: 'Europe/Stockholm', deviceScaleFactor: 1 });
  await page.goto(`${origin}/index.html`);
  await page.screenshot({ path: `${folder}/01_Spiris_Integration_Anlaggningar.png`, fullPage: true });
  await page.getByRole('button', { name: 'Gemensamma' }).nth(1).click();
  await page.screenshot({ path: `${folder}/02_Spiris_Anlaggning_Egna_Konton.png`, fullPage: true });
  await page.getByRole('button', { name: 'Gemensamma' }).nth(1).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${folder}/03_Spiris_Integration_Mobil.png`, fullPage: true });
  console.log('Rendered desktop, site-detail and mobile mockups.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
