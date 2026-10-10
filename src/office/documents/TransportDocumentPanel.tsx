import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FileText, Plus, Save, Trash2, X } from 'lucide-react';
import ArchiveViewer from './ArchiveViewer';
import { documentApi, type ArchivedDocument, type DocumentIdentity, type DocumentParty, type DocumentSite, type TransportDocumentChanges, type TransportDocumentDraft } from './client';
import './documents.css';

const changesOf = (draft: TransportDocumentDraft): TransportDocumentChanges => ({ siteId: draft.siteId, direction: draft.direction, sender: draft.sender, receiver: draft.receiver,
  carrier: draft.carrier, driver: draft.driver, registration: draft.registration, startAt: draft.startAt, requestedAt: draft.requestedAt,
  handling: draft.handling, rows: draft.rows, reference: draft.reference });
const dateValue = (value: string) => value?.slice(0, 10) ?? '';

export default function TransportDocumentPanel({ orderId, identity, canEdit, onClose }: {
  orderId: string; identity: DocumentIdentity; canEdit: boolean; onClose: () => void;
}) {
  const [draft, setDraft] = useState<TransportDocumentDraft>();
  const [documents, setDocuments] = useState<ArchivedDocument[]>([]);
  const [sites, setSites] = useState<DocumentSite[]>([]);
  const [preferredId, setPreferredId] = useState<string>();
  const [tab, setTab] = useState<'details' | 'pdf'>('details');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const baseline = useRef('');
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void documentApi.transport(orderId, identity, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setDraft(value.draft); setSites(value.sites ?? []); baseline.current = JSON.stringify(changesOf(value.draft)); setDocuments(value.documents);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Transportunderlaget kunde inte hämtas.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [orderId, identity.actualUserId, identity.userId, attempt]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; dialog.current?.querySelector<HTMLElement>('button,input,select')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]') ?? []).filter(value => value.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  function patch(value: Partial<TransportDocumentDraft>) { setDraft(previous => previous ? { ...previous, ...value } : previous); setNotice(''); }
  function chooseSite(siteId: string) {
    if (!draft) return;
    const nextSite = sites.find(site => site.id === siteId), previousSite = sites.find(site => site.id === draft.siteId);
    const carrier = previousSite?.party && JSON.stringify(draft.carrier) === JSON.stringify(previousSite.party) && nextSite?.party ? nextSite.party : draft.carrier;
    patch({siteId, carrier, ...(nextSite?.party ? draft.direction === 'pickup' ? {receiver:nextSite.party} : {sender:nextSite.party} : {})});
  }
  async function save(generatePdf: boolean) {
    if (!draft || busy || !canEdit) return;
    setBusy(true); setError(''); setNotice('');
    try {
      let saved = draft;
      if (!draft.version || baseline.current !== JSON.stringify(changesOf(draft))) {
        const response = await documentApi.saveTransport(orderId, changesOf(draft), draft.version, identity);
        saved = response.draft; setDraft(saved); baseline.current = JSON.stringify(changesOf(saved));
        if (response.documents) setDocuments(response.documents);
      }
      if (generatePdf) {
        const response = await documentApi.generateTransport(orderId, identity);
        setDraft(response.draft); baseline.current = JSON.stringify(changesOf(response.draft));
        setDocuments(previous => [response.document, ...previous.filter(value => value.id !== response.document.id)]);
        setPreferredId(response.document.id); setTab('pdf'); setNotice('PDF-utkastet är arkiverat.');
      } else setNotice('Transportutkastet är sparat.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Transportunderlaget kunde inte sparas.'); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void save(false); }
  return <div className="transport-document-dialog" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="document-panel" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="transport-document-title">
      <header className="transport-document-header"><div><h2 id="transport-document-title">Transportdokument · {orderId}</h2><span className="document-stage">UTKAST</span><p>Förbered uppgifter för hämtning eller utleverans. Dokumentet är inte signerat.</p></div><button type="button" aria-label="Stäng transportdokument" onClick={onClose} disabled={busy}><X size={21} /></button></header>
      <div className="document-tabs" aria-label="Transportdokumentets vy"><button className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>Uppgifter</button><button className={tab === 'pdf' ? 'active' : ''} onClick={() => setTab('pdf')}>PDF & historik{documents.length ? ` (${documents.length})` : ''}</button></div>
      {error && <div className="document-error" role="alert"><span>{error}</span><button className="office-btn outline" onClick={() => setAttempt(value => value + 1)}>{draft ? 'Hämta senaste' : 'Försök igen'}</button></div>}
      {notice && <p role="status">{notice}</p>}
      {loading ? <div className="document-empty" role="status">Hämtar transportunderlag…</div> : tab === 'pdf' ? <ArchiveViewer documents={documents} identity={identity} preferredId={preferredId} /> : draft && <form className="transport-document-form" onSubmit={submit}>
        <fieldset disabled={busy || !canEdit}><legend>Transport</legend><div className="transport-document-grid">
          <label>Anläggning<select aria-label="Anläggning för transportdokument" value={draft.siteId} onChange={event => chooseSite(event.target.value)}>{sites.length ? sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>) : <option value={draft.siteId}>Aktuell anläggning</option>}</select></label>
          <label>Riktning<select aria-label="Riktning" value={draft.direction} onChange={event => { const direction = event.target.value as TransportDocumentDraft['direction']; if (direction !== draft.direction) patch({direction, sender:draft.receiver, receiver:draft.sender}); }}><option value="pickup">Hämtning till JEROC</option><option value="outbound">Utleverans från JEROC</option></select></label>
          <label>Referens<input value={draft.reference} onChange={event => patch({reference:event.target.value})} maxLength={200} /></label>
          <label>Planerat transportdatum<input type="date" value={dateValue(draft.startAt)} onChange={event => patch({startAt:event.target.value})} /></label>
          <label>Önskat datum<input type="date" value={dateValue(draft.requestedAt)} onChange={event => patch({requestedAt:event.target.value})} /></label>
        </div></fieldset>
        <PartyFields title="Avsändare" party={draft.sender} disabled={busy || !canEdit} onChange={sender => patch({sender})} />
        <PartyFields title="Mottagare" party={draft.receiver} disabled={busy || !canEdit} onChange={receiver => patch({receiver})} />
        <PartyFields title="Transportör" party={draft.carrier} disabled={busy || !canEdit} onChange={carrier => patch({carrier})} />
        <fieldset disabled={busy || !canEdit}><legend>Förare & fordon</legend><div className="transport-document-grid">
          <label>Förare<input value={draft.driver} onChange={event => patch({driver:event.target.value})} maxLength={200} /></label><label>Registreringsnummer<input value={draft.registration} onChange={event => patch({registration:event.target.value})} maxLength={50} /></label>
          <label className="full">Hantering & instruktioner<textarea value={draft.handling} onChange={event => patch({handling:event.target.value})} maxLength={2000} /></label>
        </div></fieldset>
        <fieldset disabled={busy || !canEdit}><legend>Material & mängd</legend><div className="transport-document-rows">{draft.rows.map((row, index) => <div className="transport-document-row" key={index}>
          <label>Material<input aria-label={`Material ${index + 1}`} value={row.name} onChange={event => patch({rows:draft.rows.map((value, at) => at === index ? {...value,name:event.target.value} : value)})} maxLength={200} /></label>
          <label>Avfallskod<input aria-label={`Avfallskod ${index + 1}`} value={row.wasteCode} onChange={event => patch({rows:draft.rows.map((value, at) => at === index ? {...value,wasteCode:event.target.value} : value)})} placeholder="T.ex. 16 06 01*" maxLength={20} /></label>
          <label>Vikt (kg)<input aria-label={`Vikt (kg) ${index + 1}`} type="number" min="0.001" max="1000000000" step="0.001" value={row.weight ?? ''} onChange={event => patch({rows:draft.rows.map((value, at) => at === index ? {...value,weight:event.target.value === '' ? null : Number(event.target.value)} : value)})} placeholder="Ej fastställd" /></label>
          <button type="button" aria-label={`Ta bort material ${index + 1}`} disabled={draft.rows.length === 1} onClick={() => patch({rows:draft.rows.filter((_, at) => at !== index)})}><Trash2 size={17} /></button>
        </div>)}</div>{canEdit && <button type="button" className="office-link" disabled={draft.rows.length >= 100} onClick={() => patch({rows:[...draft.rows,{name:'',wasteCode:'',weight:null}]})}><Plus size={15} /> Lägg till material</button>}</fieldset>
        {draft.missing?.length > 0 && <div className="transport-document-missing"><strong>Uppgifter saknas i det sparade underlaget</strong><ul>{draft.missing.map((value, index) => <li key={index}>{value}</li>)}</ul></div>}
        <p className="document-caption">Utkastet registrerar ingen lagerförflyttning och skickas inte till Naturvårdsverket. Signaturer och transportbekräftelser tillkommer i transportflödet.</p>
        {canEdit && <div className="transport-document-actions"><button className="office-btn outline" disabled={busy}><Save size={16} /> {busy ? 'Sparar…' : 'Spara utkast'}</button><button type="button" className="office-btn" disabled={busy} onClick={() => { const form = dialog.current?.querySelector<HTMLFormElement>('form'); if (form?.reportValidity()) void save(true); }}><FileText size={16} /> Skapa PDF-utkast</button></div>}
      </form>}
    </div>
  </div>;
}
function PartyFields({title, party, disabled, onChange}: {title: string; party: DocumentParty; disabled: boolean; onChange: (party: DocumentParty) => void}) {
  return <fieldset disabled={disabled}><legend>{title}</legend><div className="transport-document-grid">
    {([['name','Namn / företag'],['number','Org.- / personnummer'],['address','Gatuadress'],['postalCode','Postnummer'],['city','Ort']] as const).map(([field,label]) => <label className={field === 'name' || field === 'address' ? 'full' : ''} key={field}>{label}<input aria-label={`${title} · ${label}`} value={party[field] ?? ''} onChange={event => onChange({...party,[field]:event.target.value})} maxLength={field === 'address' ? 300 : 200} /></label>)}
  </div></fieldset>;
}
