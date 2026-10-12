import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, MapPin } from 'lucide-react';
import { employeeError, useEmployee } from './EmployeeProvider';

export function ActiveSitePicker() {
  const { session, setActiveSite } = useEmployee();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [online, setOnline] = useState(() => navigator.onLine);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const identity = `${session?.companyId ?? ''}:${session?.person.id ?? ''}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const sites = session?.sites.filter(site => site.active !== false && session.person.siteIds.includes(site.id)) ?? [];
  const current = sites.find(site => site.id === session?.activeSiteId);

  useEffect(() => { setOpen(false); setBusy(false); setError(''); }, [identity]);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);

  async function choose(siteId: string) {
    if (busy) return;
    if (siteId === current?.id) { setOpen(false); return; }
    const initiatingIdentity = identityRef.current;
    setBusy(true); setError('');
    try { await setActiveSite(siteId); if (identityRef.current === initiatingIdentity) { setOpen(false); trigger.current?.focus(); } }
    catch (caught) { if (identityRef.current === initiatingIdentity) setError(employeeError(caught)); }
    finally { if (identityRef.current === initiatingIdentity) setBusy(false); }
  }

  if (sites.length <= 1) return <span className="employee-site-current" aria-label={`Aktiv anläggning: ${current?.name ?? sites[0]?.name ?? 'Anläggning saknas'}`}><MapPin size={15} aria-hidden="true" /><span>{current?.name ?? sites[0]?.name ?? 'Anläggning saknas'}</span></span>;
  return <div className="employee-site-picker" ref={root}>
    <button ref={trigger} type="button" className="employee-site-trigger" aria-label={`Byt anläggning, ${current?.name ?? 'Välj anläggning'}`} aria-haspopup="listbox" aria-expanded={open} disabled={busy} onClick={() => { setError(''); setOpen(value => !value); }}>
      <MapPin size={15} aria-hidden="true" /><span>{current?.name ?? 'Välj anläggning'}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div className="employee-site-popover">
      <div className="employee-site-options" role="listbox" aria-label="Anläggning" aria-busy={busy}>
        {sites.map(site => <button type="button" key={site.id} role="option" aria-selected={site.id === current?.id} disabled={busy || !online} onClick={() => void choose(site.id)}><span>{site.name}</span>{site.id === current?.id && <Check size={16} aria-hidden="true" />}</button>)}
      </div>
      {busy && <p role="status">Sparar anläggning…</p>}
      {!online && <p role="status">Anläggningen kan inte bytas utan anslutning. Försök igen när du är online.</p>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}
