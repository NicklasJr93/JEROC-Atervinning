import { money, toCents, assert, transact, nextId } from './core.js';
import { createCreditNote, refundCredit, offsetCredit, getDocumentSettlementSummary, getCreditSourceLines, previewCreditNote } from './settlements.js';

const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const amount = value => (value / 100).toFixed(2).replace('.', ',');
const values = data => data instanceof FormData ? Object.fromEntries(data) : data;
const hidden = (name, value) => `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
const moneyInput = (name, label, value = 0) => `<label>${e(label)}<input name="${e(name)}" value="${e(amount(value))}" inputmode="decimal" required autocomplete="off"></label>`;
const textInput = (name, label, maxLength = 100) => `<label>${e(label)}<input name="${e(name)}" required maxlength="${maxLength}" autocomplete="off"></label>`;
const stateDate = (state, source) => {
  const today = new Date().toISOString().slice(0, 10);
  return [state.company.fiscalYearStart, source.date, source.settlementLastDate ?? '', ...source.payments.map(p => p.date), today > state.company.fiscalYearEnd ? state.company.fiscalYearEnd : today].sort().at(-1);
};
const dateInput = (state, source) => `<label>Bokföringsdatum<input type="date" name="date" value="${e(stateDate(state, source))}" min="${e(source.date)}" max="${e(state.company.fiscalYearEnd)}" required></label>`;
const formStart = (side, source, action) => `<form data-feature-form="settlements" data-action="${action}" class="settlement-form">${hidden('side', side)}${hidden('documentId', source.id)}`;
const party = (state, side, source) => side === 'customer' ? state.customers.find(customer => customer.id === source.customerId)?.name ?? 'Kund' : source.supplier;
const eligible = (state, side, source) => (side === 'customer' ? source.kind === 'invoice' && source.status === 'issued' : source.status === 'booked');
const sameParty = (side, source, other) => side === 'customer' ? source.customerId === other.customerId : source.supplier.trim().toLocaleLowerCase('sv') === other.supplier.trim().toLocaleLowerCase('sv');

function documentCard(state, side, source, open) {
  const totals = getDocumentSettlementSummary(side, source), lines = getCreditSourceLines(state, side, source.id);
  const special=!!source.rot||(side==='customer'&&(state.revenueSchedules??[]).some(item=>item.invoiceId===source.id));
  const preview=(state.creditPreviews??[]).find(item=>item.payload.side===side&&item.payload.documentId===source.id);
  const canCredit = lines.some(line => line.remainingNetCents > 0);
  const others = (side === 'customer' ? state.invoices : state.bills).filter(other => !source.rot&&!other.rot&&other.id !== source.id && eligible(state, side, other) && sameParty(side, source, other) && getDocumentSettlementSummary(side, other).outstandingCents > 0);
  return `<details class="settlement-document"${open ? ' open' : ''}><summary><span><strong>${e(source.number)}</strong> · ${e(party(state, side, source))}<small>${side === 'customer' ? 'Kundfaktura' : 'Leverantörsfaktura'} · ${e(source.date)}</small></span><span class="settlement-summary-amount">${totals.refundableCents ? `Tillgodo ${e(money(totals.refundableCents))}` : `Kvar ${e(money(totals.outstandingCents))}`}</span></summary>
    <div class="settlement-body"><p><a class="text-link" href="#${side === 'customer' ? 'sales' : 'purchases'}/${e(source.id)}">Öppna originalfakturan</a> · Ursprungliga uppgifter och verifikationer bevaras.</p>
    <div class="settlement-metrics"><div><small>Krediterat inkl. moms</small><strong>${e(money(totals.creditCents))}</strong></div><div><small>Återbetalat</small><strong>${e(money(totals.refundCents))}</strong></div><div><small>${totals.refundableCents ? 'Kvar att återbetala / kvitta' : 'Kvar att betala'}</small><strong>${e(money(totals.refundableCents || totals.outstandingCents))}</strong></div></div>
    ${canCredit ? `${formStart(side, source, special?'preview-special-credit':'credit')}<h3>Skapa kreditnota</h3><p>Ange nettobelopp per originalrad. Moms och bokföring räknas från originalets belopp, även efter rabatt. Lämna 0 på rader som inte ska krediteras.</p><div class="table-scroll"><table><thead><tr><th>Originalrad</th><th>Ursprungligt netto</th><th>Kvar att kreditera</th><th>Kreditera netto</th></tr></thead><tbody>${lines.map(line => `<tr><td>${e(line.description)}</td><td>${e(money(line.netCents))}</td><td>${e(money(line.remainingNetCents))}</td><td><input aria-label="Kreditera netto: ${e(line.description)}" name="line-${line.index}" value="0,00" inputmode="decimal" ${line.remainingNetCents ? '' : 'disabled'}></td></tr>`).join('')}</tbody></table></div><div class="settlement-fields">${dateInput(state, source)}${textInput('reference', 'Unik kreditreferens')}${textInput('reason', 'Orsak till krediteringen', 300)}</div><button class="button primary" type="submit">${special?'Förhandsgranska kredit och följdändringar':'Bokför kreditnota'}</button></form>${preview?renderPreview(state,source,preview):''}` : '<p class="note">Hela originalfakturans nettobelopp är krediterat.</p>'}
    ${totals.refundableCents ? `<div class="settlement-actions-grid">${formStart(side, source, 'refund')}<h3>${side === 'customer' ? 'Registrera återbetalning till kunden' : 'Registrera återbetalning från leverantören'}</h3><p>Registrerar en genomförd betalning i demon. Ingen banköverföring skickas.</p><div class="settlement-fields">${dateInput(state, source)}${moneyInput('amount', 'Återbetalat belopp', totals.refundableCents)}${textInput('reference', 'Unik betalningsreferens')}<label>Befintlig bankhändelse<select name="bankEventId"><option value="">Skapa fiktiv kontohändelse</option>${state.bankTransactions.filter(event => !event.matchedEntryId && event.account === '1930' && (side === 'customer' ? event.amountCents < 0 : event.amountCents > 0)).map(event => `<option value="${e(event.id)}">${e(event.date)} · ${e(money(event.amountCents))} · ${e(event.description)}</option>`).join('')}</select></label></div><button class="button primary" type="submit">Bokför återbetalning</button></form>
    ${others.length ? `${formStart(side, source, 'offset')}<h3>Kvitta mot en annan faktura</h3><p>Endast samma motpart kan väljas. Kvittningen flyttar tillgodot mellan fakturorna utan bankrörelse.</p><div class="settlement-fields">${dateInput(state, source)}<label>Faktura att betala med tillgodot<select name="targetDocumentId" required>${others.map(other => `<option value="${e(other.id)}">${e(other.number)} · ${e(money(getDocumentSettlementSummary(side, other).outstandingCents))} kvar</option>`).join('')}</select></label>${moneyInput('amount', 'Belopp att kvitta', Math.min(totals.refundableCents, getDocumentSettlementSummary(side, others[0]).outstandingCents))}${textInput('reference', 'Unik kvittningsreferens')}</div><button class="button secondary" type="submit">Bokför kvittning</button></form>` : ''}</div>` : ''}
    </div></details>`;
}

function renderPreview(state,source,preview){
  const planName=id=>(state.revenueSchedules??[]).find(item=>item.id===id)?.name??id;
  return `<section class="settlement-preview" aria-label="Granska kredit"><h3>Granska kreditens följdändringar</h3><p>Kreditnota: <strong>${e(money(preview.amountCents))}</strong> inklusive moms. Originalfakturan och tidigare verifikationer bevaras.</p>
  ${preview.revenueAdjustments.map(item=>`<p><strong>${e(planName(item.planId))}</strong>: ${e(money(item.deferredCents))} återförs från kvarvarande förutbetald intäkt och ${e(money(item.recognizedCents))} från redan redovisad intäkt.</p>`).join('')}
  ${preview.rot?`<p>ROT ändras från ${e(money(preview.rot.beforeCents))} till ${e(money(preview.rot.afterCents))}. ${preview.rot.taxRepaymentCents?`Återbetalning till Skatteverket: <strong>${e(money(preview.rot.taxRepaymentCents))}</strong>.`:'Ingen skatteåterbetalning bokförs.'}</p><p>Gamla begäranden bevaras som historik. Återstående ROT hanteras i Moms & ROT efter rättelsen. Personvisa rättelser för flera mottagare hanteras separat med Skatteverket.</p>`:''}
  <table><thead><tr><th>Konto</th><th>Debet</th><th>Kredit</th></tr></thead><tbody>${preview.rows.map(row=>`<tr><td>${e(row.account)}</td><td>${e(money(row.debitCents))}</td><td>${e(money(row.creditCents))}</td></tr>`).join('')}</tbody></table>
  ${formStart(preview.payload.side,source,'confirm-special-credit')}${hidden('fingerprint',preview.fingerprint)}<label class="settlement-check"><input name="specialReviewed" type="checkbox" value="true" required> Jag har granskat kredit, moms och ${preview.hasRevenue?'att krediten gäller proportionellt över hela avtalsperioden':'ROT-underlaget'}.</label>
  ${preview.rot?`<label class="settlement-check"><input name="rotCaseAdjusted" type="checkbox" value="true" required> Jag har hanterat rättelsen av gamla ROT-begäranden hos Skatteverket.</label>${textInput('taxReference','Referens till ROT-rättelsen',150)}${preview.rot.taxRepaymentCents?'<label class="settlement-check"><input name="taxRefundConfirmed" type="checkbox" value="true" required> Återbetalningen till Skatteverket har verkligen genomförts och ska bokföras på angivet datum.</label>':''}`:''}
  <button class="button primary" type="submit">Bekräfta och bokför granskad kredit</button></form></section>`;
}

export function renderWorkspace(state) {
  const documents = [...state.invoices.map(source => ({ side: 'customer', source })), ...state.bills.map(source => ({ side: 'supplier', source }))].filter(({ side, source }) => eligible(state, side, source)).sort((a, b) => b.source.date.localeCompare(a.source.date));
  const history = [...(state.settlements ?? [])].reverse();
  return `<div class="settlement-workspace"><header class="page-heading"><div><span class="eyebrow">KREDITER & ÅTERBETALNINGAR</span><h1>Kreditera, återbetala och kvitta</h1><p>Delkredit och helkredit med spårbar koppling till originalfakturan.</p></div></header>
    <div class="note"><p>Du kan kreditera även betalda fakturor. Bokför först kreditnotan och registrera sedan en faktisk återbetalning eller kvittning. ROT och intäktsperiodisering får en separat förhandsgranskning med följdändringar innan du bekräftar.</p></div>
    <section class="panel"><div class="panel-heading"><h2>Välj en originalfaktura</h2></div>${documents.length ? documents.map(({ side, source }, index) => documentCard(state, side, source, index === 0)).join('') : '<p class="empty">Utfärda en kundfaktura eller bokför en leverantörsfaktura för att prova flödet.</p>'}</section>
    <section class="panel"><div class="panel-heading"><h2>Bokförda krediter och betalningar</h2></div>${history.length ? history.map(record => `<details class="settlement-history"><summary><strong>${e(record.number || record.reference)}</strong><span>${e({ credit: 'Kreditnota', refund: 'Återbetalning', offset: 'Kvittning' }[record.kind])} · ${e(record.date)} · ${e(money(record.amountCents))}</span></summary><dl><dt>Referens</dt><dd>${e(record.reference)}</dd>${record.reason ? `<dt>Orsak</dt><dd>${e(record.reason)}</dd>` : ''}<dt>Original</dt><dd><a href="#${record.side === 'customer' ? 'sales' : 'purchases'}/${e(record.documentId)}">Öppna originalfaktura</a></dd></dl>${record.lines ? `<p>Krediterade originalrader: ${record.lines.map(line => `${line.index + 1}: ${money(line.netCents)} netto`).map(e).join(' · ')}</p>` : ''}<div class="table-scroll"><table><thead><tr><th>Konto</th><th>Debet</th><th>Kredit</th></tr></thead><tbody>${(state.entries.find(entry => entry.id === record.entryId)?.rows ?? []).map(row => `<tr><td>${e(row.account)}</td><td>${row.debitCents ? e(money(row.debitCents)) : '—'}</td><td>${row.creditCents ? e(money(row.creditCents)) : '—'}</td></tr>`).join('')}</tbody></table></div></details>`).join('') : '<p class="empty">Inga krediter eller återbetalningar är bokförda ännu.</p>'}</section></div>`;
}

export function handleAction(state, action, input) {
  const data = values(input);
  assert(data && typeof data === 'object', 'Formulärets uppgifter saknas.');
  const common = { side: data.side, documentId: data.documentId, date: data.date, reference: data.reference };
  if (action === 'confirm-special-credit') {
    const preview=(state.creditPreviews??[]).find(item=>item.payload.side===data.side&&item.payload.documentId===data.documentId);
    assert(preview&&preview.fingerprint===data.fingerprint,'Förhandsgranska krediten igen.');
    const current=previewCreditNote(state,preview.payload);assert(current.fingerprint===preview.fingerprint,'Bokföringen har ändrats. Förhandsgranska krediten igen.');
    const next=createCreditNote(state,{...preview.payload,specialReviewed:data.specialReviewed==='true',rotCaseAdjusted:data.rotCaseAdjusted==='true',taxRefundConfirmed:data.taxRefundConfirmed==='true',taxReference:data.taxReference});
    return transact(next,draft=>{draft.creditPreviews=(draft.creditPreviews??[]).filter(item=>item!==preview&&!(item.payload.side===data.side&&item.payload.documentId===data.documentId));});
  }
  if (action === 'credit'||action==='preview-special-credit') {
    const lines = Object.entries(data).filter(([name, value]) => /^line-\d+$/.test(name) && String(value).trim()).map(([name, value]) => ({ index: Number(name.slice(5)), netCents: toCents(value) })).filter(line => line.netCents > 0);
    const payload={...common,reason:data.reason,lines};
    if(action==='preview-special-credit'){const preview=previewCreditNote(state,payload);return transact(state,draft=>{draft.creditPreviews=[...(draft.creditPreviews??[]).filter(item=>item.payload.side!==data.side||item.payload.documentId!==data.documentId),{...preview,id:nextId(draft,'credit-preview')}];});}
    return createCreditNote(state,payload);
  }
  if (action === 'refund') return refundCredit(state, { ...common, amountCents: toCents(data.amount), bankEventId: data.bankEventId || null });
  if (action === 'offset') return offsetCredit(state, { ...common, amountCents: toCents(data.amount), targetDocumentId: data.targetDocumentId });
  throw new Error('Okänd kreditåtgärd.');
}
