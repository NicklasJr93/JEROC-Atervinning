# Arbetsorder, lager och kundportal – kontorsdemo 0.12.1

Den befintliga JEROC-appen har nu gemensamma arbetsorder för **Hämtning**,
**Byte**, **Utställning** och **Utleverans**. Kontoret, planeraren, kundportalen,
åkeriet och chauffören använder samma order-ID. Inga externa mejl-, NVV-,
Visma- eller betalningsanrop aktiveras av denna release.

## Kontorets menyer och arbetsflöde

- **Arbetsorder** har Aktiva/Historik, sökning och filter för typ, status,
  anläggning och egna/externa utförare. Detaljen visar sträcka, material,
  tidsönskemål, åkerisvar, bemanning, kundönskemål och historik.
- **Lager** visar material och mängder per anläggning, med filter för alla
  eller enskilda tillåtna anläggningar. Enskilda viktkort visas inte i
  översikten. **Boka utleverans** öppnar samma arbetsorderformulär med
  utleverans, lastande anläggning och material/mängd förifyllda.
- **Kärl & containrar** samlar konkreta tillgångar, kundplatser, avtal och
  kundernas portalinloggningar. Kärltyp och storlek hålls skilda från det
  konkreta kärl-ID:t och den aktuella placeringen.

Egna chaufförer är förval. Förare och fordon kan tilldelas utan att en tid
bokas. Exakt kalenderbokning är ett separat val och använder befintliga
kontroller för schema, frånvaro, kompetenser samt förar-/fordonskrockar.
Standardtidsåtgången är 60 minuter. Ett önskat datum eller tidsfönster blir
inte en kalenderbokning av att arbetsordern skapas.

**Ny arbetsorder** öppnar `/kontor#/work-orders/new`; redigering öppnar
`/kontor#/work-orders/:id/edit`. Formulären är hela kontorssidor med alla
inställningar och kvarliggande Spara/Avbryt. Direktlänkar och omladdning
behåller valt uppdrag. Förval från lager/kärl följer med i sidans navigation,
och Avbryt återgår till den vy där beställningen startades.

## Kopplad vägning och nummersättning

En hämtning eller ett byte utan material skapar inget vägningsutkast. Första
sparade materialraden skapar ett gemensamt förberett underlag kopplat till
arbetsorderns ID. Fler rader uppdaterar samma oanvända underlag. För farliga
artiklar förbereds även miljöuppgifter från klassificeringen. Dessa uppgifter
utgör inte en faktisk mottagning eller ett skickat NVV-underlag.

Förberedelsen har ett internt UUID och inget INV-/avräkningsnummer. Planerad
mängd hålls separat från faktisk vikt. På arbetsordern startar behörig personal
vägningen och registrerar verkliga vikter. Vid färdigställning tilldelar servern
ett permanent INV-nummer atomiskt och skapar ett kontorskort en gång, med kund,
ursprung och arbetsorderlänk. Samma kort öppnas vid återförsök. Kundgodkännande,
miljömottagning och attest följer befintliga regler.

När en arbetsorder avbryts före påbörjad vägning tas oanvända förberedelser bort
utan att förbruka nummer. Påbörjade och färdigställda underlag behåller sin
spårbarhet. Färdigställda nummer återanvänds aldrig. Utställningar, tomma
hämtningar och utleveranser skapar inga inkommande inköpskort.

Kartpositioner följer transportmodellens sparade koordinater. En ny adress
geokodas inte automatiskt i denna etapp; adressautocomplete och ruttförslag
är fortsatt separat planerat arbete.

Vid **Extern transportör** väljs ett befintligt åkeri från personalregistret.
Kontoret sparar ordern och öppnar förfrågan/mejlförhandsvisningen. När förfrågan
verkställs blir den tillgänglig i det åkeriets portal. Mejltext förbereds men
**inget mejl skickas**. Åkeriet kan acceptera, avböja eller föreslå annan tid;
exakt tid behöver inte anges för att acceptera eller bemanna uppdraget.
Överenskommen tid och kalenderbokning är separata uppgifter.

## Lager och verkligt utförande

Lageröversikten skiljer på **fysiskt lager**, **reserverat** och **tillgängligt**.
En aktiv utleverans reserverar den planerade mängden. Ändrad mängd räknas om
på servern, och avbruten order frigör reservationen.

Vanligt material hämtas från serverlagrade invägningsrader med käll-ID.
Farligt avfall hämtas från registrerade miljömottagningar och miljörättelser,
inte från vanliga ekonomiska statusar eller demomängder. Inga påhittade
fysiska ingående saldon skapas vid införandet. Behörig personal kan lägga in
befintligt vanligt lager eller göra en inventeringsrättelse med motivering.
Farliga mängder rättas fortsatt genom miljöflödet.

Chaufförens uppdrag skiljer på körning utan last till hämtningen, ankomst,
registrerad verklig last, avfärd med last och slutförd leverans. Planering,
åkeriets ja och registrerad last minskar inte det fysiska lagret. **Bekräftad
lastad avfärd** registrerar ett lageravdrag med verklig mängd, en gång per
order/material. Återförsök gör inte om avdraget.

Kontorets klartecken, giltig förare/fordon och verkliga vikter kontrolleras
före avfärd. För farligt avfall krävs även aktuell dokumentversion samt
lämnarens och transportörens demogodkännanden. Ändrade dokumentuppgifter
eller lastvikter upphäver tidigare godkännanden av dokumentversionen.
Transport-PDF följer arbetsorderns frysta underlag och versionsarkiv;
underskrifterna är uttryckligen **testbekräftelser**, inte skarpa signaturer.
Efter avfärd kan en slutlig demoversion arkiveras. Ingen NVV-kvittens hittas på.

Slutförd hämtning, utställning eller byte uppdaterar de berörda kärlens
placering. En bokning eller ett kundönskemål flyttar inget kärl.

## Kärl, avtal och kundönskemål

Nya kärl får eget ID, namn, typ, storlek, ansvarig anläggning och valfritt
material. Vid första registreringen kan ett redan utställt kärl kopplas till
kund och separat kundplats. Därefter flyttas ett utställt kärl genom utförd
arbetsorder, med bevarad historik.

Avtal kopplas till kundens utställda kärl och samma anläggning. De kan ange
rullande byte/hämtning eller hyra, tillåtna beställningar, intervall,
nästa önskade tillfälle, hyresperiod och noteringar. Ett aktivt rullande avtal
skapar sitt planeringsuppdrag om ett sådant inte redan finns. Efter slutfört
rullande byte flyttas avtalet till ersättningskärlet och nästa uppdrag skapas.
En extra kundbeställd växling flyttar inte avtalets ordinarie nästa datum.
Slutförd hämtning utan ersättningskärl avslutar den aktuella kärlkopplingen.
Detta är ingen nattlig schemamotor för obegränsat framtida tillfällen.

Kunden beställer tillåtna åtgärder för sina egna tillgångar. Finns redan ett
aktivt uppdrag knyts önskemålet dit. Tidigare hämtning ändrar inte befintlig
bokad tid; kontoret behöver hantera önskemålet. En pågående kundförfrågan
hindrar dubbla beställningar på samma kärl. Extra önskemål ändrar inte
avtalets intervall eller kärlets placering.

## Tre separata portalinloggningar

| Portal | Adress | Konto skapas på kontoret |
| --- | --- | --- |
| Kund | `/kund` | Kärl & containrar → Kundportal → Nytt kundkonto |
| Åkeriets transportledare | `/akeri` | Arbetsorder → Åkerikonto |
| Chaufför | `/chauffor` | Personal → personkortets chaufförsinloggning |

Kund- och åkerikonton får administrerade användarnamn och egna lösenord.
Det finns inga gemensamma standardlösenord eller automatiskt skapade
portaluppgifter. Ett nytt lösenord ersätter det gamla; ändrat eller spärrat
konto gör befintliga portalsessioner ogiltiga. Testkonton och lösenord skapas
för varje testkörning och läggs inte in som credentials i repot.

Kundportalen visar endast det egna företagets tillgångar, avtal och önskemål.
Åkeriet ser sina egna förfrågningar och uppdrag och väljer egna chaufförer.
Chauffören ser endast sina tilldelade uppdrag. Kundpriser, betalningsuppgifter
och kontorsbehörigheter följer inte med till dessa portaler.

Portalerna använder separata serverlagrade sessionscookies, hashade lösenord
och kontrollerad kund-/åkeriåtkomst. Kontorets befintliga inloggning och
**Jobba som** är fortfarande demoauth; denna release inför inte skarp
personalinloggning för hela systemet.

## Persistens och befintliga uppgifter

`state.logistics` innehåller orderdetaljer, kärl, avtal, kundönskemål,
lagerrörelser, versioner, idempotens, audit och `deliveryOutbox`. Utkorgen
sparar mejlmall/mottagare/version med leverans avstängd; ersatta och återkallade
underlag ligger kvar i historiken. Arbetsordrarna ligger fortsatt
i det gemensamma transportregistret. `state.logisticsAuth` innehåller
portalens konton med lösenordshashar, sessionshashar och inloggningsförsök.

`state.workOrderWeighing` sparar de förberedda vägningarna separat: internt ID,
arbetsorderkoppling, status/version, planerade och verkliga mängder,
miljöförberedelse samt det slutliga kontorskortets ID. Befintliga databaser
får domänen utan att äldre uppgifter nollställs.

Alla dessa domäner sparas genom befintlig verksamhetsrepository, i PostgreSQL
när `DATABASE_URL` är konfigurerad. Lokalt används samma repositories
beständiga SQLite-utvecklingsläge. Ingen separat databas eller ny
Renderinställning krävs för logistiken. Detta beskriver lagringskopplingen,
inte en verifiering av en specifik Renderdeployment eller dess databas.

Befintliga kunder, personal, förare, fordon, transportordrar, dokument,
mottagningar och viktkort bevaras. Modulen raderar inte tidigare testdata
och skapar inga fiktiva kundavtal eller portalinloggningar vid uppstart.
Den befintliga dokumentmotorn används för PDF-original.

Nya rättigheter skiljer på läsa/ändra arbetsorder, lager och kärl samt
kundkonton och åkerikonton. Administrera kund-/åkerikonton kräver rättigheten
och tillgång till alla anläggningar; dessa kontoknappar döljs för användare med
anläggningsbegränsning. Anläggningsbegränsad personal kan fortfarande arbeta
med tillåtna arbetsordrar, kärl och lager enligt sina övriga rättigheter.
Servern kontrollerar rättighet, anläggning,
versionskonflikter och kund-/åkerikoppling även vid direkta API-anrop.

## Planerade integrationssteg

NVV:s första **BTFA.Anteckning TEST**-adapter finns från 0.12.0 för
företagsmottagningar och rättelser. Den är avstängd som standard och kräver
separata [Renderinställningar](integrationer/naturvardsverket/render-snabbstart.md)
och ett uttryckligt utskick. Utgående transport-/borttransportrapporter är
fortsatt en separat etapp. Arbetsorderförberedelser skickar aldrig rapporter.

Spiris/Visma eEkonomi är det valda målet för nästa sandboxetapp, som är ett
separat ekonomisteg efter kundgodkännande
och intern attest. OAuth, rätt inköps-/självfaktureringsflöde, kontomappning
och bekräftade referenser ska provas innan export aktiveras. Utbetalningar
är fortsatt manuella. Riktig mejlleverans och skarp dokumentunderskrift
kräver sina egna konfigurationer och verifieringar.
