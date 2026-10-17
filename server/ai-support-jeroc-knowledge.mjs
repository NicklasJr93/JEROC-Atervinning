/** Reviewed public-source candidates, never a seed or a publication decision.
 * Repository demo addresses/articles are deliberately not evidence here. */
export const JEROC_KNOWLEDGE_PACK_ID = 'jeroc-customer-faq';
export const JEROC_KNOWLEDGE_PACK_VERSION = 1;
const verifiedAt = '2026-10-17';
const source = (url, title) => Object.freeze({ url, title, verifiedAt });
const sources = Object.freeze({
  recycling: source('https://www.jeroc.se/jerocatervinning', 'JEROC Återvinning – material, hämtning och uthyrning'),
  facilities: source('https://www.jeroc.se/anläggningar', 'JEROC – anläggningar och skrot som köps'),
  contact: source('https://www.jeroc.se/kontaktaoss', 'JEROC – kontakt'),
  norrtalje: source('https://www.jeroc.se/jeroc-återvinning-norrtälje', 'JEROC Återvinning Norrtälje'),
});
const item = (id, title, answer, category, sourceIds) => Object.freeze({
  id, title, answer, category, siteIds: Object.freeze([]), sources: Object.freeze(sourceIds.map(id => sources[id])),
});
const pack = Object.freeze({
  id: JEROC_KNOWLEDGE_PACK_ID,
  version: JEROC_KNOWLEDGE_PACK_VERSION,
  title: 'JEROC – källbelagda kundfrågor att granska',
  verifiedAt,
  items: Object.freeze([
    item('cable', 'Köper ni kabelskrot och kopparkabel?',
      'Ja, JEROC köper kabelskrot. Har du kopparkabel, beskriv gärna om den är isolerad eller om det är skalad koppar. Personalen behöver bedöma materialklassningen och bekräfta aktuellt pris för just ditt material.',
      'materials', ['facilities', 'recycling']),
    item('metals', 'Vilka metaller tar ni emot?',
      'JEROC tar emot bland annat koppar, mässing, rostfritt stål och järn. Beskriv gärna vilket material du har och ungefärlig mängd, så kan personalen hjälpa dig med bedömningen.',
      'materials', ['recycling']),
    item('customers', 'Tar ni emot både privatpersoner och företag?',
      'Ja, JEROC tar emot skrot från både privatpersoner och företag. Personalen hjälper dig att bekräfta villkoren för just ditt material och ärende.',
      'general', ['recycling']),
    item('dropoff', 'Kan jag lämna skrot själv?',
      'Ja, du kan själv köra och lämna skrot hos JEROC. Berätta gärna vilket material och ungefärlig mängd du vill lämna. Kontakta personalen för att bekräfta aktuell mottagning och förutsättningarna för ditt besök.',
      'visits', ['recycling']),
    item('pickup', 'Kan ni hämta skrot?',
      'JEROC hämtar skrot i Norrort efter överenskommelse. Beskriv materialet, ungefärlig mängd och hämtningsplats. Personalen behöver bekräfta upplägg, tid och aktuella villkor innan någon hämtning är bokad.',
      'pickups', ['recycling']),
    item('containers', 'Hyr ni ut container, kärl och storsäck?',
      'Ja, JEROC hyr ut container, kärl och storsäckar. Det finns olika storlekar och möjlighet till kortare eller längre hyresperioder. Personalen hjälper dig att välja lösning och bekräftar tillgänglighet och villkor.',
      'pickups', ['recycling']),
    item('car-batteries', 'Tar ni emot bilbatterier?',
      'Ja, JEROC tar emot bilbatterier. Om frågan gäller en annan batterityp behöver personalen bekräfta om den kan tas emot och hur den ska hanteras.',
      'materials', ['facilities', 'recycling']),
    item('electronics', 'Tar ni emot elektronikskrot?',
      'Ja, JEROC tar emot elektronikskrot. Beskriv gärna vad det är för utrustning och ungefärlig mängd, så kan personalen bekräfta mottagningen för just ditt material.',
      'materials', ['facilities', 'recycling']),
    item('whitegoods', 'Tar ni emot vitvaror, kyl och frys?',
      'JEROC tar emot vitvaror, men inte kyl eller frys. Kontakta personalen om du behöver hjälp att reda ut vad som gäller för en viss produkt.',
      'materials', ['recycling']),
    item('prices', 'Vilket pris får jag för mitt skrot?',
      'Ersättningen baseras på aktuella skrotpriser och materialet behöver bedömas. Personalen måste bekräfta aktuellt pris och avräkning för ditt material; ett obekräftat pris eller utbetalningsdatum kan inte lämnas i samtalet.',
      'payments', ['recycling']),
    item('norrtalje-visit', 'Var finns ni i Norrtälje och när har ni öppet på vardagar?',
      'JEROC i Norrtälje finns på Argonvägen 12 i Sika industriområde. De publicerade vardagstiderna är måndag till fredag klockan 08–17. Kontakta JEROC för besked om helger eller avvikande dagar inför ditt besök.',
      'opening_hours', ['norrtalje', 'contact', 'recycling']),
    item('contact', 'Hur kontaktar jag JEROC?',
      'Ring JEROC på 070 234 28 78 eller mejla info@jeroc.se. Telefonväxeln tar inte emot sms. Personalen kan hjälpa dig med aktuella priser, mottagning, besök och hämtning.',
      'general', ['contact', 'recycling']),
  ]),
});

/** Eligibility uses the trusted tenant identifier, never a mutable company name,
 * demo site name, article catalog or a caller-supplied tenant field. */
export function isJerocKnowledgePackEligible({ organisationId } = {}) {
  return organisationId === 'jeroc-demo';
}

/** Pure candidate data only. The API must obtain explicit approval, enforce its
 * normal publication budget and persist an independently versioned wiki copy. */
export function getJerocKnowledgePack(options = {}) {
  return isJerocKnowledgePackEligible(options) ? structuredClone(pack) : null;
}
