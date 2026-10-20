import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Mail, RefreshCw } from 'lucide-react';
import type { Person } from './types';
import type { PersonnelClientScope } from './client';
import { readStaffInvitation, type StaffProvisionMethod, type StaffProvisionResult, type StaffInvitationStatus } from './staff-invitations-client';
import { Alert, Fact, Field, Panel, Pill } from './components/Ui';

export type StaffInvitationAttempt = {
  key: string; requestId: string; method: StaffProvisionMethod['method']; pending: boolean;
  passwordFingerprint?: string; reuseRequestId?: boolean; result?: StaffProvisionResult; error?: string;
};

export default function StaffInvitationPanel({ person, scope, attempt, onSend, onEdit }: {
  person: Person; scope: PersonnelClientScope; attempt?: StaffInvitationAttempt;
  onSend: (method: StaffProvisionMethod) => Promise<void>; onEdit: () => void;
}) {
  const [value, setValue] = useState<StaffInvitationStatus>(), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0), [method, setMethod] = useState<StaffProvisionMethod['method']>('email'), [password, setPassword] = useState('');
  const pending = attempt?.pending ?? false;
  useEffect(() => {
    if (pending) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    void readStaffInvitation(person.id, scope, controller.signal)
      .then(next => { if (!controller.signal.aborted) setValue(next); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Inbjudans status kunde inte hämtas.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [person.id, person.email, person.active, scope, refresh, pending]);
  const current = value ?? attempt?.result;
  const active = current?.status === 'active';
  const hasEmail = Boolean(person.email?.trim());
  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || loading || active || !hasEmail || !person.active || error) return;
    const choice: StaffProvisionMethod = method === 'temporary' ? { method, password } : { method };
    setPassword('');
    void onSend(choice).catch(() => {});
  }
  return <Panel title="Aktivera konto" icon={<KeyRound size={18} />} actions={
    <button type="button" className="office-link" disabled={loading || pending} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} /> Uppdatera status</button>
  }>
    <Fact label="E-postadress">{person.email || 'Saknas'}</Fact>
    {loading ? <p role="status">Hämtar kontots status…</p> : <Fact label="Aktivering"><Pill tone={active ? 'green' : current?.status === 'sent' ? 'blue' : 'grey'}>
      {active ? 'Kontot är aktiverat' : pending ? 'Förbereder inloggning…' : current?.status === 'sent' ? 'Inbjudan skickad' : current?.status === 'expired' ? 'Inbjudan har gått ut' : current?.status === 'failed' ? 'Inbjudan kunde inte skickas' : current?.status === 'temporary_password' ? 'Inväntar första lösenordsbytet' : 'Inte inbjuden'}
    </Pill></Fact>}
    {current?.status === 'sent' && current.expiresAt && <p className="hr-muted">Länken gäller till {new Date(current.expiresAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', dateStyle: 'short', timeStyle: 'short' })} och kan användas en gång.</p>}
    {!hasEmail ? <Alert tone="orange">Lägg till personens e-postadress innan du skapar inloggningen. <button type="button" className="office-link" onClick={onEdit}>Redigera kontaktuppgifter</button></Alert>
      : active ? <p className="hr-muted">Personen loggar in med sitt eget lösenord. Vid behov finns Glömt lösenord? på inloggningssidan.</p>
      : <form onSubmit={submit}>
        <Field label="Inloggningssätt" full><select aria-label="Inloggningssätt" value={method} disabled={pending} onChange={event => { setMethod(event.target.value as StaffProvisionMethod['method']); setPassword(''); }}>
          <option value="email">Skicka lösenordslänk via mejl</option><option value="temporary">Ange tillfälligt lösenord</option>
        </select></Field>
        {method === 'temporary' ? <><Field label="Tillfälligt lösenord" full><input name="temporaryPassword" aria-label="Tillfälligt lösenord" type="password" autoComplete="new-password" minLength={12} maxLength={200} required value={password} disabled={pending} onChange={event => setPassword(event.target.value)} /></Field>
          <p className="hr-muted">Minst 12 tecken. Lämna lösenordet till personen separat. Första inloggningen görs på <a href="/kontor/" target="_blank" rel="noopener noreferrer">kontorets inloggningssida</a>, där personen måste välja ett eget lösenord innan webb- och mobilappen kan användas.</p></>
          : <p className="hr-muted">Vi skickar en engångslänk där personen väljer sitt lösenord. En ny inbjudan ersätter den tidigare länken.</p>}
        <button type="submit" className="office-btn" disabled={loading || pending || !person.active || Boolean(error)}>{method === 'email' ? <Mail size={16} /> : <KeyRound size={16} />}
          {pending ? 'Förbereder…' : method === 'temporary' ? 'Spara tillfälligt lösenord' : current?.status === 'sent' || current?.status === 'expired' ? 'Skicka ny inbjudan' : 'Skicka inbjudan'}</button>
      </form>}
    {!person.active && <Alert tone="orange">Personen måste vara aktiv för att få en inloggning.</Alert>}
    {!active && (attempt?.error || error) && <Alert tone="red">{attempt?.error || error}</Alert>}
  </Panel>;
}
