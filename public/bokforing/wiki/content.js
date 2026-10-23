// Editorial snapshot for the public, read-only bookkeeping wiki.
// Text describes the verified demo version below, not a production certification.
const revision = '920a135afd425a0ce440002a991605038ebe8ed1';
const repository = `https://github.com/NicklasJr93/JEROC-Atervinning/blob/${revision}`;
const source = (label, path) => ({ label, url: `${repository}/${path}` });
const updated = '2026-10-23';

export const wikiMeta = {
  title: 'Bokföringswikin',
  product: 'ScrapPlanner',
  version: '920a135',
  asOf: updated,
  versionUrl: `https://github.com/NicklasJr93/JEROC-Atervinning/commit/${revision}`,
  scope: 'Dokumentation av den lokala bokföringsdemon',
  verification: { model: 211, http: 1, browser: 49 },
  description: 'Förstå arbetssätten, följ kontrollerna till koden och se vad som återstår.',
};

export const categories = [
  { id: 'kom-igang', title: 'Kom igång', description: 'Systemets omfattning och en väg in för granskaren.', icon: 'book' },
  { id: 'arbetsfloden', title: 'Arbetsflöden', description: 'Från offert och faktura till betalning och bokslut.', icon: 'workflow' },
  { id: 'kontroller', title: 'Kontroller & historik', description: 'Balansering, rättelser, sparande och underlag.', icon: 'shield' },
  { id: 'regler', title: 'Moms & ROT', description: 'De redovisningsfall som demomodellen stödjer.', icon: 'calculator' },
  { id: 'granskning', title: 'Granskning & tester', description: 'Testbevis, mänskliga bedömningar och kända begränsningar.', icon: 'check' },
  { id: 'utveckling', title: 'Utveckling & versioner', description: 'Vad som har byggts och hur Ande fungerar i demon.', icon: 'history' },
];

export const articles = [
  {
    id: 'borja-har', category: 'kom-igang', title: 'Börja här: så använder du demon',
    summary: 'En kort introduktion till Åkes Hantverk AB, de egna fakturasidorna och dina lokala demodata.',
    status: 'guide', updated, tags: ['introduktion', 'demo', 'kom igång', 'navigering'],
    sections: [
      { id: 'din-arbetsplats', title: 'Din arbetsplats', paragraphs: [
        'Bokföringsdemon öppnas utan inloggning. Startuppgifterna gäller det fiktiva bolaget Åkes Hantverk AB och använder kalenderår 2026, SEK och faktureringsmetoden.',
        'Menyn leder till bland annat kundfakturor, inköp, bokföring, bank, lön, moms och bokslut. Kund- och leverantörsfakturor öppnas på egna sidor med en egen adress i webbläsaren.',
      ] },
      { id: 'prova-ett-flode', title: 'Prova ett sammanhängande flöde', steps: [
        'Öppna Kundfakturor och välj ROT-utkastet för Maria.',
        'Granska rader och ROT-villkor, spara och utfärda fakturan.',
        'Registrera kundens demobetalning och följ verifikationen i Bokföring.',
        'Öppna Inköp för att prova en leverantörsfaktura med ett uppladdat underlag.',
      ] },
      { id: 'lokala-uppgifter', title: 'Dina uppgifter stannar i webbläsaren', callout: {
        title: 'En provmiljö', text: 'Bokföring och uppladdade filer sparas lokalt. De delas inte automatiskt med revisorn eller en annan enhet. Inga betalningar eller deklarationer skickas.', tone: 'info',
      } },
    ],
    sources: [source('Översikt och provflöde', 'bokforing/README.md')],
    related: ['for-revisorn', 'omfattning', 'lagring-och-reset'],
  },
  {
    id: 'for-revisorn', category: 'kom-igang', title: 'För revisorn: en väg genom granskningen',
    summary: 'Börja med omfattningen, välj ett affärsfall och följ dess belopp, original och rättelser.',
    status: 'guide', updated, tags: ['revisor', 'redovisningskonsult', 'granskning', 'checklista', 'bevis'],
    sections: [
      { id: 'ordning', title: 'Rekommenderad ordning', steps: [
        'Läs Systemets omfattning och Kända begränsningar. Välj vilket avgränsat affärsfall du vill bedöma.',
        'Prova en kund- eller leverantörsfaktura. Jämför uppgifter, underlag, summa och kontering innan den bokförs.',
        'Följ fakturans verifikation, betalning och eventuella kredit. Kontrollera att samma belopp återfinns i rapporterna.',
        'Prova en spärr: ett felaktigt belopp, en överbetalning eller bokning i en låst period.',
        'Läs testartikeln och öppna källkoden eller testerna för just den kontroll du vill undersöka.',
      ] },
      { id: 'bedomningar', title: 'Skilj tekniska kontroller från bedömningar', table: {
        headers: ['Teknisk kontroll i demon', 'Bedömning som fortfarande behövs'],
        rows: [
          ['Debet och kredit balanserar.', 'Affären har rätt konto och rätt redovisningsmässig behandling.'],
          ['Belopp och momsrader följer den valda modellen.', 'Den verkliga affären uppfyller modellens moms- och avdragsvillkor.'],
          ['En uppladdad fil har rätt kontrollsumma.', 'Dokumentet är äkta, fullständigt och avser rätt affär.'],
          ['ROT-underlaget räknas från valda arbetsrader.', 'Kunden, bostaden, arbetet och betalningen uppfyller ROT-villkoren.'],
        ],
      } },
      { id: 'delad-granskning', title: 'Vad revisorn får tillgång till', paragraphs: [
        'Den här wikin är läsbar utan inloggning och beskriver den angivna källkodsversionen. Den ger inte åtkomst till någon annans lokala bokföring eller uppladdade dokument.',
        'Demon kan skapa ett granskningspaket i JSON. Det är arbetsmaterial att granska, inte en revisionsberättelse eller ett oberoende godkännande.',
      ] },
    ],
    sources: [source('Omfattning, kontroller och export', 'bokforing/README.md'), source('Rapporter och granskningsåtgärder', 'public/bokforing/suite/app.js')],
    related: ['omfattning', 'verifiering', 'kanda-begransningar', 'bokslut-rapporter'],
  },
  {
    id: 'omfattning', category: 'kom-igang', title: 'Systemets omfattning',
    summary: 'Det här ingår i demomodellen och detta återstår innan ett skarpt bokföringssystem.',
    status: 'limited', updated, tags: ['omfattning', 'mvp', 'funktioner', 'API', 'integration'],
    sections: [
      { id: 'finns', title: 'Det går att prova', bullets: [
        'Kunder, projekt, tid/material, offerter och kundfakturor med ett avgränsat ROT-flöde.',
        'Leverantörsfakturor med lokala PDF-/bildunderlag, bokföring, betalning och vissa krediter.',
        'Gemensam huvudbok, manuella verifikationer, bankavstämning och rapporter.',
        'Demolön, inventarier, handelsvarulager, förutbetalda kostnader, momsperiod och årsavslut.',
      ] },
      { id: 'ramar', title: 'Gemensamma ramar', table: {
        headers: ['Område', 'Den dokumenterade versionen'],
        rows: [
          ['År och valuta', 'Kalenderår 2026 och SEK.'],
          ['Metod', 'Faktureringsmetoden i ett fiktivt demobolag.'],
          ['Lagring', 'Bokföring i localStorage, underlagsfiler i IndexedDB.'],
          ['Användare', 'Ingen inloggning, rollstyrning eller delad bolagsbok.'],
          ['Externa tjänster', 'Ingen banköverföring, myndighetsinlämning, e-postmottagning eller extern AI-tolkning.'],
        ],
      } },
      { id: 'malbild', title: 'Målbilden är större än demon', paragraphs: [
        'Ett självständigt bokföringssystem med eget API och anslutning till andra affärssystem är en målbild. Den nuvarande demon har inte det produktions-API eller den serverlagring som krävs för den målbilden.',
        'Tekniska testresultat gäller de beskrivna demofallen. Full regelefterlevnad och extern redovisningsgranskning är inte verifierade.',
      ] },
    ],
    sources: [source('Funktioner och avgränsning', 'bokforing/README.md'), source('Demobolagets startdata', 'public/bokforing/suite/seed.js')],
    related: ['kanda-begransningar', 'for-revisorn', 'andringar'],
  },
  {
    id: 'kundfakturor', category: 'arbetsfloden', title: 'Kundfaktura: från utkast till betalning',
    summary: 'Egna fakturasidor, rabatter, avgifter, frysta dokumentuppgifter och koppling till huvudboken.',
    status: 'implemented', updated, tags: ['kundfaktura', 'försäljning', 'rabatt', 'betalning', 'pdf'],
    sections: [
      { id: 'arbetsgang', title: 'Arbetsgång', steps: [
        'Välj Ny kundfaktura. Ange kund, datum, villkor, rader, momstyp och eventuellt ROT.',
        'Komplettera referenser, fakturaadress, leveransuppgifter och fakturatext. Kontrollera den löpande summeringen.',
        'Spara utkastet. Granska och utfärda från fakturans egen sida för att tilldela nummer och bokföra kundfordran.',
        'Registrera betalning och följ kvarvarande fordran. Skriv vid behov ut eller spara dokumentet som PDF via webbläsaren.',
      ] },
      { id: 'berakning', title: 'Uppgifter som påverkar beräkningen', bullets: [
        'Radrabatt följs av fakturarabatt. Frakt och fakturaavgift undantas från fakturarabatten.',
        'Pris inklusive eller exklusive moms används som beräkningsgrund. Beloppen hanteras i hela ören.',
        'Samma beloppsmodell används i summeringen, dokumentet, kundfordran och betalningsflödet.',
        'Nya utfärdade fakturor behåller sina sparade kund- och säljaruppgifter även om registeruppgifter ändras senare.',
      ] },
      { id: 'avgransning', title: 'Avgränsning', paragraphs: [
        'Artikelnummer, enhet och prislistnamn kan sparas, men en automatisk artikel- och prismotor saknas. Flera valutor, återkommande fakturor, e-faktura, delkrediter och återbetalningar återstår.',
        'En utfärdad faktura redigeras inte i det vanliga formuläret. Det stödda kreditflödet gäller en helt obetald faktura.',
      ] },
    ],
    sources: [source('Faktureringens funktioner och luckor', 'bokforing/fakturering-jamforelse.md'), source('Fakturans modell', 'public/bokforing/suite/sales.js'), source('Pris- och ROT-beräkning', 'public/bokforing/suite/rot.js')],
    related: ['rot-2026', 'rattelser', 'kontering'],
  },
  {
    id: 'leverantorsfakturor', category: 'arbetsfloden', title: 'Leverantörsfaktura med originalunderlag',
    summary: 'Registrera och granska en faktura bredvid PDF eller bild, bokför och följ betalningen.',
    status: 'implemented', updated, tags: ['leverantörsfaktura', 'inköp', 'kontering', 'underlag', 'påminnelse'],
    sections: [
      { id: 'arbetsgang', title: 'Arbetsgång', steps: [
        'Öppna Inköp och välj en befintlig faktura eller Ny leverantörsfaktura.',
        'Ladda upp ett underlag, ta ett foto på en enhet som stöder kameraval eller välj en fil från inkorgen.',
        'Fyll fakturauppgifterna manuellt. Granska belopp, moms, kostnadskonto och konteringsförslag mot originalet.',
        'Spara utkastet och välj Granska och bokför. Registrera sedan demobetalningen som en egen åtgärd.',
      ] },
      { id: 'kompletteringar', title: 'Komplettera utan att skapa ny skuld', paragraphs: [
        'En påminnelse är inte automatiskt en ny leverantörsfaktura. Den kan kopplas till den befintliga fakturan, även efter bokföring.',
        'Senare bilagor sparas som kompletteringar med en händelse i historiken. Fakturans ursprungliga uppgifter, originalbilagor, verifikation och skuld skrivs inte om av kompletteringen.',
      ] },
      { id: 'avgransning', title: 'Vad som återstår', bullets: [
        'En kostnadsrad och en momstyp per faktura. Flera kostnadsrader, blandade momssatser och radvisa dimensioner återstår.',
        'OCR/betalningsreferens, bankgiro, plusgiro och IBAN är sparade uppgifter; de verifierar inte mottagaren och utlöser ingen banköverföring.',
        'Ingen automatisk fakturatolkning, e-postmottagning eller fleranvändarattest är ansluten.',
      ] },
    ],
    sources: [source('Leverantörsflödet och kommande arbetsytor', 'bokforing/leverantorsfakturor-och-arbetsytor.md'), source('Inköp och betalningar', 'public/bokforing/suite/operations.js'), source('Dokumentuppgifter och kompletteringar', 'public/bokforing/suite/purchase-data.js')],
    related: ['underlagsinkorg', 'kontering', 'rattelser'],
  },
  {
    id: 'underlagsinkorg', category: 'arbetsfloden', title: 'Underlagsinkorgen: filer, bilder och kamera',
    summary: 'Så sparas, kontrolleras och kopplas originalfiler i den lokala demon.',
    status: 'limited', updated, tags: ['underlag', 'bilaga', 'PDF', 'kamera', 'filuppladdning', 'e-post', 'SHA256'],
    sections: [
      { id: 'ta-emot', title: 'Ta emot och koppla ett underlag', paragraphs: [
        'Inköp → Inkomna underlag visar den lokala inkorgen. Filuppladdning och dra och släpp stöder PDF, JPEG, PNG och WebP. Kameraval använder webbläsarens filfunktion på enheter som stöder det.',
        'En uppladdning skapar ingen skuld eller verifikation. Välj därefter att skapa ett fakturautkast eller koppla filen till en befintlig faktura.',
      ] },
      { id: 'filkontroller', title: 'Filkontroller', table: {
        headers: ['Kontroll', 'Beteende'],
        rows: [
          ['Typ och innehåll', 'Filändelse, angiven typ och filsignatur ska stämma med stödda format.'],
          ['Storlek', 'Högst 15 MB per fil, 10 filer per import, 100 MB totalt och 20 underlag per faktura.'],
          ['Dubbletter', 'Identiska bytes återanvänder samma SHA-256-baserade filpost.'],
          ['Före sparande och bokföring', 'Kopplade filers metadata och originalbytes kontrolleras mot kontrollsumman.'],
        ],
      } },
      { id: 'vad-kontrollen-inte-visar', title: 'Vad kontrollen inte visar', paragraphs: [
        'Kontrollsumman visar om samma sparade bytes finns kvar. Den visar inte att fakturan är äkta, att rätt företag är betalningsmottagare eller att affären är avdragsgill.',
        'Filer sparas i IndexedDB på den aktuella webbläsaren. Ett foto och en PDF av samma faktura har olika bytes, så filkontrollen ersätter inte granskning av leverantör och fakturanummer.',
        'E-postmottagning är inte ansluten. En bilaga från ett mejl kan sparas manuellt och laddas upp; en framtida mottagningstjänst ska använda samma inkorg.',
      ] },
    ],
    sources: [source('Filens lagring och validering', 'public/bokforing/suite/documents.js'), source('Dokumentens browserprov', 'tests/bokforing-documents.spec.ts'), source('Arbetsgång och avgränsningar', 'bokforing/leverantorsfakturor-och-arbetsytor.md')],
    related: ['leverantorsfakturor', 'lagring-och-reset', 'verifiering'],
  },
  {
    id: 'kontering', category: 'kontroller', title: 'Kontering, balansering och beloppskontroller',
    summary: 'Vad den gemensamma huvudboken stoppar och vad en balanserad verifikation inte bevisar.',
    status: 'implemented', updated, tags: ['debet', 'kredit', 'huvudbok', 'verifikation', 'balans', 'kontroll'],
    sections: [
      { id: 'gemensam-huvudbok', title: 'En gemensam huvudbok', paragraphs: [
        'Stödda faktura-, betalnings-, löne-, moms- och avslutsflöden skapar verifikationer i samma demobok. Rapporter räknas från den boken.',
        'Manuella verifikationer kan skapas med de konton och affärsfall modellen tillåter. Dokumentstyrda konton hanteras i sina egna flöden.',
      ] },
      { id: 'sparrar', title: 'Exempel på spärrar', bullets: [
        'Debet och kredit måste balansera. Belopp ska vara giltiga heltalsbelopp i ören.',
        'Konton, datum och räkenskapsår kontrolleras. Låsta perioder stoppar nya bokningar.',
        'Samma källbokning får inte skapas två gånger, och betalning får inte överstiga återstående fordran eller skuld.',
        'Återlästa data jämförs med bland annat fakturor, betalningar, lager, inventarier, periodiseringar och moms.',
      ] },
      { id: 'bedomning', title: 'Balansering är inte hela redovisningsbedömningen', callout: {
        title: 'Mänsklig granskning behövs', text: 'En verifikation kan balansera och ändå ha fel konto, fel momshantering eller fel period. Modellens kontroller behöver kombineras med korrekt underlag och bedömning av affären.', tone: 'info',
      } },
    ],
    sources: [source('Gemensamma kontroller och huvudbok', 'public/bokforing/suite/core.js'), source('Återläsningskontroller', 'public/bokforing/suite/validate.js'), source('Prov av spärrar', 'server/bokforing-suite-validation.test.mjs')],
    related: ['rattelser', 'moms', 'verifiering'],
  },
  {
    id: 'rattelser', category: 'kontroller', title: 'Original, rättelser och krediter',
    summary: 'Hur original bevaras i programmets funktioner och vilka rättelsefall som stöds.',
    status: 'limited', updated, tags: ['rättelse', 'kreditfaktura', 'historik', 'oföränderlighet', 'original', 'radera'],
    sections: [
      { id: 'utkast-och-bokfort', title: 'Utkast och bokfört är olika tillstånd', paragraphs: [
        'Fakturautkast kan redigeras. När en kundfaktura utfärdas eller en leverantörsfaktura bokförs sparas de uppgifter som modellen använder för att kontrollera originalet.',
        'Vanlig redigering av en bokförd faktura är spärrad. Befintliga verifikationer ändras eller raderas inte genom programmets normala bokföringsfunktioner.',
      ] },
      { id: 'stodda-rattelser', title: 'Rättelseflöden som finns', bullets: [
        'En helt obetald kundfaktura kan få en länkad helkredit.',
        'En helt obetald leverantörsfaktura kan krediteras med en länkad motbokning.',
        'Manuella rättelser använder en länk till den ursprungliga verifikationen.',
        'En bokförd leverantörsfaktura kan få kompletterande underlag utan ändring av det ursprungliga dokumentet eller dess skuld.',
      ] },
      { id: 'granser', title: 'Gränser för skyddet', paragraphs: [
        'Delkrediter, kredit efter betalning, återbetalningar och fler rättelsefall återstår.',
        'Skyddet gäller programmets funktioner och konsistenskontroller. Lokal browserlagring och kontrollkopior är inte ett manipulationssäkert serverarkiv eller en extern revisionslogg.',
      ] },
    ],
    sources: [source('Fakturor och krediter', 'public/bokforing/suite/sales.js'), source('Inköp och rättelser', 'public/bokforing/suite/operations.js'), source('Kontroll av sparade original', 'public/bokforing/suite/validate.js')],
    related: ['kontering', 'leverantorsfakturor', 'lagring-och-reset'],
  },
  {
    id: 'lagring-och-reset', category: 'kontroller', title: 'Sparande, samtidiga flikar och återställning',
    summary: 'Vad som händer vid sparfel, äldre flikar, reset och rensad browserdata.',
    status: 'limited', updated, tags: ['lagring', 'localStorage', 'IndexedDB', 'reset', 'samtidighet', 'web locks', 'sparfel'],
    sections: [
      { id: 'tva-lager', title: 'Två lokala lager', table: {
        headers: ['Uppgift', 'Lagring'],
        rows: [
          ['Bokföring, fakturor och kopplingar', 'localStorage: scrapplanner-bokforing-suite-v2.'],
          ['Uppladdade originalfiler', 'IndexedDB: scrapplanner-bokforing-documents-v1.'],
          ['Tidigare inköpsdemo', 'Egen lagringsnyckel, skild från den utökade demoboken.'],
        ],
      } },
      { id: 'sparande', title: 'Sparande och återläsning', bullets: [
        'En ändring visas som sparad först efter lyckad skrivning och återläsning.',
        'Uppdaterade flikar samordnas med Web Locks och lagringsrevision. En gammal flik spärras från att skriva över en nyare bok.',
        'Vid konflikt eller sparfel visas ett meddelande. Läs in senaste demodata innan du fortsätter.',
        'Kontrollerna kräver en säker browserkontext och stöd för Web Locks. Äldre redan öppna appversioner omfattas inte av nya klientkontroller.',
      ] },
      { id: 'reset', title: 'Återställ demo', paragraphs: [
        'Återställningen kräver bekräftelse. Den återställer demoboken och dess dokumentkopplingar men behåller uppladdade filer i inkorgen. Den äldre inköpsdemons data lämnas orörda.',
        'Väntande bilagekopplingar från före en återställning får inte återföra egna ändringar när de slutförs. Detta är ett av browserproven.',
        'Att rensa browserdata kan däremot radera både bokföring och filer. En annan enhet har inte automatiskt tillgång till dem.',
      ] },
    ],
    sources: [source('Samordnat sparande', 'public/bokforing/storage.js'), source('Filer i IndexedDB', 'public/bokforing/suite/documents.js'), source('Navigation och väntande filåtgärder', 'public/bokforing/suite/purchase-workspace.js')],
    related: ['underlagsinkorg', 'verifiering', 'kanda-begransningar'],
  },
  {
    id: 'rot-2026', category: 'regler', title: 'ROT 2026: beräkning och demoflöde',
    summary: 'Arbetskostnad, kundandel, demobegäran och skatteutbetalning i det avgränsade ROT-fallet.',
    status: 'limited', updated, tags: ['ROT', 'husarbete', 'skattereduktion', 'arbete', 'Skatteverket', '2026'],
    sections: [
      { id: 'berakningsmodell', title: 'Beräkningsmodellen', paragraphs: [
        'Modellens regelunderlag för betalningsår 2026 anger normalt 30 procent av arbetskostnaden inklusive moms, högst 50 000 kronor ROT per person och år inom ett gemensamt ROT/RUT-tak på 75 000 kronor.',
        'Endast markerade arbetsrader räknas med, efter rabatter. Material, resor, frakt och fakturaavgift ger inget ROT-underlag. Beloppet avrundas nedåt till hela kronor i demoflödet.',
      ] },
      { id: 'rakneexempel', title: 'Ett genomgående exempel', table: {
        headers: ['Del', 'Belopp inklusive moms'],
        rows: [
          ['Arbete: 32 timmar à 550 kronor exklusive moms', '22 000 kr'],
          ['Material', '10 000 kr'],
          ['Resa', '1 000 kr'],
          ['Fakturabelopp', '33 000 kr'],
          ['Planerat ROT vid tillräckligt uppgivet utrymme', '6 600 kr'],
          ['Kundens andel', '26 400 kr'],
        ],
      } },
      { id: 'arbetsgang-och-bedömning', title: 'Arbetsgång och bedömning', paragraphs: [
        'Demon stöder en person per faktura och kundbetalningar under 2026. Hela kundandelen ska vara betald innan en demobegäran förbereds. Användaren bekräftar bland annat utfört arbete och elektronisk betalning.',
        'Demobeslut och skatteutbetalning registreras separat. Ett avslag lämnar motsvarande belopp som kundfordran.',
        'Programmet verifierar inte identitet, F-skatt, ägande, arbetets art, betalningsbevis eller kundens faktiska skatteutrymme. Flera personer, proportionella delbegäranden och årsskiften återstår. Ingen begäran skickas till Skatteverket.',
      ] },
    ],
    sources: [source('Regelunderlag och avgränsning', 'bokforing/rot-regler.md'), source('ROT-beräkning', 'public/bokforing/suite/rot.js'), { label: 'Skatteverket: ROT för företag', url: 'https://www.skatteverket.se/foretag/skatterochavdrag/rotochrut/safungerarrotavdraget.4.2ef18e6a125660db8b080002709.html' }, { label: 'Lag (2009:194) om förfarandet vid skattereduktion för hushållsarbete', url: 'https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-2009194-om-forfarandet-vid-skattereduktion_sfs-2009-194/' }],
    related: ['kundfakturor', 'for-revisorn', 'kanda-begransningar'],
  },
  {
    id: 'bankavstamning', category: 'arbetsfloden', title: 'Bank och betalningar',
    summary: 'Matcha demohändelser, undvik dubbla betalningsbokningar och följ kvarvarande belopp.',
    status: 'limited', updated, tags: ['bank', 'betalning', 'avstämning', 'kassa', 'skattekonto'],
    sections: [
      { id: 'finns', title: 'Det går att prova', bullets: [
        'Fiktiva bankhändelser, företagskonto, kassa och skattekonto.',
        'Betalningar mot kund- och leverantörsfakturor, inklusive delbetalningar.',
        'Val av en befintlig, ännu inte matchad bankhändelse i betalningsformuläret.',
        'Bankavgifter, vissa överföringar, lån och ränta i de stödda demoflödena.',
      ] },
      { id: 'kontroller', title: 'Kontroller vid matchning', paragraphs: [
        'När en befintlig bankhändelse används i betalningsformuläret ska datum, belopp, konto och riktning stämma med betalningen. En händelse får inte användas två gånger.',
        'Om betalningen redan finns som en bankhändelse kan den användas i stället för att skapa en extra händelse. En överbetalning mot fakturan nekas.',
      ] },
      { id: 'aterstar', title: 'Det återstår', paragraphs: [
        'Ingen bankanslutning eller verklig överföring finns. Importfiler, automatisk återrapportering och mer avancerad fördelning av en betalning på flera fakturor behöver egna flöden.',
      ] },
    ],
    sources: [source('Betalning och bankmatchning', 'public/bokforing/suite/operations.js'), source('Kundbetalning och ROT-utbetalning', 'public/bokforing/suite/sales.js'), source('Browserprov för bankflödet', 'tests/bokforing-suite.spec.ts')],
    related: ['kundfakturor', 'leverantorsfakturor', 'kontering'],
  },
  {
    id: 'moms', category: 'regler', title: 'Moms: stödda fall och periodkontroller',
    summary: 'Vanlig svensk moms, avgränsad omvänd byggmoms och ett momsunderlag från huvudboken.',
    status: 'limited', updated, tags: ['moms', 'omvänd byggmoms', 'momsperiod', 'deklaration'],
    sections: [
      { id: 'affarsfall', title: 'Stödda affärsfall', paragraphs: [
        'Kundfakturor stöder vanlig svensk moms och ett avgränsat fall med omvänd byggmoms. Leverantörsfakturor stöder vanlig moms, inköp utan moms och bekräftad omvänd byggmoms.',
        'Momsvalet måste motsvara den verkliga affären. Att välja omvänd byggmoms kräver en bedömning av bland annat köparens och arbetets förutsättningar.',
      ] },
      { id: 'momsperiod', title: 'Momsperiodens arbetsgång', steps: [
        'Öppna Moms & ROT och välj den period som ska granskas.',
        'Följ underlagets belopp till de verifikationer som ingår.',
        'Fastställ en komplett momsperiod i demon. Modellen kontrollerar periodens omfattning och bokför momsbeloppet.',
        'Registrera vid behov regleringen via skattekontot som en separat demohändelse.',
      ] },
      { id: 'begransningar', title: 'Gränser', paragraphs: [
        'Momsunderlaget bygger på huvudbokens momskonton. Fastställda perioder spärrar nya momsverifikationer i perioden.',
        'EU-/exportförsäljning, fler internationella fall och fler avdragsbegränsningar återstår. Underlaget skickas inte till Skatteverket.',
      ] },
    ],
    sources: [source('Moms och periodhantering', 'public/bokforing/suite/finance.js'), source('Kontoval i ROT-regelunderlaget', 'bokforing/rot-regler.md'), source('Kontroller vid återläsning', 'public/bokforing/suite/validate.js')],
    related: ['kontering', 'bokslut-rapporter', 'kanda-begransningar'],
  },
  {
    id: 'lon', category: 'arbetsfloden', title: 'Lön och arbetsgivardeklarationsunderlag',
    summary: 'Demolönekörning med manuella belopp och tydlig avgränsning mot en komplett lönemotor.',
    status: 'limited', updated, tags: ['lön', 'lönebesked', 'anställd', 'AGI', 'skatt', 'semester'],
    sections: [
      { id: 'arbetsgang', title: 'Arbetsgång', steps: [
        'Lägg upp en demoanställd med månads- eller timlön och de skatte-/avgiftsbelopp som ska användas i exemplet.',
        'Skapa löneutkast, granska lönebesked och kontrollera lön, avdrag, semester, förmåner och utlägg.',
        'Bokför lönekörningen och registrera demoutbetalning och reglering av skatt/avgifter.',
        'Exportera vid behov AGI-underlag som gransknings-CSV.',
      ] },
      { id: 'bedomning', title: 'Manuella antaganden', paragraphs: [
        'Skatteavdrag och arbetsgivaravgifter bygger på angivna demovärden. Ingen aktuell skattetabell eller komplett arbetsrättslig beräkning är ansluten.',
        'Den enkla skapa-dialogen använder samma angivna frånvaro-/semester-/förmåns-/utläggsbelopp för varje vald anställd. Individuell granskning och en mer komplett lönemotor är ett eget utvecklingsområde.',
      ] },
      { id: 'export', title: 'Exportens status', callout: {
        title: 'Arbetsmaterial', text: 'AGI-CSV är ett granskningsunderlag. Det är inte en färdig myndighetsfil och skickas inte till Skatteverket.', tone: 'info',
      } },
    ],
    sources: [source('Löneberäkning och bokföring', 'public/bokforing/suite/finance.js'), source('Nuvarande gränser och nästa lönearbetsyta', 'bokforing/leverantorsfakturor-och-arbetsytor.md')],
    related: ['kontering', 'bokslut-rapporter', 'kanda-begransningar'],
  },
  {
    id: 'projekt-offert', category: 'arbetsfloden', title: 'Projekt, tid, material och offert',
    summary: 'Samla arbetsrader, skapa offert och för över godkända rader till ett fakturautkast.',
    status: 'limited', updated, tags: ['projekt', 'offert', 'tid', 'material', 'kund', 'fakturering'],
    sections: [
      { id: 'finns', title: 'Arbetsgång som finns', steps: [
        'Skapa en kund och ett projekt med en demobudget.',
        'Registrera tid, material eller övrigt med beskrivning, antal och pris.',
        'Skapa offert och registrera kundgodkännande i demon.',
        'Skapa ett redigerbart fakturautkast från offerten och granska det på fakturans egen sida.',
      ] },
      { id: 'aterstar', title: 'Vad som behöver byggas vidare', paragraphs: [
        'Projekt-, tid- och offertregistreringen använder ännu enkla formulär. En samlad projektsida, offertversioner, tydligare villkor och uppföljning av vad som redan fakturerats är föreslagna nästa steg.',
        'Registrerad projektförbrukning skapar inte automatiskt lageruttag. Kostnadsuppföljning, lager och fakturering behöver kopplas ihop i fler granskade flöden.',
      ] },
    ],
    sources: [source('Projekt och offert i modellen', 'public/bokforing/suite/sales.js'), source('Föreslagna projektarbetsytor', 'bokforing/leverantorsfakturor-och-arbetsytor.md')],
    related: ['kundfakturor', 'tillgangar-periodisering', 'andringar'],
  },
  {
    id: 'tillgangar-periodisering', category: 'arbetsfloden', title: 'Inventarier, materiallager och periodisering',
    summary: 'Tre olika modeller för tillgångar och kostnader, med skilda bedömningar och bokningsflöden.',
    status: 'limited', updated, tags: ['inventarie', 'avskrivning', 'lager', 'material', 'periodisering', 'förutbetald kostnad'],
    sections: [
      { id: 'tre-floden', title: 'Tre flöden', table: {
        headers: ['Flöde', 'Vad demon gör'],
        rows: [
          ['Inventarie', 'Omklassificerar ett bokfört utrustningsinköp, använder vald nyttjandeperiod och restvärde samt bokför månadsavskrivning och vissa avyttringar.'],
          ['Materiallager', 'Registrerar artiklar, inleverans, uttag och inventering. Handelsvaror värderas periodiskt med 1460/4960.'],
          ['Förutbetald kostnad', 'Utgår från en redan bokförd kostnad, flyttar till 1790 och fördelar kostnaden enligt en månadsplan.'],
        ],
      } },
      { id: 'kontroller', title: 'Kontroller', bullets: [
        'Lageruttag över registrerat saldo stoppas.',
        'Samma periodiseringsmånad ska inte kunna bokföras två gånger.',
        'Återläsning kontrollerar kopplingen mellan tillgångs-/kostnadsmodell och huvudbok.',
        'Vissa krediter stoppas om de skulle ta bort den kostnad som redan ligger bakom inventarie, lager eller periodisering.',
      ] },
      { id: 'bedomningar', title: 'Bedömningar och luckor', paragraphs: [
        'Kostnad eller tillgång, nyttjandeperiod, restvärde och periodtillhörighet måste bedömas. Kontoexemplen är modellens valda klassificeringar.',
        'Pågående arbeten, produktion och andra lagerslag ingår inte. Kundfakturans intäktsperiodisering är inte samma sak som den befintliga modellen för förutbetalda kostnader.',
      ] },
    ],
    sources: [source('Inventarier', 'public/bokforing/suite/finance.js'), source('Lager', 'public/bokforing/suite/inventory.js'), source('Förutbetalda kostnader', 'public/bokforing/suite/periodization.js')],
    related: ['kontering', 'bokslut-rapporter', 'projekt-offert'],
  },
  {
    id: 'bokslut-rapporter', category: 'arbetsfloden', title: 'Rapporter, periodavslut och bokslut',
    summary: 'Följ huvudbokens belopp till rapporter och använd checklistan som underlag för granskning.',
    status: 'limited', updated, tags: ['bokslut', 'resultat', 'balans', 'rapport', 'periodlås', 'granskningspaket'],
    sections: [
      { id: 'rapporter', title: 'Rapporter som finns', paragraphs: [
        'Demon visar bland annat resultat, balans och saldobalans samt momsunderlag med verifikationskoppling. CSV-export och ett granskningspaket i JSON finns.',
        'Rapporterna använder den gemensamma demobokens uppgifter. Revisionsunderlag behöver även förståelig systemdokumentation, underlag och granskning av de bedömningar som ligger bakom posterna.',
      ] },
      { id: 'avslut', title: 'Avslutsflöde', steps: [
        'Kontrollera kontohändelser, kund- och leverantörsposter, moms, löner och tillgångar.',
        'Gå igenom avstämningschecklistan i Bokslut och utred kvarstående differenser.',
        'Lås en period när den ska vara stängd. Upplåsning kräver en dokumenterad orsak i demoflödet.',
        'När årsmodellens villkor är uppfyllda kan årets resultat bokföras och ingående balansunderlag för nästa år förberedas.',
      ] },
      { id: 'dokumentens-status', title: 'Vad exporten inte är', paragraphs: [
        'Granskningspaket och nästa års balansunderlag är arbetsmaterial. De är inte en färdig årsredovisning, inkomstdeklaration eller revisionsberättelse.',
        'Fler rapportval, jämförelseperioder, bokslutsbilagor och direkt navigering från varje rapportsiffra till originalunderlaget återstår.',
      ] },
    ],
    sources: [source('Rapporter, periodlås och årsavslut', 'public/bokforing/suite/finance.js'), source('Export av granskningspaket', 'public/bokforing/suite/app.js'), source('Bokslutets kontroller', 'server/bokforing-suite-finance.test.mjs')],
    related: ['for-revisorn', 'moms', 'kontering'],
  },
  {
    id: 'verifiering', category: 'granskning', title: 'Verifiering: vad har testats?',
    summary: 'Spårbara testresultat för version 920a135 och deras praktiska gränser.',
    status: 'guide', updated, tags: ['tester', 'bevis', 'testresultat', 'kvalitet', '211', '49', 'version'],
    sections: [
      { id: 'resultat', title: 'Dokumenterat resultat', table: {
        headers: ['Kontroll', 'Resultat i denna version'],
        rows: [
          ['Produktionsbygge', 'Godkänt lokalt.'],
          ['Modell- och lagringstester', '211 godkända.'],
          ['HTTP-integrationstest', '1 godkänt.'],
          ['Browserfall mot den byggda servern', '49 godkända.'],
          ['Manuella visuella prov', 'Dator 1600 px och mobilvy 390 px; inga noterade JavaScript-fel eller horisontellt sidöverflöde.'],
        ],
      } },
      { id: 'exempel', title: 'Exempel på testade fel', bullets: [
        'Felaktiga belopp, överbetalning, dubbla källbokningar och bokning i låst period.',
        'Gammal flik, misslyckad skrivning, återläsning och explicit demo-reset.',
        'Fel filtyp, för stor import, kvotfel, ändrade originalbytes och saknad fil.',
        'Bilagekoppling som slutförs efter sidbyte eller reset ska inte hamna på fel utkast eller återinföra gamla ändringar.',
        'Frysta fakturauppgifter, ROT, bankmatchning, lön, lager och periodisering.',
      ] },
      { id: 'bevisets-grans', title: 'Så ska resultatet läsas', paragraphs: [
        'Antalen avser den lokalt verifierade versionen 920a135, inte en löpande mätning av den senast publicerade appen. Källänkarna nedan är låsta till samma kodversion.',
        'Kameraprovet använder filinput med kameraattribut; fysisk telefonkamera har inte provats. Tester av de stödda fallen är inte en redovisningscertifiering eller en kontroll av varje tänkbart affärsfall.',
      ] },
    ],
    sources: [source('Dokumenterat testresultat', 'bokforing/README.md'), source('Leverantörsvyernas browserprov', 'tests/bokforing-purchase-pages.spec.ts'), source('Dokumentlagringens browserprov', 'tests/bokforing-documents.spec.ts'), source('Kundfakturornas browserprov', 'tests/bokforing-invoice-pages.spec.ts'), source('Sammanhängande browserflöden', 'tests/bokforing-suite.spec.ts'), source('Kontroll vid återläsning', 'server/bokforing-suite-validation.test.mjs')],
    related: ['for-revisorn', 'kanda-begransningar', 'andringar'],
  },
  {
    id: 'kanda-begransningar', category: 'granskning', title: 'Kända begränsningar och kvarstående arbete',
    summary: 'En samlad lista över sådant som demon inte täcker eller inte kan avgöra.',
    status: 'planned', updated, tags: ['begränsningar', 'luckor', 'planerat', 'regelefterlevnad', 'säkerhet', 'server', 'API'],
    sections: [
      { id: 'produktion', title: 'Inför en skarp produkt', bullets: [
        'Delad serverlagring, bolagsavgränsning, användarbehörigheter och identifierade gransknings-/attestroller.',
        'Hållbart dokumentarkiv, säkerhetskopiering och provad återläsning.',
        'Produktions-API, SIE och externa anslutningar för bank, e-post, fakturautskick och myndighetsunderlag.',
        'Fortsatt systemdokumentation, granskade redovisningsfall och extern bedömning av systemet.',
      ] },
      { id: 'affarsfall', title: 'Fler affärsfall', bullets: [
        'Delkrediter, betalda krediter, återbetalningar och mer avancerad betalningsfördelning.',
        'Flera valutor, internationella momsfall, fler avdragsbegränsningar och fler konteringsrader på leverantörsfakturan.',
        'Återkommande fakturor, verkliga artikel-/prisregister och kundfakturans intäktsperiodisering.',
        'Fler ROT-personer, RUT, proportionella begäranden, årsskiften och återkrav.',
        'Komplett lönemotor, fler lager-/produktionsfall och fler avsluts-/deklarationsunderlag.',
      ] },
      { id: 'ansvar', title: 'Vad systemet inte kan bevisa', callout: {
        title: 'Begränsningarna är en del av dokumentationen', text: 'Demon kan inte garantera att varje verklig affär är rätt klassificerad eller att all regelefterlevnad är uppfylld. Affärens innebörd, underlagets kvalitet och de relevanta reglerna behöver fortfarande granskas.', tone: 'info',
      } },
    ],
    sources: [source('Övergripande avgränsning', 'bokforing/README.md'), source('Faktureringens kvarstående funktioner', 'bokforing/fakturering-jamforelse.md'), source('Kommande arbetsytor', 'bokforing/leverantorsfakturor-och-arbetsytor.md')],
    related: ['omfattning', 'for-revisorn', 'verifiering'],
  },
  {
    id: 'andringar', category: 'utveckling', title: 'Ändringslogg och dokumenterad version',
    summary: 'De senaste stegen från enkel ekonomidemo till egna fakturasidor och lokal underlagsinkorg.',
    status: 'guide', updated, tags: ['ändringslogg', 'version', 'release', 'historik', 'utveckling'],
    sections: [
      { id: 'senaste-etapper', title: 'Senaste etapper', table: {
        headers: ['Etapp', 'Innehåll'],
        rows: [
          ['Utökad ekonomidemo', 'Gemensam huvudbok för fakturor, betalningar, ROT, lön, lager, periodisering, moms och bokslut.'],
          ['Egna kundfakturasidor', 'Stor editor, egna adresser, fakturauppgifter, rabatter/avgifter, kopiering och frysta dokumentuppgifter.'],
          ['Leverantörssidor och underlagsinkorg', 'Egna sidor, lokal fil-/kamerainmatning, originalvisning, dubblettkontroll och kompletteringar efter bokföring.'],
        ],
      } },
      { id: 'den-har-wikin', title: 'Den här wikins version', paragraphs: [
        'Innehållet beskriver källkodsversion 920a135 från den 23 oktober 2026. Wikins eget gränssnitt kan publiceras i en senare commit utan att den dokumenterade bokföringsversionen ändras.',
        'En GitHub-push och en färdig publicering är olika händelser. Faktisk driftversion behöver kontrolleras mot den tjänst som serverar appen.',
      ] },
      { id: 'nasta-prioriteringar', title: 'Prioriterad fortsättning', bullets: [
        'Verifikationssida med direkt väg till originalunderlag och rättelser.',
        'Samlad projekt-/offertarbetsyta och individuella lönebesked.',
        'Tydligare bankavstämning och navigering från rapporter till underlag.',
        'Fler inköpsrader, blandad moms samt riktig e-postmottagning och granskad fakturatolkning.',
      ] },
    ],
    sources: [source('Projektets ändringslista', 'docs/Andringslistan.txt'), source('Prioriterade nästa arbetsytor', 'bokforing/leverantorsfakturor-och-arbetsytor.md')],
    related: ['verifiering', 'kanda-begransningar', 'omfattning'],
  },
  {
    id: 'ande', category: 'utveckling', title: 'Ande: förklaringar i den nuvarande demon',
    summary: 'Assistenten kan förklara exempel och nästa steg men utför ingen självständig redovisningsgranskning.',
    status: 'limited', updated, tags: ['Ande', 'AI', 'assistent', 'förklaring', 'redovisning'],
    sections: [
      { id: 'nuvarande-funktion', title: 'Det Ande gör nu', paragraphs: [
        'Ande ger kontextbundna, exempelbaserade svar om bland annat ROT, debet/kredit, moms, lön, periodisering och bokslut. Vissa svar använder demobokens aktuella antal eller belopp.',
        'Svaren ändrar inte bokföringen. Bokning, betalning och andra ändringar görs i de vanliga granskade arbetsflödena.',
      ] },
      { id: 'begransning', title: 'Det Ande inte är', paragraphs: [
        'Ingen extern språkmodell, fakturatolkning eller yrkesauktorisation ingår i denna version. Assistenten ersätter inte en redovisningskonsult eller revisor.',
        'Ett framtida AI-förslag behöver visa vilka uppgifter och regler det bygger på, skilja förslag från bokförda beslut och lämna osäkra fall för granskning.',
      ] },
    ],
    sources: [source('Assistentens exempelbaserade svar', 'public/bokforing/suite/app.js'), source('Demons avgränsning', 'bokforing/README.md')],
    related: ['for-revisorn', 'kontering', 'kanda-begransningar'],
  },
];
