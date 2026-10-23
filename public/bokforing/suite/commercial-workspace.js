import { money, toCents, assert } from './core.js';
import { saveArticle, setArticleActive, saveCustomerPrice, createArticleInvoice, createRecurringPlan, generateRecurringInvoices, setRecurringActive, prepareReminder, getReminderAmount, issueProjectStock, createRevenueSchedule, recognizeRevenueMonth, addProjectWorkpaper, nextRecurringDate } from './commercial.js';

const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dateFor = state => state.company.fiscalYearStart <= '2026-10-23' && state.company.fiscalYearEnd >= '2026-10-23' ? '2026-10-23' : state.company.fiscalYearStart;
const input = (label, name, value = '', type = 'text', extra = '') => `<label>${e(label)}<input name="${e(name)}" type="${type}" value="${e(value)}" ${extra}></label>`;
const select = (label, name, values, value = '') => `<label>${e(label)}<select name="${e(name)}">${values.map(([id, text]) => `<option value="${e(id)}" ${String(id) === String(value) ? 'selected' : ''}>${e(text)}</option>`).join('')}</select></label>`;
const amount = (label, name, value = '') => input(label, name, value, 'text', 'inputmode="decimal" required');
const form = (action, html, title, submit = 'Spara') => `<form data-feature-form="commercial" data-action="${e(action)}" class="commercial-form"><h3>${e(title)}</h3>${html}<button class="button primary" type="submit">${e(submit)}</button></form>`;
const btn = (text, action, id) => `<button type="button" class="button secondary" data-feature-action="commercial" data-action="${e(action)}" data-id="${e(id)}">${e(text)}</button>`;
const table = (heads, rows) => rows.length ? `<div class="table-scroll"><table><thead><tr>${heads.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="commercial-empty">Inga poster ännu.</p>';
const section = (id, title, text, body) => `<section id="commercial-${id}" class="panel commercial-section"><div class="panel-heading"><div><h2>${e(title)}</h2><p>${e(text)}</p></div></div>${body}</section>`;
const articleFields = article => `<div class="commercial-grid">${input('Artikelnummer', 'number', article?.number ?? '', 'text', 'required maxlength="100"')}${input('Benämning', 'name', article?.name ?? '', 'text', 'required maxlength="300"')}${select('Typ', 'kind', [['labor', 'Arbete'], ['material', 'Material'], ['other', 'Övrigt']], article?.kind ?? 'material')}${input('Enhet', 'unit', article?.unit ?? 'st', 'text', 'required maxlength="30"')}${amount('À-pris exkl. moms (kr)', 'unitCents', article ? (article.unitCents / 100).toFixed(2) : '')}${select('Moms', 'vatRate', [[25, '25 %'], [12, '12 %'], [6, '6 %'], [0, '0 %']], article?.vatRate ?? 25)}</div>`;

export function renderWorkspace(state) {
  const today = dateFor(state);
  const articles = state.commercialArticles ?? [];
  const activeArticles = articles.filter(item => item.active).map(item => [item.id, `${item.number} · ${item.name}`]);
  const customers = state.customers.map(item => [item.id, item.name]);
  const projects = [['', 'Inget projekt'], ...state.projects.map(item => [item.id, item.name])];
  const invoices = state.invoices.filter(item => item.kind === 'invoice' && item.status === 'issued');
  const invoiceOptions = invoices.map(item => [item.id, `${item.number} · ${state.customers.find(customer => customer.id === item.customerId)?.name ?? ''}`]);
  const invoiceRows = () => [1, 2, 3].map(i => `<div class="commercial-item-row">${select(`Artikelrad ${i}`, `article${i}`, [['', i === 1 ? 'Välj artikel' : 'Ingen extra rad'], ...activeArticles])}${input('Antal', `quantity${i}`, i === 1 ? '1' : '', 'text', 'inputmode="decimal"')}</div>`).join('');
  const basics = () => `<div class="commercial-grid">${select('Kund', 'customerId', customers)}${select('Projekt (samma kund)', 'projectId', projects)}</div>${invoiceRows()}`;
  const catalog = table(['Artikel', 'Pris exkl. moms', 'Moms', 'Status', 'Ändra'], articles.map(item => [
    `<strong>${e(item.number)}</strong><br>${e(item.name)} · ${e(item.unit)}`, e(money(item.unitCents)), `${item.vatRate} %`, item.active ? 'Aktiv' : 'Inaktiv',
    `<details><summary>Ändra artikel</summary>${form('save-article', `<input type="hidden" name="id" value="${e(item.id)}">${articleFields(item)}`, `${item.number} · version ${item.revision}`)}</details>${btn(item.active ? 'Inaktivera' : 'Aktivera', item.active ? 'deactivate-article' : 'activate-article', item.id)}`,
  ]));
  const prices = table(['Kund', 'Artikel', 'Kundpris'], (state.commercialPrices ?? []).map(item => [e(state.customers.find(customer => customer.id === item.customerId)?.name), e(articles.find(article => article.id === item.articleId)?.number), e(money(item.unitCents))]));
  const plans = table(['Plan', 'Nästa fakturadatum', 'Skapade utkast', 'Status', 'Åtgärd'], (state.recurringPlans ?? []).map(plan => [
    e(plan.name), e(plan.endDate && nextRecurringDate(plan) > plan.endDate ? 'Planen avslutad' : nextRecurringDate(plan)), plan.generated.map(item => `<a href="#sales/${e(item.invoiceId)}">${e(item.date)}</a>`).join('<br>') || '0', plan.active ? 'Aktiv' : 'Pausad', btn(plan.active ? 'Pausa' : 'Aktivera', plan.active ? 'pause-recurring' : 'activate-recurring', plan.id),
  ]));
  const generated = table(['Artikelutkast', 'Datum', 'Kund'], (state.commercialInvoiceOrigins ?? []).slice().reverse().map(origin => {
    const invoice = state.invoices.find(item => item.id === origin.invoiceId);
    return [`<a href="#sales/${e(invoice.id)}">${e(invoice.number || 'Öppna utkast')}</a>`, e(invoice.date), e(state.customers.find(customer => customer.id === invoice.customerId)?.name)];
  }));
  const recurringForm = form('create-recurring', `${input('Planens namn', 'name', '', 'text', 'required maxlength="150"')}${basics()}<div class="commercial-grid">${input('Första fakturadatum', 'startDate', today, 'date', 'required')}${input('Sista fakturadatum (valfritt)', 'endDate', '', 'date')}${select('Intervall', 'intervalMonths', [[1, 'Varje månad'], [3, 'Varje kvartal'], [6, 'Varje halvår'], [12, 'Varje år']])}${input('Betalningsvillkor i dagar', 'dueDays', '30', 'number', 'min="0" max="365" required')}</div>`, 'Ny återkommande fakturaplan', 'Skapa plan');
  const remainder = table(['Faktura', 'Datum', 'Belopp då', 'Text'], (state.commercialReminders ?? []).map(item => [e(state.invoices.find(invoice => invoice.id === item.invoiceId)?.number), e(item.date), e(money(item.outstandingCents)), e(item.note)]));
  const stocks = table(['Projekt', 'Artikel', 'Antal', 'Kostnad', 'Datum'], (state.projectStockLinks ?? []).map(item => [e(state.projects.find(project => project.id === item.projectId)?.name), e(state.inventoryItems.find(stock => stock.id === item.inventoryItemId)?.name), e(item.quantity), e(money(item.costCents)), e(item.date)]));
  const schedules = table(['Plan', 'Faktura', 'Kvar att intäktsföra', 'Fördelat', 'Nästa månad'], (state.revenueSchedules ?? []).map(item => {
    const remaining = item.amountCents - item.postings.reduce((total, posting) => total + posting.amountCents, 0);
    const month = new Date(`${item.startMonth}-01T12:00:00Z`); month.setUTCMonth(month.getUTCMonth() + item.postings.length);
    return [e(item.name), e(state.invoices.find(invoice => invoice.id === item.invoiceId)?.number), e(money(remaining)), `${item.postings.length}/${item.months}`, item.status === 'completed' ? 'Färdig' : form('recognize-revenue', `<input type="hidden" name="id" value="${e(item.id)}">${input('Bokföringsdatum', 'date', month.toISOString().slice(0, 10), 'date', 'required')}`, month.toISOString().slice(0, 7), 'Bokför månad')];
  }));
  const papers = table(['Projekt', 'Datum', 'Färdigställt', 'Kostnad', 'Bedömning'], (state.projectWorkpapers ?? []).map(item => [e(state.projects.find(project => project.id === item.projectId)?.name), e(item.date), `${item.completionBps / 100} %`, e(money(item.completedCostCents)), `${e(item.reviewNote)}<br><small>${e(item.reviewer)}</small>`]));
  return `<div class="commercial-workspace"><header class="page-heading"><div><span class="eyebrow">Projekt & fakturering</span><h1>Artiklar, avtal och intäkter</h1><p>Från kundpris och lageruttag till fakturautkast och månatlig intäktsföring.</p></div></header>
    <nav class="commercial-nav" aria-label="Arbetsområden"><a href="#commercial/artiklar">Artiklar & priser</a><a href="#commercial/avtal">Återkommande</a><a href="#commercial/paminnelser">Påminnelser</a><a href="#commercial/projekt">Projektmaterial</a><a href="#commercial/intakter">Intäkter</a><a href="#commercial/pagaende">Pågående arbeten</a></nav>
    <p class="commercial-note">Fakturaplaner skapar utkast som du granskar och utfärdar i Kundfakturor. Påminnelser förbereds här; ingen e-post eller betalning skickas.</p>
    ${section('artiklar', 'Artiklar och kundpriser', 'Priset kopieras till fakturautkastet. En senare artikeländring skriver inte om befintliga fakturor.', catalog + `<div class="commercial-columns">${form('save-article', articleFields(), 'Ny artikel', 'Lägg till artikel')}${form('save-price', select('Kund', 'customerId', customers) + select('Artikel', 'articleId', activeArticles) + amount('Kundpris exkl. moms (kr)', 'unitCents'), 'Kundspecifikt pris')}</div>` + prices + form('article-invoice', basics() + `<div class="commercial-grid">${input('Fakturadatum', 'date', today, 'date', 'required')}${input('Förfallodatum', 'dueDate', today, 'date', 'required')}</div>`, 'Faktura från artikelregistret', 'Skapa fakturautkast') + generated)}
    ${section('avtal', 'Återkommande fakturor', 'Planens rader och pris fryses när planen skapas. Samma period kan inte genereras två gånger. Dagen förankras i första datumet, även efter februari.', plans + `<div class="commercial-columns">${recurringForm}${form('generate-recurring', input('Skapa utkast till och med', 'asOf', today, 'date', 'required'), 'Generera förfallna perioder', 'Skapa utkast')}</div>`)}
    ${section('paminnelser', 'Påminnelseunderlag', 'Visa förfallna kundandelar och förbered en påminnelse med belopp och daterad historik. Väntad ROT-utbetalning krävs inte av kunden. Avgifter och ränta bokförs inte automatiskt.', form('reminder', select('Obetald kundfaktura', 'invoiceId', invoices.filter(item => getReminderAmount(item) > 0).map(item => [item.id, `${item.number} · ${money(getReminderAmount(item))}`])) + input('Påminnelsedatum', 'date', today, 'date', 'required') + '<label>Påminnelsetext<textarea name="note" required maxlength="2000">Vi saknar betalning för fakturan. Kontakta oss om betalning redan har gjorts.</textarea></label>', 'Förbered påminnelse', 'Spara påminnelseunderlag') + remainder)}
    ${section('projekt', 'Lageruttag till projekt', 'Uttaget minskar fysiskt lager och skapar samma materialrad på projektet. Kostnad och försäljningspris visas separat. Bokförd lagerförändring hanteras i Materiallager.', form('project-stock', `<div class="commercial-grid">${select('Projekt', 'projectId', projects.filter(([id]) => id))}${select('Lagerartikel', 'inventoryItemId', state.inventoryItems.map(item => [item.id, `${item.name} · ${item.quantity} ${item.unit} i lager`]))}${input('Datum', 'date', today, 'date', 'required')}${input('Antal', 'quantity', '1', 'text', 'inputmode="decimal" required')}${amount('Försäljningspris per enhet exkl. moms', 'unitCents')}${select('Moms', 'vatRate', [[25, '25 %'], [12, '12 %'], [6, '6 %'], [0, '0 %']])}</div>${input('Orsak', 'reason', '', 'text', 'required maxlength="300"')}`, 'Koppla lageruttag', 'Registrera uttag och projektmaterial') + stocks)}
    ${section('intakter', 'Intäktsperiodisering', 'Fördela nettointäkt från en utfärdad faktura. Moms och kundfordran ändras inte. Välj period och bedömning utifrån avtalet; ROT och redan krediterade fakturor hanteras separat.', form('create-revenue', select('Utfärdad faktura', 'invoiceId', invoiceOptions) + input('Planens namn', 'name', '', 'text', 'required maxlength="150"') + `<div class="commercial-grid">${amount('Nettointäkt att fördela (kr)', 'amountCents')}${input('Omföringsdatum', 'date', today, 'date', 'required')}${input('Första intäktsmånad', 'startMonth', today.slice(0, 7), 'month', 'required')}${input('Antal månader', 'months', '12', 'number', 'required min="1" max="120"')}</div>`, 'Ny intäktsplan', 'Bokför omföring och skapa plan') + schedules)}
    ${section('pagaende', 'Pågående arbeten · bedömningsunderlag', 'Dokumentera värden, färdigställandegrad och redovisningsprincip för granskning. Detta är ett arbetsunderlag och skapar ingen automatisk värderingsverifikation.', form('workpaper', select('Projekt', 'projectId', projects.filter(([id]) => id)) + `<div class="commercial-grid">${input('Bedömningsdatum', 'date', today, 'date', 'required')}${amount('Nedlagd kostnad (kr)', 'completedCostCents')}${amount('Avtalad intäkt (kr)', 'agreedRevenueCents')}${input('Färdigställandegrad (%)', 'completionPercent', '0', 'text', 'inputmode="decimal" required')}</div>${input('Granskare', 'reviewer', '', 'text', 'required maxlength="150"')}<label>Bedömning och vald redovisningsprincip<textarea name="reviewNote" required maxlength="2000"></textarea></label>`, 'Dokumentera bedömning', 'Spara granskningsunderlag') + papers)}
  </div>`;
}

const decimal = value => { assert(typeof value === 'string' && /^\d+(?:[,.]\d{1,2})?$/.test(value.trim()), 'Ange ett positivt tal med högst två decimaler.'); return Number(value.replace(',', '.')); };
const items = data => [1, 2, 3].filter(i => data[`article${i}`]).map(i => ({ articleId: data[`article${i}`], quantity: decimal(data[`quantity${i}`]) }));
export function handleAction(state, action, data = {}) {
  switch (action) {
    case 'save-article': return saveArticle(state, { ...data, vatRate: Number(data.vatRate), unitCents: toCents(data.unitCents), active: data.id ? state.commercialArticles.find(item => item.id === data.id)?.active : true });
    case 'activate-article': return setArticleActive(state, data.id, true);
    case 'deactivate-article': return setArticleActive(state, data.id, false);
    case 'save-price': return saveCustomerPrice(state, { ...data, unitCents: toCents(data.unitCents) });
    case 'article-invoice': return createArticleInvoice(state, { ...data, items: items(data) });
    case 'create-recurring': return createRecurringPlan(state, { ...data, items: items(data), intervalMonths: Number(data.intervalMonths), dueDays: Number(data.dueDays) });
    case 'generate-recurring': return generateRecurringInvoices(state, data);
    case 'pause-recurring': return setRecurringActive(state, data.id, false);
    case 'activate-recurring': return setRecurringActive(state, data.id, true);
    case 'reminder': return prepareReminder(state, data);
    case 'project-stock': return issueProjectStock(state, { ...data, quantity: decimal(data.quantity), unitCents: toCents(data.unitCents), vatRate: Number(data.vatRate) });
    case 'create-revenue': return createRevenueSchedule(state, { ...data, amountCents: toCents(data.amountCents), months: Number(data.months) });
    case 'recognize-revenue': return recognizeRevenueMonth(state, data.id, data);
    case 'workpaper': return addProjectWorkpaper(state, { ...data, completedCostCents: toCents(data.completedCostCents), agreedRevenueCents: toCents(data.agreedRevenueCents), completionBps: Math.round(decimal(data.completionPercent) * 100) });
    default: throw new Error('Den kommersiella åtgärden stöds inte.');
  }
}
