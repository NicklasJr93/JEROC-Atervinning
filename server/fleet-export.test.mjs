import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetExportSelection, renderFleetCsv, renderFleetPdf } from './fleet-export.mjs';

const trip = (id, patch = {}) => ({ id, vehicleId: 'van-1', personId: 'person-1', driverSource: 'panel', startAt: '2026-10-15T22:30:00Z', endAt: '2026-10-15T23:15:00Z',
  startOdometerKm: 1000, endOdometerKm: 1012.3, distanceKm: 12.3, classification: 'business', purpose: 'Hämtning av skrot hos verkstad',
  fromLabel: 'Gården 1, Norrtälje', toLabel: 'Verkstadsvägen 7, Täby', source: 'device', quality: 'good', ...patch });
const projection = trips => ({ vehicles: [{ id: 'van-1', registration: 'ABC123', name: 'Servicebil' }, { id: 'machine-1', machineIdentifier: 'MASKIN-17', name: 'Grävmaskin' }],
  people: [{ id: 'person-1', name: 'Åsa Öberg' }], workOrders: [{ id: 'AO-123' }], trips });
const pages = pdf => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
let extracts = true;
try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); } catch { extracts = false; }
async function extract(pdf, boxes = false) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-fleet-export-'));
  try { const path = join(directory, 'journal.pdf'); await writeFile(path, pdf); return execFileSync('pdftotext', [boxes ? '-bbox-layout' : '-layout', path, '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function csvRows(csv) {
  const rows = [], row = []; let value = '', quoted = false;
  const input = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (character === '"') { if (quoted && input[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (character === ';' && !quoted) { row.push(value); value = ''; }
    else if (character === '\r' && input[i + 1] === '\n' && !quoted) { row.push(value); rows.push([...row]); row.length = 0; value = ''; i++; }
    else value += character;
  }
  row.push(value); rows.push([...row]); return rows;
}

test('export dates use Stockholm calendar days, filters are strict and selected counts are complete', () => {
  const data = projection([trip('oct16'), trip('oct15', { startAt: '2026-10-15T10:00:00Z', endAt: '2026-10-15T11:00:00Z' }), trip('private', { classification: 'private' })]);
  const selected = fleetExportSelection(data, new URLSearchParams('from=2026-10-16&to=2026-10-16&format=csv'));
  assert.deepEqual(selected.trips.map(value => value.id), ['oct16', 'private']); assert.equal(selected.count, 2); assert.equal(selected.completeCount, 2); assert.equal(selected.missingCount, 0);
  assert.equal(fleetExportSelection(data, { vehicleId: 'unknown' }).count, 0);
  for (const filters of [{ from: '2026-02-30' }, { from: '2026-10-16', to: '2026-10-15' }, { classification: 'invented' }, { includePrivateAddresses: true }, { vehicleId: 'x\n y' }]) assert.throws(() => fleetExportSelection(data, filters), error => error.status === 422);
  assert.throws(() => fleetExportSelection(data, new URLSearchParams('from=2026-10-15&from=2026-10-16')), /bara anges en gång/);
});
test('business completion requires concrete purpose or a visible work order; sensor gaps stay explicit', () => {
  const selected = fleetExportSelection(projection([
    trip('generic', { purpose: 'Tjänst' }), trip('order', { purpose: '', workOrderId: 'AO-123' }), trip('hidden-order', { purpose: '', workOrderId: 'SECRET-AO' }),
    trip('gap', { quality: 'sensor_gap', distanceKm: undefined, startOdometerKm: undefined, endOdometerKm: undefined }), trip('machine', { vehicleId: 'machine-1' }),
  ]));
  assert.equal(selected.completeCount, 2); assert.equal(selected.missingCount, 3); assert.equal(selected.label, 'Utkast – ofullständiga uppgifter');
  assert.equal(selected.trips.find(value => value.id === 'hidden-order').workOrderId, '');
  const gap = selected.trips.find(value => value.id === 'gap'); assert.equal(gap.distanceKm, null); assert.equal(gap.startOdometerKm, null); assert.equal(gap.endOdometerKm, null);
  assert.ok(gap.missingFields.includes('Sensorunderlag behöver kontrolleras'));
  assert.equal(fleetExportSelection(projection(selected.trips), { status: 'review' }).count, 1);
});
test('private and unclassified rows strip addresses, purpose, order, raw positions and unrelated secrets', () => {
  const selected = fleetExportSelection(projection([
    trip('private', { classification: 'private', fromLabel: 'PRIVATE-FROM', toLabel: 'PRIVATE-TO', purpose: 'PRIVATE-PURPOSE', workOrderId: 'AO-123', positions: [{ lat: 66, lng: 18 }], apiKey: 'SECRET-TOKEN' }),
    trip('pending', { classification: undefined, fromLabel: 'PENDING-FROM', toLabel: 'PENDING-TO', purpose: 'PENDING-PURPOSE', workOrderId: 'AO-123' }),
  ]));
  for (const row of selected.trips) { assert.equal(row.fromLabel, ''); assert.equal(row.toLabel, ''); assert.equal(row.purpose, ''); assert.equal(row.workOrderId, ''); assert.equal(row.positions, undefined); assert.equal(row.apiKey, undefined); }
  const serialized = JSON.stringify(selected) + renderFleetCsv(selected);
  assert.doesNotMatch(serialized, /PRIVATE-FROM|PRIVATE-TO|PRIVATE-PURPOSE|PENDING-FROM|PENDING-PURPOSE|AO-123|SECRET-TOKEN/);
  assert.equal(selected.completeCount, 1); assert.equal(selected.missingCount, 1);
});
test('journal status aliases, safe search and manually assigned drivers match the visible selection', () => {
  const data = projection([
    trip('manual', { driverSource: 'unknown', driverConflict: true, manualDriverAssignment: { personId: 'person-1' }, distanceKm: undefined }),
    trip('unknown-driver', { driverSource: 'unknown', personId: undefined }),
    trip('active', { endAt: undefined, classification: undefined }),
    trip('private-search', { classification: 'private', purpose: 'PRIVATE-SEARCH-PURPOSE', fromLabel: 'PRIVATE-SEARCH-ADDRESS' }),
  ]);
  const completed = fleetExportSelection(data, { status: 'completed', classification: 'all' });
  assert.ok(completed.trips.some(value => value.id === 'manual'));
  assert.equal(completed.trips.find(value => value.id === 'manual').driverName, 'Åsa Öberg');
  assert.ok(completed.draft, 'missing odometer/distance rows remain explicitly incomplete in completed classification selection');
  assert.deepEqual(fleetExportSelection(data, { status: 'active', classification: 'unclassified' }).trips.map(value => value.id), ['active']);
  assert.deepEqual(fleetExportSelection(data, { status: 'review' }).trips.map(value => value.id), ['unknown-driver']);
  assert.equal(fleetExportSelection(data, { search: 'PRIVATE-SEARCH-ADDRESS' }).count, 0);
  assert.equal(fleetExportSelection(data, { search: 'ÅSA' }).count, 3);
  data.vehicles[1] = { id: 'machine-1', assetTag: 'MASKIN-A', name: 'Lastmaskin' };
  assert.equal(fleetExportSelection({ ...data, trips: [trip('machine', { vehicleId: 'machine-1' })] }).trips[0].vehicleIdentifier, 'MASKIN-A');
});
test('CSV is quoted, spreadsheet-safe, has matching counts and leaves unknown sensor cells empty', () => {
  const data = projection([trip('=HYPERLINK("https://bad.invalid")', { purpose: '+malicious, but long', quality: 'review', startOdometerKm: undefined, endOdometerKm: undefined, distanceKm: undefined })]);
  data.people[0].name = '  @bad'; data.vehicles[0].name = 'Återbruk; "Norr"';
  const selected = fleetExportSelection(data), csv = renderFleetCsv(selected), rows = csvRows(csv), header = rows.findIndex(row => row[0] === 'Resa'), row = rows[header + 1];
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(row[0].startsWith("'=HYPERLINK")); assert.equal(row[5], 'Återbruk; "Norr"'); assert.equal(row[7], "'@bad");
  assert.equal(row[8], ''); assert.equal(row[9], ''); assert.equal(row[10], ''); assert.ok(row[14].startsWith("'+"));
  assert.match(csv, /Utkast – ofullständiga uppgifter/); assert.match(csv, /Europe\/Stockholm/); assert.match(row[2], /^2026-10-16 00:30:00$/);
  assert.ok(row[18].includes('Mätarställning start')); assert.equal(selected.count, 1);
});
test('exports reject incomplete paging and excessive matching rows instead of silently truncating', () => {
  assert.throws(() => fleetExportSelection({ ...projection([trip('only-first-page')]), truncated: true }), error => error.code === 'fleet_export_limit');
  assert.throws(() => fleetExportSelection({ ...projection([trip('page-two')]), pagination: { offset: 100 } }), error => error.code === 'fleet_export_limit');
  const data = projection(Array.from({ length: 10001 }, (_, i) => trip(`trip-${i}`)));
  assert.throws(() => fleetExportSelection(data), /10 000/);
});
test('native A4 PDF uses the same draft counts and source warnings without private details', { skip: !extracts }, async () => {
  const selected = fleetExportSelection(projection([trip('business'), trip('private', { classification: 'private', fromLabel: 'PRIVATE-ADDRESS', purpose: 'PRIVATE-PURPOSE', source: 'simulator' }), trip('missing', { endAt: undefined, distanceKm: undefined })]));
  const pdf = await renderFleetPdf(selected, { companyName: 'Återbruk Öst AB', actorName: 'Kajsa Äng' }), content = await extract(pdf);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.match(content, /Återbruk Öst AB|Återbruk Öst/); assert.match(content, /Utkast – ofullständiga uppgifter/);
  assert.match(content, /3 resor · 2 med ifyllda uppgifter · 1 ofullständig/); assert.match(content, /TESTDATA INGÅR/); assert.match(content, /inte bevis på faktisk körning/);
  assert.match(content, /Åsa Öberg/); assert.doesNotMatch(content, /PRIVATE-ADDRESS|PRIVATE-PURPOSE/); assert.match(content, /Körsträcka/); assert.match(content, /Slutdatum\/tid/);
  assert.ok(pages(pdf) >= 1); assert.match(content, /Sida 1 av/);
});
test('PDF paginates every selected trip with repeated headers and wraps oversized text within A4 margins', { skip: !extracts }, async () => {
  const selected = fleetExportSelection(projection(Array.from({ length: 90 }, (_, i) => trip(`ROW${String(i).padStart(3, '0')}`, { purpose: i === 40 ? 'Materialhämtning'.repeat(220) : 'Hämtning av skrot hos verkstad' }))));
  const pdf = await renderFleetPdf(selected, { companyName: 'Testbolag AB', actorName: 'Anna Berg' }), content = await extract(pdf), pageText = content.split('\f').filter(value => value.trim());
  assert.ok(pages(pdf) > 10 && pages(pdf) < 60); assert.equal(pageText.length, pages(pdf));
  for (let i = 0; i < 90; i++) assert.equal((content.match(new RegExp(`ROW${String(i).padStart(3, '0')}\\b`, 'g')) ?? []).length, 1, `missing or duplicate row ${i}`);
  for (const page of pageText) { assert.match(page, /KÖRJOURNAL/); assert.match(page, /Sida \d+ av \d+/); if (/ROW\d+/.test(page)) assert.match(page, /Datum \/ tid/); }
  const boxes = await extract(pdf, true);
  for (const word of boxes.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/g)) assert.ok(Number(word[1]) >= 28 && Number(word[3]) < 568 && Number(word[4]) < 840, `content outside A4: ${word[0]}`);
});
