import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CalendarDays, CheckCircle2, ChevronRight, ClipboardCheck, Download, FileCheck2, HeartPulse, History, LockKeyhole, Pencil, Plus, RefreshCw, Search, Settings2, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { OfficeUser } from '../model';
import type { SicknessCase, SicknessExtent, SicknessForecast, SicknessManagementCommand, SicknessManagementResponse, SicknessUnderlay } from '../../employee/sickness-types';
import { OfficePageHeader } from '../OfficePageHeader';
import { Alert, Dialog, Fact, Field, Panel, Pill, formatDate, initials, localToday, minuteLabel } from './components/Ui';
import { downloadSicknessCsv, downloadSicknessFile, mayReadSickness, sicknessFilesRequest, sicknessRequest, sicknessScope, SicknessApiError, validSicknessManagementResponse, type SicknessFile, type SicknessScope } from './sickness-client';
import './personal.css';
import './sickness.css';

export interface SicknessWorkspaceProps {
  user: OfficeUser; actualUser: OfficeUser; selectedSiteId?: string; personId?: string; onNotice: (message: string) => void;
}
type Tab = 'cases' | 'underlay' | 'settings';
type EditorKind = 'report' | 'confirm' | 'forecast' | 'recover' | 'declare' | 'correct' | 'certificate' | 'review' | 'profile' | 'highrisk' | 'import' | 'policy';
interface Editor {
  key: string; kind: EditorKind; requestId: string; personId: string; caseId?: string; revision: number;
  fromDate: string; lastSickDate: string; startTime: string; recoveryTime: string; extent: SicknessExtent;
  forecastKind: SicknessForecast['kind']; forecastDate: string; declared: boolean; reason: string;
  certificateReceived: boolean; certificateFrom: string; certificateTo: string; reference: string;
  firstDayRequired: boolean; firstDayReason: string;
  hourlyBase: string; weeklyHours: string; sickPayRate: string; confirmed: boolean; source: string;
  highRiskKind: 'frequent' | 'long'; decisionId?: string; reviewKind: Extract<SicknessManagementCommand, { action: 'case.review' }>['kind'];
  dailyContact: boolean; contactBy: string; agreement: 'unknown' | 'statutory' | 'collective'; agreementName: string; effectiveFrom: string;
}
const titles: Record<EditorKind, string> = {
  report: 'Registrera sjukanmälan', confirm: 'Bekräfta fortsatt sjukfrånvaro', forecast: 'Uppdatera prognos', recover: 'Registrera friskanmälan',
  declare: 'Registrera mottagen försäkran',
  correct: 'Rätta sjukfrånvaro', certificate: 'Registrera läkarintyg', review: 'Dokumentera uppföljning',
  profile: 'Beräkningsunderlag för sjuklön', highrisk: 'Registrera särskilt högriskskydd', import: 'Tidigare karensavdrag', policy: 'Sjukregler & kontaktrutin',
};
const fullTime = (value?: string) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const money = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value)
  ? `${value.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr` : 'Ej beräknat';
const hours = (minutes: number) => `${(minutes / 60).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} h`;
const profileStatus = { calculated: 'Beräknat underlag', missing_basis: 'Underlag saknas', review_required: 'Behöver granskas' };
const rowStatus = { calculated: 'Beräknad', missing_basis: 'Underlag saknas', outside_employer_period: 'Utanför sjuklöneperiod', review_required: 'Behöver granskas' };
const exemptionLabel = { none: 'Karensavdrag gäller', general_high_risk: 'Allmänt högriskskydd', special_high_risk: 'Särskilt högriskskydd' };
const minutesFromTime = (value: string) => value ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)) : undefined;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Sjukfrånvaron kunde inte sparas. Uppdatera för att kontrollera status.';
const forecastLabel = (value: SicknessForecast) => value.kind === 'date' && value.date ? formatDate(value.date) : 'Återkomst är inte känd';
export default function SicknessWorkspace({ user, actualUser, selectedSiteId = 'all', personId, onNotice }: SicknessWorkspaceProps) {
  const navigate = useNavigate(), latestScope = sicknessScope(user, actualUser);
  const scope = useMemo(() => latestScope, [latestScope.key]);
  const readable = mayReadSickness(user, actualUser);
  const [selectedPerson, setSelectedPerson] = useState<string>(), [selectedCaseId, setSelectedCaseId] = useState<string>();
  const currentPerson = personId ?? selectedPerson, key = `${scope.key}/${selectedSiteId}/${currentPerson ?? 'all'}`;
  const keyRef = useRef(key); keyRef.current = key;
  const mounted = useRef(true), serial = useRef(0), readController = useRef<AbortController | undefined>(undefined), writeController = useRef<AbortController | undefined>(undefined), exportController = useRef<AbortController | undefined>(undefined);
  const writeLock = useRef<string | undefined>(undefined);
  const [stored, setStored] = useState<{ key: string; data: SicknessManagementResponse }>();
  const [activity, setActivity] = useState<{ key: string; kind: 'read' | 'write' }>(), [failure, setFailure] = useState<{ key: string; message: string }>();
  const [uncertainKey, setUncertainKey] = useState<string>(), [editor, setEditor] = useState<Editor>();
  const [exporting, setExporting] = useState<string>();
  const [tab, setTab] = useState<Tab>('cases'), [query, setQuery] = useState(''), [status, setStatus] = useState('open');
  const data = stored?.key === key && readable ? stored.data : undefined;
  const busy = activity?.key === key, writing = busy && activity.kind === 'write', uncertain = uncertainKey === key;
  const activeEditor = editor?.key === key ? editor : undefined;
  const cap = (name: string) => data?.capabilities.includes(name) ?? false;
  const selectedCase = data?.cases.find(value => value.id === selectedCaseId) ?? (personId ? data?.cases.find(value => value.status === 'open') : undefined);
  const selectedName = data?.people.find(value => value.id === currentPerson)?.name ?? selectedCase?.personName ?? 'Person';

  const read = useCallback(async () => {
    if (!readable) return;
    const ownKey = key, number = ++serial.current;
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    setActivity({ key: ownKey, kind: 'read' });
    try {
      const next = await sicknessRequest<SicknessManagementResponse>(scope, { personId: currentPerson, siteId: selectedSiteId }, undefined, controller.signal);
      if (!validSicknessManagementResponse(next)) throw new Error('Sjukfrånvaron gav ett ofullständigt svar. Försök uppdatera igen.');
      if (mounted.current && keyRef.current === ownKey && number === serial.current) {
        setStored({ key: ownKey, data: next }); setFailure(undefined); setUncertainKey(undefined);
      }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && keyRef.current === ownKey && number === serial.current) {
        setFailure({ key: ownKey, message: errorText(error) });
        if (error instanceof SicknessApiError && [401, 403].includes(error.status)) { setStored(undefined); setEditor(undefined); }
      }
    } finally {
      if (mounted.current && keyRef.current === ownKey && number === serial.current) setActivity(undefined);
    }
  }, [scope, key, readable, currentPerson, selectedSiteId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readController.current?.abort(); writeController.current?.abort(); exportController.current?.abort(); }; }, []);
  useEffect(() => { setEditor(undefined); setFailure(undefined); setUncertainKey(undefined); void read(); return () => { readController.current?.abort(); writeController.current?.abort(); exportController.current?.abort(); }; }, [read]);

  const openEditor = (kind: EditorKind, illness: SicknessCase | null | undefined = selectedCase, chosenPerson = currentPerson) => {
    if (!data || busy || uncertain || kind === 'policy' && !cap('policyWrite')) return;
    const profile = [...data.profiles].filter(value => value.personId === chosenPerson).sort((a, b) => b.revision - a.revision)[0];
    setEditor({ key, kind, requestId: crypto.randomUUID(), personId: chosenPerson ?? '', caseId: illness?.id, revision: kind === 'profile' ? profile?.revision ?? 0 : illness?.revision ?? 0,
      fromDate: illness?.fromDate ?? data.today, lastSickDate: kind === 'correct' && illness?.status === 'open' ? '' : illness?.lastSickDate ?? data.today,
      startTime: illness?.startMinute === undefined ? '' : minuteLabel(illness.startMinute), recoveryTime: illness?.recoveryMinute === undefined ? '' : minuteLabel(illness.recoveryMinute),
      extent: illness?.extent ?? 100, forecastKind: illness?.forecast.kind ?? 'unknown', forecastDate: illness?.forecast.date ?? '', declared: illness?.declared ?? false, reason: '',
      certificateReceived: illness?.certificate.received ?? false, certificateFrom: illness?.certificate.fromDate ?? illness?.fromDate ?? data.today,
      certificateTo: illness?.certificate.toDate ?? data.today, reference: illness?.certificate.reference ?? '', firstDayRequired: illness?.certificate.firstDayRequired ?? false,
      firstDayReason: illness?.certificate.firstDayReason ?? '', hourlyBase: profile ? String(profile.hourlyBase) : '', weeklyHours: profile ? String(profile.averageWeeklyHours) : '',
      sickPayRate: profile ? String(profile.sickPayRate * 100) : '80', confirmed: profile?.confirmed ?? false, source: profile?.source ?? '',
      highRiskKind: 'frequent', reviewKind: 'checked', dailyContact: data.policy.dailyContact, contactBy: minuteLabel(data.policy.contactByMinute),
      agreement: data.policy.agreement, agreementName: data.policy.agreementName, effectiveFrom: data.today,
    });
  };
  const updateEditor = (change: Partial<Editor>) => setEditor(value => value && value.key === key ? { ...value, ...change } : value);

  const commandFor = (value: Editor): SicknessManagementCommand => {
    const forecast: SicknessForecast = value.forecastKind === 'date' ? { kind: 'date', date: value.forecastDate } : { kind: 'unknown' };
    const base = { requestId: value.requestId, personId: value.personId }, illness = { ...base, id: value.caseId!, revision: value.revision };
    const contactReason = value.reason.trim() ? { reason: value.reason.trim() } : {};
    const startMinute = minutesFromTime(value.startTime), recoveryMinute = minutesFromTime(value.recoveryTime);
    switch (value.kind) {
      case 'report': return { ...base, ...contactReason, action: 'sickness.report', fromDate: value.fromDate, ...(startMinute === undefined ? {} : { startMinute }), extent: value.extent, forecast, declared: value.declared };
      case 'confirm': return { ...illness, ...contactReason, action: 'sickness.confirm', extent: value.extent, forecast };
      case 'forecast': return { ...illness, ...contactReason, action: 'sickness.forecast', forecast };
      case 'recover': return { ...illness, ...contactReason, action: 'sickness.recover', lastSickDate: value.lastSickDate, ...(recoveryMinute === undefined ? {} : { recoveryMinute }) };
      case 'declare': return { ...illness, action: 'sickness.declare', declared: true, reason: value.reason.trim() };
      case 'correct': return { ...illness, action: 'sickness.correct', fromDate: value.fromDate, ...(startMinute === undefined ? {} : { startMinute }), extent: value.extent,
        ...(value.lastSickDate ? { lastSickDate: value.lastSickDate } : {}), ...(recoveryMinute === undefined ? {} : { recoveryMinute }), reason: value.reason.trim() };
      case 'certificate': return { ...illness, action: 'certificate.save', certificate: { received: value.certificateReceived,
        ...(value.certificateReceived ? { fromDate: value.certificateFrom, toDate: value.certificateTo } : {}), reference: value.reference.trim(),
        firstDayRequired: value.firstDayRequired, firstDayReason: value.firstDayReason.trim() } };
      case 'review': return { ...illness, action: 'case.review', kind: value.reviewKind, reason: value.reason.trim() };
      case 'profile': return { action: 'payprofile.save', requestId: value.requestId, profile: { personId: value.personId,
        revision: value.revision,
        effectiveFrom: value.effectiveFrom, hourlyBase: Number(value.hourlyBase), averageWeeklyHours: Number(value.weeklyHours), sickPayRate: Number(value.sickPayRate) / 100,
        confirmed: value.confirmed, source: value.source.trim() } };
      case 'highrisk': return { action: 'highrisk.save', requestId: value.requestId, decision: { id: value.decisionId ?? value.requestId, personId: value.personId, revision: value.decisionId ? value.revision : 0,
        fromDate: value.fromDate, toDate: value.lastSickDate, kind: value.highRiskKind, reference: value.reference.trim() } };
      case 'import': return { ...base, action: 'deduction.import', date: value.fromDate, source: value.source.trim() };
      case 'policy': return { action: 'policy.save', requestId: value.requestId, policy: { revision: data!.policy.revision, dailyContact: value.dailyContact,
        contactByMinute: minutesFromTime(value.contactBy) ?? 480, agreement: value.agreement, agreementName: value.agreementName.trim(),
        calculationConfirmed: value.confirmed, effectiveFrom: value.effectiveFrom } };
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeEditor || !data || busy || uncertain || writeLock.current === key || activeEditor.kind === 'policy' && !cap('policyWrite')) return;
    const ownKey = key, current = activeEditor;
    writeLock.current = ownKey;
    readController.current?.abort(); ++serial.current;
    const controller = new AbortController(); writeController.current = controller;
    setActivity({ key: ownKey, kind: 'write' }); setFailure(undefined);
    try {
      const next = await sicknessRequest<SicknessManagementResponse>(scope, { personId: currentPerson, siteId: selectedSiteId }, commandFor(current), controller.signal);
      if (!validSicknessManagementResponse(next)) throw new Error('Svaret var ofullständigt. Uppdatera för att kontrollera om ändringen sparades.');
      if (mounted.current && keyRef.current === ownKey) {
        setStored({ key: ownKey, data: next }); setEditor(undefined); setUncertainKey(undefined);
        onNotice(`${titles[current.kind]}: uppgifterna har sparats.`);
        window.dispatchEvent(new Event('jeroc:employee-session-check'));
      }
    } catch (error) {
      if (mounted.current && keyRef.current === ownKey && !controller.signal.aborted) {
        setFailure({ key: ownKey, message: errorText(error) });
        if (error instanceof SicknessApiError && [401, 403].includes(error.status)) { setStored(undefined); setEditor(undefined); }
        // A network/timeout or malformed success may hide a committed mutation.
        if (!(error && typeof error === 'object' && 'status' in error && Number((error as { status: unknown }).status) >= 400 && Number((error as { status: unknown }).status) < 500)) setUncertainKey(ownKey);
      }
    } finally { if (writeLock.current === ownKey) writeLock.current = undefined; if (mounted.current && keyRef.current === ownKey) setActivity(undefined); }
  };

  const chooseCase = (illness: SicknessCase) => { setSelectedCaseId(illness.id); if (!personId) setSelectedPerson(illness.personId); setTab('cases'); };
  const downloadCsv = async () => {
    if (!currentPerson || busy || exporting === key || !cap('salaryRead')) return;
    const ownKey = key, controller = new AbortController(); exportController.current?.abort(); exportController.current = controller; setExporting(ownKey);
    const timeout = window.setTimeout(() => controller.abort(), 35000);
    try {
      const file = await downloadSicknessCsv(scope, { personId: currentPerson, siteId: selectedSiteId }, controller.signal);
      if (!mounted.current || keyRef.current !== ownKey || controller.signal.aborted) return;
      const url = URL.createObjectURL(file.blob), link = document.createElement('a'); link.href = url; link.download = file.filename;
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (mounted.current && keyRef.current === ownKey) {
        setFailure({ key: ownKey, message: controller.signal.aborted ? 'Sjuklöneunderlaget kunde inte exporteras i tid. Försök igen.' : errorText(error) });
        if (error instanceof SicknessApiError && [401, 403].includes(error.status)) setStored(undefined);
      }
    } finally { window.clearTimeout(timeout); if (mounted.current && keyRef.current === ownKey) setExporting(undefined); }
  };
  const back = () => { setSelectedCaseId(undefined); setSelectedPerson(undefined); setTab('cases'); };
  const filteredCases = data?.cases.filter(illness => (status === 'all' || illness.status === status || status === 'followup' && (illness.followup.contactOverdue || illness.followup.reviewRequired || illness.followup.certificateRequired || illness.followup.insurerReportDue || illness.followup.rehabilitationPlanDue))
    && `${illness.personName ?? data.people.find(person => person.id === illness.personId)?.name ?? ''} ${illness.id}`.toLocaleLowerCase('sv-SE').includes(query.toLocaleLowerCase('sv-SE'))) ?? [];
  const shownCases = [...filteredCases].sort((a, b) => b.fromDate.localeCompare(a.fromDate));
  const allPeople = data?.people ?? [], writable = cap('absenceWrite'), financialRead = cap('salaryRead'), financialWrite = cap('salaryWrite') && cap('absenceWrite');
  const today = data?.today ?? localToday();

  if (!readable) return <Alert tone="orange"><LockKeyhole size={18} />Du saknar behörighet att läsa sjukfrånvaro. Frånvarouppgifter visas bara för behörig personal.</Alert>;
  return <div className="hr-workspace hr-sickness-workspace">
    {!personId && <OfficePageHeader className="hr-page-header" controls={<nav className="hr-sickness-tabs" aria-label="Sjukfrånvaro"><button className={tab === 'cases' ? 'active' : ''} onClick={() => setTab('cases')}>Sjukärenden</button>{financialRead && <button className={tab === 'underlay' ? 'active' : ''} onClick={() => setTab('underlay')}>Sjuklön & karens</button>}<button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Regler & rutiner</button></nav>}>
      <button className="office-back" onClick={() => navigate('/personnel')}><ArrowLeft size={16} /> Till personal</button>
      <div className="office-page-title"><div><span className="hr-eyebrow">PERSONAL & UPPFÖLJNING</span><h1>Sjukfrånvaro</h1><p>Sjukanmälan, återkomst och spårbara sjuklöneunderlag.</p></div><div className="hr-actions"><button className="office-btn outline" disabled={writing} onClick={() => void read()}><RefreshCw size={15} />{busy && !writing ? 'Hämtar…' : 'Uppdatera'}</button>{writable && <button className="office-btn" disabled={busy || uncertain} onClick={() => openEditor('report', null)}><Plus size={15} />Sjukanmälan</button>}</div></div>
    </OfficePageHeader>}
    {personId && <div className="hr-sickness-subheading"><nav className="hr-sickness-tabs" aria-label="Sjukfrånvaro"><button className={tab === 'cases' ? 'active' : ''} onClick={() => setTab('cases')}>Sjukärenden</button>{financialRead && <button className={tab === 'underlay' ? 'active' : ''} onClick={() => setTab('underlay')}>Sjuklön & karens</button>}</nav><div className="hr-actions"><button className="office-btn outline" disabled={writing} onClick={() => void read()}><RefreshCw size={15} />Uppdatera</button>{writable && !data?.cases.some(illness => illness.status === 'open') && <button className="office-btn" disabled={busy || uncertain} onClick={() => openEditor('report', null)}><Plus size={15} />Sjukanmälan</button>}</div></div>}
    {failure?.key === key && <Alert tone="red">{failure.message}</Alert>}
    {uncertain && <Alert tone="orange">Det är osäkert om senaste ändringen sparades. Uppdatera status innan du fortsätter.<button className="office-btn outline" disabled={busy} onClick={() => void read()}><RefreshCw size={14} />Kontrollera status</button></Alert>}
    {!data ? <div className="hr-loading"><RefreshCw size={20} />{busy ? 'Laddar sjukfrånvaro…' : 'Ingen sjukfrånvaro kunde hämtas.'}</div> : <>
      {tab === 'cases' && <>
        {!personId && currentPerson && <button className="office-back" onClick={back}><ArrowLeft size={15} />Alla sjukärenden</button>}
        {currentPerson && data.cases.length > 1 && <div className="hr-sickness-case-select"><Field label="Sjukärende"><select value={selectedCase?.id ?? ''} onChange={event => setSelectedCaseId(event.target.value)}><option value="">Välj sjukärende</option>{[...data.cases].sort((a, b) => b.fromDate.localeCompare(a.fromDate)).map(illness => <option key={illness.id} value={illness.id}>{formatDate(illness.fromDate)} · {illness.status === 'open' ? 'Pågående' : 'Friskanmälan'}{illness.relapse ? ' · återinsjuknande' : ''}</option>)}</select></Field></div>}
        {!selectedCase && !currentPerson && <div className="hr-metrics"><Metric label="Pågående sjukärenden" value={data.cases.filter(illness => illness.status === 'open').length} icon={<HeartPulse size={22} />} /><Metric label="Behöver uppföljning" value={data.cases.filter(illness => illness.followup.contactOverdue || illness.followup.reviewRequired || illness.followup.certificateRequired || illness.followup.insurerReportDue || illness.followup.rehabilitationPlanDue).length} icon={<ClipboardCheck size={22} />} /><Metric label="Friskanmälningar" value={data.cases.filter(illness => illness.status === 'recovered').length} icon={<CheckCircle2 size={22} />} /></div>}
        {selectedCase ? <>
          <Panel title="Sjukärendet" icon={<HeartPulse size={18} />} actions={writable && <button className="office-link" disabled={busy || uncertain} onClick={() => openEditor('correct')}><Pencil size={14} />Rätta med orsak</button>}>
            <div className="hr-sickness-case-heading"><span className="hr-avatar">{initials(selectedName)}</span><div><h3>{selectedName}</h3><p>Anmäld {fullTime(selectedCase.reportedAt)} · Ärende {selectedCase.id}</p></div><Pill tone={selectedCase.status === 'open' ? 'red' : 'green'}>{selectedCase.status === 'open' ? 'Pågående sjukfrånvaro' : 'Friskanmälan registrerad'}</Pill>{selectedCase.relapse && <Pill tone="purple">Återinsjuknande · samma sjuklöneperiod</Pill>}</div>
            <div className="hr-sickness-case-summary"><div><span>Sjuk från</span><strong>{formatDate(selectedCase.fromDate)}{selectedCase.startMinute === undefined ? '' : ` · ${minuteLabel(selectedCase.startMinute)}`}</strong></div><div><span>Nedsatt arbetsförmåga</span><strong>{selectedCase.extent} %</strong></div><div><span>{selectedCase.status === 'recovered' ? 'Sista sjukdag' : 'Uppskattad återkomst'}</span><strong>{selectedCase.status === 'recovered' ? formatDate(selectedCase.lastSickDate) : forecastLabel(selectedCase.forecast)}</strong></div></div>
            {selectedCase.timeIssue && <Alert tone="orange">Tidregistreringen behöver följas upp separat. Sjukanmälan är registrerad; redan arbetade timmar ska bevaras.</Alert>}
            <Fact label="Senast bekräftad sjukfrånvaro">{formatDate(selectedCase.lastContactDate)}</Fact><Fact label="Skriftlig försäkran">{selectedCase.declared ? `Lämnad ${fullTime(selectedCase.declaredAt)}` : 'Saknas – medarbetaren lämnar den i appen'}</Fact>
            {!selectedCase.declared && writable && <button className="office-link" disabled={busy || uncertain} onClick={() => openEditor('declare')}>Registrera försäkran som mottagits separat<ChevronRight size={14} /></button>}
            {selectedCase.status === 'open' && writable && <div className="hr-sickness-inline-actions"><button className="office-btn outline" disabled={busy || uncertain} onClick={() => openEditor('confirm')}><ClipboardCheck size={15} />Bekräfta fortsatt sjuk</button><button className="office-btn outline" disabled={busy || uncertain} onClick={() => openEditor('forecast')}><CalendarDays size={15} />Ändra prognos</button><button className="office-btn" disabled={busy || uncertain} onClick={() => openEditor('recover')}><CheckCircle2 size={15} />Friskanmäl</button></div>}
            <p className="hr-sickness-label-note">Prognosen ändrar inte den faktiska sjukfrånvaron. Ärendet avslutas först med friskanmälan.</p>
          </Panel>
          <div className="hr-grid two">
            <Panel title="Uppföljning" icon={<ClipboardCheck size={18} />} actions={writable && <button className="office-link" disabled={busy || uncertain} onClick={() => openEditor('review')}>Dokumentera åtgärd<ChevronRight size={14} /></button>}>
              <div className="hr-sickness-checklist">
                <Check title="Kontakt med medarbetaren" warning={selectedCase.followup.contactOverdue} text={data.policy.dailyContact ? `Arbetsplatsens rutin: bekräftelse senast ${minuteLabel(data.policy.contactByMinute)}. ${selectedCase.followup.contactOverdue ? 'Dagens uppdatering saknas.' : 'Senaste kontakt registrerad.'}` : 'Ingen daglig bekräftelse krävs i den valda arbetsplatsrutinen. Håll regelbunden kontakt.'} />
                <Check title="Skriftlig försäkran" warning={!selectedCase.declared} complete={selectedCase.declared} text={selectedCase.declared ? 'Medarbetaren har bekräftat sjukdom och omfattning. Diagnos efterfrågas inte.' : 'Behöver lämnas av medarbetaren. Sjuklöneunderlaget visar om den saknas.'} />
                <Check title="Läkarintyg" warning={selectedCase.followup.certificateRequired} complete={selectedCase.certificate.received && !selectedCase.followup.certificateRequired} text={`Normalt från ${formatDate(selectedCase.followup.certificateDueDate)}. ${selectedCase.certificate.received ? `Registrerad täckning ${formatDate(selectedCase.certificate.fromDate)}–${formatDate(selectedCase.certificate.toDate)}.` : 'Inget intyg är registrerat.'}`} />
                <Check title="Anmälan till Försäkringskassan" warning={selectedCase.followup.insurerReportDue && !selectedCase.followup.insurerReportedAt} complete={!!selectedCase.followup.insurerReportedAt} text={selectedCase.followup.insurerReportedAt ? `Manuellt anmäld ${fullTime(selectedCase.followup.insurerReportedAt)}.` : `Vid fortsatt sjukfrånvaro efter arbetsgivarperioden. Senast ${formatDate(selectedCase.followup.insurerReportDeadline)}. Systemet skickar ingen myndighetsanmälan.`} />
                <Check title="Plan för återgång i arbete" warning={selectedCase.followup.rehabilitationPlanDue && !selectedCase.followup.rehabilitationPlanAt} complete={!!selectedCase.followup.rehabilitationPlanAt} text={selectedCase.followup.rehabilitationPlanAt ? `Upprättad ${fullTime(selectedCase.followup.rehabilitationPlanAt)}.` : 'Bedöm behov av arbetsanpassning. Plan behövs normalt senast dag 30 om frånvaron väntas pågå minst 60 dagar.'} />
                {selectedCase.followup.messages.map(message => <Check key={message} title="Behöver kontrolleras" warning text={message} />)}
              </div>
            </Panel>
            <Panel title="Intyg & frånvarodagar" icon={<FileCheck2 size={18} />} actions={writable && <button className="office-link" disabled={busy || uncertain} onClick={() => openEditor('certificate')}>{selectedCase.certificate.received ? 'Ändra intygsuppgifter' : 'Registrera intyg'}<ChevronRight size={14} /></button>}>
              <Fact label="Intyg mottaget"><Pill tone={selectedCase.certificate.received ? 'green' : 'grey'}>{selectedCase.certificate.received ? 'Ja' : 'Nej'}</Pill></Fact><Fact label="Intygsreferens">{selectedCase.certificate.reference || '—'}</Fact>{selectedCase.certificate.firstDayRequired && <Fact label="Särskilt krav på tidigare intyg">Skriftligt beslut registrerat</Fact>}
              <CertificateFiles scope={scope} illness={selectedCase} writable={writable} scopeKey={key} onDenied={() => { setStored(undefined); setEditor(undefined); }} />
              <p className="hr-sickness-label-note">Intygsdatum registreras separat från uppladdningen. Filer hämtas med skyddad åtkomst och visas aldrig som offentliga bildlänkar.</p>
              <div className="hr-table-scroll"><table className="hr-table"><thead><tr><th>Datum</th><th>Omfattning</th><th>Frånvarotid</th><th>Tidrapport</th></tr></thead><tbody>{selectedCase.days.map(day => <tr key={day.date}><td>{formatDate(day.date)}</td><td>{day.extent} %</td><td>{hours(day.lostMinutes)}</td><td><Pill tone={day.timeLocked ? 'orange' : 'grey'}>{day.timeLocked ? 'Låst period' : 'Öppen period'}</Pill></td></tr>)}</tbody></table>{!selectedCase.days.length && <p className="hr-muted">Inga faktiska frånvarodagar är registrerade ännu.</p>}</div>
            </Panel>
          </div>
          <Panel title="Sjukärendets historik" icon={<History size={18} />}><HistoryList events={data.events.filter(value => value.caseId === selectedCase.id)} /></Panel>
        </> : <Panel title={currentPerson ? `${selectedName} · sjukärenden` : 'Sjukärenden'} icon={<HeartPulse size={18} />}>
          <div className="hr-filters"><label className="hr-search"><Search size={15} /><input aria-label="Sök sjukärende" value={query} placeholder="Sök person eller ärende…" onChange={event => setQuery(event.target.value)} /></label><select aria-label="Filtrera sjukärenden" value={status} onChange={event => setStatus(event.target.value)}><option value="open">Pågående</option><option value="followup">Behöver uppföljning</option><option value="recovered">Friskanmälningar</option><option value="all">Alla sjukärenden</option></select></div>
          {shownCases.length ? <div className="hr-table-scroll"><table className="hr-table hr-sickness-table"><thead><tr><th>Person</th><th>Sjuk från / omfattning</th><th>Senaste kontakt</th><th>Prognos</th><th>Status</th><th><span className="hr-sickness-sr-only">Öppna ärende</span></th></tr></thead><tbody>{shownCases.map(illness => { const name = illness.personName ?? allPeople.find(person => person.id === illness.personId)?.name ?? 'Person'; return <tr key={illness.id} tabIndex={0} aria-label={`Öppna sjukärende för ${name}`} onClick={() => chooseCase(illness)} onKeyDown={event => { if (event.currentTarget === event.target && ['Enter', ' '].includes(event.key)) { event.preventDefault(); chooseCase(illness); } }}><td><div className="hr-sickness-person"><span className="hr-avatar">{initials(name)}</span><strong>{name}</strong></div></td><td>{formatDate(illness.fromDate)}<small>{illness.extent} %{illness.relapse ? ' · återinsjuknande' : ''}</small></td><td>{formatDate(illness.lastContactDate)}{illness.followup.contactOverdue && <small>Uppdatering saknas</small>}</td><td>{illness.status === 'recovered' ? `Sista sjukdag ${formatDate(illness.lastSickDate)}` : forecastLabel(illness.forecast)}</td><td><Pill tone={illness.status === 'recovered' ? 'green' : illness.followup.reviewRequired || illness.followup.contactOverdue || illness.followup.certificateRequired ? 'orange' : 'red'}>{illness.status === 'recovered' ? 'Friskanmälan' : illness.followup.reviewRequired || illness.followup.contactOverdue || illness.followup.certificateRequired ? 'Behöver uppföljning' : 'Pågående sjukfrånvaro'}</Pill></td><td><ChevronRight size={16} /></td></tr>; })}</tbody></table></div> : <div className="hr-empty"><HeartPulse size={28} /><strong>Inga sjukärenden matchar filtret</strong><p>Medarbetarnas sjukanmälningar från appen visas här. En behörig chef kan också registrera en anmälan.</p></div>}
        </Panel>}
      </>}
      {tab === 'underlay' && financialRead && <>
        {!personId && <Panel title="Välj person för löneunderlag" icon={<LockKeyhole size={18} />}><Field label="Person"><select value={currentPerson ?? ''} disabled={writing} onChange={event => { setSelectedPerson(event.target.value || undefined); setSelectedCaseId(undefined); }}><option value="">Välj person</option>{allPeople.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field></Panel>}
        {currentPerson ? <>
          <Panel title={`${selectedName} · sjuklön & karens`} icon={<ShieldCheck size={18} />} actions={<>{financialWrite && <button className="office-btn outline" disabled={busy || uncertain} onClick={() => openEditor('profile', undefined)}><Pencil size={14} />Beräkningsunderlag</button>}{data.underlay && <button className="office-btn outline" disabled={busy || exporting === key} onClick={() => void downloadCsv()}><Download size={14} />{exporting === key ? 'Exporterar…' : 'Exportera CSV'}</button>}</>}>
            {data.underlay ? <UnderlayView underlay={data.underlay} /> : <Alert tone="orange">Inget sjuklöneunderlag kunde hämtas för personen. Uppdatera vyn.</Alert>}
          </Panel>
          <Panel title="Karenshistorik & högriskskydd" icon={<History size={18} />} actions={financialWrite && <><button className="office-btn outline" disabled={busy || uncertain} onClick={() => openEditor('import', undefined)}><Plus size={14} />Tidigare karens</button><button className="office-btn outline" disabled={busy || uncertain} onClick={() => openEditor('highrisk', undefined)}><ShieldCheck size={14} />FK-beslut</button></>}>
            <Alert>Återinsjuknande inom fem kalenderdagar hör normalt till samma sjuklöneperiod och ger inget nytt karensavdrag. Efter tio karensavdrag inom tolv månader kan allmänt högriskskydd gälla. Dagliga bekräftelser skapar inget nytt avdrag.</Alert>
            <div className="hr-grid two"><div><h3 className="hr-sickness-label-note">Registrerade FK-beslut</h3>{data.highRiskDecisions.filter(decision => decision.personId === currentPerson).map(decision => <div className="hr-fact" key={decision.id}><span>{decision.kind === 'frequent' ? 'Ofta sjuk · undantag från karens' : 'Lång sjukperiod · ersättning till arbetsgivaren'}<small>{formatDate(decision.fromDate)}–{formatDate(decision.toDate)}</small></span><strong>{decision.reference}</strong></div>)}{!data.highRiskDecisions.some(decision => decision.personId === currentPerson) && <p className="hr-muted">Inga särskilda högriskbeslut registrerade.</p>}</div><div><h3 className="hr-sickness-label-note">Importerade karenstillfällen</h3>{data.deductionImports.filter(row => row.personId === currentPerson).map(row => <Fact key={row.id} label={formatDate(row.date)}>{row.source}</Fact>)}{!data.deductionImports.some(row => row.personId === currentPerson) && <p className="hr-muted">Ingen historik importerad. Importera tidigare avdrag från ett verifierat löneunderlag vid övergång till systemet.</p>}</div></div>
          </Panel>
          <Panel title="Bekräftad beräkningsgrund" icon={<LockKeyhole size={18} />}><div className="hr-sickness-profile-list">{data.profiles.filter(profile => profile.personId === currentPerson).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)).map(profile => <div key={`${profile.personId}/${profile.revision}/${profile.effectiveFrom}`}><h3>Gäller från {formatDate(profile.effectiveFrom)} · version {profile.revision}</h3><Pill tone={profile.confirmed ? 'green' : 'orange'}>{profile.confirmed ? 'Bekräftad' : 'Behöver bekräftas'}</Pill><p>{money(profile.hourlyBase)} / timme · {profile.averageWeeklyHours} normala timmar per vecka · {(profile.sickPayRate * 100).toLocaleString('sv-SE')} % sjuklön</p><p>Källa: {profile.source}</p></div>)}</div>{!data.profiles.some(profile => profile.personId === currentPerson) && <Alert tone="orange">En verifierad lönegrund behövs innan beloppen kan beräknas. Månadslön eller kollektivavtalsregler räknas inte om automatiskt med en antagen schablon.</Alert>}</Panel>
        </> : <div className="hr-empty"><LockKeyhole size={26} /><strong>Välj en person</strong><p>Individuella löneuppgifter visas bara med separat lönebehörighet.</p></div>}
      </>}
      {tab === 'settings' && !personId && <>
        <Panel title="Sjukregler & kontaktrutin" icon={<Settings2 size={18} />} actions={cap('policyWrite') && <button className="office-btn outline" disabled={busy || uncertain} onClick={() => { openEditor('policy', undefined); setEditor(value => value ? { ...value, confirmed: data.policy.calculationConfirmed, effectiveFrom: data.policy.effectiveFrom } : value); }}><Pencil size={14} />Redigera rutinen</button>}>
          <Fact label="Löneregler">{data.policy.agreement === 'statutory' ? 'Sjuklönelagen · lagens grundregler' : data.policy.agreement === 'collective' ? `Kollektivavtal · ${data.policy.agreementName || 'namn saknas'}` : 'Avtalsregler behöver fastställas'}</Fact><Fact label="Beräkningsregler"><Pill tone={data.policy.calculationConfirmed ? 'green' : 'orange'}>{data.policy.calculationConfirmed ? 'Bekräftade' : 'Ej fastställda'}</Pill></Fact><Fact label="Daglig bekräftelse">{data.policy.dailyContact ? `Arbetsplatsrutin · senast ${minuteLabel(data.policy.contactByMinute)}` : 'Ingen daglig bekräftelse krävs'}</Fact><Fact label="Gäller från">{formatDate(data.policy.effectiveFrom)}</Fact>
          <Alert>Daglig sjukanmälan är en arbetsplatsrutin, inget generellt lagkrav. Medarbetaren kan ange uppskattad återkomst eller ”vet inte”. Prognosen avslutar aldrig ett sjukärende.</Alert>
          {!data.policy.calculationConfirmed && <Alert tone="orange">Fastställ tillämpliga avtalsregler och individuellt löneunderlag för att få beräknade belopp. Sjukfrånvaro kan anmälas och följas upp redan nu.</Alert>}
        </Panel>
        <Panel title="Så följer systemet sjukperioder" icon={<ShieldCheck size={18} />}><div className="hr-sickness-checklist"><Check title="Karensavdrag – inte en hel karensdag" text="Lagens grundregel är 20 % av genomsnittlig veckosjuklön. Avdraget fördelas över sjuklön i samma period och får inte göra sjuklönen negativ." /><Check title="Återinsjuknande inom fem kalenderdagar" text="Sjukärendet kopplas normalt till föregående sjuklöneperiod. Eventuellt återstående karens följer med, utan ett nytt avdrag." /><Check title="Arbetsgivarens sjuklöneperiod" text="Normalt högst 14 kalenderdagar i den sammanhängande eller återkopplade sjuklöneperioden. Beräkningen utgår från faktisk frånvaro och schemalagd tid." /><Check title="Intyg och myndighetsuppföljning" text="Intyg behövs normalt från dag 8. Vid längre frånvaro får HR påminnelser om Försäkringskassan och plan för återgång. Inga myndighetsuppgifter skickas automatiskt." /><Check title="Låsta tidrapporter och historik" text="Rättelser behöver en orsak och respekterar tidrapportens månadsstatus. Sparade händelser och beräkningsgrunder bevaras." /></div><p className="hr-muted">Regelstöd: <a href="https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-19911047-om-sjuklon_sfs-1991-1047/" target="_blank" rel="noopener noreferrer">Sjuklönelagen</a> · <a href="https://www.forsakringskassan.se/arbetsgivare/sjukdom-och-skada/sjuklon" target="_blank" rel="noopener noreferrer">Försäkringskassan</a>. Fastställda kollektivavtalsregler kan påverka beräkningen.</p></Panel>
        <Panel title="Reglernas & underlagens historik" icon={<History size={18} />}><HistoryList events={data.events.filter(event => !event.caseId)} /></Panel>
      </>}
    </>}
    {activeEditor && data && <Dialog title={titles[activeEditor.kind]} description="Uppgifter sparas med person, tidpunkt och historik. Ange ingen diagnos." onClose={() => { if (!writing) setEditor(undefined); }}><form className="hr-sickness-dialog" onSubmit={event => void save(event)}><fieldset className="hr-form-fieldset" disabled={writing || uncertain || activeEditor.kind === 'policy' && !cap('policyWrite')}>
      {failure?.key === key && <Alert tone="red">{failure.message}</Alert>}
      <div className="hr-form-grid">
        {['report', 'profile', 'highrisk', 'import'].includes(activeEditor.kind) && <Field label="Person" full><select required disabled={!!personId || activeEditor.kind !== 'report' && !!currentPerson} value={activeEditor.personId} onChange={event => updateEditor({ personId: event.target.value })}><option value="">Välj person</option>{allPeople.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field>}
        {['report', 'correct'].includes(activeEditor.kind) && <><Field label="Första sjukdag"><input type="date" required max={today} value={activeEditor.fromDate} onChange={event => updateEditor({ fromDate: event.target.value })} /></Field><Field label="Från klockslag (vid del av dag)"><input type="time" value={activeEditor.startTime} onChange={event => updateEditor({ startTime: event.target.value })} /><small>Lämna tomt vid frånvaro från hela arbetspassets början.</small></Field></>}
        {['report', 'confirm', 'correct'].includes(activeEditor.kind) && <Field label="Nedsatt arbetsförmåga"><select required value={activeEditor.extent} onChange={event => updateEditor({ extent: Number(event.target.value) as SicknessExtent })}>{[100, 75, 50, 25].map(value => <option key={value} value={value}>{value} %</option>)}</select></Field>}
        {['report', 'confirm', 'forecast'].includes(activeEditor.kind) && <><Field label="Uppskattad återkomst"><select value={activeEditor.forecastKind} onChange={event => updateEditor({ forecastKind: event.target.value as SicknessForecast['kind'] })}><option value="unknown">Vet inte ännu</option><option value="date">Uppskattat datum</option></select></Field>{activeEditor.forecastKind === 'date' && <Field label="Uppskattat datum"><input type="date" required min={activeEditor.fromDate} value={activeEditor.forecastDate} onChange={event => updateEditor({ forecastDate: event.target.value })} /></Field>}</>}
        {activeEditor.kind === 'report' && <div className="full"><Alert>HR registrerar anmälan åt medarbetaren. Medarbetaren lämnar själv skriftlig försäkran i appen. Redan arbetad tid får inte räknas som sjukfrånvaro.</Alert><label className="hr-checkbox"><input type="checkbox" checked={activeEditor.declared} onChange={event => updateEditor({ declared: event.target.checked })} />Medarbetarens skriftliga försäkran är mottagen</label></div>}
        {['recover', 'correct'].includes(activeEditor.kind) && <><Field label="Sista faktiska sjukdag"><input type="date" required={activeEditor.kind === 'recover'} min={activeEditor.fromDate} max={today} value={activeEditor.lastSickDate} onChange={event => updateEditor({ lastSickDate: event.target.value })} /></Field><Field label="Åter i arbete under sista sjukdagen"><input type="time" value={activeEditor.recoveryTime} onChange={event => updateEditor({ recoveryTime: event.target.value })} /><small>Fyll bara i om återgången skedde under dagen.</small></Field><div className="full"><Alert>Friskanmälan sparar faktisk sista sjukdag. Återinsjuknande inom fem kalenderdagar ger normalt inget nytt karensavdrag.</Alert></div></>}
        {activeEditor.kind === 'correct' && <div className="full"><Alert tone="orange">Låsta eller inlämnade månadsrapporter måste återöppnas genom ordinarie granskning innan sjukfrånvaron där kan rättas.</Alert></div>}
        {activeEditor.kind === 'certificate' && <><label className="hr-checkbox full"><input type="checkbox" checked={activeEditor.certificateReceived} onChange={event => updateEditor({ certificateReceived: event.target.checked })} />Läkarintyget är mottaget</label>{activeEditor.certificateReceived && <><Field label="Intyget gäller från"><input type="date" required value={activeEditor.certificateFrom} onChange={event => updateEditor({ certificateFrom: event.target.value })} /></Field><Field label="Intyget gäller till"><input type="date" required min={activeEditor.certificateFrom} value={activeEditor.certificateTo} onChange={event => updateEditor({ certificateTo: event.target.value })} /></Field><Field label="Referens till skyddat intyg" full><input required maxLength={200} value={activeEditor.reference} onChange={event => updateEditor({ reference: event.target.value })} placeholder="Filnamn eller dokumentreferens – ange ingen diagnos" /></Field></>}<label className="hr-checkbox full"><input type="checkbox" checked={activeEditor.firstDayRequired} onChange={event => updateEditor({ firstDayRequired: event.target.checked })} />Skriftligt beslut om tidigare intyg finns</label>{activeEditor.firstDayRequired && <Field label="Särskilda skäl och referens till skriftligt beslut" full><textarea required minLength={10} maxLength={600} value={activeEditor.firstDayReason} onChange={event => updateEditor({ firstDayReason: event.target.value })} /></Field>}<div className="full"><Alert>Uppladdning görs i ärendets intygskort. Kontrollera giltighetsdatum och registrera dem här för korrekt uppföljning.</Alert></div></>}
        {activeEditor.kind === 'review' && <Field label="Utförd åtgärd" full><select value={activeEditor.reviewKind} onChange={event => updateEditor({ reviewKind: event.target.value as Editor['reviewKind'] })}><option value="checked">Ärendet har granskats</option><option value="insurer_reported">Anmälan till Försäkringskassan är gjord</option><option value="rehabilitation_plan">Plan för återgång är upprättad</option><option value="report_delay_exception">Hinder för tidigare sjukanmälan är utrett och dokumenterat</option><option value="return_work_verified">Full återgång och arbetad dag efter avslutad sjuklöneperiod är verifierad</option></select><small>Registrera bara en åtgärd som faktiskt har utförts. Ingen extern anmälan skickas här.</small></Field>}
        {activeEditor.kind === 'profile' && <><Field label="Gäller från"><input type="date" required value={activeEditor.effectiveFrom} onChange={event => updateEditor({ effectiveFrom: event.target.value })} /></Field><Field label="Verifierad sjuklönegrund per timme (kr)"><input type="number" min="0.01" step="0.01" required value={activeEditor.hourlyBase} onChange={event => updateEditor({ hourlyBase: event.target.value })} /></Field><Field label="Genomsnittlig normal veckoarbetstid"><input type="number" min="0.01" max="168" step="0.01" required value={activeEditor.weeklyHours} onChange={event => updateEditor({ weeklyHours: event.target.value })} /></Field><Field label="Sjuklön av lönebortfallet (%)"><input type="number" min="1" max="100" step="0.01" required value={activeEditor.sickPayRate} onChange={event => updateEditor({ sickPayRate: event.target.value })} /></Field><Field label="Källa och tillämplig avtalsregel" full><textarea required minLength={5} maxLength={600} value={activeEditor.source} onChange={event => updateEditor({ source: event.target.value })} placeholder="Exempel: verifierat löneunderlag och normal veckoarbetstid, regler för aktuell anställning" /></Field><label className="hr-checkbox full"><input type="checkbox" required checked={activeEditor.confirmed} onChange={event => updateEditor({ confirmed: event.target.checked })} />Jag har verifierat lönegrunden och tillämpliga avtalsregler</label><div className="full"><Alert>Timlönegrunden får inte vara en gissad omräkning av månadslön. Sjuklön är normalt 80 %. Karens är normalt 20 % av genomsnittlig veckosjuklön. Tidigare fastställda periodgrunder bevaras.</Alert></div></>}
        {activeEditor.kind === 'highrisk' && <><Field label="FK-beslutets typ" full><select value={activeEditor.highRiskKind} onChange={event => updateEditor({ highRiskKind: event.target.value as Editor['highRiskKind'] })}><option value="frequent">Ofta sjuk – inget karensavdrag enligt beslutet</option><option value="long">Längre sjukperiod – arbetsgivarens ersättning</option></select><small>Ett beslut om ersättning vid lång sjukperiod tar inte automatiskt bort karensavdraget.</small></Field><Field label="Beslut gäller från"><input type="date" required value={activeEditor.fromDate} onChange={event => updateEditor({ fromDate: event.target.value })} /></Field><Field label="Beslut gäller till"><input type="date" required min={activeEditor.fromDate} value={activeEditor.lastSickDate} onChange={event => updateEditor({ lastSickDate: event.target.value })} /></Field><Field label="Referens till Försäkringskassans beslut" full><input required minLength={3} maxLength={200} value={activeEditor.reference} onChange={event => updateEditor({ reference: event.target.value })} /></Field></>}
        {activeEditor.kind === 'import' && <><Field label="Datum för tidigare karensavdrag"><input type="date" required max={today} value={activeEditor.fromDate} onChange={event => updateEditor({ fromDate: event.target.value })} /></Field><Field label="Verifierat löneunderlag / källa" full><textarea required minLength={5} maxLength={600} value={activeEditor.source} onChange={event => updateEditor({ source: event.target.value })} /></Field><div className="full"><Alert>Registrera ett faktiskt karenstillfälle per sjuklöneperiod, inte varje sjukdag. Underlaget används för allmänt högriskskydd och ska kunna styrkas.</Alert></div></>}
        {activeEditor.kind === 'policy' && <><Field label="Tillämpliga regler" full><select value={activeEditor.agreement} onChange={event => updateEditor({ agreement: event.target.value as Editor['agreement'], ...(event.target.value === 'unknown' ? { confirmed: false } : {}) })}><option value="unknown">Avtal behöver fastställas</option><option value="statutory">Sjuklönelagens grundregler</option><option value="collective">Kollektivavtal</option></select></Field>{activeEditor.agreement === 'collective' && <Field label="Kollektivavtalets namn" full><input required maxLength={200} value={activeEditor.agreementName} onChange={event => updateEditor({ agreementName: event.target.value })} /></Field>}<Field label="Gäller från"><input type="date" required value={activeEditor.effectiveFrom} onChange={event => updateEditor({ effectiveFrom: event.target.value })} /></Field><Field label="Tid för daglig bekräftelse"><input type="time" disabled={!activeEditor.dailyContact} required={activeEditor.dailyContact} value={activeEditor.contactBy} onChange={event => updateEditor({ contactBy: event.target.value })} /></Field><label className="hr-checkbox full"><input type="checkbox" checked={activeEditor.dailyContact} onChange={event => updateEditor({ dailyContact: event.target.checked })} />Arbetsplatsen har rutin för daglig sjukbekräftelse</label><label className="hr-checkbox full"><input type="checkbox" disabled={activeEditor.agreement === 'unknown'} checked={activeEditor.confirmed} onChange={event => updateEditor({ confirmed: event.target.checked })} />{activeEditor.agreement === 'collective' ? 'Avtalet kan beräknas med denna modell: karens 20 % av genomsnittlig veckosjuklön och verifierad sjuklönesats/timlönegrund' : 'Beräkningsreglerna är kontrollerade och fastställda'}</label><div className="full"><Alert>Rutin för daglig kontakt innebär inte en ny sjukperiod. Modellen använder karens 20 % av genomsnittlig veckosjuklön och vald sjuklönesats på verifierad timlönegrund. Om kollektivavtalet kräver en annan beräkningsmodell ska reglerna lämnas obekräftade och underlaget hanteras separat.</Alert></div></>}
        {activeEditor.kind === 'declare' && <div className="full"><Alert>Registrera bara en skriftlig försäkran som medarbetaren själv har lämnat om sjukdom och nedsatt arbetsförmåga. Ange var den mottogs eller dess skyddade dokumentreferens. Diagnos ska inte anges.</Alert></div>}
        {['report', 'confirm', 'forecast', 'recover', 'declare', 'correct', 'review'].includes(activeEditor.kind) && <Field label={activeEditor.kind === 'correct' ? 'Orsak till rättelsen' : activeEditor.kind === 'declare' ? 'Referens till medarbetarens skriftliga försäkran' : 'Kontakt / åtgärdsreferens (utan medicinska uppgifter)'} full><textarea required={['correct', 'review', 'declare'].includes(activeEditor.kind) || activeEditor.kind === 'report' && activeEditor.declared} minLength={['correct', 'review', 'declare'].includes(activeEditor.kind) || activeEditor.kind === 'report' && activeEditor.declared ? 5 : undefined} maxLength={600} value={activeEditor.reason} onChange={event => updateEditor({ reason: event.target.value })} /></Field>}
      </div>
      <div className="hr-dialog-actions"><button type="button" className="office-btn outline" onClick={() => setEditor(undefined)}>Avbryt</button><button type="submit" className="office-btn">{writing ? 'Sparar…' : 'Spara'}</button></div>
    </fieldset></form></Dialog>}
  </div>;
}

function Metric({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return <div className="hr-metric"><span className="hr-metric-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}
function Check({ title, text, warning = false, complete = false }: { title: string; text: string; warning?: boolean; complete?: boolean }) {
  return <div className={`hr-sickness-check${warning ? ' warning' : complete ? ' complete' : ''}`}>{warning ? <TriangleAlert size={18} /> : complete ? <CheckCircle2 size={18} /> : <ClipboardCheck size={18} />}<div><strong>{title}</strong><p>{text}</p></div></div>;
}
function HistoryList({ events }: { events: SicknessManagementResponse['events'] }) {
  return events.length ? <ol className="hr-sickness-timeline">{[...events].sort((a, b) => b.at.localeCompare(a.at)).map(event => <li key={event.id}><strong>{event.text}</strong><time dateTime={event.at}>{fullTime(event.at)}</time>{event.reason && <p>{event.reason}</p>}</li>)}</ol> : <p className="hr-muted">Inga händelser registrerade ännu.</p>;
}
function CertificateFiles({ scope, illness, writable, scopeKey, onDenied }: { scope: SicknessScope; illness: SicknessCase; writable: boolean; scopeKey: string; onDenied: () => void }) {
  const key = `${scopeKey}/${illness.id}`, keyRef = useRef(key), denialRef = useRef(onDenied); keyRef.current = key; denialRef.current = onDenied;
  const controller = useRef<AbortController | undefined>(undefined), mounted = useRef(true), input = useRef<HTMLInputElement>(null);
  const [stored, setStored] = useState<{ key: string; files: SicknessFile[] }>(), [busyKey, setBusyKey] = useState<string>();
  const [failure, setFailure] = useState<{ key: string; message: string }>(), [uploadUncertain, setUploadUncertain] = useState<string>();
  const [notice, setNotice] = useState<{ key: string; message: string }>();
  const files = stored?.key === key ? stored.files : [], busy = busyKey === key;
  const readFiles = useCallback(async () => {
    const ownKey = key, requestController = new AbortController(); controller.current?.abort(); controller.current = requestController;
    setBusyKey(ownKey);
    try {
      const result = await sicknessFilesRequest(scope, { personId: illness.personId, caseId: illness.id }, undefined, requestController.signal);
      if (!('files' in result)) throw new Error('Intygens fillista gav ett ofullständigt svar.');
      if (mounted.current && keyRef.current === ownKey) { setStored({ key: ownKey, files: result.files }); setFailure(undefined); setUploadUncertain(undefined); }
    } catch (error) { if (mounted.current && !requestController.signal.aborted && keyRef.current === ownKey) { setFailure({ key: ownKey, message: errorText(error) }); if (error instanceof SicknessApiError && [401, 403].includes(error.status)) { setStored(undefined); denialRef.current(); } } }
    finally { if (mounted.current && keyRef.current === ownKey) setBusyKey(undefined); }
  }, [scope, key, illness.personId, illness.id]);
  useEffect(() => { mounted.current = true; void readFiles(); return () => { mounted.current = false; controller.current?.abort(); }; }, [readFiles]);
  const upload = async (file?: File) => {
    if (!file || busy || !writable || uploadUncertain === key) return;
    const ownKey = key, requestController = new AbortController(); controller.current?.abort(); controller.current = requestController;
    setBusyKey(ownKey); setFailure(undefined); setNotice(undefined);
    try {
      const result = await sicknessFilesRequest(scope, { personId: illness.personId, caseId: illness.id }, file, requestController.signal);
      if (!('file' in result)) throw new Error('Intygsuppladdningen gav ett ofullständigt svar.');
      if (mounted.current && keyRef.current === ownKey) {
        setStored({ key: ownKey, files: [...files.filter(value => value.id !== result.file.id), result.file] });
        setNotice({ key: ownKey, message: 'Intyg uppladdat. Kontrollera giltighetsdatum och registrera dem under intygsuppgifter.' });
      }
    } catch (error) {
      if (mounted.current && !requestController.signal.aborted && keyRef.current === ownKey) {
        setFailure({ key: ownKey, message: errorText(error) });
        if (!(error && typeof error === 'object' && 'status' in error && Number((error as { status: unknown }).status) >= 400 && Number((error as { status: unknown }).status) < 500)) setUploadUncertain(ownKey);
      }
    } finally { if (mounted.current && keyRef.current === ownKey) setBusyKey(undefined); if (input.current) input.current.value = ''; }
  };
  const download = async (file: SicknessFile) => {
    if (busy) return;
    const ownKey = key, requestController = new AbortController(); controller.current?.abort(); controller.current = requestController; setBusyKey(ownKey);
    try {
      const blob = await downloadSicknessFile(scope, file, requestController.signal);
      if (!mounted.current || keyRef.current !== ownKey || requestController.signal.aborted) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = file.name;
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { if (mounted.current && !requestController.signal.aborted && keyRef.current === ownKey) { setFailure({ key: ownKey, message: errorText(error) }); if (error instanceof SicknessApiError && [401, 403].includes(error.status)) { setStored(undefined); denialRef.current(); } } }
    finally { if (mounted.current && keyRef.current === ownKey) setBusyKey(undefined); }
  };
  return <div className="hr-sickness-private-files">
    <div className="hr-sickness-subheading"><h3>Skyddade intygsfiler</h3><div className="hr-actions"><button className="office-link" disabled={busy} onClick={() => void readFiles()}><RefreshCw size={14} />Uppdatera filer</button>{writable && <><input ref={input} type="file" className="hr-sickness-sr-only" aria-label="Välj intygsfil" accept="application/pdf,image/jpeg,image/png" disabled={busy || uploadUncertain === key} onChange={event => void upload(event.target.files?.[0])} /><button className="office-btn outline" disabled={busy || uploadUncertain === key} onClick={() => input.current?.click()}><Plus size={14} />Ladda upp intyg</button></>}</div></div>
    {failure?.key === key && <Alert tone="red">{failure.message}</Alert>}{notice?.key === key && <Alert tone="green">{notice.message}</Alert>}
    {uploadUncertain === key && <Alert tone="orange">Uppladdningens status är osäker. Uppdatera fillistan innan du försöker igen.</Alert>}
    {files.length ? <ul className="hr-sickness-file-list">{files.map(file => <li key={file.id}><FileCheck2 size={17} /><div><strong>{file.name}</strong><small>{Math.ceil(file.size / 1024)} kB · {fullTime(file.uploadedAt)}</small></div><button className="office-link" disabled={busy} onClick={() => void download(file)}><Download size={14} />Hämta</button></li>)}</ul> : <p className="hr-muted">{busy ? 'Hämtar intygsfiler…' : 'Inga intygsfiler har laddats upp.'}</p>}
    <p className="hr-sickness-label-note"><LockKeyhole size={12} />Endast medarbetaren och personal med sjukfrånvarobehörighet kan hämta filerna. PDF, JPG eller PNG · högst 5 MB.</p>
  </div>;
}
function UnderlayView({ underlay }: { underlay: SicknessUnderlay }) {
  return <><Pill tone={underlay.calculationStatus === 'calculated' ? 'green' : 'orange'}>{profileStatus[underlay.calculationStatus]}</Pill><p className="hr-sickness-label-note">Beräknat {fullTime(underlay.generatedAt)}. Underlag för lönehantering – ingen lön har betalats ut.</p>{underlay.messages.map(message => <Alert key={message} tone="orange">{message}</Alert>)}
    <div className="hr-metrics"><div className="hr-metric"><div><small>Sjuklön före karens</small><strong>{money(underlay.totalGrossSickPay)}</strong></div></div><div className="hr-metric"><div><small>Karensavdrag</small><strong>{money(underlay.totalDeduction)}</strong></div></div><div className="hr-metric"><div><small>Sjuklön efter karens</small><strong>{money(underlay.totalPayableSickPay)}</strong></div></div></div>
    {underlay.cycles.map(cycle => <div className="hr-sickness-basis" key={cycle.id}><strong>Sjuklöneperiod från {formatDate(cycle.firstDate)}</strong> · {exemptionLabel[cycle.deductionExemption]}<br />Karensmål {money(cycle.deductionTarget)} · dragen {money(cycle.deductionTaken)} · återstår {money(cycle.deductionRemaining)}{cycle.basis && <><br />Periodens grund: {money(cycle.basis.hourlyBase)} / timme · {cycle.basis.averageWeeklyHours} h/vecka · {(cycle.basis.sickPayRate * 100).toLocaleString('sv-SE')} % sjuklön · version {cycle.basis.revision}<br />Källa: {cycle.basis.source}</>}</div>)}
    <div className="hr-table-scroll"><table className="hr-table"><thead><tr><th>Datum / perioddag</th><th className="hr-sickness-numeric">Frånvarotid</th><th className="hr-sickness-numeric">Lönebortfall</th><th className="hr-sickness-numeric">Sjuklön</th><th className="hr-sickness-numeric">Karens</th><th className="hr-sickness-numeric">Efter karens</th><th>Status</th></tr></thead><tbody>{underlay.rows.map(row => <tr key={`${row.caseId}/${row.date}`}><td>{formatDate(row.date)}<small>Dag {row.employerDay}</small></td><td className="hr-sickness-numeric">{hours(row.lostMinutes)}</td><td className="hr-sickness-numeric">{money(row.salaryLoss)}</td><td className="hr-sickness-numeric">{money(row.grossSickPay)}</td><td className="hr-sickness-numeric">{money(row.karensDeduction)}</td><td className="hr-sickness-numeric">{money(row.payableSickPay)}</td><td><Pill tone={row.status === 'calculated' ? 'green' : row.status === 'outside_employer_period' ? 'grey' : 'orange'}>{rowStatus[row.status]}</Pill>{row.messages.map(message => <small key={message}>{message}</small>)}</td></tr>)}</tbody></table>{!underlay.rows.length && <p className="hr-muted">Inga sjukfrånvarodagar finns att beräkna.</p>}</div>
  </>;
}
