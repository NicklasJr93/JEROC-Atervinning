# Kontorets mejlkopia av vägt underlag

I **Företagsinställningar → Aviseringar** finns kryssrutan
**Skicka vägt underlag till e-post**. Ange kontorets mottagare, en adress per
rad (högst tio), och välj **Spara ändringar**. Funktionen är avstängd från början.
Behörigheten att ändra företagets inställningar krävs även på servern.

Kopian skickas **efter intern attest**, när den slutliga PDF-filen har sparats
i bolagets dokumentarkiv. Att bara spara en invägning eller få kundens
godkännande skickar ingen kopia. Bilagan är samma arkiverade original med
företagets sparade uppgifter och logga; den skapas inte på nytt från senare
ändrade kund- eller företagsuppgifter.

Utskicket använder den befintliga `RESEND_API_KEY` på appservern och avsändaren
`ScrapPlanner <noreply@scrapplanner.com>`. Det kräver ingen Spiris-anslutning.
Pilotens övriga integrationsspärrar behålls. Inställningen skickar till kontorets
uttryckligen angivna adresser, inte automatiskt till kunden eller VD-kontot.

## Leverans och återförsök

- Dokumentarkivet och den beständiga mejlkön är separata från leverantörsanropet.
  Ett mejlfel gör inte att en genomförd attest behöver göras om.
- Samma attestversion får en beständig utskicksidentitet per mottagare.
  Upprepade attestanrop, PDF-återförsök och omstarter skapar inga nya utskick.
- Kön kontrolleras efter arkivering och därefter var femtonde sekund.
  Tillfälliga fel kan ta längre tid genom återförsök med ökande väntetid.
- Mottagare och PDF-identitet fryses för respektive utskick. Avstängning eller
  borttagning av en mottagare stoppar oskickade jobb. Ett mejl som redan har
  lämnats till leverantören går inte att ta tillbaka.
- Aktivering skickar inte äldre underlag. Betalningsrevisioner och
  betalningsbekräftelser utlöser inte nya kontorskopior.
- Vid osäkert leverantörssvar återanvänds samma idempotensnyckel och samma
  innehåll inom ett konservativt 23-timmarsfönster. Därefter krävs manuell
  kontroll i stället för att riskera en dubblett. Leverantörens godkännande
  betyder accepterat för leverans, inte att mejlet har lästs eller nått inkorgen.

Jobbstatus och en begränsad teknisk audit sparas i respektive bolags privata
metadata. Kön har ingen publik API för valfri PDF, mottagaradress eller
omsändning. Inga PDF-bytes, API-nycklar eller fullständiga mottagaradresser
skrivs i tekniska auditposter.

## Prova

Aktivera med en kontrollerad kontorsadress och attestera ett nytt underlag.
Kontrollera att mejlet har en PDF-bilaga som motsvarar den slutliga versionen
i arkivet. Prova därefter avstängning. Automatiska tester använder syntetiska
adresser och en ersatt mejlleverantör; de skickar inga riktiga mejl.
