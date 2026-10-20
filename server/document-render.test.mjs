import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderPdf } from './documents/render.mjs';
import sharp from 'sharp';

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
test('new company PDFs show their own name and omit the JEROC logo while legacy branding stays intact', { skip: !canExtract }, async () => {
  for (const company of [{ id: 'company-a', name: 'Återbruk A AB' }, { id: 'company-b', name: 'Metall B AB' }]) {
    const s = sample();
    s.company = { ...s.company, ...company };
    const pdf = await renderPdf(s), text = await extracted(pdf);
    assert.ok(text.includes(company.name));
    assert.match(text, /Intern attest/);
    assert.doesNotMatch(text, /JEROC/);
    assert.doesNotMatch(pdf.toString('latin1'), /\/Subtype \/Image/);
  }
  const legacy = await renderPdf(sample());
  assert.match(await extracted(legacy), /JEROC:s interna attest/);
  assert.match(legacy.toString('latin1'), /\/Subtype \/Image/);
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
  for (const method of ['staff_checked_physical_id', 'staff_checked_id_demo', 'manual_id_demo']) {
    const s = sample();
    s.approval = { ...s.approval, method, person: 'Anna Berg', verifiedBy: 'Anna Berg' };
    const pdf = await renderPdf(s), text = await extracted(pdf);
    assert.equal(pages(pdf), 1);
    assert.match(text, /Kundgodkännande/);
    assert.match(text, /Kund: Hasses Rör AB/);
    assert.match(text, /Legitimation kontrollerad på plats/);
    if (method === 'staff_checked_physical_id') assert.doesNotMatch(text, /Legitimation kontrollerad på plats · demo/);
    else assert.match(text, /Legitimation kontrollerad på plats · demo/);
    assert.match(text, /Kontrollerat av: Anna Berg/);
    assert.doesNotMatch(text, /staff_checked_physical_id|staff_checked_id_demo|manual_id_demo|Säljarens godkännande|Hasse Nilsson/);
    assert.equal((text.match(/Anna Berg/g) ?? []).length, 1);
  }
});
test('payment PDF revision clearly replaces the earlier PDF while retaining settlement number, dates, tax and totals', { skip: !canExtract }, async () => {
  const s = sample();
  s.payment = { method: 'swish', label: 'Swish', recipient: 'Hasses Rör AB', maskedAccount: '•••• 1132' };
  s.paymentRevision = { version: 2, mode: 'mss', simulation: true, actor: { name: 'Anna Berg' }, at: '2026-10-13T08:45:00Z',
    reason: 'Kunden önskar ändrat betalningssätt.', originalDocumentId: 'original-uuid', replacesDocumentId: 'original-uuid' };
  const pdf = await renderPdf(s), text = await extracted(pdf), boxes = await extracted(pdf, true);
  assert.match(text, /Uppdaterade betalningsuppgifter/);
  assert.match(text, /ersätter tidigare PDF-version/);
  assert.match(text, /PDF-version 2/);
  for (const expected of ['AV-2026-00128', 'HR-2026-001', '37 329,00', '36 829,00', 'Anna Berg', '2026-10-10', '2026-10-09', 'Swish', '1132', 'SWISH MSS', 'Omvänd betalningsskyldighet'])
    assert.ok(text.includes(expected), expected);
  assert.doesNotMatch(text, /Registrerat betald|SENSITIVE-FULL-ACCOUNT/);
  assert.ok(pages(pdf) <= 2);
  for (const word of boxes.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/g))
    assert.ok(Number(word[1]) >= 28 && Number(word[3]) <= 567 && Number(word[4]) < 840, 'revision content exceeds A4');
});
test('confirmed MSS PDF replaces waiting status with masked Swish confirmation, actual provider date and reference', { skip: !canExtract }, async () => {
  const s = sample();
  s.payment = { method: 'swish', label: 'Swish', recipient: 'Testkunden', maskedAccount: '•••• 1132' };
  s.customer = { ...s.customer, name: 'Testkunden', number: '' };
  s.paymentConfirmation = { version: 3, mode: 'mss', simulation: true, datePaid: '2026-10-13T08:47:00Z',
    actualPaidAt: '2026-10-13T08:47:00Z', verifiedAt: '2026-10-13T08:47:01Z', amountCents: 3682900,
    maskedPhone: '•••• 1132', maskedPersonalNumber: '•••• 6828', providerRef: 'SWISH-MSS-REFERENCE-001' };
  const pdf = await renderPdf(s), text = await extracted(pdf), boxes = await extracted(pdf, true);
  for (const expected of ['Betalningsbekräftelse', 'ersätter tidigare PDF-version', 'PDF-version 3', 'Testutbetalning bekräftad',
    'Swish MSS', 'Swish-nummer', '1132', 'Personnummer', '6828', '2026-10-13', '10:47', 'SWISH-MSS-REFERENCE-001',
    'Inga riktiga pengar', '36 829,00', '37 329,00', 'AV-2026-00128', 'Omvänd betalningsskyldighet'])
    assert.ok(text.includes(expected), expected);
  assert.doesNotMatch(text, /inväntar utbetalning|Att utbetala:|197709306828|46711111132|SENSITIVE-FULL-ACCOUNT|PDF bekräftar inte genomförd/);
  assert.ok(pages(pdf) <= 2);
  for (const word of boxes.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/g))
    assert.ok(Number(word[1]) >= 28 && Number(word[3]) <= 567 && Number(word[4]) < 840, 'confirmation content exceeds A4');
});
test('bank sandbox confirmation shows its own provider and masked giro without claiming a Swish result', { skip: !canExtract }, async () => {
  const s = sample();
  s.payment = { method: 'bank', bankType: 'bankgiro', label: 'Bankgiro', recipient: 'Hasses Rör AB', maskedAccount: '•••• 4566' };
  s.paymentConfirmation = { version: 2, mode: 'openpayments_sandbox', simulation: true, providerName: 'Open Payments sandbox',
    label: 'Testutbetalning bekräftad · Open Payments sandbox', datePaid: '2026-10-13T08:47:00Z',
    verifiedAt: '2026-10-13T08:47:01Z', amountCents: 3682900, providerRef: 'BANK-SANDBOX-REFERENCE-001' };
  const text = await extracted(await renderPdf(s));
  for (const expected of ['Open Payments sandbox', 'Bankgiro', '4566', 'BANK-SANDBOX-REFERENCE-001', 'Inga riktiga pengar', '36 829,00']) assert.ok(text.includes(expected), expected);
  assert.doesNotMatch(text, /Swish|SWISH|inväntar utbetalning|SENSITIVE-FULL-ACCOUNT/);
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


test('immutable uploaded company logo and confirmed contact/footer details render inside A4 without legacy branding', { skip: !canExtract }, async () => {
  const logoBytes = await sharp({ create: { width: 160, height: 50, channels: 4, background: '#167b5b' } }).png().toBuffer();
  const source = sample();
  source.company = { ...party, id: 'company-branding', name: 'Profilbolaget AB',
    logoId: '00000000-0000-4000-8000-000000000001', phone: '+46812345678', email: 'kontakt@example.test',
    website: 'https://example.test', footerText: 'Bekräftad dokumenttext. Tack för att du återvinner med oss.' };
  const before = structuredClone(source);
  const pdf = await renderPdf(source, { logoBytes }), text = await extracted(pdf), bbox = await extracted(pdf, true);
  assert.match(pdf.toString('latin1'), /\/Subtype \/Image/);
  for (const expected of ['Profilbolaget AB', '+46812345678', 'kontakt@example.test', 'https://example.test', 'Bekräftad dokumenttext.', 'Tack för att du återvinner med oss.'])
    assert.ok(text.includes(expected), expected);
  assert.doesNotMatch(text, /JEROC/);
  for (const word of bbox.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/g))
    assert.ok(Number(word[1]) >= 28 && Number(word[3]) <= 567 && Number(word[4]) < 840, 'branding exceeds A4 bounds');
  assert.deepEqual(source, before, 'Rendering cannot modify the frozen profile or its source.');
});

test('a frozen company logo reference cannot silently fall back to the latest or legacy logo', async () => {
  const source = sample(); source.company = { ...source.company, id: 'company-branding', logoId: '00000000-0000-4000-8000-000000000001' };
  await assert.rejects(renderPdf(source), /sparade företagsloggan/);
  await assert.rejects(renderPdf(source, { logoBytes: '/tmp/not-a-logo.png' }), /sparade företagsloggan/);
  await assert.rejects(renderPdf(source, { logoBytes: Buffer.from('<svg onload="bad()"></svg>') }), /ogiltigt format/);
});
