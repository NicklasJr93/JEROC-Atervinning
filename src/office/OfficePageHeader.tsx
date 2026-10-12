import { useLayoutEffect, useRef, type ReactNode } from 'react';
import './page-header.css';

/** The shell and page heading share the measured height of the actual top bar,
 * including the support banner and wrapped controls on smaller screens. */
export function OfficeStickyShell({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const shell = ref.current;
    const workspace = shell?.closest<HTMLElement>('.office-workspace');
    if (!shell || !workspace) return;
    const measure = () => workspace.style.setProperty('--office-shell-height', `${shell.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => {
      observer.disconnect();
      workspace.style.removeProperty('--office-shell-height');
    };
  }, []);
  return <div ref={ref} className="office-sticky-shell">{children}</div>;
}

/** Put navigation, title and primary actions in children, and list tabs/search
 * in controls. Summary cards and forms belong after this component. A workspace
 * that already owns its list scrolling can use sticky={false}. */
export function OfficePageHeader({ children, controls, className = '', sticky = true }: {
  children: ReactNode;
  controls?: ReactNode;
  className?: string;
  sticky?: boolean;
}) {
  return <div className={`office-page-header ${sticky ? '' : 'office-page-header-contained'} ${className}`}>
    <div className="office-page-header-heading">{children}</div>
    {controls && <div className="office-page-header-controls">{controls}</div>}
  </div>;
}
