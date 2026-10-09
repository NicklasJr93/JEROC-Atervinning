/* JEROC – fristående utleveransmockup. Inga API-anrop eller verkliga lagerändringar. */
(function () {
  const i = (name, size = 20) => icon(name, size);
  const num = value => new Intl.NumberFormat('sv-SE').format(value);

  window.outboundView = function (state = {}) {
    const released = Boolean(state.released);
    const reserved = Boolean(state.reserved) && !released;
    const actual = Number(state.actualWeight) || 980;
    const onHand = released ? 1680 - actual : 1680;
    const allReserved = reserved ? 1300 : 300;
    const available = onHand - allReserved;
    const currentStep = released ? 3 : reserved ? 1 : 0;
    const status = released ? 'Utlevererad' : reserved ? 'Planerad' : 'Utkast';
    const statusClass = released ? 'green' : reserved ? 'blue' : 'grey';
    const completedWeight = released ? actual : 1000;
    const materialHint = released
      ? `${num(actual)} kg utlevererat · ${num(1000 - actual)} kg av reservationen åter frigjort`
      : reserved
        ? '1 000 kg reserverat för denna arbetsorder. Lagret minskar vid avfärd.'
        : 'Välj lagerpartier och planera mängden. Lagret minskar vid avfärd.';
    const field = (label, value, className = '') => `<label class="field ${className}"><span>${label}</span><input value="${value}" readonly></label>`;
    const checked = text => `<div class="outbound-readiness-item"><span class="readiness-check">${i('CircleCheck', 17)}</span><span>${text}</span></div>`;

    return `
      <div class="page-heading outbound-heading">
        <div>
          <button class="text-btn outbound-back" data-action="back-stock">${i('ArrowLeft', 16)} Till lager</button>
          <div class="eyebrow">UTLEVERANS FRÅN NORRTÄLJE</div>
          <h1>Arbetsorder AO-1210 <span class="pill pill-${statusClass}">${status}</span></h1>
          <p class="muted">Blybatterier till Nordmetall Återvinning AB</p>
        </div>
        <div class="inline-actions">
          ${reserved ? `<button class="btn" data-action="cancel-plan">Avbryt planering</button>` : ''}
          ${released ? `<button class="btn" data-action="document-preview">${i('FileText', 17)} Visa underlag</button>` : `<button class="btn" data-action="save-draft">${i('Check', 17)} ${reserved ? 'Spara ändringar' : 'Spara utkast'}</button>`}
        </div>
      </div>

      <nav class="outbound-flow" aria-label="Utleveransens steg">
        ${['Utkast', 'Planerad', 'Lastning', 'Utlevererad'].map((label, index) => `
          <div class="outbound-step ${index < currentStep ? 'is-complete' : ''} ${index === currentStep ? 'is-current' : ''}">
            <span class="outbound-stage-index">${index < currentStep ? i('Check', 15) : index + 1}</span>
            <div><strong>${label}</strong><small>${['Material & mottagare', 'Mängd reserverad', 'Verklig vikt & dokument', 'Lageravdrag registrerat'][index]}</small></div>
            ${index !== 3 ? i('ChevronRight', 16) : ''}
          </div>`).join('')}
      </nav>

      <div class="outbound-grid">
        <section class="panel outbound-material">
          <div class="panel-head"><h2>Material & lagerpartier</h2>${released ? '<span class="pill pill-green">Lageravdrag registrerat</span>' : '<button class="text-btn" data-action="edit-party">Välj partier</button>'}</div>
          <div class="outbound-material-heading">
            <span class="outbound-material-icon">${i('Leaf', 25)}</span>
            <div><strong>Blybatterier</strong><small class="muted">Farligt avfall · 16 06 01*</small></div>
            <div class="outbound-material-weight"><strong>${num(completedWeight)} <span>kg</span></strong><small class="muted">${released ? 'Faktiskt utlevererat' : 'Planerad mängd'}</small></div>
          </div>
          <table class="data-table outbound-party-table">
            <thead><tr><th>Lagerparti / invägning</th><th>Inkommet</th><th class="align-right">${released ? 'Planerat underlag' : 'Vald mängd'}</th></tr></thead>
            <tbody>
              <tr><td><strong>INV-2050</strong><small>Anderssons Verkstad AB</small></td><td>7 okt 2026</td><td class="align-right"><strong>650 kg</strong></td></tr>
              <tr><td><strong>INV-3010</strong><small>Bygg & Riv AB</small></td><td>9 okt 2026</td><td class="align-right"><strong>350 kg</strong></td></tr>
            </tbody>
          </table>
          <div class="outbound-figure-row">
            <div><small class="muted">Registrerat lager</small><strong>${num(onHand)} kg</strong></div>
            <div><small class="muted">${reserved ? 'Totalt reserverat' : 'Andra reservationer'}</small><strong>${num(allReserved)} kg</strong></div>
            <div><small class="muted">${!reserved && !released ? 'Fritt efter planering' : 'Fritt lager'}</small><strong class="positive">${num(!reserved && !released ? available - 1000 : available)} kg</strong></div>
          </div>
          <p class="small muted outbound-material-note">${materialHint}</p>
        </section>

        <section class="panel">
          <div class="panel-head"><h2>Från & till</h2>${!released ? `<button class="text-btn" data-action="edit-recipient">${i('Pencil', 15)} Ändra</button>` : ''}</div>
          <div class="outbound-route">
            <div class="outbound-route-stop"><span class="outbound-route-dot origin">${i('Building2', 19)}</span><div><small class="muted">Lämnare · från anläggning</small><strong>JEROC Återvinning AB · Norrtälje</strong><span>Ängsvägen 19, 761 41 Norrtälje</span></div></div>
            <div class="outbound-route-stop"><span class="outbound-route-dot destination">${i('MapPin', 19)}</span><div><small class="muted">Mottagare · till anläggning</small><strong>Nordmetall Återvinning AB</strong><span>Återvinningsvägen 8, 197 40 Bro</span></div></div>
          </div>
          <div class="detail-row"><span>Kontakt hos mottagaren</span><strong>Eva Holm · 070-000 42 18</strong></div>
          <div class="detail-row"><span>Referens</span><strong>Batterileverans · vecka 42</strong></div>
          <div class="outbound-permit-check">${i('ShieldCheck', 17)} <span>Mottagarens tillstånd kontrollerat <small class="muted">Exempeluppgift i mockup</small></span></div>
        </section>

        <section class="panel">
          <div class="panel-head"><h2>Transport & önskad tid</h2><span class="pill pill-blue">Extern transportör</span></div>
          <div class="outbound-carrier-heading"><span class="outbound-carrier-icon">${i('Truck', 25)}</span><div><strong>Roslagens Transport AB</strong><small class="muted">Åkeriets förare och fordon</small></div>${!released ? `<button class="text-btn" data-action="external-carrier">Ändra</button>` : ''}</div>
          <div class="form-grid outbound-transport-fields">
            ${field('Önskat hämtningsdatum', '12 okt 2026')}
            ${field('Önskat tidsfönster', '10:00–12:00')}
            ${field('Förare', 'Oskar Lind')}
            ${field('Fordon / registrering', 'ABC123')}
          </div>
          <p class="small muted outbound-transport-note">${i('Info', 14)} Tiden är ett önskemål. Åkeriet bekräftar tid, förare och fordon.</p>
          <div class="outbound-adr-line">${i('ShieldCheck', 16)} <span>ADR bedöms separat för denna transport</span><span class="pill pill-${released ? 'green' : 'grey'}">${released ? 'Kontrollerat · DEMO' : 'Att kontrollera'}</span></div>
        </section>

        <section class="panel outbound-document-panel">
          <div class="panel-head"><h2>Transportdokument</h2><span class="pill pill-${released ? 'green' : 'amber'}">${released ? 'Demoversion låst' : 'Utkast'}</span></div>
          <div class="outbound-document-heading"><span class="outbound-document-icon">${i('FileText', 26)}</span><div><strong>TD-1210</strong><small class="muted">Underlag för samma arbetsorder</small></div><button class="text-btn" data-action="document-preview">Visa underlag ${i('ExternalLink', 15)}</button></div>
          <div class="outbound-readiness">
            ${checked('Lämnare, mottagare och transportör')}
            ${checked('Avfallskod och planerad mängd')}
            ${released ? checked(`Verklig lastvikt: ${num(actual)} kg`) : `<div class="outbound-readiness-item pending">${i('Circle', 17)}<span>Verklig lastvikt anges före avfärd</span></div>`}
            ${released ? `<div class="outbound-readiness-item"><span class="readiness-check">${i('CircleCheck', 17)}</span><span>Underskrifter <span class="pill pill-grey">DEMO</span></span></div>` : `<div class="outbound-readiness-item pending">${i('Circle', 17)}<span>Underskrifter väntar</span></div>`}
          </div>
          <p class="small muted outbound-document-note">${released ? 'Låst demounderlag. Ingen rapport har skickats till Avfallsregistret.' : 'Granska underlaget och bekräfta verklig last före avfärd.'}</p>
        </section>
      </div>

      <section class="panel outbound-foot ${released ? 'is-released' : ''}">
        <div class="outbound-foot-icon">${i(released ? 'CircleCheck' : 'Truck', 25)}</div>
        <div class="outbound-foot-copy"><h2>${released ? 'Utleveransen är registrerad' : reserved ? 'Redo för lastning' : 'Planera utleveransen'}</h2><p class="muted">${released ? `${num(actual)} kg har lämnat lagret. Historiken och demounderlaget är sparade.` : reserved ? 'Bekräfta verklig vikt, dokument och avfärd när lasten lämnar anläggningen.' : 'Reservera 1 000 kg och knyt utleveransen till samma arbetsorder.'}</p></div>
        <div class="outbound-total"><small class="muted">${released ? 'Verklig last' : 'Planerad last'}</small><strong>${num(completedWeight)} kg</strong></div>
        ${released ? `<button class="btn" data-action="back-stock">Visa lager ${i('ArrowRight', 17)}</button>` : reserved ? `<button class="btn btn-primary" data-action="confirm-departure">${i('Check', 18)} Bekräfta avfärd</button>` : `<button class="btn btn-primary" data-action="reserve-order">${i('CalendarDays', 18)} Planera utleverans</button>`}
      </section>

      <section class="panel outbound-history">
        <div class="outbound-history-title">${i('Clock', 20)}<h2>Spårbarhet</h2></div>
        <div class="outbound-history-events">
          ${released ? `<div class="outbound-history-event"><span class="history-dot green"></span><div><strong>Avfärd bekräftad · ${num(actual)} kg lageravdrag</strong><small class="muted">Lars Andersson · 12 okt 2026, 10:42 · Demohändelse</small></div></div>` : ''}
          ${reserved || released ? `<div class="outbound-history-event"><span class="history-dot blue"></span><div><strong>1 000 kg reserverat från två lagerpartier</strong><small class="muted">Anna Berg · 9 okt 2026, 14:18 · Demohändelse</small></div></div>` : ''}
          <div class="outbound-history-event"><span class="history-dot"></span><div><strong>Utleverans skapad från lageröversikten</strong><small class="muted">Anna Berg · 9 okt 2026, 14:12 · Demohändelse</small></div></div>
        </div>
      </section>`;
  };
}());
