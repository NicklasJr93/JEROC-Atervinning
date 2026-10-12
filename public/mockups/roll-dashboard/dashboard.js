/* Role dashboard design prototype. Synthetic data, local interactions only. */
(() => {
  'use strict';
  const profiles = [
    { id: 'kontor', name: 'Kontorist', title: 'Mitt arbete', person: 'Sara Lind', initials: 'SL', subtitle: 'Kontor · Norrtälje' },
    { id: 'ekonomi', name: 'Ekonomi & attest', title: 'Ekonomi & attest', person: 'Sofia Lundin', initials: 'SL', subtitle: 'Ekonomi · Alla anläggningar' },
    { id: 'transport', name: 'Transportledare', title: 'Transportledning', person: 'Johan Berg', initials: 'JB', subtitle: 'Transport · Alla anläggningar' },
    { id: 'gruppledare', name: 'Gruppledare', title: 'Mitt team', person: 'Anna Berg', initials: 'AB', subtitle: 'Gruppledare · Norrtälje' },
    { id: 'vd', name: 'VD / verksamhet', title: 'Verksamheten', person: 'Lars Andersson', initials: 'LA', subtitle: 'VD · Alla anläggningar' },
    { id: 'systemadmin', name: 'Systemadmin', title: 'Systemöversikt', person: 'Systemadmin', initials: 'SA', subtitle: 'Systemadmin · Alla anläggningar' },
    { id: 'gard', name: 'Invägare / gård', title: 'På gården idag', person: 'Maria Johansson', initials: 'MJ', subtitle: 'Invägare · Norrtälje' },
    { id: 'chauffor', name: 'Chaufför', title: 'Mina uppdrag', person: 'Lina Eriksson', initials: 'LE', subtitle: 'Chaufför · Norrtälje' }
  ];
  const localState = Object.create(null);
  const ui = () => window.MockupUI;
  const icon = name => ui().icon(name);
  const pill = (text, tone) => ui().pill(text, tone);
  const stat = (label, value, note, name, tone) => ui().stat(label, value, note, name, tone);
  const task = options => ui().task(options);
  const money = value => ui().money(value);
  const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const open = (label, type, id, className = 'text-button', iconName = 'ChevronRight') => `<button class="${className}" data-dash-case="${escape(type)}" data-dash-id="${escape(id)}">${escape(label)}${icon(iconName)}</button>`;
  const nav = (label, target, className = 'text-button', iconName = 'ChevronRight') => `<button class="${className}" data-dash-nav="${escape(target)}">${escape(label)}${icon(iconName)}</button>`;
  const heading = (title, note, action = '') => `<div class="dashboard-subhead"><div><h2>${title}</h2>${note ? `<p class="small muted">${note}</p>` : ''}</div>${action}</div>`;
  const row = (name, note, right, iconName = 'CircleCheck') => `<div class="status-row"><span class="status-icon">${icon(iconName)}</span><div><strong>${name}</strong><span class="small muted">${note}</span></div><div class="status-value">${right}</div></div>`;
  let currentProfile = 'kontor';
  const siteName = () => window.MockupSite === 'rimbo' ? 'Rimbo' : window.MockupSite === 'norrtalje' ? 'Norrtälje' : 'Alla anläggningar';
  const norrtaljeFigures = {
    ekonomi: { 'Att attestera': ['2', 'Inom din behörighet · Norrtälje'], 'Utbetalningskö': [118880, '3 attesterade kort · Norrtälje'], 'Attesterat idag': ['6', 'Inköpsvärde 32 800 kr exkl. moms'] },
    transport: { 'Uppdrag idag': ['8', '5 bemannade · 3 behöver åtgärd'], 'Pågående körningar': ['3', '2 egna förare · 1 extern'] },
    vd: { 'Inkommande material': ['31,6 ton', '+14,2 % mot jämförelseperioden'], 'Inköpsvärde': [176400, 'Norrtälje · exklusive moms'], 'Färdiga invägningar': ['132', 'Norrtälje · 1–12 oktober'], 'Väntar på utbetalning': [118880, '3 attesterade kort · aktuell kö'] }
  };
  const rimboFigures = {
    vd: { 'Inkommande material': ['12,2 ton', '+8,1 % mot jämförelseperioden'], 'Inköpsvärde': [66400, 'Rimbo · exklusive moms'], 'Färdiga invägningar': ['54', 'Rimbo · 1–12 oktober'], 'Väntar på utbetalning': [5700, '1 attesterat kort · aktuell kö'] }
  };
  const kpis = items => {
    const siteValues = (window.MockupSite === 'norrtalje' ? norrtaljeFigures : window.MockupSite === 'rimbo' ? rimboFigures : {})[currentProfile] || {};
    return `<div class="kpi-grid">${items.map(args => {
      const override = siteValues[args[0]];
      return stat(...(override ? [args[0], typeof override[0] === 'number' ? money(override[0]) : override[0], override[1], ...args.slice(3)] : args));
    }).join('')}</div>`;
  };
  const ai = (title, description, caseId, label = 'Förklara prioriteringen') => `<section class="panel ai-summary"><div class="dashboard-subhead"><div class="title-with-icon">${icon('Sparkles')}<h2>${title}</h2></div>${pill('AI-förslag', 'purple')}</div><p>${description}</p><div class="ai-actions">${open(label, 'ai', caseId, 'button secondary', 'Sparkles')}<span class="small muted">Bygger på uppgifterna du har rätt att se.</span></div></section>`;
  const tasks = (title, note, items, action = '', filters = true) => `<section class="panel tasks">${heading(title, note, action)}${filters ? `<div class="task-filter" role="group" aria-label="Filtrera uppgifter"><button class="filter-chip active" data-dash-filter="all" aria-pressed="true">Alla <span>${items.length}</span></button><button class="filter-chip" data-dash-filter="urgent" aria-pressed="false">Behöver åtgärd</button></div>` : ''}<div class="task-list">${items.map(item => `<div class="dashboard-task-entry" data-task-tone="${escape(item.tone || 'blue')}">${task(item)}</div>`).join('')}</div><p class="empty-state" hidden>Inga brådskande uppgifter i denna lista.</p></section>`;
  const table = (headers, rows) => `<div class="table-wrap"><table class="mini-table"><thead><tr>${headers.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const tabbar = (profileId, active) => `<div class="role-tabs" role="tablist" aria-label="Översiktsvy"><button class="role-tab ${active === 'work' ? 'active' : ''}" role="tab" aria-selected="${active === 'work'}" data-dash-tab="work">${icon('ListChecks')}Mitt arbete</button><button class="role-tab ${active === 'business' ? 'active' : ''}" role="tab" aria-selected="${active === 'business'}" data-dash-tab="business">${icon('BarChart3')}${profileId === 'gruppledare' ? 'Teamöversikt' : 'Verksamheten'}</button></div>`;
  const workload = (title, steps) => `<section class="panel">${heading(title, 'Antal ärenden som väntar på nästa steg')}${steps.map(([name, count, percentage, tone = 'blue']) => `<div class="progress-summary"><div><span>${name}</span><strong>${count}</strong></div><div class="progress-track"><span class="${tone}" style="width:${percentage}%"></span></div></div>`).join('')}<p class="small muted">Samma ärende räknas bara i sitt aktuella steg.</p></section>`;
  const schedule = (entries, title = 'Nästa uppdrag') => `<section class="panel">${heading(title, 'Önskade tider · dagens planering', nav('Visa planering', 'transport'))}<div class="schedule-list">${entries.map(([time, title, note, status, tone, id]) => `<div class="schedule-row"><time>${time}</time><div><strong>${title}</strong><p class="small muted">${note}</p></div><div>${pill(status, tone)}${open('Öppna', 'workorder', id)}</div></div>`).join('')}</div></section>`;

  function office() {
    return kpis([
      ['Att komplettera', '6', 'Kund, ursprung eller ändringsbegäran', 'FilePenLine', 'blue'],
      ['Kunder väntar', '2', 'Fysisk legitimation att kontrollera', 'Contact', 'amber'],
      ['Redo för nästa steg', '3', 'Kundgodkännande eller mottagning', 'ArrowRight', 'green'],
      ['Nya mejl', '4', '2 förfrågningar att hantera', 'Mail', 'purple']
    ]) + `<div class="dashboard-grid"><div class="dashboard-primary">${tasks('Gör detta härnäst', 'Kunder som väntar kommer först.', [
      { title: 'Kunden väntar på legitimationskontroll', detail: 'INV-3018 · Bygg & Riv AB · Terminal 1 · väntat 2 min', label: 'Kontrollera ID', type: 'id', id: 'INV-3018', tone: 'amber' },
      { title: 'Kunden vill ändra vikten', detail: 'INV-3017 · Erik Johansson · Koppar klass 1 · ny granskning behövs', label: 'Granska ändring', type: 'review', id: 'INV-3017', tone: 'amber' },
      { title: 'Komplettera ursprungsadressen', detail: 'INV-3016 · El & Montage AB · krävs före kundgodkännande', label: 'Öppna kortet', type: 'weighing', id: 'INV-3016', tone: 'blue' },
      { title: 'Bekräfta mottagning av farligt avfall', detail: 'INV-3015 · 100 kg blybatterier · kunden har godkänt', label: 'Granska mottagning', type: 'environment', id: 'INV-3015', tone: 'blue' }
    ], nav('Alla invägningar', 'weighings'))}${ai('Två kunder väntar just nu', 'Börja med legitimationen på Terminal 1. Ändringsbegäran behöver därefter en ny kundgranskning innan kortet kan gå vidare.', 'kontor')}${schedule([
      ['10:30', 'Utbyte · El & Montage AB', 'AO-241 · kabelkärl · Lina Eriksson', 'Planerad', 'blue', 'AO-241'],
      ['13:00', 'Hämtning · Solbackens BRF', 'AO-245 · container · egen chaufför', 'Förare saknas', 'amber', 'AO-245']
    ], 'Uppdrag som berör kontoret')}</div><aside class="dashboard-secondary">${workload('Flödet idag', [['Komplettering', 6, 75], ['Kundgodkännande', 2, 25], ['Mottagning', 1, 13], ['Attest', 3, 38]])}<section class="panel">${heading('Genvägar', 'Vanliga åtgärder')}<div class="quick-actions">${open('Ny kund', 'customer', 'new', 'button secondary', 'UserPlus')}${open('Ny arbetsorder', 'workorder', 'new', 'button secondary', 'Plus')}${nav('Öppna inkorg', 'mail', 'button secondary', 'Mail')}</div></section><section class="panel">${heading('På gården', 'Norrtälje · idag')}<div class="status-list">${row('18 invägningar klara', '4 280 kg registrerat material', pill('Idag', 'green'), 'Scale')}${row('Terminal 1', 'En kund behöver ID-kontroll', pill('Upptagen', 'amber'), 'Monitor')}${row('Terminal 2', 'Redo för nästa kund', pill('Ledig', 'green'), 'Monitor')}</div></section></aside></div>`;
  }

  function finance() {
    return kpis([
      ['Att attestera', '3', 'Inom din behörighet och beloppsgräns', 'BadgeCheck', 'blue'],
      ['Utbetalningskö', money(124580), '4 attesterade kort · alla betalningssätt', 'Wallet', 'green'],
      ['Spiris behöver åtgärd', '2', '1 avvisat · 1 oklart svar', 'PlugZap', 'amber'],
      ['Attesterat idag', '8', 'Inköpsvärde 42 860 kr exkl. moms', 'CircleCheck', 'purple']
    ]) + `<div class="dashboard-grid"><div class="dashboard-primary">${tasks('Din ekonomiska arbetskö', 'Attest och överföringar inom din åtkomst.', [
      { title: 'Oklart svar från Spiris', detail: 'INV-3009 · leverantörsfakturan kan ha skapats · kontrollera innan nytt försök', label: 'Granska överföring', type: 'integration', id: 'SPIRIS-3009', tone: 'amber' },
      { title: 'Färdigt för attest', detail: 'INV-3015 · Bygg & Riv AB · 12 850 kr · kund och mottagning klara', label: 'Granska och attestera', type: 'attest', id: 'INV-3015', tone: 'blue' },
      { title: 'Spiris saknar en giltig kontokoppling', detail: 'INV-3012 · utkast avvisat · kontrollera ekonominställningen', label: 'Granska svaret', type: 'integration', id: 'SPIRIS-3012', tone: 'amber' }
    ], nav('Öppna attestkö', 'attest'))}<section class="panel">${heading('Klara för utbetalning', 'Betalning hanteras separat från fakturautkastet.', nav('Öppna utbetalningar', 'payments'))}${table(['Kort / kund', 'Betalningssätt', 'Att betala', 'Status'], [
      ['<strong>INV-3011</strong><span class="small muted">Roslagens El AB</span>', 'Bankkonto', money(48750), pill('Inväntar utbetalning', 'blue')],
      ['<strong>INV-3010</strong><span class="small muted">Bygg & Riv AB</span>', 'Bankkonto', money(62840), pill('Inväntar utbetalning', 'blue')],
      ['<strong>INV-3008</strong><span class="small muted">Erik Johansson</span>', 'Swish', money(7290), pill('Inväntar utbetalning', 'blue')],
      ['<strong>INV-3007</strong><span class="small muted">Solbackens BRF</span>', 'Spara på saldo', money(5700), pill('Att registrera', 'blue')]
    ])}</section>${ai('Håll isär överföring och betalning', 'Ett skapat Spiris-utkast betyder inte att kunden är betald. Ett av ärendena har oklart svar och behöver kontrolleras innan något skickas igen.', 'ekonomi', 'Förklara ekonomiärendena')}</div><aside class="dashboard-secondary"><section class="panel">${heading('Din attestbehörighet', 'Sofia Lundin')}<div class="shift-card"><span class="small muted">Beloppsgräns per kort</span><strong>${money(100000)}</strong><p class="small muted">Alla anläggningar · endast kort som är klara för attest.</p></div></section><section class="panel">${heading('Överföringar till Spiris', 'Sandbox · dagens exempel')}<div class="status-list">${row('Fakturautkast skapade', 'Leverantör och utkast-ID finns sparade', '<strong>6</strong>', 'FileCheck2')}${row('Väntar i kön', 'Bearbetas i bakgrunden', '<strong>2</strong>', 'Clock3')}${row('Behöver kontroll', 'Avvisat eller oklart svar', pill('2 ärenden', 'amber'), 'TriangleAlert')}</div>${nav('Visa överföringar', 'integrations')}</section><section class="panel">${heading('Håll ihop ärendet', '')}<div class="status-list">${row('Kundgodkännande', 'Belopp och underlag är låsta', pill('Klart', 'green'), 'ClipboardCheck')}${row('Attest', 'Granskning av behörig användare', pill('Nästa steg', 'blue'), 'BadgeCheck')}${row('Utbetalning', 'Registrera utförd betalning separat', nav('Öppna', 'payments'), 'Wallet')}</div></section></aside></div>`;
  }

  function transport() {
    return kpis([
      ['Uppdrag idag', '12', '9 bemannade · 3 behöver åtgärd', 'ClipboardList', 'blue'],
      ['Förare saknas', '3', '2 berörs av registrerad frånvaro', 'UserRoundSearch', 'amber'],
      ['Åkerisvar väntar', '1', 'Extern förfrågan · önskad tid 13:00', 'Send', 'purple'],
      ['Pågående körningar', '4', '2 egna förare · 2 externa', 'Truck', 'green']
    ]) + `<div class="dashboard-grid"><div class="dashboard-primary">${tasks('Planering att lösa', 'Önskade tider är underlag för planeringen.', [
      { title: 'Två uppdrag behöver ersättare', detail: 'Kalle Nilsson är frånvarande idag · AO-245 och AO-246 ligger kvar', label: 'Lös bemanning', type: 'staffing', id: 'SICK-KALLE', tone: 'amber' },
      { title: 'Utleverans saknar förare', detail: 'AO-249 · 2 500 kg järnskrot · Norrtälje → mottagare · önskat 14:00', label: 'Tilldela förare', type: 'workorder', id: 'AO-249', tone: 'amber' },
      { title: 'Väntar på Roslagens Åkeri', detail: 'AO-247 · hämtning · åkeriet kan tacka ja, nej eller föreslå annan tid', label: 'Öppna förfrågan', type: 'workorder', id: 'AO-247', tone: 'blue' },
      { title: 'Transport med farligt avfall förbereds', detail: 'AO-248 · blybatterier · dokument och signering behövs före avfärd', label: 'Granska underlaget', type: 'transport-document', id: 'AO-248', tone: 'blue' }
    ], nav('Alla arbetsordrar', 'workorders'))}${schedule([
      ['10:30', 'Utbyte · El & Montage AB', 'AO-241 · Lina Eriksson · JEROC', 'På väg', 'green', 'AO-241'],
      ['12:00', 'Hämtning · Bygg & Riv AB', 'AO-248 · Oskar Lind · Roslagens Åkeri', 'Förbereder avfärd', 'blue', 'AO-248'],
      ['13:00', 'Hämtning · Solbackens BRF', 'AO-245 · container · ersättare behövs', 'Förare saknas', 'amber', 'AO-245']
    ])}${ai('Bemanningen påverkar två hämtningar', 'Bokningarna finns kvar trots frånvaron. Granska tillgängliga förare och deras kompetens innan du väljer ersättare.', 'transport', 'Visa bemanningsförslag')}</div><aside class="dashboard-secondary"><section class="panel">${heading('Tillgängliga förare', 'Kompetens och arbetstid måste passa uppdraget.')}<div class="status-list">${row('Lina Eriksson', 'Egen · C / CE · YKB · ADR', pill('Tillgänglig 13–16', 'green'), 'UserRound')}${row('Johan Svensson', 'Egen · C · YKB', pill('Tillgänglig 14–16', 'green'), 'UserRound')}${row('Oskar Lind', 'Extern · Roslagens Åkeri', pill('Bokat uppdrag', 'blue'), 'UserRound')}${row('Kalle Nilsson', 'Två uppdrag behöver ny förare', pill('Frånvarande', 'amber'), 'UserRound')}</div>${nav('Öppna personal', 'personal')}</section><section class="panel">${heading('Snabbstart', '')}<div class="quick-actions">${open('Ny arbetsorder', 'workorder', 'new', 'button primary', 'Plus')}${nav('Boka från lagret', 'stock', 'button secondary', 'Package')}${nav('Kundernas kärl', 'containers', 'button secondary', 'Boxes')}</div></section></aside></div>`;
  }

  function team() {
    return kpis([
      ['I tjänst idag', '8', 'Transport och gårdsplan · Norrtälje', 'Users', 'green'],
      ['Bemanning att lösa', '3', 'Anna Berg är ansvarig', 'ListChecks', 'amber'],
      ['Frånvarande', '1', 'Bokade uppdrag ligger kvar', 'CalendarOff', 'blue'],
      ['Kompetenser löper ut', '2', 'Inom 30 dagar · behöver planeras', 'BadgeCheck', 'purple']
    ]) + `<div class="dashboard-grid"><div class="dashboard-primary">${tasks('Ditt team behöver detta', 'Prioriterat efter berörda uppdrag och giltighet.', [
      { title: 'Kalles frånvaro påverkar två uppdrag', detail: 'AO-245 och AO-246 · ingen ersättare vald · måndag 12 oktober', label: 'Lös bemanning', type: 'staffing', id: 'SICK-KALLE', tone: 'amber' },
      { title: 'Johan behöver kompletterad körkompetens', detail: 'AO-249 kräver C / CE · registrerad behörighet är C', label: 'Granska bemanning', type: 'staffing', id: 'AO-249', tone: 'amber' },
      { title: 'Två kompetenser löper ut snart', detail: 'YKB och truckkort · planera förnyelse utan att avboka dagens giltiga uppdrag', label: 'Öppna kompetenser', type: 'competency', id: 'TEAM-EXPIRY', tone: 'blue' }
    ], nav('Alla bemanningsärenden', 'personal'))}<section class="panel">${heading('Teamet idag', 'Arbetstid med avdrag för frånvaro och rast.', nav('Schema & frånvaro', 'personal'))}${table(['Person', 'Arbetspass', 'Tillgänglighet', 'Nästa uppdrag'], [
      ['<strong>Lina Eriksson</strong><span class="small muted">Chaufför · C / CE · YKB · ADR</span>', '07:00–16:00', pill('Tillgänglig efter 13', 'green'), 'AO-241 · utbyte'],
      ['<strong>Johan Svensson</strong><span class="small muted">Chaufför · C · YKB</span>', '07:00–16:00', pill('Tillgänglig efter 14', 'green'), 'AO-244 · hämtning'],
      ['<strong>Kalle Nilsson</strong><span class="small muted">Chaufför · C / CE · YKB · ADR</span>', '07:00–16:00', pill('Frånvarande', 'amber'), '2 bokningar berörs'],
      ['<strong>Maria Johansson</strong><span class="small muted">Invägare · gårdsplan</span>', '07:00–16:00', pill('I tjänst', 'green'), 'Invägning · Norrtälje']
    ])}</section>${ai('Lös bemanningen utan att tappa bokningarna', 'Två uppdrag behöver ersättare och ett har en kompetenskonflikt. Kontrollera tillgänglighet, rätt fordon och verifierad kompetens tillsammans.', 'gruppledare', 'Förklara teamets uppgifter')}</div><aside class="dashboard-secondary"><section class="panel">${heading('Dagens bemanning', 'Transport och gårdsplan')}<div class="status-list">${row('Gårdsplan', '3 invägare · ordinarie pass', pill('Bemannad', 'green'), 'Scale')}${row('Egna transporter', '4 förare i tjänst · 1 frånvarande', pill('2 uppdrag berörs', 'amber'), 'Truck')}${row('Kontor', '1 kontorist i tjänst', pill('Bemannat', 'green'), 'Building2')}</div></section><section class="panel">${heading('Personalåtgärder', '')}<div class="quick-actions">${open('Registrera frånvaro', 'absence', 'new', 'button secondary', 'CalendarOff')}${nav('Öppna personregister', 'personal', 'button secondary', 'Users')}${open('Granska kompetenser', 'competency', 'TEAM-EXPIRY', 'button secondary', 'BadgeCheck')}</div><p class="small muted">Lön och personuppgifter visas bara med separat behörighet.</p></section></aside></div>`;
  }

  function graph() {
    const factor = window.MockupSite === 'norrtalje' ? 0.72 : window.MockupSite === 'rimbo' ? 0.28 : 1;
    const bars = [{ x: 52, height: 96, label: 'v. 37', value: 7.2 }, { x: 128, height: 120, label: 'v. 38', value: 9 }, { x: 204, height: 108, label: 'v. 39', value: 8.1 }, { x: 280, height: 150, label: 'v. 40', value: 11.3 }, { x: 356, height: 162, label: 'v. 41', value: 12.2 }].map(bar => ({ ...bar, height: bar.height * factor, value: (bar.value * factor).toLocaleString('sv-SE', { maximumFractionDigits: 1 }) }));
    return `<svg class="volume-chart" viewBox="0 0 460 225" role="img" aria-label="Inkommande material per vecka på ${siteName()}: ${bars.map(b => `${b.label}: ${b.value} ton`).join(', ')}."><line x1="34" y1="184" x2="442" y2="184" stroke="#dbe7f6"/><line x1="34" y1="122" x2="442" y2="122" stroke="#edf3fa"/><line x1="34" y1="60" x2="442" y2="60" stroke="#edf3fa"/><text x="3" y="187" fill="#8799b5" font-size="10">0</text><text x="3" y="125" fill="#8799b5" font-size="10">5</text><text x="0" y="63" fill="#8799b5" font-size="10">10</text><text x="1" y="19" fill="#8799b5" font-size="10">ton</text>${bars.map((bar, index) => `<rect x="${bar.x}" y="${184 - bar.height}" width="46" height="${bar.height}" rx="6" fill="${index === bars.length - 1 ? '#0962f5' : '#b9d6ff'}"/><text x="${bar.x + 23}" y="${175 - bar.height}" text-anchor="middle" fill="#284264" font-size="11" font-weight="600">${bar.value}</text><text x="${bar.x + 23}" y="206" text-anchor="middle" fill="#7488a8" font-size="11">${bar.label}</text>`).join('')}</svg>`;
  }

  function management() {
    const scoped = window.MockupSite === 'norrtalje' ? { total: '31,6', last: '8,8', factor: .72 } : window.MockupSite === 'rimbo' ? { total: '12,2', last: '3,4', factor: .28 } : { total: '43,8', last: '12,2', factor: 1 };
    return `<div class="dashboard-toolbar"><label class="field-inline">Period<select data-dash-period aria-label="Statistikperiod"><option value="month">1–12 oktober 2026</option><option value="previous" disabled>September 2026</option></select></label><label class="field-inline">Jämförelse<select data-dash-compare aria-label="Jämförelseperiod"><option>Motsvarande period föregående månad</option><option disabled>Ingen jämförelse</option></select></label><span class="small muted">Inköpsvärden exklusive moms</span></div><div data-management-current>${kpis([
      ['Inkommande material', '43,8 ton', '+12,4 % mot jämförelseperioden', 'Scale', 'blue'],
      ['Inköpsvärde', money(242800), '+8,1 % · exklusive moms', 'Wallet', 'green'],
      ['Färdiga invägningar', '186', 'På 12 dagar · 15,5 per dag', 'ClipboardCheck', 'purple'],
      ['Väntar på utbetalning', money(124580), '4 attesterade kort · aktuell kö', 'Clock3', 'amber']
    ])}</div><div data-management-previous hidden>${kpis([
      ['Inkommande material', '98,6 ton', 'September 2026 · hela månaden', 'Scale', 'blue'],
      ['Inköpsvärde', money(584200), 'September 2026 · exklusive moms', 'Wallet', 'green'],
      ['Färdiga invägningar', '412', 'September 2026 · 13,7 per dag', 'ClipboardCheck', 'purple'],
      ['Väntar på utbetalning', money(124580), 'Aktuell kö · inte historiskt saldo', 'Clock3', 'amber']
    ])}</div><div class="dashboard-grid"><div class="dashboard-primary"><div class="dashboard-pair"><section class="panel">${heading('Materialvolym per vecka', `Senaste fem avslutade veckorna · ${siteName()}`)}${graph()}<div class="chart-caption">Senaste veckan <strong>${scoped.last} ton</strong>${pill('+8,0 %', 'green')}</div></section><section class="panel">${heading('Vad kommer in?', 'Materialfördelning · 1–12 oktober')}<div class="material-mix"><div class="mix-donut" role="img" aria-label="Järn 52 procent, koppar 24 procent, aluminium 14 procent, övrigt 10 procent"><div><strong>${scoped.total}</strong><span>ton</span></div></div><div>${[['Järn', 22.8, '52 %', '#0962f5'], ['Koppar', 10.5, '24 %', '#5b9bf8'], ['Aluminium', 6.1, '14 %', '#6dd6b5'], ['Övrigt', 4.4, '10 %', '#bdccdf']].map(([name, value, percentage, color]) => `<div class="material-row"><span class="material-dot" style="background:${color}"></span><span>${name}<small>${(value * scoped.factor).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} ton</small></span><strong>${percentage}</strong></div>`).join('')}</div></div></section></div><section class="panel">${heading('Anläggningarnas utveckling', 'Inkommande material och inköpsvärde · vald period')}${table(['Anläggning', 'Materialvolym', 'Inköpsvärde exkl. moms', 'Mot föregående period'], [
      ['<strong>Norrtälje</strong><span class="small muted">132 färdiga invägningar</span>', '31,6 ton', money(176400), pill('+14,2 % volym', 'green')],
      ['<strong>Rimbo</strong><span class="small muted">54 färdiga invägningar</span>', '12,2 ton', money(66400), pill('+8,1 % volym', 'green')]
    ].filter(r => window.MockupSite === 'norrtalje' ? r[0].includes('Norrtälje') : window.MockupSite === 'rimbo' ? r[0].includes('Rimbo') : true))}</section>${ai('Volymen ökar, men två flöden behöver uppmärksamhet', window.MockupSite === 'rimbo' ? 'Rimbo visar 12,2 ton för perioden, en ökning på 8,1 %. Ett NVV-ärende behöver kontrolleras och en extern hämtning väntar på svar.' : 'Norrtälje står för 72 % av periodens materialvolym. Bemanningen behöver lösas för tre uppdrag, och två Spiris-ärenden väntar på kontroll.', 'vd', 'Öppna verksamhetssammanfattning')}</div><aside class="dashboard-secondary"><section class="panel">${heading('Viktigt att följa upp', '')}<div class="status-list">${window.MockupSite === 'rimbo' ? row('NVV-rapportering', 'Ett ärende behöver kontroll', open('Visa', 'integration', 'NVV-3012'), 'Leaf') + row('Extern hämtning', 'Väntar på åkerisvar', open('Visa', 'workorder', 'AO-252'), 'Truck') : row('Bemanning', 'Tre uppdrag behöver lösning', open('Visa', 'staffing', 'TEAM-TODAY'), 'Users') + row('Spiris', 'Två ärenden behöver kontroll', open('Visa', 'integration', 'SPIRIS-QUEUE'), 'PlugZap') + row('Attestkö', 'Tre kort väntar · äldsta 38 min', open('Visa', 'attest', 'ATTEST-QUEUE'), 'BadgeCheck')}</div></section><section class="panel">${heading('Största levererande kunder', 'Inköpsvärde exkl. moms · vald period')}<div class="status-list">${window.MockupSite === 'rimbo' ? row('Solbackens BRF', '8 invägningar · 3,6 ton', '<strong>21 200 kr</strong>', 'Building2') + row('Rimbo Bygg AB', '10 invägningar · 4,8 ton', '<strong>18 450 kr</strong>', 'Building2') : row('Roslagens El AB', '18 invägningar · 6,8 ton', '<strong>54 200 kr</strong>', 'Building2') + row('Bygg & Riv AB', '23 invägningar · 12,1 ton', '<strong>41 650 kr</strong>', 'Building2') + row('El & Montage AB', '12 invägningar · 4,2 ton', '<strong>37 400 kr</strong>', 'Building2')}</div></section><section class="panel">${heading('Registrerat lager', 'Samlat per anläggning')}<div class="status-list">${window.MockupSite !== 'rimbo' ? row('Norrtälje', 'Material med registrerade lagerrörelser', '<strong>24,6 ton</strong>', 'Package') : ''}${window.MockupSite !== 'norrtalje' ? row('Rimbo', 'Material med registrerade lagerrörelser', '<strong>8,2 ton</strong>', 'Package') : ''}</div>${nav('Öppna lager', 'stock')}<p class="small muted">Öppna lagret för att se material, reservationer och tillgängliga mängder.</p></section></aside></div>`;
  }

  function admin() {
    return kpis([
      ['Oklara överföringar', '1', 'Kontroll krävs innan nytt försök', 'TriangleAlert', 'amber'],
      ['Avvisade ärenden', '2', '1 NVV · 1 Spiris', 'CircleAlert', 'blue'],
      ['Väntar i kö', '3', 'Sparas beständigt · bearbetas i bakgrunden', 'ListOrdered', 'purple'],
      ['Terminaler online', '2 / 3', 'Terminal 3 är offline', 'Monitor', 'green']
    ]) + `<div class="dashboard-grid"><div class="dashboard-primary">${tasks('Systemärenden att lösa', 'Ett oklart skrivsvar ska kontrolleras, inte skickas om automatiskt.', [
      { title: 'Spiris kan ha skapat ett fakturautkast', detail: 'INV-3009 · oklart svar efter sändning · leta efter befintligt utkast först', label: 'Granska skickhistorik', type: 'integration', id: 'SPIRIS-3009', tone: 'amber' },
      { title: 'NVV avvisade rapporteringen', detail: 'INV-3012 · organisationsnummer och rapportör behöver matcha', label: 'Granska svaret', type: 'integration', id: 'NVV-3012', tone: 'amber' },
      { title: 'Spiris-konteringen behöver kompletteras', detail: 'INV-3013 · saknar giltig kontokoppling för artikeln', label: 'Öppna inställningar', type: 'integration', id: 'SPIRIS-3013', tone: 'blue' }
    ], nav('Öppna integrationer', 'integrations'))}<section class="panel">${heading('Integrationer och köer', 'Status från respektive ärende · alla externa miljöer visas tydligt.')}${table(['Koppling', 'Miljö', 'Kö / åtgärd', 'Nästa steg'], [
      ['<strong>Spiris / eEkonomi</strong><span class="small muted">Fakturautkast efter attest</span>', pill('Sandbox', 'purple'), '2 i kö · 1 oklart · 1 avvisat', open('Öppna', 'integration', 'SPIRIS-QUEUE')],
      ['<strong>Naturvårdsverket</strong><span class="small muted">Farligt avfall</span>', pill('Test', 'blue'), '1 i kö · 1 avvisat', open('Öppna', 'integration', 'NVV-QUEUE')],
      ['<strong>Microsoft 365 / Outlook</strong><span class="small muted">Gemensam inkorg · designförslag</span>', pill('Planerad', 'grey'), 'Ingen aktiv anslutning', nav('Visa inkorgsförslag', 'mail')]
    ])}</section>${ai('Förklara felet med det faktiska svaret', 'Assistenten visar vilka fält som behöver kontrolleras och länkar till rätt inställning. Tekniska råsvar och behörigheter ligger kvar i ärendet.', 'systemadmin', 'Förklara integrationsärendena')}</div><aside class="dashboard-secondary"><section class="panel">${heading('Återställning & drift', 'Planerade funktioner')}<div class="status-list">${row('Komplett backupmotor', 'Nattlig kopia och återställningsflöde', pill('Planerad', 'grey'), 'DatabaseBackup')}${row('Felrapportering', 'Sentry eller motsvarande', pill('Planerad', 'grey'), 'Activity')}${row('AI-assistent', 'Förklaringar och granskade utkast', pill('Mockup', 'purple'), 'Sparkles')}</div></section><section class="panel">${heading('Terminaler', '')}<div class="status-list">${row('Terminal 1', 'Kunden väntar på ID-kontroll', pill('Upptagen', 'amber'), 'Monitor')}${row('Terminal 2', 'Norrtälje', pill('Ledig', 'green'), 'Monitor')}${row('Terminal 3', 'Rimbo · senaste kontakt 08:14', pill('Offline', 'grey'), 'Monitor')}</div>${open('Hantera terminaler', 'terminal', 'all')}</section></aside></div>`;
  }

  function yard() {
    return kpis([
      ['Mina pågående kort', '2', 'Sparas löpande medan du arbetar', 'Scale', 'blue'],
      ['Klara för kontoret', '5', 'Inlämnade och färdiga vägningar', 'ClipboardCheck', 'green'],
      ['Vägt in idag', '4 280 kg', '18 färdiga kort · Norrtälje', 'Package', 'purple'],
      ['Väntar på komplettering', '1', 'Material behöver kontrolleras', 'TriangleAlert', 'amber']
    ]) + `<div class="dashboard-grid"><div class="dashboard-primary"><section class="panel shift-card"><div class="dashboard-subhead"><div><h2>Redo för nästa invägning?</h2><p>Välj material, registrera faktisk vikt och lämna kortet till kontoret när vägningen är klar.</p></div>${open('Ny invägning', 'weighing', 'new', 'button primary', 'Plus')}</div></section>${tasks('Fortsätt där du slutade', 'Dina vägningar på Norrtäljeanläggningen.', [
      { title: 'Fortsätt invägning av koppar', detail: 'INV-3019 · 2 materialrader · senaste ändring 09:42', label: 'Fortsätt väga', type: 'weighing', id: 'INV-3019', tone: 'blue' },
      { title: 'Kontrollera vilket batterimaterial som lämnats', detail: 'INV-3018 · skilj blybatterier från andra batterier före färdig vägning', label: 'Öppna kortet', type: 'weighing', id: 'INV-3018', tone: 'amber' }
    ], '', false)}<section class="panel">${heading('Senast lämnat till kontoret', 'Färdiga vägningar · kundgodkännande görs i nästa steg')}${table(['Kort', 'Material', 'Vikt', 'Status'], [
      ['<strong>INV-3017</strong><span class="small muted">09:31 · Maria Johansson</span>', 'Koppar klass 1', '125 kg', pill('Hos kontoret', 'blue')],
      ['<strong>INV-3016</strong><span class="small muted">09:18 · Maria Johansson</span>', 'Järnskrot · aluminium', '840 kg', pill('Hos kontoret', 'blue')],
      ['<strong>INV-3015</strong><span class="small muted">09:04 · Maria Johansson</span>', 'Blybatterier', '100 kg', pill('Hos kontoret', 'blue')]
    ])}</section></div><aside class="dashboard-secondary"><section class="panel">${heading('Mitt arbetspass', 'Måndag 12 oktober')}<div class="status-list">${row('Norrtälje · gårdsplan', '07:00–16:00 · rast 12:00–13:00', pill('I tjänst', 'green'), 'CalendarDays')}${row('Gruppledare', 'Anna Berg', open('Kontakta', 'person', 'ANNA'), 'Users')}</div></section><section class="panel">${heading('Hitta material', 'Gemensamt artikelregister')}<p class="small muted">Exempelbilder och instruktioner hjälper dig välja rätt artikel innan du väger.</p>${open('Öppna materialguiden', 'article', 'guide', 'button secondary', 'BookOpen')}</section>${ai('Hjälp när ett material är oklart', 'Se artikelns registrerade instruktioner och förklara skillnader. Klassificeringen ändras inte av AI.', 'gard', 'Öppna materialhjälp')}</aside></div>`;
  }

  function driver() {
    return kpis([
      ['Mina uppdrag idag', '4', '2 kvar · 1 pågår · 1 klart', 'Truck', 'blue'],
      ['Farligt avfall', '1 uppdrag', 'Granska dokument före avfärd', 'ShieldAlert', 'amber'],
      ['Önskad tid ändrad', '1', 'Planeringen har uppdaterats', 'Clock3', 'purple'],
      ['Mitt arbetspass', '07–16', 'Rast 12:00–13:00', 'CalendarDays', 'green']
    ]) + `<div class="dashboard-grid"><div class="dashboard-primary"><section class="panel driver-next">${heading('Nästa uppdrag', 'AO-251 · hämtning · önskad tid 11:00', pill('Farligt avfall', 'amber'))}<h3>Hämta blybatterier hos Bygg & Riv AB</h3><p class="muted">Industrivägen 8, Norrtälje → JEROC Norrtälje</p><div class="route-line"><div class="route-stop">${icon('MapPin')}<div><strong>Hämtning</strong><span>Bygg & Riv AB · kontakt Anders</span></div></div>${icon('ArrowRight')}<div class="route-stop">${icon('Building2')}<div><strong>Mottagning</strong><span>Ängsvägen 19 · Norrtälje</span></div></div></div><div class="notice notice-amber">${icon('FileCheck2')}<div><strong>Granska och signera innan du kör med lasten.</strong><p>Transportdokument och uppgifter ska vara klara före avfärd. Beräknad mängd är 100 kg; faktisk vikt registreras senare.</p></div></div><div class="quick-actions">${open('Granska transportdokument', 'transport-document', 'AO-251', 'button primary', 'FileText')}${open('Öppna uppdrag', 'workorder', 'AO-251', 'button secondary')}</div></section>${schedule([
      ['08:30', 'Utbyte · El & Montage AB', 'AO-241 · kabelkärl · återlämnat till gården', 'Klart', 'green', 'AO-241'],
      ['11:00', 'Hämtning · Bygg & Riv AB', 'AO-251 · blybatterier · granska före avfärd', 'Förbereder', 'amber', 'AO-251'],
      ['13:30', 'Hämtning · Solbackens BRF', 'AO-245 · container · önskad tid ändrad', 'Planerad', 'blue', 'AO-245'],
      ['15:00', 'Utleverans · metallmaterial', 'AO-249 · Norrtälje → mottagare', 'Planerad', 'blue', 'AO-249']
    ], 'Min dag')}</div><aside class="dashboard-secondary"><section class="panel">${heading('Information till mig', '')}<div class="status-list">${row('Ny önskad hämtningstid', 'AO-245 · 13:30 i stället för 13:00', open('Visa', 'workorder', 'AO-245'), 'Clock3')}${row('Kontakt på kontoret', 'Johan Berg · transportledning', open('Kontakt', 'person', 'JOHAN'), 'Phone')}</div></section><section class="panel">${heading('Jag & mitt fordon', '')}<div class="status-list">${row('Fordon', 'Lastbil JEROC 02', pill('Tilldelat', 'blue'), 'Truck')}${row('Kompetens', 'C / CE · YKB · ADR', pill('Registrerad', 'green'), 'BadgeCheck')}${row('Dagens arbetstid', '07:00–16:00 · Norrtälje', pill('I tjänst', 'green'), 'CalendarDays')}</div>${open('Se mitt schema', 'schedule', 'LINA')}</section>${ai('Vad behöver jag göra före avfärd?', 'Få en kort genomgång av uppdragets registrerade dokument och instruktioner. Signering görs av dig i uppdraget.', 'chauffor', 'Förklara nästa uppdrag')}</aside></div>`;
  }

  function operationsSummary(profileId) {
    const localSite = ['gruppledare', 'gard'].includes(profileId);
    return kpis([
      ['Färdiga invägningar idag', localSite ? '18' : '26', localSite ? 'Norrtälje · aktuell arbetsdag' : 'Samtliga tillåtna anläggningar', 'Scale', 'blue'],
      ['Inkommande material', localSite ? '4,28 ton' : '6,42 ton', 'Faktiskt registrerade vikter idag', 'Package', 'green'],
      ['Aktiva arbetsordrar', localSite ? '7' : '12', 'Planerade och pågående uppdrag idag', 'ClipboardList', 'purple'],
      ['Behöver åtgärd', '3', 'Bemanning eller komplettering', 'TriangleAlert', 'amber']
    ]) + `<div class="dashboard-grid"><div class="dashboard-primary">${schedule([
      ['10:30', 'Utbyte · El & Montage AB', 'AO-241 · Lina Eriksson · JEROC', 'På väg', 'green', 'AO-241'],
      ['12:00', 'Hämtning · Bygg & Riv AB', 'AO-248 · blybatterier · förberedelser', 'Planerad', 'blue', 'AO-248'],
      ['13:00', 'Hämtning · Solbackens BRF', 'AO-245 · ersättare behövs', 'Förare saknas', 'amber', 'AO-245']
    ], 'Verksamheten idag')}<section class="panel">${heading('Senaste aktivitet', 'Inom de anläggningar och moduler du får se')}<div class="status-list">${row('INV-3015 är kundgodkänt', '09:42 · mottagning är nästa steg', open('Öppna', 'weighing', 'INV-3015'), 'ClipboardCheck')}${row('AO-241 är på väg till kunden', '09:36 · Lina Eriksson · utbyte', open('Öppna', 'workorder', 'AO-241'), 'Truck')}${row('Bemanningsärende skapat', '09:28 · två uppdrag berörs av frånvaro', open('Visa', 'staffing', 'SICK-KALLE'), 'Users')}</div></section></div><aside class="dashboard-secondary">${workload('Viktkortens aktuella steg', [['Komplettering', 6, 75], ['Kundgodkännande', 2, 25], ['Mottagning', 1, 13], ['Attest', 3, 38]])}<section class="panel">${heading('Anläggningsöverblick', '')}<div class="status-list">${row('Norrtälje', '18 färdiga kort idag', '<strong>4,28 ton</strong>', 'Building2')}${localSite ? '' : row('Rimbo', '8 färdiga kort idag', '<strong>2,14 ton</strong>', 'Building2')}</div></section></aside></div>`;
  }

  function rimboOverview(profileId) {
    if (['gard', 'chauffor', 'gruppledare'].includes(profileId)) return `<section class="panel"><div class="empty-state">${icon('Building2')}<h2>Inga egna uppgifter på Rimbo</h2><p>Exempelpersonen arbetar på Norrtälje. Personliga uppdrag och teamuppgifter visas inom den tilldelade anläggningen.</p><button class="button secondary" data-dash-toast="Välj Norrtälje i anläggningsväljaren för att se exempelpersonens uppgifter.">Visa hur filtret fungerar</button></div></section>`;
    const metrics = {
      kontor: [['Att komplettera', '2', 'Kund och ursprung · Rimbo', 'FilePenLine', 'blue'], ['Kunder väntar', '0', 'Ingen aktiv ID-kontroll på Rimbo', 'Contact', 'green'], ['Redo för nästa steg', '1', 'Kundgodkännande · Rimbo', 'ArrowRight', 'blue'], ['Färdiga invägningar', '8', '2,14 ton registrerat idag', 'Scale', 'purple']],
      ekonomi: [['Att attestera', '1', 'Inom din behörighet · Rimbo', 'BadgeCheck', 'blue'], ['Utbetalningskö', money(5700), '1 attesterat kort · Rimbo', 'Wallet', 'green'], ['Spiris behöver åtgärd', '0', 'Inga avvisade Rimbo-ärenden', 'PlugZap', 'green'], ['Attesterat idag', '2', 'Inköpsvärde 10 060 kr exkl. moms', 'CircleCheck', 'purple']],
      transport: [['Uppdrag idag', '4', '3 bemannade · 1 väntar på svar', 'ClipboardList', 'blue'], ['Förare saknas', '0', 'Inga bemanningsärenden på Rimbo', 'Users', 'green'], ['Åkerisvar väntar', '1', 'AO-252 · extern hämtning', 'Send', 'amber'], ['Pågående körningar', '1', 'Tilldelad extern chaufför', 'Truck', 'green']],
      systemadmin: [['Oklara överföringar', '0', 'Inga oklara Rimbo-ärenden', 'TriangleAlert', 'green'], ['Avvisade ärenden', '1', 'NVV-rapport · behöver kontroll', 'CircleAlert', 'amber'], ['Väntar i kö', '1', 'NVV · Rimbo', 'ListOrdered', 'blue'], ['Terminaler online', '0 / 1', 'Terminal 3 är offline', 'Monitor', 'amber']]
    };
    const queues = {
      kontor: [{ title: 'Komplettera kunden på invägningen', detail: 'INV-3021 · Rimbo · kund behöver väljas före godkännande', label: 'Öppna kortet', type: 'weighing', id: 'INV-3021', tone: 'blue' }, { title: 'Ett kort är redo för kundgranskning', detail: 'INV-3020 · Rimbo Bygg AB · kund och ursprung finns sparade', label: 'Granska kortet', type: 'review', id: 'INV-3020', tone: 'blue' }],
      ekonomi: [{ title: 'Ett Rimbo-kort är färdigt för attest', detail: 'INV-3022 · Solbackens BRF · 5 700 kr · inom din beloppsgräns', label: 'Granska och attestera', type: 'attest', id: 'INV-3022', tone: 'blue' }],
      transport: [{ title: 'Väntar på åkeriets svar', detail: 'AO-252 · hämtning på Rimbo · önskad tid 14:00', label: 'Öppna förfrågan', type: 'workorder', id: 'AO-252', tone: 'amber' }],
      systemadmin: [{ title: 'NVV avvisade en rapport från Rimbo', detail: 'INV-3012 · kontrollera rapportör och organisationsnummer', label: 'Granska svaret', type: 'integration', id: 'NVV-3012', tone: 'amber' }]
    };
    return kpis(metrics[profileId] || metrics.kontor) + `<div class="dashboard-grid"><div class="dashboard-primary">${tasks('Uppgifter på Rimbo', 'Anläggningsfiltret begränsar både listan och siffrorna.', queues[profileId] || queues.kontor)}${schedule([['14:00', 'Hämtning · Rimbo Bygg AB', 'AO-252 · extern förfrågan · åkerisvar väntar', 'Väntar på svar', 'amber', 'AO-252']], 'Planeringen på Rimbo')}</div><aside class="dashboard-secondary"><section class="panel">${heading('Rimbo idag', '')}<div class="status-list">${row('Färdiga invägningar', '2,14 ton material registrerat', '<strong>8</strong>', 'Scale')}${row('Terminal 3', 'Senaste kontakt 08:14', pill('Offline', 'grey'), 'Monitor')}${row('Registrerat lager', 'Samlat per anläggning', '<strong>8,2 ton</strong>', 'Package')}</div></section>${ai('Sammanfattning för vald anläggning', 'Rimbo har en extern förfrågan som väntar på svar. Ett NVV-ärende behöver kontroll. Förklaringar följer användarens behörigheter.', profileId, 'Förklara läget på Rimbo')}</aside></div>`;
  }

  const views = { kontor: office, ekonomi: finance, transport, gruppledare: team, vd: management, systemadmin: admin, gard: yard, chauffor: driver };
  function render(profileId = 'kontor') {
    const profile = profiles.find(p => p.id === profileId) || profiles[0];
    currentProfile = profile.id;
    const active = localState[profile.id]?.tab || (profile.id === 'vd' ? 'business' : 'work');
    const showTabs = !['gard', 'chauffor', 'systemadmin'].includes(profile.id);
    const title = active === 'business' ? (profile.id === 'gruppledare' ? 'Teamöversikt' : 'Verksamheten') : profile.title;
    const captions = {
      kontor: 'Kunder som väntar, kort att komplettera och nästa steg i flödet.',
      ekonomi: 'Attest, utbetalningar och överföringar som behöver din uppmärksamhet.',
      transport: 'Dagens körningar, bemanning och externa förfrågningar.',
      gruppledare: 'Lös bemanning och håll koll på teamets tillgänglighet och kompetens.',
      vd: 'Utveckling, volymer och flaskhalsar i verksamheten.',
      systemadmin: 'Integrationsärenden och systemuppgifter som behöver kontroll.',
      gard: 'Fortsätt dina vägningar och lämna färdiga kort till kontoret.',
      chauffor: 'Dina körningar, kontaktuppgifter och dokument före avfärd.'
    };
    const content = window.MockupSite === 'rimbo' && profile.id !== 'vd' ? rimboOverview(profile.id) : active === 'business' && profile.id !== 'vd' ? operationsSummary(profile.id) : profile.id === 'vd' && active === 'work' ? tasks('Dina uppföljningar', 'Verksamhetsfrågor som behöver ett beslut eller en ansvarig.', [
      { title: 'Tre uppdrag behöver löst bemanning', detail: 'Transportledningen arbetar med ersättare · följ upp dagens kapacitet', label: 'Granska bemanningen', type: 'staffing', id: 'TEAM-TODAY', tone: 'amber' },
      { title: 'Två ekonomiöverföringar behöver kontroll', detail: 'Spiris · ett avvisat och ett oklart svar · följ upp med ekonomi', label: 'Granska ärendena', type: 'integration', id: 'SPIRIS-QUEUE', tone: 'blue' },
      { title: 'Följ upp ökningen på Norrtälje', detail: 'Materialvolym +14,2 % · granska periodens material och levererande kunder', label: 'Se verksamheten', type: 'business', id: 'NORRTALJE', tone: 'blue' }
    ]) + ai('Din verksamhetssammanfattning', 'Samla periodens förändringar och ärenden att följa upp. Beräknade siffror och källor visas tillsammans med sammanfattningen.', 'vd', 'Öppna sammanfattning') : views[profile.id]();
    return `<div class="role-dashboard" data-dashboard-profile="${profile.id}"><div class="page-title"><div><span class="eyebrow">ÖVERSIKT · ${profile.name.toLocaleUpperCase('sv')}</span><h1>${title}</h1><p>${captions[profile.id]}</p></div><div class="dashboard-header-actions">${profile.id === 'transport' ? open('Ny arbetsorder', 'workorder', 'new', 'button primary', 'Plus') : profile.id === 'vd' ? open('Veckosammanfattning', 'ai', 'vd', 'button secondary', 'Sparkles') : `<span class="date-pill">${icon('CalendarDays')}Måndag 12 oktober</span>`}</div></div>${showTabs ? tabbar(profile.id, active) : ''}<p class="small muted dashboard-scope">${icon('Building2')}${siteName()} · uppgifter inom din åtkomst</p><div class="dashboard-content" role="tabpanel">${content}</div></div>`;
  }

  function bind(container, helpers) {
    const dashboard = container.querySelector('[data-dashboard-profile]');
    if (!dashboard) return;
    const profileId = dashboard.dataset.dashboardProfile;
    dashboard.addEventListener('click', event => {
      const element = event.target.closest('[data-dash-case],[data-dash-nav],[data-dash-tab],[data-dash-filter],[data-dash-toast]');
      if (!element || !container.contains(element)) return;
      if (element.dataset.dashCase) helpers.openCase(element.dataset.dashCase, element.dataset.dashId);
      if (element.dataset.dashNav) helpers.navigate(element.dataset.dashNav);
      if (element.dataset.dashToast) helpers.toast(element.dataset.dashToast);
      if (element.dataset.dashTab) {
        localState[profileId] = { ...localState[profileId], tab: element.dataset.dashTab };
        helpers.setProfile(profileId);
      }
      if (element.dataset.dashFilter) {
        const panel = element.closest('.tasks');
        for (const button of panel.querySelectorAll('[data-dash-filter]')) {
          const active = button === element;
          button.classList.toggle('active', active);
          button.setAttribute('aria-pressed', String(active));
        }
        let visible = 0;
        for (const entry of panel.querySelectorAll('.dashboard-task-entry')) {
          entry.hidden = element.dataset.dashFilter === 'urgent' && !['amber', 'red'].includes(entry.dataset.taskTone);
          if (!entry.hidden) visible++;
        }
        panel.querySelector('.empty-state').hidden = visible !== 0;
      }
    }, { signal: helpers.signal });
    const period = container.querySelector('[data-dash-period]');
    period?.addEventListener('change', () => {
      container.querySelector('[data-management-current]').hidden = period.value === 'previous';
      container.querySelector('[data-management-previous]').hidden = period.value !== 'previous';
      helpers.toast(period.value === 'previous' ? 'Exempelvärden för september visas. Diagram och kundlistor visar fortsatt oktober i denna mockup.' : 'Exempelvärden för 1–12 oktober visas.');
    }, { signal: helpers.signal });
    container.querySelector('[data-dash-compare]')?.addEventListener('change', event => {
      helpers.toast(event.target.value === 'Ingen jämförelse' ? 'Mockup: jämförelseperiod kan döljas i den färdiga översikten.' : 'Jämförelse mot samma antal dagar föregående månad.');
    }, { signal: helpers.signal });
  }
  window.DashboardMockup = { profiles, render, bind };
})();
