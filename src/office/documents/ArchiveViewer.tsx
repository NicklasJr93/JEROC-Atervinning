import { useEffect, useState } from 'react';
import { Download, ExternalLink, FileText, LoaderCircle } from 'lucide-react';
import { documentStageNames, documentsNewestFirst, readDocumentPdf, type ArchivedDocument, type DocumentIdentity } from './client';
import './documents.css';

export default function ArchiveViewer({ documents, identity, preferredId, onSelect }: {
  documents: ArchivedDocument[]; identity: DocumentIdentity; preferredId?: string; onSelect?: (document: ArchivedDocument) => void;
}) {
  const ordered = documentsNewestFirst(documents);
  const [selectedId, setSelectedId] = useState(preferredId ?? ordered[0]?.id ?? '');
  const [file, setFile] = useState<{url: string; filename: string}>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const selected = ordered.find(document => document.id === selectedId) ?? ordered[0];
  useEffect(() => { if (preferredId) setSelectedId(preferredId); }, [preferredId]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController(); let url: string | undefined;
    setFile(undefined); setError(''); setLoading(true);
    void readDocumentPdf(selected, identity, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(result.blob); setFile({ url, filename: result.filename });
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'PDF-filen kunde inte laddas.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [selected?.id, identity.actualUserId, identity.userId, attempt]);
  if (!selected) return <div className="document-empty"><FileText size={25} /><p>Ingen arkiverad PDF finns för underlaget ännu.</p></div>;
  return <section className="document-archive" aria-label="Arkiverad PDF">
    <div className="document-archive-toolbar"><label>Dokumentversion<select aria-label="Dokumentversion" value={selected.id} onChange={event => { setSelectedId(event.target.value); const next = documents.find(value => value.id === event.target.value); if (next) onSelect?.(next); }}>
      {ordered.map(document => <option key={document.id} value={document.id}>{documentStageNames[document.stage] ?? document.stage} · version {document.sourceVersion} · {new Date(document.createdAt).toLocaleString('sv-SE', {timeZone:'Europe/Stockholm',dateStyle:'short',timeStyle:'short'})}</option>)}
    </select></label><div className="document-buttons">
      {file && <><a className="office-btn outline" href={file.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} /> Öppna PDF</a><a className="office-btn" href={file.url} download={file.filename}><Download size={16} /> Ladda ned PDF</a></>}
    </div></div>
    <p className="document-archive-caption">{selected.title} · {documentStageNames[selected.stage] ?? selected.stage} · arkiverad {new Date(selected.createdAt).toLocaleString('sv-SE', {timeZone:'Europe/Stockholm',dateStyle:'short',timeStyle:'short'})}</p>
    {loading && <div className="document-empty" role="status"><LoaderCircle size={22} /> Hämtar PDF…</div>}
    {error && <div className="document-error" role="alert"><span>{error}</span><button className="office-btn outline" onClick={() => setAttempt(value => value + 1)}>Försök igen</button></div>}
    {file && <iframe className="document-pdf" src={file.url} title={`${selected.title} · arkiverad PDF`} />}
  </section>;
}
