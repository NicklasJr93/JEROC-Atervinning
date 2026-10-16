import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, ImagePlus, LoaderCircle, Truck, X } from 'lucide-react';
import { Alert } from '../personnel/components/Ui';
import { downloadFleetBlob, fleetFileId, getFleetFile, readFleetFiles, uploadFleetFile, type FleetScope } from './client';
import type { FleetFile } from './types';
import { timestamp } from './format';

export function FleetPhoto({ scope, url, alt, className = '' }: { scope: FleetScope; url?: string; alt: string; className?: string }) {
  const [image, setImage] = useState<{ key: string; url: string }>();
  const key = `${scope.key}:${url ?? ''}`, id = fleetFileId(url);
  useEffect(() => {
    if (!id) return;
    let active = true, objectUrl: string | undefined; const controller = new AbortController();
    void getFleetFile(scope, { id }, controller.signal).then(blob => { if (!active || !blob.type.startsWith('image/')) return; objectUrl = URL.createObjectURL(blob); setImage({ key, url: objectUrl }); }).catch(() => {});
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [key, id, scope]);
  return <div className={`fleet-photo ${className}`}>{image?.key === key ? <img src={image.url} alt={alt} /> : <Truck aria-label={alt} size={36} />}</div>;
}

export function FleetPhotoPicker({ scope, vehicleId, urls, onChange, multiple = false, disabled = false, onBusyChange }: {
  scope: FleetScope; vehicleId: string; urls: string[]; onChange: (urls: string[]) => void; multiple?: boolean; disabled?: boolean; onBusyChange?: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null), controller = useRef<AbortController | undefined>(undefined), mounted = useRef(true), pending = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); onBusyChange?.(false); }; }, [scope.key, vehicleId]);
  async function upload(file?: File) {
    if (!file || pending.current || disabled) return;
    pending.current = true; setBusy(true); onBusyChange?.(true); setError(''); const request = new AbortController(); controller.current = request;
    try { const value = await uploadFleetFile(scope, vehicleId, 'photo', file, request.signal); if (mounted.current && !request.signal.aborted) onChange(multiple ? [...urls, value.file.url] : [value.file.url]); }
    catch (reason) { if (mounted.current && !request.signal.aborted) setError(reason instanceof Error ? reason.message : 'Bilden kunde inte laddas upp.'); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); onBusyChange?.(false); } }
  }
  return <div className="fleet-photo-picker"><div className="fleet-photo-thumbs">{urls.map(url => <div key={url}><FleetPhoto scope={scope} url={url} alt="Fordonsfoto" /><button type="button" aria-label="Ta bort bild från underlaget" disabled={busy || disabled} onClick={() => onChange(urls.filter(value => value !== url))}><X size={14} /></button></div>)}</div>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden aria-label="Välj fordonsfoto" disabled={busy || disabled} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void upload(file); }} />
    {(multiple ? urls.length < 6 : !urls.length) && <button type="button" className="office-btn outline" disabled={busy || disabled} onClick={() => input.current?.click()}>{busy ? <LoaderCircle size={15} /> : <ImagePlus size={15} />}{busy ? 'Laddar upp…' : 'Lägg till foto'}</button>}
    <small>JPG, PNG eller WebP · högst 8 MB.</small>{error && <Alert tone="red">{error}</Alert>}
  </div>;
}

export default function FleetFiles({ scope, vehicleId, writable, documentRefs = [] }: { scope: FleetScope; vehicleId: string; writable: boolean; documentRefs?: string[] }) {
  const [snapshot, setSnapshot] = useState<{ key: string; files: FleetFile[] }>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const key = `${scope.key}:${vehicleId}`, keyRef = useRef(key); keyRef.current = key;
  const controllers = useRef(new Set<AbortController>()), input = useRef<HTMLInputElement>(null), pending = useRef(false);
  const files = snapshot?.key === key ? snapshot.files : [];
  const load = useCallback(async () => {
    const controller = new AbortController(); controllers.current.add(controller);
    try { const value = await readFleetFiles(scope, vehicleId, controller.signal); if (keyRef.current === key && !controller.signal.aborted) { setSnapshot({ key, files: value.files }); setError(''); } }
    catch (reason) { if (keyRef.current === key && !controller.signal.aborted) { setSnapshot(undefined); setError(reason instanceof Error ? reason.message : 'Dokumenten kunde inte hämtas.'); } }
    finally { controllers.current.delete(controller); }
  }, [key, scope, vehicleId]);
  useEffect(() => { void load(); const requests = controllers.current; return () => { for (const request of requests) request.abort(); requests.clear(); }; }, [load]);
  async function upload(file?: File) {
    if (!file || pending.current || !writable) return; pending.current = true; setBusy(true); setError(''); const controller = new AbortController(); controllers.current.add(controller);
    try { const value = await uploadFleetFile(scope, vehicleId, 'document', file, controller.signal); if (keyRef.current === key && !controller.signal.aborted) setSnapshot(previous => ({ key, files: [...(previous?.key === key ? previous.files : []), value.file] })); }
    catch (reason) { if (keyRef.current === key && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Dokumentet kunde inte laddas upp.'); }
    finally { controllers.current.delete(controller); pending.current = false; if (keyRef.current === key) setBusy(false); }
  }
  async function download(file: FleetFile) {
    const controller = new AbortController(); controllers.current.add(controller);
    try { const blob = await getFleetFile(scope, file, controller.signal); if (keyRef.current === key && !controller.signal.aborted) downloadFleetBlob(blob, file.name); }
    catch (reason) { if (keyRef.current === key && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Dokumentet kunde inte hämtas.'); }
    finally { controllers.current.delete(controller); }
  }
  const unknownRefs = documentRefs.filter(reference => !files.some(file => file.url === reference));
  return <section className="office-panel fleet-panel"><div className="fleet-section-heading"><div><h2>Dokument</h2><p>Serviceunderlag, protokoll och bilder för fordonet.</p></div>{writable && <><input ref={input} type="file" hidden accept="application/pdf,image/jpeg,image/png,image/webp" aria-label="Välj fordonsdokument" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void upload(file); }} /><button type="button" className="office-btn outline" disabled={busy} onClick={() => input.current?.click()}><ImagePlus size={15} />{busy ? 'Laddar upp…' : 'Ladda upp dokument'}</button></>}</div>
    {error && <Alert tone="red">{error}</Alert>}{files.length ? <ul className="fleet-file-list">{files.map(file => <li key={file.id}><FileText size={20} /><div><strong>{file.name}</strong><small>{timestamp(file.uploadedAt)} · {file.kind === 'photo' ? 'Foto' : 'Dokument'}</small></div><button type="button" className="office-link" onClick={() => void download(file)}><Download size={15} /> Hämta</button></li>)}</ul> : <div className="fleet-empty"><FileText size={25} /><p>Inga filer registrerade för fordonet.</p></div>}
    {unknownRefs.length > 0 && <div className="fleet-reference-list"><h3>Övriga dokumentreferenser</h3>{unknownRefs.map(reference => <p key={reference}>{reference}</p>)}</div>}
  </section>;
}
