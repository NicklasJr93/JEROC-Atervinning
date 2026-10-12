(function () {
  'use strict';

  const TODAY = '2026-10-12';
  const WEEK_START = '2026-10-12';
  const reportLabels = { draft: ['Utkast', 'grey'], submitted: ['Väntar på granskning', 'amber'], approved: ['Godkänd', 'green'], returned: ['Behöver rättas', 'red'] };
  const leaveLabels = { pending: ['Väntar på beslut', 'amber'], approved: ['Godkänd', 'green'], rejected: ['Avslagen', 'red'], withdrawn: ['Tillbakadragen', 'grey'] };
  const typeLabels = { holiday: 'Semester', leave: 'Ledighet', comp: 'Kompledigt' };
  const weekday = ['Sön', 'Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör'];
  const num = value => Number(value) || 0;
  const localDate = value => new Date(value + 'T12:00:00');
  const formatNumber = value => Number(value).toLocaleString('sv-SE', { maximumFractionDigits: 1 });
  function addDays(value, days) {
    const date = localDate(value);
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function weekNumber(value) {
    const date = localDate(value);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
    const firstThursday = new Date(date.getFullYear(), 0, 4);
    firstThursday.setDate(firstThursday.getDate() + 3 - (firstThursday.getDay() + 6) % 7);
    return 1 + Math.round((date - firstThursday) / 604800000);
  }
  const monthLabel = value => localDate(value).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
  const swedishDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(localDate(value).valueOf()) ? localDate(value).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Välj datum';
  const routeOf = ctx => String(ctx.state.route || location.hash.slice(1) || 'profil').replace(/^#?\/?/, '').split('?')[0];
  const personOf = ctx => Object.assign({ name: 'Kalle Nilsson', role: 'Chaufför', site: 'Norrtälje', manager: 'Anna Berg' }, ctx.state.person || {});
  const esc = (ctx, value) => ctx.esc(String(value == null ? '' : value));
  const icon = (ctx, name, size = 20) => ctx.icon(name, size);
  const pill = (ctx, text, tone = 'grey') => `<span class="pm-pill pm-pill-${tone}">${esc(ctx, text)}</span>`;
  const button = (ctx, text, route, name, style = 'primary') => `<button type="button" class="pm-button pm-button-${style}" data-go="${route}">${name ? icon(ctx, name, 19) : ''}<span>${esc(ctx, text)}</span></button>`;
  const notice = (ctx, text, tone = 'blue', name = 'Info') => `<div class="pm-notice pm-notice-${tone}">${icon(ctx, name, 18)}<div>${text}</div></div>`;
  const dateField = (ctx, name, value, min, max = '') => `<span class="pm-date-field"><span aria-hidden="true" data-date-label="${name}">${esc(ctx, swedishDate(value))}</span>${icon(ctx, 'CalendarDays', 17)}<input name="${name}" type="date" value="${esc(ctx, value)}" min="${esc(ctx, min)}" ${max ? `max="${max}"` : ''} required></span>`;
  const statusPill = (ctx, status, leave = false) => { const pair = (leave ? leaveLabels : reportLabels)[status] || ['Utkast', 'grey']; return pill(ctx, pair[0], pair[1]); };
  function workedMinutes(ctx, entry) { return Math.max(0, num(ctx.minutes(entry.end)) - num(ctx.minutes(entry.start)) - num(entry.breakMinutes)); }
  function reportSummary(ctx) {
    const data = ctx.reportSummary() || {};
    const worked = data.worked == null ? (ctx.state.report.entries || []).reduce((total, entry) => total + workedMinutes(ctx, entry), 0) : num(data.worked);
    const absence = data.absence == null ? 120 : num(data.absence);
    const planned = num(data.planned == null ? data.scheduled == null ? 2400 : data.scheduled : data.planned);
    return { worked, absence, planned, deviation: data.deviation == null ? data.variance == null ? worked + absence - planned : num(data.variance) : num(data.deviation) };
  }
  function hourText(ctx, value) { const text = String(ctx.hours(value)); return /\bh$/.test(text) ? text : `${text} h`; }
  function hourValue(ctx, value) { return esc(ctx, hourText(ctx, value).replace(/\s*h$/, '')); }
  function hours(ctx, value) { return esc(ctx, hourText(ctx, value)); }
  function deviationText(minutes) { return `${minutes > 0 ? '+' : ''}${formatNumber(minutes)} min`; }
  function balance(ctx) {
    const data = ctx.leaveBalance();
    return { ...data, annual: num(data.annual), taken: num(data.taken), approved: num(data.approved), pending: num(data.pending), balance: num(data.balance), comp: num(data.comp), flex: num(data.flex) };
  }
  function range(ctx, request) { return request.start === request.end ? esc(ctx, ctx.dateLabel(request.start)) : `${esc(ctx, monthLabel(request.start))}–${esc(ctx, ctx.dateLabel(request.end))}`; }
  function jobCount(ctx, request) { const result = ctx.affectedJobs(request); return Array.isArray(result) ? result.length : num(result && typeof result === 'object' ? result.count : result); }
  function menuRow(ctx, title, description, route, name, extra = '') {
    return `<button type="button" class="pm-menu-row" data-go="${route}"><span class="pm-menu-icon">${icon(ctx, name, 22)}</span><span class="pm-grow"><strong>${title}</strong><small>${description}</small></span>${extra}${icon(ctx, 'ChevronRight', 18)}</button>`;
  }
  function localNav(ctx, route) {
    const items = [['start', 'Start', 'House'], ['schema', 'Schema', 'CalendarDays'], ['tid', 'Tid', 'Clock3'], ['ledighet', 'Ledighet', 'Sun'], ['saldo', 'Saldo', 'Wallet']];
    const active = route === 'registrera' ? 'tid' : route === 'ansok' ? 'ledighet' : route;
    return `<nav class="pm-bottom-nav" aria-label="Min personal">${items.map(([target, label, name]) => `<button type="button" class="${target === active ? 'active' : ''}" data-go="${target}" ${target === active ? 'aria-current="page"' : ''}>${icon(ctx, name, 21)}<span>${label}</span></button>`).join('')}</nav>`;
  }
  function appNav(ctx) {
    return `<nav class="pm-bottom-nav pm-app-nav" aria-label="Appens huvudmeny">${[['Hem', 'House'], ['Vägningar', 'List'], ['Prislista', 'FileText'], ['Profil', 'UserRound']].map(([label, name]) => `<button type="button" ${label === 'Profil' ? 'class="active" data-go="profil" aria-current="page"' : `data-mobile-action="app-menu" data-label="${label}"`}>${icon(ctx, name, 22)}<span>${label}</span></button>`).join('')}</nav>`;
  }
  function header(ctx, route) {
    const titles = { profil: 'Profil', start: 'Min personal', schema: 'Mitt schema', tid: 'Min tidrapport', registrera: ctx.state.editingEntryId ? 'Redigera arbetstid' : 'Registrera arbetstid', ledighet: 'Min ledighet', ansok: 'Ansök om ledighet', saldo: 'Mina saldon' };
    const back = route === 'registrera' ? 'tid' : route === 'ansok' ? 'ledighet' : route === 'start' ? 'profil' : 'start';
    return `<header class="pm-header">${route === 'profil' ? '' : `<button type="button" class="pm-icon-button" data-go="${back}" aria-label="Tillbaka till ${back === 'start' ? 'Min personal' : back === 'profil' ? 'Profil' : back === 'tid' ? 'Min tidrapport' : 'Min ledighet'}">${icon(ctx, 'ArrowLeft', 22)}</button>`}<div class="pm-grow">${route !== 'profil' ? '<span class="pm-eyebrow">MIN PERSONAL</span>' : ''}<h1>${titles[route] || titles.start}</h1></div>${route !== 'profil' ? '<span class="pm-mini-avatar" aria-label="Kalle Nilsson">KN</span>' : ''}</header>`;
  }
  function profile(ctx) {
    const person = personOf(ctx);
    return `<section class="pm-profile-identity"><span class="pm-big-avatar">KN</span><h2>${esc(ctx, person.name)}</h2><p>${esc(ctx, person.role)} · ${esc(ctx, person.site)}</p>${pill(ctx, 'Demokonto', 'green')}</section>
      <section class="pm-card pm-profile-data" aria-label="Profiluppgifter"><div><span>Användarnamn</span><strong>kalle.nilsson</strong></div><div><span>Anläggning</span><strong>${esc(ctx, person.site)}</strong></div><div><span>Närmaste chef</span><strong>${esc(ctx, person.manager)}</strong></div></section>
      <button type="button" class="pm-personal-entry" data-go="start"><span class="pm-entry-icon">${icon(ctx, 'UserRound', 25)}</span><span class="pm-grow"><span class="pm-eyebrow">DIN ARBETSVECKA</span><strong>Min personal</strong><small>Schema, tid, ledighet & saldon</small></span>${icon(ctx, 'ChevronRight', 22)}</button>
      <section class="pm-card pm-menu-list">${menuRow(ctx, 'Mitt schema', 'Kommande arbetspass och frånvaro', 'schema', 'CalendarDays')}${menuRow(ctx, 'Min tidrapport', `5–9 oktober · ${(reportLabels[ctx.state.report.status] || reportLabels.draft)[0].toLocaleLowerCase('sv')}`, 'tid', 'Clock3')}${menuRow(ctx, 'Ledighet & saldon', 'Ansök och följ dina beslut', 'ledighet', 'Sun')}</section>
      ${notice(ctx, 'Här samlas dina egna personaluppgifter. Har du frågor om schema eller saldon hjälper din närmaste chef dig.')}`;
  }
  function start(ctx) {
    const person = personOf(ctx), data = reportSummary(ctx), balances = balance(ctx), report = ctx.state.report;
    return `<div class="pm-greeting"><span class="pm-eyebrow">MÅNDAG 12 OKTOBER</span><h2>Hej, ${esc(ctx, person.name.split(' ')[0])}.</h2><p>Här har du koll på din arbetsvecka.</p></div>
      <section class="pm-today-card"><div class="pm-section-head"><span class="pm-eyebrow">DITT PASS IDAG</span>${pill(ctx, 'Schemalagt', 'green')}</div><div class="pm-shift-time">07:00 <span>–</span> 16:00</div><p>${icon(ctx, 'MapPin', 15)} ${esc(ctx, person.site)} · Transport</p><div class="pm-shift-meta"><span>8 h planerad arbetstid</span><span>1 h obetald rast</span></div><button type="button" class="pm-inline-link" data-go="schema">Se mitt schema ${icon(ctx, 'ArrowRight', 17)}</button></section>
      <section class="pm-card"><div class="pm-section-head"><h2>Förra veckans tid</h2>${statusPill(ctx, report.status)}</div><p class="pm-muted pm-text-small">5–9 oktober · vecka 41</p><div class="pm-report-overview"><div><strong>${hourValue(ctx, data.worked)}<span> h</span></strong><small>Arbetad tid</small></div><div><strong>${hourValue(ctx, data.planned)}<span> h</span></strong><small>Schemalagt</small></div></div><p class="pm-muted pm-text-small">${hours(ctx, data.absence)} frånvaro registrerad · ${data.deviation === 0 ? 'enligt schema' : `${data.deviation > 0 ? '+' : ''}${hours(ctx, data.deviation)} skillnad mot schema`}</p>${button(ctx, report.status === 'draft' || report.status === 'returned' ? 'Granska min tidrapport' : 'Visa min tidrapport', 'tid', 'ArrowRight', 'soft')}</section>
      <div class="pm-section-head"><h2>Ledighet & saldon</h2></div><section class="pm-card pm-menu-list">${menuRow(ctx, 'Ansök om ledighet', 'Semester, ledighet eller komptid', 'ansok', 'Sun')}${menuRow(ctx, 'Semester kvar', `${formatNumber(balances.pending)} dagar ansökta · inväntar beslut`, 'saldo', 'Wallet', `<strong class="pm-row-number">${formatNumber(balances.balance)}<small>dagar</small></strong>`)}</section>
      <div class="pm-manager-note">${icon(ctx, 'UserRound', 17)}<span>Din chef är <strong>${esc(ctx, person.manager)}</strong></span></div>`;
  }
  function schema(ctx) {
    const offset = num(ctx.state.mobileScheduleWeek), startDate = addDays(WEEK_START, offset * 7), endDate = addDays(startDate, 6);
    const requests = ctx.state.leaveRequests || [];
    const visiblePending = requests.filter(request => request.status === 'pending' && request.start <= endDate && request.end >= startDate);
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(startDate, i), weekend = i > 4;
      const approved = requests.find(request => request.status === 'approved' && request.start <= date && request.end >= date);
      const pending = requests.find(request => request.status === 'pending' && request.start <= date && request.end >= date);
      const historicalAbsence = date === '2026-10-07';
      const fullDayOff = approved && approved.portion !== 'half';
      return `<article class="pm-schedule-day ${date === TODAY ? 'pm-today' : ''} ${weekend ? 'pm-weekend' : ''}"><div class="pm-schedule-date"><strong>${weekday[localDate(date).getDay()]}</strong><span>${localDate(date).getDate()}</span>${date === TODAY ? '<small>Idag</small>' : ''}</div><div class="pm-grow">${weekend ? '<strong class="pm-muted">Ledig</strong><small>Inget arbetspass</small>' : fullDayOff ? `<strong>${esc(ctx, typeLabels[approved.type] || 'Ledighet')}</strong><small>Hela dagen · godkänd frånvaro</small>${pill(ctx, 'Godkänd', 'green')}` : `<strong>${approved ? 'Halvt arbetspass' : '07:00–16:00'}</strong><small>Norrtälje · Transport</small><span class="pm-schedule-sub">${approved ? '4 h arbete · tid bestäms med chef' : historicalAbsence ? '6 h arbete · 2 h VAB' : '8 h planerat · rast 12:00–13:00'}</span>${approved ? pill(ctx, `${typeLabels[approved.type]} · halv dag`, 'green') : ''}${pending ? pill(ctx, 'Ansökan väntar på beslut', 'amber') : ''}${date === TODAY ? `<details class="pm-jobs"><summary>3 planerade uppdrag ${icon(ctx, 'ChevronDown', 15)}</summary><ul><li><strong>08:00 · Hämtning</strong><span>Norrtälje Bygg · Container 10 m³</span></li><li><strong>10:30 · Leverans</strong><span>Roslagsbostäder · Container 8 m³</span></li><li><strong>14:00 · Hämtning</strong><span>Rimbo Entreprenad · Metall</span></li></ul></details>` : ''}`}</div></article>`;
    }).join('');
    return `<div class="pm-week-picker"><button type="button" class="pm-icon-button" data-mobile-action="schedule-previous" aria-label="Föregående vecka">${icon(ctx, 'ChevronLeft', 21)}</button><div><strong>${monthLabel(startDate)}–${monthLabel(endDate)}</strong><small>Vecka ${weekNumber(startDate)}${offset === 0 ? ' · denna vecka' : ''}</small></div><button type="button" class="pm-icon-button" data-mobile-action="schedule-next" aria-label="Nästa vecka">${icon(ctx, 'ChevronRight', 21)}</button></div>
      ${offset !== 0 ? '<button type="button" class="pm-inline-link pm-center" data-mobile-action="schedule-today">Till denna vecka</button>' : ''}
      ${visiblePending.length ? notice(ctx, '<strong>Din ansökan väntar på beslut.</strong><p>Arbetspassen ligger kvar tills ledigheten har godkänts av din chef.</p>', 'amber') : ''}
      <section class="pm-card pm-schedule-list" aria-label="Veckans arbetspass">${days}</section>
      ${notice(ctx, 'Schemat visar planerad arbetstid. Registrera din faktiska start, sluttid och rast i <strong>Tid</strong>.')}
      ${button(ctx, 'Ansök om ledighet', 'ansok', 'Sun', 'outline')}`;
  }
  function report(ctx) {
    const data = reportSummary(ctx), current = ctx.state.report, editable = current.status === 'draft' || current.status === 'returned';
    const person = personOf(ctx);
    const entries = (current.entries || []).map(entry => {
      const deviation = workedMinutes(ctx, entry) + (entry.date === '2026-10-07' ? 120 : 0) - 480;
      return `<button type="button" class="pm-time-row" data-mobile-action="${editable ? 'edit-entry' : 'view-entry'}" data-entry-id="${esc(ctx, entry.id)}"><span class="pm-date-chip"><strong>${weekday[localDate(entry.date).getDay()]}</strong><span>${localDate(entry.date).getDate()}</span></span><span class="pm-grow"><strong>${esc(ctx, entry.start)}–${esc(ctx, entry.end)}</strong><small>${num(entry.breakMinutes)} min rast${entry.date === '2026-10-07' ? ' · 2 h VAB separat' : ''}</small>${entry.note ? `<span class="pm-entry-note">${esc(ctx, entry.note)}</span>` : ''}</span><span class="pm-time-total"><strong>${hours(ctx, workedMinutes(ctx, entry))}</strong>${deviation ? `<small>${deviationText(deviation)}</small>` : ''}</span>${editable ? icon(ctx, 'ChevronRight', 17) : icon(ctx, 'LockKeyhole', 15)}</button>`;
    }).join('');
    return `<div class="pm-section-head"><div><h2>5–9 oktober</h2><p class="pm-muted pm-text-small">Vecka 41 · ${esc(ctx, person.name)}</p></div>${statusPill(ctx, current.status)}</div>
      ${current.status === 'returned' ? notice(ctx, `<strong>Anna ber dig rätta rapporten.</strong><p>${esc(ctx, current.reason || 'Kontrollera tiden på tisdagen och skicka in igen.')}</p>`, 'red', 'MessageSquare') : current.status === 'submitted' ? notice(ctx, '<strong>Din tidrapport är inskickad.</strong><p>Anna Berg granskar tiden och avvikelsen. Du kan följa beslutet här.</p>', 'green', 'CheckCircle2') : current.status === 'approved' ? notice(ctx, '<strong>Din tidrapport är godkänd.</strong><p>Granskad av Anna Berg. Beslut om avvikelsen hanteras separat.</p>', 'green', 'CheckCircle2') : ''}
      <section class="pm-card pm-time-summary"><div class="pm-main-metric"><span>Arbetad tid</span><strong>${hourValue(ctx, data.worked)}<small> h</small></strong></div><div class="pm-two-metrics"><div><span>Frånvaro</span><strong>${hours(ctx, data.absence)}</strong><small>VAB, onsdag</small></div><div><span>Schemalagt</span><strong>${hours(ctx, data.planned)}</strong><small>Planerad arbetstid</small></div></div><div class="pm-variance"><span>${icon(ctx, 'Info', 16)} Skillnad mot schema</span><strong>${data.deviation >= 0 ? '+' : ''}${hours(ctx, data.deviation)}</strong></div></section>
      ${data.deviation !== 0 ? notice(ctx, `<strong>${formatNumber(Math.abs(data.deviation))} minuter ${data.deviation > 0 ? 'utöver schema' : 'under schema'}${current.status === 'approved' ? '.' : ' att granska.'}</strong><p>Arbetstid och frånvaro jämförs med schemat. Extra tid blir inte automatiskt övertid, komp eller flex.</p>`, 'amber') : notice(ctx, '<strong>Registrerad tid stämmer med schemat.</strong><p>Arbetad tid och frånvaro uppgår tillsammans till 40 timmar.</p>', 'green', 'CheckCircle2')}
      <div class="pm-section-head"><h2>Registrerade dagar</h2>${editable ? '<button type="button" class="pm-inline-link" data-mobile-action="new-entry">Lägg till</button>' : ''}</div><section class="pm-card pm-time-list">${entries || '<p class="pm-muted">Ingen arbetstid registrerad ännu.</p>'}</section>
      <section class="pm-card pm-absence-card"><span class="pm-menu-icon pm-menu-icon-green">${icon(ctx, 'CalendarMinus', 21)}</span><div><strong>VAB · onsdag 7 oktober</strong><p>07:00–09:00 · 2 h registrerad frånvaro</p><small>Frånvaron hålls separat från arbetad tid.</small></div></section>
      ${editable && ctx.state.mobileConfirmReport ? `<section class="pm-card pm-review-card"><h2>Skicka till ${esc(ctx, person.manager)}?</h2><p>Rapporten innehåller ${hours(ctx, data.worked)} arbete och ${hours(ctx, data.absence)} frånvaro.${data.deviation ? ` Din chef granskar även skillnaden mot schema: ${deviationText(data.deviation)}.` : ''}</p><p class="pm-muted pm-text-small">Efter att du skickat kan du inte redigera förrän din chef eventuellt skickar tillbaka rapporten.</p><div class="pm-form-error" id="pm-report-error" role="alert" hidden></div><button type="button" class="pm-button pm-button-primary" data-mobile-action="submit-report">${icon(ctx, 'Send', 18)} Skicka tidrapport</button><button type="button" class="pm-button pm-button-outline" data-mobile-action="cancel-submit">Fortsätt redigera</button></section>` : editable ? `<button type="button" class="pm-button pm-button-primary" data-mobile-action="review-submit">${icon(ctx, 'Send', 19)} Skicka för granskning</button><p class="pm-muted pm-text-small pm-center">Skickas till ${esc(ctx, person.manager)} för granskning.</p>` : ''}`;
  }
  function register(ctx) {
    const id = ctx.state.editingEntryId;
    const saved = (ctx.state.report.entries || []).find(item => item.id === id) || { date: '2026-10-09', start: '07:00', end: '16:00', breakMinutes: 60, note: '' };
    const entry = ctx.state.mobileTimeDraft && ctx.state.mobileTimeDraft.id === (id || '') ? { ...saved, ...ctx.state.mobileTimeDraft } : saved;
    const difference = workedMinutes(ctx, entry) - 480;
    const accountedDifference = difference + (entry.date === '2026-10-07' ? 120 : 0);
    const differenceLabel = `${entry.date === '2026-10-07' ? '2 h VAB separat · ' : ''}${accountedDifference === 0 ? 'arbete och frånvaro enligt schema' : `${deviationText(accountedDifference)} mot schema, inklusive frånvaro`}`;
    const editable = ctx.state.report.status === 'draft' || ctx.state.report.status === 'returned';
    if (!editable) return notice(ctx, 'Rapporten är inskickad och kan inte redigeras just nu.') + button(ctx, 'Till min tidrapport', 'tid', 'ArrowLeft', 'outline');
    return `<p class="pm-muted">Fyll i den tid du faktiskt arbetade.</p><form id="pm-time-form" data-form="time" class="pm-form" novalidate><input type="hidden" name="id" value="${esc(ctx, id || '')}"><label class="pm-field">Datum${dateField(ctx, 'date', entry.date, '2026-10-05', '2026-10-09')}</label><div class="pm-input-grid"><label class="pm-field">Starttid<input name="start" type="time" value="${esc(ctx, entry.start)}" required></label><label class="pm-field">Sluttid<input name="end" type="time" value="${esc(ctx, entry.end)}" required></label></div><label class="pm-field">Obetald rast, minuter<input name="breakMinutes" type="number" value="${esc(ctx, entry.breakMinutes)}" min="0" max="480" step="1" inputmode="numeric" required><small>Rasten räknas bort från din arbetade tid.</small></label><section class="pm-card pm-live-total" aria-live="polite"><div><span>Din registrering</span><strong id="pm-time-calculated">${hours(ctx, workedMinutes(ctx, entry))}</strong></div><div><span>Planerad arbetstid</span><strong id="pm-time-planned">8 h</strong></div><p id="pm-time-difference" class="pm-muted pm-text-small">${differenceLabel}</p></section><label class="pm-field">Kommentar <span class="pm-optional" id="pm-time-note-rule">${difference > 0 ? '(krävs vid längre arbetstid)' : '(valfritt)'}</span><textarea name="note" rows="3" maxlength="500" ${difference > 0 ? 'required' : ''} placeholder="Till exempel varför du arbetade längre">${esc(ctx, entry.note)}</textarea></label><div class="pm-form-error" id="pm-time-error" role="alert" hidden></div>${notice(ctx, 'Tiden sparas som utkast. Skicka hela veckans rapport när du är klar.')}</form><div class="pm-next-feature">${icon(ctx, 'Clock3', 17)}<div><strong>Stämpling kan läggas till senare</strong><p>Starttid, sluttid och rast fylls i manuellt här.</p></div></div>`;
  }
  function leaveCard(ctx, request) {
    const days = ctx.leaveDays(request), confirm = ctx.state.mobileWithdrawId === request.id;
    return `<article class="pm-card pm-leave-request"><div class="pm-section-head"><h3>${esc(ctx, typeLabels[request.type] || 'Ledighet')}</h3>${statusPill(ctx, request.status, true)}</div><strong class="pm-request-dates">${range(ctx, request)}</strong><p class="pm-muted pm-text-small">${formatNumber(days)} ${request.type === 'comp' ? 'arbetsdagar' : 'dagar'}${request.portion === 'half' ? ' · halv dag per arbetsdag' : ' · hela dagar'}</p>${request.note ? `<p class="pm-request-note">${esc(ctx, request.note)}</p>` : ''}${request.status === 'rejected' && request.reason ? notice(ctx, `<strong>Chefens kommentar</strong><p>${esc(ctx, request.reason)}</p>`, 'red', 'MessageSquare') : ''}${request.status === 'pending' ? `<div class="pm-request-state">${icon(ctx, 'Clock3', 15)} Väntar på Anna Berg · schemat gäller tills vidare</div>${confirm ? `<div class="pm-withdraw-confirm"><strong>Dra tillbaka ansökan?</strong><p>Ansökan tas bort från Annas lista. Ditt saldo och schema påverkas inte.</p><button type="button" class="pm-button pm-button-danger" data-mobile-action="confirm-withdraw" data-request-id="${esc(ctx, request.id)}">Ja, dra tillbaka</button><button type="button" class="pm-button pm-button-outline" data-mobile-action="cancel-withdraw">Behåll ansökan</button></div>` : `<button type="button" class="pm-inline-link" data-mobile-action="withdraw-leave" data-request-id="${esc(ctx, request.id)}">Dra tillbaka ansökan</button>`}` : request.status === 'approved' ? '<div class="pm-request-state pm-request-state-green">Godkänd frånvaro visas i ditt schema.</div>' : request.status === 'withdrawn' ? '<div class="pm-request-state">Ansökan är återtagen. Ingen ledighet bokas.</div>' : ''}</article>`;
  }
  function leaves(ctx) {
    const data = balance(ctx), requests = ctx.state.leaveRequests || [];
    const receipt = requests.find(request => request.id === ctx.state.justSubmittedLeaveId && request.status === 'pending');
    const pending = requests.filter(request => request.status === 'pending'), history = requests.filter(request => request.status !== 'pending');
    return `${receipt ? `<section class="pm-receipt" role="status"><span class="pm-receipt-icon">${icon(ctx, 'Check', 28)}</span><h2>Din ansökan är skickad</h2><p>${esc(ctx, typeLabels[receipt.type])} · ${range(ctx, receipt)}</p>${pill(ctx, 'Väntar på Anna Berg', 'amber')}<p class="pm-text-small">Du ser beslutet här. Ledigheten börjar gälla i schemat när den har godkänts.</p><button type="button" class="pm-inline-link" data-mobile-action="dismiss-receipt">Stäng bekräftelsen</button></section>` : ''}
      <section class="pm-card pm-leave-balance"><div><span class="pm-eyebrow">TILLGÄNGLIG SEMESTER</span><strong>${formatNumber(data.balance)} <small>dagar</small></strong><p>${formatNumber(data.pending)} dagar ansökta · inväntar beslut</p></div><button type="button" class="pm-icon-button" data-go="saldo" aria-label="Visa semestersaldo">${icon(ctx, 'ChevronRight', 22)}</button></section>
      ${button(ctx, 'Ansök om ledighet', 'ansok', 'Plus')}
      <div class="pm-section-head"><h2>Väntar på beslut</h2>${pill(ctx, String(pending.length), 'amber')}</div>${pending.length ? pending.map(request => leaveCard(ctx, request)).join('') : '<section class="pm-card pm-empty"><p>Du har inga ansökningar som väntar på beslut.</p></section>'}
      <div class="pm-section-head"><h2>Tidigare & godkända</h2></div>${history.length ? history.slice().reverse().map(request => leaveCard(ctx, request)).join('') : '<p class="pm-muted pm-text-small">Beslut och tillbakadragna ansökningar visas här.</p>'}
      ${notice(ctx, 'När din chef godkänner ansökan räknas ledigheten av från saldot, läggs in i schemat och berörda uppdrag behöver bemannas.')}`;
  }
  function leavePreview(ctx, request) {
    const data = balance(ctx), days = num(ctx.leaveDays(request));
    const count = jobCount(ctx, request), compNeeded = days * 480;
    if (!request.start || !request.end || request.end < request.start) return '<p class="pm-muted">Välj giltiga datum för att se omfattningen.</p>';
    return `<div class="pm-preview-head"><span>Omfattning</span><strong>${formatNumber(days)} arbetsdagar</strong></div>${request.type === 'holiday' ? `<div class="pm-preview-row"><span>Tillgängligt saldo idag</span><strong>${formatNumber(data.balance)} dagar</strong></div><div class="pm-preview-row"><span>Ansökta dagar utan beslut</span><strong>${formatNumber(data.pending)} dagar</strong></div><div class="pm-preview-row"><span>Om denna ansökan godkänns</span><strong class="${data.balance - days < 0 ? 'pm-text-red' : ''}">${formatNumber(data.balance - days)} dagar kvar</strong></div><p>Saldot ändras när din chef godkänner ansökan.</p>` : request.type === 'comp' ? `<div class="pm-preview-row"><span>Komp att använda</span><strong>${hours(ctx, compNeeded)}</strong></div><div class="pm-preview-row"><span>Kompsaldo</span><strong>${hours(ctx, data.comp)}</strong></div><p>${compNeeded > data.comp ? 'Ditt nuvarande kompsaldo räcker inte till hela ansökan.' : 'Komptiden räknas av när din chef godkänner ansökan.'}</p>` : '<p>Ansökan påverkar inte semestersaldot. Din chef bedömer vilken typ av ledighet som gäller.</p>'}<div class="pm-preview-impact">${icon(ctx, 'Truck', 17)}<span>${count ? `${count} planerade uppdrag kan beröras.` : 'Bemanning kontrolleras när din chef granskar.'} Schemat ändras först efter godkännande.</span></div>`;
  }
  function apply(ctx) {
    const request = { type: 'holiday', start: '2026-11-02', end: '2026-11-06', portion: 'full', note: '', ...ctx.state.mobileLeaveDraft };
    return `<p class="pm-muted">Välj datum och skicka till ${esc(ctx, personOf(ctx).manager)}.</p><form id="pm-leave-form" data-form="leave" class="pm-form" novalidate><label class="pm-field">Typ av ledighet<select name="type">${Object.entries(typeLabels).map(([value, label]) => `<option value="${value}" ${request.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="pm-input-grid"><label class="pm-field">Från och med${dateField(ctx, 'start', request.start, TODAY)}</label><label class="pm-field">Till och med${dateField(ctx, 'end', request.end, request.start)}</label></div><label class="pm-field">Omfattning<select name="portion"><option value="full" ${request.portion === 'full' ? 'selected' : ''}>Hela arbetsdagar</option><option value="half" ${request.portion === 'half' ? 'selected' : ''}>Halva arbetsdagar</option></select><small>Endast arbetsdagar räknas. Vid halvdag bestäms tiden med din chef.</small></label><section id="pm-leave-preview" class="pm-card pm-request-preview" aria-live="polite">${leavePreview(ctx, request)}</section><label class="pm-field">Kommentar <span class="pm-optional">(valfritt)</span><textarea name="note" rows="3" maxlength="500" placeholder="Till exempel önskemål om för- eller eftermiddag">${esc(ctx, request.note)}</textarea></label><div class="pm-form-error" id="pm-leave-error" role="alert" hidden></div>${notice(ctx, 'Det här är en ansökan. Dina arbetspass och uppdrag ligger kvar tills din chef har godkänt ledigheten.')}</form>`;
  }
  function balances(ctx) {
    const data = balance(ctx), reportData = reportSummary(ctx);
    return `<section class="pm-saldo-hero"><span class="pm-eyebrow">SEMESTER 2026</span><strong>${formatNumber(data.balance)}<small> dagar tillgängliga</small></strong><p>Efter uttag och godkänd kommande semester</p><div class="pm-saldo-pending"><span>${formatNumber(data.pending)} dagar ansökta · inväntar beslut</span><strong>Saldot ändras först efter godkännande</strong></div></section>
      <section class="pm-card pm-ledger"><h2>Så räknas ditt saldo</h2><div><span>Tilldelade semesterdagar</span><strong>${formatNumber(data.annual)} dagar</strong></div><div><span>Uttagen semester</span><strong>−${formatNumber(data.taken)} dagar</strong></div><div><span>Godkänd kommande semester</span><strong>−${formatNumber(data.approved)} dagar</strong></div><div class="pm-ledger-total"><span>Tillgängligt saldo</span><strong>${formatNumber(data.balance)} dagar</strong></div><div class="pm-ledger-available"><span>Ansökta dagar utan beslut</span><strong>${formatNumber(data.pending)} dagar</strong></div></section>
      <div class="pm-section-head"><h2>Komp & flex</h2></div><div class="pm-balance-grid"><section class="pm-card"><span class="pm-menu-icon pm-menu-icon-green">${icon(ctx, 'Clock3', 21)}</span><h3>Komptid</h3><strong>${hours(ctx, data.comp)}</strong><p>Godkänt saldo</p></section><section class="pm-card"><span class="pm-menu-icon">${icon(ctx, 'ArrowLeftRight', 21)}</span><h3>Flex</h3><strong>+${hours(ctx, data.flex)}</strong><p>Godkänt saldo</p></section></div>
      ${reportData.deviation > 0 ? notice(ctx, `<strong>${formatNumber(reportData.deviation)} minuter utöver schema.</strong><p>Avvikelsen i vecka 41 ingår inte i dina saldon. Din chef avgör om och hur den ska räknas.</p>`, 'amber') : ''}
      ${button(ctx, 'Ansök om ledighet', 'ansok', 'Sun')}${button(ctx, 'Visa mina ansökningar', 'ledighet', 'ArrowRight', 'outline')}<p class="pm-muted pm-text-small">Saldona i den här mockupen är fiktiva exempeluppgifter.</p>`;
  }
  const views = { profil: profile, start, schema, tid: report, registrera: register, ledighet: leaves, ansok: apply, saldo: balances };
  window.renderPersonalMobile = function (ctx) {
    const route = views[routeOf(ctx)] ? routeOf(ctx) : 'start';
    const form = route === 'registrera' || route === 'ansok';
    return `<div class="personal-mobile-shell" data-mobile-route="${route}">${header(ctx, route)}<div class="pm-main ${form ? 'pm-main-form' : ''}">${views[route](ctx)}</div>${form ? `<div class="pm-form-footer"><button type="submit" form="${route === 'registrera' ? 'pm-time-form' : 'pm-leave-form'}" class="pm-button pm-button-primary">${icon(ctx, route === 'registrera' ? 'Check' : 'Send', 19)} ${route === 'registrera' ? 'Spara arbetstid' : 'Skicka ansökan'}</button><span>${route === 'registrera' ? 'Sparas i veckans utkast' : 'Skickas till din närmaste chef'}</span></div>` : route === 'profil' ? appNav(ctx) : localNav(ctx, route)}</div>`;
  };
  function showError(element, message) {
    if (!element) return;
    element.textContent = message;
    element.hidden = false;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function refresh(ctx) { if (ctx.render) ctx.render(); else ctx.go(routeOf(ctx)); }
  function formInput(form) { return Object.fromEntries(new FormData(form).entries()); }
  function updateDateLabels(form) {
    form.querySelectorAll('[data-date-label]').forEach(label => { label.textContent = swedishDate(form.elements[label.dataset.dateLabel].value); });
  }
  window.bindPersonalMobile = function (ctx) {
    const shell = document.querySelector('.personal-mobile-shell');
    if (!shell) return;
    shell.querySelectorAll('.pm-date-field input').forEach(input => input.addEventListener('click', () => { try { input.showPicker?.(); } catch (_) {} }));
    shell.querySelectorAll('[data-mobile-action]').forEach(node => node.addEventListener('click', () => {
      const action = node.dataset.mobileAction;
      switch (action) {
        case 'app-menu': ctx.toast(`${node.dataset.label} hör till den vanliga appen. I mockupen kan du öppna Min personal från Profil.`); break;
        case 'edit-entry': ctx.state.editingEntryId = node.dataset.entryId; ctx.go('registrera'); break;
        case 'view-entry': ctx.toast(ctx.state.report.status === 'approved' ? 'Rapporten är godkänd. Kontakta Anna Berg om något behöver rättas.' : 'Rapporten är inskickad. Anna Berg behöver skicka tillbaka den innan du kan redigera.'); break;
        case 'new-entry': ctx.state.editingEntryId = null; ctx.go('registrera'); break;
        case 'schedule-previous': ctx.state.mobileScheduleWeek = num(ctx.state.mobileScheduleWeek) - 1; refresh(ctx); break;
        case 'schedule-next': ctx.state.mobileScheduleWeek = num(ctx.state.mobileScheduleWeek) + 1; refresh(ctx); break;
        case 'schedule-today': ctx.state.mobileScheduleWeek = 0; refresh(ctx); break;
        case 'review-submit': ctx.state.mobileConfirmReport = true; refresh(ctx); shell.ownerDocument.querySelector('.pm-review-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); break;
        case 'cancel-submit': ctx.state.mobileConfirmReport = false; refresh(ctx); break;
        case 'submit-report': {
          const result = ctx.submitReport();
          if (result === false || result && result.ok === false) showError(document.querySelector('#pm-report-error'), result.error || 'Kontrollera att alla arbetade dagar är registrerade innan du skickar.');
          else { ctx.state.mobileConfirmReport = false; ctx.go('tid'); }
          break;
        }
        case 'withdraw-leave': ctx.state.mobileWithdrawId = node.dataset.requestId; refresh(ctx); break;
        case 'cancel-withdraw': ctx.state.mobileWithdrawId = null; refresh(ctx); break;
        case 'confirm-withdraw': { ctx.state.mobileWithdrawId = null; const result = ctx.withdrawLeave(node.dataset.requestId); ctx.toast(result?.ok ? 'Ansökan är tillbakadragen.' : result?.error || 'Ansökan kunde inte dras tillbaka.'); break; }
        case 'dismiss-receipt': ctx.state.justSubmittedLeaveId = null; refresh(ctx); break;
      }
    }));
    const timeForm = shell.querySelector('#pm-time-form');
    if (timeForm) {
      const updateTime = () => {
        const data = formInput(timeForm), start = ctx.minutes(data.start), end = ctx.minutes(data.end), total = num(end) - num(start) - num(data.breakMinutes);
        ctx.state.mobileTimeDraft = data;
        updateDateLabels(timeForm);
        const valid = data.start && data.end && end > start && total > 0 && data.breakMinutes !== '' && Number.isInteger(num(data.breakMinutes)) && num(data.breakMinutes) >= 0;
        shell.querySelector('#pm-time-calculated').textContent = valid ? hourText(ctx, total) : '–';
        const isWeekday = data.date && localDate(data.date).getDay() > 0 && localDate(data.date).getDay() < 6;
        const planned = isWeekday ? 480 : 0;
        shell.querySelector('#pm-time-planned').textContent = hourText(ctx, planned);
        const absence = data.date === '2026-10-07' ? 120 : 0, deviation = total + absence - planned;
        shell.querySelector('#pm-time-difference').textContent = !valid ? 'Kontrollera start, sluttid och rast.' : `${absence ? '2 h VAB separat · ' : ''}${deviation === 0 ? 'arbete och frånvaro enligt schema' : `${deviationText(deviation)} mot schema, inklusive frånvaro`}`;
        timeForm.elements.note.required = !!valid && total > 480;
        shell.querySelector('#pm-time-note-rule').textContent = timeForm.elements.note.required ? '(krävs vid längre arbetstid)' : '(valfritt)';
        shell.querySelector('#pm-time-error').hidden = true;
      };
      timeForm.addEventListener('input', updateTime);
      timeForm.addEventListener('change', updateTime);
      timeForm.addEventListener('submit', event => {
        event.preventDefault();
        if (!timeForm.reportValidity()) return;
        const data = formInput(timeForm);
        const result = ctx.saveTimeEntry({ ...data, breakMinutes: num(data.breakMinutes) });
        if (!result || !result.ok) showError(shell.querySelector('#pm-time-error'), result?.error || 'Kontrollera datum, tider och rast.');
        else { ctx.state.mobileTimeDraft = null; ctx.go('tid'); }
      });
      updateTime();
    }
    const leaveForm = shell.querySelector('#pm-leave-form');
    if (leaveForm) {
      const updateLeave = () => {
        const data = formInput(leaveForm);
        ctx.state.mobileLeaveDraft = data;
        updateDateLabels(leaveForm);
        leaveForm.elements.end.min = data.start || TODAY;
        shell.querySelector('#pm-leave-preview').innerHTML = leavePreview(ctx, data);
        shell.querySelector('#pm-leave-error').hidden = true;
      };
      leaveForm.addEventListener('input', updateLeave);
      leaveForm.addEventListener('change', updateLeave);
      leaveForm.addEventListener('submit', event => {
        event.preventDefault();
        if (!leaveForm.reportValidity()) return;
        const result = ctx.saveLeaveRequest(formInput(leaveForm));
        if (!result || !result.ok) showError(shell.querySelector('#pm-leave-error'), result?.error || 'Kontrollera din ansökan och dina saldon.');
        else { ctx.state.mobileLeaveDraft = null; ctx.state.justSubmittedLeaveId = result.id; ctx.go('ledighet'); }
      });
    }
  };
})();
