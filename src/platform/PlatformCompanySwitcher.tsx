import { useEffect, useState } from 'react';
import { Building2, LogIn } from 'lucide-react';
import { platformApi } from './client';
import type { AuthenticatedPlatformSession, PlatformCompany, PlatformCompanyUser } from './types';

export default function PlatformCompanySwitcher({ session, companies, onSwitch, compact = false }: {
  session: AuthenticatedPlatformSession; companies: PlatformCompany[];
  onSwitch: (organisationId: string, effectiveUserId?: string) => Promise<void>; compact?: boolean;
}) {
  const [organisationId, setOrganisationId] = useState(session.organisationId ?? session.company?.id ?? '');
  const [effectiveUserId, setEffectiveUserId] = useState(''), [users, setUsers] = useState<PlatformCompanyUser[]>([]);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    setUsers([]);
    setEffectiveUserId(organisationId === (session.organisationId ?? session.company?.id) && session.user.level !== 'Systemadmin' ? session.effectiveUserId ?? session.user.id : '');
    setError('');
    if (!session.actor.platformAdmin || !organisationId) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    void platformApi.companyUsers(organisationId, controller.signal)
      .then(response => { if (!controller.signal.aborted) setUsers(response.users.filter(user => user.active !== false)); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Användarna kunde inte hämtas.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [organisationId, session.actor.id, session.actor.platformAdmin, session.effectiveUserId, session.organisationId, session.company?.id, session.user.id, session.user.level]);
  return <div className={`platform-switcher${compact ? ' compact' : ''}`}>
    <label><span><Building2 size={15} />{session.actor.platformAdmin ? 'Jobba som bolag' : 'Bolag'}</span>
      <select aria-label="Jobba som bolag" value={organisationId} disabled={busy} onChange={event => setOrganisationId(event.target.value)}>
        <option value="">Välj bolag…</option>
        {companies.map(company => <option key={company.id} value={company.id} disabled={company.status !== 'active'}>{company.name}{company.status !== 'active' ? ' · inte aktivt' : ''}</option>)}
      </select>
    </label>
    {session.actor.platformAdmin && <label><span>Behörighet</span><select aria-label="Jobba som användare" value={effectiveUserId}
      disabled={busy || loading || !organisationId || Boolean(error)} onChange={event => setEffectiveUserId(event.target.value)}>
      <option value="">{loading ? 'Hämtar användare…' : 'Systemadmin · egen behörighet'}</option>
      {users.map(user => <option key={user.id} value={user.id}>{user.name} · {user.level}</option>)}
    </select></label>}
    <button type="button" className="platform-btn" disabled={busy || !organisationId || loading || Boolean(error)} onClick={async () => {
      setBusy(true); setError('');
      try { await onSwitch(organisationId, effectiveUserId || undefined); }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'Bolaget kunde inte öppnas.'); }
      finally { setBusy(false); }
    }}><LogIn size={16} />{busy ? 'Öppnar…' : 'Öppna arbetsyta'}</button>
    {error && <p className="platform-error" role="alert">{error}</p>}
  </div>;
}
