import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { articleById } from '../data';
import { type OfficeCard } from './model';
import { approvalLabels } from './terminal-demo-types';
import './weight-card-rows.css';

export type WeightCardPreviewData = {
  customerName: string;
  materials: { name: string; weight: number }[];
  origin: string;
  reference: string;
  registration?: string;
  nextStep: string;
  note?: string;
};

export function createWeightCardPreview(card: OfficeCard, customerName: string, nextStep?: string): WeightCardPreviewData {
  const approval = card.customerApproval;
  const next = nextStep ?? (approval?.status === 'change_requested' ? 'Granska kundens ändringsbegäran'
    : approval?.status === 'id_requested' ? 'Kontrollera kundens legitimation'
      : approval?.status === 'waiting' ? 'Invänta kundens godkännande'
        : approval?.status === 'expired' ? 'Skicka en ny granskningsversion'
          : card.status === 'new' || card.status === 'complement' ? !card.customerId ? 'Välj kund och komplettera underlaget'
            : !card.origin.trim() ? 'Komplettera ursprungsadressen' : 'Granska underlaget och starta kundgodkännande'
            : card.status === 'attest' ? 'Granska och attestera avräkningen'
              : card.status === 'ready' ? 'Kontrollera och registrera utbetalningen'
                : card.status === 'paid' || card.status === 'balance' ? 'Avslutat kort · avräkning och historik finns på kortet'
                  : approval ? approvalLabels[approval.status] : 'Granska kundgodkännandet');
  // Only non-financial fields from the already scoped list projection are used.
  return {
    customerName,
    materials: card.rows.map(row => ({ name: row.articleName ?? articleById(row.articleId)?.name ?? row.articleId, weight: row.weight })),
    origin: card.origin, reference: card.reference, registration: card.registration, nextStep: next,
  };
}

type ActivePreview = { rowKey: string; cardId: number; data: WeightCardPreviewData; x: number; y: number };
type PreviewContext = {
  active?: ActivePreview;
  tooltipId: string;
  schedule: (preview: ActivePreview) => void;
  close: (rowKey?: string) => void;
  leave: (rowKey: string) => void;
  keepOpen: () => void;
  update: (rowKey: string, data: WeightCardPreviewData) => void;
};
const PreviewContext = createContext<PreviewContext | undefined>(undefined);

export function WeightCardRows({ children, scope = '' }: { children: ReactNode; scope?: string }) {
  const location = useLocation();
  const [active, setActive] = useState<ActivePreview>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<ActivePreview>(undefined);
  const tooltipId = useId();
  const close = (rowKey?: string) => {
    if (!rowKey || pending.current?.rowKey === rowKey) {
      clearTimeout(timer.current); timer.current = undefined; pending.current = undefined;
    }
    clearTimeout(leaveTimer.current); leaveTimer.current = undefined;
    setActive(previous => !rowKey || previous?.rowKey === rowKey ? undefined : previous);
  };
  useEffect(() => {
    close();
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const hide = () => close();
    document.addEventListener('keydown', dismiss);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      clearTimeout(timer.current);
      clearTimeout(leaveTimer.current);
      document.removeEventListener('keydown', dismiss);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [location.key, scope]);
  const context: PreviewContext = {
    active, tooltipId, close,
    schedule: preview => {
      clearTimeout(timer.current);
      clearTimeout(leaveTimer.current);
      if (active?.rowKey === preview.rowKey) return;
      setActive(undefined);
      pending.current = preview;
      timer.current = setTimeout(() => {
        if (pending.current?.rowKey === preview.rowKey) setActive(pending.current);
        timer.current = undefined;
      }, 400);
    },
    leave: rowKey => {
      if (pending.current?.rowKey === rowKey) {
        clearTimeout(timer.current); timer.current = undefined; pending.current = undefined;
      }
      clearTimeout(leaveTimer.current);
      // Keep hover content reachable across the small gap beside the row.
      leaveTimer.current = setTimeout(() => close(rowKey), 150);
    },
    keepOpen: () => { clearTimeout(leaveTimer.current); leaveTimer.current = undefined; },
    update: (rowKey, data) => {
      if (pending.current?.rowKey === rowKey) pending.current = { ...pending.current, data };
      setActive(previous => previous?.rowKey === rowKey && previous.data !== data ? { ...previous, data } : previous);
    },
  };
  return <PreviewContext.Provider value={context}>{children}{active && createPortal(<CompactWeightCardPreview preview={active} id={tooltipId} />, document.body)}</PreviewContext.Provider>;
}

function CompactWeightCardPreview({ preview, id }: { preview: ActivePreview; id: string }) {
  const context = useContext(PreviewContext);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    if (!ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    const margin = 12;
    const left = Math.max(margin, Math.min(preview.x + 18, window.innerWidth - width - margin));
    const preferredTop = preview.y + 18;
    const top = Math.max(margin, Math.min(preferredTop + height > window.innerHeight - margin ? preview.y - height - 18 : preferredTop, window.innerHeight - height - margin));
    setPosition({ left, top });
  }, [preview]);
  const data = preview.data;
  return <div ref={ref} id={id} role="tooltip" className="office-weight-card-preview" onPointerEnter={() => context?.keepOpen()} onPointerLeave={() => context?.leave(preview.rowKey)} style={{ left: position?.left ?? 12, top: position?.top ?? 12, visibility: position ? 'visible' : 'hidden' }}>
    <header><strong>Viktkort #{preview.cardId}</strong><span>{data.customerName}</span></header>
    <ul aria-label="Material på viktkortet">{data.materials.slice(0, 3).map((material, index) => <li key={index}><span>{material.name}</span><strong>{material.weight.toLocaleString('sv-SE', { maximumFractionDigits: 2 })} kg</strong></li>)}</ul>
    {!data.materials.length && <p>Inga material registrerade</p>}
    {data.materials.length > 3 && <p className="office-preview-more">+ {data.materials.length - 3} material till på kortet</p>}
    <dl><div><dt>Ursprung</dt><dd>{data.origin || 'Ursprung saknas'}</dd></div><div><dt>Referens</dt><dd>{data.reference || 'Referens saknas'}</dd></div>{data.registration && <div><dt>Registrering</dt><dd>{data.registration}</dd></div>}</dl>
    {data.note && <p className="office-preview-note">{data.note}</p>}
    <p className="office-preview-next"><span>Nästa steg</span>{data.nextStep}</p>
  </div>;
}

const interactive = 'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [contenteditable="true"]';
const modified = (event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) => event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;

export function WeightCardLink({ cardId, to, onOpen, children, className = 'office-link', label }: {
  cardId: number; to: string; onOpen: (id: number) => void; children?: ReactNode; className?: string; label?: string;
}) {
  const preview = useContext(PreviewContext);
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    preview?.close();
    if (event.button !== 0 || modified(event)) return;
    event.preventDefault(); onOpen(cardId);
  };
  return <Link className={className} to={to} aria-label={label ?? `Öppna viktkort ${cardId}`} onClick={click}>{children ?? `#${cardId}`}</Link>;
}

export function WeightCardRow({ cardId, to, onOpen, preview, children, className = '', rowKey }: {
  cardId: number; to: string; onOpen: (id: number) => void; preview: WeightCardPreviewData; children: ReactNode; className?: string; rowKey?: string;
}) {
  const context = useContext(PreviewContext);
  const identity = rowKey ?? String(cardId);
  const latest = useRef(context); latest.current = context;
  useEffect(() => { latest.current?.update(identity, preview); }, [identity, preview]);
  useEffect(() => () => latest.current?.close(identity), [identity]);
  const show = (element: HTMLTableRowElement, x?: number, y?: number) => {
    const box = element.getBoundingClientRect();
    context?.schedule({ rowKey: identity, cardId, data: preview, x: x ?? box.left + Math.min(240, box.width / 2), y: y ?? box.bottom });
  };
  return <tr className={`office-weight-card-row ${className}`.trim()} tabIndex={0} aria-label={`Öppna viktkort ${cardId}`} aria-describedby={context?.active?.rowKey === identity ? context.tooltipId : undefined} data-card-route={to}
    onClick={event => {
      context?.close();
      if (event.button !== 0 || modified(event) || (event.target instanceof Element && event.target.closest(interactive))) return;
      const selection = window.getSelection();
      if (selection?.toString() && selection.anchorNode && event.currentTarget.contains(selection.anchorNode)) return;
      onOpen(cardId);
    }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || modified(event) || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault(); context?.close(); onOpen(cardId);
    }}
    onPointerEnter={event => { if (event.pointerType === 'mouse' && window.matchMedia('(hover: hover) and (pointer: fine)').matches) show(event.currentTarget, event.clientX, event.clientY); }}
    onPointerLeave={() => context?.leave(identity)}
    onFocus={event => { if (event.target === event.currentTarget && window.matchMedia('(hover: hover) and (pointer: fine)').matches) show(event.currentTarget); }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) context?.close(identity); }}
  >{children}</tr>;
}
