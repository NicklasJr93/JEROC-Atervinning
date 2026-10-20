import { useEffect, useState } from 'react';
import { tenantPublicContext } from './tenant-public-context';

/** Portals share the already-cached server-selected company. Product branding
 * stays ScrapPlanner; operational instructions name the actual customer company. */
export function useTenantCompanyName(): string {
  const [name, setName] = useState('verksamheten');
  useEffect(() => {
    let active = true;
    void tenantPublicContext().then(context => {
      if (active && context.companyName.trim()) setName(context.companyName);
    }).catch(() => { /* The portal's authenticated request reports selection errors. */ });
    return () => { active = false; };
  }, []);
  return name;
}
