import { createHash, randomUUID } from 'node:crypto';
import { afterDatabaseCommit } from './database-runtime.mjs';
import { EnvironmentError } from './environment-storage.mjs';

const DOMAIN = 'vismaPayments', LOCK = 1860399454, RETRY_MS = 300000, LEASE_MS = 120000, FOLLOWUP_MS = 30 * 86400000;
const clone = value => structuredClone(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);
const fail = (message, code = 'visma_payment_invalid') => { throw new EnvironmentError(message, 409, code); };
const transientRead = result => result?.outcome === 'unknown' || result?.httpStatus === 408 || result?.httpStatus === 429 || result?.httpStatus >= 500;
const requireRead = (result, message, code) => {
  if (result.outcome !== 'accepted') fail(message, transientRead(result) ? 'visma_payment_provider_unavailable' : code);
};
const cents = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 0.00001 ? Math.round(value * 100) : null;
const swedishDate = value => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('Swish saknar ett verifierat faktiskt betalningsdatum.', 'visma_payment_date_missing');
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
};
const proofIdentity = value => JSON.stringify([value.id, value.organisationId, value.providerInstructionUUID, value.providerPaymentReference,
  value.source?.cardId, value.source?.approvalId, value.source?.version, value.source?.hash, value.amountCents, value.currency, value.spirisCompanyId,
  value.spirisBankAccountId, value.providerResult?.datePaid]);
const digest = value => createHash('sha256').update(proofIdentity(value)).digest('hex');
const publicEntry = entry => ({ paymentId: entry.paymentId, status: entry.status, simulation: true, environment: 'sandbox',
  companyId: entry.companyId, amountCents: entry.amountCents, paymentDate: entry.paymentDate, bankAccountId: entry.bankAccountId,
  invoiceId: entry.invoiceId ?? null, bankTransactionId: entry.bankTransactionId ?? null, paymentVoucherId: entry.paymentVoucherId ?? null,
  paymentVoucherNumber: entry.paymentVoucherNumber ?? null, reason: entry.reason ?? null, updatedAt: entry.updatedAt,
  nextCheckAt: entry.nextCheckAt ?? null, request: entry.request ?? null,
  ...(entry.providerHttpStatus === undefined ? {} : { providerHttpStatus: entry.providerHttpStatus }),
  ...(entry.response === undefined ? {} : { response: clone(entry.response) }), events: clone(entry.events ?? []) });

/** Complete records with indexed tenant/id/queue columns, independent from the
 * money journal. New bookkeeping fields remain included in ordinary PG backup. */
function createStore(getRepository, organisationId) {
  const migrated = new WeakSet();
  async function ready() {
    const repo = await getRepository();
    if (repo.kind === 'postgresql' && !migrated.has(repo)) await repo.runInTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
      await client.query(`CREATE TABLE IF NOT EXISTS jeroc_visma_payment_records (
        organisation_id TEXT NOT NULL,payment_id TEXT NOT NULL,document JSONB NOT NULL,status TEXT NOT NULL,next_check_at TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(organisation_id,payment_id));
        CREATE INDEX IF NOT EXISTS jeroc_visma_payment_queue ON jeroc_visma_payment_records(organisation_id,status,next_check_at);`);
      afterDatabaseCommit(() => migrated.add(repo));
    });
    return repo;
  }
  async function read(id) {
    const repo = await ready();
    if (repo.kind === 'postgresql') return repo.runInReadTransaction(async client => clone((await client.query(
      'SELECT document FROM jeroc_visma_payment_records WHERE organisation_id=$1 AND payment_id=$2', [organisationId, id])).rows[0]?.document ?? null));
    const select = state => clone(state[DOMAIN]?.records?.find(record => record.organisationId === organisationId && record.paymentId === id) ?? null);
    return repo.read(select, { domains: [DOMAIN] });
  }
  async function mutate(id, operation) {
    const repo = await ready();
    if (repo.kind === 'postgresql') return repo.runInTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
      const entry = clone((await client.query('SELECT document FROM jeroc_visma_payment_records WHERE organisation_id=$1 AND payment_id=$2 FOR UPDATE', [organisationId, id])).rows[0]?.document ?? null);
      const result = await operation(entry);
      if (result.entry) await client.query(`INSERT INTO jeroc_visma_payment_records(organisation_id,payment_id,document,status,next_check_at)
        VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(organisation_id,payment_id) DO UPDATE SET document=EXCLUDED.document,status=EXCLUDED.status,next_check_at=EXCLUDED.next_check_at,updated_at=NOW()`,
      [organisationId, id, JSON.stringify(result.entry), result.entry.status, result.entry.nextCheckAt ?? null]);
      return clone(result.value);
    });
    return repo.transact(async state => {
      const records = (state[DOMAIN] ??= { version: 1, records: [] }).records;
      const index = records.findIndex(entry => entry.organisationId === organisationId && entry.paymentId === id);
      const result = await operation(index < 0 ? null : records[index]);
      if (result.entry) { if (index < 0) records.push(result.entry); else records[index] = result.entry; }
      return clone(result.value);
    });
  }
  async function due(at) {
    const repo = await ready();
    if (repo.kind === 'postgresql') return repo.runInReadTransaction(async client => (await client.query(
      `SELECT payment_id FROM jeroc_visma_payment_records WHERE organisation_id=$1 AND status IN ('pending','processing','waiting_booked','unknown')
       AND (next_check_at IS NULL OR next_check_at<=$2) ORDER BY next_check_at NULLS FIRST LIMIT 25`, [organisationId, at])).rows.map(row => row.payment_id));
    return repo.read(state => (state[DOMAIN]?.records ?? []).filter(entry => entry.organisationId === organisationId
      && ['pending', 'processing', 'waiting_booked', 'unknown'].includes(entry.status) && (!entry.nextCheckAt || entry.nextCheckAt <= at)).slice(0, 25).map(entry => entry.paymentId), { domains: [DOMAIN] });
  }
  return { read, mutate, due };
}

/** The supplied proof reader is a server closure over the Swish journal. No
 * caller-supplied recipient/amount, admin principal or paid flag is trusted. */
export function createVismaPayments({ organisationId, getRepository, proofProvider, config, connection, target, batch, clock }) {
  const store = createStore(getRepository, organisationId);
  const event = (entry, status, message) => { entry.events ??= []; entry.events.push({ id: randomUUID(), at: clock().toISOString(), status, text: message }); };
  const setStatus = (entry, status, reason) => { entry.status = status; entry.reason = reason ?? null; entry.updatedAt = clock().toISOString();
    entry.nextCheckAt = ['waiting_booked', 'pending', 'unknown'].includes(status) ? new Date(clock().getTime() + RETRY_MS).toISOString() : null; event(entry, status, reason ?? status); };
  async function proof(id) {
    const value = typeof proofProvider === 'function' ? await proofProvider(id) : null;
    if (!value || value.id !== id || value.organisationId !== organisationId || value.kind !== 'card' || value.mode !== 'mss' || value.simulation !== true
      || value.status !== 'simulated_paid' || value.providerResult?.status !== 'PAID' || value.currency !== 'SEK'
      || !Number.isSafeInteger(value.amountCents) || value.amountCents <= 0 || !value.source || !Number.isSafeInteger(value.source.cardId)
      || !uuid(value.source.approvalId) || !Number.isInteger(value.source.version) || value.source.version < 1 || !/^[a-f0-9]{64}$/.test(value.source.hash)
      || !uuid(value.spirisBankAccountId) || !uuid(value.spirisCompanyId)
      || !Number.isFinite(Date.parse(value.providerResult.datePaid)) || Date.parse(value.providerResult.datePaid) > clock().getTime() + 5000)
      fail('Betalningsbokföringen kräver en verifierad Swish-simulering, låst kortversion och eget Spiris-bankkonto.', 'visma_payment_proof_missing');
    return value;
  }
  async function authorized(entry) {
    const value = await proof(entry.paymentId);
    if (digest(value) !== entry.proofHash) fail('Utbetalningens verifierade uppgifter har ändrats. Bokföringen måste granskas.', 'visma_payment_proof_changed');
    const configuration = config(), connected = await connection();
    if (configuration.mode !== 'sandbox' || !configuration.configured || configuration.expectedCompanyId !== entry.companyId
      || !connected.companyVerified || connected.company?.id !== entry.companyId || connected.generation !== entry.generation)
      fail('Spiris-kopplingen har ändrats eller stängts av. Utbetalningen skickas inte till ett annat företag.', 'visma_payment_connection_changed');
    const latest = await target(entry.source);
    if (!latest.settings.enabled || latest.settings.sandbox !== true || latest.settings.companyId !== entry.companyId
      || !latest.settings.enabledBy?.actualUserId) fail('Spiris-överföringen är avstängd. Betalningsbokföringen är pausad.', 'visma_payment_connection_changed');
    return latest;
  }
  function validateInvoice(invoice, entry, exportJob) {
    if (invoice?.Id !== entry.invoiceId || invoice.CreatedFromDraftId !== exportJob.draftId || invoice.SupplierId !== exportJob.supplierId
      || invoice.InvoiceNumber !== exportJob.draft.InvoiceNumber || invoice.CurrencyCode !== 'SEK' || invoice.Status !== 1
      || !uuid(invoice.VoucherId) || cents(invoice.TotalAmount) !== cents(exportJob.draft.TotalAmount)
      || exportJob.accounting?.paymentNetCents !== entry.amountCents || exportJob.accounting?.offsetCents !== 0)
      fail('Spiris-fakturan matchar inte kortets attesterade version och utbetalningsbelopp.', 'visma_payment_invoice_mismatch');
  }
  function verifiedTransaction(transaction, entry) {
    const matchingRows = (transaction?.Rows ?? []).filter(row => row.SourceId === entry.invoiceId && uuid(row.PaymentVoucherId)
      && typeof row.PaymentVoucherNumber === 'string' && row.PaymentVoucherNumber.trim()
      && Math.abs(cents(row.AmountTransactionCurrency) ?? NaN) === entry.amountCents);
    return uuid(transaction?.Id) && transaction.Reference === entry.reference && transaction.TransactionDate?.slice(0, 10) === entry.paymentDate
      && transaction.IsReconciled === true && transaction.TransactionAmountCurrency === 'SEK'
      && cents(transaction.TransactionAmount) === -entry.amountCents && matchingRows.length === 1 ? matchingRows[0] : null;
  }
  async function confirm(entry, send, exportJob) {
    const invoiceResult = await send('invoice', { resourceId: entry.invoiceId });
    if (invoiceResult.outcome !== 'accepted') return false;
    validateInvoice(invoiceResult.response, entry, exportJob);
    const candidates = [];
    if (uuid(entry.bankTransactionId)) {
      const result = await send('bankTransaction', { bankAccountId: entry.bankAccountId, bankTransactionId: entry.bankTransactionId });
      if (result.outcome === 'accepted' && result.response?.Id === entry.bankTransactionId) candidates.push(result.response);
    } else {
      for (let page = 1; page <= 100; page++) {
        const result = await send('matchedTransactions', { bankAccountId: entry.bankAccountId, fromDate: entry.paymentDate, toDate: entry.paymentDate, page, pageSize: 1000 });
        if (result.outcome !== 'accepted' || !Array.isArray(result.response?.Data) || result.response.Meta?.CurrentPage !== page
          || !Number.isInteger(result.response.Meta?.TotalNumberOfPages) || result.response.Meta.TotalNumberOfPages > 100) return false;
        candidates.push(...result.response.Data);
        if (result.response.Meta.TotalNumberOfPages <= page) break;
        if (page === 100) return false;
      }
    }
    const matching = candidates.map(transaction => ({ transaction, row: verifiedTransaction(transaction, entry) })).filter(value => value.row);
    const remaining = cents(invoiceResult.response.RemainingAmountInvoiceCurrency);
    if (matching.length !== 1 || remaining === null || remaining !== entry.remainingBeforeCents - entry.amountCents
      || remaining === 0 && invoiceResult.response.PaymentStatus !== 6) return false;
    const { transaction, row } = matching[0]; entry.bankTransactionId = transaction.Id;
    entry.paymentVoucherId = row.PaymentVoucherId; entry.paymentVoucherNumber = row.PaymentVoucherNumber;
    return true;
  }
  async function synchronize(id, { force = false } = {}) {
    if (!uuid(id)) fail('Ange utbetalningens server-ID.', 'visma_payment_invalid');
    const value = await proof(id), connected = await connection();
    const reserved = await store.mutate(id, previous => {
      if (previous) { if (previous.proofHash !== digest(value)) fail('Samma betalnings-ID har andra uppgifter.', 'idempotency_conflict'); return { value: previous }; }
      const entry = { paymentId: id, organisationId, source: clone(value.source), proofHash: digest(value), companyId: value.spirisCompanyId,
        generation: connected.generation, bankAccountId: value.spirisBankAccountId, amountCents: value.amountCents,
        paymentDate: swedishDate(value.providerResult.datePaid), reference: `SP-SWISH-${value.providerInstructionUUID}`, status: 'pending',
        createdAt: clock().toISOString(), updatedAt: clock().toISOString(), events: [] };
      event(entry, 'pending', 'Verifierad Swish-simulering köad för betalningsbokföring i Spiris sandbox.'); return { entry, value: entry };
    });
    if (force !== true && reserved.nextCheckAt && reserved.nextCheckAt > clock().toISOString() || ['registered', 'blocked', 'failed', 'paused'].includes(reserved.status)) return publicEntry(reserved);
    return process(id);
  }
  async function process(id) {
    const owner = randomUUID();
    const claimed = await store.mutate(id, entry => {
      if (!entry) return { value: null };
      if (['registered', 'failed', 'blocked', 'paused'].includes(entry.status)) return { value: null };
      if (entry.lease && entry.lease.until > clock().toISOString()) return { value: null };
      if (entry.postReserved && entry.status === 'processing') setStatus(entry, 'unknown', 'Ett tidigare bokföringsförsök kan ha nått Spiris. Endast återläsning tillåts.');
      entry.lease = { id: owner, until: new Date(clock().getTime() + LEASE_MS).toISOString() }; entry.updatedAt = clock().toISOString();
      return { entry, value: clone(entry) };
    });
    if (!claimed) return publicEntry(await store.read(id));
    let entry = claimed;
    const save = async () => store.mutate(id, current => { if (current.lease?.id !== owner) fail('En annan arbetare hanterar betalningsbokföringen.', 'visma_payment_busy'); return { entry, value: null }; });
    try {
      if (clock().getTime() - Date.parse(entry.createdAt) >= FOLLOWUP_MS) fail('Betalningsbokföringen saknar bekräftelse efter 30 dagar. Kontrollera och stäm av i Spiris.', 'visma_payment_followup_expired');
      const latest = await authorized(entry), exportJob = latest.job;
      if (!exportJob || exportJob.tracking?.state !== 'booked' || !uuid(exportJob.tracking.invoiceId)) {
        setStatus(entry, 'waiting_booked', 'Swish-simuleringen är klar. Betalningsbokföringen väntar på att samma fakturautkast bokförs i Spiris.');
      } else {
        if (entry.invoiceId && entry.invoiceId !== exportJob.tracking.invoiceId) fail('Den slutliga fakturakopplingen har ändrats.', 'visma_payment_invoice_mismatch');
        entry.invoiceId = exportJob.tracking.invoiceId;
        await batch({ companyId: entry.companyId, generation: entry.generation }, () => authorized(entry), async send => {
          if (entry.postReserved) {
            if (await confirm(entry, send, exportJob)) setStatus(entry, 'registered', 'Simulerad Swish-utbetalning registrerad och återläst i Spiris sandbox.');
            else setStatus(entry, 'unknown', 'Bokföringsförsöket kunde inte verifieras. Ingen automatisk omsändning sker; kontrollera Spiris.');
            return;
          }
          const invoiceResult = await send('invoice', { resourceId: entry.invoiceId });
          requireRead(invoiceResult, 'Den bokförda fakturan kunde inte hämtas före betalningsregistreringen.', 'visma_payment_invoice_unavailable');
          validateInvoice(invoiceResult.response, entry, exportJob);
          const remaining = cents(invoiceResult.response.RemainingAmountInvoiceCurrency);
          if (remaining === null || remaining < entry.amountCents || [6, 9, 11, 15, 16, 17].includes(invoiceResult.response.PaymentStatus)
            || invoiceResult.response.SkipSendToBank !== true) fail('Fakturan är redan betald, skickad till banken eller har ett annat restbelopp. Betalningsregistreringen måste granskas.', 'visma_payment_already_recorded');
          const accounts = [];
          for (let page = 1; page <= 100; page++) {
            const result = await send('bankAccounts', { page, pageSize: 1000 });
            requireRead(result, 'Egna Spiris-bankkonton kunde inte hämtas just nu.', 'visma_payment_bank_unverified');
            if (!Array.isArray(result.response?.Data) || result.response.Meta?.CurrentPage !== page
              || !Number.isInteger(result.response.Meta?.TotalNumberOfPages) || result.response.Meta.TotalNumberOfPages > 100) fail('Egna Spiris-bankkonton kunde inte verifieras.', 'visma_payment_bank_unverified');
            accounts.push(...result.response.Data); if (result.response.Meta.TotalNumberOfPages <= page) break;
            if (page === 100) fail('Bankkontolistan överstiger verifieringsgränsen.', 'visma_payment_bank_unverified');
          }
          const bank = accounts.filter(account => account.Id === entry.bankAccountId && account.IsActive === true
            && (!account.CurrencyCode || account.CurrencyCode === 'SEK') && [1, 3, 5, 6].includes(account.BankAccountType));
          if (bank.length !== 1) fail('Valt Spiris-bankkonto är inte ett aktivt eget SEK-konto.', 'visma_payment_bank_unverified');
          entry.remainingBeforeCents = remaining;
          entry.request = { CompanyBankAccountId: entry.bankAccountId, PaymentDate: entry.paymentDate, PaymentAmount: entry.amountCents / 100,
            PaymentCurrency: 'SEK', PaymentType: remaining === entry.amountCents ? 2 : 1, Reference: entry.reference };
          // Durable reservation comes before POST. Even a process crash here
          // never permits a second POST with a new random idempotency key.
          entry.postReserved = true; setStatus(entry, 'processing', 'Betalningsregistrering reserverad i Spiris sandbox.'); await save();
          const result = await send('recordPayment', { resourceId: entry.invoiceId }, entry.request);
          entry.providerHttpStatus = result.httpStatus; entry.response = clone(result.response);
          if (uuid(result.response?.BankTransactionId)) entry.bankTransactionId = result.response.BankTransactionId;
          if (result.outcome === 'rejected') setStatus(entry, 'failed', result.error?.message ?? 'Spiris avvisade betalningsregistreringen.');
          else if (await confirm(entry, send, exportJob)) setStatus(entry, 'registered', 'Simulerad Swish-utbetalning registrerad och återläst i Spiris sandbox.');
          else setStatus(entry, 'unknown', 'Svaret eller betalningsverifikationen behöver kontrolleras. Ingen automatisk omsändning sker.');
        });
      }
    } catch (error) {
      const reason = error instanceof EnvironmentError ? error.message : 'Betalningsbokföringen kunde inte verifieras. Kontrollera kopplingen.';
      const temporary = error?.code === 'visma_payment_provider_unavailable' || ['AbortError', 'TimeoutError'].includes(error?.name);
      setStatus(entry, error?.code === 'visma_payment_connection_changed' ? 'paused' : error?.code === 'visma_payment_followup_expired' ? 'blocked'
        : entry.postReserved ? 'unknown' : temporary ? 'pending' : 'blocked', reason);
    } finally { delete entry.lease; await save(); }
    return publicEntry(entry);
  }
  let running = false;
  async function processQueue() {
    if (running) return { processed: 0, payments: [] };
    running = true;
    try { const ids = await store.due(clock().toISOString()), payments = []; for (const id of ids) payments.push(await process(id)); return { processed: ids.length, payments }; }
    finally { running = false; }
  }
  return { synchronize, processQueue, projection: async id => { const value = await store.read(id); return value ? publicEntry(value) : null; } };
}
