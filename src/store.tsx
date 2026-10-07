import {
  createContext,
  useContext,
  useRef,
  useState,
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
  login: (name: string, password: string) => boolean;
  logout: () => void;
  saveDraft: (draft: Draft) => boolean;
  markDraftActive: (draftId: string) => boolean;
  removeDraft: (draftId: string) => boolean;
  addCustomer: (customer: Customer, draft?: Draft) => boolean;
  reset: () => boolean;
  changePassword: (current: string, next: string) => boolean;
  linkRegistration: (customerId: string, registration: string) => boolean;
};
const DemoContext = createContext<Context | null>(null);
export function DemoProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(load);
  const [data, setData] = useState(initial.data);
  const dataRef = useRef(data);
  const [storageError, setError] = useState(initial.error);
  const [blocked, setBlocked] = useState(Boolean(initial.error));
  const [loggedIn, setLoggedIn] = useState(() => {
    try {
      return sessionStorage.getItem('jeroc.demo.login') === 'yes';
    } catch {
      return false;
    }
  });
  const [password, setPassword] = useState('Demo123!');
  const [passwordRequired, setPasswordRequired] = useState(() => {
    try {
      return sessionStorage.getItem('jeroc.demo.password-required') === 'yes';
    } catch {
      return false;
    }
  });
  function persist(next: DemoData, force = false) {
    if (blocked && !force) return false;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
      dataRef.current = next;
      setData(next);
      setError('');
      setBlocked(false);
      return true;
    } catch {
      setError(
        'Utkastet kunde inte sparas i webbläsaren. Frigör lagringsutrymme eller tillåt lokal lagring och försök igen.',
      );
      return false;
    }
  }
  const value: Context = {
    data,
    storageError,
    loggedIn,
    passwordRequired,
    login(name, provided) {
      if (
        name.trim().toLowerCase() !== 'niklas' ||
        (provided !== password && provided !== 'Demo123!')
      )
        return false;
      setPassword(provided);
      setLoggedIn(true);
      setPasswordRequired(true);
      try {
        sessionStorage.setItem('jeroc.demo.login', 'yes');
        sessionStorage.setItem('jeroc.demo.password-required', 'yes');
      } catch {
        /* Login still works for this open tab. */
      }
      return true;
    },
    logout() {
      setLoggedIn(false);
      setPasswordRequired(false);
      try {
        sessionStorage.removeItem('jeroc.demo.login');
        sessionStorage.removeItem('jeroc.demo.password-required');
      } catch {
        /* State is already cleared. */
      }
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
      return persist(seedDemo(), true);
    },
    changePassword(current, next) {
      if (current !== password) return false;
      setPassword(next);
      setPasswordRequired(false);
      try {
        sessionStorage.removeItem('jeroc.demo.password-required');
      } catch {
        /* Demo can continue in this tab. */
      }
      return true;
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
