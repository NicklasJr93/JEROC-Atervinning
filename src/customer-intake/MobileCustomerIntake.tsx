import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ClipboardCheck, LoaderCircle, Monitor, RefreshCw, Send, Smartphone, UserRound } from 'lucide-react';
import { Button, Notice } from '../components';
import { formatAddress, phoneNumberError } from '../data-format';
import { useEmployee } from '../employee/EmployeeProvider';
import type { Draft } from '../model';
import { useDemo } from '../store';
import { customerIntakeClient, customerIntakeError, customerIntakeRequestId, customerIntakeSessionChanged, type CustomerIntakeState } from './client';
import type { CustomerIntake } from './types';
import './mobile-customer-intake.css';

export const customerIntakePending = (intake: CustomerIntake | null | undefined) => Boolean(intake
  && ['waiting', 'submitted', 'unknown'].includes(intake.status));

type Props = { draft: Draft; compact?: boolean; onPendingChange?: (pending: boolean) => void; onBusyChange?: (busy: boolean) => void };
/** Remount the entire request state across login, support-company and draft
 * boundaries. Old proposals never flash in the next user's weighing. */
export default function MobileCustomerIntake(props: Props) {
  const { session, sessionGeneration } = useEmployee();
  if (!session || props.draft.status === 'ready') return null;
  return <IntakePanel key={JSON.stringify([session.companyId, session.person.id, sessionGeneration, props.draft.id])}
    {...props} companyId={session.companyId ?? 'jeroc-demo'} personId={session.person.id} />;
}

function IntakePanel({ draft, compact = false, companyId, personId, onPendingChange, onBusyChange }: Props & { companyId: string; personId: string }) {
  const navigate = useNavigate();
  const { flushDraft, acceptCustomerIntake } = useDemo();
  const [api] = useState(() => customerIntakeClient({ companyId, personId }));
  const [state, setState] = useState<CustomerIntakeState | null>(null);
  const [chooser, setChooser] = useState(false);
  const [review, setReview] = useState(false);
  const [channel, setChannel] = useState<'terminal' | 'sms'>('terminal');
  const [terminalId, setTerminalId] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true), working = useRef(false), readFlight = useRef(false), epoch = useRef(0);
  const readController = useRef<AbortController | undefined>(undefined);
  const actionController = useRef<AbortController | undefined>(undefined);
  const requestKeys = useRef(new Map<string, string>());
  const createAttempt = useRef(0);
  const draftRef = useRef(draft); draftRef.current = draft;
  const intake = state?.intake;
  const pending = customerIntakePending(intake);

  useEffect(() => { if (state) onPendingChange?.(pending); }, [state, pending, onPendingChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; epoch.current += 1;
      readController.current?.abort(); readController.current = undefined; readFlight.current = false;
      actionController.current?.abort();
      onBusyChange?.(false);
    };
  }, []);

  const load = useCallback(async (explicit = false) => {
    if (!alive.current || working.current || readFlight.current || document.hidden || navigator.onLine === false) return;
    readFlight.current = true;
    const currentEpoch = epoch.current, controller = new AbortController();
    readController.current = controller;
    try {
      const next = await api.load(draft.id, controller.signal);
      if (!alive.current || controller.signal.aborted || epoch.current !== currentEpoch) return;
      if (next.intake && next.intake.draftId !== draft.id) throw new Error('Kundförfrågan tillhör en annan vägning. Öppna vägningen igen.');
      setState(next);
      setTerminalId(previous => next.terminals.some(terminal => terminal.id === previous && terminal.available && terminal.siteId === draftRef.current.siteId) ? previous
        : next.terminals.find(terminal => terminal.available && terminal.siteId === draftRef.current.siteId)?.id ?? '');
      if (explicit) setError('');
    } catch (caught) {
      if (alive.current && !controller.signal.aborted && epoch.current === currentEpoch) {
        if (customerIntakeSessionChanged(caught)) { setState(null); setReview(false); setChooser(false); onPendingChange?.(true); }
        setError(customerIntakeError(caught));
      }
    } finally {
      if (readController.current === controller) { readController.current = undefined; readFlight.current = false; }
    }
  }, [api, draft.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const resume = () => { if (!document.hidden) void load(); };
    const timer = window.setInterval(() => { if (pending || chooser) void load(); }, 5_000);
    window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume);
    return () => { window.clearInterval(timer); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume); };
  }, [load, pending, chooser]);

  function requestId(key: string) {
    const existing = requestKeys.current.get(key);
    if (existing) return existing;
    const next = customerIntakeRequestId(); requestKeys.current.set(key, next); return next;
  }
  async function command(action: (signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    working.current = true; epoch.current += 1; readController.current?.abort();
    const controller = new AbortController(); actionController.current = controller;
    setBusy(true); onBusyChange?.(true); setError('');
    try { await action(controller.signal); }
    catch (caught) {
      if (alive.current && !controller.signal.aborted) {
        if (customerIntakeSessionChanged(caught)) { setState(null); setReview(false); setChooser(false); onPendingChange?.(true); }
        setError(customerIntakeError(caught));
      }
    }
    finally {
      if (alive.current) { working.current = false; setBusy(false); onBusyChange?.(false); }
      if (actionController.current === controller) actionController.current = undefined;
    }
  }
  function accept(next: CustomerIntake) {
    if (!alive.current || next.draftId !== draft.id) return;
    setState(previous => ({ intake: next, terminals: previous?.terminals ?? [], smsConfigured: previous?.smsConfigured ?? false }));
    setChooser(false);
  }
  async function create() {
    if (channel === 'sms') {
      const message = phoneNumberError(phone);
      if (!phone.trim() || message) { setError(message || 'Ange kundens mobilnummer.'); return; }
    } else if (!state?.terminals.some(terminal => terminal.id === terminalId && terminal.available && terminal.siteId === draft.siteId)) {
      setError('Välj en ledig kundterminal vid vägningens anläggning.'); return;
    }
    await command(async signal => {
      const confirmedDraft = await flushDraft(draft.id);
      if (!alive.current || signal.aborted) return;
      const key = JSON.stringify(['create', createAttempt.current, intake?.id ?? null, draft.id, confirmedDraft.customerId ?? null, channel, terminalId, phone.trim()]);
      const result = await api.create({ draftId: draft.id, channel,
        ...(channel === 'terminal' ? { terminalId } : { phone: phone.trim() }),
        requestId: requestId(key), expectedCustomerId: confirmedDraft.customerId ?? null }, signal);
      if (alive.current && !signal.aborted) { createAttempt.current += 1; accept(result.intake); }
    });
  }
  async function cancel() {
    if (!intake) return;
    await command(async signal => {
      const result = await api.cancel(intake.id, requestId(`cancel:${intake.id}`), signal);
      if (alive.current && !signal.aborted) { accept(result.intake); setReview(false); }
    });
  }
  async function apply() {
    if (!intake || intake.status !== 'submitted') return;
    await command(async signal => {
      const confirmedDraft = await flushDraft(draft.id);
      if (!alive.current || signal.aborted) return;
      const result = await api.apply(intake.id, requestId(`apply:${intake.id}`), signal);
      if (!alive.current || signal.aborted) return;
      const accepted = await acceptCustomerIntake(result, confirmedDraft);
      if (!alive.current || signal.aborted) return;
      accept(result.intake); setReview(false);
      if (!accepted) throw new Error('Kundvalet har ändrats. Kontrollera den aktuella kunden på viktkortet.');
    });
  }

  const title = intake?.status === 'submitted' ? 'Kunduppgifter mottagna'
    : intake?.status === 'applied' ? 'Kunduppgifter kopplade'
    : intake?.status === 'waiting' ? 'Inväntar kunduppgifter'
    : intake?.status === 'unknown' ? 'Utskicket kunde inte bekräftas'
    : intake?.status === 'failed' ? 'Förfrågan kunde inte skickas'
    : intake?.status === 'expired' ? 'Kundförfrågan har gått ut'
    : 'Kundförfrågan avbruten';
  const target = intake?.channel === 'terminal' ? intake.terminalName || 'Kundterminal' : `SMS${intake?.recipientMasked ? ` till ${intake.recipientMasked}` : ''}`;
  const hasStatus = Boolean(intake && (!compact || pending || intake.status === 'applied' || intake.status === 'failed' || intake.status === 'expired'));
  if (compact && !hasStatus && !error) return null;
  return <section className={`mobile-customer-intake${compact ? ' compact' : ''}`} aria-label="Kunduppgifter från kunden">
    {hasStatus && <div className="intake-status">
      <span className={`intake-status-icon ${intake?.status === 'applied' ? 'complete' : ''}`}>
        {intake?.status === 'applied' ? <Check size={22} /> : intake?.status === 'submitted' ? <ClipboardCheck size={22} /> : <UserRound size={22} />}
      </span>
      <div><h2>{title}</h2><p>{target}</p></div>
      <button type="button" className="icon-button" aria-label="Uppdatera kundförfrågan" disabled={busy} onClick={() => void load(true)}><RefreshCw size={18} /></button>
    </div>}
    {intake?.status === 'waiting' && <p className="field-help">Kunden fyller i sina uppgifter. Du kan fortsätta väga under tiden.</p>}
    {intake?.status === 'submitted' && <>
      <p className="field-help">Granska förslaget och koppla kunden innan vägningen sparas som färdig.</p>
      <Button variant="outline" icon={ClipboardCheck} disabled={busy} onClick={() => compact
        ? navigate(`/weigh/${draft.id}/customer`) : setReview(value => !value)}>{review ? 'Dölj kunduppgifter' : 'Granska kunduppgifter'}</Button>
    </>}
    {intake?.status === 'applied' && <p className="field-help">Uppgifterna är kopplade till den här vägningen. Kundgodkännande och ID-kontroll görs separat.</p>}
    {intake?.status === 'unknown' && <Notice tone="amber">Det är osäkert om SMS:et skickades. Kontrollera med kunden innan du avbryter och skapar en ny förfrågan.</Notice>}
    {intake?.status === 'failed' && <Notice tone="red">Förfrågan skickades inte. Du kan skapa en ny förfrågan när uppgifterna eller anslutningen har kontrollerats.</Notice>}
    {review && !compact && intake?.status === 'submitted' && intake.proposal && <div className="intake-proposal">
      <h3>Uppgifter från kunden</h3>
      <dl>{[
        ['Kundtyp', intake.proposal.type], ['Namn', intake.proposal.name], ['Organisations-/personnummer', intake.proposal.number],
        ['Telefon', intake.proposal.phone], ['E-post', intake.proposal.email], ['Adress', formatAddress(intake.proposal)],
        ['Referens', intake.proposal.reference], ['Ursprungsadress', intake.proposal.originDetails && formatAddress(intake.proposal.originDetails)],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || 'Ej angivet'}</dd></div>)}</dl>
      {intake.existingCustomerName && <Notice>En befintlig kund matchar uppgifterna: <strong>{intake.existingCustomerName}</strong>. Kundens sparade kontaktuppgifter behålls.</Notice>}
      {intake.hasPaymentProfile && <p className="field-help">{intake.bankWillBeSaved
        ? 'Kunden har lämnat bankuppgifter. De sparas på kundkortet när du använder förslaget med behörighet att hantera betalningsuppgifter.'
        : intake.existingCustomerName ? 'Befintliga betalningsuppgifter behålls. Kundens inskickade bankuppgifter ersätter dem inte.'
          : 'Kunden har lämnat bankuppgifter. De lagras på kundkortet när förslaget används.'}</p>}
      <Button icon={Check} disabled={busy} onClick={() => void apply()}>{busy ? 'Kopplar kund…' : 'Använd kunduppgifterna'}</Button>
    </div>}
    {pending && <Button variant="quiet" disabled={busy} onClick={() => void cancel()}>Avbryt kundförfrågan</Button>}
    {!compact && !pending && !chooser && <Button variant="outline" icon={Smartphone} disabled={busy} onClick={() => { setChooser(true); setError(''); void load(true); }}>Låt kunden fylla i</Button>}
    {!compact && chooser && !pending && <div className="intake-chooser">
      <h2>Låt kunden fylla i</h2><p className="field-help">Skicka ett formulär kopplat till vägning #{draft.number}. Du kan fortsätta väga medan kunden fyller i.</p>
      <div className="intake-channels" role="group" aria-label="Välj hur kunden fyller i">
        <button type="button" aria-pressed={channel === 'terminal'} disabled={busy} onClick={() => setChannel('terminal')}><Monitor size={21} />Kundterminal</button>
        <button type="button" aria-pressed={channel === 'sms'} disabled={busy} onClick={() => setChannel('sms')}><Smartphone size={21} />SMS</button>
      </div>
      {channel === 'terminal' ? <label className="field"><span>Kundterminal</span><select aria-label="Kundterminal" value={terminalId} disabled={busy || !state} onChange={event => setTerminalId(event.target.value)}>
        <option value="">{state ? 'Välj en ledig terminal' : 'Hämtar terminaler…'}</option>
        {state?.terminals.filter(terminal => terminal.siteId === draftRef.current.siteId).map(terminal => <option key={terminal.id} value={terminal.id} disabled={!terminal.available}>{terminal.name}{!terminal.available ? ' · upptagen eller frånkopplad' : ''}</option>)}
      </select></label> : <>
        <label className="field"><span>Kundens mobilnummer</span><input type="tel" inputMode="tel" autoComplete="tel" value={phone} disabled={busy} onChange={event => setPhone(event.target.value)} placeholder="0701234567" /></label>
        {state && !state.smsConfigured && <Notice tone="amber">SMS-utskick är inte konfigurerat. Välj en kundterminal eller fyll i kunden själv.</Notice>}
      </>}
      <Button icon={busy ? LoaderCircle : Send} disabled={busy || !state || (channel === 'sms' && !state.smsConfigured)} onClick={() => void create()}>{busy ? 'Skickar förfrågan…' : channel === 'terminal' ? 'Öppna på kundterminal' : 'Skicka formulär via SMS'}</Button>
      <Button variant="quiet" disabled={busy} onClick={() => setChooser(false)}>Stäng</Button>
    </div>}
    {error && <Notice tone="red">{error}<button type="button" className="text-button" disabled={busy} onClick={() => void load(true)}>Uppdatera status</button></Notice>}
  </section>;
}
