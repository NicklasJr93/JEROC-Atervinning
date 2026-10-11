import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Trash2, X } from 'lucide-react';
import { kilos } from '../model';
import type { OfficeCard } from './model';
import './quick-customer.css';

export default function EditWeighingRowModal({ mode, row, canRemove, requiresNewApproval, onSave, onClose }: {
  mode: 'weight' | 'remove';
  row: OfficeCard['rows'][number];
  canRemove: boolean;
  requiresNewApproval: boolean;
  onSave: (weight?: number) => Promise<boolean>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useId();
  const [weight, setWeight] = useState(String(row.weight).replace('.', ','));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const name = row.articleName ?? row.articleId;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); opener?.focus(); };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const value = weight.trim().replace(',', '.');
    if (mode === 'weight' && (!/^\d+(\.\d{1,3})?$/.test(value) || Number(value) > 1e9)) {
      setError('Ange en vikt från 0 kg, med högst tre decimaler.');
      return;
    }
    if (mode === 'weight' && Number(value) === 0 && !canRemove) {
      setError('0 kg tar bort artikeln. Du behöver även behörigheten Får ta bort material.');
      return;
    }
    setBusy(true); setError('');
    try {
      if (!(await onSave(mode === 'weight' ? Number(value) : undefined))) setError('Ändringen kunde inte sparas. Läs in kortet och försök igen.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Ändringen kunde inte sparas. Försök igen.'); }
    finally { setBusy(false); }
  }
  const removing = mode === 'remove' || weight.trim() !== '' && Number(weight.trim().replace(',', '.')) === 0;
  return <dialog ref={dialog} className="quick-customer-dialog office-add-article-dialog" aria-labelledby={heading} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit} className="quick-customer-form">
      <div className="quick-customer-heading"><div><h2 id={heading}>{mode === 'weight' ? 'Ändra vikt' : 'Ta bort artikel'}</h2><p>{name} · {kilos(row.weight)} kg</p></div><button type="button" className="quick-customer-close" aria-label="Stäng materialändring" disabled={busy} onClick={onClose}><X size={21}/></button></div>
      {mode === 'weight'
        ? <div className="quick-customer-fields"><label>Vikt (kg)<input autoFocus aria-label="Vikt (kg)" inputMode="decimal" value={weight} disabled={busy} onChange={event => setWeight(event.target.value)} /></label></div>
        : <p>Ta bort materialraden från den här invägningen?</p>}
      {mode === 'weight' && <p className="office-row-edit-help">{canRemove ? '0 kg tar bort artikeln från kortet.' : 'För att ange 0 kg krävs även behörighet att ta bort material.'}</p>}
      {requiresNewApproval && <div className="office-info">Ändringen återkallar kundgodkännandet. Kunden behöver godkänna en ny version.</div>}
      {error && <p role="alert" className="quick-customer-error">{error}</p>}
      <div className="office-actions"><button type="button" className="office-btn outline" disabled={busy} onClick={onClose}>Avbryt</button><button className="office-btn" disabled={busy}>{mode === 'remove' && <Trash2 size={16}/>} {busy ? 'Sparar…' : mode === 'remove' ? 'Ta bort artikel' : removing && canRemove ? 'Spara och ta bort artikel' : 'Spara vikt'}</button></div>
    </form>
  </dialog>;
}
