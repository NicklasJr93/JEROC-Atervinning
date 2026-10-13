# Open Payments sandbox – förberedelser

Verifierad mot officiell dokumentation 2026-10-13. Bankadaptern och dess
återkopplingsrutt är implementerade i ÄL 109, kontor 0.24.0.
[Aktuella provsteg och begränsningar](openpayments-bygge-2026-10-13.md). Ingen skarp bankkoppling aktiveras här.

## Portal och Render

Sandboxappen har skapats med AIS, PIS, ASPSP-information och
Bankgiro-information. AIS ger möjlighet att läsa bankkonton, saldon och
transaktioner efter rätt godkännande. PIS används för betalningsinitiering.
Registrerade produkter bevisar inte att alla banker eller mottagartyper stöds.

Förbered två separata rader under Render → Environment:

| Key | Value |
| --- | --- |
| `OPENPAYMENTS_CLIENT_ID` | Client Id från den skapade sandboxappen. |
| `OPENPAYMENTS_CLIENT_SECRET` | Exakt originalvärde för Client Secret. |

Nyckelnamnen ovan läses endast av serverns sandboxadapter. Kopiera värdena från portalen; lägg inga nyckelvärden i GitHub, frontend,
mockuper eller felsökningsjournaler. Om hemligheten inte sparades när appen
skapades används portalens Reset för att generera en ny.

## Första anslutningsprovet

Sandboxens OAuth-adress är
`https://oauth.sandbox.openbankingplatform.com/connect/token`.
Begäran använder form-encoding med `client_id`, `client_secret`,
`grant_type=client_credentials` och `scope=accountinformation corporate`.
Token gäller en timme och ska hållas på servern.

Därefter kan en banklista läsas utan att initiera betalning:
`GET https://api.sandbox.openbankingplatform.com/psd2/aspspinformation/v1/aspsps?isoCountryCodes=SE`,
med Bearer-token och ett nytt UUID i `X-Request-ID`. Sandboxguiden anger
`accountinformation` för denna läsning.

Detta första token-/banklistprov behöver ingen redirect-adress eller något
klientcertifikat. `401 invalid_client` gäller klientautentiseringen; att ändra
redirect-adressen löser inte det felet. Kontrollera exakt nyckelpar och miljö.

## Senare bankgodkännande

Portalens nuvarande `https://localhost:8080/` är en lokal återkopplingsadress.
Den behöver kompletteras med
`https://jeroc-atervinning.onrender.com/api/integrations/openpayments/callback`
innan godkännande via redirect provas. En Render-startsida eller Visma-callback är
inte ett färdigt bankgodkännandeflöde. Använd den levererade bankruttens exakta adress ovan.

Servern ska binda godkännandet till rätt bolag och resurs, verifiera `state`,
växla den returnerade koden enligt kontraktet med exakt samma `redirect_uri`
och därefter kontrollera resursens status. Bankgodkännande eller skapad
instruktion är inte bevis på genomförd betalning.

## Källor

- [Sandboxmiljö](https://docs.openpayments.io/docs/sandbox.md).
- [Token](https://docs.openpayments.io/docs/get_access_token.md).
- [Kom igång](https://docs.openpayments.io/docs/getstarted.md).
- [Banklista](https://docs.openpayments.io/docs/list_banks.md).
- [Godkännande](https://docs.openpayments.io/docs/authorisations.md).

De aktuella sandboxguiderna anger `oauth.sandbox.openbankingplatform.com`.
En äldre OpenAPI-fil anger `auth.sandbox…`; använd sandboxguiderna konsekvent.
