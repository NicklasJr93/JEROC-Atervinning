(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const seed = () => ({
    route: 'start', role: 'employee',
    person: { id: 'kalle', name: 'Kalle Nilsson', role: 'Chaufför', site: 'Norrtälje', manager: 'Anna Berg', team: 'Transport' },
    report: { status: 'draft', reason: '', entries: [
      { id: 'mon', date: '2026-10-05', start: '07:00', end: '16:00', breakMinutes: 60, note: '' },
      { id: 'tue', date: '2026-10-06', start: '07:00', end: '16:30', breakMinutes: 60, note: 'Lastningen drog ut på tiden hos Verkstad Nord.' },
      { id: 'wed', date: '2026-10-07', start: '09:00', end: '16:00', breakMinutes: 60, note: 'VAB 07:00–09:00 är registrerad separat.' },
      { id: 'thu', date: '2026-10-08', start: '07:00', end: '16:00', breakMinutes: 60, note: '' },
      { id: 'fri', date: '2026-10-09', start: '07:00', end: '16:00', breakMinutes: 60, note: '' },
    ] },
    editingEntryId: 'tue', justSubmittedLeaveId: '', selectedRequestId: 'LE-1045',
    leaveRequests: [
      { id: 'LE-1039', type: 'holiday', start: '2026-10-19', end: '2026-10-21', portion: 'full', note: '', status: 'approved', reason: '', createdAt: '2026-10-01', reviewedBy: 'Anna Berg' },
      { id: 'LE-1045', type: 'holiday', start: '2026-10-26', end: '2026-10-30', portion: 'full', note: 'Höstlov med familjen.', status: 'pending', reason: '', createdAt: '2026-10-12' },
    ],
    staffingCreated: false, replacementAssigned: false,
  });
  const today = '2026-10-12';
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && !Number.isNaN(new Date(`${value}T12:00:00Z`).valueOf()) && new Date(`${value}T12:00:00Z`).toISOString().slice(0,10) === value;
  const minutes = time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time ?? '') ? Number(time.slice(0,2))*60+Number(time.slice(3)) : NaN;
  const hours = value => `${Number(value/60).toLocaleString('sv-SE',{maximumFractionDigits:2})} h`;
  const dateLabel = value => validDate(value) ? new Date(`${value}T12:00:00Z`).toLocaleDateString('sv-SE',{day:'numeric',month:'short'}) : '—';
  function workDays(start,end) {
    if (!validDate(start) || !validDate(end) || end < start) return 0;
    const from = new Date(`${start}T12:00:00Z`), to = new Date(`${end}T12:00:00Z`);
    if ((to-from)/86400000 > 366) return 0;
    let days=0;
    for(let d=from;d<=to;d.setUTCDate(d.getUTCDate()+1)) if(d.getUTCDay()>0 && d.getUTCDay()<6) days++;
    return days;
  }
  const leaveDays = request => workDays(request.start,request.end)*(request.portion==='half'?.5:1);
  const mock = window.PersonalMock = { state: seed(), esc, minutes, hours, dateLabel, leaveDays,
    icon: (name,size=20) => window.icon(name,size),
    pill: (label,tone='blue') => `<span class="pill ${esc(tone)}">${esc(label)}</span>`,
    toast(message) { const node=document.querySelector('#toast');node.textContent=message;node.hidden=false;clearTimeout(mock.toastTimer);mock.toastTimer=setTimeout(()=>node.hidden=true,4200); },
    go(route) { if(location.hash.slice(1)===route) render();else location.hash=route;window.scrollTo({top:0,behavior:'instant'}); },
    render,
    reset() { mock.state=seed();mock.go('start');render(); },
    reportSummary() {
      const worked=mock.state.report.entries.reduce((total,item)=>total+Math.max(0,minutes(item.end)-minutes(item.start)-Number(item.breakMinutes)),0);
      const absence=120, scheduled=2400, variance=worked+absence-scheduled;
      return {worked,absence,scheduled,planned:scheduled,variance,deviation:variance};
    },
    leaveBalance() {
      const approvedRequests=mock.state.leaveRequests.filter(r=>r.status==='approved');
      const approved=approvedRequests.filter(r=>r.type==='holiday').reduce((sum,r)=>sum+leaveDays(r),0);
      const pending=mock.state.leaveRequests.filter(r=>r.type==='holiday' && r.status==='pending').reduce((sum,r)=>sum+leaveDays(r),0);
      const comp=480-approvedRequests.filter(r=>r.type==='comp').reduce((sum,r)=>sum+leaveDays(r)*480,0);
      return {annual:25,taken:12,approved,pending,balance:25-12-approved,comp,flex:195};
    },
    affectedJobs(request) { return [
      {id:'AO-1042',date:'2026-10-26',time:'08:00–09:00',customer:'Verkstad Nord'},
      {id:'AO-1043',date:'2026-10-28',time:'10:00–11:00',customer:'Hasses Rör AB'},
    ].filter(job=>job.date>=request.start && job.date<=request.end); },
    selectedRequest() { return mock.state.leaveRequests.find(r=>r.id===mock.state.selectedRequestId) ?? mock.state.leaveRequests.find(r=>r.status==='pending') ?? mock.state.leaveRequests.at(-1); },
    saveTimeEntry(input) {
      if(mock.state.role!=='employee') return fail('Välj medarbetarens vy för att rapportera tid.');
      if(['submitted','approved'].includes(mock.state.report.status)) return fail('Rapporten är låst. Chefen behöver återföra den för ändring.');
      const from=minutes(input.start),to=minutes(input.end),pause=Number(input.breakMinutes);
      if(!validDate(input.date) || input.date>today || input.date<'2026-10-05' || input.date>'2026-10-09') return fail('Välj en dag i rapportveckan 5–9 oktober. Framtida arbete kan inte rapporteras.');
      if(!Number.isFinite(from) || !Number.isFinite(to) || to<=from) return fail('Sluttiden behöver vara efter starttiden.');
      if(!Number.isInteger(pause) || pause<0 || pause>=to-from) return fail('Ange en rast som är kortare än arbetspasset.');
      if(to-from-pause>480 && !String(input.note??'').trim()) return fail('Beskriv tidsavvikelsen innan du sparar.');
      const row={id:input.id && input.id!=='new'?input.id:`entry-${Date.now()}`,date:input.date,start:input.start,end:input.end,breakMinutes:pause,note:String(input.note??'').trim()};
      if(mock.state.report.entries.some(r=>r.date===row.date && r.id!==row.id)) return fail('Den dagen har redan en registrering. Öppna den befintliga dagen för att ändra tiden.');
      const existing=mock.state.report.entries.find(r=>r.id===row.id || r.date===row.date);
      if(existing) Object.assign(existing,{...row,id:existing.id});else mock.state.report.entries.push(row);
      mock.state.report.entries.sort((a,b)=>a.date.localeCompare(b.date));mock.state.report.status='draft';render();return {ok:true};
    },
    submitReport() {
      if(mock.state.role!=='employee' || !['draft','returned'].includes(mock.state.report.status)) return fail('Rapporten är redan skickad eller granskad.');
      if(mock.state.report.entries.length!==5) return fail('Komplettera rapportveckans arbetsdagar.');
      mock.state.report.status='submitted';mock.state.report.reason='';render();return {ok:true};
    },
    approveReport() {
      if(!manager() || mock.state.report.status!=='submitted') return fail('Rapporten behöver vara skickad innan den kan godkännas.');
      mock.state.report.status='approved';mock.state.report.reviewedBy='Anna Berg';render();return {ok:true};
    },
    returnReport(reason) {
      if(!manager() || mock.state.report.status!=='submitted') return fail('Välj en skickad rapport.');
      if(!String(reason??'').trim()) return fail('Skriv vad medarbetaren behöver komplettera.');
      mock.state.report.status='returned';mock.state.report.reason=reason.trim();render();return {ok:true};
    },
    saveLeaveRequest(input) {
      if(mock.state.role!=='employee') return fail('Välj medarbetarens vy för att ansöka om ledighet.');
      if(!['holiday','leave','comp'].includes(input.type)) return fail('Välj typ av ledighet.');
      if(!validDate(input.start) || !validDate(input.end) || input.start<today || input.end<input.start) return fail('Kontrollera från- och tilldatum.');
      const candidate={...input,portion:input.portion==='half'?'half':'full'},days=leaveDays(candidate);
      if(!days) return fail('Perioden behöver innehålla en schemalagd arbetsdag.');
      if(mock.state.leaveRequests.some(r=>['pending','approved'].includes(r.status) && r.start<=candidate.end && r.end>=candidate.start)) return fail('Du har redan en ansökan eller godkänd ledighet under perioden.');
      const balance=mock.leaveBalance();
      if(candidate.type==='holiday' && days>balance.balance) return fail('Ansökan är större än ditt tillgängliga semestersaldo.');
      if(candidate.type==='comp' && days*480>balance.comp) return fail('Kompsaldot räcker inte för den valda ledigheten.');
      const request={id:`LE-${1046+mock.state.leaveRequests.length-1}`,type:candidate.type,start:candidate.start,end:candidate.end,portion:candidate.portion,note:String(input.note??'').trim(),status:'pending',reason:'',createdAt:today};
      mock.state.leaveRequests.push(request);mock.state.justSubmittedLeaveId=request.id;mock.state.selectedRequestId=request.id;render();return {ok:true,id:request.id};
    },
    withdrawLeave(id) {
      const r=mock.state.leaveRequests.find(r=>r.id===id);
      if(mock.state.role!=='employee' || r?.status!=='pending') return fail('Bara en väntande ansökan kan tas tillbaka här.');
      r.status='withdrawn';mock.state.justSubmittedLeaveId='';render();return {ok:true};
    },
    approveLeave(id) {
      const request=mock.state.leaveRequests.find(r=>r.id===id);
      if(!manager() || request?.status!=='pending') return fail('Ansökan är redan behandlad.');
      const balance=mock.leaveBalance(),days=leaveDays(request);
      if(request.type==='holiday' && days>balance.balance || request.type==='comp' && days*480>balance.comp) return fail('Saldot behöver kontrolleras innan ansökan kan godkännas.');
      request.status='approved';request.reviewedBy='Anna Berg';mock.state.selectedRequestId=id;
      if(mock.state.justSubmittedLeaveId===id) mock.state.justSubmittedLeaveId='';
      mock.state.staffingCreated=mock.affectedJobs(request).length>0;mock.state.replacementAssigned=false;render();return {ok:true};
    },
    rejectLeave(id,reason) {
      const request=mock.state.leaveRequests.find(r=>r.id===id);
      if(!manager() || request?.status!=='pending') return fail('Välj en väntande ansökan.');
      if(!String(reason??'').trim()) return fail('Skriv en förklaring till medarbetaren.');
      request.status='rejected';request.reason=reason.trim();
      if(mock.state.justSubmittedLeaveId===id) mock.state.justSubmittedLeaveId='';
      render();return {ok:true};
    },
    assignReplacement() {
      if(!manager() || !mock.state.staffingCreated || mock.state.selectedRequest()?.status!=='approved') return fail('Godkänn ledigheten innan bemanningen ändras.');
      mock.state.replacementAssigned=true;render();return {ok:true};
    },
  };
  function fail(error) { return {ok:false,error}; }
  function manager() { return mock.state.role==='manager'; }
  function render() {
    const valid=['profil','start','schema','tid','registrera','ledighet','ansok','saldo','chef','chef-ledighet','chef-tid'];
    const route=location.hash.slice(1)||'start';mock.state.route=valid.includes(route)?route:'start';
    mock.state.role=mock.state.route.startsWith('chef')?'manager':'employee';
    document.querySelector('#preview-role').value=mock.state.role;
    document.body.classList.toggle('manager-preview',manager());
    const screen=document.querySelector('#screen');
    screen.innerHTML=manager()?window.renderPersonalManager(mock):window.renderPersonalMobile(mock);
    if(manager()) window.bindPersonalManager(mock);else window.bindPersonalMobile(mock);
  }
  document.addEventListener('click',event=>{const button=event.target.closest('[data-go]');if(button){event.preventDefault();mock.go(button.dataset.go);} });
  document.querySelector('#preview-role').addEventListener('change',event=>mock.go(event.target.value==='manager'?'chef':'start'));
  document.querySelector('#reset-demo').addEventListener('click',()=>{mock.reset();mock.toast('Exempeluppgifterna är återställda.');});
  window.addEventListener('hashchange',()=>{render();window.scrollTo({top:0,behavior:'instant'});});
  render();
})();
