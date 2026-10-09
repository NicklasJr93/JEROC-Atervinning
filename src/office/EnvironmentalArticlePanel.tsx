import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Leaf, Save, ShieldAlert } from 'lucide-react';
import type { OfficeUser } from './model';
import { environmentApi, EnvironmentApiError } from './environment-client';
import { emptyClassification, environmentWeight, formatWasteCode } from './environment-types';
import { parseStorageLimit, storageLimitText } from './StoragePolicyPanel';
import { EnvironmentAccessBoundary, environmentFailure, hasEnvironmentPermission, useEnvironmentSession } from './EnvironmentSession';
import './environment.css';
import './storage.css';

export default function EnvironmentalArticlePanel({ articleId, articleName, user, actualUser, onNotice }: { articleId: string; articleName: string; user: OfficeUser; actualUser: OfficeUser; onNotice: (message: string) => void }) {
  const { state, refresh } = useEnvironmentSession();
  const saved = state?.classifications.find(item => item.articleId === articleId);
  const [draft, setDraft] = useState(() => emptyClassification(articleId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [storageLimits, setStorageLimits] = useState<Record<string, string>>({});
  const identity = `${articleId}/${actualUser.id}/${user.id}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  useEffect(() => { setDraft(saved ?? emptyClassification(articleId)); setDirty(false); setConflict(false); setError(''); setBusy(false); }, [articleId, actualUser.id, user.id]);
  useEffect(() => { if (!dirty) { setDraft(saved ?? emptyClassification(articleId)); setStorageLimits(Object.fromEntries((saved?.storageRules ?? []).map(rule => [rule.siteId, storageLimitText(rule.maxKg)]))); } }, [saved, dirty, articleId]);
  const editable = hasEnvironmentPermission(user, 'environmentClassify');
  const storageEditable = editable && hasEnvironmentPermission(user, 'environmentStorage');
  const canConfigureStorage = storageEditable && user.siteIds === undefined;
  const change = (value: Partial<typeof draft>) => { setDraft(current => ({ ...current, ...value })); setDirty(true); setError(''); };
  async function save() {
    if (busy || conflict || !articleId || !editable) return;
    const wasteCode = draft.wasteCode.replace(/\D/g, '');
    if ((draft.hazardous && (!/^\d{6}$/.test(wasteCode) || !draft.wasteDescription.trim())) || (wasteCode && !/^\d{6}$/.test(wasteCode))) { setError('Ange en sexsiffrig avfallskod. Farligt avfall behöver också en miljöbeskrivning.'); return; }
    let storageRules = draft.storageRules;
    if (storageEditable && storageRules !== undefined) {
      const visibleSiteIds = new Set((state?.sites ?? []).map(site => site.id));
      try { storageRules = storageRules.map(rule => visibleSiteIds.has(rule.siteId) ? { ...rule, maxKg: rule.allowed ? parseStorageLimit(storageLimits[rule.siteId] ?? '', `Max lager för ${state?.sites.find(site => site.id === rule.siteId)?.name ?? rule.siteId}`) : null } : rule); }
      catch (failure) { setError(environmentFailure(failure)); return; }
    }
    setBusy(true); setError('');
    const expectedIdentity = identity;
    try {
      const classification = await environmentApi.classify(articleId, { expectedVersion: draft.version, hazardous: draft.hazardous, wasteCode, wasteDescription: draft.wasteDescription.trim(), handlingInstructions: draft.handlingInstructions.trim(), adrRequired: draft.adrRequired, ...(storageEditable && storageRules !== undefined ? { storageRules } : {}) });
      if (identityRef.current !== expectedIdentity) return;
      setDraft(classification); setDirty(false); setConflict(false); await refresh();
      if (identityRef.current === expectedIdentity) onNotice('Miljöklassificeringen och lagringsreglerna är sparade. Befintliga mottagningar behåller sin version.');
    } catch (failure) {
      if (identityRef.current !== expectedIdentity) return;
      if (failure instanceof EnvironmentApiError && failure.status === 409) {
        setConflict(true); setError('Artikeln ändrades av någon annan. Ditt utkast finns kvar. Hämta senaste versionen innan du sparar.');
        await refresh().catch(() => undefined);
      } else setError(environmentFailure(failure));
    }
    finally { if (identityRef.current === expectedIdentity) setBusy(false); }
  }
  return <section className="office-panel environment-panel environment-article-panel" aria-label={`Miljöklassificering för ${articleName || 'ny artikel'}`}>
    <header className="environment-heading"><span className="environment-icon"><Leaf size={21} /></span><div><h2>Miljö & avfallsklassificering</h2><p>Artikelns klassificering sparas med varje mottagning.</p></div>{saved && <span className="environment-pill">Version {saved.version}</span>}</header>
    {!articleId ? <p className="environment-muted">Spara artikeln först för att ange miljöklassificering.</p> : <EnvironmentAccessBoundary><div className="environment-classification-options"><button type="button" disabled={!editable || busy} className={`environment-classification-option ${!draft.hazardous ? 'selected' : ''}`} aria-pressed={!draft.hazardous} onClick={() => change({ hazardous: false })}><Leaf size={21} /><span><strong>Icke-farligt avfall</strong><small>Gäller ej som farligt avfall</small></span>{!draft.hazardous && <Check size={17} />}</button><button type="button" disabled={!editable || busy} className={`environment-classification-option hazardous ${draft.hazardous ? 'selected' : ''}`} aria-pressed={draft.hazardous} onClick={() => change({ hazardous: true })}><ShieldAlert size={22} /><span><strong>Farligt avfall</strong><small>Underlag för avfallsregistret</small></span>{draft.hazardous && <Check size={17} />}</button></div>
      <div className="environment-form-grid"><label>Avfallskod {draft.hazardous && <span>*</span>}<input aria-label="Avfallskod" disabled={!editable || busy} inputMode="numeric" maxLength={12} placeholder={draft.hazardous ? '16 06 01*' : 'Valfri avfallskod'} value={draft.wasteCode} onChange={event => change({ wasteCode: event.target.value })} /></label><label>Miljöbeskrivning {draft.hazardous && <span>*</span>}<input aria-label="Miljöbeskrivning" disabled={!editable || busy} maxLength={1000} placeholder="Exempelvis förbrukade blybatterier" value={draft.wasteDescription} onChange={event => change({ wasteDescription: event.target.value })} /></label><label className="environment-full">Säkerhetsanvisningar<textarea aria-label="Säkerhetsanvisningar" disabled={!editable || busy} maxLength={2000} rows={2} value={draft.handlingInstructions} onChange={event => change({ handlingInstructions: event.target.value })} placeholder="Förvaring, hantering och vad som ska rapporteras vid skada" /></label></div>
      <div className="storage-article-section"><h3>Tillåtna lagringsplatser</h3><p>Artikelns platsval och eventuella extra gräns gäller tillsammans med anläggningens regler.</p>{draft.storageRules === undefined ? <><p className="environment-muted">Lagringsregler är inte angivna.</p>{canConfigureStorage && <button type="button" className="office-link" disabled={busy} onClick={() => change({ storageRules: (state?.sites ?? []).map(site => ({ siteId: site.id, allowed: false, maxKg: null })) })}>Ange lagringsregler</button>}{storageEditable && !canConfigureStorage && <small className="environment-muted">En användare med tillgång till alla anläggningar behöver ange artikelns första lagringsregler.</small>}</> : <>{(state?.sites ?? []).map(site => {
        const rule = draft.storageRules?.find(item => item.siteId === site.id);
        const allowed = rule?.allowed ?? false;
        const currentKg = (state?.inventory ?? []).filter(item => item.siteId === site.id && item.articleId === articleId).reduce((sum, item) => sum + item.weight, 0);
        return <div className="storage-article-row" key={site.id}><div><label className="environment-checkbox"><input type="checkbox" aria-label={`Tillåt lagring på ${site.name}`} disabled={!storageEditable || busy} checked={allowed} onChange={event => change({ storageRules: [...(draft.storageRules ?? []).filter(item => item.siteId !== site.id), { siteId: site.id, allowed: event.target.checked, maxKg: rule?.maxKg ?? null }] })} /><span>{site.name}{!site.active ? ' · Avaktiverad' : ''}</span></label><small>{allowed ? 'Tillåten' : 'Ej tillåten'} · Registrerat lager: {environmentWeight(currentKg)}</small></div><label>Max artikelns lager (kg)<input type="text" inputMode="decimal" aria-label={`Max artikelns lager på ${site.name}`} disabled={!storageEditable || busy || !allowed} placeholder="Anläggningens gränser" value={storageLimits[site.id] ?? ''} onChange={event => { setStorageLimits(current => ({ ...current, [site.id]: event.target.value })); setDirty(true); setError(''); }} /></label></div>;
      })}<p className="environment-muted">Tom mängdgräns = ingen extra artikelgräns. Anläggningens gemensamma gränser gäller fortfarande. 0 kg = ingen lagring.</p></>}{!storageEditable && <small className="environment-muted">Ändring kräver behörighet för miljöklassificering och lagringsregler.</small>}</div>
      <div className="environment-adr"><div><h3>Farligt gods / ADR</h3><p>Bedöms separat från avfallsklassificeringen.</p><label className="environment-checkbox"><input type="checkbox" disabled={!editable || busy} checked={draft.adrRequired} onChange={event => change({ adrRequired: event.target.checked })} />ADR-bedömning krävs</label></div>{draft.adrRequired && <span className="environment-pill warning"><CircleAlert size={14} />ADR-bedömning ej slutförd</span>}</div>
      {error && <div className="environment-error" role="alert">{error}</div>}<div className="environment-actions"><small>{draft.hazardous ? `${formatWasteCode(draft.wasteCode)} · ` : ''}En ny version gäller nya miljöhändelser.</small><div className="environment-action-buttons">{(dirty || conflict) && <button type="button" className="office-btn outline" disabled={busy} onClick={() => { setDraft(saved ?? emptyClassification(articleId)); setStorageLimits(Object.fromEntries((saved?.storageRules ?? []).map(rule => [rule.siteId, storageLimitText(rule.maxKg)]))); setDirty(false); setConflict(false); setError(''); }}>{conflict ? 'Hämta senaste version' : 'Återställ utkast'}</button>}{editable && <button type="button" className="office-btn" disabled={busy || !dirty || conflict} onClick={() => void save()}><Save size={14} />{busy ? 'Sparar…' : 'Spara miljöklassificering'}</button>}</div></div>
    </EnvironmentAccessBoundary>}
  </section>;
}
