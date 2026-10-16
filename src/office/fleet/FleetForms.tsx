import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Dialog, Field } from '../personnel/components/Ui';
import type { FleetRunner } from './useFleet';
import type { FleetIssue, FleetProfile, FleetService, FleetSite, FleetState } from './types';
import type { FleetScope } from './client';
import { FleetApiError } from './client';
import type { TransportVehicle } from '../transport/types';
import { FleetPhotoPicker } from './FleetFiles';
import { issueStatusLabels, severityLabels, stockholmInstant, vehicleLabel } from './format';

export type FleetModalSelection = { kind: 'profile' | 'service' | 'issue' | 'block' | 'inspection' | 'driver'; vehicleId: string; serviceId?: string; issueId?: string; expectedRevision?: number };
const optionalNumber = (form: FormData, key: string) => { const value = String(form.get(key) ?? '').trim(); return value ? Number(value.replace(',', '.')) : undefined; };
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const localDateTime = (value?: string) => value ? new Date(value).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).slice(0, 16).replace(' ', 'T') : '';

function FormBox({ title, description, children, onClose, onSave, label = 'Spara', disabled = false }: {
  title: string; description?: string; children: ReactNode; onClose: () => void; onSave: (data: FormData) => Promise<unknown>; label?: string; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending.current || disabled) return; pending.current = true; setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try { await onSave(form); if (mounted.current) onClose(); }
    catch (reason) { if (mounted.current) setError((reason instanceof Error ? reason.message : 'Uppgifterna kunde inte sparas.') + (reason instanceof FleetApiError && reason.status === 409 ? ' Stäng formuläret och öppna det på nytt för att läsa aktuella uppgifter.' : '')); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <div className="fleet-dialog"><Dialog title={title} description={description} onClose={() => { if (!pending.current && !disabled) onClose(); }}><form onSubmit={submit}><fieldset className="fleet-form-fields" disabled={busy}><div className="hr-form-grid">{children}</div></fieldset>{error && <Alert tone="red">{error}</Alert>}<div className="hr-dialog-actions"><button type="button" className="office-btn outline" disabled={busy || disabled} onClick={onClose}>Avbryt</button><button className="office-btn" disabled={busy || disabled}>{busy ? 'Sparar…' : label}</button></div></form></Dialog></div>;
}

function ProfileForm({ state, vehicle, sites, scope, run, onClose }: { state: FleetState; vehicle: TransportVehicle; sites: FleetSite[]; scope: FleetScope; run: FleetRunner; onClose: () => void }) {
  const profile = state.profiles[vehicle.id] ?? {}, maintenance = profile.maintenance ?? {};
  const [photos, setPhotos] = useState(profile.photoUrl ? [profile.photoUrl] : []), [uploading, setUploading] = useState(false);
  return <FormBox title="Fordonsprofil" description={`${vehicleLabel(vehicle)} · ${vehicle.name}`} onClose={onClose} disabled={uploading} label="Spara fordonsprofil" onSave={async form => {
    const odometerKm = optionalNumber(form, 'odometerKm');
    const next: Pick<FleetProfile, 'siteId' | 'defaultDriverId' | 'odometerKm' | 'odometerSource' | 'photoUrl' | 'notes' | 'operatingHours' | 'maintenance'> = {
      siteId: text(form, 'siteId') || undefined, defaultDriverId: text(form, 'defaultDriverId') || null, notes: text(form, 'notes'), photoUrl: photos[0] ?? '',
      ...(odometerKm === undefined ? {} : { odometerKm, odometerSource: odometerKm === profile.odometerKm ? profile.odometerSource ?? 'manual' : 'manual' }),
      ...(optionalNumber(form, 'operatingHours') === undefined ? {} : { operatingHours: optionalNumber(form, 'operatingHours') }),
      maintenance: Object.fromEntries(['intervalKm', 'intervalHours', 'intervalMonths', 'lastServiceKm', 'lastServiceHours'].map(key => [key, optionalNumber(form, key)]).filter(([, value]) => value !== undefined)),
    };
    if (text(form, 'lastServiceDate')) next.maintenance!.lastServiceDate = text(form, 'lastServiceDate');
    return run({ action: 'profile.save', vehicleId: vehicle.id, profile: next });
  }}>
    <Field label="Anläggning *"><select name="siteId" defaultValue={profile.siteId ?? ''} required><option value="">Välj anläggning</option>{sites.filter(site => site.active !== false || site.id === profile.siteId).map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></Field>
    <Field label="Standardförare"><select name="defaultDriverId" defaultValue={profile.defaultDriverId ?? ''}><option value="">Ingen standardförare</option>{state.people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select><small>Gäller framtida resor. Historiken ändras inte.</small></Field>
    <Field label="Mätarställning (km)"><input name="odometerKm" type="number" min="0" step="0.1" defaultValue={profile.odometerKm} placeholder="Ej registrerat" /><small>En ändrad avläsning registreras som manuell.</small></Field>
    <Field label="Drifttimmar"><input name="operatingHours" type="number" min="0" step="0.1" defaultValue={profile.operatingHours} placeholder="Ej registrerat" /></Field>
    <div className="full"><h3>Fordonsfoto</h3><FleetPhotoPicker scope={scope} vehicleId={vehicle.id} urls={photos} onChange={setPhotos} onBusyChange={setUploading} /></div>
    <div className="full fleet-form-divider"><h3>Serviceintervall</h3><p>Första uppnådda datum- eller mätargränsen gäller. Tomma intervall innebär ingen bevakning.</p></div>
    <Field label="Intervall (km)"><input name="intervalKm" type="number" min="1" step="1" defaultValue={maintenance.intervalKm} /></Field>
    <Field label="Intervall (drifttimmar)"><input name="intervalHours" type="number" min="1" step="0.1" defaultValue={maintenance.intervalHours} /></Field>
    <Field label="Intervall (månader)"><input name="intervalMonths" type="number" min="1" step="1" defaultValue={maintenance.intervalMonths} /></Field>
    <Field label="Senaste service, datum"><input name="lastServiceDate" type="date" defaultValue={maintenance.lastServiceDate} /></Field>
    <Field label="Senaste service, km"><input name="lastServiceKm" type="number" min="0" step="0.1" defaultValue={maintenance.lastServiceKm} /></Field>
    <Field label="Senaste service, drifttimmar"><input name="lastServiceHours" type="number" min="0" step="0.1" defaultValue={maintenance.lastServiceHours} /></Field>
    <Field label="Anteckning" full><textarea name="notes" defaultValue={profile.notes} maxLength={2000} /></Field>
  </FormBox>;
}

function ServiceForm({ service, state, vehicle, run, onClose }: { service?: FleetService; state: FleetState; vehicle: TransportVehicle; run: FleetRunner; onClose: () => void }) {
  return <FormBox title={service ? 'Hantera service & besiktning' : 'Planera åtgärd'} description={vehicleLabel(vehicle)} onClose={onClose} label="Spara åtgärd" onSave={form => {
    const input: Extract<Parameters<FleetRunner>[0], { action: 'service.save' }>['service'] = { ...(service ? { id: service.id } : {}), vehicleId: text(form, 'vehicleId'), title: text(form, 'title'), status: text(form, 'status') as FleetService['status'], workshop: text(form, 'workshop'),
      ...(text(form, 'dueDate') ? { dueDate: text(form, 'dueDate') } : {}), ...(optionalNumber(form, 'dueKm') === undefined ? {} : { dueKm: optionalNumber(form, 'dueKm') }), ...(optionalNumber(form, 'dueHours') === undefined ? {} : { dueHours: optionalNumber(form, 'dueHours') }),
      ...(text(form, 'startAt') ? { startAt: stockholmInstant(text(form, 'startAt'), service?.startAt) } : {}), ...(text(form, 'endAt') ? { endAt: stockholmInstant(text(form, 'endAt'), service?.endAt) } : {}), ...(optionalNumber(form, 'cost') === undefined ? {} : { cost: optionalNumber(form, 'cost') }),
      documentRefs: text(form, 'documentRefs').split('\n').map(value => value.trim()).filter(Boolean),
    };
    if (Boolean(input.startAt) !== Boolean(input.endAt)) throw new Error('Ange både start och slut för en verkstadsbokning.');
    if (input.startAt && input.endAt && input.endAt <= input.startAt) throw new Error('Verkstadsbokningens sluttid ska vara efter starttiden.');
    return run({ action: 'service.save', service: input });
  }}>
    <Field label="Fordon *"><select name="vehicleId" defaultValue={vehicle.id} required disabled={Boolean(service)}>{state.vehicles.map(value => <option key={value.id} value={value.id}>{vehicleLabel(value)} · {value.name}</option>)}</select>{service && <input type="hidden" name="vehicleId" value={vehicle.id} />}</Field>
    <Field label="Åtgärd *"><input name="title" required maxLength={200} defaultValue={service?.title} placeholder="T.ex. kontrollbesiktning" /></Field>
    <Field label="Senast datum"><input name="dueDate" type="date" defaultValue={service?.dueDate} /></Field>
    <Field label="Senast mätarställning (km)"><input name="dueKm" type="number" min="0" step="0.1" defaultValue={service?.dueKm} /></Field>
    <Field label="Senast drifttimmar"><input name="dueHours" type="number" min="0" step="0.1" defaultValue={service?.dueHours} /></Field>
    <Field label="Verkstad"><input name="workshop" defaultValue={service?.workshop} maxLength={200} /></Field>
    <Field label="Bokad från"><input name="startAt" type="datetime-local" defaultValue={localDateTime(service?.startAt)} /><small>Svensk tid.</small></Field>
    <Field label="Bokad till"><input name="endAt" type="datetime-local" defaultValue={localDateTime(service?.endAt)} /></Field>
    <Field label="Status"><select name="status" defaultValue={service?.status ?? 'planned'}><option value="planned">Planerad</option><option value="completed">Utförd</option></select></Field>
    <Field label="Kostnad (kr)"><input name="cost" type="number" min="0" step="0.01" defaultValue={service?.cost} /></Field>
    <Field label="Dokumentreferenser" full><textarea name="documentRefs" defaultValue={service?.documentRefs?.join('\n')} placeholder="En befintlig dokumentreferens per rad" maxLength={6000} /><small>Filer laddas upp under fordonets Dokument.</small></Field>
    <div className="full"><Alert>En bokad kontrollbesiktning är inte ett godkänt besiktningsresultat. En driftspärr hävs separat.</Alert></div>
  </FormBox>;
}

function IssueForm({ issue, vehicle, scope, run, onClose }: { issue?: FleetIssue; vehicle: TransportVehicle; scope: FleetScope; run: FleetRunner; onClose: () => void }) {
  const [photos, setPhotos] = useState(issue?.photoUrls ?? []), [uploading, setUploading] = useState(false);
  return <FormBox title={issue ? 'Hantera felanmälan' : 'Rapportera fel'} description={vehicleLabel(vehicle)} onClose={onClose} disabled={uploading} label="Spara felanmälan" onSave={form => run({ action: 'issue.save', issue: { ...(issue ? { id: issue.id } : {}), vehicleId: vehicle.id, title: text(form, 'title'), description: text(form, 'description'), severity: text(form, 'severity') as FleetIssue['severity'], status: text(form, 'status') as FleetIssue['status'], photoUrls: photos } })}>
    <Field label="Rubrik *" full><input name="title" required maxLength={200} defaultValue={issue?.title} /></Field>
    <Field label="Beskrivning" full><textarea name="description" defaultValue={issue?.description} maxLength={2000} /></Field>
    <Field label="Prioritet"><select name="severity" defaultValue={issue?.severity ?? 'medium'}>{Object.entries(severityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
    <Field label="Status"><select name="status" defaultValue={issue?.status ?? 'open'}>{Object.entries(issueStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
    <div className="full"><h3>Foton</h3><FleetPhotoPicker scope={scope} vehicleId={vehicle.id} urls={photos} onChange={setPhotos} multiple onBusyChange={setUploading} /></div>
    <div className="full"><Alert>Felanmälan och driftspärr hanteras separat. Ett åtgärdat fel tar inte fordonet i drift automatiskt.</Alert></div>
  </FormBox>;
}

function InspectionForm({ vehicle, scope, run, onClose }: { vehicle: TransportVehicle; scope: FleetScope; run: FleetRunner; onClose: () => void }) {
  const [checks, setChecks] = useState<{ key: string; label: string; ok: boolean | null }[]>([
    { key: 'visible', label: 'Synliga skador och läckage', ok: null }, { key: 'wheels', label: 'Däck och hjul', ok: null }, { key: 'lights', label: 'Belysning och sikt', ok: null },
  ]), [photos, setPhotos] = useState<string[]>([]), [uploading, setUploading] = useState(false);
  return <FormBox title="Registrera fordonskontroll" description={vehicleLabel(vehicle)} onClose={onClose} disabled={uploading} label="Spara fordonskontroll" onSave={form => {
    if (checks.some(check => check.ok === null)) throw new Error('Ange resultat för varje kontrollpunkt.');
    return run({ action: 'inspection.save', vehicleId: vehicle.id, checks: checks.map(check => ({ ...check, ok: check.ok === true })), comment: text(form, 'comment'), photoUrls: photos });
  }}>
    <div className="full fleet-checklist">{checks.map((check, index) => <div key={check.key}><strong>{check.label}</strong><div>{[true, false].map(ok => <label key={String(ok)}><input type="radio" name={`check-${check.key}`} checked={check.ok === ok} onChange={() => setChecks(previous => previous.map((value, i) => i === index ? { ...value, ok } : value))} />{ok ? 'Utan anmärkning' : 'Anmärkning'}</label>)}</div></div>)}</div>
    <Field label="Kommentar" full><textarea name="comment" maxLength={2000} /></Field>
    <div className="full"><FleetPhotoPicker scope={scope} vehicleId={vehicle.id} urls={photos} onChange={setPhotos} multiple onBusyChange={setUploading} /></div>
    <div className="full"><Alert>Detta är en fordonskontroll. Kontrollbesiktning och driftspärr har egna registreringar.</Alert></div>
  </FormBox>;
}

export default function FleetForms({ selection, state, scope, sites, run, onClose }: { selection: FleetModalSelection; state: FleetState; scope: FleetScope; sites: FleetSite[]; run: FleetRunner; onClose: () => void }) {
  const vehicle = state.vehicles.find(value => value.id === selection.vehicleId);
  if (!vehicle) return null;
  if (selection.kind === 'profile') return <ProfileForm state={state} vehicle={vehicle} scope={scope} sites={sites} run={run} onClose={onClose} />;
  if (selection.kind === 'service') return <ServiceForm state={state} vehicle={vehicle} service={state.services.find(value => value.id === selection.serviceId)} run={run} onClose={onClose} />;
  if (selection.kind === 'issue') return <IssueForm vehicle={vehicle} issue={state.issues.find(value => value.id === selection.issueId)} scope={scope} run={run} onClose={onClose} />;
  if (selection.kind === 'inspection') return <InspectionForm vehicle={vehicle} scope={scope} run={run} onClose={onClose} />;
  if (selection.kind === 'block') {
    const blocked = state.profiles[vehicle.id]?.blocked === true;
    return <FormBox title={blocked ? 'Häv driftspärr' : 'Driftspärra fordon'} description={vehicleLabel(vehicle)} onClose={onClose} label={blocked ? 'Bekräfta hävning' : 'Bekräfta driftspärr'} onSave={form => run({ action: 'vehicle.block', vehicleId: vehicle.id, blocked: !blocked, reason: text(form, 'reason') })}>
      <div className="full"><Alert tone={blocked ? 'orange' : 'red'}>{blocked ? 'Bekräfta att fordonet får tas i bruk. Service eller ett åtgärdat fel häver inte spärren automatiskt.' : 'Fordonet stoppas för nya tilldelningar. Befintlig historik behålls.'}</Alert></div>
      <Field label="Anledning *" full><textarea name="reason" required minLength={3} maxLength={1000} defaultValue="" /></Field>
    </FormBox>;
  }
  return <FormBox title="Förare för nästa resa" description={vehicleLabel(vehicle)} onClose={onClose} label="Spara förarval" onSave={form => run({ action: 'driver.select', vehicleId: vehicle.id, personId: text(form, 'personId') })}><Field label="Förare *" full><select name="personId" defaultValue={state.profiles[vehicle.id]?.nextDriver?.personId ?? ''} required><option value="">Välj förare</option>{state.people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field><div className="full"><Alert>Gäller nästa resa. Därefter används standardföraren igen. Historiska resor ändras inte.</Alert></div></FormBox>;
}
