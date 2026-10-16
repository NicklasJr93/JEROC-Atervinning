# Demoinloggning på externa portaler

Bygge 0.29.4, beställt 2026-10-16. Gäller Chaufför (`/chauffor`), Åkeri
(`/akeri`) och Kundportal (`/kund`). Kontoret och plattformens inloggning
omfattas inte.

Under inloggningsfälten finns **Prova demon**. Välj ett konto för att fylla i
användarnamn och lösenord. Användaren trycker därefter själv på **Logga in**;
att öppna sidan eller välja demokonto skickar ingen inloggning.

Servern publicerar endast tillåtna, fiktiva demouppgifter för det valda
bolaget. Uppgifterna hämtas från respektive portals `GET /demo-config` med
bolagskontroll och utan cache. Ett felaktigt eller otillgängligt svar döljer
genvägarna; den vanliga inloggningen fungerar fortfarande.

JEROC:s ursprungliga demo får separata konton för chauffören Oskar,
Roslagens Åkeri och Bygg & Riv. De skapas en gång vid normal uppstart,
aldrig av läsningen. Befintliga konton skrivs inte över. Borttagna,
inaktiverade eller ändrade demokonton återställs inte vid nästa omstart,
och privata kontons uppgifter returneras aldrig av demo-endpointen.

Inga nya Render-inställningar krävs för den befintliga JEROC-demon.
`JEROC_DEMO_AUTO_SESSION=false` stänger av dessa publika demokonton:
knapparna döljs, nya demoinloggningar nekas och redan öppna demosessioner
slutar ge åtkomst. Vanliga privata portalkonton påverkas inte. Demo-markören
bevaras vid kontoredigering så att ett konto med publicerat lösenord inte
förlorar denna spärr. Andra bolag får inga sådana konton eller genvägar.

Verifierat med 22 riktade servertester, 10 browserfall och produktionsbygge.
Serverproven använder de publicerade demouppgifterna för faktisk lokal
inloggning och kontrollerar ändrade/inaktiva konton, avstängd demo,
befintliga sessioner och isolering mellan bolag. Browserproven använder
mockade API-svar och kontrollerar förifyllning utan automatisk inloggning.
