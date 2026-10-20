import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { can, permissionNames, sensitivePersonnelPermissions, type OfficeUser, type Permission } from '../model';
import { useEnvironmentSession } from '../EnvironmentSession';
import { OfficePageHeader } from '../OfficePageHeader';
import { personnelClientScope } from './client';
import { Alert } from './components/Ui';
import { hasDelegatedUserManagement, mayDelegateUserManagement, mayGrantStaffOwnAttest, mayGrantStaffPermission, mayGrantStaffSite, staffAccountRestriction, staffAttestCeiling } from './account-permissions';
import './personal.css';

const permissionPrerequisites: Partial<Record<Permission, Permission[]>> = {
  lmeWrite: ['lmeRead'],
  transportPlan: ['transportRead'],
  environmentStorage: ['environmentRead'],
  environmentReport: ['environmentRead'],
  environmentReportCorrect: ['environmentRead', 'environmentReport'],
  environmentIntegration: ['environmentRead'],
  integrationsRead: ['environmentRead'],
  integrationsManage: ['environmentRead', 'integrationsRead'],
  personnelWrite: ['personnelRead'],
  personnelPresenceRead: ['personnelRead'],
  personnelTimeReviewRead: ['personnelRead'],
  personnelTimeApprove: ['personnelRead', 'personnelTimeReviewRead'],
  equipmentWrite: ['equipmentRead'],
  employmentRead: ['personnelRead'],
  employmentWrite: ['personnelRead', 'employmentRead'],
  salaryRead: ['personnelRead'],
  salaryWrite: ['personnelRead', 'salaryRead'],
  absenceRead: ['personnelRead'],
  absenceWrite: ['personnelRead', 'absenceRead'],
  competenciesWrite: ['personnelRead'],
  staffingWrite: ['personnelRead', 'transportRead', 'transportPlan'],
  externalAccounts: ['personnelRead'],
  workOrdersWrite: ['workOrdersRead'],
  vesselsWrite: ['vesselsRead'],
  warehouseWrite: ['warehouseRead'],
  customerAccounts: ['vesselsRead'],
  carrierAccounts: ['workOrdersRead'],
};
function changedPermissions(current: Permission[], key: Permission, checked: boolean): Permission[] {
  if (checked) return [...new Set([...current, key, ...(permissionPrerequisites[key] ?? [])])];
  let next = current.filter(right => right !== key);
  // Removing a prerequisite also removes any dependent grants, including
  // dependencies reached through another grant such as staffing -> planning.
  let previousLength;
  do {
    previousLength = next.length;
    next = next.filter(right => !(permissionPrerequisites[right] ?? []).some(required => !next.includes(required)));
  } while (next.length !== previousLength);
  return next;
}
interface StaffAccountPanelProps {
  users: OfficeUser[]; initialUserId?: string; embedded?: boolean; navigation?: ReactNode;
  actor: OfficeUser; actualUser?: OfficeUser; sites?: { id: string; name: string }[];
  save: (users: OfficeUser[], allSiteUserIds?: string[]) => Promise<boolean>;
  onSaved?: () => Promise<void> | void;
}
const accountSaveFailure = (reason?: unknown) => {
  const message = reason instanceof Error ? reason.message.trim() : '';
  // Validation libraries can serialize their full issues array as Error.message.
  // Keep ordinary actionable server messages, not raw schemas or stack output.
  return message && message.length <= 500 && !/^[\[{]|invalid_enum_value|invalid_type|ZodError/.test(message)
    ? message
    : 'Kontot kunde inte sparas. Kontrollera kontouppgifterna och de valda behörigheterna och försök igen. Dina val finns kvar.';
};
export default function StaffAccountPanel(props: StaffAccountPanelProps) {
  const scope = personnelClientScope(props.actor, props.actualUser ?? props.actor);
  if (props.initialUserId && !props.users.some(user => user.id === props.initialUserId)) return <p className="office-muted">Det kopplade kontot kan inte visas med din aktuella åtkomst.</p>;
  return <StaffAccountEditor key={`${scope.key}:${props.initialUserId ?? 'catalog'}`} {...props} />;
}
function StaffAccountEditor({ users, initialUserId, embedded = false, navigation, actor, actualUser = actor, sites: fallbackSites, save, onSaved }: StaffAccountPanelProps) {
  const { state: environmentState } = useEnvironmentSession();
  const sites = environmentState?.sites ?? fallbackSites ?? [];
  const allSiteIds = sites.map(site => site.id);
  const availableSiteIds = sites.filter(site => mayGrantStaffSite(actor, actualUser, site.id)).map(site => site.id);
  const newAccount = (): OfficeUser => ({ id: crypto.randomUUID(), name: '', level: 'Medarbetare',
    permissions: mayGrantStaffPermission(actor, actualUser, 'view') ? ['view'] : [], siteIds: availableSiteIds,
    maxAttest: 0, ownAttest: false, active: true });
  const [selected, setSelected] = useState(users.find(person => person.id === initialUserId) ?? users[0] ?? newAccount()),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const mounted = useRef(true), pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const unrestricted = [actualUser, actor].every(principal => !Array.isArray(principal.siteIds));
  const delegating = mayDelegateUserManagement(actor, actualUser);
  const delegated = hasDelegatedUserManagement(actor, actualUser);
  const original = users.find(user => user.id === selected.id);
  const restriction = staffAccountRestriction(actor, actualUser, original ?? selected);
  const editable = !restriction;
  const attestCeiling = staffAttestCeiling(actor, actualUser);
  const grantable = (right: Permission) => mayGrantStaffPermission(actor, actualUser, right)
    && (permissionPrerequisites[right] ?? []).every(required => mayGrantStaffPermission(actor, actualUser, required));
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!editable) return;
    const invalidTarget = staffAccountRestriction(actor, actualUser, selected);
    if (invalidTarget) { setError(invalidTarget); return; }
    if (selected.maxAttest < 0 || !Number.isFinite(selected.maxAttest)
      || selected.maxAttest > attestCeiling && (delegated || selected.maxAttest !== original?.maxAttest)) {
      setError('Attestgränsen får inte överstiga din och den faktiska användarens gemensamma gräns.'); return;
    }
    if (pending.current) return;
    pending.current = true; setSaving(true); setNotice(''); setError('');
    try {
      const saved = await save(
        users.some(user => user.id === selected.id) ? users.map(user => user.id === selected.id ? selected : user) : [...users, selected],
        !Array.isArray(selected.siteIds) && unrestricted ? [selected.id] : [],
      );
      if (!mounted.current) return;
      if (!saved) { setError(accountSaveFailure()); return; }
      setNotice('Kontot och den gemensamma anläggningsåtkomsten har sparats.');
      try { await onSaved?.(); } catch { if (mounted.current) setNotice('Kontot är sparat. Uppdatera personkortet för att se den aktuella åtkomsten.'); }
    } catch (reason) { if (mounted.current) setError(accountSaveFailure(reason)); }
    finally { pending.current = false; if (mounted.current) setSaving(false); }
  }

  return (
    <>
      {!embedded && <OfficePageHeader controls={navigation}><div className="office-title">
        <div>
          <h1>Konton & behörigheter</h1>
          <p>
            Hantera konton, inloggningar och behörigheter för företaget.
          </p>
        </div>
        <button
          className="office-btn"
          disabled={saving || ![actualUser, actor].every(principal => can(principal, 'users'))}
          onClick={() => {
            setNotice(''); setError('');
            setSelected(newAccount());
          }}
        >
          <Plus size={17} />
          Nytt konto
        </button>
      </div></OfficePageHeader>}
      <div className={embedded ? 'office-account-embedded' : 'office-user-admin'}>
        {!embedded && <section className="office-panel">
          {users.map((u) => (
            <button
              className={`office-user-choice ${u.id === selected.id ? 'active' : ''}`}
              key={u.id}
              disabled={saving}
              onClick={() => {
                setSelected(u);
                setNotice(''); setError('');
              }}
            >
              <strong>{u.name}</strong>
              <small>{u.level}{u.active === false ? ' · Spärrat' : ''}</small>
            </button>
          ))}
        </section>}
        <section className="office-panel">
          <form onSubmit={submit} aria-busy={saving}>
            <h2>{embedded ? 'Inloggning & behörigheter' : selected.name || 'Nytt konto'}</h2>
            {embedded && <p className="office-muted">{selected.name} · Personligt användarkonto</p>}
            {notice && <p role="status">{notice}</p>}
            {error && <Alert tone="red">{error}</Alert>}
            {!editable && (
              <div className="office-alert">
                {restriction}
              </div>
            )}
            <label>
              Namn
              <input
                required
                value={selected.name}
                disabled={!editable || saving}
                onChange={(e) =>
                  setSelected({ ...selected, name: e.target.value })
                }
              />
            </label>
            <label>
              Kontonivå
              <select
                disabled={!editable || saving || !delegating || [actor.id, actualUser.id].includes(selected.id)}
                value={selected.level}
                onChange={(e) =>
                  setSelected({
                    ...selected,
                    level: e.target.value as OfficeUser['level'],
                  })
                }
              >
                {[...new Set(['Medarbetare', ...(delegating ? ['VD'] : []),
                  ...([actor, actualUser].every(principal => principal.level === 'Systemadmin') ? ['Systemadmin'] : []),
                  ...(!editable ? [selected.level] : [])])].map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </label>
            <div className="office-permission-grid">
              {Object.entries(permissionNames).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    disabled={!editable || saving || !grantable(key as Permission) || (selected.level !== 'Medarbetare' && !(selected.level === 'VD' && sensitivePersonnelPermissions.includes(key as Permission)))}
                    title={!grantable(key as Permission) ? key === 'users' ? 'Endast VD eller Systemadmin kan delegera användarhantering.' : 'Du får endast ge behörigheter som både du och den faktiska användaren har.' : undefined}
                    checked={key === 'users' && selected.level === 'Medarbetare' ? selected.permissions.includes('users') : can(selected, key as Permission)}
                    onChange={(e) =>
                      setSelected({
                        ...selected,
                        permissions: changedPermissions(selected.permissions, key as Permission, e.target.checked),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            {delegated && <p className="office-muted">Du kan hantera vanliga medarbetarkonton inom dina och den faktiska användarens gemensamma behörigheter, anläggningar och attestvillkor. Att ge användarhantering vidare eller ändra administratörskonton kräver VD eller Systemadmin.</p>}
            {delegating && selected.level === 'Medarbetare' && <p className="office-muted">Hantera användare låter medarbetaren skapa och administrera vanliga konton inom sin egen åtkomst. Behörigheten kan bara ges eller tas bort av VD eller Systemadmin.</p>}
            <div role="group" aria-label="Anläggningsåtkomst">
              <h3>Anläggningsåtkomst</h3>
              <label className="office-checkbox">
                <input type="checkbox" checked={!Array.isArray(selected.siteIds)} disabled={!editable || !unrestricted || saving}
                  onChange={event => setSelected({ ...selected, siteIds: event.target.checked ? undefined : allSiteIds })} />
                Alla anläggningar, även nya
              </label>
              <div className="office-permission-grid">
                {sites.map((site) => (
                  <label key={site.id}>
                    <input
                      type="checkbox"
                      disabled={!editable || saving || (!Array.isArray(selected.siteIds)) || !mayGrantStaffSite(actor, actualUser, site.id)}
                      checked={(selected.siteIds ?? allSiteIds).includes(site.id)}
                      onChange={(event) => {
                        const current: NonNullable<OfficeUser['siteIds']> =
                          selected.siteIds ?? allSiteIds;
                        setSelected({
                          ...selected,
                          siteIds: event.target.checked
                            ? [...new Set([...current, site.id])]
                            : current.filter((id) => id !== site.id),
                        });
                      }}
                    />
                    {site.name}
                  </label>
                ))}
              </div>
              <p className="office-muted">
                Kontots val är gemensamt för kontoret, mobilen, kundterminalerna och det kopplade personkortet. Inga val ger ingen anläggningsåtkomst.
              </p>
            </div>
            <label>
              Maxbelopp för attest (kr)
              <input
                type="number"
                min="0"
                max={
                  Number.isFinite(attestCeiling) ? Math.max(attestCeiling, delegated ? 0 : original?.maxAttest ?? 0) : undefined
                }
                step="0.01"
                value={selected.maxAttest}
                disabled={!editable || saving}
                onChange={(e) =>
                  setSelected({
                    ...selected,
                    maxAttest: Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="office-checkbox">
              <input
                type="checkbox"
                checked={selected.active !== false}
                disabled={!editable || saving || [actor.id, actualUser.id].includes(selected.id)}
                onChange={(e) => setSelected({ ...selected, active: e.target.checked })}
              />
              Aktivt inloggningskonto
            </label>
            <label className="office-checkbox">
              <input
                type="checkbox"
                checked={selected.ownAttest}
                disabled={!editable || saving || !mayGrantStaffOwnAttest(actor, actualUser)}
                onChange={(e) =>
                  setSelected({ ...selected, ownAttest: e.target.checked })
                }
              />
              Får attestera egna förberedda kort
            </label>
            <button className="office-btn" disabled={!editable || saving}>
              Spara behörigheter
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
