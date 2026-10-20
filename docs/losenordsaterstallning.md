# Glömt lösenord – kontoret och systemadmin

Återställning finns på kontorets inloggningssida och använder systemets befintliga Resend-anslutning. Den första leveransen omfattar plattformens systemadmin och bolagens centralt registrerade VD-konton. Personalkonton i mobilappen samt chaufförs-, åkeri- och kundportalerna har egna kontoregister och ingår ännu inte.

## Användarens flöde

1. Välj **Glömt lösenord?** och ange kontots registrerade e-postadress. Om flera konton delar adressen kan även **Användarnamn (valfritt)** fyllas i, exempelvis `admin` för plattformskontot.
2. Formuläret ger samma besked för kända, okända och inaktiva konton. Det visar inte om någon viss person har ett konto.
3. Ett mejl från **ScrapPlanner <noreply@scrapplanner.com>** innehåller en länk som gäller i 30 minuter. Inga lösenord skickas i mejl.
4. Öppna länken, välj ett nytt lösenord med 12–200 tecken och bekräfta det. Att bara öppna länken ändrar ingenting; e-posttjänsters länkskanning förbrukar den inte.
5. Efter lyckat byte är länken förbrukad, tidigare sessioner avslutas och användaren loggar in på nytt. Kontots bolag och behörigheter ändras inte.

Adress och lösenord kan inte väljas via ett annat bolags kontaktinställningar. Systemadmin återställs genom sin egen återställningsadress, även när kontot tidigare har arbetat i ett kundbolag.

## Render

I **scrapplanner-app → Environment**:

- `RESEND_API_KEY`: den befintliga fungerande systemnyckeln används även här.
- `APP_URL`: `https://app.scrapplanner.com`. Servern bygger länken från denna betrodda adress, aldrig från anropets `Host` eller användarens formulär.
- `SCRAPPLANNER_PLATFORM_ADMIN_EMAIL`: ange den e-postadress som ska få återställningslänkar för plattformens systemadmin. Det är en separat uppgift från publikt kontaktmejl och bolagens adresser. Start utan värdet fungerar fortsatt, men ett adminkonto utan registrerad adress kan inte återställas via mejl.

Efter ändrad adminadress och deploy uppdateras det befintliga adminkontots återställningsadress utan att lösenord eller behörigheter byts. Om flera plattformsadministratörer skulle finnas måste adresserna hanteras individuellt; den gemensamma bootstrapinställningen får inte tilldelas godtyckliga konton.

VD-konton använder den e-postadress som angavs när bolaget skapades. En delad e-postadress väljer aldrig ett godtyckligt konto: ange även rätt användarnamn. Konton som saknar registrerad adress behöver hjälp av systemadmin.

## Säkerhet och lagring

Engångslänken använder en kryptografiskt slumpad token med 256 bitar. Bara dess hash lagras i det beständiga plattformsregistret. Posterna binds till det aktuella kontot, e-postadressen och lösenordsversionen. Ett senare lösenordsbyte eller en ändrad återställningsadress gör äldre länkar ogiltiga. Förbrukning och uppdatering skyddas av databastransaktioner och samtidighetskontroller.

Publika anrop har beständiga begränsningar per adress, nätadress och hela tjänsten. Upprepade begäranden begränsar utskick. Mejl skickas utanför databastransaktionen; leverantörsfel visas inte som kontospecifika svar. Utskickets godkännande hos Resend garanterar inte leverans till inkorgen.

Token finns i länkens URL-fragment, skickas aldrig i en API-frågesträng och tas bort ur webbläsarens aktuella historikpost när formuläret öppnats. Den hålls endast i formulärets minne. Vid omladdning öppnar användaren länken från mejlet igen. Formuläret sparar inga lösenord eller återställningstoken i lokal lagring. Återställningssvar har `no-store` och `no-referrer`.

Lösenord lagras med befintlig saltad scrypt-hashning. Synkronisering med länkade personalkonton återkallar gamla sessioner innan det nya lösenordet aktiveras. Ett tidigare administrativt avstängt personalkonto förblir avstängt; det första VD-lösenordet kan däremot aktivera det ännu ej aktiverade grundkontot. Ändringar av personalkontot under återställningen upptäcks innan aktiv status återställs. Vid synkroniseringsfel rapporteras inte ett lyckat byte; användaren kan försöka igen enligt felmeddelandet. Revisionshistoriken innehåller händelser och tekniska identifierare, inga lösenord, råa återställningslänkar eller meddelandetexter.

## Kontroll efter deploy

Begär en länk för ett eget registrerat testkonto, kontrollera avsändaren och byt lösenord. Kontrollera att det gamla lösenordet och den använda länken avvisas, att gamla sessioner avslutas och att det nya lösenordet öppnar samma bolag med samma behörighet. Prova även fel bekräftelse och en ogiltig länk. Lokala tester använder isolerad lagring och en simulerad mejlleverantör; inga riktiga mejl skickas av testerna.

```sh
node scripts/build-domain-models.mjs
node --test server/platform-password-reset.test.mjs server/password-recovery-gateway.test.mjs server/system-email.test.mjs server/platform-auth.test.mjs server/pilot-platform.test.mjs
npx playwright test tests/password-recovery.spec.ts tests/platform-gate.spec.ts --workers=2
npm run build
```
