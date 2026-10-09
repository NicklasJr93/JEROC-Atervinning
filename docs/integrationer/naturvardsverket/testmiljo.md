# Testmiljö – anslutning och verifiering

Planeringsunderlag 2026-10-09. Inställningsnamnen nedan är **föreslagna för den
kommande serveradaptern**; befintlig app läser dem inte ännu. Ingen riktig rapport
eller autentiserat myndighetsanrop har gjorts i denna granskning.

## Det användaren redan har

Anslutning för **BTFA.Anteckning – TEST**, klientnyckel/secret och en tillfällig
åtkomsttoken. Portalen ger ett recept för OAuth-flödet `client_credentials`.
Certifikatpaketets PDF-brev ger instruktioner för separat hämtning av testidentiteter.

## Det som återstår för officiell testanslutning

1. Bekräfta om Expisofts generiska testbolag får användas med JEROC:s
   organisationsbundna anslutningsnycklar. De har andra organisationsnummer än JEROC.
   Be Naturvårdsverket/Expisoft bekräfta rätt testförfarande innan köp av eget certifikat.
   Kontraktet kräver att verksamhetsutövaren vid egen rapportering, eller ett
   behörigt ombud vid ombudsrapportering, matchar certifikatets organisation.
   Kopplingen mellan OAuth-kontot och en generisk testidentitet är däremot ännu
   inte verifierad för JEROC:s testanslutning.
2. Hämta rätt **server-/organisationslegitimation** enligt leveransbrevet,
   inklusive faktisk `.p12`-fil och lösenord. Stämpellegitimation och utgivarens
   `.cer`-fil fyller andra funktioner. Se [certifikatgranskningen](certifikatgranskning.md).
3. Bind nycklar, certifikat och lösenord säkert till JEROC:s server.
   Exakta Render-steg ges när adapterns konfiguration är implementerad.
4. Kontrollera JEROC:s juridiska namn, organisationsnummer, kontaktperson,
   kontakttelefon/e-post och testanläggningens platsuppgifter. Mockupens
   demoföretag och demoadresser är inte verifierade företagsuppgifter.
5. Bygg och testa klienten först mot lokal simulering, sedan mot myndighetens
   testmiljö. Ett godkänt läsanrop verifierar anslutningen; det verifierar inte
   mottagnings-, borttransport- och rättelseflödena i sig.

Kontrollfråga till support:

> Vi ska använda JEROC Återvinning AB:s egen anslutning till BTFA.Anteckning TEST.
> Får Expisofts publika testbolags server-/organisationscertifikat användas med
> denna OAuth-anslutning, och hur ska verksamhetsutövare/ombud anges?
> Vilken aktuell test-CA accepterar tjänsten: ExpiTrust Test CA v8 eller v8u?

## Föreslagen serverkonfiguration

Kopplingen placeras i **befintliga JEROC-tjänsten på Render**. Webbläsaren,
terminalen och Expo-appen ska använda JEROC:s egna behörighetskontrollerade API;
de får inte myndighetens klientnyckel, token eller privata certifikatnyckel.

| Föreslaget namn | Innehåll | Förvaring |
| --- | --- | --- |
| `NVV_ENVIRONMENT` | `mock` eller `test`; produktion är ett separat senare steg. | Serverinställning. |
| `NVV_API_BASE_URL` | `https://apimtest.naturvardsverket.se/btfa/anteckning/v1` | Serverinställning, endast HTTPS. |
| `NVV_TOKEN_URL` | `https://apimtest.naturvardsverket.se/oauth2/token` | Serverinställning, endast HTTPS. |
| `NVV_CLIENT_ID` | Värdet som portalen kallar **Key**. | Hemlig servervariabel. |
| `NVV_CLIENT_SECRET` | Värdet som portalen kallar **Secret**. | Hemlig servervariabel. |
| `NVV_CLIENT_PFX_SECRET_FILE` | Sökväg till serverns hemliga fil med base64-kodad `.p12`/`.pfx`. | Sökväg i serverinställning; filinnehållet i Render **Secret Files**. |
| `NVV_CLIENT_PFX_PASSWORD` | Lösenordet till just detta klientcertifikat. | Hemlig servervariabel. |
| `NVV_CLIENT_SYSTEM_ID` | JEROC-systemets namn och faktiskt byggd version. | Serverinställning. |

Render Secret Files tar textinnehåll. Ett binärt certifikat kan därför lagras
som base64 i en hemlig fil och avkodas i serverns minne. Base64 är en
representation, **inte kryptering**; filen är fortfarande en hemlighet.
Certifikatformat och faktisk lösenordshantering ska verifieras före bindning.
För PEM används vid behov separata hemliga certifikat-/nyckelfiler; det beslutas
efter att den faktiska hämtade filen har granskats.

Servern hämtar och förnyar token med `client_credentials`, HTTP Basic från
klientnyckel/secret och `Content-Type: application/x-www-form-urlencoded`.
Token hålls på servern och förnyas enligt svarets giltighet, även vid utgången
token. Anropen använder rätt klientcertifikat och verifierar myndighetens
servercertifikat. Portalens curl-exempel stänger av TLS-verifiering; den
inställningen ska inte kopieras till implementation eller anslutningstest.

Rapportanrop använder `Authorization: Bearer …`, JSON/UTF-8,
`NV-Client-System-ID` och ett spårnings-ID för försöket. Spårnings-ID är inte
ett dokumenterat dedupliceringslöfte från myndigheten.

Nycklar som delats i chatt/skärmbilder bör bytas genom myndighetens säkra
förfarande före anslutning. En ny access token roterar inte klientnyckel/secret.
Varken OAuth-värden, token, privata nycklar, certifikatens PIN-brev eller
certifikatlösenord ingår i GitHub-underlaget.

## Föreslagen verifieringsordning

1. **Lokal simulering:** validering, statusövergångar, behörigheter, databas,
   nätfel och omstart testas utan kontakt med myndigheten.
2. **Anslutning:** verifiera TLS/mTLS, tokenhämtning och tokenförnyelse.
   Kör `GET /avfallstyper` och kontrollera kod **160601**; hämta även transportsätt.
3. **Mottagning:** företagsinlämning med 250 kg blybatterier, giltiga platser,
   tidigare innehavare och faktiskt mottagningsdatum. Spara skickad snapshot,
   svaret och bekräftat `avfallId`. Återläs via testmiljöns `/anteckningar`.
4. **Blandad invägning:** samma kort kan innehålla 12 kg koppar. Batterirapporten
   innehåller endast batteriernas fysiska mängd. Flera farliga koder blir
   separata rapporter; lika koder kräver tydlig regel för summering inom händelsen.
5. **Rättelse:** ändra 250 till 245 kg via rätt PUT-sökväg. Verifiera nytt
   myndighets-ID och versionskedja, samt att lager justeras en gång.
6. **Borttransport:** 1 000 kg batterier med verklig extern transportör,
   ny innehavare och mottagningsplats. JEROC behåller sin egen rapporterande roll.
7. **Valideringsfel:** saknad platsuppgift, ogiltig avfallskod, ej positiv vikt
   och identifieringsfel ska ge tydliga åtgärder i miljökön.
8. **Makulering:** makulera en särskild testpost med tillåten orsak och behåll
   full lokal historik; ingen hård radering av tidigare myndighetskvittens.
9. **Avbrott och dubbelklick:** parallella handläggare, omstart och förlorat
   svar får inte orsaka dubbla lagerhändelser eller blind myndighetsomsändning.

Utlämning/borttransport måste ha sin anteckning färdig i rätt tid före avfärd;
myndighetsrapporteringen har en separat frist. Inkommande transportdokument,
transportörstillstånd, e-underskrifter och ADR bedöms separat från ett lyckat
API-anrop. Exakt roll och faktisk övertagandepunkt fastställs för JEROC:s rutin.

## Spärrar och dokumentationsgränser

- **Mock** kan visa simulerade svar, tydligt märkta. Det är inte officiellt TEST.
- **TEST** använder separata testadresser och testidentiteter enligt myndighetens
  accepterade förfarande. Testkvittens ska märkas som test även i dokument.
- **PRODUKTION** kräver separat anslutning, korrekt certifikat och uttrycklig
  aktivering. Testinställningar ska inte kunna välja produktionsadressen av misstag.
- Ett API-klientcertifikat ger inte kundens eller chaufförens underskrift på ett
  transportdokument. Den funktionen behöver sin egen lösning.
- Testmiljöns återläsning av anteckningar är inte dokumenterad för produktion.
  Rutinen för okänt produktionsutfall måste därför klarläggas innan aktivering.

## Källor

- [Naturvårdsverkets anslutningsguide](https://www.naturvardsverket.se/verktyg-och-tjanster/api-tjanster/anslutning-till-api-tjanst/)
- [Naturvårdsverkets API-beskrivning](https://www.naturvardsverket.se/vagledning-och-stod/avfall-farligt-avfall/rapportera-till-avfallsregistret-via-api/)
- [Expisofts testpaket](https://eid.expisoft.se/expitrust-test-certifikat/)
- [Render: Environment Variables and Secrets](https://render.com/docs/configure-environment-variables)
