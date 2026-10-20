import { OfficePageHeader } from './OfficePageHeader';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowUpRight, Building2, CheckCircle2, ChevronRight, CircleAlert,
  Clock3, FileText, Fingerprint, Leaf, Mail, MapPin, PhoneCall, PlugZap, RefreshCw,
  ShieldCheck, TrendingUp, Wallet, type LucideIcon,
} from 'lucide-react';
import { can, type OfficeUser } from './model';
import { environmentApi, environmentRequest } from './environment-client';
import { environmentFailure, useEnvironmentSession } from './EnvironmentSession';
import type { NvvIntegrationStatus } from './environment-types';
import NvvIntegrationPanel from './NvvIntegrationPanel';
import SpirisAccountingPanel from './SpirisAccountingPanel';
import SwishIntegrationPanel from './SwishIntegrationPanel';
import OpenPaymentsIntegrationPanel from './OpenPaymentsIntegrationPanel';
import MailIntegrationPanel from './MailIntegrationPanel';
import GoogleAddressIntegrationPanel from './GoogleAddressIntegrationPanel';
import { cacheIntegrationRead, cachedIntegrationRead, clearIntegrationReadCache, integrationReadScope } from './integration-read-cache';
import './environment.css';
import './integrations.css';

const AiSupportSettings = lazy(() => import('../ai-support/AiSupportSettings'));

export interface IntegrationProvider {
  id: string;
  name: string;
  description: string;
  category: string;
  status: 'planned' | 'disabled' | 'not-configured' | 'not-verified' | 'connected' | 'error';
  mode: 'planned' | 'disabled' | 'mock' | 'test' | 'production';
  implemented: boolean;
  configured: boolean;
  connected: boolean;
  capabilities: { canView: boolean; canConfigure: boolean; canCheck: boolean; canConnect: false };
  requiredSetup: string[];
  lastCheckedAt?: string;
  links: { settings?: string };
}

interface IntegrationCatalog {
  version: number;
  organisationId: string;
  providers: IntegrationProvider[];
  capabilities: { canManage: boolean };
}

export interface IntegrationsWorkspaceProps {
  user: OfficeUser;
  actualUser: OfficeUser;
  users?: OfficeUser[];
  siteId?: string;
  onNotice: (message: string) => void;
}

const providerPresentation: Record<string, { icon: LucideIcon; functions: string[]; preparation: string }> = {
  nvv: {
    icon: Leaf,
    functions: ['Rapportering av mottaget farligt avfall', 'Kvittens och avfalls-ID från testmiljön', 'Spårbar skickhistorik och kontrollerade rättelser'],
    preparation: 'Testorganisation och serveranslutning ställs in nedan. Skickning sker från Miljörapportering.',
  },
  visma: {
    icon: FileText,
    functions: ['Ekonomiinställningar och konton från ert svenska testföretag', 'Fakturautkast från kundgodkända och attesterade avräkningar', 'Skickat underlag, API-svar och överföringshistorik'],
    preparation: 'Behörig VD eller systemadmin ansluter bolagets sandboxföretag på testsidan. Anslutningen sparas separat för bolaget.',
  },
  bank: {
    icon: Building2,
    functions: ['Bankbetalningar med bankens godkännande i sandbox', 'Bolagets konton och testsaldon via bankmedgivande', 'Bekräftade bankresultat och separat bokföring i Spiris'],
    preparation: 'Välj testbank och anslut bolagets bankkonto i inställningarna. Inga riktiga pengar flyttas.',
  },
  swish: {
    icon: Wallet,
    functions: ['Swish-utbetalningar till privatpersoner i MSS', 'Signerade testinstruktioner och återläst betalningsstatus', 'Spårbar betalningsjournal och koppling till Spiris sandbox'],
    preparation: 'Bolagets MSS-test aktiveras i inställningarna. Inga riktiga pengar flyttas.',
  },
  fortnox: {
    icon: Wallet,
    functions: ['Leverantörsunderlag från färdiga avräkningar', 'Kontomappning och exporthistorik', 'Återkoppling av bekräftade bokföringsreferenser'],
    preparation: 'Ekonomiflöde och vilka underlag som ska överföras behöver bestämmas inför anslutningen.',
  },
  microsoft365: {
    icon: Mail,
    functions: ['Flera egna och delade inkorgar', 'Inkomna mejl med kundmatchning', 'Individuellt styrd inkorgsåtkomst'],
    preparation: 'Anslut Microsoft-kontot nedan och välj vilka inkorgar personalen får läsa.',
  },
  gmail: {
    icon: Mail,
    functions: ['Google-inkorgar i den gemensamma mejlvyn', 'Vald åtkomst per inkorg', 'Samma kundmatchning som Microsoft 365'],
    preparation: 'Google-kopplingen följer efter första Microsoft 365-versionen.',
  },
  bankid: {
    icon: Fingerprint,
    functions: ['Kundgodkännande med BankID', 'QR-kod på kundterminalen', 'Verifierad identitet knuten till rätt avräkningsversion'],
    preparation: 'BankID-leverantör, avtal och testidentiteter behövs innan riktig signering kan provas.',
  },
  messaging: {
    icon: Mail,
    functions: ['Godkännandelänkar via SMS och e-post', 'Bokningsförfrågningar och transportaviseringar', 'Leveransstatus och skickhistorik'],
    preparation: 'Välj leverantör och avsändare för SMS och e-post inför aktiveringen.',
  },
  'google-maps': {
    icon: MapPin,
    functions: ['Förslag på svenska postadresser', 'Gata, postnummer och ort i separata fält', 'Granska och bekräfta adressen innan formuläret ändras'],
    preparation: 'Två separata nycklar läggs på appservern: en webbläsarnyckel begränsad till webbplatser och en servernyckel för adresskontroll.',
  },
  lme: {
    icon: TrendingUp,
    functions: ['Marknadspriser som underlag till prismotorn', 'Tidsstämplade prisuppdateringar', 'Prishistorik för uppföljning'],
    preparation: 'Prisleverantör och licens behöver väljas. Manuella LME-priser används under tiden.',
  },
};

const categoryLabels: Record<string, string> = {
  environment: 'Miljö & myndigheter', accounting: 'Ekonomi', productivity: 'Kontor & kalender',
  identity: 'Identifiering', messaging: 'Meddelanden', maps: 'Kartor & adresser', market: 'Marknadspriser', payments: 'Betalningar',
};
const categoryLabel = (category: string) => categoryLabels[category] ?? category;

function providerStatus(provider: IntegrationProvider) {
  if (provider.status === 'planned') return { label: 'Planerad', tone: 'muted', icon: Clock3 };
  if (provider.status === 'error') return { label: 'Kontrollera anslutning', tone: 'error', icon: CircleAlert };
  if (provider.mode === 'mock') return { label: 'Simulerat test', tone: 'test', icon: ShieldCheck };
  if (provider.status === 'disabled') return { label: 'Avstängd', tone: 'muted', icon: PlugZap };
  if (provider.status === 'not-configured') return { label: 'Inställningar saknas', tone: 'warning', icon: CircleAlert };
  if (provider.status === 'not-verified') return provider.id === 'google-maps'
    ? { label: 'Konfigurerad', tone: 'test', icon: ShieldCheck }
    : { label: 'Ej verifierad', tone: 'warning', icon: CircleAlert };
  return { label: provider.mode === 'test' ? 'Testanslutning klar' : 'Ansluten', tone: 'success', icon: CheckCircle2 };
}

function IntegrationStatus({ provider }: { provider: IntegrationProvider }) {
  const status = providerStatus(provider);
  const Icon = status.icon;
  return <span className={`integration-status ${status.tone}`}><Icon size={13} />{status.label}</span>;
}

export default function IntegrationsWorkspace({ user, actualUser, users, siteId = 'all', onNotice }: IntegrationsWorkspaceProps) {
  const { session, loading: sessionLoading, error: sessionError, refreshSession } = useEnvironmentSession();
  const [search, setSearch] = useSearchParams();
  const requestedId = search.get('service') ?? '';
  const selectedId = requestedId === 'outlook' ? 'microsoft365' : requestedId;
  const [catalog, setCatalog] = useState<IntegrationCatalog>();
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [nvv, setNvv] = useState<NvvIntegrationStatus>();
  const [nvvLoading, setNvvLoading] = useState(false);
  const [nvvError, setNvvError] = useState('');
  const [googleRefresh, setGoogleRefresh] = useState(0);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const catalogGeneration = useRef(0);
  const nvvGeneration = useRef(0);
  const readable = can(user, 'integrationsRead');
  const nvvReadable = can(user, 'environmentRead');
  const identity = `${actualUser.id}/${actualUser.level}/${actualUser.permissions.join(',')}/${actualUser.siteIds?.join(',') ?? 'all'}/${user.id}/${user.level}/${user.permissions.join(',')}/${user.siteIds?.join(',') ?? 'all'}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const matchingSession = session?.actualUserId === actualUser.id && session?.effectiveUserId === user.id;
  const cacheScope = integrationReadScope(actualUser, user, session);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    catalogGeneration.current += 1; nvvGeneration.current += 1;
    setCatalog(undefined); setCatalogError(''); setCatalogLoading(false);
    setNvv(undefined); setNvvError(''); setNvvLoading(false);
  }, [identity]);

  const loadCatalog = useCallback(async (signal?: AbortSignal, force = false) => {
    if (!matchingSession || !readable) return;
    const generation = ++catalogGeneration.current;
    const current = () => mounted.current && !signal?.aborted && identityRef.current === identity && catalogGeneration.current === generation;
    const cached = !force && cachedIntegrationRead<IntegrationCatalog>('catalog', cacheScope);
    if (cached) { setCatalog(cached.value); if (cached.fresh) { setCatalogLoading(false); setCatalogError(''); return; } }
    setCatalogLoading(true); setCatalogError('');
    try {
      const value = await environmentRequest<IntegrationCatalog>('/integrations/catalog', 'GET', undefined, signal);
      if (current()) { cacheIntegrationRead('catalog', cacheScope, value); setCatalog(value); }
    } catch (failure) {
      if (current()) setCatalogError(environmentFailure(failure));
    } finally {
      if (current()) setCatalogLoading(false);
    }
  }, [identity, matchingSession, readable, cacheScope]);

  const loadNvv = useCallback(async (signal?: AbortSignal) => {
    if (!matchingSession || !nvvReadable) return;
    const generation = ++nvvGeneration.current;
    const current = () => mounted.current && !signal?.aborted && identityRef.current === identity && nvvGeneration.current === generation;
    setNvvLoading(true); setNvvError('');
    try {
      const value = await environmentApi.nvvStatus(signal);
      if (current()) setNvv(value);
    } catch (failure) {
      if (current()) setNvvError(environmentFailure(failure));
    } finally {
      if (current()) setNvvLoading(false);
    }
  }, [identity, matchingSession, nvvReadable]);

  useEffect(() => {
    const controller = new AbortController();
    void loadCatalog(controller.signal);
    return () => controller.abort();
  }, [loadCatalog]);

  useEffect(() => {
    if (selectedId !== 'nvv' || !readable) return;
    const controller = new AbortController();
    void loadNvv(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadNvv(controller.signal);
    }, 15000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [selectedId, loadNvv, readable]);

  const providers = catalog?.providers.filter(provider => provider.capabilities.canView) ?? [];
  const selected = providers.find(provider => provider.id === selectedId);
  // The known settings endpoint authorizes this service itself. Do not put a
  // catalog read in front of it when opening a direct Spiris settings link.
  const parallelSpiris = selectedId === 'visma' && (!catalog || !!selected?.implemented);
  const parallelSwish = selectedId === 'swish' && (!catalog || !!selected?.implemented);
  const parallelBank = selectedId === 'bank' && (!catalog || !!selected?.implemented);
  const parallelMail = selectedId === 'microsoft365';
  const parallelAi = selectedId === 'ai-support';
  const parallelGoogle = selectedId === 'google-maps';
  const mayManageAi = [user, actualUser].every(account => account.active !== false && ['Systemadmin', 'VD'].includes(account.level));
  const selectedPresentation = selected && providerPresentation[selected.id];
  const SelectedIcon = selectedPresentation?.icon ?? PlugZap;

  useEffect(() => { detailHeading.current?.focus(); }, [selected?.id]);

  async function update() {
    if (!matchingSession) { await refreshSession().catch(() => undefined); return; }
    if (parallelGoogle) setGoogleRefresh(value => value + 1);
    await Promise.all([loadCatalog(undefined, true), selectedId === 'nvv' ? loadNvv() : Promise.resolve()]);
  }

  function nvvChanged(next: NvvIntegrationStatus) {
    nvvGeneration.current += 1;
    setNvv(next); setNvvError(''); setNvvLoading(false);
    clearIntegrationReadCache('catalog');
    void loadCatalog(undefined, true);
  }

  function backToIntegrations() {
    if (parallelAi && !window.dispatchEvent(new Event('scrappilot:before-ai-support-navigation', { cancelable: true }))) return;
    setSearch({});
  }

  if (!readable) return <section className="integrations-workspace"><div className="office-panel integration-message"><ShieldCheck size={19} /><span>Du saknar behörighet att visa integrationer.</span></div></section>;

  return <section className="integrations-workspace">
    <OfficePageHeader>
      {(parallelSpiris || parallelSwish || parallelBank || parallelMail || parallelAi || parallelGoogle || selected) && <button type="button" className="office-link integration-back" onClick={backToIntegrations}><ArrowLeft size={15} />Alla integrationer</button>}
    <div className="office-title integration-page-title">
      <div><span className="office-eyebrow">BOLAGETS ANSLUTNINGAR</span><h1>{parallelAi ? 'AI-kundmottagning' : selectedId === 'visma' ? 'Spiris / Visma eEkonomi' : selectedId === 'swish' ? 'Swish Utbetalning' : selectedId === 'bank' ? 'Bank · Open Payments' : parallelMail ? 'Mejl & inkorgar' : parallelGoogle ? 'Google adresser' : 'Integrationer'}</h1><p>{parallelAi ? 'Ge kundmottagaren rätt kunskap, röst och tydliga gränser.' : selectedId === 'visma' ? 'Ekonomiinställningar för avräkningar och era anläggningar.' : selectedId === 'swish' ? 'Testutbetalningar och bokföringskoppling för bolaget.' : selectedId === 'bank' ? 'Bankbetalningar, konton och bankmedgivande i sandbox.' : parallelMail ? 'Microsoft 365/Outlook och åtkomst till företagets inkorgar.' : parallelGoogle ? 'Adressförslag och bekräftade postadresser i formulären.' : 'Koppla bolaget till myndigheter, ekonomi och andra tjänster.'}</p></div>
      {!parallelAi && <button type="button" className="office-btn outline" onClick={() => void update()} disabled={catalogLoading || sessionLoading || nvvLoading}><RefreshCw size={14} />Uppdatera</button>}
    </div>
    </OfficePageHeader>
    {siteId !== 'all' && <p className="integration-scope"><Building2 size={14} />Anslutningarna är gemensamma för alla anläggningar.</p>}

    {!matchingSession && <div className={`office-panel integration-message ${sessionError ? 'error' : ''}`} role={sessionError ? 'alert' : 'status'}>
      {sessionError ? <CircleAlert size={19} /> : <RefreshCw size={19} />}<span>{sessionError || (sessionLoading ? 'Hämtar anslutningar…' : 'Anslutningarna kunde inte hämtas.')}</span>
      {!sessionLoading && <button type="button" className="office-btn outline" onClick={() => void refreshSession().catch(() => undefined)}>Försök igen</button>}
    </div>}
    {matchingSession && catalogError && !parallelAi && <div className="office-panel integration-message error" role="alert"><CircleAlert size={19} /><span>{catalogError}</span><button type="button" className="office-btn outline" onClick={() => void loadCatalog(undefined, true)} disabled={catalogLoading}>Försök igen</button></div>}
    {matchingSession && !catalog && !catalogError && !parallelSpiris && !parallelSwish && !parallelBank && !parallelMail && !parallelAi && <div className="office-panel integration-message" role="status"><RefreshCw size={19} /><span>Hämtar integrationer…</span></div>}
    {matchingSession && parallelSpiris && <>
      <SpirisAccountingPanel user={user} actualUser={actualUser} onNotice={onNotice} />
    </>}
    {matchingSession && parallelSwish && <SwishIntegrationPanel user={user} actualUser={actualUser} onNotice={onNotice} />}
    {matchingSession && parallelBank && <OpenPaymentsIntegrationPanel user={user} actualUser={actualUser} onNotice={onNotice} />}
    {matchingSession && parallelMail && <MailIntegrationPanel user={user} actualUser={actualUser} users={users} onNotice={onNotice} />}
    {matchingSession && parallelGoogle && <GoogleAddressIntegrationPanel user={user} actualUser={actualUser} refreshKey={googleRefresh} />}

    {matchingSession && parallelAi && <Suspense fallback={<div className="office-panel integration-message" role="status">Öppnar AI-inställningar…</div>}><AiSupportSettings /></Suspense>}

    {!!catalog && matchingSession && !parallelSpiris && !parallelSwish && !parallelBank && !parallelMail && !parallelAi && !parallelGoogle && <>
      {selected ? <>
        {selected.id === 'visma' && selected.implemented ? <SpirisAccountingPanel user={user} actualUser={actualUser} onNotice={onNotice} /> : <article className="office-panel integration-detail">
          <div className="integration-detail-heading"><span className={`integration-icon ${selected.id}`}><SelectedIcon size={25} /></span><div><small>{categoryLabel(selected.category)}</small><h2 ref={detailHeading} tabIndex={-1}>{selected.name}</h2><p>{selected.description}</p></div><IntegrationStatus provider={selected} /></div>
          <div className="integration-detail-columns">
            <div><h3>{selected.implemented ? 'Det här ingår' : 'Planerade funktioner'}</h3><ul className="integration-functions">{(selectedPresentation?.functions ?? [selected.description]).map(item => <li key={item}><ChevronRight size={14} /><span>{item}</span></li>)}</ul></div>
            <div><h3>{selected.implemented ? 'Anslutningen' : 'Inför anslutning'}</h3><p>{selectedPresentation?.preparation ?? 'Den här kopplingen förbereds inför en kommande uppdatering.'}</p>{selected.requiredSetup.length > 0 && selected.id !== 'nvv' && <ul className="integration-setup">{selected.requiredSetup.map(item => <li key={item}>{item}</li>)}</ul>}</div>
          </div>
          {!selected.implemented && <div className="integration-planned"><Clock3 size={18} /><div><strong>Planerad integration</strong><p>Kopplingen kan inte anslutas ännu. Inga uppgifter skickas till {selected.name}.</p></div></div>}
          {selected.id === 'nvv' && <div className="integration-test-note"><ShieldCheck size={16} /><span>{selected.mode === 'mock' ? 'Simulerat provflöde. Inga uppgifter skickas till Naturvårdsverket.' : 'Endast testanslutning är tillgänglig. Produktionsrapportering är avstängd.'}</span></div>}
          {selected.id === 'visma' && selected.implemented && <div className="integration-test-note"><ShieldCheck size={16} /><span>Sandboxprov av leverantörer och fakturautkast. Anslutning och test kräver bolagets integrationsbehörighet.</span></div>}
          {selected.id === 'visma' && selected.implemented && catalog.capabilities.canManage && <Link className="office-btn" to="/integrations/visma-test"><PlugZap size={16} />Öppna Spiris-test</Link>}
        </article>}
        {selected.id === 'nvv' && <div className="environment-workspace integration-nvv-region">
          {!nvvReadable ? <div className="office-panel integration-message"><ShieldCheck size={19} /><span>Du behöver behörighet att läsa miljöunderlag för att visa NVV-inställningarna.</span></div>
            : nvvError ? <div className="office-panel integration-message error" role="alert"><CircleAlert size={19} /><span>{nvvError}</span><button type="button" className="office-btn outline" onClick={() => void loadNvv()} disabled={nvvLoading}>Försök igen</button></div>
              : nvv ? <NvvIntegrationPanel user={user} actualUser={actualUser} status={nvv} onChange={nvvChanged} onNotice={onNotice} initialOpen />
                : <div className="office-panel integration-message" role="status"><RefreshCw size={19} /><span>Hämtar NVV-inställningar…</span></div>}
        </div>}
      </> : <>
        {selectedId && <p className="integration-unknown" role="status">Integrationen kunde inte visas. Välj en av anslutningarna nedan.</p>}
        <div className="integration-grid" aria-label="Tillgängliga integrationspaket">
          {providers.map(provider => {
            const Icon = providerPresentation[provider.id]?.icon ?? PlugZap;
            return <button type="button" key={provider.id} className="office-panel integration-card" aria-label={provider.name} onClick={() => setSearch({ service: provider.id })}>
              <div className="integration-card-top"><span className={`integration-icon ${provider.id}`}><Icon size={25} /></span><IntegrationStatus provider={provider} /></div>
              <small>{categoryLabel(provider.category)}</small><h2>{provider.name}</h2><p>{provider.description}</p>
              <span className="integration-card-link">{provider.implemented ? 'Visa anslutning' : 'Visa planerad koppling'}<ArrowUpRight size={15} /></span>
            </button>;
          })}
          {mayManageAi && <button type="button" onClick={() => setSearch({ service: 'ai-support' })} className="office-panel integration-card" aria-label="AI-kundmottagning · inställningar">
            <div className="integration-card-top"><span className="integration-icon"><PhoneCall size={25} /></span><span className="integration-status test">TEST</span></div>
            <small>Kundkontakt</small><h2>AI-kundmottagning</h2><p>Välj röst och godkänn den kunskap som kundmottagaren får använda. Prova samtal och följ upp ärenden.</p>
            <span className="integration-card-link">Öppna inställningar<ArrowUpRight size={15} /></span>
          </button>}
        </div>
        {!providers.length && !mayManageAi && <div className="office-panel integration-message"><PlugZap size={19} /><span>Inga integrationer är tillgängliga för ditt konto.</span></div>}
      </>}
    </>}
  </section>;
}
