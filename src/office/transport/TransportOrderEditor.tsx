import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  MapPin,
  Search,
  X,
} from 'lucide-react';
import type { OfficeCustomer } from '../model';
import { durationLabel, timeLabel, today } from './model';
import {
  actionLabels,
  vesselTypes,
  type ContainerType,
  type TransportAction,
  type TransportData,
  type TransportDraft,
  type TransportOrder,
  type TransportPlan,
} from './types';
import './transport-editor.css';
import type { PersonnelData } from '../personnel/types';
import { personnelPlanIssues } from '../personnel/model';

type Coordinates = { lat: number; lng: number };
type Repeat = 'none' | 'weekly' | 'biweekly';
type Scope = 'one' | 'series';

export interface TransportOrderEditorProps {
  order?: TransportOrder;
  data: TransportData;
  customers: OfficeCustomer[];
  mode: 'create' | 'edit' | 'book';
  initialPlan?: TransportPlan;
  error: string;
  onError(message: string): void;
  onSubmit(draft: TransportDraft, options: { repeat: Repeat; scope: Scope }): boolean;
  onCancel(): void;
  onPickLocation(receive: (coords: Coordinates) => void): void;
  personnel?: PersonnelData;
}

function validCoordinates(coords: Coordinates): boolean {
  return Number.isFinite(coords.lat) && Number.isFinite(coords.lng) &&
    coords.lat >= -90 && coords.lat <= 90 && coords.lng >= -180 && coords.lng <= 180;
}

function newDraft(order?: TransportOrder): TransportDraft {
  return {
    customerId: order?.customerId,
    customerName: order?.customerName ?? '',
    address: order?.address ?? '',
    city: order?.city ?? '',
    contact: order?.contact ?? '',
    phone: order?.phone ?? '',
    action: order?.action ?? 'pickup',
    vesselType: order?.vesselType ?? 'container',
    material: order?.material ?? '',
    vesselSize: order?.vesselSize ?? '',
    pickupVessel: order?.pickupVessel ?? '',
    replacementVessel: order?.replacementVessel ?? '',
    notes: order?.notes ?? '',
    lat: order?.lat ?? Number.NaN,
    lng: order?.lng ?? Number.NaN,
    durationMinutes: order?.durationMinutes ?? 60,
    status: order?.status ?? 'unbooked',
    requestedDate: order?.requestedDate ?? (order ? undefined : today()),
    requiredCompetencies: order?.requiredCompetencies,
  };
}

/** The parent validates booking conflicts and commits one complete, auditable change. */
export default function TransportOrderEditor({
  order,
  data,
  customers,
  mode,
  initialPlan,
  error,
  onError,
  onSubmit,
  onCancel,
  onPickLocation,
  personnel,
}: TransportOrderEditorProps) {
  const formId = useId();
  const [draft, setDraft] = useState<TransportDraft>(() => ({
    ...newDraft(order),
    durationMinutes: initialPlan?.durationMinutes ?? order?.durationMinutes ?? 60,
  }));
  const [booked, setBooked] = useState(
    mode === 'book' || Boolean(initialPlan) || Boolean(order && order.status !== 'unbooked'),
  );
  const [date, setDate] = useState(initialPlan?.date ?? order?.date ?? today());
  const [start, setStart] = useState(timeLabel(initialPlan?.startMinute ?? order?.startMinute ?? 600));
  const [driverId, setDriverId] = useState(initialPlan?.driverId ?? order?.driverId ?? data.drivers[0]?.id ?? '');
  const [vehicleId, setVehicleId] = useState(initialPlan?.vehicleId ?? order?.vehicleId ?? data.drivers[0]?.vehicleId ?? '');
  const [repeat, setRepeat] = useState<Repeat>('none');
  const [scope, setScope] = useState<Scope>('one');
  const [finding, setFinding] = useState(false);
  const [locationHelp, setLocationHelp] = useState('');
  const geocodeController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const locationVersion = useRef(0);
  const hasLocation = validCoordinates(draft);
  const hours = Math.floor(draft.durationMinutes / 60);
  const minutes = draft.durationMinutes % 60;
  const startMinute = /^\d{2}:\d{2}$/.test(start)
    ? Number(start.slice(0, 2)) * 60 + Number(start.slice(3))
    : Number.NaN;
  const title = mode === 'create' ? 'Ny arbetsorder' : mode === 'book' ? 'Boka arbetsorder' : 'Redigera arbetsorder';
  const submitLabel = mode === 'create' ? 'Spara arbetsorder' : mode === 'book' || order?.preliminary || (order?.status === 'unbooked' && booked) ? 'Spara planering' : 'Spara ändringar';
  const person = personnel?.people.find(entry => entry.driverId === driverId);
  const company = personnel?.companies.find(entry => entry.id === person?.companyId);
  const competencyOptions = Array.from(new Map((personnel?.competencies ?? []).flatMap(competency => competency.codes.map(code => [`${competency.type}:${code}`, `${competency.name} · ${code}`] as const))).entries());
  const previewOrder: TransportOrder = { ...draft, id: order?.id ?? 'draft-check', audit: [], updatedAt: new Date().toISOString(), bookingVersion: 0 };
  const previewData: TransportData = { ...data, orders: [...data.orders.filter(entry => entry.id !== previewOrder.id), previewOrder] };
  const bookingIssues = booked && personnel && Number.isFinite(startMinute)
    ? personnelPlanIssues(personnel, previewData, previewOrder.id, { date, startMinute, durationMinutes: draft.durationMinutes, driverId, vehicleId }) : [];

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      geocodeController.current?.abort();
      locationVersion.current += 1;
    };
  }, []);

  function setField<K extends keyof TransportDraft>(key: K, value: TransportDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    if (error) onError('');
  }

  function changeAddress(address: string, city: string) {
    geocodeController.current?.abort();
    locationVersion.current += 1;
    setFinding(false);
    setLocationHelp('');
    setDraft((current) => ({ ...current, address, city, lat: Number.NaN, lng: Number.NaN }));
    if (error) onError('');
  }

  function chooseCustomer(id: string) {
    const customer = customers.find((entry) => entry.id === id);
    if (!customer) {
      setField('customerId', undefined);
      return;
    }
    const addressChanged = customer.address !== draft.address || customer.city !== draft.city;
    if (addressChanged) {
      geocodeController.current?.abort();
      locationVersion.current += 1;
      setFinding(false);
      setLocationHelp('');
    }
    setDraft((current) => ({
      ...current,
      customerId: customer.id,
      customerName: customer.name,
      address: customer.address,
      city: customer.city,
      contact: customer.contactPerson,
      phone: customer.phone,
      ...(addressChanged ? { lat: Number.NaN, lng: Number.NaN } : {}),
    }));
    if (error) onError('');
  }

  async function findAddress() {
    if (!draft.address.trim() || !draft.city.trim()) {
      onError('Ange adress och ort innan du söker efter platsen.');
      return;
    }
    geocodeController.current?.abort();
    const controller = new AbortController();
    geocodeController.current = controller;
    const version = ++locationVersion.current;
    setFinding(true);
    setLocationHelp('');
    if (error) onError('');
    try {
      const query = new URLSearchParams({
        format: 'json',
        q: `${draft.address.trim()}, ${draft.city.trim()}, Sverige`,
        countrycodes: 'se',
        limit: '1',
      });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${query}`, { signal: controller.signal });
      if (!response.ok) throw new Error('Adressökningen är tillfälligt otillgänglig.');
      const result: unknown = await response.json();
      if (!Array.isArray(result) || !result.length || typeof result[0] !== 'object' || result[0] === null) {
        throw new Error('Adressen hittades inte. Välj platsen på kartan i stället.');
      }
      const point = result[0] as Record<string, unknown>;
      const coords = { lat: Number(point.lat), lng: Number(point.lon) };
      if ((typeof point.lat !== 'number' && typeof point.lat !== 'string') ||
          (typeof point.lon !== 'number' && typeof point.lon !== 'string') ||
          (typeof point.lat === 'string' && !point.lat.trim()) ||
          (typeof point.lon === 'string' && !point.lon.trim()) ||
          !validCoordinates(coords)) {
        throw new Error('Platsen kunde inte läsas. Välj platsen på kartan i stället.');
      }
      if (mounted.current && version === locationVersion.current && !controller.signal.aborted) {
        setDraft((current) => ({ ...current, ...coords }));
        setLocationHelp('Adressen hittad. Kontrollera gärna placeringen på kartan.');
      }
    } catch (failure) {
      if (mounted.current && version === locationVersion.current && !controller.signal.aborted) {
        setLocationHelp(failure instanceof Error ? `${failure.message} Du kan alltid välja plats på kartan.` : 'Välj platsen på kartan i stället.');
      }
    } finally {
      if (mounted.current && version === locationVersion.current) setFinding(false);
    }
  }

  function pickLocation() {
    geocodeController.current?.abort();
    setFinding(false);
    const version = ++locationVersion.current;
    setLocationHelp('Klicka på uppdragets plats på kartan.');
    onPickLocation((coords) => {
      if (!mounted.current || version !== locationVersion.current) return;
      if (!validCoordinates(coords)) {
        onError('Välj en giltig plats på kartan.');
        return;
      }
      setDraft((current) => ({ ...current, ...coords }));
      setLocationHelp('Platsen har valts på kartan.');
      onError('');
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.customerName.trim() || !draft.address.trim() || !draft.city.trim()) {
      onError('Ange kund, adress och ort.');
      return;
    }
    if (!hasLocation) {
      onError('Hitta adressen eller välj platsen på kartan innan du sparar.');
      return;
    }
    if (draft.durationMinutes < 15 || draft.durationMinutes > 480 || draft.durationMinutes % 15 !== 0) {
      onError('Välj en tidsåtgång mellan 15 minuter och 8 timmar i 15-minuterssteg.');
      return;
    }
    const clean: TransportDraft = {
      ...draft,
      customerName: draft.customerName.trim(),
      address: draft.address.trim(),
      city: draft.city.trim(),
      contact: draft.contact.trim(),
      phone: draft.phone.trim(),
      material: draft.material.trim(),
      vesselSize: draft.vesselSize.trim(),
      pickupVessel: draft.pickupVessel.trim(),
      replacementVessel: draft.replacementVessel.trim(),
      notes: draft.notes.trim(),
      requestedDate: draft.requestedDate || undefined,
      status: booked ? (order?.status === 'on_way' ? 'on_way' : order?.status === 'done' ? 'done' : 'booked') : 'unbooked',
      ...(booked ? { date, startMinute, driverId, vehicleId } : {}),
    };
    onSubmit(clean, { repeat, scope });
  }

  return (
    <section className="transport-order-editor" aria-label={title}>
      <header className="transport-editor-heading">
        <div>
          <span>{order?.id ?? 'PLANERA EN HÄMTNING'}</span>
          <h2>{title}</h2>
        </div>
        <button type="button" className="transport-editor-close" aria-label="Stäng arbetsorder" onClick={onCancel}>
          <X size={18} />
        </button>
      </header>
      <form id={formId} className="transport-editor-form" onSubmit={submit}>
        <fieldset>
          <legend>Kund & plats</legend>
          <label>
            Välj befintlig kund
            <select value={draft.customerId && customers.some((entry) => entry.id === draft.customerId) ? draft.customerId : ''} onChange={(event) => chooseCustomer(event.target.value)}>
              <option value="">Annan kund / skriv namn</option>
              {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
            </select>
          </label>
          <label>
            Kundnamn <span className="transport-required">*</span>
            <input aria-label="Kundnamn" autoFocus required maxLength={200} value={draft.customerName} placeholder="Företag eller namn" onChange={(event) => {
              setDraft((current) => ({ ...current, customerName: event.target.value, customerId: undefined }));
              if (error) onError('');
            }} />
          </label>
          <label>
            Hämtningsadress <span className="transport-required">*</span>
            <input aria-label="Hämtningsadress" required maxLength={200} value={draft.address} placeholder="Gata och nummer" onChange={(event) => changeAddress(event.target.value, draft.city)} />
          </label>
          <label>
            Ort <span className="transport-required">*</span>
            <input aria-label="Ort" required maxLength={200} value={draft.city} placeholder="Exempelvis Norrtälje" onChange={(event) => changeAddress(draft.address, event.target.value)} />
          </label>
          <div className="transport-location-actions">
            <button type="button" disabled={finding || !draft.address.trim() || !draft.city.trim()} onClick={() => void findAddress()}>
              {finding ? <LoaderCircle className="transport-editor-spinner" size={15} /> : <Search size={15} />} Hitta adress
            </button>
            <button type="button" onClick={pickLocation}><MapPin size={15} /> Välj på kartan</button>
          </div>
          <div className={`transport-location-state ${hasLocation ? 'is-set' : ''}`} aria-live="polite">
            {hasLocation ? <CheckCircle2 size={14} /> : <MapPin size={14} />}
            <span>{hasLocation ? 'Plats vald' : 'Välj plats för pinnålen'}</span>
          </div>
          {locationHelp && <p className="transport-editor-help" role="status">{locationHelp}</p>}
          <div className="transport-editor-grid">
            <label>Kontaktperson<input maxLength={2000} value={draft.contact} onChange={(event) => setField('contact', event.target.value)} /></label>
            <label>Telefon<input type="tel" maxLength={2000} value={draft.phone} onChange={(event) => setField('phone', event.target.value)} /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Uppdrag</legend>
          <div className="transport-editor-grid">
            <label>Åtgärd<select value={draft.action} onChange={(event) => setField('action', event.target.value as TransportAction)}>{Object.entries(actionLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label>Kärltyp<select value={draft.vesselType} onChange={(event) => setField('vesselType', event.target.value as ContainerType)}>{Object.entries(vesselTypes).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
          </div>
          <div className="transport-editor-grid">
            <label>Material<input maxLength={2000} value={draft.material} placeholder="Ex. batterier" onChange={(event) => setField('material', event.target.value)} /></label>
            <label>Storlek<input maxLength={2000} value={draft.vesselSize} placeholder="Ex. 20 m³" onChange={(event) => setField('vesselSize', event.target.value)} /></label>
          </div>
          <div className="transport-editor-grid">
            {draft.action !== 'placement' && <label>Kärl som hämtas<input maxLength={2000} value={draft.pickupVessel} placeholder="Ex. C-014" onChange={(event) => setField('pickupVessel', event.target.value)} /></label>}
            {draft.action !== 'pickup' && <label>Kärl som ställs ut<input maxLength={2000} value={draft.replacementVessel} placeholder="Ex. C-027" onChange={(event) => setField('replacementVessel', event.target.value)} /></label>}
          </div>
          <label>Instruktioner<textarea rows={3} maxLength={2000} value={draft.notes} placeholder="Tillträde, grindkod eller annat föraren behöver veta" onChange={(event) => setField('notes', event.target.value)} /></label>
          {competencyOptions.length > 0 && <details className="transport-competency-picker"><summary>Obligatoriska kompetenser{draft.requiredCompetencies?.length ? ` (${draft.requiredCompetencies.length})` : ''}</summary><p className="transport-editor-help">Välj krav för just uppdraget. Farligt avfall innebär inte automatiskt ADR-krav. Fordonets krav kontrolleras också.</p>{competencyOptions.map(([code, label]) => <label key={code}><input type="checkbox" checked={draft.requiredCompetencies?.includes(code) ?? false} onChange={event => setField('requiredCompetencies', event.target.checked ? [...draft.requiredCompetencies ?? [], code] : draft.requiredCompetencies?.filter(value => value !== code))} />{label}</label>)}</details>}
        </fieldset>

        <fieldset className="transport-duration-section">
          <legend><Clock3 size={15} /> Uppskattad tidsåtgång</legend>
          <div className="transport-editor-grid">
            <label>Timmar<select aria-label="Timmar" value={hours} onChange={(event) => {
              const nextHours = Number(event.target.value);
              setField('durationMinutes', nextHours * 60 + (nextHours === 8 ? 0 : minutes));
            }}>{Array.from({ length: 9 }, (_, hour) => <option key={hour} value={hour}>{hour} tim</option>)}</select></label>
            <label>Minuter<select aria-label="Minuter" value={minutes} disabled={hours === 8} onChange={(event) => setField('durationMinutes', hours * 60 + Number(event.target.value))}>{[0, 15, 30, 45].map((minute) => <option key={minute} value={minute}>{minute} min</option>)}</select></label>
          </div>
          <p className="transport-editor-help">{durationLabel(draft.durationMinutes)} · används som uppdragets längd i planeraren.</p>
        </fieldset>

        <fieldset>
          <legend><CalendarDays size={15} /> Bokning</legend>
          {mode !== 'book' && (!order || order.status === 'unbooked') && <label className="transport-book-switch"><input type="checkbox" checked={booked} onChange={(event) => setBooked(event.target.checked)} /> Planera preliminär bokning</label>}
          {booked ? <>
            <div className="transport-editor-grid">
              <label>Datum<input type="date" required value={date} onChange={(event) => setDate(event.target.value)} /></label>
              <label>Starttid<input type="time" required step={900} value={start} onChange={(event) => setStart(event.target.value)} /></label>
            </div>
            <label>Förare<select required value={driverId} onChange={(event) => {
              setDriverId(event.target.value);
              const driver = data.drivers.find((entry) => entry.id === event.target.value);
              if (driver) setVehicleId(driver.vehicleId);
              if (error) onError('');
            }}><option value="">Välj förare</option>{data.drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}</select></label>
            {person && <p className="transport-editor-help">{person.kind === 'external' ? `Extern förare · ${company?.name ?? 'Åkeri'}` : `${person.name} · ${person.team || 'Personal'}`}</p>}
            <label>Fordon<select required value={vehicleId} onChange={(event) => {
              setVehicleId(event.target.value);
              if (error) onError('');
            }}><option value="">Välj fordon</option>{data.vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.registration} · {vehicle.name}</option>)}</select></label>
            {Number.isFinite(startMinute) && <p className="transport-editor-booking-summary"><Clock3 size={14} /> {start}–{timeLabel(startMinute + draft.durationMinutes)} · {durationLabel(draft.durationMinutes)}</p>}
            {bookingIssues.length > 0 && <div className="transport-personnel-validation" role="status"><AlertCircle size={16} /><div>{bookingIssues.map(issue => <p key={issue}>{issue}</p>)}</div></div>}
            {(!order || order.status === 'unbooked' || order.preliminary) && <p className="transport-editor-help">Bokningen visas preliminärt i kalendern. Verkställ med knappen ovanför arbetsytan.</p>}
          </> : <>
            <label>Önskad dag <span className="transport-optional">valfritt</span><input type="date" value={draft.requestedDate ?? ''} onChange={(event) => setField('requestedDate', event.target.value || undefined)} /></label>
            <p className="transport-editor-help">Önskad dag är ett önskemål. Arbetet hamnar i Obokade tills planeringen har verkställts.</p>
          </>}
          {mode === 'create' && <>
            <label>Återkommande<select value={repeat} onChange={(event) => setRepeat(event.target.value as Repeat)}><option value="none">Engångsuppdrag</option><option value="weekly">Varje vecka</option><option value="biweekly">Varannan vecka</option></select></label>
            {repeat !== 'none' && <p className="transport-editor-help">De första fyra tillfällena skapas. Varje tillfälle får en egen arbetsorder.</p>}
          </>}
          {mode === 'edit' && order?.seriesId && <label>Ändringen gäller<select value={scope} onChange={(event) => setScope(event.target.value as Scope)}><option value="one">Bara detta tillfälle</option><option value="series">Detta och kommande tillfällen i serien</option></select></label>}
        </fieldset>
      </form>
      <footer className="transport-editor-footer">
        {error && <div className="transport-editor-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
        <div>
          <button type="button" className="transport-editor-cancel" onClick={onCancel}>Avbryt</button>
          <button type="submit" form={formId} className="transport-editor-save" disabled={finding}>{submitLabel}</button>
        </div>
      </footer>
    </section>
  );
}

export { TransportOrderEditor };
