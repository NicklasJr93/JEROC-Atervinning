import { getInvoiceTotals, getInvoiceOutstanding } from './sales.js';
import { getBillOutstanding } from './operations.js';
import { calculateLineAmounts } from './rot.js';
import { getReports } from './finance.js';
import { ghost, icon, nav } from './views.js';
import { featureNavigation } from './feature-workspaces.js';

const ENDPOINT = '/api/bokforing/ande';
// Map only known server codes. Raw upstream messages may contain private data.
function answerError(status, code) {
  const messages = {
    ANDE_RESPONSE_LIMIT: 'Andes svar blev för långt och kunde inte slutföras. Prova en mer avgränsad fråga.',
    ANDE_PROVIDER_TIMEOUT: 'AI-tjänsten hann inte svara. Försök igen eller ställ en kortare fråga.',
    ANDE_PROVIDER_PROTOCOL: 'AI-tjänsten gav ett ofullständigt svar. Försök igen.',
    ANDE_PROVIDER_RATE_LIMIT: 'OpenAI begränsar anropen just nu. Vänta en stund och försök igen.',
    ANDE_PROVIDER_UNAVAILABLE: 'Det gick inte att få kontakt med AI-tjänsten. Försök igen om en stund.',
    ANDE_PROVIDER_REFUSAL: 'Ande kunde inte hjälpa till med frågan. Prova att beskriva bokföringsfrågan på ett annat sätt.',
    ande_busy: 'Ande arbetar fortfarande med en fråga. Vänta tills den är färdig och försök igen.',
    ande_minute_limit: 'Ande har fått många frågor på kort tid. Vänta en minut och försök igen.',
    ande_invalid_input: 'Frågan eller underlaget kunde inte läsas. Prova Nytt samtal och ställ frågan igen.',
    ANDE_INVALID_INPUT: 'Frågan eller underlaget kunde inte läsas. Prova Nytt samtal och ställ frågan igen.',
  };
  if (typeof code === 'string' && Object.hasOwn(messages, code)) return messages[code];
  if (status === 429) return 'AI-testets användningsgräns är nådd. Försök igen senare.';
  if (status === 401) return 'Demosessionen behöver förnyas. Tryck på Kontrollera anslutning.';
  if (status === 403) return 'Åtkomsten kunde inte bekräftas. Kontrollera anslutningen igen.';
  return 'Ande kunde inte svara just nu. Ingen bokföring har ändrats.';
}
const labels = new Map([...nav, ...featureNavigation]);
const cleanText = (value, maximum = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maximum) : '';
const amount = value => Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000_000 ? value : 0;
const count = values => Array.isArray(values) ? values.length : 0;
const identifier = value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value ?? '') ? value : '';
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value : '';
const documentLine = line => {
  const result = {};
  for (const key of ['description', 'kind', 'vatMode']) if (typeof line[key] === 'string') result[key] = cleanText(line[key], key === 'description' ? 160 : 40);
  if (/^\d{4}$/.test(line.account ?? '')) result.account = line.account;
  for (const key of ['quantity', 'unitCents', 'netCents', 'vatCents', 'grossCents', 'discountBps', 'vatRate', 'deductibleBps']) {
    if (Number.isFinite(line[key])) result[key] = line[key];
  }
  if (typeof line.unitPriceIncludesVat === 'boolean') result.unitPriceIncludesVat = line.unitPriceIncludesVat;
  return result;
};

/** Explicit allowlist: never serialise state, customer profiles, payroll people,
 * bank references, attachments or invoice recipient/sender details. */
export function buildAndeContext(state, ui = {}) {
  const view = labels.has(ui.view) ? ui.view : 'overview';
  const report = getReports(state);
  const figures = Object.fromEntries(['bankCents', 'assetsCents', 'liabilitiesEquityCents', 'revenueCents', 'expenseCents', 'resultCents', 'receivablesCents', 'payablesCents'].map(key => [key, amount(report[key])]));
  figures.balanced = report.balanced === true;
  const context = {
    schemaVersion: 1, source: 'browser-demo', view, route: `#${view}`, label: labels.get(view) ?? 'Översikt',
    fiscalYear: { start: date(state.company?.fiscalYearStart), end: date(state.company?.fiscalYearEnd) },
    overview: {
      invoiceDrafts: (state.invoices ?? []).filter(item => item.status === 'draft').length,
      purchaseDrafts: (state.bills ?? []).filter(item => item.status === 'draft').length,
      unmatchedBankEvents: (state.bankTransactions ?? []).filter(item => !item.matchedEntryId).length,
      journalEntries: count(state.entries), figures,
    }, selected: null,
  };
  const invoice = view === 'sales' && ui.invoiceMode !== 'new' && (state.invoices ?? []).find(item => item.id === ui.invoiceId);
  const bill = view === 'purchases' && !['new', 'copy', 'inbox'].includes(ui.purchaseMode) && (state.bills ?? []).find(item => item.id === ui.billId);
  const entry = view === 'ledger' && (state.entries ?? []).find(item => item.id === ui.entryId);
  if (invoice) {
    const totals = getInvoiceTotals(invoice);
    context.selected = { kind: 'customer-invoice', id: identifier(invoice.id), number: cleanText(invoice.number, 100),
      status: cleanText(invoice.status, 40), date: date(invoice.date), dueDate: date(invoice.dueDate),
      netCents: amount(totals.netCents), vatCents: amount(totals.vatCents), totalCents: amount(totals.grossCents),
      outstandingCents: amount(getInvoiceOutstanding(invoice)), rotCents: amount(totals.rotCents),
      vatMode: cleanText(invoice.vatMode, 40), lineCount: count(invoice.lines), lines: (invoice.lines ?? []).slice(0, 12).map(line => documentLine({ ...line, ...calculateLineAmounts(line, invoice.vatMode, invoice.invoiceDiscountBps ?? 0) })) };
  } else if (bill) {
    context.selected = { kind: 'supplier-invoice', id: identifier(bill.id), number: cleanText(bill.number, 100),
      status: cleanText(bill.status, 40), date: date(bill.date), dueDate: date(bill.dueDate),
      netCents: amount(bill.netCents), vatCents: amount(bill.vatCents), totalCents: amount(bill.totalCents),
      outstandingCents: amount(getBillOutstanding(bill)), vatMode: cleanText(bill.vatMode, 40),
      lineCount: count(bill.lines) || 1,
      lines: (bill.lines ?? [{ account: bill.account, netCents: bill.netCents, vatMode: bill.vatMode, vatRate: bill.vatRate }]).slice(0, 12).map(documentLine) };
  } else if (entry) {
    context.selected = { kind: 'journal-entry', id: identifier(entry.id), number: cleanText(entry.number, 100),
      date: date(entry.date), lineCount: count(entry.rows),
      lines: (entry.rows ?? []).slice(0, 12).map(row => ({ account: /^\d{4}$/.test(row.account ?? '') ? row.account : '',
        debitCents: amount(row.debitCents), creditCents: amount(row.creditCents) })) };
  }
  if (context.selected?.id) context.route += `/${encodeURIComponent(context.selected.id)}`;
  return context;
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function safeCitation(value) {
  if (typeof value !== 'string') return null;
  try {
    const target = new URL(value, location.origin);
    if (target.origin === location.origin && target.pathname === '/bokforing/wiki/' && /^#artikel\/[a-z0-9-]+$/.test(target.hash)) return target.pathname + target.hash;
    if (target.protocol === 'https:' && ['www.skatteverket.se', 'skatteverket.se', 'www.bfn.se', 'bfn.se', 'www.riksdagen.se'].includes(target.hostname)) return target.href;
  } catch { /* Untrusted model URLs are never inserted. */ }
  return null;
}

export function createAndeClient({ getState, getUi, panel = document.querySelector('#suite-assistant'), fetchImpl = (...args) => fetch(...args) }) {
  if (!panel) throw new Error('Andes panel saknas.');
  let status = null, statusRequest = null, history = [], pending = null, sequence = 0, contextSignature = '', destroyed = false;
  panel.classList.add('ande-connected-panel');
  panel.innerHTML = `<header>${ghost()}<div><strong>Ande</strong><small id="ande-model-status">AI-stöd för din demobokföring</small></div><button class="icon-button" data-action="toggle-assistant" aria-label="Stäng Ande">${icon('x')}</button></header>
    <div class="ande-toolbar"><button type="button" id="ande-new" class="ande-text-button">Nytt samtal</button><button type="button" id="ande-refresh" class="ande-text-button">Kontrollera anslutning</button></div>
    <p id="ande-connection" class="ande-connection" role="status">Öppna Ande för att kontrollera anslutningen.</p>
    <details class="ande-context"><summary id="ande-context-summary">Underlag till Ande</summary><label class="ande-context-choice"><input type="checkbox" id="ande-share-context" checked><span>Bifoga aktuell demovy</span></label><p>Rapportsummor, valda fakturabelopp, högst tolv radtexter och antal öppna poster skickas till OpenAI tillsammans med din fråga och samtalshistorik. Kundregister, personnummerfält, betalningsuppgifter och filer bifogas inte. Använd bara fiktiva uppgifter, även i radtexterna.</p><pre id="ande-context-preview"></pre></details>
    <div id="assistant-messages" class="assistant-messages" role="log" aria-label="Samtal med Ande" aria-live="polite" aria-relevant="additions"></div>
    <p id="ande-error" class="ande-error" role="alert" hidden></p>
    <div class="assistant-suggestions"><button type="button" data-ande-question="Vad behöver jag kontrollera i den här vyn?">Mitt nästa steg</button><button type="button" data-ande-question="Förklara konteringen och vilka uppgifter jag behöver kontrollera.">Förklara kontering</button><button type="button" data-ande-question="Vilka underlag behöver redovisningskonsulten för att granska detta?">Inför granskning</button></div>
    <form id="assistant-form"><label class="sr-only" for="assistant-input">Fråga Ande</label><textarea id="assistant-input" rows="2" placeholder="Ställ en fråga om demobokföringen…" required maxlength="1600"></textarea><button id="ande-send" class="button primary" aria-label="Skicka fråga" type="submit">${icon('arrow')}</button><button id="ande-stop" class="button secondary" type="button" hidden>Avbryt</button></form>
    <p class="ande-boundary">AI-förslag behöver granskas. Ande bokför, betalar eller deklarerar inte. Samtalet finns i denna flik tills du laddar om sidan eller väljer Nytt samtal.</p>`;
  const find = selector => panel.querySelector(selector);
  const messages = find('#assistant-messages'), input = find('#assistant-input'), error = find('#ande-error');
  const share = find('#ande-share-context');
  const add = (text, role, contextLabel, citations) => {
    const bubble = make('div', `chat-bubble ${role}`);
    if (contextLabel) bubble.append(make('small', 'ande-message-context', contextLabel));
    bubble.append(make('div', 'ande-message-text', text));
    if (Array.isArray(citations)) {
      const references = make('div', 'ande-citations');
      for (const citation of citations.slice(0, 8)) {
        const href = safeCitation(citation?.url ?? citation?.href);
        if (!href) continue;
        const link = make('a', '', cleanText(citation.title ?? citation.label ?? 'Läs underlaget', 120));
        link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; references.append(link);
      }
      if (references.childElementCount) bubble.append(references);
    }
    messages.append(bubble); messages.scrollTop = messages.scrollHeight;
    return bubble;
  };
  const showError = text => { error.textContent = text; error.hidden = !text; };
  const controls = () => {
    const busy = Boolean(pending), available = status?.available === true;
    input.disabled = busy || !available;
    find('#ande-send').disabled = busy || !available;
    find('#ande-stop').hidden = !busy;
    find('#ande-new').disabled = busy;
    panel.querySelectorAll('[data-ande-question]').forEach(button => { button.disabled = busy || !available; });
    messages.setAttribute('aria-busy', String(busy));
  };
  const showStatus = () => {
    const available = status?.available === true;
    find('#ande-model-status').textContent = available ? 'Ansluten till OpenAI · demodata' : 'AI-stöd för din demobokföring';
    find('#ande-connection').textContent = available ? 'Ande är ansluten. Svar är förslag som du granskar.'
      : status?.reason || 'AI-anslutningen är inte tillgänglig ännu. Tryck på Kontrollera anslutning för att försöka igen.';
    find('#ande-connection').dataset.available = String(available);
    controls();
  };
  const context = () => share.checked ? buildAndeContext(getState(), getUi()) : null;
  function cancel(reason = 'Svaret avbröts. Du kan ställa frågan igen.') {
    if (!pending) return;
    sequence++;
    pending.abort(); pending = null;
    controls();
    if (reason) showError(reason);
  }
  function refreshContext() {
    if (destroyed) return;
    let current;
    try { current = context(); } catch { current = null; }
    const nextSignature = JSON.stringify(current);
    if (contextSignature && nextSignature !== contextSignature) {
      cancel('Underlaget ändrades medan Ande arbetade. Ställ frågan igen med den nya vyn.');
      history = [];
    }
    contextSignature = nextSignature;
    const caption = current ? `${current.label}${current.selected?.number ? ` · ${current.selected.number}` : ''}` : 'Ingen demodata bifogas';
    find('#ande-context-summary').textContent = `Underlag: ${caption}`;
    find('#ande-context-preview').textContent = current ? JSON.stringify(current, null, 2) : 'Bara din fråga och samtalets tidigare meddelanden skickas.';
  }
  async function checkStatus() {
    if (destroyed) return;
    statusRequest?.abort();
    const controller = new AbortController(); statusRequest = controller;
    const timer = setTimeout(() => controller.abort(), 12000);
    find('#ande-connection').textContent = 'Kontrollerar AI-anslutningen…';
    try {
      const response = await fetchImpl(`${ENDPOINT}/status`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
      const value = await response.json();
      if (statusRequest !== controller || destroyed) return;
      const previousSession = status?.sessionGeneration ?? status?.csrfToken;
      const nextSession = value?.sessionGeneration ?? value?.csrfToken;
      if (response.ok && previousSession && nextSession && previousSession !== nextSession) reset();
      status = response.ok && value && typeof value === 'object' ? value
        : { available: false, authenticated: response.status === 401 ? false : undefined, reason: 'AI-anslutningen kunde inte kontrolleras. Försök igen.' };
    } catch {
      if (statusRequest !== controller || destroyed) return;
      status = { available: false, reason: 'AI-anslutningen kunde inte kontrolleras. Försök igen.' };
    } finally {
      clearTimeout(timer);
      if (statusRequest === controller) { statusRequest = null; showStatus(); }
    }
  }
  async function ask(question) {
    const text = typeof question === 'string' ? question.trim() : '';
    if (!text || text.length > 1600 || pending || destroyed) return;
    if (!status?.available) { showError('Tryck på Kontrollera anslutning innan du frågar Ande.'); return; }
    refreshContext();
    const submittedContext = context();
    const submittedSignature = JSON.stringify(submittedContext);
    const requestHistory = history.slice(-6).map(message => ({ role: message.role, content: message.content.slice(0, 2000) }));
    const controller = new AbortController(), id = ++sequence;
    pending = controller; input.value = ''; showError(''); controls();
    const caption = submittedContext?.label ?? 'Utan demodata';
    add(text, 'user', caption);
    const thinking = add('Ande läser underlaget…', 'assistant ande-thinking');
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetchImpl(`${ENDPOINT}/chat`, { method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(status.csrfToken ? { 'X-CSRF-Token': status.csrfToken } : {}) },
        body: JSON.stringify({ question: text, history: requestHistory, context: submittedContext }) });
      let value; try { value = await response.json(); } catch { value = null; }
      if (id !== sequence || destroyed) return;
      if (!response.ok) {
        if (response.status === 401) { status = { available: false, reason: 'Demosessionen behöver förnyas. Tryck på Kontrollera anslutning.' }; showStatus(); }
        input.value = text;
        showError(answerError(response.status, value?.code)); return;
      }
      if (typeof value?.text !== 'string' || !value.text.trim() || value.text.length > 20000) throw new Error('Ogiltigt svar');
      if (JSON.stringify(context()) !== submittedSignature) { showError('Underlaget ändrades. Ställ frågan igen med den nya vyn.'); return; }
      add(value.text, 'assistant', caption, value.citations);
      history.push({ role: 'user', content: text }, { role: 'assistant', content: value.text });
      history = history.slice(-6);
    } catch (cause) {
      if (id !== sequence || destroyed) return;
      input.value = text;
      showError(cause?.name === 'AbortError' ? 'Ande hann inte svara. Du kan försöka igen.' : 'Ande kunde inte svara just nu. Ingen bokföring har ändrats.');
    } finally {
      clearTimeout(timeout); thinking.remove();
      if (id === sequence) { pending = null; controls(); if (!panel.hidden && !input.disabled) input.focus(); }
    }
  }
  function reset() {
    cancel(''); history = []; messages.replaceChildren(); input.value = ''; showError('');
    add('Hej! Jag hjälper dig förstå demobokföringen och förbereda förslag. Ställ en fråga eller välj ett förslag nedan. Använd fiktiva uppgifter även i frågan.', 'assistant');
    refreshContext(); controls();
  }
  const onSubmit = event => { event.preventDefault(); event.stopPropagation(); void ask(input.value); };
  const onKey = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void ask(input.value); }
  };
  const onClick = event => {
    const target = event.target.closest('button');
    if (!target || !panel.contains(target) || target.dataset.action === 'toggle-assistant') return;
    event.stopPropagation();
    if (target.id === 'ande-new') reset();
    if (target.id === 'ande-refresh') void checkStatus();
    if (target.id === 'ande-stop') cancel();
    if (target.dataset.andeQuestion) void ask(target.dataset.andeQuestion);
  };
  find('#assistant-form').addEventListener('submit', onSubmit);
  input.addEventListener('keydown', onKey);
  panel.addEventListener('click', onClick);
  share.addEventListener('change', refreshContext);
  reset();
  return {
    open() { refreshContext(); void checkStatus(); },
    close() { cancel('Svaret avbröts när du stängde Ande.'); statusRequest?.abort(); statusRequest = null; },
    ask, reset, refreshContext,
    destroy() { destroyed = true; cancel(''); statusRequest?.abort(); find('#assistant-form').removeEventListener('submit', onSubmit); input.removeEventListener('keydown', onKey); panel.removeEventListener('click', onClick); share.removeEventListener('change', refreshContext); },
  };
}
