import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from '../scripts/build.mjs';

const routes = ['/', '/plattformen/', '/integrationer/', '/priser/', '/kontakt/', '/integritet/'];
const origin = 'https://marketing.example.com';
let output;

before(async () => {
  output = await mkdtemp(join(tmpdir(), 'scrapplanner-website-test-'));
  await build({ output, env: { PUBLIC_SITE_URL: origin, CONTACT_EMAIL: 'nicklas@endorgroup.se' } });
});
after(async () => { if (output) await rm(output, { recursive: true, force: true }); });

test('all agreed pages have independent, crawlable metadata and visible vendor identity', async () => {
  const titles = new Set();
  const descriptions = new Set();
  for (const route of routes) {
    const html = await readFile(join(output, route, 'index.html'), 'utf8');
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    const description = html.match(/<meta name="description" content="([^"]+)"/)?.[1];
    assert.ok(title?.includes('ScrapPlanner'), `title for ${route}`);
    assert.ok(description?.length > 30, `description for ${route}`);
    titles.add(title);
    descriptions.add(description);
    assert.match(html, /<html lang="sv">/);
    assert.equal((html.match(/<h1(?:\s[^>]*)?>/g) || []).length, 1, `one h1 for ${route}`);
    assert.ok(html.includes(`rel="canonical" href="${new URL(route, origin).href}"`), route);
    assert.match(html, /EndorGroup/, `vendor identity on ${route}`);
    assert.ok(!html.includes('{{'), `no unresolved configuration on ${route}`);
    assert.ok(!html.includes('noindex'), `public page should be indexed: ${route}`);
  }
  assert.equal(titles.size, routes.length);
  assert.equal(descriptions.size, routes.length);
});

test('local navigation, download assets and fragment targets exist in the built project', async () => {
  for (const route of routes) {
    const html = await readFile(join(output, route, 'index.html'), 'utf8');
    for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const href = match[1].replaceAll('&amp;', '&');
      const url = new URL(href, origin + route);
      if (url.origin !== origin) continue;
      const targetPath = decodeURIComponent(url.pathname);
      const file = resolve(output, `.${targetPath}`, targetPath.endsWith('/') ? 'index.html' : '');
      assert.ok((await stat(file)).isFile(), `${route}: ${href}`);
      if (url.hash && file.endsWith('.html')) {
        const targetHtml = file === join(output, route, 'index.html') ? html : await readFile(file, 'utf8');
        assert.ok(targetHtml.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `${route}: missing anchor ${href}`);
      }
    }
  }
});

test('sitemap and robots describe the public origin without app routes or the 404', async () => {
  const sitemap = await readFile(join(output, 'sitemap.xml'), 'utf8');
  assert.equal((sitemap.match(/<url>/g) || []).length, routes.length);
  for (const route of routes) assert.ok(sitemap.includes(`<loc>${origin}${route}</loc>`));
  assert.ok(!sitemap.includes('404'));
  assert.equal(await readFile(join(output, 'robots.txt'), 'utf8'), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
  assert.match(await readFile(join(output, '404.html'), 'utf8'), /name="robots" content="noindex"/);
});
