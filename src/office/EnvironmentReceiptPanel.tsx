import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, FileText, Leaf, LockKeyhole, Pencil, Save, X } from 'lucide-react';
import { articles, demoPrivateIdentityNumber } from '../data';
import type { OfficeCard, OfficeCustomer, OfficeUser } from './model';
import { environmentApi } from './environment-client';
import type { EnvironmentalAddressResolution, EnvironmentalDraftInput, EnvironmentalParty, EnvironmentalPlace, EnvironmentalReceipt, EnvironmentalReceiptInput, EnvironmentalStorageAssessment, EnvironmentalTransportMode, IncomingEnvironmentalDocument } from './environment-types';
import { environmentTime, environmentWeight, formatWasteCode, transportModeNames } from './environment-types';
import { EnvironmentAccessBoundary, environmentFailure, hasEnvironmentPermission, useEnvironmentSession } from './EnvironmentSession';
import StorageAssessmentSummary from './StorageAssessmentSummary';
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
function receiptTimeLabel(value: string) { try { return environmentTime(stockholmReceiptDate(value)); } catch { return 'Datum och tid behöver kompletteras'; } }
type ReceiptForm = {
  siteId: string; receivedAt: string; previousHolder: EnvironmentalParty; originAddress: string;
  lastPlace: EnvironmentalPlace; nextPlace: EnvironmentalPlace; transportMode: EnvironmentalTransportMode;
  incomingDocument: IncomingEnvironmentalDocument; addressResolution: EnvironmentalAddressResolution;
};
type EditSection = 'holder' | 'origin' | 'site' | 'time' | null;
const materialName = (articleId: string) => articles.find(article => article.id === articleId)?.name ?? articleId;
const rowSignature = (rows: { articleId: string; weight: number }[]) => {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.articleId, (totals.get(row.articleId) ?? 0) + Math.round(row.weight * 1000));
  return JSON.stringify([...totals].sort(([first], [second]) => first.localeCompare(second)));
};
function newForm(card: OfficeCard, customer?: OfficeCustomer): ReceiptForm {
  return {
    siteId: card.siteId ?? (card.yard.toLowerCase().includes('rimbo') ? 'rimbo' : 'norrtalje'), receivedAt: initialReceiptTime(card),
    previousHolder: { name: customer?.name ?? '', number: customer?.id === 'customer-erik' && customer.number === 'Demo · privatperson' ? demoPrivateIdentityNumber : customer?.number ?? '', contactName: customer?.contactPerson ?? '', email: customer?.email ?? '', phone: customer?.phone ?? '' },
    originAddress: card.origin || '', lastPlace: blankPlace(), nextPlace: blankPlace(), transportMode: 'road', incomingDocument: { status: 'unknown', reference: '' },
    addressResolution: { originAddress: card.origin || '', status: 'needs_address', provider: 'unresolved' },
  };
}
function fromInput(input: EnvironmentalDraftInput, fallback: ReceiptForm): ReceiptForm {
  return {
    siteId: input.siteId, receivedAt: input.receivedAt ? stockholmInput(new Date(input.receivedAt)) : fallback.receivedAt, previousHolder: { ...fallback.previousHolder, ...input.previousHolder },
    originAddress: input.originAddress, lastPlace: { ...fallback.lastPlace, ...input.lastPlace }, nextPlace: { ...fallback.nextPlace, ...input.nextPlace },
    transportMode: input.transportMode ?? fallback.transportMode, incomingDocument: { status: 'unknown', ...input.incomingDocument },
    addressResolution: input.addressResolution ?? { originAddress: input.originAddress, status: 'needs_address', provider: 'unresolved' },
  };
}
function validPlace(place: EnvironmentalPlace) { return Boolean(place.address.trim() && place.city.trim() && /^\d{5}$/.test(place.postalCode.replace(/\s/g, '')) && /^\d{4}$/.test(place.municipalityCode)); }
function validHolderNumber(number: string) { return /^(?:\d{10}|\d{12}|[A-Z]{2}[A-Z0-9]{2,30})$/.test(number.trim().replace(/[\s-]/g, '')); }
const holderNumberMessage = 'Ange ett giltigt org-/personnummer med 10 eller 12 siffror, eller ett utländskt nummer med landskod.';
function Fact({ title, children, editor = false }: { title: string; children: ReactNode; editor?: boolean }) { return <div className={editor ? 'environment-row-editor' : undefined}><dt>{title}</dt><dd>{children}</dd></div>; }
function Materials({ rows }: { rows: { articleId: string; weight: number }[] }) { return <div className="environment-material-lines">{rows.map((row, index) => <span key={`${row.articleId}/${index}`}><strong>{materialName(row.articleId)}</strong><b>{environmentWeight(row.weight)}</b></span>)}</div>; }

export default function EnvironmentReceiptPanel({ card, customer, user, actualUser, onNotice, onRegistered, onOriginChange, canChangeOrigin = false, guidance, onGuidanceState }: {
  card: OfficeCard; customer?: OfficeCustomer; user: OfficeUser; actualUser: OfficeUser;
  onNotice: (message: string) => void; onRegistered?: (receipt: EnvironmentalReceipt) => void;
  onOriginChange?: (origin: string) => boolean; canChangeOrigin?: boolean;
  guidance?: 'focus' | 'muted'; onGuidanceState?: (state: { visible: boolean; received: boolean; canConfirm: boolean }) => void;
}) {
  const { state, refresh, session } = useEnvironmentSession();
  const sourceId = card.sourceId ?? '';
  const receipt = state?.receipts.find(item => item.sourceId === sourceId);
  const draft = state?.drafts.find(item => item.sourceId === sourceId);
  // A receipt freezes the classification. Later catalogue changes must not
  // remove a previously received hazardous article from its correction flow.
  const classifiedRows = card.rows.map(row => ({ ...row, classification: receipt?.snapshot.rows.find(item => item.articleId === row.articleId)?.classification ?? state?.classifications.find(item => item.articleId === row.articleId) })).filter(row => row.classification?.hazardous);
  const recordedHazardousRows = receipt?.snapshot.rows.filter(row => row.classification.hazardous) ?? [];
  const hazardousWeight = classifiedRows.reduce((sum, row) => sum + row.weight, 0);
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState<ReceiptForm>(() => newForm(card, customer));
  const [editSection, setEditSection] = useState<EditSection>(null);
  const [originEdit, setOriginEdit] = useState(card.origin || '');
  const [showContacts, setShowContacts] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correctionReason, setCorrectionReason] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState('');
  const [dirty, setDirty] = useState(false);
  const [storagePreview, setStoragePreview] = useState<{ key: string; assessment?: EnvironmentalStorageAssessment; error?: string }>();
  const requestKey = useRef(crypto.randomUUID());
  const dirtyRef = useRef(false);
  const hydratedRef = useRef('');
  const draftVersionRef = useRef(0);
  const addressRequestRef = useRef(0);
  const previousCustomerRef = useRef(customer);
  const receiptIdentity = `${sourceId}/${actualUser.id}/${user.id}`;
  const identityRef = useRef(receiptIdentity); identityRef.current = receiptIdentity;
  const dialogRef = useRef<HTMLElement>(null);
  const editable = hasEnvironmentPermission(user, 'environmentWrite');
  const guidanceVisible = Boolean(state && (recordedHazardousRows.length > 0 || classifiedRows.length > 0));
  const received = Boolean(receipt);
  const canConfirm = guidanceVisible && !received && editable && Boolean(session && sourceId);
  const editing = !receipt || correcting;
  const storageKey = `${receiptIdentity}/${form.siteId}/${rowSignature(classifiedRows)}/${state?.revision ?? ''}/${correcting ? receipt?.id : ''}/${receipt?.version ?? 0}`;
  const storageAssessment = editing ? storagePreview?.key === storageKey ? storagePreview.assessment : undefined : receipt?.snapshot.storageAssessment;
  const storageError = editing && storagePreview?.key === storageKey ? storagePreview.error ?? '' : '';
  const storageLoading = Boolean(editing && guidanceVisible && session && !storageAssessment && !storageError);
  const reports = useMemo(() => state?.reports.filter(report => report.receiptId === receipt?.id) ?? [], [state?.reports, receipt?.id]);
  const site = state?.sites.find(item => item.id === form.siteId);
  const cardDiffers = Boolean(receipt && (rowSignature(classifiedRows) !== rowSignature(recordedHazardousRows) || card.origin.trim() !== (receipt.snapshot.originAddress ?? receipt.snapshot.lastPlace.address).trim()));
  const snapshotForm = (value: EnvironmentalReceipt) => fromInput({ ...value.snapshot, originAddress: value.snapshot.originAddress ?? value.snapshot.lastPlace.address }, newForm(card, customer));

  function updateForm(updater: (previous: ReceiptForm) => ReceiptForm) { dirtyRef.current = true; setDirty(true); setError(''); setForm(updater); }
  useEffect(() => { onGuidanceState?.({ visible: guidanceVisible, received, canConfirm }); }, [onGuidanceState, guidanceVisible, received, canConfirm]);
  useEffect(() => {
    setForm(newForm(card, customer)); setOriginEdit(card.origin || ''); setExpanded(false); setEditSection(null); setCorrecting(false); setCorrectionReason(''); setConfirmOpen(false); setShowContacts(false); setError(''); setSavedAt(''); setBusy(false);
    dirtyRef.current = false; setDirty(false); hydratedRef.current = ''; draftVersionRef.current = 0; requestKey.current = crypto.randomUUID();
  }, [receiptIdentity]);
  useEffect(() => {
    if (!state || correcting) return;
    const key = receipt ? `receipt/${receipt.id}/${receipt.version}` : draft ? `draft/${draft.version}` : 'initial';
    if (hydratedRef.current === key || dirtyRef.current) return;
    if (receipt) setForm(snapshotForm(receipt));
    else if (draft) {
      const loaded = fromInput(draft.input, newForm(card, customer));
      if (loaded.previousHolder.name === 'Erik Johansson' && loaded.previousHolder.number === 'Demo · privatperson') loaded.previousHolder = { ...loaded.previousHolder, number: demoPrivateIdentityNumber };
      // The weighing card remains the source even if another cashier changed it after this draft was saved.
      setForm(loaded.originAddress === (card.origin || '') ? loaded : { ...loaded, originAddress: card.origin || '', lastPlace: blankPlace(), addressResolution: { originAddress: card.origin || '', status: 'needs_address', provider: 'unresolved' } });
      setSavedAt(draft.updatedAt);
    }
    else setForm(newForm(card, customer));
    draftVersionRef.current = draft?.version ?? 0; hydratedRef.current = key;
  }, [state, receipt, draft, correcting]);
  useEffect(() => {
    if (!editing) return;
    setForm(previous => previous.originAddress === (card.origin || '') ? previous : { ...previous, originAddress: card.origin || '', addressResolution: { originAddress: card.origin || '', status: 'needs_address', provider: 'unresolved' }, lastPlace: blankPlace() });
    setOriginEdit(card.origin || '');
  }, [card.origin, receiptIdentity, editing]);
  useEffect(() => {
    const previousCustomer = previousCustomerRef.current; previousCustomerRef.current = customer;
    if (!editing || receipt || previousCustomer?.id === customer?.id) return;
    setForm(previous => {
      const holder = previous.previousHolder;
      if ((holder.name && holder.name !== previousCustomer?.name) || (holder.number && holder.number !== previousCustomer?.number)) return previous;
      return { ...previous, previousHolder: newForm(card, customer).previousHolder };
    });
  }, [customer, editing, receipt]);
  useEffect(() => {
    if (!editing || !site) return;
    setForm(previous => ({ ...previous, nextPlace: { address: site.address, postalCode: site.postalCode, city: site.city, municipalityCode: site.municipalityCode } }));
  }, [editing, site?.id, site?.address, site?.postalCode, site?.city, site?.municipalityCode]);
  useEffect(() => {
    if (!session || !state || !editing || !guidanceVisible || !form.originAddress.trim()) { setResolving(false); return; }
    const expectedIdentity = receiptIdentity; const requestNumber = ++addressRequestRef.current; let active = true;
    setResolving(true);
    const timer = window.setTimeout(() => {
      void environmentApi.resolveAddress({ siteId: form.siteId, originAddress: form.originAddress }).then(result => {
        if (!active || identityRef.current !== expectedIdentity || addressRequestRef.current !== requestNumber) return;
        setForm(previous => previous.originAddress.trim() !== result.originAddress.trim() || (previous.addressResolution.municipalityConfirmed && previous.addressResolution.status === 'resolved') ? previous : { ...previous, lastPlace: result.place, addressResolution: { originAddress: result.originAddress, status: result.status, provider: result.provider, resolvedAt: result.resolvedAt, municipalityConfirmed: result.municipalityConfirmed } });
      }).catch(failure => { if (active && identityRef.current === expectedIdentity && addressRequestRef.current === requestNumber) setError(environmentFailure(failure)); }).finally(() => { if (active && identityRef.current === expectedIdentity && addressRequestRef.current === requestNumber) setResolving(false); });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [receiptIdentity, session?.actualUserId, Boolean(state), editing, guidanceVisible, form.originAddress, form.siteId]);
  useEffect(() => {
    if (!session || !state || !editing || !guidanceVisible) return;
    const controller = new AbortController(); const expectedIdentity = receiptIdentity;
    const timer = window.setTimeout(() => {
      void environmentApi.checkStorage({ siteId: form.siteId, materialScope: 'hazardous', rows: classifiedRows.map(row => ({ articleId: row.articleId, weight: row.weight })), ...(correcting && receipt ? { receiptId: receipt.id } : {}) }, controller.signal)
        .then(assessment => { if (!controller.signal.aborted && identityRef.current === expectedIdentity) setStoragePreview({ key: storageKey, assessment }); })
        .catch(failure => { if (!controller.signal.aborted && identityRef.current === expectedIdentity) setStoragePreview({ key: storageKey, error: environmentFailure(failure) }); });
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [storageKey, session?.actualUserId, session?.effectiveUserId, editing, guidanceVisible]);
  useEffect(() => {
    if (!confirmOpen) return;
    const previousFocus = document.activeElement;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) setConfirmOpen(false); };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, [confirmOpen, busy]);

  function buildInput(): Omit<EnvironmentalReceiptInput, 'idempotencyKey' | 'expectedDraftVersion'> {
    return { sourceId, cardId: card.id, siteId: form.siteId, materialScope: 'hazardous', receivedAt: stockholmReceiptDate(form.receivedAt), originAddress: form.originAddress, rows: classifiedRows.map(row => ({ articleId: row.articleId, weight: row.weight })), previousHolder: form.previousHolder, lastPlace: form.lastPlace, nextPlace: form.nextPlace, transportMode: form.transportMode, incomingDocument: form.incomingDocument, addressResolution: form.addressResolution };
  }
  function validateConfirmation() {
    if (!form.previousHolder.name.trim() || !form.previousHolder.number.trim()) return 'Komplettera tidigare innehavare med namn och org-/personnummer.';
    if (!validHolderNumber(form.previousHolder.number)) return holderNumberMessage;
    if (!form.originAddress.trim() || form.addressResolution.status !== 'resolved' || !validPlace(form.lastPlace)) return 'Komplettera ursprungsadressen eller välj rätt kommun. Övriga adressuppgifter hämtas automatiskt.';
    if (!validPlace(form.nextPlace)) return 'Mottagande anläggning saknar fullständig adress. Komplettera anläggningens uppgifter.';
    if (form.incomingDocument.status === 'missing' && !form.incomingDocument.missingReason?.trim()) return 'Beskriv avvikelsen när ett obligatoriskt transportdokument saknas.';
    if (form.incomingDocument.status === 'not_required' && !form.incomingDocument.exemptionReason?.trim()) return 'Ange varför transportdokument inte krävs i detta fall.';
    if (correcting && !correctionReason.trim()) return 'Beskriv varför miljöuppgifterna ska rättas.';
    try { stockholmReceiptDate(form.receivedAt); } catch (failure) { return environmentFailure(failure); }
    if (storageLoading) return 'Invänta kontrollen av anläggningens lagringsregler.';
    if (storageError) return storageError;
    if (!storageAssessment?.canReceive) return storageAssessment?.checks.find(check => check.severity === 'blocked')?.message ?? 'Lagringskontrollen behöver slutföras före mottagningen.';
    return '';
  }
  async function resolveMunicipality(code: string) {
    if (!code || busy) return;
    const expectedIdentity = receiptIdentity; const requestNumber = ++addressRequestRef.current; setResolving(true); setError('');
    try {
      const result = await environmentApi.resolveAddress({ siteId: form.siteId, originAddress: form.originAddress, municipalityCode: code });
      if (identityRef.current !== expectedIdentity || addressRequestRef.current !== requestNumber) return;
      updateForm(previous => ({ ...previous, lastPlace: result.place, addressResolution: { originAddress: result.originAddress, status: result.status, provider: result.provider, resolvedAt: result.resolvedAt, municipalityConfirmed: result.municipalityConfirmed } }));
    } catch (failure) { if (identityRef.current === expectedIdentity && addressRequestRef.current === requestNumber) setError(environmentFailure(failure)); }
    finally { if (identityRef.current === expectedIdentity && addressRequestRef.current === requestNumber) setResolving(false); }
  }
  function saveOrigin() {
    if (!canChangeOrigin || !onOriginChange) return;
    const address = originEdit.trim();
    if (!address) { setError('Ange gatuadress, postnummer och ort där materialet kommer ifrån.'); return; }
    if (!onOriginChange(address)) return;
    updateForm(previous => ({ ...previous, originAddress: address, lastPlace: blankPlace(), addressResolution: { originAddress: address, status: 'needs_address', provider: 'unresolved' } }));
    setEditSection(null);
  }
  async function saveDraft() {
    if (!sourceId || busy || !editable) return;
    const expectedIdentity = receiptIdentity; setBusy(true); setError('');
    try {
      const saved = await environmentApi.saveDraft(sourceId, { expectedVersion: draftVersionRef.current, input: { ...buildInput(), originAddress: form.originAddress } });
      if (identityRef.current !== expectedIdentity) return;
      draftVersionRef.current = saved.version; hydratedRef.current = `draft/${saved.version}`; dirtyRef.current = false; setDirty(false); setSavedAt(saved.updatedAt); await refresh();
      onNotice('Miljöutkast sparat. Inget lager har registrerats genom att spara utkastet.');
    } catch (failure) { if (identityRef.current === expectedIdentity) setError(environmentFailure(failure)); }
    finally { if (identityRef.current === expectedIdentity) setBusy(false); }
  }
  function openConfirmation() { const validation = validateConfirmation(); if (validation) { setError(validation); return; } setError(''); setConfirmOpen(true); }
  async function receive() {
    if (!sourceId || busy || !editable) return;
    const validation = validateConfirmation(); if (validation) { setError(validation); setConfirmOpen(false); return; }
    const expectedIdentity = receiptIdentity; setBusy(true); setError('');
    try {
      const input = buildInput();
      const received = correcting && receipt
        ? await environmentApi.correct(receipt.id, { ...input, expectedVersion: receipt.version, reason: correctionReason.trim(), idempotencyKey: requestKey.current })
        : await environmentApi.receive({ ...input, expectedDraftVersion: draftVersionRef.current, idempotencyKey: requestKey.current });
      if (identityRef.current !== expectedIdentity) return;
      dirtyRef.current = false; setDirty(false); setCorrecting(false); setConfirmOpen(false); setEditSection(null); setForm(snapshotForm(received)); await refresh();
      if (identityRef.current !== expectedIdentity) return;
      setExpanded(false); onRegistered?.(received);
      onNotice(correcting ? `Miljömottagning rättad till version ${received.version}. Original och lagerjustering är sparade.` : `Mottagning registrerad för INV-${received.cardId}. Miljöunderlag och lagerrörelse är sparade.`);
    } catch (failure) { if (identityRef.current === expectedIdentity) setError(environmentFailure(failure)); }
    finally { if (identityRef.current === expectedIdentity) setBusy(false); }
  }
  function beginCorrection() {
    if (!receipt || !editable) return;
    const originalForm = snapshotForm(receipt);
    setForm(originalForm.originAddress === (card.origin || '') ? originalForm : { ...originalForm, originAddress: card.origin || '', addressResolution: { originAddress: card.origin || '', status: 'needs_address', provider: 'unresolved' }, lastPlace: blankPlace() });
    setCorrecting(true); setExpanded(true); setEditSection(null); setCorrectionReason(''); setError(''); dirtyRef.current = true; setDirty(true); requestKey.current = crypto.randomUUID();
  }
  const display = editing ? form : receipt ? snapshotForm(receipt) : form;
  const rowsShown = editing ? classifiedRows : recordedHazardousRows;
  const municipality = state?.municipalities.find(item => item.code === display.lastPlace.municipalityCode);
  const status = display.incomingDocument.status ?? (display.incomingDocument.reference ? 'provided' : display.incomingDocument.missingReason ? 'missing' : 'unknown');
  function editButton(section: Exclude<EditSection, null>, label: string, allowed = true) {
    return editing && editable && allowed && <button type="button" className="office-link environment-inline-edit" aria-label={label} disabled={busy} onClick={() => { setEditSection(previous => previous === section ? null : section); if (section === 'origin') setOriginEdit(card.origin || ''); }}><Pencil size={12} />Ändra</button>;
  }

  if (state && !guidanceVisible) return null;

  return <section className={`office-panel environment-panel environment-receipt-panel${guidance ? ` office-guidance-${guidance}` : ''}`} aria-label="Miljö och mottagning">
    <header className="environment-heading"><span className="environment-icon"><Leaf size={22} /></span><div><h2>Miljö & mottagning</h2><p>Farligt avfall och ursprung hämtas från viktkortet. Mottagningen sparas separat från kundgodkännandet.</p></div>{session && guidanceVisible && <button type="button" className="environment-toggle" aria-expanded={expanded} aria-label={expanded ? 'Dölj mottagningsuppgifter' : 'Visa mottagningsuppgifter'} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronUp size={19} /> : <ChevronDown size={19} />}</button>}</header>
    <EnvironmentAccessBoundary>{!state ? <p>Hämtar miljöuppgifter…</p> : <>
      <div className="environment-receipt-summary"><div><span className={`environment-pill ${receipt && !correcting ? 'success' : 'warning'}`}>{receipt && !correcting && <CheckCircle2 size={14} />}{correcting ? 'Miljörättelse · utkast' : receipt ? 'Mottagning registrerad' : draft ? 'Utkast sparat' : 'Inväntar mottagningsbekräftelse'}</span><small>{receipt ? `${environmentTime(receipt.receivedAt)} · ${state.sites.find(item => item.id === receipt.siteId)?.name}` : 'Ingen lagerregistrering förrän mottagningen bekräftas.'}</small></div><div><strong>{environmentWeight(receipt && !correcting ? recordedHazardousRows.reduce((sum, row) => sum + row.weight, 0) : hazardousWeight)}</strong><small>{receipt && !correcting ? `Version ${receipt.version} · ${reports.length} miljöunderlag · ej skickat` : classifiedRows.map(row => formatWasteCode(row.classification!.wasteCode)).join(', ') || 'Registrerad lagring'}</small></div><button type="button" className="office-btn outline" onClick={() => setExpanded(value => !value)}><FileText size={14} />{expanded ? 'Dölj uppgifter' : 'Visa uppgifter'}</button></div>
      <StorageAssessmentSummary assessment={storageAssessment} loading={storageLoading} error={storageError} detailed={expanded} recorded={!editing} />
      {receipt && !correcting && receipt.deviations.map(deviation => <div className="environment-alert" key={deviation.code}><CircleAlert size={16} />{deviation.message}</div>)}
      {cardDiffers && !correcting && <div className="environment-alert"><CircleAlert size={16} /><span>Viktkortet har ändrats. Material, vikt eller ursprungsadress skiljer sig från den registrerade miljömottagningen. Granska uppgifterna och gör en spårbar miljörättelse.</span>{editable && <button type="button" className="office-link" onClick={beginCorrection}>Rätta miljöuppgifter</button>}</div>}
      {expanded && <div className="environment-receipt-editor environment-compact-editor">
        <dl className="environment-compact-facts">
          <Fact title="Material & vikt"><Materials rows={rowsShown} /><small>{editing ? 'Hämtas från viktkortet. Granska faktiska mängder före bekräftelse.' : 'Mängderna i den här registrerade versionen.'}</small></Fact>
          <Fact title="Tidigare innehavare"><strong>{display.previousHolder.name || 'Kund/innehavare saknas'}</strong><span className="environment-fact-secondary">{display.previousHolder.number || 'Org-/personnummer saknas'}</span>{editButton('holder', 'Ändra tidigare innehavare')}</Fact>
          {editSection === 'holder' && editing && <Fact title="Ändra innehavare" editor><div className="environment-form-grid"><label>Namn *<input aria-label="Tidigare innehavare – namn" disabled={busy} maxLength={200} value={form.previousHolder.name} onChange={event => updateForm(previous => ({ ...previous, previousHolder: { ...previous.previousHolder, name: event.target.value } }))} /></label><label>Org-/personnummer *<input aria-label="Tidigare innehavare – organisationsnummer" disabled={busy} maxLength={30} value={form.previousHolder.number} onChange={event => updateForm(previous => ({ ...previous, previousHolder: { ...previous.previousHolder, number: event.target.value } }))} /></label></div><small>Den som lämnade avfallet kan vara en annan än betalningskunden.</small><button type="button" className="office-link" onClick={() => setEditSection(null)}>Klart</button></Fact>}
          <Fact title="Ursprung"><strong>{display.originAddress || 'Ursprungsadress saknas på viktkortet'}</strong><span className="environment-fact-secondary">{editing && resolving ? 'Kontrollerar adress…' : `${municipality?.name || (display.lastPlace.municipalityCode ? 'Kommun' : 'Kommun behöver kompletteras')}${display.lastPlace.municipalityCode ? ` · ${display.lastPlace.municipalityCode}` : ''}`}</span>{editButton('origin', 'Ändra ursprungsadress', canChangeOrigin)}</Fact>
          {editSection === 'origin' && editing && <Fact title="Gemensam adress" editor><div className="environment-form-grid"><label className="environment-full">Ursprungsadress<input aria-label="Ursprungsadress för materialet" disabled={busy || !canChangeOrigin} maxLength={300} placeholder="Gatuadress, postnummer och ort" value={originEdit} onChange={event => setOriginEdit(event.target.value)} /><small>Uppdaterar samma ursprungsadress på viktkortet.</small></label></div><button type="button" className="office-btn outline" disabled={busy || !canChangeOrigin} onClick={saveOrigin}>Spara ursprungsadress</button></Fact>}
          {editing && form.originAddress && form.addressResolution.status !== 'resolved' && <Fact title="Komplettera ursprung" editor>{form.addressResolution.status === 'needs_address' ? <p>Adressen behöver gatuadress, postnummer och ort.{canChangeOrigin ? ' Ändra ursprungsadressen ovan.' : ' En behörig kollega behöver komplettera ursprungsadressen på viktkortet.'}</p> : <><label>Kommun för ursprungsadressen<select aria-label="Kommun för ursprungsadressen" disabled={busy || resolving || !editable} value={form.lastPlace.municipalityCode} onChange={event => void resolveMunicipality(event.target.value)}><option value="">Välj kommun…</option>{state.municipalities.map(option => <option key={option.code} value={option.code}>{option.name}</option>)}</select></label><small>Adressen kunde läsas, men kommunen behöver bekräftas.</small></>}</Fact>}
          <Fact title="Mottagning"><strong>{state.sites.find(item => item.id === display.siteId)?.name || display.siteId}</strong><span className="environment-fact-secondary">{display.nextPlace.address}{display.nextPlace.postalCode && `, ${display.nextPlace.postalCode} ${display.nextPlace.city}`}</span>{editButton('site', 'Ändra mottagande anläggning', !receipt)}</Fact>
          {editSection === 'site' && editing && <Fact title="Anläggning" editor><label>Mottagande anläggning<select aria-label="Mottagande anläggning" disabled={busy || Boolean(receipt)} value={form.siteId} onChange={event => updateForm(previous => ({ ...previous, siteId: event.target.value }))}>{state.sites.map(option => <option key={option.id} value={option.id} disabled={!option.active}>{option.name}{!option.active ? " · Avaktiverad" : ""}</option>)}</select></label><small>Platsens adress hämtas från anläggningen.</small><button type="button" className="office-link" onClick={() => setEditSection(null)}>Klart</button></Fact>}
          <Fact title="Faktiskt mottaget"><strong>{receiptTimeLabel(display.receivedAt)}</strong><span className="environment-fact-secondary">Svensk tid · Europe/Stockholm</span>{editButton('time', 'Ändra mottagningstid')}</Fact>
          {editSection === 'time' && editing && <Fact title="Mottagningstid" editor><label>Faktiskt mottaget<input aria-label="Faktiskt mottaget" disabled={busy} type="datetime-local" value={form.receivedAt} onChange={event => updateForm(previous => ({ ...previous, receivedAt: event.target.value }))} /></label><small>Den verkliga mottagningstiden styr miljöfristerna.</small><button type="button" className="office-link" onClick={() => setEditSection(null)}>Klart</button></Fact>}
          <Fact title="Transportsätt">{editing ? <select aria-label="Transportsätt" disabled={busy || !editable} value={form.transportMode} onChange={event => updateForm(previous => ({ ...previous, transportMode: event.target.value as EnvironmentalTransportMode }))}>{Object.entries(transportModeNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select> : <strong>{transportModeNames[display.transportMode]}</strong>}</Fact>
          <Fact title="Transportdokument">{editing ? <div className="environment-document-inline"><input aria-label="Inkommande transportdokument" disabled={busy || !editable} maxLength={200} placeholder="Dokument-/transportreferens (valfritt)" value={form.incomingDocument.reference ?? ''} onChange={event => updateForm(previous => ({ ...previous, incomingDocument: { ...previous.incomingDocument, reference: event.target.value, ...(event.target.value.trim() && previous.incomingDocument.status === 'unknown' ? { status: 'provided' as const } : {}) } }))} /><select aria-label="Dokumentstatus" disabled={busy || !editable} value={status} onChange={event => updateForm(previous => ({ ...previous, incomingDocument: { ...previous.incomingDocument, status: event.target.value as IncomingEnvironmentalDocument['status'] } }))}><option value="unknown">Ej kontrollerat</option><option value="provided">Dokument finns</option><option value="not_required">Krävs inte i detta fall</option><option value="missing">Krävs men saknas</option></select></div> : <><strong>{display.incomingDocument.reference || (status === 'provided' ? 'Dokument finns · referens inte angiven' : status === 'not_required' ? 'Krävs inte i detta fall' : status === 'missing' ? 'Krävs men saknas' : 'Ej kontrollerat')}</strong>{(display.incomingDocument.exemptionReason || display.incomingDocument.missingReason) && <span className="environment-fact-secondary">{display.incomingDocument.exemptionReason || display.incomingDocument.missingReason}</span>}</>}{editing && <small>Referensen är valfri. Ett tomt nummerfält betyder inte att dokumentet saknas.</small>}</Fact>
          {editing && (status === 'missing' || status === 'not_required') && <Fact title={status === 'missing' ? 'Dokumentavvikelse' : 'Grund för undantag'} editor><label>{status === 'missing' ? 'Vad saknas och hur följs det upp?' : 'Varför krävs inget transportdokument?'}<textarea aria-label={status === 'missing' ? 'Avvikelse när transportdokument saknas' : 'Grund för att transportdokument inte krävs'} disabled={busy || !editable} maxLength={1000} rows={2} value={(status === 'missing' ? form.incomingDocument.missingReason : form.incomingDocument.exemptionReason) ?? ''} onChange={event => updateForm(previous => ({ ...previous, incomingDocument: { ...previous.incomingDocument, [status === 'missing' ? 'missingReason' : 'exemptionReason']: event.target.value } }))} /></label><small>{status === 'missing' ? 'Mottagningen kan registreras med en tydlig dokumentavvikelse.' : 'Välj utifrån det aktuella avfallet och transporten. Kundtypen avgör inte ensam.'}</small></Fact>}
        </dl>
        {editing && <><button type="button" className="office-link environment-more-details" aria-expanded={showContacts} onClick={() => setShowContacts(value => !value)}>{showContacts ? <ChevronUp size={13} /> : <ChevronDown size={13} />}Fler uppgifter</button>{showContacts && <div className="environment-extra-contacts environment-form-grid"><label>Kontaktperson<input aria-label="Tidigare innehavare – kontaktperson" disabled={busy || !editable} maxLength={100} value={form.previousHolder.contactName} onChange={event => updateForm(previous => ({ ...previous, previousHolder: { ...previous.previousHolder, contactName: event.target.value } }))} /></label><label>Telefon<input aria-label="Tidigare innehavare – telefon" disabled={busy || !editable} type="tel" maxLength={50} value={form.previousHolder.phone} onChange={event => updateForm(previous => ({ ...previous, previousHolder: { ...previous.previousHolder, phone: event.target.value } }))} /></label><label className="environment-full">E-post<input aria-label="Tidigare innehavare – e-post" disabled={busy || !editable} type="email" maxLength={254} value={form.previousHolder.email} onChange={event => updateForm(previous => ({ ...previous, previousHolder: { ...previous.previousHolder, email: event.target.value } }))} /></label></div>}</>}
        {correcting && <div className="environment-form-grid environment-correction-reason"><label className="environment-full">Orsak till miljörättelse *<textarea aria-label="Orsak till miljörättelse" disabled={busy} maxLength={1000} rows={2} placeholder="Beskriv vad som var fel och varför uppgifterna rättas" value={correctionReason} onChange={event => setCorrectionReason(event.target.value)} /><small>Originalversionen bevaras. Mängdskillnader ger en separat lagerjustering.</small></label></div>}
        {!sourceId && <div className="environment-error" role="alert">Kortet saknar ett stabilt käll-ID. Ladda om kontoret innan du registrerar mottagningen.</div>}{error && <div className="environment-error" role="alert">{error}</div>}
        {editing ? <div className="environment-actions"><small>{dirty ? 'Osparade ändringar' : savedAt ? `Utkast sparat ${environmentTime(savedAt)}` : 'Utkastet kan sparas utan att låsa uppgifter eller skapa lager.'}</small><div className="environment-action-buttons">{correcting && <button type="button" className="office-btn outline" disabled={busy} onClick={() => { setCorrecting(false); setForm(snapshotForm(receipt!)); dirtyRef.current = false; setDirty(false); setError(''); }}>Avbryt rättelse</button>}{!correcting && <button type="button" className="office-btn outline" disabled={busy || !editable || !sourceId} onClick={() => void saveDraft()}><Save size={14} />{busy ? 'Sparar…' : 'Spara utkast'}</button>}<button type="button" className="office-btn" disabled={busy || resolving || !editable || !sourceId} onClick={openConfirmation}><CheckCircle2 size={14} />{correcting ? 'Spara miljörättelse' : 'Bekräfta mottagning'}</button></div></div> : <div className="environment-actions"><small><LockKeyhole size={12} />Registrerad version {receipt!.version} · kontrollsumma {receipt!.hash.slice(0, 12)} · ej skickat till Naturvårdsverket</small>{editable && !cardDiffers && <button type="button" className="office-btn outline" onClick={beginCorrection}><Pencil size={13} />Rätta miljöuppgifter</button>}</div>}
        {receipt && <div className="environment-version-history"><h3>Versionshistorik</h3><ol><li><strong>Version 1 · mottagning registrerad</strong><span>{receipt.createdBy} · {environmentTime(receipt.createdAt)}</span></li>{receipt.correctionHistory?.map(item => <li key={item.id}><strong>Version {item.version} · miljörättelse</strong><span>{item.createdBy} · {environmentTime(item.createdAt)}</span><p>{item.reason}</p></li>)}</ol>{receipt.originalSnapshot && <details className="environment-original-details"><summary>Visa originalversion</summary><Materials rows={receipt.originalSnapshot.rows.filter(row => row.classification.hazardous)} /><p>{receipt.originalSnapshot.originAddress ?? receipt.originalSnapshot.lastPlace.address}</p><small>Oföränderligt original · kontrollsumma {(receipt.originalHash ?? receipt.hash).slice(0, 12)}</small></details>}</div>}
      </div>}
      {confirmOpen && <div className="environment-detail-backdrop" onClick={() => { if (!busy) setConfirmOpen(false); }}><section ref={dialogRef} className="environment-detail-dialog environment-confirm-dialog" role="dialog" aria-modal="true" aria-label={correcting ? 'Bekräfta miljörättelse' : 'Bekräfta mottagning'} onClick={event => event.stopPropagation()}><header><div><h2>{correcting ? 'Bekräfta miljörättelse' : 'Bekräfta mottagning'}</h2><p>Kontrollera material och verkligt mottagna vikter.</p></div><button type="button" className="environment-toggle" aria-label="Stäng mottagningsbekräftelse" disabled={busy} onClick={() => setConfirmOpen(false)}><X size={19} /></button></header><div className="environment-confirm-materials"><Materials rows={classifiedRows} /></div><p>{form.originAddress} · {receiptTimeLabel(form.receivedAt)}</p><div className="environment-info"><LockKeyhole size={16} /><span>{correcting ? 'En ny version sparas med rättelseorsaken. Originalversionen ligger kvar och lagret justeras med mängdskillnaden.' : 'Bekräftelsen sparar material, vikt och miljöuppgifter som en låst version och registrerar inkommande lager. Senare ändringar görs genom en spårbar miljörättelse.'} Kundgodkännande, intern attest och utbetalning hanteras separat.</span></div>{error && <div className="environment-error" role="alert">{error}</div>}<div className="environment-actions"><button type="button" className="office-btn outline" disabled={busy} onClick={() => setConfirmOpen(false)}>Avbryt</button><button type="button" className="office-btn" disabled={busy} onClick={() => void receive()}><CheckCircle2 size={14} />{busy ? 'Sparar…' : correcting ? 'Bekräfta miljörättelse' : 'Bekräfta mottagning'}</button></div></section></div>}
    </>}</EnvironmentAccessBoundary>
  </section>;
}
