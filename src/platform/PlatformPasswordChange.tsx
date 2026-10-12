import { useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import ProductBrand from './ProductBrand';
import { platformApi } from './client';
import type { AuthenticatedPlatformSession } from './types';

export default function PlatformPasswordChange({ session, onSession, onLogout }: {
  session: AuthenticatedPlatformSession; onSession: (session: AuthenticatedPlatformSession) => void; onLogout: () => Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState(''), [newPassword, setNewPassword] = useState(''), [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (newPassword.length < 12) { setError('Använd minst 12 tecken i det nya lösenordet.'); return; }
    if (newPassword !== confirm) { setError('De nya lösenorden stämmer inte överens.'); return; }
    if (newPassword === currentPassword) { setError('Välj ett annat lösenord än det tillfälliga.'); return; }
    setBusy(true); setError('');
    try { onSession(await platformApi.changePassword(currentPassword, newPassword)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Lösenordet kunde inte ändras.'); }
    finally { setBusy(false); }
  }
  return <main className="platform-auth-screen"><section className="platform-auth-card">
    <ProductBrand large /><span className="platform-eyebrow">DITT KONTO</span>
    <h1>Välj ditt eget lösenord</h1>
    <p>Hej, {session.actor.name}! Byt det tillfälliga lösenordet innan du öppnar bolagets arbetsyta.</p>
    <form className="platform-form" onSubmit={submit}>
      <label>Tillfälligt lösenord<input type="password" aria-label="Tillfälligt lösenord" autoComplete="current-password" value={currentPassword}
        required disabled={busy} maxLength={200} onChange={event => setCurrentPassword(event.target.value)} /></label>
      <label>Nytt lösenord<input type="password" aria-label="Nytt lösenord" autoComplete="new-password" value={newPassword}
        required minLength={12} maxLength={200} disabled={busy} onChange={event => setNewPassword(event.target.value)} /></label>
      <small>Minst 12 tecken. En längre lösenfras fungerar bra.</small>
      <label>Bekräfta nytt lösenord<input type="password" aria-label="Bekräfta nytt lösenord" autoComplete="new-password" value={confirm}
        required minLength={12} maxLength={200} disabled={busy} onChange={event => setConfirm(event.target.value)} /></label>
      {error && <p className="platform-error" role="alert">{error}</p>}
      <button className="platform-btn" type="submit" disabled={busy}><ShieldCheck size={17} />{busy ? 'Sparar…' : 'Spara lösenord och fortsätt'}</button>
    </form>
    <button className="platform-text-btn" type="button" disabled={busy} onClick={() => void onLogout().catch(failure => setError(failure instanceof Error ? failure.message : 'Utloggningen misslyckades.'))}>Logga ut</button>
  </section></main>;
}
