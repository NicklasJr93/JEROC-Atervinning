import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
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

test('the public build publishes curated illustrations instead of internal application screenshots', async () => {
  const files = await readdir(join(output, 'assets'), { recursive: true });
  const internalScreenshots = /(?:^|\/)(?:office-(?:overview|weighing|work-orders)|mobile-(?:home|weighing))(?:-\d+)?\.(?:webp|png|jpe?g)$/i;
  assert.deepEqual(files.filter(file => internalScreenshots.test(file)), [], 'old application screenshots must not remain downloadable');
  for (const route of routes) {
    const html = await readFile(join(output, route, 'index.html'), 'utf8');
    for (const match of html.matchAll(/\b(?:src|srcset)="([^"]+)"/g)) {
      assert.ok(!/(?:office-(?:overview|weighing|work-orders)|mobile-(?:home|weighing))/.test(match[1]), `${route}: internal screenshot reference`);
    }
  }
});

test('the rounded typeface is self-hosted and Naturvårdsverket is described as under verification', async () => {
  const css = await readFile(join(output, 'styles.css'), 'utf8');
  const fontFaces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)];
  assert.ok(fontFaces.length, 'the premium headline typeface must be included');
  for (const [, declaration] of fontFaces) {
    const sources = [...declaration.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g)];
    assert.ok(sources.length, 'each font face needs an actual font asset');
    for (const [, source] of sources) {
      const url = new URL(source, origin + '/styles.css');
      assert.equal(url.origin, origin, 'font loading must not send visitor requests to another provider');
      assert.ok((await stat(resolve(output, `.${decodeURIComponent(url.pathname)}`))).size > 1000, source);
    }
  }
  for (const route of ['/', '/integrationer/']) {
    const html = await readFile(join(output, route, 'index.html'), 'utf8');
    assert.match(html, /Naturvårdsverket/, route);
    assert.match(html, /Anslutning under verifiering/, route);
  }
});
