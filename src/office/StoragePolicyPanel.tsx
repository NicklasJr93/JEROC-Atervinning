import { useEffect, useRef, useState } from 'react';
import { Building2, Plus, Save, Trash2 } from 'lucide-react';
import type { OfficeUser } from './model';
import { environmentApi, EnvironmentApiError } from './environment-client';
import { environmentFailure, hasEnvironmentPermission, useEnvironmentSession } from './EnvironmentSession';
import { environmentTime, environmentWeight, formatWasteCode, type EnvironmentSite } from './environment-types';
import './storage.css';

export function parseStorageLimit(value: string, label: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return null;
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized) || !Number.isFinite(Number(normalized)) || Number(normalized) > 1_000_000_000_000) {
    throw new Error(`${label}: ange 0–1 000 000 000 000 kg med högst tre decimaler, eller lämna tomt.`);
  }
  return Number(normalized);
}
export const storageLimitText = (value: number | null | undefined) => value == null ? '' : String(value).replace('.', ',');

interface RuleDraft { wasteCode: string; allowed: boolean; maxKg: string }
export default function StoragePolicyPanel({ site, user, actualUser, onNotice }: {
  site: EnvironmentSite; user: OfficeUser; actualUser: OfficeUser; onNotice: (message: string) => void;
}) {
  const { state, refresh } = useEnvironmentSession();
  const saved = state?.storagePolicies?.find(policy => policy.siteId === site.id);
  const [total, setTotal] = useState('');
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [expectedVersion, setExpectedVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const identity = `${actualUser.id}/${user.id}/${site.id}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const editable = hasEnvironmentPermission(user, 'environmentStorage');
  const load = () => {
    setTotal(storageLimitText(saved?.totalMaxKg));
    setRules((saved?.rules ?? []).map(rule => ({ ...rule, maxKg: storageLimitText(rule.maxKg) })));
    setExpectedVersion(saved?.version ?? 0); setDirty(false); setError(''); setConflict(false);
  };
  useEffect(() => { load(); setBusy(false); }, [identity]);
  useEffect(() => { if (!dirty) load(); }, [saved, dirty]);
  const change = () => { setDirty(true); setError(''); };
  const inventory = (state?.inventory ?? []).filter(item => item.siteId === site.id);
  const registeredKg = inventory.reduce((sum, item) => sum + item.weight, 0);
  const knownCodes = [...new Set((state?.classifications ?? []).map(item => item.wasteCode).filter(Boolean))].sort();
  async function save() {
    if (!editable || busy || conflict) return;
    let totalMaxKg: number | null;
    let nextRules: { wasteCode: string; allowed: boolean; maxKg: number | null }[];
    try {
      totalMaxKg = parseStorageLimit(total, 'Max registrerat lager');
      const codes = new Set<string>();
      nextRules = rules.map(rule => {
        const wasteCode = rule.wasteCode.replace(/\D/g, '');
        if (!/^\d{6}$/.test(wasteCode)) throw new Error('Ange en sexsiffrig avfallskod på varje rad.');
        if (codes.has(wasteCode)) throw new Error(`Avfallskod ${formatWasteCode(wasteCode, false)} finns på flera rader.`);
        codes.add(wasteCode);
        return { wasteCode, allowed: rule.allowed, maxKg: rule.allowed ? parseStorageLimit(rule.maxKg, `Max lager för ${formatWasteCode(wasteCode, false)}`) : null };
      });
    } catch (failure) { setError(environmentFailure(failure)); return; }
    const expectedIdentity = identity; setBusy(true); setError('');
    try {
      await environmentApi.saveStoragePolicy(site.id, { expectedVersion, totalMaxKg, rules: nextRules });
      if (identityRef.current !== expectedIdentity) return;
      setDirty(false); await refresh();
      if (identityRef.current === expectedIdentity) onNotice('Anläggningens lagringsregler är sparade. Befintliga mottagningsversioner bevaras.');
    } catch (failure) {
      if (identityRef.current !== expectedIdentity) return;
      if (failure instanceof EnvironmentApiError && failure.status === 409) {
        setConflict(true); setError('Lagringsreglerna ändrades av någon annan. Ditt utkast finns kvar. Hämta den senaste versionen innan du sparar igen.');
        await refresh().catch(() => undefined);
      } else setError(environmentFailure(failure));
    } finally { if (identityRef.current === expectedIdentity) setBusy(false); }
  }
  return <section className="office-panel environment-panel storage-policy-panel" aria-label={`Lagringsregler för ${site.name}`}>
    <header className="environment-heading"><span className="environment-icon"><Building2 size={21} /></span><div><h2>Lagringsregler & mängdgränser</h2><p>Gränser för anläggningens registrerade lager, gemensamt för artiklar med samma avfallskod.</p></div>{saved && <span className="environment-pill">Version {saved.version}</span>}</header>
    {!saved && <div className="environment-info">Lagringsregler är inte angivna. Inget tillstånd eller någon mängdgräns är bekräftad av systemet.</div>}
    {!site.active && <p className="environment-muted">Anläggningen är avaktiverad och kan inte ta emot nytt material. Reglerna kan förberedas inför återaktivering.</p>}
    <div className="storage-total"><label>Max registrerat lager (kg)<input aria-label="Max registrerat lager (kg)" inputMode="decimal" disabled={!editable || busy} placeholder="Ingen angiven mängdgräns" value={total} onChange={event => { setTotal(event.target.value); change(); }} /><small>Tomt = mängdgräns saknas. 0 = ingen lagring tillåten.</small></label><div><small>Registrerat lager</small><strong>{environmentWeight(registeredKg)}</strong></div></div>
    <div className="storage-policy-rules"><div className="storage-policy-header"><span>Avfallskod</span><span>Tillåten</span><span>Max lager (kg)</span><span /></div>{rules.map((rule, index) => {
      const currentKg = inventory.filter(item => item.wasteCode === rule.wasteCode.replace(/\D/g, '')).reduce((sum, item) => sum + item.weight, 0);
      return <div className="storage-policy-rule" key={index}><label><span className="storage-mobile-label">Avfallskod</span><input aria-label={`Avfallskod rad ${index + 1}`} disabled={!editable || busy} inputMode="numeric" list={`storage-codes-${site.id}`} maxLength={12} placeholder="16 06 01" value={rule.wasteCode} onChange={event => { setRules(current => current.map((item, at) => at === index ? { ...item, wasteCode: event.target.value } : item)); change(); }} /><small>Registrerat: {environmentWeight(currentKg)}</small></label><label className="environment-checkbox"><input type="checkbox" aria-label={`Tillåt avfallskod rad ${index + 1}`} disabled={!editable || busy} checked={rule.allowed} onChange={event => { setRules(current => current.map((item, at) => at === index ? { ...item, allowed: event.target.checked } : item)); change(); }} /><span>{rule.allowed ? 'Tillåten' : 'Ej tillåten'}</span></label><label><span className="storage-mobile-label">Max lager (kg)</span><input aria-label={`Max lager rad ${index + 1}`} disabled={!editable || busy || !rule.allowed} inputMode="decimal" value={rule.maxKg} placeholder="Ingen angiven gräns" onChange={event => { setRules(current => current.map((item, at) => at === index ? { ...item, maxKg: event.target.value } : item)); change(); }} /></label>{editable && <button type="button" className="environment-toggle" disabled={busy} aria-label={`Ta bort avfallskod rad ${index + 1}`} onClick={() => { setRules(current => current.filter((_, at) => at !== index)); change(); }}><Trash2 size={16} /></button>}</div>;
    })}</div>
    <datalist id={`storage-codes-${site.id}`}>{knownCodes.map(code => <option key={code} value={code} />)}</datalist>
    {!rules.length && <p className="environment-muted">Inga avfallskoder angivna. Om du sparar denna lista tillåts inga avfallskoder på anläggningen.</p>}
    <p className="environment-muted">Enskilda artiklars platsval anges under <a className="office-link" href="#/prices">Artiklar & priser</a>. Den strängaste artikel- eller anläggningsgränsen gäller.</p>
    {editable && <button type="button" className="office-link storage-add-rule" disabled={busy} onClick={() => { setRules(current => [...current, { wasteCode: '', allowed: false, maxKg: '' }]); change(); }}><Plus size={14} />Lägg till avfallskod</button>}
    {error && <div className="environment-error" role="alert">{error}</div>}
    <div className="environment-actions"><small>{saved ? `Sparat ${environmentTime(saved.updatedAt)} · ${saved.updatedBy}` : 'Ange regler enligt anläggningens faktiska tillstånd.'}</small><div className="environment-action-buttons">{(dirty || conflict) && <button type="button" className="office-btn outline" disabled={busy} onClick={load}>{conflict ? 'Hämta senaste version' : 'Återställ utkast'}</button>}{editable && <button type="button" className="office-btn" disabled={busy || !dirty || conflict} onClick={() => void save()}><Save size={14} />{busy ? 'Sparar…' : 'Spara lagringsregler'}</button>}</div></div>
    <div className="environment-info">Kontrollen utgår från registrerade lagerrörelser. Utleveranser och lageravdrag byggs i nästa etapp; mängden är ännu inte ett fullständigt fysiskt lagersaldo.</div>
  </section>;
}
