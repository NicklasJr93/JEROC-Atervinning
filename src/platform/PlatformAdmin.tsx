import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Building2, Check, Copy, Eye, EyeOff, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { customerIdentifierError, normalizeOrganisationNumber } from '../data-format';
import CompanyLookup from '../company-register/CompanyLookup';
import { normalizeCompanyLookupNumber } from '../company-register/client';
import { platformApi } from './client';
import PlatformCompanySwitcher from './PlatformCompanySwitcher';
import PlatformFleet from './PlatformFleet';
import PlatformCommunications from './PlatformCommunications';
import PlatformUsage from './PlatformUsage';
import type { AuthenticatedPlatformSession, CompanyCreated, PlatformCompany } from './types';

const companyStatus = { active: 'Aktivt', inactive: 'Inaktivt', provisioning: 'Förbereds', failed: 'Behöver åtgärdas' };

function CompanyLinks({ company }: { company: PlatformCompany }) {
  const [message, setMessage] = useState('');
  const destinations = [
    ['Kontoret', '/kontor'], ['Mobilappen', '/mobil'], ['Kundterminal', '/terminal'],
    ['Chaufför', '/chauffor'], ['Åkeri', '/akeri'], ['Kundportal', '/kund'],
  ] as const;
  return <details className="platform-company-links"><summary>Bolagets länkar</summary><div>
    {destinations.map(([label, path]) => {
      const url = new URL(path, window.location.origin); url.searchParams.set('company', company.id);
      if (path === '/kontor') url.hash = '/dashboard';
      return <span key={path}><a href={url.toString()} target="_blank" rel="noopener noreferrer">{label}</a>
        <button type="button" className="platform-icon-btn" aria-label={`Kopiera länk till ${label} för ${company.name}`} onClick={async () => {
          try { await navigator.clipboard.writeText(url.toString()); setMessage(`Länken till ${label} är kopierad.`); }
          catch { setMessage('Kopiera länken genom att högerklicka på den.'); }
        }}><Copy size={14} /></button></span>;
    })}
    {message && <small role="status">{message}</small>}
  </div></details>;
}

function TemporaryCredentials({ credentials, onClose, reset = false }: { credentials: NonNullable<CompanyCreated['temporaryCredentials']>; onClose: () => void; reset?: boolean }) {
  const [visible, setVisible] = useState(false), [copied, setCopied] = useState(''), [error, setError] = useState('');
  const password = useRef<HTMLInputElement>(null);
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setCopied(label); setError(''); }
    catch { password.current?.focus(); password.current?.select(); setVisible(true); setError('Kopiera uppgifterna manuellt från fälten.'); }
  }
  return <section className="platform-credentials" aria-label="VD-kontots tillfälliga inloggning">
    <div className="platform-panel-heading"><h2><ShieldCheck size={21} />{reset ? 'Nytt tillfälligt lösenord' : 'VD-kontot är skapat'}</h2><button className="platform-icon-btn" type="button" onClick={onClose} aria-label="Stäng tillfälliga inloggningsuppgifter"><X size={18} /></button></div>
    <p>Spara inloggningsuppgifterna nu. Lösenordet visas bara vid skapandet och måste bytas vid första inloggningen.</p>
    <div className="platform-credential-field"><label>Användarnamn<input aria-label="VD-kontots användarnamn" value={credentials.username} readOnly /></label>
      <button className="platform-icon-btn" type="button" aria-label="Kopiera VD-kontots användarnamn" onClick={() => void copy(credentials.username, 'Användarnamnet är kopierat')}><Copy size={18} /></button></div>
    <div className="platform-credential-field"><label>Tillfälligt lösenord<input ref={password} aria-label="VD-kontots tillfälliga lösenord" type={visible ? 'text' : 'password'} value={credentials.password} readOnly autoComplete="off" /></label>
      <button className="platform-icon-btn" type="button" aria-label={visible ? 'Dölj tillfälligt lösenord' : 'Visa tillfälligt lösenord'} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
      <button className="platform-icon-btn" type="button" aria-label="Kopiera VD-kontots tillfälliga lösenord" onClick={() => void copy(credentials.password, 'Lösenordet är kopierat')}><Copy size={18} /></button></div>
    {copied && <p className="platform-copy-status" role="status"><Check size={15} />{copied}</p>}
    {error && <p className="platform-error" role="alert">{error}</p>}
    <small>Inget mejl skickas automatiskt.</small>
  </section>;
}

export default function PlatformAdmin({ session, onSwitch }: {
  session: AuthenticatedPlatformSession; onSwitch: (organisationId: string, effectiveUserId?: string) => Promise<void>;
}) {
  const [companies, setCompanies] = useState<PlatformCompany[]>(session.companies ?? []);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false), [busy, setBusy] = useState(false), [formError, setFormError] = useState('');
  const [created, setCreated] = useState<CompanyCreated>();
  const [resetting, setResetting] = useState(''), [passwordReset, setPasswordReset] = useState(false);
  const resets = useRef(new Map<string, string>());
  const [form, setForm] = useState({ name: '', organisationNumber: '', vdName: '', vdEmail: '' });
  const attempt = useRef<{ body: string; requestId: string } | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void platformApi.companies(controller.signal)
      .then(response => { if (!controller.signal.aborted) setCompanies(response.companies); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Bolagen kunde inte hämtas.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh, session.actor.id]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const validation = customerIdentifierError('Företag', form.organisationNumber);
    if (validation) { setFormError(validation); return; }
    const data = { name: form.name.trim(), organisationNumber: normalizeOrganisationNumber(form.organisationNumber), vdName: form.vdName.trim(), vdEmail: form.vdEmail.trim().toLowerCase() };
    const body = JSON.stringify(data);
    if (attempt.current?.body !== body) attempt.current = { body, requestId: crypto.randomUUID() };
    setBusy(true); setFormError('');
    try {
      const result = await platformApi.createCompany({ ...data, requestId: attempt.current!.requestId });
      setCreated(result); setPasswordReset(false); setCreating(false); setForm({ name: '', organisationNumber: '', vdName: '', vdEmail: '' });
      attempt.current = undefined; setRefresh(value => value + 1);
    } catch (failure) { setFormError(failure instanceof Error ? failure.message : 'Bolaget kunde inte skapas.'); }
    finally { setBusy(false); }
  }
  async function resetPassword(company: PlatformCompany) {
    if (busy || resetting) return;
    const requestId = resets.current.get(company.id) ?? crypto.randomUUID(); resets.current.set(company.id, requestId);
    setResetting(company.id); setError('');
    try {
      const result = await platformApi.resetInitialPassword(company.id, requestId);
      setCreated(result); setPasswordReset(true); resets.current.delete(company.id); setRefresh(value => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Ett nytt tillfälligt lösenord kunde inte skapas.'); }
    finally { setResetting(''); }
  }
  return <main className="platform-admin">
    <div className="platform-page-heading"><div><span className="platform-eyebrow">SYSTEMADMINISTRATION</span><h1>Bolag</h1><p>Hantera bolag och öppna arbetsytan med rätt behörighet.</p></div>
      <button className="platform-btn" type="button" onClick={() => setCreating(true)} disabled={busy || Boolean(resetting)}><Plus size={18} />Skapa bolag</button></div>
    <div className="platform-stats"><div><Building2 size={22} /><span>Registrerade bolag<strong>{companies.length}</strong></span></div><div><ShieldCheck size={22} /><span>Aktiva bolag<strong>{companies.filter(company => company.status === 'active').length}</strong></span></div></div>
    <PlatformCommunications session={session} />
    <PlatformUsage session={session} companies={companies} />
    {created?.temporaryCredentials && <TemporaryCredentials credentials={created.temporaryCredentials} reset={passwordReset} onClose={() => setCreated(undefined)} />}
    {created && !created.temporaryCredentials && <p className="platform-info" role="status">Bolaget {created.company.name} finns registrerat. Tillfälliga inloggningsuppgifter har redan visats och hämtas inte igen.</p>}
    {creating && <section className="platform-panel">
      <div className="platform-panel-heading"><h2>Nytt bolag</h2><button className="platform-icon-btn" type="button" disabled={busy} aria-label="Stäng skapa bolag" onClick={() => setCreating(false)}><X size={19} /></button></div>
      <p>Bolaget får en egen arbetsyta. VD:n får ett separat konto för att administrera verksamheten.</p>
      <form className="platform-form platform-company-form" onSubmit={submit}>
        <label>Bolagsnamn<input aria-label="Bolagsnamn" value={form.name} maxLength={200} required disabled={busy} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></label>
        <label>Organisationsnummer<input aria-label="Bolagets organisationsnummer" value={form.organisationNumber} placeholder="XXXXXX-XXXX" maxLength={30} required disabled={busy} onChange={event => setForm(current => ({ ...current, organisationNumber: event.target.value }))} /></label>
        <CompanyLookup
          organisationNumber={form.organisationNumber}
          enabled={session.actor.platformAdmin}
          disabled={busy}
          applyLabel="Använd bolagsnamn och organisationsnummer"
          helpText="Fyller i bolagsnamn och organisationsnummer. VD-kontot anges separat. Bolaget skapas först när du väljer att skapa det."
          scopeKey={JSON.stringify([session.actor.id, session.generation, form.name])}
          onApply={company => setForm(current => normalizeCompanyLookupNumber(current.organisationNumber) === company.organisationNumber
            ? { ...current, name: company.name, organisationNumber: company.organisationNumber }
            : current)}
        />
        <label>VD:s namn<input aria-label="VD:s namn" value={form.vdName} maxLength={200} required disabled={busy} onChange={event => setForm(current => ({ ...current, vdName: event.target.value }))} /></label>
        <label>VD:s e-post<input aria-label="VD:s e-post" value={form.vdEmail} type="email" autoComplete="email" maxLength={200} required disabled={busy} onChange={event => setForm(current => ({ ...current, vdEmail: event.target.value }))} /></label>
        {formError && <p className="platform-error" role="alert">{formError}</p>}
        <div className="platform-form-actions"><button className="platform-btn outline" type="button" disabled={busy} onClick={() => setCreating(false)}>Avbryt</button><button className="platform-btn" type="submit" disabled={busy}><Plus size={17} />{busy ? 'Skapar bolag och VD-konto…' : 'Skapa bolag och VD-konto'}</button></div>
      </form>
    </section>}
    <section className="platform-panel"><div className="platform-panel-heading"><h2>Öppna ett bolag</h2></div><PlatformCompanySwitcher session={session} companies={companies} onSwitch={onSwitch} /></section>
    {session.actor.platformAdmin && <PlatformFleet session={session} companies={companies} />}
    <section className="platform-panel"><div className="platform-panel-heading"><h2>Alla bolag</h2><button type="button" className="platform-text-btn" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} />Uppdatera</button></div>
      {error && <p className="platform-error" role="alert">{error}</p>}
      {loading && <p role="status">Hämtar bolag…</p>}
      {!loading && !companies.length && !error && <p>Inga bolag är registrerade ännu. Börja med Skapa bolag.</p>}
      <div className="platform-table-wrap"><table className="platform-table"><thead><tr><th>Bolag</th><th>Organisationsnummer</th><th>Status</th></tr></thead><tbody>
        {companies.map(company => <tr key={company.id}><td><strong>{company.name}</strong>{company.status === 'active' && <CompanyLinks company={company} />}</td><td>{company.organisationNumber}</td><td><span className={`platform-status ${company.status}`}>{companyStatus[company.status]}</span>{company.status === 'active' && company.ownerPasswordChangePending && <div className="platform-initial-password"><small>VD:n har inte bytt startlösenord än.</small><button className="platform-text-btn" type="button" disabled={busy || Boolean(resetting)} onClick={() => void resetPassword(company)}>{resetting === company.id ? 'Skapar nytt lösenord…' : 'Nytt tillfälligt lösenord'}</button></div>}</td></tr>)}
      </tbody></table></div>
    </section>
  </main>;
}
