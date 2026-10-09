import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import './quick-customer.css';

export default function AddWeighingArticleModal({ articles, onSave, onClose }: {
  articles: { id: string; name: string }[];
  onSave: (articleId: string, weight: number) => Promise<boolean>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useId();
  const [articleId, setArticleId] = useState(''), [weight, setWeight] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); opener?.focus(); };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const value = weight.trim().replace(',', '.');
    if (!articles.some(article => article.id === articleId) || !/^\d+(\.\d{1,3})?$/.test(value) || Number(value) <= 0 || Number(value) > 1e9) {
      setError('Välj en artikel och ange en vikt större än 0 kg, med högst tre decimaler.');
      return;
    }
    setBusy(true); setError('');
    try {
      if (!(await onSave(articleId, Number(value)))) setError('Artikeln kunde inte läggas till. Kontrollera att kortet fortfarande är öppet.');
    } catch { setError('Artikeln kunde inte läggas till. Försök igen.'); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="quick-customer-dialog office-add-article-dialog" aria-labelledby={heading} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit} className="quick-customer-form">
      <div className="quick-customer-heading"><div><h2 id={heading}>Lägg till artikel</h2><p>Lägg till en separat materialrad på invägningen.</p></div><button type="button" className="quick-customer-close" aria-label="Stäng lägg till artikel" disabled={busy} onClick={onClose}><X size={21}/></button></div>
      <div className="quick-customer-fields">
        <label>Artikel<select aria-label="Artikel" value={articleId} disabled={busy} onChange={event => setArticleId(event.target.value)}><option value="">Välj artikel</option>{articles.map(article => <option key={article.id} value={article.id}>{article.name}</option>)}</select></label>
        <label>Vikt (kg)<input aria-label="Vikt (kg)" inputMode="decimal" value={weight} disabled={busy} onChange={event => setWeight(event.target.value)} placeholder="0,000"/></label>
      </div>
      {error && <p role="alert" className="quick-customer-error">{error}</p>}
      <div className="office-actions"><button type="button" className="office-btn outline" disabled={busy} onClick={onClose}>Avbryt</button><button className="office-btn" disabled={busy}>{busy ? 'Sparar…' : 'Lägg till artikel'}</button></div>
    </form>
  </dialog>;
}
