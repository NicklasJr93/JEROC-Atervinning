# Spiris / Visma eEkonomi – sandbox i JEROC

Kontorsversion 0.15.2, 2026-10-11. Anslutningen är ett uttryckligt
testverktyg för systemadmin. Den exporterar inte viktkort eller riktiga
betalningar automatiskt. [API-fält och källor](api-testfalt.md) beskriver
leverantörer, konteringsrader och fakturautkast.

## Inställningar i Render

Öppna **JEROC-Atervinning → Environment → Edit → Add Environment Variable**.
Lägg upp följande uppgifter och spara med omstart/deploy:

| Key | Value |
| --- | --- |
| `VISMA_ENVIRONMENT` | `sandbox` |
| `VISMA_CLIENT_ID` | Klient-ID för er svenska Spiris-sandboxklient. |
| `VISMA_CLIENT_SECRET` | Klienthemligheten för samma sandboxklient. |
| `VISMA_REDIRECT_URI` | `https://jeroc-atervinning.onrender.com/api/integrations/visma/oauth/callback` |
| `VISMA_TOKEN_ENCRYPTION_KEY` | En slumpmässig 32-byte-nyckel kodad som base64. |
| `VISMA_SANDBOX_COMPANY_ID` | Testföretagets exakta `CompanyIdentifier`. Kan läggas till efter första anslutningen nedan. |

Registrera **exakt samma returadress** hos Spiris för sandboxklienten, utan
`#` eller tillägg. Spiris användarkonto/testföretag och utvecklarklient är
olika uppgifter: OAuth godkänner vilket företag klienten får åtkomst till.
Använd endast sandboxklientens credentials. Spiris använder samma API- och
inloggningsadresser för test och produktion.

Det mottagna onboardingmejlet anger fortfarande
`https://localhost:44300/callback`. Den kan användas med det tillfälliga
localhostläget nedan. För automatisk retur till Render: be `api@spiris.se`
registrera Render-adressen ovan för klient-ID:t från mejlet. Att enbart
ändra Render-fältet ändrar inte Spiris registrering. För denna klient används dess beviljade
scopes `ea:api offline_access ea:purchase ea:accounting ea:sales`.
`vls:api` behövs inte för de aktuella testerna. API-verktygets fasta
operationslista begränsar vad JEROC kan göra trots dessa bredare scopes.

Krypteringsnyckeln kan genereras i Render Shell med `openssl rand -base64 32`.
Kopiera den direkt till Render-fältet och förvara den i er lösenordshanterare.
Nyckeln behöver bevaras tillsammans med databasen för att kunna läsa sparade
token efter en återställning. Ett nyckelbyte kräver återanslutning; byt inte
nyckeln vid varje deploy. Klienthemligheten, nyckeln och OAuth-token ska inte
läggas i GitHub eller skickas i chatten.

Den befintliga `DATABASE_URL` används. Anslutningen och testhistoriken sparas
i en separat integrationsdomän i PostgreSQL. Befintliga kunder, viktkort,
miljömottagningar och attester ändras inte av testverktyget.

## Tillfälligt test med befintlig localhostadress

I kontorsdemo 0.15.1 kan den redan registrerade adressen användas utan lokal
server. Ändra följande i **Render → webbtjänsten JEROC-Atervinning →
Environment → Edit** och spara med deploy:

| Fält | Värde |
| --- | --- |
| `VISMA_ENVIRONMENT` | `sandbox` |
| `VISMA_REDIRECT_URI` | `https://localhost:44300/callback` |
| `VISMA_OAUTH_LOCAL_RELAY` | `true` |

Klient-ID, klienthemlighet och krypteringsnyckel använder de befintliga
Render-fälten. Läget tillåter bara just denna HTTPS-adress, port och sökväg.

1. Öppna `/kontor/integration/systemadminvismatest.html` som Systemadmin.
2. Tryck **Anslut Visma sandbox**, logga in hos Spiris, välj **testföretaget**
   och godkänn åtkomsten.
3. Webbläsaren försöker öppna localhost. Ett anslutningsfel är väntat när
   ingen lokal server körs. Kopiera **hela adressen ur adressfältet**,
   inklusive `code` och `state`, och öppna JEROC-testsidan igen i samma
   webbläsarprofil. Byt inte konto eller session under anslutningen.
4. Klistra in den i **Returadress från Spiris** och tryck **För över svaret
   till JEROC**, sedan **Slutför anslutning**. Gör detta inom fem minuter
   efter Spiris-godkännandet; annars börja om med en ny anslutning.
5. Ange och verifiera `VISMA_SANDBOX_COMPANY_ID` enligt nästa avsnitt.

Svaret förs genom webbläsaren till JEROC:s fasta callback så att dess
ursprungliga HttpOnly-cookie följer med. Servern kontrollerar engångs-state,
browserbindning, PKCE och samma aktiva adminsession. Både auktorisering och
tokenutbyte anger **den registrerade localhostadressen**. Render-adressen
är en intern mottagare för vidarebefordran, inte en ny OAuth redirect URI.
Formuläret sparar inte den inklistrade adressen i webbläsarlagring eller
testhistorik. Adressen innehåller en kortlivad engångskod; dela den inte.

Efter anslutningen sköts API-anrop och tokenförnyelse helt av Render.
Manuell vidarebefordran behövs igen om en ny inloggning krävs. När Spiris
har registrerat den normala Render-adressen: sätt `VISMA_REDIRECT_URI` till
den och ta bort `VISMA_OAUTH_LOCAL_RELAY` (eller sätt `false`). Detta
lokala provflöde är verifierat med fejkade providersvar. Användaren har
också bekräftat att den verkliga sandboxinloggningen fungerar.

## Anslut testföretaget

1. Logga in som **Systemadmin**, arbeta som samma konto och använd åtkomst
   till alla anläggningar.
2. Öppna **Integrationer → Spiris / Visma eEkonomi → Öppna Spiris-test** eller
   `/kontor/integration/systemadminvismatest.html`.
3. Tryck på anslutningsknappen och välj det svenska **testföretaget** i Spiris.
   Godkänn den begärda åtkomsten. Inloggningen sker hos Spiris; JEROC tar
   inte emot Spiris användarlösenord.
4. Efter retur till JEROC trycker du på **Slutför anslutning** med samma
   aktuella systemadminsession. Företagsuppgifterna visas på testsidan.
5. Kopiera företagets visade `CompanyIdentifier` till
   `VISMA_SANDBOX_COMPANY_ID` i Render och spara. Kontrollera även namn och
   organisationsnummer mot ert kända testföretag.
6. Uppdatera testsidan och kör **Läs företagsidentitet** för att verifiera
   det nya Render-fältet. Företagskontrollen måste matcha innan andra
   testoperationer blir tillgängliga. Saknat eller avvikande ID ska ge en
   komplettering, aldrig ett skickande till ett annat företag.

OAuth använder engångs-state, PKCE S256 och en tillfällig browserbindning.
Returen byter inte automatiskt token eller skapar ett utkast genom ett GET.
Access- och refresh-token lagras krypterade på servern och visas inte i
formulär, diagnospopup eller anropshistorik.

## Testa från ett attesterat viktkort

Version 0.15.2 använder befintlig Render-konfiguration. På testsidan:

1. Välj **Attesterat viktkort**. Endast senaste kundgodkända och internt
   attesterade versionen är valbar. Förifyllningen läser dess frysta uppgifter,
   inte dagens kund- eller artikelregister. Kortvalet skickar inget till Spiris.
2. Tryck **Hämta Spiris-val** för att läsa inköpsbetalvillkor, leverantörer,
   räkenskapsår och kontoplan. Egna ifyllda fält bevaras. Om inget öppet år
   täcker fakturadatumet behöver rätt år väljas med det vanliga kontoplanstestet.
3. Granska leverantörsfälten. Ett entydigt leverantörsnummer eller
   organisationsnummer kan koppla en redan hämtad leverantör. Om en ny
   behövs, välj **Skapa testleverantör** och skicka uttryckligen. Dess faktiska
   svar-ID förs in i utkastet; utkastet skickas inte av detta klick.
4. Granska **Leverantörsfakturautkast**: avräkningsnummer, datum, hela
   inköpsbeloppet, moms och debet/kredit. Aktiva 4000/2440 kan föreslås från
   kontoplanen, men är inte en fastställd momskontering. Företagsinköp
   behöver ett uttryckligt momsbelopp. Privatpersonens personnummer överförs
   inte som organisationsnummer. Kvittning mot tidigare saldo visas separat
   och behöver senare egen bokföring; fakturabeloppet minskas inte av den.
5. Skicka utkastet med testknappen och granska faktisk begäran och svar i
   integrationspopupen. Läs tillbaka resursen med dess returnerade ID.

Den lokala testhistoriken kopplar försöket till attest-ID, version och
kontrollsumma. Servern kontrollerar att versionen fortfarande är attesterad
före sändning. Dessa källreferenser följer inte med som extra Spiris-fält.
PDF-bilaga och automatisk export efter attest byggs i en senare etapp.
Inget av detta bokför fakturan eller utför betalning.

## Prova fria API-fält

1. Läs **företagsuppgifter**, **betalvillkor** och **räkenskapsår**. Välj ett
   riktigt räkenskapsårs-ID för att läsa dess kontoplan. Dessa är läsanrop.
2. Skapa en fiktiv leverantör med namn och ett faktiskt betalvillkors-ID där
   `AvailableForPurchase` är sant. Orgnummer, adress och e-post är valfria
   testfält enligt API-kontraktet. Privatperson använder samma
   leverantörsmodell; det finns ingen påhittad person-/företagsflagga.
3. Ta leverantörens **faktiska ID från svaret** och sätt det i ett nytt
   fakturautkast. Ange konteringsrader utifrån testföretagets kontoplan.
   `AccountNumber` är kontonumret, inte kontots UUID. Kontrollera belopp,
   moms och debet/kredit i den redigerbara JSON-förhandsvisningen.
4. Skicka med ett uttryckligt klick. Den befintliga integrationsdialogen
   visar den frysta begäran, HTTP-status och faktiskt råsvar. Råsvaret visas
   efter borttagning av credentials och token; övriga API-fel bevaras.
5. Läs tillbaka skapad leverantör eller utkast med dess ID. Historikens
   visning och återfyllning skickar inget nytt POST.

Tillåtna operationer är fast definierade: företagsuppgifter, räkenskapsår,
kontoplan, betalvillkor, leverantörslista, en leverantör, ett fakturautkast,
skapa leverantör och skapa fakturautkast. Det finns ingen fri URL, inga
klientvalda Authorization-header och ingen bokförings-, konverterings- eller
betalningsoperation i detta verktyg.

Varje försök får en beständig reservation och ett fryst underlag före API-
anropet. Vid timeout eller avbrott kan ett POST ha genomförts trots att
svaret saknas. Resultatet visas då som **oklart**. Kontrollera historiken och
testföretaget innan ett nytt försök; verktyget skickar inte automatiskt om
ett sådant skrivförsök. Ett upprepat request-ID med samma underlag hämtar
det gamla försöket i stället för att skapa en dublett.

Webbläsaren bevarar också det pågående försökets ID och frysta testfält per
faktisk/effektiv användare vid omladdning. Ett oklart skrivförsök hindrar nya
skrivtester men tillåter läsanrop för kontroll. När du har kontrollerat
testföretaget kan du markera **Jag har kontrollerat testföretaget** i
historiken. Markeringen skickar inget anrop och ändrar inte det okända
resultatet. Den bevaras i den aktuella webbläsarsessionen, med datum, och
tillåter ett nytt uttryckligt test med ett nytt ID.

## Nästa etapp

Efter verifierat sandboxbeteende kan vi bygga automatisk export av en
attesterad avräkning med PDF, beständig leverantörsmappning, fastställd
kontering och externa referenser.
Spiris bankkoppling är ett separat avtal och flöde. En lyckad sandboxkontroll
eller ett sparat fakturautkast är inte bevis på att en betalning utförts.
