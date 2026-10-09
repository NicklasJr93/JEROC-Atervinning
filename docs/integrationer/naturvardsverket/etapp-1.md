# Etapp 1 – artikelmiljö och mottagning, kontorsdemo 0.7.1

Godkänd byggstart 2026-10-09. Den här etappen låter kontoret klassificera
artiklar och registrera en faktisk direktinlämning. Ingen anteckning skickas
till Naturvårdsverket och inga Visma-, bank- eller meddelandeanrop görs.

## Prova i kontoret

1. Öppna `/kontor` och välj Systemadmin. Miljösessionen följer automatiskt valt
   demokonto och **Jobba som**; inget extra lösenord behövs. Detta är tydligt
   demoautentisering. Terminalkonton behåller sin egen lösenordsinloggning.
2. Under **Artiklar & priser**, öppna **Blybatterier** och kontrollera panelen
   **Miljö & avfallsklassificering**: farligt avfall, kod `160601`, beskrivning
   Blybatterier. Klassificering och ADR-behov är separata uppgifter. Ändringar
   får en ny version; prisformlerna påverkas inte.
3. Öppna invägning **2050**: 250 kg blybatterier och 12 kg koppar. **Miljö &
   mottagning** ligger efter kundgodkännandet och före intern attest. Öppna den
   kompakta sammanställningen. Innehavare, anläggning och tid är förifyllda från
   kund/kort. Ändra per rad; extra kontaktuppgifter finns under **Fler uppgifter**.
4. **Ursprungsadress på viktkortet** är den enda källan till senaste hanteringsplats.
   Backend delar den och söker säker adress-/kommunmatchning. Vid osäker matchning
   kompletteras bara adressen eller kommunen. En adress ändrad här sparas även
   på viktkortet. Kundens fakturaadress används aldrig som reserv.
5. Vägsätt är förvalt men kan ändras i raden. Dokument-/transportreferens är
   valfri. Välj **Dokument finns**, **Krävs inte i detta fall** (orsak), **Krävs men
   saknas** (avvikelse) eller **Ej kontrollerat**. Ett tomt nummerfält betyder inte
   automatiskt att ett obligatoriskt dokument saknas.
6. **Spara utkast** och ladda om. Uppgifterna är serverlagrade och kan läsas från
   en annan kassa. Ingen lagerpost eller rapportfrist skapas av utkastet.
   Även bekräftelsen kräver att utkastversionen fortfarande är aktuell;
   en kollegas nyare utkast kan inte ersättas av en gammal kontorsvy.
7. **Bekräfta mottagning** visar material och verkliga vikter före sparning.
   Bekräftelsen fryser underlaget och skapar fysisk lagermängd och miljöunderlag.
   Kopparraden bildar inget farligt-avfallsunderlag. **Miljörapportering** visar
   underlag, frister och inkommande lager. Utskick är avstängt.
8. **Rätta miljöuppgifter** sparar en ny version med obligatorisk orsak. Originalet
   bevaras. Rättelser använder kortets aktuella materialmängder och justerar bara
   skillnaden i fysiskt lager. Kontakt-/metadataändringar ger ingen mängdändring;
   prisändringar påverkar inte miljöversionen. Tidigare underlag syns under
   **Historik**. Detta tillför ingen ny material-/vikteditor till kontorskortet.
9. Prova kundgodkännande på terminal och separat intern attest på samma kort.
   Miljömottagningen och dess frister är oberoende av de ekonomiska stegen.

Anläggnings-, företags- och kontaktuppgifter i demon är exempel. Underlaget
är inte färdigt för myndighetsleverans enbart för att mottagningen registrerats.
Verifierad verksamhetsidentitet och komplett framtida API-payload behövs innan
rapportering aktiveras i etapp 4. Hämtning hos kunden byggs i etapp 2.

## Beständig lagring och behörigheter

Render använder den befintliga `DATABASE_URL`. Nya migrationer körs automatiskt
vid miljötjänstens första anrop. Saknas PostgreSQL i Render visas ett fel;
inget ärende sparas till serverminnet som reservlösning. Lokalt används
`.data/environment.sqlite` om ingen databasadress finns. Filen är ignorerad
av Git och kan flyttas med `JEROC_ENVIRONMENT_DB_PATH`.

Miljötjänstens tabeller: `jeroc_environment_meta`, `credentials`, `sessions`,
`classifications`, `drafts`, `receipts`, `corrections`, `inventory`, `reports`, `requests`, `audit`
(alla med prefix `jeroc_environment_`). Entiteterna sparas som versionsbara
JSON-objekt med separata primärnycklar; mottagningens käll-ID och
mottagning/artikel för lager och rapport har databasunika begränsningar.
Skrivtransaktioner låser metadataraden så att två serverprocesser inte
registrerar samma mottagning. Snapshot och SHA-256-hash fryser parter, platser,
vikter och den aktuella artikelklassificeringen.

Nya behörigheter är **Läsa miljöunderlag och mottagningar**,
**Registrera faktisk mottagning och miljöuppgifter** och
**Ändra artiklars miljöklassificering**. Servern kontrollerar miljösession,
behörighet och tillåtna anläggningar. Sessionstoken lagras hashat, cookie
HttpOnly/SameSite och skrivningar har CSRF-skydd. Klientens förväntade faktisk/
utförande identitet jämförs med cookien för att stoppa felaktig användare vid
kontobyte i en annan flik. Den äldre testlösenordsrutten finns för regression
och stängd automatisk demoanslutning; lösenord lagras med salt och scrypt.
Systemadmins Jobba som sparar faktisk och utförande identitet separat.
Miljöåtkomst kräver inte rätt att se priser eller bankuppgifter.

Kontorets övriga demoinloggning och användaradministration/prismotor är fortsatt
demofunktioner med delvis minnesbaserat användarregister. Den automatiska miljödemosessionen
gör inte hela den befintliga appen produktionssäker. Den kan stängas av med
`JEROC_DEMO_AUTO_SESSION=false`. Hemligheter och NVV-uppgifter används inte av
denna session eller skickas till klienten. Kundregister, ekonomiska
utkast, betalningsjournal, transportplanerare och gårdsappens/Expos egna kort
är fortsatt lokala där de var lokala tidigare. De nya miljöentiteterna och
terminalernas kundgodkännanden delas via databasen.

## Engångsåterställning av invägningarnas testdata

Användaren godkände uttryckligen att radera gamla testinvägningar. Generation
`demo-weighings-2026-10-09-v2` ersätter webbläsarens gamla kort samt deras
betalningar/rättelser med fyra nya kort **2050–2053**. Alla börjar som
**Ny invägning** eller **Behöver kompletteras**, utan kundgodkännande,
ID-verifiering, attest eller utbetalning. Tidigare seedad ekonomisk volym tas bort.

Terminaldatabasens gamla avräknings-/godkännandesessioner och deras kortanknutna
utskicksförsök rensas under samma versionsmigrering. Terminalkonton, lösenord,
enhetssessioner och personliga förval bevaras. Miljödatabasens motsvarande
generationsmigrering bevarar klassificeringar och konton. Gamla lokala kunder,
användare, priser och transportdata återställs inte av denna migration.

Migreringen körs en gång per lager/webbläsare. Senare kort och godkännanden
bevaras vid omladdning och omstart. Det vanliga **Återställ kontorsdemo** är
fortfarande en lokal återställning; det raderar inte gemensam miljödata.
En redan registrerad mottagning kan inte registreras igen för samma stabila
`sourceId`; återanvänd inte käll-ID:n för nya verkliga händelser.

## Frister, dokument och historik

Mottagningens datum är den faktiska händelsen, inte attestdatum. Beräkningen
använder Europe/Stockholm och svenska arbetsdagar/helgdagar. Anteckningsfrist
visas separat från rapportfrist; reportfristen utgår från när anteckningen
senast skulle vara gjord. Registreringstid flyttar inte en redan passerad frist.
Kundgodkännande eller betalning återställer inte fristen.

Etapp 1 skapar inkommande lagerposter för alla mottagna materialrader, och
miljöunderlag för de farliga artiklarna, utan dubblering. Ändrad
artikelklassificering ändrar inte en sparad mottagning.
Miljörättelser finns i uppföljningen 0.7.1: originalet är oföränderligt och
signade mängdskillnader sparas som egna lagerrörelser. Aktiva rapportunderlag
visar aktuell version; ersatta underlag ligger separat i historiken. Rättelser
får förkorta, men aldrig flytta fram, tidigare beräknade miljöfrister.
Utleverans, underskrifter och rapporteringsarbetare byggs i kommande separat
godkända etapper. Dokumentbilagor och riktig myndighetsleverans
är inte aktiverade nu.

## Adressmatchning och hushåll

Kommunlistan innehåller SCB:s 290 kommunkoder och källhänvisning. Backendens
Nominatim-adapter använder begränsad anropsfrekvens, timeout och cache. En
adress matchas endast med säker gata/husnummer och svensk kommun; tvetydiga
resultat eller driftfel ger komplettering, aldrig ett gissat kommunresultat.
Demon har tydligt märkta referenser för sina exempeladresser. Vid ändrad
ursprungsadress tas tidigare manuell kommunbekräftelse bort i utkastet.

En privatkund betyder inte automatiskt att platsen bara består av kommunkod.
NVV:s speciella hushålls-/okänd-platsformer beror på roll och faktiska
förhållanden. Den här demon använder fortfarande kompletta svenska platser;
ingen förenklad hushållspayload eller riktig API-leverans påstås vara verifierad.

## Utvecklingskontroll och säkerhetskopiering

Kör befintliga kontroller enligt `docs/office-demo.md` samt miljötjänstens
riktade servertester, `tests/environment.spec.ts` och
`tests/environment-compact.spec.ts`. PostgreSQL-test kan
aktiveras med `JEROC_TEST_DATABASE_URL` till en **separat testdatabas**.
Använd aldrig Render-demon eller en produktionsdatabas till regressionstester.

Repositoryts `backup()`/`restore()` är interna utvecklingsfunktioner med
struktur- och referenskontroll, inte öppna webbrutter. Backup innehåller
konton och sessionsuppgifter och ska skyddas. För Render används normala
PostgreSQL-backuper; lagra inga databasdumpfiler i Git. Om miljötabellerna
återställs ska samtliga relaterade tabeller återställas tillsammans.

Verifierat 2026-10-09: 85 servertester utan överhoppade tester, inklusive
PostgreSQL 18 mot en separat lokal testdatabas. Kontrollerna omfattar
idempotens, samtidiga mottagningar, behörigheter/anläggningar, omstart,
säkerhetskopiering/återställning, klassificeringsversioner och frister.
135 olika Playwright-kontroller är verifierade: hela sviten gav 134 godkända;
ett testexempel för ett låst kort saknade sin frysta kundsnapshot. Efter
rättning och normalisering av testexemplen passerade samtliga 16 kontroller
för kortvy, arbetsköer, uppdatering och kontorsflöde. Mobilflöde,
terminalgodkännande, intern attest, prisbehörigheter och transportplanering
ingår. Produktionsbygge och Expo-typkontroll passerade. Miljöpanelerna har
också granskats visuellt i webbläsaren.

Render verifierades efter publicering: det nya produktionsbygget visas,
miljöinloggning och läsning av gemensam databas svarar HTTP 200, klassificeringen
för blybatterier har kod `160601`, och mottagnings-/rapportköerna börjar tomma.
Verifieringssessionen avslutades. Ingen mottagning eller myndighetsleverans
skapades av denna kontroll.

## Uppföljning 0.7.1

Migration 002 lägger till utkast och rättelser utan att radera kort eller gamla
mottagningar. Ny kontrollsumma använder kanonisk JSON så att PostgreSQL:s
JSONB-nyckelordning inte ändrar hashen. Tidigare versioners lagrade hash behålls.

Verifierat i uppföljningen: 117 servertester, inklusive PostgreSQL 18 i separat
testdatabas, och samtliga 145 Playwright-kontroller. Utkast och optimistiska
konflikter, kanonisk adress, osäker kommun, valfritt dokumentnummer, dubletter
av materialrader, spårbar rättelse, prisändring utan fysisk effekt och kontobyte
i annan flik ingår. Äldre backup/hash-format bevaras och kan rättas till en ny
version. Produktionsbygge och Expo-typkontroll passerade. Kompakt miljökort
granskades visuellt utan sidöverflöde eller JavaScriptfel.
