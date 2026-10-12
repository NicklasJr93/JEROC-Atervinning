(function () {
  'use strict';

  // Presentation state only. All personnel changes go through the shared mock.
  var ui = { type: 'all', status: 'all', query: '', modal: '', reason: '', error: '', route: '' };
  var leaveNames = { holiday: 'Semester', leave: 'Ledighet', comp: 'Kompensationsledighet' };
  var statusNames = { pending: 'Väntar på beslut', submitted: 'Inskickad', approved: 'Godkänd', rejected: 'Avslagen', withdrawn: 'Återkallad', returned: 'Återförd', draft: 'Utkast' };

  function esc(ctx, value) { return ctx.esc(String(value == null ? '' : value)); }
  function icon(ctx, name, size) { return ctx.icon(name, size || 18); }
  function pill(ctx, status, label) {
    var tone = status === 'approved' ? 'green' : ['pending', 'submitted'].includes(status) ? 'orange' : ['rejected', 'returned'].includes(status) ? 'red' : 'grey';
    return '<span class="pm-pill ' + tone + '">' + esc(ctx, label || statusNames[status] || status) + '</span>';
  }
  function number(value) { return Number(value || 0).toLocaleString('sv-SE', { maximumFractionDigits: 1 }); }
  function hourLabel(value) { return number(value / 60) + ' h'; }
  function date(value, options) {
    if (!value) return '–';
    var parsed = new Date(String(value).slice(0, 10) + 'T12:00:00Z');
    return Number.isNaN(parsed.getTime()) ? '–' : new Intl.DateTimeFormat('sv-SE', options || { day: 'numeric', month: 'short' }).format(parsed);
  }
  function period(request) {
    if (request.start === request.end) return date(request.start);
    var sameMonth = String(request.start).slice(0, 7) === String(request.end).slice(0, 7);
    return date(request.start, sameMonth ? { day: 'numeric' } : undefined) + '–' + date(request.end);
  }
  function person(ctx) { return ctx.state.person && ctx.state.person.name || 'Kalle Nilsson'; }
  function initials(name) { return name.split(/\s+/).map(function (part) { return part[0]; }).join('').slice(0, 2); }
  function dayCount(ctx, request) { return Number(ctx.leaveDays(request) || 0); }
  function leaveRequests(ctx) {
    return (ctx.state.leaveRequests || []).filter(function (request) { return Boolean(leaveNames[request.type]); });
  }
  function button(ctx, label, action, style, glyph, attrs) {
    return '<button type="button" class="pm-btn ' + (style || '') + '" ' + (action ? 'data-manager-action="' + action + '" ' : '') + (attrs || '') + '>' + (glyph ? icon(ctx, glyph, 16) : '') + esc(ctx, label) + '</button>';
  }
  function alert(ctx, tone, glyph, title, detail) {
    return '<div class="pm-alert ' + tone + '">' + icon(ctx, glyph, 20) + '<div><strong>' + esc(ctx, title) + '</strong>' + (detail ? '<p>' + esc(ctx, detail) + '</p>' : '') + '</div></div>';
  }
  function metric(ctx, glyph, label, value, detail) {
    return '<div class="pm-metric"><span class="pm-metric-icon">' + icon(ctx, glyph, 20) + '</span><div><span>' + esc(ctx, label) + '</span><strong>' + esc(ctx, value) + '</strong><small>' + esc(ctx, detail) + '</small></div></div>';
  }
  function fact(ctx, label, value) {
    return '<div class="pm-fact"><dt>' + esc(ctx, label) + '</dt><dd>' + esc(ctx, value) + '</dd></div>';
  }
  function paneHeading(ctx, glyph, title, extra) {
    return '<div class="pm-panel-heading"><h2>' + icon(ctx, glyph, 18) + esc(ctx, title) + '</h2>' + (extra || '') + '</div>';
  }
  function pendingCount(ctx) {
    return leaveRequests(ctx).filter(function (request) { return request.status === 'pending'; }).length + (ctx.state.report.status === 'submitted' ? 1 : 0);
  }
  function staffingCount(ctx) {
    if (!ctx.state.staffingCreated || ctx.state.replacementAssigned) return 0;
    return leaveRequests(ctx).filter(function (request) { return request.status === 'approved'; }).reduce(function (total, request) { return total + ctx.affectedJobs(request).length; }, 0);
  }
  function shell(ctx, body, route) {
    var nav = [
      ['LayoutDashboard', 'Översikt'], ['Scale', 'Vägning'], ['Truck', 'Transport'],
      ['ClipboardList', 'Arbetsordrar'], ['Building2', 'Kunder'], ['Users', 'Personal'], ['PlugZap', 'Integrationer']
    ];
    return '<div class="personal-manager">' +
      '<aside class="pm-sidebar" aria-label="Kontorets huvudmeny"><img class="pm-logo" src="assets/jeroc-logo.png" alt="JEROC Återvinning"><span class="pm-eyebrow pm-nav-eyebrow">KONTORSÖVERSIKT</span><nav>' + nav.map(function (item) {
        return item[1] === 'Personal' ? '<button type="button" class="active" data-go="chef" aria-current="page">' + icon(ctx, item[0], 19) + '<span>Personal</span>' + (pendingCount(ctx) ? '<span class="pm-nav-count">' + pendingCount(ctx) + '</span>' : '') + '</button>' : '<span class="pm-nav-item">' + icon(ctx, item[0], 19) + '<span>' + item[1] + '</span></span>';
      }).join('') + '</nav>' +
      '<div class="pm-sidebar-bottom"><details class="pm-profile"><summary aria-label="Öppna Annas profilmeny"><span class="pm-avatar blue">AB</span><span><strong>Anna Berg</strong><small>Gruppledare · Norrtälje</small></span>' + icon(ctx, 'ChevronDown', 15) + '</summary><div class="pm-profile-dropdown"><strong>Anna Berg</strong><p>Chef för Transport Norrtälje</p><p>Du granskar ditt teams tidrapporter och ledighetsansökningar.</p>' + button(ctx, 'Visa Kalles mobilvy', '', 'outline', 'UserRound', 'data-go="start"') + '</div></details><span class="pm-online">● Klickbar mockup</span><p>Norrtälje · Fiktiva uppgifter</p></div></aside>' +
      '<div class="pm-workspace"><header class="pm-topbar"><div class="pm-breadcrumb"><span>Kontoret</span>' + icon(ctx, 'ChevronRight', 14) + '<button type="button" data-go="chef">Personal</button>' + icon(ctx, 'ChevronRight', 14) + '<span>Att godkänna</span></div><div class="pm-team">' + icon(ctx, 'Building2', 17) + '<span><small>Team</small><strong>Transport Norrtälje</strong></span></div></header>' +
      '<main class="pm-main" id="manager-content">' + body + '</main></div>' + modal(ctx) + '</div>';
  }
  function overviewRows(ctx) {
    var rows = leaveRequests(ctx).map(function (request) {
      return { kind: 'leave', request: request, status: request.status, title: leaveNames[request.type], range: period(request) + ' 2026', amount: number(dayCount(ctx, request)) + ' dagar', note: request.portion === 'half' ? 'Halva dagar' : 'Hela dagar' };
    });
    if (ctx.state.report.status !== 'draft') {
      var summary = ctx.reportSummary();
      rows.unshift({ kind: 'report', status: ctx.state.report.status, title: 'Tidrapport', range: '5–9 okt 2026', amount: hourLabel(summary.worked), note: 'Vecka 41 · manuellt registrerad' });
    }
    return rows.filter(function (row) {
      var typeMatches = ui.type === 'all' || ui.type === row.kind;
      var statusMatches = ui.status === 'all' || (ui.status === 'waiting' && ['pending', 'submitted'].includes(row.status)) || (ui.status === 'returned' && row.status === 'returned') || (ui.status === 'processed' && ['approved', 'rejected', 'withdrawn'].includes(row.status));
      var queryMatches = [person(ctx), 'Transport Norrtälje', row.title, row.range, statusNames[row.status]].join(' ').toLocaleLowerCase('sv-SE').includes(ui.query.trim().toLocaleLowerCase('sv-SE'));
      return typeMatches && statusMatches && queryMatches;
    });
  }
  function rowsMarkup(ctx) {
    var rows = overviewRows(ctx);
    if (!rows.length) return '<div class="pm-empty">' + icon(ctx, 'ClipboardCheck', 30) + '<strong>Inga ärenden matchar filtret</strong><p>Ändra ärendetyp, status eller din sökning.</p>' + button(ctx, 'Rensa filter', 'clear-filters', 'outline') + '</div>';
    return '<div class="pm-table-wrap"><table class="pm-table pm-requests-table"><thead><tr><th>Medarbetare</th><th>Ärende / period</th><th>Omfattning</th><th>Status</th><th><span class="pm-sr-only">Öppna ärende</span></th></tr></thead><tbody>' + rows.map(function (row) {
      var attrs = row.kind === 'report' ? 'data-go="chef-tid"' : 'data-manager-action="open-request" data-request-id="' + esc(ctx, row.request.id) + '"';
      return '<tr><td data-label="Medarbetare"><div class="pm-person"><span class="pm-avatar">' + esc(ctx, initials(person(ctx))) + '</span><div><strong>' + esc(ctx, person(ctx)) + '</strong><small>Transport Norrtälje</small></div></div></td><td data-label="Ärende"><strong>' + esc(ctx, row.title) + '</strong><small>' + esc(ctx, row.range) + '</small></td><td data-label="Omfattning"><strong>' + esc(ctx, row.amount) + '</strong><small>' + esc(ctx, row.note) + '</small></td><td data-label="Status">' + pill(ctx, row.status) + '</td><td class="pm-table-action"><button type="button" class="pm-link" ' + attrs + ' aria-label="Granska ' + esc(ctx, row.title.toLocaleLowerCase('sv-SE')) + ' för ' + esc(ctx, person(ctx)) + '">Granska ' + icon(ctx, 'ChevronRight', 15) + '</button></td></tr>';
    }).join('') + '</tbody></table></div>';
  }
  function overview(ctx) {
    var balance = ctx.leaveBalance();
    var waiting = pendingCount(ctx);
    return '<div class="pm-page-title"><div><span class="pm-eyebrow">PERSONAL / TRANSPORT NORRTÄLJE</span><h1>Att godkänna</h1><p>Tid och ledighet för ditt team. Inloggad som Anna Berg.</p></div><span class="pm-today">Måndag 12 oktober 2026</span></div>' +
      '<nav class="pm-section-nav" aria-label="Personal"><span>' + icon(ctx, 'Users', 16) + 'Medarbetare</span><span>' + icon(ctx, 'CalendarDays', 16) + 'Schema & frånvaro</span><button type="button" class="active" data-go="chef" aria-current="page">' + icon(ctx, 'ClipboardCheck', 16) + 'Att godkänna' + (waiting ? '<span class="pm-count">' + waiting + '</span>' : '') + '</button></nav>' +
      '<div class="pm-metrics">' + metric(ctx, 'ClipboardCheck', 'Väntar på ditt beslut', waiting + ' ärenden', 'Ledighetsansökningar och inskickad tid') + metric(ctx, 'CalendarDays', 'Kalles semestersaldo', number(balance.balance) + ' dagar', 'Efter uttaget och godkänd semester') + metric(ctx, 'Truck', 'Att bemanna', staffingCount(ctx) + ' uppdrag', ctx.state.replacementAssigned ? 'Ersättare tilldelad till berörda uppdrag' : 'Uppgifter skapas när ledighet godkänns') + '</div>' +
      '<section class="pm-panel">' + paneHeading(ctx, 'ClipboardCheck', 'Ärenden att granska', '<span class="pm-muted">Transport Norrtälje</span>') +
      '<div class="pm-filter-tabs" role="group" aria-label="Filtrera ärendetyp">' + [['all', 'Alla ärenden'], ['leave', 'Ledighetsansökningar'], ['report', 'Tidrapporter']].map(function (item) { return '<button type="button" data-manager-action="filter-type" data-type="' + item[0] + '" class="' + (ui.type === item[0] ? 'active' : '') + '" aria-pressed="' + (ui.type === item[0]) + '">' + item[1] + '</button>'; }).join('') + '</div>' +
      '<div class="pm-filters"><label class="pm-search">' + icon(ctx, 'Search', 17) + '<input type="search" id="manager-search" data-manager-search placeholder="Sök medarbetare eller ärende…" aria-label="Sök medarbetare eller ärende" value="' + esc(ctx, ui.query) + '"></label><label class="pm-select-label"><span class="pm-sr-only">Filtrera status</span><select data-manager-status aria-label="Filtrera status">' + [['all', 'Alla statusar'], ['waiting', 'Väntar på beslut'], ['returned', 'Återförda tidrapporter'], ['processed', 'Behandlade ärenden']].map(function (item) { return '<option value="' + item[0] + '"' + (ui.status === item[0] ? ' selected' : '') + '>' + item[1] + '</option>'; }).join('') + '</select></label></div><div id="manager-results">' + rowsMarkup(ctx) + '</div><p class="pm-list-foot"><span id="manager-result-count">' + overviewRows(ctx).length + '</span> ärenden visas · Frånvaroanmälningar hanteras i Schema & frånvaro.</p></section>' +
      '<div class="pm-guidance">' + icon(ctx, 'ShieldCheck', 18) + '<p>Godkännanden gäller ditt team. Återförd tidrapport väntar på att medarbetaren korrigerar och skickar in den igen.</p></div>';
  }
  function detailHeading(ctx, title, subtitle, status) {
    return button(ctx, 'Tillbaka till Att godkänna', '', 'pm-back', 'ArrowLeft', 'data-go="chef"') + '<div class="pm-page-title pm-detail-title"><div><span class="pm-eyebrow">GRANSKA / ' + esc(ctx, person(ctx).toLocaleUpperCase('sv-SE')) + '</span><h1>' + esc(ctx, title) + '</h1><p>' + esc(ctx, subtitle) + '</p></div>' + pill(ctx, status) + '</div>';
  }
  function employeeChip(ctx) {
    return '<div class="pm-employee-header"><span class="pm-avatar large">' + esc(ctx, initials(person(ctx))) + '</span><div><h2>' + esc(ctx, person(ctx)) + '</h2><p>Chaufför · Transport Norrtälje</p></div><span class="pm-pill grey">Anställd</span></div>';
  }
  function leaveView(ctx) {
    var request = ctx.selectedRequest();
    if (!request || !leaveNames[request.type]) return detailHeading(ctx, 'Ledighetsansökan', 'Ingen ledighetsansökan har valts.', 'withdrawn') + '<section class="pm-panel"><div class="pm-empty"><p>Välj en ansökan i översikten för att granska den.</p>' + button(ctx, 'Visa ärenden', '', 'outline', 'ArrowLeft', 'data-go="chef"') + '</div></section>';
    var days = dayCount(ctx, request), balance = ctx.leaveBalance(), jobs = ctx.affectedJobs(request), approved = request.status === 'approved';
    var isHoliday = request.type === 'holiday';
    var title = isHoliday ? 'Semesteransökan' : leaveNames[request.type];
    var approvalNotice = approved ? alert(ctx, 'green', 'Check', title + ' godkänd', number(days) + (isHoliday ? ' semesterdagar har reserverats. Beslutet visas också i Kalles mobil.' : ' ledighetsdagar har registrerats. Beslutet visas också i Kalles mobil.')) : request.status === 'rejected' ? alert(ctx, 'red', 'X', 'Ansökan avslagen', request.reason || 'Ansökan har avslagits av Anna Berg.') : request.status === 'withdrawn' ? alert(ctx, 'grey', 'Undo2', 'Ansökan återkallad', 'Medarbetaren har återkallat ansökan. Den kan inte godkännas.') : '';
    return detailHeading(ctx, title, period(request) + ' 2026 · ' + number(days) + ' arbetsdagar', request.status) + approvalNotice +
      '<div class="pm-detail-grid"><div><section class="pm-panel">' + employeeChip(ctx) + '<dl class="pm-facts">' + fact(ctx, 'Typ av ledighet', leaveNames[request.type]) + fact(ctx, 'Period', date(request.start, { day: 'numeric', month: 'long', year: 'numeric' }) + ' – ' + date(request.end, { day: 'numeric', month: 'long', year: 'numeric' })) + fact(ctx, 'Omfattning', request.portion === 'half' ? 'Halva dagar' : 'Hela dagar') + fact(ctx, 'Antal arbetsdagar', number(days) + ' dagar') + fact(ctx, 'Ansökan skickad', date(request.createdAt, { day: 'numeric', month: 'long', year: 'numeric' })) + '</dl><div class="pm-note"><span class="pm-eyebrow">MEDARBETARENS KOMMENTAR</span><p>' + esc(ctx, request.note || 'Ingen kommentar lämnad.') + '</p></div>' + (request.status === 'pending' ? '<div class="pm-decision-actions">' + button(ctx, 'Avslå med kommentar', 'reject-leave', 'outline danger', 'X') + button(ctx, 'Godkänn ledighet', 'approve-leave', '', 'Check', 'data-request-id="' + esc(ctx, request.id) + '"') + '</div><p class="pm-decision-note">Beslut fattas av Anna Berg. Medarbetaren kan se beslut och eventuell kommentar.</p>' : '<div class="pm-decision-record">' + icon(ctx, approved ? 'Check' : 'FileText', 16) + '<span>' + (approved ? 'Godkänd av Anna Berg' : request.status === 'rejected' ? 'Avslagen av Anna Berg' : 'Återkallad av medarbetaren') + '</span></div>') + '</section>' +
      '<section class="pm-panel pm-staffing-panel">' + paneHeading(ctx, 'Truck', approved ? 'Bemanning efter godkännandet' : 'Uppdrag under ledigheten', pill(ctx, approved ? (ctx.state.replacementAssigned ? 'approved' : 'pending') : 'draft', jobs.length + ' uppdrag')) +
      '<p class="pm-muted">' + (approved ? ctx.state.replacementAssigned ? 'Lina Andersson har tilldelats de berörda uppdragen.' : 'Godkänd frånvaro skapar bemanningsuppgifter för berörda uppdrag.' : 'Granska hur ledigheten påverkar planeringen. Bemanningsuppgifter skapas först när ansökan godkänns.') + '</p>' +
      '<div class="pm-jobs">' + (jobs.length ? jobs.map(function (job) { return '<div class="pm-job"><span class="pm-job-icon">' + icon(ctx, 'Truck', 18) + '</span><div><strong>' + esc(ctx, job.customer) + '</strong><small>' + esc(ctx, job.id) + ' · ' + date(job.date) + ' · ' + esc(ctx, job.time) + '</small></div>' + pill(ctx, approved ? (ctx.state.replacementAssigned ? 'approved' : 'pending') : 'draft', approved ? (ctx.state.replacementAssigned ? 'Lina Andersson' : 'Behöver ersättare') : 'Kalle Nilsson') + '</div>'; }).join('') : '<p class="pm-muted">Inga planerade uppdrag berörs av den här perioden.</p>') + '</div>' +
      (approved && jobs.length && !ctx.state.replacementAssigned ? '<div class="pm-staffing-footer"><p>' + jobs.length + ' bemanningsuppgifter skapade</p>' + button(ctx, 'Välj ersättare', 'replacement', '', 'Users') + '</div>' : '') + '<p class="pm-list-foot">Arbetsorder finns kvar. Ersättaren ändrar bemanningen för berörda uppdrag.</p></section></div>' +
      '<aside class="pm-detail-aside">' + (isHoliday ? '<section class="pm-panel pm-balance-panel">' + paneHeading(ctx, 'CalendarDays', 'Semestersaldo 2026') + '<div class="pm-balance"><strong>' + number(balance.balance) + '<span>dagar</span></strong><p>Kvar att ansöka om</p></div><dl class="pm-facts">' + fact(ctx, 'Årsdagar', number(balance.annual)) + fact(ctx, 'Uttagna', number(balance.taken)) + fact(ctx, 'Godkända, ej uttagna', number(balance.approved)) + fact(ctx, 'Väntande ansökningar', number(balance.pending)) + '</dl>' + (request.status === 'pending' ? '<div class="pm-balance-preview"><span>Efter godkännande</span><strong>' + number(balance.balance - days) + ' dagar kvar</strong><small>' + number(days) + ' dagar reserveras för denna ansökan</small></div>' : '') + '<p class="pm-list-foot">Väntande ansökningar reserverar inga dagar. Saldo = årsdagar − uttagna − godkända dagar.</p></section>' : '') +
      '<section class="pm-panel pm-check-panel">' + paneHeading(ctx, 'ShieldCheck', 'Inför ditt beslut') + '<div class="pm-check-item">' + icon(ctx, 'Check', 16) + '<p>Ansökan gäller ditt team.</p></div><div class="pm-check-item">' + icon(ctx, 'CalendarDays', 16) + '<p>Arbetsdagar räknas enligt Kalles schema.</p></div><div class="pm-check-item">' + icon(ctx, 'Truck', 16) + '<p>' + jobs.length + ' planerade uppdrag berörs.</p></div></section></aside></div>';
  }
  function clockMinutes(value) {
    if (typeof value === 'number') return value;
    var parts = String(value || '').split(':');
    return Number(parts[0] || 0) * 60 + Number(parts[1] || 0);
  }
  function reportRows(ctx) {
    return ctx.state.report.entries.map(function (entry) {
      var worked = Math.max(0, clockMinutes(entry.end) - clockMinutes(entry.start) - Number(entry.breakMinutes || 0));
      var isVab = entry.date === '2026-10-07';
      return '<tr><td data-label="Dag"><strong>' + date(entry.date, { weekday: 'long' }) + '</strong><small>' + date(entry.date) + '</small></td><td data-label="Arbetstid"><strong>' + esc(ctx, entry.start) + '–' + esc(ctx, entry.end) + '</strong><small>Rast ' + number(entry.breakMinutes) + ' min</small></td><td data-label="Arbetad tid"><strong>' + hourLabel(worked) + '</strong></td><td data-label="Frånvaro">' + (isVab ? pill(ctx, 'draft', 'VAB · 2 h') : '<span class="pm-muted">–</span>') + '</td><td data-label="Kommentar"><span>' + esc(ctx, entry.note || '–') + '</span></td></tr>';
    }).join('');
  }
  function reportView(ctx) {
    var report = ctx.state.report, summary = ctx.reportSummary(), submitted = report.status === 'submitted';
    return detailHeading(ctx, 'Tidrapport · vecka 41', '5–9 oktober 2026 · manuellt registrerad arbetstid', report.status) +
      (report.status === 'approved' ? alert(ctx, 'green', 'LockKeyhole', 'Tidrapporten är godkänd och låst', 'Anna Berg har granskat tiden. Övertidsersättning och förändring av flexsaldo behöver ett separat beslut.') : report.status === 'returned' ? alert(ctx, 'red', 'Undo2', 'Tidrapporten har återförts till Kalle', report.reason || 'Medarbetaren behöver korrigera och skicka in rapporten igen.') : report.status === 'draft' ? alert(ctx, 'grey', 'FileText', 'Rapporten är ännu inte inskickad', 'Kalle kan redigera sitt utkast. Granskning blir tillgänglig när rapporten skickas in.') : '') +
      '<div class="pm-report-metrics">' + metric(ctx, 'Clock', 'Arbetad tid', hourLabel(summary.worked), 'Summerad tid efter rast') + metric(ctx, 'CalendarDays', 'Planerad tid', hourLabel(summary.scheduled), 'Ordinarie schema · 5 vardagar') + metric(ctx, 'UserRound', 'Registrerad frånvaro', hourLabel(summary.absence), 'VAB · onsdag 7 oktober') + metric(ctx, 'TrendingUp', 'Avvikelse mot schema', (summary.variance >= 0 ? '+' : '−') + number(Math.abs(summary.variance)) + ' min', 'Arbete + frånvaro − planerad tid') + '</div>' +
      '<section class="pm-panel">' + employeeChip(ctx) + paneHeading(ctx, 'Clock', 'Registrerad arbetstid', '<span class="pm-pill grey">Manuell rapportering</span>') + '<div class="pm-table-wrap"><table class="pm-table pm-report-table"><thead><tr><th>Dag</th><th>Start / slut</th><th>Arbetad tid</th><th>Frånvaro</th><th>Medarbetarens kommentar</th></tr></thead><tbody>' + reportRows(ctx) + '</tbody><tfoot><tr><td colspan="2">Totalt vecka 41</td><td><strong>' + hourLabel(summary.worked) + '</strong></td><td><strong>' + hourLabel(summary.absence) + '</strong></td><td><strong>' + (summary.variance >= 0 ? '+' : '−') + number(Math.abs(summary.variance)) + ' min mot schema</strong></td></tr></tfoot></table></div><p class="pm-list-foot">VAB är en registrerad frånvaroanmälan och ingår i jämförelsen med schemat.</p></section>' +
      '<div class="pm-review-grid"><section class="pm-panel">' + paneHeading(ctx, 'TrendingUp', 'Avvikelse att ta ställning till', pill(ctx, 'pending', 'Ej bedömd')) + '<div class="pm-variance"><strong>' + (summary.variance >= 0 ? '+' : '−') + number(Math.abs(summary.variance)) + '<span>minuter</span></strong><p>' + (summary.variance === 0 ? 'Rapporterad tid och frånvaro motsvarar schemat.' : 'Rapporterad tid och frånvaro ' + (summary.variance > 0 ? 'överstiger' : 'understiger') + ' schemat med ' + number(Math.abs(summary.variance)) + ' minuter.') + '</p></div><p class="pm-muted">Granskningen bekräftar rapporterad tid. Ersättning och eventuell flexförändring hanteras separat enligt anställning och avtal.</p></section>' +
      '<section class="pm-panel">' + paneHeading(ctx, 'ClipboardCheck', 'Granska tidrapporten') + '<p class="pm-muted">Kontrollera tid, raster och kommentarer. Återför rapporten om Kalle behöver ändra eller förtydliga något.</p>' + (submitted ? '<div class="pm-decision-actions report">' + button(ctx, 'Återför med kommentar', 'return-report', 'outline', 'Undo2') + button(ctx, 'Godkänn tidrapport', 'approve-report', '', 'Check') + '</div>' : '<div class="pm-decision-record">' + icon(ctx, report.status === 'approved' ? 'LockKeyhole' : 'Clock', 18) + '<span>' + (report.status === 'approved' ? 'Godkänd av Anna Berg · granskad tid' : report.status === 'returned' ? 'Inväntar korrigering och ny inskickning' : 'Inväntar medarbetarens inskickning') + '</span></div>') + '<p class="pm-decision-note">Godkännande bokför ingen övertidsersättning och höjer inget flexsaldo automatiskt.</p></section></div>';
  }
  function modal(ctx) {
    if (!ui.modal) return '';
    var replacement = ui.modal === 'replacement', leave = ui.modal === 'reject-leave';
    var title = replacement ? 'Välj ersättare' : leave ? 'Avslå ledighetsansökan' : 'Återför tidrapport';
    var subtitle = replacement ? 'För berörda uppdrag under Kalles godkända ledighet.' : leave ? 'Kommentaren visas för Kalle tillsammans med beslutet.' : 'Beskriv vad Kalle behöver korrigera innan rapporten skickas in igen.';
    return '<div class="pm-overlay" data-manager-overlay><section class="pm-dialog" role="dialog" aria-modal="true" aria-labelledby="manager-dialog-title" aria-describedby="manager-dialog-description"><div class="pm-dialog-heading"><div><h2 id="manager-dialog-title">' + title + '</h2><p id="manager-dialog-description">' + subtitle + '</p></div><button type="button" class="pm-icon-btn" data-manager-action="close-modal" aria-label="Stäng dialog">' + icon(ctx, 'X', 20) + '</button></div><form data-manager-form="' + ui.modal + '">' +
      (replacement ? '<label class="pm-candidate"><input type="radio" name="replacement" value="lina" checked required><span class="pm-avatar">LA</span><span><strong>Lina Andersson</strong><small>Chaufför · Transport Norrtälje</small><span class="pm-pill green">Tillgänglig · C/CE, YKB</span></span></label><p class="pm-muted">Lina tilldelas de berörda uppdragen. Uppdrag och arbetsorder behåller sina referenser.</p>' : '<label class="pm-field" for="manager-reason">Kommentar <span>(obligatorisk)</span><textarea id="manager-reason" name="reason" maxlength="600" required placeholder="' + (leave ? 'Förklara varför ansökan avslås…' : 'Beskriv vad som behöver korrigeras…') + '" aria-describedby="manager-reason-help">' + esc(ctx, ui.reason) + '</textarea><small id="manager-reason-help">Lämna en tydlig kommentar som medarbetaren kan agera på.</small></label>') +
      (ui.error ? '<p class="pm-form-error" role="alert">' + esc(ctx, ui.error) + '</p>' : '') + '<div class="pm-dialog-actions">' + button(ctx, 'Avbryt', 'close-modal', 'outline') + '<button type="submit" class="pm-btn' + (leave ? ' danger-solid' : '') + '">' + icon(ctx, replacement ? 'Check' : leave ? 'X' : 'Undo2', 16) + (replacement ? 'Tilldela Lina' : leave ? 'Avslå ansökan' : 'Återför till Kalle') + '</button></div></form></section></div>';
  }

  window.renderPersonalManager = function (ctx) {
    var route = window.location.hash.replace(/^#/, '').split('?')[0] || 'chef';
    if (ui.route !== route) { ui.modal = ''; ui.reason = ''; ui.error = ''; ui.route = route; }
    return shell(ctx, route === 'chef-ledighet' ? leaveView(ctx) : route === 'chef-tid' ? reportView(ctx) : overview(ctx), route);
  };

  window.bindPersonalManager = function (ctx) {
    var root = document.querySelector('.personal-manager');
    if (!root) return;
    function refresh() { ctx.render(); }
    function close() { ui.modal = ''; ui.reason = ''; ui.error = ''; refresh(); }
    function show(name) { ui.modal = name; ui.reason = ''; ui.error = ''; refresh(); }
    function results() {
      var target = root.querySelector('#manager-results');
      if (target) { target.innerHTML = rowsMarkup(ctx); bindActions(target); }
      var count = root.querySelector('#manager-result-count');
      if (count) count.textContent = String(overviewRows(ctx).length);
    }
    function handle(event) {
      var el = event.currentTarget, action = el.getAttribute('data-manager-action');
      if (action === 'open-request') { ctx.state.selectedRequestId = el.getAttribute('data-request-id'); ctx.go('chef-ledighet'); }
      else if (action === 'filter-type') { ui.type = el.getAttribute('data-type'); refresh(); }
      else if (action === 'clear-filters') { ui.type = 'all'; ui.status = 'all'; ui.query = ''; refresh(); }
      else if (action === 'close-modal') close();
      else if (['reject-leave', 'return-report', 'replacement'].includes(action)) show(action);
      else if (action === 'approve-leave' || action === 'approve-report') {
        ui.modal = '';
        var result = action === 'approve-leave' ? ctx.approveLeave(el.getAttribute('data-request-id')) : ctx.approveReport();
        if (result && result.ok === false) ctx.toast(result.error || 'Åtgärden kunde inte genomföras.');
      }
    }
    function bindActions(target) {
      target.querySelectorAll('[data-manager-action]').forEach(function (el) { el.addEventListener('click', handle); });
    }
    bindActions(root);
    var search = root.querySelector('[data-manager-search]');
    if (search) search.addEventListener('input', function () { ui.query = search.value; results(); });
    var status = root.querySelector('[data-manager-status]');
    if (status) status.addEventListener('change', function () { ui.status = status.value; results(); });
    var form = root.querySelector('[data-manager-form]');
    if (form) {
      var reason = form.querySelector('[name="reason"]');
      if (reason) reason.addEventListener('input', function () { ui.reason = reason.value; });
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var action = form.getAttribute('data-manager-form'), text = reason ? reason.value.trim() : '';
        if (action !== 'replacement' && !text) { ui.error = 'Skriv en kommentar innan du fortsätter.'; refresh(); return; }
        var previousModal = ui.modal;
        ui.modal = ''; ui.error = '';
        var result = action === 'replacement' ? ctx.assignReplacement() : action === 'reject-leave' ? ctx.rejectLeave(ctx.selectedRequest().id, text) : ctx.returnReport(text);
        if (result && result.ok === false) { ui.modal = previousModal; ui.reason = text; ui.error = result.error || 'Åtgärden kunde inte genomföras.'; refresh(); }
      });
      var dialog = root.querySelector('.pm-dialog');
      var focusable = Array.from(dialog.querySelectorAll('button, textarea, input, select, a[href]')).filter(function (el) { return !el.disabled; });
      (reason || form.querySelector('input') || focusable[0]).focus();
      dialog.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab' && focusable.length) {
          var first = focusable[0], last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      });
    }
  };
})();
