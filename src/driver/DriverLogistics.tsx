import { useState, type FormEvent } from 'react';
import { CheckCircle2, ClipboardCheck, FileText, LoaderCircle, MapPin, ShieldCheck, Truck } from 'lucide-react';
import type { LogisticsDriverCommand, LogisticsOrderDetail } from '../office/logistics/types';

const stages: Record<LogisticsOrderDetail['execution']['stage'], string> = {
  pending: 'Ej påbörjat', travelling_empty: 'På väg till lastning', at_pickup: 'På lastningsplats',
  loaded: 'Lastat', departed: 'Transport påbörjad', delivered: 'Levererat',
};

export default function DriverLogistics({ detail, busy, disabled, onAction }: {
  detail: LogisticsOrderDetail; busy: boolean; disabled: boolean;
  onAction: (command: LogisticsDriverCommand) => void;
}) {
  const [weights, setWeights] = useState(() => Object.fromEntries(detail.materialRows.map(row => [row.articleId, row.actualKg === undefined ? '' : String(row.actualKg)])));
  const [reviewed, setReviewed] = useState(false);
  const stage = detail.execution.stage;
  const document = detail.document;
  const hazardous = detail.materialRows.some(row => row.hazardous);
  const signature = document?.signatures.find(entry => entry.role === 'carrier' && entry.documentVersion === document.version && entry.documentHash === document.hash);
  const senderSignature = document?.signatures.find(entry => entry.role === 'sender' && entry.documentVersion === document.version && entry.documentHash === document.hash);
  const readyWeights = detail.materialRows.every(row => row.actualKg !== undefined && row.actualKg > 0);
  const departureMissing = [
    ...(!readyWeights ? ['Faktiska vikter'] : []),
    ...(hazardous && document?.status !== 'prepared' ? ['Förberett transportdokument'] : []),
    ...(hazardous && !senderSignature ? ['Avsändarens godkännande'] : []),
    ...(hazardous && !signature ? ['Transportörens godkännande'] : []),
    ...(!detail.execution.officeCleared ? ['Kontorets klartecken'] : []),
  ];
  function act(command: Omit<Extract<LogisticsDriverCommand, { action: 'travel.empty' | 'arrive' | 'depart' | 'deliver' }>, 'expectedVersion'>) {
    onAction({ ...command, expectedVersion: detail.version });
  }
  function load(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onAction({ action: 'load', expectedVersion: detail.version, rows: detail.materialRows.map(row => ({ articleId: row.articleId, actualKg: Number(weights[row.articleId]) })) });
  }
  return <section className="driver-logistics" aria-label="Transportens genomförande">
    <div className="driver-execution"><Truck size={18} /><strong>{stages[stage]}</strong>{hazardous && <span>Farligt avfall</span>}</div>
    <div className="driver-route"><div><MapPin size={16} /><span><small>Lastningsplats</small><strong>{detail.from.name}</strong>{detail.from.address}, {detail.from.postalCode} {detail.from.city}</span></div><div><MapPin size={16} /><span><small>Destination</small><strong>{detail.to.name}</strong>{detail.to.address}, {detail.to.postalCode} {detail.to.city}</span></div></div>
    {detail.handling && <div className="driver-order-notes"><span>Hantering</span><p>{detail.handling}</p></div>}
    {stage === 'pending' && <button className="driver-button primary" disabled={disabled} onClick={() => act({ action: 'travel.empty' })}><Truck size={18} />På väg till lastning</button>}
    {stage === 'travelling_empty' && <button className="driver-button primary" disabled={disabled} onClick={() => act({ action: 'arrive' })}><MapPin size={18} />Jag är på lastningsplatsen</button>}
    {['at_pickup', 'loaded'].includes(stage) && <form className="driver-weight-form" onSubmit={load}><h3><ClipboardCheck size={18} />Faktiskt lastade mängder</h3>{detail.materialRows.map(row => <label key={row.articleId}><span>{row.name}<small>{row.hazardous ? `Farligt avfall · ${row.wasteCode}` : 'Material'} · planerat {row.plannedKg.toLocaleString('sv-SE')} kg</small></span><span className="driver-weight-input"><input aria-label={`Lastad vikt ${row.name}`} type="number" required min="0.001" max="1000000000" step="0.001" inputMode="decimal" disabled={disabled} value={weights[row.articleId] ?? ''} onChange={event => setWeights(value => ({ ...value, [row.articleId]: event.target.value }))} />kg</span></label>)}<button className="driver-button primary" disabled={disabled}>{busy ? <LoaderCircle size={18} className="driver-spinner" /> : <CheckCircle2 size={18} />}Spara lastade vikter</button></form>}
    {document && <div className="driver-document-review"><h3><FileText size={18} />Transportdokument · version {document.version}</h3><span className="driver-eyebrow">TESTGODKÄNNANDE · DEMO</span><p>{document.snapshot.from.name} → {document.snapshot.to.name}</p>{document.snapshot.rows.map(row => <div className="driver-document-row" key={row.articleId}><span>{row.name}{row.hazardous && <small>{row.wasteCode}</small>}</span><strong>{row.actualKg?.toLocaleString('sv-SE') ?? 'Ej vägt'} kg</strong></div>)}{document.snapshot.handling && <p>{document.snapshot.handling}</p>}<div className="driver-document-checks"><span className={senderSignature ? 'complete' : ''}><ShieldCheck size={16} />Avsändare: {senderSignature ? 'godkänd version' : 'inväntar godkännande'}</span><span className={signature ? 'complete' : ''}><ShieldCheck size={16} />Transportör: {signature ? 'godkänd version' : 'inväntar godkännande'}</span></div>{!signature && document.status === 'prepared' && stage === 'loaded' && <><label className="driver-review-checkbox"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} disabled={disabled} />Jag har granskat transportuppgifterna för denna version.</label><button className="driver-button primary" disabled={disabled || !reviewed} onClick={() => onAction({ action: 'sign', expectedVersion: detail.version, documentVersion: document.version })}>Godkänn som transportör (demo)</button></>}</div>}
    {stage === 'loaded' && <><div className={`driver-readiness${departureMissing.length ? '' : ' complete'}`}><ShieldCheck size={19} /><div><strong>{departureMissing.length ? 'Innan transporten får starta' : 'Klart för transport'}</strong>{departureMissing.length ? <ul>{departureMissing.map(text => <li key={text}>{text}</li>)}</ul> : <p>Aktuella krav är uppfyllda.</p>}</div></div><button className="driver-button green" disabled={disabled || departureMissing.length > 0} onClick={() => act({ action: 'depart' })}><Truck size={18} />Påbörja transport med last</button></>}
    {stage === 'departed' && <button className="driver-button green" disabled={disabled} onClick={() => act({ action: 'deliver' })}><CheckCircle2 size={18} />Bekräfta leverans</button>}
    {stage === 'delivered' && <p className="driver-notice"><CheckCircle2 size={18} />Leveransen är registrerad.</p>}
  </section>;
}
