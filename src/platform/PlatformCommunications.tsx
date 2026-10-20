import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Mail, RefreshCw, Send } from 'lucide-react';
import { platformApi } from './client';
import type { AuthenticatedPlatformSession, PlatformCommunicationsConfig, PlatformTestEmailResult } from './types';

export default function PlatformCommunications({ session }: { session: AuthenticatedPlatformSession }) {
  const allowed = session.actor.platformAdmin && !session.isSupportSession && !session.mustChangePassword
    && (!session.company || session.company.id === 'jeroc-demo');
  const scopeKey = JSON.stringify([session.actor.id, session.generation, session.organisationId, session.company?.id, allowed]);
  const scope = useRef(scopeKey); scope.current = scopeKey;
  const attempts = useRef(new Map<string, string>());
  const pending = useRef<AbortController | undefined>(undefined);
  const [config, setConfig] = useState<PlatformCommunicationsConfig>();
  const [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState(false), [to, setTo] = useState(''), [busy, setBusy] = useState(false);
  const [configError, setConfigError] = useState(''), [error, setError] = useState('');
  const [result, setResult] = useState<PlatformTestEmailResult>();

  useEffect(() => {
    pending.current?.abort(); pending.current = undefined; attempts.current.clear();
    setOpen(false); setTo(''); setBusy(false); setError(''); setResult(undefined);
    return () => { pending.current?.abort(); };
  }, [scopeKey]);

  useEffect(() => {
    const controller = new AbortController();
    setConfig(undefined); setConfigError(''); setLoading(allowed);
    if (allowed) void platformApi.communications(controller.signal)
      .then(value => {
        if (controller.signal.aborted || scope.current !== scopeKey) return;
        if (!value || typeof value !== 'object' || !value.email || typeof value.email.configured !== 'boolean'
          || value.email.provider !== 'resend' || typeof value.email.from !== 'string' || !value.email.from.trim()
          || value.email.from.length > 320 || !value.sms || typeof value.sms.configured !== 'boolean')
          throw new Error('Utskickstjänsten gav ett ofullständigt svar. Uppdatera status och försök igen.');
        setConfig(value);
      })
      .catch(failure => {
        if (!controller.signal.aborted && scope.current === scopeKey)
          setConfigError(failure instanceof Error ? failure.message : 'Utskickstjänstens status kunde inte hämtas.');
      })
      .finally(() => { if (!controller.signal.aborted && scope.current === scopeKey) setLoading(false); });
    return () => controller.abort();
  }, [allowed, refresh, scopeKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || busy || !allowed || !config?.email.configured) return;
    const recipient = to.trim().toLowerCase();
    if (!recipient || recipient.length > 254 || /[\r\n,;]/.test(recipient)) {
      setError('Ange en giltig e-postadress till en mottagare.'); return;
    }
    const requestId = attempts.current.get(recipient) ?? crypto.randomUUID();
    attempts.current.set(recipient, requestId);
    const controller = new AbortController(); pending.current = controller;
    const principal = scope.current;
    let timedOut = false;
    const timeout = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    setBusy(true); setError(''); setResult(undefined);
    try {
      const response = await platformApi.sendTestEmail({ to: recipient, requestId }, controller.signal);
      controller.signal.throwIfAborted();
      if (scope.current !== principal) return;
      if (response.status !== 'accepted' || response.requestId !== requestId || typeof response.to !== 'string' || response.to.toLowerCase() !== recipient)
        throw new Error('Utskicket kunde inte bekräftas. Försök igen med samma mottagare.');
      attempts.current.delete(recipient); setResult(response);
    } catch (failure) {
      if ((!controller.signal.aborted || timedOut) && scope.current === principal)
        setError(timedOut ? 'Testmejlet kunde inte bekräftas i tid. Försök igen med samma mottagare.'
          : failure instanceof Error ? failure.message : 'Testmejlet kunde inte bekräftas. Försök igen med samma mottagare.');
    } finally {
      globalThis.clearTimeout(timeout);
      if (pending.current === controller) pending.current = undefined;
      if (scope.current === principal) setBusy(false);
    }
  }

  if (!allowed) return null;
  return <section className="platform-panel platform-communications" aria-label="Systemutskick">
    <div className="platform-panel-heading"><h2><Mail size={20} />Systemutskick</h2>
      <button type="button" className="platform-text-btn" disabled={loading || busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} />Uppdatera status</button></div>
    <p>Testa ScrapPlanners gemensamma mejlavsändare från ditt systemadminkonto.</p>
    {loading && <p role="status">Kontrollerar mejltjänsten…</p>}
    {configError && <p className="platform-error" role="alert">{configError}</p>}
    {config && <>
      <div className="platform-communications-sender"><span>Avsändare<strong>{config.email.from}</strong></span>
        <span className={`platform-status ${config.email.configured ? 'active' : 'inactive'}`}>{config.email.configured ? 'Resend konfigurerat' : 'Mejltjänsten är inte konfigurerad'}</span></div>
      {!config.email.configured && <p className="platform-info">Spara RESEND_API_KEY i appserverns miljövariabler och deploya för att aktivera mejltestet.</p>}
      <button type="button" className="platform-btn outline" aria-expanded={open} aria-controls="platform-email-test-form" disabled={!config.email.configured || busy} onClick={() => { setOpen(value => !value); setError(''); setResult(undefined); }}><Mail size={16} />Testa mejlutskick</button>
      {open && <form id="platform-email-test-form" className="platform-form platform-email-test-form" onSubmit={event => void submit(event)}>
        <label>Mottagarens e-postadress<input type="email" autoComplete="email" value={to} required maxLength={254} disabled={busy} onChange={event => { setTo(event.target.value); setError(''); setResult(undefined); }} /></label>
        <p className="platform-email-test-help">Ett testmejl skickas till den angivna adressen när du väljer Skicka testmejl.</p>
        <div className="platform-form-actions"><button type="submit" className="platform-btn" disabled={busy || !to.trim() || !config.email.configured}><Send size={16} />{busy ? 'Skickar…' : 'Skicka testmejl'}</button></div>
      </form>}
    </>}
    {error && <p className="platform-error" role="alert">{error}</p>}
    {result && <p className="platform-info platform-email-test-result" role="status">Resend har tagit emot testmejlet till <strong>{result.to}</strong> för utskick. Kontrollera inkorgen och skräpposten. Leveransen till inkorgen är ännu inte bekräftad.</p>}
    <p className="platform-communications-sms">SMS förbereds för kundgodkännanden och transportaviseringar. Ingen SMS-leverantör är ansluten.</p>
  </section>;
}
