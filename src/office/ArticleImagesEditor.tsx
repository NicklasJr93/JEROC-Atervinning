import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ImagePlus, LoaderCircle, Star, Trash2 } from 'lucide-react';
import type { ArticleImage } from '../catalog-types';
import type { OfficeUser } from './model';
import { CatalogImage } from './CatalogImage';
import './article-images-editor.css';

export type ArticleImagesEditorProps = {
  images: ArticleImage[];
  onChange: (images: ArticleImage[]) => void;
  user: OfficeUser;
  actualUser: OfficeUser;
  disabled?: boolean;
  maxImages?: number;
  /** Keeps an upload scoped to the article/group that started it. */
  scopeKey?: string;
  onBusyChange?: (busy: boolean) => void;
};

const uploadTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const uploadLimit = 10 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function uploadContentType(file: File): Promise<string> {
  const declared = file.type.trim().toLowerCase();
  const canonical = ({ 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png' } as Record<string, string>)[declared] || declared;
  if (uploadTypes.has(canonical)) return canonical;
  if (canonical && canonical !== 'application/octet-stream') return '';
  // Some mobile file pickers omit MIME metadata. Use the signature, never the
  // filename extension; the server still decodes and verifies the whole image.
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return 'image/png';
  const header = Array.from(bytes, value => String.fromCharCode(value)).join('');
  if (header.slice(0, 4) === 'RIFF' && header.slice(8, 12) === 'WEBP') return 'image/webp';
  if (header.slice(4, 8) === 'ftyp' && /avif|avis/.test(header.slice(8))) return 'image/avif';
  return '';
}

export function ArticleImagesEditor({ images, onChange, user, actualUser, disabled = false, maxImages = 6, scopeKey = '', onBusyChange }: ArticleImagesEditorProps) {
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const scope = `${actualUser.id}:${user.id}:${scopeKey}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const imageRef = useRef(images);
  imageRef.current = images;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const max = Math.max(1, Math.min(6, maxImages));

  useEffect(() => {
    setBusy(false);
    setError('');
    setProgress('');
    setPicker(false);
    return () => {
      pending.current?.abort();
      pending.current = null;
      busyCallback.current?.(false);
    };
  }, [scope]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current?.abort(); pending.current = null; busyCallback.current?.(false); };
  }, []);
  useEffect(() => {
    if (!disabled) return;
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setProgress('');
    busyCallback.current?.(false);
  }, [disabled]);

  function move(index: number, destination: number) {
    const next = [...images];
    const [image] = next.splice(index, 1);
    next.splice(destination, 0, image);
    onChange(next);
  }

  async function upload(files: File[]) {
    if (disabled || pending.current || !files.length) return;
    setError('');
    const room = max - imageRef.current.length;
    if (files.length > room) { setError(`Du kan välja högst ${max} ${max === 1 ? 'bild' : 'bilder'}. Ta bort en bild för att lägga till en ny.`); return; }
    if (files.some(file => !file.size)) { setError('Bilden är tom. Välj en annan bild.'); return; }
    if (files.some(file => file.size > uploadLimit)) { setError('Varje bild får vara högst 10 MB. Välj en mindre bild.'); return; }
    const controller = new AbortController();
    pending.current = controller;
    const uploadScope = scope;
    const ownsUpload = () => mounted.current && currentScope.current === uploadScope && pending.current === controller;
    const valid = () => ownsUpload() && !disabledRef.current;
    setBusy(true);
    busyCallback.current?.(true);
    try {
      setProgress('Förbereder bilder…');
      const contentTypes = await Promise.all(files.map(uploadContentType));
      if (!valid()) return;
      if (contentTypes.some(type => !type)) throw new Error('Välj en bild i JPEG-, PNG-, WebP- eller AVIF-format.');
      for (let index = 0; index < files.length; index += 1) {
        if (!valid()) return;
        setProgress(`Laddar upp bild ${index + 1} av ${files.length}…`);
        let timedOut = false;
        const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 45_000);
        try {
          const response = await fetch('/api/article-media', {
            method: 'POST', credentials: 'same-origin', signal: controller.signal,
            headers: { Accept: 'application/json', 'Content-Type': contentTypes[index], 'X-Demo-Actor': actualUser.id, 'X-Demo-User': user.id, 'X-File-Name': encodeURIComponent(files[index].name) },
            body: files[index],
          });
          const result = await response.json().catch(() => null) as { image?: { id?: string }; error?: string; message?: string } | null;
          if (!valid()) return;
          if (!response.ok) throw new Error(result?.message || result?.error || 'Bilden kunde inte laddas upp. Försök igen.');
          const id = result?.image?.id;
          if (!id || !uuidPattern.test(id)) throw new Error('Bildtjänsten gav ett oväntat svar. Försök igen.');
          const next = [...imageRef.current, id];
          if (next.length > max) throw new Error(`Högst ${max} bilder kan väljas.`);
          imageRef.current = next;
          changeRef.current(next);
        } catch (cause) {
          if (timedOut) throw new Error('Uppladdningen tog för lång tid. Kontrollera anslutningen och försök igen.');
          throw cause;
        } finally { window.clearTimeout(timeout); }
      }
    } catch (cause) {
      if (valid() && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : 'Bilden kunde inte laddas upp.');
    } finally {
      if (ownsUpload()) { pending.current = null; setBusy(false); setProgress(''); busyCallback.current?.(false); }
    }
  }

  const locked = disabled || busy;
  return <div className="office-article-images">
    <div className="office-article-images-actions">
      <button type="button" className="office-pricing-plain" disabled={locked} aria-expanded={picker} onClick={() => setPicker(value => !value)}>{picker ? 'Stäng bildval' : `Välj referensbilder (${images.length})`}</button>
      <button type="button" className="office-pricing-plain" disabled={locked || images.length >= max} onClick={() => fileInput.current?.click()}>{busy ? <LoaderCircle size={16} className="office-article-image-spinner" aria-hidden="true" /> : <ImagePlus size={16} aria-hidden="true" />}Ladda upp bild</button>
      <input id={inputId} ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple={max > 1} disabled={locked} hidden aria-label="Ladda upp egna referensbilder" onChange={event => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; void upload(files); }} />
    </div>
    {busy && <div className="office-article-images-progress" role="status"><LoaderCircle size={14} className="office-article-image-spinner" aria-hidden="true" />{progress}</div>}
    {error && <div className="office-article-images-error" role="alert">{error}</div>}
    {images.length > 0 && <ol className="office-article-images-selected" aria-label="Valda referensbilder i visningsordning">
      {images.map((image, index) => <li key={`${typeof image}:${image}`}>
        <CatalogImage image={image} alt={typeof image === 'number' ? `Referensbild ${image + 1}` : `Uppladdad bild ${index + 1}`} />
        <div className="office-article-images-caption">{index === 0 ? <><Star size={11} aria-hidden="true" />Huvudbild</> : `Bild ${index + 1}`}</div>
        {!disabled && <div className="office-article-images-tools">
          {max > 1 && <><button type="button" disabled={locked || index === 0} title="Flytta åt vänster" aria-label={`Flytta bild ${index + 1} åt vänster`} onClick={() => move(index, index - 1)}><ArrowLeft size={13} /></button>
          <button type="button" disabled={locked || index === images.length - 1} title="Flytta åt höger" aria-label={`Flytta bild ${index + 1} åt höger`} onClick={() => move(index, index + 1)}><ArrowRight size={13} /></button>
          <button type="button" disabled={locked || index === 0} title="Gör till huvudbild" aria-label={`Gör bild ${index + 1} till huvudbild`} onClick={() => move(index, 0)}><Star size={13} /></button></>}
          <button type="button" disabled={locked} title="Ta bort från bildvalet" aria-label={`Ta bort bild ${index + 1}`} onClick={() => onChange(images.filter((_, position) => position !== index))}><Trash2 size={13} /></button>
        </div>}
      </li>)}
    </ol>}
    {picker && <div className="office-article-images-library" aria-label="Befintliga exempelbilder">
      {Array.from({ length: 40 }, (_, image) => {
        const selected = images.includes(image);
        return <button type="button" key={image} className={selected ? 'selected' : ''} disabled={locked || (!selected && images.length >= max)} aria-label={`Referensbild ${image + 1}`} aria-pressed={selected} onClick={() => onChange(selected ? images.filter(item => item !== image) : [...images, image])}>
          <CatalogImage image={image} alt={`Referensbild ${image + 1}`} />{selected && <Check size={14} aria-hidden="true" />}
        </button>;
      })}
    </div>}
    <p className="office-article-images-help">{max === 1 ? 'Välj en bild ur biblioteket eller ladda upp en egen.' : `Upp till ${max} bilder från biblioteket eller egna uppladdningar. Första bilden är huvudbild.`}</p>
  </div>;
}

export default ArticleImagesEditor;
