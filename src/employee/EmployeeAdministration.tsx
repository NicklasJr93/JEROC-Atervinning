import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, LogOut, ShieldCheck } from 'lucide-react';
import { Button, Logo, Nav, Notice } from '../components';
import { employeeError, useEmployee } from './EmployeeProvider';

function AdminPasswordChange() {
  const { admin, adminBusy, changeAdminPassword, logout, error: sessionError } = useEmployee();
  const [current, setCurrent] = useState(''), [password, setPassword] = useState(''), [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (adminBusy) return; setError('');
    if (password.length < 12) { setError('Använd minst 12 tecken i det nya lösenordet.'); return; }
    if (password !== repeat) { setError('De nya lösenorden stämmer inte överens.'); return; }
    if (password === current) { setError('Välj ett annat lösenord än det tillfälliga.'); return; }
    try { await changeAdminPassword(current, password); setCurrent(''); setPassword(''); setRepeat(''); }
    catch (failure) { setError(employeeError(failure)); }
  }
  return <main className="employee-login employee-admin-picker"><Logo /><h1>Välj nytt lösenord</h1>
    <p>Hej {admin?.platformSession.actor.name}! Byt det tillfälliga lösenordet innan du öppnar ett bolag.</p>
    <form className="employee-form" onSubmit={submit}>
      <label>Nuvarande lösenord<input required type="password" autoComplete="current-password" maxLength={200} disabled={adminBusy} value={current} onChange={event => setCurrent(event.target.value)} /></label>
      <label>Nytt lösenord<input required type="password" autoComplete="new-password" minLength={12} maxLength={200} disabled={adminBusy} value={password} onChange={event => setPassword(event.target.value)} /></label>
      <label>Upprepa nytt lösenord<input required type="password" autoComplete="new-password" minLength={12} maxLength={200} disabled={adminBusy} value={repeat} onChange={event => setRepeat(event.target.value)} /></label>
      <p className="employee-subtle">Minst 12 tecken. En längre lösenfras fungerar bra.</p>
      {(error || sessionError) && <Notice tone="red">{error || sessionError}</Notice>}
      <Button type="submit" variant="blue" disabled={adminBusy}>{adminBusy ? 'Sparar…' : 'Spara nytt lösenord'}</Button>
    </form><button className="employee-text" disabled={adminBusy} onClick={() => void logout().catch(failure => setError(employeeError(failure)))}>Logga ut</button>
  </main>;
}

export function EmployeeAdminCompanyPage() {
  const { admin, adminBusy, chooseCompany, openCompanySelection, logout, error: sessionError } = useEmployee();
  const navigate = useNavigate();
  const [companyId, setCompanyId] = useState(''), [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!admin?.companies.some(company => company.id === companyId)) setCompanyId(''); }, [admin?.companies, companyId]);
  if (!admin) return null;
  if (admin.platformSession.mustChangePassword) return <AdminPasswordChange />;
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!companyId || adminBusy) return; setError('');
    try { if (await chooseCompany(companyId)) navigate('/', { replace: true }); }
    catch (failure) { if (mounted.current) setError(employeeError(failure)); }
  }
  return <main className="employee-login employee-admin-picker"><Logo />
    <p className="employee-admin-eyebrow"><ShieldCheck size={17} />Systemadministration</p>
    <h1>Välj bolag</h1><p>Hej {admin.platformSession.actor.name}! Öppna det bolag du vill arbeta i.</p>
    <form className="employee-form" onSubmit={submit}>
      <label>Bolag<select value={companyId} disabled={adminBusy} required onChange={event => { setCompanyId(event.target.value); setError(''); }}>
        <option value="">Välj bolag…</option>{admin.companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
      </select></label>
      {companyId && <p className="employee-subtle">Organisationsnummer {admin.companies.find(company => company.id === companyId)?.organisationNumber}</p>}
      {!admin.companies.length && !adminBusy && <Notice>Det finns inga aktiva bolag att öppna.</Notice>}
      {(error || sessionError) && <Notice tone="red">{error || sessionError}</Notice>}
      {adminBusy && <p role="status">Hämtar bolagets arbetsyta…</p>}
      <Button type="submit" variant="blue" icon={Building2} disabled={!companyId || adminBusy}>{adminBusy ? 'Öppnar…' : 'Öppna bolag'}</Button>
    </form>
    <div className="employee-admin-picker-actions"><button type="button" className="employee-text" disabled={adminBusy} onClick={() => void openCompanySelection().catch(failure => { if (mounted.current) setError(employeeError(failure)); })}>Uppdatera bolag</button>
      <button type="button" className="employee-text danger" disabled={adminBusy} onClick={() => void logout().catch(failure => { if (mounted.current) setError(employeeError(failure)); })}><LogOut size={16} />Logga ut</button></div>
  </main>;
}

export function EmployeeAdminBar() {
  const { admin, session, adminBusy, openCompanySelection, logout } = useEmployee();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = bar.current, root = element?.parentElement;
    if (!element || !root) return;
    const measure = () => root.style.setProperty('--employee-admin-bar-height', `${element.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => { observer.disconnect(); root.style.removeProperty('--employee-admin-bar-height'); };
  }, [session?.companyId, Boolean(session?.support)]);
  if (!admin || !session?.support) return null;
  async function switchCompany() {
    setError('');
    try { await openCompanySelection(); navigate('/', { replace: true }); }
    catch (failure) { setError(employeeError(failure)); }
  }
  return <section className="employee-admin-bar" ref={bar} role="region" aria-label="Administrationsläge">
    <div className="employee-admin-identity"><ShieldCheck size={16} /><strong>Systemadmin · {session.companyName}</strong></div>
    <div className="employee-admin-bar-actions"><button type="button" disabled={adminBusy} onClick={() => void switchCompany()}><Building2 size={15} />Byt bolag</button>
      <button type="button" disabled={adminBusy} onClick={() => void logout().catch(failure => setError(employeeError(failure)))}><LogOut size={15} />Logga ut</button></div>
    {error && <span role="alert">{error}</span>}
  </section>;
}

export function EmployeeAdminProfile() {
  const { admin, session, logout, openCompanySelection, adminBusy } = useEmployee();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  if (!admin || !session?.support) return null;
  return <><main className="employee-page"><header className="employee-page-heading"><h1>Profil</h1></header>
    <section className="employee-card employee-profile-card"><div className="employee-profile-avatar"><ShieldCheck size={32} /></div>
      <h2>{admin.platformSession.actor.name}</h2><p>Systemadmin · {session.companyName}</p>
      <div className="employee-details"><div><span>Användarnamn</span><strong>{admin.platformSession.actor.username}</strong></div><div><span>Bolag</span><strong>{session.companyName}</strong></div></div>
    </section>{error && <Notice tone="red">{error}</Notice>}
    <Button variant="outline" icon={Building2} disabled={adminBusy} onClick={() => void openCompanySelection().then(() => navigate('/', { replace: true })).catch(failure => setError(employeeError(failure)))}>Byt bolag</Button>
    <Button variant="danger" icon={LogOut} disabled={adminBusy} onClick={() => void logout().catch(failure => setError(employeeError(failure)))}>Logga ut</Button>
  </main><Nav /></>;
}
