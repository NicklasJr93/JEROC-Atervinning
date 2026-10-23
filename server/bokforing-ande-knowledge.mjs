/**
 * Small, versioned knowledge pack for the read-only bookkeeping demo assistant.
 * These are reviewed descriptions of supported demo behaviour, not a complete
 * legal corpus or proof of the user's accounting treatment. No runtime crawl,
 * customer-supplied URL, document or cross-company material is included.
 */
export const ANDE_KNOWLEDGE_VERSION = 'SE-demo-2026-10-23.1';

export const andeKnowledge = Object.freeze([
  {
    id: 'demo-scope',
    title: 'Demons omfattning och begränsningar',
    url: '/bokforing/wiki/#artikel/kanda-begransningar',
    text: 'Kontrollerat mot demokoden och dokumentationen 2026-10-23. Bokföringsdemon använder fiktiva uppgifter, SEK och faktureringsmetoden. Ekonomidata och uppladdade original lagras i webbläsaren; de är inte ett manipulationssäkert serverarkiv. Användarens rensning av webbläsardata kan ta bort dem. Ingen riktig betalning, kundfaktura, påminnelse eller deklaration skickas. Exporter för AGI, moms, bolagsskatt och årsredovisning är granskningsunderlag, inte färdiga myndighetsfiler. Fullständig K2/K3-årsredovisning, INK2, kontantmetod, flera valutor, bankanslutning och långsiktig dokumentarkivering återstår. Programkontroller och tekniska tester betyder inte att varje verklig affär är rätt redovisad. Utgå aldrig från att underlaget är äkta, fullständigt eller korrekt bara för att det har registrerats.',
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
    text: 'I Krediter & återbetalningar kan en utfärdad kundfaktura eller bokförd leverantörsfaktura krediteras helt eller delvis per ursprungsrad, även efter betalning. Kreditnotan får eget nummer och egen verifikation; originalet bevaras. Summerade krediter får inte överstiga originalraden. Momsen återförs kumulativt så att en full kredit ger exakt originalets ören, inklusive leverantörsradens avdragsandel. Ett återbetalningsbart saldo kan registreras som återbetalt eller kvittas mot en annan faktura till samma motpart. Datum, saldo och unik referens kontrolleras. Ingen banköverföring utförs. ROT-fakturor och intäktsperiodiserade fakturor är spärrade i det generella kreditflödet eftersom deras underliggande ärenden måste rättas tillsammans. Kostnadsunderlag som bär inventarie, lagervärdering eller periodisering skyddas. Kreditbalanser i reskontra behöver särskild bedömning inför bokslut; automatisk omklassificering återstår.',
  },
  {
    id: 'payroll-2026',
    title: 'Individuell lön: stödda 2026-fall',
    url: '/bokforing/wiki/#artikel/individuell-lon',
    text: 'Lönearbetsytan använder versionerade officiella månadsvisa skattetabeller 29–42, kolumn 1 och 3 för 2026 och skatteunderlag till och med 80 000 kronor. Tabell och kolumn väljs från den anställdes A-skattsedel; de gissas inte från födelseår. Skattepliktiga förmåner ingår i skatte- och avgiftsunderlag men är inte kontant lön. Engångsbelopp i stödda fall använder 2026 års engångstabell och kräver uttryckligen granskat helårslöneunderlag. Sjukfrånvaro, karens och semester behöver individuellt schema, saldo och avtalsbedömning. Stödda arbetsgivaravgifter är daterade; gamla demokörningar kan fortfarande ha manuella skattevärden. Bokförd obetald lön kan återföras med originalkoppling och positiv komplettering kan registreras. Negativa rättelser efter utbetalning, återkrav, full semesterintjäning, kollektivavtal, pension och försäkringar är inte fullständigt implementerade. AGI-CSV är granskningsmaterial. Assistenten ska inte räkna fram en persons exakta lön eller skattetabellsbelopp utan motorberäkning och nödvändigt underlag.',
  },
  {
    id: 'vat-demo',
    title: 'Momsunderlag, avdragsandel och utlandsaffärer',
    url: '/bokforing/wiki/#artikel/moms-utland',
    text: 'Arbetsytan Moms & ROT visar momsunderlag och kan registrera särskilt klassificerade, redan betalda SEK-affärer som inte redan finns i reskontran. Stödda fall omfattar svenska affärer, vissa omvända köp, EU-varuinköp, tjänsteinköp enligt huvudregeln från EU eller tredje land samt valda EU- och exportförsäljningar. Importmoms använder tullunderlag och bokför inte varuinköpet igen. Land, villkor och i relevanta fall köparens VAT-nummer behöver granskas; VAT-numret kontrolleras inte mot VIES. Avdragsandelen är ett uttryckligt användarval, inte en automatisk rättslig bedömning. Rapporten hämtar stödda fakturor, delkrediter och momshändelser till deklarationsrutor, visar oklassificerade verifikationer och avstämning mot huvudboken. Alla specialfall är inte klassificerade. VMB, uttag, frivillig hyresbeskattning, trepartshandel och periodisk sammanställning kräver ytterligare hantering. CSV är granskningsunderlag och skickas inte till Skatteverket. Kontonumret ensamt avgör inte affärens momsbehandling.',
  },
  {
    id: 'rot-2026',
    title: 'ROT 2026: arbetskostnad, betalning och delbegäran',
    url: '/bokforing/wiki/#artikel/rot-delbegaran',
    text: 'Demons ROT-regelversion gäller kundbetalningar under 2026: 30 procent av godkänd arbetskostnad inklusive moms, inom uppgivet återstående årsutrymme och högst 50 000 kronor per person och år i ROT. Material, resor och avgifter ingår inte i arbetsunderlaget. Den äldre fakturaeditorn beräknar ursprungligt avdrag för en person. I den nya ROT-arbetsytan kan en redan utfärdad fakturas frysta avdrag fördelas mellan 1–10 personer; det höjer inte fakturans ursprungliga totalavdrag. Delbegäran baseras på registrerade elektroniska kundbetalningar, utfört arbete och tidigare begärda andelar. Demobeslut anges per person. Avslag lämnar beloppet som kundfordran; en separat skatteutbetalning minskar fordran. Registrerat återkrav bokför återbetalningen och återöppnar motsvarande kundfordran. Begärans metadata kan dateras till 31 januari 2027 men kundbetalningar under 2027 stöds inte. F-skatt, ägande, faktiskt skatteutrymme och rätt till avdrag är inte verifierade. RUT eller ändring av fattade beslut stöds inte. Ingen ansökan skickas.',
  },
  {
    id: 'year-end',
    title: 'Bokslut, periodisering och fortsatt bokföring nästa år',
    url: '/bokforing/wiki/#artikel/nytt-rakenskapsar',
    text: 'Bokslutsarbetsytan samlar avstämningar, versionshanterade bokslutsbilagor, resultatbokning och öppning av nästa räkenskapsår. Granskad i demon betyder två olika angivna namn och underlagsreferens; det är inte identifierad attest eller revisorsgodkännande. Ett ändrat kontosaldo kräver ny granskning av bilagan. Nästa år börjar dagen efter föregående; gamla verifikationer och årsbilden bevaras. Balansräkningen räknar huvudbok till slutdatum och resultatrapporten avser vald period. Ny ingående balans bokförs inte ovanpå bevarad huvudbok. Föregående års resultat flyttas från 2099 till 2098; det är inte beslut om utdelning. Obetalda fakturor, inventarier, lager och fleråriga periodiseringar fortsätter över årsskiftet. Förutbetalda kostnader och intäktsplaner har kontroller och exakta öresfördelningar, men bedömningen av rätt period och regelverk återstår hos användaren. Pågående arbeten är bedömningsunderlag, inte automatisk vinstavräkning. Bolagsskatt och årsredovisningsexport är arbetsmaterial, inte fullständig K2/K3 eller INK2.',
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
