// Coordination for the local agency demo. This orders cooperating browser
// tabs; it is not server authentication or a production tenant boundary.
import { createDemoStorage, DemoStorageError } from '../storage.js';
import { createAgencyState, validateAgencyState, hasPermission } from './agency.js';
import { createSuiteState } from './seed.js';
import { createEmptyState, addActivity } from './core.js';
import { validateSuiteState } from './validate.js';

export const AGENCY_STORAGE_KEY = 'endor-bokforing-agency-v1';
const DIRECTORY_LOCK = `scrapplanner:bookkeeping-demo:${AGENCY_STORAGE_KEY}`;
const PERMISSION_IDS = new Set(['read', 'bookkeeping', 'payroll', 'closing', 'payments', 'export', 'manage']);

export function companyStorageKey(companyId) {
  if (companyId === 'company-ake') return 'scrapplanner-bokforing-suite-v2';
  if (companyId === 'company-bjork') return 'endor-bokforing-company-company-bjork-v1';
  throw new DemoStorageError('ACCESS_DENIED', 'Övningsbolaget finns inte. Ingen bokföring har lästs eller ändrats.');
}

function createCompanyState(companyId) {
  if (companyId === 'company-ake') return createSuiteState();
  companyStorageKey(companyId);
  const state = createEmptyState();
  Object.assign(state.company, {
    name: 'Björks El AB', orgNumber: '5599999983', vatNumber: 'SE559999998301',
  });
  addActivity(state, 'Björks tomma övningsbolag är skapat. Alla uppgifter är fiktiva.').actor = 'System';
  return state;
}

const denied = () => { throw new DemoStorageError('ACCESS_DENIED', 'Du saknar behörighet till den här åtgärden i bolaget. Ingen ändring har sparats.'); };

export function createAgencyCoordinator(options = {}) {
  const locks = options.locks ?? globalThis.navigator?.locks;
  const shared = { ...options, locks };
  const directoryStore = createDemoStorage({
    ...shared, key: AGENCY_STORAGE_KEY, createState: createAgencyState, validateState: validateAgencyState,
  });
  const companyStores = new Map();

  function companyStore(companyId) {
    const key = companyStorageKey(companyId);
    if (!companyStores.has(companyId)) companyStores.set(companyId, createDemoStorage({
      ...shared, key, createState: () => createCompanyState(companyId), validateState: validateSuiteState,
    }));
    return companyStores.get(companyId);
  }

  function authorisedDirectory(userId, companyId, permissions) {
    // A corrupt/missing coordination snapshot must never grant access using the
    // fallback demo state returned by the underlying storage reader.
    const snapshot = directoryStore.load();
    if (snapshot.error) throw snapshot.error;
    if (!Array.isArray(permissions) || permissions.length === 0 ||
      new Set(permissions).size !== permissions.length ||
      permissions.some(permission => !PERMISSION_IDS.has(permission))) denied();
    if (!hasPermission(snapshot.state, userId, companyId, 'read') ||
      permissions.some(permission => !hasPermission(snapshot.state, userId, companyId, permission))) denied();
    return snapshot;
  }

  function unchangedDirectory(expected) {
    const latest = directoryStore.load();
    if (latest.error) throw latest.error;
    if (latest.revision !== expected.revision) {
      throw new DemoStorageError('STALE_STATE', 'Behörigheterna har ändrats under sparandet. Läs in senaste uppgifter och försök igen.');
    }
  }

  function stampActivity(priorIds, next, directory, userId, companyId) {
    if (!next || !Array.isArray(next.activity)) return next;
    const user = directory.users.find(item => item.id === userId);
    const agency = directory.agencies.find(item => item.id === user.agencyId);
    const actor = agency ? `${user.name} via ${agency.name}` : user.name;
    for (const event of next.activity) {
      if (priorIds.has(event.id)) continue;
      event.actor = actor;
      event.actorId = userId;
      event.actingCompanyId = companyId;
      event.agencyId = agency?.id ?? null;
    }
    return next;
  }

  function loadCompany({ userId, companyId }) {
    authorisedDirectory(userId, companyId, ['read']);
    return companyStore(companyId).load();
  }

  async function commitCompany({ userId, companyId, permissions = ['bookkeeping'], snapshot, transition, reset = false }) {
    if (typeof locks?.request !== 'function') {
      throw new DemoStorageError('COORDINATION_UNAVAILABLE', 'Webbläsaren kan inte samordna behörigheter och sparande. Ingen ändring har sparats.');
    }
    if (reset !== true && reset !== false) denied();
    if (!reset && typeof transition !== 'function') throw new TypeError('Bokföringsuppdateringen behöver en funktion.');
    let entered = false;
    try {
      return await locks.request(DIRECTORY_LOCK, { mode: 'exclusive' }, async lock => {
        entered = true;
        if (!lock) throw new DemoStorageError('COORDINATION_UNAVAILABLE', 'Behörigheterna kunde inte låsas. Ingen ändring har sparats.');
        const requested = reset ? ['manage'] : permissions;
        const access = authorisedDirectory(userId, companyId, requested);
        const ledger = companyStore(companyId);
        if (reset) return ledger.reset(snapshot);
        return ledger.commit(snapshot, async current => {
          const priorActivityIds = new Set(current.activity.map(event => event.id));
          const next = await transition(current);
          unchangedDirectory(access);
          return stampActivity(priorActivityIds, next, access.state, userId, companyId);
        });
      });
    } catch (error) {
      if (entered || error instanceof DemoStorageError) throw error;
      throw new DemoStorageError('COORDINATION_UNAVAILABLE', 'Behörigheterna kunde inte samordnas. Ingen ändring har sparats.', error);
    }
  }

  return {
    load: () => directoryStore.load(),
    commit: (snapshot, transition) => directoryStore.commit(snapshot, transition),
    loadCompany,
    commitCompany,
  };
}
