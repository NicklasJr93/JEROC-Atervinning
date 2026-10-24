// Editorial snapshot for the public, read-only bookkeeping wiki.
// Text describes the verified demo version below, not a production certification.
const revision = '08d544c4798967052a023460823b1bf6ca3cb595';
const repository = `https://github.com/NicklasJr93/JEROC-Atervinning/blob/${revision}`;
const source = (label, path) => ({ label, url: `${repository}/${path}` });
const historicalSource = (label, path) => ({ label, url: `https://github.com/NicklasJr93/JEROC-Atervinning/blob/c5134ecddc624c1e3a0e30e3e3f6058bcc8d0b95/${path}` });
const andeRepository = repository;
const andeSource = (label, path) => ({ label, url: `${andeRepository}/${path}` });
const updated = '2026-10-23';

export const wikiMeta = {
  title: 'Bokföringswikin',
  product: 'Endor Bokföring',
  version: revision.slice(0, 7),
  asOf: '2026-10-24',
  versionUrl: `https://github.com/NicklasJr93/JEROC-Atervinning/commit/${revision}`,
  scope: 'Lokal bokföringsdemo med simulerad byrååtkomst',
  verification: { model: 3511, http: 1, browser: 128 },
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
    id: 'byra-behorigheter', category: 'arbetsfloden', title: 'Byrå & behörigheter i Endor Bokföring',
    summary: 'Bjud in en registrerad demoperson, välj behörigheter och växla mellan accepterade kundbolag.',
    status: 'guide', updated: '2026-10-24', tags: ['Endor', 'byrå', 'Lexratio', 'personnummer', 'inbjudan', 'behörighet', 'bolagsbyte'],
    sections: [
      { id: 'prova', title: 'Prova båda sidor av inbjudan', bullets: [
        'Öppna Byrå & behörigheter i menyn eller via Företaget. Välj Åke som Demoperson.',
        'Ange Jennys fiktiva testnummer 20900303-0039, välj rättigheter och skapa inbjudan. Ankis testnummer är 20900404-0045.',
        'Välj Jenny som Demoperson och acceptera inbjudan. Först därefter visas Åkes bolag bland hennes uppdrag.',
        'Välj Arbeta i bolaget. Åke kan ändra rättigheter eller återkalla åtkomsten. Avböjda och återkallade inbjudningar finns kvar i historiken.',
      ] },
      { id: 'rattigheter', title: 'Separata rättigheter', table: { headers: ['Rättighet', 'Omfattning i demon'], rows: [
        ['Läsa och granska', 'Grundåtkomst till bolagets vanliga bokföringsvyer.'],
        ['Bokföra och fakturera', 'Skapa och redigera affärsunderlag samt bokföra stödda flöden.'],
        ['Hantera lön', 'Öppna lönearbetsytan och arbeta med löneunderlag.'],
        ['Moms, periodlåsning och bokslut', 'Fastställa perioder och använda bokslutsflöden.'],
        ['Registrera betalningar', 'Registrera fiktiva kund-, leverantörs- och skattebetalningar; ingen banköverföring görs.'],
        ['Exportera underlag', 'Ladda ned underlag. Fullständiga paket kräver även rättigheter till känsliga arbetsytor.'],
      ] } },
      { id: 'bolagsbyte', title: 'Bolagsbyte och spårbarhet', paragraphs: [
        'Åkes befintliga bok bevaras under sin tidigare lagringsnyckel. Björks övningsbolag har en egen tom bok och en separat lokal filinkorg. Byte av bolag eller demoperson stänger formulär, rensar urval och nollställer Andes samtal.',
        'Inbjudan ger ingen åtkomst innan mottagaren accepterar. Ändrade rättigheter kontrolleras även vid sparande, samordnat med återkallelser mellan flikar. Nya bokföringshändelser anger faktisk demoperson, byrå och bolags-ID.',
      ] },
      { id: 'grans', title: 'Vad light-versionen innebär', paragraphs: [
        'Detta är en lokal demo med fiktiva framtida personnummer. Demopersonsväljaren är inte en inloggning. Personnumret används för att hitta en befintlig profil, inte för att styrka identiteten.',
        'Inbjudningarna finns i den aktuella webbläsaren och kan delas mellan dess flikar. Inga mejl skickas och inget delas automatiskt mellan olika datorer. Lokal lagring är inte en säkerhetsgräns mot den som kontrollerar webbläsaren.',
        'Inför riktig användning krävs identifierade konton, serverlagring, behörighetskontroll för varje serveroperation och serverbaserad bolagsisolering. Den delen har inte införts i denna etapp.',
      ] },
      { id: 'testat', title: 'Verifiering av byråflödet', paragraphs: [
        '61 nya automatiska fall testar inbjudningar, rättighetskontroller, lagring och återkallelser. Den samlade automatiska bokföringssviten är 3 512 av 3 512 godkänd.',
        'Nio nya webbläsarfall testar båda sidor av inbjudan, fel mottagare, spärrade formulär, återkallelse i en redan öppen flik, separata böcker och PDF-inkorgar, mobilvy och Andes bolagsbyte. Samtliga är godkända.',
      ] },
    ],
    sources: [source('Arbetsgång och begränsningar', 'bokforing/byra-och-behorigheter.md'), source('Inbjudningar och rättigheter', 'public/bokforing/suite/agency.js'), source('Samordnad lagring och kontroll vid sparande', 'public/bokforing/suite/agency-storage.js'), source('Webbläsarprov för byråflödet', 'tests/bokforing-agency.spec.ts')],
    related: ['verifiering', 'for-revisorn', 'ande-saas', 'kanda-begransningar'],
  },
  {
  "id": "audit3-1000",
  "category": "granskning",
  "title": "1 000 nya scenariotester: tredje testomgången",
  "summary": "Fem nya testmatriser, ett rättat funktionsfel och 3 451 godkända automatiska tester.",
  "status": "guide",
  "updated": "2026-10-23",
  "tags": [
    "1000",
    "3451",
    "tester",
    "regelefterlevnad",
    "förmån",
    "lön",
    "SIE",
    "rapport"
  ],
  "sections": [
    {
      "id": "resultat",
      "title": "Vad som testats",
      "table": {
        "headers": [
          "Nya kombinationsfall",
          "Antal"
        ],
        "rows": [
          [
            "Kundfakturor, krediter, återbetalningar och ROT",
            "200"
          ],
          [
            "Leverantörer, kontantmetod och valuta",
            "200"
          ],
          [
            "Lön, förmåner, årsgräns och återkrav",
            "200"
          ],
          [
            "Moms, periodspärrar och deklarationsfält",
            "200"
          ],
          [
            "Huvudbok, SIE, rättelser, årsbyte och arkiv",
            "200"
          ]
        ]
      },
      "paragraphs": [
        "Alla 1 000 nya fall och samtliga 2 451 tidigare automatiska tester är godkända: totalt 3 451, utan underkända eller överhoppade.",
        "15 riktade webbläsarfall ingår: nio arbetsflödesfall (två nya) och sex omkörda wiki-fall. De tidigare bredare webbläsarkörningarna bevaras som historiska resultat."
      ]
    },
    {
      "id": "fynd",
      "title": "Ett fel hittades och rättades",
      "paragraphs": [
        "Tio lönescenarier fångade samma rotorsak: ren skattepliktig förmån under årsgränsen gav inga bokföringsrader men programmet försökte ändå skapa en verifikation.",
        "Nu registreras och bekräftas ett granskat sådant förmånsunderlag utan tom verifikation eller bankbetalning. Original och händelser bevaras; återtag, AGI och årsarkiv har testats. Vanlig lön måste fortfarande ha korrekta bokföringsposter. Flödet utan verifikation är avgränsat till positiv förmån utan kontantlön, skatt, avgift, utlägg eller semesteruttag."
      ]
    },
    {
      "id": "metod",
      "title": "Hur resultaten ska läsas",
      "paragraphs": [
        "Det är deterministiska kombinationsfall med fasta belopp och olika händelsekedjor. Beloppsfacit, perioder, originalhistorik, JSON-återläsning och nekade ändringar kontrolleras. En separat kodgranskning stärkte bland annat kontantmetodens mellanlägen och momsens exporterade kronbelopp.",
        "1 000 testfall är inte 1 000 självständigt granskade lagkrav. Alla verkliga identiteter, avdragsvillkor, underlag och branschfall kan inte verifieras av programtester."
      ]
    },
    {
      "id": "avgransning",
      "title": "Kvarstående granskning",
      "callout": {
        "title": "Fortsatt demo och avgränsade regler",
        "text": "Full regelefterlevnad eller skarp drift är inte styrkt. Identifierade användare, bolagsisolering och hållbar arkivering kvarstår i driftetappen. Verkliga affärsvillkor och särregler behöver redovisningsmässig granskning.",
        "tone": "info"
      }
    }
  ],
  "sources": [
    {
      "label": "Kort granskningsrapport (PDF)",
      "url": "/bokforing/granskning/atgarder/audit3-1000.pdf"
    },
    {
      "label": "Samtliga testresultat (CSV)",
      "url": "/bokforing/granskning/atgarder/testresultat-audit3.csv"
    },
    {
      "label": "Maskinläsbar rapport",
      "url": "/bokforing/granskning/atgarder/audit3-1000.json"
    },
    {
      "label": "Metod och begränsningar",
      "url": "https://github.com/NicklasJr93/JEROC-Atervinning/blob/cc4a2a25e2c605fd6cc5d2839c4e7565b8c728f2/bokforing/granskning/audit3-1000.md"
    }
  ],
  "related": [
    "for-revisorn",
    "verifiering",
    "andra-testomgangen-2026",
    "kanda-begransningar"
  ]
},
  {
  "id": "andra-testomgangen-2026",
  "category": "granskning",
  "title": "Andra testomgången: 66 nya fall och två rättningar",
  "summary": "2 451 automatiska tester samt riktade webbläsarprov. Två nya fel hittades och rättades.",
  "status": "guide",
  "updated": "2026-10-23",
  "tags": [
    "test",
    "granskning",
    "lön",
    "årsbedömning",
    "moms",
    "återföring",
    "66",
    "2451"
  ],
  "sections": [
    {
      "id": "resultat",
      "title": "Aktuellt testresultat",
      "paragraphs": [
        "66 nya automatiska testfall och samtliga 2 385 tidigare fall är godkända: totalt 2 451. Inga underkända eller överhoppade fall i slutkörningen.",
        "Åtta riktade webbläsarfall är godkända, varav två nya. Därutöver kontrolleras de sex befintliga wiki-fallen efter uppdateringen. Det är ett urval för denna ändring; de 115 fallen i den föregående omgången är historiska resultat."
      ]
    },
    {
      "id": "ratta",
      "title": "Två fel som hittades och rättades",
      "bullets": [
        "Lön: en redan bokförd, obetald körning kunde betalas efter en slutlig årsbedömning under 1 000 kr. Nu måste en uttrycklig ny årsavstämning göras innan ytterligare betalning. Det gäller både den nya och äldre lönemodulen, även noll nettolön och flerpersonskörning.",
        "Moms: en separat momsfri affär kunde återföras inom en redan fastställd period. Nu stoppas återföringar som skulle ändra periodens deklarationsrutor, även om själva momsbeloppet är noll. Rättelser i nästa öppna period och momsneutrala inköpsrättelser fungerar fortfarande."
      ]
    },
    {
      "id": "metod",
      "title": "Vad de nya testerna prövar",
      "bullets": [
        "15 fakturafall: ändrade kunder/bolagsuppgifter, krediter, kopior, frysta original och försök att kringgå kraven.",
        "12 betalningsfall: olika uppdelningar av samma betalning och återbetalning i vanlig fakturering, valuta och kontantmetod ska bevara alla ören.",
        "19 lönefall: årsgräns, AGI, förmåner, återkrav, perioder, flera personer och spärrarnas atomicitet.",
        "20 momsfall: klassningar, krediter, periodgränser, deklarationer och kvarstående gamla oklassade underlag.",
        "Två nya webbläsarfall: fakturaspärrar vid omladdning och kopiering samt oförändrade sparade data efter ett nekat, forcerat knapptryck."
      ]
    },
    {
      "id": "grans",
      "title": "Resultatets gräns",
      "callout": {
        "title": "Teknisk testning av demon",
        "text": "Antalet tester är inte ett antal godkända lagkrav. Testerna styrker de dokumenterade exemplen och spärrarna. Full regelefterlevnad, verkliga underlag och lämplighet för skarp drift behöver fortsatt granskning.",
        "tone": "info"
      }
    }
  ],
  "sources": [
    {
      "label": "Kort rapport och metod",
      "url": "https://github.com/NicklasJr93/JEROC-Atervinning/blob/0b66b070cd8b31aa337999bc0db828ab57399193/bokforing/granskning/2026-10-23-andra-testomgangen.md"
    },
    {
      "label": "Hela testförteckningen (CSV)",
      "url": "/bokforing/granskning/atgarder/testresultat-omtest-2-2026-10-23.csv"
    },
    {
      "label": "Maskinläsbart testresultat",
      "url": "/bokforing/granskning/atgarder/omtest-2-2026-10-23.json"
    }
  ],
  "related": [
    "for-revisorn",
    "verifiering",
    "atgarder-2026",
    "kanda-begransningar"
  ]
},
  {
  "id": "atgarder-2026",
  "category": "granskning",
  "title": "Första åtgärdsomgången: fakturakrav, moms och lönegräns",
  "summary": "132 nya modellfall, fullständig regressionskörning och en kort uppföljande rapport.",
  "status": "guide",
  "updated": "2026-10-23",
  "tags": [
    "åtgärder",
    "fakturakrav",
    "momsfri",
    "årsgräns",
    "1000",
    "rapport",
    "PDF"
  ],
  "sections": [
    {
      "id": "resultat",
      "title": "Verifierat i denna version",
      "paragraphs": [
        "2385 automatiska tester och 115 webbläsarfall är godkända. Detta är tekniska testresultat för de dokumenterade fallen; full regelefterlevnad är inte styrkt."
      ]
    },
    {
      "id": "faktura",
      "title": "Nya fakturor kontrolleras före utfärdande",
      "bullets": [
        "Namn, fullständiga adresser, relevanta momsnummer och bekräftat leverans-/utförandedatum eller period.",
        "Aktiebolags organisationsnummer, styrelsesäte och likvidationsuppgift. Igenkända svenska organisations-/personnummer jämförs med angivet VAT-nummer. Ingen myndighetskontroll av registrering görs.",
        "Kontrollerna finns för ordinarie, valuta- och kontantfakturor. Frysta original och tillhörande kreditnotor behåller sina uppgifter.",
        "Utkast kan sparas ofullständiga. Nya kopior behöver ny datumgranskning. Förskott eller fakturering före framtida prestation stöds inte i dessa vanliga flöden."
      ]
    },
    {
      "id": "moms",
      "title": "0 % kräver uttrycklig bedömning",
      "paragraphs": [
        "Stödda svenska momsundantag väljs uttryckligen med grund, bedömning och bekräftelse. Sådana belopp hamnar i ruta 42. Undantagstexten avser bara de momsbefriade raderna, även på kreditnotor. Positiv moms kan inte kombineras med motstridig undantagsuppgift.",
        "Gamla oklassade nollmomsunderlag ändras inte. De ger varning som stoppar fastställande och XML-export tills redovisningsmässig granskning/rättelse är gjord. Det gäller även äldre valuta- och kontantfakturor."
      ]
    },
    {
      "id": "lon",
      "title": "Årsgräns för arbetsgivaravgifter",
      "paragraphs": [
        "Faktisk lön och skattepliktiga förmåner ackumuleras per anställdspost och år. Vid 1 000 kr hanteras tidigare avgiftsfri ersättning enligt reglerna för tröskelpassage. Skatteavdragets prognos är en separat bedömning.",
        "AGI använder fälten 010, 011/012 och 131/132. Återkrav och avgiftsdifferenser får separat, spårbar årsavstämning utan att gamla löneoriginal skrivs om. Löneprofilen behöver en granskad årsprognos och referens."
      ]
    },
    {
      "id": "kvarstar",
      "title": "Kvarstående avgränsningar",
      "callout": {
        "title": "Fortsatt granskning behövs",
        "text": "Serverlagring, inloggning, bolagsisolering och hållbar arkivering återstår i driftetappen. Alla internationella skattefall, kollektivavtal, särskilda löne-/förmånsregler eller förskottsflöden omfattas inte. Riktiga identiteter och affärsvillkor behöver bedömas externt.",
        "tone": "info"
      }
    }
  ],
  "sources": [
    {
      "label": "Kort åtgärdsrapport (PDF)",
      "url": "/bokforing/granskning/atgardsrapport-2026-10-23.pdf"
    },
    {
      "label": "Testförteckning för åtgärdsversionen",
      "url": "/bokforing/granskning/atgarder/testresultat-2026-10-23.csv"
    },
    {
      "label": "Ursprunglig granskning (historisk PDF)",
      "url": "/bokforing/granskning/granskningsrapport-2026-10-23.pdf"
    },
    {
      "label": "Årsgränsens regler och arbetsgång",
      "url": "https://github.com/NicklasJr93/JEROC-Atervinning/blob/ee235b3efbf0181dfbe5248861ae342604054923/bokforing/lon-arsgrans-2026.md"
    }
  ],
  "related": [
    "for-revisorn",
    "verifiering",
    "kanda-begransningar",
    "regelgranskning-2026"
  ]
},
  {
  "id": "regelgranskning-2026",
  "category": "granskning",
  "title": "Tidigare regelgranskning: rapport för redovisaren",
  "summary": "1 798 nya auditfall, 13 fynd med åtgärder och en PDF med kravmatris, testbevis och kvarstående luckor.",
  "status": "guide",
  "updated": "2026-10-23",
  "tags": [
    "PDF",
    "rapport",
    "regelefterlevnad",
    "granskning",
    "redovisare",
    "1798",
    "2253",
    "testresultat"
  ],
  "sections": [
    {
      "id": "resultat",
      "title": "Historiska resultat för version 1520d83",
      "table": {
        "headers": [
          "Kontroll",
          "Resultat"
        ],
        "rows": [
          [
            "Nya auditfall",
            "1 798 godkända, fördelade på sex områden."
          ],
          [
            "Hela automatiska sviten",
            "2 253 godkända: 2 252 modell-/lagrings-/AI-fall och 1 HTTP-test. Inga underkända eller överhoppade."
          ],
          [
            "Webbläsarprov",
            "41 berörda affärsfall och 6 wiki-fall, totalt 47 godkända. Det är en riktad omkörning, inte alla tidigare browserfall."
          ],
          [
            "Produktionsbygge",
            "Godkänt med typkontroll."
          ],
          [
            "Fynd",
            "13 fynd har rättats eller fått en skyddsspärr."
          ]
        ]
      }
    },
    {
      "id": "atgarder",
      "title": "Vad som har rättats",
      "bullets": [
        "ID-serien kontrolleras vid återläsning så att nästa bokning inte återanvänder ett genererat ID.",
        "ROT begränsas av uppgivet utrymme. Personfördelning vid nya delbegäranden kan inte minska redan begärda andelar.",
        "Semesteråterföringar hanterar historiska saldon och kan inte frigöra framtida dagar för ett tidigare daterat uttag.",
        "Kreditnotor anger originalfaktura och skäl. Utskrifter visar nettopris även när priset matats in inklusive moms.",
        "Återläsning skyddar tidsordningen vid krediter av periodiserad intäkt.",
        "Fastställd moms skyddar även deklarationsunderlag där själva momsbeloppet är noll.",
        "Kontantmetodens årsslut kan hantera verklig radomfördelning utan en konstgjord nollverifikation.",
        "AGI-export kontrollerar schemats beloppsgränser och verkliga kalenderdatum.",
        "Svensk standardförsäljning med 0 % och oklar rättslig grund varnas och blockerar moms-XML. Ingen automatisk omklassning görs."
      ]
    },
    {
      "id": "kvarstar",
      "title": "Vad resultatet inte styrker",
      "callout": {
        "title": "Full regelefterlevnad är inte styrkt",
        "text": "Den första rapporten beskrev luckor i fakturauppgifter, momsklassning och lönegräns. Dessa har åtgärdats inom den dokumenterade omfattningen; läs Åtgärder: fakturakrav, moms och lönegräns för aktuellt resultat. Beständig arkivering, identifierade användare och bolagsisolering återstår. Affärernas verkliga innehåll och avdragsrätt behöver fortfarande bedömas av redovisare.",
        "tone": "info"
      }
    },
    {
      "id": "underlag",
      "title": "Läs och granska rapporten",
      "paragraphs": [
        "PDF:en beskriver metod, varje fynd med test-ID, lag-/källhänvisningar, kvarstående risker och en checklista för extern granskning. CSV-filen listar samtliga 2 253 automatiska testfall. Källkodsversionen anges i rapporten. Antalet tester är inte ett antal godkända lagkrav."
      ]
    }
  ],
  "sources": [
    {
      "label": "Ladda ned granskningsrapporten (PDF)",
      "url": "/bokforing/granskning/granskningsrapport-2026-10-23.pdf"
    },
    {
      "label": "Fullständig testförteckning (CSV)",
      "url": "/bokforing/granskning/testresultat-2026-10-23.csv"
    },
    {
      "label": "Rå testlogg (TAP, gzip)",
      "url": "/bokforing/granskning/testlogg-2026-10-23.tap.gz"
    }
  ],
  "related": [
    "for-revisorn",
    "verifiering",
    "kanda-begransningar"
  ]
},
  {
    id: 'borja-har', category: 'kom-igang', title: 'Börja här: så använder du demon',
    summary: 'En kort introduktion till Åkes Hantverk AB, de egna fakturasidorna och dina lokala demodata.',
    status: 'guide', updated, tags: ['introduktion', 'demo', 'kom igång', 'navigering'],
    sections: [
      { id: 'din-arbetsplats', title: 'Din arbetsplats', paragraphs: [
        'Bokföringsdemon öppnas utan inloggning. Startuppgifterna gäller det fiktiva bolaget Åkes Hantverk AB och använder kalenderår 2026, SEK och faktureringsmetoden.',
        'Menyn leder till kundfakturor, inköp, bokföring, bank, lön, moms och bokslut samt SIE, valutafakturor, kontantmetod och deklarationer. Kund- och leverantörsfakturor öppnas på egna sidor med en egen adress i webbläsaren.',
      ] },
      { id: 'prova-ett-flode', title: 'Prova ett sammanhängande flöde', steps: [
        'Öppna Kundfakturor och välj ROT-utkastet för Maria.',
        'Granska rader och ROT-villkor, spara och utfärda fakturan.',
        'Registrera kundens demobetalning och följ verifikationen i Bokföring.',
        'Öppna Inköp för att prova en leverantörsfaktura med ett uppladdat underlag.',
      ] },
      { id: 'lokala-uppgifter', title: 'Dina uppgifter stannar i webbläsaren', callout: {
        title: 'En provmiljö', text: 'Bokföring och uppladdade filer sparas lokalt. De delas inte automatiskt med revisorn eller en annan enhet. Inga betalningar eller deklarationer skickas. När du frågar Ande skickas frågan och vald demokontext till OpenAI via servern; du kan välja bort kontexten.', tone: 'info',
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
        'Börja med 1 000 nya scenariotester för den senaste rapporten; tidigare testomgångar och PDF:er finns kvar som historik. Läs Systemets omfattning och Kända begränsningar och välj ett avgränsat affärsfall.',
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
    related: ['audit3-1000', 'andra-testomgangen-2026', 'atgarder-2026', 'regelgranskning-2026', 'omfattning', 'verifiering', 'kanda-begransningar', 'bokslut-rapporter'],
  },
  {
    id: 'omfattning', category: 'kom-igang', title: 'Systemets omfattning',
    summary: 'Det här ingår i demomodellen och detta återstår innan ett skarpt bokföringssystem.',
    status: 'limited', updated, tags: ['omfattning', 'mvp', 'funktioner', 'API', 'integration'],
    sections: [
      { id: 'finns', title: 'Det går att prova', bullets: [
        'Kunder, projekt, tid/material, offerter och kundfakturor samt artiklar, kundpriser och återkommande fakturautkast.',
        'Leverantörsfakturor med flera konteringsrader, blandad moms, lokala PDF-/bildunderlag, betalning samt delkrediter och återbetalningar.',
        'Gemensam huvudbok, manuella verifikationer, bankavstämning och rapporter.',
        'Individuella löneunderlag med 2026-tabeller, semesterkonton, bruttolöneåterkrav, inventarier, lager, periodisering, momsrapport, bokslutsbilagor och nästa räkenskapsår.',
        'SIE 4-huvudbok, EUR/USD-fakturor, en separat kontantmetodsarbetsyta och granskade exportfiler för AGI, moms, INK2/SRU samt ett avgränsat K2-årsredovisningsdokument.',
      ] },
      { id: 'ramar', title: 'Gemensamma ramar', table: {
        headers: ['Område', 'Den dokumenterade versionen'],
        rows: [
          ['År och valuta', 'Startår 2026, fortsatt bokföring efter årsavslut och SEK som redovisningsvaluta. Separata EUR/USD-fakturor finns. ROT, lönetabeller och deklarationsformat har egna årsgränser.'],
          ['Metod', 'Startbolaget använder faktureringsmetoden. Kontantmetoden kräver ett nytt tomt övningsbolag och använder ett separat fakturaflöde.'],
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
        'Spara utkastet. Komplettera parter, relevanta momsnummer och bolagsuppgifter. Bekräfta utförandedatum eller period och eventuell grund för momsfri försäljning innan fakturan utfärdas och bokförs.',
        'Registrera betalning och följ kvarvarande fordran. Skriv vid behov ut eller spara dokumentet som PDF via webbläsaren.',
      ] },
      { id: 'berakning', title: 'Uppgifter som påverkar beräkningen', bullets: [
        'Radrabatt följs av fakturarabatt. Frakt och fakturaavgift undantas från fakturarabatten.',
        'Pris inklusive eller exklusive moms används som beräkningsgrund. Beloppen hanteras i hela ören.',
        'Samma beloppsmodell används i summeringen, dokumentet, kundfordran och betalningsflödet.',
        'Nya utfärdade fakturor behåller sina sparade kund- och säljaruppgifter även om registeruppgifter ändras senare.',
      ] },
      { id: 'avgransning', title: 'Avgränsning', paragraphs: [
        'Artiklar, kundspecifika priser och återkommande fakturautkast finns i Artiklar & avtal. Valutafakturor och kontantmetod har egna arbetsytor med uttryckliga gränser. E-faktura och verkliga utskick återstår.',
        'En utfärdad faktura redigeras inte i det vanliga formuläret. Delkrediter och krediter efter betalning bevarar originalet. ROT- och intäktsperiodiserade fakturor har särskild förhandsgranskning och sammanhängande rättelseflöden i kreditvyn.',
      ] },
    ],
    sources: [source('Faktureringens funktioner och luckor', 'bokforing/fakturering-jamforelse.md'), source('Fakturans modell', 'public/bokforing/suite/sales.js'), source('Pris- och ROT-beräkning', 'public/bokforing/suite/rot.js')],
    related: ['rot-2026', 'krediter-aterbetalningar', 'artiklar-avtal', 'kontering'],
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
      { id: 'avgransning', title: 'Omfattning och avgränsning', bullets: [
        'Flera konteringsrader med eget kostnadskonto, momssats och avdragsandel finns. Vanlig moms, ingen moms och omvänd byggmoms kan blandas. Vald avdragsrätt och eventuell omvänd moms måste bedömas av användaren.',
        'OCR/betalningsreferens, bankgiro, plusgiro och IBAN är sparade uppgifter; de verifierar inte mottagaren och utlöser ingen banköverföring.',
        'Ingen automatisk fakturatolkning, e-postmottagning eller fleranvändarattest är ansluten.',
      ] },
    ],
    sources: [source('Leverantörsflödet och kommande arbetsytor', 'bokforing/leverantorsfakturor-och-arbetsytor.md'), source('Inköp och betalningar', 'public/bokforing/suite/operations.js'), source('Dokumentuppgifter och kompletteringar', 'public/bokforing/suite/purchase-data.js')],
    related: ['underlagsinkorg', 'kontering', 'krediter-aterbetalningar'],
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
        'Kundfakturor kan del- eller helkrediteras per ursprungsrad, även efter betalning, i Krediter & återbetalningar. Ursprunglig faktura och verifikation bevaras.',
        'Leverantörsfakturor kan krediteras per ursprungsrad med samma moms och avdragsandel. Ett återbetalningsbart saldo kan regleras eller kvittas mot samma motpart.',
        'Manuella rättelser använder en länk till den ursprungliga verifikationen.',
        'En bokförd leverantörsfaktura kan få kompletterande underlag utan ändring av det ursprungliga dokumentet eller dess skuld.',
        'Utbetald lön kan rättas genom ett granskat bruttolöneåterkrav med egen fordran och registrerade återbetalningar. ROT och periodiserade intäkter har särskild kreditgranskning.',
      ] },
      { id: 'granser', title: 'Gränser för skyddet', paragraphs: [
        'ROT-krediter kräver granskning av det externa ärendet och faktisk skatteåterbetalning när sådan behövs. Flerpersons-ROT kan inte automatiskt få en ny begäran efter kredit. Allmän lönekvittning, förmånsrättelser och samtliga automatiska bokslutsomklassificeringar ingår inte.',
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
        'Det äldre ROT-flödet finns kvar. Den utökade arbetsytan kan fördela en redan utfärdad fakturas frysta ROT-belopp på 1–10 personer och förbereda proportionella delbegäranden efter elektroniska kundbetalningar under 2026.',
        'Demobeslut och skatteutbetalning registreras separat. Ett avslag lämnar motsvarande belopp som kundfordran.',
        'Programmet verifierar inte identitet, F-skatt, ägande, arbetets art, betalningsbevis eller faktiskt skatteutrymme. Begärans metadata kan dateras till 31 januari 2027 för betalningar 2026; kundbetalningar under 2027, RUT och fullständiga årsskiftesfall återstår. Ingen begäran skickas till Skatteverket.',
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
    summary: 'Svensk moms, valda internationella affärsfall och en ruta-för-ruta-rapport som stäms av mot huvudboken.',
    status: 'limited', updated, tags: ['moms', 'omvänd byggmoms', 'momsperiod', 'deklaration'],
    sections: [
      { id: 'affarsfall', title: 'Stödda affärsfall', paragraphs: [
        'Kundfakturor stöder svensk moms och avgränsad omvänd byggmoms. Leverantörsfakturor kan ha blandade momsrader och avdragsandel. Moms & ROT har dessutom separata, redan betalda SEK-händelser för valda EU-, export- och importmomsfall.',
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
        'Särregler såsom vinstmarginalbeskattning, uttag, vissa hyresfall och trepartshandel är inte automatiskt klassificerade. Rapporten visar begränsningar och oklassificerade poster. Granskad moms-XML finns i Deklarationer; VIES-kontroll, periodisk sammanställning och myndighetsinlämning ingår inte.',
      ] },
    ],
    sources: [source('Momsrapport och klassificering', 'public/bokforing/suite/tax-ledger.js'), source('Moms och ROT: avgränsning', 'bokforing/moms-och-rot-utbyggnad.md'), source('Kontroller vid återläsning', 'public/bokforing/suite/validate.js')],
    related: ['individuell-lon', 'kontering', 'bokslut-rapporter', 'kanda-begransningar'],
  },
  {
    id: 'lon', category: 'arbetsfloden', title: 'Lön och arbetsgivardeklarationsunderlag',
    summary: 'Individuella löneunderlag, officiella skattetabeller inom angivna gränser och spårbara lönerättelser.',
    status: 'limited', updated, tags: ['lön', 'lönebesked', 'anställd', 'AGI', 'skatt', 'semester'],
    sections: [
      { id: 'arbetsgang', title: 'Arbetsgång', steps: [
        'Lägg upp en anställd och en individuell löneprofil med födelseår, arbetstid och skattetabell/kolumn enligt skatteunderlaget eller ett dokumenterat skattebeslut.',
        'Skapa löneutkast, granska lönebesked och kontrollera lön, avdrag, semester, förmåner och utlägg.',
        'Bokför lönekörningen och registrera demoutbetalning och reglering av skatt/avgifter.',
        'Granska semesterkonto eller bruttolöneåterkrav när det behövs. Skapa AGI XML i Deklarationer efter kontroll av personuppgifter, specifikationsnummer och rättelser.',
      ] },
      { id: 'bedomning', title: 'Manuella antaganden', paragraphs: [
        'Den nya lönearbetsytan använder officiella månadstabeller 29–42, kolumn 1 och 3 för 2026, upp till 80 000 kr. Arbetsgivaravgifter beräknas för stödda födelseårs- och betalningsdatumfall. Äldre manuella lönekörningar bevaras.',
        'Frånvaro, semester, förmåner och utlägg granskas individuellt. Semesterintjäning, uttag och slutlig ersättning finns för uttryckligt valda regler. Bruttolöneåterkrav efter utbetalning skapar en separat fordran; kollektivavtal, pensions-/försäkringsregler och allmän nettokvittning ingår inte.',
      ] },
      { id: 'export', title: 'Exportens status', callout: {
        title: 'Fil och inlämning är skilda steg', text: 'Löne-CSV är granskningsunderlag. Deklarationsarbetsytan kan skapa en AGI XML-fil för stödda 2026-fall, men ingen fil skickas eller godkänns av Skatteverket härifrån.', tone: 'info',
      } },
    ],
    sources: [source('Individuell löneberäkning', 'public/bokforing/suite/payroll-engine.js'), source('Löneregler och avgränsning', 'bokforing/lon-regler-och-avgransning.md')],
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
        'Artiklar & avtal kan göra ett lageruttag och skapa en kopplad materialrad i projektet i samma åtgärd. Kostnadspriset och försäljningspriset hålls isär; bokförd lagerkostnad följer den periodiska lagervärderingen.',
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
        'Intäktsperiodisering finns nu för utfärdade, okrediterade kundfakturor utan ROT, separat från förutbetalda kostnader. Pågående arbeten har en bedömningsbilaga men ingen automatisk värderingsbokning. Produktion och fler lagerslag återstår.',
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
        'När villkoren är uppfyllda bokförs årets resultat. Nästa räkenskapsår kan öppnas med bevarad historik, obetalda fakturor, tillgångar, lager och periodiseringsplaner.',
      ] },
      { id: 'dokumentens-status', title: 'Vad exporten inte är', paragraphs: [
        'Granskningspaket och nästa års balansunderlag är arbetsmaterial. De är inte en färdig årsredovisning, inkomstdeklaration eller revisionsberättelse.',
        'Bokslutsbilagor, jämförelsetal och nästa år finns. Deklarationsarbetsytan kan skapa INK2/INK2R/INK2S i SRU och ett utskrivbart årsredovisningsdokument för en avgränsad K2-tillämpning. Granskning av skattejusteringar och noter, underskrifter, fastställelseintyg och myndighetsinlämning återstår hos användaren.',
      ] },
    ],
    sources: [source('Rapporter, periodlås och årsavslut', 'public/bokforing/suite/finance.js'), source('Export av granskningspaket', 'public/bokforing/suite/app.js'), source('Bokslutets kontroller', 'server/bokforing-suite-finance.test.mjs')],
    related: ['for-revisorn', 'moms', 'kontering'],
  },
  {
    id: 'verifiering', category: 'granskning', title: 'Verifiering: vad har testats?',
    summary: 'Historiska testresultat, de nya funktionernas provfiler och vad verifieringen kan visa.',
    status: 'guide', updated, tags: ['tester', 'bevis', 'testresultat', 'kvalitet', '320', '75', 'version'],
    sections: [
      { id: 'byra-resultat', title: 'Aktuell byråutbyggnad', paragraphs: [
        'Version 08d544c: 3 511 modell-/lagrings-/AI-fall och 1 HTTP-test, totalt 3 512 godkända. 61 nya fall avser byråinbjudan, rollkontroller och separata bolagsböcker.',
        '128 unika webbläsarfall är godkända efter omprov, varav nio nya för byråflödet. Den breda körningen gav först 127 godkända och ett äldre prov som läste lagringen innan sparandet hade avslutats. Provet väntar nu på bekräftat sparande; båda berörda regressionsfallen har körts om med godkänt resultat. Bokföringskontrollen behövde inte ändras.',
        'Bokföringens tidigare granskningsrapporter ligger kvar oförändrade. Det här är kontroller av en lokal demo, inte verifierad serverautentisering eller ett myndighetsgodkännande.',
      ] },
      { id: 'audit3-resultat', title: 'Tidigare testomgång: 1 000 nya kombinationsfall', paragraphs: [
        'Version cc4a2a2: 3 450 modell-/lagrings-/AI-fall och 1 HTTP-test, totalt 3 451 godkända. 1 000 nya kombinationsfall är fördelade över fem områden. Inga underkända eller överhoppade i slutkörningen.',
        '15 riktade webbläsarfall är godkända: nio arbetsflödesfall (två nya) och sex omkörda wiki-fall. Det är en avgränsad omkörning; tidigare bredare resultat finns kvar nedan.',
        'Ett nytt funktionsfel hittades och rättades: ren förmån utan kontantlön kunde inte registreras när ingen verifikation behövdes. Se den korta rapporten för metod, fynd och begränsningar.',
      ] },
      { id: 'omtest2-resultat', title: 'Tidigare omtest: version 0b66b07', paragraphs: [
        'Version 0b66b07: 2 450 modell-/lagrings-/AI-fall och 1 HTTP-test, totalt 2 451 godkända. 66 nya fall ingår. Ingen underkänd eller överhoppad kontroll i slutkörningen.',
        '14 riktade webbläsarfall ingår i denna verifiering: åtta för arbetsflöden (två nya) samt sex omkörda wiki-fall. Detta ersätter inte de tidigare bredare browserkörningarna; deras resultat behålls nedan som historik.',
        'Två funktionsfel hittades och rättades: lönebetalning efter slutlig årsbedömning och momsfri återföring efter fastställd momsperiod.',
      ] },
      { id: 'atgarder-resultat', title: 'Första åtgärdsomgången: version ee235b3', paragraphs: [
        'Version ee235b3: 2 384 modell-/lagrings-/AI-fall och 1 HTTP-test, totalt 2 385 godkända. 132 nya fall avser åtgärderna efter den första granskningen.',
        '115 webbläsarfall är godkända. Bokföringskod och testfiler är versionsbundna; wikin och åtgärdsrapporten publiceras därefter och har egna slutprov.',
        'Fakturornas fältkrav, explicit momsundantag och den årliga avgiftsgränsen är implementerade inom dokumenterad omfattning. Rapporten beskriver kvarvarande drift- och specialfallsbegränsningar.',
      ] },
      { id: 'audit-resultat', title: 'Tidigare granskning: version 1520d83', paragraphs: [
        'Version 1520d83: 1 798 nya auditfall och 455 tidigare tester, totalt 2 253 godkända. Av dessa är 2 252 modell-/lagrings-/AI-fall och 1 HTTP-test. Inga underkända eller överhoppade i den körningen.',
        '41 berörda affärsfall och 6 wiki-fall har körts i webbläsaren, totalt 47 godkända. Produktionsbygge och typkontroll är godkända. Det är en riktad browserkörning; de 107 äldre fallen nedan är historiska.',
        '13 fynd har fått rättningar eller skyddsspärrar. PDF-rapporten redovisar varje fynd, lagstöd, test-ID och återstående luckor. Full regelefterlevnad är inte styrkt.',
      ] },
      { id: 'resultat', title: 'Historiskt resultat: version c5134ec', table: {
        headers: ['Kontroll', 'Resultat i den tidigare versionen'],
        rows: [
          ['Produktionsbygge', 'Godkänt lokalt.'],
          ['Modell- och lagringstester', '320 godkända.'],
          ['HTTP-integrationstest', '1 godkänt.'],
          ['Browserfall mot den byggda servern', '75 godkända.'],
          ['Manuella visuella prov', 'Skrivbords- och mobilvyer; inga noterade JavaScript-fel eller horisontellt sidöverflöde i genomförda prov.'],
        ],
      } },
      { id: 'nya-prov', title: 'Historiska prov: version b512afc', paragraphs: [
        'Version b512afc: godkänt produktionsbygge och typkontroll, 454 modell-, lagrings- och AI-kontroller, 1 separat HTTP-test och 107 unika webbläsarfall efter grundkörning och omprov.',
        'SIE, valutafakturor, kontantmetoden, semesterkonton, löneåterkrav, ROT-krediter och deklarationsexport har egna modell- och webbläsarprov. Slutrapporten beskriver grundkörningen, rättningar och omprov; testantalen avser denna kodversion.',
        'AGI-prov använder även Skatteverkets XSD. En SIE-fil från den fiktiva demoboken har kontrollerats i SIE-gruppens publika testtjänst utan syntax- eller radfel. Det visar hur de testade filerna är uppbyggda; det är ingen myndighetsinlämning eller certifiering.',
      ] },
      { id: 'exempel', title: 'Exempel på testade fel', bullets: [
        'Felaktiga belopp, överbetalning, dubbla källbokningar och bokning i låst period.',
        'Gammal flik, misslyckad skrivning, återläsning och explicit demo-reset.',
        'Fel filtyp, för stor import, kvotfel, ändrade originalbytes och saknad fil.',
        'Bilagekoppling som slutförs efter sidbyte eller reset ska inte hamna på fel utkast eller återinföra gamla ändringar.',
        'Frysta fakturauppgifter, ROT, bankmatchning, lön, lager och periodisering.',
      ] },
      { id: 'bevisets-grans', title: 'Så ska resultatet läsas', paragraphs: [
        'De historiska antalen ovan avser den lokalt verifierade versionen c5134ec, inte en löpande mätning av den senast publicerade appen. Den historiska rapportlänken är låst till den versionen. Nya provfiler länkas till den senaste dokumenterade etappen.',
        'Kameraprovet använder filinput med kameraattribut; fysisk telefonkamera har inte provats. Tester av de stödda fallen är inte en redovisningscertifiering eller en kontroll av varje tänkbart affärsfall.',
      ] },
    ],
    sources: [{ label: 'Aktuell granskningsrapport (PDF)', url: '/bokforing/granskning/granskningsrapport-2026-10-23.pdf' }, source('Historisk slutrapport för b512afc', 'bokforing/granskning/2026-10-23-funktionskomplettering.md'), historicalSource('Historisk verifiering och omprov för c5134ec', 'bokforing/granskning/2026-10-23-utbyggnad.md'), source('Aktuell omfattning', 'bokforing/README.md'), source('SIE-prov', 'server/bokforing-sie.test.mjs'), source('Semester och löneåterkrav', 'server/bokforing-payroll-completion.test.mjs'), source('Löneåterkrav till AGI med XSD-kontroll', 'server/bokforing-declaration-payroll-integration.test.mjs'), source('Kontroll vid återläsning', 'server/bokforing-suite-validation.test.mjs')],
    related: ['audit3-1000', 'andra-testomgangen-2026', 'atgarder-2026', 'regelgranskning-2026', 'for-revisorn', 'kanda-begransningar', 'andringar'],
  },
  {
    id: 'kanda-begransningar', category: 'granskning', title: 'Kända begränsningar och kvarstående arbete',
    summary: 'En samlad lista över sådant som demon inte täcker eller inte kan avgöra.',
    status: 'planned', updated, tags: ['begränsningar', 'luckor', 'planerat', 'regelefterlevnad', 'säkerhet', 'server', 'API'],
    sections: [
      { id: 'produktion', title: 'Inför en skarp produkt', bullets: [
        'Förskottsfakturering och fakturering före framtida prestation behöver separat stöd för korrekt kontering.',
        'Fler momsundantag, internationella specialfall och rättelseflöde för äldre oklassade underlag kräver fortsatt granskning.',
        'Delad serverlagring, bolagsavgränsning, användarbehörigheter och identifierade gransknings-/attestroller.',
        'Hållbart dokumentarkiv, säkerhetskopiering och provad återläsning.',
        'Produktions-API och externa anslutningar för bank, e-post, fakturautskick och myndighetsinlämning. SIE-huvudbok och funktionella deklarationsexporter finns i demon.',
        'Fortsatt systemdokumentation, granskade redovisningsfall och extern bedömning av systemet.',
      ] },
      { id: 'affarsfall', title: 'Fler affärsfall', bullets: [
        'Nya automatiska begäranden efter flerpersons-ROT-kredit, allmän lönekvittning, förmånsrättelser och mer avancerad bankbetalningsfördelning.',
        'Valutabankkonton, fler valutor än EUR/USD, kombinationer av kontantmetod och internationella/ROT-affärer samt återstående momssärregler. Verklig avdragsrätt, motpart och underlag behöver granskas.',
        'Automatiska utskick och serverstyrd schemaläggning av återkommande fakturor, indexering, dröjsmålsränta och inkassoflöden.',
        'RUT, kundbetalningar under andra ROT-regelår och fullständig hantering av beslut som ändras efter utbetalning.',
        'Återstående lönefall och avtalsregler, bokförd värdering av pågående arbeten, K3 och särskilda K2-/deklarationsbilagor. Digital underskrift, fastställelseintyg, myndighetsinlämning och kvittenser skapas inte automatiskt.',
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
          ['Utbyggda ekonomiflöden', 'Fler inköpsrader, delkrediter/återbetalningar, individuella löner, utökad moms/ROT, artikel-/avtalsflöden och fortsatt bokföring nästa år.'],
          ['1 000 nya scenariotester', 'Fem testmatriser, oberoende facit och rättat förmånsflöde utan tom verifikation.'],
          ['Andra testomgången', '66 nya automatiska fall och två rättningar av löne-/momsspärrar.'],
          ['Fakturakrav, moms och årsgräns', 'Obligatoriska fakturauppgifter, explicit momsundantag, lönens årsgräns och uppföljande testprotokoll.'],
          ['Teknisk regelgranskning', '1 798 nya auditfall, 13 fynd med åtgärder och PDF-rapport för extern redovisningsgranskning.'],
          ['Bokföringsfunktioner och filutbyte', 'SIE 4, EUR/USD-fakturor, kontantmetod, semesterkonton, löneåterkrav, ROT-/periodiseringskrediter samt AGI-, moms- och INK2/SRU-export.'],
        ],
      } },
      { id: 'den-har-wikin', title: 'Den här wikins version', paragraphs: [
        `Funktionsbeskrivningarna omfattar regelgranskningen den 23 oktober 2026. Kod och testbevis är bundna till version ${revision.slice(0, 7)}. Äldre resultat för c5134ec och b512afc är separat märkta som historiska.`,
        'En GitHub-push och en färdig publicering är olika händelser. Faktisk driftversion behöver kontrolleras mot den tjänst som serverar appen.',
      ] },
      { id: 'nasta-prioriteringar', title: 'Prioriterad fortsättning', bullets: [
        'Verifikationssida med direkt väg till originalunderlag och rättelser.',
        'Fördjupad projekt-/offertarbetsyta och återstående individuella löne-/semesterfall.',
        'Tydligare bankavstämning och navigering från rapporter till underlag.',
        'Riktig e-postmottagning, granskad fakturatolkning och bolagsavgränsad serverlagring.',
      ] },
    ],
    sources: [source('Projektets ändringslista', 'docs/Andringslistan.txt'), source('Prioriterade nästa arbetsytor', 'bokforing/leverantorsfakturor-och-arbetsytor.md')],
    related: ['verifiering', 'kanda-begransningar', 'omfattning'],
  },
  {
    id: 'ande', category: 'utveckling', title: 'Ande: AI-stöd direkt i bokföringsdemon',
    summary: 'OpenAI-ansluten assistent med begränsad demokontext, källhänvisningar och förslag att granska.',
    status: 'limited', updated, tags: ['Ande', 'AI', 'assistent', 'förklaring', 'redovisning'],
    sections: [
      { id: 'nuvarande-funktion', title: 'Det Ande gör nu', paragraphs: [
        'Öppna Fråga Ande. Du behöver inte logga in. När serverns OpenAI-nyckel är konfigurerad skickas frågan till modellen. Anslutningsstatusen skiljer konfiguration från ett faktiskt mottaget AI-svar; vid fel visas ett felmeddelande, inte ett förskrivet ersättningssvar.',
        'Om modellen når svarslängdsgränsen, inte hinner svara eller lämnar ett ofullständigt svar visas orsaken i chatten. Frågan behålls i skrivfältet för ett nytt försök. Ett ofärdigt AI-svar behandlas inte som ett färdigt bokföringsförslag.',
        'Ande får en avgränsad bild av aktuell demovy: rapportsummor, antal öppna poster och i relevanta vyer vald faktura eller verifikation med högst tolv rader. Den får inte automatiskt hela bokföringen, uppladdade original eller andra företags uppgifter. Osparade formulärändringar ingår inte.',
        'Underlag till Ande visar vilka fält som skickas och låter dig välja bort dem. Dina egna frågor och radtexter kan också innehålla information, så använd fiktiva uppgifter. Samtalet finns i flikens minne och kan tömmas med Nytt samtal.',
        'Svar kan innehålla förslag och hänvisningar till ett daterat kunskapspaket. Bara serverns tillåtna källor blir klickbara hänvisningar. En källhänvisning bevisar inte att modellens tolkning är riktig.',
        'Svaren ändrar inte bokföringen. Bokning, betalning och andra ändringar görs i de vanliga granskade arbetsflödena.',
      ] },
      { id: 'teknik', title: 'Åtkomst och kostnad', paragraphs: [
        'API-nyckeln ligger på servern som BOKFORING_OPENAI_API_KEY och skickas inte till webbläsaren. Den publika demon använder en separat tillfällig demosession med cookie och skydd mot anrop från andra webbplatser.',
        'Det finns ingen total kredit- eller dygnsgräns i denna testversion. Korta anropsgränser och ett begränsat antal samtidiga anrop skyddar mot spam; varje modellfråga kan kosta pengar för tjänstens ägare.',
        'Servern sparar användningsmetadata, inte chattens fullständiga text. Modellanropet använder store:false, vilket inte i sig garanterar noll lagring hos leverantören.',
      ] },
      { id: 'begransning', title: 'Det Ande inte är', paragraphs: [
        'Ande är inte auktoriserad revisor eller redovisningskonsult och utför ingen oberoende revision. Modellen kan dra fel slutsatser även när beloppen och källorna är riktiga.',
        'Kunskapspaketet beskriver avgränsade 2026-fall och demofunktioner. Aktuella myndighetssidor hämtas inte vid varje fråga. Dokumenttolkning, fullständig regelbevakning, långsiktigt företagsminne och strukturerade bokföringsförslag med acceptflöde återstår.',
      ] },
    ],
    sources: [andeSource('Anslutning, test och avgränsningar', 'bokforing/ande-openai-test.md'), andeSource('Serveråtkomst och anropsgränser', 'server/bokforing-ande.mjs'), andeSource('OpenAI-anrop och instruktioner', 'server/bokforing-ande-provider.mjs'), andeSource('Daterat kunskapspaket', 'server/bokforing-ande-knowledge.mjs'), andeSource('Kontext och samtalsvy', 'public/bokforing/suite/ande-client.js')],
    related: ['ande-saas', 'for-revisorn', 'kontering', 'kanda-begransningar'],
  },
  {
    id: 'krediter-aterbetalningar', category: 'arbetsfloden', title: 'Delkrediter, återbetalningar och kvittning',
    summary: 'Rätta hela eller delar av en faktura, även efter betalning, med bevarat original och korrekt kvarvarande saldo.',
    status: 'limited', updated, tags: ['kredit', 'delkredit', 'återbetalning', 'kvittning', 'betald faktura', 'reskontra'],
    sections: [
      { id: 'arbetsgang', title: 'Arbetsgång', steps: [
        'Öppna Krediter & återbetalningar och välj en utfärdad kundfaktura eller bokförd leverantörsfaktura.',
        'Ange kreditbelopp per ursprungsrad, datum, referens och orsak. Granska hur den valda raden påverkar moms och konto.',
        'Bokför kreditnotan. Originalets uppgifter och verifikation bevaras; krediten får eget nummer och egen verifikation.',
        'Om krediten ger ett belopp att återbetala, registrera en återbetalning eller kvitta mot en annan obetald faktura till samma motpart.',
      ] },
      { id: 'kontroller', title: 'Belopps- och sambandskontroller', bullets: [
        'Sammanlagda delkrediter får inte överstiga ursprungsradens nettobelopp. Momsen fördelas kumulativt så att full kreditering återför exakt originalets ören.',
        'Blandade leverantörsrader behåller sina konton, momssatser och avdragsandelar i kreditens beräkning.',
        'Återbetalning får inte överstiga återbetalningsbart saldo. Bankkonto, datum, belopp och riktning kontrolleras när en befintlig bankhändelse används.',
        'Kvittning kräver samma motpart och får inte överstiga motfakturans återstående belopp. Datum, låsta perioder och dubbla referenser kontrolleras.',
      ] },
      { id: 'granser', title: 'Viktiga avgränsningar', paragraphs: [
        'ROT-fakturor och intäktsperiodiserade fakturor har särskild kreditförhandsgranskning. ROT kräver bekräftad extern ärendehantering och eventuell faktisk skatteåterbetalning. Intäktskrediter fördelas över den ursprungliga avtalstiden; redan redovisad intäkt rättas separat från kvarvarande belopp på 2990.',
        'En leverantörskredit stoppas om den tar bort kostnaden som bär en inventarie, lagervärdering eller periodisering. Dessa samband måste först rättas genom ett granskat flöde.',
        'En återbetalning registreras bara i demoboken; ingen banköverföring skickas. Vid bokslut behöver eventuella kreditbalanser i kund- och leverantörsreskontra bedömas och vid behov klassificeras om.',
      ] },
    ],
    sources: [source('Krediter och reglering', 'public/bokforing/suite/settlements.js'), source('ROT- och periodiseringskrediter', 'docs/bokforing/rot-credit-completion.md'), source('Krediternas modellprov', 'server/bokforing-settlements.test.mjs'), source('Utökade kreditprov', 'server/bokforing-rot-credit-completion.test.mjs')],
    related: ['rattelser', 'kundfakturor', 'leverantorsfakturor', 'bokslut-rapporter'],
  },
  {
    id: 'individuell-lon', category: 'arbetsfloden', title: 'Individuell lön, skattetabeller och rättelser',
    summary: 'Den nya lönearbetsytan har personliga underlag och avgränsat stöd för officiella svenska tabeller 2026.',
    status: 'limited', updated, tags: ['lön', 'skattetabell', '2026', 'semester', 'sjuklön', 'karens', 'förmåner', 'rättelse'],
    sections: [
      { id: 'profil-och-tabell', title: 'Löneprofil och skatteunderlag', paragraphs: [
        'Varje anställd får en profil med bland annat födelseår, arbetstid och skatteunderlag. Tabell och kolumn väljs från A-skattsedeln; systemet hämtar inte den personens beslut från Skatteverket.',
        'Officiella månadstabeller 29–42, kolumn 1 och 3 för 2026 är inlästa för inkomster till och med 80 000 kr per månad. Källdata har versionsuppgift och kontrollsumma. Andra år eller tabellfall kräver ett separat granskat skatteunderlag.',
        'Arbetsgivaravgifter beräknas för modellens stödda födelseårs- och betalningsdatumfall 2026, inklusive det avgränsade ungdomsfallet från april. Tidigare utbetalningar i samma månad räknas med där månadstaket kräver det.',
      ] },
      { id: 'personligt-underlag', title: 'Individuellt underlag och granskning', bullets: [
        'Månads- eller timlön, frånvaro, sjuklön och karens registreras per person. Arbetsschema och uppgifter om sjukperioden behöver granskas.',
        'Semesterkonton beräknar intjänade dagar från anställningstid och granskad frånvaro. Procentregeln räknar ett granskat löneunderlag; sammalöneregeln använder månadslön och tillägg. Uttag och slutlig ersättning minskar kontots saldo.',
        'Skattepliktiga förmåner och skattefria utlägg hålls isär i beräkning och lönebesked.',
        'Varje lönebesked granskas innan lönekörningen bokförs. Utbetalning och reglering av skatt/avgifter är separata demohändelser.',
      ] },
      { id: 'rattelser', title: 'Rättelser och gränser', paragraphs: [
        'En bokförd men ännu inte utbetald lönekörning kan återföras med länk till originalet. Positiva kompletteringar finns för tidigare bokförd eller betald lön.',
        'Utbetald lön kan rättas genom ett granskat bruttolöneåterkrav. Originalet bevaras; 1680 visar fordran, delbetalningar matchar fordran och eventuell faktisk avgiftskreditering registreras på skattekontot. Innehållen skatt ändras inte.',
        'Återkravet korrigerar AGI-underlaget i ursprunglig utbetalningsmånad. Årsgränsens följdändringar granskas i en separat avgiftsavstämning. Villkoren för det verkliga återkravet behöver bedömas; ett bokfört krav är inte en myndighetskvittens.',
        'Kollektivavtal, pensions-/försäkringsmotor, automatisk semesterlöneskuld, allmän nettokvittning och alla förmånsrättelser ingår inte. Skatte- och avgiftsreglerna gäller uttryckligen 2026. Deklarationsarbetsytan skapar AGI XML för de stödda fallen utan att skicka den.',
      ] },
    ],
    sources: [source('Årsgränsen 1 000 kr och AGI', 'bokforing/lon-arsgrans-2026.md'), source('Semester, löneåterkrav och gränser', 'bokforing/lon-komplettering.md'), source('Löneregler och grundomfattning', 'bokforing/lon-regler-och-avgransning.md'), source('Lönemotor', 'public/bokforing/suite/payroll-engine.js'), source('Semester- och återkravsprov', 'server/bokforing-payroll-completion.test.mjs')],
    related: ['lon', 'deklarationer', 'kontering', 'nytt-rakenskapsar', 'kanda-begransningar'],
  },
  {
    id: 'moms-utland', category: 'regler', title: 'Momsrutor, avdragsandel och utlandsaffärer',
    summary: 'Valda betalda SEK-affärer kan klassificeras och följas till momsrapportens rutor och huvudboken.',
    status: 'limited', updated, tags: ['moms', 'EU', 'import', 'export', 'avdragsrätt', 'momsdeklaration', 'ruta'],
    sections: [
      { id: 'stodda-fall', title: 'Affärsfall som finns', paragraphs: [
        'Utöver kund- och leverantörsfakturorna finns separata redan betalda händelser för svenska inköp/försäljningar, vissa svenska omvända momsfall, varuinköp från EU, tjänsteinköp enligt huvudregeln från EU eller tredje land samt valda EU-/exportförsäljningar.',
        'Importmoms kan bokföras från tullunderlag. Det är en separat momsberäkning som inte bokför själva varuinköpet en andra gång.',
        'Land, VAT-nummer när det behövs, underlagsreferens och avdragsandel anges uttryckligt. Användaren bekräftar att det valda fallet motsvarar den verkliga affären.',
      ] },
      { id: 'rapport', title: 'Rapport och avstämning', bullets: [
        'Rapporten hämtar stödda fakturor, blandade leverantörsrader, delkrediter och särskilt klassificerade momshändelser.',
        'Alla 28 visade momsrutor har beskrivning. Beloppen kan följas till underlag och jämföras med momskontona i huvudboken.',
        'Ruta 42 stöder valda svenska momsundantag med uttrycklig bedömning. Rutor 06, 07, 08, 37 och 38 samt andra undantag är inte fullt klassificerade. Oklassificerade momsverifikationer och differenser visas som granskningspunkter och stoppar fastställande och export.',
        'Ett granskningsunderlag kan exporteras som CSV. Fastställande och reglering i demon är skilda steg.',
      ] },
      { id: 'granser', title: 'Avgränsning', paragraphs: [
        'De särskilda utlandstransaktionerna avser redan betalda SEK-belopp. Valutafakturor och kontantmetoden finns i egna arbetsytor; de ger inte automatiskt stöd för samtliga kombinationer med internationella momsfall.',
        'Ingen kontroll av VAT-nummer mot VIES, återbetalning av utländsk moms, periodisk sammanställning eller myndighetsinlämning är ansluten. Avdragsandelen är ett granskat användarval, inte en automatisk rättslig bedömning.',
      ] },
    ],
    sources: [source('Momsklassificering och rapport', 'public/bokforing/suite/tax-ledger.js'), source('Avgränsning för moms och ROT', 'bokforing/moms-och-rot-utbyggnad.md'), source('Moms-/ROT-prov', 'server/bokforing-tax-rot-extended.test.mjs')],
    related: ['moms', 'leverantorsfakturor', 'krediter-aterbetalningar', 'kontering'],
  },
  {
    id: 'rot-delbegaran', category: 'regler', title: 'ROT för flera personer och delbetalningar',
    summary: 'Fördela ett befintligt ROT-belopp, skapa proportionella delbegäranden och följ beslut, utbetalningar och återkrav.',
    status: 'limited', updated, tags: ['ROT', 'delbetalning', 'flera personer', 'återkrav', '2026', 'årsskifte'],
    sections: [
      { id: 'fordelning', title: 'Fördela det frysta fakturabeloppet', paragraphs: [
        'Utgå från en redan utfärdad ROT-faktura och ange 1–10 personer. Fördelningen måste summera till fakturans redan frysta ROT-belopp; originalfakturan skrivs inte om.',
        'Tillgängligt utrymme och villkor bekräftas per person. Andra ROT-belopp för samma person i den lokala demoboken räknas med i kontrollen.',
        'Fler personer höjer inte det äldre fakturaflödets ursprungliga maxbelopp på 50 000 kr. Detta är en avgränsad utbyggnad av en befintlig faktura.',
      ] },
      { id: 'delbegaran', title: 'Delbegäran, beslut och pengar', steps: [
        'Registrera en elektronisk kundbetalning under 2026 och bekräfta utfört arbete.',
        'Förbered en delbegäran. Modellen beräknar det sammanlagda möjliga beloppet utifrån kundens betalningar och drar av det som redan har begärts.',
        'Registrera ett demobeslut per person och följ godkänt eller avslaget belopp.',
        'Registrera skatteutbetalning separat. Ett avslag lämnar fordran på kunden.',
        'Om utbetalt ROT behöver återbetalas, registrera ett dokumenterat återkrav. Bankutbetalningen bokförs och motsvarande kundfordran öppnas igen.',
      ] },
      { id: 'granser', title: 'År och rättelser', paragraphs: [
        'Stödet gäller kundbetalningar under 2026. Begärans metadata kan dateras till 31 januari 2027; det innebär inte stöd för kundbetalningar under 2027 eller alla årsskiftesfall.',
        'ROT-krediter har nu ett eget rättelseflöde: tidigare ärenden bevaras, det tillåtna avdraget minskar och nödvändig skatteåterbetalning registreras. För en person finns korrigerad begäran, beslut och utbetalning. Ny automatisk begäran efter flerpersonskredit är spärrad och kräver personvis avstämning. RUT och andra betalningsår ingår inte. Inga ansökningar skickas till Skatteverket.',
      ] },
    ],
    sources: [source('ROT-planer och delbegäranden', 'public/bokforing/suite/rot-extended.js'), source('ROT-krediternas arbetsgång och gränser', 'docs/bokforing/rot-credit-completion.md'), source('Rättelsemodell efter kredit', 'public/bokforing/suite/rot-credit.js'), source('Verifiering av ROT-krediter', 'server/bokforing-rot-credit-completion.test.mjs')],
    related: ['rot-2026', 'kundfakturor', 'bankavstamning', 'kanda-begransningar'],
  },
  {
    id: 'artiklar-avtal', category: 'arbetsfloden', title: 'Artiklar, kundpriser, avtal och projektmaterial',
    summary: 'Från artikelregister och återkommande utkast till lageruttag och periodisering av fakturerade intäkter.',
    status: 'limited', updated, tags: ['artikelregister', 'prislista', 'kundpris', 'återkommande', 'påminnelse', 'lageruttag', 'intäktsperiodisering'],
    sections: [
      { id: 'artiklar', title: 'Artiklar och återkommande fakturor', paragraphs: [
        'Registrera artiklar med pris, enhet, momssats och aktiv status. Ett kundspecifikt pris kan användas när ett nytt fakturautkast skapas; utkastet får en kopia av artikel- och prisuppgifterna.',
        'Återkommande planer kan generera utkast varje, var tredje, sjätte eller tolfte månad. Samma plan och period skapar inte dubbletter. Datum följer planens ursprungliga dag även när en månad är kortare.',
        'Planen kan pausas. Körningen startas i demon och skickar inga fakturor. Serverstyrda jobb, indexering och faktisk distribution återstår.',
      ] },
      { id: 'projekt-och-intakt', title: 'Projekt, lager och intäkter', bullets: [
        'Ett projektanknutet lageruttag och motsvarande materialrad skapas tillsammans. Kostnadspris och försäljningspris hålls isär.',
        'Lagrets redovisade kostnad bokförs genom den periodiska lagervärderingen. Uttaget skapar inte en extra kostnadsbokning för samma material.',
        'Intäktsperiodisering för en utfärdad, okrediterad faktura utan ROT använder 2990 och en månadsplan med exakt sammanlagd öresfördelning. Planen kan fortsätta över årsskifte.',
        'En senare intäktskredit rättar redan redovisad intäkt och återstående 2990 proportionellt över avtalstiden. Historiska månadsverifikationer bevaras och framtida planbelopp räknas om.',
        'Pågående arbeten har en dokumenterad bedömningsbilaga. Automatisk värderingsbokning eller fullständig successiv vinstavräkning ingår inte.',
      ] },
      { id: 'paminnelse', title: 'Påminnelseförberedelser', paragraphs: [
        'En daterad påminnelse kan förberedas för förfallen kundandel. Planerat ROT från Skatteverket krävs inte av kunden genom detta flöde.',
        'Text och saldo sparas som underlag. Ingen påminnelse skickas, och avgifter, dröjsmålsränta eller inkasso bokförs inte automatiskt.',
      ] },
    ],
    sources: [source('Kommersiella flöden och gränser', 'bokforing/utveckling/kommersiella-floden.md'), source('Artiklar, avtal och periodisering', 'public/bokforing/suite/commercial.js'), source('Prov av kommersiella flöden', 'server/bokforing-commercial.test.mjs')],
    related: ['kundfakturor', 'projekt-offert', 'tillgangar-periodisering', 'nytt-rakenskapsar'],
  },
  {
    id: 'nytt-rakenskapsar', category: 'arbetsfloden', title: 'Bokslutsbilagor, årsarkiv och nästa räkenskapsår',
    summary: 'Avsluta året med spårbara bilagor och fortsätt bokföra med samma reskontra, tillgångar och historik.',
    status: 'limited', updated, tags: ['bokslut', 'räkenskapsår', 'årsbyte', 'årsredovisning', 'INK2', 'bokslutsbilaga', 'arkiv'],
    sections: [
      { id: 'granskning', title: 'Avstämning och bilagor', paragraphs: [
        'Bokslut & räkenskapsår visar avstämningskontroller och bilagor med konto, kommentar, underlagsreferens och versionshistorik.',
        'Granskad i demon kräver olika angivna namn för upprättare och granskare samt underlagsreferens. Namnen är formuläruppgifter; detta är inte identifierad attest eller ett externt revisionsgodkännande.',
        'Om ett granskat kontosaldo ändras behöver bilagan uppdateras och granskas igen innan årsavslut via arbetsytan.',
      ] },
      { id: 'arsbyte', title: 'Vad som händer när nästa år öppnas', bullets: [
        'Nästa år börjar dagen efter föregående års slut. Ett avslutat år och dess verifikationer bevaras.',
        'Ingående balans visas från den bevarade huvudboken. Samma tillgångar och skulder bokförs inte en gång till.',
        'Obetalda fakturor, tillgångar, lager samt fleråriga kostnads- och intäktsplaner fortsätter. Exempelvis kan en decemberfaktura betalas i januari.',
        'Föregående års resultat flyttas från 2099 till 2098 i det nya året. Slutlig resultatdisposition beslutas separat.',
        'Balansrapporter summerar fram till valt slutdatum; resultatkonton och resultatrapport avser den valda perioden.',
      ] },
      { id: 'export', title: 'Exportens gränser', paragraphs: [
        'Årsarkivet innehåller en fryst ögonblicksbild och kan exporteras tillsammans med granskningsunderlag. Senare betalningar skriver inte om den sparade ögonblicksbilden.',
        'Deklarationsarbetsytan skapar INK2/SRU för stödd beskattningsperiod och ett utskrivbart årsredovisningsdokument för ett mindre privat K2-aktiebolag. Användaren måste fylla och granska skattejusteringar, noter, jämförelsetal och resultatdisposition. K3, särskilda bilagor, underskrifter, fastställelseintyg och myndighetsinlämning ingår inte automatiskt.',
        'Kreditbalanser i reskontra kan behöva särskild bokslutsklassificering. Lokal webbläsarlagring är inte ett hållbart serverarkiv.',
      ] },
    ],
    sources: [source('Årsflödet och avgränsningar', 'bokforing/bokslut-och-rakenskapsar.md'), source('Årsöppning och bilagor', 'public/bokforing/suite/financial-years.js'), source('Rapporternas perioder', 'public/bokforing/suite/fiscal-reports.js'), source('Prov av fortsatt bokföring', 'server/bokforing-year-continuation.test.mjs')],
    related: ['bokslut-rapporter', 'lagring-och-reset', 'individuell-lon', 'artiklar-avtal'],
  },
  {
    id: 'sie-import-export', category: 'arbetsfloden', title: 'SIE 4: flytta huvudbok mellan system',
    summary: 'Granska en fil, mappa konton och importera huvudbok med bevarat original. Exportera ett valt år i PC8.',
    status: 'limited', updated, tags: ['SIE', 'import', 'export', 'Fortnox', 'Visma', 'huvudbok', 'CP437', 'PC8'],
    sections: [
      { id: 'arbetsgang', title: 'Importera efter granskning', steps: [
        'Kontrollera företag och räkenskapsår. En fullständig inflyttning kan provas i ett nytt tomt övningsbolag; det ersätter lokal demodata efter bekräftelse.',
        'Öppna SIE, välj fil och kodning. Standard är PC8/IBM CP437; UTF-8 kräver ett uttryckligt importval.',
        'Mappa vid behov okända konton till befintliga konton och granska redovisningsbetydelsen.',
        'Granska företag, år, ingående balans, verifikationer, dubbletter och varningar. Förhandsgranskningen bokför ingenting.',
        'Bekräfta importen. Fel avbryter hela transaktionen; ingen halv import ska bli kvar.',
      ] },
      { id: 'kontroller', title: 'Spårbarhet och filkontroll', paragraphs: [
        'Originaltext, SHA-256, kontomappning och koppling till journalen sparas. Återläsning kontrollerar importerade verifikationer mot det sparade originalet. Identisk fil stoppas; samma bolag/år/källserie/nummer hoppas över när innehållet är identiskt och stoppas om innehållet ändrats.',
        'Importen kontrollerar bland annat balanserade verifikationer, IB och deklarerade UB/RES, datum, ören, konton och periodlås. En redan registrerad ingående balans måste stämma; den bokas inte en gång till.',
        'Exporten använder SIE 4 med PC8/IBM CP437 och CR/LF. En testfil kontrollerades i SIE-gruppens publika testtjänst utan syntax- eller radfel. Det är kontroll av filen, inte SIE-certifiering.',
      ] },
      { id: 'granser', title: 'Vad SIE inte flyttar', paragraphs: [
        'SIE-importen flyttar huvudbok. Den skapar inte reskontrafakturor, bilagor, betalningsuppdrag, anställningskort, inventariekort eller ROT-ärenden. Ett importerat 1510-/2440-saldo behöver kompletterande reskontra för individuell uppföljning.',
        'Okända konton kräver mappning. Objektdimensioner, avvikande transaktionsdatum och KSUMMA stöds inte i denna version. Filen är högst 2 MB med högst 5 000 verifikationer och 1 000 rader per verifikation. Import mot lagerkontot efter registervärdering behöver särskild avstämning och stoppas.',
      ] },
    ],
    sources: [source('SIE-arbetsgång och oberoende kontroll', 'bokforing/sie.md'), source('SIE-parser och export', 'public/bokforing/suite/sie.js'), source('SIE-prov', 'server/bokforing-sie.test.mjs')],
    related: ['omfattning', 'kontering', 'nytt-rakenskapsar', 'lagring-och-reset'],
  },
  {
    id: 'valutafakturor', category: 'arbetsfloden', title: 'Valutafakturor: EUR och USD i en SEK-bok',
    summary: 'Frysta kurser, delbetalningar, kursdifferenser, kreditnotor och balansdagsvärdering.',
    status: 'limited', updated, tags: ['valuta', 'EUR', 'USD', 'kursvinst', 'kursförlust', 'utländsk valuta', 'balansdag'],
    sections: [
      { id: 'arbetsgang', title: 'Från utkast till betalning', steps: [
        'Välj kund- eller leverantörsfaktura i Valutafakturor och ange EUR eller USD.',
        'Ange SEK per valutaenhet, kursdatum och granskad kursreferens. Momstyp bedöms separat; den följer inte av valutan.',
        'Granska och utfärda. Valutabelopp, SEK-värden, kurser och dokumentuppgifter fryses.',
        'Registrera del- eller slutbetalning med faktiskt SEK-belopp och separat bankavgift. Kursdifferensen bokförs på 3960 eller 7960.',
        'Vid balansdagen granskas kursen för kvarvarande monetära poster. Värderingen följer med till nästa år.',
      ] },
      { id: 'krediter', title: 'Krediter och exakta belopp', paragraphs: [
        'Delkredit kan göras per originalrad före eller efter betalning. Moms och intäkt/kostnad återförs med originalets frysta SEK-belopp. När ett nytt tillgodo uppstår krävs granskad kurs för kreditdatumet.',
        'Öresbelopp hanteras som heltal, och kursen som ett reducerat heltalsbråk. Netto och moms omräknas separat per rad. Sista betalningen eller krediten tar resterande ören exakt.',
      ] },
      { id: 'granser', title: 'Stödd kombination', paragraphs: [
        'Faktureringsmetoden och SEK-redovisning krävs. EUR/USD är fakturavalutor; bankkontot är fortfarande i SEK. Svenska momssatser och dokumenterad ingen moms stöds. ROT, omvänd moms och särskilda EU-/exportkombinationer är inte kopplade till denna arbetsyta.',
        'Ingen banköverföring eller kursinhämtning görs. Kreditbalanser i reskontran kan kräva särskild klassificering inför bokslut.',
      ] },
    ],
    sources: [source('Valutafakturornas omfattning', 'bokforing/valutafakturor.md'), source('Valutamotor', 'public/bokforing/suite/fx.js'), source('Valutaprov', 'server/bokforing-fx.test.mjs')],
    related: ['kundfakturor', 'leverantorsfakturor', 'bankavstamning', 'nytt-rakenskapsar', 'moms'],
  },
  {
    id: 'kontantmetoden', category: 'arbetsfloden', title: 'Kontantmetoden: betalning, kredit och årsskifte',
    summary: 'Ett separat flöde där betalning bokför affären och obetalda poster hanteras vid årsslut.',
    status: 'limited', updated, tags: ['kontantmetod', 'bokslutsmetod', 'betalning', 'årsskifte', 'SEK', 'moms'],
    sections: [
      { id: 'starta', title: 'Ett nytt tomt övningsbolag', paragraphs: [
        'Kontantmetoden väljs när ett nytt tomt övningsbolag skapas efter tydliga bekräftelser. Befintliga bokningar konverteras inte genom ett metodbyte. Exportera det du vill behålla innan lokal demodata ersätts.',
        'Användaren bekräftar förutsättningarna för metoden och förväntad årsomsättning inom det stödda fallet, normalt högst tre miljoner kronor. Systemet verifierar inte den verkliga rättsliga rätten att använda metoden.',
      ] },
      { id: 'betalning', title: 'Betalning styr bokföring och moms', paragraphs: [
        'En kund- eller leverantörsfaktura får ett fryst original och unikt nummer vid utfärdande men ingen intäkts-, kostnads-, moms- eller reskontrabokning. Betalningar bokför den betalda andelen av raderna och momsen.',
        'Exempel: av en faktura på 1 250 kr inklusive 250 kr moms ger en betalning på 500 kr en intäkt på 400 kr och moms på 100 kr. Vid årsslut bokas kvarvarande 750 kr som 600 kr intäkt, 150 kr moms och 750 kr kundfordran. Nästa års betalning reglerar fordran utan ny moms.',
        'Hel- och delkrediter får egna dokument och återbetalningar får egna bankhändelser. Kvarvarande kundtillgodo klassificeras på 2490 och leverantörstillgodo på 1680 vid årsslut.',
      ] },
      { id: 'granser', title: 'Avgränsning', paragraphs: [
        'Svenska SEK-affärer med 0, 6, 12 eller 25 procent moms och granskad avdragsandel stöds. ROT, omvänd moms, internationella affärer, valuta, förskott och kvittning mellan fakturor ingår inte i detta flöde.',
        'Krediter proportioneras över fakturan. Artikelregister, återkommande planer och den ordinarie bilduppladdningen är inte automatiskt integrerade med dessa separata dokument. Bokföring och dokument är fortfarande lokalt lagrade.',
      ] },
    ],
    sources: [source('Kontantmetodens arbetsgång', 'bokforing/kontantmetoden.md'), source('Kontantmetodens motor', 'public/bokforing/suite/cash-method.js'), source('Kontantmetodens prov', 'server/bokforing-cash-method.test.mjs')],
    related: ['omfattning', 'moms', 'nytt-rakenskapsar', 'lagring-och-reset'],
  },
  {
    id: 'deklarationer', category: 'arbetsfloden', title: 'Deklarationer: AGI, moms, INK2 och årsredovisning',
    summary: 'Granskade lokala exportfiler för stödda fall. Filskapande, underskrift och myndighetsinlämning är skilda steg.',
    status: 'limited', updated, tags: ['deklaration', 'AGI', 'XML', 'INK2', 'SRU', 'K2', 'årsredovisning', 'Skatteverket'],
    sections: [
      { id: 'arbetsgang', title: 'Granska, spara version och hämta fil', steps: [
        'Öppna Deklarationer och välj handling. Ange organisationsnummer, personuppgifter och övrigt underlag som saknas; DEMO är ingen giltig deklarationsidentitet.',
        'Granska tillämpningsområde, period, belopp och obligatoriska uppgifter. Fiktiv bokföring ska inte lämnas in som en verklig deklaration.',
        'Spara en granskningsversion och hämta dess fil. Sparade versioner skrivs inte över.',
        'Om bokföringsunderlaget ändras, skapa och granska en ny version. En gammal export från ändrat underlag stoppas.',
        'Underskrift, eventuell komplettering och inlämning görs separat. Hämta och bevara mottagningskvittens i den externa tjänsten.',
      ] },
      { id: 'format', title: 'Filer och avgränsningar', table: {
        headers: ['Handling', 'Stöd och granskning'],
        rows: [
          ['AGI XML', 'Utbetald vanlig svensk lön under 2026, HU/IU och avgränsad föräldrafrånvaro. Personnummer kontrolleras mot födelseår och tidigare specifikationsnummer. Bruttolöneåterkrav rättar ursprungsmånaden utan sänkt skatteavdrag.'],
          ['Moms XML', 'eSKDUpload 6.0 från en avstämd rapport. Perioden måste matcha bolagets registrerade period och hela kalendermånader. Ruta 49 räknas från de exporterade rutornas hela kronor.'],
          ['INK2/SRU', 'INK2, INK2R och INK2S för aktiebolag med beskattningsperiod 2026P4. En ZIP innehåller två ISO-8859-1-filer. Användaren granskar kontomappning, skattejusteringar och samtliga rutor.'],
          ['Årsredovisning', 'Utskrivbar HTML med jämförelsetal, förvaltningsberättelse, resultat/balans, noter, resultatdisposition och underskriftsrader för avgränsad K2-tillämpning. Avslutat år och granskat underlag krävs.'],
        ],
      } },
      { id: 'granser', title: 'Vad filen inte intygar', paragraphs: [
        'AGI-exporten täcker inte samtliga ersättningar, pensions-/utlandsfall eller identitetsborttagningar. N8/N9, andra företagsformer och andra SRU-perioder ingår inte. Bruttokravets rättsliga förutsättningar och tidpunkt måste granskas; implementationen har inte verifierat rättelsesidans fulltext.',
        'Årsredovisningen gäller en mindre privat K2-aktiebolagstillämpning med granskning av de regler som gäller från 2026. K3, koncern och särskilda fall utanför kontomappningen omfattas inte. Särskilda noter och skattebedömningar kan behövas.',
        'Ingen API-inlämning, digital underskrift, fastställelseintyg eller revisionsberättelse genereras. XSD- och filkontroller visar formatet, inte att en myndighet har tagit emot handlingen eller att en revisor godkänt innehållet.',
      ] },
    ],
    sources: [source('Format, källor och avgränsning', 'bokforing/deklarationer.md'), source('Deklarationsmotor', 'public/bokforing/suite/declarations.js'), source('Scheman och filprov', 'server/bokforing-declarations.test.mjs'), source('Löneåterkrav till AGI', 'server/bokforing-declaration-payroll-integration.test.mjs')],
    related: ['individuell-lon', 'moms', 'nytt-rakenskapsar', 'verifiering', 'kanda-begransningar'],
  },
  {
    id: 'ande-saas', category: 'utveckling', title: 'Plan: en personlig Ande per kundbolag',
    summary: 'Föreslagen serverarkitektur för gemensam regelkunskap, bolagets kontext och personligt minne.',
    status: 'planned', updated, tags: ['AI', 'Ande', 'SaaS', 'API-nyckel', 'tokens', 'minne', 'bolagsgräns'],
    sections: [
      { id: 'nyckel-och-kunskap', title: 'Modellåtkomst och kunskap', paragraphs: [
        'Planen använder ett modell-API med API-nyckel på servern. Kunden behöver normalt ingen egen nyckel. Tokens är de textenheter som förbrukas av frågor, kontext och svar.',
        'En gemensam grundmodell kan kombineras med daterade, granskade regelkällor från exempelvis BFN och Skatteverket. Separat modellträning per kund behövs inte för att göra assistenten personlig.',
        'Kundbolagets egna fakturor, saldon och godkända arbetssätt hämtas som avgränsad kontext. Assistentens namn och förklaringsstil kan vara personliga.',
      ] },
      { id: 'bolagsgranser', title: 'Bolagsgränsen ska upprätthållas av servern', bullets: [
        'Session, medlemskap och roll ska kontrolleras vid varje läsning, sökning, minnesändring och förslag.',
        'Konversationer, dokument, sökindex och cache ska avgränsas per bolag. Ett inskickat companyId är ingen behörighet.',
        'Dokumentens text ska behandlas som underlag. En instruktion inuti en faktura får inte styra verktyg eller ge åtkomst till ett annat bolag.',
        'En byrå kan ha delegerad åtkomst till flera kundbolag, men deras kontext och minnen ska hållas åtskilda.',
      ] },
      { id: 'forslag-och-ansvar', title: 'Förslag, granskning och ansvar', paragraphs: [
        'Första anslutna versionen är tänkt att läsa, förklara och föreslå kontering med källor och osäkerheter. Godkända förslag ska passera samma bokföringskontroller som manuell registrering.',
        'Kunskapsmålet är kvalificerat redovisningsstöd. En språkmodell blir inte auktoriserad revisor genom träning och kan inte lämna ett oberoende revisionsuttalande.',
        'Personligt SaaS-minne och bolagsavgränsad åtkomst till riktig bokföring är fortfarande en plan. Den nuvarande offentliga Ande är OpenAI-ansluten med tillfälliga demosamtal och ett avgränsat underlag från webbläsaren. Den använder inte produktionsbolagens bokföring.',
      ] },
    ],
    sources: [andeSource('Arkitektur, ansvar och planerade API-kontrakt', 'bokforing/ai-ande-saas.md'), andeSource('Ansluten demoassistent', 'bokforing/ande-openai-test.md')],
    related: ['ande', 'for-revisorn', 'kanda-begransningar'],
  },
];
