# Nytt NVV TEST enligt supportens citerade roller

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
Ny referens, tracking-ID och tidpunkt skapas när kommandot körs.

## Kör i Render Shell från projektroten

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
