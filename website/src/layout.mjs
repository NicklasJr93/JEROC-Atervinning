import { brand, button, icon } from './shared.mjs';

export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ],
  );
export const routeInfo = [
  {
    path: '/',
    key: 'home',
    title: 'Affärssystem för återvinning',
    description:
      'Samla invägning, avräkning, arbetsorder, personal och fordon. ScrapPlanner kopplar ihop gården och kontoret. Boka en personlig demo.',
  },
  {
    path: '/plattformen/',
    key: 'platform',
    title: 'Plattformen – gården, kontoret och mobilen',
    description:
      'Upptäck ett gemensamt arbetsflöde för material, avräkning, transport, tidrapportering och fordon med ScrapPlanner.',
  },
  {
    path: '/integrationer/',
    key: 'integrations',
    title: 'Integrationer – ekonomi, betalningar och mejl',
    description:
      'Se anslutningar och aktuell status för Spiris, Microsoft 365, bank, Swish, miljörapportering och telematik.',
  },
  {
    path: '/priser/',
    key: 'pricing',
    title: 'Priser och upplägg',
    description:
      'Pris enligt offert. Vi går igenom era arbetsflöden, anläggningar och användare för ett upplägg som passar verksamheten.',
  },
  {
    path: '/kontakt/',
    key: 'contact',
    title: 'Boka demo och kontakta oss',
    description:
      'Berätta om er återvinningsverksamhet. Förbered en demoförfrågan och få en genomgång av ScrapPlanner.',
  },
  {
    path: '/integritet/',
    key: 'privacy',
    title: 'Integritet på hemsidan',
    description:
      'Så fungerar förfrågningar, lokal kopiering och integritet på ScrapPlanners publika hemsida.',
  },
];

export function layout(page, content, config, { noindex = false } = {}) {
  const navItem = (key, path, label) =>
    `<a href="${path}"${page.key === key ? ' aria-current="page"' : ''}>${label}</a>`;
  const title = `${page.title} | ScrapPlanner`;
  const canonical = new URL(page.path, config.siteUrl).href;
  return `<!doctype html><html lang="sv"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(page.description)}"><meta name="theme-color" content="#123047">
  ${noindex ? '<meta name="robots" content="noindex">' : ''}<link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:type" content="website"><meta property="og:locale" content="sv_SE"><meta property="og:site_name" content="ScrapPlanner"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(page.description)}"><meta property="og:url" content="${escapeHtml(canonical)}"><meta property="og:image" content="${escapeHtml(new URL('/assets/social-card.png', config.siteUrl).href)}"><meta property="og:image:alt" content="ScrapPlanner – Simplifying your recycling business."><meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/assets/favicon-32.png" sizes="32x32"><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png"><link rel="preload" href="/assets/nunito-variable.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/styles.css"><script type="module" src="/main.js"></script>
  </head><body class="page-${escapeHtml(page.key)}"><a class="skip-link" href="#main">Hoppa till innehållet</a>
  <header class="site-header"><div class="container nav"><a class="brand-link" href="/" aria-label="ScrapPlanner, startsida">${brand()}</a><nav class="nav-links" aria-label="Huvudnavigation" id="main-nav">${navItem('platform', '/plattformen/', 'Plattformen')}${navItem('integrations', '/integrationer/', 'Integrationer')}${navItem('pricing', '/priser/', 'Priser')}<a class="mobile-demo-link" href="/kontakt/">Boka demo</a></nav><div class="nav-actions"><a class="login" href="${escapeHtml(config.appUrl)}">Logga in ${icon('arrow')}</a>${button('Boka demo', '/kontakt/')}<button type="button" class="menu-toggle" aria-label="Öppna menyn" aria-expanded="false" aria-controls="main-nav">${icon('menu')}${icon('close')}</button></div></div></header>
  <main id="main" tabindex="-1">${content}</main>
  <footer class="footer container"><div class="footer-top"><div><a class="brand-link" href="/" aria-label="ScrapPlanner, startsida">${brand()}</a><p class="endor-credit">En produkt av <strong>EndorGroup.</strong></p></div><nav aria-label="Sidfotsnavigation"><a href="/plattformen/">Plattformen</a><a href="/integrationer/">Integrationer</a><a href="/priser/">Priser & offert</a><a href="/kontakt/">Kontakt</a></nav><div class="footer-contact"><strong>Låt oss prata återvinning.</strong><a href="mailto:${escapeHtml(config.contactEmail)}">${escapeHtml(config.contactEmail)}</a></div></div><div class="footer-bottom"><span>© ${new Date().getUTCFullYear()} ScrapPlanner</span><span>Simplifying your recycling business.</span><div><a href="/integritet/">Integritet</a><a class="footer-mobile-link" href="${escapeHtml(config.mobileUrl)}">Mobilvy ${icon('arrow')}</a></div></div></footer>
  </body></html>`;
}
