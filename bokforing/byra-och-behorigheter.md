# Endor Bokföring – byrå och behörigheter

Den lokala byrådemon visar hur ett företag bjuder in en registrerad
byråmedarbetare, väljer rättigheter och låter personen acceptera uppdraget.
Öppna **Byrå & behörigheter** i menyn, eller gå till
[`/bokforing/#agency`](https://app.scrapplanner.com/bokforing/#agency).

## Prova hela flödet

1. Välj **Åke** i menyn **Demoperson** högst upp. Öppna
   **Byrå & behörigheter** för Åkes Hantverk AB.
2. Ange Jennys fiktiva testnummer **20900303-0039**. Välj exempelvis
   **Bokföra och fakturera** och **Exportera underlag**, och tryck
   **Skapa inbjudan**. Läsbehörighet ingår alltid.
3. Inbjudan visas som **Väntar på svar**. Jenny har ännu ingen åtkomst.
4. Byt demoperson till **Jenny**. Under **Dina inbjudningar** väljer hon
   **Acceptera inbjudan**. Hon kan också avböja.
5. Åkes bolag finns nu under **Dina bolag**. Välj **Arbeta i bolaget** för
   att öppna bokföringen med de tilldelade rättigheterna.
6. Byt tillbaka till Åke för att ändra behörigheter eller återkalla åtkomst.
   Den tidigare inbjudan och dess händelser finns kvar i historiken.

Anki på samma demobyrå har testnumret **20900404-0045**. Numren har avsiktligt
framtida födelseår och representerar inga verifierade personer. Inmatningen
kräver tolv siffror, med eller utan bindestreck: `ÅÅÅÅMMDD-NNNN` eller
`ÅÅÅÅMMDDNNNN`. Tiosiffriga nummer stöds inte i denna version.

## Rättigheter och spårbarhet

Bolagsägaren kan tilldela läsning, bokföring och fakturering, lön, moms och
bokslut, betalningsregistrering samt export. Vissa åtgärder kräver flera
rättigheter, exempelvis både lön och betalningar för att registrera en
löneutbetalning. Betalningsregistrering skickar ingen banköverföring.
Medarbetaren kan inte själv utöka sin åtkomst eller bjuda in någon till
kundbolaget.

Inbjudan måste matcha en redan registrerad byråmedarbetare. Endast den
inbjudna demoprofilen får acceptera. Väntande, avböjda och återkallade
inbjudningar ger ingen åtkomst. Kontroller görs även vid sparande, och nya
bokföringshändelser märks med person, byrå och bolag. Äldre händelser skrivs
inte om när demopersonen byts.

Åkes Hantverk AB och Björks El AB har separata lokala bokföringsdata och
separata filinkorgar. Befintliga uppgifter i Åkes demo behålls. Vid byte av
person eller bolag rensas den öppna arbetsytans urval och Ande-samtal.

## Vad denna version faktiskt innebär

Ingen BankID-koppling eller inloggning finns. **Demoperson är en simulering:**
vem som helst som använder webbläsaren kan välja en annan demoprofil.
Personnumrets format och kontrollsiffra kontrolleras, men identiteten och
rätten att använda numret verifieras inte.

Register, inbjudningar och bokföring sparas i webbläsaren; bilagor sparas
lokalt i IndexedDB. Inga inbjudningsmejl skickas. Inbjudningar levereras inte
till andra datorer, webbläsare eller webbläsarprofiler. Lokala kontroller är
inte ett produktionsskydd för verkliga kundbolag.

Inför skarp drift behövs serverdatabas, riktig kontoinloggning och
serverkontrollerad bolagsåtkomst. Verifierad koppling mellan personnummer och
kontoinnehavare samt global unikhet i ett gemensamt användarregister återstår.
Detta arbete och lagringens produktionsskydd ingår inte i byrådemon.
