import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { can, permissionNames, sensitivePersonnelPermissions, type OfficeUser, type Permission } from '../model';
import { useEnvironmentSession } from '../EnvironmentSession';

const permissionPrerequisites: Partial<Record<Permission, Permission[]>> = {
  lmeWrite: ['lmeRead'],
  transportPlan: ['transportRead'],
  environmentStorage: ['environmentRead'],
  personnelWrite: ['personnelRead'],
  employmentRead: ['personnelRead'],
  employmentWrite: ['personnelRead', 'employmentRead'],
  salaryRead: ['personnelRead'],
  salaryWrite: ['personnelRead', 'salaryRead'],
  absenceRead: ['personnelRead'],
  absenceWrite: ['personnelRead', 'absenceRead'],
  competenciesWrite: ['personnelRead'],
  staffingWrite: ['personnelRead', 'transportRead', 'transportPlan'],
  externalAccounts: ['personnelRead'],
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
export default function StaffAccountPanel({
  users,
  initialUserId,
  embedded = false,
  actor,
  sites: fallbackSites,
  save,
}: {
  users: OfficeUser[];
  initialUserId?: string;
  embedded?: boolean;
  actor: OfficeUser;
  sites?: { id: string; name: string }[];
  save: (u: OfficeUser[]) => Promise<boolean>;
}) {
  const { state: environmentState } = useEnvironmentSession();
  const sites = environmentState?.sites ?? fallbackSites ?? [{ id: 'norrtalje', name: 'Norrtälje' }, { id: 'rimbo', name: 'Rimbo' }];
  const allSiteIds = sites.map(site => site.id);
  const [selected, setSelected] = useState(users.find(person => person.id === initialUserId) ?? users[0]),
    [notice, setNotice] = useState(''),
    [saving, setSaving] = useState(false);
  const editable = can(actor, 'users') &&
    (actor.level === 'Systemadmin' || selected.level !== 'Systemadmin');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (
      !editable ||
      selected.maxAttest < 0 ||
      (actor.level !== 'Systemadmin' && selected.maxAttest > actor.maxAttest) ||
      !Number.isFinite(selected.maxAttest)
    )
      return;
    setSaving(true);
    if (
      await save(
        users.some((u) => u.id === selected.id)
          ? users.map((u) => (u.id === selected.id ? selected : u))
          : [...users, selected],
      )
    )
      setNotice(
        'Kontot och behörigheterna har sparats.',
      );
    setSaving(false);
  }
  return (
    <>
      {!embedded && <div className="office-title">
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
      </div>}
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
            {embedded && <p className="office-muted">{selected.name} · Kontorets demokonto</p>}
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
            <div role="group" aria-label="Anläggningar">
              <h3>Anläggningar</h3>
              <div className="office-permission-grid">
                {sites.map((site) => (
                  <label key={site.id}>
                    <input
                      type="checkbox"
                      disabled={!editable || (actor.level !== 'Systemadmin' &&
                        !(actor.siteIds ?? allSiteIds).includes(site.id) &&
                        !(selected.siteIds ?? allSiteIds).includes(site.id))}
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
                Styr åtkomst till kundterminaler och miljöuppgifter. Inga val ger ingen anläggningsåtkomst.
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
