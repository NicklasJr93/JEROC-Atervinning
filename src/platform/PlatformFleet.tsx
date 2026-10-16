import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Building2, CheckCircle2, MapPin, Plus, Radio, RefreshCw, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { platformRequestHeaders } from './session';
import type { AuthenticatedPlatformSession, PlatformCompany } from './types';
import './platform-fleet.css';

type Device = {
  id: string; name: string; model: string; imei?: string; source: 'device' | 'simulator'; profile: string;
  provisioningStatus: 'prepared' | 'active' | 'retired'; connectionStatus: string; organisationId?: string; pendingOrganisationId?: string; pendingRequestId?: string;
  sim?: { iccid?: string; operator?: string; apn?: string };
};
type Command = { requestId: string; revision: number; action: string; deviceId?: string; organisationId?: string; [key: string]: unknown };
type Inventory = { revision: number; devices: Device[]; requests: { deviceId: string; command: Command }[]; events: { id: string; action: string; actorName: string; deviceId: string; at: string }[] };
const labels = { prepared: 'Förberedd', active: 'Tilldelad', retired: 'Avregistrerad' };
async function request(data?: Command, signal?: AbortSignal): Promise<Inventory> {
  const response = await fetch('/api/platform/telematics', { method: data ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { ...platformRequestHeaders(), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(body?.error ?? 'Trackerregistret kunde inte hämtas.');
  return body as Inventory;
}

export default function PlatformFleet({ session, companies }: { session: AuthenticatedPlatformSession; companies: PlatformCompany[] }) {
  const [data, setData] = useState<Inventory>(), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(''), [companyFilter, setCompanyFilter] = useState('');
  const [registering, setRegistering] = useState(false), [selected, setSelected] = useState<Device>(), [action, setAction] = useState<'assign' | 'retire'>('assign'), [company, setCompany] = useState('');
  const [form, setForm] = useState({ name: '', model: 'Teltonika FMC003', imei: '', source: 'device', profile: 'teltonika-codec8e', operator: '', iccid: '', apn: '' });
  const attempts = useRef(new Map<string, Command>()), generation = useRef('');
  generation.current = `${session.actor.id}:${session.generation}:${session.isSupportSession}`;
  const allowed = session.actor.platformAdmin && !session.isSupportSession;
  useEffect(() => {
    const controller = new AbortController(); setData(undefined); setError(''); setLoading(true);
    if (!allowed) { setLoading(false); return () => controller.abort(); }
    void request(undefined, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Trackers kunde inte hämtas.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh, allowed, session.actor.id, session.generation]);
  async function mutate(payload: Omit<Command, 'requestId' | 'revision'>, retry?: Command) {
    if (busy || !data || !allowed) return;
    const key = JSON.stringify(payload), principal = generation.current;
    const command = retry ?? attempts.current.get(key) ?? { ...payload, requestId: crypto.randomUUID(), revision: data.revision } as Command;
    attempts.current.set(key, command); setBusy(true); setError(''); setMessage('');
    try {
      const next = await request(command);
      if (generation.current !== principal) return;
      setData(next); attempts.current.delete(key); setRegistering(false); setSelected(undefined);
      setMessage(command.action === 'device.register' ? 'Trackern är registrerad och förberedd. Ingen fysisk anslutning har bekräftats.' : command.action === 'device.assign' ? 'Trackern är tilldelad och sparad i bolagets register.' : 'Trackern är avregistrerad. Historiken och tidigare bolagstilldelning bevaras.');
      if (command.action === 'device.register') setForm(current => ({ ...current, name: '', imei: '', iccid: '' }));
    } catch (failure) {
      if (generation.current !== principal) return;
      setError(failure instanceof Error ? failure.message : 'Trackeråtgärden kunde inte sparas.');
      try { const next = await request(); if (generation.current === principal) setData(next); } catch { /* Keep the last confirmed inventory. */ }
    } finally { if (generation.current === principal) setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const sim = Object.fromEntries(['operator', 'iccid', 'apn'].filter(key => form[key as 'operator' | 'iccid' | 'apn'].trim()).map(key => [key, form[key as 'operator' | 'iccid' | 'apn'].trim()]));
    void mutate({ action: 'device.register', name: form.name.trim(), model: form.model.trim(), source: form.source, profile: form.profile,
      ...(form.source === 'device' && { imei: form.imei.trim(), ...(Object.keys(sim).length && { sim }) }) });
  }
  const companyName = (id?: string) => companies.find(value => value.id === id)?.name ?? 'Inte tilldelad';
  const visible = (data?.devices ?? []).filter(device => (!companyFilter || companyFilter === 'unassigned' ? !companyFilter || !device.organisationId && !device.pendingOrganisationId : device.organisationId === companyFilter || device.pendingOrganisationId === companyFilter)
    && `${device.name} ${device.model} ${device.imei ?? ''} ${device.sim?.operator ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  if (!allowed) return <section className="platform-panel"><h2>Trackers</h2><p>Avsluta Jobba som och öppna systemadministrationen med ditt eget plattformskonto för att hantera trackers.</p></section>;
  return <section className="platform-fleet" aria-label="Plattformens trackerregister">
    <div className="platform-page-heading"><div><span className="platform-eyebrow">SYSTEMADMINISTRATION</span><h1>Trackers</h1><p>Registrera utrustning, förbered anslutningen och tilldela rätt bolag.</p></div><button type="button" className="platform-btn" disabled={busy} onClick={() => { setRegistering(true); setError(''); }}><Plus size={17} />Registrera tracker</button></div>
    <div className="platform-stats"><div><Radio size={22} /><span>Registrerade<strong>{data?.devices.length ?? 0}</strong></span></div><div><Building2 size={22} /><span>Tilldelade<strong>{data?.devices.filter(value => value.organisationId && value.provisioningStatus !== 'retired').length ?? 0}</strong></span></div><div><ShieldCheck size={22} /><span>Väntar på synkronisering<strong>{data?.requests.length ?? 0}</strong></span></div></div>
    {error && <p className="platform-error" role="alert">{error}</p>}{message && <p className="platform-info" role="status">{message}</p>}
    {registering && <section className="platform-panel"><div className="platform-panel-heading"><h2>Ny tracker</h2><button type="button" className="platform-icon-btn" aria-label="Stäng trackerregistrering" disabled={busy} onClick={() => setRegistering(false)}><X size={19} /></button></div>
      <form className="platform-form platform-fleet-form" onSubmit={submit}>
        <label>Namn<input required maxLength={120} value={form.name} disabled={busy} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} placeholder="Exempel: Tracker 12" /></label>
        <label>Typ<select value={form.source} disabled={busy} onChange={event => setForm(current => ({ ...current, source: event.target.value, profile: event.target.value === 'simulator' ? 'simulator' : 'teltonika-codec8e', model: event.target.value === 'simulator' ? 'Testsändare' : 'Teltonika FMC003' }))}><option value="device">Fysisk tracker</option><option value="simulator">Testsändare</option></select></label>
        <label>Modell<input required maxLength={80} value={form.model} disabled={busy} onChange={event => setForm(current => ({ ...current, model: event.target.value }))} /></label>
        <label>Profil<select value={form.profile} disabled={busy || form.source === 'simulator'} onChange={event => setForm(current => ({ ...current, profile: event.target.value }))}>{form.source === 'simulator' ? <option value="simulator">Simulerad testkälla</option> : <><option value="teltonika-codec8e">Teltonika Codec 8 Extended</option><option value="teltonika-codec8">Teltonika Codec 8</option></>}</select></label>
        {form.source === 'device' && <><label>IMEI<input required inputMode="numeric" pattern="[0-9]{15}" maxLength={15} value={form.imei} disabled={busy} onChange={event => setForm(current => ({ ...current, imei: event.target.value }))} placeholder="15 siffror från enhetens etikett" /></label><label>Mobiloperatör<input maxLength={80} value={form.operator} disabled={busy} onChange={event => setForm(current => ({ ...current, operator: event.target.value }))} /></label><label>SIM-kortets ICCID <small>Valfritt</small><input inputMode="numeric" maxLength={22} value={form.iccid} disabled={busy} onChange={event => setForm(current => ({ ...current, iccid: event.target.value }))} /></label><label>APN <small>Valfritt, inga lösenord</small><input maxLength={100} value={form.apn} disabled={busy} onChange={event => setForm(current => ({ ...current, apn: event.target.value }))} /></label></>}
        <p className="platform-fleet-help">Registreringen förbereder enheten. Den visar inte att en fysisk tracker har anslutits. Testsändare markeras alltid som testdata.</p>
        <div className="platform-form-actions"><button type="button" className="platform-btn outline" disabled={busy} onClick={() => setRegistering(false)}>Avbryt</button><button type="submit" className="platform-btn" disabled={busy}>{busy ? 'Sparar…' : 'Registrera och förbered'}</button></div>
      </form>
    </section>}
    <section className="platform-panel"><div className="platform-panel-heading"><h2>Enhetsregister</h2><button type="button" className="platform-text-btn" disabled={loading || busy} onClick={() => { attempts.current.clear(); setRefresh(value => value + 1); }}><RefreshCw size={15} />Uppdatera</button></div>
      <div className="platform-fleet-filters"><label><Search size={16} /><input aria-label="Sök trackers" value={search} onChange={event => setSearch(event.target.value)} placeholder="Sök namn, IMEI eller modell…" /></label><select aria-label="Filtrera trackers efter bolag" value={companyFilter} onChange={event => setCompanyFilter(event.target.value)}><option value="">Alla bolag</option><option value="unassigned">Inte tilldelade</option>{companies.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></div>
      {loading && <p role="status">Hämtar trackers…</p>}
      <div className="platform-table-wrap"><table className="platform-table"><thead><tr><th>Tracker</th><th>Bolag</th><th>Förberedelse</th><th>Anslutning</th><th>Åtgärder</th></tr></thead><tbody>{visible.map(device => <tr key={device.id}><td><strong>{device.name}</strong><small>{device.model}{device.source === 'simulator' ? ' · TESTSÄNDARE' : ''}</small><small>{device.imei ? `IMEI ${device.imei}` : 'Ingen fysisk IMEI'}</small>{device.sim?.operator && <small>{device.sim.operator}</small>}</td><td>{companyName(device.organisationId)}{device.pendingOrganisationId && <small>Väntar: {companyName(device.pendingOrganisationId)}</small>}</td><td><span className={`platform-status ${device.provisioningStatus === 'retired' ? 'inactive' : device.provisioningStatus === 'active' ? 'active' : 'provisioning'}`}>{device.pendingRequestId ? 'Synkroniseras' : labels[device.provisioningStatus]}</span></td><td><span className="platform-fleet-connection"><MapPin size={13} />{device.source === 'simulator' ? 'Testkälla' : 'Ingen bekräftad anslutning'}</span></td><td><div className="platform-fleet-actions">{device.pendingRequestId ? <button type="button" className="platform-text-btn" disabled={busy} onClick={() => { const pending = data?.requests.find(value => value.deviceId === device.id); if (pending) void mutate(pending.command, pending.command); }}><RefreshCw size={14} />Försök synkronisera igen</button> : device.provisioningStatus !== 'retired' && <><button type="button" className="platform-text-btn" disabled={busy} onClick={() => { setSelected(device); setAction('assign'); setCompany(device.organisationId ?? ''); }}><Building2 size={14} />{device.organisationId ? 'Visa tilldelning' : 'Tilldela bolag'}</button><button type="button" className="platform-text-btn danger" disabled={busy} onClick={() => { setSelected(device); setAction('retire'); }}><Trash2 size={14} />Avregistrera</button></>}</div></td></tr>)}</tbody></table></div>
      {!loading && !visible.length && <p className="platform-fleet-empty"><Radio size={24} />Inga trackers matchar urvalet. Registrera en enhet för att börja.</p>}
    </section>
    {selected && <div className="platform-fleet-overlay"><section className="platform-panel platform-fleet-dialog" role="dialog" aria-modal="true" aria-label={action === 'assign' ? 'Tilldela tracker till bolag' : 'Avregistrera tracker'}><div className="platform-panel-heading"><h2>{action === 'assign' ? 'Tilldela bolag' : 'Avregistrera tracker'}</h2><button type="button" className="platform-icon-btn" aria-label="Stäng trackeråtgärd" disabled={busy} onClick={() => setSelected(undefined)}><X size={18} /></button></div><p><strong>{selected.name}</strong>{selected.imei ? ` · ${selected.imei}` : ' · Testsändare'}</p>{action === 'assign' ? <><p>Bolaget kan sedan koppla enheten till sitt fordon. Tidigare bolagstilldelning kan inte flyttas här.</p><label className="platform-fleet-company-label">Bolag<select value={company} disabled={busy || Boolean(selected.organisationId)} onChange={event => setCompany(event.target.value)}><option value="">Välj bolag</option>{companies.filter(value => value.status === 'active').map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label></> : <p>Enheten inaktiveras i bolagets register. Tidigare tilldelning och historik bevaras.</p>}<div className="platform-form-actions"><button type="button" className="platform-btn outline" disabled={busy} onClick={() => setSelected(undefined)}>Avbryt</button><button type="button" className="platform-btn" disabled={busy || action === 'assign' && !company} onClick={() => void mutate({ action: action === 'assign' ? 'device.assign' : 'device.retire', deviceId: selected.id, ...(action === 'assign' && { organisationId: company }) })}><CheckCircle2 size={16} />{busy ? 'Sparar…' : action === 'assign' ? 'Tilldela och synkronisera' : 'Avregistrera'}</button></div></section></div>}
  </section>;
}
