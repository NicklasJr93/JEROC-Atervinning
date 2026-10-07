import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  FileText,
  Home,
  Info,
  List,
  MapPin,
  Scale,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, type ReactNode } from 'react';
import { useDemo } from './store';
import { kilos } from './model';

export function Logo() {
  return (
    <img
      className="company-logo"
      src="/images/jeroc-logo.png"
      alt="JEROC Återvinning"
    />
  );
}
export function Photo({
  index,
  className = '',
  label,
}: {
  index: number;
  className?: string;
  label: string;
}) {
  const extra = index >= 28;
  const cell = extra ? index - 28 : index;
  return (
    <div
      role="img"
      aria-label={label}
      className={`material-photo ${className}`}
      style={{
        backgroundImage: extra ? "url('/images/copper-grades.png')" : undefined,
        backgroundSize: extra ? '400% 300%' : undefined,
        backgroundPosition: `${((cell % 4) * 100) / 3}% ${(Math.floor(cell / 4) * 100) / (extra ? 2 : 6)}%`,
      }}
    />
  );
}
export function DemoBadge() {
  return (
    <span className="demo-badge">
      <span /> DEMOLÄGE
    </span>
  );
}
export function Header({
  title,
  back = '/',
  children,
  onBack,
}: {
  title: string;
  back?: string;
  children?: ReactNode;
  onBack?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <header className="page-header">
      <button
        type="button"
        className="icon-button"
        aria-label="Tillbaka"
        onClick={onBack ?? (() => navigate(back))}
      >
        <ArrowLeft />
      </button>
      <h1>{title}</h1>
      {children}
    </header>
  );
}
export function Button({
  children,
  onClick,
  variant = 'primary',
  icon: Icon,
  disabled,
  type = 'button',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'blue' | 'outline' | 'danger' | 'quiet';
  icon?: LucideIcon;
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={`button ${variant} ${className}`}
      onClick={onClick}
    >
      {Icon && <Icon size={21} />}
      <span>{children}</span>
    </button>
  );
}
export function Notice({
  children,
  tone = 'blue',
}: {
  children: ReactNode;
  tone?: 'blue' | 'green' | 'red' | 'amber';
}) {
  return (
    <div
      className={`notice ${tone}`}
      role={tone === 'red' ? 'alert' : undefined}
    >
      <Info size={19} />
      <div>{children}</div>
    </div>
  );
}
export function Total({
  weight,
  count,
  label = 'Total vikt',
}: {
  weight: number;
  count?: number;
  label?: string;
}) {
  return (
    <div className="total-card">
      <Scale size={35} strokeWidth={1.65} />
      <div>
        <span>{label}</span>
        <strong data-testid="total-weight">
          {kilos(weight)} <small>kg</small>
        </strong>
      </div>
      {count != null && <span className="total-count">{count} material</span>}
    </div>
  );
}
export function Nav() {
  const location = useLocation();
  const navigate = useNavigate();
  const items: { path: string; label: string; icon: LucideIcon }[] = [
    { path: '/', label: 'Hem', icon: Home },
    { path: '/drafts', label: 'Vägningar', icon: List },
    { path: '/prices', label: 'Prislista', icon: FileText },
    { path: '/profile', label: 'Profil', icon: UserRound },
  ];
  return (
    <nav className="bottom-nav" aria-label="Huvudmeny">
      {items.map(({ path, label, icon: Icon }) => (
        <button
          key={path}
          className={
            location.pathname === path ||
            (path === '/drafts' && location.pathname.endsWith('/summary'))
              ? 'active'
              : ''
          }
          onClick={() => navigate(path)}
        >
          <Icon size={22} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
export function MenuRow({
  title,
  description,
  icon: Icon,
  onClick,
  disabled,
  trailing,
}: {
  title: string;
  description?: string;
  icon: LucideIcon;
  onClick?: () => void;
  disabled?: boolean;
  trailing?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="menu-row"
      onClick={onClick}
    >
      <span className="menu-icon">
        <Icon size={22} />
      </span>
      <span className="menu-copy">
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </span>
      {trailing && <span className="muted small">{trailing}</span>}
      <ChevronRight size={18} />
    </button>
  );
}
export function CustomerLink({
  draftId,
  customerId,
}: {
  draftId: string;
  customerId?: string;
}) {
  const { data } = useDemo();
  const navigate = useNavigate();
  const customer = data.customers.find((c) => c.id === customerId);
  return (
    <MenuRow
      title={customer?.name ?? 'Lägg till kund'}
      description={
        customer ? `${customer.type} · ${customer.number}` : undefined
      }
      trailing={customer ? undefined : 'Valfritt'}
      icon={UserRound}
      onClick={() => navigate(`/weigh/${draftId}/customer`)}
    />
  );
}
export function ReferenceLink({
  draftId,
  customerId,
  reference,
  origin,
}: {
  draftId: string;
  customerId?: string;
  reference: string;
  origin: string;
}) {
  const navigate = useNavigate();
  return (
    <div>
      <MenuRow
        title="Referens & ursprung"
        description={
          customerId
            ? [reference, origin].filter(Boolean).join(' · ') ||
              'Valfria uppgifter'
            : undefined
        }
        icon={MapPin}
        disabled={!customerId}
        onClick={() => navigate(`/weigh/${draftId}/reference`)}
      />
      {!customerId && (
        <p className="field-help">
          Välj kund för referens och ursprungsadress.
        </p>
      )}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog className="modal" ref={ref} onCancel={onClose}>
      <header>
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Stäng" onClick={onClose}>
          <X />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span>
        <List size={34} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Search({
  value,
  setValue,
  placeholder,
}: {
  value: string;
  setValue: (s: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search">
      <span aria-hidden="true">⌕</span>
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </label>
  );
}
export function ProgressSaved({ saved }: { saved: boolean }) {
  return saved ? (
    <span className="saved-line">
      <Check size={14} /> Sparat på den här enheten
    </span>
  ) : null;
}
export function ForwardIcon() {
  return <ArrowRight size={20} />;
}
