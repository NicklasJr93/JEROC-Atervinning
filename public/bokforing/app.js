import { STORAGE_KEY, ACCOUNTS, createState, restoreState, money, getSummary, getReports, getVatReport, bookDraft, matchBank, assistantAnswer } from './model.js';

const app = document.querySelector('#app');
const icons = {
  book: '<path d="M4 4c3-1 6 0 8 2 2-2 5-3 8-2v15c-3-1-6 0-8 2-2-2-5-3-8-2V4Z"/><path d="M12 6v15"/>',
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  documents: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  ledger: '<path d="M4 4c3-1 6 0 8 2 2-2 5-3 8-2v15c-3-1-6 0-8 2-2-2-5-3-8-2V4Z"/><path d="M12 6v15"/>',
  bank: '<path d="m3 9 9-6 9 6H3Zm2 3v6m5-6v6m4-6v6m5-6v6M3 21h18M2 18h20"/>',
  vat: '<path d="m5 20 14-16"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/>',
  reports: '<path d="M4 20V10m6 10V4m6 16v-7m5 7H2"/>',
  integrations: '<path d="m10 13 4-4m-7 6-2 2a4 4 0 0 0 6 5l4-4a4 4 0 0 0 0-6m2-3 2-2a4 4 0 0 0-6-5L9 5a4 4 0 0 0 0 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18M7 14h2m5 0h2m-9 3h2"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-11 12h4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v5m-2.5-2.5h5"/>',
  send: '<path d="m3 3 19 9-19 9 3-9-3-9Zm3 9h16"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 8.5a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 4h.01"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"/>',
  external: '<path d="M14 3h7v7m-9 2 9-9M10 4H4v16h16v-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.documents}</svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const navItems = [['overview', 'Översikt'], ['documents', 'Underlag'], ['ledger', 'Bokföring'], ['bank', 'Bank'], ['vat', 'Moms'], ['reports', 'Rapporter'], ['integrations', 'Integrationer']];
const views = new Set(navItems.map(([view]) => view));
const accountName = number => ACCOUNTS.find(a => String(a.number) === String(number))?.name ?? 'Konto';
const date = value => {
  const text = String(value ?? '');
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}/.test(text) ? `${text.slice(0, 10)}T12:00:00` : text);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short' }).format(parsed) : 'Okänt datum';
};
const integer = value => Number.isSafeInteger(value) ? value : 0;
const amount = cents => (integer(cents) / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plainAmount = cents => (integer(cents) / 100).toFixed(2).replace('.', ',');
const ghost = (size = '') => `<span class="ghost ${size}" aria-hidden="true"><span class="ghost-face"><i></i><i></i></span></span>`;
let state;
let persistenceAvailable = true;
try { const raw = localStorage.getItem(STORAGE_KEY); state = raw ? restoreState(JSON.parse(raw)) : createState(); }
catch { state = createState(); persistenceAvailable = false; }
let currentView = 'overview';
let selectedDocumentId = null;
let search = '';
let statusFilter = 'all';
let ledgerAccount = 'all';
let reportTab = 'result';
let sidebarOpen = false;
let aiOpen = false;
let aiContext = 'overview';
let toastTimer;
const draftEdits = new Map();
const messages = [{ role: 'assistant', text: 'Hej! Jag är Ande, din demoassistent. Jag hjälper dig att förstå underlagen, hitta nästa steg och granska konteringsförslag.', links: [] }];

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); persistenceAvailable = true; }
  catch { persistenceAvailable = false; toast('Webbläsaren kan inte spara just nu. Du kan fortsätta prova i den här fliken.', 'info'); }
  updateChrome();
}
function go(view, documentId = null) {
  const target = views.has(view) ? view : 'overview';
  const hash = `#${target}${documentId ? `/${encodeURIComponent(documentId)}` : ''}`;
  sidebarOpen = false;
  if (location.hash === hash) render();
  else location.hash = hash;
}
function readLocation() {
  const [view, id] = location.hash.replace(/^#/, '').split('/');
  currentView = views.has(view) ? view : 'overview';
  try { selectedDocumentId = currentView === 'documents' && id ? decodeURIComponent(id) : null; }
  catch { selectedDocumentId = null; }
  render();
}
function updateChrome() {
  document.querySelectorAll('[data-nav]').forEach(a => { const active = a.dataset.nav === currentView; a.classList.toggle('active', active); if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const count = state.documents.filter(d => d.status === 'draft').length;
  document.querySelectorAll('[data-draft-count]').forEach(el => { el.textContent = String(count); });
  document.querySelector('#storage-status').textContent = persistenceAvailable ? 'Demodata sparas i din webbläsare' : 'Demodata i den här fliken';
  document.querySelector('#sidebar').classList.toggle('is-open', sidebarOpen);
  document.querySelector('#sidebar-backdrop').hidden = !sidebarOpen;
  document.querySelector('#mobile-menu').setAttribute('aria-expanded', String(sidebarOpen));
  document.querySelector('#assistant-panel').hidden = !aiOpen;
  document.querySelector('#assistant-launcher').setAttribute('aria-expanded', String(aiOpen));
  document.querySelector('#assistant-launcher').classList.toggle('is-hidden', aiOpen);
  document.querySelector('#assistant-context').textContent = selectedDocumentId ? 'Hjälp med valt underlag' : `Du tittar på ${navItems.find(([v]) => v === currentView)?.[1].toLowerCase() ?? 'översikten'}`;
}
function toast(message, type = 'success') {
  const el = document.querySelector('#toast');
  el.innerHTML = `${icon(type === 'success' ? 'check' : 'help')}<span>${escape(message)}</span>`;
  el.className = `toast is-visible ${type}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('is-visible'), 4700);
}
function badge(status, text) { return `<span class="badge ${status}">${status === 'booked' || status === 'matched' ? icon('check') : ''}${escape(text ?? (status === 'booked' ? 'Bokförd' : 'Att granska'))}</span>`; }
function pageHeader(eyebrow, title, subtitle, actions = '') { return `<div class="page-heading"><div><p class="eyebrow">${escape(eyebrow)}</p><h1>${escape(title)}</h1><p class="page-subtitle">${escape(subtitle)}</p></div><div class="heading-actions">${actions}</div></div>`; }
function aiButton(text = 'Fråga Ande', question = '', context = '') { return `<button class="button button-lavender" data-action="ask-ai" data-question="${escape(question)}" data-context="${escape(context)}">${icon('sparkle')}${escape(text)}</button>`; }
function emptyState(title, description) { return `<div class="empty-state"><span class="empty-icon">${icon('search')}</span><h3>${escape(title)}</h3><p>${escape(description)}</p><button class="button button-secondary" data-action="clear-search">Rensa filter</button></div>`; }

function renderOverview() {
  const summary = getSummary(state);
  const draftDocs = state.documents.filter(d => d.status === 'draft');
  const recent = [...state.entries].sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number, 'sv', { numeric: true })).slice(0, 5);
  return `${pageHeader('DIN EKONOMISKA ARBETSPLATS', 'Lite mindre administration. Lite mer överblick.', 'Här är läget i Exempelbolaget. Vad vill du ta hand om idag?', `<button class="button button-primary" data-action="next-document">${icon('plus')}Granska underlag</button>`)}
    <div class="demo-intro"><span class="demo-intro-icon">${icon('sparkle')}</span><span><strong>Välkommen till din bokföringsdemo.</strong> Prova att granska ett underlag, bokföra ett förslag eller fråga Ande.</span><button data-action="ask-ai" data-question="Vad kan jag göra i demon?" class="text-button">Visa mig runt ${icon('arrow')}</button></div>
    <section class="metric-grid" aria-label="Ekonomisk översikt">
      ${metric('bank', 'Bankkonto', money(summary.bankCents), 'Saldo på företagskontot', 'blue')}
      ${metric('reports', 'Periodens resultat', money(summary.resultCents), 'Bokfört under oktober', 'green')}
      ${metric('documents', 'Att granska', String(summary.draftCount), 'Underlag som väntar på dig', 'violet', 'next-document')}
      ${metric('clock', 'Leverantörsskulder', money(summary.payablesCents), 'Bokförda, ännu inte betalda', 'amber')}
    </section>
    <div class="overview-middle">
      <section class="panel chart-panel"><div class="panel-heading"><div><h2>Bankens utveckling</h2><p>Saldo på bankkonto under demoperioden</p></div><span class="quiet-pill">${icon('calendar')}Oktober 2026</span></div>${bankChart()}<div class="chart-footer"><span><i class="legend-dot blue"></i>Företagskonto 1930</span><strong>${money(summary.bankCents)}</strong></div></section>
      <section class="panel review-panel"><div class="panel-heading"><div><h2>Ditt nästa steg</h2><p>En sak i taget räcker långt.</p></div><span class="count-pill">${draftDocs.length}</span></div><div class="review-items">${draftDocs.slice(0, 3).map((d, i) => `<button class="review-item" data-document="${escape(d.id)}"><span class="file-tile ${['blue', 'violet', 'amber'][i]}">${icon('documents')}</span><span><strong>${escape(d.supplier)}</strong><small>${escape(d.title || d.number)}</small></span><span class="review-amount">${money(d.totalCents)}${icon('chevron')}</span></button>`).join('') || '<div class="all-done">'+icon('check')+'Alla underlag är granskade. Snyggt jobbat!</div>'}</div><div class="ande-nudge">${ghost('small')}<div><strong>Vi gör det begripligt.</strong><p>Jag kan förklara ett konto eller hjälpa dig att komma vidare.</p><button class="text-button" data-action="ask-ai" data-question="Vad behöver jag granska?">Fråga Ande ${icon('arrow')}</button></div></div></section>
    </div>
    <div class="overview-bottom"><section class="panel recent-panel"><div class="panel-heading"><div><h2>Senaste verifikationer</h2><p>Det som redan är bokfört</p></div><button class="text-button" data-view="ledger">Visa huvudbok ${icon('arrow')}</button></div><div class="table-scroll"><table class="data-table"><thead><tr><th>Datum</th><th>Verifikation</th><th>Beskrivning</th><th class="number">Belopp</th><th>Status</th></tr></thead><tbody>${recent.map(e => `<tr class="clickable-row" data-entry="${escape(e.id)}" tabindex="0"><td>${escape(date(e.date))}</td><td><span class="entry-number">${escape(e.number)}</span></td><td>${escape(e.description)}</td><td class="number">${money(entryAmount(e))}</td><td>${badge('booked')}</td></tr>`).join('')}</tbody></table></div></section><section class="panel activity-panel"><div class="panel-heading"><div><h2>Senaste händelser</h2><p>Små steg framåt</p></div></div><div class="activity-list">${[...state.activity].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4).map(a => `<div class="activity-item"><span class="activity-dot"></span><div><strong>${escape(a.label)}</strong><small>${escape(date(a.date))}</small></div></div>`).join('')}</div><button class="subtle-action" data-view="bank">${icon('bank')}Stäm av banken ${icon('arrow')}</button></section></div>`;
}
function metric(name, label, value, detail, color, action = '') { const tag = action ? 'button' : 'div'; return `<${tag} class="metric-card ${action ? 'interactive' : ''}" ${action ? `data-action="${action}"` : ''}><div class="metric-top"><span class="metric-icon ${color}">${icon(name)}</span><span>${escape(label)}</span>${action ? icon('chevron', 'metric-chevron') : ''}</div><strong class="metric-value">${escape(value)}</strong><span class="metric-detail">${escape(detail)}</span></${tag}>`; }
function entryAmount(entry) { return entry.rows.reduce((sum, row) => sum + integer(row.debitCents), 0); }
function bankChart() {
  const changes = new Map();
  state.entries.forEach(e => { const value = e.rows.filter(r => String(r.account) === '1930').reduce((sum, r) => sum + integer(r.debitCents) - integer(r.creditCents), 0); if (value) { const day = Math.min(31, Math.max(1, Number(e.date.slice(8, 10)))); changes.set(day, (changes.get(day) ?? 0) + value); } });
  let balance = 0; const values = []; for (let day = 1; day <= 31; day++) { balance += changes.get(day) ?? 0; values.push({ day, balance }); }
  const min = Math.min(...values.map(v => v.balance)) * .88; const max = Math.max(...values.map(v => v.balance), 100000) * 1.05; const span = Math.max(100000, max - min);
  const points = values.map(v => ({ x: 52 + ((v.day - 1) / 30) * 628, y: 190 - ((v.balance - min) / span) * 150 }));
  const line = points.map((v, i) => `${i ? 'L' : 'M'}${v.x.toFixed(1)},${v.y.toFixed(1)}`).join(' ');
  return `<div class="chart-wrap"><svg class="balance-chart" viewBox="0 0 710 236" role="img" aria-label="Bankkontots utveckling i oktober, aktuellt saldo ${escape(money(balance))}"><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#2762f6" stop-opacity=".18"/><stop offset="100%" stop-color="#2762f6" stop-opacity=".005"/></linearGradient></defs>${[0, 1, 2, 3].map(i => { const y = 40 + i * 50; const value = max - (i / 3) * span; return `<line x1="52" x2="680" y1="${y}" y2="${y}" stroke="#edf0f6" stroke-dasharray="4 5"/><text x="42" y="${y + 4}" text-anchor="end">${Math.round(value / 100000)} tkr</text>`; }).join('')}<path d="${line} L680,202 L52,202 Z" fill="url(#chart-fill)"/><path d="${line}" fill="none" stroke="#2762f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${[0, 7, 14, 21, 30].map(i => `<circle cx="${points[i].x}" cy="${points[i].y}" r="4" fill="white" stroke="#2762f6" stroke-width="2"/><text x="${points[i].x}" y="226" text-anchor="middle">${i + 1} okt</text>`).join('')}</svg></div>`;
}

function renderDocuments() {
  const selected = state.documents.find(d => d.id === selectedDocumentId);
  if (selected) return renderDocument(selected);
  const docs = state.documents.filter(d => (statusFilter === 'all' || d.status === statusFilter) && `${d.supplier} ${d.title} ${d.number} ${d.source}`.toLowerCase().includes(search.toLowerCase()));
  return `${pageHeader('UNDERLAG', 'Allt börjar med ett underlag.', 'Granska exempelunderlagen och prova hur en affär blir bokföring.', `<button class="button button-primary" data-action="next-document">${icon('eye')}Granska nästa</button>`)}<section class="panel documents-panel"><div class="list-toolbar"><div class="tab-group" aria-label="Filtrera underlag"><button class="tab ${statusFilter === 'all' ? 'active' : ''}" data-status="all">Alla <span>${state.documents.length}</span></button><button class="tab ${statusFilter === 'draft' ? 'active' : ''}" data-status="draft">Att granska <span>${state.documents.filter(d => d.status === 'draft').length}</span></button><button class="tab ${statusFilter === 'booked' ? 'active' : ''}" data-status="booked">Bokförda</button></div><label class="search-field">${icon('search')}<input id="document-search" type="search" aria-label="Sök bland underlag" placeholder="Sök leverantör eller underlag…" value="${escape(search)}"></label></div>${docs.length ? `<div class="table-scroll"><table class="data-table document-table"><thead><tr><th>Underlag</th><th>Källa</th><th>Datum</th><th class="number">Belopp</th><th>Status</th><th><span class="sr-only">Öppna</span></th></tr></thead><tbody>${docs.map((d, i) => `<tr class="clickable-row" data-document="${escape(d.id)}" tabindex="0"><td><div class="table-document"><span class="file-tile ${['blue', 'violet', 'amber', 'green'][i % 4]}">${icon('documents')}</span><span><strong>${escape(d.supplier)}</strong><small>${escape(d.number)} · ${escape(d.title)}</small></span></div></td><td><span class="source-label"><span class="source-dot"></span>${escape(d.source)}</span></td><td>${escape(date(d.date))}</td><td class="number strong">${money(d.totalCents)}</td><td>${badge(d.status)}</td><td>${icon('chevron', 'row-arrow')}</td></tr>`).join('')}</tbody></table></div>` : emptyState('Inga underlag matchar', 'Prova ett annat sökord eller visa alla statusar.')}<div class="panel-bottom-note">${icon('lock')}Det här är exempelunderlag. Du kan tryggt prova och återställa demon.</div></section>`;
}
function getEdits(doc) { let edit = draftEdits.get(doc.id); if (!edit || edit.version !== doc.version) { edit = { version: doc.version, rows: structuredClone(doc.rows) }; draftEdits.set(doc.id, edit); } return edit; }
function renderDocument(doc) {
  const rows = doc.status === 'draft' ? getEdits(doc).rows : doc.rows;
  const reverse = rows.some(r => String(r.account) === '2614');
  return `<button class="back-link" data-action="document-back">${icon('arrow')}Till inkorgen</button>${pageHeader('GRANSKA UNDERLAG', doc.supplier, `${doc.title} · ${doc.number}`, `${badge(doc.status)}${aiButton('Förklara underlaget', 'Förklara det här underlaget och konteringsförslaget.', doc.id)}`)}<div class="document-workspace"><section class="panel preview-panel"><div class="preview-toolbar"><span>${icon('documents')}${escape(doc.number)}</span><span class="quiet-pill">Förhandsvisning</span></div><div class="invoice-paper"><div class="invoice-head"><span class="invoice-logo">${escape(doc.supplier.slice(0, 1))}</span><div><strong>${escape(doc.supplier)}</strong><small>Exempelunderlag</small></div></div><div class="invoice-title"><div><p class="eyebrow">FAKTURA / UNDERLAG</p><h2>${escape(doc.number)}</h2></div><span class="paper-stamp">DEMO</span></div><div class="invoice-parties"><div><small>Till</small><strong>${escape(state.company.name)}</strong><span>Exempelgatan 12</span><span>111 22 Stockholm</span></div><dl><div><dt>Datum</dt><dd>${escape(doc.date)}</dd></div><div><dt>Förfallodag</dt><dd>${escape(doc.dueDate)}</dd></div></dl></div><table class="invoice-lines"><thead><tr><th>Beskrivning</th><th class="number">Belopp</th></tr></thead><tbody>${(doc.items?.length ? doc.items : [{ description: doc.title, netCents: doc.netCents }]).map(item => `<tr><td>${escape(item.description)}${item.quantity ? `<small>${escape(item.quantity)} st</small>` : ''}</td><td class="number">${money(item.netCents)}</td></tr>`).join('')}</tbody></table><div class="invoice-totals"><div><span>Summa exkl. moms</span><strong>${money(doc.netCents)}</strong></div><div><span>Debiterad moms</span><strong>${money(doc.vatCents)}</strong></div><div class="invoice-total"><span>Att betala</span><strong>${money(doc.totalCents)}</strong></div></div>${reverse ? '<div class="invoice-note">Omvänd betalningsskyldighet. Moms framgår av konteringsförslaget.</div>' : ''}<div class="invoice-footer">Fiktivt underlag för att prova arbetsflödet.<br>Inga pengar skickas från den här demon.</div></div></section><section class="panel entry-editor"><div class="panel-heading"><div><h2>${doc.status === 'draft' ? 'Granska kontering' : 'Bokförd kontering'}</h2><p>${doc.status === 'draft' ? 'Kontrollera förslaget innan du bokför.' : 'Underlaget finns nu i huvudboken.'}</p></div><span class="quiet-pill">${icon('documents')}${escape(doc.source)}</span></div><div class="ai-explanation">${ghost('small')}<div><strong>${doc.status === 'draft' ? 'Ett förslag att ta ställning till' : 'Klart för nästa steg'}</strong><p>${doc.status === 'draft' ? 'Konton och belopp är förberedda. Du kan ändra raderna eller be mig förklara dem.' : 'Du kan följa verifikationen i huvudboken eller gå vidare till nästa underlag.'}</p><button class="text-button" data-action="ask-ai" data-question="Varför föreslås de här kontona?" data-context="${escape(doc.id)}">Varför dessa konton? ${icon('arrow')}</button></div></div><div class="table-scroll editor-table-wrap"><table class="editor-table"><thead><tr><th>Konto</th><th class="number">Debet, kr</th><th class="number">Kredit, kr</th><th><span class="sr-only">Ta bort</span></th></tr></thead><tbody>${rows.map((row, i) => `<tr><td>${doc.status === 'draft' ? `<select aria-label="Konto på rad ${i + 1}" data-row="${i}" data-field="account">${ACCOUNTS.map(a => `<option value="${escape(a.number)}" ${String(a.number) === String(row.account) ? 'selected' : ''}>${escape(a.number)} · ${escape(a.name)}</option>`).join('')}</select>` : `<strong>${escape(row.account)}</strong><small class="account-name">${escape(accountName(row.account))}</small>`}</td><td class="number">${doc.status === 'draft' ? `<input aria-label="Debet på rad ${i + 1}" inputmode="decimal" data-row="${i}" data-field="debitCents" value="${row.debitCents ? escape(plainAmount(row.debitCents)) : ''}" placeholder="0,00">` : amount(row.debitCents)}</td><td class="number">${doc.status === 'draft' ? `<input aria-label="Kredit på rad ${i + 1}" inputmode="decimal" data-row="${i}" data-field="creditCents" value="${row.creditCents ? escape(plainAmount(row.creditCents)) : ''}" placeholder="0,00">` : amount(row.creditCents)}</td><td>${doc.status === 'draft' && rows.length > 2 ? `<button class="icon-button remove-row" data-action="remove-row" data-row="${i}" aria-label="Ta bort rad ${i + 1}">${icon('close')}</button>` : ''}</td></tr>`).join('')}</tbody><tfoot><tr><td>Summa</td><td class="number" id="draft-debit-total"></td><td class="number" id="draft-credit-total"></td><td></td></tr></tfoot></table></div>${doc.status === 'draft' ? `<button class="text-button add-row" data-action="add-row">${icon('plus')}Lägg till rad</button>` : ''}<div id="draft-balance" class="balance-notice"></div><div id="draft-error" class="inline-error" role="alert" hidden></div><div class="editor-footer"><button class="button button-secondary" data-action="document-back">Till inkorgen</button>${doc.status === 'draft' ? `<button class="button button-primary" id="book-document" data-action="book-document">${icon('book')}Godkänn och bokför</button>` : `<button class="button button-primary" data-view="ledger">Visa i huvudboken ${icon('arrow')}</button>`}</div></section></div>`;
}
function updateDraftSummary() {
  const doc = state.documents.find(d => d.id === selectedDocumentId); if (!doc) return;
  const rows = doc.status === 'draft' ? getEdits(doc).rows : doc.rows;
  const valid = rows.every(r => Number.isSafeInteger(r.debitCents) && Number.isSafeInteger(r.creditCents) && r.debitCents >= 0 && r.creditCents >= 0);
  const debit = rows.reduce((sum, r) => sum + integer(r.debitCents), 0); const credit = rows.reduce((sum, r) => sum + integer(r.creditCents), 0); const balanced = valid && debit === credit && debit > 0;
  const debitEl = document.querySelector('#draft-debit-total'); if (!debitEl) return;
  debitEl.textContent = amount(debit); document.querySelector('#draft-credit-total').textContent = amount(credit);
  const notice = document.querySelector('#draft-balance'); notice.className = `balance-notice ${balanced ? 'balanced' : 'unbalanced'}`;
  notice.innerHTML = `${icon(balanced ? 'check' : 'help')}<div><strong>${balanced ? 'Debet och kredit balanserar' : valid ? 'Konteringen behöver justeras' : 'Kontrollera beloppen på raderna'}</strong><span>${valid ? `Differens: ${money(Math.abs(debit - credit))}` : 'Använd belopp med högst två decimaler.'}</span></div>`;
  const book = document.querySelector('#book-document'); if (book) book.disabled = !balanced;
}

function renderLedger() {
  const rows = state.entries.flatMap(entry => entry.rows.map(row => ({ ...row, entry })));
  const filtered = rows.filter(r => (ledgerAccount === 'all' || String(r.account) === ledgerAccount) && `${r.entry.number} ${r.account} ${accountName(r.account)} ${r.entry.description}`.toLowerCase().includes(search.toLowerCase()));
  return `${pageHeader('BOKFÖRING', 'Huvudbok', 'Följ varje bokförd affär, hela vägen till underlaget.', `<button class="button button-secondary" data-action="export-ledger">${icon('download')}Exportera CSV</button>${aiButton('Förklara huvudboken', 'Vad visar huvudboken?')}`)}<section class="panel"><div class="list-toolbar ledger-toolbar"><label class="field-label">Konto<select id="ledger-account"><option value="all">Alla konton</option>${ACCOUNTS.map(a => `<option value="${escape(a.number)}" ${String(a.number) === ledgerAccount ? 'selected' : ''}>${escape(a.number)} · ${escape(a.name)}</option>`).join('')}</select></label><span class="quiet-pill">${icon('calendar')}Oktober 2026</span><label class="search-field">${icon('search')}<input id="ledger-search" type="search" aria-label="Sök i huvudboken" placeholder="Sök konto, post eller verifikation…" value="${escape(search)}"></label></div>${filtered.length ? `<div class="table-scroll"><table class="data-table ledger-table"><thead><tr><th>Datum</th><th>Verifikation</th><th>Konto</th><th>Beskrivning</th><th class="number">Debet</th><th class="number">Kredit</th><th>Underlag</th></tr></thead><tbody>${filtered.map(r => `<tr class="clickable-row" data-entry="${escape(r.entry.id)}" tabindex="0"><td>${escape(date(r.entry.date))}</td><td><span class="entry-number">${escape(r.entry.number)}</span></td><td><strong>${escape(r.account)}</strong><small class="account-name">${escape(accountName(r.account))}</small></td><td>${escape(r.entry.description)}</td><td class="number">${r.debitCents ? amount(r.debitCents) : '—'}</td><td class="number">${r.creditCents ? amount(r.creditCents) : '—'}</td><td><span class="document-link">${icon(r.entry.documentId ? 'documents' : 'eye')}${r.entry.documentId ? 'Visa underlag' : 'Visa post'}</span></td></tr>`).join('')}</tbody><tfoot><tr><td colspan="4">Summa visade rader · ${filtered.length} st</td><td class="number">${amount(filtered.reduce((s, r) => s + integer(r.debitCents), 0))}</td><td class="number">${amount(filtered.reduce((s, r) => s + integer(r.creditCents), 0))}</td><td></td></tr></tfoot></table></div>` : emptyState('Inga bokföringsrader matchar', 'Prova att söka på en annan beskrivning eller välj alla konton.')}</section>`;
}
function renderBank() {
  const matched = state.bankTransactions.filter(t => t.matchedEntryId).length;
  const total = state.bankTransactions.length;
  return `${pageHeader('BANKAVSTÄMNING', 'När banken och bokföringen möts.', 'Prova att matcha exempelbetalningar mot bokförda poster.', aiButton('Hjälp mig stämma av', 'Hur stämmer jag av banken?'))}<div class="bank-summary"><span class="bank-account-icon">${icon('bank')}</span><div><strong>Företagskonto</strong><span>Exempelkonto · 1930</span></div><div class="bank-summary-balance"><small>Bokfört saldo</small><strong>${money(getSummary(state).bankCents)}</strong></div><div class="match-progress"><span>${matched} av ${total} matchade</span><progress value="${matched}" max="${total || 1}"></progress></div></div><section class="panel"><div class="panel-heading"><div><h2>Bankhändelser</h2><p>En matchning länkar bankhändelsen till rätt verifikation.</p></div>${badge('draft', `${total - matched} att stämma av`)}</div><div class="bank-events">${state.bankTransactions.map(t => { const entry = state.entries.find(e => e.id === (t.matchedEntryId || t.suggestedEntryId)); return `<div class="bank-event"><span class="bank-event-icon ${t.amountCents >= 0 ? 'green' : 'blue'}">${icon(t.amountCents >= 0 ? 'arrow' : 'documents')}</span><div class="bank-event-main"><strong>${escape(t.description)}</strong><span>${escape(date(t.date))}${entry ? ` · ${escape(entry.number)}` : ''}</span></div><strong class="bank-event-amount ${t.amountCents > 0 ? 'positive' : ''}">${money(t.amountCents)}</strong><div class="bank-match">${t.matchedEntryId ? badge('matched', 'Matchad') : t.suggestedEntryId && entry ? `<div><small>Föreslagen matchning</small><span>${escape(entry.number)} · ${escape(entry.description)}</span></div><button class="button button-primary button-small" data-action="match-bank" data-bank-id="${escape(t.id)}" data-entry-id="${escape(entry.id)}">${icon('check')}Matcha</button>` : `<span class="badge draft">Behöver granskas</span><button class="button button-secondary button-small" data-view="ledger">Visa huvudbok</button>`}</div></div>`; }).join('')}</div><div class="panel-bottom-note">${icon('lock')}Du provar avstämning med demodata. Inga bankkonton är anslutna och inga betalningar skickas.</div></section>`;
}
function renderVat() {
  const vat = getVatReport(state); const sum = getSummary(state);
  const rows = [['05', 'Momspliktig försäljning', vat.salesBaseCents], ['10', 'Utgående moms 25 %', vat.outputVatCents], ['23', 'Inköp med omvänd moms', vat.reverseBaseCents], ['30', 'Utgående moms, omvänd betalningsskyldighet', vat.reverseOutputVatCents], ['48', 'Ingående moms att dra av', vat.inputVatCents + vat.reverseInputVatCents]];
  return `${pageHeader('MOMS', 'En tydligare bild av momsen.', 'Se hur de bokförda posterna bildar ett preliminärt momsunderlag.', `<button class="button button-secondary" data-action="export-vat">${icon('download')}Ladda ned underlag</button>${aiButton('Förklara momsen', 'Förklara momsrapporten och omvänd moms.')}`)}<div class="vat-layout"><section class="panel vat-report"><div class="panel-heading"><div><h2>Momsunderlag</h2><p>Oktober 2026 · endast bokförda poster</p></div><span class="badge draft">Preliminärt</span></div><table class="data-table vat-table"><thead><tr><th>Fält</th><th>Beskrivning</th><th class="number">Belopp</th></tr></thead><tbody>${rows.map(([field, label, value]) => `<tr><td><span class="tax-field">${field}</span></td><td>${label}</td><td class="number">${money(value)}</td></tr>`).join('')}</tbody><tfoot><tr><td><span class="tax-field">49</span></td><td>${vat.payableCents >= 0 ? 'Moms att betala' : 'Moms att få tillbaka'}</td><td class="number">${money(Math.abs(vat.payableCents))}</td></tr></tfoot></table><div class="panel-bottom-note">${icon('documents')}Ingen momsdeklaration lämnas in från den här demon.</div></section><aside class="vat-side"><section class="panel preparation-card"><span class="large-soft-icon violet">${icon('vat')}</span><h2>Redo att ta nästa steg?</h2><p>Granska kvarvarande underlag och stäm av kontona innan du färdigställer en period.</p><div class="checklist"><div>${icon(sum.draftCount ? 'clock' : 'check')}<span>${sum.draftCount ? `${sum.draftCount} underlag kvar att granska` : 'Alla underlag granskade'}</span></div><div>${icon('check')}<span>Rapporten följer bokförda rader</span></div><div>${icon('lock')}<span>Demoperioden är öppen</span></div></div><button class="button button-primary" data-action="next-document">Granska underlag ${icon('arrow')}</button></section><div class="ande-nudge standalone">${ghost('small')}<div><strong>Omvänd moms kan kännas bakvänd.</strong><p>Jag hjälper dig att se vilka poster som påverkar rapporten.</p><button class="text-button" data-action="ask-ai" data-question="Förklara omvänd moms">Förklara för mig ${icon('arrow')}</button></div></div></aside></div>`;
}
function renderReports() {
  const report = getReports(state);
  const accounts = report.accounts;
  const resultRows = accounts.filter(a => Number(a.number) >= 3000 && Number(a.number) < 9000);
  const assets = accounts.filter(a => String(a.number).startsWith('1'));
  const liabilities = accounts.filter(a => String(a.number).startsWith('2'));
  const row = (a, sign = 1) => `<tr><td><button class="account-filter" data-account="${escape(a.number)}">${escape(a.number)}</button></td><td>${escape(a.name)}</td><td class="number">${money(sign * (a.debitCents - a.creditCents))}</td></tr>`;
  return `${pageHeader('RAPPORTER', 'Se siffrorna i sitt sammanhang.', 'Rapporterna uppdateras när du bokför ett nytt underlag.', `<button class="button button-secondary" data-action="export-reports">${icon('download')}Exportera CSV</button>${aiButton('Fråga om resultatet', 'Förklara företagets resultat.')}`)}<section class="panel reports-panel"><div class="list-toolbar"><div class="tab-group"><button class="tab ${reportTab === 'result' ? 'active' : ''}" data-report="result">Resultatrapport</button><button class="tab ${reportTab === 'balance' ? 'active' : ''}" data-report="balance">Balansrapport</button></div><span class="quiet-pill">${icon('calendar')}Oktober 2026</span></div><div class="report-title"><div><p class="eyebrow">${escape(state.company.name)}</p><h2>${reportTab === 'result' ? 'Resultatrapport' : 'Balansrapport'}</h2><p>1–31 oktober 2026 · kronor</p></div><span class="report-mark">${icon('reports')}</span></div>${reportTab === 'result' ? `<div class="report-highlights"><div><span>Intäkter</span><strong>${money(report.revenueCents)}</strong></div><div><span>Kostnader</span><strong>${money(report.expenseCents)}</strong></div><div class="highlight-result"><span>Periodens resultat</span><strong>${money(report.resultCents)}</strong></div></div><div class="table-scroll"><table class="data-table report-table"><thead><tr><th>Konto</th><th>Benämning</th><th class="number">Oktober 2026</th></tr></thead><tbody>${resultRows.map(a => row(a, -1)).join('')}</tbody><tfoot><tr><td></td><td>Periodens resultat</td><td class="number">${money(report.resultCents)}</td></tr></tfoot></table></div>` : `<div class="balance-columns"><div><h3>Tillgångar</h3><table class="data-table report-table"><tbody>${assets.map(a => row(a)).join('')}</tbody><tfoot><tr><td></td><td>Summa tillgångar</td><td class="number">${money(assets.reduce((sum, a) => sum + a.debitCents - a.creditCents, 0))}</td></tr></tfoot></table></div><div><h3>Eget kapital och skulder</h3><table class="data-table report-table"><tbody>${liabilities.map(a => row(a, -1)).join('')}<tr><td></td><td>Periodens resultat</td><td class="number">${money(report.resultCents)}</td></tr></tbody><tfoot><tr><td></td><td>Summa eget kapital och skulder</td><td class="number">${money(liabilities.reduce((sum, a) => sum + a.creditCents - a.debitCents, 0) + report.resultCents)}</td></tr></tfoot></table></div></div>`}<div class="panel-bottom-note">${icon('eye')}Klicka på ett kontonummer för att följa beloppet till huvudboken.</div></section>`;
}
function renderIntegrations() {
  const apiDocs = state.documents.filter(d => /scrapplanner|api/i.test(d.source));
  return `${pageHeader('INTEGRATIONER', 'Bokföringen börjar där affären sker.', 'En egen ekonomidel som kan ta emot underlag från flera verksamhetssystem.')}<div class="integration-grid"><section class="panel integration-card"><div class="integration-logo">${icon('integrations')}</div><div><span class="badge draft">Exempelanslutning</span><h2>ScrapPlanner</h2><p>Avräkningar och inköpsunderlag kan bli granskningsbara konteringsförslag.</p></div><div class="integration-count"><strong>${apiDocs.length}</strong><span>exempelunderlag i demon</span></div><button class="button button-secondary" data-action="source-documents">Visa underlag ${icon('arrow')}</button></section><section class="panel integration-card neutral"><div class="integration-logo">${icon('plus')}</div><h2>Plats för fler system</h2><p>Den fristående bokföringen planeras med ett gemensamt API för fler verksamhetsflöden.</p><span class="quiet-pill">Nästa utvecklingssteg</span></section></div><div class="integration-flow"><span>Affärsunderlag</span>${icon('arrow')}<span>Granskat förslag</span>${icon('arrow')}<span>Bokförd verifikation</span></div><div class="panel-bottom-note standalone-note">${icon('lock')}Anslutningarna här är illustrativa. Demon läser eller skriver inga uppgifter i andra system.</div>`;
}

function render() {
  const renderers = { overview: renderOverview, documents: renderDocuments, ledger: renderLedger, bank: renderBank, vat: renderVat, reports: renderReports, integrations: renderIntegrations };
  document.querySelector('#workspace').innerHTML = renderers[currentView]();
  updateChrome(); updateDraftSummary();
  document.title = `${navItems.find(([v]) => v === currentView)?.[1] ?? 'Bokföring'} · Bokföringsdemo`;
}
function renderMessages() {
  const el = document.querySelector('#assistant-messages');
  el.innerHTML = messages.map(m => `<div class="chat-message ${m.role}">${m.role === 'assistant' ? `<span class="chat-avatar">${icon('sparkle')}</span>` : ''}<div><p>${escape(m.text)}</p>${m.links?.length ? `<div class="chat-links">${m.links.filter(link => views.has(link.view)).map(link => `<button data-view="${escape(link.view)}">${escape(link.label)}${icon('arrow')}</button>`).join('')}</div>` : ''}</div></div>`).join('');
  el.scrollTop = el.scrollHeight;
}
function openAI(question = '', context = '') {
  aiOpen = true; aiContext = context || selectedDocumentId || currentView; updateChrome();
  if (question) ask(question, aiContext);
  else renderMessages();
  setTimeout(() => document.querySelector('#assistant-input').focus(), 20);
}
function ask(text, context = aiContext) {
  const question = text.trim().slice(0, 1600); if (!question) return;
  messages.push({ role: 'user', text: question, links: [] });
  try { const answer = assistantAnswer(state, question, context); messages.push({ role: 'assistant', text: answer.text, links: answer.links ?? [] }); }
  catch { messages.push({ role: 'assistant', text: 'Jag kunde inte förklara just det här. Prova en av frågorna nedan eller öppna ett underlag.', links: [] }); }
  renderMessages();
}
function parseCents(value) {
  const normalized = String(value).trim().replace(/\s/g, '').replace(',', '.'); if (!normalized) return 0;
  if (!/^\d{1,12}(?:\.\d{0,2})?$/.test(normalized)) return NaN;
  const [whole, fraction = ''] = normalized.split('.'); const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0')); return Number.isSafeInteger(cents) ? cents : NaN;
}
function downloadCsv(name, rows) {
  const cell = value => {
    let text = String(value ?? '');
    if (typeof value !== 'number' && /^\s*[=+\-@]/.test(text) && !/^[+\-]?\d+(?:[.,]\d+)?$/.test(text.trim())) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const blob = new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = href; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(href), 1000); toast('Din CSV-export är klar.');
}
function exportLedger() { downloadCsv('huvudbok-demo-oktober-2026.csv', [['Datum', 'Verifikation', 'Konto', 'Beskrivning', 'Debet', 'Kredit'], ...state.entries.flatMap(e => e.rows.map(r => [e.date, e.number, r.account, e.description, plainAmount(r.debitCents), plainAmount(r.creditCents)]))]); }
function openEntry(id) {
  const entry = state.entries.find(e => e.id === id); if (!entry) return;
  const dialog = document.querySelector('#entry-dialog');
  dialog.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">BOKFÖRD VERIFIKATION</p><h2>${escape(entry.number)}</h2></div><button class="icon-button" data-action="close-dialog" aria-label="Stäng verifikation">${icon('close')}</button></div><p class="entry-dialog-description">${escape(entry.description)}</p><div class="entry-dialog-meta"><span>${icon('calendar')}${escape(entry.date)}</span>${badge('booked')}</div><div class="table-scroll"><table class="data-table"><thead><tr><th>Konto</th><th class="number">Debet</th><th class="number">Kredit</th></tr></thead><tbody>${entry.rows.map(r => `<tr><td><strong>${escape(r.account)}</strong><small class="account-name">${escape(accountName(r.account))}</small></td><td class="number">${amount(r.debitCents)}</td><td class="number">${amount(r.creditCents)}</td></tr>`).join('')}</tbody></table></div><div class="dialog-actions">${entry.documentId ? `<button class="button button-secondary" data-document="${escape(entry.documentId)}">${icon('documents')}Visa underlag</button>` : ''}<button class="button button-primary" data-action="close-dialog">Stäng</button></div>`;
  dialog.showModal();
}

app.innerHTML = `<div class="app-shell"><aside id="sidebar" class="sidebar" aria-label="Huvudnavigation"><a class="brand" href="#overview"><span class="brand-mark">${icon('book')}</span><span>Bokföring<small>en del av ScrapPlanner</small></span></a><div class="workspace-label">DIN ARBETSPLATS</div><nav>${navItems.map(([view, label]) => `<a href="#${view}" data-nav="${view}">${icon(view)}<span>${label}</span>${view === 'documents' ? '<span class="nav-count" data-draft-count></span>' : ''}</a>`).join('')}</nav><div class="sidebar-bottom"><div class="sidebar-ande">${ghost('small')}<strong>En hjälpande ande.</strong><p>Fråga, förstå och kom vidare.</p><button class="sidebar-ai-button" data-action="ask-ai">${icon('sparkle')}Prata med Ande</button></div><button class="sidebar-help" data-action="reset">${icon('refresh')}Återställ demo</button><a class="back-to-scrapplanner" href="/kontor/">Till ScrapPlanner ${icon('external')}</a></div></aside><button id="sidebar-backdrop" class="sidebar-backdrop" aria-label="Stäng navigation" hidden></button><div class="app-body"><header class="topbar"><button id="mobile-menu" class="icon-button mobile-menu" data-action="toggle-menu" aria-label="Öppna navigation" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button><div class="topbar-breadcrumb"><span class="tiny-brand">${icon('book')}</span><span>Din bokföring</span><span class="demo-badge">DEMO</span></div><label class="global-search">${icon('search')}<input id="global-search" type="search" placeholder="Sök underlag, leverantör…" aria-label="Sök bland underlag"><kbd>↵</kbd></label><div class="company-switcher"><span class="company-icon">${icon('bank')}</span><span>Exempelbolaget AB</span></div><span class="topbar-period">${icon('calendar')}Oktober 2026</span><button class="icon-button notifications" data-action="next-document" aria-label="Visa underlag att granska">${icon('bell')}<i></i></button><span class="user-avatar" aria-label="Exempelbolaget">EB</span></header><main id="main-content" tabindex="-1"><div id="workspace" class="workspace"></div><footer class="app-footer"><span><i class="status-dot"></i><span id="storage-status"></span></span><span>En första version, skapad för att provas.</span></footer></main></div></div><button id="assistant-launcher" class="assistant-launcher" data-action="ask-ai" aria-label="Öppna Ande, AI-demoassistent" aria-expanded="false" aria-controls="assistant-panel">${ghost()}<span><strong>Fråga Ande</strong><small>Din AI-demoassistent</small></span>${icon('sparkle')}</button><section id="assistant-panel" class="assistant-panel" aria-label="Ande, AI-demoassistent" hidden><header class="assistant-header">${ghost('small')}<div><strong>Ande</strong><span>AI-demoassistent <i></i></span></div><button class="icon-button" data-action="close-ai" aria-label="Minimera Ande">${icon('close')}</button></header><p id="assistant-context" class="assistant-context"></p><div id="assistant-messages" class="assistant-messages" aria-live="polite" aria-relevant="additions"></div><div class="assistant-suggestions"><button data-quick-question="Vad behöver jag granska?">Vad återstår?</button><button data-quick-question="Förklara företagets resultat">Förklara resultatet</button><button data-quick-question="Förklara omvänd moms">Omvänd moms?</button></div><form id="assistant-form" class="assistant-form"><label class="sr-only" for="assistant-input">Fråga Ande</label><input id="assistant-input" placeholder="Fråga om en post eller rapport…" autocomplete="off" maxlength="1600"><button class="send-button" type="submit" aria-label="Skicka fråga">${icon('send')}</button></form><p class="assistant-footnote">Svar och förslag i den här demon bygger på exempeldata.</p></section><div id="toast" class="toast" role="status" aria-live="polite"></div><dialog id="entry-dialog" class="entry-dialog"></dialog><dialog id="reset-dialog" class="reset-dialog"><div class="dialog-heading"><h2>Börja om från början?</h2><button class="icon-button" data-action="close-dialog" aria-label="Avbryt">${icon('close')}</button></div><p>Dina ändringar i den här bokföringsdemon ersätts med de ursprungliga exempeluppgifterna.</p><div class="dialog-actions"><button class="button button-secondary" data-action="close-dialog">Avbryt</button><button class="button button-primary" data-action="confirm-reset">${icon('refresh')}Återställ demo</button></div></dialog>`;

document.addEventListener('click', event => {
  const el = event.target.closest('button, a, [data-document], [data-entry]'); if (!el) return;
  if (el.classList.contains('skip-link')) { event.preventDefault(); const main = document.querySelector('#main-content'); main.focus(); main.scrollIntoView({ block: 'start' }); return; }
  if (el.dataset.nav) { event.preventDefault(); go(el.dataset.nav); return; }
  if (el.dataset.document) { document.querySelectorAll('dialog[open]').forEach(d => d.close()); go('documents', el.dataset.document); return; }
  if (el.dataset.entry && !el.dataset.action) { openEntry(el.dataset.entry); return; }
  if (el.dataset.view) { go(el.dataset.view); return; }
  if (el.dataset.account) { ledgerAccount = el.dataset.account; search = ''; go('ledger'); return; }
  if (el.dataset.status) { statusFilter = el.dataset.status; render(); return; }
  if (el.dataset.report) { reportTab = el.dataset.report; render(); return; }
  if (el.dataset.quickQuestion) { ask(el.dataset.quickQuestion, selectedDocumentId || currentView); return; }
  const action = el.dataset.action;
  if (action === 'ask-ai') openAI(el.dataset.question, el.dataset.context);
  if (action === 'close-ai') { aiOpen = false; updateChrome(); document.querySelector('#assistant-launcher').focus(); }
  if (action === 'toggle-menu') { sidebarOpen = !sidebarOpen; updateChrome(); }
  if (action === 'clear-search') { search = ''; statusFilter = 'all'; ledgerAccount = 'all'; document.querySelector('#global-search').value = ''; render(); }
  if (action === 'next-document') { search = ''; const doc = state.documents.find(d => d.status === 'draft'); if (doc) go('documents', doc.id); else { toast('Alla underlag är bokförda. Du kan återställa demon och prova igen.', 'info'); go('documents'); } }
  if (action === 'document-back') { selectedDocumentId = null; go('documents'); }
  if (action === 'add-row' || action === 'remove-row') { const doc = state.documents.find(d => d.id === selectedDocumentId); if (doc?.status !== 'draft') return; const edit = getEdits(doc); if (action === 'add-row') edit.rows.push({ account: String(ACCOUNTS[0].number), debitCents: 0, creditCents: 0 }); else edit.rows.splice(Number(el.dataset.row), 1); render(); }
  if (action === 'book-document') {
    const doc = state.documents.find(d => d.id === selectedDocumentId); if (!doc || doc.status !== 'draft') return;
    try { const edit = getEdits(doc); state = bookDraft(state, doc.id, edit.rows, edit.version); draftEdits.delete(doc.id); persist(); render(); toast(`${doc.number} är bokförd. Huvudbok och rapporter är uppdaterade.`); }
    catch (error) { const box = document.querySelector('#draft-error'); if (box) { box.textContent = error.message; box.hidden = false; } else toast(error.message, 'info'); }
  }
  if (action === 'match-bank') { try { state = matchBank(state, el.dataset.bankId, el.dataset.entryId); persist(); render(); toast('Bankhändelsen är matchad med verifikationen.'); } catch (error) { toast(error.message, 'info'); } }
  if (action === 'source-documents') { statusFilter = 'all'; search = 'ScrapPlanner'; document.querySelector('#global-search').value = ''; go('documents'); }
  if (action === 'export-ledger') exportLedger();
  if (action === 'export-reports') { const report = getReports(state); downloadCsv('kontosaldon-demo-oktober-2026.csv', [['Konto', 'Benämning', 'Debet', 'Kredit', 'Saldo'], ...report.accounts.map(a => [a.number, a.name, plainAmount(a.debitCents), plainAmount(a.creditCents), plainAmount(a.debitCents - a.creditCents)])]); }
  if (action === 'export-vat') { const vat = getVatReport(state); downloadCsv('momsunderlag-demo-oktober-2026.csv', [['Post', 'Belopp'], ['Momspliktig försäljning', plainAmount(vat.salesBaseCents)], ['Utgående moms', plainAmount(vat.outputVatCents)], ['Ingående moms', plainAmount(vat.inputVatCents)], ['Omvänd utgående moms', plainAmount(vat.reverseOutputVatCents)], ['Omvänd ingående moms', plainAmount(vat.reverseInputVatCents)], ['Moms att betala', plainAmount(vat.payableCents)]]); }
  if (action === 'reset') document.querySelector('#reset-dialog').showModal();
  if (action === 'close-dialog') el.closest('dialog')?.close();
  if (action === 'confirm-reset') { state = createState(); draftEdits.clear(); messages.splice(1); search = ''; ledgerAccount = 'all'; statusFilter = 'all'; document.querySelector('#global-search').value = ''; document.querySelector('#reset-dialog').close(); persist(); renderMessages(); go('overview'); toast('Demon är återställd. Du kan börja om.'); }
});
document.querySelector('#sidebar-backdrop').addEventListener('click', () => { sidebarOpen = false; updateChrome(); });
document.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('tr[data-document], tr[data-entry]')) { event.preventDefault(); event.target.click(); }
  if (event.key === 'Escape') { if (aiOpen) { aiOpen = false; updateChrome(); document.querySelector('#assistant-launcher').focus(); } sidebarOpen = false; updateChrome(); }
});
document.addEventListener('input', event => {
  const el = event.target;
  if (el.id === 'document-search' || el.id === 'ledger-search') { const start = el.selectionStart; const id = el.id; search = el.value; render(); const replacement = document.getElementById(id); replacement.focus(); replacement.setSelectionRange(start, start); }
  if (el.matches('[data-row][data-field]') && el.dataset.field !== 'account') { const doc = state.documents.find(d => d.id === selectedDocumentId); if (doc?.status !== 'draft') return; const edit = getEdits(doc); const row = edit.rows[Number(el.dataset.row)]; if (!row) return; const value = parseCents(el.value); row[el.dataset.field] = value; if (Number.isSafeInteger(value) && value > 0) { const other = el.dataset.field === 'debitCents' ? 'creditCents' : 'debitCents'; row[other] = 0; const input = document.querySelector(`[data-row="${el.dataset.row}"][data-field="${other}"]`); if (input) input.value = ''; } const error = document.querySelector('#draft-error'); if (error) error.hidden = true; updateDraftSummary(); }
});
document.addEventListener('change', event => {
  const el = event.target;
  if (el.id === 'ledger-account') { ledgerAccount = el.value; render(); }
  if (el.matches('select[data-row][data-field="account"]')) { const doc = state.documents.find(d => d.id === selectedDocumentId); if (doc?.status === 'draft') getEdits(doc).rows[Number(el.dataset.row)].account = el.value; }
});
document.querySelector('#global-search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search = event.target.value; statusFilter = 'all'; go('documents'); } });
document.querySelector('#assistant-form').addEventListener('submit', event => { event.preventDefault(); const input = document.querySelector('#assistant-input'); const value = input.value; input.value = ''; ask(value, selectedDocumentId || currentView); input.focus(); });
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
window.addEventListener('hashchange', () => { readLocation(); window.scrollTo({ top: 0, behavior: 'instant' }); });
readLocation();
