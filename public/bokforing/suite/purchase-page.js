// Full-page supplier-invoice workspaces. File bytes are kept by documents.js;
// these views only read invoice data and escaped document metadata.
import { ACCOUNTS, assert, cents, money, toCents } from './core.js';
import { calculatePurchaseLines } from './purchase-lines.js';
import { getBillOutstanding, getBillBookingRows, getBillAttachments } from './operations.js';
import { escapeHtml as e, icon, numberInput } from './views.js';

const TODAY = '2026-10-23';
const expenseAccounts = ['4010', '5010', '5410', '5460', '6110', '6540', '6570', '6991'];
const statusName = { draft: 'Utkast', booked: 'Bokförd', credited: 'Krediterad' };
const accountName = account => ACCOUNTS.find(item => item.number === account)?.name || account;
const button = (label, action, id = '', kind = 'secondary', extra = '') => `<button type="button" class="button ${kind}" data-action="${e(action)}" data-id="${e(id)}" ${extra}>${e(label)}</button>`;
const badge = (label, kind = '') => `<span class="badge ${e(kind)}">${e(label)}</span>`;
const pair = (label, value) => `<div class="label-value"><span>${e(label)}</span><strong>${e(value || '—')}</strong></div>`;
const option = (value, label, selected) => `<option value="${e(value)}" ${selected ? 'selected' : ''}>${e(label)}</option>`;
const field = (label, name, value = '', { type = 'text', extra = '', className = '', help = '' } = {}) => `<label class="${e(className)}"><span>${e(label)}</span><input type="${e(type)}" name="${e(name)}" value="${e(value)}" ${extra}>${help ? `<small>${e(help)}</small>` : ''}</label>`;
const select = (label, name, choices, selected, extra = '') => `<label><span>${e(label)}</span><select name="${e(name)}" ${extra}>${choices.map(([value, label]) => option(value, label, String(value) === String(selected))).join('')}</select></label>`;
const checkbox = (label, name, checked = false, extra = '') => `<label class="checkbox"><input type="checkbox" name="${e(name)}" ${checked ? 'checked' : ''} ${extra}><span>${e(label)}</span></label>`;
const card = (title, description, body, extra = '') => `<section class="purchase-card" ${extra}><header><div><h2>${e(title)}</h2>${description ? `<p>${e(description)}</p>` : ''}</div></header><div class="purchase-card-body">${body}</div></section>`;
const projectName = (state, id) => state.projects.find(project => project.id === id)?.name || '—';
const dueAfter = date => { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + 30); return value.toISOString().slice(0, 10); };
const sizeLabel = size => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} kB` : `${(size / (1024 * 1024)).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} MB`;
const timeLabel = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Stockholm' }).format(date) : '';
};
const mimeLabel = type => type === 'application/pdf' ? 'PDF' : type === 'image/jpeg' ? 'JPEG' : type === 'image/png' ? 'PNG' : type === 'image/webp' ? 'WebP' : 'Fil';
const detailsDefaults = () => ({ paymentReference: '', bankgiro: '', plusgiro: '', iban: '', ourReference: '', supplierReference: '', costCenter: '', description: '', supplier: { orgNumber: '', address: '', postalCode: '', city: '', country: 'SE', email: '', phone: '' } });
const detailsFor = bill => ({ ...detailsDefaults(), ...bill?.details, supplier: { ...detailsDefaults().supplier, ...bill?.details?.supplier } });
const attachmentsFor = bill => bill ? getBillAttachments(bill) : [];

export function defaultPurchaseDate(state, date = TODAY) {
  return date < state.company.fiscalYearStart ? state.company.fiscalYearStart
    : date > state.company.fiscalYearEnd ? state.company.fiscalYearEnd : date;
}

export function createPurchaseEditorDraft(state, bill = null, options = {}) {
  const date = bill?.date || defaultPurchaseDate(state, options.date || TODAY);
  const lines = bill?.lines ? structuredClone(bill.lines) : [{ description: '', netCents: bill?.netCents || 0,
    vatRate: bill?.vatRate ?? 25, vatMode: bill?.vatMode || 'standard', account: bill?.account || '4010',
    deductibleBps: 10000, reverseConfirmed: bill?.reverseConfirmed === true }];
  let totals = { netCents: 0, vatCents: 0, totalCents: 0, vatMode: 'mixed', vatRate: 0, account: 'mixed', reverseConfirmed: false };
  if (lines.every(line => line.netCents > 0)) totals = calculatePurchaseLines(lines);
  return {
    id: bill?.id || '', supplier: bill?.supplier || '', number: bill?.number || '',
    date, dueDate: bill?.dueDate || options.dueDate || dueAfter(date), ...totals, lines,
    projectId: bill?.projectId || null, status: 'draft', payments: [], details: detailsFor(bill),
    attachments: structuredClone(options.attachments || attachmentsFor(bill)),
  };
}

const lineName = (index, key) => index === 0 ? key : `line-${index}-${key}`;
function renderPurchaseLine(line, index, state) {
  const name = key => lineName(index, key), attr = key => `data-purchase-field="${key}"`;
  return `<article class="purchase-line" data-purchase-line="${index}"><header><h3>Konteringsrad <span data-line-number>${index + 1}</span></h3>${button('Ta bort rad', 'purchase-remove-line', String(index), 'secondary', 'aria-label="Ta bort konteringsrad"')}</header>
    <div class="purchase-grid purchase-grid-two">
      ${field('Beskrivning', name('lineDescription'), line.description || '', { extra: `${attr('lineDescription')} maxlength="300"`, className: 'purchase-span-two' })}
      ${field('Belopp exklusive moms', name('netCents'), numberInput(line.netCents || 0), { extra: `${attr('netCents')} required inputmode="decimal"` })}
      ${select('Momstyp', name('vatMode'), [['standard', 'Vanlig svensk moms'], ['no-vat', 'Ingen moms'], ['reverse-construction', 'Omvänd byggmoms']], line.vatMode, attr('vatMode'))}
      ${select('Momssats', name('vatRate'), [25, 12, 6, 0].map(rate => [rate, `${rate} %`]), line.vatRate, attr('vatRate'))}
      ${select('Kostnadskonto', name('account'), line.vatMode === 'reverse-construction' ? [['4425', `4425 · ${accountName('4425')}`]] : expenseAccounts.map(account => [account, `${account} · ${accountName(account)}`]), line.account, attr('account'))}
      ${field('Avdragsgill andel av moms (%)', name('deductiblePercent'), numberInput(line.deductibleBps ?? 10000), { extra: `${attr('deductiblePercent')} inputmode="decimal"`, help: 'Ange den granskade avdragsrätten. Ej avdragsgill moms förs till kostnaden.' })}
      ${select('Projekt på raden', name('lineProjectId'), [['', 'Ingen särskild radkoppling'], ...state.projects.map(project => [project.id, project.name])], line.projectId || '', attr('lineProjectId'))}
    </div><div data-purchase-reverse ${line.vatMode === 'reverse-construction' ? '' : 'hidden'}>${checkbox('Förutsättningarna för omvänd byggmoms har granskats', name('reverseConfirmed'), line.reverseConfirmed, attr('reverseConfirmed'))}</div></article>`;
}

export function changePurchaseLines(form, action, index, state) {
  const list = form.querySelector('[data-purchase-lines]');
  assert(list, 'Konteringsraderna saknas.');
  if (action === 'purchase-add-line') {
    assert(list.children.length < 100, 'Högst 100 konteringsrader kan användas.');
    list.insertAdjacentHTML('beforeend', renderPurchaseLine({ netCents: 0, vatMode: 'standard', vatRate: 25, account: '4010', deductibleBps: 10000 }, list.children.length, state));
  } else {
    assert(list.children.length > 1, 'Behåll minst en konteringsrad.');
    const line = list.querySelector(`[data-purchase-line="${Number(index)}"]`);
    assert(line, 'Konteringsraden finns inte.'); line.remove();
  }
  [...list.children].forEach((line, idx) => {
    line.dataset.purchaseLine = String(idx);
    line.querySelector('[data-line-number]').textContent = String(idx + 1);
    line.querySelector('[data-action="purchase-remove-line"]').dataset.id = String(idx);
    line.querySelectorAll('[data-purchase-field]').forEach(field => { field.name = lineName(idx, field.dataset.purchaseField); });
  });
  applyPurchaseVatMode(form);
}

function tabs(active) {
  return `<nav class="purchase-tabs" aria-label="Inköpsvyer"><a href="#purchases" ${active === 'bills' ? 'aria-current="page"' : ''}>Leverantörsfakturor</a><a href="#purchases/inbox" ${active === 'inbox' ? 'aria-current="page"' : ''}>Inkomna underlag</a></nav>`;
}

function invoiceStatus(bill) {
  if (bill.status === 'booked' && bill.settlementCreditCents > 0) return badge(bill.settlementCreditCents >= bill.totalCents ? 'Krediterad' : 'Delkrediterad', 'credited');
  if (bill.status === 'booked' && getBillOutstanding(bill) === 0) return badge('Betald', 'settled');
  return badge(statusName[bill.status] || bill.status, bill.status);
}

export function renderPurchaseList(state, search = '') {
  const query = search.trim().toLocaleLowerCase('sv');
  const bills = [...state.bills].reverse().filter(bill => `${bill.supplier} ${bill.number} ${bill.details?.paymentReference || ''}`.toLocaleLowerCase('sv').includes(query));
  const outstanding = state.bills.filter(bill => bill.status === 'booked').reduce((sum, bill) => sum + getBillOutstanding(bill), 0);
  return `<div class="purchase-workspace">
    <header class="purchase-page-heading"><div><span class="eyebrow">INKÖP · LEVERANTÖRSRESKONTRA</span><h1>Leverantörsfakturor</h1><p>Från inkommet underlag till granskad faktura och betalning.</p></div><div class="actions">${button('Inkomna underlag', 'purchase-inbox')}${button('Ny leverantörsfaktura', 'new-bill', '', 'primary')}</div></header>
    ${tabs('bills')}
    <div class="metrics compact"><article class="metric"><span class="metric-label">Kvar att betala</span><strong>${e(money(outstanding))}</strong><span>Bokförda leverantörsfakturor</span></article><article class="metric"><span class="metric-label">Utkast</span><strong>${state.bills.filter(bill => bill.status === 'draft').length}</strong><span>Granska uppgifter och underlag</span></article><article class="metric"><span class="metric-label">Med underlag</span><strong>${state.bills.filter(bill => attachmentsFor(bill).length).length}</strong><span>Lokalt kopplade bilder eller PDF</span></article></div>
    <section class="panel purchase-list-panel"><div class="panel-heading"><div><h2>Alla leverantörsfakturor</h2><p>Öppna en faktura för uppgifter, kontering, underlag och historik.</p></div><span>${bills.length} st</span></div>${bills.length ? `<div class="table-scroll"><table><thead><tr><th>Leverantör / faktura</th><th>Fakturadatum</th><th>Förfallodag</th><th>Belopp</th><th>Kvar</th><th>Underlag</th><th>Status</th></tr></thead><tbody>${bills.map(bill => `<tr data-purchase-row="${e(bill.id)}"><td><a class="purchase-number-link" href="#purchases/${encodeURIComponent(bill.id)}" data-select-bill="${e(bill.id)}">${e(bill.supplier)}</a><small>${e(bill.number)}</small></td><td>${e(bill.date)}</td><td>${e(bill.dueDate)}</td><td>${e(money(bill.totalCents))}</td><td>${e(money(getBillOutstanding(bill)))}</td><td>${attachmentsFor(bill).length || '—'}</td><td>${invoiceStatus(bill)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><p>Inga leverantörsfakturor matchar sökningen.</p></div>'}</section>
  </div>`;
}

export function renderPurchaseEditor(state, draft, { isNew = !draft.id, error = '', busy = false, selectedDocumentId = '' } = {}) {
  const details = detailsFor(draft);
  const title = isNew ? 'Ny leverantörsfaktura' : `Redigera ${draft.number || 'leverantörsfaktura'}`;
  return `<div class="purchase-workspace purchase-editor-page">
    <div class="purchase-breadcrumb"><a href="#purchases" data-action="purchase-back">${icon('arrow')}Leverantörsfakturor</a><span>/</span><span>${e(title)}</span></div>
    <header class="purchase-page-heading"><div><span class="eyebrow">INKÖP · REGISTRERA OCH GRANSKA</span><h1>${e(title)}</h1><p>Ha underlaget bredvid fakturauppgifterna när du registrerar och kontrollerar.</p></div><div class="actions">${badge('Utkast', 'draft')}<span id="purchase-editor-status" class="purchase-local-status">Ej sparade ändringar</span></div></header>
    <form id="purchase-page-form" data-form="purchase-page" data-attachments="${e(JSON.stringify(draft.attachments || []))}" novalidate>
      <input type="hidden" name="id" value="${e(draft.id || '')}">
      <div id="purchase-page-error" class="form-error" role="alert" ${error ? '' : 'hidden'}>${e(error)}</div>
      <div class="purchase-editor-layout"><div class="purchase-form-pane">
        ${card('Fakturauppgifter', 'Kontrollera beloppen mot leverantörens underlag.', `<div class="purchase-grid purchase-grid-two">
          ${field('Leverantör', 'supplier', draft.supplier, { extra: 'required maxlength="200" autocomplete="organization"' })}
          ${field('Leverantörens fakturanummer', 'number', draft.number, { extra: 'required maxlength="100"' })}
          ${field('OCR / betalningsreferens', 'details.paymentReference', details.paymentReference, { extra: 'maxlength="100"', className: 'purchase-span-two' })}
          ${field('Fakturadatum', 'date', draft.date, { type: 'date', extra: 'required' })}
          ${field('Förfallodatum', 'dueDate', draft.dueDate, { type: 'date', extra: 'required' })}
          ${field('Valuta', 'currency', 'SEK', { extra: 'readonly aria-readonly="true"' })}
          ${select('Projekt', 'projectId', [['', 'Utan projekt'], ...state.projects.map(project => [project.id, project.name])], draft.projectId || '')}
        </div>`)}
        ${card('Konteringsrader', 'Fördela fakturan på kostnader, momssatser och granskad avdragsrätt.', `<div data-purchase-lines>${draft.lines.map((line, index) => renderPurchaseLine(line, index, state)).join('')}</div><div class="actions">${button('Lägg till konteringsrad', 'purchase-add-line')}</div><p class="purchase-help">Summan av raderna ska motsvara leverantörens fakturabelopp. Avdragsrätten kräver egen bedömning; programmet beräknar den andel du anger.</p>`)}
        <div id="purchase-live-summary" aria-live="polite">${renderPurchaseSummary(draft)}</div>
        ${card('Betalning och referenser', 'Uppgifter från fakturan. Ingen betalning skickas härifrån.', `<div class="purchase-grid purchase-grid-two">
          ${field('Bankgiro', 'details.bankgiro', details.bankgiro, { extra: 'maxlength="50"' })}
          ${field('Plusgiro', 'details.plusgiro', details.plusgiro, { extra: 'maxlength="50"' })}
          ${field('IBAN', 'details.iban', details.iban, { extra: 'maxlength="50"', className: 'purchase-span-two' })}
          ${field('Vår referens', 'details.ourReference', details.ourReference, { extra: 'maxlength="150"' })}
          ${field('Leverantörens referens', 'details.supplierReference', details.supplierReference, { extra: 'maxlength="150"' })}
          ${field('Kostnadsställe / märkning', 'details.costCenter', details.costCenter, { extra: 'maxlength="100"', className: 'purchase-span-two', help: 'Sparad märkning; ingen automatisk redovisningsdimension.' })}
        </div><label><span>Beskrivning / anteckning på fakturan</span><textarea name="details.description" maxlength="4000" rows="3">${e(details.description)}</textarea></label>`)}
        <details class="purchase-card purchase-contact"><summary>Leverantörens kontaktuppgifter</summary><div class="purchase-card-body"><div class="purchase-grid purchase-grid-two">
          ${field('Organisationsnummer', 'details.supplier.orgNumber', details.supplier.orgNumber, { extra: 'maxlength="50"' })}
          ${field('Telefon', 'details.supplier.phone', details.supplier.phone, { type: 'tel', extra: 'maxlength="50"' })}
          ${field('Adress', 'details.supplier.address', details.supplier.address, { extra: 'maxlength="300"', className: 'purchase-span-two' })}
          ${field('Postnummer', 'details.supplier.postalCode', details.supplier.postalCode, { extra: 'maxlength="30"' })}
          ${field('Ort', 'details.supplier.city', details.supplier.city, { extra: 'maxlength="150"' })}
          ${field('E-post', 'details.supplier.email', details.supplier.email, { type: 'email', extra: 'maxlength="254"', className: 'purchase-span-two' })}
        </div></div></details>
      </div><aside class="purchase-document-pane">${renderDocumentPanel(draft.attachments || [], { editable: true, selectedDocumentId })}</aside></div>
      <div class="purchase-save-bar"><div><strong>Spara som utkast</strong><span>Granska och bokför på fakturans egen sida.</span></div><div class="actions">${button('Avbryt', 'purchase-back')}<button type="submit" class="button primary" ${busy ? 'disabled' : ''}>${busy ? 'Sparar…' : 'Spara utkast'}</button></div></div>
    </form>
  </div>`;
}

export function readPurchaseEditor(form) {
  const value = name => String(form.elements.namedItem(name)?.value ?? '').trim();
  const lines = [...form.querySelectorAll('[data-purchase-line]')].map(row => {
    const field = key => row.querySelector(`[data-purchase-field="${key}"]`);
    const read = key => String(field(key)?.value ?? '').trim();
    const vatMode = read('vatMode');
    return { description: read('lineDescription'), netCents: toCents(read('netCents')),
      vatMode, vatRate: vatMode === 'no-vat' ? 0 : vatMode === 'reverse-construction' ? 25 : Number(read('vatRate')),
      account: vatMode === 'reverse-construction' ? '4425' : read('account'),
      deductibleBps: toCents(read('deductiblePercent')), reverseConfirmed: field('reverseConfirmed')?.checked === true,
      ...(read('lineProjectId') ? { projectId: read('lineProjectId') } : {}) };
  });
  const { rows, deductibleVatCents, reverseVatCents, nonDeductibleVatCents, ...amounts } = calculatePurchaseLines(lines);
  let attachments;
  try { attachments = JSON.parse(form.dataset.attachments || '[]'); } catch { throw new Error('De kopplade underlagen kunde inte läsas.'); }
  assert(Array.isArray(attachments), 'De kopplade underlagen har fel format.');
  const details = Object.fromEntries(['paymentReference', 'bankgiro', 'plusgiro', 'iban', 'ourReference', 'supplierReference', 'costCenter', 'description'].map(key => [key, value(`details.${key}`)]));
  details.supplier = Object.fromEntries(['orgNumber', 'address', 'postalCode', 'city', 'email', 'phone'].map(key => [key, value(`details.supplier.${key}`)]));
  details.supplier.country = 'SE';
  return { id: value('id'), supplier: value('supplier'), number: value('number'), date: value('date'), dueDate: value('dueDate'), ...amounts,
    projectId: value('projectId') || null, details, attachments, status: 'draft', payments: [] };
}

export function applyPurchaseVatMode(form) {
  const lineCount = form.querySelectorAll('[data-purchase-line]').length;
  form.querySelectorAll('[data-action="purchase-remove-line"]').forEach(button => { button.disabled = lineCount <= 1; });
  form.querySelectorAll('[data-purchase-line]').forEach(line => {
    const mode = line.querySelector('[data-purchase-field="vatMode"]').value;
    const account = line.querySelector('[data-purchase-field="account"]');
    const rate = line.querySelector('[data-purchase-field="vatRate"]');
    const normalAccount = expenseAccounts.includes(account.value) ? account.value : line.dataset.normalAccount || '4010';
    if (mode === 'reverse-construction') {
      line.dataset.normalAccount = normalAccount;
      account.innerHTML = option('4425', `4425 · ${accountName('4425')}`, true);
      rate.value = '25';
    } else {
      account.innerHTML = expenseAccounts.map(value => option(value, `${value} · ${accountName(value)}`, value === normalAccount)).join('');
      if (mode === 'no-vat') rate.value = '0';
    }
    rate.disabled = mode !== 'standard';
    line.querySelector('[data-purchase-reverse]').hidden = mode !== 'reverse-construction';
  });
}

function postingTable(rows) {
  const debitTotal = rows.reduce((sum, row) => sum + row.debitCents, 0);
  const creditTotal = rows.reduce((sum, row) => sum + row.creditCents, 0);
  return `<div class="table-scroll purchase-journal"><table><thead><tr><th>Konto</th><th>Benämning</th><th>Debet</th><th>Kredit</th></tr></thead><tbody>${rows.map(row => `<tr><td>${e(row.account)}</td><td>${e(accountName(row.account))}</td><td>${row.debitCents ? e(money(row.debitCents)) : '—'}</td><td>${row.creditCents ? e(money(row.creditCents)) : '—'}</td></tr>`).join('')}</tbody><tfoot><tr><td colspan="2">Summa</td><td>${e(money(debitTotal))}</td><td>${e(money(creditTotal))}</td></tr></tfoot></table></div>`;
}

export function renderPurchaseSummary(draft) {
  try {
    const rows = getBillBookingRows(draft);
    const allocation = draft.lines ? calculatePurchaseLines(draft.lines) : null;
    return `<section class="purchase-card"><header><div><h2>Konteringsförslag</h2><p>Så bokförs fakturan efter din granskning.</p></div>${badge('Ej bokfört', 'draft')}</header>${postingTable(rows)}<div class="purchase-card-body">${pair('Belopp exklusive moms', money(draft.netCents))}${pair('Moms på leverantörens faktura', money(draft.vatCents))}${allocation ? pair('Avdragsgill moms enligt angiven andel', money(allocation.deductibleVatCents)) + pair('Ej avdragsgill moms som kostnad', money(allocation.nonDeductibleVatCents)) : ''}<div class="purchase-summary-total"><span>Fakturabelopp inklusive moms</span><strong>${e(money(draft.totalCents))}</strong><small>SEK</small></div>${draft.lines?.some(line => line.vatMode === 'reverse-construction') || draft.vatMode === 'reverse-construction' ? '<p class="purchase-help">På rader med omvänd byggmoms beräknas momsen i bokföringen och ingår inte i leverantörens fakturabelopp.</p>' : ''}</div></section>`;
  } catch (error) {
    return card('Konteringsförslag', '', `<p class="purchase-help">${e(error.message || 'Fyll i ett giltigt belopp för att se konteringen.')}</p>`);
  }
}

function uploadActions() {
  return `<div class="purchase-upload-actions"><label class="button secondary purchase-file-button">${icon('plus')}Ladda upp fil<input type="file" data-document-upload data-source="file" accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp" multiple aria-label="Ladda upp PDF eller bild"></label><label class="button secondary purchase-file-button">${icon('overview')}Ta foto<input type="file" data-document-upload data-source="camera" accept="image/jpeg,image/png,image/webp" capture="environment" aria-label="Ta foto av fakturan"></label>${button('Välj från inkorgen', 'open-document-picker')}</div>`;
}

export function renderDocumentPanel(attachments = [], { editable = false, canAppend = false, allowUpload = editable || canAppend, selectedDocumentId = '', viewer = null, pickerHTML = '' } = {}) {
  const selected = attachments.find(document => document.id === selectedDocumentId) || attachments[0] || null;
  return `<section id="purchase-document-panel" class="purchase-card purchase-doc-panel" data-document-drop ${allowUpload ? 'data-upload-enabled="true"' : ''}>
    <header><div><h2>Underlag${attachments.length ? ` (${attachments.length})` : ''}</h2><p>${editable ? 'PDF eller bild att kontrollera mot fakturan.' : 'Kopplade original och kompletterande underlag.'}</p></div>${attachments.length ? badge(`${attachments.length} filer`) : ''}</header>
    ${allowUpload ? `<div class="purchase-upload-zone">${uploadActions()}<p class="purchase-help">Dra filer hit eller välj PDF, JPEG, PNG eller WebP. Upp till 15 MB per fil. Filerna sparas lokalt i den här webbläsaren.</p>${!editable ? '<p class="purchase-help">Nya underlag läggs till som kompletteringar. Tidigare underlag och bokförda uppgifter behålls.</p>' : ''}</div>` : ''}
    <div id="purchase-document-picker">${pickerHTML}</div>
    ${attachments.length ? `<div class="purchase-doc-tabs" aria-label="Kopplade underlag">${attachments.map(document => `<div class="purchase-doc-tab ${selected?.id === document.id ? 'selected' : ''}">${button(document.name, 'select-document', document.id, 'secondary', `aria-pressed="${selected?.id === document.id}"`)}${editable ? `<button type="button" class="icon-button" data-action="unlink-document" data-id="${e(document.id)}" aria-label="Koppla bort ${e(document.name)}">${icon('x')}</button>` : ''}</div>`).join('')}</div>` : ''}
    <div id="purchase-document-viewer" data-selected-document-id="${e(selected?.id || '')}">${viewer ? renderDocumentViewer(selected, viewer) : selected ? '<div class="purchase-doc-empty"><p>Läser underlaget…</p></div>' : `<div class="purchase-doc-empty">${icon('sales')}<h3>Se originalet medan du registrerar</h3><p>Ladda upp ett underlag eller välj en fil från inkorgen. Fakturauppgifterna fyller du i och granskar själv.</p></div>`}</div>
  </section>`;
}

export function renderDocumentViewer(document, { url = '', zoom = 1, rotation = 0, loading = false, error = '' } = {}) {
  if (!document) return '<div class="purchase-doc-empty"><p>Välj ett underlag för att visa det.</p></div>';
  if (error) return `<div class="purchase-doc-empty purchase-doc-warning" role="alert"><h3>Underlaget kunde inte visas</h3><p>${e(error)}</p><p>Fakturans uppgifter finns kvar. Filen kan behöva väljas på nytt från den ursprungliga enheten.</p></div>`;
  if (loading || !url) return '<div class="purchase-doc-empty"><p>Läser underlaget…</p></div>';
  // The controller supplies an object URL after reading and verifying the bytes.
  if (!/^blob:/.test(url)) return '<div class="purchase-doc-empty" role="alert"><p>Dokumentets adress kunde inte godkännas.</p></div>';
  const imageFile = document.type.startsWith('image/');
  const scale = Math.min(3, Math.max(0.5, Number(zoom) || 1));
  const turn = ((Math.round((Number(rotation) || 0) / 90) * 90) % 360 + 360) % 360;
  // Keep the transformed image in positive scroll coordinates at every turn.
  const translation = turn === 90 ? 'translateY(-100%)' : turn === 180 ? 'translate(-100%,-100%)' : turn === 270 ? 'translateX(-100%)' : '';
  return `<div class="purchase-doc-toolbar"><div><strong>${e(document.name)}</strong><small>${e(mimeLabel(document.type))} · ${e(sizeLabel(document.size))}</small></div><div class="actions">${imageFile ? `${button('−', 'document-zoom-out', document.id, 'secondary', 'aria-label="Zooma ut underlaget"')}${button(`${Math.round(scale * 100)} %`, 'document-reset', document.id, 'secondary', 'aria-label="Återställ zoom och rotation"')}${button('+', 'document-zoom-in', document.id, 'secondary', 'aria-label="Zooma in underlaget"')}${button('Rotera', 'document-rotate', document.id)}` : ''}${button('Ladda ner', 'download-document', document.id)}</div></div>
    <div class="purchase-doc-stage" ${imageFile ? 'data-image-stage' : ''}>${imageFile ? `<img class="purchase-document-image" src="${e(url)}" alt="${e(document.name)}" style="transform-origin:top left;transform:scale(${scale}) rotate(${turn}deg) ${translation}" draggable="false">` : `<iframe class="purchase-document-pdf" src="${e(url)}" title="Underlag: ${e(document.name)}"></iframe>`}</div>
    <div class="purchase-doc-info"><span>${document.source === 'camera' ? 'Tillagd via kamera' : 'Tillagd via filuppladdning'} · ${e(timeLabel(document.createdAt))}</span>${!imageFile ? '<span>Om PDF-visning saknas i webbläsaren, välj Ladda ner för att öppna filen.</span>' : ''}</div>`;
}

export function renderDocumentPicker(documents, state, selectedIds = []) {
  const selected = new Set(selectedIds);
  const used = new Map(state.bills.flatMap(bill => attachmentsFor(bill).map(document => [document.id, bill])));
  const choices = documents.filter(document => !selected.has(document.id));
  return `<div class="purchase-picker-list"><header><strong>Välj underlag från inkorgen</strong>${button('Stäng', 'close-document-picker')}</header>${choices.length ? choices.map(document => `<article><div><strong>${e(document.name)}</strong><small>${e(mimeLabel(document.type))} · ${e(sizeLabel(document.size))}${used.has(document.id) ? ` · kopplad till ${e(used.get(document.id).number)}` : ''}</small></div>${button('Koppla', 'attach-document', document.id)}</article>`).join('') : '<p class="purchase-help">Inga fler underlag finns i inkorgen. Ladda upp en fil för att lägga till ett.</p>'}</div>`;
}

function supplierBlock(bill) {
  const supplier = detailsFor(bill).supplier;
  return `<div class="purchase-detail-list"><strong>${e(bill.supplier)}</strong>${[supplier.orgNumber, supplier.address, [supplier.postalCode, supplier.city].filter(Boolean).join(' '), supplier.email, supplier.phone].filter(Boolean).map(value => `<span>${e(value)}</span>`).join('')}</div>`;
}

export function renderPurchaseDetail(state, bill, { selectedDocumentId = '', viewer = null } = {}) {
  const details = detailsFor(bill), attachments = attachmentsFor(bill);
  const entry = state.entries.find(item => item.id === bill.entryId);
  const relatedEntries = [bill.entryId, bill.creditEntryId, ...(bill.payments || []).map(payment => payment.entryId)].filter(Boolean).map(id => state.entries.find(item => item.id === id)).filter(Boolean);
  const activity = [...state.activity].reverse().filter(event => event.entityId === bill.id || relatedEntries.some(entry => entry.id === event.entityId));
  const settlementLink = bill.status !== 'draft' ? '<a class="button secondary" href="#settlements">Krediter &amp; återbetalningar</a>' : '';
  const actions = bill.status === 'draft' ? `${button('Redigera', 'edit-bill', bill.id)}${button('Granska & bokför', 'book-bill', bill.id, 'primary')}` : bill.status === 'booked' && getBillOutstanding(bill) > 0 ? button('Registrera betalning', 'bill-payment', bill.id, 'primary') : '';
  return `<div class="purchase-workspace purchase-detail-page">
    <div class="purchase-breadcrumb"><a href="#purchases" data-action="purchase-back">${icon('arrow')}Leverantörsfakturor</a><span>/</span><span>${e(bill.number)}</span></div>
    <header class="purchase-page-heading"><div><span class="eyebrow">INKÖP · LEVERANTÖRSFAKTURA</span><h1>${e(bill.number)}</h1><p>${e(bill.supplier)}</p></div><div class="actions">${invoiceStatus(bill)}${button('Kopiera till ny', 'copy-bill', bill.id)}${settlementLink}${actions}</div></header>
    <div class="purchase-detail-layout"><div class="purchase-form-pane">
      ${card('Fakturauppgifter', bill.status === 'draft' ? 'Granska utkastet före bokföring.' : 'Fakturauppgifterna är låsta efter bokföring.', `<div class="purchase-grid purchase-grid-two"><div>${supplierBlock(bill)}</div><div>${pair('Fakturadatum', bill.date)}${pair('Förfallodatum', bill.dueDate)}${pair('Projekt', projectName(state, bill.projectId))}</div></div><div class="purchase-grid purchase-grid-two">${pair('OCR / betalningsreferens', details.paymentReference)}${pair('Bankgiro', details.bankgiro)}${pair('Plusgiro', details.plusgiro)}${pair('IBAN', details.iban)}${pair('Vår referens', details.ourReference)}${pair('Leverantörens referens', details.supplierReference)}${pair('Kostnadsställe / märkning', details.costCenter)}${pair('Momstyp', bill.lines ? `${bill.lines.length} konteringsrader med individuell moms` : bill.vatMode === 'reverse-construction' ? 'Omvänd byggmoms' : bill.vatMode === 'no-vat' ? 'Ingen moms' : `Svensk moms ${bill.vatRate} %`)}</div>${details.description ? `<p class="purchase-description">${e(details.description)}</p>` : ''}`)}
      ${bill.lines ? card('Fakturans konteringsrader', 'Ursprungliga uppgifter per kostnadsrad.', `<div class="table-scroll"><table><thead><tr><th>Beskrivning</th><th>Konto</th><th>Netto</th><th>Moms</th><th>Avdrag</th></tr></thead><tbody>${bill.lines.map(line => `<tr><td>${e(line.description || '—')}</td><td>${e(line.account)}</td><td>${e(money(line.netCents))}</td><td>${e(line.vatMode === 'no-vat' ? 'Ingen moms' : `${line.vatRate} %${line.vatMode === 'reverse-construction' ? ' omvänd' : ''}`)}</td><td>${e(((line.deductibleBps ?? 10000) / 100).toLocaleString('sv-SE'))} %</td></tr>`).join('')}</tbody></table></div>`) : ''}
      ${bill.status === 'draft' ? renderPurchaseSummary(bill) : `<section class="purchase-card"><header><div><h2>Bokförd kontering</h2><p>${e(entry?.number || '')} · ${e(entry?.date || bill.date)}</p></div>${entry ? button('Visa verifikation', 'show-entry', entry.id) : ''}</header>${postingTable(entry?.rows || [])}<div class="purchase-card-body">${pair('Belopp exklusive moms', money(bill.netCents))}${pair('Moms på fakturan', money(bill.vatCents))}<div class="purchase-summary-total"><span>Fakturabelopp</span><strong>${e(money(bill.totalCents))}</strong></div></div></section>`}
      ${card('Betalningar och historik', '', `${pair('Kvar att betala', money(getBillOutstanding(bill)))}${bill.settlementCreditCents !== undefined ? pair('Krediterat', money(bill.settlementCreditCents)) : ''}${bill.settlementRefundCents !== undefined ? pair('Återbetalt av leverantören', money(bill.settlementRefundCents)) : ''}${bill.payments?.length ? `<div class="table-scroll"><table><thead><tr><th>Datum</th><th>Belopp</th><th>Verifikation</th></tr></thead><tbody>${bill.payments.map(payment => `<tr><td>${e(payment.date)}</td><td>${e(money(payment.amountCents))}</td><td>${button(state.entries.find(item => item.id === payment.entryId)?.number || 'Visa', 'show-entry', payment.entryId)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="purchase-help">Inga betalningar registrerade.</p>'}${bill.status === 'booked' && !bill.payments.length && !bill.settlementLastDate && !bill.settlementCreditCents && !bill.settlementRefundCents && !bill.settlementOffsetInCents && !bill.settlementOffsetOutCents ? `<div class="actions">${button('Kreditera inköpet', 'credit-bill', bill.id, 'danger')}</div>` : ''}${bill.creditReason ? `<p class="purchase-description">Krediterad: ${e(bill.creditReason)}</p>` : ''}${relatedEntries.length ? `<div class="actions purchase-entry-links">${relatedEntries.map(item => button(`${item.number} · ${item.description}`, 'show-entry', item.id)).join('')}</div>` : ''}${activity.length ? `<h3>Fakturans händelser</h3><ol class="purchase-history">${activity.map(event => `<li><span>${e(event.label)}</span><small>${e(timeLabel(event.createdAt || event.date))} · ${e(event.actor || 'Åke')}</small></li>`).join('')}</ol>` : ''}`)}
    </div><aside class="purchase-document-pane">${renderDocumentPanel(attachments, { editable: false, allowUpload: bill.status !== 'draft', selectedDocumentId, viewer })}${bill.status === 'draft' ? '<p class="purchase-help">Välj Redigera för att lägga till eller koppla bort underlag i utkastet.</p>' : ''}</aside></div>
  </div>`;
}

export function renderDocumentInbox(documents, state, { loading = false, error = '', selectedDocumentId = '', viewer = null } = {}) {
  const owners = new Map();
  for (const bill of state.bills) for (const document of attachmentsFor(bill)) {
    if (!owners.has(document.id)) owners.set(document.id, []);
    owners.get(document.id).push(bill);
  }
  const selected = documents.find(document => document.id === selectedDocumentId);
  return `<div class="purchase-workspace purchase-inbox-page"><header class="purchase-page-heading"><div><span class="eyebrow">INKÖP · DOKUMENTINKORG</span><h1>Inkomna underlag</h1><p>Samla fakturor, foton och kompletteringar innan du kopplar dem till bokföringen.</p></div><div class="actions">${button('Leverantörsfakturor', 'purchase-back')}${button('Ny leverantörsfaktura', 'new-bill', '', 'primary')}</div></header>${tabs('inbox')}
    <div class="purchase-upload-zone purchase-inbox-upload" data-document-drop data-upload-enabled="true">${uploadActions()}<p class="purchase-help">Filerna sparas lokalt i den här webbläsaren. PDF, JPEG, PNG eller WebP, högst 15 MB per fil.</p></div>
    <div class="purchase-mail-note"><div>${icon('sales')}<strong>E-postmottagning är inte ansluten</strong></div><p>I en ansluten inkorg kan e-postbilagor komma hit för granskning. Tills dess kan du spara bilagan från ditt mejl och ladda upp den här. Uppladdningen tolkar inte fakturans belopp automatiskt.</p></div>
    ${error ? `<div class="form-error" role="alert">${e(error)}</div>` : ''}
    ${loading ? '<div class="empty"><p>Läser inkorgen…</p></div>' : documents.length ? `<div class="purchase-inbox-grid">${[...documents].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(document => { const linked = owners.get(document.id) || []; return `<article class="purchase-inbox-card ${selected?.id === document.id ? 'selected' : ''}"><div class="purchase-inbox-meta"><span class="purchase-file-type">${e(mimeLabel(document.type))}</span>${badge(linked.length ? 'Kopplad' : 'Att hantera', linked.length ? 'settled' : 'draft')}</div><h2>${e(document.name)}</h2><p>${e(sizeLabel(document.size))} · ${e(timeLabel(document.createdAt))}</p><small>${document.source === 'camera' ? 'Tillagd via kamera' : 'Filuppladdning'}</small>${linked.length ? `<p class="purchase-linked-bill">${linked.map(bill => `<a href="#purchases/${encodeURIComponent(bill.id)}" data-action="show-bill" data-id="${e(bill.id)}">${e(bill.supplier)} · ${e(bill.number)}</a>`).join('<br>')}</p>` : ''}<div class="actions">${button('Visa underlag', 'select-inbox-document', document.id)}${!linked.length ? `${button('Skapa fakturautkast', 'create-bill-from-document', document.id, 'primary')}${button('Koppla till befintlig', 'link-document-existing', document.id)}${button('Ta bort', 'remove-inbox-document', document.id, 'secondary')}` : ''}</div></article>`; }).join('')}</div>` : '<div class="purchase-doc-empty"><h2>Inkorgen är tom</h2><p>Ladda upp en PDF eller bild, eller fotografera fakturan med mobilen.</p></div>'}
    ${selected ? `<section class="purchase-card purchase-inbox-preview"><header><h2>Förhandsvisning av underlag</h2>${button('Stäng förhandsvisning', 'close-inbox-preview')}</header><div id="purchase-document-viewer" data-selected-document-id="${e(selected.id)}">${renderDocumentViewer(selected, viewer || {})}</div></section>` : ''}
  </div>`;
}
