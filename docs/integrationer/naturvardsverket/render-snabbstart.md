# NVV TEST – lägg in anslutningen i Render

Använd den **befintliga webbtjänsten JEROC-Atervinning** på Render. Behåll
`DATABASE_URL` och övriga inställningar. Ingen ny app eller databas behövs.

Certifikatet `6aca2ab583253.p12` är granskat offline: **Testbolag 1**, organisationsnummer
**5560000167**, giltigt till **9 april 2028**. Filen går att öppna med lösenordet i
Testbolag 1:s leveransbrev. Inget anslutningsprov mot NVV har gjorts ännu.

## 1. Kopiera certifikatet på din Mac

Lägg filen i **Hämtade filer/Downloads**. Öppna Macens app **Terminal** och kör:

```bash
base64 -i ~/Downloads/6aca2ab583253.p12 | pbcopy
```

Det kopierar certifikatet till urklipp utan att skriva ut det. Om filen ligger
någon annanstans: skriv `base64 -i `, dra in filen från Finder, skriv ` | pbcopy`
och tryck Enter. Base64-innehållet är fortfarande hemligt.

## 2. Lägg till den hemliga filen i Render

1. Öppna **Render → JEROC-Atervinning → Environment**.
2. Under **Secret Files**, välj **Add file**.
3. Ange filnamnet **`nvv-client-pfx.b64`**.
4. Klistra in innehållet från urklipp i filens innehållsfält och spara.

Render gör filen tillgänglig för servern som `/etc/secrets/nvv-client-pfx.b64`.
Lägg inte certifikatet, lösenordet eller anslutningsnycklarna i GitHub eller chatten.

## 3. Lägg till sex inställningar

På samma sida: **Environment Variables → Edit → Add Environment Variable**.
Lägg till dessa rader:

| Key | Value |
| --- | --- |
| `NVV_ENVIRONMENT` | `test` |
| `NVV_CLIENT_ID` | **Key** från NVV:s portal, **BTFA.Anteckning – Testmiljö**. |
| `NVV_CLIENT_SECRET` | **Secret** från samma testanslutning. |
| `NVV_CLIENT_PFX_SECRET_FILE` | `/etc/secrets/nvv-client-pfx.b64` |
| `NVV_CLIENT_PFX_PASSWORD` | PIN/lösenordet från **Testbolag 1:s leveransbrev**. |
| `NVV_CLIENT_SYSTEM_ID` | `JEROC0.12.1` |

Spara och låt Render göra en ny deploy. Om den inte startar automatiskt, välj
**Manual Deploy → Deploy latest commit**. Vänta tills tjänsten visar **Live**.

Du behöver inte lägga in en access token. Servern hämtar och förnyar den själv.
Testadresserna är redan inbyggda; lägg inte in produktionsadresser.

## 4. Ställ in testorganisationen i JEROC

Logga in som **Systemadmin** och arbeta som Systemadmin. Öppna
**Integrationer → Naturvårdsverket → NVV-inställningar**.

Fyll i:

- **Organisationsnamn:** `Testbolag 1`.
- **Organisationsnummer:** `5560000167`.
- **Kontaktperson, e-post och telefon:** kontaktuppgifterna för testet.
- **Organisation i klientcertifikatet:** `5560000167`.

Certifikatet identifierar Testbolag 1, inte JEROC. NVV:s acceptans av denna
generiska testidentitet tillsammans med JEROC:s anslutningsnycklar är ännu inte
verifierad. Kontrollera att uppgifterna ovan stämmer med leveransbrevet och markera rutan
**”Testidentiteten och certifikatets organisation har kontrollerats för denna NVV-anslutning.”**

Välj **Spara testorganisation**, därefter **Kontrollera testanslutning**.
Kontrollen hämtar token och kodlistor samt kontrollerar blybatterier **160601**
och vägtransport **R**. Den skickar **ingen mottagningsrapport**.

## 5. Första rapportprovet

När anslutningskontrollen fungerar, använd ett separat testkort med en
**företagsinlämning av blybatterier**. Kundgodkännande, mottagningsbekräftelse,
verklig vikt och kompletta ursprungs-/anläggningsuppgifter behöver vara klara.

Öppna rapporten i **Miljörapportering**, kontrollera underlaget och välj uttryckligen
att skicka till **NVV TEST**. Ett godkänt svar ska visa ett riktigt test-avfalls-ID.
Prova därefter återläsning och en rättelse; rättelsen ska få ett nytt ID med
den tidigare kvittensen kvar i historiken.

Om svaret blir **Okänt utfall**, läs tillbaka/utred först. Skicka inte samma rapport
på nytt på chans. TEST ger inga produktionsrapporter, betalningar eller ekonomiska
statusändringar. Rapportering startar inte automatiskt när Render-inställningarna sparas.
