# Byggplan – fyra etapper för farligt avfall och transporter

Förslag 2026-10-09. Bygger vidare på befintlig JEROC-app, databas och godkända
mockuper. **Varje etapp startas först efter användarens uttryckliga godkännande
av just den etappen.** Publicering av denna plan är inte byggstart.

| Etapp | Leverans | Startstatus |
| --- | --- | --- |
| 1 | Gemensam lagring, artikelmiljö och mottagning | Väntar på godkännande. |
| 2 | Arbetsordrar, utleverans, lager och transportdokument | Väntar på godkännande efter etapp 1. |
| 3 | Mobilwebb för åkerier, chaufförer och dokumentgranskning | Väntar på godkännande efter etapp 2. |
| 4 | Rapporteringsmotor och Naturvårdsverkets TEST | Väntar på godkännande efter etapp 3. |

Efter varje etapp: kör relevanta tester, publicera den färdiga versionen på
GitHub/Render, redovisa vad som fungerar respektive är simulerat och lämna ett
kort provflöde. Användaren provar och godkänner nästa etapps start separat.
Ett godkännande av planen ersätter inte dessa etappgodkännanden.

## Nytt beslut om extern transportör

Arbetsordern **tilldelas ett åkeri**. Åkeriet bemannar uppdraget och bekräftar
tid; JEROC behöver inte boka deras chaufförer i sin interna förarkalender.
Samma order ligger bakom kontorets lista, karta/planerare och den externa portalen.

- JEROC anger önskad dag eller tidsintervall samt eventuella fasta krav,
  exempelvis öppettider. Önskemålet visas inte som en bekräftad bokning.
- Åkeriets ansvariga kan acceptera, tacka nej eller föreslå annan tid.
  Önskad, föreslagen, överenskommen och faktisk tid sparas separat.
- JEROC skapar/godkänner åkeriets åtkomst. Åkeriets administratör får sedan
  registrera och hantera sina egna personliga chaufförskonton.
- Åkeriets ansvariga väljer chaufför bland det egna åkeriets aktiva förare.
  Chauffören ser sina tilldelade uppdrag via mobilanpassad webb, med egen inloggning.
- Vem som kör, vem som lämnar uppgifter och vem som undertecknar dokumentet
  sparas separat med tid och versionskoppling. Delat chaufförskonto undviks.
- Uppdragsacceptans är ett planeringsbeslut; transportdokumentets underskrift
  är ett eget moment. Personlig inloggning eller ett förarval är inte i sig
  en dokumentunderskrift.
- Dokument, faktisk vikt och rätt underskrifter färdigställs före **avfärd med
  last**. Tom körning till kunden och faktisk mottagning är egna händelser.
- Förarbyte bevarar tilldelningshistoriken. Om signerade uppgifter ändras
  behöver dokumentet ny version och relevanta nya underskrifter. Byte av
  juridisk transportör under transport kräver nytt transportdokument.
- Åkeriets tillstånd och relevanta förarkompetenser kan registreras med
  giltighet/kontrollunderlag. Farligt avfall innebär inte automatiskt krav på
  ADR-förarintyg; vilka kompetenser som krävs bedöms för den aktuella transporten.

## Etapp 1 – grund, artiklar och faktisk mottagning

**Du ska kunna prova:** klassificera blybatterier och registrera en direkt
kundinlämning som ger ett gemensamt, sparat miljöunderlag.

Omfattning:

- Utöka befintlig PostgreSQL med migrationer för miljöklassificering,
  strukturerade parter/platser, mottagningar, inkommande lagerunderlag,
  versionssnapshots, historik och rapportunderlag/status/frister.
- Etablera personliga kontorssessioner för de nya serverfunktionerna samt
  serverkontroller för organisation/anläggning och miljörättigheter.
  Testkonton och eventuell Jobba som-funktion ska ha tydlig demostatus och
  serverkontroller; en klientvald roll är inte verifierad personalidentitet.
- Lägg **Miljö & avfallsklassificering** på befintlig artikelvy enligt mockup 01.
  Blybatterier använder kod `160601`; priser och referensbilder behåller sina flöden.
- Lägg kompakt mottagningspanel på viktkort enligt 02: tidigare innehavare,
  senaste/kommande plats, transportsätt och faktiskt mottagningsdatum.
- Länka inkommande transportdokument eller registrera avvikelse. Ingen
  bakdatering av ett saknat dokument. Grundläggande miljökö visar sparat
  underlag och saknade uppgifter; ingen extern sändning sker i etapp 1.
- Bevara befintliga lokala testkort och terminaldata. Kopiera/importera
  relevant underlag kontrollerat och idempotent, utan att göra lokalt
  kortnummer till ett globalt unikt ID.

Kontroller: två kontorssessioner ser samma nya miljöpost; den finns kvar efter
serveromstart; dubbelklick skapar inte dubbla mottagningar/lagerrörelser;
icke-farligt material fungerar som tidigare. Verifiera migration och
säkerhetskopiering/återställning för de nya tabellerna. Miljöfristerna räknas
från rätt källhändelse, oberoende av ekonomi.

Inför start preciseras datamodell och bevarande/import. Första provflödet är
företagskund som lämnar på JEROC; rutinen för övertagande vid hämtning
fastställs innan det flödet aktiveras i nästa etapp.

## Etapp 2 – arbetsordrar, utleverans och dokument

**Du ska kunna prova:** skapa en hämtning eller utleverans, öppna samma uppdrag
i planeraren och få ett transportdokument med spårbart lager-/mängdunderlag.

Omfattning:

- Egen huvudmeny **Arbetsordrar** med lista, nytt uppdrag och detalj enligt
  03–06. Återanvänd befintlig karta/kalender och flytta orderkällan till
  gemensam beständig lagring; skapa ingen parallell ordermotor.
- Stöd hämtning, byte, utställning och utleverans samt egen/extern transportör.
  Externa uppdrag tilldelas åkeri med önskemål om tid; förare kan vara okänd vid skapande.
- Förbered åkeriets tidsförslag/acceptans och bemanning i samma ordermodell.
  Kontoret kan prova dessa uppgifter innan den externa portalen finns.
- Länka order → dokumentutkast → viktkortsutkast. Tom utställning ger ingen
  inköpsinvägning; tom körning till kund ger ingen lastad avfärd eller automatisk mottagning.
- Fastställ vikt hos kunden före lastad avfärd. Separera övertagande/mottagning,
  förberedelse av borttransportanteckning och faktisk avfärd.
- Bygg lagerpartier, reservationer och utleverans med mottagare/transportör.
  Lageravdrag och eventuella fysiska rättelser görs en gång i transaktion.
- Generera och arkivera versionslåst transportdokument/PDF enligt 07, med
  rätt parter och historik. Underskriftsflödet är **uttryckligen simulerat** i demon.
- Lägg anläggningens avfallskoder, tillståndsuppgifter och mängdgränser enligt
  11. Gränsernas innebörd och varning/stopp kopplas till dokumenterade regler.

Kontroller: samma order i lista och planerare; blandade material hålls isär;
reservation/avdrag tål samtidiga användare; omplanering uppdaterar inte
faktiska tider; dokumentändringar lämnar tidigare original kvar. Visa externa
uppdrag utan att kräva intern JEROC-förare.

## Etapp 3 – extern åkeri- och chaufförsportal

**Du ska kunna prova:** logga in som ett åkeri, fördela en order till en chaufför
och genomföra uppdragets dokument-/transportsteg från mobilen.

Omfattning:

- Mobilanpassad webbportal på befintlig domän, med separata åkeri-/chaufförskonton,
  säkra serversessioner och behörighetskontroll. Ingen ny native-app behövs.
- Åkeriets ansvariga ser företagets tilldelade uppdrag, svarar på tidsönskemål,
  hanterar egna chaufförer och väljer förare/fordon för uppdraget.
- Personlig chaufförsvy **Mina uppdrag** med kontakt, platser, instruktioner,
  faktisk vägning, dokument, bilagor och händelser enligt 08.
- Separat lämnarsida granskar samma dokumentversion. Skilj chaufför, behörig
  företrädare för transportören och lämnare i underlaget.
- Registrera vem som körde, uppdragsacceptans och underskriftsförsök på rätt
  version. Förarbyte, återkallad tilldelning och dokumentändring sparar historik.
- Behåll **SIMULERAD underskrift** i demon. Riktig e-underskrift kräver en
  separat vald tjänst och senare aktivering; den ingår inte automatiskt för
  att kontot eller knappen fungerar. SMS/e-post kan fortsatt vara simulerade.
- Registrera relevanta kompetens-/tillståndsuppgifter utan att låta ett
  självregistrerat förarnamn betyda verifierad kompetens.

Kontroller: prova två åkerier och flera förare; ingen kan läsa ett annat
åkeris uppdrag eller dokument. Avaktiverade konton och återkallade uppdrag
tappar åtkomst. Testa förarbyte och mobilens nätavbrott utan att felaktigt
visa en sparad underskrift eller avfärd.

## Etapp 4 – rapporteringsmotor och Naturvårdsverket TEST

**Du ska kunna prova:** ett komplett flöde från fysisk mottagning till
rapporterad testanteckning och spårbar rättelse.

Omfattning:

- Slutför **Miljörapportering** med Aktiva/Historik, frister, behöriga åtgärder,
  detaljer, fel och rättelse enligt 09–10. Tidigare sparade händelser/underlag
  används; ekonomisk attest är inte en rapporteringsspärr.
- Bygg sändningsarbetaren på en beständig transaktionskö med lås och lokal
  unikhet för händelse/roll/version. Inget beroende av serverns RAM eller webbläsaren.
- NVV-adapter för mottagning och borttransport, med mTLS, OAuth-tokenförnyelse,
  validering, kodlistor och sparade request/response-versioner.
- Håll **lokalt simulerat** och **officiellt TEST** som olika lägen. Utgångsläget
  är simulering; officiellt test kräver faktiskt klientcertifikat och accepterad testidentitet.
- Rättelse skapar nytt myndighets-ID och behåller hela kedjan. Makulering har
  egen behörighet, tillåten orsak och historik. Okänt resultat kräver avstämning
  och utlöser inte blind omsändning.
- Testa blandade material, extern transportör, omstart, dubbla anrop,
  fel/utgången token och förlorat svar samt fortsatt funktion för mobil,
  priser, terminaler, kundgodkännande, attest och manuella utbetalningar.

Kontroller: börja med kodlisteanrop i TEST. Därefter mottagning 250 kg,
rättelse till 245 kg och utleverans med extern transportör; kontrollera
accepterade ID och testmiljöns återläsning. För dessa externa tester krävs
testcertifikat med privat nyckel, säker serverkonfiguration och godkänt
förfarande för testidentiteten. Det uppladdade ZIP-paketets PDF-brev räcker inte.

## Avgränsning för de fyra etapperna

Första spåret är blybatterier och prioriterad roll insamlare. Roller vid egna
transporter och kundfall utanför det första företagsflödet verifieras innan de
aktiveras. Befintliga lokala exempeldata ska bevaras och import vara kontrollerad.

De fyra etapperna levererar en testbar demo och förberedelse/test mot
myndigheten. **Produktion, verkliga e-underskrifter och skarp extern
rapportering är separata aktiveringar.** Visma, bankbetalningar och riktiga
SMS-/e-postutskick ingår inte i detta bygge. Utbetalning förblir manuell.

Etapp 1–3 och lokal simulering i etapp 4 kan byggas utan att invänta
myndighetscertifikatet. Ett blockerat officiellt test redovisas som blockerat,
inte som ett godkänt anslutningstest.

## Underlag

- [Samlad API- och certifikatgranskning](README.md).
- [Mockupmatchning och återstående verksamhetsbeslut](mockupmatchning.md).
- [Godkända mockuper och flöden](../../mockups/farligt-avfall/README.md).
- [Naturvårdsverkets vägledning om transportdokument och underskrifter](https://www.naturvardsverket.se/vagledning-och-stod/avfall/avfallstransporter-inom-sverige/).
