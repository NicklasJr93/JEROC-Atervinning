/* Local design prototype only. No API requests, provider calls or persistence. */
const icon = (name, size = 18) => window.icon(name, size);
for (const element of document.querySelectorAll('[data-icon]')) element.innerHTML = icon(element.dataset.icon);
const items = [['LayoutDashboard','Översikt'],['Scale','Invägningar'],['ClipboardCheck','Kundgodkännande'],['BadgeCheck','Attest'],['Wallet','Utbetalningar'],['Users','Kunder'],['ClipboardList','Arbetsorder'],['Package','Lager'],['Boxes','Kärl & containrar'],['Truck','Transportplanering'],['UserRound','Personal'],['FileText','Artiklar & priser'],['PlugZap','Integrationer'],['Leaf','Miljörapportering'],['Building2','Anläggningar']];
document.querySelector('#navigation').innerHTML = items.map(([name, label]) => `<a class="nav-item${label === 'Integrationer' ? ' active' : ''}" href="#${label === 'Integrationer' ? 'integrationer' : 'demo'}">${icon(name, 18)}<span>${label}</span></a>`).join('');
let toastTimer;
function toast(message) { const element = document.querySelector('#toast'); element.textContent = message; element.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, 3500); }
const currency = value => value.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function updatePreview() {
  const site = document.querySelector('#preview-site').value, reverse = document.querySelector('#preview-kind').value === 'reverse';
  const days = Number(document.querySelector('#payment-term').value);
  const date = new Date('2026-10-12T12:00:00Z'); date.setUTCDate(date.getUTCDate() + days);
  const center = document.querySelector(`.cost-center[data-site="${site}"]`);
  document.querySelector('#preview-center').textContent = center.selectedOptions[0].textContent;
  document.querySelector('#preview-term').textContent = document.querySelector('#payment-term').selectedOptions[0].textContent;
  document.querySelector('#preview-date').textContent = date.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Stockholm' });
  document.querySelector('#due-caption').textContent = days === 0 ? 'Förfallodatum = avräkningsdatum' : `${days} kalenderdag${days === 1 ? '' : 'ar'} efter avräkningsdatumet`;
  document.querySelector('#preview-tax').textContent = reverse ? 'Omvänd moms · 25 %' : 'Privatinköp · ingen moms';
  const override = document.getElementById(`override-${site}`), overrideEnabled = !override.querySelector('.inherit-check').checked;
  const purchaseAccount = overrideEnabled ? override.querySelectorAll('select')[reverse ? 1 : 0].value : document.querySelector(reverse ? '#reverse-account' : '#private-account').value;
  const rows = reverse ? [[purchaseAccount,1000,0],['2647',250,0],['2614',0,250],['2440',0,1000]] : [[purchaseAccount,1000,0],['2440',0,1000]];
  document.querySelector('#journal-rows').innerHTML = rows.map(([account, debit, credit]) => `<div class="journal-row"><span>${account}</span><span>${debit ? currency(debit) : '—'}</span><span>${credit ? currency(credit) : '—'}</span></div>`).join('');
  const mapped = [...document.querySelectorAll('.cost-center')].filter(select => select.value).length;
  document.querySelector('#locations-status').textContent = mapped === 2 ? '2 av 2 kopplade' : `${mapped} av 2 med kostnadsställe`;
}
document.addEventListener('change', event => {
  if (event.target.matches('.inherit-check')) {
    const site = event.target.dataset.site;
    for (const select of document.getElementById(`override-${site}`).querySelectorAll('select')) select.disabled = event.target.checked;
    const button = document.querySelector(`.inherit-button[data-site="${site}"]`);
    button.innerHTML = `${icon('Link',12)}${event.target.checked ? 'Gemensamma' : 'Egna konton'}${icon('ChevronDown',12)}`;
  }
  updatePreview();
});
for (const button of document.querySelectorAll('.inherit-button')) button.addEventListener('click', () => {
  const element = document.getElementById(`override-${button.dataset.site}`); element.hidden = !element.hidden; button.setAttribute('aria-expanded', String(!element.hidden));
});
document.querySelector('#save').addEventListener('click', () => toast('Mockup: inställningarna är granskade. Inget har sparats eller skickats.'));
document.querySelector('#reset').addEventListener('click', () => location.reload());
document.querySelector('#fetch-choices').addEventListener('click', () => toast('Mockup: här hämtas kontoplan, momskoder, betalvillkor och kostnadsställen från Spiris.'));
document.querySelector('#check-connection').addEventListener('click', () => toast('Mockup: den befintliga animerade integrationsdialogen öppnas här.'));
document.querySelector('#history-tab').addEventListener('click', () => toast('Mockup: här visas överföringar, viktkort, status och svar från Spiris.'));
updatePreview();
