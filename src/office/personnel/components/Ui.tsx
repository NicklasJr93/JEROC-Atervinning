import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export const localToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
export const formatDate = (value?: string) => value ? new Date(value.length === 10 ? `${value}T12:00:00Z` : value).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Stockholm' }) : '—';
export const minuteLabel = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).map(word => word[0]).slice(0, 2).join('').toUpperCase();
export function Pill({ tone = 'blue', children }: { tone?: 'blue' | 'green' | 'orange' | 'red' | 'grey' | 'purple'; children: ReactNode }) { return <span className={`hr-pill ${tone}`}>{children}</span>; }
export function Alert({ tone = 'blue', children }: { tone?: 'blue' | 'green' | 'orange' | 'red'; children: ReactNode }) { return <div className={`hr-alert ${tone}`} role={tone === 'red' ? 'alert' : undefined}>{children}</div>; }
export function Panel({ title, icon, actions, children }: { title: string; icon?: ReactNode; actions?: ReactNode; children: ReactNode }) { return <section className="office-panel hr-panel"><div className="hr-panel-heading"><h2>{icon}{title}</h2>{actions && <div className="hr-actions">{actions}</div>}</div>{children}</section>; }
export function Field({ label, children, full = false }: { label: string; children: ReactNode; full?: boolean }) { return <label className={`hr-field${full ? ' full' : ''}`}><span>{label}</span>{children}</label>; }
export function Fact({ label, children }: { label: string; children: ReactNode }) { return <div className="hr-fact"><span>{label}</span><strong>{children}</strong></div>; }
export function Dialog({ title, description, children, onClose }: { title: string; description?: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, []);
  return <div className="hr-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={ref} className="hr-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="hr-dialog-heading"><div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div><button className="hr-icon-btn" type="button" onClick={onClose} aria-label="Stäng"><X size={20} /></button></div>{children}</div></div>;
}
