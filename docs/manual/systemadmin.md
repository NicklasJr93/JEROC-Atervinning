# Systemadmin

[Till manualens startsida](README.md)

Systemadmin administrerar plattformen och bolagen. Företagets VD och vanliga
medarbetare arbetar i bolagets vy och får inte plattformsbehörighet genom
vanliga rättighetskryss.

## Öppna ett bolag

Logga in i kontoret med systemadminkontot och öppna **Systemadmin**.
Välj bolag under **Öppna ett bolag**, välj behörighet och öppna arbetsytan.
Om du arbetar som en viss användare begränsas arbetet även av den användarens
rättigheter. Historiken skiljer på inloggad och vald användare.

Använd **Systemadmin** i översta raden eller **Bolagsadministration** i
profilmenyn för att återgå till plattformsvyn. Företagets egna användare
har inte denna extra översta rad.

I mobilappen loggar systemadmin in på den vanliga inloggningssidan och väljer
sedan aktivt bolag. **Byt bolag** återgår till bolagsvalet. Detta är ett
skrivbart arbetsläge; åtgärderna påverkar det valda bolagets riktiga data.
En egen anställning behövs inte för att visa eller arbeta med vägning.
Personliga funktioner som egen tid, sjukfrånvaro och körjournal hör däremot
till ett verkligt personalkonto. Se [systemadmin i mobilen](../mobil-systemadmin.md).

## Förbrukning och månadsunderlag

Panelen **Förbrukning & fakturaunderlag** visar registrerade tjänsteuppslag.
Välj månad och eventuellt bolag. Läs antal, bekräftat belopp och fakturarader;
CSV-exporten använder samma urval. Månaden räknas i svensk tid.

Personuppslag debiteras **2,00 kr exklusive moms per bekräftat uppslag**.
Även ett bekräftat svar utan träff kan räknas. Fel och osäkra utfall visas
separat för granskning och ingår inte i de bekräftade fakturaraderna.
Intern kundmatchning och ogiltiga nummer som stoppas före uppslaget debiteras
inte som personuppslag. Leverantörskostnad och kundpris hålls åtskilda.

Exporten är ett underlag för SaaS-bolagets månadsfaktura. Funktionen skapar
eller skickar ingen månadsfaktura automatiskt och lägger inte på nya
SMS-/mejlavgifter. Journalen visar förbrukning utan kundernas personnummer,
namn och adresser. Se [personuppslag och debiteringsregler](../personuppslag-och-saas-forbrukning.md).

## Testa systemutskick

I plattformsvyns **Systemutskick** finns separata tester för mejl och SMS.
Öppna önskat test, ange en mottagare du får skicka testet till och välj
skicka. Testet gör ett verkligt utskick; det är inte en förhandsvisning.

Mejl använder **ScrapPlanner &lt;noreply@scrapplanner.com&gt;**. Att leverantören
accepterar ett test bevisar inte att det lästs eller hamnat i inkorgen.
Kontrollera eventuell feltext och leveransstatus innan ett nytt försök.
Testerna ersätter inte kundgodkännandets eller PDF-kopians verksamhetsflöde.
Se [systemutskick och tester](../integrationer/systemutskick.md).

## Profil och återställning

Använd **Min profil** för systemadminkontots egna uppgifter och registrerade
återställningsadress. När du arbetar som ett bolag är det fortfarande ditt
eget konto som profilen gäller. Företagets fakturamejl eller kundmejl ändrar
inte din återställningsadress.

Drift, integrationer och återställning av lagring hör till
[den tekniska dokumentationen](../README.md). En inställning eller levererad
funktion betyder inte att varje bolag har anslutit samma externa tjänst.
