/**
 * Small, versioned knowledge pack for the read-only bookkeeping demo assistant.
 * These are reviewed descriptions of supported demo behaviour, not a complete
 * legal corpus or proof of the user's accounting treatment. No runtime crawl,
 * customer-supplied URL, document or cross-company material is included.
 */
export const ANDE_KNOWLEDGE_VERSION = 'SE-demo-2026-10-23.2';

export const andeKnowledge = Object.freeze([
  {
    id: 'demo-scope',
    title: 'Demons omfattning och begränsningar',
    url: '/bokforing/wiki/#artikel/kanda-begransningar',
    text: 'Kontrollerat mot kod och dokumentation 2026-10-23. Startbolaget använder fiktiva uppgifter, SEK och faktureringsmetoden. Ekonomidata och originalfiler lagras lokalt; ingen inloggning eller bolagsisolering finns. SIE 4 kan importera/exportera huvudbok i PC8/CP437 med filgranskning, kontomappning, dubblettkontroll och bevarat original. Det flyttar inte reskontra, bilagor eller lönekort och är inte SIE-certifiering. Valutaarbetsytan stöder EUR/USD-fakturor under faktureringsmetoden med granskade kurser, SEK-redovisning, betalningar, kursdifferenser, krediter och balansdagsvärdering; inte valutabank eller automatiska kurser. Kontantmetoden kräver ett nytt tomt övningsbolag och stöder svenska SEK-fakturor, betalningsbokföring, kredit/återbetalning och obetalda poster vid årsslut; befintlig bokföring metodväxlas inte. Valuta, kontantmetod, ROT och internationella momsfall kan inte kombineras fritt. AGI XML, moms XML, INK2/SRU och ett avgränsat K2-årsredovisningsdokument kan skapas efter granskning. Ingen fil, faktura eller betalning skickas externt. Serverarkiv, API-integrationer och full regelefterlevnad återstår. Tekniska kontroller visar inte att varje verklig affär eller underlag är korrekt.',
  },
  {
    id: 'ledger-controls',
    title: 'Balansering, periodlås och spårbara rättelser',
    url: '/bokforing/wiki/#artikel/kontering',
    text: 'Demons stödda flöden använder en gemensam verifikationsbok. Belopp lagras i hela ören; debet och kredit måste balansera. Konton, datum, räkenskapsår, periodlås, källbokningar och samband med reskontra kontrolleras. Låsta perioder stoppar nya bokningar. Upplåsning kräver dokumenterad orsak. Fakturautkast kan redigeras. Bokförda verifikationer kan inte skrivas över eller raderas genom de vanliga funktionerna; en rättelse får egen verifikation med koppling till originalet. Sparandet samordnas mellan uppdaterade demoflikar, och gammal data får inte skriva över nyare. Skyddet gäller programmets flöden, inte direkt manipulation av webbläsarlagringen. En balanserad verifikation kan fortfarande ha fel konto, momsbedömning eller period. Förklara skillnaden och efterfråga affärens innehåll när det saknas.',
  },
  {
    id: 'customer-invoices',
    title: 'Kundfakturor och registrerade betalningar',
    url: '/bokforing/wiki/#artikel/kundfakturor',
    text: 'Kundfakturor har egna sidor och ett redigerbart utkast med villkor, kund- och leveransuppgifter, referenser, artiklar, enhet, rad- och fakturarabatt samt avgifter. Pris inklusive eller exklusive moms påverkar beräkningen. Utfärdande skapar fakturanummer, en fryst fakturaversion och bokförd kundfordran. Senare ändringar i registret skriver inte om fakturans sparade uppgifter. Delbetalningar registreras mot den befintliga fordran och får inte överstiga återstående belopp. Betalningen registreras i demoboken; pengar skickas inte. Kopiering skapar ett nytt utkast och är inte en rättelse av originalet. Utskrift kan sparas som PDF. Om en påminnelse förbereds hålls väntat ROT-belopp från Skatteverket utanför kundens påminnelsebelopp. Ingen påminnelse, ränta eller avgift skickas eller bokförs automatiskt.',
  },
  {
    id: 'supplier-invoices',
    title: 'Leverantörsfakturor, blandad moms och underlag',
    url: '/bokforing/wiki/#artikel/leverantorsfakturor',
    text: 'En leverantörsfaktura kan ha flera konteringsrader med eget kostnadskonto, nettobelopp, momssats och avdragsandel. Vanlig svensk moms, momsfritt och uttryckligen bekräftad omvänd byggmoms kan kombineras. Icke avdragsgill moms läggs på kostnaden enligt vald avdragsandel. Systemet räknar; användaren måste bedöma om kontot, momstypen och avdragsrätten passar affären. Tillåtna filer i den lokala inkorgen är PDF, JPEG, PNG och WebP. Filinnehåll, storlek och dubbletter kontrolleras; kontrollsumman verifierar oförändrade bytes, inte fakturans riktighet. Underlag kan kopplas före bokföring och kompletteras senare utan en ny skuld. Kamera använder webbläsarens filfunktion. Ingen e-postinkorg, OCR-tolkning eller långsiktig serverarkivering är ansluten. Ande får inte påstå att den läst dokumentet när bara fakturans strukturerade fält ingår i frågan.',
  },
  {
    id: 'credits-refunds',
    title: 'Delkrediter, återbetalningar och kvittning',
    url: '/bokforing/wiki/#artikel/krediter-aterbetalningar',
    text: 'Krediter & återbetalningar skapar hel-/delkredit per ursprungsrad, även efter betalning, med eget nummer och journal utan att skriva om originalet. Summerad kredit får inte överstiga originalet; momsen återförs kumulativt i exakta ören. Återbetalning och kvittning mot samma motpart har saldo-, datum- och referenskontroll. ROT-fakturor och intäktsperiodiserade fakturor kan nu krediteras efter särskild förhandsgranskning. ROT kräver bekräftad extern ärenderättelse och verklig skatteåterbetalning när mottaget belopp överstiger nytt avdrag. Intäktskredit fördelas proportionellt över ursprunglig avtalstid mellan redan redovisad intäkt och återstående 2990; historiska månadsjournaler bevaras. Kostnader som bär inventarie, lager eller periodisering skyddas. Ingen banköverföring skickas. ROT-kvittning och ny automatisk begäran efter flerpersonskredit är spärrade. Kontantmetod och valuta har egna kreditflöden; antag inte att alla generella kreditfunktioner gäller där.',
  },
  {
    id: 'payroll-2026',
    title: 'Individuell lön: stödda 2026-fall',
    url: '/bokforing/wiki/#artikel/individuell-lon',
    text: 'Lön använder officiella skattetabeller 29–42, kolumn 1/3, för 2026 upp till 80 000 kr/månad samt stödda daterade avgiftsregler. Tabell/kolumn väljs från A-skattsedel. Engångsskatt kräver granskad helårslön. Sjuklön/karens behöver individuellt schema och underlag. Semesterkonton räknar intjänade dagar från anställningsdagar och granskad semestergrundande frånvaro; procentregeln räknar granskat löneunderlag och sammalöneregeln behåller månadslön plus tillägg. Uttag reserverar dagar, och slutlig ersättning kräver särskild granskning; sammalöneregelns slutbelopp per dag anges från avtalet. Obetald bokförd lön kan återföras. Efter betalning används ett separat granskat bruttokrav: original och innehållen skatt bevaras, 1680 visar fordran, inbetalningar och faktisk skattekreditering registreras separat. AGI-underlaget minskar i ursprungsmånaden. Rättslig grund och tidpunkt för sådan AGI-rättelse måste granskas; rättelsesidans fulltext är inte verifierad i implementationen. Kollektivavtal, automatisk semesterlöneskuld, full pension/försäkring, förmånsrättelser och allmän nettokvittning ingår inte. Regler för andra år antas inte. Räkna inte fram exakt personlig lön utan motorresultat och nödvändigt underlag. AGI XML skapas i Deklarationer; löne-CSV är fortsatt granskningsmaterial.',
  },
  {
    id: 'vat-demo',
    title: 'Momsunderlag, avdragsandel och utlandsaffärer',
    url: '/bokforing/wiki/#artikel/moms-utland',
    text: 'Moms & ROT visar momsunderlag och särskilt klassificerade redan betalda SEK-affärer utanför reskontran: svenska affärer, vissa omvända köp, EU-varuinköp, tjänsteinköp enligt huvudregeln från EU/tredje land och valda EU-/exportförsäljningar. Importmoms använder tullunderlag utan att bokföra varuinköpet igen. Land, villkor, VAT-nummer och avdragsandel måste granskas; ingen VIES-kontroll görs. Rapporten tar med stödda fakturor, krediter, valuta- och kontantmetodshändelser enligt bokföringsdatum, visar oklassificerade poster och avstämning mot huvudboken. Kontantmetodens årsslutsbokade fordran ger ingen ny moms vid nästa års betalning. VMB, uttag, hyresfall, trepartshandel och periodisk sammanställning kräver separat hantering. Deklarationer kan skapa moms-XML enligt eSKDUpload 6.0 från avstämd period; perioden ska motsvara bolagets registrerade månad/kvartal/år och hela kalendermånader. Ören tas bort per ruta och ruta 49 räknas från de exporterade rutorna. Ingen inlämning görs och kontonumret ensamt avgör inte momsbehandlingen.',
  },
  {
    id: 'rot-2026',
    title: 'ROT 2026: arbetskostnad, betalning och delbegäran',
    url: '/bokforing/wiki/#artikel/rot-delbegaran',
    text: 'ROT-regeln gäller kundbetalningar 2026: 30 procent av godkänd arbetskostnad inklusive moms och högst 50 000 kr per person/år inom uppgivet utrymme. Material, resor och avgifter räknas inte. Ett fryst fakturaavdrag kan fördelas på 1–10 personer utan att totalen höjs. Delbegäran följer elektronisk kundbetalning, utfört arbete och tidigare andelar. Beslut, skatteutbetalning och återkrav registreras separat; avslag/återkrav lämnar eller återöppnar kundfordran. Efter en ROT-kredit bevaras gamla ärenden, nytt tillåtet avdrag räknas från kvarvarande arbete och eventuell skatteåterbetalning måste bekräftas som faktisk. För en person finns korrigerad begäran, beslut, utbetalning och senare återkrav. Kundens korrigerade andel ska vara betald. Ny automatisk begäran efter flerpersonskredit och ROT-kvittning är spärrade. Begärans metadata kan dateras senast 31 januari 2027; kundbetalningar 2027 stöds inte. Extern rättelse, F-skatt, ägande, verkligt skatteutrymme och avdragsrätt verifieras inte. RUT ingår inte. Ingen ansökan eller bankbetalning skickas.',
  },
  {
    id: 'year-end',
    title: 'Bokslut, periodisering och fortsatt bokföring nästa år',
    url: '/bokforing/wiki/#artikel/nytt-rakenskapsar',
    text: 'Bokslut har versionsbilagor, resultatbokning och nästa år med bevarad historik, fakturor, lager och fleråriga planer. Angivna granskningsnamn är inte identifierad attest. Ändrat saldo kräver ny bilagegranskning; ingående balans dubbleras inte. 2099 flyttas till 2098 utan utdelningsbeslut. Pågående arbeten har bedömningsunderlag, inte automatisk vinstavräkning. Deklarationer skapar verkliga lokala filer efter granskning: AGI XML för vanlig svensk lön 2026, moms XML och INK2/INK2R/INK2S som Latin1-SRU i ZIP för 2026P4. AGI utgår endast från utbetald lön; personnummer och specifikationsnummer låses vid rättelse. INK2 kräver manuellt granskade skattejusteringar; N8/N9 och andra perioder/företagsformer stöds inte. Ett utskrivbart K2-årsredovisningsdokument innehåller jämförelsetal, förvaltningsberättelse, noter, resultatdisposition och underskriftsrader för ett avgränsat mindre privat AB. K2:s nya tillämpningsgränser från 2026 måste bedömas, exempelvis filial, krypto, fastigheter och väsentlig uppskjuten skatt. Saknade historiska år hittas inte på. Det är inte generell K2/K3-täckning. Ingen myndighetsinlämning, digital underskrift, revisionsberättelse eller fastställelseintyg genereras. En sparad filversion ersätter inte kvittens från mottagaren.',
  },
  {
    id: 'ande-boundaries',
    title: 'Andes roll, kontext och kunskapsgränser',
    url: '/bokforing/wiki/#artikel/ande-saas',
    text: 'Ande är en AI-assistent för förklaringar och förslag, inte auktoriserad revisor och inte ett oberoende revisionsutlåtande. Den första anslutna versionen har inga verktyg som bokför, betalar, deklarerar, öppnar låsta perioder eller raderar. Den får bara den aktuella begränsade demokontext och samtalstext som uttryckligen skickas; den har inte automatiskt hela bokföringen, originalfiler, andra flikar, e-post eller historik. Skilj på strukturerade uppgifter i frågan, programregler, allmänna exempel och osäkra redovisningsbedömningar. Föreslå aldrig påhittade verifikationer eller hävda att en åtgärd redan utförts. Beskriv kontoförslag som villkorade förslag och fråga efter saknade affärsfakta. Företagsminne och produktionsåtkomst per kundbolag är en separat framtida serverfunktion. Använd aktuella regelkällor och kvalificerad granskning när den bifogade kunskapen inte räcker; gissa inte juridiska tidsfrister, skatteregler eller procentsatser för andra år.',
  },
  {
    id: 'skatteverket-vat',
    title: 'Skatteverket: fylla i momsdeklarationen',
    url: 'https://www.skatteverket.se/foretag/moms/deklareramoms/fyllaimomsdeklarationen.4.3a2a542410ab40a421c80004214.html',
    text: 'Myndighetsvägvisare för att kontrollera momsdeklarationens rutor och vilka uppgifter som ska redovisas. Länken är en originalkälla, inte bevis att programmets underlag är rätt eller att deklarationen lämnats. Ande har inte hämtat sidans aktuella fulltext vid frågetillfället. Hänvisa dit för vidare kontroll och var tydlig om kunskapspaketets datum 2026-10-23; påstå inte att en aktuell regelkontroll har utförts.',
  },
  {
    id: 'bfn-guidance',
    title: 'Bokföringsnämnden: redovisningsregler och vägledning',
    url: 'https://www.bfn.se/',
    text: 'Bokföringsnämnden är en officiell källa till svensk god redovisningssed, allmänna råd och vägledningar. Vilket regelverk som är tillämpligt beror på företagsform, storlek och förhållanden. Denna länk är en vägvisare, inte en fulltextsamling eller ett godkännande av demoprogrammet. Assistenten har inte läst myndighetens aktuella webbplats vid varje svar och får inte tillskriva BFN en specifik regel, paragraf eller bedömning som inte finns i det bifogade underlaget.',
  },
].map(item => Object.freeze(item)));

const byId = new Map(andeKnowledge.map(item => [item.id, item]));

/** Turn model-selected IDs into a small server-owned list, never model URLs. */
export function getAndeCitations(ids = []) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter(id => typeof id === 'string'))]
    .flatMap(id => {
      const item = byId.get(id);
      return item ? [{ id: item.id, title: item.title, url: item.url }] : [];
    })
    .slice(0, 6);
}
