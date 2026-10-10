import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Leaf, Plus, Save, Scale, Trash2 } from 'lucide-react';
import type { LogisticsOfficeCommand, LogisticsOfficeState, LogisticsOrder, LogisticsWeighingInput } from './types';
import { Alert, Field, kg, Panel, Pill } from './Ui';

interface WeighingForm {
  customerId: string; origin: string; reference: string;
  rows: { articleId: string; weight: string }[];
}
const formOf = (order: LogisticsOrder): WeighingForm => ({
  customerId: order.detail.weighing?.customerId ?? '', origin: order.detail.weighing?.origin ?? '', reference: order.detail.weighing?.reference ?? '',
  rows: order.detail.weighing?.rows.map(row => ({ articleId: row.articleId, weight: row.weight === undefined ? '' : String(row.weight) })) ?? [],
});

export default function WorkOrderWeighing({ order, state, writable, onCommand, onBusyChange, onNotice, onOpenWeighing }: {
  order: LogisticsOrder; state: LogisticsOfficeState; writable: boolean;
  onCommand: (command: LogisticsOfficeCommand) => Promise<LogisticsOfficeState>;
  onBusyChange: (busy: boolean) => void; onNotice: (message: string) => void;
  onOpenWeighing: (cardId: number) => void | Promise<void>;
}) {
  const weighing = order.detail.weighing;
  const [open, setOpen] = useState(false), [form, setForm] = useState(() => formOf(order));
  const [dirty, setDirty] = useState(false), [baseVersion, setBaseVersion] = useState(order.detail.version);
  const [pending, setPending] = useState<'start' | 'save' | 'complete' | 'open'>(), [error, setError] = useState('');
  const mounted = useRef(true), submitting = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!dirty) { setForm(formOf(order)); setBaseVersion(order.detail.version); }
  }, [weighing?.version, order.detail.version, dirty]);

  if (!['pickup', 'exchange'].includes(order.action)) return null;
  if (!weighing) return <Panel title="Förberedd vägning" icon={<Scale size={17} />}><p className="wo-text">Lägg till material på arbetsordern för att förbereda vägningen.</p></Panel>;
  const completed = weighing.status === 'completed';
  const canEdit = writable && !completed && order.status !== 'cancelled';
  const actualKg = weighing.rows.reduce((sum, row) => sum + (row.weight ?? 0), 0);
  const customer = state.customers.find(value => value.id === weighing.customerId);
  const stale = dirty && baseVersion !== order.detail.version;

  function patch(next: Partial<WeighingForm>) { setForm(current => ({ ...current, ...next })); setDirty(true); setError(''); }
  function adopt(next: LogisticsOfficeState) {
    const latest = next.orders.find(value => value.id === order.id);
    if (latest && mounted.current) { setForm(formOf(latest)); setBaseVersion(latest.detail.version); setDirty(false); }
    return latest;
  }
  function input(requireWeights: boolean): LogisticsWeighingInput {
    if (!form.rows.length) throw new Error('Lägg till minst en artikel för vägningen.');
    const seen = new Set<string>();
    const rows = form.rows.map((row, index) => {
      const article = state.articles.find(value => value.id === row.articleId);
      if (!article) throw new Error(`Välj artikel på rad ${index + 1}.`);
      if (seen.has(row.articleId)) throw new Error('Samma artikel kan bara finnas på en rad.');
      seen.add(row.articleId);
      const weight = row.weight.trim() === '' ? undefined : Number(row.weight.replace(',', '.'));
      if (weight !== undefined && (!Number.isFinite(weight) || weight < 0 || weight > 1e9 || Math.abs(weight * 1000 - Math.round(weight * 1000)) > .00001)) throw new Error(`Ange en giltig vikt för ${article.name}, med högst tre decimaler.`);
      if (requireWeights && (!weight || weight <= 0)) throw new Error(`Ange faktiskt invägd vikt för ${article.name}.`);
      return { articleId: row.articleId, ...(weight && weight > 0 ? { weight } : {}) };
    });
    if (requireWeights && !form.origin.trim()) throw new Error('Fyll i ursprungsadressen innan vägningen färdigställs.');
    return { customerId: form.customerId || undefined, origin: form.origin.trim(), reference: form.reference.trim(), rows };
  }
  async function perform(action: 'start' | 'save' | 'complete') {
    if (submitting.current || !canEdit) return;
    submitting.current = true; setPending(action); onBusyChange(true); setError('');
    try {
      if (action === 'start') {
        const next = await onCommand({ action: 'order.weighing.start', orderId: order.id, expectedVersion: order.detail.version });
        if (!mounted.current) return;
        adopt(next); setOpen(true);
      } else {
        const value = input(action === 'complete');
        const saved = await onCommand({ action: 'order.weighing.save', orderId: order.id, expectedVersion: baseVersion, input: value });
        if (!mounted.current) return;
        const latest = adopt(saved);
        if (action === 'complete') {
          if (!latest) throw new Error('Vägningen kunde inte läsas efter sparningen. Uppdatera arbetsordern.');
          const next = await onCommand({ action: 'order.weighing.complete', orderId: order.id, expectedVersion: latest.detail.version });
          if (!mounted.current) return;
          adopt(next); setOpen(false); onNotice('Vägningen är färdigställd och har fått ett invägningskort.');
        } else onNotice('Vägningen är sparad. Den kan fortsätta senare.');
      }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Vägningen kunde inte sparas.'); }
    finally { submitting.current = false; if (mounted.current) setPending(undefined); onBusyChange(false); }
  }
  async function openCard() {
    if (!weighing?.cardId || submitting.current) return;
    submitting.current = true; setPending('open'); setError('');
    try { await onOpenWeighing(weighing.cardId); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Invägningen kunde inte öppnas.'); }
    finally { submitting.current = false; if (mounted.current) setPending(undefined); }
  }

  return <Panel title="Förberedd vägning" icon={<Scale size={17} />} actions={<Pill tone={completed ? 'green' : weighing.status === 'started' ? 'blue' : 'grey'}>{completed ? 'Färdigställd' : weighing.status === 'started' ? 'Påbörjad' : 'Förberedd'}</Pill>}>
    <div className="wo-weighing-summary">
      <div><strong>{completed && weighing.cardId ? `Invägning #${weighing.cardId}` : customer?.name ?? 'Kund kompletteras vid vägning'}</strong><small>{completed ? `${kg(actualKg)} · ${weighing.rows.length} artiklar` : 'Registrera faktiskt invägda vikter.'}</small>{weighing.origin && <small>{weighing.origin}</small>}</div>
      <div className="wo-actions">{completed && weighing.cardId ? <button type="button" className="office-btn" disabled={!!pending} onClick={() => void openCard()}><CheckCircle2 size={15} />{pending === 'open' ? 'Öppnar…' : 'Öppna invägning'}<ChevronRight size={14} /></button>
        : <button type="button" className="office-btn outline" disabled={!!pending} aria-expanded={open} onClick={() => { if (open) setOpen(false); else if (canEdit && weighing.status === 'prepared') void perform('start'); else setOpen(true); }}>{pending === 'start' ? 'Startar…' : open ? 'Dölj vägning' : canEdit && weighing.status === 'prepared' ? 'Starta vägning' : canEdit ? 'Öppna vägning' : 'Visa vägning'}<ChevronDown size={14} /></button>}</div>
    </div>
    {open && !completed && <div className="wo-weighing-editor">
      <fieldset disabled={!canEdit || !!pending} className="wo-form-fieldset"><div className="wo-form-grid">
        <Field label="Kund"><select aria-label="Kund för vägning" value={form.customerId} onChange={event => patch({ customerId: event.target.value })}><option value="">Välj kund senare</option>{state.customers.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></Field>
        <Field label="Referens (valfri)"><input aria-label="Referens för vägning" maxLength={1000} value={form.reference} onChange={event => patch({ reference: event.target.value })} /></Field>
        <Field label="Ursprungsadress *" full><input aria-label="Ursprungsadress för vägning" maxLength={1000} value={form.origin} onChange={event => patch({ origin: event.target.value })} /></Field>
      </div><div className="wo-weighing-rows">{form.rows.map((row, index) => {
        const article = state.articles.find(value => value.id === row.articleId), source = weighing.rows.find(value => value.articleId === row.articleId);
        return <div className="wo-material-row" key={index}><Field label="Artikel"><select aria-label={`Artikel för vägning ${index + 1}`} value={row.articleId} onChange={event => patch({ rows: form.rows.map((value, at) => at === index ? { ...value, articleId: event.target.value, weight: '' } : value) })}><option value="">Välj artikel</option>{state.articles.filter(value => value.id === row.articleId || !form.rows.some(current => current.articleId === value.id)).map(value => <option key={value.id} value={value.id}>{value.name}{value.hazardous ? ' · farligt avfall' : ''}</option>)}</select>{source && source.plannedKg > 0 && <small className="wo-form-hint">Planerat: {kg(source.plannedKg)}</small>}{article?.hazardous && <small className="wo-form-hint">Farligt avfall · {article.wasteCode}</small>}</Field><Field label="Verklig vikt (kg)"><input aria-label={`Verklig vikt ${index + 1}`} inputMode="decimal" type="number" min="0" max="1000000000" step="0.001" placeholder="Ej vägd" value={row.weight} onChange={event => patch({ rows: form.rows.map((value, at) => at === index ? { ...value, weight: event.target.value } : value) })} /></Field>{canEdit && <button type="button" className="wo-icon-button" aria-label={`Ta bort vägningsrad ${index + 1}`} onClick={() => patch({ rows: form.rows.filter((_, at) => at !== index) })}><Trash2 size={15} /></button>}</div>;
      })}{canEdit && <button type="button" className="office-link" onClick={() => patch({ rows: [...form.rows, { articleId: '', weight: '' }] })}><Plus size={15} />Lägg till artikel</button>}</div></fieldset>
      {!!weighing.environmentPreparation?.rows.length && <div className="wo-weighing-environment"><Leaf size={15} /><span>Miljöunderlag för {weighing.environmentPreparation.rows.map(row => row.name).join(', ')} förbereds för invägningskortet.</span></div>}
      {stale && <Alert tone="orange">Arbetsordern har ändrats sedan du öppnade vägningen. Hämta senaste innan du sparar.<button type="button" className="office-link" onClick={() => { setDirty(false); setForm(formOf(order)); setBaseVersion(order.detail.version); setError(''); }}>Hämta senaste</button></Alert>}
      {canEdit && <div className="wo-weighing-actions"><span>{dirty ? 'Osparade ändringar' : 'Vägningen är sparad'}</span><div className="wo-actions"><button type="button" className="office-btn outline" disabled={!!pending || stale} onClick={() => void perform('save')}><Save size={15} />{pending === 'save' ? 'Sparar…' : 'Spara vägning'}</button><button type="button" className="office-btn" disabled={!!pending || stale} onClick={() => void perform('complete')}><CheckCircle2 size={15} />{pending === 'complete' ? 'Färdigställer…' : 'Färdigställ vägning'}</button></div></div>}
    </div>}
    {error && <Alert tone="red">{error}</Alert>}
  </Panel>;
}
