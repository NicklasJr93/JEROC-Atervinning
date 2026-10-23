import { ACCOUNTS, money, toCents, assert } from './core.js';
import { closeYear, lockPeriod, unlockPeriod } from './finance.js';
import { annualReportDraft, closeReviewedYear, currentYearClosure, defaultNextYearEnd, exportYearReview, fiscalPeriods, getCloseChecklist, getYearReports, nextCalendarDate, openNextYear, prepareCorporateTax, saveYearWorkpaper } from './financial-years.js';

const e = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const categories = { bank: 'Bank och kassa', receivables: 'Kundfordringar', payables: 'Leverantörsskulder', vat: 'Moms', payroll: 'Lön och avgifter', assets: 'Inventarier', inventory: 'Lager', accruals: 'Periodiseringar', tax: 'Skatt', equity: 'Eget kapital', 'annual-report': 'Årsredovisning', other: 'Övrigt' };
const statusLabel = { draft: 'Utkast', prepared: 'Upprättad', reviewed: 'Granskad i demon' };
const input = (label, name, value = '', type = 'text', extra = '') => `<label>${e(label)}<input type="${type}" name="${name}" value="${e(value)}" ${extra}></label>`;
const select = (label, name, options, value = '') => `<label>${e(label)}<select name="${name}">${options.map(([key, title]) => `<option value="${e(key)}" ${key === value ? 'selected' : ''}>${e(title)}</option>`).join('')}</select></label>`;
const textarea = (label, name, value = '', extra = '') => `<label class="year-span">${e(label)}<textarea name="${name}" rows="3" ${extra}>${e(value)}</textarea></label>`;
const form = (action, content, button) => `<form data-feature-form="year-end" data-action="${action}" class="year-form">${content}<div class="year-span"><button type="submit" class="button primary">${e(button)}</button></div></form>`;
const table = (headers, rows) => `<div class="year-table"><table><thead><tr>${headers.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}">Inga poster ännu.</td></tr>`}</tbody></table></div>`;
const periodMonths = state => {
  const result = []; let date = new Date(`${state.company.fiscalYearStart.slice(0, 7)}-01T00:00:00Z`);
  while (date.toISOString().slice(0, 7) <= state.company.fiscalYearEnd.slice(0, 7)) {
    result.push(date.toISOString().slice(0, 7)); date.setUTCMonth(date.getUTCMonth() + 1);
  }
  return result;
};

function workpaperForm(paper) {
  return form('save-workpaper', `${paper ? `<input type="hidden" name="id" value="${e(paper.id)}">` : ''}${input('Rubrik', 'title', paper?.title ?? '', 'text', 'required maxlength="160"')}${select('Område', 'category', Object.entries(categories), paper?.category ?? 'bank')}${select('Konto för avstämning', 'account', [['', 'Ingen kontokoppling'], ...ACCOUNTS.map(account => [account.number, `${account.number} ${account.name}`])], paper?.account ?? '')}${select('Status', 'status', Object.entries(statusLabel), paper?.status ?? 'draft')}${input('Upprättad av (demouppgift)', 'preparedBy', paper?.preparedBy ?? '', 'text', 'maxlength="100"')}${input('Granskad av (demouppgift)', 'reviewedBy', paper?.reviewedBy ?? '', 'text', 'maxlength="100"')}${textarea('Kommentar och bedömning', 'note', paper?.note ?? '', 'maxlength="6000"')}${textarea('Underlagsreferens', 'evidence', paper?.evidence ?? '', 'maxlength="1000"')}`, paper ? 'Spara ny version av bilagan' : 'Skapa bokslutsbilaga');
}

export function renderWorkspace(state) {
  const report = getYearReports(state); const closure = currentYearClosure(state); const checks = getCloseChecklist(state);
  const papers = (state.yearWorkpapers ?? []).filter(paper => paper.fiscalYearStart === state.company.fiscalYearStart && paper.fiscalYearEnd === state.company.fiscalYearEnd);
  const nextStart = nextCalendarDate(state.company.fiscalYearEnd); const nextEnd = defaultNextYearEnd(nextStart);
  const archive = fiscalPeriods(state).filter(period => period.snapshot);
  return `<section class="year-workspace"><div class="page-heading"><div><span class="eyebrow">BOKSLUT OCH RÄKENSKAPSÅR</span><h1>Från avstämning till nästa år</h1><p>${e(state.company.fiscalYearStart)}–${e(state.company.fiscalYearEnd)} · ${closure ? 'Året är avslutat' : 'Pågående räkenskapsår'}</p></div></div>
    <div class="year-metrics"><article><span>Årets resultat</span><strong>${e(money(report.resultCents))}</strong></article><article><span>Tillgångar</span><strong>${e(money(report.assetsCents))}</strong></article><article><span>Bokslutsbilagor</span><strong>${papers.filter(paper => paper.status === 'reviewed').length}/${papers.length} granskade</strong></article><article><span>Arkiverade år</span><strong>${archive.length}</strong></article></div>
    <p class="year-callout">Bilagor, skatteberäkning och årsredovisningsunderlag hjälper granskningen. De är arbetsmaterial; namngiven demogranskning är ingen verifierad attest och inget skickas till myndigheter.</p>
    <div class="year-columns"><article class="panel year-panel"><h2>Avstämning inför bokslut</h2>${table(['Kontroll', 'Status', 'Kommentar'], checks.filter(check => check.id !== 'year').map(check => [e(check.label), `<span class="year-pill ${check.done ? 'done' : ''}">${check.done ? 'Klart' : 'Återstår'}</span>`, e(check.detail)]))}
    ${!closure ? form('lock-period', select('Period', 'month', periodMonths(state).map(month => [month, `${month}${state.lockedPeriods.includes(month) ? ' · låst' : ''}`])) + select('Åtgärd', 'operation', [['lock', 'Lås period'], ['unlock', 'Öppna igen']]) + input('Orsak vid upplåsning', 'reason', '', 'text', 'maxlength="160"'), 'Utför periodåtgärd') : ''}</article>
    <article class="panel year-panel"><h2>${closure ? 'Öppna nästa räkenskapsår' : 'Avsluta räkenskapsåret'}</h2>${closure ? `<p>Historiska verifikationer och bilagor sparas. Obetalda fakturor, tillgångar, lager och periodiseringsplaner följer med. Balanskontona förs vidare utan en dubblerad ingående balans.</p>${form('open-next-year', input('Första dag', 'start', nextStart, 'date', 'required') + input('Sista dag', 'end', nextEnd, 'date', 'required') + '<label class="year-span year-check"><input type="checkbox" name="confirmed" required> Jag vill öppna nästa år och bevara historiken.</label>', 'Öppna nästa år')}` : `<p>Befintliga bokslutsbilagor ska vara granskade och kontosaldon oförändrade. Årsavslutet kontrollerar även bokföringens avstämningslista.</p>${form('close-year', '<label class="year-span year-check"><input type="checkbox" name="confirmed" required> Jag har granskat bokslutsbedömningar, skatt och periodiseringar.</label>', 'Bokför årets resultat och avsluta')}`}</article></div>
    <article class="panel year-panel"><h2>Bokslutsbilagor</h2>${papers.length ? papers.map(paper => `<details class="year-paper"><summary><strong>${e(paper.title)}</strong><span>${e(categories[paper.category])} · ${e(statusLabel[paper.status])}${paper.account ? ` · ${e(paper.account)} ${e(money(paper.balanceCents))}` : ''}</span></summary><p>${e(paper.note || 'Ingen kommentar.')}</p><p class="muted">${paper.revisions.length} versioner · Upprättad av ${e(paper.preparedBy || '—')} · Granskad av ${e(paper.reviewedBy || '—')}</p>${!closure ? workpaperForm(paper) : ''}</details>`).join('') : '<p>Skapa exempelvis bilagor för bank, kundfordringar, lager, periodiseringar och skatt.</p>'}${!closure ? `<details class="year-paper"><summary><strong>Ny bokslutsbilaga</strong></summary>${workpaperForm()}</details>` : ''}</article>
    <div class="year-columns"><article class="panel year-panel"><h2>Bolagsskatt · beräkningsunderlag</h2><p>För svenskt aktiebolag: 20,6 %. Ange granskade skattemässiga justeringar och utnyttjbart underskott. Beräkningen bokför inget och är ingen INK2-inlämning.</p>${form('calculate-tax', input('Ej avdragsgilla tillägg, kr', 'additions', '0', 'text', 'inputmode="decimal" required') + input('Skattemässiga avdrag, kr', 'deductions', '0', 'text', 'inputmode="decimal" required') + input('Utnyttjbart tidigare underskott, kr', 'priorLoss', '0', 'text', 'inputmode="decimal" required') + textarea('Bedömning och underlag', 'assessmentNote', '', 'maxlength="6000"'), 'Hämta skatteberäkning')}</article>
    <article class="panel year-panel"><h2>Årsredovisningsunderlag</h2><p>Hämta resultat, balans och föregående års jämförelse, kompletterat med egna texter. K-regelverk, noter, resultatdisposition och underskrifter behöver färdigställas och granskas.</p>${form('export-annual', textarea('Utkast till förvaltningsberättelse', 'managementReport', '', 'maxlength="12000"') + textarea('Utkast till noter', 'notes', '', 'maxlength="12000"'), 'Hämta årsredovisningsunderlag')}</article></div>
    <article class="panel year-panel"><h2>Årsarkiv och granskningspaket</h2>${table(['Räkenskapsår', 'Status', 'Underlag'], fiscalPeriods(state).map(period => [`${e(period.start)}–${e(period.end)}`, e(period.snapshot ? 'Arkiverat' : currentYearClosure(state) ? 'Avslutat' : 'Pågående'), `<button type="button" class="button" data-feature-action="year-end" data-action="export-year" data-id="${e(period.start + '/' + period.end)}">Hämta granskningspaket</button>`]))}<p class="muted">Arkivet är fortfarande lokal demodata. Serverlagring och provad återläsning behövs inför skarp drift.</p></article></section>`;
}

export function handleAction(state, action, data) {
  if (action === 'save-workpaper') return saveYearWorkpaper(state, data);
  if (action === 'lock-period') return data.operation === 'unlock' ? unlockPeriod(state, data.month, data.reason) : lockPeriod(state, data.month);
  if (action === 'close-year') return closeReviewedYear(state, { confirmed: data.confirmed === true || data.confirmed === 'on' });
  if (action === 'open-next-year') return openNextYear(state, { start: data.start, end: data.end, confirmed: data.confirmed === true || data.confirmed === 'on' });
  // Download actions are handled by the parent so the model stays pure.
  assert(!['calculate-tax', 'export-annual', 'export-year'].includes(action), 'Denna åtgärd ska hämta ett granskningsunderlag, inte skriva bokföring.');
  throw new Error('Okänd bokslutsåtgärd.');
}

export function getDownload(state, action, data) {
  if (action === 'calculate-tax') return { name: 'bolagsskatt-berakningsunderlag.json', value: prepareCorporateTax(state, { additionsCents: toCents(data.additions || '0'), deductionsCents: toCents(data.deductions || '0'), priorLossCents: toCents(data.priorLoss || '0'), assessmentNote: data.assessmentNote || '' }) };
  if (action === 'export-annual') return { name: 'arsredovisningsunderlag-utkast.json', value: annualReportDraft(state, { managementReport: data.managementReport || '', notes: data.notes || '' }) };
  if (action === 'export-year') {
    const [start, end] = String(data.id ?? `${state.company.fiscalYearStart}/${state.company.fiscalYearEnd}`).split('/');
    return { name: `bokslutspaket-${start}-${end}.json`, value: exportYearReview(state, start, end) };
  }
  return null;
}
