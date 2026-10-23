import { ACCOUNTS, money, toCents, assert } from './core.js';
import * as Sales from './sales.js';
import * as Operations from './operations.js';
import * as Finance from './finance.js';
import * as Periodization from './periodization.js';
import * as Inventory from './inventory.js';
import { createSuiteStorage } from './storage.js';
import { createPurchaseWorkspace } from './purchase-workspace.js';
import { featureModules, featureNavigation, featureData, featureDownload } from './feature-workspaces.js';
import { renderView, escapeHtml as e, icon, ghost, nav, numberInput } from './views.js';
import { createInvoiceEditorDraft, renderInvoiceEditor, readInvoiceEditor, renderInvoiceSummary,
 renderInvoiceDetail, renderInvoiceList, invoiceDocumentHTML, createInvoiceLineHTML,
 applyInvoiceCustomer, applyInvoicePriceMode, updateInvoiceLineKind } from './invoice-page.js';

let TODAY='2026-10-23';
const STORE_KEY='scrapplanner-bokforing-suite-v2';
const root=document.querySelector('#app');
const store=createSuiteStorage();
let snapshot=store.load(), state=snapshot.state, busy=false, stale=false, toastTimer;
let invoiceDraft=null, invoiceDraftRoute='', invoiceDirty=false, acceptedHash=location.hash||'#overview';
const ui={view:'overview',search:'',invoiceId:null,billId:null,entryId:null,projectId:null,bankId:null,payrollId:null,assetId:null,bankAccount:'1930',vatFrom:'2026-10-01',vatTo:'2026-12-31',assistantOpen:false};
const displayNav = nav.filter(([key]) => !['payroll', 'vat', 'close'].includes(key)).flatMap(item => [item, ...(item[0] === 'purchases' ? [featureNavigation[0]] : item[0] === 'projects' ? [featureNavigation[1]] : [])]).concat(featureNavigation.slice(2));
const validViews=new Set([...nav, ...featureNavigation].map(x=>x[0]));
let featureDirty=false;
const fmt=numberInput;
const purchaseWorkspace=createPurchaseWorkspace({getState:()=>state,readStoredState:()=>{const latest=store.load();if(latest.error)throw latest.error;return latest.state;},write,toast,canWrite:()=>canWrite(),navigate,openDialog,closeDialog:()=>dialog.close(),rerender:render});
const selected=(id,list)=>list.find(x=>x.id===id);
const option=(value,label,isSelected=false)=>`<option value="${e(value)}" ${isSelected?'selected':''}>${e(label)}</option>`;
const select=(label,name,options,value='',required=true)=>`<label>${e(label)}<select name="${e(name)}" ${required?'required':''}>${options.map(x=>option(x[0],x[1],x[0]===value)).join('')}</select></label>`;
const field=(label,name,value='',type='text',extra='')=>`<label>${e(label)}<input name="${e(name)}" type="${e(type)}" value="${e(value)}" ${extra}></label>`;
const check=(label,name,isChecked=false,extra='')=>`<label class="checkbox"><input name="${e(name)}" type="checkbox" ${isChecked?'checked':''} ${extra}><span>${e(label)}</span></label>`;
const help=text=>`<p class="form-help">${e(text)}</p>`;
const dateField=(name='date',label='Datum',value=TODAY)=>field(label,name,value,'date','required');
const moneyField=(label,name,value=0,extra='')=>field(label,name,fmt(value),'text',`inputmode="decimal" required ${extra}`);
const customerOptions=()=>[['','Välj kund'],...state.customers.map(c=>[c.id,c.name])];
const projectOptions=()=>[['','Utan projekt'],...state.projects.map(p=>[p.id,p.name])];
const bankEventField = direction => select('Befintlig kontohändelse','bankEventId',[['','Ny demobetalning'],...state.bankTransactions.filter(x=>!x.matchedEntryId&&(x.account||'1930')==='1930'&&(direction==='in'?x.amountCents>0:x.amountCents<0)).map(x=>[x.id,x.date+' · '+money(x.amountCents)+' · '+x.description])],'',false);
const errorMessage=err=>err?.message || 'Åtgärden kunde inte slutföras.';
const canWrite=()=>!busy&&!stale&&!snapshot.error&&snapshot.writable;
const canReset=()=>!busy&&!stale&&typeof navigator.locks?.request==='function'&&(snapshot.revision===null||typeof snapshot.revision==='string')&&(!snapshot.error||snapshot.error.code==='INVALID_DATA');

root.innerHTML=`<div class="suite-shell"><button id="suite-backdrop" class="sidebar-backdrop" aria-label="Stäng meny" hidden></button><aside id="suite-sidebar"><a href="#overview" class="brand"><span>${icon('ledger')}</span><strong>Bokföring<small>en del av ScrapPlanner</small></strong></a><p class="nav-caption">DIN ARBETSPLATS</p><nav>${displayNav.map(([view,label])=>`<a href="#${view}" data-nav="${view}">${icon(({inventory:'assets',accruals:'close'})[view]||view)}<span>${e(label)}</span></a>`).join('')}<a href="/bokforing/wiki/" target="_blank" rel="noopener noreferrer">${icon('ledger')}<span>Wiki &amp; granskning ↗</span></a></nav><div class="sidebar-bottom"><div class="sidebar-ande">${ghost()}<strong>En hjälpande ande.</strong><p>Fråga, förstå och kom vidare.</p><button data-action="toggle-assistant">${icon('sparkle')}Prata med Ande</button></div><button class="reset-link" data-action="reset">${icon('refresh')}Återställ demo</button><a href="/bokforing/klassisk.html" class="classic-link">Tidigare inköpsdemo ↗</a></div></aside><div class="suite-workspace"><header class="topbar"><button id="suite-menu" class="icon-button" aria-label="Öppna meny" aria-expanded="false">${icon('menu')}</button><span class="breadcrumb" id="breadcrumb">Översikt</span><span class="demo-badge">DEMO</span><label class="global-search">${icon('search')}<input id="suite-search" placeholder="Sök faktura eller verifikation…" aria-label="Sök faktura eller verifikation"></label><strong id="company-name"></strong><span class="year-label">2026</span><span class="avatar">ÅH</span><button class="ande-launcher" data-action="toggle-assistant" aria-label="Fråga Ande">${ghost()}<span>Fråga Ande</span></button></header><div id="suite-storage-notice" class="storage-notice" hidden><p></p><button class="button secondary" data-action="reload">Läs in senaste</button></div><main id="suite-main" tabindex="-1"></main><footer class="suite-footer"><span id="save-status">Fiktiva uppgifter · sparas i din webbläsare</span><span>Inga betalningar eller deklarationer skickas</span></footer></div></div><dialog id="suite-dialog" aria-labelledby="dialog-title"><div class="dialog-heading"><h2 id="dialog-title"></h2><button class="icon-button" data-action="close-dialog" aria-label="Stäng dialog">${icon('x')}</button></div><div id="dialog-body"></div></dialog><aside id="suite-assistant" class="assistant-panel" aria-label="Samtal med Ande" hidden><header>${ghost()}<div><strong>Ande</strong><small>Exempelbaserad demoassistent</small></div><button class="icon-button" data-action="toggle-assistant" aria-label="Stäng Ande">${icon('x')}</button></header><div id="assistant-messages" class="assistant-messages" aria-live="polite"></div><div class="assistant-suggestions"><button data-question="Vad behöver jag göra nu?">Mitt nästa steg</button><button data-question="Hur fungerar ROT?">Förklara ROT</button><button data-question="Varför balanserar bokföringen?">Debet och kredit</button></div><form id="assistant-form"><label class="sr-only" for="assistant-input">Fråga Ande</label><input id="assistant-input" placeholder="Ställ en fråga…" required maxlength="700"><button class="button primary" aria-label="Skicka fråga">${icon('arrow')}</button></form></aside><div id="suite-toast" class="toast" role="status"></div><div id="print-area"></div>`;
const dialog=document.querySelector('#suite-dialog');
const body=document.querySelector('#dialog-body');

function toast(message,isError=false){const el=document.querySelector('#suite-toast');el.textContent=message;el.className='toast visible'+(isError?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),6000);}
function updateChrome(){
 TODAY=['2026-10-23',state.company.fiscalYearStart].sort().at(-1);
 if(TODAY>state.company.fiscalYearEnd)TODAY=state.company.fiscalYearEnd;
 document.querySelector('#company-name').textContent=state.company.name;
 document.querySelector('#breadcrumb').textContent=[...nav,...featureNavigation].find(x=>x[0]===ui.view)?.[1]||'Översikt';
 document.querySelector('.year-label').textContent=state.company.fiscalYearStart.slice(0,4)+(state.company.fiscalYearEnd.slice(0,4)!==state.company.fiscalYearStart.slice(0,4)?'–'+state.company.fiscalYearEnd.slice(0,4):'');
 document.querySelectorAll('[data-nav]').forEach(el=>{el.classList.toggle('active',el.dataset.nav===ui.view);if(el.dataset.nav===ui.view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
 const issue=document.querySelector('#suite-storage-notice');
 issue.hidden=!snapshot.error&&!stale;
 issue.querySelector('p').textContent=stale?'En annan flik har ändrat demoboken. Dina ändringar har inte skrivits över. Läs in senaste uppgifter innan du fortsätter.':errorMessage(snapshot.error);
 document.querySelector('#save-status').textContent=busy?'Sparar…':stale||snapshot.error?'Sparandet är pausat':'Fiktiva uppgifter · sparas i din webbläsare';
 document.querySelector('#suite-main').setAttribute('aria-busy',String(busy));
 document.querySelector('#suite-assistant').hidden=!ui.assistantOpen;
 document.querySelectorAll('button[data-action]').forEach(el=>{const exempt=['toggle-assistant','close-dialog','reload','reset','print-invoice','export-ledger','export-reports','export-review','export-agi','show-entry','show-invoice','invoice-back','purchase-back','show-bill','open-document-inbox','select-document','select-inbox-document','download-document','document-zoom-in','document-zoom-out','document-rotate','document-reset','reload-documents','add-line','remove-line','add-entry-row','remove-entry-row'];if(!exempt.includes(el.dataset.action))el.disabled=!canWrite();});
 document.querySelectorAll('#suite-main button[type="submit"],#suite-dialog button[type="submit"]').forEach(el=>{el.disabled=el.dataset.blocked==='true'||(el.closest('form')?.dataset.form==='reset'?!canReset():!canWrite());});
 document.querySelector('[data-action="reset"]').disabled=!canReset();
}
function invoiceEditorOpen(){return ui.view==='sales'&&['new','edit'].includes(ui.invoiceMode);}
function invoiceLocation(id,edit=false){return '#sales/'+encodeURIComponent(id)+(edit?'/edit':'');}
function navigate(hash){if(location.hash===hash)route();else location.hash=hash;}
function render(){
 try{
  let html;
  if(featureModules[ui.view])html=featureModules[ui.view].renderWorkspace(state);
  else if(ui.view==='purchases')html=purchaseWorkspace.render(ui);
  else if(ui.view!=='sales')html=renderView(state,ui);
  else if(ui.invoiceMode==='list')html=renderInvoiceList(state,ui.search);
  else if(ui.invoiceMode==='detail'){
   const invoice=selected(ui.invoiceId,state.invoices);
   if(!invoice)throw new Error('Fakturan finns inte. Gå tillbaka till fakturalistan.');
   html=renderInvoiceDetail(state,invoice);
  }else{
   const key=ui.invoiceMode==='new'?'new':ui.invoiceId;
   if(invoiceDraftRoute!==key){
    const invoice=ui.invoiceMode==='edit'?selected(ui.invoiceId,state.invoices):null;
    if(ui.invoiceMode==='edit'&&(!invoice||invoice.status!=='draft'))throw new Error('Bara fakturautkast kan redigeras.');
    invoiceDraft=createInvoiceEditorDraft(state,invoice);invoiceDraftRoute=key;invoiceDirty=false;
   }
   html=renderInvoiceEditor(state,invoiceDraft,{isNew:ui.invoiceMode==='new',busy});
  }
  document.querySelector('#suite-main').innerHTML=html;
 }catch(err){document.querySelector('#suite-main').innerHTML=`<div class="panel error-panel"><h1>Vyn kunde inte öppnas</h1><p>${e(errorMessage(err))}</p><a class="button secondary" href="${ui.view==='purchases'?'#purchases':'#sales'}">Till fakturalistan</a></div>`;}
 const editStatus=document.querySelector('#invoice-editor-status');if(editStatus)editStatus.textContent=invoiceDirty?'Osparade ändringar':'Utkast';
 updateChrome();
 if(ui.view==='purchases')purchaseWorkspace.mount().catch(showError);
}
function route(){
 const target=location.hash||'#overview';
 const changed=target!==acceptedHash;
 if((invoiceDirty||featureDirty||purchaseWorkspace.isDirty())&&target!==acceptedHash){
  if(!window.confirm('Du har osparade ändringar på fakturan. Vill du lämna sidan och kasta ändringarna?')){
   history.replaceState(null,'',acceptedHash);return;
  }
  invoiceDirty=false;featureDirty=false;
 }
 if(target!==acceptedHash){invoiceDraft=null;invoiceDraftRoute='';purchaseWorkspace.discard();featureDirty=false;}
 acceptedHash=target;
 let parts;try{parts=target.slice(1).split('/').map(decodeURIComponent);}catch{parts=['sales'];}
 ui.view=validViews.has(parts[0])?parts[0]:'overview';
 ui.invoiceMode=!parts[1]?'list':parts[1]==='new'?'new':parts[2]==='edit'?'edit':'detail';
 if(ui.view==='sales')ui.invoiceId=['list','new'].includes(ui.invoiceMode)?null:parts[1];
 if(ui.view==='purchases'){
  ui.purchaseMode=!parts[1]?'list':['new','inbox','copy'].includes(parts[1])?parts[1]:parts[2]==='edit'?'edit':'detail';
  ui.billId=['detail','edit'].includes(ui.purchaseMode)?parts[1]:null;
  ui.purchaseSourceId=['new','copy'].includes(ui.purchaseMode)?parts[2]||null:null;
  ui.purchaseRouteKey=target;
 }
 document.querySelector('#suite-sidebar').classList.remove('open');document.querySelector('#suite-backdrop').hidden=true;
 document.querySelector('#suite-menu').setAttribute('aria-expanded','false');render();
 if(changed){window.scrollTo(0,0);document.querySelector('#suite-main').focus({preventScroll:true});}
 if(ui.view==='commercial'&&parts[1])document.getElementById('commercial-'+parts[1])?.scrollIntoView();
}
function refreshInvoiceSummary(markDirty=true){
 const form=document.querySelector('#invoice-page-form');if(!form)return;
 if(markDirty)invoiceDirty=true;
 const box=document.querySelector('#invoice-live-summary');
 try{invoiceDraft=readInvoiceEditor(form);if(box)box.innerHTML=renderInvoiceSummary(invoiceDraft);}
 catch(err){if(box)box.innerHTML=`<p class="form-help">${e(errorMessage(err))}</p>`;}
 const status=document.querySelector('#invoice-editor-status');if(status)status.textContent=invoiceDirty?'Osparade ändringar':'Utkast';
}
function invoiceDueDate(form){
 const date=form.elements.namedItem('date'),terms=form.elements.namedItem('paymentTermsDays');
 const due=form.elements.namedItem('dueDate');
 if(!date?.value||!terms||!due)return;
 const days=Number(terms.value),parsed=new Date(date.value+'T12:00:00Z');
 if(Number.isInteger(days)&&days>=0&&days<=365&&Number.isFinite(parsed.getTime())){
  parsed.setUTCDate(parsed.getUTCDate()+days);due.value=parsed.toISOString().slice(0,10);
 }
}
function openDialog(title,formName,content,submit='Spara',extra=''){
 document.querySelector('#dialog-title').textContent=title;
 body.innerHTML=`<form data-form="${e(formName)}" ${extra}><div id="dialog-error" class="form-error" role="alert" hidden></div>${content}<div class="dialog-actions"><button type="button" class="button secondary" data-action="close-dialog">Avbryt</button><button type="submit" class="button primary">${e(submit)}</button></div></form>`;
 dialog.showModal();updateChrome();setTimeout(()=>body.querySelector('input:not([type="hidden"]),select,textarea')?.focus(),20);
}
function showError(err){const box=document.querySelector('#dialog-error'),pageBox=document.querySelector('#invoice-page-error')||document.querySelector('#purchase-page-error');if(dialog.open&&box){box.textContent=errorMessage(err);box.hidden=false;}else if(pageBox&&(invoiceEditorOpen()||purchaseWorkspace.isEditor())){pageBox.textContent=errorMessage(err);pageBox.hidden=false;pageBox.scrollIntoView({block:'nearest'});}else toast(errorMessage(err),true);}
async function write(transition,message,{close=true,after}={}){
 if(!canWrite()){showError(new Error(stale?'Läs in senaste demodata innan du fortsätter.':snapshot.error?.message||'Sparandet är pausat.'));return false;}
 busy=true;updateChrome();
 try{const saved=await store.commit(snapshot,transition);snapshot=saved;state=saved.state;stale=false;if(close&&dialog.open)dialog.close();if(after)after(state);render();toast(message);return true;}
 catch(err){if(err.code){snapshot={...snapshot,error:err};if(err.code==='STALE_STATE')stale=true;}showError(err);return false;}
 finally{busy=false;updateChrome();}
}
function reload(){snapshot=store.load();state=snapshot.state;stale=false;invoiceDirty=false;featureDirty=false;invoiceDraft=null;invoiceDraftRoute='';purchaseWorkspace.discard(true);dialog.close();render();toast(snapshot.error?errorMessage(snapshot.error):'Senaste demodata är inlästa. Osparade ändringar har återställts.',!!snapshot.error);}
function download(text,filename,type='text/csv;charset=utf-8'){const blob=new Blob([type.startsWith('text/csv')?'\uFEFF':'',text],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function csv(rows){return rows.map(row=>row.map(v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(';')).join('\r\n');}
function exportLedger(){download(csv([['Verifikation','Datum','Beskrivning','Konto','Debet','Kredit','Källa','Rättar'],...state.entries.flatMap(x=>x.rows.map(r=>[x.number,x.date,x.description,r.account,fmt(r.debitCents),fmt(r.creditCents),x.sourceType,x.correctsEntryId||'']))]),'huvudbok-demo.csv');}
function exportReports(){const r=Finance.getReports(state);download(csv([['Räkenskapsår',r.start,r.end],['Konto','Benämning','Ingående balans','Periodens debet','Periodens kredit','Utgående balans'],...r.accounts.map(x=>[x.number,x.name,fmt(x.openingCents),fmt(x.periodDebitCents),fmt(x.periodCreditCents),fmt(x.balanceCents)])]),'saldobalans-demo.csv');}
function exportReview(){download(JSON.stringify({...state,kind:'Fiktivt granskningsunderlag – ej årsredovisning',exportedAt:new Date().toISOString(),reports:Finance.getReports(state),checks:Finance.getCloseChecklist(state)},null,2),'granskningspaket-demo.json','application/json;charset=utf-8');}

function lineRow(line={description:'',kind:'labor',quantity:1,unitCents:0,vatRate:25}){return `<div class="invoice-line" data-line><label>Typ<select data-line-field="kind">${[['labor','Arbete'],['material','Material'],['other','Övrigt']].map(x=>option(...x,line.kind===x[0])).join('')}</select></label><label class="line-description">Beskrivning<input data-line-field="description" value="${e(line.description)}" required maxlength="300"></label><label>Antal / timmar<input data-line-field="quantity" value="${e(line.quantity)}" inputmode="decimal" required></label><label>À-pris exkl. moms<input data-line-field="unitCents" value="${e(fmt(line.unitCents))}" inputmode="decimal" required></label><label>Moms<select data-line-field="vatRate">${[25,12,6,0].map(v=>option(String(v),v+' %',line.vatRate===v)).join('')}</select></label><button type="button" class="icon-button remove-row" data-action="remove-line" aria-label="Ta bort raden">${icon('x')}</button></div>`;}
function lineEditor(lines){return `<div class="form-section"><h3>Fakturarader</h3><div id="line-editor">${lines.map(lineRow).join('')}</div><button class="button secondary small" type="button" data-action="add-line">${icon('plus')}Lägg till rad</button></div>`;}
function readLines(form){const lines=[...form.querySelectorAll('[data-line]')].map(row=>{const val=name=>row.querySelector(`[data-line-field="${name}"]`).value;const q=val('quantity').trim().replace(',','.');assert(/^\d+(?:\.\d{1,2})?$/.test(q),'Antal ska vara positivt med högst två decimaler.');return {kind:val('kind'),description:val('description').trim(),quantity:Number(q),unitCents:toCents(val('unitCents')),vatRate:Number(val('vatRate'))};});assert(lines.length,'Lägg till minst en fakturarad.');return lines;}
function entryRow(row={account:'6570',side:'debit',amountCents:0}){return `<div class="journal-line" data-entry-row>${select('Konto','unused',ACCOUNTS.map(a=>[a.number,a.number+' · '+a.name]),row.account)}${select('Sida','unused',[['debit','Debet'],['credit','Kredit']],row.side)}${moneyField('Belopp','unused',row.amountCents)}<button type="button" class="icon-button" data-action="remove-entry-row" aria-label="Ta bort konteringsrad">${icon('x')}</button></div>`;}
function confirmAction(action,id,title,text,{date=false,reason=false,dateValue=TODAY,checkbox='Jag har granskat uppgifterna',submit='Bekräfta'}={}){openDialog(title,'confirm-action',`<input type="hidden" name="action" value="${e(action)}"><input type="hidden" name="id" value="${e(id)}"><p>${e(text)}</p>${date?dateField('date','Datum',dateValue):''}${reason?field('Orsak','reason','','text','required maxlength="500"'):''}${check(checkbox,'reviewed',false,'required')}`,submit);}

async function action(name,id,el){
 if(purchaseWorkspace.handlesAction(name)){await purchaseWorkspace.action(name,id,el);return;}
 switch(name){
 case 'close-dialog':dialog.close();return;
 case 'reload':reload();return;
 case 'toggle-assistant':ui.assistantOpen=!ui.assistantOpen;updateChrome();return;
 case 'add-line':document.querySelector('#line-editor')?.insertAdjacentHTML('beforeend',lineRow());return;
 case 'remove-line':el.closest('[data-line]')?.remove();return;
 case 'add-entry-row':document.querySelector('#entry-rows')?.insertAdjacentHTML('beforeend',entryRow());return;
 case 'remove-entry-row':el.closest('[data-entry-row]')?.remove();return;
 case 'show-entry':ui.entryId=id;location.hash='ledger';if(ui.view==='ledger')render();return;
 case 'show-invoice':navigate(invoiceLocation(id));return;
 case 'invoice-back':navigate('#sales');return;
 case 'new-invoice':navigate('#sales/new');return;
 case 'edit-invoice':navigate(invoiceLocation(id,true));return;
 case 'copy-invoice':{
  const invoice=selected(id,state.invoices),days=invoice?.details?.paymentTermsDays??30,date=new Date(TODAY+'T12:00:00Z');
  date.setUTCDate(date.getUTCDate()+days);
  await write(s=>Sales.copyInvoice(s,id,{date:TODAY,dueDate:date.toISOString().slice(0,10)}),'Ett nytt fakturautkast har skapats.',{after:s=>{invoiceDirty=false;navigate(invoiceLocation(s.invoices.at(-1).id,true));}});return;
 }
 case 'add-invoice-line':{
  const container=document.querySelector('#invoice-page-lines');if(!container)return;
  const includesVat=document.querySelector('#invoice-page-form [name="pricesIncludeVat"]')?.checked||false;
  const rotEnabled=document.querySelector('#invoice-page-form [name="rotEnabled"]')?.checked||false;
  container.insertAdjacentHTML('beforeend',createInvoiceLineHTML({description:'',kind:'labor',quantity:1,unitCents:0,vatRate:25,unit:'tim',articleNumber:'',discountBps:0,unitPriceIncludesVat:includesVat,rotEligible:true},container.querySelectorAll('[data-invoice-line]').length,{includesVat,rotEnabled}));
  refreshInvoiceSummary();return;
 }
 case 'remove-invoice-line':el.closest('[data-invoice-line]')?.remove();refreshInvoiceSummary();return;
 case 'new-customer':openDialog('Ny kund','customer',`${field('Namn','name','','text','required maxlength="200"')}${field('E-post','email','','email','maxlength="250"')}${field('Adress','address','','text','maxlength="300"')}`);return;
 case 'new-project':openDialog('Nytt projekt','project',`${field('Projektnamn','name','','text','required maxlength="200"')}${select('Kund','customerId',customerOptions())}${moneyField('Budget exkl. moms','budgetCents',0)}`);return;
 case 'project-item':openDialog('Registrera tid eller material','project-item',`<input type="hidden" name="projectId" value="${e(id)}">${select('Typ','kind',[['labor','Arbete'],['material','Material'],['other','Övrigt']])}${field('Beskrivning','description','','text','required maxlength="300"')}<div class="form-grid">${field('Antal (timmar / stycken)','quantity',1,'text','required inputmode="decimal"')}${moneyField('À-pris exkl. moms','unitCents',55000)}</div>`);return;
 case 'new-quote':{const p=selected(id,state.projects);openDialog('Skapa offert','quote',`<input type="hidden" name="projectId" value="${e(id)}">${select('Kund','customerId',customerOptions(),p?.customerId||'')}<div class="form-grid">${dateField()}${dateField('validUntil','Giltig till','2026-11-22')}</div>${lineEditor(p?.items.length?p.items.map(x=>({...x,vatRate:25})):[{description:'Snickeriarbete',kind:'labor',quantity:1,unitCents:55000,vatRate:25}])}`,'Spara offert');return;}
 case 'accept-quote':await write(s=>Sales.acceptQuote(s,id),'Offerten är godkänd i demon.');return;
 case 'invoice-quote':openDialog('Skapa faktura från offert','invoice-quote',`<input type="hidden" name="id" value="${e(id)}"><div class="form-grid">${dateField('date','Fakturadatum')}${dateField('dueDate','Förfallodag','2026-11-22')}</div>${help('Offertens rader följer med till ett redigerbart fakturautkast.')}`,'Skapa fakturautkast');return;
 case 'issue-invoice':{const x=selected(id,state.invoices);confirmAction(name,id,'Granska och utfärda faktura',`Fakturan till ${state.customers.find(c=>c.id===x.customerId)?.name} är på ${money(Sales.getInvoiceTotals(x).grossCents)}. Fakturan bokförs och låses för direkt ändring. Inget mejl eller betalningskrav skickas.`,{submit:'Utfärda och bokför'});return;}
 case 'print-invoice':{document.querySelector('#print-area').innerHTML=invoiceDocumentHTML(state,selected(id,state.invoices));window.print();return;}
 case 'invoice-payment':{const x=selected(id,state.invoices),claim=state.rotClaims.find(c=>c.invoiceId===id);const t=Sales.getInvoiceTotals(x),paid=(x.payments||[]).filter(p=>p.payer==='customer').reduce((a,p)=>a+p.amountCents,0);openDialog('Registrera fakturabetalning','invoice-payment',`<input type="hidden" name="id" value="${e(id)}">${bankEventField('in')}${dateField()}${select('Betalare','payer',[['customer','Kunden'],...(claim?.status==='approved'?[['tax','Skatteverket (demobetalning)']]:[])])}${moneyField('Betalt belopp','amountCents',Math.max(0,t.customerCents-paid))}${field('Betalningsreferens','reference','','text','maxlength="200"')}${help('Det här registrerar en redan genomförd, fiktiv betalning. Ingen banköverföring görs.')}`,'Bokför betalning');return;}
 case 'credit-invoice':confirmAction(name,id,'Kreditera hela fakturan','En obetald faktura får en egen kreditfaktura med länk till originalet. Originalposterna bevaras.',{date:true,reason:true,submit:'Skapa kreditfaktura'});return;
 case 'remind-invoice':await write(s=>Sales.recordReminder(s,id),'Påminnelse noterad i historiken. Inget meddelande skickat.');return;
 case 'request-rot':openDialog('Förbered ROT-begäran','request-rot',`<input type="hidden" name="id" value="${e(id)}">${dateField('date','Datum för demobegäran')}${check('Arbetet är utfört','workCompletedConfirmed',false,'required')}${check('Kundens betalning är elektronisk och spårbar','electronicPaymentConfirmed',false,'required')}${help('Hela kundens del måste vara betald först. Begäran sparas som demounderlag och skickas inte till Skatteverket.')}`,'Förbered begäran');return;
 case 'decide-rot':{const claim=state.rotClaims.find(c=>c.invoiceId===id);openDialog('Registrera demobeslut om ROT','decide-rot',`<input type="hidden" name="id" value="${e(id)}">${dateField('date','Beslutsdatum')}${moneyField('Beviljat belopp i exemplet','approvedCents',claim?.requestedCents||0)}${field('Motivering','reason','','text','maxlength="500"')}${help('Ange 0 för avslag. En ej beviljad del blir återstående skuld för kunden. Det är inget beslut från Skatteverket.')}`,'Spara demobeslut');return;}
 case 'bill-payment':{const x=selected(id,state.bills);openDialog('Registrera leverantörsbetalning','bill-payment',`<input type="hidden" name="id" value="${e(id)}">${bankEventField('out')}${dateField()}${moneyField('Betalt belopp','amountCents',Operations.getBillOutstanding(x))}${help('Betalningen bokförs mellan leverantörsskuld och företagskonto. Ingen riktig betalning skickas.')}`,'Bokför betalning');return;}
 case 'credit-bill':confirmAction(name,id,'Kreditera inköpet','Den obetalda leverantörsfakturan får en länkad motbokning. Originalet bevaras.',{date:true,reason:true,submit:'Bokför kredit'});return;
 case 'new-bank':openDialog('Ny fiktiv kontohändelse','bank',`${dateField()}${field('Beskrivning','description','','text','required maxlength="300"')}<div class="form-grid">${select('Konto','account',[['1930','Företagskonto'],['1910','Kassa'],['1630','Skattekonto']],ui.bankAccount)}${select('Riktning','direction',[['in','Pengar in'],['out','Pengar ut']])}${moneyField('Belopp','amountCents',0)}</div>`);return;
 case 'book-bank':openDialog('Bokför kontohändelse','book-bank',`<input type="hidden" name="id" value="${e(id)}">${select('Händelsetyp','kind',[['fee','Bankavgift'],['transfer-tax','Överföring till / från skattekonto'],['cash-transfer','Överföring till / från kassa'],['loan','Lån'],['interest','Ränta']])}${help('Fakturabetalningar ska bokföras på fakturan. Belopp och datum hämtas från den valda kontohändelsen.')}`,'Bokför & matcha');return;
 case 'manual-entry':openDialog('Ny manuell verifikation','manual-entry',`${dateField()}${field('Beskrivning','description','','text','required maxlength="300"')}<div id="entry-rows">${entryRow({account:'6570',side:'debit',amountCents:0})}${entryRow({account:'1930',side:'credit',amountCents:0})}</div><button class="button secondary small" type="button" data-action="add-entry-row">Lägg till konteringsrad</button>${help('Debet och kredit måste balansera. Kundfordringar, leverantörsskulder, moms och lön hanteras genom sina egna flöden.')}`,'Granska & bokför');return;
 case 'correct-entry':confirmAction(name,id,'Skapa länkad rättelse','En ny verifikation spegelvänder den manuella bokningen. Originalet finns kvar.',{date:true,reason:true,submit:'Bokför rättelse'});return;
 case 'new-employee':openDialog('Ny anställd','employee',`${field('Namn','name','','text','required maxlength="200"')}${select('Lönetyp','payType',[['monthly','Månadslön'],['hourly','Timlön']])}${moneyField('Månadslön / timlön','baseCents',3200000)}${moneyField('Skatteavdrag per lönekörning (demovärde)','withholdingCents',750000)}${field('Arbetsgivaravgift % (demovärde)','employerRate',31.42,'text','required inputmode="decimal"')}${help('Uppgifterna är exempel, inte en automatisk skattetabellsberäkning.')}`);return;
 case 'new-payroll':openDialog('Ny lönekörning','payroll',`<div class="form-grid">${field('Löneperiod','month','2026-10','month','required')}${dateField('date','Lönebokföringsdatum')}</div><fieldset><legend>Anställda och timmar</legend>${state.employees.map(x=>`<div class="employee-choice">${check(x.name,'employeeIds',true,`value="${e(x.id)}"`)}${x.payType==='hourly'?field('Timmar','hours-'+x.id,160,'text','inputmode="decimal"'):''}</div>`).join('')}</fieldset><div class="form-grid">${moneyField('Sjukavdrag per vald anställd','sickDeductionCents',0)}${moneyField('Semesterlön per vald anställd','vacationPayCents',0)}${moneyField('Förmån per vald anställd','benefitCents',0)}${moneyField('Utlägg per vald anställd','reimbursementCents',0)}</div>${help('Avdrag, semester, förmån och utlägg läggs på varje vald anställd. Granska de beräknade lönebeskeden innan bokföring.')}`,'Beräkna löneutkast');return;
 case 'post-payroll':confirmAction(name,id,'Granska och bokför lönen','Bruttolön, skatteavdrag, arbetsgivaravgifter och nettolön bokförs. Kontrollera att demovärdena stämmer.',{submit:'Bokför lön'});return;
 case 'pay-payroll':confirmAction(name,id,'Registrera löneutbetalning','Den bokförda nettolönen betalas från det fiktiva företagskontot.',{date:true,dateValue:[TODAY,selected(id,state.payrollRuns)?.date||TODAY].sort().at(-1),submit:'Bokför löneutbetalning'});return;
 case 'settle-payroll-taxes':confirmAction(name,id,'Reglera löneskatt och arbetsgivaravgifter','Demon bokför skatteavdrag och arbetsgivaravgifter via skattekontot. Ingen riktig betalning skickas.',{date:true,dateValue:[TODAY,selected(id,state.payrollRuns)?.date||TODAY].sort().at(-1),submit:'Bokför skattereglering'});return;
 case 'export-agi':download(Finance.payrollAgiCsv(state,id),'agi-demounderlag.csv');return;
 case 'new-asset':openDialog('Ny inventarie','asset',`${field('Namn','name','','text','required maxlength="200"')}${dateField('date','Datum för omklassificering')}<div class="form-grid">${moneyField('Anskaffningsvärde exkl. moms','costCents',3000000)}${field('Nyttjandeperiod (månader)','lifeMonths',60,'number','required min="1" max="600"')}${moneyField('Bedömt restvärde','residualCents',0)}</div>${help('Beloppet måste redan vara bokfört som utrustningskostnad på 5410. Det flyttas till tillgångskonto 1220 så kostnaden inte räknas två gånger.')}`,'Lägg upp & omklassificera');return;
 case 'depreciate-asset':{const item=selected(id,state.assets),[y,m]=item.date.slice(0,7).split('-').map(Number);const next=new Date(Date.UTC(y,m-1+(item.depreciations||[]).length,1)).toISOString().slice(0,10);confirmAction(name,id,'Bokför månadsavskrivning','Avskrivningen beräknas från anskaffningsvärde, restvärde och nyttjandeperiod. Månaderna följer varandra utan dubbelbokning.',{date:true,dateValue:next<item.date?item.date:next,submit:'Bokför avskrivning'});return;}
 case 'dispose-asset':openDialog('Sälj eller utrangera inventarie','dispose-asset',`<input type="hidden" name="id" value="${e(id)}">${dateField()}${moneyField('Försäljningspris exkl. moms (0 vid utrangering)','proceedsCents',0)}${check('Jag har granskat avyttringen och beloppen','reviewed',false,'required')}${help('Försäljning i demon bokförs med 25 % moms. Kvarvarande bokfört värde och resultat av avyttringen bokförs samtidigt.')}`,'Bokför avyttring');return;
 case 'new-stock':openDialog('Ny lagerartikel','stock-item',`${field('Artikelbenämning','name','','text','required maxlength="200"')}<div class="form-grid">${field('Enhet','unit','st','text','required maxlength="30"')}${moneyField('Kostnad per enhet exkl. moms','unitCostCents',0)}</div>${help('Registrera inleverans eller inventerat antal efter att artikeln sparats. Pris och antal utgör inventeringsunderlag, inte en automatisk inköpsbokning.')}`);return;
 case 'stock-movement':{const item=selected(id,state.inventoryItems);openDialog('Lagerrörelse · '+item.name,'stock-movement',`<input type="hidden" name="id" value="${e(id)}">${dateField()}${select('Händelse','kind',[['in','Inleverans'],['out','Uttag'],['count','Inventerat totalantal']])}${field('Antal','quantity',1,'text','required inputmode="decimal"')}${field('Orsak / referens','reason','','text','required maxlength="300"')}${help('Inleverans ökar antalet, uttag minskar antalet och inventering ersätter antalet med det räknade totalantalet. Varje ändring bevaras i historiken.')}`,'Registrera lagerrörelse');return;}
 case 'value-stock':openDialog('Bokför lagervärdering','stock-value',`${dateField()}${check('Jag har granskat antal, kostnader och bokförda materialinköp','reviewed',false,'required')}${help('Förändringen av lagervärdet bokförs mellan 1460 och 4960. En ökning kräver att motsvarande materialinköp finns bokförda. Äldre värderingar bevaras.')}`,'Bokför lagervärde');return;
 case 'new-accrual':openDialog('Ny förutbetald kostnad','accrual',`${field('Beskrivning','name','','text','required maxlength="200"')}${dateField('date','Datum för omklassificering')}<div class="form-grid">${moneyField('Belopp att fördela','amountCents',0)}${select('Bokfört kostnadskonto','expenseAccount',[['5010','5010 · Hyra'],['6540','6540 · IT-tjänster'],['6991','6991 · Övriga externa kostnader']])}${field('Första kostnadsmånad','startMonth','2026-11','month','required')}${field('Antal månader','months',2,'number','required min="1" max="120"')}</div>${help('Bokför fakturan eller kostnaden först. Beloppet flyttas från kostnadskontot till 1790 och kan sedan fördelas till kostnad under varje månad.')}`,'Skapa periodiseringsplan');return;
 case 'accrual-month':{const item=selected(id,state.accruals),[year,month]=item.startMonth.split('-').map(Number),next=new Date(Date.UTC(year,month-1+(item.postings||[]).length,1)).toISOString().slice(0,10);openDialog('Bokför periodens kostnad','accrual-month',`<input type="hidden" name="id" value="${e(id)}">${dateField('date','Kostnadens bokföringsdatum',next)}${check('Jag har granskat vilken månad kostnaden avser','reviewed',false,'required')}${help('Nästa planerade månad bokförs. Samma månad kan inte bokföras två gånger.')}`,'Bokför månad');return;}
 case 'file-vat':openDialog('Granska och bokför momsperiod','file-vat',`<div class="form-grid">${dateField('from','Period från',ui.vatFrom)}${dateField('to','Period till',ui.vatTo)}${dateField('date','Bokföringsdatum',ui.vatTo)}</div>${check('Jag har granskat momsunderlaget och affärernas momshantering','reviewed',false,'required')}${help('Moms flyttas till redovisningskonto 2650. Underlaget lämnas inte till Skatteverket.')}`,'Bokför moms');return;
 case 'settle-vat':confirmAction(name,id,'Reglera periodens moms','Demon bokför överföringen via skattekontot. Ingen betalning skickas.',{date:true,submit:'Bokför momsreglering'});return;
 case 'lock-period':confirmAction(name,id,'Stäm av och lås '+id,'Alla kontohändelser och utkast i perioden måste vara hanterade. Nya bokningar i den låsta månaden stoppas.',{checkbox:'Jag har granskat periodens avstämningar',submit:'Lås perioden'});return;
 case 'unlock-period':confirmAction(name,id,'Öppna perioden '+id,'Öppningen kräver en orsak och sparas i behandlingshistoriken.',{reason:true,submit:'Öppna perioden'});return;
 case 'close-year':openDialog('Bokför årets resultat','close-year',`${dateField('date','Bokslutsdatum',state.company.fiscalYearEnd)}${check('Jag har granskat samtliga avstämningar och bokslutsunderlaget','confirmed',false,'required')}${help('Alla kontroller måste vara klara. Resultatet bokförs och ingående balanser för nästa år förbereds som arbetsmaterial.')}`,'Bokför årsresultat');return;
 case 'edit-company':openDialog('Företagsuppgifter','company',`${field('Företagsnamn','name',state.company.name,'text','required maxlength="200"')}${field('Organisationsnummer (demo)','orgNumber',state.company.orgNumber,'text','required maxlength="50"')}${select('Momsperiod','vatPeriod',[['quarter','Kvartal'],['month','Månad']],state.company.vatPeriod)}${help('Demon använder SEK, kalenderår 2026 och faktureringsmetoden. År och metod ändras inte på befintlig bokföring.')}`);return;
 case 'export-ledger':exportLedger();return;
 case 'export-reports':exportReports();return;
 case 'export-review':exportReview();return;
 case 'reset':openDialog('Återställ den här demon','reset',`<p>Alla egna ändringar i den nya ekonomidemon ersätts med fiktiva startuppgifter. Uppladdade filer behålls i den lokala underlagsinkorgen. Den tidigare inköpsdemons data påverkas inte.</p>${check('Jag vill återställa de fiktiva demouppgifterna','confirmed',false,'required')}`,'Återställ demo');return;
 default:throw new Error('Åtgärden finns inte i denna vy.');
 }
}

async function submit(form){
 if(purchaseWorkspace.handlesForm(form.dataset.form)){await purchaseWorkspace.submit(form);return;}
 const d=new FormData(form), get=name=>String(d.get(name)??''), amount=name=>toCents(get(name)), checked=name=>d.get(name)!==null,id=get('id');
 let transition,message='Uppgifterna är sparade i demon.',after;
 switch(form.dataset.form){
 case 'invoice-page':{
  const payload=readInvoiceEditor(form),invoiceId=payload.id||'';
  transition=s=>invoiceId?Sales.updateInvoiceDraft(s,invoiceId,payload):Sales.createInvoice(s,payload);
  message='Fakturautkastet är sparat.';
  after=s=>{invoiceDirty=false;invoiceDraft=null;invoiceDraftRoute='';navigate(invoiceLocation(invoiceId||s.invoices.at(-1).id));};break;
 }
 case 'customer':transition=s=>Sales.createCustomer(s,{name:get('name'),email:get('email'),address:get('address')});message='Kunden är sparad.';break;
 case 'project':transition=s=>Sales.createProject(s,{name:get('name'),customerId:get('customerId'),budgetCents:amount('budgetCents')});after=s=>{ui.projectId=s.projects.at(-1).id;};break;
 case 'project-item':{const quantity=Number(get('quantity').replace(',','.'));transition=s=>Sales.recordProjectItem(s,{projectId:get('projectId'),description:get('description'),kind:get('kind'),quantity,unitCents:amount('unitCents')});break;}
 case 'quote':{const payload={customerId:get('customerId'),projectId:get('projectId')||undefined,date:get('date'),validUntil:get('validUntil'),lines:readLines(form)};transition=s=>Sales.createQuote(s,payload);message='Offerten är sparad.';break;}
 case 'invoice-quote':transition=s=>Sales.invoiceFromQuote(s,id,{date:get('date'),dueDate:get('dueDate')});after=s=>{navigate(invoiceLocation(s.invoices.at(-1).id,true));};message='Ett fakturautkast har skapats från offerten.';break;
 case 'invoice-payment':transition=s=>Sales.receivePayment(s,id,{date:get('date'),amountCents:amount('amountCents'),payer:get('payer'),reference:get('reference'),bankEventId:get('bankEventId')||undefined});message='Fakturabetalningen är bokförd.';break;
 case 'request-rot':transition=s=>Sales.requestRot(s,id,{date:get('date'),workCompletedConfirmed:checked('workCompletedConfirmed'),electronicPaymentConfirmed:checked('electronicPaymentConfirmed')});message='ROT-begäran är förberedd som demounderlag.';break;
 case 'decide-rot':transition=s=>Sales.decideRot(s,id,{date:get('date'),approvedCents:amount('approvedCents'),reason:get('reason')});message='Demobeslutet är registrerat.';break;
 case 'bill-payment':transition=s=>Operations.payBill(s,id,{date:get('date'),amountCents:amount('amountCents'),bankEventId:get('bankEventId')||undefined});message='Leverantörsbetalningen är bokförd.';break;
 case 'bank':transition=s=>Operations.createBankEvent(s,{date:get('date'),description:get('description'),amountCents:amount('amountCents')*(get('direction')==='out'?-1:1),account:get('account')});after=s=>{ui.bankAccount=get('account');ui.bankId=s.bankTransactions.at(-1).id;};break;
 case 'bank-match':transition=s=>Operations.matchBankEvent(s,id,get('entryId'));message='Kontohändelsen är matchad.';break;
 case 'book-bank':transition=s=>Operations.bookBankEvent(s,id,{kind:get('kind')});message='Kontohändelsen är bokförd och matchad.';break;
 case 'manual-entry':{const rows=[...form.querySelectorAll('[data-entry-row]')].map(row=>{const inputs=row.querySelectorAll('select,input');const amount=toCents(inputs[2].value);return {account:inputs[0].value,debitCents:inputs[1].value==='debit'?amount:0,creditCents:inputs[1].value==='credit'?amount:0};});transition=s=>Operations.postManualEntry(s,{date:get('date'),description:get('description'),rows});after=s=>{ui.entryId=s.entries.at(-1).id;};message='Verifikationen är bokförd.';break;}
 case 'employee':transition=s=>Finance.createEmployee(s,{name:get('name'),payType:get('payType'),baseCents:amount('baseCents'),withholdingCents:amount('withholdingCents'),employerRateBps:toCents(get('employerRate'))});message='Den anställde är sparad.';break;
 case 'payroll':{const employeeIds=d.getAll('employeeIds').map(String),hours=Object.fromEntries(employeeIds.map(id=>[id,get('hours-'+id).trim()===''?160:Number(get('hours-'+id).replace(',','.'))]));transition=s=>Finance.createPayrollRun(s,{month:get('month'),date:get('date'),employeeIds,hours,sickDeductionCents:amount('sickDeductionCents'),vacationPayCents:amount('vacationPayCents'),benefitCents:amount('benefitCents'),reimbursementCents:amount('reimbursementCents')});after=s=>{ui.payrollId=s.payrollRuns.at(-1).id;};message='Löneutkastet är beräknat. Granska lönebeskeden.';break;}
 case 'asset':transition=s=>Finance.createAsset(s,{name:get('name'),date:get('date'),costCents:amount('costCents'),lifeMonths:Number(get('lifeMonths')),residualCents:amount('residualCents')});after=s=>{ui.assetId=s.assets.at(-1).id;};message='Inventarien är upplagd och kostnaden omklassificerad.';break;
 case 'dispose-asset':transition=s=>Finance.disposeAsset(s,id,{date:get('date'),proceedsCents:amount('proceedsCents')});message='Avyttringen är bokförd.';break;
 case 'stock-item':transition=s=>Inventory.createStockItem(s,{name:get('name'),unit:get('unit'),unitCostCents:amount('unitCostCents')});message='Lagerartikeln är upplagd.';break;
 case 'stock-movement':{const q=get('quantity').trim().replace(',','.');assert(/^\d+(?:\.\d{1,2})?$/.test(q),'Ange ett positivt antal med högst två decimaler.');transition=s=>Inventory.recordStockMovement(s,id,{date:get('date'),kind:get('kind'),quantity:Number(q),reason:get('reason')});message='Lagerrörelsen är registrerad.';break;}
 case 'stock-value':transition=s=>Inventory.postStockValuation(s,{date:get('date')});message='Lagervärdet är granskat och bokfört.';break;
 case 'accrual':transition=s=>Periodization.createAccrual(s,{name:get('name'),date:get('date'),amountCents:amount('amountCents'),expenseAccount:get('expenseAccount'),months:Number(get('months')),startMonth:get('startMonth'),type:'prepaid'});message='Periodiseringsplanen är bokförd.';break;
 case 'accrual-month':transition=s=>Periodization.postAccrualMonth(s,id,{date:get('date')});message='Månadens kostnad är bokförd.';break;
 case 'vat-filter':ui.vatFrom=get('from');ui.vatTo=get('to');assert(ui.vatFrom<=ui.vatTo,'Periodens slut måste ligga efter starten.');render();return;
 case 'file-vat':transition=s=>Finance.fileVatPeriod(s,{from:get('from'),to:get('to'),date:get('date')});message='Momsperioden är bokförd, inte inskickad.';break;
 case 'close-year':transition=s=>Finance.closeYear(s,{date:get('date'),confirmed:checked('confirmed')});message='Årets resultat är bokfört och årsunderlaget förberett.';break;
 case 'company':transition=s=>Finance.updateCompany(s,{name:get('name'),orgNumber:get('orgNumber'),vatPeriod:get('vatPeriod')});after=s=>{const p=Finance.getVatPeriodBounds(s,TODAY);ui.vatFrom=p.from;ui.vatTo=p.to;};break;
 case 'confirm-action':{
  const name=get('action'),payload={date:get('date'),reason:get('reason')};
  const actions={
   'issue-invoice':s=>Sales.issueInvoice(s,id),'credit-invoice':s=>Sales.creditInvoice(s,id,payload),
   'credit-bill':s=>Operations.creditBill(s,id,payload),
   'correct-entry':s=>Operations.correctEntry(s,id,payload),'post-payroll':s=>Finance.postPayroll(s,id),'pay-payroll':s=>Finance.payPayroll(s,id,payload),
   'settle-payroll-taxes':s=>Finance.settlePayrollTaxes(s,id,payload),
   'depreciate-asset':s=>Finance.depreciateAsset(s,id,payload),'settle-vat':s=>Finance.settleVat(s,id,payload),
   'lock-period':s=>Finance.lockPeriod(s,id),'unlock-period':s=>Finance.unlockPeriod(s,id,get('reason'))
  };transition=actions[name];assert(transition,'Okänd åtgärd.');message='Åtgärden är bokförd och sparad i demon.';break;
 }
 case 'reset':{
  if(busy||stale)return;busy=true;updateChrome();
  try{snapshot=await store.reset(snapshot);state=snapshot.state;stale=false;invoiceDirty=false;featureDirty=false;invoiceDraft=null;invoiceDraftRoute='';purchaseWorkspace.discard(true);Object.assign(ui,{invoiceId:null,billId:null,entryId:null,projectId:null,bankId:null,payrollId:null,assetId:null});dialog.close();if(ui.view==='sales')navigate('#sales');else if(ui.view==='purchases')navigate('#purchases');else render();toast('Demon är återställd till fiktiva startuppgifter. Uppladdade underlag finns kvar i inkorgen.');}catch(err){if(err.code)snapshot={...snapshot,error:err};showError(err);}finally{busy=false;updateChrome();}return;
 }
 default:throw new Error('Formuläret kan inte sparas.');
 }
 await write(transition,message,{after});
}

function answer(question){
 const lower=question.toLowerCase(),r=Finance.getReports(state);
 if(/lager|inventer/.test(lower))return 'Materiallagret är ett separat register i demon. Registrera artikelns kostnad och antalet vid inleverans, uttag eller inventering. När du bokför lagervärderingen omförs skillnaden mellan lager och kostnad. Materialinköpet måste vara bokfört först. I Artiklar & avtal kan du registrera ett lageruttag och motsvarande projektmaterial i samma åtgärd; övrig projektregistrering skapar inte automatiskt lageruttag.';
 if(/periodiser|förutbetald/.test(lower))return 'En förutbetald kostnad hör till kommande månader. Bokför inköpet först, lägg upp en periodiseringsplan och flytta beloppet till 1790. Sedan bokför du planens månadsbelopp tillbaka till kostnadskontot, i turordning. Planen och varje bokning behåller länkar i historiken.';
 if(/rot|avdrag/.test(lower))return 'I 2026 års exempel är ROT 30 % av arbetskostnaden inklusive moms, inom personens uppgivna återstående årsutrymme och högst 50 000 kr per år. Material och resor räknas bort. Öppna fakturan, granska villkoren och registrera kundens del innan du förbereder begäran. En behörighetsbedömning och Skatteverkets besked behövs fortfarande.';
 if(/debet|kredit|balans/.test(lower))return `Varje bokförd verifikation ska ha lika mycket i debet och kredit. Bokfört saldo på företagskontot är ${money(r.bankCents)}. Tillgångarna är ${money(r.assetsCents)} och eget kapital plus skulder ${money(r.liabilitiesEquityCents)}. Systemet stoppar en obalanserad verifikation, men valet av redovisningsregel behöver också vara rätt.`;
 if(/moms/.test(lower))return 'Momsöversikten räknas från huvudbokens momskonton. Kontrollera affärernas momstyp och avdragsrätt före momsavslut. Omvänd byggmoms kräver en egen bedömning av köparens och arbetets förutsättningar. Demon förbereder och bokför underlaget, men lämnar ingen deklaration.';
 if(/lön|lone|skatt/.test(lower))return 'Löneutkastet använder grundlön, de skatteavdrag och arbetsgivaravgifter du angivit samt valda avdrag, semester, förmåner och utlägg. Den nya individuella arbetsytan använder versionerade officiella tabeller för stödda 2026-fall. Granska profil, inkomsttyp och varje lönebesked före bokföring. Äldre demokörningar använder fortfarande manuella skattevärden; fler lönefall återstår.';
 if(/bokslut|stäng|lås|period/.test(lower))return 'Börja med kontohändelser, kund- och leverantörsposter. Kontrollera moms, löner och inventarier. I Bokslut ser du vilka kontroller som återstår. Periodlås stoppar nya bokningar i månaden; en öppning kräver skäl i historiken. Granskningspaketet är arbetsmaterial för din rådgivare.';
 if(/kostnad|inventarie|avskriv/.test(lower))return 'Ett inköp kan behöva kostnadsföras direkt eller redovisas som tillgång. I denna demo registrerar du först ett utrustningsinköp på 5410 och flyttar sedan beloppet till 1220 när du lägger upp inventarien. Nyttjandeperiod och restvärde styr månadsavskrivningen och ska granskas.';
 if(/faktura|kund|betal/.test(lower))return 'Spara ett fakturautkast med kund, datum, rader och momstyp. Granska och utfärda fakturan för att bokföra kundfordran. Registrera sedan kundens betalning och följ kvarvarande skuld. I Krediter & återbetalningar kan en faktura krediteras helt eller delvis, även efter betalning. Tillgodon kan återbetalas eller kvittas. ROT och intäktsperiodiserade fakturor kräver särskilda rättelseflöden. Originalet bevaras.';
 return `Just nu finns ${state.invoices.filter(x=>x.status==='draft').length} fakturautkast, ${state.bills.filter(x=>x.status==='draft').length} inköpsutkast och ${state.bankTransactions.filter(x=>!x.matchedEntryId).length} omatchade kontohändelser. Du tittar på ${nav.find(x=>x[0]===ui.view)?.[1]}. Jag kan förklara exempelvis ROT, kontering, moms, lön och bokslut. Svaren är exempelbaserade; jag utför ingen självständig redovisningsgranskning.`;
}
function chat(question){const list=document.querySelector('#assistant-messages');const add=(text,cls)=>{const bubble=document.createElement('div');bubble.className='chat-bubble '+cls;bubble.textContent=text;list.append(bubble);};if(question)add(question,'user');add(question?answer(question):'Hej Åke! Jag är Ande. Fråga om vyn du arbetar i, eller be mig förklara nästa steg. Mina svar i demon är exempelbaserade och ändrar inte din bokföring.','assistant');list.scrollTop=list.scrollHeight;}

async function runFeature(element) {
 const key=element.dataset.featureForm||element.dataset.featureAction;
 const module=featureModules[key];assert(module,'Arbetsytan kunde inte hittas.');
 const data=featureData(element),name=element.dataset.action;
 const file=featureDownload(state,key,name,data);
 if(file){download(typeof file.value==='string'?file.value:JSON.stringify(file.value,null,2),file.name,file.type||'application/json;charset=utf-8');return;}
 await write(current=>module.handleAction(current,name,data),'Uppgifterna är kontrollerade och sparade i demon.',{after:()=>{featureDirty=false;}});
}

document.addEventListener('click',event=>{
 const el=event.target.closest('button,a');
 if(el?.dataset.featureAction){event.preventDefault();runFeature(el).catch(showError);return;}
 if(!el){const row=event.target.closest('[data-invoice-row]'),billRow=event.target.closest('[data-purchase-row]');if(row)navigate(invoiceLocation(row.dataset.invoiceRow));else if(billRow)navigate('#purchases/'+encodeURIComponent(billRow.dataset.purchaseRow));return;}
 if(el.dataset.invoiceSection){event.preventDefault();const section=document.getElementById(el.dataset.invoiceSection);if(section){if(section.tagName==='DETAILS')section.open=true;section.scrollIntoView({behavior:'smooth',block:'start'});}return;}
 if(el.classList.contains('skip-link')){event.preventDefault();document.querySelector('#suite-main').focus();return;}
 const selectMap={selectInvoice:'invoiceId',selectBill:'billId',selectEntry:'entryId',selectProject:'projectId',selectBank:'bankId',selectPayroll:'payrollId',selectAsset:'assetId'};
 for(const [key,target] of Object.entries(selectMap)){if(el.dataset[key]){if(key==='selectInvoice'){event.preventDefault();navigate(invoiceLocation(el.dataset[key]));return;}if(key==='selectBill'){event.preventDefault();navigate('#purchases/'+encodeURIComponent(el.dataset[key]));return;}if(el.tagName!=='A')event.preventDefault();ui[target]=el.dataset[key];render();return;}}
 if(el.dataset.bankAccount){ui.bankAccount=el.dataset.bankAccount;ui.bankId=null;render();return;}
 if(el.dataset.question){chat(el.dataset.question);return;}
 if(el.dataset.action){event.preventDefault();Promise.resolve(action(el.dataset.action,el.dataset.id||'',el)).catch(showError);}
});
document.addEventListener('submit',event=>{const form=event.target;if(form.dataset.featureForm){event.preventDefault();runFeature(form).catch(showError);return;}if(form.id==='assistant-form'){event.preventDefault();const input=document.querySelector('#assistant-input');chat(input.value);input.value='';return;}if(form.dataset.form){event.preventDefault();submit(form).catch(showError);}});
document.addEventListener('input',event=>{if(event.target.closest('[data-feature-form]'))featureDirty=true;if(event.target.closest('#invoice-page-form'))refreshInvoiceSummary();purchaseWorkspace.input(event.target);});
document.addEventListener('dragover',event=>{const zone=event.target.closest('[data-document-drop][data-upload-enabled="true"]');if(zone){event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';}});
document.addEventListener('drop',event=>{const zone=event.target.closest('[data-document-drop][data-upload-enabled="true"]');if(!zone)return;event.preventDefault();const input=zone.querySelector('[data-document-upload][data-source="file"]');if(input&&event.dataTransfer?.files.length){input.files=event.dataTransfer.files;purchaseWorkspace.change(input).catch(showError);}});
document.addEventListener('change',event=>{
 try{
 const target=event.target,form=target.closest('#invoice-page-form');
 if(purchaseWorkspace.handlesChange(target)){purchaseWorkspace.change(target).catch(showError);return;}
 if(form){
  if(target.name==='customerId')applyInvoiceCustomer(form,state,target.value);
  if(target.name==='paymentTermsDays'||target.name==='date')invoiceDueDate(form);
  if(target.name==='dueDate'){
   const date=form.elements.namedItem('date').value,days=(Date.parse(target.value+'T12:00:00Z')-Date.parse(date+'T12:00:00Z'))/86400000;
   if(Number.isInteger(days)&&days>=0&&days<=365)form.elements.namedItem('paymentTermsDays').value=String(days);
  }
  if(target.name==='pricesIncludeVat')applyInvoicePriceMode(form,target.checked);
  if(target.name==='vatMode'&&target.value==='reverse-construction')form.elements.namedItem('rotEnabled').checked=false;
  const rotEnabled=form.elements.namedItem('rotEnabled')?.checked||false;
  const fields=form.querySelector('.invoice-rot-fields');if(fields)fields.hidden=!rotEnabled;
  for(const row of form.querySelectorAll('[data-invoice-line]'))updateInvoiceLineKind(row,rotEnabled);
  refreshInvoiceSummary();return;
 }
 if(target.name==='bankEventId'&&target.value){const payment=state.bankTransactions.find(x=>x.id===target.value);if(payment){const parent=target.form;parent.querySelector('[name="date"]').value=payment.date;parent.querySelector('[name="amountCents"]').value=fmt(Math.abs(payment.amountCents));}}
 }catch(error){showError(error);}
});
document.querySelector('#suite-search').addEventListener('input',event=>{
 ui.search=event.target.value;
 if(invoiceEditorOpen()){navigate('#sales');return;}
 if(purchaseWorkspace.isEditor()){navigate('#purchases');return;}
 if(ui.search&&ui.view==='purchases'&&ui.purchaseMode!=='list'){navigate('#purchases');return;}
 if(ui.search&&!['sales','ledger','purchases'].includes(ui.view)){navigate(/^A\d/i.test(ui.search)?'#ledger':'#sales');return;}
 render();
});
document.querySelector('#suite-menu').addEventListener('click',()=>{document.querySelector('#suite-sidebar').classList.add('open');document.querySelector('#suite-backdrop').hidden=false;document.querySelector('#suite-menu').setAttribute('aria-expanded','true');});
document.querySelector('#suite-backdrop').addEventListener('click',()=>{document.querySelector('#suite-sidebar').classList.remove('open');document.querySelector('#suite-backdrop').hidden=true;document.querySelector('#suite-menu').setAttribute('aria-expanded','false');});
window.addEventListener('hashchange',route);
window.addEventListener('beforeunload',event=>{if(invoiceDirty||featureDirty||purchaseWorkspace.isDirty()){event.preventDefault();event.returnValue='';}});
window.addEventListener('storage',event=>{if(event.key===STORE_KEY||event.key===null){stale=true;updateChrome();}});
dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
chat();route();
