import { useEffect, useRef, useState } from 'react';
import { Building2, Plus, Save } from 'lucide-react';
import type { OfficeUser } from './model';
import { environmentApi, EnvironmentApiError } from './environment-client';
import { EnvironmentAccessBoundary, environmentFailure, hasEnvironmentPermission, useEnvironmentSession } from './EnvironmentSession';
import type { EnvironmentSite } from './environment-types';
import StoragePolicyPanel from './StoragePolicyPanel';
import './environment.css';
import './storage.css';

const newSite = (name = ''): EnvironmentSite => ({ id: `${name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0,40) || 'anlaggning'}-${crypto.randomUUID().slice(0,8)}`, name, address: '', postalCode: '', city: '', municipalityCode: '', active: true, version: 0, permitReference: '', permitNotes: '' });

function FacilityEditor({ site, user, actualUser, onSaved, onNotice }: {
  site: EnvironmentSite; user: OfficeUser; actualUser: OfficeUser; onSaved: (site: EnvironmentSite) => void; onNotice: (message: string) => void;
}) {
  const { state, refresh } = useEnvironmentSession();
  const [draft, setDraft] = useState(site);
  const [dirty, setDirty] = useState(site.version === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const identity = `${actualUser.id}/${user.id}/${site.id}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const editable = hasEnvironmentPermission(user, 'environmentStorage');
  useEffect(() => { setDraft(site); setDirty(site.version === 0); setError(''); setConflict(false); setBusy(false); }, [identity]);
  useEffect(() => { if (!dirty) setDraft(site); }, [site, dirty]);
  const change = (value: Partial<EnvironmentSite>) => { setDraft(current => ({ ...current, ...value })); setDirty(true); setError(''); };
  async function save() {
    if (!editable || busy || conflict) return;
    const postalCode = draft.postalCode.replace(/\s/g, '');
    const municipalityCode = draft.municipalityCode.trim();
    const isNew = site.version === 0;
    if (!draft.name.trim() || (isNew && (!draft.address.trim() || !postalCode || !draft.city.trim() || !municipalityCode)) ||
      (postalCode && !/^\d{5}$/.test(postalCode)) || (municipalityCode && !state?.municipalities.some(municipality => municipality.code === municipalityCode))) {
      setError('Ange namn, gatuadress, femsiffrigt postnummer, ort och fyrsiffrig kommunkod.'); return;
    }
    const expectedIdentity = identity; setBusy(true); setError('');
    try {
      const saved = await environmentApi.saveSite(site.id, { expectedVersion: draft.version ?? 0, name: draft.name.trim(), address: draft.address.trim(), postalCode, city: draft.city.trim(), municipalityCode, active: draft.active, permitReference: draft.permitReference.trim(), permitNotes: draft.permitNotes.trim() });
      if (identityRef.current !== expectedIdentity) return;
      setDraft(saved); setDirty(false); await refresh();
      if (identityRef.current === expectedIdentity) { onSaved(saved); onNotice('Anläggningen är sparad. Tillståndsreferens och lagringsregler hanteras separat.'); }
    } catch (failure) {
      if (identityRef.current !== expectedIdentity) return;
      if (failure instanceof EnvironmentApiError && failure.status === 409) { setConflict(true); setError('Anläggningen ändrades av någon annan. Ditt utkast finns kvar. Hämta senaste versionen innan du sparar.'); await refresh().catch(() => undefined); }
      else setError(environmentFailure(failure));
    } finally { if (identityRef.current === expectedIdentity) setBusy(false); }
  }
  return <section className="office-panel environment-panel facility-editor" aria-label={`Anläggningsuppgifter för ${site.name || 'ny anläggning'}`}>
    <header className="environment-heading"><span className="environment-icon"><Building2 size={21} /></span><div><h2>{site.version ? 'Anläggningsuppgifter' : 'Ny anläggning'}</h2><p>Adress, tillståndsreferens och verksamhetens egna noteringar.</p></div>{site.version > 0 && <span className="environment-pill">Version {site.version}</span>}</header>
    <div className="environment-form-grid"><label className="environment-full">Namn *<input aria-label="Anläggningsnamn" disabled={!editable || busy} value={draft.name} maxLength={150} onChange={event => change({ name: event.target.value })} /></label><label className="environment-full">Gatuadress {site.version === 0 && '*'}<input aria-label="Anläggningens gatuadress" disabled={!editable || busy} value={draft.address} maxLength={300} onChange={event => change({ address: event.target.value })} /></label><label>Postnummer {site.version === 0 && '*'}<input aria-label="Anläggningens postnummer" disabled={!editable || busy} value={draft.postalCode} inputMode="numeric" maxLength={6} onChange={event => change({ postalCode: event.target.value })} /></label><label>Ort {site.version === 0 && '*'}<input aria-label="Anläggningens ort" disabled={!editable || busy} value={draft.city} maxLength={150} onChange={event => change({ city: event.target.value })} /></label><label>Kommunkod {site.version === 0 && '*'}<input aria-label="Anläggningens kommunkod" list={`facility-municipalities-${site.id}`} disabled={!editable || busy} value={draft.municipalityCode} inputMode="numeric" maxLength={4} onChange={event => change({ municipalityCode: event.target.value })} /></label><label>Tillståndsreferens<input aria-label="Tillståndsreferens" disabled={!editable || busy} value={draft.permitReference} maxLength={300} placeholder="Beslut, diarienummer eller egen referens" onChange={event => change({ permitReference: event.target.value })} /></label><label className="environment-full">Tillstånd & noteringar<textarea aria-label="Tillstånd och noteringar" disabled={!editable || busy} value={draft.permitNotes} maxLength={4000} rows={3} placeholder="Beskriv beslutets omfattning och villkor" onChange={event => change({ permitNotes: event.target.value })} /></label></div>
    <datalist id={`facility-municipalities-${site.id}`}>{(state?.municipalities ?? []).map(municipality => <option key={municipality.code} value={municipality.code}>{municipality.name}</option>)}</datalist>
    <label className="environment-checkbox"><input type="checkbox" disabled={!editable || busy} checked={draft.active} onChange={event => change({ active: event.target.checked })} />Anläggningen är aktiv</label>
    {site.version > 0 && (!draft.address.trim() || !draft.postalCode || !draft.city.trim() || !draft.municipalityCode) && <p className="environment-muted">Adressuppgifter saknas. Komplettera dem innan anläggningen används för miljömottagning.</p>}
    <div className="environment-info">En sparad tillståndsreferens innebär inte att systemet har verifierat tillståndet. Ange tillåtna avfallskoder och mängdgränser enligt det faktiska beslutet nedan.</div>
    {error && <div className="environment-error" role="alert">{error}</div>}
    <div className="environment-actions"><small>Ändringar sparas med version och ansvarig användare.</small><div className="environment-action-buttons">{(dirty || conflict) && site.version > 0 && <button type="button" className="office-btn outline" disabled={busy} onClick={() => { setDraft(site); setDirty(false); setError(''); setConflict(false); }}>{conflict ? 'Hämta senaste version' : 'Återställ utkast'}</button>}{editable && <button type="button" className="office-btn" disabled={busy || !dirty || conflict} onClick={() => void save()}><Save size={14} />{busy ? 'Sparar…' : 'Spara anläggning'}</button>}</div></div>
  </section>;
}

export default function FacilitiesWorkspace({ user, actualUser, onNotice }: {
  user: OfficeUser; actualUser: OfficeUser; onNotice: (message: string) => void;
}) {
  const { state } = useEnvironmentSession();
  const [selectedId, setSelectedId] = useState('');
  const [created, setCreated] = useState<EnvironmentSite>();
  useEffect(() => { setSelectedId(''); setCreated(undefined); }, [user.id, actualUser.id]);
  const sites = state?.sites ?? [];
  const selected = sites.find(site => site.id === selectedId) ?? created ?? sites[0];
  const editable = hasEnvironmentPermission(user, 'environmentStorage');
  const canCreate = editable && user.siteIds === undefined;
  return <section className="environment-workspace facilities-workspace"><div className="office-title environment-workspace-title"><div><span className="office-eyebrow">ANLÄGGNINGAR & TILLSTÅND</span><h1>Anläggningar</h1><p>Hantera mottagningsplatser, tillståndsreferenser och tillåtna lagermängder.</p></div>{canCreate && <button type="button" className="office-btn" onClick={() => { const next = newSite(); setCreated(next); setSelectedId(next.id); }}><Plus size={16} />Ny anläggning</button>}</div><EnvironmentAccessBoundary><div className="facilities-layout"><aside className="facilities-list" aria-label="Välj anläggning">{sites.map(site => <button type="button" key={site.id} className={`facility-choice ${selected?.id === site.id ? 'selected' : ''}`} aria-pressed={selected?.id === site.id} onClick={() => { setSelectedId(site.id); setCreated(undefined); }}><strong>{site.name}</strong><small>{site.city}</small><span className={`environment-pill ${site.active ? 'success' : ''}`}>{site.active ? 'Aktiv' : 'Avaktiverad'}</span></button>)}{created && !sites.some(site => site.id === created.id) && <button type="button" className="facility-choice selected" aria-pressed="true"><strong>Ny anläggning</strong><small>Ej sparad</small></button>}</aside><div className="facilities-detail">{selected ? <><FacilityEditor key={`facility/${selected.id}`} site={selected} user={user} actualUser={actualUser} onNotice={onNotice} onSaved={site => { setCreated(undefined); setSelectedId(site.id); }} />{selected.version > 0 ? <StoragePolicyPanel key={`policy/${selected.id}`} site={selected} user={user} actualUser={actualUser} onNotice={onNotice} /> : <div className="environment-info">Spara anläggningen först för att ange lagringsregler.</div>}</> : <div className="office-panel environment-empty"><Building2 size={30} /><h2>Inga tillåtna anläggningar att visa</h2></div>}</div></div></EnvironmentAccessBoundary></section>;
}
