// Dedicated invoice workspaces. Everything here reads/writes the same demo
// invoice model as the rest of the suite; no distribution service is called.
import { money, toCents, assert } from './core.js';
import { getInvoiceTotals, getInvoiceOutstanding } from './sales.js';
import { calculateLineAmounts } from './rot.js';
import { normalizeInvoiceDetails } from './invoice-data.js';
import { getInvoiceIssuanceIssues, invoicePerformanceText, invoiceSellerVatRequired } from './invoice-requirements.js';
import { VAT_EXEMPTION_REASONS, normalizeVatExemption, vatExemptionInvoiceText } from './vat-classification.js';
import { escapeHtml as e, icon, numberInput } from './views.js';

const TODAY = '2026-10-23';
const kindNames = { labor: 'Arbete', material: 'Material', other: 'Övrigt' };
const statusNames = { draft: 'Utkast', issued: 'Utfärdad', credited: 'Krediterad', prepared: 'Begäran förberedd', approved: 'Beviljat exempel', denied: 'Avslaget exempel', settled: 'Reglerad' };
const sum = values => values.reduce((total, value) => total + value, 0);
const hasDelivery = delivery => Boolean(delivery && ['name','address','address2','postalCode','city','date','method','terms'].some(key => String(delivery[key] || '').trim()));
const inputNumber = value => String(value ?? '').replace('.', ',');
const bpsInput = value => numberInput(value ?? 0);
const badge = value => `<span class="badge ${e(value)}">${e(statusNames[value] || value)}</span>`;
const button = (label, action, id = '', kind = 'secondary', extra = '') => `<button type="button" class="button ${kind}" data-action="${e(action)}" data-id="${e(id)}" ${extra}>${e(label)}</button>`;
const pair = (label, value) => `<div class="label-value"><span>${e(label)}</span><strong>${e(value || '—')}</strong></div>`;
const option = (value, label, selected) => `<option value="${e(value)}" ${selected ? 'selected' : ''}>${e(label)}</option>`;
const field = (label, name, value = '', { type = 'text', extra = '', className = '', help = '' } = {}) => `<label class="${e(className)}"><span>${e(label)}</span><input name="${e(name)}" type="${e(type)}" value="${e(value)}" ${extra}>${help ? `<small>${e(help)}</small>` : ''}</label>`;
const checkbox = (label, name, checked = false, extra = '') => `<label class="checkbox"><input type="checkbox" name="${e(name)}" ${checked ? 'checked' : ''} ${extra}><span>${e(label)}</span></label>`;
const select = (label, name, choices, selected, extra = '') => `<label><span>${e(label)}</span><select name="${e(name)}" ${extra}>${choices.map(([value, text]) => option(value, text, String(value) === String(selected))).join('')}</select></label>`;
const textArea = (label, name, value = '', help = '') => `<label><span>${e(label)}</span><textarea name="${e(name)}" maxlength="2000" rows="4">${e(value)}</textarea>${help ? `<small>${e(help)}</small>` : ''}</label>`;
const section = (id, title, subtitle, content, { open = true, extra = '' } = {}) => `<details class="invoice-section" id="${e(id)}" ${open ? 'open' : ''}><summary><span>${icon('arrow')}<strong>${e(title)}</strong></span>${subtitle ? `<small>${e(subtitle)}</small>` : ''}${extra}</summary><div class="invoice-section-body">${content}</div></details>`;
const dueAfter = (date, days) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + Number(days));
  return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : '';
};

export function createInvoiceEditorDraft(state, invoice = null) {
  const customerId = invoice?.customerId || state.customers[0]?.id || '';
  const date = invoice?.date || (TODAY < state.company.fiscalYearStart ? state.company.fiscalYearStart : TODAY > state.company.fiscalYearEnd ? state.company.fiscalYearEnd : TODAY);
  const dueDate = invoice?.dueDate || dueAfter(date, 30);
  const draft = {
    id: invoice?.id || '', number: invoice?.number || '', kind: 'invoice', status: 'draft', customerId,
    projectId: invoice?.projectId || null, date, dueDate,
    vatMode: invoice?.vatMode || 'standard', buyerConstructionConfirmed: invoice?.buyerConstructionConfirmed === true,
    invoiceDiscountBps: invoice?.invoiceDiscountBps || 0,
    details: normalizeInvoiceDetails(state, { ...invoice, customerId, date, dueDate, details: invoice?.details }),
    lines: invoice?.lines?.length ? structuredClone(invoice.lines) : [{ articleNumber: '', description: 'Snickeriarbete', kind: 'labor', quantity: 1, unit: 'tim', unitCents: 55_000, vatRate: 25, discountBps: 0, unitPriceIncludesVat: false, rotEligible: true }],
    rot: invoice?.rot ? structuredClone(invoice.rot) : null,
    payments: [], reminders: [],
  };
  draft.lines = draft.lines.map(line => ({ articleNumber: '', unit: line.kind === 'labor' ? 'tim' : 'st', discountBps: 0, unitPriceIncludesVat: false, rotEligible: line.kind === 'labor', ...line }));
  return draft;
}

export function createInvoiceLineHTML(line = {}, index = 0, { includesVat = false, rotEnabled = false, vatMode = 'standard' } = {}) {
  const value = { articleNumber: '', description: '', kind: 'labor', quantity: 1, unit: 'tim', unitCents: 0, discountBps: 0, vatRate: 25, rotEligible: true, ...line };
  const control = (name, label, content, className = '') => `<label class="${className}"><span>${e(label)}</span>${content}</label>`;
  const input = (name, extra = '') => `<input data-line-field="${name}" aria-label="${e(({articleNumber:'Artikelnummer',description:'Beskrivning',quantity:'Antal / arbetade timmar',unit:'Enhet',unitCents:'À-pris',discountBps:'Radrabatt i procent'})[name] || name)}" value="${e(name === 'unitCents' ? numberInput(value[name]) : name === 'discountBps' ? bpsInput(value[name]) : name === 'quantity' ? inputNumber(value[name]) : String(value[name] ?? ''))}" ${extra}>`;
  return `<div class="invoice-work-row" data-invoice-line data-row-index="${index}" data-price-includes-vat="${value.unitPriceIncludesVat ?? includesVat}">
    <span class="invoice-row-number" aria-hidden="true">${index + 1}</span>
    ${control('articleNumber', 'Artikelnr', input('articleNumber', 'maxlength="80"'), 'invoice-article')}
    ${control('description', 'Beskrivning', input('description', 'required maxlength="300"'), 'invoice-description')}
    ${control('kind', 'Typ', `<select data-line-field="kind" aria-label="Radtyp">${Object.entries(kindNames).map(([kind,label]) => option(kind,label,kind === value.kind)).join('')}</select>`, 'invoice-kind')}
    ${control('quantity', 'Antal / timmar', input('quantity', 'required inputmode="decimal"'), 'invoice-quantity')}
    ${control('unit', 'Enhet', input('unit', 'maxlength="30" list="invoice-unit-options"'), 'invoice-unit')}
    ${control('unitCents', includesVat ? 'À-pris inkl. moms' : 'À-pris exkl. moms', input('unitCents', 'required inputmode="decimal"'), 'invoice-price')}
    ${control('discountBps', 'Rabatt %', input('discountBps', 'required inputmode="decimal"'), 'invoice-discount')}
    ${control('vatRate', 'Moms %', `<select data-line-field="vatRate" aria-label="Momssats">${[25,12,6,0].map(rate=>option(rate,rate+' %',rate===value.vatRate)).join('')}</select>`, 'invoice-vat')}
    <label class="invoice-rot-line checkbox"><span>ROT</span><input type="checkbox" data-line-field="rotEligible" aria-label="ROT-berättigat arbete" ${value.rotEligible && value.kind==='labor'?'checked':''} ${value.kind!=='labor'||!rotEnabled?'disabled':''}></label>
    <div class="invoice-row-actions"><button type="button" class="icon-button" data-action="remove-invoice-line" aria-label="Ta bort fakturarad">${icon('x')}</button></div>
  </div><div class="invoice-vat-exemption" data-vat-exemption-row="${index}" ${Number(value.vatRate)===0&&vatMode==='standard'?'':'hidden'}><label>Skäl till 0 % moms<select data-line-field="vatExemption.code" aria-label="Momsundantag">${option('','Välj prövat undantag',!value.vatExemption?.code)}${VAT_EXEMPTION_REASONS.map(reason=>option(reason.code,reason.label,reason.code===value.vatExemption?.code)).join('')}</select></label><label>Lagstöd och motivering<input data-line-field="vatExemption.legalBasis" aria-label="Lagstöd för momsundantag" maxlength="500" value="${e(value.vatExemption?.legalBasis||'')}"></label><label class="checkbox"><input type="checkbox" data-line-field="vatExemption.confirmed" aria-label="Villkoren för momsundantaget är granskade" ${value.vatExemption?.confirmed?'checked':''}>Villkoren för undantaget är granskade</label></div>`;
}

function customerFields(details) {
  const customer = details.customer;
  return `<div class="invoice-grid invoice-grid-four">
    ${field('Kundnamn', 'customer.name', customer.name, {extra:'required maxlength="150"'})}
    ${field('Organisationsnummer / person-ID', 'customer.orgNumber', customer.orgNumber, {extra:'maxlength="80"'})}
    ${field('Momsregistreringsnummer', 'customer.vatNumber', customer.vatNumber || '', {extra:'maxlength="40"',help:'Obligatoriskt vid omvänd byggmoms. Ingen registerkontroll görs.'})}
    ${field('Telefon', 'customer.phone', customer.phone, {extra:'maxlength="80"',type:'tel'})}
    ${field('E-post', 'customer.email', customer.email, {type:'email',extra:'maxlength="254"'})}
    ${field('Fakturaadress', 'customer.address', customer.address, {extra:'maxlength="250"',className:'invoice-span-two'})}
    ${field('Postnummer', 'customer.postalCode', customer.postalCode, {extra:'maxlength="30"'})}
    ${field('Ort', 'customer.city', customer.city, {extra:'maxlength="150"'})}
    ${field('Fakturaadress 2', 'customer.address2', customer.address2, {extra:'maxlength="250"',className:'invoice-span-two'})}
    ${field('Land', 'customer.country', 'Sverige', {extra:'readonly aria-readonly="true"'})}
    ${field('E-post för påminnelser', 'customer.reminderEmail', customer.reminderEmail, {type:'email',extra:'maxlength="254"'})}
  </div><p class="invoice-help">Uppgifterna sparas på fakturan. Adress- eller registerändringar ändrar inte en redan utfärdad fakturas kunduppgifter.</p>`;
}

function deliveryFields(details) {
  const delivery = details.delivery;
  return `<div class="invoice-grid invoice-grid-four">
    ${field('Leveransmottagare', 'delivery.name', delivery.name, {extra:'maxlength="150"'})}
    ${field('Leveransadress', 'delivery.address', delivery.address, {extra:'maxlength="250"'})}
    ${field('Postnummer', 'delivery.postalCode', delivery.postalCode, {extra:'maxlength="30"'})}
    ${field('Ort', 'delivery.city', delivery.city, {extra:'maxlength="150"'})}
    ${field('Leveransdatum', 'delivery.date', delivery.date, {type:'date'})}
    ${field('Leveransadress 2', 'delivery.address2', delivery.address2, {extra:'maxlength="250"'})}
    ${field('Leveranssätt', 'delivery.method', delivery.method, {extra:'maxlength="150"'})}
    ${field('Leveransvillkor', 'delivery.terms', delivery.terms, {extra:'maxlength="200"'})}
    ${field('Land', 'delivery.country', 'Sverige', {extra:'readonly aria-readonly="true"'})}
  </div>`;
}

function performanceFields(details) {
  const value = details.performance || {mode:'invoice-date',confirmed:false};
  return `<div class="invoice-grid invoice-grid-four">
    ${select('Datum för leverans / utförande','performance.mode',[['invoice-date','Samma som fakturadatum'],['date','Annat datum'],['period','Utförande under en period']],value.mode)}
    ${field('Annat leverans-/utförandedatum','performance.date',value.date||'',{type:'date'})}
    ${field('Period från','performance.from',value.from||'',{type:'date'})}
    ${field('Period till','performance.to',value.to||'',{type:'date'})}
  </div>${checkbox('Jag har kontrollerat att det valda datumet eller perioden stämmer med leveransen/utförandet','performance.confirmed',value.confirmed)}
  <p class="invoice-help">Uppgiften skrivs ut på fakturan. Mottagna förskott hanteras inte som vanlig försäljning i denna arbetsyta.</p>`;
}

function rotFields(draft) {
  const rot = draft.rot;
  return `${checkbox('Använd ROT-avdrag', 'rotEnabled', Boolean(rot))}<div class="invoice-rot-fields" ${rot?'':'hidden'}>
    <p class="invoice-help">För betalningar 2026: 30 % av berättigat arbete inklusive moms, högst 50 000 kr per person och år. Markera vilka arbetsrader som avser ROT; material och resor ingår inte.</p>
    <div class="invoice-grid invoice-grid-four">
      ${field('Fastighet / bostad', 'property', rot?.property || '', {extra:'maxlength="150"'})}
      ${field('ROT-person (fiktivt ID)', 'personId', rot?.personId || 'DEMO-001', {extra:'maxlength="100"'})}
      ${field('Betalningsår', 'paymentYear', rot?.paymentYear || 2026, {type:'number',extra:'min="2026" max="2026"'})}
      ${field('Uppgivet årsutrymme före demofakturorna', 'availableCents', numberInput(rot?.availableCents ?? 5_000_000), {extra:'inputmode="decimal"',help:'Efter övriga ROT/RUT och eget skatteutrymme.'})}
    </div>
    ${checkbox('Ägande, arbetstyp och övriga villkor har granskats; kunden har uppgivet skatteutrymme', 'eligibleConfirmed', rot?.eligibleConfirmed)}
    <p class="invoice-help">På ROT-rader avser antalet faktiskt arbetade timmar. En person per faktura. Kundbetalning och utfört arbete bekräftas före demobegäran.</p>
    <a class="text-link" href="https://www.skatteverket.se/foretag/skatterochavdrag/rotochrut/safungerarrotavdraget.4.2ef18e6a125660db8b080002709.html" target="_blank" rel="noopener noreferrer">Läs ROT-villkoren hos Skatteverket ↗</a>
  </div>`;
}

function feeExemptionFields(type, line, vatMode) {
  return `<div class="invoice-vat-exemption" data-fee-exemption="${type}" ${line?.vatRate===0&&vatMode==='standard'?'':'hidden'}>
    ${select('Undantag för '+(type==='freight'?'frakt':'fakturaavgift'),type+'.vatExemption.code',[['','Välj prövat undantag'],...VAT_EXEMPTION_REASONS.map(reason=>[reason.code,reason.label])],line?.vatExemption?.code||'')}
    ${field('Lagstöd och motivering',type+'.vatExemption.legalBasis',line?.vatExemption?.legalBasis||'',{extra:'maxlength="500"'})}
    ${checkbox('Villkoren för avgiftens momsundantag är granskade',type+'.vatExemption.confirmed',line?.vatExemption?.confirmed)}
  </div>`;
}

function feeFields(draft) {
  const fee = type => draft.lines.find(line => line.chargeType === type);
  const includes = draft.details.pricesIncludeVat;
  return `<div class="invoice-grid invoice-fee-grid">
    ${field('Fraktavgift', 'freightCents', numberInput(fee('freight')?.unitCents || 0), {extra:'inputmode="decimal"',help:includes?'Inklusive moms':'Exklusive moms'})}
    ${select('Moms på frakt', 'freightVatRate', [25,12,6,0].map(rate=>[rate,rate+' %']), fee('freight')?.vatRate ?? 25)}
    ${field('Fakturaavgift', 'invoiceFeeCents', numberInput(fee('invoice-fee')?.unitCents || 0), {extra:'inputmode="decimal"',help:includes?'Inklusive moms':'Exklusive moms'})}
    ${select('Moms på fakturaavgift', 'invoiceFeeVatRate', [25,12,6,0].map(rate=>[rate,rate+' %']), fee('invoice-fee')?.vatRate ?? 25)}
    ${field('Fakturarabatt %', 'invoiceDiscountBps', bpsInput(draft.invoiceDiscountBps), {extra:'inputmode="decimal"',help:'Efter radrabatt. Frakt och fakturaavgift undantas.'})}
  </div>${feeExemptionFields('freight',fee('freight'),draft.vatMode)}${feeExemptionFields('invoice-fee',fee('invoice-fee'),draft.vatMode)}`;
}

export function renderInvoiceEditor(state, draft, { isNew = !draft.id, error = '', busy = false } = {}) {
  const details = draft.details;
  const itemLines = draft.lines.filter(line => !line.chargeType);
  const title = isNew ? 'Ny kundfaktura' : `Redigera ${draft.number || 'fakturautkast'}`;
  return `<div class="invoice-workspace invoice-editor-page">
    <div class="invoice-breadcrumb"><a href="#sales" data-action="invoice-back">${icon('arrow')}Kundfakturor</a><span>/</span><span>${e(title)}</span></div>
    <header class="invoice-page-heading"><div><span class="eyebrow">FÖRSÄLJNING · FAKTURERING</span><h1>${e(title)}</h1><p>Samla kund, villkor, rader och ROT på samma arbetsyta.</p></div><div class="actions">${badge('draft')}<span class="invoice-local-status" id="invoice-editor-status">Ej sparade ändringar</span></div></header>
    <nav class="invoice-section-nav" aria-label="Fakturans avsnitt"><a href="#invoice-basic" data-invoice-section="invoice-basic">Fakturauppgifter</a><a href="#invoice-customer" data-invoice-section="invoice-customer">Kund</a><a href="#invoice-delivery" data-invoice-section="invoice-delivery">Leverans</a><a href="#invoice-rows" data-invoice-section="invoice-rows">Fakturarader</a><a href="#invoice-rot" data-invoice-section="invoice-rot">ROT</a><a href="#invoice-summary" data-invoice-section="invoice-summary">Summering</a></nav>
    <form id="invoice-page-form" data-form="invoice-page" data-prices-include-vat="${details.pricesIncludeVat}" novalidate>
      <input type="hidden" name="id" value="${e(draft.id || '')}">
      <div id="invoice-page-error" class="form-error" role="alert" ${error?'':'hidden'}>${e(error)}</div>
      <div class="invoice-basics-card invoice-grid invoice-grid-four" id="invoice-basic">
        ${select('Kund', 'customerId', [['','Välj kund'],...state.customers.map(customer=>[customer.id,customer.name])], draft.customerId, 'required')}
        ${field('Fakturadatum', 'date', draft.date, {type:'date',extra:'required'})}
        ${field('Förfallodatum', 'dueDate', draft.dueDate, {type:'date',extra:'required'})}
        ${field('Betalningsvillkor, dagar', 'paymentTermsDays', details.paymentTermsDays, {type:'number',extra:'required min="0" max="365"'})}
      </div>
      ${section('invoice-settings','Fakturauppgifter','Referenser, projekt och prissättning',`<div class="invoice-grid invoice-grid-four">
        ${field('Vår referens','ourReference',details.ourReference,{extra:'maxlength="150"'})}
        ${field('Er referens','customerReference',details.customerReference,{extra:'maxlength="150"'})}
        ${field('Ert ordernummer','customerOrderNumber',details.customerOrderNumber,{extra:'maxlength="150"'})}
        ${field('Kostnadsställe / märkning','costCenter',details.costCenter,{extra:'maxlength="100"'})}
        ${select('Projekt','projectId',[['','Utan projekt'],...state.projects.filter(project=>project.customerId===draft.customerId).map(project=>[project.id,project.name])],draft.projectId||'')}
        ${field('Prisunderlag / prislista','priceListName',details.priceListName,{extra:'maxlength="150"',help:'Anteckning. Artikelpriserna anges manuellt.'})}
        ${select('Momstyp','vatMode',[['standard','Sverige · vanlig moms'],['reverse-construction','Omvänd byggmoms']],draft.vatMode)}
        ${field('Valuta','currency','SEK',{extra:'readonly aria-readonly="true"'})}
      </div><div class="invoice-settings-checks">${checkbox('Priser anges inklusive moms','pricesIncludeVat',details.pricesIncludeVat)}${checkbox('Köparens förutsättningar för omvänd byggmoms är granskade','buyerConstructionConfirmed',draft.buyerConstructionConfirmed)}</div>`)}
      ${section('invoice-seller','Säljare','Frysta företagsuppgifter vid utfärdande',`${addressBlock(state.company)}<p class="invoice-help">Kontrollera företagets adress och momsregistreringsnummer. <a href="#setup">Ändra företagsuppgifter</a>. Exempeluppgifterna är fiktiva; ingen kontroll mot register görs.</p>`,{open:false})}
      ${section('invoice-performance','Leverans eller utförande','Bekräfta datum eller period före utfärdande',performanceFields(details))}
      ${section('invoice-customer','Kunduppgifter','Fakturamottagare och kontaktuppgifter',customerFields(details))}
      ${section('invoice-delivery','Leveransuppgifter','Separat leveransadress och villkor',deliveryFields(details),{open:hasDelivery(details.delivery)})}
      <section class="invoice-section invoice-lines-section" id="invoice-rows"><header><div><h2>Fakturarader</h2><p>Arbete, material och övrigt specificeras var för sig.</p></div>${button('Lägg till rad','add-invoice-line','','secondary')}</header><div class="invoice-row-scroll"><div class="invoice-row-table"><div class="invoice-work-row invoice-row-head" aria-hidden="true"><span>#</span><span>Artikelnr</span><span>Beskrivning</span><span>Typ</span><span>Antal / timmar</span><span>Enhet</span><span class="invoice-unit-label">${details.pricesIncludeVat?'À-pris inkl. moms':'À-pris exkl. moms'}</span><span>Rabatt %</span><span>Moms %</span><span>ROT</span><span></span></div><div id="invoice-page-lines">${itemLines.map((line,index)=>createInvoiceLineHTML(line,index,{includesVat:details.pricesIncludeVat,rotEnabled:Boolean(draft.rot),vatMode:draft.vatMode})).join('')}</div></div></div><div class="invoice-line-footer">${button('Lägg till fakturarad','add-invoice-line','','secondary small')}<span>Artikelnummer är en märkning; priser och moms anges på raden.</span></div><datalist id="invoice-unit-options"><option value="tim"><option value="st"><option value="m"><option value="m²"><option value="kg"><option value="dag"></datalist></section>
      ${section('invoice-rot','ROT-avdrag','Avgränsat demoflöde för en person och betalningsår 2026',rotFields(draft),{open:Boolean(draft.rot)})}
      <section class="invoice-section" id="invoice-summary"><header><h2>Text, avgifter och summering</h2></header><div class="invoice-section-body"><div class="invoice-grid invoice-summary-grid"><div>${textArea('Fakturatext','invoiceText',details.invoiceText,'Texten följer med till fakturans utskrift.')}${feeFields(draft)}<div class="invoice-grid invoice-grid-two">${field('Utskriftsspråk','language','Svenska',{extra:'readonly aria-readonly="true"'})}${field('Utskriftsformat','printFormat','Standard · PDF via utskrift',{extra:'readonly aria-readonly="true"'})}</div></div><aside id="invoice-live-summary" class="invoice-summary-card" aria-live="polite">${renderInvoiceSummary(draft)}</aside></div></div></section>
      <div class="invoice-save-bar"><div><strong>Utkast</strong><span>Spara först. Granska och utfärda från fakturans sida.</span></div><div class="actions">${button('Avbryt','invoice-back')}<button type="submit" class="button primary" ${busy?'disabled':''}>${busy?'Sparar…':'Spara utkast'}</button></div></div>
    </form>
  </div>`;
}

function parsePercent(value, label) {
  const result = toCents(String(value || '0'));
  assert(result <= 10_000, `${label} ska vara mellan 0 och 100 procent.`);
  return result;
}

export function readInvoiceEditor(form) {
  const value = name => String(form.elements.namedItem(name)?.value ?? '').trim();
  const checked = name => form.elements.namedItem(name)?.checked === true;
  const pricesIncludeVat = checked('pricesIncludeVat');
  const lines = [...form.querySelectorAll('[data-invoice-line]')].map(row => {
    const get = fieldName => String(row.querySelector(`[data-line-field="${fieldName}"]`)?.value ?? '').trim();
    const quantityText = get('quantity').replace(',','.');
    assert(/^\d+(?:\.\d{1,2})?$/.test(quantityText),'Antal ska vara positivt med högst två decimaler.');
    const kind = get('kind');
    const exemption=row.nextElementSibling?.matches('[data-vat-exemption-row]')?row.nextElementSibling:null;
    const exemptionCode=exemption?.querySelector('[data-line-field="vatExemption.code"]')?.value||'';
    const vatExemption=exemptionCode&&Number(get('vatRate'))===0&&value('vatMode')==='standard'?normalizeVatExemption({code:exemptionCode,legalBasis:exemption.querySelector('[data-line-field="vatExemption.legalBasis"]').value,confirmed:exemption.querySelector('[data-line-field="vatExemption.confirmed"]').checked}):undefined;
    return { ...(vatExemption?{vatExemption}:{}), articleNumber:get('articleNumber'),description:get('description'),kind,quantity:Number(quantityText),unit:get('unit'),unitCents:toCents(get('unitCents')),discountBps:parsePercent(get('discountBps'),'Radrabatten'),vatRate:Number(get('vatRate')),unitPriceIncludesVat:pricesIncludeVat,rotEligible:kind==='labor' && row.querySelector('[data-line-field="rotEligible"]')?.checked===true };
  });
  assert(lines.length>0,'Lägg till minst en fakturarad.');
  for(const [type,name,rateName,label] of [['freight','freightCents','freightVatRate','Frakt'],['invoice-fee','invoiceFeeCents','invoiceFeeVatRate','Fakturaavgift']]) {
    const amount=toCents(value(name)||'0');
    const code=value(type+'.vatExemption.code');
    const vatExemption=amount&&Number(value(rateName))===0&&value('vatMode')==='standard'&&code?normalizeVatExemption({code,legalBasis:value(type+'.vatExemption.legalBasis'),confirmed:checked(type+'.vatExemption.confirmed')}):undefined;
    if(amount)lines.push({...(vatExemption?{vatExemption}:{}),articleNumber:'',description:label,kind:'other',quantity:1,unit:'st',unitCents:amount,discountBps:0,vatRate:Number(value(rateName)),unitPriceIncludesVat:pricesIncludeVat,rotEligible:false,chargeType:type});
  }
  const paymentTermsDays=Number(value('paymentTermsDays'));
  assert(Number.isInteger(paymentTermsDays)&&paymentTermsDays>=0&&paymentTermsDays<=365,'Betalningsvillkor ska vara 0–365 dagar.');
  const customer=Object.fromEntries(['name','orgNumber','vatNumber','address','address2','postalCode','city','phone','email','reminderEmail'].map(key=>[key,value('customer.'+key)]));
  customer.country='SE';
  const delivery=Object.fromEntries(['name','address','address2','postalCode','city','date','method','terms'].map(key=>[key,value('delivery.'+key)]));
  delivery.country='SE';
  return {
    id:value('id'),customerId:value('customerId'),projectId:value('projectId')||null,date:value('date'),dueDate:value('dueDate'),vatMode:value('vatMode'),buyerConstructionConfirmed:checked('buyerConstructionConfirmed'),
    invoiceDiscountBps:parsePercent(value('invoiceDiscountBps'),'Fakturarabatten'),lines,
    details:{paymentTermsDays,ourReference:value('ourReference'),customerReference:value('customerReference'),customerOrderNumber:value('customerOrderNumber'),costCenter:value('costCenter'),invoiceText:value('invoiceText'),priceListName:value('priceListName'),pricesIncludeVat,language:'sv',customer,delivery,performance:{mode:value('performance.mode')||'invoice-date',date:value('performance.date'),from:value('performance.from'),to:value('performance.to'),confirmed:checked('performance.confirmed')}},
    rot:checked('rotEnabled')?{paymentYear:Number(value('paymentYear')),property:value('property'),personId:value('personId'),eligibleConfirmed:checked('eligibleConfirmed'),availableCents:toCents(value('availableCents'))}:null,
  };
}

export function renderInvoiceSummary(draft) {
  try {
    const totals=getInvoiceTotals(draft);
    const beforeDiscount=sum(draft.lines.map(line=>calculateLineAmounts({...line,discountBps:0},draft.vatMode,0).grossCents));
    const discount=beforeDiscount-totals.grossCents;
    const charges=draft.lines.filter(line=>line.chargeType);
    return `<h3>Summering</h3>${discount>0?pair('Rabatter inkl. moms',money(discount)):''}${pair('Summa exkl. moms',money(totals.netCents))}${pair('Moms',money(totals.vatCents))}${charges.length?`<p class="invoice-summary-note">Frakt och fakturaavgift ingår i summeringen med vald moms.</p>`:''}${pair('Fakturabelopp',money(totals.grossCents))}${draft.rot?pair('Planerat ROT-avdrag',money(totals.rotCents))+pair('Kundens ursprungliga del',money(totals.customerCents)):''}<div class="invoice-summary-total"><span>${draft.rot?'Kundens del':'Totalt inklusive moms'}</span><strong>${e(money(totals.customerCents))}</strong><small>SEK${draft.rot?' · före betalningar':''}</small></div>`;
  } catch(error) {
    return `<h3>Summering</h3><p class="invoice-calculation-note">Fyll i fakturarader och villkor för att se summeringen.</p><p class="invoice-calculation-error">${e(error.message)}</p>`;
  }
}

// Call these helpers from the host's delegated change handler. They update the
// existing form in place, preserving text selection and partially filled rows.
export function applyInvoiceCustomer(form,state,id) {
  const customer=state.customers.find(item=>item.id===id);
  if(!customer)return;
  const fields={name:customer.name,orgNumber:customer.orgNumber||'',vatNumber:customer.vatNumber||'',address:customer.address||'',address2:customer.address2||'',postalCode:customer.postalCode||'',city:customer.city||'',phone:customer.phone||'',email:customer.email||'',reminderEmail:customer.reminderEmail||customer.email||''};
  for(const [key,value] of Object.entries(fields))if(form.elements.namedItem('customer.'+key))form.elements.namedItem('customer.'+key).value=value;
  const project=form.elements.namedItem('projectId');
  if(project){project.innerHTML=option('','Utan projekt',true)+state.projects.filter(item=>item.customerId===id).map(item=>option(item.id,item.name,false)).join('');}
}

export function applyInvoicePaymentTerms(form) {
  const days=Number(form.elements.namedItem('paymentTermsDays')?.value);
  const date=form.elements.namedItem('date')?.value;
  if(Number.isInteger(days)&&days>=0&&days<=365&&date)form.elements.namedItem('dueDate').value=dueAfter(date,days);
}

export function updateInvoiceLineKind(row,rotEnabled=true) {
  const kind=row.querySelector('[data-line-field="kind"]')?.value;
  const checkbox=row.querySelector('[data-line-field="rotEligible"]');
  if(checkbox){checkbox.disabled=kind!=='labor'||!rotEnabled;if(kind!=='labor')checkbox.checked=false;}
}

export function applyInvoicePriceMode(form,includesVat) {
  const prior=form.dataset.pricesIncludeVat==='true';
  if(prior===includesVat)return;
  const targets=[...form.querySelectorAll('[data-invoice-line]')].map(row=>({input:row.querySelector('[data-line-field="unitCents"]'),rate:Number(row.querySelector('[data-line-field="vatRate"]').value),row}));
  targets.push({input:form.elements.namedItem('freightCents'),rate:Number(form.elements.namedItem('freightVatRate').value)},{input:form.elements.namedItem('invoiceFeeCents'),rate:Number(form.elements.namedItem('invoiceFeeVatRate').value)});
  const reverse=form.elements.namedItem('vatMode')?.value==='reverse-construction';
  try {
    const updates=targets.filter(target=>target.input&&target.input.value.trim()).map(target=>{
      const cents=toCents(target.input.value), rate=reverse?0:target.rate;
      const amount=includesVat?Math.round(cents*(100+rate)/100):Math.round(cents*100/(100+rate));
      return {...target,amount};
    });
    updates.forEach(({input,amount})=>{input.value=numberInput(amount);});
    targets.forEach(({row})=>{if(row)row.dataset.priceIncludesVat=String(includesVat);});
    form.dataset.pricesIncludeVat=String(includesVat);
    form.querySelectorAll('.invoice-unit-label').forEach(label=>{label.textContent=includesVat?'À-pris inkl. moms':'À-pris exkl. moms';});
    form.querySelectorAll('.invoice-price > span').forEach(label=>{label.textContent=includesVat?'À-pris inkl. moms':'À-pris exkl. moms';});
    ['freightCents','invoiceFeeCents'].forEach(name=>{const label=form.elements.namedItem(name)?.closest('label');const small=label?.querySelector('small');if(small)small.textContent=includesVat?'Inklusive moms':'Exklusive moms';});
  } catch(error) {
    const checkbox=form.elements.namedItem('pricesIncludeVat');if(checkbox)checkbox.checked=prior;
    throw error;
  }
}

function table(headers,rows,className='') {
  return `<div class="table-scroll ${e(className)}"><table><thead><tr>${headers.map(header=>`<th>${e(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
const cells=values=>values.map(value=>`<td>${value}</td>`).join('');
function invoiceRecipient(state,invoice) {
  const master=state.customers.find(customer=>customer.id===invoice.customerId)||{};
  return invoice.details?.customer||{name:master.name||'Okänd kund',address:master.address||'',email:master.email||''};
}
function addressBlock(person={}, {includeName=true}={}) {
  const locality=[person.postalCode,person.city].filter(Boolean).join(' ');
  return `<div class="invoice-address">${includeName?`<strong>${e(person.name||'—')}</strong>`:''}${[person.address,person.address2,locality].filter(Boolean).map(value=>`<span>${e(value)}</span>`).join('')}${person.orgNumber?`<span>${e(person.orgNumber)}</span>`:''}${person.vatNumber?`<span>Momsreg.nr ${e(person.vatNumber)}</span>`:''}${person.legalForm==='AB'&&person.registeredOffice?`<span>Styrelsens säte: ${e(person.registeredOffice)}</span>`:''}${person.legalForm==='AB'&&person.inLiquidation===true?'<strong>Under likvidation</strong>':''}${person.country?`<span>${e(person.country==='SE'?'Sverige':person.country)}</span>`:''}${person.email?`<span>${e(person.email)}</span>`:''}${person.phone?`<span>${e(person.phone)}</span>`:''}</div>`;
}

export function renderInvoiceList(state,search='') {
  const find=search.trim().toLocaleLowerCase('sv');
  const invoices=state.invoices.filter(invoice=>!find||[invoice.number,invoiceRecipient(state,invoice).name,invoice.details?.customerOrderNumber,invoice.details?.ourReference].join(' ').toLocaleLowerCase('sv').includes(find));
  const outstanding=sum(state.invoices.filter(invoice=>invoice.status==='issued').map(getInvoiceOutstanding));
  const metrics=[['Kvar att få betalt',money(outstanding),'Kund och planerade ROT-utbetalningar'],['Fakturautkast',String(state.invoices.filter(invoice=>invoice.status==='draft').length),'Fortsätt arbeta och granska'],['ROT-ärenden',String(state.rotClaims.length),'Förberedda demobegäranden']];
  return `<div class="invoice-workspace invoice-list-page"><header class="invoice-page-heading"><div><span class="eyebrow">FÖRSÄLJNING</span><h1>Kundfakturor</h1><p>Öppna en faktura för att arbeta på dess egen sida.</p></div><div class="actions">${button('Ny kund','new-customer')}${button('Ny kundfaktura','new-invoice','','primary')}</div></header><div class="metrics compact">${metrics.map(([label,value,detail])=>`<article class="metric"><span class="metric-label">${e(label)}</span><strong>${e(value)}</strong><span>${e(detail)}</span></article>`).join('')}</div><section class="panel invoice-list-panel"><div class="panel-heading"><div><h2>Alla kundfakturor</h2><p>${invoices.length} fakturor${search?' matchar sökningen':''}</p></div><span class="quiet-pill">SEK</span></div>${invoices.length?table(['Faktura','Kund','Fakturadatum','Förfallodag','Totalt','Kvar','Status',''],invoices.map(invoice=>`<tr data-invoice-row="${e(invoice.id)}">${cells([`<a class="invoice-number-link" href="#sales/${encodeURIComponent(invoice.id)}" data-select-invoice="${e(invoice.id)}">${e(invoice.number||'Utkast')}</a>`,`<strong>${e(invoiceRecipient(state,invoice).name)}</strong>${invoice.details?.customerOrderNumber?`<small>Order ${e(invoice.details.customerOrderNumber)}</small>`:''}`,e(invoice.date),e(invoice.dueDate),e(money(getInvoiceTotals(invoice).grossCents)),e(money(getInvoiceOutstanding(invoice))),badge(invoice.status),`<a href="#sales/${encodeURIComponent(invoice.id)}" aria-label="Öppna ${e(invoice.number||'fakturautkast')}">${icon('arrow')}</a>`])}</tr>`)):`<div class="empty"><p>${search?'Ingen faktura matchar sökningen.':'Skapa din första kundfaktura.'}</p></div>`}</section></div>`;
}

function printedNetUnitPrice(line) {
  // Keep price-display precision separate from the invoice's cent rounding.
  // Inclusive prices can produce repeating fractional ore before discounts.
  const numerator=BigInt(line.unitCents)*1000000n, divisor=BigInt(100+line.vatRate);
  const micros=(numerator+divisor/2n)/divisor;
  const decimals=String(micros%1000000n).padStart(6,'0').replace(/0+$/,'').padEnd(2,'0');
  return `${numerator%divisor?'≈ ':''}${Number(micros/1000000n).toLocaleString('sv-SE')},${decimals} kr`;
}

function exemptionDisplay(value, draft) {
  if (!draft) return vatExemptionInvoiceText(value);
  try { return vatExemptionInvoiceText(value); } catch { return 'Momsundantag: uppgifterna behöver kompletteras och granskas.'; }
}

function lineTable(invoice,{print=false}={}) {
  const derivedNetPrice=print&&invoice.vatMode==='standard'&&invoice.details?.pricesIncludeVat;
  const lines=invoice.lines.map(line=>{
    const amount=calculateLineAmounts(line,invoice.vatMode,invoice.invoiceDiscountBps||0);
    return `<tr>${cells([e(line.articleNumber||'—'),`<strong>${e(line.description)}</strong>${line.vatExemption?`<small>${e(exemptionDisplay(line.vatExemption,invoice.status==='draft'))}</small>`:''}${!print?`<small>${e(kindNames[line.kind])}${line.kind==='labor'&&line.rotEligible!==false&&invoice.rot?' · ROT':''}</small>`:''}`,e(inputNumber(line.quantity)),e(line.unit||(line.kind==='labor'?'tim':'st')),e(derivedNetPrice?printedNetUnitPrice(line):money(line.unitCents)),e(bpsInput(line.discountBps||0)+' %'),invoice.vatMode==='reverse-construction'?'0 %':e(line.vatRate+' %'),e(money(amount.netCents))])}</tr>`;
  });
  return table(['Artikelnr','Beskrivning','Antal','Enhet','À-pris'+(!print&&invoice.details?.pricesIncludeVat?' inkl. moms':' exkl. moms'),'Rabatt','Moms','Netto'],lines,'invoice-detail-lines')+(derivedNetPrice?'<p>À-priser exkl. moms är beräknade från inmatade priser inkl. moms före rabatter. ≈ anger avrundning till sex decimaler.</p>':'');
}

function rotOverview(state,invoice) {
  if(!invoice.rot)return '';
  const plan=(state.rotPlans||[]).find(item=>item.invoiceId===invoice.id);
  if(plan)return `<section class="invoice-section invoice-rot-overview"><header><h2>ROT · ${plan.participants.length} personer · betalningsår ${e(plan.paymentYear)}</h2><a class="button secondary" href="#tax-v2">Öppna ROT-arbetsytan</a></header><div class="invoice-section-body">${plan.participants.map(person=>pair(person.name,money(person.allocationCents))).join('')}${pair('Återbetalat till Skatteverket',money(invoice.rotRepaymentCents||0))}<p class="invoice-help">Delbegäranden, beslut och utbetalningar följs i ROT-arbetsytan. Originalfakturans uppgifter bevaras.</p></div></section>`;
  const claim=state.rotClaims.find(item=>item.invoiceId===invoice.id), payments=invoice.payments||[];
  return `<section class="invoice-section invoice-rot-overview"><header><h2>ROT · en person · betalningsår ${e(invoice.rot.paymentYear)}</h2>${claim?badge(claim.status):''}</header><div class="invoice-section-body"><div class="invoice-grid invoice-grid-two"><div>${pair('Fastighet / bostad',invoice.rot.property)}${pair('Person-ID i demon',invoice.rot.personId)}${pair('Kunden har betalat',money(sum(payments.filter(payment=>payment.payer==='customer').map(payment=>payment.amountCents))))}${pair('Skatteverket har betalat (demo)',money(sum(payments.filter(payment=>payment.payer==='tax').map(payment=>payment.amountCents))))}</div><div>${claim?pair('Begärt belopp',money(claim.requestedCents))+(claim.approvedCents!==undefined?pair('Beviljat i demobeslut',money(claim.approvedCents)):'')+pair('Begärandedatum',claim.date)+(claim.decisionDate?pair('Beslutsdatum',claim.decisionDate):''):'<p class="invoice-help">Begäran förbereds efter kundens betalning och kontroll av utfört arbete. Material och övriga rader ingår inte i ROT-underlaget.</p>'}<div class="actions wrap">${invoice.status==='issued'&&!claim?button('Förbered ROT-begäran','request-rot',invoice.id):''}${claim?.status==='prepared'?button('Registrera demobeslut','decide-rot',invoice.id):''}</div></div></div></div></section>`;
}

export function renderInvoiceDetail(state,invoice) {
  if(!invoice)return `<section class="panel invoice-not-found"><h1>Fakturan finns inte</h1><p>Den kan ha ersatts när demouppgifterna återställdes.</p><a class="button secondary" href="#sales">Till fakturalistan</a></section>`;
  const recipient=invoiceRecipient(state,invoice), details=invoice.details||{}, payments=invoice.payments||[], total=getInvoiceTotals(invoice);
  const readiness=invoice.status==='draft'?getInvoiceIssuanceIssues({seller:state.company,customer:recipient,date:invoice.date,performance:details.performance,vatMode:invoice.vatMode,sellerVatRequired:invoiceSellerVatRequired(invoice.lines,invoice.vatMode)}):[];
  if (invoice.status==='draft') {
    for (const line of invoice.lines) if (invoice.vatMode==='standard' && line.vatRate===0) { try { normalizeVatExemption(line.vatExemption,{required:true}); } catch(error) { readiness.push(`${line.description}: ${error.message}`); } }
    if (details.performance?.mode==='advance-payment') readiness.push('Mottagna förskott kräver separat förskottsflöde.');
    const end=details.performance?.mode==='period'?details.performance.to:details.performance?.mode==='date'?details.performance.date:invoice.date;
    if (end>invoice.date) readiness.push('Fakturering före leverans eller utförande kräver separat kontrollerat flöde.');
  }
  const title=(invoice.kind==='credit'?'Kreditfaktura ':invoice.number?'Kundfaktura ':'Fakturautkast ')+(invoice.number||'');
  const actions=`${button('Kopiera till ny','copy-invoice',invoice.id)}${button('Skriv ut / spara PDF','print-invoice',invoice.id)}${invoice.status==='issued'&&invoice.kind==='invoice'&&!invoice.rot?'<a class="button secondary" href="#settlements">Krediter &amp; återbetalningar</a>':''}${invoice.status==='draft'?button('Redigera','edit-invoice',invoice.id)+button('Granska & utfärda','issue-invoice',invoice.id,'primary',readiness.length?'disabled':''):invoice.status==='issued'&&invoice.kind==='invoice'&&getInvoiceOutstanding(invoice)>0?button('Registrera betalning','invoice-payment',invoice.id,'primary'):''}`;
  const invoiceEntries=state.entries.filter(entry=>entry.id===invoice.entryId||payments.some(payment=>payment.entryId===entry.id));
  const events=state.activity.filter(event=>event.entityId===invoice.id||invoiceEntries.some(entry=>entry.id===event.entityId)).slice(-12).reverse();
  const eventTime=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Stockholm',dateStyle:'short',timeStyle:'short'}).format(date):'';};
  return `<div class="invoice-workspace invoice-detail-page"><div class="invoice-breadcrumb"><a href="#sales" data-action="invoice-back">${icon('arrow')}Kundfakturor</a><span>/</span><span>${e(invoice.number||'Utkast')}</span></div><header class="invoice-page-heading"><div><span class="eyebrow">FÖRSÄLJNING · FAKTURERING</span><h1>${e(title)}</h1><p>${e(recipient.name)}${invoice.vatMode==='reverse-construction'?' · Omvänd byggmoms':''}</p></div><div class="actions">${badge(invoice.status)}${actions}</div></header>
    ${readiness.length?`<section class="invoice-section" aria-label="Fakturans kompletteringar"><header><h2>Komplettera före utfärdande</h2></header><div class="invoice-section-body"><ul>${readiness.map(issue=>`<li>${e(issue)}</li>`).join('')}</ul><div class="actions">${button('Redigera fakturan','edit-invoice',invoice.id)}${button('Ändra företagsuppgifter','edit-company')}</div><p class="invoice-help">Utkastet är sparat. Inget bokförs innan uppgifterna är kompletta och du bekräftar utfärdandet.</p></div></section>`:''}
    <div class="invoice-detail-layout"><div class="invoice-detail-document"><section class="invoice-section"><header><h2>Fakturauppgifter</h2><span class="invoice-currency">SEK</span></header><div class="invoice-section-body invoice-grid invoice-grid-three"><div><h3>Fakturamottagare</h3>${addressBlock(recipient)}</div><div>${pair('Fakturadatum',invoice.date)}${details.performance?pair('Leverans / utförande',invoicePerformanceText(details.performance,invoice.date)):''}${pair('Förfallodag',invoice.dueDate)}${pair('Betalningsvillkor',details.paymentTermsDays===undefined?'Se förfallodag':details.paymentTermsDays+' dagar')}${pair('Projekt',state.projects.find(project=>project.id===invoice.projectId)?.name||'—')}</div><div>${pair('Vår referens',details.ourReference)}${pair('Er referens',details.customerReference)}${pair('Ert ordernummer',details.customerOrderNumber)}${pair('Kostnadsställe / märkning',details.costCenter)}</div></div></section>
    ${hasDelivery(details.delivery)?`<section class="invoice-section"><header><h2>Leveransuppgifter</h2></header><div class="invoice-section-body invoice-grid invoice-grid-three">${addressBlock(details.delivery)}<div>${pair('Leveransdatum',details.delivery.date)}${pair('Leveranssätt',details.delivery.method)}</div><div>${pair('Leveransvillkor',details.delivery.terms)}</div></div></section>`:''}
    <section class="invoice-section"><header><h2>Fakturarader</h2><span>${invoice.lines.length} rader</span></header>${lineTable(invoice)}${invoice.invoiceDiscountBps?`<p class="invoice-help invoice-padded">Fakturarabatt ${e(bpsInput(invoice.invoiceDiscountBps))} % är avdragen från vanliga rader. Frakt och fakturaavgift undantas.</p>`:''}${details.invoiceText?`<div class="invoice-print-message"><h3>Fakturatext</h3><p>${e(details.invoiceText)}</p></div>`:''}</section>
    ${rotOverview(state,invoice)}
    <section class="invoice-section"><header><h2>Betalningar och historik</h2><div class="actions">${invoice.status==='issued'&&invoice.kind==='invoice'&&getInvoiceOutstanding(invoice)>0?button('Notera påminnelse','remind-invoice',invoice.id):''}${invoice.status==='issued'&&invoice.kind==='invoice'&&!payments.length&&!invoice.settlementCreditCents&&!invoice.settlementOffsetInCents&&!invoice.settlementOffsetOutCents&&!state.rotPlans?.some(plan=>plan.invoiceId===invoice.id)&&!state.revenueSchedules?.some(plan=>plan.invoiceId===invoice.id)?button('Kreditera hela fakturan','credit-invoice',invoice.id,'danger'):''}</div></header><div class="invoice-section-body">${payments.length?table(['Datum','Från','Referens','Belopp'],payments.map(payment=>`<tr>${cells([e(payment.date),payment.payer==='tax'?'Skatteverket (demo)':'Kund',e(payment.reference||'—'),e(money(payment.amountCents))])}</tr>`)):'<p class="invoice-help">Inga betalningar registrerade på fakturan.</p>'}${invoice.reminders?.length?`<p class="invoice-help">${invoice.reminders.length} påminnelse(r) noterade. Inga meddelanden har skickats.</p>`:''}${invoiceEntries.length?`<div class="invoice-entry-links">${invoiceEntries.map(entry=>button('Visa '+entry.number+' · '+entry.description,'show-entry',entry.id)).join('')}</div>`:''}${events.length?`<h3 class="invoice-history-title">Fakturans händelser</h3><ol class="invoice-event-list">${events.map(event=>`<li><span>${e(event.label)}</span><small>${e(eventTime(event.date||event.createdAt))} · ${e(event.actor||'Åke')}</small></li>`).join('')}</ol>`:''}${invoice.creditId?`<a href="#sales/${encodeURIComponent(invoice.creditId)}">Öppna länkad kreditfaktura ↗</a>`:''}${invoice.originalInvoiceId?`<a href="#sales/${encodeURIComponent(invoice.originalInvoiceId)}">Öppna originalfakturan ↗</a>`:''}</div></section>
    </div><aside class="invoice-summary-sidebar"><section class="invoice-summary-card">${renderInvoiceSummary(invoice)}${pair('Kvar totalt',money(getInvoiceOutstanding(invoice)))}${invoice.status!=='draft'?`<p class="invoice-help">${invoice.kind==='credit'?'Krediten länkar till sin originalfaktura.':'Fakturans uppgifter är låsta efter utfärdande. En rättelse görs med kreditfaktura.'}</p>`:'<p class="invoice-help">Det här är ett utkast. Granska uppgifterna innan du utfärdar och bokför fakturan.</p>'}</section><section class="invoice-support-card"><strong>Fråga Ande om fakturan</strong><p>Öppna Ande i sidhuvudet för att gå igenom exempelvis ROT, moms eller nästa steg.</p>${invoice.entryId?button('Visa verifikation','show-entry',invoice.entryId):''}</section></aside></div></div>`;
}

export function invoiceDocumentHTML(state,invoice) {
  const recipient=invoiceRecipient(state,invoice), details=invoice.details||{}, seller=details.seller||state.company, total=getInvoiceTotals(invoice);
  const type=invoice.kind==='credit'?'KREDITFAKTURA':invoice.status==='draft'?'FAKTURAUTKAST':'FAKTURA';
  const original=invoice.kind==='credit'?state.invoices.find(item=>item.id===invoice.originalInvoiceId):null;
  const correction=invoice.kind==='credit'?`<section class="invoice-print-correction">${pair('Avser faktura',original?.number||invoice.originalInvoiceId||'Originalreferens saknas')}${original?.date?pair('Originalfakturans datum',original.date):''}${pair('Krediteringsorsak',invoice.reason)}</section>`:'';
  return `<article class="print-invoice invoice-print-document"><div class="print-top"><div><h1>${e(seller.name)}</h1>${addressBlock(seller,{includeName:false})}</div><div><h1>${type}</h1><p>${e(invoice.number||'Utkast')}</p><p>SEK</p></div></div>${correction}<hr><div class="print-top"><div><h3>Fakturamottagare</h3>${addressBlock(recipient)}</div><div>${pair('Fakturadatum',invoice.date)}${details.performance?pair('Leverans / utförande',invoicePerformanceText(details.performance,invoice.date)):''}${pair('Förfallodag',invoice.dueDate)}${pair('Betalningsvillkor',details.paymentTermsDays===undefined?'Se förfallodag':details.paymentTermsDays+' dagar')}${pair('Projekt',state.projects.find(project=>project.id===invoice.projectId)?.name||'—')}</div></div><div class="invoice-print-references">${details.ourReference?pair('Vår referens',details.ourReference):''}${details.customerReference?pair('Er referens',details.customerReference):''}${details.customerOrderNumber?pair('Ert ordernummer',details.customerOrderNumber):''}${details.costCenter?pair('Kostnadsställe / märkning',details.costCenter):''}</div>${hasDelivery(details.delivery)?`<section class="invoice-print-delivery"><h3>Leverans</h3>${addressBlock(details.delivery)}${details.delivery.date?pair('Leveransdatum',details.delivery.date):''}${details.delivery.method?pair('Leveranssätt',details.delivery.method):''}${details.delivery.terms?pair('Leveransvillkor',details.delivery.terms):''}</section>`:''}${lineTable(invoice,{print:true})}${invoice.invoiceDiscountBps?`<p>Fakturarabatt: ${e(bpsInput(invoice.invoiceDiscountBps))} % på vanliga rader.</p>`:''}${details.invoiceText?`<p class="invoice-print-message">${e(details.invoiceText)}</p>`:''}<div class="print-totals">${pair('Summa exkl. moms',money(total.netCents))}${pair('Moms',money(total.vatCents))}${pair(invoice.kind==='credit'?'Kreditbelopp inkl. moms':'Fakturabelopp',money(total.grossCents))}${invoice.rot?pair('Planerat ROT-avdrag',money(total.rotCents))+pair('Kundens ursprungliga del',money(total.customerCents)):''}${pair('Kvar totalt',money(getInvoiceOutstanding(invoice)))}</div>${invoice.vatMode==='reverse-construction'?'<p>Omvänd betalningsskyldighet för moms. Köparens förutsättningar ska vara granskade.</p>':''}${invoice.rot?`<p>ROT-underlag: ${e(invoice.rot.property)} · ${e(invoice.rot.personId)}. Endast markerade arbetsrader ingår. Avdraget är preliminärt och kräver bedömning av villkor och årsutrymme.</p>`:''}<p class="print-demo">DEMONSTRATION · Fiktiva uppgifter. Ingen betalningsbegäran eller faktura har skickats.</p></article>`;
}
