import {
  createContext,
  useContext,
  useRef,
  useState,
  useEffect,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import {
  STORE_KEY,
  storeSchema,
  isComplete,
  normalizeRegistration,
  type DemoData,
  type Draft,
} from './model';
import { mergeCustomerPriceCatalog, updateCustomerPriceCatalog, type Customer } from './data';
import { useSharedData } from './shared-data';
import { useEmployee } from './employee/EmployeeProvider';
import { employeeCompanyId, employeeIdentity, employeeRecoveryKey, legacyEmployeeRecoveryKey } from './employee/cache';
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
  const [data, setData] = useState<DemoData>({ version: 1, drafts: [], customers: [] });
  const dataRef = useRef(data);
  const [storageError, setError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const loggedIn = Boolean(employee.session), passwordRequired = false;
  const personId = employee.session?.person.id;
  const companyId = employeeCompanyId(employee.session?.companyId);
  const identity = employeeIdentity(companyId, personId);
  const identityRef = useRef(identity); identityRef.current = identity;
  const storageKey = employeeRecoveryKey(companyId, personId);
  const location = useLocation();
  const priceCustomerId = location.pathname.startsWith('/prices') ? new URLSearchParams(location.search).get('customer') : undefined;
  const [priceRevision, setPriceRevision] = useState('');
  const [priceRetry, retryPrice] = useState(0);
  const [, redrawPrices] = useState(0);
  useEffect(() => {
    // Quotes are personal recovery data. A new session never sees the previous
    // employee's cached quote map, and offline reloads retain only its own map.
    updateCustomerPriceCatalog({}); setPriceRevision('');
    if (!personId) return;
    try {
      const saved = JSON.parse(localStorage.getItem(`${storageKey}.prices`) ?? 'null');
      if (saved?.personId === personId && saved.companyId === companyId && mergeCustomerPriceCatalog(saved.prices)) redrawPrices(value => value + 1);
    } catch { /* A damaged optional price cache cannot block weighing. */ }
  }, [personId, companyId, storageKey]);
  useEffect(() => {
    // A person's recovery cache never becomes another employee's current view.
    // Only the existing Niklas demo can offer its earlier local cache to the
    // server's conservative import/archive flow.
    let next: DemoData = { version: 1, drafts: [], customers: [] };
    let error = '';
    try {
      const legacyKey = legacyEmployeeRecoveryKey(companyId, personId);
      const saved = personId && (localStorage.getItem(storageKey) ?? (legacyKey ? localStorage.getItem(legacyKey) : null));
      if (saved) next = storeSchema.parse(JSON.parse(saved));
      else if (companyId === 'jeroc-demo' && employee.session?.person.username === 'niklas') {
        const legacy = localStorage.getItem(STORE_KEY);
        if (legacy) next = storeSchema.parse(JSON.parse(legacy));
      }
    } catch { error = 'Återhämtningscachen kunde inte läsas. Serverns uppgifter hämtas igen.'; }
    dataRef.current = next; setData(next); setError(error); setBlocked(false);
  }, [personId, companyId, storageKey]);
  const shared = useSharedData<DemoData>({domain:'mobile',key:STORE_KEY,identity:personId && employee.session?.capabilities.yardWork?{employee:personId,companyId}:undefined,current:dataRef,accept:next=>{setData(next);setBlocked(false);},error:setError,parse:value=>storeSchema.parse(value)});
  useEffect(() => {
    const changed = (event: Event) => {
      const value = (event as CustomEvent<{ identity: string; revision: string }>).detail;
      if (value?.identity === identity) setPriceRevision(value.revision);
    };
    const visible = () => { if (!document.hidden) retryPrice(value => value + 1); };
    window.addEventListener('jeroc:mobile-pricing-change', changed);
    window.addEventListener('online', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('jeroc:mobile-pricing-change', changed);
      window.removeEventListener('online', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [identity]);
  useEffect(() => {
    if (!personId || !shared.ready || !priceCustomerId || navigator.onLine === false || document.hidden ||
        !data.customers.some(customer => customer.id === priceCustomerId)) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/application/mobile-prices?customerId=${encodeURIComponent(priceCustomerId)}`, {
          credentials: 'same-origin', cache: 'no-store', signal: abort.signal, headers: { 'X-Employee-Company': companyId },
        });
        if (response.status === 401) window.dispatchEvent(new Event('jeroc:employee-session-check'));
        if (!response.ok) return;
        const result = await response.json();
        if (abort.signal.aborted || identityRef.current !== identity || !result.customerPrices?.[priceCustomerId]) return;
        const prices = mergeCustomerPriceCatalog({ [priceCustomerId]: result.customerPrices[priceCustomerId] });
        if (!prices) return;
        redrawPrices(value => value + 1);
        try { localStorage.setItem(`${storageKey}.prices`, JSON.stringify({ companyId, personId, prices, revision: result.mobilePricingRevision })); }
        catch { /* The live quote is usable even when optional offline caching is full. */ }
      } catch { /* Keep this person's earlier quotes on a temporary connection failure. */ }
    })();
    return () => abort.abort();
  }, [personId, companyId, identity, storageKey, shared.ready, priceCustomerId, priceRevision, priceRetry, data.customers.length]);

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
                    originDetails: undefined,
                    customerSelectionsSavedAt: undefined,
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
