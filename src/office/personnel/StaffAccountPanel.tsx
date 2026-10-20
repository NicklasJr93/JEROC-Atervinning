import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { can, permissionNames, sensitivePersonnelPermissions, type OfficeUser, type Permission } from '../model';
import { useEnvironmentSession } from '../EnvironmentSession';
import { OfficePageHeader } from '../OfficePageHeader';
import { personnelClientScope } from './client';

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
export default function StaffAccountPanel(props: StaffAccountPanelProps) {
  const scope = personnelClientScope(props.actor, props.actualUser ?? props.actor);
  if (props.initialUserId && !props.users.some(user => user.id === props.initialUserId)) return <p className="office-muted">Det kopplade kontot kan inte visas med din aktuella åtkomst.</p>;
  if (!props.users.length) return <p className="office-muted">Inga konton finns tillgängliga.</p>;
  return <StaffAccountEditor key={`${scope.key}:${props.initialUserId ?? 'catalog'}`} {...props} />;
}
function StaffAccountEditor({ users, initialUserId, embedded = false, navigation, actor, actualUser = actor, sites: fallbackSites, save, onSaved }: StaffAccountPanelProps) {
  const { state: environmentState } = useEnvironmentSession();
  const sites = environmentState?.sites ?? fallbackSites ?? [];
  const allSiteIds = sites.map(site => site.id);
  const [selected, setSelected] = useState(users.find(person => person.id === initialUserId) ?? users[0]),
    [notice, setNotice] = useState(''),
    [saving, setSaving] = useState(false);
  const mounted = useRef(true), pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const unrestricted = [actualUser, actor].every(principal => !Array.isArray(principal.siteIds));
  const withinActorScope = [actualUser, actor].every(principal => !Array.isArray(principal.siteIds) || Array.isArray(selected.siteIds) && selected.siteIds.every(id => principal.siteIds!.includes(id)));
  const editable = [actualUser, actor].every(principal => can(principal, 'users')) && withinActorScope &&
    (actor.level === 'Systemadmin' && actualUser.level === 'Systemadmin' || selected.level !== 'Systemadmin');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (
      !editable ||
      selected.maxAttest < 0 ||
      (actor.level !== 'Systemadmin' && selected.maxAttest > actor.maxAttest) ||
      !Number.isFinite(selected.maxAttest)
    )
      return;
    if (pending.current) return;
    pending.current = true; setSaving(true); setNotice('');
    try {
      const saved = await save(
        users.some(user => user.id === selected.id) ? users.map(user => user.id === selected.id ? selected : user) : [...users, selected],
        !Array.isArray(selected.siteIds) && unrestricted ? [selected.id] : [],
      );
      if (!mounted.current || !saved) return;
      setNotice('Kontot och den gemensamma anläggningsåtkomsten har sparats.');
      try { await onSaved?.(); } catch { if (mounted.current) setNotice('Kontot är sparat. Uppdatera personkortet för att se den aktuella åtkomsten.'); }
    } catch (reason) { if (mounted.current) setNotice(reason instanceof Error ? reason.message : 'Kontot kunde inte sparas.'); }
    finally { pending.current = false; if (mounted.current) setSaving(false); }
  }

  return (
    <>
      {!embedded && <OfficePageHeader controls={navigation}><div className="office-title">
        <div>
          <h1>Konton & behörigheter</h1>
          <p>
            Hantera även konton utan anställning. Kontorets inloggning är fortfarande ett demoflöde.
          </p>
        </div>
        <button
          className="office-btn"
          onClick={() => {
            setNotice('');
            setSelected({
              id: crypto.randomUUID(),
              name: '',
              level: 'Medarbetare',
              permissions: ['view'],
              siteIds: actor.siteIds ?? allSiteIds,
              maxAttest: 0,
              ownAttest: false,
              active: true,
            });
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
              onClick={() => {
                setSelected(u);
                setNotice('');
              }}
            >
              <strong>{u.name}</strong>
              <small>{u.level}{u.active === false ? ' · Spärrat' : ''}</small>
            </button>
          ))}
        </section>}
        <section className="office-panel">
          <form onSubmit={submit}>
            <h2>{embedded ? 'Inloggning & behörigheter' : selected.name || 'Nytt konto'}</h2>
            {embedded && <p className="office-muted">{selected.name} · Personligt användarkonto</p>}
            {notice && <p role="status">{notice}</p>}
            {!editable && (
              <div className="office-alert">
                VD kan inte ändra ett systemadminkonto.
              </div>
            )}
            <label>
              Namn
              <input
                required
                value={selected.name}
                disabled={!editable}
                onChange={(e) =>
                  setSelected({ ...selected, name: e.target.value })
                }
              />
            </label>
            <label>
              Kontonivå
              <select
                disabled={!editable || selected.id === actor.id}
                value={selected.level}
                onChange={(e) =>
                  setSelected({
                    ...selected,
                    level: e.target.value as OfficeUser['level'],
                  })
                }
              >
                {[
                  'Medarbetare',
                  'VD',
                  ...(actor.level === 'Systemadmin' ? ['Systemadmin'] : []),
                ].map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </label>
            <div className="office-permission-grid">
              {Object.entries(permissionNames).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    disabled={!editable || (selected.level !== 'Medarbetare' && !(selected.level === 'VD' && sensitivePersonnelPermissions.includes(key as Permission)))}
                    checked={can(selected, key as Permission)}
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
                      disabled={!editable || saving || (!Array.isArray(selected.siteIds)) || (![actualUser, actor].every(principal => !principal.siteIds || principal.siteIds.includes(site.id)) && !(selected.siteIds ?? allSiteIds).includes(site.id))}
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
                  actor.level === 'Systemadmin' ? undefined : actor.maxAttest
                }
                step="0.01"
                value={selected.maxAttest}
                disabled={!editable}
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
                disabled={!editable || selected.id === actor.id}
                onChange={(e) => setSelected({ ...selected, active: e.target.checked })}
              />
              Aktivt inloggningskonto
            </label>
            <label className="office-checkbox">
              <input
                type="checkbox"
                checked={selected.ownAttest}
                disabled={!editable}
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
