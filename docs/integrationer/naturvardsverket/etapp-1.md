# Etapp 1 – artikelmiljö och mottagning, kontorsdemo 0.7.0

Godkänd byggstart 2026-10-09. Den här etappen låter kontoret klassificera
artiklar och registrera en faktisk direktinlämning. Ingen anteckning skickas
till Naturvårdsverket och inga Visma-, bank- eller meddelandeanrop görs.

## Prova i kontoret

1. Öppna `/kontor` och välj Systemadmin. Under **Artiklar & priser**, öppna
   **Blybatterier**. Panelen **Miljö & avfallsklassificering** ligger under
   artikelns grunduppgifter. Inga bilder av blyblock används som batterireferens.
2. Aktivera den separata miljösessionen med det valda demokontots lösenord
   `JerocDemo2026!`. Kontona `admin`, `lars`, `kajsa` och `anna` har detta
   offentliga **testlösenord**. Det här verifierar ett demokonto och är inte
   en produktionsinloggning. Terminalkonto och miljökonto är olika kontotyper.
3. Kontrollera klassificeringen **Farligt avfall**, kod `160601`, beskrivning
   Blybatterier. Klassificering och eventuellt ADR-behov är olika uppgifter.
   Ändringar får en ny version; prisformlerna påverkas inte.
4. Öppna invägning **2050**: 250 kg blybatterier och 12 kg koppar. Öppna
   **Miljö & mottagning**. Ange verklig mottagningstid, tidigare innehavare,
   kontaktuppgifter, senaste/kommande adress med postnummer och kommunkod.
   Tidigare avfallsinnehavare kan skilja sig från avräkningens kund.
5. Ange inkommande transportdokumentets referens eller dokumentera varför
   dokument saknas. En referens är inte en uppladdad eller undertecknad PDF.
   Ett saknat dokument blir en avvikelse och skapar inget bakdaterat dokument.
6. Registrera mottagningen. Öppna **Miljörapportering**. Underlaget, fysisk
   lagermängd och frister ska vara kvar vid omladdning och i en andra webbläsare.
   Kopparraden bildar inget farligt-avfallsunderlag. Utskick är avstängt.
7. Prova kundgodkännande på terminal och separat intern attest på samma kort.
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
`classifications`, `receipts`, `inventory`, `reports`, `requests`, `audit`
(alla med prefix `jeroc_environment_`). Entiteterna sparas som versionsbara
JSON-objekt med separata primärnycklar; mottagningens käll-ID och
mottagning/artikel för lager och rapport har databasunika begränsningar.
Skrivtransaktioner låser metadataraden så att två serverprocesser inte
registrerar samma mottagning. Snapshot och SHA-256-hash fryser parter, platser,
vikter och den aktuella artikelklassificeringen.

Nya behörigheter är **Läsa miljöunderlag och mottagningar**,
**Registrera faktisk mottagning och miljöuppgifter** och
**Ändra artiklars miljöklassificering**. Servern kontrollerar miljösession,
behörighet och tillåtna anläggningar. Lösenord sparas med salt och scrypt;
sessionstoken hashat, cookie HttpOnly/SameSite och skrivningar har CSRF-skydd.
Systemadmins Jobba som sparar faktisk och utförande identitet separat.
Miljöåtkomst kräver inte rätt att se priser eller bankuppgifter.

Kontorets övriga demoinloggning och användaradministration/prismotor är fortsatt
demofunktioner med delvis minnesbaserat användarregister. Personliga testlösenord
gör inte hela den befintliga appen produktionssäker. Kundregister, ekonomiska
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
Miljörättelse, utleverans, underskrifter och rapporteringsarbetare byggs i
kommande separat godkända etapper. Dokumentbilagor och riktig myndighetsleverans
är inte aktiverade nu.

## Utvecklingskontroll och säkerhetskopiering

Kör befintliga kontroller enligt `docs/office-demo.md` samt miljötjänstens
riktade servertester och `tests/environment.spec.ts`. PostgreSQL-test kan
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
