# JEROC Personal – kontorsdemo 0.9.0

Implementerat 2026-10-09 enligt de godkända [personalmockuperna](mockups/personal/README.md).
Utseendet följer befintliga kontoret. Formulären är funktionella och sparas med
samma PostgreSQL-anslutning som resten av verksamhetsdemon.

- [Personal](https://jeroc-atervinning.onrender.com/kontor#/personnel)
- [Bemanning att lösa](https://jeroc-atervinning.onrender.com/kontor#/personnel/tasks)
- [Extern chaufförsinloggning](https://jeroc-atervinning.onrender.com/chauffor)

## Personalregistret och personkortet

Logga in på kontoret som **Systemadmin** och öppna **Personal**. Sök på namn,
befattning, företag eller kompetens. Filtrera på anställd/extern, team och
anläggning. Den övergripande anläggningsväljaren gäller också.

**Lägg till person** registrerar kontaktuppgifter, team, chef/gruppledare och
tillåtna anläggningar. Anställda kan kopplas till ett befintligt användarkonto;
personprofilen skapar inte en extra kopia av det kontot. En person kan finnas
utan inloggning. Befattning, personprofil, förarprofil och systembehörigheter är
separata uppgifter.

**Kan bokas som förare** kopplar personen till transportplaneringen. Välj ett
registrerat ordinarie fordon. Befintliga förar-ID:n bevaras, så arbetsordrar och
spårbarhet fortsätter att tillhöra samma person. Inaktiva personer bevaras och
kan visas med **Visa även inaktiva personer**.

Personkortets **Översikt** visar kontakt och organisation, kommande uppdrag,
kompetensvarningar och bemanningsuppgifter. **Anställning** har anställningsform,
start/slutdatum, sysselsättningsgrad och veckoarbetstid. Befattning och
anställningsnummer redigeras på personprofilen. Lönepanelen har månadslön/timlön,
belopp, giltighetsdatum, kommande lönerevision och notering. Demolönerna är
fiktiva; ingen lön betalas ut.

## Behörigheter

| Rättighet | Användning |
| --- | --- |
| `personnelRead` | Öppna personalregistret och personkort |
| `personnelWrite` | Ändra person, åkeri, förarprofil och arbetsschema |
| `employmentRead` / `employmentWrite` | Läsa / ändra anställning |
| `salaryRead` / `salaryWrite` | Läsa / ändra lön |
| `absenceRead` / `absenceWrite` | Läsa frånvaroorsak / registrera och återkalla frånvaro |
| `competenciesWrite` | Registrera och verifiera kompetenser |
| `staffingWrite` | Kontrollera och tilldela ersättare |
| `externalAccounts` | Hantera externa chaufförsinloggningar |
| `users` | Koppla/lossa befintliga personalanvändarkonton |
| `transportPlan` | Krävs även när ersättare tilldelas arbetsordrar |

Lön och frånvaroorsak kräver uttrycklig rättighet även för VD. Systemadmin kan
administrera dem. Servern filtrerar skyddade uppgifter före leverans till
webbläsaren och kontrollerar skrivåtgärder. Utan rätt att läsa frånvaroorsak
visas fortfarande att personen är otillgänglig, utan orsaken. Personal och
bemanningsuppgifter begränsas av användarens tillåtna anläggningar.

## Schema → frånvaro → ersättare

**Schema & frånvaro** visar veckokalender med arbetspass, obetald rast,
transportuppdrag och frånvaro. Veckor kan bläddras. Återkommande arbetspass anger
veckodagar, klockslag, rast och giltighetsperiod. Överlappande schemaperioder
avvisas; ändra befintligt pass eller avsluta dess period före en överlappande ny.

Prova hela kedjan:

1. Öppna **Kalle Nilsson → Schema & frånvaro**. Välj veckan med de nya
   exempeluppdragen **AO-1201–AO-1203**, normalt nästa måndag efter demosådden.
   Dessa exempel kompletterar tidigare arbetsordrar utan att ersätta dem.
2. Tryck **Registrera frånvaro**. Välj typ, datum, hel/del av dag och ansvarig.
   Ingen diagnos registreras.
3. **Kontrollera påverkan** visar faktiskt bokade uppdrag som berörs. Ändras
   formuläret måste påverkan kontrolleras igen.
4. Bekräfta registreringen. Bokningarna behåller kund, tid och arbetsorder.
   Personen blir otillgänglig och ansvarig får gemensamt lagrade
   bemanningsuppgifter. Planeraren visar frånvaro och varnar på berörda bokningar.
5. Öppna **Bemanning att lösa**. Välj ett, flera eller alla visade uppdrag.
   **Välj ersättare** kontrollerar arbetstid, rast, frånvaro, överlappande uppdrag,
   fordonets kärltyper och obligatoriska kompetenskrav för uppdragens datum.
6. Otillgängliga eller obehöriga kandidater är spärrade med förklaring. Välj en
   tillgänglig kandidat, exempelvis Lina när hon uppfyller kraven, och tilldela
   uppdragen. Servern gör om kontrollerna i den gemensamma transaktionen.
7. Uppgifterna hamnar i **Historik**. Tider, kunder och arbetsordrar bevaras;
   Kalles frånvaro ligger kvar. Kontrollera förarbytet i planeraren och efter
   omladdning.

**Återkalla** tar bort frånvarons tillgänglighetsblockering. Uppdrag som fått
ersättare flyttas inte tillbaka automatiskt. Sjukfrånvaro raderar aldrig bokningar.
Ny eller ändrad transportbokning kontrolleras mot samma personalmodell. Restid
och ruttoptimering ingår inte.

## Kompetenser och fordonsbehörighet

Körkort, YKB, ADR, arbetsgivarens körtillstånd och övriga kompetenser lagras
separat, med omfattning/behörighetskoder, giltighet och personalverifiering.
Ej verifierade, ännu ej giltiga eller utgångna kompetenser uppfyller inte
obligatoriska uppdragskrav. Översikten visar sådant som behöver förnyas.

Exempel på kravkoder: `license:CE`, `ykb:goods`, `adr:packages`. Krav kan anges på
arbetsorder och fordon i planeraren. Farligt avfall innebär inte automatiskt
ADR-krav; uppdragets faktiska krav ska bedömas och registreras separat.

## Extern chaufför och åkeri

En extern person kopplas till åkeri och förarprofil. Anställning/lön hos åkeriet
registreras inte i JEROC. Åkerier kan läggas till från personformuläret.

1. Öppna **Oskar Lind → Hantera inloggning**. Ange användarnamn och nytt lösenord,
   spara och lämna testuppgifterna till den som ska prova. Inget standardlösenord
   eller återställningsmejl skickas.
2. Öppna **/chauffor** på separat mobil/webbläsare och logga in.
3. Boka/tilldela en arbetsorder till föraren i planeraren. Chaufförsvyn visar
   endast egna uppdrag inom åkerikopplingen, med plats och kontakt. Obokat önskat
   datum visas som önskemål; bokad tid visas separat.
4. På bokade uppdrag går det att ange **Jag är på väg**, därefter **Markera
   uppdrag som klart**. Förändringarna sparas gemensamt.
5. Admin kan sätta nytt lösenord eller avaktivera kontot. Tidigare sessioner
   avslutas vid kontoändring. Konto utan uppdrag visar ett tomt läge.

Den externa tjänsten har serverkontrollerad cookie-session, hashade lösenord,
begränsade sessioner och inloggningsförsökskontroll. Den returnerar inga löner,
personalregister, priser eller andra förares uppdrag. Dokumentuppladdning och
transportdokumentkomplettering/fullständigt åkeriportalflöde byggs senare.

## Lagring och demogränser

Personal, scheman, frånvaro, kompetenser, bemanning och externa konton/sessioner
lagras i verksamhetsdatabasen under domänerna `personnel` och `personnelAuth`.
PostgreSQL använder befintlig `DATABASE_URL`. Modulen sås en gång om den saknas.
Befintliga kunder, viktkort, användare, förare och bokningar raderas inte. Se även
[Gemensam PostgreSQL](shared-postgres.md).

HR-uppgifterna är testdata. Kontorets valbara demokonton och demoidentiteter är
fortfarande inte produktionsautentisering. Använd inte verkliga löner eller
känsliga personaluppgifter i demot. Chaufförernas separata autentisering ändrar
inte denna begränsning för kontorsdelen.

Utrustning, personaldokument, profilfoto, separat historikvy, rekrytering,
löneutbetalning, avancerad löneberäkning och HR-integrationer är uppskjutna.
Backup/återställningsmotor är separat planerad. Inga NVV-, Visma-, BankID-, bank-,
SMS- eller e-postöverföringar aktiveras här.

## Utveckling och verifiering

`npm run build` kompilerar delade modeller och kontors-/mobilwebben. Serverns
personalkontroller finns i `server/personnel.test.mjs`; PostgreSQL-kontroller
använder endast `JEROC_TEST_DATABASE_URL` och isolerade testscheman. Browserflöden
kontrollerar frånvaro, bemanning, återläsning och chaufförsinloggning mot lokal
testlagring. Tester får inte köras mot Renderdatabasens driftdata.
