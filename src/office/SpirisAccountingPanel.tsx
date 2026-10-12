import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2, Calculator, Check, CheckCircle2, ChevronDown, CircleAlert, FileCheck2,
  History, Info, Link2, MapPin, PlugZap, RefreshCw, Settings2, ShieldCheck,
  SlidersHorizontal, UserRound,
} from 'lucide-react';
import { can, type OfficeUser } from './model';
import type { AccountRole, AccountingSettings } from './accounting-types';
import { EnvironmentApiError } from './environment-client';
import { environmentFailure, useEnvironmentSession } from './EnvironmentSession';
import { environmentTime } from './environment-types';
import { spirisAccountingApi, type SpirisAccountingState, type SpirisExample, type SpirisExport, type SpirisSamplePreview } from './spiris-accounting-client';
import { vismaSandboxApi, type VismaSandboxRun } from './visma-sandbox-client';
import { mergeSpirisSettings } from './spiris-settings-merge';
import SpirisManualExport from './SpirisManualExport';
import './spiris-accounting.css';
import { cacheIntegrationRead, cachedIntegrationRead, clearIntegrationReadCache, integrationReadScope } from './integration-read-cache';

const money = (value: number) => value.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const message = (issue: string | { code: string; message: string }) => typeof issue === 'string' ? issue : issue.message;
function stockholmToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
}
const accountLabels: Record<AccountRole, string> = {
  privatePurchase: 'Inköpskonto privatinköp', reversePurchase: 'Inköpskonto omvänd moms',
  standardPurchase: 'Inköpskonto vanlig moms', noVatPurchase: 'Inköpskonto momsbefriat företag',
  supplierLiability: 'Leverantörsskuld', inputReverseVat: 'Ingående omvänd moms',
  outputReverseVat: 'Utgående omvänd moms', inputVat: 'Ingående vanlig moms', offsetLiability: 'Avstämningskonto för kvittning',
};
const mainAccountRoles: AccountRole[] = ['supplierLiability', 'inputReverseVat', 'outputReverseVat'];
const otherAccountRoles: AccountRole[] = ['noVatPurchase', 'standardPurchase', 'inputVat'];
const exampleLabels: Record<SpirisExample, string> = {
  reverse_scrap: 'Skrot · momsregistrerat företag', private: 'Privatinköp',
  standard_25: 'Företagsinköp · vanlig moms 25 %', non_vat_business: 'Företag · inte momsregistrerat',
};
const exportLabels: Record<string, string> = {
  pending: 'Väntar på överföring', queued: 'Väntar på överföring', in_flight: 'Överföring pågår',
  processing: 'Överföring pågår', accepted: 'Utkast skapat', sent: 'Utkast skapat', completed: 'Utkast skapat',
  rejected: 'Avvisad', failed: 'Avvisad', blocked: 'Behöver kompletteras', unknown: 'Oklart resultat',
};

function missingPreviewFields(settings: AccountingSettings | undefined, siteId: string, example: SpirisExample) {
  if (!settings) return [];
  const site = settings.sites.find(item => item.siteId === siteId);
  const accounts = { ...settings.accounts, ...(site?.useDefaults === false ? site.accountOverrides : {}) };
  const roles: AccountRole[] = example === 'reverse_scrap' ? ['reversePurchase', 'supplierLiability', 'inputReverseVat', 'outputReverseVat']
    : example === 'standard_25' ? ['standardPurchase', 'supplierLiability', 'inputVat']
      : [example === 'private' ? 'privatePurchase' : 'noVatPurchase', 'supplierLiability'];
  const issues = roles.filter(role => !accounts[role]).map(role => `${accountLabels[role]} behöver väljas.`);
  if (!settings.paymentTermsId) issues.push('Betalvillkor behöver väljas.');
  if (example === 'non_vat_business' && settings.nonVatBusinessRule !== 'no_vat') issues.push('Företag utan momsregistrering kräver en fastställd regel.');
  return issues;
}

function SectionHeading({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children?: ReactNode }) {
  return <div className="spiris-section-heading"><span className="spiris-section-icon">{icon}</span><div><h3>{title}</h3><p>{description}</p></div>{children}</div>;
}

export default function SpirisAccountingPanel({ user, actualUser, onNotice }: {
  user: OfficeUser; actualUser: OfficeUser; onNotice: (message: string) => void;
}) {
  const { session, loading: sessionLoading, error: sessionError, refreshSession } = useEnvironmentSession();
  const administrator = user.level === 'Systemadmin' && actualUser.level === 'Systemadmin' && !user.siteIds && !actualUser.siteIds && can(user, 'integrationsRead');
  const matchingSession = session?.actualUserId === actualUser.id && session?.effectiveUserId === user.id;
  const identity = `${actualUser.id}/${actualUser.level}/${actualUser.permissions.join(',')}/${actualUser.siteIds?.join(',') ?? 'all'}/${user.id}/${user.level}/${user.permissions.join(',')}/${user.siteIds?.join(',') ?? 'all'}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const permittedRef = useRef(false); permittedRef.current = administrator && matchingSession;
  const mounted = useRef(true), generation = useRef(0), previewGeneration = useRef(0), historyGeneration = useRef(0);
  const controllers = useRef(new Set<AbortController>()), busy = useRef(false), dirtyRef = useRef(false);
  const baseSettings = useRef<AccountingSettings | undefined>(undefined), paymentTermEdited = useRef(false);
  const [state, setState] = useState<SpirisAccountingState>();
  const [form, setForm] = useState<AccountingSettings>();
  const [dirty, setDirty] = useState(false), [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<'load' | 'save' | 'choices'>();
  const [error, setError] = useState('');
  const [lookupFailed, setLookupFailed] = useState(false);
  const [tab, setTab] = useState<'settings' | 'history'>('settings');
  const [expandedSites, setExpandedSites] = useState<string[]>([]);
  const [siteId, setSiteId] = useState(''), [example, setExample] = useState<SpirisExample>('reverse_scrap');
  const [preview, setPreview] = useState<SpirisSamplePreview>(), [previewLoading, setPreviewLoading] = useState(false), [previewError, setPreviewError] = useState('');
  const [exports, setExports] = useState<SpirisExport[]>([]), [historyLoading, setHistoryLoading] = useState(false), [historyError, setHistoryError] = useState('');
  const [journal, setJournal] = useState<Record<string, VismaSandboxRun>>({}), [journalLoading, setJournalLoading] = useState<string>();
  const configured = administrator && matchingSession && !!state?.capabilities.canConfigure;
  const fieldsDisabled = !configured || pending === 'save' || pending === 'choices';
  const cacheScope = integrationReadScope(actualUser, user, session);
  const previewMissing = missingPreviewFields(form, siteId, example);
  const previewReady = previewMissing.length === 0 && !!state?.companyVerified;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; previewGeneration.current++; historyGeneration.current++; for (const controller of controllers.current) controller.abort(); };
  }, []);

  useEffect(() => {
    generation.current++; previewGeneration.current++; historyGeneration.current++;
    for (const controller of controllers.current) controller.abort(); controllers.current.clear();
    busy.current = false; dirtyRef.current = false;
    baseSettings.current = undefined; paymentTermEdited.current = false;
    setState(undefined); setForm(undefined); setDirty(false); setConflict(false); setPending(undefined); setError(''); setLookupFailed(false);
    setTab('settings'); setExpandedSites([]); setSiteId(''); setExample('reverse_scrap');
    setPreview(undefined); setPreviewLoading(false); setPreviewError('');
    setExports([]); setHistoryLoading(false); setHistoryError(''); setJournal({}); setJournalLoading(undefined);
  }, [identity, matchingSession]);

  const applyState = useCallback((next: SpirisAccountingState, replaceForm: boolean) => {
    setState(next);
    setSiteId(previous => next.sites.some(site => site.id === previous) ? previous : next.sites[0]?.id ?? '');
    const immediate = next.choices?.paymentTerms.filter(term => term.availableForPurchase && term.days === 0) ?? [];
    const suggested = immediate.length === 1 &&
      (!next.suggestedPaymentTermsId || next.suggestedPaymentTermsId === immediate[0].id) ? immediate[0] : undefined;
    if (!replaceForm) {
      if (baseSettings.current && (next.settings.revision !== baseSettings.current.revision || next.settings.companyId !== baseSettings.current.companyId)) setConflict(true);
      if (suggested && !paymentTermEdited.current) setForm(previous => {
        if (!previous || previous.paymentTermsId) return previous;
        dirtyRef.current = true; setDirty(true);
        return { ...previous, paymentTermsId: suggested.id, paymentTermDays: suggested.days };
      });
      return;
    }
    baseSettings.current = structuredClone(next.settings); paymentTermEdited.current = false;
    const nextForm = structuredClone(next.settings);
    const missingSites = next.sites.filter(site => !nextForm.sites.some(mapping => mapping.siteId === site.id));
    nextForm.sites.push(...missingSites.map(site => ({ siteId: site.id, useDefaults: true })));
    const suggestedTerm = !nextForm.paymentTermsId && suggested;
    if (suggestedTerm) { nextForm.paymentTermsId = suggestedTerm.id; nextForm.paymentTermDays = suggestedTerm.days; }
    const changed = !!suggestedTerm || missingSites.length > 0;
    setForm(nextForm); dirtyRef.current = changed; setDirty(changed);
  }, []);

  const load = useCallback(async (force = false) => {
    if (!administrator || !matchingSession || busy.current) return;
    const controller = new AbortController(); controllers.current.add(controller);
    const request = ++generation.current;
    const current = () => mounted.current && !controller.signal.aborted && identityRef.current === identity && permittedRef.current && generation.current === request;
    const cached = !force && cachedIntegrationRead<SpirisAccountingState>('spiris-settings', cacheScope);
    if (cached) {
      applyState(cached.value, !dirtyRef.current);
      if (cached.fresh) { controllers.current.delete(controller); return; }
    }
    busy.current = true; setPending('load'); setError(''); setLookupFailed(false);
    try {
      const next = await spirisAccountingApi.settings(controller.signal);
      if (current()) { cacheIntegrationRead('spiris-settings', cacheScope, next); applyState(next, !dirtyRef.current); }
    }
    catch (failure) {
      if (current()) {
        if (failure instanceof EnvironmentApiError && [401, 403].includes(failure.status)) {
          clearIntegrationReadCache(); setState(undefined); setForm(undefined);
        }
        setError(environmentFailure(failure));
      }
    }
    finally { controllers.current.delete(controller); if (current()) { busy.current = false; setPending(undefined); } }
  }, [administrator, matchingSession, identity, cacheScope, applyState]);

  useEffect(() => { void load(); }, [load]);

  function edit(update: (value: AccountingSettings) => AccountingSettings) {
    if (fieldsDisabled) return;
    setForm(value => value && update(value)); dirtyRef.current = true; setDirty(true); setError('');
  }
  function updateAccount(role: AccountRole, raw: string) {
    edit(value => ({ ...value, accounts: { ...value.accounts, [role]: raw === '' ? undefined : Number(raw) },
      ...(role === 'offsetLiability' ? { offsetReconciliation: undefined } : {}) }));
  }
  function updateSite(id: string, update: (site: AccountingSettings['sites'][number]) => AccountingSettings['sites'][number]) {
    edit(value => {
      const previous = value.sites.find(site => site.siteId === id) ?? { siteId: id, useDefaults: true };
      const next = update(previous);
      return { ...value, sites: [...value.sites.filter(site => site.siteId !== id), next] };
    });
  }

  async function perform(action: 'save' | 'choices') {
    if (!configured || !form || busy.current || (action === 'save' && conflict)) return;
    busy.current = true;
    const controller = new AbortController(); controllers.current.add(controller);
    const request = ++generation.current;
    const current = () => mounted.current && !controller.signal.aborted && identityRef.current === identity && permittedRef.current && generation.current === request;
    const frozen = structuredClone(form);
    const expectedRevision = baseSettings.current?.revision ?? form.revision;
    setPending(action); setError(''); setLookupFailed(false);
    try {
      const next = action === 'save' ? await spirisAccountingApi.saveSettings({ ...frozen, revision: expectedRevision }, expectedRevision, controller.signal)
        : await spirisAccountingApi.lookupChoices(controller.signal);
      if (!current()) return;
      cacheIntegrationRead('spiris-settings', cacheScope, next);
      clearIntegrationReadCache('catalog');
      applyState(next, action === 'save' || !dirtyRef.current);
      if (action === 'save') onNotice('Spiris-inställningarna är sparade.');
      else onNotice('Verkliga konton och val har hämtats från Spiris sandbox.');
    } catch (failure) {
      if (!current()) return;
      setError(environmentFailure(failure));
      setLookupFailed(action === 'choices');
      if (action === 'save' && failure instanceof EnvironmentApiError && ['revision_conflict', 'accounting_settings_conflict'].includes(failure.code)) {
        setConflict(true);
        try { const next = await spirisAccountingApi.settings(controller.signal); if (current()) { cacheIntegrationRead('spiris-settings', cacheScope, next); applyState(next, false); } }
        catch { /* Keep the user's form and the original conflict message. */ }
      }
    } finally { controllers.current.delete(controller); if (current()) { busy.current = false; setPending(undefined); } }
  }

  useEffect(() => {
    setPreview(undefined); setPreviewError('');
    const request = ++previewGeneration.current;
    if (!configured || !form || !siteId || !previewReady || tab !== 'settings') { setPreviewLoading(false); return; }
    const controller = new AbortController(); controllers.current.add(controller);
    const current = () => mounted.current && !controller.signal.aborted && identityRef.current === identity && permittedRef.current && previewGeneration.current === request;
    setPreviewLoading(true);
    const timer = window.setTimeout(() => {
      void spirisAccountingApi.samplePreview({ settings: structuredClone(form), siteId, example, amount: 1000, date: stockholmToday() }, controller.signal)
        .then(value => { if (current()) setPreview(value); })
        .catch(failure => { if (current()) setPreviewError(environmentFailure(failure)); })
        .finally(() => { controllers.current.delete(controller); if (current()) setPreviewLoading(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); controllers.current.delete(controller); };
  }, [configured, form, siteId, example, tab, identity, previewReady]);

  const loadHistory = useCallback(async () => {
    if (!administrator || !matchingSession) return;
    const controller = new AbortController(); controllers.current.add(controller);
    const request = ++historyGeneration.current;
    const current = () => mounted.current && !controller.signal.aborted && identityRef.current === identity && permittedRef.current && historyGeneration.current === request;
    setHistoryLoading(true); setHistoryError('');
    try { const next = await spirisAccountingApi.exports(controller.signal); if (current()) setExports(next.exports); }
    catch (failure) { if (current()) setHistoryError(environmentFailure(failure)); }
    finally { controllers.current.delete(controller); if (current()) setHistoryLoading(false); }
  }, [administrator, matchingSession, identity]);

  useEffect(() => { if (tab === 'history') void loadHistory(); }, [tab, loadHistory]);

  async function readJournal(id: string) {
    if (!administrator || !matchingSession || journalLoading) return;
    const controller = new AbortController(); controllers.current.add(controller);
    setJournalLoading(id); setHistoryError('');
    const current = () => mounted.current && !controller.signal.aborted && identityRef.current === identity && permittedRef.current;
    try { const run = await vismaSandboxApi.historyRun(id, controller.signal); if (current()) setJournal(previous => ({ ...previous, [id]: run })); }
    catch (failure) { if (current()) setHistoryError(environmentFailure(failure)); }
    finally { controllers.current.delete(controller); if (current()) setJournalLoading(undefined); }
  }

  const choices = state?.choices;
  const today = stockholmToday();
  const currentYears = choices?.fiscalYears.filter(year => !year.locked && year.startDate.slice(0, 10) <= today && year.endDate.slice(0, 10) >= today) ?? [];
  const currentAccounts = choices?.accounts.filter(account => account.active && !account.blockedForManualBooking && (currentYears.length !== 1 || account.fiscalYearId === currentYears[0].id)) ?? [];
  const accounts = [...new Map(currentAccounts.map(account => [account.number, account])).values()];
  const terms = choices?.paymentTerms.filter(term => term.availableForPurchase) ?? [];
  const centers = choices?.costCenters.filter(center => center.active && Number(center.number) === 1).flatMap(center => center.items.filter(item => item.active).map(item => ({ ...item, dimensionName: center.name }))) ?? [];
  const projects = choices?.projects.filter(project => Number(project.status) === 1 || String(project.status).toLowerCase() === 'active') ?? [];
  const rows = preview?.rows ?? preview?.draft?.Rows ?? [];
  const debit = rows.reduce((total, row) => total + Math.round(row.DebitAmount * 100), 0);
  const credit = rows.reduce((total, row) => total + Math.round(row.CreditAmount * 100), 0);
  const issues = [...previewMissing, ...(preview?.issues ?? [])];
  for (const row of rows) {
    const account = accounts.find(item => item.number === row.AccountNumber);
    if (account?.firstCostCenterMandatory && !row.CostCenterItemId1) issues.push({ code: 'visma_dimension_required', message: `Konto ${row.AccountNumber} kräver kostnadsställe.` });
    if (account?.costCenterAllowed === false && row.CostCenterItemId1) issues.push({ code: 'visma_dimension_invalid', message: `Konto ${row.AccountNumber} tillåter inte kostnadsställe.` });
    if (account?.projectAllowed === false && row.ProjectId) issues.push({ code: 'visma_dimension_invalid', message: `Konto ${row.AccountNumber} tillåter inte projekt.` });
  }
  const balanced = rows.length > 0 && debit === credit && issues.length === 0;
  const previewSite = form?.sites.find(site => site.siteId === siteId);
  const paymentTerm = terms.find(term => term.id === form?.paymentTermsId);
  const selectedCenter = centers.find(center => center.id === previewSite?.costCenterId);

  function accountSelect(role: AccountRole, value = form?.accounts[role], onChange = (raw: string) => updateAccount(role, raw), disabled = fieldsDisabled) {
    return <select aria-label={accountLabels[role]} value={value ?? ''} onChange={event => onChange(event.target.value)} disabled={disabled}>
      <option value="">Välj ett konto från Spiris</option>
      {accounts.map(account => <option key={account.number} value={account.number}>{account.number} · {account.name}{account.firstCostCenterMandatory ? ' · kostnadsställe krävs' : ''}</option>)}
      {value != null && !accounts.some(account => account.number === value) && <option value={value}>{value} · behöver hämtas eller bytas</option>}
    </select>;
  }
  function vatSelect(role: keyof AccountingSettings['vatCodes'], label: string) {
    const selected = form?.vatCodes?.[role];
    const compatible = choices?.vatCodes.filter(code => code.rate === (['reverse25', 'standard25'].includes(role) ? 25 : 0)) ?? [];
    return <label>{label}<select aria-label={label} value={selected ?? ''} onChange={event => edit(value => ({ ...value, vatCodes: { ...value.vatCodes, [role]: event.target.value || undefined } }))} disabled={fieldsDisabled}>
      <option value="">Ingen vald momskod</option>{compatible.map(code => <option key={code.id} value={code.id}>{code.code} · {code.name} · {code.rate} %</option>)}
      {selected && !compatible.some(code => code.id === selected) && <option value={selected}>Sparad momskod · behöver hämtas eller bytas</option>}
    </select></label>;
  }

  function reviewValue(settings: AccountingSettings, role: AccountRole) {
    const account = accounts.find(item => item.number === settings.accounts[role]);
    return account ? `${account.number} · ${account.name}` : settings.accounts[role] == null ? 'Inget konto valt' : String(settings.accounts[role]);
  }
  function reviewTerm(settings: AccountingSettings) {
    const term = terms.find(item => item.id === settings.paymentTermsId);
    return term ? `${term.name} · ${term.days} dagar` : settings.paymentTermsId ? `Sparat villkor · ${settings.paymentTermDays} dagar` : 'Inget betalvillkor valt';
  }
  function reconcile() {
    if (!form || !state || !baseSettings.current || fieldsDisabled) return;
    if (form.companyId !== state.settings.companyId) {
      setError('Det anslutna företaget har ändrats. Återställ formuläret för att använda det nya företagets inställningar.');
      return;
    }
    const remoteTermChanged = state.settings.paymentTermsId !== baseSettings.current.paymentTermsId || state.settings.paymentTermDays !== baseSettings.current.paymentTermDays;
    const local = !paymentTermEdited.current && remoteTermChanged ? { ...form, paymentTermsId: baseSettings.current.paymentTermsId, paymentTermDays: baseSettings.current.paymentTermDays } : form;
    const merged = mergeSpirisSettings(baseSettings.current, local, state.settings);
    baseSettings.current = structuredClone(state.settings);
    setForm(merged); dirtyRef.current = true; setDirty(true); setConflict(false); setError('');
  }
  const differences = state && form ? [
    { label: 'Betalvillkor', saved: reviewTerm(state.settings), edited: reviewTerm(form) },
    { label: 'Överföring', saved: state.settings.exportMode === 'manual' ? 'Manuell' : 'Efter attest', edited: form.exportMode === 'manual' ? 'Manuell' : 'Efter attest' },
    { label: 'Aktiverad överföring', saved: state.settings.enabled ? 'Ja' : 'Nej', edited: form.enabled ? 'Ja' : 'Nej' },
    ...Object.keys(accountLabels).map(role => ({ label: accountLabels[role as AccountRole], saved: reviewValue(state.settings, role as AccountRole), edited: reviewValue(form, role as AccountRole) })),
    ...state.sites.flatMap(site => {
      const saved = state.settings.sites.find(item => item.siteId === site.id), edited = form.sites.find(item => item.siteId === site.id);
      const centerName = (id?: string) => centers.find(item => item.id === id)?.name ?? (id ? 'Sparat val · behöver hämtas' : 'Ingen fördelning');
      const projectName = (id?: string) => projects.find(item => item.id === id)?.name ?? (id ? 'Sparat val · behöver hämtas' : 'Inget standardprojekt');
      return [
        { label: `${site.name} · kostnadsställe`, saved: centerName(saved?.costCenterId), edited: centerName(edited?.costCenterId) },
        { label: `${site.name} · projekt`, saved: projectName(saved?.projectId), edited: projectName(edited?.projectId) },
        { label: `${site.name} · konton`, saved: saved?.useDefaults === false ? 'Egna konton' : 'Gemensamma', edited: edited?.useDefaults === false ? 'Egna konton' : 'Gemensamma' },
        ...Object.keys(accountLabels).flatMap(key => {
          if (saved?.useDefaults !== false && edited?.useDefaults !== false) return [];
          const role = key as AccountRole;
          const value = (settings: AccountingSettings, mapping?: AccountingSettings['sites'][number]) => reviewValue({ ...settings, accounts: { ...settings.accounts, ...(!mapping?.useDefaults ? mapping?.accountOverrides : {}) } }, role);
          return [{ label: `${site.name} · ${accountLabels[role]}`, saved: value(state.settings, saved), edited: value(form, edited) }];
        }),
      ];
    }),
  ].filter(row => row.saved !== row.edited) : [];

  return <section className="spiris-accounting-card" aria-label="Spiris integrationskort">
    <header className="spiris-integration-header"><span className="spiris-brand-icon" aria-hidden="true">S</span><div className="spiris-brand-text"><h2>Spiris <span>/ Visma eEkonomi</span></h2><p>{state?.company?.name || 'Ekonomiinställningar för avräkningar och anläggningar'}</p></div>
      <span className={`environment-pill ${state?.companyVerified ? 'success' : 'warning'}`}><ShieldCheck size={13} />{state?.companyVerified ? 'Ansluten · Sandbox' : 'Sandbox · inte verifierad'}</span>
      {administrator && <Link className="office-btn outline" to="/integrations/visma-test"><PlugZap size={15} />Öppna Spiris-test</Link>}
    </header>
    {!administrator ? <div className="spiris-message"><ShieldCheck size={18} /><p>Spiris ekonomiinställningar kräver att systemadmin arbetar som systemadmin med åtkomst till alla anläggningar.</p></div>
      : !matchingSession ? <div className="spiris-message" role={sessionError ? 'alert' : 'status'}><RefreshCw size={18} /><p>{sessionError || (sessionLoading ? 'Hämtar din session…' : 'Sessionen behöver uppdateras.')}</p>{!sessionLoading && <button type="button" className="office-btn outline" onClick={() => void refreshSession().catch(() => undefined)}>Försök igen</button>}</div>
        : <>
          <nav className="spiris-tabs" aria-label="Spiris integrationsflikar"><button type="button" aria-current={tab === 'settings' ? 'page' : undefined} className={tab === 'settings' ? 'selected' : ''} onClick={() => setTab('settings')}><Settings2 size={15} />Inställningar</button><button type="button" aria-current={tab === 'history' ? 'page' : undefined} className={tab === 'history' ? 'selected' : ''} onClick={() => setTab('history')}><History size={15} />Överföringar{exports.length > 0 && <span className="spiris-tab-count">{exports.length}</span>}</button><div>Alla anläggningar använder samma anslutning</div></nav>
          {error && <div className="spiris-message error" role="alert"><CircleAlert size={18} /><div><p>{error}</p>{conflict && <p>Dina ändringar finns kvar. Granska den senaste sparade versionen innan du sparar igen.</p>}</div><button type="button" className="office-btn outline" onClick={() => void (lookupFailed ? perform('choices') : load(true))} disabled={!!pending}>{lookupFailed ? 'Försök hämta igen' : 'Hämta senaste version'}</button></div>}
          {pending === 'choices' && <div className="spiris-message" role="status"><RefreshCw size={18} /><p>Hämtar kontoplan, betalningsvillkor, momskoder, kostnadsställen och projekt från Spiris…</p></div>}
          {conflict && state && form && <section className="spiris-conflict-review" aria-label="Granska ändrade Spiris-inställningar"><h3>Senast sparad version {state.settings.revision}</h3><p>Dina ändringar finns kvar. Skillnaderna visas nedan. När du uppdaterar versionen behålls andras ändringar i de fält som du inte har ändrat.</p><div><table><thead><tr><th>Inställning</th><th>Senast sparat</th><th>Ditt formulär</th></tr></thead><tbody>{differences.map(row => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.saved}</td><td>{row.edited}</td></tr>)}</tbody></table></div><button type="button" className="office-btn outline" onClick={reconcile} disabled={fieldsDisabled || !!pending}>Behåll mina ändringar och uppdatera version</button></section>}
          {!state && !error && <div className="spiris-message" role="status"><RefreshCw size={18} /><p>Hämtar Spiris-inställningar…</p></div>}
          {state && form && tab === 'settings' && <>
            {!state.companyVerified && <div className="spiris-message warning"><Info size={17} /><p>Anslut och verifiera ert testföretag via Spiris-test. Konton och övriga val hämtas från det företaget.</p></div>}
            {state.issues.length > 0 && <details className="spiris-configuration-issues"><summary>Kontrollera ekonomiinställningarna ({state.issues.length})</summary><ul>{state.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
            <div className="spiris-integration-content"><div className="spiris-settings-column">
              <section className="spiris-section"><SectionHeading icon={<SlidersHorizontal size={19} />} title="Gemensamma inställningar" description="Nya kunder ärver betalvillkoret. Kundens eget val gäller om det ändrats."><span className="spiris-mini-tag">STANDARD</span></SectionHeading>
                <div className="spiris-form-grid three"><label>Betalvillkor<select aria-label="Betalvillkor" value={form.paymentTermsId ?? ''} disabled={fieldsDisabled} onChange={event => { paymentTermEdited.current = true; const term = terms.find(item => item.id === event.target.value); edit(value => ({ ...value, paymentTermsId: term?.id, paymentTermDays: term?.days ?? 0 })); }}><option value="">Välj ett betalvillkor från Spiris</option>{terms.map(term => <option key={term.id} value={term.id}>{term.days === 0 ? 'Direkt' : term.name} · {term.days} {term.days === 1 ? 'dag' : 'dagar'}{term.days === 0 && term.name !== 'Direkt' ? ` · ${term.name}` : ''}</option>)}{form.paymentTermsId && !terms.some(term => term.id === form.paymentTermsId) && <option value={form.paymentTermsId}>Sparat betalvillkor · hämta från Spiris</option>}</select><small>{form.paymentTermDays === 0 ? 'Förfallodatum = avräkningsdatum' : `Förfallodatum = avräkningsdatum + ${form.paymentTermDays} dagar`}</small></label>
                  <label>Valuta<select aria-label="Valuta" value="SEK" disabled={fieldsDisabled} onChange={() => undefined}><option value="SEK">SEK · Svenska kronor</option></select><small>Belopp från den godkända avräkningen</small></label>
                  <label>Överföring<select aria-label="Överföring" value={form.exportMode} disabled={fieldsDisabled} onChange={event => edit(value => ({ ...value, exportMode: event.target.value as AccountingSettings['exportMode'] }))}><option value="manual">Manuell överföring</option><option value="after_attest">Efter attest · fakturautkast</option></select><small>Utkast granskas i Spiris</small></label>
                </div>
                <label className="spiris-checkbox spiris-enable"><input type="checkbox" checked={form.enabled} disabled={fieldsDisabled} onChange={event => edit(value => ({ ...value, enabled: event.target.checked }))} />Aktivera överföring av fakturautkast till sandbox</label>
                <label className="spiris-tracking-limit">Följ bokföringsstatus i högst<input aria-label="Maximal uppföljning i dagar" type="number" min={1} max={365} value={form.trackingMaxDays ?? 30} disabled={fieldsDisabled} onChange={event => edit(value => ({ ...value, trackingMaxDays: Number(event.target.value) }))} /><span>dagar</span></label>
                <p className="spiris-help">Bara våra kopplade utkast följs. Kontrollen sker var femte minut första dygnet, sedan varje timme och dagligen efter sju dagar. Avstängd koppling pausar uppföljningen.</p>
                {form.exportMode === 'after_attest' && <p className="spiris-help">När överföring är aktiverad skickas kompletta, kundgodkända och attesterade avräkningar automatiskt. Blockerade underlag och oklara svar behöver granskas.</p>}
              </section>
              <section className="spiris-section"><SectionHeading icon={<Calculator size={19} />} title="Konton & momshantering" description="Gemensamma konton från Spiris kontoplan. Kund och artikel styr vilken regel som används."><button type="button" className="office-link spiris-text-button" onClick={() => void perform('choices')} disabled={fieldsDisabled || !!pending || !state.companyVerified}><RefreshCw size={13} />{pending === 'choices' ? 'Hämtar…' : 'Hämta från Spiris'}</button></SectionHeading>
                {!choices && <p className="spiris-help">Hämta företagets kontoplan, momskoder, betalvillkor, kostnadsställen och projekt. Ekonomi väljer sedan konton för varje inköpstyp.</p>}
                <div className="spiris-account-header"><span>Typ av inköp</span><span>Inköpskonto</span><span>Momshantering</span></div>
                <div className="spiris-account-row"><div className="spiris-account-kind"><span className="spiris-kind-icon"><UserRound size={16} /></span><div><strong>Privatinköp</strong><small>Privatperson säljer privat</small></div></div>{accountSelect('privatePurchase')}<span className="spiris-rule neutral">Ingen moms</span></div>
                <div className="spiris-account-row"><div className="spiris-account-kind"><span className="spiris-kind-icon green"><Building2 size={16} /></span><div><strong>Skrot · momsregistrerat företag</strong><small>Artikeln omfattas av omvänd moms</small></div></div>{accountSelect('reversePurchase')}<span className="spiris-rule green">Omvänd moms · 25 %</span></div>
                <div className="spiris-form-grid three spiris-secondary-accounts">{mainAccountRoles.map(role => <label key={role}>{accountLabels[role]}{accountSelect(role)}</label>)}</div>
                <div className="spiris-form-grid two spiris-secondary-accounts">{vatSelect('reverse25', 'Momskod omvänd moms 25 %')}</div>
                <details className="spiris-other-rules"><summary>Övriga inköp och momsregler <ChevronDown size={13} /></summary><p>Momsbefriade företagsinköp och inköp med vanlig moms kräver fastställda regler. Saknad momsregistrering eller artikelklassificering behöver kompletteras.</p><div className="spiris-form-grid two">{otherAccountRoles.map(role => <label key={role}>{accountLabels[role]}{accountSelect(role)}</label>)}
                    <label>Företag som inte är momsregistrerat<select aria-label="Företag som inte är momsregistrerat" value={form.nonVatBusinessRule ?? ''} disabled={fieldsDisabled} onChange={event => edit(value => ({ ...value, nonVatBusinessRule: event.target.value === 'no_vat' ? 'no_vat' : undefined }))}><option value="">Behöver fastställd regel</option><option value="no_vat">Ingen moms · fastställd av ekonomi</option></select></label>
                  </div><div className="spiris-form-grid two spiris-secondary-accounts">{vatSelect('private', 'Momskod privatinköp')}{vatSelect('standard25', 'Momskod vanlig moms 25 %')}{vatSelect('noVat', 'Momskod momsbefriat företagsinköp')}</div><p>Avräkningar med kvittning kräver att krediten kan stämmas av i Spiris. Sådana överföringar är spärrade tills det flödet är klart.</p></details>
                {choices && <p className="spiris-help">Val hämtade {environmentTime(choices.fetchedAt)}. Kontonummer och namn kommer från det anslutna testföretaget.</p>}
              </section>
              <section className="spiris-section spiris-locations"><SectionHeading icon={<MapPin size={19} />} title="Anläggningar & kostnadsställen" description="Varje viktkort får fördelningen från anläggningen där materialet tas emot."><span className="spiris-site-count">{state.sites.length} anläggningar</span></SectionHeading>
                <div className="spiris-location-heading"><span>Anläggning</span><span>Kostnadsställe</span><span>Projekt · valfritt</span><span>Konton</span></div>
                {state.sites.map(site => {
                  const config = form.sites.find(item => item.siteId === site.id) ?? { siteId: site.id, useDefaults: true };
                  const expanded = expandedSites.includes(site.id);
                  return <div key={site.id}>
                    <div className="spiris-location-row"><div className="spiris-location-name"><Building2 size={20} /><div><strong>{site.name}</strong><small>Alla inköp på anläggningen</small></div></div>
                      <label><span className="spiris-responsive-label">Kostnadsställe {site.name}</span><select aria-label={`Kostnadsställe ${site.name}`} value={config.costCenterId ?? ''} disabled={fieldsDisabled} onChange={event => updateSite(site.id, value => ({ ...value, costCenterId: event.target.value || undefined }))}><option value="">Ingen fördelning</option>{centers.map(center => <option key={center.id} value={center.id}>{center.shortName ? `${center.shortName} · ` : ''}{center.name}</option>)}{config.costCenterId && !centers.some(center => center.id === config.costCenterId) && <option value={config.costCenterId}>Sparat kostnadsställe · hämta val</option>}</select></label>
                      <label><span className="spiris-responsive-label">Projekt {site.name}</span><select aria-label={`Projekt ${site.name}`} value={config.projectId ?? ''} disabled={fieldsDisabled} onChange={event => updateSite(site.id, value => ({ ...value, projectId: event.target.value || undefined }))}><option value="">Inget standardprojekt</option>{projects.map(project => <option key={project.id} value={project.id}>{project.number ? `${project.number} · ` : ''}{project.name}</option>)}{config.projectId && !projects.some(project => project.id === config.projectId) && <option value={config.projectId}>Sparat projekt · hämta val</option>}</select></label>
                      <button type="button" className="office-link spiris-inherit-button" aria-expanded={expanded} aria-controls={`spiris-site-${site.id}`} onClick={() => setExpandedSites(previous => expanded ? previous.filter(id => id !== site.id) : [...previous, site.id])}><Link2 size={12} />{config.useDefaults ? 'Gemensamma' : 'Egna konton'}<ChevronDown size={12} /></button>
                    </div>
                    {expanded && <div className="spiris-site-override" id={`spiris-site-${site.id}`}><div><strong>Konton för {site.name}</strong><label className="spiris-checkbox"><input type="checkbox" checked={config.useDefaults} disabled={fieldsDisabled} onChange={event => updateSite(site.id, value => ({ ...value, useDefaults: event.target.checked, ...(event.target.checked ? { accountOverrides: undefined } : {}) }))} />Använd gemensamma konton</label></div><div className="spiris-form-grid two">{(['privatePurchase', 'reversePurchase', ...mainAccountRoles, 'noVatPurchase', 'standardPurchase', 'inputVat'] as AccountRole[]).map(role => <label key={role}>{accountLabels[role]}<select aria-label={`${accountLabels[role]} ${site.name}`} value={config.useDefaults ? form.accounts[role] ?? '' : config.accountOverrides?.[role] ?? ''} disabled={fieldsDisabled || config.useDefaults} onChange={event => updateSite(site.id, value => ({ ...value, accountOverrides: { ...value.accountOverrides, [role]: event.target.value === '' ? undefined : Number(event.target.value) } }))}><option value="">Använd gemensamt konto</option>{accounts.map(account => <option key={account.number} value={account.number}>{account.number} · {account.name}</option>)}{(config.useDefaults ? form.accounts[role] : config.accountOverrides?.[role]) != null && !accounts.some(account => account.number === (config.useDefaults ? form.accounts[role] : config.accountOverrides?.[role])) && <option value={config.useDefaults ? form.accounts[role] : config.accountOverrides?.[role]}>Sparat konto · hämta val</option>}</select></label>)}</div></div>}
                  </div>;
                })}
                {!state.sites.length && <p className="spiris-help">Inga aktiva anläggningar finns att koppla.</p>}
                <div className="spiris-locations-foot"><Info size={13} /><span>Kostnadsställe och projekt är valfria när kontot tillåter det. Nya anläggningar visas automatiskt här.</span></div>
              </section>
            </div>
            <aside className="spiris-preview-column"><section className="spiris-preview-panel" aria-label="Förhandsvisa kontering"><div className="spiris-preview-heading"><FileCheck2 size={18} /><h3>Förhandsvisa kontering</h3></div><p>{dirty ? 'Så används dina osparade inställningar.' : 'Så används dina inställningar.'}</p>
                <label>Anläggning<select aria-label="Anläggning" value={siteId} onChange={event => setSiteId(event.target.value)}>{state.sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
                <label>Exempelinköp<select aria-label="Exempelinköp" value={example} onChange={event => setExample(event.target.value as SpirisExample)}>{Object.entries(exampleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
                <div className="spiris-example-total"><small>Materialvärde · räkneexempel</small><strong>1 000,00 kr</strong><span>{example === 'reverse_scrap' ? 'Omvänd moms · 25 %' : example === 'standard_25' ? 'Vanlig moms · 25 %' : example === 'private' ? 'Privatinköp · ingen moms' : 'Momsregel enligt inställning'}</span></div>
                <div className="spiris-example-data"><div><span>Kostnadsställe</span><strong>{selectedCenter ? `${selectedCenter.shortName ? `${selectedCenter.shortName} · ` : ''}${selectedCenter.name}` : previewSite?.costCenterId ? 'Sparat val · hämta från Spiris' : 'Ingen fördelning'}</strong></div><div><span>Betalvillkor</span><strong>{paymentTerm ? `${paymentTerm.days === 0 ? 'Direkt' : paymentTerm.name} · ${paymentTerm.days} dagar` : 'Behöver väljas'}</strong></div><div><span>Förfallodatum</span><strong>{preview?.draft?.DueDate ?? '—'}</strong></div></div>
                {previewLoading && <p role="status">Beräknar kontering…</p>}{previewError && <p className="spiris-preview-error" role="alert">{previewError}</p>}
                {issues.length > 0 && <ul className="spiris-preview-issues">{issues.map((issue, index) => <li key={index}>{message(issue)}</li>)}</ul>}
                {rows.length > 0 && <table className="spiris-journal"><caption className="spiris-sr-only">Kontering för exempelinköpet</caption><thead><tr><th>Konto</th><th>Debet</th><th>Kredit</th></tr></thead><tbody>{rows.map((row, index) => <tr key={index}><th scope="row" title={row.TransactionText}>{row.AccountNumber}</th><td>{row.DebitAmount ? money(row.DebitAmount) : '—'}</td><td>{row.CreditAmount ? money(row.CreditAmount) : '—'}</td></tr>)}</tbody></table>}
                {balanced && <div className="spiris-balanced"><CheckCircle2 size={12} />Konteringen balanserar</div>}
                {rows.length > 0 && !balanced && issues.length === 0 && <p className="spiris-preview-error">Konteringen behöver granskas: debet och kredit skiljer sig.</p>}
                {preview?.accounting && issues.length === 0 && <div className="spiris-payout"><span>Att betala till säljaren</span><strong>{money(preview.accounting.net ?? preview.accounting.invoiceTotal ?? 0)} kr</strong></div>}
                <p className="spiris-payout-note">Räkneexemplet skapar inget utkast. Utbetalningen hanteras i betalflödet.</p>
              </section><section className="spiris-flow-panel"><h3>Från attest till Spiris</h3><ol><li><span>1</span><div><strong>Attesterad avräkning</strong><small>Låsta uppgifter används</small></div></li><li><span>2</span><div><strong>Leverantören kopplas</strong><small>Befintlig eller skapas automatiskt</small></div></li><li><span>3</span><div><strong>Fakturautkast skapas</strong><small>Svar och ID sparas på viktkortet</small></div></li></ol></section></aside>
            </div>
            <footer className="spiris-save-bar"><div><ShieldCheck size={17} /><span><strong>Ekonomiinställningar för alla anläggningar</strong><small>{dirty ? 'Osparade ändringar' : `Sparad version ${state.settings.revision}`} · Ändringar gäller nya exportunderlag.</small></span></div><button type="button" className="office-btn outline" disabled={fieldsDisabled || !dirty || !!pending} onClick={() => { setForm(structuredClone(state.settings)); baseSettings.current = structuredClone(state.settings); paymentTermEdited.current = false; dirtyRef.current = false; setDirty(false); setConflict(false); setError(''); }}>Återställ</button><button type="button" className="office-btn" disabled={fieldsDisabled || !dirty || !!pending || conflict} onClick={() => void perform('save')}><Check size={15} />{pending === 'save' ? 'Sparar…' : 'Spara inställningar'}</button></footer>
          </>}
          {tab === 'history' && <section className="spiris-history" aria-label="Spiris överföringshistorik"><header><div><h3>Överföringar till Spiris sandbox</h3><p>Varje försök hör till en låst attestversion. Leverantörs-ID, utkast-ID och API-svar sparas här.</p></div><button type="button" className="office-btn outline" disabled={historyLoading} onClick={() => void loadHistory()}><RefreshCw size={14} />Uppdatera historik</button></header>
            <SpirisManualExport user={user} actualUser={actualUser} canExport={!!state?.capabilities.canExport} onNotice={onNotice} onExport={entry => { setExports(previous => [entry, ...previous.filter(job => job.id !== entry.id)]); }} />
            {historyLoading && <p role="status">Hämtar överföringar…</p>}{historyError && <p className="spiris-preview-error" role="alert">{historyError}</p>}
            {!historyLoading && exports.length === 0 && <p>Inga avräkningar har överförts till Spiris.</p>}
            <ol>{exports.map(entry => <li key={entry.id}><div className="spiris-history-heading"><strong>Viktkort #{entry.source.cardId}</strong><span className={`environment-pill ${entry.draftId ? 'success' : 'warning'}`}>{exportLabels[entry.status] ?? entry.status}</span><span>{environmentTime(entry.createdAt)}</span></div><p>{entry.trigger === 'after_attest' ? 'Efter attest' : 'Manuell överföring'} · Attestversion {entry.source.version} · Inställningsversion {entry.settingsRevision}</p>
              <dl><div><dt>Överförings-ID</dt><dd>{entry.id}</dd></div>{entry.supplierId && <div><dt>Leverantörs-ID</dt><dd>{entry.supplierId}</dd></div>}{entry.draftId && <div><dt>Fakturautkast-ID</dt><dd>{entry.draftId}</dd></div>}</dl>
              {entry.error && <p className="spiris-preview-error">{entry.error.message}</p>}
              {Object.entries(entry.runs ?? {}).filter(([, id]) => !!id).map(([kind, id]) => {
                const run = journal[id!];
                return <details key={id} className="spiris-response-details"><summary>{kind === 'supplierRequestId' ? 'Leverantör · anrop och svar' : 'Fakturautkast · anrop och svar'}</summary><p>Journal-ID: {id}</p>{!run ? <button type="button" className="office-btn outline" disabled={!!journalLoading} onClick={() => void readJournal(id!)}>{journalLoading === id ? 'Hämtar svar…' : 'Visa API-svar'}</button> : <div className="spiris-response-journal" role="region" aria-label="Spiris svarjournal"><p>{run.method} {run.path} · {run.httpStatus == null ? 'HTTP-svar saknas' : `HTTP ${run.httpStatus}`}</p>{run.trackingId && <p>Spårnings-ID: {run.trackingId}</p>}{run.resourceId && <p>Resurs-ID: {run.resourceId}</p>}{run.error && <p>{run.error.message}</p>}<h4>Skickat underlag</h4><pre>{JSON.stringify(run.payload ?? {}, null, 2)}</pre><h4>API-svar</h4><pre>{JSON.stringify(run.response ?? null, null, 2)}</pre></div>}</details>;
              })}
            </li>)}</ol>
          </section>}
        </>}
  </section>;
}
