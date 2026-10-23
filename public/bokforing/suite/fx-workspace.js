import { assert, money, toCents } from './core.js';
import { createFxDocument, issueFxDocument, settleFxDocument, creditFxDocument, revalueFxDocument, reverseFxRevaluation, getFxPosition, formatFxMinor, formatFxRate, fxInvoiceHtml, updateFxDraft, removeFxDraft, fxCreditHtml } from './fx.js';

const e = value => String(value ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const field = (label,name,value='',type='text',extra='') => `<label>${e(label)}<input name="${name}" type="${type}" value="${e(value)}" ${extra}></label>`;
const select = (label,name,options,value) => `<label>${e(label)}<select name="${name}">${options.map(([key,title])=>`<option value="${e(key)}" ${key===value?'selected':''}>${e(title)}</option>`).join('')}</select></label>`;
const form = (action,content,button) => `<form class="fx-form" data-feature-form="fx" data-action="${action}">${content}<div class="fx-full"><button class="button primary" type="submit">${e(button)}</button></div></form>`;
const hidden = id => `<input type="hidden" name="id" value="${e(id)}">`;
const amount = (label,name,value='0') => field(label,name,value,'text','inputmode="decimal" required');
const table = (headers,rows) => `<div class="fx-table"><table><thead><tr>${headers.map(h=>`<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const safeDate = state => { const now=new Date().toISOString().slice(0,10);return now<state.company.fiscalYearStart?state.company.fiscalYearStart:now>state.company.fiscalYearEnd?state.company.fiscalYearEnd:now; };
function creation(state) {
  const date = safeDate(state);
  return form('create',select('Kund- eller leverantörsfaktura','side',[['customer','Kundfaktura'],['supplier','Leverantörsfaktura']],'customer')+
    select('Valuta','currency',[['EUR','EUR · euro'],['USD','USD · US dollar']],'EUR')+
    field('Fakturanummer','number','FX-'+String((state.fxDocuments??[]).length+1).padStart(4,'0'),'text','required maxlength="100"')+
    field('Fakturadatum','date',date,'date','required')+field('Förfallodatum','dueDate',date,'date','required')+
    field('Motpartens namn','partyName','','text','required maxlength="150"')+field('Motpartens adress','partyAddress','','text','required maxlength="500"')+
    field('Säljarens namn (för leverantörsfaktura: leverantören)','sellerName',state.company.name,'text','required maxlength="150"')+
    field('Säljarens adress','sellerAddress','','text','required maxlength="500"')+field('Säljarens organisationsnummer','sellerOrgNumber',state.company.orgNumber,'text','required maxlength="50"')+
    field('Säljarens momsnummer','sellerVatNumber','','text','maxlength="50"')+field('Betalningsuppgifter och referens','paymentReference','','text','required maxlength="200"')+
    field('Kurs: SEK per 1 EUR/USD','rate','11,00','text','inputmode="decimal" required')+field('Kurskälla och underlagsreferens','rateSource','','text','required maxlength="200"')+
    select('Momsbedömning','taxTreatment',[['domestic','Svensk moms (granskad svensk affär)'],['no-vat','Ingen moms (ange motivering)']],'domestic')+
    field('Motivering till ingen moms','taxReason','','text','maxlength="300"')+
    '<label class="fx-full">Fakturarader – en per rad: beskrivning; nettobelopp i valuta; momssats; kostnadskonto<textarea name="lines" rows="4" required placeholder="Konsultarbete; 100,00; 25; 6540"></textarea></label><p class="fx-full muted">Kundrader bokförs på 3000. För leverantörsrader kan 4010, 5010, 5410, 5460, 6110, 6540, 6570 eller 6991 anges. Blandade momssatser är tillåtna. Fritext och radbelopp följer med på utskriften.</p>'+
    '<label class="fx-full fx-check"><input type="checkbox" name="reviewed" required> Jag har granskat att vald svensk moms/ingen moms är rätt och att kursen avser fakturadatum. EU-/exportregler, omvänd moms och ROT i valuta hanteras inte här.</label>', 'Spara valutautkast');
}
function editForm(doc) {
  const common=['number','partyName','partyAddress','sellerName','sellerAddress','sellerOrgNumber','sellerVatNumber','paymentReference','taxReason'];
  const names={number:'Fakturanummer',partyName:'Motpartens namn',partyAddress:'Motpartens adress',sellerName:'Säljarens namn',sellerAddress:'Säljarens adress',sellerOrgNumber:'Organisationsnummer',sellerVatNumber:'Momsnummer',paymentReference:'Betalningsuppgifter',taxReason:'Motivering till ingen moms'};
  return form('edit',hidden(doc.id)+field('Fakturadatum','date',doc.date,'date','required')+field('Förfallodatum','dueDate',doc.dueDate,'date','required')+common.map(key=>field(names[key],key,doc[key])).join('')+field('Kurs SEK per valutaenhet','rate',formatFxRate(doc.rate),'text','required')+field('Kurskälla','rateSource',doc.rate.source,'text','required')+select('Momsbehandling','taxTreatment',[['domestic','Svensk moms'],['no-vat','Ingen moms']],doc.taxTreatment)+`<label class="fx-full">Rader: beskrivning; nettobelopp i valuta; moms; konto<textarea name="lines" rows="4" required>${e(doc.lines.map(line=>[line.description,(line.foreignNetMinor/100).toFixed(2),line.vatRate,line.account].join('; ')).join('\n'))}</textarea></label><label class="fx-full fx-check"><input type="checkbox" name="reviewed" required> Jag har granskat uppgifterna och kursen.</label>`,'Spara ändrat valutautkast');
}
function documentPanel(state,doc) {
  const pos=getFxPosition(state,doc.id), date=safeDate(state), eventList=(state.fxEvents??[]).filter(event=>event.documentId===doc.id), paid=pos.foreignBalanceMinor===0;
  const rows=doc.lines.map(line=>[e(line.description),e(formatFxMinor(line.foreignNetMinor,doc.currency)),e(line.vatRate+'%'),e(formatFxMinor(line.foreignGrossMinor,doc.currency)),e(money(line.grossCents))]);
  const fieldSet=hidden(doc.id)+field('Datum','date',date,'date','required')+amount('Reglerat belopp i '+doc.currency,'foreignAmount',Math.abs(pos.foreignBalanceMinor/100).toFixed(2))+amount('Faktiskt belopp på SEK-bankkontot','bankAmount','0')+amount('Separat bankavgift i SEK','feeAmount','0')+field('Unik betalningsreferens','reference','','text','required maxlength="100"')+select('Koppla bankhändelse','existingBankId',[['','Skapa ny registrerad bankhändelse'],...state.bankTransactions.filter(item=>!item.matchedEntryId&&(item.account??'1930')==='1930').map(item=>[item.id,item.date+' · '+money(item.amountCents)+' · '+item.description])],'');
  const lastRevaluation=eventList.at(-1)?.type==='revalue'&&eventList.at(-1).entryId?eventList.at(-1):null;
  return `<article class="panel fx-document" id="fx-${e(doc.id)}"><header><div><h2>${e(doc.number)} · ${e(doc.partyName)}</h2><p>${doc.side==='customer'?'Kundfaktura':'Leverantörsfaktura'} · ${doc.status==='draft'?'Utkast':'Bokförd'} · ${e(doc.currency)} · ${e(doc.date)} → ${e(doc.dueDate)}</p></div><button class="button" type="button" data-feature-action="fx" data-action="print" data-id="${e(doc.id)}">Hämta utskriftsbar faktura</button></header>${table(['Rad','Netto','Moms','Summa i valuta','Bokfört SEK-värde'],rows)}<div class="fx-summary"><strong>Total ${e(formatFxMinor(doc.foreignGrossMinor,doc.currency))}</strong><span>Moms ${e(money(doc.vatCents))} · fryst kurs ${e(formatFxRate(doc.rate))} · ${e(doc.rate.source)}</span><strong>${pos.foreignBalanceMinor<0?'Tillgodo':'Återstår'} ${e(formatFxMinor(Math.abs(pos.foreignBalanceMinor),doc.currency))} · bokfört ${e(money(Math.abs(pos.carryingCents)))}</strong></div>
    ${doc.status==='draft'?`<details><summary>Redigera utkast</summary>${editForm(doc)}</details>`+form('issue',hidden(doc.id)+'<p class="fx-full">Utfärdande/bokföring låser originalet och skapar en verifikation i SEK.</p>','Utfärda och bokför')+`<button class="button" type="button" data-feature-action="fx" data-action="remove-draft" data-id="${e(doc.id)}">Ta bort utkast</button>`:''}
    ${doc.status==='issued'?`<div class="fx-actions">${!paid?`<details><summary>${pos.foreignBalanceMinor>0?'Registrera betalning':'Registrera återbetalning'}</summary>${form(pos.foreignBalanceMinor>0?'pay':'refund',fieldSet, 'Bokför reglering och kursdifferens')}</details>`:''}<details><summary>Kreditera hela eller delar</summary>${form('credit',hidden(doc.id)+field('Kreditdatum','date',date,'date','required')+field('Kreditreferens','reference','','text','required maxlength="100"')+field('Orsak','reason','','text','required maxlength="300"')+field('Kurs för kreditdatumet, SEK per valutaenhet','rate',formatFxRate(doc.rate),'text','required')+field('Kreditkursens källa','rateSource','','text','required')+'<label class="fx-full fx-check"><input type="checkbox" name="rateReviewed" required> Jag har granskat kreditdagens kurs. Den används om krediten skapar ett tillgodobelopp.</label>'+`<label class="fx-full">Kreditrader: radnummer; nettobelopp i ${e(doc.currency)}<textarea name="creditLines" rows="3" required placeholder="1; 10,00"></textarea></label><p class="fx-full muted">Radnummer börjar på 1. Krediten återför ursprungsradens moms exakt och fördelar bokfört värde. Belopp efter redan betald faktura blir ett separat tillgodo.</p>`,'Bokför kreditnota')}</details>${!paid?`<details><summary>Värdera öppen post vid bokslut</summary>${form('revalue',hidden(doc.id)+field('Balansdag','date',state.company.fiscalYearEnd,'date','required')+field('Balansdagskurs SEK per 1 valutaenhet','rate','','text','required inputmode="decimal"')+field('Kurskälla','rateSource','','text','required maxlength="200"')+field('Värderingsreferens','reference','','text','required maxlength="100"')+'<label class="fx-full fx-check"><input type="checkbox" name="reviewed" required> Jag har granskat balansdagskurs och att värderingen följer företagets regelverk.</label>','Bokför valutavärdering')}</details>`:''}${lastRevaluation?`<details><summary>Rätta senaste valutavärderingen</summary>${form('reverse-revalue',hidden(doc.id)+`<input type="hidden" name="eventId" value="${e(lastRevaluation.id)}">`+field('Rättelsedatum','date',lastRevaluation.date,'date','required')+field('Referens','reference','','text','required')+field('Orsak','reason','','text','required'),'Återför värderingen')}</details>`:''}</div>`:''}
    <details><summary>Händelser och verifikationer (${eventList.length})</summary>${table(['Datum','Typ','Referens','Verifikation'],eventList.map(event=>[e(event.date),e(({issue:'Faktura',payment:'Betalning',credit:'Kreditnota',refund:'Återbetalning',revalue:'Valutavärdering','revalue-reversal':'Rättad värdering'})[event.type]),event.type==='credit'?`<button class="button" type="button" data-feature-action="fx" data-action="print-credit" data-id="${e(event.id)}">${e(event.reference)} · Hämta kreditnota</button>`:e(event.reference),`<a href="#ledger">${e(state.entries.find(entry=>entry.id===event.entryId)?.number??event.entryId)}</a>`]))}</details>
  </article>`;
}
export function renderWorkspace(state) {
  const documents=state.fxDocuments??[];
  return `<section class="fx-workspace"><div class="page-heading"><div><span class="eyebrow">VALUTAFAKTUROR</span><h1>Fakturera i EUR och USD</h1><p>SEK i huvudboken, ursprungsvaluta i fakturan och exakta kursdifferenser vid reglering.</p></div></div><div class="fx-notice">Den här arbetsytan hanterar valutafakturor med svensk moms eller granskad momsfrihet. Valutan avgör aldrig skatteregeln. ROT, omvänd moms, EU-/exportregler och valutabankkonton är spärrade här tills deras särskilda kombinationsfall stöds.</div><article class="panel fx-create"><details ${documents.length?'':'open'}><summary>Ny kund- eller leverantörsfaktura i valuta</summary>${creation(state)}</details></article>${documents.length?documents.slice().reverse().map(doc=>documentPanel(state,doc)).join(''):'<p>Skapa ett valutautkast. Bokföringen sker först när du väljer Utfärda och bokför.</p>'}</section>`;
}
function parseLines(value) {
  assert(typeof value==='string','Ange fakturarader.');
  return value.split(/\r?\n/).filter(line=>line.trim()).map((line,index)=>{
    const parts=line.split(';').map(part=>part.trim());
    assert(parts.length>=3&&parts.length<=4,`Rad ${index+1}: använd beskrivning; netto; moms; konto.`);
    const vatRate=Number(parts[2]); assert([0,6,12,25].includes(vatRate),'Momssatsen stöds inte.');
    return {description:parts[0],foreignNetMinor:toCents(parts[1]),vatRate,account:parts[3]||'4010'};
  });
}
export function handleAction(state,action,data) {
  if(action==='create')return createFxDocument(state,{...data,taxReviewed:data.reviewed==='on',lines:parseLines(data.lines)});
  if(action==='edit')return updateFxDraft(state,data.id,{...data,taxReviewed:data.reviewed==='on',lines:parseLines(data.lines)});
  if(action==='remove-draft')return removeFxDraft(state,data.id);
  if(action==='issue')return issueFxDocument(state,data.id);
  if(action==='pay'||action==='refund')return settleFxDocument(state,data.id,{date:data.date,foreignMinor:toCents(data.foreignAmount),bankCents:toCents(data.bankAmount),feeCents:toCents(data.feeAmount),reference:data.reference,refund:action==='refund',bankEventId:data.existingBankId||null});
  if(action==='credit')return creditFxDocument(state,data.id,{date:data.date,reference:data.reference,reason:data.reason,rate:data.rate,rateSource:data.rateSource,rateReviewed:data.rateReviewed==='on',lines:String(data.creditLines).split(/\r?\n/).filter(line=>line.trim()).map(line=>{const [index,amount]=line.split(';');assert(/^\d+$/.test(index.trim()),'Ange ett radnummer.');return {index:Number(index.trim())-1,foreignNetMinor:toCents(amount?.trim())};})});
  if(action==='revalue')return revalueFxDocument(state,data.id,{...data,reviewed:data.reviewed==='on'});
  if(action==='reverse-revalue')return reverseFxRevaluation(state,data.id,{date:data.date,reversesEventId:data.eventId,reference:data.reference,reason:data.reason});
  throw new Error('Okänd valutaåtgärd.');
}
export function getDownload(state,action,data) {
  if(action==='print-credit')return {name:`valutakredit-${data.id}.html`,value:fxCreditHtml(state,data.id),type:'text/html;charset=utf-8'};
  if(action==='print')return {name:`valutafaktura-${data.id}.html`,value:fxInvoiceHtml(state,data.id),type:'text/html;charset=utf-8'};
  return null;
}
