# PDF och dokumentarkiv – kontorsdemo 0.11.0

## Dokument i denna version

Avräkningsnota och transportdokument använder samma servermotor för A4-PDF.
Utbetalningskvitto kan också skapas från en redan registrerad manuell betalning.
PDF-filerna är textbaserade och använder JEROC:s dokumentstil, med logga,
blå materialtabell och gröna summor. Långa dokument får flera sidor.

### Avräkningsnota

Öppna ett invägningskort och välj **Förhandsvisa avräkning**. En förhandsversion
kan sparas som PDF när kund och priser är kompletta. När underlaget visas för
kund på terminal arkiveras den frysta granskningsversionen automatiskt.
Efter personalbekräftat kundgodkännande sparas en separat kundgodkänd,
fortfarande preliminär PDF. Intern attest skapar den slutliga demoversionen.
Originalen ändras inte när kundregistret, prislistan eller betalningsstatusen
ändras senare. En ny kundgranskningsversion ger nya original.

**PDF & historik** visar sparade versioner och låter användaren öppna eller
ladda ned dem. Klientens utskriftsförhandsvisning finns kvar men är inte ett
arkiverat original. Vid ett PDF-fel efter ett godkännande återställs inte
godkännandet; dokumentvyn kan återskapa saknade PDF-versioner från den sparade
serverinformationen utan att upprepa godkännandet eller attest.

Kontorets identitetskontroll är fortfarande ett uttryckligt demo-/testflöde,
inte BankID. Momshantering och självfaktureringsavtal är ännu inte verifierade
verksamhetsuppgifter. Företagsnota anger därför att momshanteringen behöver
fastställas; den får inget påhittat självfakturanummer, Visma-ID eller
verifikationsnummer. Privat inköp markeras som inköpsnota utan antagande om
moms. En attesterad demo-PDF är inte bevis på extern bokföring eller betalning.

### Transportdokument

Öppna en ny gemensam order i **Arbetsorder**. Registrera verkliga lastvikter,
tilldela förare och fordon och välj **Förbered transportdokument**. Dokumentet
fryser arbetsorderns parter, material, vikter och hanteringsuppgifter. PDF-vyn
använder samma version; uppgifterna redigeras på arbetsordern. En ändring av
underlaget upphäver tidigare testunderskrifter och kontorets klartecken.

Äldre order utan den nya arbetsordermodellen har kvar sitt separata utkast via
**Transportplanering → Öppna transportunderlag**. Befintliga original bevaras.

Samma mall används för **hämtning** (kund → JEROC) och **utleverans**
(JEROC → mottagare). Riktningen och parterna hämtas från den nya arbetsordern.
Reservationer minskar fri mängd. Fysiskt lager minskar först vid bekräftad
lastad avfärd, en gång per order och artikel.

Före avfärd märks PDF:en **UTKAST**. Efter registrerad lastad avfärd kan en
separat slutlig demoversion arkiveras. För farliga material kräver avfärden
aktuell dokumentversion och lämnarens samt transportörens testbekräftelser.
Bekräftelserna är tydligt märkta demo, inte BankID eller juridiskt verifierade
underskrifter. PDF-generering skickar inget till NVV och ändrar inte lagret.
Transportdokument innehåller inga inköpspriser eller betalningsuppgifter.
ADR-bedömning följer inte automatiskt av en avfallskod. Chaufför och åkeri
granskar dokumentdata i sina portaler; PDF-arkivets nedladdning är ännu en
kontorsfunktion med separat behörighetskontroll.

### Utbetalningskvitto och kommande typer

Efter en manuellt registrerad utbetalning kan **Utbetalningskvitto** sparas som
en egen PDF med betalningsjournalens uppgifter. Det slutliga avräkningsoriginalet
skrivs inte om för att visa en senare betalning. Kvitto kräver behörighet till
betalningsjournalen.

Rättelsenota, självfaktureringsavtal, juridiskt signerad transportversion och separata
miljö-/bokföringsbilagor kan införas med samma motor i senare etapper. Dessa
dokumenttyper skapas inte automatiskt i denna version.

## Lagring och säkerhet

Med befintligt `DATABASE_URL` sparas PDF-bytefiler som `BYTEA` i PostgreSQL,
tillsammans med fryst dokumentdata, versionsnummer, mallversion, SHA-256 för
källdata och filen samt skapandetid och aktör. Migration
`server/migrations/documents-001.sql` körs automatiskt. Inga nya credentials
eller tjänster behövs på Render.

Tabellerna är `jeroc_document_archive`, `jeroc_transport_document_drafts` och
`jeroc_document_audit`. Transportutkast sparas som nya revisioner; tidigare
revisioner och PDF-original skrivs inte över. En unik databasnyckel gör att
upprepad eller samtidig generering av samma källa, steg och mall behåller
exakt ett original. Klienter skickar käll-ID och åtgärd; avräkningens belopp
och godkännandebevis hämtas från servern.

Vid lokal utveckling används SQLite och BLOB i `.data/documents.sqlite`, eller
`JEROC_DOCUMENT_DB_PATH`. Render utan PostgreSQL ger ett konfigurationsfel i
stället för att lägga original på en tillfällig disk. Databasbackup måste
omfatta de nya tabellerna och deras bytefiler; ingen separat objektlagring
har införts. Den fullständiga backupmotorn tillhör fortsatt en senare etapp.

Varje listning och hämtning kontrollerar kontorets aktuella demoidentitet,
anläggningsåtkomst och pris-/betalningsbehörighet. Kontrollsumman verifieras
innan ett arkiverat original lämnas ut. Terminalkonto och publik kundlänk får
inte tillgång till kontorets PDF-API. Nya arbetsorder och deras dokument har
anläggnings-ID och kontrolleras mot användarens tillåtna anläggningar. Äldre
underlag utan en känd anläggning kräver fortfarande åtkomst till alla
anläggningar. Den befintliga planeraren som helhet är fortsatt begränsad till
konton med åtkomst till samtliga anläggningar.

Kontorsinloggningen använder fortsatt befintlig demoidentitet. Ingen riktig
Visma-, BankID-, SMS-, e-post-, bank- eller NVV-överföring aktiveras här.
