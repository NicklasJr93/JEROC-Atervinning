# Mockupmatchning – farligt avfall och Avfallsregistret

Granskad 2026-10-09. Mockupserie **01–11 är godkänd som designunderlag** i den
aktuella beställningen. Serien täcker de avsedda huvudflödena för blybatterier,
men behöver kompletteras med strukturerade rapportuppgifter, verksamhetsregler
och beständig serverlagring före implementation. **Designgodkännandet innebär
inte att funktionerna finns i appen, att kodbygge har beställts eller att
myndighetsrapportering har aktiverats.** Denna leverans är en dokumentgranskning.

Granskningen utgår från [mockupgalleriet](../../mockups/farligt-avfall/README.md),
[flödesbeskrivningen](../../mockups/farligt-avfall/Floden.txt), den uppladdade
implementationsspecifikationen och **den faktiskt uppladdade
`BTFA.Anteckning.json`**. Den sistnämnda anger OpenAPI 3.0.1, API-version `v1`
och beskrivningsversion 1.2.8, byggd 2023-05-23. Filens SHA-256 är
`4b29c43f4c6b818b13aaec51488edd06779a4a35f41fb7fb3bd1fe9c3f5f74cb`.
API-schema visar datakontraktet; det avgör inte ensamt rättslig roll, tillstånd,
underskriftens giltighet eller alla tidsfrister. Tidregler har också
kontrollerats mot [Naturvårdsverkets vägledning](https://www.naturvardsverket.se/avfallsregister).
Endast offentliga källor har lästs; inga rapporter eller testanteckningar har
skickats till Avfallsregistrets API i denna granskning.

## Fastställd omfattning

- Blybatterier visas som **16 06 01\***; API-underlaget använder **`160601`**.
- JEROC tar emot, lagrar och lämnar vidare avfall som insamlare. Behandling ingår
  inte i detta spår.
- Direkt kundinlämning, hämtning och utleverans ska stödjas. Hämtning och
  utleverans kan ha JEROC eller extern transportör.
- Vid hämtning vägs lasten hos kunden med våg före avfärd med last. Preliminär
  ordervikt hålls skild från den fastställda vikten.
- JEROC rapporterar sin egen skyldighet. Kundens och ett externt åkeris
  rapportering skapas inte automatiskt. Eventuell annan JEROC-roll bedöms
  separat för den faktiska händelsen.
- Transportdokument, miljöanteckning/API-rapport och ekonomisk avräkning har
  separata underlag, versioner och statusar. Kundgodkännande, attest och
  betalning styr inte miljöfristerna.

## Täckning per mockup 01–11

**Täckt** betyder att designen visar principen. **Delvis** betyder att nödvändig
detaljering återstår. Ingen av bedömningarna är ett besked om implementerad
farligt-avfall-funktion.

| Vy | Täckning i godkänd design | Komplettering inför implementation | Befintligt att återanvända |
| --- | --- | --- | --- |
| [01 Artikel – miljö](../../mockups/farligt-avfall/01_Artikel_Miljo.png) | **Täckt:** två val för farlighet, avfallskod, miljöbeskrivning och hanteringsinstruktioner. ADR hålls separat. Priskorten behålls. | Validera `160601` mot aktuell kodlista. Lagra versionerad klassificering och låst snapshot på varje miljöhändelse. Definiera strukturerat ADR-underlag och vem som får fastställa det. | Artikelredigeraren och prismodellens befintliga priser/revisioner. `PriceArticle` saknar ännu miljöklassificeringen. |
| [02 Invägning – mottagning](../../mockups/farligt-avfall/02_Invagning_Mottagning.png) | **Täckt:** direktinlämning utan arbetsorder, batterier och koppar på skilda rader, tidigare innehavare, ursprung, faktisk mottagning och separat dokumentavvikelse. Ekonomin kan vänta. | Tidigare innehavarens juridiska identifierare måste kunna skilja sig från betalningskunden. Lägg strukturerad senaste/kommande hanteringsplats, transportsättskod och separat anteckningstid bakom den kompakta panelen. Tydliggör vad som är ett utkast respektive bekräftad faktisk mottagning; bildens mottagningsstatusar får inte vara motsägelsefulla. | Viktkort, materialrader, kundregister och kompakt kortlayout. Nuvarande `origin` är fri text; terminalens avräkningssnapshot är ekonomiskt underlag. |
| [03 Arbetsordrar – översikt](../../mockups/farligt-avfall/03_Arbetsordrar_Oversikt.png) | **Täckt:** egen huvudmeny, filter för typ/transportör och öppning i samma transportplanerare. | En gemensam beständig orderkälla behövs. Filter och behörigheter ska omfatta anläggning, farligt avfall och relevanta avvikelser utan att skapa en parallell ordermotor. | Transportplaneringens ordermodell, karta, kalender, förare och fordon. |
| [04 Ny arbetsorder – hämtning](../../mockups/farligt-avfall/04_Ny_Arbetsorder_Hamtning.png) | **Delvis:** start/destination, material, preliminär vikt, kontakt och egen/extern transportör. Spara ger dokumentutkast. | Lägg juridiska parter/identifierare och strukturerade platser bakom formulärets sammanfattningar. Kunden, tidigare innehavaren, lämnaren och transportören ska kunna vara olika parter. Flera materialrader behöver separat kod och vikt. | Befintlig `TransportOrderEditor` och kundval; adressökning kan hjälpa användaren men räcker inte som API-validering. |
| [05 Arbetsorder – hämtning](../../mockups/farligt-avfall/05_Arbetsorder_Hamtning.png) | **Täckt på principnivå:** AO → dokument → viktkort, tom körning till kunden, vägning, underskrifter och lastad avfärd. Faktisk mottagning är separat. | Ge faktisk mottagning ett tydligt registreringsmoment med tid, plats och verksamhetsroll. Fastställ rutinen för när JEROC övertar avfallet; mottagning kan ske hos kunden och får inte automatiskt sättas till ankomst eller vägning på JEROC. Skapa viktkortsutkast och miljöhändelser en gång även vid dubbelklick. | Befintliga orderstatusar och audit kan utvecklas. `on_way` betyder i dag endast en transportstatus och etablerar ingen rättslig mottagning. |
| [06 Utleverans – extern transportör](../../mockups/farligt-avfall/06_Utleverans_Extern_Transportor.png) | **Täckt:** JEROC som lämnare, verklig mottagare, extern transportör, lagerparti, faktisk lastvikt, dokument och anteckning före avfärd. Lageravdrag vid faktisk avfärd. | Juridiska identifierare och fullständig mottagningsplats behöver sparas. Skilj planerad borttransport, färdig anteckning och faktisk avfärd. Fastställ hur `borttransportDatum` hanteras när anteckningen måste vara färdig före avfärd. Partifördelning, reservation och avdrag måste bli transaktionssäkra. | Orderredigering och fordon; utleveranstyp, lagerpartier och borttransportanteckning saknas ännu. |
| [07 Transportdokument – A4](../../mockups/farligt-avfall/07_Transportdokument_A4.png) | **Täckt:** lämnare, transportör, mottagare, platser, kod, mängd, dokumentversion och två uttryckligen simulerade underskrifter. | Fastställ obligatoriska dokumentuppgifter och underskriftsrutin; bilden visar planerad start och behöver tydlig hantering av faktisk start/ändring. Servergenererat original, hash, signaturbevis, fullmakt när relevant, ny version vid ändring och arkiv krävs. ADR-bedömning är ett separat underlag. | Den befintliga utskriften av avräkningsnota ger layoutkunskap; den är inte ett arkiverat transportdokument eller ett underskriftsbevis. |
| [08 Mobil – chaufför och lämnare](../../mockups/farligt-avfall/08_Mobil_Chauffor_Och_Lamnare.png) | **Täckt:** mobil webbvy för order/våg/dokument och separat lämnarsida för samma version. Underskrifter är märkta simulerade. | Bestäm behörig underskrivare, säker länk, giltighet och återkallelse. Visa om ändrad dokumentversion kräver nya underskrifter. Hantera anslutningsavbrott utan att påstå att signatur, mottagning eller avfärd sparats innan servern bekräftat. | Gårdsappens enkla material/viktflöde behålls; terminalens kundgodkännande är ett annat flöde. |
| [09 Miljörapportering – kö](../../mockups/farligt-avfall/09_Miljorapportering_Oversikt.png) | **Täckt:** mottagning/borttransport, kod/mängd, anläggning, aktiva/historik, saknade uppgifter, fel och okänt resultat. Frikopplad från ekonomi. | Beräkna anteckningsfrist och rapporteringsfrist separat per roll/händelse, visa datum och källhändelse. ”Rapportering: 4 arbetsdagar” är missvisande utan tydlig startpunkt/roll: det kan följa av mottagningens två + två arbetsdagar, men gäller inte generellt. Se verifierad fristmatris nedan. Inför beständig outbox, åtgärdsansvarig och avstämningsflöde. Skilj lokal simulering från ett faktiskt accepterat NVV-testanrop och produktion. | Befintliga arbetsköer och anläggningsfilter. Transporternas minnesutkorg är inte en NVV-integration. |
| [10 Miljörapport – rättelse](../../mockups/farligt-avfall/10_Miljorapport_Detalj_Rattelse.png) | **Täckt:** läsbart original, 250 → 245 kg, orsak, versionskedja, försök/historik och separat ekonomisk rättelse. Okänt utfall kräver avstämning. | PUT skapar nytt `avfallId`; visa gamla och nya accepterade ID och rätta senaste versionen. Lägg makulering med schemaenlig orsak och behörighet. Bestäm om -5 kg är en korrigerad registrering eller verklig fysisk avvikelse och justera lagret en gång. Spara exakt request/response-snapshot. | Befintlig ekonomisk rättelse och spårbarhet kan ge UI-mönster, men får inte automatiskt ändra miljöunderlaget. |
| [11 Anläggning – tillstånd](../../mockups/farligt-avfall/11_Anlaggning_Tillstand.png) | **Täckt på principnivå:** avfallskoder, mängdgränser, varning/stopp, separat ADR, individuella anläggningsbehörigheter och anslutningsläge. | Tillstånd behöver beslut/referens, villkor, giltighet, omfattning och kontrollbevis. Definiera om gräns avser samtidigt lager, periodmängd eller annat samt reserverad mängd. Separera JEROC:s juridiska rapportör och kontaktperson från vald fysisk anläggning. Riktig personalautentisering och serverkontroller krävs. | Befintliga anläggningar och användarbehörigheter; de nya miljörättigheterna och tillståndsreglerna finns ännu inte. |

## Obligatoriskt API-underlag och var det ska komma ifrån

Mottagning mappas till **POST/PUT `/insamlingar`** och borttransport av insamlat
avfall till **POST/PUT `/insamlingstransport`**. Rapporttypen väljs från faktisk
verksamhetsroll och händelse. Valet av extern transportör ändrar inte JEROC till
ombud eller rapportör för åkeriet. `/transporter` är en separat anteckningstyp
som bara blir aktuell efter verifiering av JEROC:s egen skyldighet i den rollen.

| Fält i uppladdat schema | Mottagning | Borttransport | Källa och UX-komplettering |
| --- | --- | --- | --- |
| `verksamhetsutovare`, `verksamhetensNamn` | Krävs | Krävs | Versionerad JEROC-konfiguration med juridisk rapportör. Den är inte kundnamnet eller enbart anläggningens visningsnamn. |
| `verksamhetensKontaktpersonNamn`, `verksamhetensKontaktpersonEpost`, `verksamhetensKontaktpersonTelefonnummer` | Krävs | Krävs | Rapportkontakt hos JEROC, inte automatiskt chaufförens eller kundens kontakt. Saknas som uttrycklig uppgiftsgrupp i serien. |
| `tidpunkt` | Krävs | Krävs | Tid då anteckningen gjordes. Sparas separat från fysisk händelsetid och från varje sändningsförsök. |
| `avfall.kod`, `avfall.mangd` | Krävs | Krävs | Låst artikel-/klassificeringsversion och faktisk miljörelevant mängd i kg, högst tre decimaler. En `avfall`-post per request; flera koder ger skilda rapporter. `160601` och 250 kg avser batterierna, inte kortets totalvikt 262 kg. |
| `mottagningsDatum` | Krävs | — | Faktiskt övertagande/mottagning med rätt tid och plats, se 02/05. |
| `tidigareInnehavare` | Krävs | — | Tidigare innehavarens identifierare. Separat partrelation från avräkningskunden; företagsnamn ensamt räcker inte. |
| `senasteHanteringsPlats` | Krävs | — | Verklig senaste hanterings-/ursprungsplats, skild från fakturaadress och ofta ofullständig i dagens fria `origin`. |
| `kommandeHanteringsPlats` | Krävs | — | Den faktiskt kommande hanteringsplatsen enligt rutinen; JEROC-anläggningens strukturerade plats när det är den relevanta platsen. |
| `borttransportDatum` | — | Krävs | Borttransportens tid. Förberedelse före avfärd och bekräftad faktisk avfärd hålls skilda; rutinen för värdet/ev. senare korrigering måste fastställas. |
| `transportor` | — | Krävs | Verklig transportörs juridiska identifierare, JEROC eller extern. Fordonsregistrering och förarnamn ersätter inte identifieraren. |
| `nyInnehavare` | — | Krävs | Den verkliga mottagarens juridiska identifierare, skild från transportören. |
| `mottagningsplats` | — | Krävs | Mottagarens fysiska plats; en köpande juridisk persons fakturaadress behöver inte vara mottagningsplatsen. |
| `transportsatt` | Krävs | Krävs | Kontrollerat val från kodlistan; vägtransport mappas till `R`. ”Kundens egen transport” beskriver vem som kör, inte API-koden för transportsätt. |
| `referens` | Valfritt | Valfritt | Lokal spårningsreferens, max 40 tecken enligt beskrivningen. Den ger ingen dokumenterad dubblettgaranti. |
| `avfall.foregaendeAvfallId` | Valfritt | Valfritt | Koppling till närmast föregående anteckning i avfallskedjan när korrekt känd. Den är inte rättelsens versionslänk och ersätter inte lokal spårning av flera ingående lagerpartier. |

`ombud` och ombudets kontaktuppgifter lämnas utanför JEROC:s egen rapportering.
Ett framtida ombudsspår kräver separat behörighet, regler och validering. Pris,
betalningsmetod, attest, kundgodkännande, fordonsnummer, underskrifter och
transportdokumentets lokala ID finns inte som fält i dessa två requests. De
sparas på relevanta lokala underlag och läggs inte till som påhittade API-fält.

### Platser och kundtyper

För normal svensk adress behövs **kommunkod, adressrad och postnummer**.
Postnummer överförs som fem siffror utan mellanrum; kommunkod har fyra siffror.
Mockupernas adressetiketter kan behållas, men ett val/sparande måste ge en
kontrollerbar strukturerad plats. Anläggningens demoadress är inte ett verifierat
produktionsvärde. En karta eller texten ”Norrtälje” ger inte automatiskt rätt
kommunkod, postnummer eller fysisk adress.

Schemat beskriver även alternativ med SWEREF 99 TM-koordinater, CFAR-nummer och
utländsk landskod. Befintliga orderkoordinater `lat`/`lng` är geografiska
bredd-/längdgrader och får inte kopieras direkt till SWEREF-fälten
`nposition`/`eposition`. Varje tillåtet alternativ måste bedömas per
anteckningstyp och platstyp.

Dagens kundregister har **Företag, Privatperson och BRF**, men mockupserien
illustrerar företagsflödet. Innan andra fall byggs behövs uttryckliga regler
för svensk organisation, privatperson/hushåll, utländsk part, okänd tidigare
innehavare och flera hushåll inom en kommun. Det uppladdade schemat beskriver
specialvärdena **`OKÄND`** och **`KOMMUN`** i platsbeskrivningen; användningen får
inte göras till ett generellt sätt att kringgå saknade uppgifter. Stöd,
innebörden av kundens person-/organisationsnummer och tillåtna platsvarianter
ska verifieras för just insamlarens mottagning. Kundens ekonomiska typ avgör
inte ensam vilken miljöuppgift som ska skickas.

## Skilda händelser och statusar

| Område | Egen händelse/status | Vad övergången får påverka |
| --- | --- | --- |
| Arbetsorder | Planering, på väg till kund, arbete utfört | Planering och kopplade utkast. Tom körning till kund ger ingen lastad avfärd eller automatisk mottagning. |
| Faktisk mottagning | Fastställd tid/plats/roll och mottagen mängd | Mottagningsanteckning, rätt rapportfrist och relevant lagerrörelse. Vid hämtning kan detta inträffa hos kunden; ankomst registreras separat. |
| Transportdokument | Utkast, fullständigt, rätt underskrifter på aktuell version | Dokumentets beredskap för lasten. Ett undertecknat dokument bevisar inte accepterad NVV-rapport. |
| Borttransport | Anteckning färdig före avfärd; separat bekräftad faktisk avfärd | Rapportunderlag och avfärdstid. Lageruttag för faktisk last registreras en gång vid verklig avfärd. |
| NVV-rapport | Saknar uppgifter, Redo, Köad, Skickar, Rapporterad, Fel, Okänt resultat/Avstämning krävs, Kräver rättelse, Rättad/Makulerad | Försök, accepterat ID och versionsspår. ”Rapporterad” kräver bekräftat accepterat svar på exakt underlagsversion. |
| Ekonomi | Kundgodkännande, attest, betalning/saldo och ekonomisk rättelse | Avräkning och betalningsjournal. En ren prisändring ändrar inte avfallsmängd, dokumentoriginal eller myndighetsrapport. |

### Verifierade frister och bild 09:s ”4 arbetsdagar”

[Naturvårdsverkets aktuella vägledning](https://www.naturvardsverket.se/avfallsregister)
kontrollerades 2026-10-09. Den anger: ”Uppgifterna ska ha lämnats senast två
arbetsdagar från det datum då anteckningen ska vara förd.” För insamlare anger
samma sida mottagningsanteckning inom två arbetsdagar och borttransportanteckning
innan transporten påbörjas. Även den aktuella
[avfallsförordningen (2020:614) hos Riksdagen](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/avfallsforordning-2020614_sfs-2020-614/)
kontrollerades. 6 kap. 11 § anger ”senast två arbetsdagar efter den tidpunkt när
anteckningen ska göras eller sammanställas enligt 1–5 §§”. Insamlarens tidpunkter
följer av 6 kap. 3 §.

| Händelse/roll | Senaste anteckning | Senaste rapportering | Startpunkt att spara |
| --- | --- | --- | --- |
| Insamlarens mottagning, 6 kap. 3 § 1 | Senast två arbetsdagar efter mottagandet | Senast två arbetsdagar efter när anteckningen ska göras enligt 3 § | Verklig mottagning med fastställd tid och plats; kan inträffa hos kunden. |
| Insamlarens borttransport av insamlat avfall, 6 kap. 3 § 2 | Innan borttransporten påbörjas | Senast två arbetsdagar efter när anteckningen ska göras enligt 3 § | Relevant borttransport; anteckningen måste redan vara färdig när lasten avgår. |
| Eventuell separat JEROC-roll, t.ex. transportör | Bedöms enligt tillämplig paragraf och undantag | Bedöms utifrån den rollens lagstadgade anteckningstidpunkt | Rollens verkliga händelse; återanvänd inte automatiskt mottagningens frist. |

”4 arbetsdagar” kan alltså beskriva den yttersta totalfristen från en normal
mottagning i insamlarrollen när två arbetsdagar för anteckningen följs av två för
rapportering. **Bild 09:s ospecificerade text är missvisande som generell
rapporteringsregel** och ska i kommande implementerade vy ersättas med beräknat
fristdatum, anteckningsfrist, roll och utgångshändelse. Ett redan bekräftat korrekt
underlag kan rapporteras omgående; modellen ska inte bygga in fyra dagars väntan.

Rapporteringsfristen räknas från när anteckningen **ska** göras, inte från ett
senare faktiskt anteckningsdatum eller nytt sändningsförsök. Anteckningsfristen
och rapporteringsfristen ska synas var för sig i 09/10. Reglerna ovan ger grund
för insamlarspåret; innan byggstart behöver JEROC:s roll-/händelsematris samt
arbetsdagskalender, tidszon och hantering av sena/ändrade händelser fastställas.
Varken en ny köpost eller ett ekonomiskt godkännande startar om fristen.

## Rättelse, okänt resultat och arkiv

Vy 10 visar rätt princip: tidigare versioner ligger kvar. API-svarets `avfallId`
är knutet till accepterad anteckningsversion och **PUT genererar ett nytt ID**.
Rättelsekedjan ska därför spara både tidigare och nytt ID; nästa rättelse ska
utgå från senaste accepterade ID. En fysisk viktkorrigering och dess eventuella
ekonomiska följd ska granskas var för sig. En korrigerad uppgift från 250 till
245 kg är inte i sig bevis på att fem kg fysiskt har försvunnit.

Makulering kräver egen åtgärd/historik. Uppladdat schema anger
DELETE `/anteckningar` med `avfallsId` och `makuleringsorsak`:
`FelAvfall`, `FelAnteckningstyp`, `FelVU` eller `SkickatDubbelt`.
Lokalt behöver även handläggare, förklaring, underlag och resultat sparas.

Timeout efter POST/PUT kan betyda att myndigheten accepterade underlaget men
att svaret försvann. Köposten ska då låsas för automatisk omsändning och visa
**Okänt resultat – avstämning krävs** med ansvarig och försöksuppgifter.
`referens` eller ett spårnings-ID är ingen dokumenterad API-idempotensnyckel.
GET `/anteckningar` och GET `/anteckningar/{avfallid}` är uttryckligen beskrivna
som **endast AT/test** i det uppladdade schemat. Produktionsrutinen för att
stämma av okända resultat behöver därför klarläggas med NVV; gränssnittet får
inte utlova en automatiserad produktionsläsning som saknar stöd.

Beständig lagring behövs för klassificeringssnapshot, juridiska parter och
platser, faktisk händelse, lagerpartier/rörelser, dokumentversion och
underskriftsbevis, skickad request, mottaget svar och försöks-/versionshistorik.
En gemensam transaktion ska säkra källhändelse och outbox; lokal unikhet på
händelse/roll/version samt arbetarlås ska skydda mot parallella handläggare,
omladdning och dubbla lokala försök. Det löser inte automatiskt ett okänt
myndighetsutfall. Naturvårdsverkets vägledning anger **minst tre års bevarande
av anteckningar**; ett år anges för den som antecknar som transportör. För detta
insamlarspår är därför tre år en miniminivå för anteckningar, inte ett fritt
konfigurationsval. Åtkomst, säkerhetskopiering, återläsning och särskilda krav på
transportdokument/underskriftsbevis behöver fastställas innan drift.

## Vad appen faktiskt har i dag

Kodgranskningen bekräftar avgränsningarna i
[kontorsdokumentationen](../../office-demo.md) och
[terminaldokumentationen](../../terminal-demo.md):

| Område | Nuvarande funktion/lagring | Betydelse för miljöspåret |
| --- | --- | --- |
| Artiklar/priser | `PriceArticle` och serverns prismotor har priser, artikelrevisioner och prisunderlag; prisdata ligger i RAM. | Miljöklassificering och dess beständiga snapshots återstår. Prisrevision är inte automatiskt miljörevision. |
| Viktkort/kunder/ekonomiska rättelser | Kontorsdata ligger huvudsakligen i webbläsarens `jeroc.office.demo.v1`. Vissa terminalgranskade kort delas från servern. | Ingen gemensam fullständig mottagnings-/miljödatabas finns. En terminalkopia uppstår först vid ekonomisk kundvisning, vilket är för sent som enda miljöhändelsekälla. |
| Transport | `TransportOrder` har hämtning, byte och utställning, en materialtext och lokal lagring i `jeroc.transport.demo.v1`. | Utleverans, strukturerade materialrader, miljöparter/-platser, dokument, faktisk mottagning och lagerspår saknas. |
| Transporternas demo-outbox | `server/transport-integrations.mjs` förbereder orderhändelser i en minnesbaserad `Map`; API:t levererar inget externt. | Den är ett återanvändbart mönster, inte beständig NVV-kö, dokumentarkiv eller fungerande myndighetsadapter. Dess generiska återförsök får inte kopieras till okända NVV-resultat. |
| Kundterminal | Terminalkonton, sessioner, frysta avräkningsversioner och kundsvar har PostgreSQL på Render och lokal SQLite enligt befintlig konfiguration. | Gemensam lagring finns för terminaldelen, inte automatiskt för hela appen. Kundens avräkningsgodkännande är inte elektronisk underskrift av transportdokument. |
| Identitet/integrationer | Kontorets användarval/Jobba som är demo. BankID, SMS, e-post och Visma är inte anslutna enligt befintlig dokumentation. | Riktig personalidentitet, miljöbehörigheter och avsedd dokumentunderskrift behöver byggas/verifieras separat. |

Kontrollerade kodkällor:
[pricing-client.ts](../../../src/office/pricing-client.ts),
[pricing.mjs](../../../server/pricing.mjs),
[model.ts](../../../src/office/model.ts),
[transport/types.ts](../../../src/office/transport/types.ts),
[transport/model.ts](../../../src/office/transport/model.ts),
[transport-integrations.mjs](../../../server/transport-integrations.mjs) och
[terminal-demo.mjs](../../../server/terminal-demo.mjs).

## Beslut som behövs före byggstart

1. **Mottagningsrutinen vid hämtning:** när, var och i vilken roll JEROC faktiskt
   övertar avfallet; hur detta dokumenteras separat från platsvägning och ankomst.
2. **Rollmatris per uppdrag:** egen/extern hämtning och egen/extern utleverans;
   bedöm JEROC:s eventuella transportörsskyldighet och tillämpliga undantag utan
   att rapportera kundens eller åkeriets skyldighet.
3. **Masterdata och kundfall:** verklig JEROC-rapportör, rapportkontakt,
   anläggningsplatser, externa parter och tillstånd samt vilka person-/hushålls-,
   BRF-, utlands- och okänd-fall som ska omfattas av första implementationen.
4. **Borttransportens tid och frister:** rutin för anteckning före avfärd,
   `borttransportDatum`, faktisk avfärd och eventuella avvikelser/rättelser;
   verifierad beräkning av antecknings- och rapporteringsfrist.
5. **Dokumentunderskrift och ADR:** avsedd tjänst, behöriga underskrivare,
   fullmaktsrutin, versionsbyte, tillgång under färd och separat ADR-bedömning.
6. **Tillstånd/lager/arkiv:** beslutens omfattning, gränsernas mätperiod,
   varning/stopp, lagerreservationer, spårning av blandade partier och
   bevarande-/återläsningsregler.
7. **Avstämning i produktion:** NVV:s stödda rutin vid okänt POST/PUT-resultat
   och vem som får avgöra att nytt försök, rättelse eller makulering är säkert.

Nästa implementationplan kan använda matrisen som acceptansunderlag och
specificera databas/migrering, transaktioner och adaptertest först. Samma plan
ska behålla befintliga priser, A/B/C, kundgodkännande, attest, terminal och
gårdsappens enkla vägning. Byggstart, riktiga underskrifter, NVV-testanrop och
produktionsaktivering är separata senare steg.
