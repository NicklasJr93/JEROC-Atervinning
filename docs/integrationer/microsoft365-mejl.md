# Microsoft 365 / Outlook – första mejlversionen

Levererad i kontor **0.25.0**, ÄL 112. Kopplingen läser riktiga inkorgar via
Microsoft Graph efter användarens Microsoft-inloggning. Google/Gmail följer senare.

## Det som finns

- **Integrationer → Microsoft 365 / Outlook:** anslut flera Microsoft-konton,
  lägg till delade brevlådor och välj vilka användare som får läsa varje inkorg.
- **Inkomna mejl:** gemensam inkorg, filter per brevlåda, sökning, olästfilter,
  mejldetalj och bilagornas namn/storlek. Länk till originalet i Outlook.
- Avsändarens normaliserade e-postadress matchas exakt mot företagets kundregister.
  En träff visar ett kompakt kundkort med kontaktuppgifter och länk till kunden.
  Flera träffar visas som val. Behörighet och anläggningsåtkomst kontrolleras före
  kunduppgifter lämnas ut; bankuppgifter och personnummer ingår inte.
- En röd notis visar olästa **synkroniserade** mejl enligt Outlook. De senaste
  50 mejlen i varje inkorg hämtas vid uttrycklig synkning. Om fler finns visas
  en markering att antalet gäller den hämtade delen. Sökning gäller dessa mejl.
- Läsa mejl kräver `mailRead` samt inkorgsåtkomst. Hantera anslutningar kräver
  VD/systemadmin, integrationsbehörigheter och åtkomst till samtliga anläggningar.
  Ett gammalt VD-konto kan behöva få **Läsa inkomna mejl i tilldelade inkorgar**
  aktiverat under Personal → Konton. Medarbetare tilldelas både rättigheten och inkorgen.

Första versionen ändrar inte Outlooks lässtatus, skickar inga svar och skapar
inga arbetsordrar från mejl. AI-förslag, svar och Google finns kvar i planeringen.
Microsofts och de delade brevlådornas egna rättigheter gäller också.

## Registrera Microsoft-appen

1. Öppna [Microsoft Entra](https://entra.microsoft.com/) → **App registrations**
   → **New registration**. Namnge appen exempelvis **ScrapPilot Mail**.
2. För den gemensamma SaaS-appen, välj konton från valfri organisationskatalog
   (**Accounts in any organizational directory**). För en app som endast gäller
   ert Microsoft-bolag kan en ensam tenant användas med tenant-ID enligt nedan.
3. Lägg till plattform **Web** med exakt returadress:

   ```text
   https://jeroc-atervinning.onrender.com/api/integrations/microsoft-mail/callback
   ```

4. Under **API permissions → Microsoft Graph → Delegated permissions**, lägg till
   `User.Read`, `Mail.Read`, `Mail.Read.Shared` samt inloggnings-/sessionsrättigheterna
   `openid`, `profile`, `offline_access`. Appen använder användarens egen åtkomst;
   application permissions används inte. Microsoft-administratören godkänner
   de begärda rättigheterna när organisationens policy kräver det.
5. Kopiera **Application (client) ID**. Under **Certificates & secrets**, skapa
   en klienthemlighet och kopiera dess **Value**, inte dess Secret ID.

## Render → Environment

| Variabel | Värde |
| --- | --- |
| `MICROSOFT_MAIL_CLIENT_ID` | Appens Application (client) ID. |
| `MICROSOFT_MAIL_CLIENT_SECRET` | Klienthemlighetens **Value**. |
| `MICROSOFT_MAIL_TENANT_ID` | Valfritt. Standard `organizations` för multitenant-appen. Ange Directory (tenant) ID för en single-tenant-app. |
| `MAIL_REDIRECT_URI` | Valfritt i Render. Den exakta HTTPS-returadressen ovan räknas annars ut från `RENDER_EXTERNAL_URL`. |
| `MAIL_TOKEN_ENCRYPTION_KEY` | Valfri separat 32-byte nyckel i base64. Befintlig giltig `VISMA_TOKEN_ENCRYPTION_KEY` återanvänds när denna variabel inte finns. |

Spara och deploya. Inga klienthemligheter eller mejllösenord ska fyllas i i
kontorsappen. Under Integrationer visas saknad konfiguration tills servern är klar.

## Prova efter deploy

1. Öppna **Integrationer → Microsoft 365 / Outlook** och välj **Anslut Microsoft 365**.
2. Välj Microsoft-kontot och godkänn den begärda läsåtkomsten. Du återvänder
   till samma bolag och integrationskort.
3. Kontots primära inkorg finns nu. Lägg vid behov till en delad brevlåda genom
   att välja det anslutna kontot och ange brevlådans adress. Microsoft kontrollerar
   att det anslutna kontot verkligen har åtkomst.
4. Tilldela personalens läsåtkomst och välj **Synka inkorgar**, eller öppna
   **Inkomna mejl** och uppdatera där.
5. Öppna ett mejl från en avsändare som har samma e-postadress på ett kundkort.
   Kontrollera kundsammanfattningen och öppna kunden från den.

Använd en inkorg ni avser att ansluta. Microsoft Graph har inte en generell
offentlig mejlsandbox; det levande provet gäller kontot som användaren godkänner.

## Lagring och verifiering

Anslutningar, krypterade tokens, inkorgsbehörigheter och begränsad mejlmetadata
sparas i det egna bolagets privata PostgreSQL-domän `mailIntegration`.
Mejlkroppar läses vid öppning och lagras inte. Tokens använder AES-GCM med
bolags-/anslutningsbunden AAD; OAuth använder PKCE och engångsstate bunden till
den faktiska användaren, den valda rollen och plattformssessionen.
Generiska kontors-/mobilprojektioner innehåller inte mejldomänen.

Kod, isolering, callback, Microsoft-protokoll och vyer är verifierade lokalt med
kontrollerade svar. Ett riktigt Microsoft-prov återstår tills Entra-uppgifterna
har lagts in och användaren har loggat in och godkänt anslutningen.
44 riktade serverkontroller, 17 regressionskontroller och 6 browserfall passerar,
liksom produktionsbygget och Expo-typkontrollen. En befintlig PostgreSQL-kontroll
av tenant-scheman är villkorligt hoppad eftersom en isolerad testdatabas saknas;
gatewayens riktiga lokala SQLite-/cookiescenario är kört.

Källor: [Microsofts authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow),
[Graph – lista mejl](https://learn.microsoft.com/en-us/graph/api/user-list-messages),
[Graph – delade inkorgar](https://learn.microsoft.com/en-us/graph/outlook-share-messages-folders),
[Graph – immutable ID](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).
