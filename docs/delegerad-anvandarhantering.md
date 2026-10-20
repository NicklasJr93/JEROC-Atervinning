# Delegerad användarhantering

VD eller Systemadmin kan markera **Hantera användare** på en medarbetares
personkort under **Inloggning & behörigheter** och spara. Medarbetaren
behåller sin kontonivå och får därefter administrera vanliga personalkonton.

För att även skapa personalprofiler och skicka lösenordsinbjudningar behövs
de motsvarande personalbehörigheterna, bland annat **Läsa personal** och
**Ändra personal**. Befintliga personalprofiler kan kompletteras med
**Skapa inloggning**; de behöver inte raderas och skapas om.

En delegerad administratör kan:

- Skapa och koppla vanliga medarbetarkonton till personal.
- Skicka lösenordslänk eller hantera engångslösenord via befintligt flöde.
- Ändra vanliga konton inom sin egen åtkomst.

Servern kontrollerar både faktiskt och valt konto vid varje åtgärd.
Rättigheter, anläggningar och attestvillkor måste rymmas inom bådas
behörighet. Egen behörighet/inloggning, VD, Systemadmin och andra
delegerade användaradministratörer hanteras av VD eller Systemadmin.
Medarbetaren kan inte delegera användarhantering vidare.

Kryssrutor och kontoval visar samma gränser som servern. Att administratören
arbetar som en annan användare utökar inte den valda användarens åtkomst.
En återkallad rättighet gäller vid nästa serveranrop.

## Uppdatering av befintlig installation

Äldre versioner kunde spara `users` i en medarbetares rättighetslista trots
att den aldrig gav kontohantering. En engångsmigrering tar bort dessa
historiskt verkningslösa kryss innan några användarbehörigheter läses.
VD/Systemadmin måste därför ge rättigheten uttryckligen efter uppdateringen.
Redan skapade personalprofiler, konton och inloggningsuppgifter behålls.
Nya beviljade rättigheter överlever omstarter.

Det nya kontoformuläret bekräftar versionsstödet vid en delegering. En
gammal öppen flik som försöker återinföra ett äldre kryss får uppmaningen
att ladda om sidan. Återställning av ett äldre prisregister återställer
inte delegeringar; de behöver beviljas på nytt av VD/Systemadmin.

Automatiska prov använder isolerade testbolag och simulerade mejlutskick.
Inga riktiga personalbehörigheter ändras av verifieringen.

Verifierat 2026-10-20 med produktionsbygge, Expo-typkontroll, 73 riktade
serverprov och 25 browserfall. Proven omfattar uttrycklig delegering av
VD/Systemadmin, faktiskt kontoskapande och inbjudningar, återkallad rätt,
skyddade konton, båda användarnas gränser och uppgradering/omstart.
