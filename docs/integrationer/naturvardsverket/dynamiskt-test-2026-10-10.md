# Dynamiskt NVV TEST – 2026-10-10

Verkliga anrop från Render med diagnostikstödet i commit `68027d5`.
Certifikatprofilerna användes tillfälligt i serverminnet. Ordinarie
Render-inställningar, rapportör, viktkort, lager och utbetalningar ändrades inte.

Totalt **24 diagnostikoperationer**, varav **12 provrapporter**.
**0 provrapporter accepterades med ett avfalls-id.**

| Profil / roll | Operation | Svensk tid | HTTP | TLS | Resultat |
| --- | --- | --- | --- | --- | --- |
| `testbolag-1/auto` | check | 21:41:35 | 200 | TLSv1.3 | accepted; 973 avfallskoder, 6 transportsätt |
| `testbolag-1/auto` | read | 21:41:37 | 200 | TLSv1.3 | accepted; 0 poster |
| `testbolag-1/auto/own` | submit | 21:41:44 | 400 | TLSv1.3 | rejected; fel 1023, 1012, 4031, 4033, 4035, 4037 |
| `testbolag-1/auto/agent` | submit | 21:41:45 | 400 | TLSv1.3 | rejected; fel 1023 |
| `testbolag-1/tls12` | check | 21:41:46 | 200 | TLSv1.2 | accepted; 973 avfallskoder, 6 transportsätt |
| `testbolag-1/tls12` | read | 21:41:48 | 200 | TLSv1.2 | accepted; 0 poster |
| `testbolag-1/tls12/own` | submit | 21:41:53 | 400 | TLSv1.2 | rejected; fel 1023, 1012, 4031, 4033, 4035, 4037 |
| `testbolag-1/tls12/agent` | submit | 21:41:54 | 400 | TLSv1.2 | rejected; fel 1023 |
| `bolag-a/auto` | check | 21:41:55 | 200 | TLSv1.3 | accepted; 973 avfallskoder, 6 transportsätt |
| `bolag-a/auto` | read | 21:41:56 | 200 | TLSv1.3 | accepted; 0 poster |
| `bolag-a/auto/own` | submit | 21:42:01 | 400 | TLSv1.3 | rejected; fel 1023, 1012, 4031, 4033, 4035, 4037 |
| `bolag-a/auto/agent` | submit | 21:42:02 | 400 | TLSv1.3 | rejected; fel 1023 |
| `bolag-a/tls12` | check | 21:42:03 | 200 | TLSv1.2 | accepted; 973 avfallskoder, 6 transportsätt |
| `bolag-a/tls12` | read | 21:42:05 | 200 | TLSv1.2 | accepted; 0 poster |
| `bolag-a/tls12/own` | submit | 21:42:10 | 400 | TLSv1.2 | rejected; fel 1023, 1012, 4031, 4033, 4035, 4037 |
| `bolag-a/tls12/agent` | submit | 21:42:11 | 400 | TLSv1.2 | rejected; fel 1023 |
| `testbolag-2/auto` | check | 21:42:12 | 200 | TLSv1.3 | accepted; 973 avfallskoder, 6 transportsätt |
| `testbolag-2/auto` | read | 21:42:13 | 200 | TLSv1.3 | accepted; 0 poster |
| `testbolag-2/auto/own` | submit | 21:42:19 | 400 | TLSv1.3 | rejected; fel 1023, 1012, 4031, 4033, 4035, 4037 |
| `testbolag-2/auto/agent` | submit | 21:42:20 | 400 | TLSv1.3 | rejected; fel 1023 |
| `testbolag-2/tls12` | check | 21:42:21 | 200 | TLSv1.2 | accepted; 973 avfallskoder, 6 transportsätt |
| `testbolag-2/tls12` | read | 21:42:23 | 200 | TLSv1.2 | accepted; 0 poster |
| `testbolag-2/tls12/own` | submit | 21:42:28 | 400 | TLSv1.2 | rejected; fel 1023, 1012, 4031, 4033, 4035, 4037 |
| `testbolag-2/tls12/agent` | submit | 21:42:29 | 400 | TLSv1.2 | rejected; fel 1023 |

## Tekniska spår för provrapporteringen

| Profil / roll | TraceId | NV-Client-Tracking-ID |
| --- | --- | --- |
| `testbolag-1/auto/own` | `400124f1-0001-f800-b63f-84710c7967bb` | `ab074fde-db98-4bd9-94fa-1f7b8de78358` |
| `testbolag-1/auto/agent` | `400124f2-0001-f800-b63f-84710c7967bb` | `8a258466-e2fa-476e-b837-b91984629dc7` |
| `testbolag-1/tls12/own` | `400124f6-0001-f800-b63f-84710c7967bb` | `cab4ea81-7171-4d44-9997-c27733a76e5c` |
| `testbolag-1/tls12/agent` | `400124f7-0001-f800-b63f-84710c7967bb` | `a5b5539e-c048-4c51-b0e9-2e8920cf4c8f` |
| `bolag-a/auto/own` | `400124fb-0001-f800-b63f-84710c7967bb` | `ad32a7f0-b198-4693-982b-89044204c0da` |
| `bolag-a/auto/agent` | `400124fc-0001-f800-b63f-84710c7967bb` | `d815c93c-3f09-41f8-bf0f-34dbfda9bb96` |
| `bolag-a/tls12/own` | `40012500-0001-f800-b63f-84710c7967bb` | `85120e5b-fcb6-4436-83f6-f9b97c88e0bc` |
| `bolag-a/tls12/agent` | `40012501-0001-f800-b63f-84710c7967bb` | `b6fbcdc4-bd6b-4483-96d7-b5a53f2c272e` |
| `testbolag-2/auto/own` | `40012505-0001-f800-b63f-84710c7967bb` | `a8a896fa-b7a4-4f06-8c75-2fedd6ddd387` |
| `testbolag-2/auto/agent` | `40012506-0001-f800-b63f-84710c7967bb` | `7e02bcb7-be7a-4617-957e-819f799621e6` |
| `testbolag-2/tls12/own` | `4001250a-0001-f800-b63f-84710c7967bb` | `b208e030-a8af-470a-928f-dc599b69435f` |
| `testbolag-2/tls12/agent` | `4001250b-0001-f800-b63f-84710c7967bb` | `5c148522-75d3-45fa-bde5-25902beec6af` |

## Vad jämförelsen visar

Varje operation använder en isolerad OAuth-klient och en ny verifierad TLS-handshake.
Certifikatets tiosiffriga nummer provades som egen verksamhetsutövare. Vid fel
1023 valdes nästa försök dynamiskt: JEROC som verksamhetsutövare och
certifikatets organisation som ombud, med samtliga ombudskontakter ifyllda.

Kodlistekontroll och läsning är separata från rapportering. Ett HTTP 200 på
kodlistorna eller en tom läsning bevisar inte vilket organisationsnummer NVV
använder vid rapportörskontrollen. Det lokala certifikatfingeravtrycket bevisar
heller inte vilken identitet NVV:s gateway faktiskt extraherade.

Ingen kvittens eller något avfalls-id bekräftades. Fel 1023 kvarstod med
samtliga tre certifikat i båda TLS-versionerna. NVV behöver slå upp dessa TraceId och
bekräfta vilket rapportörsvärde och vilken certifikategenskap deras gateway
faktiskt använde. Fler gissade organisationsformat införs inte i ordinarie flöde.

Kompletterade ombudskontakter tog bort 1012 och 4031–4037 i alla sex profiler,
men inte 1023. Saknade ombudskontakter förklarar alltså inte det kvarstående
felet. Varken ett enskilt Testbolag 1-certifikat eller valet TLS 1.3 är heller
en tillräcklig förklaring. Alla tre certifikaten delar däremot issuer och
liknande Subject-layout, och samma OAuth-anslutning användes; dessa gemensamma
faktorer är ännu inte särskiljda av svaren.

För Testbolag 2 skickades `5560065087`, medan Testbolag 1 och Bolag A använde
`5560000167`. Ombudsförsöken använde JEROC `5593593626` som verksamhetsutövare.
Inget privat personnummer användes. Samtliga sex kodlistekontroller gav
973 avfallskoder och 6 transportsätt. De sex avgränsade läsningarna var tomma;
det går därför inte att härleda rapportörens identitet ur en befintlig anteckning.

Det mest direkta kontrollärendet till NVV är Testbolag 1 / TLS 1.2 / ombud:
**21:41:54 svensk tid**, TraceId `400124f7-0001-f800-b63f-84710c7967bb`.
Be dem ange det exakta organisationsvärdet i rapportörskontrollen och om det
hämtades från TLS-certifikatet, OAuth-anslutningen eller en annan registrering.
Se även [tidigare felsökning och supportutkast](felsokning-1023.md).

## Avgränsning

Läsning begärde högst en anteckning från det senaste korta tidsintervallet.
Inga kontakter, personnummer eller råa kundposter arkiverades från lässvaren.
Ett accepterat utskick eller okänt resultat stoppar ytterligare provutskick.
Inget produktionsanrop, makulering, rättelse eller automatiskt omskick ingick.

Verifiering före driftsättning: **66 riktade tester godkända** och
`npm run build` godkänd. Se [diagnostikens API och begränsningar](dynamisk-diagnostik.md).

Efter försöken lästes samtliga 24 resultat tillbaka från serverns beständiga
historik och jämfördes med mottagna statusar och svar. Kontroll mot de tillfälliga
certifikatprofilerna hittade inga certifikatbytes eller lösenord i historiken.
Den ordinarie konfigurationen hade fortfarande Testbolag 1-certifikatet och
diagnostikförsöken var separerade från det befintliga testformulärets historik.
