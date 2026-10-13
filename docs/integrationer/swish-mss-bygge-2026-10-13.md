# Swish Utbetalning – första testbygget

Kontor 0.22.0, 2026-10-13, ÄL 102. Detta är ett verkligt API-flöde mot Swishs
Merchant Swish Simulator (MSS), med signerade instruktioner och återläsning.
MSS flyttar inga pengar. Produktionsanslutning och bankutbetalningar är inte
aktiverade. Spiris-betalningsregistreringen använder endast verifierad sandbox.

## Render

Lägg till dessa två variabler under Environment och spara/deploya:

| Namn | Värde |
| --- | --- |
| `SWISH_ENVIRONMENT` | `mss` |
| `SWISH_MSS_PUBLIC_TEST_CERTIFICATES` | `true` |

Inga nya privata Swish-nycklar behöver skickas i chatten eller laddas upp för
detta simulatorprov. Servern hämtar det officiella offentliga testpaketet,
verifierar dess hash, certifikat och nyckelpar, och sparar det i en ignorerad
runtimekatalog. Första hämtningen kan ta en stund. TLS-serverns identitet
kontrolleras; verifieringen stängs inte av. Se [certifikatbeskrivningen](swish-mss-certifikat.md).

## Börja med ett fristående Swish-prov

1. Logga in i kontoret som bolagets integrationsadministratör.
2. Öppna Integrationer -> Swish Utbetalning. Aktivera MSS-test för bolaget
   och spara. Aktivering gäller det egna bolaget, inte alla ScrapPilot-kunder.
3. Öppna Swish-testsidan. Testmottagare och testbelopp är förifyllda.
4. Skicka testet. Popupen visar anrop och svar, följt av återläst slutstatus.
   Skapad instruktion (HTTP 201) räknas inte som genomförd utbetalning.

Direktlänk efter deploy:

<https://jeroc-atervinning.onrender.com/kontor/integration/systemadminswishtest.html>

Fristående prov ändrar inga viktkort, kunduppgifter, fakturor eller verkliga
betalningsjournaler. Samma test-ID återanvänds vid förlorat svar och omladdning.

## Prova ett attesterat viktkort och Spiris

1. Anslut och verifiera bolagets eget Spiris-sandboxföretag.
2. Under Swish-inställningarna väljer du Registrera testbetalningen i Spiris
   sandbox, hämtar bolagets egna bankkonton och väljer ett aktivt SEK-bankkonto.
   Detta är bokföringskontot för bolagets utbetalning, inte mottagarens konto.
3. Använd ett kort med privatkund, fullständigt tolvsiffrigt personnummer,
   kundgodkännande och intern attest. Beloppet måste vara positivt och sakna
   kvittning. Swish Utbetalning stöder privat mottagare, inte företags-Swish.
4. Öppna Betala ut i rubriken eller utbetalningskortet. Båda öppnar samma popup.
   Den visar kund, fryst belopp och betalningsuppgifter. Betalsätt och
   mottagaruppgifter kan ändras av den som har utbetalningsbehörighet; ändringar
   kräver orsak. Den godkända kundens identitet och belopp kan inte ändras här.
5. Bekräfta Testa Swish-utbetalning. Det reserverade jobbet och dess instruktion
   sparas innan API-anropet. Endast verifierat PAID ger lyckat testresultat.
6. Spiris-registreringen väntar på den bokförda leverantörsfakturans slutliga
   ID. Om det bara finns ett utkast visas Inväntar bokförd leverantörsfaktura.
   Efter bokföring och statusåterläsning fortsätter betalningsregistreringen.

För MSS kan det officiella syntetiska mobilnumret `+46711111132` användas.
Det är ett uttryckligt simulatorundantag till vanlig svensk mobilvalidering.
Viktkortets personnummer behåller den kundidentitet som är låst i avräkningen.
Den fristående testsidan har Swishs publicerade syntetiska personnummer.

## PDF och spårbarhet

Ändrade betalningsuppgifter ger en ny PDF-version av samma avräkning före
sändning. Samma avräkningsnummer, ursprungliga utfärdandedatum, material, moms,
belopp och attest behålls. PDF:en märks Uppdaterade betalningsuppgifter –
ersätter tidigare PDF-version och innehåller orsak, aktör och tid.

Originalet behålls i historiken. Den senaste versionen visas som standard i
dokumentarkivet och kan laddas ner från utbetalningskortet. Detta skapar ingen
ny leverantörsfaktura eller ny kundgodkännandeförfrågan. En misslyckad PDF-arkivering
stoppar sändningen, så ändrade instruktioner inte används utan dokumentation.

Swish-journalen visar reserverat jobb, instruktion, svar och statuskontroller.
Spiris-bokföringen har separat journal/status och återlästa transaktions- och
betalningsverifikations-ID:n. Det ursprungliga attesterade kortet och dess
verkliga betalningsstatus skrivs inte om av en simulering.

## Fel och återhämtning

- Ett oklart Swish-resultat kontrolleras med GET på samma instruktion. Ingen
  automatisk ny utbetalning skapas. Statuskontrollen är begränsad och pausar
  till slut med krav på avstämning.
- Definitiv avvisning kan rättas och provas igen genom en uttrycklig knapp.
  Det nya försöket länkas till det avvisade försöket. Oklart resultat har
  inte denna möjlighet.
- En tillfällig Spiris-lässtörning kan återhämtas. Efter en reserverad POST
  används bara återläsning; ett saknat svar skickar inte betalningen igen.
- Manuell Uppdatera gör en aktiv kontroll av samma ärende. Den startar inte
  en ny utbetalning. Byte av Spiris-företag eller osäker anslutning pausar
  bokföringen i stället för att omdirigera den till ett annat bolag.
- Kort med kvittning, saldouttag, företagsmottagare och andra betalmetoder
  kräver kommande betalningsetapper. Bank/kontant skickas inte via MSS-knappen.

## Verifiering och kvarvarande prov

Bygget omfattar riktade transport-, journal-, behörighets-, dokument- och
Spiris-tester samt browserprov av inställningar, popup, återhämtning och
uttryckligt nytt försök. Ett injicerat sammanhängande prov verifierade ändrade
instruktioner -> PDF-version -> Swish PAID -> en Spiris-registrering och
matchande transaktionsåterläsning, med oförändrat ekonomiskt original.

Inga riktiga pengar, NVV-rapporter eller produktionsfakturor har skickats i
byggets kontroller. Det faktiska MSS-anropet behöver provas från Render efter
ovanstående inställningar; utvecklingsmiljön saknar direkt anslutning med
klientcertifikat till Swish. Lokala tester använder verifierade testdubbletter
för nätanrop. Produktionscertifikat och Swish-/bankavtal ingår inte i detta bygge.

Officiella källor: [Payouts v1](https://developer.swish.nu/api/payouts/v1),
[MSS v1](https://developer.swish.nu/api/mss/v1),
[miljöer och testcertifikat](https://developer.swish.nu/documentation/environments),
[signeringsguide](https://developer.swish.nu/documentation/getting-started/swish-payout-api).
