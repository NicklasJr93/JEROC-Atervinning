import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PricingError } from './pricing.mjs';

const TZ = 'Europe/Stockholm';
const MAX_TRIPS = 10_000;
const draftLabel = 'Utkast – ofullständiga uppgifter';
const classFilterLabel = value => ({ business: 'Tjänst', private: 'Privat', pending: 'Ej klassad', unclassified: 'Ej klassad' }[value] ?? 'Alla');
const statusFilterLabel = value => ({ active: 'Pågående', incomplete: 'Behöver kompletteras', pending: 'Behöver kompletteras', complete: 'Klassade', completed: 'Klassade', review: 'Behöver granskas' }[value] ?? 'Alla');
const clean = value => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').normalize('NFC');
const text = value => clean(value).trim();
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const decimal = value => finite(value) ? value.toLocaleString('sv-SE', { maximumFractionDigits: 3 }).replaceAll('\u00a0', ' ') : '';
const dayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const day = value => validInstant(value) ? dayFormatter.format(new Date(value)) : '';
const stamp = value => validInstant(value) ? timeFormatter.format(new Date(value)) : '';
const fail = (message, status = 422, code = 'fleet_export_invalid') => { const error = new PricingError(message, status); error.code = code; throw error; };
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value);
const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_:-]+$/);
const filterSchema = z.object({ from: date.optional(), to: date.optional(), vehicleId: id.optional(), personId: id.optional(),
  classification: z.enum(['all', 'business', 'private', 'pending', 'unclassified']).optional(),
  status: z.enum(['all', 'active', 'complete', 'completed', 'incomplete', 'pending', 'review']).optional(),
  search: z.string().trim().max(200).optional(), format: z.enum(['csv', 'pdf']).optional() }).strict();
const concretePurpose = value => text(value).length >= 5 && !/^(tjänst|arbete|jobb|business|work)$/i.test(text(value));
function filterInput(query) {
  if (query instanceof URLSearchParams) {
    for (const key of query.keys()) if (query.getAll(key).length > 1) fail('Ett exportfilter får bara anges en gång.');
    return Object.fromEntries([...query.entries()].filter(([, value]) => value !== ''));
  }
  if (!query || typeof query !== 'object' || Array.isArray(query)) fail('Kontrollera exportens filter.');
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== '' && value !== undefined));
}

/** Input is already scoped by the tenant/permission projection. Build a second
 * explicit allowlist so private routes and unrelated raw metadata cannot leak. */
export function fleetExportSelection(projection, query = {}) {
  if (projection?.truncated || Number(projection?.pagination?.offset) > 0)
    fail('Hela urvalet ryms inte i exporten. Begränsa datum, fordon eller förare och exportera igen.', 422, 'fleet_export_limit');
  const parsed = filterSchema.safeParse(filterInput(query));
  if (!parsed.success) fail('Kontrollera exportens datum, fordon, förare och klassning.');
  const { format: _format, ...filters } = parsed.data;
  if (filters.from && filters.to && filters.from > filters.to) fail('Från-datum får inte ligga efter till-datum.');
  const vehicles = new Map((projection?.vehicles ?? []).map(vehicle => [vehicle.id, vehicle]));
  const people = new Map((projection?.people ?? []).map(person => [person.id, person]));
  const workOrders = new Set((projection?.workOrders ?? []).map(order => order.id));
  const trips = [];
  for (const trip of projection?.trips ?? []) {
    const localDay = day(trip.startAt);
    if (filters.from && (!localDay || localDay < filters.from) || filters.to && (!localDay || localDay > filters.to)
      || filters.vehicleId && trip.vehicleId !== filters.vehicleId || filters.personId && trip.personId !== filters.personId
      || filters.classification && filters.classification !== 'all' && (trip.classification ?? 'pending') !== (filters.classification === 'unclassified' ? 'pending' : filters.classification)) continue;
    const vehicle = vehicles.get(trip.vehicleId), person = people.get(trip.personId);
    const classification = ['business', 'private'].includes(trip.classification) ? trip.classification : 'pending';
    const business = classification === 'business';
    const missingFields = [];
    const vehicleIdentifier = text(vehicle?.registration || vehicle?.assetTag || vehicle?.identifier || vehicle?.machineIdentifier);
    if (!vehicle || !vehicleIdentifier) missingFields.push('Fordonsidentifiering');
    const manualDriver = trip.manualDriverAssignment?.personId === trip.personId;
    const driverName = (trip.driverSource !== 'unknown' || manualDriver) && (!trip.driverConflict || manualDriver) ? text(person?.name) : '';
    if (!driverName) missingFields.push('Förare');
    if (!validInstant(trip.startAt)) missingFields.push('Startdatum/tid');
    if (!validInstant(trip.endAt)) missingFields.push('Slutdatum/tid');
    else if (validInstant(trip.startAt) && Date.parse(trip.endAt) < Date.parse(trip.startAt)) missingFields.push('Sluttid före starttid');
    if (!finite(trip.distanceKm)) missingFields.push('Körsträcka');
    if (!finite(trip.startOdometerKm)) missingFields.push('Mätarställning start');
    if (!finite(trip.endOdometerKm)) missingFields.push('Mätarställning slut');
    if (finite(trip.startOdometerKm) && finite(trip.endOdometerKm) && trip.endOdometerKm < trip.startOdometerKm) missingFields.push('Mätarställning går bakåt');
    if (classification === 'pending') missingFields.push('Klassning');
    if (!['device', 'simulator'].includes(trip.source)) missingFields.push('Datakälla');
    if (trip.quality === 'sensor_gap' || trip.quality === 'review') missingFields.push('Sensorunderlag behöver kontrolleras');
    const workOrderId = business && workOrders.has(trip.workOrderId) ? text(trip.workOrderId) : '';
    const purpose = business ? text(trip.purpose) : '';
    const fromLabel = business ? text(trip.fromLabel) : '', toLabel = business ? text(trip.toLabel) : '';
    if (business) {
      if (!fromLabel) missingFields.push('Startadress');
      if (!toLabel) missingFields.push('Slutadress');
      if (!concretePurpose(purpose) && !workOrderId) missingFields.push('Konkret syfte eller arbetsorder');
    }
    const complete = missingFields.length === 0;
    // Match the journal UI's classification/status filter. Export completeness
    // is stricter (odometer, addresses etc.) and must not silently remove rows
    // from an otherwise completed/returned journal selection.
    const classCompleted = classification === 'private' || business && (concretePurpose(trip.purpose) || Boolean(trip.workOrderId));
    const review = trip.quality === 'review' || trip.quality === 'sensor_gap' || Boolean(trip.driverConflict && !trip.manualDriverAssignment) || trip.driverSource === 'unknown' && !trip.manualDriverAssignment;
    if (filters.status === 'active' && trip.endAt
      || ['incomplete', 'pending'].includes(filters.status) && (!trip.endAt || trip.quality === 'sensor_gap' || classCompleted)
      || ['complete', 'completed'].includes(filters.status) && (!trip.endAt || !classCompleted)
      || filters.status === 'review' && !review) continue;
    const searchText = [trip.id, trip.vehicleId, trip.personId, vehicleIdentifier, vehicle?.name, person?.name,
      ...(business ? [trip.purpose, trip.workOrderId, trip.fromLabel, trip.toLabel] : [])].filter(Boolean).join(' ').toLocaleLowerCase('sv-SE');
    if (filters.search && !searchText.includes(filters.search.toLocaleLowerCase('sv-SE'))) continue;
    trips.push({ id: text(trip.id), vehicleId: text(trip.vehicleId), vehicleIdentifier, vehicleName: text(vehicle?.name),
      driverName, personId: driverName ? text(trip.personId) : '', date: localDay,
      startAt: validInstant(trip.startAt) ? trip.startAt : '', endAt: validInstant(trip.endAt) ? trip.endAt : '',
      distanceKm: finite(trip.distanceKm) ? trip.distanceKm : null,
      startOdometerKm: finite(trip.startOdometerKm) ? trip.startOdometerKm : null, endOdometerKm: finite(trip.endOdometerKm) ? trip.endOdometerKm : null,
      classification, classificationLabel: classification === 'business' ? 'Tjänst' : classification === 'private' ? 'Privat' : 'Ej klassad',
      fromLabel, toLabel, purpose, workOrderId,
      source: ['device', 'simulator'].includes(trip.source) ? trip.source : 'unknown', sourceLabel: trip.source === 'simulator' ? 'Simulerad testdata' : trip.source === 'device' ? 'Tracker' : 'Okänd källa',
      complete, missingFields, status: complete ? 'Uppgifter ifyllda' : 'Ofullständig', quality: ['good', 'sensor_gap', 'review'].includes(trip.quality) ? trip.quality : 'unknown' });
    if (trips.length > MAX_TRIPS) fail('Urvalet innehåller fler än 10 000 resor. Begränsa datum, fordon eller förare och exportera igen.', 422, 'fleet_export_limit');
  }
  trips.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id));
  const completeCount = trips.filter(trip => trip.complete).length, missingCount = trips.length - completeCount;
  return { filters, trips, count: trips.length, completeCount, missingCount, draft: missingCount > 0,
    label: missingCount ? draftLabel : trips.length ? 'Körjournal – uppgifter ifyllda' : 'Körjournal – inga resor i urvalet',
    hasSimulator: trips.some(trip => trip.source === 'simulator'),
    totalDistanceKm: trips.reduce((sum, trip) => sum + (trip.distanceKm ?? 0), 0),
    missingDistanceCount: trips.filter(trip => trip.distanceKm === null).length };
}

function csvCell(value) {
  const raw = clean(value), safe = /^[\s]*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function renderFleetCsv(selection) {
  const rows = [
    ['Körjournal', selection.label],
    ['Antal resor', selection.count, 'Uppgifter ifyllda', selection.completeCount, 'Ofullständiga', selection.missingCount],
    ['Datum från', selection.filters.from ?? '', 'Datum till', selection.filters.to ?? '', 'Tidszon', TZ],
    ['Fordon', selection.filters.vehicleId ?? 'Alla i behörigt urval', 'Förare', selection.filters.personId ?? 'Alla i behörigt urval', 'Klassning', classFilterLabel(selection.filters.classification)],
    ['Resestatusfilter', statusFilterLabel(selection.filters.status), 'Sökfilter', selection.filters.search ?? ''],
    ['Datakälla', selection.hasSimulator ? 'TESTDATA INGÅR – simulerade resor bevisar inte faktisk körning.' : 'Datakälla anges per resa. Ingen saknad körning har konstruerats.'],
    [],
    ['Resa', 'Datum', 'Starttid (Stockholm)', 'Sluttid (Stockholm)', 'Fordon', 'Fordonsnamn', 'Fordons-ID', 'Förare', 'Mätare start km', 'Mätare slut km', 'Körsträcka km', 'Klassning', 'Startadress', 'Slutadress', 'Syfte', 'Arbetsorder', 'Datakälla', 'Status', 'Saknade uppgifter'],
    ...selection.trips.map(trip => [trip.id, trip.date, stamp(trip.startAt), stamp(trip.endAt), trip.vehicleIdentifier, trip.vehicleName, trip.vehicleId, trip.driverName,
      decimal(trip.startOdometerKm), decimal(trip.endOdometerKm), decimal(trip.distanceKm), trip.classificationLabel,
      trip.classification === 'business' ? trip.fromLabel : '', trip.classification === 'business' ? trip.toLabel : '',
      trip.classification === 'business' ? trip.purpose : '', trip.classification === 'business' ? trip.workOrderId : '',
      trip.sourceLabel, trip.status, trip.missingFields.join(' · ')]),
    [], ['Registrerad körsträcka km', decimal(selection.totalDistanceKm), 'Resor utan registrerad körsträcka', selection.missingDistanceCount],
    ['Underlag', 'Export av registrerade uppgifter. Saknade sensorvärden lämnas tomma; datakällan framgår per resa.'],
  ];
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n');
}

/** A4 vector text with a repeated journal header; no browser or external API. */
export async function renderFleetPdf(selection, { companyName = '', actorName = '' } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: 'Körjournal', Author: clean(companyName), Creator: 'ScrapPilot' } });
  doc.registerFont('regular', fileURLToPath(new URL('./documents/fonts/DejaVuSans.ttf', import.meta.url)));
  doc.registerFont('bold', fileURLToPath(new URL('./documents/fonts/DejaVuSans-Bold.ttf', import.meta.url)));
  const output = new Promise((resolve, reject) => { const chunks = []; doc.on('data', chunk => chunks.push(chunk)); doc.once('error', reject); doc.once('end', () => resolve(Buffer.concat(chunks))); });
  const W = doc.page.width, H = doc.page.height, M = 29, WIDTH = W - M * 2, BOTTOM = H - 58;
  const colors = { navy: '#092B51', blue: '#146091', green: '#17804B', muted: '#6E859B', line: '#D8E5EF', light: '#EFF6FC', amber: '#936316' };
  const createdAt = stamp(new Date().toISOString()); let y = M;
  function font(size, bold = false, color = colors.navy) { return doc.font(bold ? 'bold' : 'regular').fontSize(size).fillColor(color); }
  function wrap(value, width, size = 8, bold = false) {
    font(size, bold); const result = [];
    for (const paragraph of clean(value).split('\n')) {
      let current = '';
      for (const word of paragraph.trim().split(/\s+/)) {
        if (doc.widthOfString(current ? `${current} ${word}` : word) <= width) { current = current ? `${current} ${word}` : word; continue; }
        if (current) { result.push(current); current = ''; }
        for (const character of word) { if (current && doc.widthOfString(current + character) > width) { result.push(current); current = ''; } current += character; }
      }
      result.push(current);
    }
    return result;
  }
  function draw(value, x, top, width, size = 8, bold = false, color = colors.navy, align = 'left') {
    const lines = wrap(value, width, size, bold);
    lines.forEach((line, i) => font(size, bold, color).text(line, x, top + i * (size + 3), { width, lineBreak: false, align }));
    return lines.length * (size + 3);
  }
  function nextPage() { doc.addPage({ size: 'A4', margin: 0 }); header(true); }
  function header(continued = false) {
    y = M;
    if (companyName) y += draw(companyName, M, y, WIDTH, 10, true) + 6;
    y += draw(continued ? 'KÖRJOURNAL · fortsättning' : 'KÖRJOURNAL', M, y, WIDTH, continued ? 15 : 20, true) + 4;
    doc.rect(M, y, 39, 2.5).fill(colors.green); y += 12;
    y += draw(selection.label, M, y, WIDTH, 9, true, selection.draft ? colors.amber : colors.green) + 6;
    y += draw(`${selection.count} ${selection.count === 1 ? 'resa' : 'resor'} · ${selection.completeCount} med ifyllda uppgifter · ${selection.missingCount} ${selection.missingCount === 1 ? 'ofullständig' : 'ofullständiga'}`, M, y, WIDTH, 8, false, colors.muted) + 5;
    if (!continued) {
      const period = `${selection.filters.from ?? 'Alla datum'} – ${selection.filters.to ?? 'alla datum'}`;
      y += draw(`Period: ${period} · Tider i ${TZ}`, M, y, WIDTH, 8, false, colors.muted) + 4;
      y += draw(`Fordon: ${selection.filters.vehicleId ?? 'Alla i behörigt urval'} · Förare: ${selection.filters.personId ?? 'Alla i behörigt urval'}`, M, y, WIDTH, 8, false, colors.muted) + 4;
      if (selection.filters.classification && selection.filters.classification !== 'all' || selection.filters.status && selection.filters.status !== 'all' || selection.filters.search)
        y += draw(`Klassning: ${classFilterLabel(selection.filters.classification)} · Resestatus: ${statusFilterLabel(selection.filters.status)}${selection.filters.search ? ` · Sökning: ${selection.filters.search}` : ''}`, M, y, WIDTH, 8, false, colors.muted) + 4;
      y += draw(`Export ${createdAt}${actorName ? ` · ${clean(actorName)}` : ''}`, M, y, WIDTH, 7, false, colors.muted) + 6;
    }
    if (selection.hasSimulator) y += draw('TESTDATA INGÅR – simulerade resor är inte bevis på faktisk körning.', M, y, WIDTH, 8, true, colors.amber) + 8;
    y += 4;
  }
  const widths = [WIDTH * .17, WIDTH * .18, WIDTH * .18, WIDTH * .27, WIDTH * .20];
  const xs = widths.map((_, i) => M + widths.slice(0, i).reduce((sum, value) => sum + value, 0));
  function tableHeader() {
    doc.rect(M, y, WIDTH, 25).fill(colors.blue);
    ['Datum / tid', 'Fordon / förare', 'Mätare / sträcka', 'Klassning / uppgifter', 'Status'].forEach((value, i) => draw(value, xs[i] + 7, y + 8, widths[i] - 14, 7, true, '#FFFFFF'));
    y += 25;
  }
  try {
    header(); tableHeader();
    for (const [index, trip] of selection.trips.entries()) {
      const business = trip.classification === 'business';
      const values = [
        `${stamp(trip.startAt) || 'Starttid saknas'}\n${stamp(trip.endAt) || 'Sluttid saknas'}\nResa ${trip.id}`,
        `${trip.vehicleIdentifier || 'Identifiering saknas'}\n${trip.vehicleName}\n${trip.driverName || 'Förare saknas'}`,
        `Start: ${decimal(trip.startOdometerKm)}${finite(trip.startOdometerKm) ? ' km' : ''}\nSlut: ${decimal(trip.endOdometerKm)}${finite(trip.endOdometerKm) ? ' km' : ''}\nSträcka: ${decimal(trip.distanceKm)}${finite(trip.distanceKm) ? ' km' : ''}`,
        `${trip.classificationLabel}${business ? `\n${trip.fromLabel || 'Startadress saknas'} → ${trip.toLabel || 'Slutadress saknas'}\n${trip.purpose}${trip.workOrderId ? `\nAO: ${trip.workOrderId}` : ''}` : ''}\nKälla: ${trip.sourceLabel}`,
        `${trip.status}${trip.missingFields.length ? `\n${trip.missingFields.join('\n')}` : ''}`,
      ];
      const cells = values.map((value, column) => wrap(value, widths[column] - 14, 7.5));
      let remaining = Math.max(...cells.map(cell => cell.length));
      const naturalHeight = remaining * 10.5 + 14;
      if (y + naturalHeight > BOTTOM && naturalHeight < BOTTOM - 180) { nextPage(); tableHeader(); }
      while (remaining) {
        if (y + 25 > BOTTOM) { nextPage(); tableHeader(); }
        const count = Math.min(remaining, Math.max(1, Math.floor((BOTTOM - y - 14) / 10.5))), height = count * 10.5 + 14;
        doc.rect(M, y, WIDTH, height).fill(index % 2 ? '#F4F9FE' : '#FFFFFF');
        cells.forEach((cell, column) => cell.splice(0, count).forEach((line, lineIndex) => draw(line, xs[column] + 7, y + 7 + lineIndex * 10.5, widths[column] - 14, 7.5, false, column === 4 && !trip.complete ? colors.amber : colors.navy)));
        doc.moveTo(M, y + height).lineTo(W - M, y + height).strokeColor(colors.line).lineWidth(.5).stroke();
        y += height; remaining -= count;
        if (remaining) { nextPage(); tableHeader(); }
      }
    }
    if (!selection.trips.length) { draw('Inga resor matchar de valda filtren.', M + 9, y + 18, WIDTH - 18, 10); y += 55; }
    if (y + 62 > BOTTOM) nextPage();
    y += 14;
    y += draw(`Registrerad körsträcka: ${decimal(selection.totalDistanceKm)} km. ${selection.missingDistanceCount} ${selection.missingDistanceCount === 1 ? 'resa saknar' : 'resor saknar'} registrerad sträcka.`, M, y, WIDTH, 9, true) + 6;
    draw('Export av registrerade uppgifter. Saknade sensorvärden har inte beräknats eller fyllts i.', M, y, WIDTH, 8, false, colors.muted);
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i); const top = H - 44;
      doc.moveTo(M, top).lineTo(W - M, top).lineWidth(.6).strokeColor(colors.line).stroke();
      draw(selection.draft ? draftLabel : 'Körjournal · exporterat urval', M, top + 7, WIDTH - 85, 7, false, colors.muted);
      draw(`Sida ${i + 1} av ${range.count}`, W - M - 83, top + 7, 83, 7, false, colors.muted, 'right');
      draw(selection.hasSimulator ? 'Datakälla per rad · TESTDATA ingår, inte bevis på faktisk körning.' : 'Datakälla per rad · Saknade värden lämnas tomma i dataexporten.', M, top + 22, WIDTH, 7, false, colors.muted);
    }
    doc.end();
  } catch (error) { doc.destroy(error); }
  return output;
}
