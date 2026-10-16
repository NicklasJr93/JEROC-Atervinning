import { PricingError } from './pricing.mjs';
import { fleetProjection, fleetCommand, employeeFleetProjection, employeeFleetCommand, fleetTripGate } from './fleet.mjs';
import { fleetTelematicsProjection, fleetTelematicsCommand, fleetEmployeeTelematicsProjection } from './fleet-telematics.mjs';
import { fleetExportSelection, renderFleetCsv, renderFleetPdf } from './fleet-export.mjs';
import { assertFleetFileReferences } from './fleet-files.mjs';

const domains = ['metadata', 'pricing', 'personnel', 'personnelAuth', 'transport', 'fleet'];
const allowedStatus = new Set(['all', 'active', 'incomplete', 'pending', 'complete', 'completed', 'review']);
const allowedClassification = new Set(['all', 'business', 'private', 'unclassified']);
const identifier = /^[a-zA-Z0-9_:-]{1,120}$/;
const fail = (message, status = 422, code = 'fleet_invalid') => { const error = new PricingError(message, status); error.code = code; throw error; };
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail('Fordonsanropet måste komma från samma webbplats.', 403, 'fleet_origin_forbidden');
  if (req.headers.origin === undefined) return;
  try {
    const origin = new URL(req.headers.origin);
    const protocol = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
  } catch { fail('Fordonsanropet måste komma från samma webbplats.', 403, 'fleet_origin_forbidden'); }
}
const sendJson = (res, status, value, head = false) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(head ? undefined : JSON.stringify(value));
};
async function defaultBody(req) {
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > 128 * 1024) fail('Fordonsåtgärden är för stor.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Åtgärden ska innehålla giltig JSON.', 422); }
}
function date(value) {
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T12:00:00Z`) : NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value)
    fail('Välj ett giltigt datum för körjournalen.');
  return value;
}
function queryFilters(url, { own = false, actions = false, exporting = false } = {}) {
  const allowed = actions ? [] : ['from', 'to', 'classification', 'status', 'offset', 'limit', 'search',
    ...(!own ? ['vehicleId', 'personId'] : []), ...(exporting ? ['format'] : [])];
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
    fail('Fordonsfiltret innehåller okända eller upprepade val.');
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (key === 'from' || key === 'to') result[key] = date(value);
    else if (key === 'vehicleId' || key === 'personId') {
      if (!identifier.test(value)) fail('Välj ett giltigt fordon eller en registrerad person.');
      result[key] = value;
    } else if (key === 'classification') {
      if (!allowedClassification.has(value)) fail('Välj en giltig klassning.');
      result[key] = value;
    } else if (key === 'status') {
      if (!allowedStatus.has(value)) fail('Välj en giltig resestatus.');
      result[key] = value;
    } else if (key === 'format') {
      if (!['csv', 'pdf'].includes(value)) fail('Välj CSV eller PDF.');
      result[key] = value;
    } else if (key === 'search') {
      if (value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail('Söktexten är för lång eller innehåller otillåtna tecken.');
      result[key] = value.trim();
    } else {
      if (!/^(0|[1-9]\d*)$/.test(value)) fail('Välj en giltig sida för körjournalen.');
      const number = Number(value), max = key === 'limit' ? 1000 : 1_000_000;
      if (!Number.isSafeInteger(number) || number < (key === 'limit' ? 1 : 0) || number > max)
        fail('Sidans storlek eller startposition är för stor.');
      result[key] = number;
    }
  }
  if (result.from && result.to && result.from > result.to) fail('Periodens slutdatum föregår startdatum.');
  if (exporting) { result.format ??= 'csv'; result.offset = 0; result.limit = 1000; }
  return result;
}
const scopeAllows = (principal, siteId) => [principal.actor, principal.user].every(user =>
  !Array.isArray(user.siteIds) || user.siteIds.includes(siteId));
const siteView = sites => sites.map(site => ({ id: site.id, name: site.name, active: site.active !== false }));
const organisationId = (state, env) => env.SCRAPPILOT_ORGANISATION_ID ?? env.JEROC_TENANT_ID ?? state.metadata?.organisation?.id ?? 'jeroc-demo';

/** An isolated facade over the selected tenant repository. Authentication is
 * supplied by the existing office/employee session resolvers; employee routes
 * never fall back to browser demo headers or a client-selected company. */
export function createFleetApi({ getRepository, officePrincipal, ownPrincipal, readBody = defaultBody,
  json: _json = sendJson, siteProvider = async () => [], env = {}, simulationConnector: _simulationConnector } = {}) {
  if (typeof getRepository !== 'function' || typeof officePrincipal !== 'function' || typeof ownPrincipal !== 'function')
    throw new TypeError('Fordons-API behöver bolagets databas och verifierade sessioner.');
  const activeExports = new Set();
  // The legacy application writer replaces Cache-Control with plain no-store
  // and does not implement HEAD. Keep this private facade's headers explicit.
  const respond = sendJson;
  return async (req, res, url) => {
    const own = ['/api/employee/fleet', '/api/employee/fleet/actions'].includes(url.pathname);
    const office = ['/api/fleet', '/api/fleet/actions', '/api/fleet/export'].includes(url.pathname);
    if (!own && !office) return false; // The separate private file API owns /files.
    const actions = url.pathname.endsWith('/actions'), exporting = url.pathname === '/api/fleet/export';
    try {
      sameOrigin(req);
      const methods = actions ? ['POST'] : ['GET', 'HEAD'];
      if (!methods.includes(req.method)) { res.setHeader('Allow', methods.join(', ')); fail('Metoden stöds inte.', 405, 'fleet_method_not_allowed'); }
      const filters = queryFilters(url, { own, actions, exporting });
      let command;
      if (actions) {
        if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('Använd application/json.', 415);
        if (Number(req.headers['content-length']) > 128 * 1024) fail('Fordonsåtgärden är för stor.', 413);
        command = await readBody(req);
        if (!command || typeof command !== 'object' || Array.isArray(command) || JSON.stringify(command).length > 128 * 1024)
          fail('Välj en giltig fordonsåtgärd.');
      }
      const repository = await getRepository(), siteCatalog = await siteProvider();
      const operate = async (state, _revision, audit = []) => {
        const principal = await (own ? ownPrincipal(state, req) : officePrincipal(state, req));
        if (!principal?.actor?.id || !principal?.user?.id) fail('Logga in för att öppna fordon.', 401, 'fleet_auth_required');
        const org = organisationId(state, env), now = new Date().toISOString(), options = { ...filters, now, siteCatalog, organisationId: org };
        let person;
        if (own) {
          const people = (state.personnel?.people ?? []).filter(value => value.active !== false && value.kind === 'employee'
            && (value.userId ? value.userId === principal.user.id : value.id === principal.user.id));
          if (people.length !== 1) fail('Ditt konto saknar en entydig aktiv personkoppling.', 403, 'fleet_identity_invalid');
          person = people[0];
          if (req.headers['x-employee-person'] !== undefined && req.headers['x-employee-person'] !== person.id
            || req.headers['x-employee-company'] !== undefined && req.headers['x-employee-company'] !== org)
            fail('Personalkontot eller bolaget har ändrats. Öppna fordonsvyn igen.', 409, 'employee_selection_changed');
          options.allowedSiteIds = (person.siteIds ?? []).filter(siteId => scopeAllows(principal, siteId));
        }
        let saved;
        if (command) {
          try {
            const fileInput = command.action === 'profile.save' ? { vehicleId: command.vehicleId, references: [command.profile?.photoUrl ?? ''], kind: 'photo' }
              : command.action === 'issue.save' ? { vehicleId: command.issue?.vehicleId, references: command.issue?.photoUrls ?? [], kind: 'photo' }
                : command.action === 'inspection.save' ? { vehicleId: command.vehicleId, references: command.photoUrls ?? [], kind: 'photo' }
                  : command.action === 'service.save' ? { vehicleId: command.service?.vehicleId, references: command.service?.documentRefs ?? [], kind: 'document' } : null;
            if (fileInput && (!Array.isArray(fileInput.references) || fileInput.references.some(value => value))) {
              // Authorize the resource before acknowledging any private file
              // reference. Read-only/cross-site callers cannot probe receipt IDs.
              if (own && !['issue.save', 'inspection.save'].includes(command.action))
                fail('Åtgärden kräver kontorsbehörighet.', 403, 'fleet_forbidden');
              const access = own ? employeeFleetProjection(state, principal, { ...options, limit: 1 })
                : fleetProjection(state, principal, { ...options, limit: 1 });
              if (!access.capabilities.write || !access.vehicles.some(vehicle => vehicle.id === fileInput.vehicleId))
                fail('Du saknar åtkomst att ändra fordonets bilagor.', 403, 'fleet_file_forbidden');
              assertFleetFileReferences(state, fileInput.vehicleId, fileInput.references, { kind: fileInput.kind });
            }
            saved = own ? employeeFleetCommand(state, principal, command, audit, options)
              : typeof command.action === 'string' && command.action.startsWith('device.')
                ? fleetTelematicsCommand(state, principal, command, audit, options)
                : fleetCommand(state, principal, command, audit, options);
          } catch (error) {
            if (own && error instanceof PricingError && ['fleet_trip_active', 'fleet_trip_completion_required'].includes(error.code))
              error.fleetGate = fleetTripGate(state, person);
            throw error;
          }
        }
        const core = own ? employeeFleetProjection(state, principal, options) : fleetProjection(state, principal, options);
        const visibleSites = siteCatalog.filter(site => site.active !== false && scopeAllows(principal, site.id)
          && (!own || options.allowedSiteIds.includes(site.id)));
        if (exporting) {
          if (!core.capabilities.export) fail('Du saknar behörighet att exportera körjournal.', 403, 'fleet_export_forbidden');
          if (core.truncated || core.pagination?.total > core.trips.length)
            fail('Urvalet innehåller fler än 1 000 resor. Begränsa datum, fordon eller förare och exportera igen.', 422, 'fleet_export_limit');
          return { core, principal: { actorId: principal.actor.id, userId: principal.user.id, name: principal.user.name ?? principal.user.id },
            org, companyName: state.metadata?.organisation?.name ?? env.JEROC_COMPANY_NAME ?? '' };
        }
        const telematics = own ? fleetEmployeeTelematicsProjection(state, core.vehicles.map(vehicle => vehicle.id), options)
          : fleetTelematicsProjection(state, principal, options);
        const positions = own ? undefined : telematics.devices.flatMap(device => device.vehicleId && device.latestPosition
          ? [{ vehicleId: device.vehicleId, ...device.latestPosition, source: device.source,
            stale: Date.parse(now) - Date.parse(device.latestPosition.at) > 10 * 60 * 1000 }] : []);
        return { ...core, ...(positions ? { positions } : {}), telematics, sites: siteView(visibleSites), serverNow: now,
          ...(saved?.saved ? { saved: saved.saved } : {}),
          ...(saved?.savedDeviceId ? { savedDeviceId: saved.savedDeviceId, savedTransferId: saved.savedTransferId ?? null } : {}),
          ...(saved?.replayed ? { replayed: true } : {}) };
      };
      const result = actions ? await repository.transact(operate) : await repository.read(operate, { domains });
      if (!exporting) { respond(res, 200, result, req.method === 'HEAD'); return true; }
      const key = JSON.stringify([result.org, result.principal.actorId, result.principal.userId]);
      if (activeExports.has(key) || activeExports.size >= 32) fail('En körjournal håller redan på att skapas. Försök igen om en stund.', 429, 'fleet_export_busy');
      activeExports.add(key);
      try {
        // Source projection already applied every filter before pagination. The
        // renderer adds a second privacy whitelist and marks missing evidence.
        const selectionFilters = Object.fromEntries(['from', 'to', 'vehicleId', 'personId', 'classification', 'status', 'search']
          .filter(name => filters[name] !== undefined).map(name => [name, filters[name]]));
        const selection = fleetExportSelection(result.core, selectionFilters);
        const content = filters.format === 'pdf' ? await renderFleetPdf(selection, { companyName: result.companyName, actorName: result.principal.name }) : renderFleetCsv(selection);
        const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        res.writeHead(200, { 'Content-Type': filters.format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8',
          'Content-Length': bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer', 'Content-Disposition': `attachment; filename="korjournal.${filters.format}"` });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } finally { activeExports.delete(key); }
    } catch (error) {
      const known = error instanceof PricingError;
      respond(res, known ? error.status : 503, { error: known ? error.message : 'Fordonsuppgifterna kunde inte läsas eller sparas. Försök igen.',
        code: known ? error.code ?? 'fleet_invalid' : 'fleet_unavailable', ...(known && error.gate ? { gate: error.gate } : {}),
        ...(known && error.fleetGate ? { fleetGate: error.fleetGate } : {}) }, req.method === 'HEAD');
    }
    return true;
  };
}
