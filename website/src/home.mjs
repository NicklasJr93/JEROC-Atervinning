import { button, icon, phone, quote, screen } from './shared.mjs';

const modules = [
  [
    'scale',
    'Material & avräkning',
    'Från första kilo till ett spårbart underlag.',
    'material',
  ],
  [
    'truck',
    'Planering & transport',
    'Arbetsorder, fordon och kärl i samma flöde.',
    'planering',
  ],
  [
    'clock',
    'Personal & tid',
    'Schema, stämpling och tidrapportering.',
    'personal',
  ],
  [
    'fleet',
    'Fordon & utrustning',
    'Register, service och tydligt ansvar.',
    'fordon',
  ],
];

export const homePage = `
<section class="hero"><div class="container hero-grid">
  <div class="hero-copy"><span class="eyebrow"><span class="tiny-dot"></span>AFFÄRSSYSTEM FÖR ÅTERVINNING</span>
    <h1>Full koll på<br>varje kilo.<br><span>Och allt runtom.</span></h1>
    <p>Från invägning och arbetsorder till personal och ekonomi. Samla gården och kontoret i samma arbetsflöde.</p>
    <div class="hero-actions">${button('Boka en personlig demo')}<a class="text-link" href="/plattformen/">Utforska plattformen ${icon('arrow')}</a></div>
    <p class="hero-note">${icon('check')}Byggt för gården. Tillgängligt på kontoret och i mobilen.</p>
  </div>
  <div class="hero-product"><span class="product-label"><span class="tiny-dot"></span>EN GEMENSAM BILD AV VERKSAMHETEN</span>
    ${screen('office-overview', 'Kontorets översikt med invägningar, uppdrag och uppgifter – exempeldata', true)}
    <div class="hero-phone">${phone()}</div>
    <div class="product-caption">${icon('layers')}<div><strong>Samma underlag. Hela vägen.</strong><span>Gården · Kontoret · Medarbetarna</span></div></div>
  </div>
</div></section>
<section class="customer-strip" aria-label="Vår första kund"><div class="container"><p>Utvecklat för återvinningsbranschen.</p><p class="customer"><small>FÖRSTA KUND</small><strong>JEROC <span>Återvinning</span></strong></p><p class="customer-description">Verktyg för människorna<br>som får gården att fungera.</p></div></section>
<section class="section container"><div class="section-heading"><div><span class="eyebrow">EN PLATTFORM. HELA ARBETSDAGEN.</span><h2>Håll ihop det som hör ihop.</h2></div><p>Gemensamma underlag för materialet,<br>uppdragen och människorna.</p></div>
  <div class="module-grid">${modules.map(([symbol, title, copy, id], i) => `<a class="module" href="/plattformen/#${id}"><span class="module-number">0${i + 1}</span>${icon(symbol)}<h3>${title}</h3><p>${copy}</p><span class="module-arrow">${icon('arrow')}</span></a>`).join('')}</div>
</section>
<section class="section workflow"><div class="container split workflow-grid"><div class="workflow-image">${screen('office-weighing', 'Viktkort på kontoret med material, priser och kunduppgifter – exempeldata')}<p class="image-caption">Invägning och avräkningsunderlag · Exempeldata</p></div>
  <div><span class="eyebrow">FRÅN VÄGNING TILL AVRÄKNING</span><h2>Varje steg<br> hänger med.</h2><p class="section-intro">Material, priser och kundgodkännande hör till samma viktkort. Kontoret ser vad som är klart och vad som behöver göras.</p>
  <ol class="steps"><li><span>01</span><div><h3>Väg in på gården</h3><p>Material och vikt direkt i mobilen.</p></div></li><li><span>02</span><div><h3>Granska och godkänn</h3><p>Kunden och kontoret arbetar med samma underlag.</p></div></li><li><span>03</span><div><h3>Attestera och följ upp</h3><p>Avräkning, dokument och överföringsstatus.</p></div></li></ol>
  <a class="text-link" href="/plattformen/#material">Se hur plattformen fungerar ${icon('arrow')}</a></div>
</div></section>
<section class="yard-banner"><img src="/assets/yard-illustration.webp" width="2172" height="724" alt="Illustration av en återvinningsgård med metallbalar och materialhanterare" loading="lazy" decoding="async"><div class="yard-shade"></div><div class="container yard-copy"><span class="eyebrow light">NÄRA VERKSAMHETEN</span><h2>För vardagen.<br>På riktigt.</h2><p>Från gårdsplanen till ekonomin.<br>Verktygen följer med där arbetet sker.</p><small>Illustrativ miljöbild</small></div></section>
<section class="section container integration-preview"><div><span class="eyebrow">KOPPLA IHOP ARBETET</span><h2>Plats för systemen<br>ni redan använder.</h2><p class="section-intro">Bokföring, betalningar och mejl. Vi går igenom vilka anslutningar som passar er och vad som krävs för att komma igång.</p><a class="text-link" href="/integrationer/">Utforska integrationer ${icon('arrow')}</a></div>
  <div class="status-list"><div><span class="integration-mark">S</span><div><h3>Spiris / Visma eEkonomi</h3><p>Bokföringsunderlag och återkoppling</p><span class="badge">Sandbox · skarp anslutning planeras</span></div></div><div><span class="integration-mark">M</span><div><h3>Microsoft 365</h3><p>Inkomna mejl på en gemensam plats</p><span class="badge">Första läsversionen</span></div></div><div><span class="integration-mark">${icon('layers')}</span><div><h3>Bank & Swish</h3><p>Utbetalningsflöden med spårbar status</p><span class="badge">Testmiljö</span></div></div></div>
</section>${quote()}`;
