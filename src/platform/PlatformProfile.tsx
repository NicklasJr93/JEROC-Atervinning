import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Save, UserRound } from 'lucide-react';
import { platformApi, PlatformRequestError } from './client';
import type { AuthenticatedPlatformSession, PlatformProfile as Profile } from './types';

const safeMessage = (failure: unknown) => failure instanceof PlatformRequestError ? failure.message
  : 'Profilen kunde inte uppdateras. Kontrollera anslutningen och försök igen.';

/** This form edits the authenticated actor, even while that actor is supporting
 * a company through another business user's permissions. The parent remounts
 * it on every actor/company/session-generation change.
 */
export default function PlatformProfile({ session }: { session: AuthenticatedPlatformSession }) {
  const [profile, setProfile] = useState<Profile>();
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(false), [reload, setReload] = useState(0);
  const pending = useRef<AbortController | undefined>(undefined), live = useRef(false);
  const backTo = session.actor.platformAdmin && !session.isSupportSession ? '/platform-admin' : '/dashboard';
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; pending.current?.abort(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setNotice(''); setConflict(false); setPassword('');
    void platformApi.profile(controller.signal).then(value => {
      if (controller.signal.aborted || !live.current) return;
      if (value.id !== session.actor.id) throw new PlatformRequestError('Kontot har ändrats. Öppna Min profil igen.', 'platform_context_changed', 409);
      setProfile(value); setEmail(value.email);
    }).catch(failure => {
      if (!controller.signal.aborted && live.current) setError(safeMessage(failure));
    }).finally(() => { if (!controller.signal.aborted && live.current) setLoading(false); });
    return () => controller.abort();
  }, [reload, session.actor.id]);
  const dirty = Boolean(profile && email.trim() !== profile.email);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!profile || !dirty || pending.current || conflict) return;
    if (!password) { setError('Bekräfta ändringen med ditt nuvarande lösenord.'); return; }
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await platformApi.updateProfile({ expectedVersion: profile.version, email: email.trim(), currentPassword: password }, controller.signal);
      if (!live.current || controller.signal.aborted || pending.current !== controller) return;
      if (value.id !== session.actor.id) throw new PlatformRequestError('Kontot har ändrats. Öppna Min profil igen.', 'platform_context_changed', 409);
      setProfile(value); setEmail(value.email); setPassword('');
      setNotice('E-postadressen är sparad och används när du väljer Glömt lösenord.');
    } catch (failure) {
      if (!live.current || controller.signal.aborted || pending.current !== controller) return;
      setError(safeMessage(failure));
      if (failure instanceof PlatformRequestError && failure.status === 409) setConflict(true);
    } finally {
      if (pending.current === controller) { pending.current = undefined; if (live.current) setBusy(false); }
    }
  }
  return <main className="platform-admin platform-profile">
    <Link className="platform-text-btn" to={backTo}><ArrowLeft size={15} />{backTo === '/platform-admin' ? 'Tillbaka till systemadmin' : 'Tillbaka till kontoret'}</Link>
    <header className="platform-page-heading"><div><span className="platform-eyebrow">DITT KONTO</span><h1>Min profil</h1><p>Din e-postadress används för att återställa lösenordet till ditt eget konto.</p></div></header>
    <section className="platform-panel" aria-label="Dina kontouppgifter">
      <h2><UserRound size={18} />Kontouppgifter</h2>
      {session.isSupportSession && <p className="platform-info">Du ändrar ditt eget konto, {session.actor.name}, även när du arbetar som en användare hos ett bolag.</p>}
      {loading ? <p role="status">Hämtar din profil…</p> : profile ? <form className="platform-form" onSubmit={save}>
        <div className="platform-profile-identity">
          <label>Namn<input aria-label="Namn" value={profile.name} readOnly /></label>
          <label>Användarnamn<input aria-label="Användarnamn" value={profile.username} autoComplete="username" readOnly /></label>
        </div>
        <label>E-postadress<input aria-label="E-postadress" type="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" required maxLength={254}
          disabled={busy || conflict} value={email} onChange={event => { setEmail(event.target.value); setNotice(''); setError(''); }} /></label>
        <small>Återställningslänkar skickas till denna adress. Inloggningens användarnamn behålls.</small>
        <label>Nuvarande lösenord<input aria-label="Nuvarande lösenord" type="password" autoComplete="current-password" maxLength={200} required={dirty}
          disabled={busy || conflict || !dirty} value={password} onChange={event => { setPassword(event.target.value); setError(''); }} /></label>
        <small>Bekräfta med ditt nuvarande lösenord när du ändrar e-postadress.</small>
        {error && <p className="platform-error" role="alert">{error}</p>}
        {notice && <p className="platform-info" role="status">{notice}</p>}
        {conflict && <button className="platform-text-btn" type="button" onClick={() => setReload(value => value + 1)}><RefreshCw size={15} />Hämta senaste profilen</button>}
        <div className="platform-form-actions"><button className="platform-text-btn" type="button" disabled={busy || !dirty || conflict} onClick={() => {
          setEmail(profile.email); setPassword(''); setError(''); setNotice('');
        }}>Avbryt</button><button className="platform-btn" type="submit" disabled={busy || !dirty || conflict}><Save size={16} />{busy ? 'Sparar…' : 'Spara e-postadress'}</button></div>
      </form> : <><p className="platform-error" role="alert">{error || 'Profilen kunde inte hämtas.'}</p><button className="platform-text-btn" type="button" onClick={() => setReload(value => value + 1)}><RefreshCw size={15} />Försök igen</button></>}
    </section>
  </main>;
}
