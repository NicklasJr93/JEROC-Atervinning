import { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { tenantPublicHeaders } from '../tenant-public-context';
import './demo-login-shortcuts.css';

type PortalRealm = 'driver' | 'carrier' | 'customer';
export interface DemoLoginAccount { id: string; label: string; username: string; password: string }

function isDemoAccount(value: unknown): value is DemoLoginAccount {
  if (!value || typeof value !== 'object') return false;
  const account = value as Partial<DemoLoginAccount>;
  return [account.id, account.label, account.username, account.password].every(field => typeof field === 'string' && field.length > 0);
}

function useDemoLoginAccounts(realm: PortalRealm) {
  const [accounts, setAccounts] = useState<DemoLoginAccount[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    setAccounts([]);
    void (async () => {
      const headers = await tenantPublicHeaders();
      if (controller.signal.aborted) return;
      const response = await fetch(`/api/${realm}/demo-config`, { credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', ...headers }, signal: controller.signal });
      if (!response.ok) return;
      const result = await response.json();
      if (!controller.signal.aborted && result?.enabled === true && result.companyId === headers['X-Client-Company'] && Array.isArray(result.accounts))
        setAccounts(result.accounts.filter(isDemoAccount));
    })().catch(() => { /* Optional shortcuts never interrupt ordinary sign-in. */ });
    return () => controller.abort();
  }, [realm]);
  return accounts;
}

export default function DemoLoginShortcuts({ realm, disabled, onSelect }: {
  realm: PortalRealm; disabled: boolean; onSelect: (account: DemoLoginAccount) => void;
}) {
  const accounts = useDemoLoginAccounts(realm);
  if (!accounts.length) return null;
  return <section className="portal-demo-login" aria-label="Demoinloggning">
    <p className="portal-demo-login-title">Prova demon</p>
    <div className="portal-demo-login-accounts">{accounts.map(account => <button key={account.id} type="button" disabled={disabled}
      onClick={() => { if (!disabled) onSelect(account); }}><UserRound size={18} aria-hidden="true" /><span>{account.label}</span></button>)}</div>
    <small>Välj ett demokonto för att fylla i uppgifterna. Tryck sedan på Logga in.</small>
  </section>;
}
