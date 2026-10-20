import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import ProductBrand from './ProductBrand';
import { platformApi } from './client';
import type { AuthenticatedPlatformSession } from './types';

export default function PlatformLogin({ onSession }: { onSession: (session: AuthenticatedPlatformSession) => void }) {
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { onSession(await platformApi.login(username, password)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Inloggningen misslyckades.'); }
    finally { setBusy(false); }
  }
  return <main className="platform-auth-screen">
    <section className="platform-auth-card">
      <ProductBrand large />
      <span className="platform-eyebrow">KONTORET</span>
      <h1>Välkommen tillbaka</h1>
      <p>Logga in för att öppna ditt bolags arbetsyta.</p>
      <form className="platform-form" onSubmit={submit}>
        <label>Användarnamn eller e-post<input aria-label="Användarnamn eller e-post" autoComplete="username" value={username} required maxLength={200}
          disabled={busy} onChange={event => setUsername(event.target.value)} autoFocus /></label>
        <label>Lösenord<input aria-label="Lösenord" type="password" autoComplete="current-password" value={password} required maxLength={200}
          disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
        {error && <p className="platform-error" role="alert">{error}</p>}
        <button className="platform-btn" type="submit" disabled={busy}><LockKeyhole size={17} />{busy ? 'Loggar in…' : 'Logga in'}<ArrowRight size={17} /></button>
      </form>
      <Link className="platform-text-btn" to="/forgot-password">Glömt lösenord?</Link>
    </section>
  </main>;
}
