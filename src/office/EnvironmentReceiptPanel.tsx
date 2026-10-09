import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, FileText, Leaf, LockKeyhole, Save } from 'lucide-react';
import type { OfficeCard, OfficeCustomer, OfficeUser } from './model';
import { environmentApi } from './environment-client';
import type { EnvironmentalParty, EnvironmentalPlace, EnvironmentalReceipt, EnvironmentalTransportMode } from './environment-types';
import { environmentTime, environmentWeight, formatWasteCode, transportModeNames } from './environment-types';
import { EnvironmentAccessBoundary, environmentFailure, hasEnvironmentPermission, useEnvironmentSession } from './EnvironmentSession';
import './environment.css';

const blankPlace = (): EnvironmentalPlace => ({ address: '', postalCode: '', city: '', municipalityCode: '' });
const stockholmParts = (date: Date) => Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
function stockholmInput(date: Date) { const parts = stockholmParts(date); return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`; }
export function stockholmReceiptDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Ange datum och tid för den faktiska mottagningen.');
  const desired = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]);
  const parts = stockholmParts(new Date(desired));
  const viewed = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(desired - (viewed - desired)).toISOString();
}
function initialReceiptTime(card: OfficeCard) {
  const date = card.date.replace(' ', 'T');
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(date) ? date : stockholmInput(Number.isNaN(Date.parse(date)) ? new Date() : new Date(date));
}
function PlaceFields({ title, value, onChange, disabled }: { title: string; value: EnvironmentalPlace; onChange: (value: EnvironmentalPlace) => void; disabled: boolean }) {
  return <fieldset className="environment-fieldset"><legend>{title}</legend><div className="environment-form-grid"><label className="environment-full">Gatuadress *<input aria-label={`${title} – gatuadress`} disabled={disabled} maxLength={200} value={value.address} onChange={event => onChange({ ...value, address: event.target.value })} /></label><label>Postnummer *<input aria-label={`${title} – postnummer`} disabled={disabled} inputMode="numeric" maxLength={6} placeholder="761 41" value={value.postalCode} onChange={event => onChange({ ...value, postalCode: event.target.value })} /></label><label>Ort *<input aria-label={`${title} – ort`} disabled={disabled} maxLength={100} value={value.city} onChange={event => onChange({ ...value, city: event.target.value })} /></label><label className="environment-full">Kommunkod *<input aria-label={`${title} – kommunkod`} disabled={disabled} inputMode="numeric" maxLength={4} placeholder="0188 för Norrtälje" value={value.municipalityCode} onChange={event => onChange({ ...value, municipalityCode: event.target.value })} /></label></div></fieldset>;
}
export default function EnvironmentReceiptPanel({ card, customer, user, actualUser, onNotice, onRegistered }: { card: OfficeCard; customer?: OfficeCustomer; user: OfficeUser; actualUser: OfficeUser; onNotice: (message: string) => void; onRegistered?: (receipt: EnvironmentalReceipt) => void }) {
  const { state, refresh, session } = useEnvironmentSession();
  const sourceId = (card as OfficeCard & { sourceId?: string }).sourceId ?? '';
  const receipt = state?.receipts.find(item => item.sourceId === sourceId);
  const classifiedRows = card.rows.map(row => ({ ...row, classification: state?.classifications.find(item => item.articleId === row.articleId) })).filter(row => row.classification?.hazardous);
  const hazardousWeight = classifiedRows.reduce((sum, row) => sum + row.weight, 0);
  const [expanded, setExpanded] = useState(false);
  const [siteId, setSiteId] = useState(card.siteId ?? (card.yard.toLowerCase().includes('rimbo') ? 'rimbo' : 'norrtalje'));
  const [receivedAt, setReceivedAt] = useState(initialReceiptTime(card));
  const [party, setParty] = useState<EnvironmentalParty>({ name: '', number: '', contactName: '', email: '', phone: '' });
  const [lastPlace, setLastPlace] = useState(blankPlace);
  const [nextPlace, setNextPlace] = useState(blankPlace);
  const [transportMode, setTransportMode] = useState<EnvironmentalTransportMode>('road');
  const [documentReference, setDocumentReference] = useState('');
  const [missingReason, setMissingReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestKey = useRef(crypto.randomUUID());
  const receiptIdentity = `${sourceId}/${actualUser.id}/${user.id}`;
  const identityRef = useRef(receiptIdentity); identityRef.current = receiptIdentity;
  useEffect(() => {
    setSiteId(card.siteId ?? (card.yard.toLowerCase().includes('rimbo') ? 'rimbo' : 'norrtalje')); setReceivedAt(initialReceiptTime(card));
    setParty({ name: customer?.name ?? '', number: customer?.number ?? '', contactName: customer?.contactPerson ?? '', email: customer?.email ?? '', phone: customer?.phone ?? '' });
    setLastPlace({ address: card.origin || customer?.address || '', postalCode: customer?.postalCode ?? '', city: customer?.city ?? '', municipalityCode: '' });
    setNextPlace(blankPlace()); setDocumentReference(''); setMissingReason(''); setTransportMode('road'); setExpanded(false); setError(''); setBusy(false); requestKey.current = crypto.randomUUID();
  }, [receiptIdentity, customer?.id, card.id]);
  const site = state?.sites.find(item => item.id === siteId);
  useEffect(() => { if (site) setNextPlace({ address: site.address, postalCode: site.postalCode, city: site.city, municipalityCode: site.municipalityCode }); }, [siteId, site?.address, site?.postalCode, site?.city, site?.municipalityCode]);
  const reports = useMemo(() => state?.reports.filter(report => report.receiptId === receipt?.id) ?? [], [state?.reports, receipt?.id]);
  const editable = hasEnvironmentPermission(user, 'environmentWrite');
  async function receive() {
    if (!sourceId || busy || !editable) return;
    if (!party.name.trim() || !party.number.trim()) { setError('Ange tidigare innehavares namn och org-/personnummer.'); return; }
    for (const [name, place] of [['senaste', lastPlace], ['kommande', nextPlace]] as const) {
      if (!place.address.trim() || !place.city.trim() || !/^\d{5}$/.test(place.postalCode.replace(/\s/g, '')) || !/^\d{4}$/.test(place.municipalityCode)) { setError(`Komplettera ${name} hanteringsplats med gatuadress, ort, femsiffrigt postnummer och fyrsiffrig kommunkod.`); return; }
    }
    if (!documentReference.trim() && !missingReason.trim()) { setError('Ange transportdokumentets referens eller beskriv avvikelsen när det saknas.'); return; }
    const expectedIdentity = receiptIdentity;
    setBusy(true); setError('');
    try {
      const received = await environmentApi.receive({ sourceId, cardId: card.id, siteId, receivedAt: stockholmReceiptDate(receivedAt), rows: card.rows.map(row => ({ articleId: row.articleId, weight: row.weight })), previousHolder: party, lastPlace, nextPlace, transportMode, incomingDocument: documentReference.trim() ? { reference: documentReference.trim() } : { missingReason: missingReason.trim() }, idempotencyKey: requestKey.current });
      if (identityRef.current !== expectedIdentity) return;
      await refresh(); setExpanded(false); onRegistered?.(received);
      onNotice(`Mottagning registrerad för INV-${received.cardId}. Miljöunderlag och lagerrörelse är sparade.`);
    } catch (failure) { if (identityRef.current === expectedIdentity) setError(environmentFailure(failure)); }
    finally { if (identityRef.current === expectedIdentity) setBusy(false); }
  }
  return <section className="office-panel environment-panel environment-receipt-panel" aria-label="Miljö och mottagning">
    <header className="environment-heading"><span className="environment-icon"><Leaf size={22} /></span><div><h2>Miljö & mottagning</h2><p>Faktisk mottagning sparas separat från kundgodkännande och ekonomi.</p></div>{session && (receipt || classifiedRows.length > 0) && <button type="button" className="environment-toggle" aria-expanded={expanded} aria-label={expanded ? 'Dölj mottagningsuppgifter' : 'Visa mottagningsuppgifter'} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronUp size={19} /> : <ChevronDown size={19} />}</button>}</header>
    <EnvironmentAccessBoundary>{!state ? <p>Hämtar miljöuppgifter…</p> : !receipt && classifiedRows.length === 0 ? <p className="environment-muted">Ingen artikel på kortet är klassificerad som farligt avfall. Ingen miljömottagning krävs här.</p> : receipt ? <><div className="environment-receipt-summary"><div><span className="environment-pill success"><CheckCircle2 size={14} />Mottagning registrerad</span><small>{environmentTime(receipt.receivedAt)} · {state.sites.find(item => item.id === receipt.siteId)?.name}</small></div><div><strong>{environmentWeight(receipt.snapshot.rows.filter(row => row.classification.hazardous).reduce((sum, row) => sum + row.weight, 0))}</strong><small>{receipt.snapshot.rows.filter(row => row.classification.hazardous).map(row => `${row.classification.wasteDescription} · ${formatWasteCode(row.classification.wasteCode)}`).join(', ')}</small></div><div><span className="environment-pill">Förberett – ej skickat</span><small>{reports.length} miljöunderlag · originalversion {receipt.version}</small></div></div>
      {receipt.deviations.map(deviation => <div className="environment-alert" key={deviation.code}><CircleAlert size={16} />{deviation.message}</div>)}
      {expanded && <div className="environment-receipt-original"><dl><div><dt>Registrerad av</dt><dd>{receipt.createdBy} · {environmentTime(receipt.createdAt)}</dd></div><div><dt>Tidigare innehavare</dt><dd>{receipt.snapshot.previousHolder.name} · {receipt.snapshot.previousHolder.number}</dd></div><div><dt>Senaste hanteringsplats</dt><dd>{receipt.snapshot.lastPlace.address}, {receipt.snapshot.lastPlace.postalCode} {receipt.snapshot.lastPlace.city}</dd></div><div><dt>Kommande hanteringsplats</dt><dd>{receipt.snapshot.nextPlace.address}, {receipt.snapshot.nextPlace.postalCode} {receipt.snapshot.nextPlace.city}</dd></div><div><dt>Transportsätt</dt><dd>{transportModeNames[receipt.snapshot.transportMode]}</dd></div><div><dt>Transportdokument</dt><dd>{receipt.snapshot.incomingDocument.reference || receipt.snapshot.incomingDocument.missingReason || 'Saknas – avvikelse registrerad'}</dd></div></dl><small><LockKeyhole size={12} />Oföränderligt original · {receipt.id} · Kontrollsumma {receipt.hash.slice(0, 12)}</small></div>}
    </> : <><div className="environment-receipt-summary"><div><span className="environment-pill warning">Inväntar mottagningsbekräftelse</span><small>Underlag och inkommande lager skapas en gång.</small></div><div><strong>{environmentWeight(hazardousWeight)}</strong><small>{classifiedRows.map(row => formatWasteCode(row.classification!.wasteCode)).join(', ')}</small></div>{editable && <button type="button" className="office-btn outline" onClick={() => setExpanded(value => !value)}><FileText size={14} />{expanded ? 'Dölj uppgifter' : 'Registrera mottagning'}</button>}</div>
      {expanded && <div className="environment-receipt-editor"><div className="environment-form-grid"><label>Anläggning *<select aria-label="Mottagande anläggning" disabled={busy || !editable} value={siteId} onChange={event => setSiteId(event.target.value)}>{state.sites.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label><label>Faktiskt mottaget *<input aria-label="Faktiskt mottaget" disabled={busy || !editable} type="datetime-local" value={receivedAt} onChange={event => setReceivedAt(event.target.value)} /><small>Svensk tid · Europe/Stockholm</small></label></div>
        <fieldset className="environment-fieldset"><legend>Tidigare innehavare</legend><p>Den som lämnade avfallet kan vara en annan än betalningskunden.</p><div className="environment-form-grid"><label>Namn *<input aria-label="Tidigare innehavare – namn" disabled={busy || !editable} value={party.name} onChange={event => setParty({ ...party, name: event.target.value })} maxLength={200} /></label><label>Org-/personnummer *<input aria-label="Tidigare innehavare – organisationsnummer" disabled={busy || !editable} value={party.number} onChange={event => setParty({ ...party, number: event.target.value })} maxLength={30} /></label><label>Kontaktperson<input aria-label="Tidigare innehavare – kontaktperson" disabled={busy || !editable} value={party.contactName} onChange={event => setParty({ ...party, contactName: event.target.value })} maxLength={100} /></label><label>Telefon<input aria-label="Tidigare innehavare – telefon" disabled={busy || !editable} type="tel" value={party.phone} onChange={event => setParty({ ...party, phone: event.target.value })} maxLength={50} /></label><label className="environment-full">E-post<input aria-label="Tidigare innehavare – e-post" disabled={busy || !editable} type="email" value={party.email} onChange={event => setParty({ ...party, email: event.target.value })} maxLength={254} /></label></div></fieldset>
        <div className="environment-places"><PlaceFields title="Senaste hanteringsplats" disabled={busy || !editable} value={lastPlace} onChange={setLastPlace} /><PlaceFields title="Kommande hanteringsplats" disabled={busy || !editable} value={nextPlace} onChange={setNextPlace} /></div>
        <div className="environment-form-grid"><label>Transportsätt *<select aria-label="Transportsätt" disabled={busy || !editable} value={transportMode} onChange={event => setTransportMode(event.target.value as EnvironmentalTransportMode)}>{Object.entries(transportModeNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Inkommande transportdokument<input aria-label="Inkommande transportdokument" disabled={busy || !editable} placeholder="Dokumentnummer eller befintlig dokumentreferens" value={documentReference} onChange={event => setDocumentReference(event.target.value)} maxLength={200} /></label>{!documentReference.trim() && <label className="environment-full">Avvikelse när dokument saknas<textarea aria-label="Avvikelse när transportdokument saknas" disabled={busy || !editable} placeholder="Beskriv vad som saknas och hur det följs upp" rows={2} maxLength={1000} value={missingReason} onChange={event => setMissingReason(event.target.value)} /><small>Avvikelsen sparas. Ett komplett mottagningsunderlag kan ändå förberedas.</small></label>}</div>
        {!sourceId && <div className="environment-error" role="alert">Kortet saknar ett stabilt käll-ID. Ladda om kontoret innan du registrerar mottagningen.</div>}{error && <div className="environment-error" role="alert">{error}</div>}
        <div className="environment-actions"><small>Bekräfta verkligt mottagen mängd. Prisändringar ändrar inte lagret.</small><button type="button" className="office-btn" disabled={busy || !editable || !sourceId} onClick={() => void receive()}><Save size={14} />{busy ? 'Registrerar…' : 'Bekräfta mottagning'}</button></div>
      </div>}
    </>}</EnvironmentAccessBoundary>
  </section>;
}
