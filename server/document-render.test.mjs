import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderPdf } from './documents/render.mjs';

const party = { name: 'JEROC Återvinning AB', number: '559123-4567', vat: 'SE559123456701', address: 'Ängsvägen 19', postalCode: '761 41', city: 'Norrtälje' };
const sample = () => ({
  type: 'settlement', status: 'final', id: 'AV-2026-00128', version: 1,
  issuedAt: '2026-10-10T09:00:00Z', receivedAt: '2026-10-09T12:00:00Z', sourceId: 'INV-2026-00456', site: 'Norrtälje', reference: 'Hasse / Täbyprojektet',
  company: party, customer: { ...party, name: 'Hasses Rör AB', address: 'Verkstadsvägen 7', postalCode: '183 65', city: 'Täby' },
  rows: [
    ['Koppar klass 1', 182, 64], ['Mässing', 96, 38], ['Järnskrot', 1240, 1.85], ['Aluminium', 420, 16], ['Rostfritt', 310, 12.5],
    ['Kabel, koppar', 85, 48], ['Blandmetall', 260, 4.5], ['Zink', 140, 9.5], ['Bly', 110, 11.2], ['Elmotorer', 190, 7.8],
  ].map(([name, weight, price]) => ({ name, weight, price, amount: weight * price })),
  totalWeight: 3033, materialTotal: 37479, adjustment: -150, gross: 37329, settlementTotal: 37329, offset: 500, net: 36829,
  offsetReference: 'Rättelse R-2026-00017 · viktkort INV-2026-00412',
  approval: { method: 'Godkänt på plats', person: 'Hasse Nilsson', at: '2026-10-09T12:20:00Z', verifiedBy: 'Anna Berg', version: 1 },
  attest: { name: 'Sofia Lundin', at: '2026-10-09T12:32:00Z' },
  payment: { method: 'bank', maskedAccount: 'Swedbank · ***4567', account: 'SENSITIVE-FULL-ACCOUNT', recipient: 'Hasses Rör AB', plannedAt: '2026-10-12' },
  tax: { mode: 'reverse' }, selfBilling: { agreed: true, number: 'HR-2026-001' },
});
const pages = buffer => (buffer.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
let canExtract = true;
try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); } catch { canExtract = false; }
async function extracted(buffer, bbox = false) {
  const dir = await mkdtemp(join(tmpdir(), 'jeroc-document-render-'));
  try {
    const path = join(dir, 'document.pdf'); await writeFile(path, buffer);
    return execFileSync('pdftotext', [bbox ? '-bbox-layout' : '-layout', path, '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('renders a native A4 PDF with ten material rows on one page', async () => {
  const pdf = await renderPdf(sample());
  assert.ok(Buffer.isBuffer(pdf)); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pages(pdf), 1); assert.ok(pdf.length > 10000);
  assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 595\.28 841\.89\]/);
});
test('rejects unsupported document types', async () => {
  await assert.rejects(renderPdf({ type: 'unknown' }), /Dokumenttypen/);
});
test('keeps Swedish text, real totals and masked bank details in the settlement', { skip: !canExtract }, async () => {
  const text = await extracted(await renderPdf(sample()));
  for (const expected of ['Återvinning', 'Ängsvägen', 'Norrtälje', 'Mässing', 'Rättelse', '3 033', '37 479,00', '37 329,00', '36 829,00', 'HR-2026-001', 'Hasse Nilsson', 'Sofia Lundin', '***4567']) assert.ok(text.includes(expected), expected);
  assert.match(text, /Omvänd betalningsskyldighet/); assert.doesNotMatch(text, /0\s*%|SENSITIVE-FULL-ACCOUNT/);
  const boxes = await extracted(await renderPdf(sample()), true);
  for (const word of boxes.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/g)) {
    assert.ok(Number(word[1]) >= 28 && Number(word[3]) <= 567, `word beyond horizontal margin: ${word[0]}`);
    assert.ok(Number(word[2]) >= 28 && Number(word[4]) < 840, `word beyond page: ${word[0]}`);
  }
});
test('preliminary and mismatched versions never claim customer approval, attest or issued self-invoice', { skip: !canExtract }, async () => {
  const prelim = { ...sample(), status: 'preliminary' };
  const text = await extracted(await renderPdf(prelim));
  assert.match(text, /PRELIMINÄR/); assert.match(text, /Inväntar godkännande/);
  assert.doesNotMatch(text, /Hasse Nilsson|Sofia Lundin|HR-2026-001|Attesterat/);
  const stale = sample(); stale.approval.version = 0;
  assert.doesNotMatch(await extracted(await renderPdf(stale)), /Hasse Nilsson/);
  const withoutAgreement = { ...sample(), selfBilling: { agreed: false }, tax: { mode: 'unverified' } };
  const unverified = await extracted(await renderPdf(withoutAgreement));
  assert.doesNotMatch(unverified, /HR-2026-001|Omvänd betalningsskyldighet|0\s*%/);
  assert.match(unverified, /Momsbehandling ej verifierad/);
});
test('manual ID checks show the customer and checking employee without inventing a seller signer', { skip: !canExtract }, async () => {
  for (const method of ['staff_checked_id_demo', 'manual_id_demo']) {
    const s = sample();
    s.approval = { ...s.approval, method, person: 'Anna Berg', verifiedBy: 'Anna Berg' };
    const pdf = await renderPdf(s), text = await extracted(pdf);
    assert.equal(pages(pdf), 1);
    assert.match(text, /Kundgodkännande/);
    assert.match(text, /Kund: Hasses Rör AB/);
    assert.match(text, /Legitimation kontrollerad på plats · demo/);
    assert.match(text, /Kontrollerat av: Anna Berg/);
    assert.doesNotMatch(text, /staff_checked_id_demo|manual_id_demo|Säljarens godkännande|Hasse Nilsson/);
    assert.equal((text.match(/Anna Berg/g) ?? []).length, 1);
  }
});
test('transport document keeps sender, carrier and receiver but omits money and bank details', { skip: !canExtract }, async () => {
  const s = { ...sample(), type: 'transport', status: 'draft', sender: party, receiver: { ...party, name: 'Nordmetall Återvinning AB' }, carrier: { ...party, name: 'Roslagens Transport AB' }, rows: [{ name: 'Blybatterier', weight: 980, price: 99, amount: 97020, wasteCode: '16 06 01*' }], totalWeight: 980, origin: 'Kundverkstaden 3', transport: { direction: 'pickup', driver: 'Oskar Lind', registration: 'ABC123', requestedAt: '2026-10-12T08:00:00Z', handling: 'Skydda mot läckage och kortslutning.', signatures: [] } };
  const text = await extracted(await renderPdf(s));
  for (const expected of ['TRANSPORTDOKUMENT', 'UTKAST', 'Upphämtning', 'Nordmetall', 'Roslagens Transport', 'Oskar Lind', 'ABC123', '16 06 01*', '980', 'Inväntar underskrift']) assert.ok(text.includes(expected), expected);
  assert.doesNotMatch(text, /kr\/kg|36 829|37 329|97020|97 020|Swedbank|\*\*\*4567|Kundsaldo|Sofia Lundin|Hasse Nilsson/);
});
test('hundreds of rows and oversized unbroken descriptions wrap across A4 pages without dropping rows', { skip: !canExtract }, async () => {
  const s = sample(); s.rows = Array.from({ length: 300 }, (_, i) => ({ name: `RAD-${String(i).padStart(3, '0')} Material från återvinningen ${i === 97 ? 'mycketlångtmaterial'.repeat(220) : ''}`, weight: i + 1, price: 1, amount: i + 1 }));
  const pdf = await renderPdf(s), text = await extracted(pdf), pageText = text.split('\f').filter(part => part.trim());
  assert.ok(pages(pdf) > 8 && pages(pdf) < 30, `unreasonable page count ${pages(pdf)}`);
  assert.equal(pageText.length, pages(pdf));
  for (let i = 0; i < 300; i++) assert.equal((text.match(new RegExp(`RAD-${String(i).padStart(3, '0')}\\b`, 'g')) ?? []).length, 1, `lost or duplicated row ${i}`);
  for (const part of pageText) {
    assert.match(part, /DEMO/); assert.match(part, /Sida \d+ av \d+/);
    if (/RAD-/.test(part)) assert.match(part, /Artikel \/ material/);
    assert.ok(/RAD-|mycketlångtmaterial|Avräkning|Momsbehandling|Godkännande|Kundgodkännande/.test(part), 'empty continuation page');
  }
  const boxes = await extracted(pdf, true);
  for (const word of boxes.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/g)) assert.ok(Number(word[3]) <= 567 && Number(word[4]) < 840, 'paginated content exceeds A4');
});
