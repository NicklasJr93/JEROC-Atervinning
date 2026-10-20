import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Building2, CalendarDays, CheckCircle2, Download, FileSpreadsheet, Info, LoaderCircle, ReceiptText, RefreshCw, SearchCheck } from 'lucide-react';
import { exportPlatformUsage, PlatformUsageError, platformUsageScope, platformUsageScopeKey, readPlatformUsage, stockholmUsageMonth,
  type PlatformUsageData, type PlatformUsageScope, type PlatformUsageService } from './platform-usage-client';
import type { AuthenticatedPlatformSession, PlatformCompany } from './types';
import './platform-usage.css';

const number = (value: number) => value.toLocaleString('sv-SE');
const money = (minor: number) => new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', minimumFractionDigits: 2 }).format(minor / 100);
const monthLabel = (month: string) => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)
  ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', month: 'long', year: 'numeric' }).format(new Date(`${month}-15T12:00:00Z`)) : 'vald månad';
const serviceLabel = (service: string) => service === 'roaring.person.lookup' ? 'Personuppslag · Roaring' : service;
const channelLabel = (channel: string) => channel === 'customer_registration' ? 'Kundregistrering' : channel;
const messageOf = (error: unknown) => error instanceof PlatformUsageError ? error.message : 'Underlaget kunde inte hämtas. Kontrollera anslutningen och försök igen.';
type Result = { key: string; phase: 'loading' | 'ready' | 'error'; data?: PlatformUsageData; error?: string };

export default function PlatformUsage({ session, companies }: { session: AuthenticatedPlatformSession; companies: PlatformCompany[] }) {
  const scope = platformUsageScope(session);
  if (!scope.allowed) return null;
  // Changing the actual administrator, scope or session disposes every loaded
  // aggregate and aborts in-flight exports before mounting the next view.
  return <UsagePanel key={scope.key} scope={scope} companies={companies} />;
}

function UsagePanel({ scope, companies }: { scope: PlatformUsageScope; companies: PlatformCompany[] }) {
  const [month, setMonth] = useState(stockholmUsageMonth), [companyId, setCompanyId] = useState('');
  const [refresh, setRefresh] = useState(0), [result, setResult] = useState<Result>();
  const [downloading, setDownloading] = useState(false), [downloadError, setDownloadError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(true), exportController = useRef<AbortController | undefined>(undefined), objectUrls = useRef(new Set<string>());
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const queryKey = JSON.stringify([month, companyId]), queryRef = useRef(queryKey); queryRef.current = queryKey;
  const current = () => mounted.current && scopeRef.current.key === platformUsageScopeKey();
  const activeResult = result?.key === queryKey ? result : undefined;
  const data = activeResult?.data, validMonth = /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month);
  const loading = validMonth && (!activeResult || activeResult.phase === 'loading');

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; exportController.current?.abort(); for (const url of objectUrls.current) URL.revokeObjectURL(url); objectUrls.current.clear(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); exportController.current?.abort(); exportController.current = undefined;
    setDownloading(false); setDownloadError(''); setNotice('');
    if (!validMonth) { setResult(undefined); return () => controller.abort(); }
    setResult({ key: queryKey, phase: 'loading' });
    void readPlatformUsage(scope, { month, companyId }, controller.signal).then(value => {
      if (!controller.signal.aborted && current() && queryRef.current === queryKey) setResult({ key: queryKey, phase: 'ready', data: value });
    }).catch(error => {
      if (controller.signal.aborted || !current() || queryRef.current !== queryKey) return;
      setResult({ key: queryKey, phase: 'error', error: messageOf(error) });
      if (error instanceof PlatformUsageError && [401, 403].includes(error.status)) window.dispatchEvent(new Event('scrappilot:check-platform-session'));
    });
    return () => controller.abort();
  }, [scope.key, month, companyId, refresh]);

  const choices = useMemo(() => {
    const values = new Map(companies.map(company => [company.id, company.name]));
    for (const company of data?.availableCompanies ?? []) values.set(company.id, company.name);
    return [...values].sort((left, right) => left[1].localeCompare(right[1], 'sv-SE'));
  }, [companies, data?.availableCompanies]);
  const invoiceRows = (data?.companies ?? []).flatMap(company => company.services.filter(service => service.billableCount > 0)
    .map((service, index) => ({ company, service, key: `${company.companyId}:${service.service}:${service.channel}:${service.unitSalesMinor}:${index}` })));

  async function download() {
    if (!data || loading || exportController.current || !current()) return;
    const controller = new AbortController(), key = queryKey; exportController.current = controller;
    setDownloading(true); setDownloadError(''); setNotice('');
    try {
      const blob = await exportPlatformUsage(scope, { month, companyId }, controller.signal);
      if (controller.signal.aborted || !current() || queryRef.current !== key) return;
      const url = URL.createObjectURL(blob); objectUrls.current.add(url);
      const link = document.createElement('a'); link.href = url;
      link.download = `fakturaunderlag-${month}${companyId ? '-valt-bolag' : ''}.csv`; link.hidden = true;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => { URL.revokeObjectURL(url); objectUrls.current.delete(url); }, 1000);
      setNotice(`CSV-underlaget för ${monthLabel(month)} är klart.`);
    } catch (error) {
      if (controller.signal.aborted || !current() || queryRef.current !== key) return;
      setDownloadError(messageOf(error));
      if (error instanceof PlatformUsageError && [401, 403].includes(error.status)) {
        setResult({ key, phase: 'error', error: messageOf(error) }); window.dispatchEvent(new Event('scrappilot:check-platform-session'));
      }
    } finally { if (exportController.current === controller) { exportController.current = undefined; if (mounted.current) setDownloading(false); } }
  }

  return <section className="platform-panel platform-usage" aria-label="Förbrukning och fakturaunderlag">
    <div className="platform-panel-heading"><div className="platform-usage-heading"><h2><ReceiptText size={21} />Förbrukning &amp; fakturaunderlag</h2><p>Följ registrerad tjänsteförbrukning per bolag och kalendermånad.</p></div>
      <div className="platform-usage-tools"><button type="button" className="platform-text-btn" disabled={loading || downloading || !validMonth} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} />Uppdatera förbrukning</button>
        <button type="button" className="platform-btn outline" disabled={!data || loading || downloading} onClick={() => void download()}>{downloading ? <LoaderCircle size={16} className="platform-usage-spin" /> : <Download size={16} />}Ladda ner CSV</button></div></div>
    <div className="platform-usage-filters"><label><span><CalendarDays size={15} />Månad</span><input type="month" aria-label="Förbrukningsmånad" value={month} onChange={event => setMonth(event.target.value)} /></label>
      <label><span><Building2 size={15} />Bolag</span><select aria-label="Filtrera förbrukning efter bolag" value={companyId} onChange={event => setCompanyId(event.target.value)}><option value="">Alla bolag</option>{choices.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label></div>
    {!validMonth && <p className="platform-info" role="status">Välj en månad för att visa förbrukningen.</p>}
    {loading && <p className="platform-usage-loading" role="status"><LoaderCircle size={17} className="platform-usage-spin" />Hämtar förbrukningen…</p>}
    {activeResult?.error && <p className="platform-error" role="alert">{activeResult.error}</p>}
    {downloadError && <p className="platform-error" role="alert">{downloadError}</p>}
    {notice && <p className="platform-info" role="status">{notice}</p>}
    {data && <>
      <div className="platform-usage-stats">
        <div className="platform-usage-stat"><span><SearchCheck size={17} />Utgående försök</span><strong>{number(data.totals.providerCalls)}</strong><small>Inklusive osäkra försök</small></div>
        <div className="platform-usage-stat"><span><CheckCircle2 size={17} />Bekräftat debiterbara</span><strong>{number(data.totals.billableCount)}</strong><small>Bekräftade utfall i underlaget</small></div>
        <div className="platform-usage-stat"><span><ReceiptText size={17} />Aktuellt kundpris</span><strong>{money(data.pricing.roaringLookupSalesMinor)}</strong><small>Roaring per uppslag · exklusive moms</small></div>
        <div className="platform-usage-stat total"><span><ReceiptText size={17} />Summa exklusive moms</span><strong>{money(data.totals.salesMinor)}</strong><small>Bekräftat fakturaunderlag</small></div>
      </div>
      <div className="platform-usage-outcomes" aria-label="Utfall för vald månad"><span>Träffar: {number(data.totals.success)}</span><span>Ingen träff: {number(data.totals.notFound)}</span>
        <span className="failed">Fel/avvisade: {number(data.totals.failed + data.totals.rejected)}</span><span className="unknown">Okänt utfall: {number(data.totals.unknown)}</span>
        <span>Reserverade: {number(data.totals.reservedCount)}</span><span>Ej skickade: {number(data.totals.notDispatchedCount)}</span></div>
      <p className="platform-usage-note"><AlertCircle size={16} /><span><strong>Att granska: {number(data.totals.reviewCount)} uppslag · {money(data.totals.reviewSalesMinor)} exkl. moms.</strong> Dessa belopp ingår inte i det bekräftade fakturaunderlaget.</span></p>
      <section className="platform-usage-section" aria-label="Förbrukning per bolag"><div className="platform-usage-section-heading"><h3><Building2 size={17} />Per bolag</h3><small>{monthLabel(data.month)} · Europe/Stockholm</small></div>
        <div className="platform-table-wrap"><table className="platform-table"><thead><tr><th>Bolag</th><th className="numeric">Utgående försök</th><th className="numeric">Debiterbara</th><th className="numeric">Att granska</th><th className="numeric">Fel/avvisade</th><th className="numeric">Okända</th><th className="numeric">Belopp exkl. moms</th></tr></thead><tbody>{data.companies.map(company => <tr key={company.companyId}><td><strong>{company.companyName}</strong></td><td className="numeric">{number(company.totals.providerCalls)}</td><td className="numeric">{number(company.totals.billableCount)}</td><td className="numeric">{number(company.totals.reviewCount)}</td><td className="numeric">{number(company.totals.failed + company.totals.rejected)}</td><td className="numeric">{number(company.totals.unknown)}</td><td className="numeric">{money(company.totals.salesMinor)}</td></tr>)}</tbody></table></div>
        {!data.companies.length && <p className="platform-usage-empty"><FileSpreadsheet size={23} />Ingen registrerad förbrukning för vald månad och bolag.</p>}
      </section>
      <section className="platform-usage-section" aria-label="Månadens fakturaunderlag"><div className="platform-usage-section-heading"><h3><FileSpreadsheet size={17} />Fakturarader</h3><small>Bekräftade antal · samtliga priser exklusive moms</small></div>
        <div className="platform-table-wrap"><table className="platform-table"><thead><tr><th>Bolag</th><th>Tjänst</th><th className="numeric">Antal</th><th className="numeric">À-pris</th><th className="numeric">Belopp</th></tr></thead><tbody>{invoiceRows.map(({ company, service, key }) => <InvoiceRow key={key} companyName={company.companyName} service={service} />)}</tbody><tfoot><tr><td colSpan={4}>Summa exklusive moms</td><td className="numeric">{money(data.totals.salesMinor)}</td></tr></tfoot></table></div>
        {!invoiceRows.length && <p className="platform-usage-empty"><CheckCircle2 size={23} />Inga bekräftat debiterbara tjänster i urvalet.</p>}
      </section>
      <p className="platform-usage-note"><Info size={16} /><span>Underlaget omfattar registrerade tjänstehändelser för vald månad i svensk tid. CSV-exporten är ett granskningsunderlag. Ingen faktura skapas eller skickas automatiskt.</span></p>
    </>}
  </section>;
}

function InvoiceRow({ companyName, service }: { companyName: string; service: PlatformUsageService }) {
  return <tr><td>{companyName}</td><td><strong>{serviceLabel(service.service)}</strong><small>{channelLabel(service.channel)}</small></td><td className="numeric">{number(service.billableCount)}</td><td className="numeric">{money(service.unitSalesMinor)}</td><td className="numeric">{money(service.salesMinor)}</td></tr>;
}
