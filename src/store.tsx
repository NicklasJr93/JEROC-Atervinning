import {
  createContext,
  useContext,
  useRef,
  useState,
  useEffect,
  type ReactNode,
} from 'react';
import {
  STORE_KEY,
  seedDemo,
  storeSchema,
  isComplete,
  normalizeRegistration,
  type DemoData,
  type Draft,
} from './model';
import type { Customer } from './data';
import { useSharedData } from './shared-data';
import { useEmployee } from './employee/EmployeeProvider';

function load(): { data: DemoData; error: string } {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (!saved) return { data: seedDemo(), error: '' };
    return { data: storeSchema.parse(JSON.parse(saved)), error: '' };
  } catch {
    return {
      data: seedDemo(),
      error:
        'Tidigare demodata kunde inte läsas. Ingenting har skrivits över. Nya utkast kan inte sparas förrän du återställer demon i Profil.',
    };
  }
}
type Context = {
  data: DemoData;
  storageError: string;
  loggedIn: boolean;
  passwordRequired: boolean;
  sharedReady: boolean;
  login: (name: string, password: string) => Promise<boolean>;
  logout: () => void;
  saveDraft: (draft: Draft) => boolean;
  markDraftActive: (draftId: string) => boolean;
  removeDraft: (draftId: string) => boolean;
  addCustomer: (customer: Customer, draft?: Draft) => boolean;
  reset: () => boolean;
  changePassword: (current: string, next: string) => Promise<boolean>;
  linkRegistration: (customerId: string, registration: string) => boolean;
};
const DemoContext = createContext<Context | null>(null);
export function DemoProvider({ children }: { children: ReactNode }) {
  const employee = useEmployee();
  const [initial] = useState(load);
  const [data, setData] = useState(initial.data);
  const dataRef = useRef(data);
  const [storageError, setError] = useState(initial.error);
  const [blocked, setBlocked] = useState(Boolean(initial.error));
  const loggedIn = Boolean(employee.session), passwordRequired = false;
  const personId = employee.session?.person.id;
  const storageKey = personId ? `${STORE_KEY}.employee.${personId}` : `${STORE_KEY}.employee.signed-out`;
  useEffect(() => {
    // A person's recovery cache never becomes another employee's current view.
    // Only the existing Niklas demo can offer its earlier local cache to the
    // server's conservative import/archive flow.
    let next: DemoData = { version: 1, drafts: [], customers: [] };
    let error = '';
    try {
      const saved = personId && localStorage.getItem(storageKey);
      if (saved) next = storeSchema.parse(JSON.parse(saved));
      else if (employee.session?.person.username === 'niklas') {
        const legacy = localStorage.getItem(STORE_KEY);
        if (legacy) next = storeSchema.parse(JSON.parse(legacy));
      }
    } catch { error = 'Återhämtningscachen kunde inte läsas. Serverns uppgifter hämtas igen.'; }
    dataRef.current = next; setData(next); setError(error); setBlocked(false);
  }, [personId, storageKey]);
  const shared = useSharedData<DemoData>({domain:'mobile',key:storageKey,identity:personId && employee.session?.capabilities.yardWork?{employee:personId}:undefined,current:dataRef,accept:next=>{setData(next);setBlocked(false);},error:setError,parse:value=>storeSchema.parse(value)});

  function persist(next: DemoData, force = false) {
    if (blocked && !force) return false;
    return shared.save(storeSchema.parse(next));
  }
  const value: Context = {
    data,
    storageError,
    loggedIn,
    passwordRequired,
    sharedReady: shared.ready,
    async login(name, provided) {
      try { await employee.login(name, provided); return true; }
      catch { return false; }
    },
    logout() {
      void employee.logout().catch(error => setError(error instanceof Error ? error.message : 'Utloggningen kunde inte slutföras.'));
    },
    saveDraft(draft) {
      const data = dataRef.current;
      if (data.drafts.find((d) => d.id === draft.id)?.status === 'ready') {
        setError('Vägningen är färdig och låst. Den kan inte ändras.');
        return false;
      }
      if (
        draft.status === 'ready' &&
        (!isComplete(draft) || draft.pendingWeight || draft.vehicleInput)
      )
        return false;
      const saved = {
        ...draft,
        status: draft.rows.some(
          (r) => r.method === 'vehicle' && r.entryAt && r.tare == null,
        )
          ? ('awaiting-exit' as const)
          : draft.status,
        updatedAt: new Date().toISOString(),
        activityOrder:
          Math.max(0, ...data.drafts.map((d) => d.activityOrder ?? 0)) + 1,
      };
      const found = data.drafts.some((d) => d.id === saved.id);
      return persist({
        ...data,
        drafts: found
          ? data.drafts.map((d) => (d.id === saved.id ? saved : d))
          : [...data.drafts, saved],
      });
    },
    markDraftActive(draftId) {
      const data = dataRef.current;
      const draft = data.drafts.find((d) => d.id === draftId);
      if (!draft || draft.status === 'ready') return false;
      const activityOrder =
        Math.max(0, ...data.drafts.map((d) => d.activityOrder ?? 0)) + 1;
      return persist({
        ...data,
        drafts: data.drafts.map((d) =>
          d.id === draftId ? { ...d, activityOrder } : d,
        ),
      });
    },
    removeDraft(draftId) {
      const data = dataRef.current;
      if (data.drafts.find((d) => d.id === draftId)?.status === 'ready')
        return false;
      return persist({
        ...data,
        drafts: data.drafts.filter((d) => d.id !== draftId),
      });
    },
    addCustomer(customer, draft) {
      const data = dataRef.current;
      if (
        draft &&
        data.drafts.find((d) => d.id === draft.id)?.status === 'ready'
      )
        return false;
      return persist({
        ...data,
        customers: [...data.customers, customer],
        drafts: draft
          ? data.drafts.map((d) =>
              d.id === draft.id
                ? {
                    ...draft,
                    customerId: customer.id,
                    reference: '',
                    origin: '',
                    updatedAt: new Date().toISOString(),
                  }
                : d,
            )
          : data.drafts,
      });
    },
    reset() {
      window.location.reload();
      return true;
    },
    async changePassword(current, next) {
      try { await employee.changePassword(current, next); return true; }
      catch { return false; }
    },
    linkRegistration(customerId, registration) {
      const data = dataRef.current;
      const plate = normalizeRegistration(registration);
      if (
        !/^[A-ZÅÄÖ0-9]{2,12}$/.test(plate) ||
        !data.customers.some((c) => c.id === customerId)
      )
        return false;
      return persist({
        ...data,
        customers: data.customers.map((c) => ({
          ...c,
          registrations: [
            ...(c.registrations ?? []).filter(
              (r) => normalizeRegistration(r) !== plate,
            ),
            ...(c.id === customerId ? [plate] : []),
          ],
        })),
      });
    },
  };
  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}
export function useDemo() {
  const value = useContext(DemoContext);
  if (!value) throw new Error('DemoProvider saknas');
  return value;
}
