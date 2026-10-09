import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Leaf, Save, ShieldAlert } from 'lucide-react';
import type { OfficeUser } from './model';
import { environmentApi } from './environment-client';
import { emptyClassification, formatWasteCode } from './environment-types';
import { EnvironmentAccessBoundary, environmentFailure, hasEnvironmentPermission, useEnvironmentSession } from './EnvironmentSession';
import './environment.css';

export default function EnvironmentalArticlePanel({ articleId, articleName, user, actualUser, onNotice }: { articleId: string; articleName: string; user: OfficeUser; actualUser: OfficeUser; onNotice: (message: string) => void }) {
  const { state, refresh } = useEnvironmentSession();
  const saved = state?.classifications.find(item => item.articleId === articleId);
  const [draft, setDraft] = useState(() => emptyClassification(articleId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const identity = `${articleId}/${actualUser.id}/${user.id}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  useEffect(() => { setDraft(saved ?? emptyClassification(articleId)); setDirty(false); setError(''); setBusy(false); }, [articleId, actualUser.id, user.id]);
  useEffect(() => { if (!dirty) setDraft(saved ?? emptyClassification(articleId)); }, [saved, dirty, articleId]);
  const editable = hasEnvironmentPermission(user, 'environmentClassify');
  const change = (value: Partial<typeof draft>) => { setDraft(current => ({ ...current, ...value })); setDirty(true); setError(''); };
  async function save() {
    if (busy || !articleId || !editable) return;
    if (draft.hazardous && (!/^\d{6}$/.test(draft.wasteCode.replace(/\D/g, '')) || !draft.wasteDescription.trim())) { setError('Ange en sexsiffrig avfallskod och miljöbeskrivning för farligt avfall.'); return; }
    setBusy(true); setError('');
    const expectedIdentity = identity;
    try {
      const classification = await environmentApi.classify(articleId, { expectedVersion: draft.version, hazardous: draft.hazardous, wasteCode: draft.wasteCode.replace(/\D/g, ''), wasteDescription: draft.wasteDescription.trim(), handlingInstructions: draft.handlingInstructions.trim(), adrRequired: draft.adrRequired });
      if (identityRef.current !== expectedIdentity) return;
      setDraft(classification); setDirty(false); await refresh(); onNotice('Miljöklassificeringen är sparad. Befintliga mottagningar behåller sin version.');
    } catch (failure) { if (identityRef.current === expectedIdentity) setError(environmentFailure(failure)); }
    finally { if (identityRef.current === expectedIdentity) setBusy(false); }
  }
  return <section className="office-panel environment-panel environment-article-panel" aria-label={`Miljöklassificering för ${articleName || 'ny artikel'}`}>
    <header className="environment-heading"><span className="environment-icon"><Leaf size={21} /></span><div><h2>Miljö & avfallsklassificering</h2><p>Artikelns klassificering sparas med varje mottagning.</p></div>{saved && <span className="environment-pill">Version {saved.version}</span>}</header>
    {!articleId ? <p className="environment-muted">Spara artikeln först för att ange miljöklassificering.</p> : <EnvironmentAccessBoundary><div className="environment-classification-options"><button type="button" disabled={!editable || busy} className={`environment-classification-option ${!draft.hazardous ? 'selected' : ''}`} aria-pressed={!draft.hazardous} onClick={() => change({ hazardous: false })}><Leaf size={21} /><span><strong>Icke-farligt avfall</strong><small>Gäller ej som farligt avfall</small></span>{!draft.hazardous && <Check size={17} />}</button><button type="button" disabled={!editable || busy} className={`environment-classification-option hazardous ${draft.hazardous ? 'selected' : ''}`} aria-pressed={draft.hazardous} onClick={() => change({ hazardous: true })}><ShieldAlert size={22} /><span><strong>Farligt avfall</strong><small>Underlag för avfallsregistret</small></span>{draft.hazardous && <Check size={17} />}</button></div>
      <div className="environment-form-grid"><label>Avfallskod {draft.hazardous && <span>*</span>}<input aria-label="Avfallskod" disabled={!editable || busy} inputMode="numeric" maxLength={12} placeholder={draft.hazardous ? '16 06 01*' : 'Valfri avfallskod'} value={draft.wasteCode} onChange={event => change({ wasteCode: event.target.value })} /></label><label>Miljöbeskrivning {draft.hazardous && <span>*</span>}<input aria-label="Miljöbeskrivning" disabled={!editable || busy} maxLength={1000} placeholder="Exempelvis förbrukade blybatterier" value={draft.wasteDescription} onChange={event => change({ wasteDescription: event.target.value })} /></label><label className="environment-full">Säkerhetsanvisningar<textarea aria-label="Säkerhetsanvisningar" disabled={!editable || busy} maxLength={2000} rows={2} value={draft.handlingInstructions} onChange={event => change({ handlingInstructions: event.target.value })} placeholder="Förvaring, hantering och vad som ska rapporteras vid skada" /></label></div>
      <div className="environment-adr"><div><h3>Farligt gods / ADR</h3><p>Bedöms separat från avfallsklassificeringen.</p><label className="environment-checkbox"><input type="checkbox" disabled={!editable || busy} checked={draft.adrRequired} onChange={event => change({ adrRequired: event.target.checked })} />ADR-bedömning krävs</label></div>{draft.adrRequired && <span className="environment-pill warning"><CircleAlert size={14} />ADR-bedömning ej slutförd</span>}</div>
      {error && <div className="environment-error" role="alert">{error}</div>}<div className="environment-actions"><small>{draft.hazardous ? `${formatWasteCode(draft.wasteCode)} · ` : ''}En ny version gäller nya miljöhändelser.</small>{editable && <button type="button" className="office-btn" disabled={busy || !dirty} onClick={() => void save()}><Save size={14} />{busy ? 'Sparar…' : 'Spara miljöklassificering'}</button>}</div>
    </EnvironmentAccessBoundary>}
  </section>;
}
