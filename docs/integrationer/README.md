# Integrationer – kontorsdemo 0.12.0

**Integrationer** finns i kontorets vänstermeny. Kortgrid och detaljvy återanvänder
kontorets design. Naturvårdsverket har den första TEST-adaptern. Spiris/Visma
eEkonomi, Fortnox, Microsoft 365/Outlook, BankID, SMS/e-post, Google Maps och
LME visas som planerade; ingen OAuth-session eller anslutning fabriceras.

NVV-inställningar ligger under **Integrationer → Naturvårdsverket**. Rapportkö,
rättelser och kvittenser ligger kvar under **Miljörapportering**.
Se [NVV:s provflöde och Renderinställningar](naturvardsverket/nvv-test-demo.md).
API-granskning, myndighetens oförändrade OpenAPI-definition och tidigare
mockupmatchning finns i [NVV:s anslutningsunderlag](naturvardsverket/README.md).
API-nycklar, lösenord, privata nycklar och leveransbrev förvaras separat
från dokumentationen och GitHub.

## Gemensam adaptergrund

`server/integrations.mjs` ger ett serverägt leverantörsregister med säkra
statusprojektioner, adapterkontroller och förberedda händelseidentiteter.
Det bygger inte en andra NVV-motor: NVV-adaptern återanvänder befintlig
beständig rapportering, inställningshistorik och anslutningskontroll.

- Varje adapteranrop får en ny betrodd kontext med organisation, inloggad
  och utförande användare samt läs-/administrationsrättighet.
- Organisationsmedlemskap kontrolleras före adapteranrop. En adapter kan
  bindas till bestämda organisationer; JEROC:s NVV-anslutning är bunden till
  `jeroc-demo` och får inte lämna dess inställningar till en annan organisation.
- Katalogen innehåller valda statusfält. API-hemligheter, token, certifikat,
  personuppgifter i rapportören och leverantörens råa fel lämnas inte där.
- Händelseförberedelsen skapar en nyckel per organisation, leverantör,
  händelse, objekt och version, samt hash av underlaget. Konflikthjälparen
  avvisar återanvänd nyckel med ändrat underlag. Den skickar inga händelser
  och ersätter inte en beständig utkorg.
- Läsning av katalogen och öppnande av ett kort ansluter aldrig automatiskt
  till en leverantör. Anslutningsprov och NVV-sändning är uttryckliga åtgärder.

Katalogen nås via `GET /api/environment/integrations/catalog`, en cookie-
autentiserad fasad över det fristående registret. Den kräver
`integrationsRead`; servern kontrollerar även sessionens aktuella användare.
`integrationsManage` förbereder administrationsrättigheten. Aktuella globala
NVV-inställningar kräver dessutom faktisk och utförande Systemadmin,
`environmentIntegration` och åtkomst till alla anläggningar.

## SaaS-gränsen

Den nuvarande demon har **en organisation** och demoautentisering för personal.
Servern tilldelar `jeroc-demo`; klientens query, JSON eller header får inte
välja organisation. Organisationsbundna anrop är testade i den gemensamma
motorn, men flera riktiga SaaS-kunder är inte aktiverade i resten av systemet.

Före SaaS-drift behövs riktiga användarsessioner/organisationsmedlemskap,
organisationsnycklar på berörda databasobjekt, isolerade dokument och
integrationers inställningar, krypterad tokenlagring samt leverantörernas
verifierade OAuth- och avtalsspecifika flöden. Varje sådan adapter ska använda
en beständig utkorg och journal, inte endast denna händelseförberedelse.
NVV:s nuvarande inställningar och Render-hemligheter är en organisations
anslutning och måste få tenantlagring innan flera kunder kan aktivera NVV.

Utbetalningar är fortfarande manuella. Denna leverans ansluter inte Visma,
Fortnox, Outlook, BankID, SMS/e-post, Google eller någon LME-leverantör.
