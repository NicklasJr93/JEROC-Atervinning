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
  leaf: '<path d="M20 3C9 2 3 7 4 14c1 7 15 9 16-11ZM4 21 15 9M10 14l-1-5M10 14l5 1"/>',
  document: '<path d="M6 2h8l4 4v16H6ZM13 2v6h5M9 12h6M9 16h6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18M12 3c5 5 5 13 0 18"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
export const icon = (name) =>
  `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.arrow}</svg>`;
export const button = (text, href = '/kontakt/', kind = 'primary') =>
  `<a class="button button-${kind}" href="${href}">${text}<span aria-hidden="true">${icon('arrow')}</span></a>`;
export const brand = () =>
  '<span class="brand"><img src="/assets/logo.webp" width="2172" height="724" alt="ScrapPlanner – Simplifying your recycling business."></span>';

// A fixed viewBox keeps the device and its content in proportion at every size.
// The illustration contains no real account, customer or employee information.
export const phone = () => `
  <div class="phone" role="img" aria-label="Illustrativ mobilvy med arbetsdag och invägning. Generiska exempel, inga kunduppgifter.">
    <svg class="phone-screen" viewBox="0 0 390 810" fill="none" aria-hidden="true">
      <rect width="390" height="810" fill="#f2f7ee"/>
      <path d="M0 0h390v64H0z" fill="#fff"/>
      <text x="28" y="39" class="phone-time">09:41</text>
      <rect x="143" y="16" width="104" height="20" rx="10" fill="#173a45"/>
      <path d="M310 34v-9m8 9V20m8 14V15" stroke="#23493b" stroke-width="4"/>
      <rect x="343" y="20" width="22" height="12" rx="3" stroke="#23493b" stroke-width="3"/>
      <text x="28" y="105" class="phone-label">SCRAPPLANNER / MOBIL</text>
      <text x="28" y="166" class="phone-title">Redo för</text>
      <text x="28" y="216" class="phone-title">nästa steg.</text>
      <rect x="26" y="253" width="338" height="174" rx="16" fill="#fff" stroke="#dce6d5" stroke-width="2"/>
      <text x="47" y="285" class="phone-label">MIN ARBETSDAG</text>
      <text x="47" y="327" class="phone-strong">Allt inom räckhåll.</text>
      <rect x="47" y="348" width="242" height="6" rx="3" fill="#bfd3ad"/>
      <circle cx="57" cy="391" r="11" stroke="#729361" stroke-width="2"/>
      <path d="M57 384v7l5 3" stroke="#729361" stroke-width="2"/>
      <text x="80" y="397" class="phone-text">Schema &amp; tid</text>
      <rect x="26" y="451" width="338" height="70" rx="13" fill="#d6e6c8"/>
      <path d="M53 469v31m-10 0h20m-22-24h24m-20 0-6 13h12l-6-13Zm16 0-6 13h12l-6-13Z" stroke="#46725c" stroke-width="2"/>
      <text x="82" y="493" class="phone-button">Starta invägning</text>
      <path d="M324 478l8 8-8 8" stroke="#46725c" stroke-width="2"/>
      <rect x="26" y="540" width="338" height="70" rx="13" fill="#fff" stroke="#dce6d5" stroke-width="2"/>
      <path d="m53 562 13 7-13 7-13-7 13-7Zm-13 15 13 7 13-7" stroke="#46725c" stroke-width="2"/>
      <text x="82" y="582" class="phone-button">Mina uppdrag</text>
      <path d="M324 567l8 8-8 8" stroke="#46725c" stroke-width="2"/>
      <text x="28" y="657" class="phone-label">Utvalt produktutsnitt</text>
      <path d="M0 710h390v100H0z" fill="#fff"/>
      <path d="m63 749 12-10 12 10v16H63v-16Zm132-12v28m-14-14h28m103-14a14 14 0 1 0 0 28 14 14 0 0 0 0-28Z" stroke="#729361" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="137" y="790" width="116" height="5" rx="2.5" fill="#23493b"/>
    </svg>
  </div>`;

// Curated synthetic UI. Never embed live application screenshots or customer data.
export const workspace = (kind = '') => `<div class="workspace ${kind}" role="img" aria-label="Illustrativ verksamhetsöversikt med material, uppdrag och miljöunderlag. Generiska exempel, inga kunduppgifter."><div class="workspace-illustration" aria-hidden="true"><div class="app-rail"><div class="app-symbol">S<span>P</span></div>${icon('layers')}${icon('scale')}${icon('clock')}${icon('leaf')}<div class="rail-bottom"></div></div><div class="app-content"><div class="app-top"><span>Verksamhetsöversikt</span><span class="app-status"><i></i>Gemensam arbetsyta</span></div><div class="app-heading"><div><small>GÅRDEN & KONTORET</small><div class="app-title">Allt hänger ihop.</div></div><span class="app-date">Idag ${icon('globe')}</span></div><div class="app-stats"><div><span class="app-tile-icon">${icon('scale')}</span><small>Material</small><strong>Överblick</strong><span class="app-mini-bar"><i></i></span></div><div><span class="app-tile-icon">${icon('clock')}</span><small>Uppdrag</small><strong>I rörelse</strong><span class="app-mini-bar"><i></i></span></div><div><span class="app-tile-icon">${icon('document')}</span><small>Underlag</small><strong>Samlat</strong><span class="app-mini-bar"><i></i></span></div></div><div class="app-bottom"><div class="app-flow"><div class="app-block-heading"><strong>Från material till underlag</strong><span>Visa översikt ${icon('arrow')}</span></div><div class="material-row"><span class="material-swatch copper"></span><div><strong>Metall</strong><span>Material mottaget</span></div><em>Pågår</em></div><div class="material-row"><span class="material-swatch silver"></span><div><strong>Underlag</strong><span>Samlat för uppföljning</span></div><em class="ready">Översikt</em></div><div class="neutral-lines"><i></i><i></i></div></div><div class="app-environment"><span class="env-icon">${icon('leaf')}</span><small>MILJÖ & SPÅRBARHET</small><strong>Rätt underlag.<br>På samma plats.</strong><span class="env-rule"></span><span>Avfallsregistret</span><em>Under verifiering</em></div></div></div></div></div>`;

export const nvvFeature = () => `<section class="nvv"><div class="container nvv-grid"><div class="nvv-copy"><span class="eyebrow">MILJÖRAPPORTERING, NÄRA VERKSAMHETEN</span><h2>Naturvårdsverket.<br><span>Med i flödet.</span></h2><p>Koppling till Naturvårdsverkets avfallsregister. Samla rapporteringsunderlaget där det dagliga arbetet redan sker.</p><span class="nvv-status"><i></i>Anslutning under verifiering</span><a class="text-link" href="/kontakt/?amne=nvv">Prata med oss om rapporteringen ${icon('arrow')}</a></div><div class="nvv-visual"><div class="integration-path"><div class="source-brand"><b>S<span>P</span></b><span>ScrapPlanner</span></div><div class="connection"><i></i><span>API-KOPPLING</span><i></i></div><div class="destination-brand">${icon('leaf')}<span>Naturvårdsverket<small>Avfallsregistret</small></span></div></div><div class="nvv-paper"><span class="paper-label">MILJÖ & SPÅRBARHET</span><div class="paper-heading">Från viktunderlag<br>till avfallsrapportering.</div><div class="paper-items"><span>${icon('document')}Samlat underlag</span><span>${icon('layers')}Spårbar historik</span><span>${icon('leaf')}En del av arbetsdagen</span></div><div class="paper-bottom"><span>Produktöversikt</span><span>Detaljer i personlig visning ${icon('arrow')}</span></div></div><span class="nvv-note">Kopplingen verifieras inför skarp användning.</span></div></div></section>`;

export const quote = () => `<section class="closing"><div class="closing-decoration" aria-hidden="true">S<span>P</span></div><div class="container closing-content"><span class="eyebrow">NÄSTA STEG BÖRJAR MED ETT SAMTAL</span><h2>Er vardag.<br>Med större möjligheter.</h2><div class="closing-bottom"><div><p>Vi visar hur ScrapPlanner kan passa in.<br>Personlig genomgång. Pris enligt offert.</p><span>ScrapPlanner — Simplifying your recycling business.</span></div>${button('Boka en personlig visning', '/kontakt/', 'dark')}</div></div></section>`;
