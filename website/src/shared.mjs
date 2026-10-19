const paths = {
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  scale: '<path d="M12 3v17M5 21h14M4 7h16M5 7l-4 8h8L5 7Zm14 0-4 8h8l-4-8Z"/>',
  truck:
    '<path d="M2 5h12v12H2zM14 9h4l4 4v4h-8"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  fleet: '<path d="m4 7 2-4h12l2 4v12H4ZM4 11h16M7 15h1m8 0h1M7 19v2m10-2v2"/>',
  layers:
    '<path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
export const icon = (name) =>
  `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.arrow}</svg>`;
export const button = (text, href = '/kontakt/', kind = 'primary') =>
  `<a class="button button-${kind}" href="${href}">${text}${icon('arrow')}</a>`;
export const brand = () =>
  '<span class="brand"><img src="/assets/logo.webp" width="2172" height="724" alt="ScrapPlanner – Simplifying your recycling business."></span>';
export const screen = (name, alt, priority = false) =>
  `<figure class="screen-frame"><div class="browser-bar" aria-hidden="true"><span class="browser-dots">● ● ●</span><span>app.scrapplanner.com</span><span>···</span></div><img src="/assets/${name}.webp" srcset="/assets/${name}-640.webp 640w, /assets/${name}-960.webp 960w, /assets/${name}.webp 1440w" sizes="(max-width: 700px) 90vw, 65vw" width="1440" height="1000" alt="${alt}" ${priority ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"></figure>`;
export const phone = (name = 'mobile-weighing') =>
  `<div class="phone"><img src="/assets/${name}.webp" width="780" height="1688" alt="${name === 'mobile-home' ? 'Mobilens hemskärm med arbetspass och nästa uppdrag' : 'Invägning i mobilen med material, vikt och avräkning'} – exempeldata" loading="lazy" decoding="async"></div>`;
export const quote = () =>
  `<section class="price-section"><div class="container price-inner"><div><span class="eyebrow light">PRISER & UPPLÄGG</span><h2>Rätt verktyg.<br>Ett upplägg för er.</h2><p>Vi utgår från era arbetsflöden, anläggningar och användare. Sedan tar vi fram ett förslag som passar verksamheten.</p></div><div class="quote"><span class="eyebrow light">SCRAPPLANNER</span><h3>Pris enligt offert.</h3><p>Berätta hur ni arbetar.<br>Vi visar hur ScrapPlanner kan passa in.</p>${button('Kontakta oss för pris', '/kontakt/?amne=offert', 'white')}<span class="quote-note">Personlig genomgång · Anpassat för er</span></div></div></section>`;
