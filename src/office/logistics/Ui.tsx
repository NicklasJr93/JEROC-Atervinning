import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export const dateLabel = (value?: string) => value ? new Date(value.length === 10 ? `${value}T12:00:00Z` : value).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Stockholm' }) : 'Ej valt';
export const minuteLabel = (value?: number) => value === undefined ? '' : `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
export const kg = (value: number) => `${value.toLocaleString('sv-SE', { maximumFractionDigits: 3 })} kg`;
export function Pill({ tone = 'blue', children }: { tone?: 'blue' | 'green' | 'orange' | 'red' | 'grey'; children: ReactNode }) { return <span className={`wo-pill ${tone}`}>{children}</span>; }
export function Panel({ title, icon, actions, children }: { title: string; icon?: ReactNode; actions?: ReactNode; children: ReactNode }) { return <section className="office-panel wo-panel"><header className="wo-panel-heading"><h2>{icon}{title}</h2>{actions && <div className="wo-actions">{actions}</div>}</header>{children}</section>; }
export function Field({ label, full = false, children }: { label: string; full?: boolean; children: ReactNode }) { return <label className={`wo-field${full ? ' full' : ''}`}><span>{label}</span>{children}</label>; }
export function Alert({ tone = 'blue', children }: { tone?: 'blue' | 'green' | 'orange' | 'red'; children: ReactNode }) { return <div className={`wo-alert ${tone}`} role={tone === 'red' ? 'alert' : undefined}>{children}</div>; }
export function Dialog({ title, description, children, busy = false, onClose }: { title: string; description?: string; children: ReactNode; busy?: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null), close = useRef(onClose), pending = useRef(busy); close.current = onClose; pending.current = busy;
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending.current) { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]') ?? []).filter(value => value.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return <div className="wo-overlay" onMouseDown={event => { if (!busy && event.target === event.currentTarget) onClose(); }}><div ref={ref} className="wo-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}><header className="wo-dialog-heading"><div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div><button type="button" className="wo-icon-button" aria-label="Stäng" disabled={busy} onClick={onClose}><X size={20} /></button></header>{children}</div></div>;
}
