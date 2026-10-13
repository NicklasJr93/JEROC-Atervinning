import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Plus, RefreshCw, Truck } from 'lucide-react';
import type { ContainerType, TransportVehicle, VehicleRegistryResponse, VehicleSaveCommand } from '../transport/types';
import { vesselTypes } from '../transport/types';
import { PersonnelApiError, type PersonnelClientScope } from './client';
import { readVehicles, saveVehicle } from './vehicles-client';
import { Alert, Dialog, Field, Pill } from './components/Ui';
import './personnel-vehicles.css';

const categories = { truck: 'Lastbil', van: 'Transportbil', car: 'Personbil', trailer: 'Släp', other: 'Annat fordon' };

export function useVehicleRegistry(scope: PersonnelClientScope, initialVehicles: TransportVehicle[] = []) {
  const identity = useRef(scope.key); identity.current = scope.key;
  const [snapshot, setSnapshot] = useState<{ key: string; value: VehicleRegistryResponse }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const requests = useRef(new Set<AbortController>()), sequence = useRef(0);
  const refresh = useCallback(async () => {
    const controller = new AbortController(), version = ++sequence.current;
    requests.current.add(controller);
    try {
      const value = await readVehicles(scope, controller.signal);
      if (identity.current !== scope.key || controller.signal.aborted) return;
      if (version === sequence.current) { setSnapshot(previous => previous?.key === scope.key && previous.value.revision > value.revision ? previous : { key: scope.key, value }); setError(''); }
    } catch (reason) {
      if (identity.current !== scope.key || controller.signal.aborted) return;
      if (reason instanceof PersonnelApiError && [401, 403].includes(reason.status)) setSnapshot(undefined);
      setError(reason instanceof Error ? reason.message : 'Fordonsregistret kunde inte laddas.');
    } finally { requests.current.delete(controller); if (identity.current === scope.key) setLoading(false); }
  }, [scope.key]);
  useEffect(() => {
    setSnapshot(undefined); setError(''); setLoading(true); void refresh();
    const activeRequests = requests.current;
    return () => { ++sequence.current; for (const request of activeRequests) request.abort(); activeRequests.clear(); };
  }, [refresh]);
  const save = useCallback(async (command: VehicleSaveCommand) => {
    const controller = new AbortController(); requests.current.add(controller); ++sequence.current;
    try {
      const value = await saveVehicle(scope, command, controller.signal);
      if (identity.current !== scope.key || controller.signal.aborted) throw new DOMException('Inloggningen har ändrats.', 'AbortError');
      setSnapshot({ key: scope.key, value }); setError(''); return value;
    } catch (reason) {
      if (identity.current === scope.key && reason instanceof PersonnelApiError && [401, 403].includes(reason.status)) setSnapshot(undefined);
      throw reason;
    } finally { requests.current.delete(controller); }
  }, [scope.key]);
  const value = snapshot?.key === scope.key ? snapshot.value : undefined;
  return { value, vehicles: value?.vehicles ?? (error ? [] : initialVehicles), loading, error, refresh, save };
}

/** Shared controlled fields: usable inside a person form without a nested form. */
export function VehicleEditor({ vehicle, onSave, onClose, onBusy, allowInactive = true }: {
  vehicle?: TransportVehicle;
  onSave: (command: VehicleSaveCommand) => Promise<VehicleRegistryResponse>;
  onClose: () => void; onBusy?: (busy: boolean) => void; allowInactive?: boolean;
}) {
  const [name, setName] = useState(vehicle?.name ?? ''), [registration, setRegistration] = useState(vehicle?.registration ?? '');
  const [category, setCategory] = useState<NonNullable<TransportVehicle['category']>>(vehicle?.category ?? 'truck');
  const [capacity, setCapacity] = useState(vehicle?.capacityKg === undefined ? '' : String(vehicle.capacityKg));
  const [types, setTypes] = useState<ContainerType[]>(vehicle?.types ?? ['container']);
  const [active, setActive] = useState(vehicle?.active !== false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), mounted = useRef(true), retry = useRef<{ key: string; requestId: string } | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit() {
    if (pending.current) return;
    if (!name.trim() || registration.trim().length < 2 || !types.length) { setError('Ange namn, registreringsnummer och minst en kärltyp.'); return; }
    const kg = capacity.trim() ? Number(capacity.replace(',', '.')) : undefined;
    if (kg !== undefined && (!Number.isFinite(kg) || kg <= 0 || kg > 1e7)) { setError('Ange en lastkapacitet över 0 och högst 10 000 000 kg, eller lämna fältet tomt.'); return; }
    const input: VehicleSaveCommand['vehicle'] = { ...(vehicle ? { id: vehicle.id, revision: vehicle.revision ?? 0 } : {}), name: name.trim(), registration: registration.trim(), types, active, category, ...(kg === undefined ? {} : { capacityKg: kg }) };
    const key = JSON.stringify(input);
    if (retry.current?.key !== key) retry.current = { key, requestId: crypto.randomUUID() };
    pending.current = true; setBusy(true); onBusy?.(true); setError('');
    try { await onSave({ action: 'vehicle.save', vehicle: input, requestId: retry.current.requestId }); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Fordonet kunde inte sparas.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); onBusy?.(false); }
  }
  return <section className="hr-vehicle-editor" aria-label={vehicle ? 'Redigera fordon' : 'Skapa nytt fordon'}>
    <h3><Truck size={17} />{vehicle ? 'Redigera fordon' : 'Skapa nytt fordon'}</h3>
    <fieldset disabled={busy} className="hr-vehicle-fields"><div className="hr-form-grid">
      <Field label="Fordonsnamn *"><input aria-label="Fordonsnamn *" value={name} onChange={event => setName(event.target.value)} maxLength={200} placeholder="T.ex. Lastbil 3" /></Field>
      <Field label="Registreringsnummer *"><input aria-label="Registreringsnummer *" value={registration} onChange={event => setRegistration(event.target.value)} maxLength={30} autoCapitalize="characters" /></Field>
      <Field label="Fordonstyp"><select value={category} onChange={event => setCategory(event.target.value as typeof category)}>{Object.entries(categories).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
      <Field label="Lastkapacitet (kg)"><input inputMode="decimal" value={capacity} onChange={event => setCapacity(event.target.value)} placeholder="Valfritt" /></Field>
      <div className="hr-field full"><span>Kan hantera *</span><div className="hr-checkbox-list">{Object.entries(vesselTypes).map(([id, type]) => <label key={id}><input type="checkbox" checked={types.includes(id as ContainerType)} onChange={event => setTypes(previous => event.target.checked ? [...previous, id as ContainerType] : previous.filter(value => value !== id))} />{type.label}</label>)}</div></div>
      {allowInactive && <label className="hr-checkbox full"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} /> Fordonet är aktivt</label>}
    </div></fieldset>
    {!active && <Alert tone="orange">Fordonet tas bort från nya fordonsval. Befintliga kopplingar och bokningshistorik finns kvar.</Alert>}
    {error && <Alert tone="red">{error}</Alert>}
    <div className="hr-dialog-actions"><button type="button" className="office-btn outline" disabled={busy} onClick={onClose}>Avbryt fordonsändring</button><button type="button" className="office-btn" disabled={busy} onClick={() => void submit()}>{busy ? 'Sparar fordon…' : 'Spara fordon'}</button></div>
  </section>;
}

export default function VehicleRegistry({ scope, onClose, onChanged }: { scope: PersonnelClientScope; onClose: () => void; onChanged?: () => Promise<void> | void }) {
  const registry = useVehicleRegistry(scope), [editing, setEditing] = useState<TransportVehicle | 'new'>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  return <Dialog title="Fordonsregister" description="Gemensamma fordon för personal och transportplanering." onClose={() => { if (!busy) onClose(); }}>
    {registry.loading ? <div className="hr-loading"><RefreshCw size={18} /> Laddar fordon…</div> : <>
      {registry.error && <Alert tone="red">{registry.error}<button type="button" className="office-link" onClick={() => void registry.refresh()}>Uppdatera fordon</button></Alert>}
      {notice && <Alert tone="green">{notice}</Alert>}
      {editing && registry.value?.capabilities.vehicleWrite ? <VehicleEditor key={editing === 'new' ? 'new' : `${editing.id}:${editing.revision ?? 0}`} vehicle={editing === 'new' ? undefined : editing} onBusy={setBusy} onClose={() => setEditing(undefined)} onSave={async command => { const value = await registry.save(command); setEditing(undefined); setNotice('Fordonet är sparat.'); void Promise.resolve(onChanged?.()).catch(() => {}); return value; }} /> : <>
        {registry.value?.capabilities.vehicleWrite && <button type="button" className="office-btn hr-vehicle-create" onClick={() => { setNotice(''); setEditing('new'); }}><Plus size={16} /> Skapa nytt fordon</button>}
        <div className="hr-table-scroll"><table className="office-table hr-table"><thead><tr><th>Fordon</th><th>Kan hantera</th><th>Status</th><th></th></tr></thead><tbody>{registry.vehicles.map(vehicle => <tr key={vehicle.id}><td><strong>{vehicle.name}</strong><small>{vehicle.registration}{vehicle.capacityKg !== undefined ? ` · ${vehicle.capacityKg.toLocaleString('sv-SE')} kg` : ''}</small></td><td>{vehicle.types.map(type => vesselTypes[type].label).join(', ')}</td><td><Pill tone={vehicle.active === false ? 'grey' : 'green'}>{vehicle.active === false ? 'Inaktiverat' : 'Aktivt'}</Pill></td><td>{registry.value?.capabilities.vehicleWrite && <button type="button" className="office-link" aria-label={`Redigera ${vehicle.name}`} onClick={() => { setNotice(''); setEditing(vehicle); }}><Pencil size={14} /> Redigera</button>}</td></tr>)}</tbody></table></div>
        {!registry.vehicles.length && !registry.error && <div className="hr-empty">Inga fordon registrerade.</div>}
        {registry.value && !registry.value.capabilities.vehicleWrite && <p className="hr-muted">För att ändra det gemensamma fordonsregistret krävs behörighet för alla anläggningar.</p>}
      </>}
    </>}
  </Dialog>;
}
