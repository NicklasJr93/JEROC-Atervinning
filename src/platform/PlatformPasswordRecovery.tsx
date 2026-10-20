import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Mail, ShieldCheck } from 'lucide-react';
import ProductBrand from './ProductBrand';
import { platformApi, PlatformRequestError } from './client';

const requestNotice = 'Om adressen är kopplad till ett aktivt konto skickar vi en återställningslänk.';
const tokenFrom = (search: string) => {
  const values = new URLSearchParams(search).getAll('token');
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]) ? values[0] : '';
};
const failureMessage = (failure: unknown) => failure instanceof PlatformRequestError ? failure.message
  : 'Åtgärden kunde inte slutföras. Kontrollera anslutningen och försök igen.';

/** The emailed secret lives only in this mounted form. It never becomes an
 * API URL, persistent browser value, rendered field or automatic login token. */
export default function PlatformPasswordRecovery({ mode, onCompleted }: {
  mode: 'request' | 'reset'; onCompleted: () => void;
}) {
  const location = useLocation(), navigate = useNavigate();
  const [token, setToken] = useState(() => mode === 'reset' ? tokenFrom(location.search) : '');
  const [email, setEmail] = useState(''), [username, setUsername] = useState(''), [newPassword, setNewPassword] = useState(''), [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [completed, setCompleted] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined), live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; pending.current?.abort(); };
  }, []);
  useEffect(() => {
    if (mode !== 'reset' || !location.search) return;
    const next = tokenFrom(location.search);
    pending.current?.abort(); pending.current = undefined;
    setToken(next); setNewPassword(''); setConfirm(''); setCompleted(false); setError(''); setBusy(false);
    // React Router replaces the history entry without remounting this form.
    // A reload requires reopening the original email, rather than persisting a
    // password-reset credential in sessionStorage/localStorage.
    navigate('/reset-password', { replace: true });
  }, [mode, location.search, navigate]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || completed) return;
    if (mode === 'reset') {
      if (!token) { setError('Länken är ogiltig. Begär en ny återställningslänk.'); return; }
      if (newPassword.length < 12 || newPassword.length > 200) { setError('Använd 12–200 tecken i det nya lösenordet.'); return; }
      if (newPassword !== confirm) { setError('De nya lösenorden stämmer inte överens.'); return; }
    }
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError('');
    try {
      if (mode === 'request') {
        await platformApi.requestPasswordReset(email.trim(), controller.signal, username.trim() || undefined);
      } else {
        await platformApi.confirmPasswordReset({ token, newPassword, confirmPassword: confirm }, controller.signal);
      }
      if (!live.current || controller.signal.aborted || pending.current !== controller) return;
      setCompleted(true); setNewPassword(''); setConfirm(''); setToken('');
      if (mode === 'reset') onCompleted();
    } catch (failure) {
      if (live.current && !controller.signal.aborted && pending.current === controller) setError(failureMessage(failure));
    } finally {
      if (pending.current === controller) {
        pending.current = undefined;
        if (live.current) setBusy(false);
      }
    }
  }

  return <main className="platform-auth-screen"><section className="platform-auth-card">
    <ProductBrand large /><span className="platform-eyebrow">DITT KONTO</span>
    <h1>{mode === 'request' ? 'Glömt lösenord?' : completed ? 'Lösenordet är ändrat' : 'Välj ett nytt lösenord'}</h1>
    {completed ? <>
      <p className="platform-info" role="status">{mode === 'request' ? requestNotice
        : 'Ditt nya lösenord är sparat och tidigare sessioner har avslutats. Logga in på nytt för att fortsätta.'}</p>
      {mode === 'request' && <p>Länken gäller i 30 minuter och kan bara användas en gång. Kontrollera även skräpposten. Saknas ett mejl kan du kontakta systemadmin.</p>}
    </> : mode === 'reset' && !token ? <p className="platform-error" role="alert">Länken saknas eller är ogiltig. Öppna länken i mejlet igen eller begär en ny.</p> : <>
      <p>{mode === 'request' ? 'Ange e-postadressen som är registrerad för ditt konto. Vi skickar en länk där du väljer ett nytt lösenord.'
        : 'Välj och bekräfta ditt nya lösenord. När det sparats behöver du logga in på nytt.'}</p>
      <form className="platform-form" onSubmit={submit}>
        {mode === 'request' ? <>
          <label>E-postadress<input aria-label="E-postadress" type="email" autoComplete="email" autoCapitalize="none" autoCorrect="off"
            required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} autoFocus /></label>
          <label>Användarnamn (valfritt)<input aria-label="Användarnamn (valfritt)" autoComplete="username" autoCapitalize="none" autoCorrect="off"
            maxLength={200} placeholder="Till exempel admin" value={username} disabled={busy} onChange={event => setUsername(event.target.value)} /></label>
          <small>Ange även användarnamn om flera konton använder samma e-postadress.</small>
        </> : <>
          <label>Nytt lösenord<input aria-label="Nytt lösenord" type="password" autoComplete="new-password" required minLength={12} maxLength={200}
            value={newPassword} disabled={busy} onChange={event => setNewPassword(event.target.value)} autoFocus /></label>
          <small>Minst 12 tecken. En längre lösenfras fungerar bra.</small>
          <label>Bekräfta nytt lösenord<input aria-label="Bekräfta nytt lösenord" type="password" autoComplete="new-password" required minLength={12} maxLength={200}
            value={confirm} disabled={busy} onChange={event => setConfirm(event.target.value)} /></label>
        </>}
        {error && <p className="platform-error" role="alert">{error}</p>}
        <button className="platform-btn" type="submit" disabled={busy}>{mode === 'request' ? <Mail size={17} /> : <ShieldCheck size={17} />}
          {busy ? mode === 'request' ? 'Skickar…' : 'Sparar…' : mode === 'request' ? 'Skicka återställningslänk' : 'Spara nytt lösenord'}</button>
      </form>
    </>}
    {mode === 'reset' && !completed && <Link className="platform-text-btn" to="/forgot-password">Begär en ny återställningslänk</Link>}
    <Link className="platform-text-btn" to="/dashboard"><ArrowLeft size={15} />Tillbaka till inloggning</Link>
  </section></main>;
}
