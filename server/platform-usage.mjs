import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError } from './platform-auth.mjs';

export const PLATFORM_USAGE_TARIFFS = Object.freeze({ 'roaring.person.lookup': Object.freeze({ unitCostMinor: 200, unitSalesMinor: 200, currency: 'SEK', version: 1 }) });
const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_:-]+$/);
const service = z.string().min(1).max(100).regex(/^[a-z][a-z0-9_.-]*$/);
const channel = service.max(64);
const commandSchema = z.object({ organisationId: id.max(100), operationId: z.string().uuid().transform(value => value.toLowerCase()), service, channel, actorId: id.optional(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const outcomeSchema = z.object({ status: z.enum(['success', 'not_found', 'rejected', 'failed', 'unknown']), billableConfirmed: z.boolean().optional(), result: z.unknown().optional() }).strict();
const filterSchema = z.object({ month: z.string().regex(/^(?:20|21)\d{2}-(?:0[1-9]|1[0-2])$/), companyId: id.max(100).optional() }).strict();
const tariffSchema = z.object({ unitCostMinor: z.number().int().nonnegative().safe(), unitSalesMinor: z.number().int().nonnegative().safe(), currency: z.literal('SEK'), version: z.number().int().positive().safe() }).strict();
const fail = (message, status = 422, code = 'platform_usage_invalid') => { throw new PlatformError(message, status, code); };
const parse = (schema, input) => { const result = schema.safeParse(input); if (!result.success) fail('Kontrollera användningsuppgifterna; ogiltiga eller okända fält avvisas.'); return result.data; };
const monthFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit' });
export const platformUsageMonth = date => monthFormatter.format(new Date(date));
const effectiveStatus = (record, at) => record.leaseUntil && Date.parse(record.leaseUntil) <= at && ['reserved', 'dispatched'].includes(record.status) ? record.dispatchedAt ? 'unknown' : 'rejected' : record.status;
const publicRecord = (record, at) => ({ id: record.id, organisationId: record.organisationId, operationId: record.operationId, service: record.service, channel: record.channel, status: effectiveStatus(record, at), month: record.month,
  createdAt: record.createdAt, ...(record.dispatchedAt ? { dispatchedAt: record.dispatchedAt } : {}), ...(record.completedAt ? { completedAt: record.completedAt } : {}), unitCostMinor: record.unitCostMinor, unitSalesMinor: record.unitSalesMinor, currency: record.currency,
  billableConfirmed: record.billableConfirmed === true, billingStatus: record.dispatchedAt ? record.billableConfirmed ? 'confirmed' : 'review' : 'not_dispatched' });
const countKeys = ['providerCalls', 'billableCount', 'reviewCount', 'reservedCount', 'notDispatchedCount', 'success', 'notFound', 'rejected', 'failed', 'unknown', 'costMinor', 'salesMinor', 'reviewSalesMinor'];
const emptyTotals = () => Object.fromEntries(countKeys.map(key => [key, 0]));
function add(target, source) { for (const key of countKeys) { target[key] += source[key]; if (!Number.isSafeInteger(target[key])) fail('Användningsbeloppet är för stort för ett säkert underlag.', 409, 'platform_usage_amount_overflow'); } }
function summarize(records, companies, at) {
  const groups = new Map(), names = new Map(companies.map(company => [company.id, String(company.name ?? company.id)]));
  for (const record of records) {
    const key = JSON.stringify([record.organisationId, record.service, record.channel, record.unitCostMinor, record.unitSalesMinor]);
    let row = groups.get(key);
    if (!row) { row = { service: record.service, channel: record.channel, unitCostMinor: record.unitCostMinor, unitSalesMinor: record.unitSalesMinor, ...emptyTotals() }; groups.set(key, { companyId: record.organisationId, ...row }); row = groups.get(key); }
    const delta = emptyTotals(), status = effectiveStatus(record, at), dispatched = Boolean(record.dispatchedAt), confirmed = dispatched && record.billableConfirmed === true;
    delta.providerCalls = dispatched ? 1 : 0; delta.billableCount = confirmed ? 1 : 0; delta.reviewCount = dispatched && !confirmed ? 1 : 0;
    delta.reservedCount = status === 'reserved' ? 1 : 0; delta.notDispatchedCount = dispatched ? 0 : 1;
    if (status === 'not_found') delta.notFound = 1; else if (['success', 'rejected', 'failed', 'unknown'].includes(status)) delta[status] = 1;
    delta.costMinor = dispatched ? record.unitCostMinor : 0; delta.salesMinor = confirmed ? record.unitSalesMinor : 0; delta.reviewSalesMinor = dispatched && !confirmed ? record.unitSalesMinor : 0; add(row, delta);
  }
  const grouped = new Map(), totals = emptyTotals();
  for (const row of [...groups.values()].sort((a, b) => a.companyId.localeCompare(b.companyId, 'en') || a.service.localeCompare(b.service, 'en') || a.channel.localeCompare(b.channel, 'en') || a.unitSalesMinor - b.unitSalesMinor || a.unitCostMinor - b.unitCostMinor)) {
    if (!grouped.has(row.companyId)) grouped.set(row.companyId, { companyId: row.companyId, companyName: names.get(row.companyId) ?? row.companyId, services: [], totals: emptyTotals() });
    const company = grouped.get(row.companyId), { companyId, ...item } = row; company.services.push(item); add(company.totals, row); add(totals, row);
  }
  return { companies: [...grouped.values()], totals };
}
const minorDecimal = amount => `${Math.floor(amount / 100)},${String(amount % 100).padStart(2, '0')}`;
const csvCell = value => { let text = String(value); if (/^\s*[=+\-@\t\r\n]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };

/** Generic metering boundary. The trusted caller owns identity, authorization
 * and provider preparation. beforeDispatch MUST run immediately before the one
 * provider request, after OAuth/internal matches. Only that atomic claim counts.
 * Neither provider results nor raw request data enter this ledger. */
export function createPlatformUsage({ storage, auth, tariffs = PLATFORM_USAGE_TARIFFS, now = () => new Date() } = {}) {
  if (!storage?.reserve || !storage?.markDispatched || !storage?.finish || !storage?.list || !storage?.fingerprintKey) throw new TypeError('Beständig plattformslagring krävs för användningsmätning.');
  const catalog = Object.fromEntries(Object.entries(tariffs).map(([name, tariff]) => [parse(service, name), parse(tariffSchema, tariff)]));
  let closed = false, fingerprintKey;
  const at = () => new Date(now()).toISOString();
  async function fingerprint(input) {
    const parsed = parse(z.object({ organisationId: id.max(100), service, value: z.string().min(1).max(4096) }).strict(), input);
    fingerprintKey ??= Promise.resolve(storage.fingerprintKey());
    const key = await fingerprintKey;
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) fail('Användningsmätningens korrelationsskydd är inte tillgängligt.', 503, 'platform_usage_fingerprint_unavailable');
    return createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify([parsed.organisationId, parsed.service, parsed.value])).digest('hex');
  }
  async function execute(input, callback) {
    if (closed) fail('Användningsmätningen stängs av. Inget uppslag har skickats.', 503, 'platform_usage_closed');
    const command = parse(commandSchema, input), tariff = Object.hasOwn(catalog, command.service) ? catalog[command.service] : undefined;
    if (!tariff || typeof callback !== 'function') fail('Tjänsten saknar godkänd serverägd användningstaxa.', 422, 'platform_usage_service_unknown');
    const stamp = at(), reservation = await storage.reserve({ id: randomUUID(), ...command, ...tariff, tariffVersion: tariff.version, status: 'reserved', claimId: randomUUID(), billableConfirmed: false, createdAt: stamp, month: platformUsageMonth(stamp), leaseUntil: new Date(Date.parse(stamp) + 60_000).toISOString(), history: [{ status: 'reserved', at: stamp }] });
    const record = reservation.record;
    if (record.fingerprint !== command.fingerprint || record.channel !== command.channel || record.actorId !== command.actorId) fail('Försöksnyckeln har redan använts för andra uppgifter.', 409, 'platform_usage_operation_conflict');
    if (!reservation.created) return { record: publicRecord(record, Date.parse(at())), replayed: true };
    let dispatched = false, dispatchInFlight = false, claimUncertain = false, outcome;
    const beforeDispatch = async () => {
      if (closed || dispatched || dispatchInFlight || Date.parse(record.leaseUntil) <= Date.parse(at())) fail('Uppslaget har redan hanterats eller dess reservation har löpt ut. Ingen ny leverantörsförfrågan skickas.', 409, 'platform_usage_already_dispatched');
      dispatchInFlight = true;
      const stamp = at(), claim = { claimId: record.claimId, at: stamp, month: platformUsageMonth(stamp), leaseUntil: new Date(Date.parse(stamp) + 60_000).toISOString() }; let claimed;
      try { claimed = await storage.markDispatched(command, claim); }
      catch (error) {
        claimUncertain = true;
        // Recover our own database COMMIT whose acknowledgement was lost. This
        // retries only a conditional SQL claim, never the external lookup. The
        // same private claimId proves this live callback owns the unpaid GET.
        try {
          const observed = await storage.markDispatched(command, claim);
          if (observed.changed || observed.record?.claimId === record.claimId && observed.record.status === 'dispatched') claimed = { ...observed, changed: true };
          else throw error;
        } catch { throw error; }
      }
      if (!claimed.changed) fail('Uppslaget har redan hanterats. Ingen ny leverantörsförfrågan skickas.', 409, 'platform_usage_already_dispatched');
      dispatched = true; claimUncertain = false;
    };
    try {
      outcome = parse(outcomeSchema, await callback({ beforeDispatch }));
      if (!dispatched && outcome.status !== 'rejected') fail('Leverantörsuppslaget saknar en bekräftad utskicksreservation.', 503, 'platform_usage_dispatch_missing');
    } catch (error) {
      // A timeout after dispatch cannot establish whether the provider charged.
      // Preserve uncertainty and never repeat the paid operation automatically.
      try { await storage.finish(command, { claimId: record.claimId, status: dispatched || claimUncertain ? 'unknown' : 'rejected', billableConfirmed: false, at: at() }); }
      catch { fail('Uppslagets utfall behöver kontrolleras. Inget automatiskt återförsök görs.', 503, 'platform_usage_outcome_unknown'); }
      throw error;
    }
    const billableConfirmed = dispatched && (['success', 'not_found'].includes(outcome.status) || outcome.status === 'rejected' && outcome.billableConfirmed === true);
    let saved;
    try { saved = await storage.finish(command, { claimId: record.claimId, status: outcome.status, billableConfirmed, at: at() }); }
    catch { fail('Uppslagets utfall behöver kontrolleras. Inget automatiskt återförsök görs.', 503, 'platform_usage_outcome_unknown'); }
    return { record: publicRecord(saved.record, Date.parse(at())), replayed: false, ...(Object.hasOwn(outcome, 'result') ? { result: outcome.result } : {}) };
  }
  async function authorize(req) {
    if (!auth?.withPlatformAdminTransaction) fail('Plattformsadministratör krävs.', 403, 'platform_usage_forbidden');
    try { return await auth.withPlatformAdminTransaction(req, state => state.companies.map(company => ({ id: company.id, name: company.name })), { purpose: 'usage' }); }
    catch (error) { if (error instanceof PlatformError && error.status === 403) fail('Öppna systemadministrationen som dig själv för att se användning och fakturaunderlag.', 403, 'platform_usage_forbidden'); throw error; }
  }
  async function read(input, req) {
    const companies = await authorize(req), filters = parse(filterSchema, input);
    const records = await storage.list({ month: filters.month, organisationId: filters.companyId });
    await authorize(req); // Withhold a late result after session/scope revocation.
    const summary = summarize(records, companies, Date.parse(at()));
    return { month: filters.month, currency: 'SEK', pricing: { roaringLookupSalesMinor: catalog['roaring.person.lookup']?.unitSalesMinor ?? 200, roaringLookupCostMinor: catalog['roaring.person.lookup']?.unitCostMinor ?? 200, pricesExcludeVat: true }, ...summary,
      availableCompanies: companies.sort((a, b) => a.id.localeCompare(b.id, 'en')).map(company => ({ id: company.id, name: company.name })) };
  }
  async function exportCsv(input, req) {
    const summary = await read(input, req), rows = [['Månad', 'Bolags-ID', 'Bolagsnamn', 'Tjänst', 'Kanal', 'Leverantörsförsök inkl. osäkra', 'Bekräftat debiterbara', 'Att granska', 'Styckpris SEK exkl. moms', 'Bekräftat belopp SEK exkl. moms', 'Belopp att granska SEK exkl. moms', 'Beräknad leverantörskostnad SEK']];
    // Stable sorting and frozen price groups make the same ledger/company
    // snapshot byte-identical. The human label is the current registry name;
    // a rename never changes the historic amount or identifying company ID.
    for (const company of summary.companies) for (const row of company.services) rows.push([summary.month, company.companyId, company.companyName, row.service, row.channel, row.providerCalls, row.billableCount, row.reviewCount, minorDecimal(row.unitSalesMinor), minorDecimal(row.salesMinor), minorDecimal(row.reviewSalesMinor), minorDecimal(row.costMinor)]);
    return { filename: `anvandning-${summary.month}-${input.companyId ?? 'alla-bolag'}.csv`, csv: '\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n' };
  }
  return { execute, fingerprint, read, exportCsv, close() { closed = true; } };
}
