# Byggrecept – från ScrapPilot till återanvändbar SaaS-grund

Detta är genomförandeplanen till [blueprinten](README.md). Checklistorna är
acceptanskriterier för kommande arbete. Dokumentationen extraherar inga paket,
ändrar inga databasscheman och aktiverar inga nya tjänster.

## 1. Fyll i produktkortet

Gör dessa val innan en ny produkt byggs. Hemliga värden anges i miljöns
hemlighetshantering; produktkortet innehåller bara variabelnamn och ansvar.

| Val | Utgångspunkt |
| --- | --- |
| Produktnamn, slug och paketnamespace | Produktens egna värden; juridiskt kundbolag lagras separat. |
| Målgrupp och huvudarbete | Beskriv tre verkliga användarflöden som produkten ska lösa. |
| Bolagsmodell | B2B med separata tenants; stöd för flera medlemskap endast när det behövs. |
| Inloggningsytor | Kontor, mobil och eventuella externa portaler har uttryckligt definierade målgrupper. |
| Startmoduler och beroenden | Välj minsta användbara kombination och dokumentera beroendegrafen. |
| Tenantlagring | Servervalda PostgreSQL-scheman som första kandidat; dokumentera rättigheter och begränsningar. |
| Språk och kalender | Exempelvis `sv-SE`, IANA-tidszon `Europe/Stockholm`; lagra tidpunkter i UTC. |
| Användarroller | Beskriv åtgärder, objektägarskap, anläggningar och privata dataklasser. |
| Kundadministration | Vem får skapa bolag, bjuda in användare, lägga till anläggningar och avsluta bolag? |
| Integrationer | Ange vilka som krävs, vem som äger anslutningen och test-/produktionsmiljö. |
| Dokument och retention | Ange dokumenttyper, åtkomst, gallring, export och juridisk arkivering. |
| Driftmål | Besluta svarstider, datamängd, samtidiga användare, RPO/RTO och vem som får larm. |
| Leveransmiljöer | Lokal utveckling, isolerad CI, staging och produktion med separata hemligheter och databaser. |

RPO är accepterad dataförlust räknad i tid. RTO är målet för hur snabbt tjänsten
ska kunna återställas. Värdena behöver väljas, budgeteras och provas.

## 2. Etapp A – säkra utgångspunkten

Genomför [säkerhets- och driftkraven](03-sakerhet-och-drift.md), med de bekräftade
luckorna i ÄL 123 som prioritet. Ett säkerhetsfel ska rättas i källprodukten
innan dess kod blir en rekommenderad kopieringsmall.

- [ ] Serverkonton i demoläge kan spärras; det räcker inte att dölja demoknappar.
- [ ] Samma identitets säkerhetsändring återkallar alla relevanta sessioner.
- [ ] Arkiv, exporter och filer har egna validerings- och åtkomstregler.
- [ ] Okända externa betalningsutfall kan inte öppna för dubbelt utförande.
- [ ] Skydd mot renderfel, säkerhetsheaders, loggmaskering och uppladdningspolicy finns.
- [ ] Staging, verkliga PostgreSQL-tester, CI, backup och återställning är verifierade.

**Färdigt när:** kritiska fel har negativa regressionstester genom den riktiga
gatewayen, och kvarvarande risker har ansvarig, beslut och datum. Ett grönt
lokalt deltest ersätter inte releasegaten.

## 3. Etapp B – fastställ kontrakten före flytt av kod

Skriv korta arkitekturbeslut, en fråga per beslut:

1. **Identitet och auktorisering:** ett konto, medlemskap, verklig/effektiv
   aktör, säkerhetsversion, MFA och regler för support.
2. **Tenantlagring:** schema- eller annan isoleringsmodell, databasroller,
   sökvägar, poolbudget och hur återställning av ett bolag fungerar.
3. **Moduler och produkter:** manifest, beroenden, versionskrav, livscykel och
   vilka API-/UI-ytor som varje modul äger.
4. **Transaktioner och händelser:** kommandon, idempotens, audit, outbox och
   vad som händer när en konsument eller leverantör är nere.
5. **Filer och hemligheter:** lagring, kvoter, privat åtkomst, nyckelversioner,
   rotation och återställning.

Definiera gemensam felmodell, inklusive `requestId`, begripligt användarfel och
säker teknisk felsökning. Besluta vilka konflikter som ger omläsning, vilka
operationer som kan återförsökas och vilka som kräver kontroll av samma försök.

**Färdigt när:** ett kommando kan beskrivas och testas utan import av
ScrapPilots artikel-, transport- eller viktkortsmodell.

## 4. Etapp C – bygg en körbar kärna

Skapa ett separat starter-repo när implementationen av denna etapp påbörjas.
Bevara denna blueprint i källprodukten som referens. Följande är föreslagen
struktur, inte mappar som redan finns som färdiga paket:

```text
apps/
  web/                    # kontor + plattformsytor
  worker/                 # beständiga jobb
packages/
  core/                   # identity, tenant, policy, audit, transaktioner
  ui/                     # sidmallar, formulär, tabeller och dialoger
  storage-postgres/       # tenantbundna repositories och migrationer
  files/                  # privat filåtkomst och lagringsadapter
  module-runtime/         # register, beroenden, API/nav och livscykel
  testkit/                # två tenants, fake clock och provider-simulatorer
modules/
  people/
  equipment/
products/
  example/                # varumärke, moduler, meny och produktinställningar
docs/
  decisions/
  operations/
```

Använd befintliga verktyg där de fungerar: React/TypeScript, Node, PostgreSQL,
servervaliderade scheman och Playwright. Paketstrukturen ska följa bekräftade
gränser; varje liten hjälpfunktion behöver inte bli ett eget publicerat paket.

- [ ] Login, logout, förstgångsbyte, utgång, återkallande och MFA fungerar.
- [ ] Plattformen kan skapa ett bolag och första administratören säkert.
- [ ] Bolag A och B kan ha identiska objekt-ID:n utan dataläckage.
- [ ] Systemadmin kan lämna en bolagsvy och återgå till plattformsöversikten.
- [ ] Jobba som visar faktisk och effektiv identitet och loggar kontextbytet.
- [ ] Ett avstängt konto eller medlemskap tappar API-, fil- och streamåtkomst.
- [ ] Sidmall, meny, inställningar och mobilgrund fungerar utan branschmoduler.
- [ ] Branding och bolagsidentitet kommer från rätt konfiguration.
- [ ] Nya bolag innehåller endast uttryckliga systemstartvärden.

**Färdigt när:** en ren installation kan gå från tom databas till två verkligt
isolerade bolag utan JEROC-fixtures, manuella databasändringar eller branschflöden.

## 5. Etapp D – bevisa en modul från början till slut

Starta med en smal personkatalog och **utrustning**: registrera ett verktyg,
tilldela det en person, återlämna det och visa historiken. Detta provar
personreferenser, plats, behörighet, listor, detaljer, kommando, transaktion,
audit och modulåtkomst med ett begripligt verksamhetsflöde.

- [ ] Samma modul fungerar med två olika produktkonfigurationer/varumärken.
- [ ] Modulen kräver varken prislista, skrotartikel, Fleet eller Dispatch.
- [ ] Meny och API är spärrade när modulen är avstängd.
- [ ] Aktiverad modul ger ingen användarbehörighet automatiskt.
- [ ] Läsrätt, skrivrätt, objektgräns och anläggningsgräns har negativa tester.
- [ ] Samtidig dubbel tilldelning kan inte skapa två aktiva innehavare.
- [ ] Upprepning av ett sparförsök skapar en affärshändelse.
- [ ] Modulens migration och uppgradering bevarar historik och referenser.
- [ ] Avstängning bevarar beslutat underlag och hanterar pågående jobb.

**Färdigt när:** den andra produkten kan använda modulen genom dokumenterade
kontrakt. Modulen får inte läsa den första produktens privata state direkt.

## 6. Etapp E – extrahera större delar stegvis

| Ordning | Leverans | Viktig kontroll |
| --- | --- | --- |
| 1 | Tid och stämpel | Fungerar med personkatalog och schema utan arbetsorder eller Dispatch. |
| 2 | Anställning, frånvaro och tidattest | Privata fält och lands-/avtalspolicy hålls separata från vanlig tillgänglighet. |
| 3 | Generisk kalenderpresentation | Resurser, bokningar och kommandon kommer via adapter. |
| 4 | Dispatch-motor | Konflikter, kompetens och bokningsregler kontrolleras på servern. |
| 5 | Assets/Fleet | Ett kanoniskt fordonsregister används av planering, personal och körjournal. |
| 6 | Mejl och AI | Kundmatchning är valfri adapter; offentlig AI-kunskap hålls skild från interna uppgifter. |
| 7 | Högfrekvent telematik | Separat mottagare, kö, datalivscykel och återspelning dimensioneras efter uppmätt last. |

ScrapPilot behåller sina publika objektreferenser under flytten. Lägg adapter
runt befintliga funktioner, flytta en datadomän åt gången och välj en kanonisk
skrivväg. Kopierade fordons- eller personalregister med två skrivande ägare ger
svårhanterliga synkfel.

Planera datamigreringen med inventering, backup, provmigrering, jämförda antal
och relationer, kort avgränsad övergång och verifierad återgång. Pågående
betalningar, integrationsjobb och frysta dokument behöver egna cutover-regler.
En rollback får inte återutlösa genomförda pengarörelser eller utskick.

## 7. Obligatorisk testmatris för varje produkt

| Prov | Minsta bevis |
| --- | --- |
| Två tenants | Samma kund-/person-/fil-/jobb-ID, båda läs- och skrivförsök via verklig gateway. |
| Anläggningar | Tillåten, otillåten, borttagen och avstängd anläggning. |
| Roll och objekt | Ingen session, fel roll, rätt roll/fel objekt, avstängt konto och återkallat medlemskap. |
| Systemadmin/support | Egen plattformsbehörighet, arbete som användare, begränsad support och avslutad supportsession. |
| Modulåtkomst | Saknad modul, saknad användarrätt, stängd modul med pågående jobb samt beroende som saknas. |
| Kontextbyte | Två flikar, fördröjt svar, gammalt formulär, cache, export, uppladdning och stream. |
| Samtidighet | Två sparningar på samma revision, dubbelklick, återstart och två workers. |
| Externa fel | Timeout före/efter möjlig mottagning, 429, 5xx, felaktigt JSON och duplicerad webhook. |
| Återställning | Isolerad restore av databas och filer med externa sidoeffekter avstängda. |
| UI | Mobil och desktop, tangentbord, fokus, sticky ytor, tomt läge, fel och återhämtning. |
| Last | Beslutad användar-/datamängd, paginering, pooltak, köålder och tjänstens svar vid delavbrott. |

Använd serverkonstruerade testidentiteter och samma policyväg som i produktion.
En testheader som fungerar utanför gatewayen är inte bevis för publik API-åtkomst.
Betalda eller skarpa provideranrop har egna uttryckliga acceptansprov och körs
inte som bieffekt av vanliga tester.

## 8. CI och release

Varje pull request bör kontrollera låsta beroenden, typer/bygge, kritiska
server-/browserfall, migrationskompatibilitet och beroende-/hemlighetsskanning.
Riktiga PostgreSQL-prov körs mot en tillfällig separat testdatabas. Ett
testkommando får inte ärva produktionsdatabas eller skarpa credentials.

Release görs som ett kontrollerat flöde:

1. Bygg ett versionsidentifierat artefaktpaket och kör verifieringen.
2. Kontrollera backup, migrationsplan och återgång för den aktuella releasen.
3. Driftsätt bakåtkompatibelt i staging och prova kärnflödet.
4. Kör godkänd driftsättning med schema-/modulversioner under kontroll.
5. Kontrollera readiness, felandel, köer och ett litet verkligt behörighetsprov.
6. Följ upp; återställ kod eller använd dokumenterad framåträttning vid fel.

Databasåterställning är ett separat beslut med dataförlustkonsekvenser. Att rulla
tillbaka applikationsversionen ska normalt inte kräva en restore av kundernas
senaste arbete.

## 9. Definition av en färdig SaaS-starter

- [ ] Ny produkt kan byggas från dokumenterade val och låsta versioner.
- [ ] Alla kärnflöden ovan fungerar mot produktionslik databas.
- [ ] Samma modul har demonstrerats i två olika produkter.
- [ ] Ingen branschmodul behövs för att logga in eller administrera bolag.
- [ ] Systemadmin, bolagsadmin och support är tydligt skilda befogenheter.
- [ ] Dataklasser, retention, backup, restore och incidentansvar är fastställda.
- [ ] Grundens kapacitetsgränser och kända begränsningar är dokumenterade.
- [ ] Skarpa integrationer kan inte aktiveras bara genom att öppna en meny.
- [ ] Säkerhetsgaten är verifierad; inga oklassificerade kritiska fel återstår.
- [ ] Det finns installationsguide, driftguide och exempel på hur en ny modul läggs till.

## 10. Starttext för ett framtida bygge

Följande kan användas i ett nytt utvecklingsärende tillsammans med de fyra
blueprint-dokumenten och ett ifyllt produktkort:

> Bygg produktens SaaS-grund enligt bifogad blueprint. Börja med att verifiera
> vilka kärnkontrakt och paket som faktiskt finns. Markera förslag som ännu
> kräver implementation. Implementera först isolering, identitet, policy,
> systemadmin, bolagsprovisionering, UI-skal och releasekontroller. Använd
> servervalt bolag och testa två tenants med kolliderande objekt-ID:n. Lägg
> därefter till valda moduler genom dokumenterade portar. Återanvänd inga
> demolösenord, legacy-bolagsfallbacks, kunddata eller skarpa hemligheter.
> Redovisa vad som är testat, vilket underlag som saknas och vilken etapp som
> är färdig innan nya verksamhetsfunktioner byggs.
