# NVV TEST – Testbolag 1 utan ombud

## Aktuell testmall från kontor 0.29.5

Beställt 2026-10-16: förifyll Testbolag 1:s egna uppgifter utan ombud.
[Öppna det förifyllda kontrollprovet](https://jeroc-atervinning.onrender.com/kontor/integration/systemadminintegrationtest.html?preset=testbolag1-own-2026-10-16).
Under **Integrationer → Naturvårdsverket** finns **Testa Testbolag 1 utan ombud**.
Även testsidan utan query-parametrar och den äldre supportlänken öppnar
nu den här mallen. Inga uppgifter behöver kopieras manuellt.

| Fält | Värde |
| --- | --- |
| Verksamhetsutövare | `5560000167` |
| Verksamhetens namn | `Testbolag 1` |
| Tidigare innehavare | `5560000167` |
| Ombud och alla ombudets kontaktfält | Utelämnas helt ur JSON |

Syntetisk kontaktperson, e-post, telefon, 10 kg avfall `160601`, vägtransport,
platser, aktuell tidpunkt och unik referens fylls i automatiskt. Certifikatet
ska fortfarande vara det verifierade Testbolag 1-certifikatet. Testmallen är
fristående från ordinarie NVV-inställningar och verkliga viktkort.

Ladda om efter deploy, granska formuläret och tryck **Skicka till NVV · TEST**.
Att öppna sidan, förbereda mallen eller kontrollera historiken skickar inget
nytt anrop. Den befintliga popupen visar begäran, råsvar och TraceId.
För eget manuellt test används **Återställ testmall**; den knappen lämnar
den styrda förifyllningen och återgår till serverns generiska mall.

Den nya mallen har en egen preset och stoppspärr per variant. Äldre payloads,
svar och supportförsök behåller sin ursprungliga betydelse i historiken.
Ett pågående, okänt eller accepterat försök med den nya mallen spärrar fler
sådana försök; ett avvisat försök kan följas av ett aktivt nytt test.
TLS 1.2, verifierat certifikat och spärrad automatisk 401-omsändning behålls.
Inget faktiskt NVV-resultat har verifierats i utvecklingsmiljön; ett nytt
svar kräver den uttryckliga testknappen i den anslutna Render-miljön.

## Tidigare supportprov med ombud (0.29.2)

Den tidigare mallen och CLI-provet nedan behålls för historik och jämförelse.
**CLI-provet använder fortfarande JEROC som verksamhetsutövare och Testbolag 1
som ombud.** Den äldre UI-länken nedan öppnar däremot den aktuella mallen utan
ombud från 0.29.5.

Beställt 2026-10-16. Detta är ett förberett engångsprov; inget nytt svar från
NVV har verifierats i den här arbetsmiljön. Befintlig Render-konfiguration
behövs för att köra det externa provet. Skärmbildens supporttext gav ingen
annan exakt fältkombination än den som citerades och redan provats tidigare.

Kontroll i den här sessionen: ScrapPilots
`GET /api/environment/nvv/sandbox` svarade **401 platform_session_required**.
Lokala NVV-inställningar saknas. Ingen ny tokenbegäran eller rapport skickades
till Naturvårdsverket. Klientens 34 befintliga tester passerade, och separata
lokala kontroller verifierade engångsspärr, rätt roller, kontaktfält och
bevarad HTTP-status/TraceId vid spärrad 401-omsändning.

| Roll | Organisationsnummer |
| --- | --- |
| Testbolag 1 i klientcertifikatet | `5560000167` |
| JEROC som verksamhetsutövare | `5593593626` |
| Testbolag 1 som ombud | `5560000167` |

Samtliga verksamhets- och ombudskontakter fylls i med syntetiska testuppgifter.
Ny referens, tracking-ID och tidpunkt skapas för ett nytt prov.

## Kör direkt i kontorsappen – inget Render Shell behövs

Implementerat 2026-10-16 i kontor **0.29.2**.

1. Logga in som systemadmin och arbeta som JEROC.
2. [Öppna det förifyllda supportprovet](https://jeroc-atervinning.onrender.com/kontor/integration/systemadminintegrationtest.html?preset=support-2026-10-16).
   Under **Integrationer → Naturvårdsverket** finns också knappen
   **Öppna förifyllt supportprov**, synlig även när NVV-inställningarna är
   hopfällda. På testsidan kan samma mall väljas med **Förbered NVV-supportens test**.
3. Granska verksamhetsutövare, ombud och övriga förifyllda uppgifter. Ingen
   rapport skickas när sidan öppnas eller när formuläret förbereds.
4. Tryck en gång på **Skicka till NVV · TEST**. Den befintliga popupen visar
   den frysta begäran, HTTP-status, NVV:s svar och spårning. Allt sparas i
   testsidans beständiga, bolagsavgränsade historik.

Serverns befintliga Render-anslutning används. Systemadmin, rätt certifikat,
certifikatets giltighet och rollerna kontrolleras även på servern. Provet
använder en isolerad TLS 1.2-profil; ordinarie rapportörsinställningar ändras
inte. Även HTTP 401 bevaras utan automatisk tokenförnyelse/omsändning för
just supportprovet.

Ett tidigare pågående eller okänt supportprov spärrar nya prov även efter
omladdning och vid samtidiga anrop. Ett accepterat supportprov stoppar
ytterligare supportprov. Ett avvisat prov kan följas av ett uttryckligt nytt
försök. **Kontrollera testhistorik** hämtar bara sparat resultat.

Ett förifyllt formulär är inte en bekräftelse på att NVV accepterar anropet.
Ett faktiskt nytt svar måste komma från användarens uttryckliga test efter deploy.

### Om systemadmin saknar behörighet till vyn

Kontor **0.29.3** rättar kopplingen mellan plattformens egen behörighet och
JEROC:s äldre personalkonto `admin`. Personalmigreringen kunde begränsa det
kontot till en lista med anläggningar; NVV-testet kräver obegränsad
anläggningsåtkomst. Plattformen använder därför samma separata
`__platform-admin`-identitet i JEROC som i övriga bolag. Befintliga egna
plattformssessioner återläses med den identiteten. Personalkontots
anläggningsåtkomst och lösenord ändras inte.
Sambandet med den tidigare personidentiteten används fortfarande för
spärrar mot självattest av tid, avräkningar och rättelser. Det ger ingen
utökad behörighet åt ett valt personalkonto och ändrar ingen historik.

Ladda om sidan efter deploy. Vid ett tidigare kontobyte, välj **Jobba som bolag
→ Behörighet → Plattformens systemadmin · egen behörighet**, öppna arbetsytan och därefter
supportprovet igen. Vid arbete som en annan användare gäller fortfarande
den användarens roll och anläggningsbegränsning; plattformsinloggningen
kringgår inte det valda kontots begränsningar. Inget NVV-anrop skickas av
omladdning eller byte av arbetsyta.

Verifiering av rättningen: riktade behörighets-/NVV-/självattestprov,
browserprov för testformuläret, kontoväljaren och attestvyn samt produktionsbygge
passerar. Två äldre fel i `server/accounting-review-flow.test.mjs` kvarstår:
privatkundsfixturen innehåller ett ogiltigt födelsedatum (422 i stället för 200)
och ett exportprov väntar 0 poster men får 1. Båda reproducerades mot orörda
produktionskällor och originaltest från `e626ea95` i en separat HEAD-checkout;
de är inte orsakade av behörighetsrättningen. Det nya HTTP-provet för
självattest av rättelser passerar utan ändrat sparat underlag.

## Alternativ för driftansvarig: Render Shell från projektroten

Efter deploy av denna fil, kör en gång:

```sh
node scripts/nvv-support-probe.mjs --send
```

Kommandot använder serverns befintliga `NVV_*`-inställningar och certifikatfil.
Inga nya hemligheter eller miljövariabler behöver införas i Render. Det kräver
att miljön redan är `test`, att certifikatet är giltigt och att dess offentliga
fingeravtryck matchar det tidigare verifierade Testbolag 1-certifikatet.

Endast ett tokenanrop och högst en `POST /insamlingar` till de fasta
TEST-adresserna tillåts. Den delade klientens automatiska 401-replay spärras.
TLS 1.2 används för jämförelse med tidigare kontrollförsök. Serverns
TLS-verifiering behålls.

Begäran reserveras före anropet och resultatet sparas lokalt under
`.data/nvv-support-probes/`. Utskriften innehåller syntetisk begäran, maskerat
API-svar och eventuell TraceId/kvittens; aldrig anslutningsnycklar eller privat
certifikatmaterial. Spara resultatet efter körning: lokala Render-filer är
inte ett beständigt journalarkiv och kan försvinna vid deploy.
`httpExchange` bevarar faktisk rapport-HTTP-status och validerad TraceId även
om ett 401-svar leder till en spärrad tokenförnyelse. Råa headers och
autentiseringsuppgifter ingår inte i transportöversikten.

Vid okänt svar/avbrott ska samma prov inte köras igen innan utfallet utretts.
En lyckad rapport stoppar också fortsatta provrapporter. Ingen ordinarie
inställning, viktkort, mottagning eller lager ändras av skriptet; det skriver
en syntetisk anteckning endast till NVV TEST.

Utan `--send` visas bara testbegäran; inga externa anrop görs.

Tidigare protokoll: [Felsökning 1023](felsokning-1023.md),
[dynamiska försök](dynamiskt-test-2026-10-10.md).
