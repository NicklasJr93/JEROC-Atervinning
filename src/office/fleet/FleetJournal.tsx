import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Eye, FileText, LockKeyhole, Route, Search, TriangleAlert } from 'lucide-react';
import { Alert, Dialog, Fact, Field, Pill } from '../personnel/components/Ui';
import type { FleetState, FleetTrip, FleetExportFilters } from './types';
import type { FleetScope } from './client';
import { downloadFleetBlob, exportFleet, readFleet } from './client';
import type { FleetRunner } from './useFleet';
import { date, driverSourceLabels, number, time, tripComplete, vehicleLabel } from './format';

export default function FleetJournal({ state, scope, run, vehicleId, onOpenVehicle }: { state: FleetState; scope: FleetScope; run: FleetRunner; vehicleId?: string; onOpenVehicle: (id: string) => void }) {
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [selectedVehicle, setVehicle] = useState(vehicleId ?? ''), [personId, setPerson] = useState(''), [query, setQuery] = useState(''), [status, setStatus] = useState('all'), [classification, setClassification] = useState('');
  const [page, setPage] = useState(0), [selected, setSelected] = useState<string>(), [exporting, setExporting] = useState(false);
  useEffect(() => { setVehicle(vehicleId ?? ''); }, [vehicleId]);
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => { const timeout = window.setTimeout(() => setDebouncedQuery(query), 250); return () => window.clearTimeout(timeout); }, [query]);
  useEffect(() => { setPage(0); }, [from, to, selectedVehicle, personId, debouncedQuery, status, classification]);
  const exportFilters: FleetExportFilters = { from, to, vehicleId: vehicleId || selectedVehicle, personId, classification, status: status === 'all' ? undefined : status, search: debouncedQuery };
  const pageKey = JSON.stringify([scope.key, exportFilters, page]), keyRef = useRef(pageKey); keyRef.current = pageKey;
  const [paged, setPaged] = useState<{ key: string; value: FleetState }>(), [loadError, setLoadError] = useState(''), [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setLoadError('');
    void readFleet(scope, controller.signal, { ...exportFilters, offset: page * 12, limit: 12 }).then(value => { if (!controller.signal.aborted && keyRef.current === pageKey) setPaged({ key: pageKey, value }); }).catch(reason => { if (!controller.signal.aborted && keyRef.current === pageKey) { setPaged(undefined); setLoadError(reason instanceof Error ? reason.message : 'Körjournalen kunde inte hämtas.'); } }).finally(() => { if (!controller.signal.aborted && keyRef.current === pageKey) setLoading(false); });
    return () => controller.abort();
  }, [pageKey, state.revision, scope]);
  const projection = paged?.key === pageKey ? paged.value : undefined, trips = projection?.trips ?? [];
  const total = projection?.pagination?.total ?? projection?.tripCount ?? trips.length;
  const maxPage = Math.max(0, Math.ceil(total / 12) - 1), currentPage = page, detail = trips.find(trip => trip.id === selected);
  const missing = trips.filter(trip => !tripComplete(trip)).length, knownDistances = trips.filter(trip => trip.distanceKm !== undefined);
  return <div className="fleet-journal">
    <div className="fleet-section-heading"><div><h2>Körjournal</h2><p>Resor, syften och underlag på ett ställe.</p></div>{state.capabilities.export && <button className="office-btn" onClick={() => setExporting(true)}><Download size={16} /> Exportera körjournal</button>}</div>
    <div className="fleet-journal-totals"><span><Route size={19} /><strong>{total}</strong> resor i urvalet</span><span><strong>{knownDistances.length ? number(knownDistances.reduce((sum, trip) => sum + trip.distanceKm!, 0)) : trips.length ? '—' : '0'}</strong> km på sidan</span><span><TriangleAlert size={18} /><strong>{missing}</strong> ofullständiga på sidan</span></div>
    <div className="fleet-filters fleet-journal-filters"><Field label="Från datum"><input type="date" value={from} onChange={event => setFrom(event.target.value)} /></Field><Field label="Till datum"><input type="date" min={from} value={to} onChange={event => setTo(event.target.value)} /></Field>
      {!vehicleId && <Field label="Fordon"><select value={selectedVehicle} onChange={event => setVehicle(event.target.value)}><option value="">Alla fordon</option>{state.vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicleLabel(vehicle)}</option>)}</select></Field>}
      <Field label="Förare"><select value={personId} onChange={event => setPerson(event.target.value)}><option value="">Alla förare</option>{state.people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field>
      <Field label="Klassificering"><select value={classification} onChange={event => setClassification(event.target.value)}><option value="">Alla resor</option><option value="business">Tjänst</option><option value="private">Privat</option><option value="unclassified">Ej klassificerad</option></select></Field>
      <label className="fleet-search"><Search size={17} /><input aria-label="Sök i körjournal" placeholder="Sök fordon, förare eller tjänstesyfte…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    </div>
    <div className="fleet-subtabs" aria-label="Resornas status">{[['all', 'Alla'], ['incomplete', 'Ofullständiga'], ['complete', 'Klara'], ['review', 'Behöver granskas']].map(([id, label]) => <button key={id} className={status === id ? 'active' : ''} onClick={() => setStatus(id)}>{label}</button>)}</div>
    {loadError && <Alert tone="red">{loadError}</Alert>}
    <div className={`fleet-journal-layout${detail ? ' with-detail' : ''}`}><section className="office-panel fleet-panel"><div className="fleet-table-scroll"><table className="office-table fleet-table"><thead><tr><th>Datum / tid</th><th>Fordon / förare</th><th>Resa</th><th>Km</th><th>Status</th><th></th></tr></thead><tbody>{trips.map(trip => <tr key={trip.id} className={detail?.id === trip.id ? 'selected' : ''} onClick={() => setSelected(trip.id)}><td><strong>{date(trip.startAt)}</strong><small>{time(trip.startAt)}–{trip.endAt ? time(trip.endAt) : 'Pågår'}</small></td><td><strong>{vehicleLabel(state.vehicles.find(value => value.id === trip.vehicleId))}</strong><small>{state.people.find(person => person.id === trip.personId)?.name ?? 'Förare saknas'}</small></td><td>{trip.classification === 'business' ? <><strong>{trip.fromLabel || 'Startplats saknas'}</strong><small>→ {trip.toLabel || 'Slutplats saknas'}</small></> : <><strong><LockKeyhole size={13} /> {trip.classification === 'private' ? 'Privat resa' : 'Ej klassificerad'}</strong><small>Rutt skyddad</small></>}</td><td>{number(trip.distanceKm)}</td><td><Pill tone={tripComplete(trip) ? trip.classification === 'private' ? 'grey' : 'green' : 'orange'}>{tripComplete(trip) ? trip.classification === 'private' ? 'Privat' : 'Tjänst' : 'Behöver kompletteras'}</Pill>{trip.quality && trip.quality !== 'good' && <small>Teknisk granskning behövs</small>}</td><td><button className="fleet-open-row" aria-label={`Öppna resa ${date(trip.startAt)} ${time(trip.startAt)}`} onClick={event => { event.stopPropagation(); setSelected(trip.id); }}><ChevronRight size={17} /></button></td></tr>)}</tbody></table></div>{!trips.length && <div className="fleet-empty"><Route size={27} /><p>{loading ? 'Hämtar körjournal…' : 'Inga resor matchar urvalet.'}</p></div>}<div className="fleet-pagination"><span>{total ? `${currentPage * 12 + 1}–${Math.min((currentPage + 1) * 12, total)} av ${total}` : '0 resor'}</span><div><button className="office-btn outline" disabled={!currentPage || loading} aria-label="Föregående sida i körjournal" onClick={() => setPage(value => value - 1)}><ChevronLeft size={15} /></button><span>{currentPage + 1}</span><button className="office-btn outline" disabled={currentPage >= maxPage || loading} aria-label="Nästa sida i körjournal" onClick={() => setPage(value => value + 1)}><ChevronRight size={15} /></button></div></div></section>
      {detail && <TripDetail key={detail.id} trip={detail} state={state} run={run} onClose={() => setSelected(undefined)} onOpenVehicle={onOpenVehicle} />}
    </div><p className="fleet-footnote"><LockKeyhole size={14} /> Privata och oklassificerade adresser och rutter visas inte.</p>
    {exporting && <ExportDialog scope={scope} filters={exportFilters} count={total} missing={missing} partial={total > trips.length} onClose={() => setExporting(false)} />}
  </div>;
}

function TripDetail({ trip, state, run, onClose, onOpenVehicle }: { trip: FleetTrip; state: FleetState; run: FleetRunner; onClose: () => void; onOpenVehicle: (id: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), pending = useRef(false), mounted = useRef(true);
  const editedTripRevision = useRef(trip.revision);
  const [assigning, setAssigning] = useState(false), [assignedPerson, setAssignedPerson] = useState(''), [assignmentReason, setAssignmentReason] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function assign() {
    if (pending.current || !assignedPerson || assignmentReason.trim().length < 5) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await run({ action: 'trip.assign', tripId: trip.id, expectedTripRevision: editedTripRevision.current, personId: assignedPerson, reason: assignmentReason.trim() });
      if (mounted.current) setAssigning(false);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Föraren kunde inte tilldelas.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <aside className="office-panel fleet-panel fleet-trip-detail"><div className="fleet-section-heading"><h2>Resa · {vehicleLabel(state.vehicles.find(value => value.id === trip.vehicleId))}</h2><button className="fleet-open-row" aria-label="Stäng resdetaljer" onClick={onClose}>×</button></div>
    <Fact label="Datum">{date(trip.startAt)}</Fact><Fact label="Tid">{time(trip.startAt)}–{trip.endAt ? time(trip.endAt) : 'Pågår'}</Fact><Fact label="Sträcka">{number(trip.distanceKm)} km</Fact><Fact label="Förare">{state.people.find(person => person.id === trip.personId)?.name ?? 'Förare saknas'}</Fact><Fact label="Förarkälla">{trip.manualDriverAssignment ? 'Manuellt granskad förartilldelning' : driverSourceLabels[trip.driverSource]}</Fact>
    {trip.classification === 'business' ? <><Fact label="Från">{trip.fromLabel || '—'}</Fact><Fact label="Till">{trip.toLabel || '—'}</Fact></> : <p className="fleet-privacy"><LockKeyhole size={16} /> Adresser och rutt är skyddade.</p>}
    <Fact label="Mätare">{number(trip.startOdometerKm)} → {number(trip.endOdometerKm)} km</Fact><Fact label="Datakälla">{trip.source === 'simulator' ? 'Simulerad telemetri' : 'GPS-enhet'}</Fact>
    {trip.manualDriverAssignment && <p className="fleet-footnote">Förartilldelning granskad: {trip.manualDriverAssignment.reason}</p>}
    {state.capabilities.write && trip.endAt && !trip.manualDriverAssignment && (trip.driverSource === 'unknown' || trip.driverConflict) && <button className="office-btn outline" onClick={() => { setError(''); setAssigning(true); }}>Tilldela förare till resan</button>}
    {trip.quality && trip.quality !== 'good' && <Alert tone="orange">Resan har tekniska luckor och behöver granskas. Sensorvärden fylls inte i manuellt.</Alert>}
    {trip.classification === 'business' && <><Fact label="Tjänstesyfte">{trip.purpose || '—'}</Fact><Fact label="Arbetsorder">{trip.workOrderId || '—'}</Fact></>}
    {trip.personId ? !tripComplete(trip) && <Alert>Kompletteras av föraren i appen.</Alert> : <Alert tone="orange">Resan saknar förare. Ingen person tilldelas automatiskt.</Alert>}
    <button className="office-link" onClick={() => onOpenVehicle(trip.vehicleId)}>Öppna fordonskort <ChevronRight size={14} /></button>
    {assigning && <div className="fleet-dialog"><Dialog title="Bekräfta förare för resan" description={`${date(trip.startAt)} · ${time(trip.startAt)}–${time(trip.endAt)}`} onClose={() => { if (!busy) setAssigning(false); }}>
      <div className="hr-form-grid"><Field label="Förare *" full><select value={assignedPerson} disabled={busy} onChange={event => setAssignedPerson(event.target.value)}><option value="">Välj förare</option>{state.people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field><Field label="Orsak / underlag *" full><textarea value={assignmentReason} disabled={busy} minLength={5} maxLength={1000} onChange={event => setAssignmentReason(event.target.value)} placeholder="Ange vad som styrker vem som körde resan" /></Field></div>
      <Alert>Detta är en manuell granskning av den historiska resan. Ursprunglig förarkälla och ändringshistorik bevaras.</Alert>{error && <Alert tone="red">{error}</Alert>}<div className="hr-dialog-actions"><button className="office-btn outline" disabled={busy} onClick={() => setAssigning(false)}>Avbryt</button><button className="office-btn" disabled={busy || !assignedPerson || assignmentReason.trim().length < 5} onClick={() => void assign()}>{busy ? 'Sparar…' : 'Bekräfta förare'}</button></div>
    </Dialog></div>}
  </aside>;
}

function ExportDialog({ scope, filters, count, missing, partial, onClose }: { scope: FleetScope; filters: FleetExportFilters; count: number; missing: number; partial: boolean; onClose: () => void }) {
  const [format, setFormat] = useState<'pdf' | 'csv'>('pdf'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined), objectUrl = useRef<string | undefined>(undefined), mounted = useRef(true), pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }; }, [scope.key]);
  async function generate(asPreview = false) {
    if (pending.current) return; pending.current = true; setBusy(true); setError(''); const request = new AbortController(); controller.current = request;
    try { const blob = await exportFleet(scope, asPreview ? 'pdf' : format, filters, request.signal); if (!mounted.current || request.signal.aborted) return;
      if (asPreview) { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = URL.createObjectURL(blob); setPreview(objectUrl.current); }
      else downloadFleetBlob(blob, `korjournal-${filters.from || 'alla'}-${filters.to || 'datum'}.${format}`);
    } catch (reason) { if (mounted.current && !request.signal.aborted) setError(reason instanceof Error ? reason.message : 'Körjournalen kunde inte exporteras.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <div className="fleet-dialog fleet-export-dialog"><Dialog title="Exportera körjournal" description="Välj format för det aktuella urvalet." onClose={() => { if (!busy) onClose(); }}>
    <div className="fleet-export-formats">{(['pdf', 'csv'] as const).map(value => <label key={value} className={format === value ? 'active' : ''}><input type="radio" name="export-format" checked={format === value} disabled={busy} onChange={() => setFormat(value)} /><FileText size={23} /><strong>{value.toUpperCase()}</strong><small>{value === 'pdf' ? 'Läsvänligt underlag' : 'För vidare bearbetning'}</small></label>)}</div>
    <div className="fleet-export-summary"><strong>{count} resor i urvalet</strong><span>{filters.from ? date(filters.from) : 'Alla datum'}{filters.to ? `–${date(filters.to)}` : ''}</span><span>{partial ? 'Exporten omfattar hela det filtrerade urvalet, även andra sidor.' : missing ? `${missing} behöver kompletteras` : 'Servern kontrollerar om underlaget är komplett.'}</span></div>
    <Alert><LockKeyhole size={17} /> Privata adresser och rutter tas inte med. Ofullständiga resor märks som utkast.</Alert>
    {preview && <iframe title="Förhandsvisning av körjournal PDF" src={preview} className="fleet-pdf-preview" />}{error && <Alert tone="red">{error}</Alert>}
    <div className="hr-dialog-actions"><button className="office-btn outline" disabled={busy} onClick={onClose}>Avbryt</button><button className="office-btn outline" disabled={busy || !count} onClick={() => void generate(true)}><Eye size={15} /> Förhandsvisa PDF</button><button className="office-btn" disabled={busy || !count} onClick={() => void generate()}><Download size={15} />{busy ? 'Skapar fil…' : `Hämta ${format.toUpperCase()}`}</button></div>
  </Dialog></div>;
}
