import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Truck } from 'lucide-react';
import type { ContainerType, TransportVehicle, VehicleRegistryResponse, VehicleSaveCommand } from '../transport/types';
import { vesselTypes } from '../transport/types';
import { PersonnelApiError, type PersonnelClientScope } from './client';
import { readVehicles, saveVehicle } from './vehicles-client';
import { Alert, Dialog, Field } from './components/Ui';
import './personnel-vehicles.css';

const categories = { truck: 'Lastbil', van: 'Transportbil', car: 'Personbil', trailer: 'Släp', machine: 'Maskin', other: 'Annat fordon' };

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
  const [assetTag, setAssetTag] = useState(vehicle?.assetTag ?? ''), [identifier, setIdentifier] = useState(vehicle?.identifier ?? '');
  const [category, setCategory] = useState<NonNullable<TransportVehicle['category']>>(vehicle?.category ?? 'truck');
  const [capacity, setCapacity] = useState(vehicle?.capacityKg === undefined ? '' : String(vehicle.capacityKg));
  const [types, setTypes] = useState<ContainerType[]>(vehicle?.types ?? ['container']);
  const [active, setActive] = useState(vehicle?.active !== false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), mounted = useRef(true), retry = useRef<{ key: string; requestId: string } | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit() {
    if (pending.current) return;
    const machine = category === 'machine' || category === 'other';
    if (!name.trim() || (!machine && registration.trim().length < 2) || (machine && !registration.trim() && !assetTag.trim() && !identifier.trim())) {
      setError('Ange namn och registreringsnummer. För maskiner räcker ett inventarienummer eller en intern identifiering.'); return;
    }
    if (!types.length && !['car', 'machine', 'other'].includes(category)) { setError('Välj minst en kärltyp för transportfordonet.'); return; }
    const kg = capacity.trim() ? Number(capacity.replace(',', '.')) : undefined;
    if (kg !== undefined && (!Number.isFinite(kg) || kg <= 0 || kg > 1e7)) { setError('Ange en lastkapacitet över 0 och högst 10 000 000 kg, eller lämna fältet tomt.'); return; }
    const input: VehicleSaveCommand['vehicle'] = { ...(vehicle ? { id: vehicle.id, revision: vehicle.revision ?? 0 } : {}), name: name.trim(), registration: registration.trim(), types, active, category,
      ...(assetTag.trim() ? { assetTag: assetTag.trim() } : {}), ...(identifier.trim() ? { identifier: identifier.trim() } : {}), ...(kg === undefined ? {} : { capacityKg: kg }) };
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
      <Field label={['machine', 'other'].includes(category) ? 'Registreringsnummer' : 'Registreringsnummer *'}><input aria-label={['machine', 'other'].includes(category) ? 'Registreringsnummer' : 'Registreringsnummer *'} value={registration} onChange={event => setRegistration(event.target.value)} maxLength={30} autoCapitalize="characters" /></Field>
      <Field label="Fordonstyp"><select aria-label="Fordonstyp" value={category} onChange={event => setCategory(event.target.value as typeof category)}>{Object.entries(categories).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
      <Field label="Inventarienummer"><input value={assetTag} onChange={event => setAssetTag(event.target.value)} maxLength={120} placeholder="Valfritt" /></Field>
      <Field label="Intern identifiering"><input value={identifier} onChange={event => setIdentifier(event.target.value)} maxLength={120} placeholder="T.ex. serienummer" /></Field>
      <Field label="Lastkapacitet (kg)"><input inputMode="decimal" value={capacity} onChange={event => setCapacity(event.target.value)} placeholder="Valfritt" /></Field>
      <div className="hr-field full"><span>{['car', 'machine', 'other'].includes(category) ? 'Kan hantera (valfritt)' : 'Kan hantera *'}</span><div className="hr-checkbox-list">{Object.entries(vesselTypes).map(([id, type]) => <label key={id}><input type="checkbox" checked={types.includes(id as ContainerType)} onChange={event => setTypes(previous => event.target.checked ? [...previous, id as ContainerType] : previous.filter(value => value !== id))} />{type.label}</label>)}</div></div>
      {allowInactive && <label className="hr-checkbox full"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} /> Fordonet är aktivt</label>}
    </div></fieldset>
    {!active && <Alert tone="orange">Fordonet tas bort från nya fordonsval. Befintliga kopplingar och bokningshistorik finns kvar.</Alert>}
    {error && <Alert tone="red">{error}</Alert>}
    <div className="hr-dialog-actions"><button type="button" className="office-btn outline" disabled={busy} onClick={onClose}>Avbryt fordonsändring</button><button type="button" className="office-btn" disabled={busy} onClick={() => void submit()}>{busy ? 'Sparar fordon…' : 'Spara fordon'}</button></div>
  </section>;
}

export default function VehicleRegistry({ onClose }: { scope: PersonnelClientScope; onClose: () => void; onChanged?: () => Promise<void> | void }) {
  return <Dialog title="Fordonsregister" description="Fordon och maskiner hanteras i det gemensamma registret." onClose={onClose}>
    <p>Öppna Fordon och maskiner för register, underhåll och fordonsuppgifter. Befintliga kopplingar till personal och transporter följer med.</p>
    <a className="office-btn" href="#/fleet" onClick={onClose}><ArrowUpRight size={16} /> Öppna Fordon och maskiner</a>
  </Dialog>;
}
