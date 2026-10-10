import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CheckCircle2, ChevronDown, CircleAlert, PlugZap, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { can, type OfficeUser } from './model';
import { environmentApi } from './environment-client';
import { environmentFailure } from './EnvironmentSession';
import { environmentTime, type NvvIntegrationStatus, type NvvReporterInput } from './environment-types';
import NvvConnectionCheckDialog, { type NvvCheckProgress } from './NvvConnectionCheckDialog';

export const nvvModeLabel = (mode?: NvvIntegrationStatus['mode']) => mode === 'test' ? 'NVV · TEST' : mode === 'mock' ? 'NVV · simulering' : 'NVV · avstängd';
const reporterInput = (status?: NvvIntegrationStatus): NvvReporterInput => ({
  name: status?.reporter?.name ?? '', number: status?.reporter?.number ?? '', contactName: status?.reporter?.contactName ?? '',
  email: status?.reporter?.email ?? '', phone: status?.reporter?.phone ?? '',
  certificateOrganisationNumber: status?.reporter?.certificateOrganisationNumber ?? '',
  testIdentityConfirmed: status?.reporter?.testIdentityConfirmed ?? false, expectedVersion: status?.reporterVersion ?? 0,
});
const missingLabel = (value: string) => ({
  NVV_CLIENT_ID: 'Testmiljöns API-nyckel saknas på servern.', NVV_CLIENT_SECRET: 'Testmiljöns API-hemlighet saknas på servern.',
  NVV_CLIENT_PFX_SECRET_FILE: 'Klientcertifikatet saknas på servern.', NVV_CLIENT_PFX_PASSWORD: 'Certifikatets lösenord saknas på servern.',
  NVV_CLIENT_SYSTEM_ID: 'Systemnamn och version saknas i serverns NVV-inställningar.',
}[value] ?? value);

export default function NvvIntegrationPanel({ user, actualUser, status, onChange, onNotice, initialOpen = false }: {
  user: OfficeUser; actualUser: OfficeUser; status?: NvvIntegrationStatus;
  onChange: (status: NvvIntegrationStatus) => void; onNotice: (message: string) => void;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [form, setForm] = useState(() => reporterInput(status));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<'save' | 'check'>();
  const [checkProgress, setCheckProgress] = useState<NvvCheckProgress | null>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState('');
  const identity = `${actualUser.id}/${user.id}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const active = useRef(true);
  const request = useRef(0);
  const busy = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const permitted = !!status && user.level === 'Systemadmin' && actualUser.level === 'Systemadmin' && !user.siteIds && !actualUser.siteIds && can(user, 'environmentIntegration');
  const currentPermission = useRef(permitted);
  currentPermission.current = permitted;
  const certificate = status?.certificate;
  const certificateMetadata = Boolean(certificate?.metadataAvailable);
  const certificateNumber = certificateMetadata ? certificate?.organisationNumber : null;
  const certificateMismatch = Boolean(status?.mode === 'test' && certificateNumber && form.number.trim() &&
    form.number.replace(/[\s-]/g, '') !== certificateNumber);
  const certificateDate = (value: string) => Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString('sv-SE', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Datum kunde inte läsas';
  useEffect(() => { if (!dirty) setForm(reporterInput(status)); }, [status?.reporterVersion, dirty]);
  useEffect(() => {
    request.current++; busy.current = false;
    setOpen(initialOpen); setDirty(false); setError(''); setPending(undefined); setCheckProgress(null);
  }, [user.id, actualUser.id, initialOpen, permitted]);

  function update<K extends keyof NvvReporterInput>(key: K, value: NvvReporterInput[K]) {
    setForm(current => ({ ...current, [key]: value })); setDirty(true); setError('');
  }
  async function perform(action: 'save' | 'check') {
    if (!permitted || busy.current || (action === 'check' && (dirty || status?.mode === 'disabled'))) return;
    busy.current = true;
    const requestId = ++request.current;
    const isCurrent = () => active.current && currentIdentity.current === identity && currentPermission.current && request.current === requestId;
    setPending(action); setError('');
    if (action === 'check') setCheckProgress({ phase: 'running', mode: status!.mode });
    try {
      const next = action === 'save' ? await environmentApi.saveNvvReporter(form) : await environmentApi.checkNvvConnection();
      if (!isCurrent()) return;
      onChange(next);
      if (action === 'save') { setForm(reporterInput(next)); setDirty(false); onNotice('NVV:s rapporterande testorganisation är sparad.'); }
      else if (next.lastCheck?.connected) {
        setCheckProgress(current => current ? { phase: 'success', mode: next.mode, wasteCodes: next.lastCheck!.wasteCodes.length, transportModes: next.lastCheck!.transportModes.length, diagnostics: next.lastCheck!.diagnostics } : null);
        onNotice(next.mode === 'mock' ? 'Simulerad anslutningskontroll klar. Inget anrop har gjorts till NVV.' : 'Anslutningen till NVV:s testmiljö fungerar.');
      } else {
        const message = next.lastCheck?.error?.message || 'Anslutningen kunde inte bekräftas. Kontrollera serverinställningarna.';
        setError(message);
        setCheckProgress(current => current ? { phase: 'error', mode: next.mode, message, diagnostics: next.lastCheck?.diagnostics } : null);
      }
    } catch (failure) {
      if (isCurrent()) {
        const message = environmentFailure(failure);
        setError(message);
        if (action === 'check') setCheckProgress(current => current ? { phase: 'error', mode: status!.mode, message } : null);
      }
    } finally { if (isCurrent()) { busy.current = false; setPending(undefined); } }
  }

  return <section className="office-panel nvv-integration-panel" aria-label="NVV-inställningar">
    <button type="button" className="nvv-settings-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="environment-icon"><PlugZap size={21} /></span>
      <span><strong>NVV-inställningar</strong><small>{status?.mode === 'test' ? 'Anslutning och rapporterande testorganisation' : status?.mode === 'mock' ? 'Lokalt provflöde · ingen myndighetsöverföring' : 'Rapportering är avstängd tills testanslutningen är klar'}</small></span>
      <span className={`environment-pill ${status?.connected ? 'success' : 'warning'}`}><ShieldCheck size={13} />{nvvModeLabel(status?.mode)}</span>
      <ChevronDown size={17} className={open ? 'is-open' : ''} />
    </button>
    {open && <div className="nvv-settings-body">
      <div className="nvv-connection-summary">
        <div><span className={`environment-pill ${status?.connected ? 'success' : 'warning'}`}>{status?.connected ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}{status?.connected ? (status.mode === 'mock' ? 'Simulerad anslutning' : 'Testanslutning fungerar') : status?.configured ? 'Anslutning ej verifierad' : 'Inställningar saknas'}</span>
          <p>{status?.mode === 'test' ? 'Endast Naturvårdsverkets testmiljö används.' : status?.mode === 'mock' ? 'Svar och avfalls-ID:n är simulerade och gäller inte hos Naturvårdsverket.' : 'Inga rapporter kan skickas i avstängt läge.'} Produktionsrapportering är avstängd.</p>
          {status?.lastCheck && <small>Senaste kontroll: {environmentTime(status.lastCheck.checkedAt)}{status.lastCheck.connected ? ` · ${status.lastCheck.wasteCodes.length} avfallskoder · ${status.lastCheck.transportModes.length} transportsätt` : ''}</small>}
        </div>
        {permitted && <button ref={checkButton} type="button" className="office-btn outline" onClick={() => void perform('check')} disabled={!!pending || dirty || status?.mode === 'disabled'}><RefreshCw size={14} />{pending === 'check' ? 'Kontrollerar…' : status?.mode === 'mock' ? 'Prova simulerad anslutning' : 'Kontrollera testanslutning'}</button>}
      </div>
      {permitted && <p className="nvv-readonly-notice"><a className="office-link" href="/kontor/integration/systemadminintegrationtest.html"><ArrowUpRight size={14} />Öppna systemadmins NVV-testformulär</a></p>}
      {!!status?.missing.length && <div className="environment-alert"><CircleAlert size={16} /><div><strong>Återstår före testet</strong><ul>{status.missing.map(item => <li key={item}>{missingLabel(item)}</li>)}</ul></div></div>}
      <section className="environment-extra-contacts" aria-label="Klientcertifikat på servern">
        <strong>Klientcertifikat på servern</strong>
        {certificateMetadata ? <>
          <p className="nvv-readonly-notice"><strong>{certificate?.organisationName || 'Organisationsnamn saknas i certifikatet'}</strong>{certificateNumber && <> · {certificateNumber}</>}</p>
          <p className="nvv-readonly-notice">Identiteten är läst från serverns certifikatfil. {certificate?.validated ? 'Certifikatfilen är inläst.' : 'Certifikatfilen kunde inte valideras.'}</p>
          {(certificate?.issuer || certificate?.validFrom || certificate?.validTo || certificate?.fingerprint256) && <details className="environment-original-details">
            <summary>Visa certifikatuppgifter</summary>
            <dl className="environment-compact-facts">
              {certificate.issuer && <div><dt>Utfärdare</dt><dd style={{ overflowWrap: 'anywhere' }}>{certificate.issuer}</dd></div>}
              {certificate.validFrom && <div><dt>Giltigt från</dt><dd>{certificateDate(certificate.validFrom)}</dd></div>}
              {certificate.validTo && <div><dt>Giltigt till</dt><dd>{certificateDate(certificate.validTo)}</dd></div>}
              {certificate.fingerprint256 && <div><dt>SHA-256-fingeravtryck</dt><dd style={{ overflowWrap: 'anywhere' }}>{certificate.fingerprint256}</dd></div>}
            </dl>
          </details>}
        </> : <p className="nvv-readonly-notice">{certificate?.configured ? 'Certifikatets identitet kunde inte läsas från servern.' : 'Certifikatets identitet är inte tillgänglig.'} Uppgifterna i formuläret är manuellt angivna.</p>}
      </section>
      <form onSubmit={event => { event.preventDefault(); void perform('save'); }}>
        <h3>Rapporterande organisation</h3>
        {certificateMismatch && <div className="environment-alert" role="alert"><CircleAlert size={16} /><span>Verksamhetsutövaren måste matcha serverns klientcertifikat vid egen rapportering.</span></div>}
        <div className="nvv-reporter-grid">
          <label>Organisationsnamn<input value={form.name} onChange={event => update('name', event.target.value)} disabled={!permitted || !!pending} maxLength={200} required /></label>
          <label>Organisationsnummer<input value={form.number} onChange={event => update('number', event.target.value)} disabled={!permitted || !!pending} maxLength={30} required /></label>
          <label>Kontaktperson<input value={form.contactName} onChange={event => update('contactName', event.target.value)} disabled={!permitted || !!pending} maxLength={200} required /></label>
          <label>E-post<input type="email" value={form.email} onChange={event => update('email', event.target.value)} disabled={!permitted || !!pending} maxLength={250} required /></label>
          <label>Telefon<input type="tel" value={form.phone} onChange={event => update('phone', event.target.value)} disabled={!permitted || !!pending} maxLength={40} required /></label>
          <label>Organisation i klientcertifikatet<input value={form.certificateOrganisationNumber} onChange={event => update('certificateOrganisationNumber', event.target.value)} disabled={!permitted || !!pending} maxLength={30} required={status?.mode === 'test'} /><small>{certificateNumber ? <>Manuellt kontrollfält. Serverns certifikat tillhör {certificateNumber}. Fältet ändrar inte certifikatets identitet.</> : 'Manuellt kontrollfält. Servercertifikatets organisation är inte bekräftad här.'}</small></label>
        </div>
        <label className="nvv-identity-confirmation"><input type="checkbox" checked={form.testIdentityConfirmed} onChange={event => update('testIdentityConfirmed', event.target.checked)} disabled={!permitted || !!pending} /><span>Testidentiteten och certifikatets organisation har kontrollerats för denna NVV-anslutning.</span></label>
        <div className="environment-actions"><small>API-hemligheter och certifikat hanteras på servern. {status?.reporter && `Sparad version ${status.reporterVersion}.`}</small>{permitted && <div className="environment-action-buttons">{dirty && <button type="button" className="office-btn outline" disabled={!!pending} onClick={() => { setForm(reporterInput(status)); setDirty(false); setError(''); }}>Återställ ändringar</button>}<button type="submit" className="office-btn" disabled={!dirty || !!pending}><Save size={14} />{pending === 'save' ? 'Sparar…' : 'Spara testorganisation'}</button></div>}</div>
      </form>
      {!permitted && <p className="nvv-readonly-notice">Inställningarna kan ändras av systemadmin med NVV-behörighet.</p>}
      {!!error && <div className="environment-error" role="alert"><CircleAlert size={16} />{error}</div>}
    </div>}
    {checkProgress && <NvvConnectionCheckDialog progress={checkProgress} returnFocus={checkButton} onClose={() => setCheckProgress(null)} onRetry={() => void perform('check')} />}
  </section>;
}
