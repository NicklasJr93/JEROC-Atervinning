import { useEffect, useState, type FormEvent } from 'react';
import { Building2, Check, ExternalLink, KeyRound, Monitor, Pencil, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { terminalDemoApi } from './terminal-demo-client';
import type { DemoTerminal, TerminalDemoState } from './terminal-demo-types';
import { useEnvironmentSession } from './EnvironmentSession';
import './terminals.css';

const failureMessage = (failure: unknown) => failure instanceof Error ? failure.message : 'Åtgärden kunde inte utföras.';
const shortTime = (value?: string) => value ? new Date(value).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Inte inloggad ännu';
const usernameFromName = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 40);

export function TerminalServiceNotice({ error, configurationRequired, onRefresh }: { error?: string; configurationRequired?: boolean; onRefresh?: () => Promise<void> }) {
  return <div className="terminal-service-notice" role="status">
    <Monitor size={23} />
    <div><strong>{configurationRequired ? 'Terminalerna behöver gemensam lagring' : 'Terminaltjänsten kunde inte nås'}</strong><p>{configurationRequired ? 'Lägg till DATABASE_URL i Render och driftsätt igen. Terminaler och godkännanden sparas då gemensamt för datorn och mobilen.' : error}</p></div>
    {onRefresh && <button className="office-btn outline" onClick={() => void onRefresh()}><RefreshCw size={14} />Försök igen</button>}
  </div>;
}

export type TerminalWorkspaceProps = {
  state?: TerminalDemoState; loading: boolean; error: string; configurationRequired: boolean;
  onRefresh: () => Promise<void>; onNotice: (message: string) => void;
};

export default function TerminalWorkspace({ state, loading, error, configurationRequired, onRefresh, onNotice }: TerminalWorkspaceProps) {
  const { state: environmentState } = useEnvironmentSession();
  const sites = environmentState?.sites ?? state?.sites ?? [];
  const activeSites = sites.filter(site => site.active !== false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [password, setPassword] = useState('');
  const [siteId, setSiteId] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [editing, setEditing] = useState<DemoTerminal>();
  const [editMode, setEditMode] = useState<'name' | 'password' | 'release' | 'active'>('name');
  const [editValue, setEditValue] = useState('');
  useEffect(() => { if (!activeSites.some(site => site.id === siteId)) setSiteId(activeSites[0]?.id ?? ''); }, [sites, siteId]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setFormError('');
    try {
      await terminalDemoApi.create({ name: name.trim(), username: username.trim(), password, siteId });
      setPassword(''); setName(''); setUsername(''); setUsernameEdited(false); setCreating(false);
      await onRefresh(); onNotice('Terminalen är skapad. Öppna /terminal på den enhet som ska användas.');
    } catch (failure) { setFormError(failureMessage(failure)); }
    finally { setBusy(false); }
  }
  async function update(event: FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    setBusy(true); setFormError('');
    try {
      if (editMode === 'release') await terminalDemoApi.release(editing.id);
      else await terminalDemoApi.update(editing.id, editMode === 'name' ? { name: editValue.trim() } : editMode === 'password' ? { password: editValue } : { active: !editing.active });
      setEditValue(''); setEditing(undefined); await onRefresh();
      onNotice(editMode === 'password' ? 'Lösenordet har återställts.' : editMode === 'release' ? 'Terminalens inloggning är avslutad. En ny enhet kan logga in.' : 'Terminalen har uppdaterats.');
    } catch (failure) { setFormError(failureMessage(failure)); }
    finally { setBusy(false); }
  }
  function openEdit(terminal: DemoTerminal, mode: typeof editMode) {
    setEditing(terminal); setEditMode(mode); setEditValue(mode === 'name' ? terminal.name : ''); setFormError('');
  }

  return <section className="terminal-workspace">
    <div className="office-title terminal-workspace-title"><div><span className="office-eyebrow">ADMINISTRATION</span><h1>Kundterminaler</h1><p>Skapa terminaler och visa rätt avräkning på rätt skärm.</p></div><div className="terminal-title-actions"><a className="office-btn outline" href="/terminal" target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />Öppna terminal</a><button className="office-btn" disabled={!state || loading} onClick={() => { setCreating(true); setFormError(''); }}><Plus size={16} />Skapa terminal</button></div></div>
    {(error || configurationRequired) && <TerminalServiceNotice error={error} configurationRequired={configurationRequired} onRefresh={onRefresh} />}
    {loading && !state && <div className="office-panel" role="status">Hämtar terminaler…</div>}
    {state && <><div className="terminal-summary"><span><Monitor size={16} /><strong>{state.terminals.length}</strong> terminaler</span><span><i className="terminal-dot online" /><strong>{state.terminals.filter(t => t.online && t.active && !t.busy).length}</strong> lediga online</span><span><i className="terminal-dot busy" /><strong>{state.terminals.filter(t => t.busy).length}</strong> kundvisningar</span></div>
      {state.terminals.length === 0 ? <div className="office-panel terminal-empty"><Monitor size={35} /><h2>Skapa er första terminal</h2><p>Logga sedan in på /terminal från mobilen eller en iPad för att prova en kundvisning.</p><button className="office-btn" onClick={() => setCreating(true)}><Plus size={15} />Skapa terminal</button></div> : <div className="terminal-grid">{state.terminals.map(terminal => <article className="office-panel terminal-card" key={terminal.id}>
        <div className="terminal-card-heading"><span className="terminal-icon"><Monitor size={23} /></span><div><h2>{terminal.name}</h2><small><Building2 size={12} />{sites.find(s => s.id === terminal.siteId)?.name ?? terminal.siteId}</small></div><span className={`terminal-pill ${!terminal.active ? 'inactive' : terminal.busy ? 'busy' : terminal.online ? 'online' : 'offline'}`}><i className="terminal-dot" />{!terminal.active ? 'Avaktiverad' : terminal.busy ? 'Upptagen' : terminal.online ? 'Ledig' : 'Offline'}</span></div>
        <dl className="terminal-facts"><div><dt>Inloggning</dt><dd>{terminal.username}</dd></div><div><dt>Senast sedd</dt><dd>{shortTime(terminal.lastSeen)}</dd></div>{terminal.busy && <div><dt>Kundvisning</dt><dd>En avräkning visas</dd></div>}</dl>
        <div className="terminal-card-actions"><button className="office-link" onClick={() => openEdit(terminal, 'name')}><Pencil size={13} />Byt namn</button><button className="office-link" onClick={() => openEdit(terminal, 'password')}><KeyRound size={13} />Nytt lösenord</button><button className="office-link" onClick={() => openEdit(terminal, 'active')}>{terminal.active ? 'Avaktivera' : 'Aktivera'}</button></div>
        {terminal.active && <button className="office-btn outline terminal-release" onClick={() => openEdit(terminal, 'release')}>Avsluta terminalinloggning</button>}
      </article>)}</div>}
      <div className="terminal-info"><ShieldCheck size={18} /><p>Terminalen har ett eget konto och kan bara visa sin aktuella kundavräkning. En enhet åt gången kan vara inloggad.</p></div>
    </>}
    {creating && <div className="terminal-modal-backdrop"><form className="terminal-dialog" onSubmit={create}><div className="terminal-dialog-heading"><h2>Skapa kundterminal</h2><button type="button" className="terminal-icon-button" aria-label="Stäng skapa terminal" disabled={busy} onClick={() => { setCreating(false); setPassword(''); }}><X size={20} /></button></div><p>Kontot används enbart på kundens terminalskärm.</p>
      <label>Namn<input required maxLength={80} value={name} placeholder="Exempelvis Kassa 1" onChange={event => { setName(event.target.value); if (!usernameEdited) setUsername(usernameFromName(event.target.value)); }} autoFocus /></label>
      <label>Inloggningsnamn<input required minLength={3} maxLength={40} autoCapitalize="none" autoCorrect="off" value={username} onChange={event => { setUsernameEdited(true); setUsername(event.target.value); }} /></label>
      <label>Lösenord<input required type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /><small>Minst 8 tecken. Spara lösenordet innan du skapar terminalen.</small></label>
      <label>Anläggning<select required value={siteId} onChange={event => setSiteId(event.target.value)}>{activeSites.length === 0 && <option value="">Ingen aktiv anläggning</option>}{activeSites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
      {formError && <div className="terminal-error" role="alert">{formError}</div>}<button className="office-btn" disabled={busy || !siteId}>{busy ? 'Skapar…' : 'Skapa terminal'}</button>
    </form></div>}
    {editing && <div className="terminal-modal-backdrop"><form className="terminal-dialog" onSubmit={update}><div className="terminal-dialog-heading"><h2>{editMode === 'name' ? 'Byt terminalnamn' : editMode === 'password' ? 'Återställ lösenord' : editMode === 'release' ? 'Avsluta terminalinloggning?' : editing.active ? 'Avaktivera terminal?' : 'Aktivera terminal?'}</h2><button type="button" className="terminal-icon-button" aria-label="Stäng terminaländring" disabled={busy} onClick={() => { setEditing(undefined); setEditValue(''); }}><X size={20} /></button></div><p>{editing.name} · {editing.username}</p>
      {editMode === 'name' && <label>Namn<input required maxLength={80} value={editValue} onChange={event => setEditValue(event.target.value)} autoFocus /></label>}
      {editMode === 'password' && <label>Nytt lösenord<input required type="password" autoComplete="new-password" minLength={8} maxLength={128} value={editValue} onChange={event => setEditValue(event.target.value)} autoFocus /><small>Den nuvarande inloggningen avslutas när lösenordet ändras.</small></label>}
      {editMode === 'release' && <p>Den inloggade enheten kopplas från. En pågående kundvisning avslutas och måste vid behov skickas igen.</p>}
      {editMode === 'active' && editing.active && <p>Terminalen kan inte användas förrän den aktiveras igen. En pågående kundvisning avslutas.</p>}
      {formError && <div className="terminal-error" role="alert">{formError}</div>}<div className="terminal-dialog-actions"><button type="button" className="office-btn outline" disabled={busy} onClick={() => { setEditing(undefined); setEditValue(''); }}>Avbryt</button><button className="office-btn" disabled={busy}><Check size={14} />{busy ? 'Sparar…' : 'Bekräfta'}</button></div>
    </form></div>}
  </section>;
}

export type TerminalSelectorsProps = {
  state?: TerminalDemoState; userId: string; siteId: string; onSiteChange: (id: string) => void;
  terminalId: string; onTerminalChange: (id: string) => void;
  onRefresh: () => Promise<void>; onNotice: (message: string) => void;
};
export function TerminalSelectors({ state, userId, siteId, onSiteChange, terminalId, onTerminalChange, onRefresh, onNotice }: TerminalSelectorsProps) {
  const { state: environmentState } = useEnvironmentSession();
  const sites = environmentState?.sites ?? state?.sites ?? [];
  const [busy, setBusy] = useState(false);
  const selected = state?.terminals.find(terminal => terminal.id === terminalId);
  const terminals = state?.terminals.filter(terminal => terminal.active && sites.some(site => site.id === terminal.siteId && site.active !== false) && (!siteId || siteId === 'all' || terminal.siteId === siteId)) ?? [];
  async function choose(id: string) {
    const next = state?.terminals.find(terminal => terminal.id === id);
    const previousId = terminalId;
    onTerminalChange(id);
    const targetSite = next?.siteId ?? (siteId && siteId !== 'all' ? siteId : selected?.siteId);
    if (!targetSite) return;
    setBusy(true);
    try { await terminalDemoApi.defaultTerminal(targetSite, id || null); await onRefresh(); }
    catch (failure) { onTerminalChange(previousId); onNotice(failureMessage(failure)); }
    finally { setBusy(false); }
  }
  if (!state && !environmentState) return null;
  const defaultForSite = state?.defaults.find(item => item.userId === userId && item.siteId === siteId)?.terminalId ?? '';
  return <div className="terminal-top-selectors">
    <label className="terminal-top-selector"><Building2 size={15} /><span><small>Anläggning</small><select aria-label="Anläggning" value={siteId || 'all'} onChange={event => onSiteChange(event.target.value)}><option value="all">Alla anläggningar</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}{site.active === false ? ' · Avaktiverad' : ''}</option>)}</select></span></label>
    {state && <label className="terminal-top-selector"><Monitor size={15} /><span><small>Kundterminal{selected ? ` · ${selected.busy ? 'Upptagen' : selected.online ? 'Ledig' : 'Offline'}` : ''}</small><select aria-label="Förvald kundterminal" disabled={busy} value={terminalId || defaultForSite} onChange={event => void choose(event.target.value)}><option value="">Välj terminal</option>{terminals.map(terminal => <option key={terminal.id} value={terminal.id}>{terminal.name} · {terminal.busy ? 'Upptagen' : terminal.online ? 'Ledig' : 'Offline'}</option>)}</select></span></label>}
  </div>;
}
