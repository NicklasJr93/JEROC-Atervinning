import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, CheckCircle2, CircleAlert, Code2, Copy, Database, FileText, FlaskConical, History, LoaderCircle, LogOut, Plus, RefreshCw, Send, ShieldCheck, Trash2 } from 'lucide-react';
import { can, type OfficeUser } from './model';
import { EnvironmentApiError } from './environment-client';
import { environmentFailure, useEnvironmentSession } from './EnvironmentSession';
import { environmentTime, type NvvJsonObject, type NvvJsonValue } from './environment-types';
import NvvConnectionCheckDialog, { type NvvCheckProgress } from './NvvConnectionCheckDialog';
import { vismaSandboxApi, type VismaOperation, type VismaParameters, type VismaSandboxRequest, type VismaSandboxRun, type VismaSandboxStatus, type VismaAttestedCard, type VismaCardPrefill } from './visma-sandbox-client';
import './environment.css';
import './nvv-sandbox.css';
import './visma-sandbox.css';

const runLabels: Record<VismaSandboxRun['status'], string> = { in_flight: 'Inväntar Visma', accepted: 'Svar från SANDBOX', rejected: 'Avvisat', unknown: 'Oklart resultat' };
const operationLabels: Record<VismaOperation, string> = {
  company: 'Läs företagsidentitet', fiscalYears: 'Läs räkenskapsår', accounts: 'Läs kontoplan', paymentTerms: 'Läs betalningsvillkor',
  vatCodes: 'Läs momskoder', costCenters: 'Läs kostnadsställen', projects: 'Läs projekt',
  suppliers: 'Läs leverantörer', supplier: 'Läs en leverantör', draft: 'Läs ett fakturautkast', createSupplier: 'Skapa testleverantör', createDraft: 'Skapa leverantörsfakturautkast',
};
const jsonText = (value: unknown) => JSON.stringify(value, null, 2);
const objectValue = (value: unknown): NvvJsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as NvvJsonObject : {};
const fieldValue = (payload: NvvJsonObject | undefined, key: string) => typeof payload?.[key] === 'string' || typeof payload?.[key] === 'number' ? String(payload[key]) : '';
const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const placeholderUuids = new Set(['00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000000']);
const usableUuid = (value: string) => uuidPattern.test(value) && !placeholderUuids.has(value);
const writeOperation = (operation: VismaOperation) => operation === 'createSupplier' || operation === 'createDraft';
const results = (response: unknown): NvvJsonObject[] => {
  const data = objectValue(response).Data;
  return Array.isArray(data) ? data.map(objectValue) : [];
};
function parsePayload(value: string): NvvJsonObject {
  const result: unknown = JSON.parse(value);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('JSON-payloaden måste vara ett objekt.');
  return result as NvvJsonObject;
}
function starterPayload(operation: 'createSupplier' | 'createDraft', templates?: VismaSandboxStatus['templates']): NvvJsonObject {
  const payload: NvvJsonObject = structuredClone(templates?.[operation] ?? (operation === 'createSupplier'
    ? { Name: 'JEROC Sandbox Leverantör', CountryCode: 'SE', CurrencyCode: 'SEK', IsActive: true, TermsOfPaymentId: '' }
    : { SupplierId: '', IsCreditInvoice: false, InvoiceNumber: 'JEROC-TEST-001', CurrencyCode: 'SEK', TotalAmount: 100, Vat: 0, SkipSendToBank: true, Rows: [{ DebitAmount: 100, CreditAmount: 0, LineNumber: 1 }, { DebitAmount: 0, CreditAmount: 100, LineNumber: 2 }] }));
  for (const key of ['TermsOfPaymentId', 'SupplierId']) if (typeof payload[key] === 'string' && placeholderUuids.has(payload[key])) payload[key] = '';
  if (operation === 'createDraft') {
    const rows = Array.isArray(payload.Rows) ? payload.Rows : [];
    payload.Rows = (rows.length > 1 ? rows : [{ ...objectValue(rows[0]), DebitAmount: Number(payload.TotalAmount ?? 0), CreditAmount: 0, LineNumber: 1 }, { DebitAmount: 0, CreditAmount: Number(payload.TotalAmount ?? 0), LineNumber: 2 }]).map(row => {
      const copy = { ...objectValue(row) }; delete copy.AccountNumber; return copy;
    });
  }
  return payload;
}
const progressFor = (run: VismaSandboxRun): NvvCheckProgress => run.status === 'in_flight'
  ? { phase: 'running', mode: 'test' }
  : run.status === 'accepted' ? { phase: 'success', mode: 'test', wasteCodes: 0, transportModes: 0 }
    : { phase: 'error', mode: 'test', message: run.error?.message || (run.status === 'unknown' ? 'Serverns slutresultat är oklart. Läs testföretagets uppgifter och kontrollera resultatet innan ett nytt skrivtest.' : 'Visma avvisade anropet. Se råsvaret nedan.') };
type TestDialog = { request: VismaSandboxRequest; run: VismaSandboxRun; progress: NvvCheckProgress };
type LookupState = { fiscalYears: NvvJsonObject[]; accounts: NvvJsonObject[]; paymentTerms: NvvJsonObject[]; suppliers: NvvJsonObject[] };
type Acknowledgments = Record<string, { acknowledgedAt: string; run?: VismaSandboxRun }>;
const emptyLookups = (): LookupState => ({ fiscalYears: [], accounts: [], paymentTerms: [], suppliers: [] });
const moneyText = (value: number) => `${value.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`;
const sourceReference = (source: VismaCardPrefill['source']) => ({ cardId: source.cardId, approvalId: source.approvalId, version: source.version, hash: source.hash });
function prefilledForms(prefill: VismaCardPrefill, lookups: LookupState, runs: VismaSandboxRun[]) {
  const supplier = structuredClone(prefill.supplier), draft = structuredClone(prefill.draft);
  const numbered = lookups.suppliers.filter(item => item.IsActive !== false && supplier.SupplierNumber && item.SupplierNumber === supplier.SupplierNumber);
  const identified = numbered.length ? numbered : lookups.suppliers.filter(item => item.IsActive !== false && supplier.CorporateIdentityNumber &&
    fieldValue(item, 'CorporateIdentityNumber').replace(/\D/g, '') === supplier.CorporateIdentityNumber);
  const match = identified.length === 1 ? identified[0] : undefined;
  const created = runs.find(run => run.operation === 'createSupplier' && run.status === 'accepted' && usableUuid(run.resourceId ?? '') &&
    run.source?.cardId === prefill.source.cardId && run.source.hash === prefill.source.hash);
  const purchaseTerms = lookups.paymentTerms.filter(term => term.AvailableForPurchase === true && usableUuid(fieldValue(term, 'Id')));
  const term = purchaseTerms.find(item => item.Id === supplier.TermsOfPaymentId) ?? purchaseTerms.find(item => item.Id === match?.TermsOfPaymentId)
    ?? purchaseTerms.find(item => item.NumberOfDays === 0) ?? purchaseTerms[0];
  if (term) supplier.TermsOfPaymentId = term.Id;
  if (match && usableUuid(fieldValue(match, 'Id'))) draft.SupplierId = match.Id;
  else if (created) draft.SupplierId = created.resourceId!;
  const days = Number(term?.NumberOfDays);
  if (term && Number.isInteger(days) && days >= 0 && days <= 10000) {
    const due = new Date(`${String(draft.InvoiceDate)}T00:00:00Z`); due.setUTCDate(due.getUTCDate() + days); draft.DueDate = due.toISOString().slice(0, 10);
  }
  draft.Rows = (draft.Rows as NvvJsonObject[]).map(row => {
    const proposed = Number(row.CreditAmount) > 0 ? 2440 : 4000;
    return lookups.accounts.some(account => Number(account.Number) === proposed && account.IsActive === true &&
      !account.IsFirstCostCenterMandatory && !account.IsSecondCostCenterMandatory && !account.IsThirdCostCenterMandatory && !account.IsProjectMandatory)
      ? { ...row, AccountNumber: proposed } : row;
  });
  return { createSupplier: supplier, createDraft: draft };
}

// Keep the frozen request across a tab reload. This journal never replays it;
// only the request UUID is used to retrieve the server's saved result.
function restorePending(key: string, actualUserId: string, effectiveUserId: string): TestDialog | undefined {
  try {
    const value = window.sessionStorage.getItem(key);
    if (!value || value.length > 256 * 1024) return;
    const saved = JSON.parse(value), request = saved?.request;
    if (saved.version !== 1 || saved.actualUserId !== actualUserId || saved.effectiveUserId !== effectiveUserId || !request ||
      typeof request.requestId !== 'string' || !usableUuid(request.requestId) || typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length > 100 ||
      typeof request.operation !== 'string' || !Object.hasOwn(operationLabels, request.operation) ||
      saved.method !== (writeOperation(request.operation) ? 'POST' : 'GET') || typeof saved.path !== 'string' || saved.path.length > 500 ||
      typeof saved.startedAt !== 'string' || !Number.isFinite(Date.parse(saved.startedAt))) return;
    if (request.parameters !== undefined && (!request.parameters || typeof request.parameters !== 'object' || Array.isArray(request.parameters) ||
      Object.entries(request.parameters).some(([name, id]) => !['fiscalYearId', 'resourceId'].includes(name) || typeof id !== 'string' || !usableUuid(id)))) return;
    if (request.payload !== undefined && (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload))) return;
    if (request.source !== undefined && (!Number.isSafeInteger(request.source?.cardId) || request.source.cardId <= 0 || !usableUuid(request.source.approvalId) ||
      !Number.isInteger(request.source.version) || request.source.version <= 0 || !/^[a-f0-9]{64}$/.test(request.source.hash))) return;
    const frozen = structuredClone(request) as VismaSandboxRequest;
    const run: VismaSandboxRun = { id: frozen.requestId, status: 'unknown', operation: frozen.operation, method: saved.method, path: saved.path,
      parameters: frozen.parameters, payload: frozen.payload, source: frozen.source, startedAt: saved.startedAt, httpStatus: null, response: null, trackingId: '',
      error: { code: 'response_unknown', message: 'Ett tidigare test saknar säkert slutresultat. Kontrollera historiken innan ett nytt test.' } };
    return { request: frozen, run, progress: progressFor(run) };
  } catch { return; }
}
function savePending(key: string, actualUserId: string, effectiveUserId: string, pending: TestDialog): boolean {
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ version: 1, actualUserId, effectiveUserId, request: pending.request,
      method: pending.run.method, path: pending.run.path, startedAt: pending.run.startedAt }));
    return true;
  } catch { return false; }
}
function clearPending(key: string, requestId: string) {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (saved?.request?.requestId === requestId) window.sessionStorage.removeItem(key);
  } catch { /* The durable server history remains available. */ }
}
function restoreAcknowledgments(key: string, actualUserId: string, effectiveUserId: string): Acknowledgments {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (saved?.version !== 1 || saved.actualUserId !== actualUserId || saved.effectiveUserId !== effectiveUserId || !saved.entries || typeof saved.entries !== 'object') return {};
    const result: Acknowledgments = {};
    for (const [id, value] of Object.entries(saved.entries)) {
      const entry = objectValue(value), archived = objectValue(entry.run);
      if (!usableUuid(id) || typeof entry.acknowledgedAt !== 'string' || !Number.isFinite(Date.parse(entry.acknowledgedAt))) continue;
      result[id] = { acknowledgedAt: entry.acknowledgedAt };
      if (archived.id !== id || !['createSupplier', 'createDraft'].includes(String(archived.operation)) || archived.method !== 'POST' ||
        typeof archived.path !== 'string' || archived.path.length > 500 || typeof archived.startedAt !== 'string' || !Number.isFinite(Date.parse(archived.startedAt))) continue;
      result[id].run = { id, status: 'unknown', operation: archived.operation as VismaOperation, method: 'POST', path: archived.path, startedAt: archived.startedAt,
        ...(archived.payload && typeof archived.payload === 'object' && !Array.isArray(archived.payload) ? { payload: archived.payload } : {}),
        parameters: objectValue(archived.parameters), httpStatus: null, response: null, trackingId: '' };
    }
    return result;
  } catch { return {}; }
}
function saveAcknowledgments(key: string, actualUserId: string, effectiveUserId: string, entries: Acknowledgments): boolean {
  try {
    const metadata = Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, { acknowledgedAt: entry.acknowledgedAt,
      ...(entry.run ? { run: { id, operation: entry.run.operation, method: entry.run.method, path: entry.run.path, payload: entry.run.payload, parameters: entry.run.parameters, startedAt: entry.run.startedAt } } : {}) }]));
    window.sessionStorage.setItem(key, JSON.stringify({ version: 1, actualUserId, effectiveUserId, entries: metadata })); return true;
  } catch { return false; }
}
function retainUnknownRuns(runs: VismaSandboxRun[], pending: TestDialog | undefined, acknowledgments: Acknowledgments) {
  const merged = new Map<string, VismaSandboxRun>();
  for (const entry of Object.values(acknowledgments)) if (entry.run) merged.set(entry.run.id, entry.run);
  if (pending) merged.set(pending.run.id, pending.run);
  for (const run of runs) merged.set(run.id, run);
  return [...merged.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
}

export default function VismaSandboxWorkspace({ user, actualUser }: { user: OfficeUser; actualUser: OfficeUser }) {
  const { session, loading: sessionLoading, error: sessionError, refreshSession } = useEnvironmentSession();
  const permitted = user.level === 'Systemadmin' && actualUser.level === 'Systemadmin' && !user.siteIds && !actualUser.siteIds && can(user, 'integrationsRead');
  const sessionMatches = session?.actualUserId === actualUser.id && session?.effectiveUserId === user.id;
  const identity = `${actualUser.id}/${actualUser.level}/${actualUser.permissions.join(',')}/${actualUser.siteIds?.join(',') ?? 'all'}/${user.id}/${user.level}/${user.permissions.join(',')}/${user.siteIds?.join(',') ?? 'all'}`;
  const pendingStorageKey = `jeroc.visma-sandbox.pending:${encodeURIComponent(actualUser.id)}:${encodeURIComponent(user.id)}`;
  const acknowledgmentStorageKey = `jeroc.visma-sandbox.acknowledged:${encodeURIComponent(actualUser.id)}:${encodeURIComponent(user.id)}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const mounted = useRef(true), generation = useRef(0), busy = useRef(false);
  const readFlight = useRef<{ controller: AbortController; promise: Promise<void>; generation: number } | undefined>(undefined);
  const writeController = useRef<AbortController | undefined>(undefined);
  const pendingRef = useRef<TestDialog | undefined>(undefined);
  const acknowledgmentsRef = useRef<Acknowledgments>({});
  const formRef = useRef<{ createSupplier: NvvJsonObject; createDraft: NvvJsonObject } | undefined>(undefined);
  const dialogRef = useRef<TestDialog | null>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const [sandbox, setSandbox] = useState<VismaSandboxStatus>();
  const [attestedCards, setAttestedCards] = useState<VismaAttestedCard[]>([]);
  const [cardPrefill, setCardPrefill] = useState<VismaCardPrefill>();
  const [operation, setOperation] = useState<VismaOperation>('company');
  const [parameters, setParameters] = useState<VismaParameters>({});
  const [forms, setForms] = useState<{ createSupplier: NvvJsonObject; createDraft: NvvJsonObject }>();
  const [editor, setEditor] = useState<'fields' | 'json'>('fields');
  const [raw, setRaw] = useState('');
  const [lookups, setLookups] = useState<LookupState>(emptyLookups);
  const [loading, setLoading] = useState(false), [sending, setSending] = useState(false), [connectionBusy, setConnectionBusy] = useState(false);
  const [acknowledgments, setAcknowledgments] = useState<Acknowledgments>({});
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<TestDialog | null>(null);
  const [callback, setCallback] = useState(() => new URLSearchParams(window.location.search).get('vismaOAuth'));
  const [localCallbackUrl, setLocalCallbackUrl] = useState('');
  dialogRef.current = dialog;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; readFlight.current?.controller.abort(); writeController.current?.abort(); }; }, []);
  useEffect(() => {
    generation.current++; readFlight.current?.controller.abort(); readFlight.current = undefined; writeController.current?.abort(); writeController.current = undefined;
    let recovered = permitted ? restorePending(pendingStorageKey, actualUser.id, user.id) : undefined;
    if (recovered?.run.method === 'GET') { clearPending(pendingStorageKey, recovered.run.id); recovered = undefined; }
    const restoredAcknowledgments = permitted ? restoreAcknowledgments(acknowledgmentStorageKey, actualUser.id, user.id) : {};
    acknowledgmentsRef.current = restoredAcknowledgments; setAcknowledgments(restoredAcknowledgments);
    busy.current = false; pendingRef.current = recovered; formRef.current = undefined; dialogRef.current = null;
    setSandbox(undefined); setForms(undefined); setOperation('company'); setParameters({}); setLookups(emptyLookups()); setRaw(''); setEditor('fields');
    setLoading(false); setSending(false); setConnectionBusy(false); setError(''); setNotice(''); setDialog(null);
    setLocalCallbackUrl('');
    setAttestedCards([]); setCardPrefill(undefined);
  }, [identity]);

  const applyLookup = useCallback((run: VismaSandboxRun) => {
    if (run.status !== 'accepted') return;
    if (['fiscalYears', 'accounts', 'paymentTerms', 'suppliers'].includes(run.operation))
      setLookups(state => ({ ...state, [run.operation]: results(run.response) }));
  }, []);
  const publishRun = useCallback((run: VismaSandboxRun) => {
    setSandbox(state => state ? { ...state, runs: [run, ...state.runs.filter(item => item.id !== run.id)].slice(0, 50) } : state);
    const acknowledged = acknowledgmentsRef.current[run.id];
    if (acknowledged?.run && (run.status === 'accepted' || run.status === 'rejected')) {
      const entries = { ...acknowledgmentsRef.current, [run.id]: { acknowledgedAt: acknowledged.acknowledgedAt } };
      acknowledgmentsRef.current = entries; setAcknowledgments(entries);
      saveAcknowledgments(acknowledgmentStorageKey, actualUser.id, user.id, entries);
    }
    applyLookup(run);
  }, [applyLookup, acknowledgmentStorageKey, actualUser.id, user.id]);
  const load = useCallback((): Promise<void> => {
    if (!permitted || !sessionMatches) return Promise.resolve();
    const epoch = generation.current;
    if (readFlight.current?.generation === epoch) return readFlight.current.promise;
    const controller = new AbortController(), current = () => mounted.current && !controller.signal.aborted && generation.current === epoch && identityRef.current === identity;
    const flight = { controller, generation: epoch, promise: Promise.resolve() };
    setLoading(true);
    flight.promise = (async () => {
      try {
        const [next, available] = await Promise.all([vismaSandboxApi.status(controller.signal), vismaSandboxApi.attestedCards(controller.signal)]);
        if (!current()) return;
        setAttestedCards(available.cards);
        const pending = pendingRef.current;
        setSandbox({ ...next, runs: retainUnknownRuns(next.runs, pending, acknowledgmentsRef.current) });
        if (!formRef.current) {
          const initial = { createSupplier: starterPayload('createSupplier', next.templates), createDraft: starterPayload('createDraft', next.templates) };
          formRef.current = initial; setForms(initial);
        }
        for (const lookup of ['fiscalYears', 'accounts', 'paymentTerms', 'suppliers'] as const) {
          const latest = next.runs.find(run => run.operation === lookup && run.status === 'accepted');
          if (latest) applyLookup(latest);
        }
        if (pending) {
          let found = next.runs.find(run => run.id === pending.run.id);
          if (!found || found.status === 'in_flight' || found.status === 'unknown') {
            try { found = await vismaSandboxApi.historyRun(pending.run.id, controller.signal); }
            catch (failure) { if (!(failure instanceof EnvironmentApiError && failure.status === 404)) throw failure; }
          }
          if (!current()) return;
          if (found) {
            publishRun(found);
            const nextDialog = { ...pending, run: structuredClone(found), progress: progressFor(found) };
            if (found.status === 'accepted' || found.status === 'rejected') { clearPending(pendingStorageKey, found.id); pendingRef.current = undefined; }
            else pendingRef.current = nextDialog;
            if (dialogRef.current?.run.id === found.id) { dialogRef.current = nextDialog; setDialog(nextDialog); }
          }
        }
        setError('');
      } catch (failure) { if (current()) setError(environmentFailure(failure)); }
      finally { if (current()) setLoading(false); if (readFlight.current === flight) readFlight.current = undefined; }
    })();
    readFlight.current = flight; return flight.promise;
  }, [permitted, sessionMatches, identity, pendingStorageKey, applyLookup, publishRun]);
  useEffect(() => {
    if (permitted && sessionMatches) void load();
    return () => { readFlight.current?.controller.abort(); readFlight.current = undefined; };
  }, [identity, permitted, sessionMatches, load]);

  function adoptForm(target: 'createSupplier' | 'createDraft', payload: NvvJsonObject) {
    const copy = structuredClone(payload), next = { createSupplier: formRef.current?.createSupplier ?? starterPayload('createSupplier'), createDraft: formRef.current?.createDraft ?? starterPayload('createDraft'), [target]: copy };
    formRef.current = next; setForms(next); if (operation === target) setRaw(jsonText(copy)); setError('');
  }
  async function selectAttestedCard(value: string) {
    if (busy.current || readFlight.current || !permitted || !sessionMatches) return;
    if (!value) {
      setCardPrefill(undefined);
      const next = { createSupplier: starterPayload('createSupplier', sandbox?.templates), createDraft: starterPayload('createDraft', sandbox?.templates) };
      formRef.current = next; setForms(next); setEditor('fields'); setRaw(''); return;
    }
    const epoch = generation.current, controller = new AbortController(); writeController.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && generation.current === epoch && identityRef.current === identity;
    busy.current = true; setConnectionBusy(true); setError(''); setNotice('');
    try {
      const prefill = await vismaSandboxApi.prefill(Number(value), controller.signal);
      if (!current()) return;
      const next = prefilledForms(prefill, lookups, sandbox?.runs ?? []);
      setCardPrefill(prefill); formRef.current = next; setForms(next); setOperation(usableUuid(fieldValue(next.createDraft, 'SupplierId')) ? 'createDraft' : 'createSupplier');
      setEditor('fields'); setRaw('');
      setNotice(`Uppgifterna är hämtade från ${prefill.source.number}, attesterad av ${prefill.source.attestedBy}. Granska testunderlaget före sändning.`);
    } catch (failure) { if (current()) setError(environmentFailure(failure)); }
    finally { if (current()) { busy.current = false; setConnectionBusy(false); } if (writeController.current === controller) writeController.current = undefined; }
  }
  async function prepareSpirisChoices() {
    if (!permitted || !sessionMatches || busy.current || readFlight.current || !sandbox?.companyVerified || inFlight) return;
    const epoch = generation.current, controller = new AbortController(); writeController.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && generation.current === epoch && identityRef.current === identity;
    busy.current = true; setConnectionBusy(true); setError(''); setNotice('');
    const collected = { ...lookups };
    const readChoice = async (target: 'paymentTerms' | 'fiscalYears' | 'suppliers' | 'accounts', parameters: VismaParameters = {}) => {
      const descriptor = sandbox.operations.find(item => item.id === target)!;
      const requestId = crypto.randomUUID(), request: VismaSandboxRequest = { requestId, idempotencyKey: `visma-choices-${requestId}`, operation: target, parameters };
      const run: VismaSandboxRun = { id: requestId, operation: target, method: 'GET', path: descriptor.path.replace('{fiscalYearId}', parameters.fiscalYearId ?? ''),
        parameters, status: 'in_flight', startedAt: new Date().toISOString(), trackingId: '' };
      const pending = { request, run, progress: progressFor(run) }; dialogRef.current = pending; setDialog(pending);
      let result: VismaSandboxRun;
      try { result = await vismaSandboxApi.run(request, controller.signal); }
      catch (failure) { result = { ...run, status: 'unknown', error: { code: 'response_unknown', message: environmentFailure(failure) } }; }
      if (!current()) return false;
      publishRun(result);
      const completed = { request, run: result, progress: progressFor(result) }; dialogRef.current = completed; setDialog(completed);
      if (result.status !== 'accepted') throw new Error(result.error?.message || 'Spiris-valen kunde inte hämtas. Se svaret i historiken.');
      collected[target] = results(result.response); return true;
    };
    try {
      for (const target of ['paymentTerms', 'fiscalYears', 'suppliers'] as const) if (!await readChoice(target)) return;
      const date = fieldValue(formRef.current?.createDraft, 'InvoiceDate') || new Date().toISOString().slice(0, 10);
      const year = collected.fiscalYears.find(item => usableUuid(fieldValue(item, 'Id')) && item.IsLockedForAccounting !== true &&
        fieldValue(item, 'StartDate').slice(0, 10) <= date && fieldValue(item, 'EndDate').slice(0, 10) >= date);
      collected.accounts = [];
      if (year) { if (!await readChoice('accounts', { fiscalYearId: String(year.Id) })) return; setParameters(state => ({ ...state, fiscalYearId: String(year.Id) })); }
      if (!current()) return;
      setLookups(collected);
      if (cardPrefill && formRef.current) {
        const previous = formRef.current, proposals = prefilledForms({ ...cardPrefill, supplier: previous.createSupplier, draft: previous.createDraft }, collected, sandbox.runs);
        const supplier = { ...previous.createSupplier }, draft = { ...previous.createDraft };
        for (const key of ['TermsOfPaymentId']) if (!fieldValue(supplier, key) && proposals.createSupplier[key] !== undefined) supplier[key] = proposals.createSupplier[key];
        for (const key of ['SupplierId', 'DueDate']) if (!fieldValue(draft, key) && proposals.createDraft[key] !== undefined) draft[key] = proposals.createDraft[key];
        draft.Rows = (draft.Rows as NvvJsonObject[]).map((row, index) => row.AccountNumber ? row : (proposals.createDraft.Rows as NvvJsonObject[])[index]);
        const next = { createSupplier: supplier, createDraft: draft }; formRef.current = next; setForms(next);
        if (editor === 'fields') setRaw(jsonText(next[operation === 'createDraft' ? 'createDraft' : 'createSupplier']));
      }
      setNotice(year ? 'Spiris betalvillkor, leverantörer och kontoplan har hämtats. Saknade val är förifyllda där ett matchande förslag finns.'
        : 'Betalvillkor och leverantörer har hämtats. Inget öppet räkenskapsår matchade fakturadatumet; välj räkenskapsår och läs kontoplanen.');
    } catch (failure) { if (current()) setError(environmentFailure(failure)); }
    finally { if (current()) { busy.current = false; setConnectionBusy(false); } if (writeController.current === controller) writeController.current = undefined; }
  }
  function updateField(target: 'createSupplier' | 'createDraft', key: string, value: NvvJsonValue | undefined) {
    const copy = structuredClone(formRef.current?.[target] ?? {});
    if (value === undefined) delete copy[key]; else copy[key] = value;
    adoptForm(target, copy);
  }
  function selectOperation(next: VismaOperation) {
    if (writeOperation(operation) && editor === 'json') {
      try { adoptForm(operation as 'createSupplier' | 'createDraft', parsePayload(raw)); }
      catch (failure) { setError(`JSON-payloaden kunde inte läsas: ${environmentFailure(failure)}`); return; }
    }
    setOperation(next); setEditor('fields'); setError('');
    if (writeOperation(next)) setRaw(jsonText(formRef.current?.[next as 'createSupplier' | 'createDraft'] ?? {}));
  }
  function switchEditor(next: 'fields' | 'json') {
    if (!writeOperation(operation) || editor === next) return;
    const target = operation as 'createSupplier' | 'createDraft';
    if (next === 'fields') {
      try { adoptForm(target, parsePayload(raw)); }
      catch (failure) { setError(`JSON-payloaden kunde inte läsas: ${environmentFailure(failure)}`); return; }
    } else setRaw(jsonText(formRef.current?.[target] ?? {}));
    setEditor(next); setError('');
  }
  function clearCallback() {
    const url = new URL(window.location.href); url.searchParams.delete('vismaOAuth'); window.history.replaceState(window.history.state, '', url); setCallback(null);
  }
  async function connectionAction(action: 'start' | 'complete' | 'disconnect') {
    if (!permitted || !sessionMatches || busy.current || readFlight.current || loading || (action === 'complete' && callback !== 'ok')) return;
    const epoch = generation.current, controller = new AbortController(); writeController.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && generation.current === epoch && identityRef.current === identity;
    busy.current = true; setConnectionBusy(true); setError(''); setNotice('');
    try {
      if (action === 'start') {
        const result = await vismaSandboxApi.startOAuth(controller.signal);
        if (!current()) return;
        const url = new URL(result.authorizationUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'identity.vismaonline.com' || url.port || url.username || url.password || url.pathname !== '/connect/authorize') throw new Error('Servern returnerade ingen giltig Visma-inloggningsadress.');
        window.location.assign(url.href);
      } else {
        const next = await (action === 'complete' ? vismaSandboxApi.completeOAuth(controller.signal) : vismaSandboxApi.disconnect(controller.signal));
        if (!current()) return;
        setSandbox({ ...next, runs: retainUnknownRuns(next.runs, pendingRef.current, acknowledgmentsRef.current) }); clearCallback();
        setNotice(action === 'complete' ? 'Sandboxanslutningen har slutförts. Kontrollera företagsidentiteten nedan.' : 'Visma-anslutningen har kopplats från.');
      }
    } catch (failure) { if (current()) setError(environmentFailure(failure)); }
    finally { if (current()) { busy.current = false; setConnectionBusy(false); } if (writeController.current === controller) writeController.current = undefined; }
  }
  const selected = sandbox?.operations.find(item => item.id === operation);
  function relayLocalCallback(event: FormEvent) {
    event.preventDefault();
    if (!permitted || !sessionMatches || !sandbox?.configured || !sandbox.localCallbackRelay || busy.current || loading || !!inFlight) return;
    try {
      const supplied = localCallbackUrl.trim();
      if (supplied.length > 8192) throw new Error();
      const source = new URL(supplied);
      if (`${source.origin}${source.pathname}` !== 'https://localhost:44300/callback' || source.username || source.password || source.hash) throw new Error();
      const state = source.searchParams.get('state'), code = source.searchParams.get('code'), failure = source.searchParams.get('error');
      if (!state || state.length > 200 || !!code === !!failure || code && code.length > 4096 || failure && failure.length > 200 ||
        ['state', 'code', 'error'].some(key => source.searchParams.getAll(key).length > 1)) throw new Error();
      // Navigate the browser so the original Render HttpOnly binding cookie is
      // attached. Do not import tokens, persist the URL or allow a chosen host.
      const destination = new URL('/api/integrations/visma/oauth/callback', window.location.origin);
      destination.searchParams.set('state', state);
      if (code) destination.searchParams.set('code', code);
      else destination.searchParams.set('error', failure!);
      setLocalCallbackUrl('');
      window.location.assign(destination.href);
    } catch { setError('Klistra in hela returadressen från Spiris. Den ska börja med https://localhost:44300/callback och innehålla state och code (eller error).'); }
  }
  const unresolved = sandbox?.runs.find(run => run.status === 'in_flight' || run.status === 'unknown');
  const inFlight = sandbox?.runs.find(run => run.status === 'in_flight');
  const uncheckedWrite = sandbox?.runs.find(run => run.status === 'unknown' && run.method === 'POST' && !acknowledgments[run.id]);
  const write = writeOperation(operation);
  const payload = write ? forms?.[operation as 'createSupplier' | 'createDraft'] : undefined;
  const blockedReason = sending || connectionBusy || loading || inFlight ? 'Inväntar serverns svar.' : write && uncheckedWrite ? 'Ett skrivtest har oklart resultat. Kontrollera testföretaget och bekräfta kontrollen i historiken.'
    : sandbox?.mode !== 'sandbox' ? 'Servern behöver vara inställd för Visma sandbox.' : !sandbox.connected && operation !== 'company' ? 'Anslut Visma sandbox först.'
      : write && !sandbox.companyVerified ? 'Verifiera VISMA_SANDBOX_COMPANY_ID på Render före skrivtester.' : !selected ? 'Testoperationen är inte tillgänglig.' : '';
  async function send() {
    if (!permitted || !sessionMatches || busy.current || readFlight.current || blockedReason || !selected) return;
    let frozen: NvvJsonObject | undefined;
    const frozenParameters: VismaParameters = operation === 'accounts' ? { fiscalYearId: parameters.fiscalYearId || '' } : operation === 'supplier' || operation === 'draft' ? { resourceId: parameters.resourceId || '' } : {};
    try {
      if (operation === 'accounts' && !usableUuid(frozenParameters.fiscalYearId ?? '')) throw new Error('Välj ett faktiskt räkenskapsår från sandboxen.');
      if ((operation === 'supplier' || operation === 'draft') && !usableUuid(frozenParameters.resourceId ?? '')) throw new Error('Ange resursens faktiska UUID från Visma.');
      if (write) frozen = structuredClone(editor === 'json' ? parsePayload(raw) : formRef.current?.[operation as 'createSupplier' | 'createDraft'] ?? {});
      if (operation === 'createSupplier' && (!fieldValue(frozen, 'Name').trim() || !usableUuid(fieldValue(frozen, 'TermsOfPaymentId')))) throw new Error('Ange leverantörens namn och ett faktiskt betalningsvillkors-ID.');
      if (operation === 'createDraft') {
        if (!usableUuid(fieldValue(frozen, 'SupplierId'))) throw new Error('Ange leverantörens faktiska UUID från Visma.');
        if (cardPrefill?.source.customerType !== 'Privatperson' && cardPrefill && typeof frozen?.Vat !== 'number')
          throw new Error('Ange momsbelopp för företagets testunderlag och kontrollera momskonteringen. Viktkortet innehåller inget fastställt momsbeslut.');
        const rows = frozen?.Rows;
        if (!Array.isArray(rows) || !rows.length || rows.some(row => !Number.isInteger(objectValue(row).AccountNumber) || Number(objectValue(row).AccountNumber) < 1)) throw new Error('Välj verkliga konton för utkastets konteringsrader.');
      }
    } catch (failure) { setError(environmentFailure(failure)); return; }
    const requestId = crypto.randomUUID(), request: VismaSandboxRequest = { requestId, idempotencyKey: `visma-sandbox-${requestId}`, operation, ...(Object.keys(frozenParameters).length ? { parameters: frozenParameters } : {}), ...(frozen ? { payload: frozen } : {}),
      ...(write && cardPrefill ? { source: sourceReference(cardPrefill.source) } : {}) };
    let path = selected.path;
    if (frozenParameters.fiscalYearId) path = path.replace('{fiscalYearId}', frozenParameters.fiscalYearId);
    if (frozenParameters.resourceId) path = path.replace('{resourceId}', frozenParameters.resourceId).replace('{id}', frozenParameters.resourceId);
    const pendingRun: VismaSandboxRun = { id: requestId, status: 'in_flight', operation, method: selected.method, path, parameters: frozenParameters, source: request.source, ...(frozen ? { payload: frozen } : {}), startedAt: new Date().toISOString(), httpStatus: null, response: null, trackingId: '' };
    const pending: TestDialog = { request, run: pendingRun, progress: progressFor(pendingRun) };
    if (write && !savePending(pendingStorageKey, actualUser.id, user.id, pending)) { setError('Webbläsaren kunde inte bevara testets ID inför omladdning. Testet har inte skickats.'); return; }
    if (write) pendingRef.current = pending;
    dialogRef.current = pending; setDialog(pending); publishRun(pendingRun);
    const epoch = generation.current, controller = new AbortController(); writeController.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && generation.current === epoch && identityRef.current === identity;
    busy.current = true; setSending(true); setError(''); setNotice('');
    try {
      const run = await vismaSandboxApi.run(request, controller.signal);
      if (!current()) return;
      publishRun(run);
      if (run.status === 'accepted' && operation === 'createSupplier' && request.source && usableUuid(run.resourceId ?? '') && cardPrefill &&
        request.source.cardId === cardPrefill.source.cardId && request.source.hash === cardPrefill.source.hash) {
        updateField('createDraft', 'SupplierId', run.resourceId!); setOperation('createDraft'); setEditor('fields');
      }
      const nextDialog = { request, run: structuredClone(run), progress: progressFor(run) };
      if (write) {
        pendingRef.current = run.status === 'in_flight' || run.status === 'unknown' ? nextDialog : undefined;
        if (!pendingRef.current) clearPending(pendingStorageKey, requestId);
      }
      if (dialogRef.current?.run.id === requestId) { dialogRef.current = nextDialog; setDialog(nextDialog); }
      setNotice(run.status === 'accepted' ? 'Visma sandbox har svarat. Anrop och råsvar finns i historiken.' : 'Testets resultat finns i historiken.');
      if (operation === 'company') void load();
    } catch (failure) {
      if (!current()) return;
      const definite = failure instanceof EnvironmentApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status);
      const message = definite ? environmentFailure(failure) : write ? 'Serverns slutresultat saknas. Läs och kontrollera testföretaget innan ett nytt skrivtest.' : 'Läsanropets slutresultat saknas. Du kan utföra ett nytt läsanrop för att kontrollera uppgifterna.';
      const run: VismaSandboxRun = { ...pendingRun, status: definite ? 'rejected' : 'unknown', error: { code: definite ? (failure as EnvironmentApiError).code : 'response_unknown', message }, finishedAt: new Date().toISOString() };
      const nextDialog = { request, run, progress: progressFor(run) };
      publishRun(run); setError(message);
      if (write) {
        pendingRef.current = definite ? undefined : nextDialog;
        if (definite) clearPending(pendingStorageKey, requestId);
      }
      if (dialogRef.current?.run.id === requestId) { dialogRef.current = nextDialog; setDialog(nextDialog); }
    } finally { if (current()) { busy.current = false; setSending(false); } if (writeController.current === controller) writeController.current = undefined; }
  }

  const field = (target: 'createSupplier' | 'createDraft', label: string, key: string, options?: { type?: 'number' | 'date' | 'email'; required?: boolean; wide?: boolean }) => <label className={options?.wide ? 'is-wide' : undefined}>{label}<input type={options?.type ?? 'text'} step={options?.type === 'number' ? '0.01' : undefined} required={options?.required} value={fieldValue(forms?.[target], key)} onChange={event => updateField(target, key, event.target.value === '' ? undefined : options?.type === 'number' ? Number(event.target.value) : event.target.value)} autoComplete="off" /></label>;
  const rows = Array.isArray(forms?.createDraft.Rows) ? forms.createDraft.Rows.map(objectValue) : [];
  function updateRow(index: number, key: string, value: NvvJsonValue | undefined) {
    const copy = structuredClone(formRef.current?.createDraft ?? {}), nextRows = Array.isArray(copy.Rows) ? copy.Rows.map(objectValue) : [];
    const row = { ...nextRows[index] }; if (value === undefined) delete row[key]; else row[key] = value; nextRows[index] = row;
    copy.Rows = nextRows; adoptForm('createDraft', copy);
  }
  function useSupplier(id: string) {
    if (!usableUuid(id)) return;
    updateField('createDraft', 'SupplierId', id); setOperation('createDraft'); setEditor('fields'); setRaw(jsonText(formRef.current?.createDraft));
    setNotice('Leverantörs-ID har lagts i utkastformuläret. Skapa utkast är ett separat knapptryck.');
  }
  function viewRun(run: VismaSandboxRun) {
    const request: VismaSandboxRequest = { requestId: run.id, idempotencyKey: '', operation: run.operation, parameters: run.parameters, source: run.source, payload: structuredClone(run.payload) };
    const next = { request, run: structuredClone(run), progress: progressFor(run) }; dialogRef.current = next; setDialog(next);
  }
  function useRun(run: VismaSandboxRun) {
    if (!run.source || run.source.cardId !== cardPrefill?.source.cardId || run.source.hash !== cardPrefill?.source.hash) setCardPrefill(undefined);
    if (writeOperation(run.operation) && run.payload) adoptForm(run.operation as 'createSupplier' | 'createDraft', run.payload);
    setOperation(run.operation); setParameters(run.parameters ?? {}); setEditor('fields'); setRaw(jsonText(run.payload ?? {})); applyLookup(run);
    setNotice('Testets uppgifter har lagts i formuläret. Inget nytt anrop har skickats.');
  }
  function acknowledgeUnknownWrite(run: VismaSandboxRun) {
    if (!permitted || !sessionMatches || busy.current || readFlight.current || loading || inFlight || run.status !== 'unknown' || run.method !== 'POST' || acknowledgmentsRef.current[run.id]) return;
    const entries = { ...acknowledgmentsRef.current, [run.id]: { acknowledgedAt: new Date().toISOString(), run: structuredClone(run) } };
    if (!saveAcknowledgments(acknowledgmentStorageKey, actualUser.id, user.id, entries)) { setError('Webbläsaren kunde inte bevara din bekräftelse. Skrivtestet är fortfarande spärrat.'); return; }
    acknowledgmentsRef.current = entries; setAcknowledgments(entries); setError('');
    setNotice('Din kontroll har bekräftats. Det tidigare testets resultat är fortfarande oklart. Ett nytt skrivtest kräver ett nytt knapptryck.');
  }

  return <section className="environment-workspace nvv-sandbox-workspace visma-sandbox-workspace">
    <div className="office-title environment-workspace-title"><div><a className="office-link" href="/kontor#/integrations?service=visma"><ArrowLeft size={14} />Till integrationsinställningar</a><span className="office-eyebrow">INTEGRATIONER · SEPARATA SANDBOXTESTER</span><h1>Spiris / Visma · systemadminstest</h1><p>Anslut ett sandboxföretag, prova enskilda anrop och se faktiska payloads och svar.</p></div><span className="environment-pill warning"><FlaskConical size={14} />Endast SANDBOX</span></div>
    {!permitted ? <div className="office-panel environment-empty"><ShieldCheck size={30} /><h2>Endast systemadmin</h2><p>Testverktyget kräver systemadmin med integrationsbehörighet utan anläggningsbegränsning.</p></div>
      : !sessionMatches ? <div className="environment-access"><LoaderCircle size={18} /><span>{sessionError || (sessionLoading ? 'Ansluter testsessionen…' : 'Testsessionen kunde inte anslutas.')}</span>{!sessionLoading && <button className="office-link" type="button" onClick={() => void refreshSession().catch(() => undefined)}>Försök igen</button>}</div>
        : <>
          <section className="office-panel visma-sandbox-connection" aria-label="Visma sandboxanslutning"><div className="nvv-sandbox-context"><span className="environment-icon"><Database size={22} /></span><div><strong>Visma sandbox · serveranslutning</strong><p>Inloggning och företagsval sker hos Visma. OAuth-uppgifter lagras på servern.</p></div><button className="office-btn outline" type="button" disabled={loading || sending || connectionBusy} onClick={() => void load()}><RefreshCw size={14} />{loading ? 'Hämtar…' : 'Kontrollera historik'}</button></div>
            <div className="visma-sandbox-company"><div><span className={`environment-pill ${sandbox?.companyVerified ? 'success' : 'warning'}`}><ShieldCheck size={13} />{sandbox?.companyVerified ? 'Företaget verifierat' : sandbox?.company ? 'Företaget behöver verifieras' : 'Inte ansluten'}</span>{sandbox?.company ? <><strong>{sandbox.company.name || 'Namn saknas'}{sandbox.company.number && ` · ${sandbox.company.number}`}</strong><small>Företags-ID: {sandbox.company.id}</small></> : <p>Företagsidentiteten visas när anslutningen har slutförts.</p>}{sandbox?.expectedCompanyId && <small>Förväntat sandbox-ID: {sandbox.expectedCompanyId}</small>}</div><div className="visma-sandbox-connect-actions">{callback === 'ok' ? <button className="office-btn" type="button" disabled={connectionBusy || sending || loading || !!inFlight} onClick={() => void connectionAction('complete')}><ShieldCheck size={15} />{connectionBusy ? 'Slutför…' : 'Slutför anslutning'}</button> : <button className="office-btn outline" type="button" disabled={connectionBusy || sending || loading || !!inFlight || sandbox?.mode !== 'sandbox'} onClick={() => void connectionAction('start')}><ArrowUpRight size={15} />{sandbox?.company ? 'Anslut på nytt' : 'Anslut Visma sandbox'}</button>}{(sandbox?.connected || sandbox?.company) && <button className="office-link" type="button" disabled={connectionBusy || sending || loading || !!inFlight} onClick={() => void connectionAction('disconnect')}><LogOut size={14} />Koppla från</button>}</div></div>
            {callback === 'ok' && <p className="visma-sandbox-help" role="status">Du är tillbaka från Visma. Tryck på Slutför anslutning för att hämta och kontrollera det valda företagets identitet.</p>}{callback === 'error' && <p className="environment-error" role="alert">Visma-inloggningen kunde inte slutföras. Starta en ny anslutning.</p>}
            {sandbox?.company && !sandbox.expectedCompanyId && <p className="visma-sandbox-help">Ange det visade företags-ID:t som VISMA_SANDBOX_COMPANY_ID i Render och ladda om tjänsten. Skrivtester öppnas när servern har verifierat samma företag.</p>}
            {sandbox?.localCallbackRelay && callback !== 'ok' && <form className="visma-sandbox-local-relay" onSubmit={relayLocalCallback} aria-label="Slutför via localhost">
              <strong>Tillfällig anslutning via localhost</strong>
              <p>Tryck först på Anslut Visma sandbox och välj testföretaget. Efter godkännandet kan localhost visa ett anslutningsfel. Kopiera då hela adressen ur adressfältet och öppna den här testsidan igen i samma webbläsare. Klistra in adressen nedan inom fem minuter.</p>
              <label>Returadress från Spiris<input type="text" value={localCallbackUrl} onChange={event => setLocalCallbackUrl(event.target.value)} maxLength={8192} autoComplete="off" spellCheck={false} placeholder="https://localhost:44300/callback?code=…&state=…" /></label>
              <button className="office-btn outline" type="submit" disabled={!localCallbackUrl.trim() || !sandbox.configured || connectionBusy || sending || loading || !!inFlight}><ArrowUpRight size={14} />För över svaret till JEROC</button>
            </form>}
          </section>
          {!!sandbox?.missing.length && <div className="environment-alert" role="status"><CircleAlert size={16} /><div><strong>Återstår före testet</strong><ul>{sandbox.missing.map(item => <li key={item}>{item}</li>)}</ul></div></div>}
          {error && <div className="environment-error" role="alert"><CircleAlert size={16} />{error}</div>}{notice && <p className="nvv-sandbox-notice" role="status">{notice}</p>}
          {sandbox && <section className="office-panel visma-sandbox-source" aria-label="Underlag från attesterat viktkort">
            <header><div><h2><FileText size={18} />Testa ett attesterat viktkort</h2><p>Attesten gör underlaget exportklart. Den låsta avräkningen förifyller testet; sändningen görs med testknappen.</p></div>
              <button className="office-btn outline" type="button" disabled={!sandbox.companyVerified || loading || sending || connectionBusy || !!inFlight} onClick={() => void prepareSpirisChoices()}><RefreshCw size={14} />Hämta Spiris-val</button></header>
            <label>Attesterat viktkort<select value={cardPrefill?.source.cardId ?? ''} disabled={loading || sending || connectionBusy || !!inFlight} onChange={event => void selectAttestedCard(event.target.value)}>
              <option value="">Välj kort eller använd fritt testformulär</option>{attestedCards.map(card => <option key={card.approvalId} value={card.cardId}>INV-{card.cardId} · {card.customerName} · {moneyText(card.gross)}</option>)}
            </select></label>
            {!attestedCards.length && <p className="visma-sandbox-help">Inga aktuella kundgodkända och internt attesterade kort finns ännu. Attestera ett kort och tryck på Kontrollera historik för att hämta listan igen.</p>}
            {cardPrefill && <><div className="visma-sandbox-source-summary"><div><small>Avräkning</small><strong>{cardPrefill.source.number}</strong></div><div><small>Hela inköpet</small><strong>{moneyText(cardPrefill.source.gross)}</strong></div><div><small>Att betala efter kvittning</small><strong>{moneyText(cardPrefill.source.net)}</strong></div><div><small>Attesterad av</small><strong>{cardPrefill.source.attestedBy}</strong><small>{environmentTime(cardPrefill.source.attestedAt)}</small></div></div>
              <details><summary>Material, referens och betalning</summary><table><thead><tr><th>Material</th><th>Vikt</th><th>Pris/kg</th><th>Belopp</th></tr></thead><tbody>{cardPrefill.source.rows.map((row, index) => <tr key={index}><td>{row.name}</td><td>{row.weight.toLocaleString('sv-SE')} kg</td><td>{moneyText(row.price)}</td><td>{moneyText(row.amount)}</td></tr>)}</tbody></table>
                <p>Referens: {cardPrefill.source.reference || '—'} · Ursprung: {cardPrefill.source.origin}</p><p>Betalning: {({ bank: 'Bankkonto', cash: 'Kontant', swish: 'Swish', balance: 'Spara på saldo' } as Record<string, string>)[cardPrefill.source.paymentMethod]} · {cardPrefill.source.paymentRecipient}</p>
              </details>{cardPrefill.notes.map(note => <p className="visma-sandbox-help" key={note}>{note}</p>)}
              <div className="visma-sandbox-source-actions"><button className="office-link" type="button" disabled={loading || sending || connectionBusy || !!inFlight} onClick={() => void selectAttestedCard(String(cardPrefill.source.cardId))}><RefreshCw size={14} />Förifyll igen från attesten</button><button className="office-link" type="button" disabled={loading || sending || connectionBusy || !!inFlight} onClick={() => selectOperation('createDraft')}><ArrowUpRight size={14} />Till fakturautkast</button></div>
              <p className="visma-sandbox-help">Spiris använder kunden som leverantör. Konton 4000 och 2440 föreslås endast när de finns aktiva i den hämtade kontoplanen; granska konton och moms före testet.</p>
            </>}
          </section>}
          {sandbox && forms ? <div className="nvv-sandbox-layout">
            <form className="office-panel nvv-sandbox-form" onSubmit={event => { event.preventDefault(); void send(); }} aria-label="Visma sandboxtest"><div className="nvv-sandbox-form-header"><div><h2>Testanrop</h2><p>Varje test skickas först när du trycker på knappen.</p></div>{write && <button className="office-link" type="button" onClick={() => { adoptForm(operation as 'createSupplier' | 'createDraft', starterPayload(operation as 'createSupplier' | 'createDraft', sandbox.templates)); setNotice('Testmallen har återställts. Välj faktiska ID:n och konton före testet.'); }}>Återställ testmall</button>}</div>
              <div className="nvv-sandbox-fields visma-sandbox-operation"><label className="is-wide">Välj operation<select value={operation} onChange={event => selectOperation(event.target.value as VismaOperation)}>{sandbox.operations.map(item => <option key={item.id} value={item.id}>{item.method} · {operationLabels[item.id]}</option>)}</select></label></div>
              {operation === 'accounts' && <fieldset><legend>Kontoplan</legend><div className="nvv-sandbox-fields"><label className="is-wide">Räkenskapsår<select value={parameters.fiscalYearId ?? ''} onChange={event => { setParameters(state => ({ ...state, fiscalYearId: event.target.value })); setLookups(state => ({ ...state, accounts: [] })); }}><option value="">Välj ett hämtat räkenskapsår</option>{lookups.fiscalYears.map(year => <option key={fieldValue(year, 'Id')} value={fieldValue(year, 'Id')}>{fieldValue(year, 'StartDate').slice(0, 10)} – {fieldValue(year, 'EndDate').slice(0, 10)}{year.IsLockedForAccounting ? ' · låst' : ''}</option>)}</select></label><label className="is-wide">Räkenskapsårs-ID<input value={parameters.fiscalYearId ?? ''} onChange={event => { setParameters(state => ({ ...state, fiscalYearId: event.target.value })); setLookups(state => ({ ...state, accounts: [] })); }} placeholder="Faktiskt UUID från sandboxen" /></label></div><p className="visma-sandbox-help">Läs räkenskapsår först. Kontoplanen hämtas för det valda årets faktiska ID.</p></fieldset>}
              {(operation === 'supplier' || operation === 'draft') && <fieldset><legend>Resurs att läsa</legend><div className="nvv-sandbox-fields"><label className="is-wide">{operation === 'supplier' ? 'Leverantörs-ID' : 'Utkasts-ID'}<input required value={parameters.resourceId ?? ''} onChange={event => setParameters(state => ({ ...state, resourceId: event.target.value }))} placeholder="Faktiskt UUID från Visma" /></label></div></fieldset>}
              {write && <><div className="nvv-sandbox-tabs" role="tablist" aria-label="Redigera testpayload"><button type="button" role="tab" aria-selected={editor === 'fields'} aria-controls="visma-sandbox-fields" onClick={() => switchEditor('fields')}><FileText size={15} />Formulär</button><button type="button" role="tab" aria-selected={editor === 'json'} aria-controls="visma-sandbox-json" onClick={() => switchEditor('json')}><Code2 size={15} />Avancerad JSON</button></div>
                {editor === 'json' ? <div id="visma-sandbox-json" role="tabpanel" className="nvv-sandbox-json"><label>JSON-payload<textarea value={raw} onChange={event => { setRaw(event.target.value); setError(''); }} rows={22} spellCheck={false} /></label><small>Servern validerar dokumenterade fält. Adress, företag och autentisering bestäms av servern.</small></div> : <div id="visma-sandbox-fields" role="tabpanel">
                  {operation === 'createSupplier' ? <fieldset><legend>Testleverantör</legend><div className="nvv-sandbox-fields">{field('createSupplier', 'Namn', 'Name', { required: true, wide: true })}{field('createSupplier', 'Organisationsnummer · utelämna för privatperson', 'CorporateIdentityNumber')}{field('createSupplier', 'Leverantörsnummer · valfritt', 'SupplierNumber')}{field('createSupplier', 'E-post', 'EmailAddress', { type: 'email' })}{field('createSupplier', 'Kontaktperson', 'ContactPersonName')}
                    <label className="is-wide">Betalningsvillkor<select value={fieldValue(forms.createSupplier, 'TermsOfPaymentId')} onChange={event => updateField('createSupplier', 'TermsOfPaymentId', event.target.value)}><option value="">Välj ett hämtat inköpsvillkor</option>{lookups.paymentTerms.filter(term => term.AvailableForPurchase === true).map(term => <option key={fieldValue(term, 'Id')} value={fieldValue(term, 'Id')}>{fieldValue(term, 'Name')} · {fieldValue(term, 'NumberOfDays')} dagar</option>)}{usableUuid(fieldValue(forms.createSupplier, 'TermsOfPaymentId')) && !lookups.paymentTerms.some(term => term.Id === forms.createSupplier.TermsOfPaymentId) && <option value={fieldValue(forms.createSupplier, 'TermsOfPaymentId')}>{fieldValue(forms.createSupplier, 'TermsOfPaymentId')}</option>}</select></label>{field('createSupplier', 'Betalningsvillkors-ID', 'TermsOfPaymentId', { required: true, wide: true })}{field('createSupplier', 'Landkod', 'CountryCode')}{field('createSupplier', 'Valutakod', 'CurrencyCode')}
                    {field('createSupplier', 'Adress', 'Address1', { wide: true })}{field('createSupplier', 'Postnummer', 'PostalCode')}{field('createSupplier', 'Ort', 'City')}{field('createSupplier', 'Telefon', 'Telephone')}{field('createSupplier', 'Bank', 'BankName')}{field('createSupplier', 'Clearingnummer', 'Clearing')}{field('createSupplier', 'Bankkontonummer', 'BankAccountNumber')}{field('createSupplier', 'Anteckning och JEROC-referens', 'Note', { wide: true })}</div><p className="visma-sandbox-help">Hämta Spiris-val för betalvillkor. Ett valt viktkort använder kunduppgifterna från dess attestversion. Privatpersonens personnummer förs inte till fältet för organisationsnummer.</p></fieldset>
                    : <><fieldset><legend>Leverantörsfakturautkast</legend><div className="nvv-sandbox-fields"><label className="is-wide">Hämtad leverantör<select value={fieldValue(forms.createDraft, 'SupplierId')} onChange={event => updateField('createDraft', 'SupplierId', event.target.value)}><option value="">Välj en hämtad testleverantör</option>{lookups.suppliers.map(supplier => <option key={fieldValue(supplier, 'Id')} value={fieldValue(supplier, 'Id')}>{fieldValue(supplier, 'Name')} · {fieldValue(supplier, 'SupplierNumber')}</option>)}{usableUuid(fieldValue(forms.createDraft, 'SupplierId')) && !lookups.suppliers.some(supplier => supplier.Id === forms.createDraft.SupplierId) && <option value={fieldValue(forms.createDraft, 'SupplierId')}>{fieldValue(forms.createDraft, 'SupplierId')}</option>}</select></label>{field('createDraft', 'Leverantörs-ID', 'SupplierId', { required: true, wide: true })}{field('createDraft', 'Fakturanummer', 'InvoiceNumber')}{field('createDraft', 'Valutakod', 'CurrencyCode')}{field('createDraft', 'Fakturadatum', 'InvoiceDate', { type: 'date' })}{field('createDraft', 'Förfallodatum', 'DueDate', { type: 'date' })}{field('createDraft', 'Totalbelopp', 'TotalAmount', { type: 'number' })}{field('createDraft', 'Momsbelopp', 'Vat', { type: 'number' })}</div><label className="nvv-sandbox-agent-toggle visma-sandbox-checkbox"><input type="checkbox" checked={forms.createDraft.IsCreditInvoice === true} onChange={event => updateField('createDraft', 'IsCreditInvoice', event.target.checked)} />Kreditfaktura</label></fieldset>
                      <fieldset><legend>Konteringsrader</legend><p className="visma-sandbox-help">Läs räkenskapsår och kontoplan. Välj verkliga konton från sandboxen och kontrollera debet och kredit.</p><div className="visma-sandbox-rows">{rows.map((row, index) => <div className="visma-sandbox-row" key={index}><div className="visma-sandbox-row-heading"><strong>Rad {index + 1}</strong><button className="office-link" type="button" aria-label={`Ta bort rad ${index + 1}`} onClick={() => updateField('createDraft', 'Rows', rows.filter((_, at) => at !== index))}><Trash2 size={13} />Ta bort</button></div><div className="nvv-sandbox-fields"><label className="is-wide">Konto · rad {index + 1}<select value={fieldValue(row, 'AccountNumber')} onChange={event => updateRow(index, 'AccountNumber', event.target.value ? Number(event.target.value) : undefined)}><option value="">Välj ett faktiskt konto</option>{lookups.accounts.filter(account => account.IsActive === true && /^\d+$/.test(fieldValue(account, 'Number'))).map(account => <option key={fieldValue(account, 'Number')} value={fieldValue(account, 'Number')}>{fieldValue(account, 'Number')} · {fieldValue(account, 'Name')}{account.IsFirstCostCenterMandatory ? ' · kostnadsställe krävs' : ''}</option>)}{fieldValue(row, 'AccountNumber') && !lookups.accounts.some(account => Number(account.Number) === row.AccountNumber) && <option value={fieldValue(row, 'AccountNumber')}>{fieldValue(row, 'AccountNumber')} · från payload</option>}</select></label>{(['DebitAmount', 'CreditAmount'] as const).map(key => <label key={key}>{key === 'DebitAmount' ? 'Debet' : 'Kredit'} · rad {index + 1}<input type="number" step="0.01" value={fieldValue(row, key)} onChange={event => updateRow(index, key, event.target.value === '' ? undefined : Number(event.target.value))} /></label>)}<label className="is-wide">Text · rad {index + 1}<input value={fieldValue(row, 'TransactionText')} onChange={event => updateRow(index, 'TransactionText', event.target.value || undefined)} /></label></div></div>)}</div><button className="office-link" type="button" onClick={() => updateField('createDraft', 'Rows', [...rows, { DebitAmount: 0, CreditAmount: 0, LineNumber: rows.length + 1 }])}><Plus size={14} />Lägg till rad</button></fieldset></>}
                </div>}</>}
              {!write && <p className="visma-sandbox-help">Det valda anropet läser endast data från Visma sandbox. Resultatet sparas i testhistoriken och kan användas för val i formulären.</p>}
              <div className="nvv-sandbox-submit"><div><strong>{write ? 'Knappen skapar en testresurs i det verifierade sandboxföretaget.' : 'Knappen utför det valda läsanropet i sandboxen.'}</strong>{blockedReason && <small>{blockedReason}</small>}</div><button ref={submitButton} className="office-btn" type="submit" disabled={!!blockedReason}><Send size={15} />{sending ? 'Inväntar svar…' : write ? 'Skicka till Visma · SANDBOX' : 'Läs från Visma · SANDBOX'}</button></div>
            </form>
            <aside className="office-panel nvv-sandbox-preview" aria-label="Utgående Visma-anrop"><h2><Code2 size={18} />Utgående anrop</h2><p>{selected?.method} {selected?.path}</p><pre>{write ? editor === 'json' ? raw : jsonText(payload) : operation === 'accounts' ? jsonText({ fiscalYearId: parameters.fiscalYearId ?? '' }) : operation === 'supplier' || operation === 'draft' ? jsonText({ resourceId: parameters.resourceId ?? '' }) : 'Ingen payload · läsanrop'}</pre><small>Varje test sparar en egen kopia av anropet, HTTP-statusen, råsvaret och resurs-ID:t.</small>{sandbox.redirectUri && <details className="visma-sandbox-details"><summary>Serverns anslutningsuppgifter</summary><p>OAuth redirect URI: {sandbox.redirectUri}</p><p>Behörigheter: {sandbox.scopes.join(', ')}</p></details>}</aside>
          </div> : loading && <div className="environment-empty"><LoaderCircle size={25} /><p>Hämtar sandboxens status…</p></div>}
          <section className="office-panel nvv-sandbox-history" aria-label="Visma testhistorik"><header><div><h2><History size={19} />Testhistorik</h2><p>Senaste 50 testerna. Visa sparade anrop och svar eller lägg uppgifterna i formuläret.</p></div>{unresolved && <span className="environment-pill warning"><CircleAlert size={13} />{runLabels[unresolved.status]}</span>}</header>
            {!sandbox?.runs.length ? <p className="nvv-sandbox-empty">Inga testanrop har utförts.</p> : <ol>{sandbox.runs.map(run => <li key={run.id}><div className="nvv-sandbox-run-heading"><span className={`environment-pill ${run.status === 'accepted' ? 'success' : 'warning'}`}>{run.status === 'accepted' ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}{runLabels[run.status]}</span><strong>{operationLabels[run.operation]}</strong><span>{environmentTime(run.startedAt)} · {run.httpStatus == null ? 'Inget HTTP-svar' : `HTTP ${run.httpStatus}`}</span><div><button className="office-link" type="button" onClick={() => viewRun(run)}><ArrowUpRight size={14} />Visa anrop och svar</button><button className="office-link" type="button" onClick={() => useRun(run)}><Copy size={14} />Använd uppgifter</button>{run.status === 'accepted' && run.operation === 'createSupplier' && run.resourceId && <button className="office-link" type="button" onClick={() => useSupplier(run.resourceId!)}><Copy size={14} />Använd leverantörs-ID</button>}</div></div><small>{run.method} {run.path}</small><small>Test-ID: {run.id}{run.trackingId && ` · Spårnings-ID: ${run.trackingId}`}</small>{run.resourceId && <small>Resurs-ID: {run.resourceId}</small>}{run.error && <p>{run.error.message}</p>}{run.status === 'unknown' && run.method === 'POST' && <div className="visma-sandbox-recovery">{acknowledgments[run.id] ? <p role="status">Kontroll bekräftad: {new Date(acknowledgments[run.id].acknowledgedAt).toLocaleString('sv-SE')}. Testets slutresultat är fortfarande oklart.</p> : <><p>Kontrollera leverantörer och utkast i testföretaget innan ett nytt skrivtest. Du kan läsa uppgifter från sandboxen under tiden. Bekräftelsen skickar inget nytt anrop.</p><button className="office-btn outline" type="button" disabled={sending || connectionBusy || loading || !!inFlight} onClick={() => acknowledgeUnknownWrite(run)}><ShieldCheck size={14} />Jag har kontrollerat testföretaget</button></>}</div>}</li>)}</ol>}
          </section>
        </>}
    {dialog && permitted && sessionMatches && <NvvConnectionCheckDialog progress={dialog.progress} externalTest={{ provider: 'Visma', environmentLabel: 'Visma · SANDBOX', method: dialog.run.method, path: dialog.run.path, payload: dialog.run.payload ?? dialog.request.payload, parameters: dialog.request.parameters, run: dialog.run, uncertain: dialog.run.status === 'unknown' }} returnFocus={submitButton} onClose={() => { dialogRef.current = null; setDialog(null); }} onRetry={() => void load()} />}
  </section>;
}
