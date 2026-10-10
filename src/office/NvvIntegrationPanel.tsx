import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, CircleAlert, PlugZap, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { can, type OfficeUser } from './model';
import { environmentApi } from './environment-client';
import { environmentFailure } from './EnvironmentSession';
import { environmentTime, type NvvIntegrationStatus, type NvvReporterInput } from './environment-types';

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
  const [error, setError] = useState('');
  const identity = `${actualUser.id}/${user.id}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const permitted = !!status && user.level === 'Systemadmin' && actualUser.level === 'Systemadmin' && !user.siteIds && !actualUser.siteIds && can(user, 'environmentIntegration');
  useEffect(() => { if (!dirty) setForm(reporterInput(status)); }, [status?.reporterVersion, dirty]);
  useEffect(() => { setOpen(initialOpen); setDirty(false); setError(''); setPending(undefined); }, [user.id, actualUser.id, initialOpen]);

  function update<K extends keyof NvvReporterInput>(key: K, value: NvvReporterInput[K]) {
    setForm(current => ({ ...current, [key]: value })); setDirty(true); setError('');
  }
  async function perform(action: 'save' | 'check') {
    if (!permitted || pending) return;
    setPending(action); setError('');
    try {
      const next = action === 'save' ? await environmentApi.saveNvvReporter(form) : await environmentApi.checkNvvConnection();
      if (!active.current || currentIdentity.current !== identity) return;
      onChange(next);
      if (action === 'save') { setForm(reporterInput(next)); setDirty(false); onNotice('NVV:s rapporterande testorganisation är sparad.'); }
      else if (next.lastCheck?.connected) onNotice(next.mode === 'mock' ? 'Simulerad anslutningskontroll klar. Inget anrop har gjorts till NVV.' : 'Anslutningen till NVV:s testmiljö fungerar.');
      else setError(next.lastCheck?.error?.message || 'Anslutningen kunde inte bekräftas. Kontrollera serverinställningarna.');
    } catch (failure) { if (active.current && currentIdentity.current === identity) setError(environmentFailure(failure)); }
    finally { if (active.current && currentIdentity.current === identity) setPending(undefined); }
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
        {permitted && <button type="button" className="office-btn outline" onClick={() => void perform('check')} disabled={!!pending || dirty || status?.mode === 'disabled'}><RefreshCw size={14} />{pending === 'check' ? 'Kontrollerar…' : status?.mode === 'mock' ? 'Prova simulerad anslutning' : 'Kontrollera testanslutning'}</button>}
      </div>
      {!!status?.missing.length && <div className="environment-alert"><CircleAlert size={16} /><div><strong>Återstår före testet</strong><ul>{status.missing.map(item => <li key={item}>{missingLabel(item)}</li>)}</ul></div></div>}
      <form onSubmit={event => { event.preventDefault(); void perform('save'); }}>
        <h3>Rapporterande organisation</h3>
        <div className="nvv-reporter-grid">
          <label>Organisationsnamn<input value={form.name} onChange={event => update('name', event.target.value)} disabled={!permitted || !!pending} maxLength={200} required /></label>
          <label>Organisationsnummer<input value={form.number} onChange={event => update('number', event.target.value)} disabled={!permitted || !!pending} maxLength={30} required /></label>
          <label>Kontaktperson<input value={form.contactName} onChange={event => update('contactName', event.target.value)} disabled={!permitted || !!pending} maxLength={200} required /></label>
          <label>E-post<input type="email" value={form.email} onChange={event => update('email', event.target.value)} disabled={!permitted || !!pending} maxLength={250} required /></label>
          <label>Telefon<input type="tel" value={form.phone} onChange={event => update('phone', event.target.value)} disabled={!permitted || !!pending} maxLength={40} required /></label>
          <label>Organisation i klientcertifikatet<input value={form.certificateOrganisationNumber} onChange={event => update('certificateOrganisationNumber', event.target.value)} disabled={!permitted || !!pending} maxLength={30} required={status?.mode === 'test'} /><small>Ange testorganisationens nummer enligt certifikatet.</small></label>
        </div>
        <label className="nvv-identity-confirmation"><input type="checkbox" checked={form.testIdentityConfirmed} onChange={event => update('testIdentityConfirmed', event.target.checked)} disabled={!permitted || !!pending} /><span>Testidentiteten och certifikatets organisation har kontrollerats för denna NVV-anslutning.</span></label>
        <div className="environment-actions"><small>API-hemligheter och certifikat hanteras på servern. {status?.reporter && `Sparad version ${status.reporterVersion}.`}</small>{permitted && <div className="environment-action-buttons">{dirty && <button type="button" className="office-btn outline" disabled={!!pending} onClick={() => { setForm(reporterInput(status)); setDirty(false); setError(''); }}>Återställ ändringar</button>}<button type="submit" className="office-btn" disabled={!dirty || !!pending}><Save size={14} />{pending === 'save' ? 'Sparar…' : 'Spara testorganisation'}</button></div>}</div>
      </form>
      {!permitted && <p className="nvv-readonly-notice">Inställningarna kan ändras av systemadmin med NVV-behörighet.</p>}
      {!!error && <div className="environment-error" role="alert"><CircleAlert size={16} />{error}</div>}
    </div>}
  </section>;
}
