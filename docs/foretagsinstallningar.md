# Företagsinställningar och anläggningarnas öppettider

Implementerad 20 oktober 2026 enligt ÄL 140. [Bildmockup och UI-beslut](mockups/foretagsinstallningar/README.md). Implementation återanvänder det befintliga kontorsgränssnittet.

## Hitta rätt

Öppna **Kontoret → Företagsinställningar** (`/kontor/#/company-settings`).

- **Företaget:** namn, postadress, telefon, publikt kundmejl, fakturamejl, kontaktperson och webbplats.
- **Logga & dokument:** uppladdad logga, dokumentförhandsvisning och sidfot. Organisationsnummer är bolagets låsta juridiska identitet.
- **Standardval:** betalningsdagar för nya kunder, eller tomt värde för integrationens standard. Sverige, SEK, svenska och Europe/Stockholm följer nuvarande systemstöd; inga språkval visas som om de vore översatta funktioner.
- **Aviseringar:** mottagarlistor för kundförfrågningar, bokningar och integrationsfel. Detta är lagrad konfiguration; inställningarna startar inte ett nytt mejlutskick eller någon leveranskö. Respektive framtida aviseringsflöde behöver anslutas uttryckligen.

Bank, bokföring, mejlkopplingar och behörigheter hanteras genom genvägar till befintliga arbetsytor. Uppgifterna dubbleras inte.

## Öppettider och lokala kontakter

Öppna **Anläggningar**, välj plats och redigera telefon, mejl samt öppettider. En dag kan vara **Ej angivet**, **Stängt** eller ha en eller flera öppna perioder, exempelvis 07.00–12.00 och 13.00–16.00. Datumavvikelser kan ange stängt eller särskilda tider för exempelvis en helgdag. Tider är lokala i Europe/Stockholm.

Inga tider eller helgdagar antas. Överlapp, ogiltiga datum och sluttid före start avvisas på servern. Uppgifterna följer anläggningens befintliga version och åtkomst. Äldre API-klienter som utelämnar fälten bevarar dem; uttryckligt återställande kan rensa tiderna.

Tiderna är administrativa uppgifter i den här leveransen. Ingen automatisk publicering till Google, kundportal, AI-kunskap eller schemaläggning sker.

## Behörighet, sparande och lagring

VD och systemadmin kan läsa företagsinställningarna. Andra användare behöver **Läsa företagsinställningar** eller **Ändra företagsinställningar**; ändringsrätten ger även läsrätt. Sparande kräver att både inloggad och vald användare har rätt att ändra och åtkomst till hela bolaget. En supportsession som arbetar som en begränsad användare får inte högre rättigheter av sin inloggade systemadmin.

Företagsinställningarna lagras i bolagets befintliga applikationsdatabas, under dess servervalda tenant. Varje sparande använder `expectedVersion` och registrerar ändrade grupper, båda användarna samt tid. Versionskonflikt behåller formulärets utkast tills användaren väljer att läsa om. API-anrop kontrollerar aktuell session och behörighet igen före mutation och svar.

`GET/HEAD /api/company-settings` och `POST /api/company-settings` hanterar hela profilen. `GET/HEAD /api/company-settings/defaults` lämnar endast bolagets namn, kundstandarder och eventuell logg-URL till autentiserade verksamhetsklienter; interna mottagarlistor och fakturakontakt lämnas inte via det anropet. Plattformsanrop för ändring kräver CSRF och aktuell bolagsgeneration.

## Logga och dokumenthistorik

Loggan laddas upp till `POST /api/company-settings/logo` och sparas i en separat beständig tabell `jeroc_company_logos`. PostgreSQL använder samma bolagsschema som övrig verksamhetsdata; lokal utveckling använder `JEROC_COMPANY_LOGO_DB_PATH` eller en fil bredvid bolagets applikationsdatabas.

PNG, JPEG och WebP upp till 1 MiB accepteras. Dekodning, pixelgräns, omkodning och borttagning av metadata sker på servern. SVG, fjärr-URL:er och animerade bilder accepteras inte. Bild-ID är oföränderligt och kontrolleras mot rätt bolag även om någon gissar en annan URL. Fullständig profil innehåller bara bildens ID, aldrig råa bildbytes.

En uppladdad logga väljs först när formuläret sparas. Befintliga bildversioner behålls eftersom frysta dokument kan referera till dem. Dokumentgenereringen använder dokumentets egen företagsprofil och loggversion. Saknad bild ersätts inte tyst med en ny logga eller ett annat bolags identitet.

## Google-adressprovet

Den rapporterade adresskontrollen kunde tidigare visa samma feltext för fel i Google-detaljer, saknade adressfält och ett nekat backendanrop. Dessa steg har nu skilda, begripliga meddelanden. Om Google nekar servernyckeln anges att API-aktivering, nyckel och Render-appens utgående IP-adresser ska kontrolleras. Råa Google-fel eller nycklar visas inte.

Detta förbättrar diagnosen men bevisar inte orsaken till ett visst misslyckat skarpt anrop. Gör ett nytt adressprov efter deployment och använd den specifika feltexten för fortsatt felsökning. Ingen adress fylls i utan serverkontroll och användarens bekräftelse.

## Deployment och verifiering

Inga nya externa API-nycklar behövs för företagsinställningar eller loggor. Deploya senaste commit för **scrapplanner-app**. En befintlig Render/PostgreSQL-installation skapar loggtabellen vid första användning. Nya lagringsfält är tillägg; befintliga underlag raderas inte.

Kontrollera med ett behörigt konto: spara profil, ladda upp logga, granska ett nytt underlag, skapa en ny kund med förvalt betalningsvillkor och ange öppettider på en anläggning. Kontrollera även ett äldre låst dokument efter profiländringen.

Automatiska tester använder isolerade databaser och syntetiska filer/API-svar. Riktiga Google-nycklar och Render-trafik kan inte verifieras av lokala tester.


### Automatiska kontroller vid leverans

- `npm run build`: passerar.
- Den samlade backendkörningen passerar 204 tester; tre befintliga PostgreSQL-prov är överhoppade eftersom separat testdatabas inte är konfigurerad här.
- 55 relevanta browserfall har verifierats för företagsinställningar, öppettider, betalningsförval, kundformulär och Google-feldiagnos. Testerna använder isolerade sessions-/API-fixturer.
- Verkliga gatewaytester omfattar CSRF, behörighet hos båda identiteterna, anläggningsbegränsningar, versionskonflikt, separata bolag, logg-ID från annat bolag och mobilens begränsade standardprojektion.
- PDF-proven omfattar bevarade frysta profiler även när PDF-kön varit otillgänglig och företagets inställningar ändrats innan filen genererats.

Exempel på provkommandon:

```sh
node scripts/build-domain-models.mjs
node --test server/company-settings*.test.mjs server/company-logo*.test.mjs server/facility-opening-hours.test.mjs server/environment-storage-rules.test.mjs server/documents.test.mjs server/document-hooks.test.mjs server/document-render.test.mjs server/document-worker.test.mjs
npx playwright test tests/company-settings.spec.ts tests/facility-settings.spec.ts tests/company-defaults.spec.ts tests/customer-form.spec.ts tests/customer-identity-office.spec.ts tests/mobile-customer-settings.spec.ts tests/address-assistance.spec.ts --workers=2
npm run build
```
