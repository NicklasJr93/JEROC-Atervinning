import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homePage } from '../src/home.mjs';
import {
  platformPage,
  integrationsPage,
  pricingPage,
  contactPage,
  privacyPage,
} from '../src/pages.mjs';
import { escapeHtml, layout, routeInfo } from '../src/layout.mjs';
import { prepareAssets } from './assets.mjs';

export const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

function publicUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} måste vara en fullständig HTTPS-adress.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      `${name} måste vara en HTTPS-adress utan sökväg eller inloggningsuppgifter.`,
    );
  return url.origin;
}
export function readConfig(env = process.env) {
  const contactEmail =
    (env.CONTACT_EMAIL ?? '').trim() || 'nicklas@endorgroup.se';
  if (
    contactEmail &&
    (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(
      contactEmail,
    ) ||
      contactEmail.length > 254)
  )
    throw new Error('CONTACT_EMAIL måste vara en giltig e-postadress.');
  return {
    siteUrl: publicUrl(
      env.PUBLIC_SITE_URL || 'https://scrapplanner.com',
      'PUBLIC_SITE_URL',
    ),
    appUrl: publicUrl(env.APP_URL || 'https://app.scrapplanner.com', 'APP_URL'),
    mobileUrl: publicUrl(
      env.MOBILE_URL || 'https://mobile.scrapplanner.com',
      'MOBILE_URL',
    ),
    contactEmail,
  };
}
export async function build({
  output = resolve(projectRoot, 'dist'),
  env = process.env,
} = {}) {
  const config = readConfig(env);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(resolve(projectRoot, 'public'), output, { recursive: true });
  await prepareAssets(output);
  await cp(
    resolve(projectRoot, 'src/styles.css'),
    resolve(output, 'styles.css'),
  );
  await cp(resolve(projectRoot, 'src/main.js'), resolve(output, 'main.js'));
  const contents = {
    home: homePage,
    platform: platformPage,
    integrations: integrationsPage,
    pricing: pricingPage,
    contact: contactPage,
    privacy: privacyPage,
  };
  for (const page of routeInfo) {
    const folder = resolve(output, `.${page.path}`);
    await mkdir(folder, { recursive: true });
    const content = contents[page.key]
      .replaceAll('{{APP_URL}}', escapeHtml(config.appUrl))
      .replaceAll('{{MOBILE_URL}}', escapeHtml(config.mobileUrl))
      .replaceAll('{{CONTACT_EMAIL}}', escapeHtml(config.contactEmail));
    await writeFile(
      resolve(folder, 'index.html'),
      layout(page, content, config),
    );
  }
  const notFound = {
    path: '/404.html',
    key: '404',
    title: 'Sidan hittades inte',
    description:
      'Länken verkar inte stämma. Gå tillbaka till ScrapPlanners startsida.',
  };
  await writeFile(
    resolve(output, '404.html'),
    layout(
      notFound,
      '<section class="page-hero"><div class="container"><span class="eyebrow">404</span><h1>Här tog vägen slut.</h1><p>Sidan finns inte på den här adressen.</p><a class="button button-primary" href="/">Till startsidan</a></div></section>',
      config,
      { noindex: true },
    ),
  );
  await writeFile(
    resolve(output, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routeInfo.map((p) => `<url><loc>${escapeHtml(new URL(p.path, config.siteUrl).href)}</loc></url>`).join('')}</urlset>\n`,
  );
  await writeFile(
    resolve(output, 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${config.siteUrl}/sitemap.xml\n`,
  );
  console.log(
    `Byggde ${routeInfo.length} sidor + 404. Kontaktflöde: ${config.contactEmail ? 'e-postprogram och kopiering' : 'kopiering (CONTACT_EMAIL ej satt)'}.`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await build();
