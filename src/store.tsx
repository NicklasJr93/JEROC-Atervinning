import { createContext, useContext, useState, type ReactNode } from 'react';
import {
  STORE_KEY,
  seedDemo,
  storeSchema,
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
  login: (name: string, password: string) => boolean;
  logout: () => void;
  saveDraft: (draft: Draft) => boolean;
  removeDraft: (draftId: string) => boolean;
  addCustomer: (customer: Customer, draft?: Draft) => boolean;
  reset: () => boolean;
  changePassword: (current: string, next: string) => boolean;
};
const DemoContext = createContext<Context | null>(null);
export function DemoProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(load);
  const [data, setData] = useState(initial.data);
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
  function persist(next: DemoData, force = false) {
    if (blocked && !force) return false;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
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
    login(name, provided) {
      if (name.trim().toLowerCase() !== 'niklas' || provided !== password)
        return false;
      setLoggedIn(true);
      try {
        sessionStorage.setItem('jeroc.demo.login', 'yes');
      } catch {
        /* Login still works for this open tab. */
      }
      return true;
    },
    logout() {
      setLoggedIn(false);
      try {
        sessionStorage.removeItem('jeroc.demo.login');
      } catch {
        /* State is already cleared. */
      }
    },
    saveDraft(draft) {
      const saved = {
        ...draft,
        status: draft.rows.some(
          (r) => r.method === 'vehicle' && r.entryAt && r.tare == null,
        )
          ? ('awaiting-exit' as const)
          : draft.status,
        updatedAt: new Date().toISOString(),
      };
      const found = data.drafts.some((d) => d.id === saved.id);
      return persist({
        ...data,
        drafts: found
          ? data.drafts.map((d) => (d.id === saved.id ? saved : d))
          : [...data.drafts, saved],
      });
    },
    removeDraft(draftId) {
      return persist({
        ...data,
        drafts: data.drafts.filter((d) => d.id !== draftId),
      });
    },
    addCustomer(customer, draft) {
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
      return true;
    },
  };
  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}
export function useDemo() {
  const value = useContext(DemoContext);
  if (!value) throw new Error('DemoProvider saknas');
  return value;
}
