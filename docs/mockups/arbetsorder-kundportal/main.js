/* Standalone UX prototype. No authentication, backend, persistence or delivery. */
(() => {
  'use strict';
  const app = document.getElementById('app');
  const overlay = document.getElementById('overlay');
  const toastNode = document.getElementById('toast');
  const icon = (name, size = 18) => window.icon(name, size);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const button = (action, text, iconName, className = 'btn', disabled = false) => `<button type="button" class="${className}" data-action="${action}"${disabled ? ' disabled' : ''}>${iconName ? icon(iconName,16) : ''}${text}</button>`;
  const pill = (text, color = 'blue') => `<span class="pill pill-${color}">${text}</span>`;
  const types = {
    pickup:{ label:'Hämtning', icon:'Truck', help:'Hämta kärl eller material' },
    exchange:{ label:'Byte', icon:'RefreshCw', help:'Hämta fullt, lämna tomt' },
    placement:{ label:'Utställning', icon:'Package', help:'Ställ ut kärl eller container' },
    outbound:{ label:'Utleverans', icon:'ArrowUpRight', help:'Leverera material från lager' },
  };
  const statuses = {
    pending:['Att planera','amber'], booked:['Bokad','green'], underway:['Pågår','blue'],
    carrier_pending:['Inväntar åkeri','purple'], completed:['Utförd','grey'],
  };
  const formDefaults = () => ({ type:'pickup', source:'office', customer:'Elektriska AB', site:'Norrtälje', address:'Verkstadsvägen 12, 761 41 Norrtälje',
    assetId:'K-0660', item:'Kabel (koppar)', amount:'', date:'2026-10-14', from:'09:00', to:'12:00', duration:'60',
    mode:'own', driver:'Ej tilldelad', vehicle:'Ej tilldelat', carrier:'Sjöbergs Transport AB', reference:'',
    comment:'Truck finns på plats. Ring kontaktpersonen när ni närmar er.', recipient:'Nordic Metall AB',
    recipientAddress:'Metallvägen 4, 745 39 Enköping', priority:'window',
  });
  const fixture = () => ({ customerCompany:'Elektriska AB', filter:'all', typeFilter:'all', operatorFilter:'all', siteFilter:'all', query:'', history:false, form:formDefaults(),
    requests:[{id:'REQ-1054',orderId:'AO-1054',assetId:'C-014',status:'pending',customer:'Roslagens Däck AB',wantedDate:'2026-10-13',type:'exchange'}],
    orders:[
      { id:'AO-1054', type:'exchange', customer:'Roslagens Däck AB', assetId:'C-014', item:'Däckcontainer · C-014', location:'Industrivägen 8, Norrtälje', site:'Norrtälje', wantedDate:'2026-10-13', source:'portal', mode:'own', driver:'Ej tilldelad', status:'pending' },
      { id:'AO-1053', type:'pickup', customer:'Bergs Verkstad AB', item:'Batterilåda · Blybatterier', location:'Verkstadsvägen 4, Rimbo', site:'Rimbo', wantedDate:'2026-10-14', source:'office', mode:'own', driver:'Ej tilldelad', status:'pending', hazardous:true },
      { id:'AO-1052', type:'pickup', customer:'Elektriska AB', assetId:'C-1042', item:'Skrotcontainer · 10 m³', location:'Verkstadsvägen 12, Norrtälje', site:'Norrtälje', wantedDate:'2026-10-19', bookedDate:'2026-10-19', from:'09:00',to:'12:00', source:'office', mode:'own', driver:'Oskar Lind', status:'booked' },
      { id:'AO-1048', type:'outbound', customer:'Nordic Metall AB', item:'Blybatterier · cirka 1 000 kg', location:'Norrtälje → Enköping', site:'Norrtälje', wantedDate:'2026-10-12', source:'warehouse', mode:'external', driver:'Sjöbergs Transport AB', status:'carrier_pending', hazardous:true },
      { id:'AO-1047', type:'exchange', customer:'Hasses Rör AB', item:'Kabelkärl · 660 liter · K-0621', location:'Byggvägen 8, Täby', site:'Norrtälje', wantedDate:'2026-10-12', bookedDate:'2026-10-12', from:'10:00',to:'11:00', source:'office', mode:'own', driver:'Kalle Karlsson', status:'booked' },
      { id:'AO-1046', type:'placement', customer:'Bygg & Riv AB', item:'Skrotcontainer · 10 m³', location:'Stationsvägen 6, Rimbo', site:'Rimbo', wantedDate:'2026-10-12', bookedDate:'2026-10-12', from:'08:00',to:'09:00', source:'office', mode:'own', driver:'Nicklas Juhlin Rosén', status:'underway' },
      { id:'AO-1040', type:'pickup', customer:'Hasses Rör AB', item:'Kabelkärl · 660 liter', location:'Byggvägen 8, Täby', site:'Norrtälje', wantedDate:'2026-10-09', bookedDate:'2026-10-09', source:'office', mode:'own', driver:'Kalle Karlsson', status:'completed' },
    ],
  });
  const state = fixture();
  let lastFocus;
  let toastTimer;
  const viewName = () => new URLSearchParams(location.hash.slice(1)).get('view') || 'orders';
  const dateLabel = value => new Date(`${value}T12:00:00`).toLocaleDateString('sv-SE',{ weekday:'short',day:'numeric',month:'short' });
  const navItems = [['LayoutDashboard','Översikt'],['Scale','Invägningar'],['ClipboardCheck','Kundgodkännande'],['BadgeCheck','Attest'],['Wallet','Utbetalningar'],['UsersRound','Kunder'],['ListChecks','Arbetsorder'],['Truck','Transportplanering'],['Package','Lager'],['Package','Kärl & containrar'],['FileText','Artiklar & priser'],['Leaf','Miljörapportering'],['Building2','Anläggningar'],['UserRound','Personal']];
  const guide = () => `<nav class="prototype-tabs" aria-label="Mockupvyer"><span>PROVA VYERNA</span><a href="#view=orders">${icon('ListChecks',14)}Arbetsorder</a><a href="#view=new">${icon('Plus',14)}Skapa ny</a><a href="#view=customer">${icon('Package',14)}Kundportal</a><a href="#view=login">${icon('LockKeyhole',14)}Kundinloggning</a></nav>`;
  function shell(content, options = {}) {
    const customer = Boolean(options.customer);
    const active = options.active || 'Arbetsorder';
    const nav = customer ? [['LayoutDashboard','Översikt'],['Package','Kärl & containrar'],['ListChecks','Mina beställningar'],['FileText','Avtal & dokument'],['Settings2','Företagsuppgifter']] : navItems;
    return `<aside class="sidebar"><img class="logo" src="assets/jeroc-logo.png" alt="JEROC Återvinning"><div class="eyebrow">${customer ? 'KUNDPORTAL' : 'KONTORSÖVERSIKT'}</div><nav>${nav.map(([name,label]) => `<button type="button" class="nav-item${label===active ? ' active':''}" data-action="${label==='Arbetsorder' ? 'nav-orders' : label==='Lager' ? 'warehouse-start' : 'demo-nav'}">${icon(name)}<span>${label}</span>${label==='Arbetsorder' && state.orders.some(order=>order.status==='pending' || order.changeRequestDate) ? `<span class="nav-count">${state.orders.filter(order=>order.status==='pending' || order.changeRequestDate).length}</span>`:''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="signed-in"><span class="avatar">${customer ? 'ME':'LA'}</span><div><strong>${customer ? 'Maria Eriksson':'Lars Andersson'}</strong><small>${customer ? 'Elektriska AB · Administratör':'VD · Norrtälje'}</small></div>${icon('ChevronDown',14)}</div><div class="demo-label">Designmockup · Demo</div><small>Alla uppgifter är fiktiva</small></div></aside><div class="workspace${customer ? ' customer-workspace':''}"><header class="topbar"><div class="breadcrumbs">${customer ? 'Kundportalen':'Kontoret'}${icon('ChevronRight',13)}<span>${options.title || active}</span></div>${!customer ? `<label class="search">${icon('Search',16)}<input aria-label="Global sökning i mockup" placeholder="Sök kund, arbetsorder eller referens…"></label>`:''}<div class="site-picker">${icon(customer ? 'MapPin':'Building2',17)}<div><small>${customer ? 'Kundplats':'Anläggning'}</small><strong>${customer ? 'Alla våra platser':'Alla anläggningar'}</strong></div>${icon('ChevronDown',14)}</div></header><div class="prototype-bar"><strong>KLICKBAR MOCKUP</strong><span>${customer ? 'Din kundportal · Exempel på avtal och beställningar':'Samma arbetsorder för kontor, planerare, kund och chaufför'}</span><button type="button" data-action="reset">Återställ exemplet</button></div><main id="content">${content}${guide()}<p class="mockup-footer">JEROC · Designförslag · Ingen verklig bokning eller leverans sker</p></main></div>`;
  }
  function toast(text) { clearTimeout(toastTimer); toastNode.textContent = text; toastNode.hidden=false; toastTimer=setTimeout(()=>{toastNode.hidden=true;},3500); }
  function closeModal() { overlay.hidden=true; overlay.innerHTML=''; lastFocus?.focus(); }
  function modal(title, subtitle, body, actions) {
    lastFocus=document.activeElement;
    overlay.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><div><h2 id="modal-title">${title}</h2><p>${subtitle}</p></div>${button('close-modal','', 'X','icon-btn')}</div>${body}<div class="modal-actions">${button('close-modal','Avbryt','','btn')}${actions}</div></section>`;
    overlay.hidden=false;
    overlay.querySelector('input,select,textarea,button')?.focus();
  }
  function navigate(name) { closeModal(); if(viewName()===name) render(); else location.hash=`view=${name}`; }
  function addCustomerRequest(data) {
    const active = state.requests.find(request=>request.assetId===data.assetId && !['completed','cancelled','declined'].includes(request.status));
    if(active) return active;
    let order=state.orders.find(order=>order.id===data.existingOrderId);
    if(order) {
      order.changeRequestDate=data.wantedDate;
      order.changeComment=data.comment;
      // The confirmed appointment stays intact until the office approves the change.
    } else {
      const id=`AO-${Math.max(...state.orders.map(order=>Number(order.id.slice(3))))+1}`;
      order={id,type:data.type==='exchange'?'exchange':'pickup',customer:data.customer||state.customerCompany,assetId:data.assetId,
        item:data.assetId==='K-0660'?'Kabelkärl · 660 liter · K-0660':'Skrotcontainer · 10 m³',location:data.location||'Verkstadsvägen 12, Norrtälje',
        site:'Norrtälje',wantedDate:data.wantedDate,source:'portal',mode:'own',driver:'Ej tilldelad',status:'pending',comment:data.comment};
      state.orders.unshift(order);
    }
    const request={...data,id:`REQ-${state.requests.length+1}`,orderId:order.id,status:'pending'};
    state.requests.push(request);
    return request;
  }
  const field = (name,label,value,help='',placeholder='') => `<label class="field">${label}<input data-field="${name}" value="${esc(value)}"${placeholder ? ` placeholder="${esc(placeholder)}"`:''}>${help ? `<small>${help}</small>`:''}</label>`;
  const select = (name,label,choices,value) => `<label class="field">${label}<select data-field="${name}">${choices.map(choice=>`<option${choice===value?' selected':''}>${esc(choice)}</option>`).join('')}</select></label>`;
  const notice = (text,color='blue',name='Info') => `<div class="notice notice-${color}">${icon(name,17)}<div>${text}</div></div>`;
  function overview() {
    const all=state.orders.filter(order=>Boolean(order.status==='completed')===state.history);
    const counts={pending:all.filter(order=>order.status==='pending'||order.changeRequestDate).length,booked:all.filter(order=>order.status==='booked').length,
      portal:all.filter(order=>order.source==='portal'||order.changeRequestDate).length,underway:all.filter(order=>order.status==='underway').length};
    const matches=all.filter(order=> (state.filter==='all'||(state.filter==='pending' ? order.status==='pending'||order.changeRequestDate:order.status===state.filter))
      &&(state.typeFilter==='all'||order.type===state.typeFilter)&&(state.operatorFilter==='all'||order.mode===state.operatorFilter)&&(state.siteFilter==='all'||order.site===state.siteFilter)
      && `${order.id} ${order.customer} ${order.item} ${order.location}`.toLocaleLowerCase('sv-SE').includes(state.query.toLocaleLowerCase('sv-SE')));
    const rows=matches.map(order=>`<tr class="${order.source==='portal'||order.changeRequestDate ? 'customer-request':''}" data-order-id="${order.id}"><td><a class="order-number" href="#" data-action="order-${order.id}">${order.id}</a><span class="order-type">${icon(types[order.type].icon,14)}${types[order.type].label}</span><small class="source-note">${order.source==='portal' ? `${icon('UserRound',11)}Kundportalen`:order.source==='warehouse'?'Från lager':'Kontoret'}</small></td><td><strong>${esc(order.customer)}</strong><small>${esc(order.item)}</small>${order.hazardous?'<small style="color:#b7823f">Farligt avfall</small>':''}</td><td><strong>${esc(order.location)}</strong><small>${esc(order.site)}</small></td><td><strong>${order.bookedDate ? dateLabel(order.bookedDate):order.wantedDate ? dateLabel(order.wantedDate):'Ingen dag angiven'}${order.bookedDate&&order.from ? ` · ${order.from}–${order.to}`:''}</strong><small>${order.bookedDate?'Bokad tid':order.wantedDate?'Önskad dag':'Planeras på kontoret'}</small>${order.changeRequestDate?`<small style="color:#b8823c">Önskar ändring till ${dateLabel(order.changeRequestDate)}</small>`:''}<small>${esc(order.driver)}${order.mode==='external'?' · Externt':''}</small></td><td>${order.changeRequestDate ? pill('Ändring önskad','amber'):pill(...statuses[order.status])}<small>${order.status==='pending'?'Välj tid och chaufför':order.status==='carrier_pending'?'Förfrågan skickad':order.status==='underway'?'På väg till kund':order.status==='booked'?'Chaufför och tid klara':'Avslutad arbetsorder'}</small></td><td>${button(`order-${order.id}`,'','ChevronRight','icon-btn')}</td></tr>`).join('');
    return shell(`<div class="page-heading"><div><div class="eyebrow">TRANSPORT & SERVICE</div><h1>Arbetsorder</h1><p>Hämtningar, byten, utställningar och utleveranser på ett ställe.</p></div><div class="heading-actions">${button('planner','Visa transportplanering','CalendarDays','btn')}${button('new-order','Ny arbetsorder','Plus','btn btn-primary')}</div></div><div class="stat-grid">${[['Clock','amber','Att planera',counts.pending,'Obokade jobb och ändringsönskemål'],['CalendarDays','green','Bokade',counts.booked,'Tid och chaufför är klara'],['UserRound','purple','Från kundportalen',counts.portal,'Beställningar och önskemål'],['Truck','','Pågående',counts.underway,'Uppdrag som påbörjats']].map(([name,color,label,count,foot])=>`<section class="panel stat-card"><span class="stat-icon ${color}">${icon(name,20)}</span><div><small>${label}</small><strong>${count}</strong><span class="stat-foot">${foot}</span></div></section>`).join('')}</div><div class="sticky-queue"><div class="tabs">${button('tab-active','Aktiva','',''+(!state.history?'selected':''))}${button('tab-history','Historik','',''+(state.history?'selected':''))}<div class="view-switch">${[['all','Alla aktiva'],['pending','Att planera'],['booked','Bokade'],['underway','Pågår']].map(([value,label])=>button(`filter-${value}`,label,'',state.filter===value?'selected':'')).join('')}</div></div><section class="panel filter-panel"><label class="list-search">${icon('Search',17)}<input data-field="query" value="${esc(state.query)}" placeholder="Sök ordernummer, kund, kärl eller adress…" aria-label="Sök arbetsorder"></label><select data-field="typeFilter" aria-label="Uppdragstyp"><option value="all">Alla uppdragstyper</option>${Object.entries(types).map(([key,type])=>`<option value="${key}"${state.typeFilter===key?' selected':''}>${type.label}</option>`).join('')}</select><select data-field="operatorFilter" aria-label="Transportör"><option value="all">Egna & externa</option><option value="own"${state.operatorFilter==='own'?' selected':''}>Egna chaufförer</option><option value="external"${state.operatorFilter==='external'?' selected':''}>Externa åkerier</option></select><select data-field="siteFilter" aria-label="Anläggning"><option value="all">Alla anläggningar</option>${['Norrtälje','Rimbo'].map(site=>`<option${state.siteFilter===site?' selected':''}>${site}</option>`).join('')}</select></section></div><section class="panel order-list"><div class="list-caption"><strong>${matches.length} arbetsorder</strong><span>Senaste förfrågningarna först</span></div>${matches.length?`<table class="order-table"><thead><tr><th>Order / typ</th><th>Kund / uppdrag</th><th>Plats</th><th>Tid / utförare</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`:'<div class="empty">Inga arbetsorder matchar dina val.</div>'}<div class="order-footer"><span>Visar ${matches.length} av ${all.length} ${state.history?'avslutade':'aktiva'} arbetsorder</span><span>${button('reset-filters','Rensa filter','','btn')}</span></div></section><section class="panel linked-guide"><div>${icon('Package',18)}<span><strong>Lager</strong> visar material och mängder. Boka utleverans skapar en arbetsorder.</span></div>${button('warehouse-start','Prova Boka utleverans','ArrowRight','text-btn')}</section>`,{title:'Arbetsorder'});
  }
  function itemSection() {
    const f=state.form;
    if(f.type==='outbound') return `<div class="form-grid">${select('item','Material',['Blybatterier','Kabel (koppar)','Järn'],f.item)}${field('amount','Uppskattad mängd (kg)',f.amount,'Verklig vikt fastställs vid lastning.')}</div><div class="form-sub">Lager och tillgänglig mängd visas för vald artikel och anläggning.</div>${f.item==='Blybatterier'?notice('Farligt avfall: transportdokument och relevanta underskrifter färdigställs före avfärd med last.','amber','TriangleAlert'):''}`;
    if(f.type==='placement') return `<div class="form-grid">${select('assetId','Kärltyp',['Container · 10 m³','Kabelkärl · 660 liter','Batterilåda'],f.assetId)}${field('reference','Avtal / hyresperiod','Hyra 1 vecka','Hämtning kan planeras samtidigt.')}</div><div class="address-preview">${icon('Package',21)}<div><strong>Tom skrotcontainer · 10 m³</strong><small>Exakt kärl väljs vid planering · avsändare JEROC Norrtälje</small></div></div>`;
    const asset=`<div class="item-strip"><span class="asset-icon">${icon('Package',24)}</span><div class="asset-text"><strong>Kabelkärl · 660 liter</strong><small>K-0660 · Fyra hjul · Elektriska AB</small></div></div>`;
    if(f.type==='exchange') return `<div class="swap-strip"><div>${asset}<p class="form-sub">Hämta fullt kärl · Kabel (koppar)</p></div>${icon('RefreshCw',21)}<div><div class="item-strip"><span class="asset-icon">${icon('Package',24)}</span><div class="asset-text"><strong>Lämna tomt kabelkärl</strong><small>660 liter · Kärlnummer väljs vid lastning</small></div></div><p class="form-sub">Rullande bytesavtal · AV-2026-041</p></div></div>`;
    return `<div class="form-grid">${select('assetId','Vad ska hämtas?',['K-0660 · Kabelkärl 660 liter','C-1042 · Skrotcontainer 10 m³','Löst material utan kärl'],'K-0660 · Kabelkärl 660 liter')}${select('item','Material',['Kabel (koppar)','Järn','Blybatterier'],f.item)}</div><div class="form-sub">Kärl, kundplats och avtal följer arbetsordern. Uppskattad mängd kan kompletteras.</div>`;
  }
  function newOrder() {
    const f=state.form;
    const outbound=f.type==='outbound';
    const routeTitle=outbound?'Lastningsplats & mottagare':'Kund & uppdragsplats';
    return shell(`<div class="page-heading order-heading"><div>${button('nav-orders','Arbetsorder','ArrowLeft','page-back')}<h1>Ny arbetsorder</h1><p>Välj uppdragstyp. Uppgifterna anpassas efter vad som ska göras.</p></div><div class="heading-actions">${pill(f.source==='warehouse'?'Förifyllt från lager':'Nytt uppdrag','grey')}</div></div>${f.source==='warehouse'?`<div class="source-banner notice notice-blue">${icon('Package',18)}<div>Startad från <strong style="display:inline">Lager · Norrtälje · Blybatterier</strong>. Lastningsplats och material är förifyllda.</div></div>`:''}<section class="panel type-panel"><div class="panel-head"><h2>Vad ska göras?</h2><small>En arbetsorder, olika uppdrag</small></div><div class="type-grid">${Object.entries(types).map(([key,type])=>`<button type="button" data-action="type-${key}" class="type-choice${f.type===key?' selected':''}">${icon(type.icon,21)}<div><strong>${type.label}</strong><small>${type.help}</small></div></button>`).join('')}</div></section><div class="new-grid"><div class="new-main"><section class="panel"><div class="panel-head"><h2><span class="panel-index">1</span>${routeTitle}</h2>${outbound?pill('Från JEROC','grey'):button('demo-nav','Ny kund','Plus','text-btn')}</div>${outbound?`<div class="form-grid">${select('site','Lastande anläggning',['Norrtälje','Rimbo'],f.site)}${select('recipient','Mottagare',['Nordic Metall AB','Hasses Rör AB'],f.recipient)}</div><div class="address-preview">${icon('ArrowRight',20)}<div><strong>JEROC Norrtälje → ${esc(f.recipient)}</strong><small>Ångsvägen 19, 761 41 Norrtälje → ${esc(f.recipientAddress)}</small></div>${button('edit-address','Ändra','Pencil','text-btn')}</div>`:`<div class="form-grid">${select('customer','Kund',['Elektriska AB','Hasses Rör AB','Bygg & Riv AB'],f.customer)}${select('address','Kundplats',['Verkstadsvägen 12, 761 41 Norrtälje','Annan uppdragsplats'],f.address)}</div><div class="address-preview">${icon('MapPin',20)}<div><strong>${esc(f.address)}</strong><small>Maria Eriksson · 070-000 12 34 · Kopplad till Norrtälje</small></div>${button('edit-address','Ändra','Pencil','text-btn')}</div>`}</section><section class="panel"><div class="panel-head"><h2><span class="panel-index">2</span>${outbound?'Material & mängd':f.type==='placement'?'Kärl & avtal':f.type==='exchange'?'Kärlbyte & avtal':'Kärl eller material'}</h2>${f.type==='exchange'?pill('Avtal finns','green'):''}</div>${itemSection()}</section><section class="panel"><div class="panel-head"><h2><span class="panel-index">3</span>Tid & transport</h2><small>Standardtid 1 timme</small></div><div class="mode-toggle">${button('mode-own','Egna chaufförer','UsersRound',f.mode==='own'?'selected':'')}${button('mode-external','Extern transportör','Truck',f.mode==='external'?'selected':'')}</div><div class="form-grid three">${field('date','Önskad dag',f.date,'Dag önskas; boka tid i planeraren.','ÅÅÅÅ-MM-DD')}${field('from','Tidigast',f.from,'Öppettider gäller.','09:00')}${field('to','Senast',f.to,'','12:00')}</div><div class="inline-title"><strong>${f.mode==='own'?'Planera internt':'Skicka förfrågan till åkeriet'}</strong>${pill(f.mode==='own'?'Kan tilldelas senare':'Tiden är ett önskemål','grey')}</div><div class="form-grid">${f.mode==='own'?`${select('driver','Chaufför',['Ej tilldelad','Kalle Karlsson','Oskar Lind'],f.driver)}${select('vehicle','Fordon',['Ej tilldelat','DEF 456 · JEROC lastbil med kran','JER 123 · JEROC lastbil med flak'],f.vehicle)}`:`${select('carrier','Transportör',['Sjöbergs Transport AB'],f.carrier)}${field('reference','Transportreferens (valfri)',f.reference)}`}</div>${f.mode==='external'?`<div class="form-sub">Åkeriet kan tacka ja eller nej utan exakt tid. Mejl förbereds i demo.</div>`:''}</section><section class="panel"><div class="panel-head"><h2><span class="panel-index">4</span>Kontakt & instruktioner</h2><small>Följer med till chauffören</small></div><div class="form-grid">${field('reference','Referens (valfri)',f.reference,'','Projekt, arbetsplats eller ordernummer')}${field('duration','Uppskattad tidsåtgång (min)',f.duration)}</div><label class="field full" style="margin-top:13px">Lastning och övrig information<textarea data-field="comment">${esc(f.comment)}</textarea></label></section><div class="footer-actions form-actions"><div><strong>${f.mode==='own'?'Skapa och planera när det passar':'Förfrågan till externt åkeri'}</strong><p>${f.mode==='own'?'Tid och chaufför kan kompletteras i transportplaneringen.':'Åkeriet får svara och därefter välja chaufför.'}</p></div><div class="footer-buttons">${button('nav-orders','Avbryt','','btn')}${button('save-order',f.mode==='own'?'Skapa arbetsorder':'Skicka förfrågan','Check','btn btn-primary')}</div></div></div><aside class="new-aside"><section class="panel"><div class="panel-head"><h2>Sammanställning</h2>${pill(types[f.type].label,'blue')}</div><div class="summary-section"><small>${outbound?'Mottagare':'Kund'}</small><strong>${esc(outbound?f.recipient:f.customer)}</strong><p>${esc(outbound?f.recipientAddress:f.address)}</p></div><div class="summary-section"><small>Uppdrag</small><strong>${f.type==='exchange'?'Hämta fullt, lämna tomt':f.type==='placement'?'Ställ ut tomt kärl':outbound?`Utleverans från ${esc(f.site)}`:'Hämta kärl / material'}</strong><p>${f.type==='outbound'?`${esc(f.item)} · cirka ${esc(f.amount||'–')} kg`:f.type==='placement'?'Tomt kärl · från JEROC':'Kabelkärl · 660 liter · K-0660'}</p></div><div class="summary-section"><small>Tidsönskemål</small><strong>${dateLabel(f.date)} · ${esc(f.from)}–${esc(f.to)}</strong><p>Uppskattad tidsåtgång ${esc(f.duration)} min</p></div><div class="summary-section"><small>Transport</small><strong>${f.mode==='own'?'JEROC · Egna chaufförer':esc(f.carrier)}</strong><p>${f.mode==='own'?esc(f.driver):'Förfrågan · åkeriet väljer chaufför'}</p></div>${notice(f.mode==='own'?'Arbetsordern får status Att planera. Önskad tid bekräftas när planeringen är klar.':'Skickad förfrågan inväntar åkeriets svar. Önskad tid blir inte automatiskt bekräftad.')} ${button('save-order',f.mode==='own'?'Skapa arbetsorder':'Skicka förfrågan','Plus','btn btn-primary')}</section><section class="panel"><div class="panel-head"><h2>${icon('ListChecks',18)}Kopplat till uppdraget</h2></div><div class="integration-tags">${['Kund & plats','Kärl / material','Avtal','Planering','Chaufför','Dokument'].map(label=>pill(label,'grey')).join('')}</div><p class="form-sub">Samma ordernummer används i alla vyer.</p></section></aside></div>`,{title:'Ny arbetsorder'});
  }
  function render() {
    const name=viewName();
    document.body.dataset.view=name;
    document.title=`JEROC · ${name==='orders'?'Arbetsorder':name==='new'?'Ny arbetsorder':name==='login'?'Kundinloggning':'Kundportal'}`;
    app.innerHTML=name==='orders'?overview():name==='new'?newOrder():window.CustomerMockup.view(name);
    if(document.getElementById('content')) document.getElementById('content').dataset.view=name;
  }
  function setType(type) { state.form.type=type; state.form.source='office'; state.form.assetId=type==='placement'?'Container · 10 m³':'K-0660'; if(type==='outbound') {state.form.item='Blybatterier';state.form.amount='1000';} else {state.form.item='Kabel (koppar)';state.form.amount='';} render(); }
  function openOrder(id) {
    const order=state.orders.find(order=>order.id===id);
    modal(`${types[order.type].label} · ${id}`,`${esc(order.customer)} · ${esc(order.site)}`,`<div class="order-modal-content">${[['Uppdrag',order.item],['Plats',order.location],['Status',statuses[order.status][0]],['Tid',`${dateLabel(order.bookedDate||order.wantedDate)}${order.bookedDate?' · Bokad':' · Önskemål'}`],['Utförare',order.driver]].map(([label,value])=>`<div class="modal-line"><span>${label}</span><strong>${esc(value)}</strong></div>`).join('')}${order.changeRequestDate?notice(`Kunden önskar hämtning ${dateLabel(order.changeRequestDate)}. Nuvarande bokning står kvar tills ändringen godkänts.`,'amber'):''}<div class="gap-top">${notice('Kärl, kundplats och dokument följer samma arbetsorder i kundportalen, planeringen och chaufförsvyn.')}</div></div>`,button('planner','Öppna i planeraren','CalendarDays','btn btn-primary'));
  }
  const actions={
    'reset':()=>{Object.assign(state,fixture());closeModal();render();toast('Mockupexemplet återställt.');},
    'close-modal':closeModal,
    'nav-orders':()=>navigate('orders'),
    'new-order':()=>{state.form=formDefaults();navigate('new');},
    'warehouse-start':()=>{state.form={...formDefaults(),type:'outbound',source:'warehouse',item:'Blybatterier',amount:'1000'};navigate('new');},
    'tab-active':()=>{state.history=false;state.filter='all';render();},
    'tab-history':()=>{state.history=true;state.filter='all';render();},
    'reset-filters':()=>{Object.assign(state,{query:'',typeFilter:'all',operatorFilter:'all',siteFilter:'all',filter:'all'});render();},
    'mode-own':()=>{state.form.mode='own';render();},
    'mode-external':()=>{state.form.mode='external';render();},
    'demo-nav':()=>toast('Den här mockupen visar arbetsorder och kundens kärlhantering.'),
    'planner':()=>{closeModal();toast('Nästa steg: samma arbetsorder öppnas i befintlig karta och planerare.');},
    'edit-address':()=>toast('Uppdragsplatsen kan ändras utan att kundens fakturaadress ändras.'),
    'save-order':()=>{
      const f=state.form;
      if(!/^\d{4}-\d{2}-\d{2}$/.test(f.date)||!Number.isFinite(new Date(f.date).getTime())||Number(f.duration)<=0) {toast('Kontrollera önskad dag och tidsåtgång.');return;}
      const id=`AO-${Math.max(...state.orders.map(order=>Number(order.id.slice(3))))+1}`;
      state.orders.unshift({id,type:f.type,customer:f.type==='outbound'?f.recipient:f.customer,site:f.site,
        assetId:['outbound','placement'].includes(f.type)?undefined:f.assetId,item:f.type==='outbound'?`${f.item} · cirka ${f.amount} kg`:f.type==='placement'?`Tomt kärl · ${f.assetId}`:'Kabelkärl · 660 liter · K-0660',
        location:f.type==='outbound'?`${f.site} → Enköping`:f.address,wantedDate:f.date,source:f.source==='warehouse'?'warehouse':'office',
        mode:f.mode,driver:f.mode==='external'?f.carrier:f.driver,status:f.mode==='external'?'carrier_pending':'pending',comment:f.comment});
      state.history=false;state.filter='all';navigate('orders');toast(`${id} skapad i mockupen · ingen verklig bokning.`);
    },
  };
  window.JEROCPrototype={state,icon,esc,button,pill,shell,modal,closeModal,toast,navigate,render,addCustomerRequest};
  document.addEventListener('click',event=>{
    const target=event.target.closest('[data-action]');
    if(!target||target.disabled)return;
    const action=target.dataset.action;
    event.preventDefault();
    if(action.startsWith('type-'))setType(action.slice(5));
    else if(action.startsWith('filter-')){state.filter=action.slice(7);render();}
    else if(action.startsWith('order-'))openOrder(action.slice(6));
    else if(actions[action])actions[action]();
    else window.CustomerMockup.action(action,target);
  });
  document.addEventListener('change',event=>{
    const fieldName=event.target.dataset.field;
    if(!fieldName)return;
    if(fieldName.startsWith('customer-')){window.CustomerMockup.change(event);return;}
    if(Object.prototype.hasOwnProperty.call(state,fieldName))state[fieldName]=event.target.value;
    else if(Object.prototype.hasOwnProperty.call(state.form,fieldName))state.form[fieldName]=event.target.value;
    render();
  });
  overlay.addEventListener('click',event=>{if(event.target===overlay)closeModal();});
  document.addEventListener('keydown',event=>{
    if(overlay.hidden)return;
    if(event.key==='Escape'){event.preventDefault();closeModal();}
    if(event.key==='Tab'){
      const focusable=[...overlay.querySelectorAll('button,input,select,textarea,a[href]')].filter(element=>!element.disabled);
      const first=focusable[0],last=focusable.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  });
  window.addEventListener('hashchange',render);
  render();
})();
