import { useEffect, useRef } from 'react';
import { Recycle, Scale } from 'lucide-react';
import { useEmployee } from './EmployeeProvider';
import { employeeCompanyId } from './cache';
import './employee-yard-activity.css';

export function EmployeeYardActivity() {
  const { overview, session, refresh, refreshing, sessionGeneration } = useEmployee();
  const refreshingRef = useRef(refreshing); refreshingRef.current = refreshing;
  const today = overview?.today;
  useEffect(() => {
    if (!session?.capabilities.yardWork || !today) return;
    const companyId = employeeCompanyId(session.companyId), personId = session.person.id;
    let active = true, running = false, queued = false;
    const update = async () => {
      if (running) { queued = true; return; }
      running = true;
      const olderRead = refreshingRef.current;
      try {
        await refresh({ date: today, month: today.slice(0, 7), view: 'bootstrap' }).catch(() => undefined);
        if (active && (olderRead || queued)) {
          queued = false;
          await refresh({ date: today, month: today.slice(0, 7), view: 'bootstrap' }).catch(() => undefined);
        }
      } finally { running = false; if (active && queued) { queued = false; void update(); } }
    };
    const submitted = (event: Event) => {
      const detail = (event as CustomEvent<{ companyId?: string; personId?: string }>).detail;
      if (active && detail?.companyId === companyId && detail.personId === personId) void update();
    };
    void update();
    window.addEventListener('jeroc:mobile-weighing-submitted', submitted);
    return () => { active = false; window.removeEventListener('jeroc:mobile-weighing-submitted', submitted); };
  }, [refresh, today, session?.companyId, session?.person.id, session?.capabilities.yardWork, sessionGeneration]);
  const activity = overview?.homeActivity;
  const site = session?.sites.find(value => value.id === activity?.siteId && value.active !== false && session.person.siteIds.includes(value.id));
  if (!session?.capabilities.yardWork || !activity || !site || activity.date !== today || activity.siteId !== session.activeSiteId
    || !Number.isSafeInteger(activity.completedWeighings) || activity.completedWeighings < 0 || !Number.isFinite(activity.weighedKg) || activity.weighedKg < 0) return null;
  return <section className="employee-yard-activity" aria-label="Din insats idag"><header><h2>Din insats idag</h2><span>{site.name}</span></header><div>
    <article><Scale size={25} aria-hidden="true" /><span><strong>{activity.completedWeighings.toLocaleString('sv-SE')}</strong><small>Invägningar</small></span></article>
    <article><Recycle size={25} aria-hidden="true" /><span><strong>{activity.weighedKg.toLocaleString('sv-SE', { maximumFractionDigits: 3 })} kg</strong><small>Invägt</small></span></article>
  </div></section>;
}
