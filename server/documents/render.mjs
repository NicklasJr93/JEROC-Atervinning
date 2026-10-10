import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const logo = fileURLToPath(new URL('../../public/images/jeroc-logo-v2.png', import.meta.url));
const regularFont = fileURLToPath(new URL('./fonts/DejaVuSans.ttf', import.meta.url));
const boldFont = fileURLToPath(new URL('./fonts/DejaVuSans-Bold.ttf', import.meta.url));
const C = { navy: '#052352', blue: '#115C93', green: '#177C43', text: '#244567', muted: '#6382A4', line: '#D5E4F2', light: '#F4F9FF', buyer: '#EDF7FF', seller: '#EDF8F0', amber: '#9B6B22' };
const clean = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').replace(/\r\n?/g, '\n').normalize('NFC');
const show = (value, fallback = 'Ej angivet') => clean(value).trim() || fallback;
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const money = value => num(value).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replaceAll('\u00a0', ' ');
const kilos = value => num(value).toLocaleString('sv-SE', { maximumFractionDigits: 3 }).replaceAll('\u00a0', ' ');
function date(value, withTime = false) {
  if (!value) return 'Ej angivet';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return show(value);
  return parsed.toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
}
function partyLines(party = {}) {
  return [
    show(party.name),
    [party.number ? `Org-/personnr: ${clean(party.number)}` : null, party.customerNumber ? `Kundnr: ${clean(party.customerNumber)}` : null].filter(Boolean).join(' · '),
    party.vat ? `Momsreg.nr: ${clean(party.vat)}` : null,
    [show(party.address, 'Adress saknas'), [party.postalCode, party.city].filter(Boolean).map(clean).join(' ')].filter(Boolean).join(', '),
  ].filter(Boolean);
}

/** Native A4 rendering of an already authorised, frozen business snapshot. No network access. */
export async function renderPdf(snapshot) {
  if (!snapshot || !['settlement', 'transport', 'receipt'].includes(snapshot.type)) throw new TypeError('Dokumenttypen stöds inte.');
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, compress: true, info: { Title: `${snapshot.type === 'transport' ? 'Transportdokument' : snapshot.type === 'receipt' ? 'Utbetalningskvitto' : 'Avräkningsnota'} ${show(snapshot.id)}`, Author: 'JEROC Återvinning', Subject: 'Demounderlag', Creator: 'JEROC PDF-motor' } });
  doc.registerFont('JEROC-Regular', regularFont);
  doc.registerFont('JEROC-Bold', boldFont);
  const output = new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.once('error', reject);
    doc.once('end', () => resolve(Buffer.concat(chunks)));
  });
  const W = doc.page.width, H = doc.page.height, M = 29, WIDTH = W - M * 2, BOTTOM = H - 55;
  let y = M;
  const transport = snapshot.type === 'transport';
  const receipt = snapshot.type === 'receipt';
  const site = snapshot.site?.name ?? snapshot.site;
  const final = snapshot.status === 'final';
  const title = transport ? 'TRANSPORTDOKUMENT' : receipt ? 'UTBETALNINGSKVITTO' : 'AVRÄKNINGSNOTA';
  const state = snapshot.status === 'reviewed' ? 'KUNDGODKÄND · EJ ATTESTERAD' : final ? 'UTFÄRDAD · DEMO' : transport ? 'UTKAST · DEMO' : 'PRELIMINÄR · EJ BOKFÖRD';
  const font = (size, bold = false, color = C.text) => doc.font(bold ? 'JEROC-Bold' : 'JEROC-Regular').fontSize(size).fillColor(color);
  // Split ourselves instead of relying on PDFKit's implicit text/page flow. A long
  // unbroken address or material name must never escape its column or lose text.
  function lines(value, width, size = 9, bold = false) {
    font(size, bold);
    const result = [];
    for (const paragraph of clean(value).split('\n')) {
      if (!paragraph.trim()) { result.push(''); continue; }
      let current = '';
      for (const word of paragraph.trim().split(/\s+/)) {
        if (doc.widthOfString(current ? `${current} ${word}` : word) <= width) { current = current ? `${current} ${word}` : word; continue; }
        if (current) { result.push(current); current = ''; }
        if (doc.widthOfString(word) <= width) { current = word; continue; }
        for (const character of word) {
          if (current && doc.widthOfString(current + character) > width) { result.push(current); current = ''; }
          current += character;
        }
      }
      if (current) result.push(current);
    }
    return result.length ? result : [''];
  }
  function text(value, x, top, width, size = 9, bold = false, color = C.text, align = 'left') {
    const wrapped = lines(value, width, size, bold);
    for (let i = 0; i < wrapped.length; i++) {
      font(size, bold, color).text(wrapped[i], x, top + i * (size + 3), { width, lineBreak: false, align });
    }
    return wrapped.length * (size + 3);
  }
  const box = (x, top, width, height, fill = C.light) => doc.save().roundedRect(x, top, width, height, 5).fill(fill).restore();
  function header(continued = false) {
    const top = M;
    if (continued) {
      text(title, M, top, WIDTH * .62, 13, true, C.navy);
      text('Fortsättning', M + WIDTH * .65, top, WIDTH * .35, 9, false, C.muted, 'right');
      doc.moveTo(M, top + 23).lineTo(W - M, top + 23).strokeColor(C.line).lineWidth(.7).stroke();
      y = top + 36;
      return;
    }
    if (existsSync(logo)) doc.image(logo, M, top, { fit: [98, 45], align: 'left', valign: 'center' });
    else text('JEROC', M, top + 8, 96, 21, true, C.blue);
    const tx = M + 113;
    text(title, tx, top + 4, WIDTH - 113, transport ? 20 : 21, true, C.navy);
    doc.rect(tx, top + 33, 37, 2.5).fill(C.green);
    text(transport ? 'Transportunderlag · inga betalningsuppgifter' : receipt ? 'Registrerad demoutbetalning · belopp i SEK' : 'Inköp av skrot · belopp i SEK', tx, top + 38, WIDTH - 113, 8, false, C.muted);
    y = top + 50;
  }
  function nextPage() { doc.addPage({ size: 'A4', margin: 0 }); header(true); }
  function need(height) { if (y + height > BOTTOM && y > M + 37) nextPage(); }
  // Each card is made of measured lines; oversized cards continue across pages
  // with their title repeated. Paired cards keep a shared height and baseline.
  function cards(items, columns = 2, colors = [C.buyer, C.seller]) {
    const gap = 9, width = (WIDTH - gap * (columns - 1)) / columns, inset = 11;
    const queue = items.map(item => item.body.flatMap((entry, index) => {
      const object = typeof entry === 'string' ? { text: entry, bold: index === 0 } : entry;
      const size = object.size ?? 8;
      return lines(show(object.text, '—'), width - inset * 2, size, object.bold).map(line => ({ text: line, size, bold: object.bold, color: object.color ?? C.text, height: size + 3 }));
    }));
    while (queue.some(q => q.length)) {
      const naturalHeight = Math.max(...queue.map(q => q.reduce((sum, line) => sum + line.height, 0))) + 31;
      if (naturalHeight <= BOTTOM - (M + 36)) need(naturalHeight);
      else need(80);
      const available = BOTTOM - y - 31;
      const portions = queue.map(q => {
        let used = 0, count = 0;
        while (count < q.length && used + q[count].height <= available) used += q[count++].height;
        return q.splice(0, count);
      });
      const height = Math.max(...portions.map(part => part.reduce((sum, line) => sum + line.height, 0))) + 31;
      if (!portions.some(part => part.length)) { nextPage(); continue; }
      portions.forEach((part, index) => {
        const x = M + index * (width + gap);
        box(x, y, width, height, colors[index] ?? C.light);
        text(items[index].title, x + inset, y + 8, width - inset * 2, 9, true, index === 1 ? C.green : C.navy);
        let pos = y + 23;
        for (const line of part) { text(line.text, x + inset, pos, width - inset * 2, line.size, line.bold, line.color); pos += line.height; }
      });
      y += height + 8;
      if (queue.some(q => q.length)) nextPage();
    }
  }
  function paragraph(value, { title: heading, size = 9, color = C.muted } = {}) {
    const wrapped = lines(value, WIDTH - 22, size);
    while (wrapped.length) {
      need(50);
      const capacity = Math.max(1, Math.floor((BOTTOM - y - (heading ? 30 : 16)) / (size + 3)));
      const part = wrapped.splice(0, capacity), height = part.length * (size + 3) + (heading ? 30 : 16);
      box(M, y, WIDTH, height);
      if (heading) text(heading, M + 11, y + 9, WIDTH - 22, 10, true, C.navy);
      let pos = y + (heading ? 24 : 8);
      for (const line of part) { text(line, M + 11, pos, WIDTH - 22, size, false, color); pos += size + 3; }
      y += height + 8;
      if (wrapped.length) nextPage();
    }
  }
  function facts(entries) {
    const width = WIDTH / 3;
    for (let i = 0; i < entries.length; i += 3) {
      const row = entries.slice(i, i + 3);
      const height = Math.max(...row.map(([, value]) => lines(show(value), width - 20, 8.5, true).length * 11.5)) + 24;
      need(height);
      box(M, y, WIDTH, height, C.light);
      row.forEach(([label, value], index) => {
        const x = M + width * index + 10;
        text(label, x, y + 7, width - 20, 7, false, C.muted);
        text(show(value), x, y + 19, width - 20, 8.5, true, C.navy);
      });
      y += height + 3;
    }
    y += 4;
  }
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  const totalWeight = snapshot.totalWeight ?? rows.reduce((sum, row) => sum + num(row.weight), 0);
  const materialTotal = snapshot.materialTotal ?? rows.reduce((sum, row) => sum + (row.amount == null ? num(row.weight) * num(row.price) : num(row.amount)), 0);
  const gross = snapshot.settlementTotal ?? snapshot.gross ?? materialTotal + num(snapshot.adjustment);
  function table() {
    const widths = transport ? [WIDTH * .48, WIDTH * .22, WIDTH * .19, WIDTH * .11] : [WIDTH * .43, WIDTH * .17, WIDTH * .18, WIDTH * .22];
    const headings = transport ? ['Artikel / avfallsbeskrivning', 'Avfallskod', 'Vikt', 'Enhet'] : ['Artikel / material', 'Vikt · kg', 'Pris · kr/kg', 'Belopp · kr'];
    const positions = widths.map((_, index) => M + widths.slice(0, index).reduce((sum, value) => sum + value, 0));
    function tableHead() {
      doc.rect(M, y, WIDTH, 23).fill(C.blue);
      headings.forEach((value, index) => text(value, positions[index] + 9, y + 7, widths[index] - 18, 7.5, true, '#FFFFFF', index === 0 || transport && index === 1 ? 'left' : 'right'));
      y += 23;
    }
    need(56); tableHead();
    for (const [rowIndex, row] of (rows.length ? rows : [{ name: 'Materialuppgifter saknas' }]).entries()) {
      const values = transport
        ? [show(row.name), show(row.wasteCode, 'Ej klassificerat'), row.weight == null ? 'Ej angivet' : kilos(row.weight), 'kg']
        : [show(row.name), row.weight == null ? '—' : kilos(row.weight), row.price == null ? '—' : money(row.price), row.amount == null && row.price == null ? '—' : money(row.amount ?? num(row.price) * num(row.weight))];
      const cells = values.map((value, index) => lines(value, widths[index] - 18, 8.5, index === 0));
      let remaining = Math.max(...cells.map(cell => cell.length));
      const natural = remaining * 11.5 + 9;
      if (natural < BOTTOM - (M + 36) - 25 && y + natural > BOTTOM) { nextPage(); tableHead(); }
      while (remaining > 0) {
        if (y + 20.5 > BOTTOM) { nextPage(); tableHead(); }
        const count = Math.min(remaining, Math.max(1, Math.floor((BOTTOM - y - 9) / 11.5)));
        const height = count * 11.5 + 9;
        doc.rect(M, y, WIDTH, height).fill(rowIndex % 2 ? '#F5FAFF' : '#FFFFFF');
        cells.forEach((cell, column) => {
          const portion = cell.splice(0, count);
          portion.forEach((line, lineIndex) => text(line, positions[column] + 9, y + 4.5 + lineIndex * 11.5, widths[column] - 18, 8.5, column === 0, C.text, column === 0 || transport && column === 1 ? 'left' : 'right'));
        });
        doc.moveTo(M, y + height).lineTo(W - M, y + height).lineWidth(.5).strokeColor(C.line).stroke();
        y += height; remaining -= count;
        if (remaining > 0) { nextPage(); tableHead(); }
      }
    }
    need(31);
    box(M, y, WIDTH, 25, C.buyer);
    text(transport ? (final ? 'Total lastvikt' : 'Planerad lastvikt') : 'Summa material', M + 10, y + 7, WIDTH * .4, 8.5, true, C.navy);
    text(`${kilos(totalWeight)} kg${transport ? '' : `     ${money(materialTotal)} kr`}`, M + WIDTH * .42, y + 7, WIDTH * .58 - 10, 8.5, true, C.navy, 'right');
    y += 33;
  }
  function approvalCards() {
    const approval = snapshot.approval;
    const matching = approval?.at && approval.version === snapshot.version;
    const approved = matching && approval.method && approval.person && ['reviewed', 'final'].includes(snapshot.status);
    const manualIdCheck = ['staff_checked_id_demo', 'manual_id_demo'].includes(approval?.method);
    const approvalBody = approved
      ? manualIdCheck
        ? [`Kund: ${show(snapshot.customer?.name)}`, 'Legitimation kontrollerad på plats · demo', `${date(approval.at, true)} · Kontrollerat av: ${show(approval.verifiedBy ?? approval.person)}`, `Dokumentversion ${snapshot.version}`]
        : [show(approval.person), `${show(approval.method)} · ${date(approval.at, true)}`, `Registrerat av: ${show(approval.verifiedBy)}`, `Dokumentversion ${snapshot.version}`]
      : ['Inväntar godkännande', 'Ingen registrerad accept av denna version.'];
    const attest = snapshot.attest;
    cards([
      { title: 'Kundgodkännande', body: approvalBody },
      { title: 'JEROC:s interna attest', body: final && attest?.at ? [show(attest.name), `Attesterat · ${date(attest.at, true)}`, `Dokumentversion ${snapshot.version}`] : ['Inväntar attest', 'Underlaget granskas före utfärdandet.'] },
    ], 2, ['#F7FAFE', '#F7FAFE']);
  }
  function financialSummary() {
    const payment = snapshot.payment ?? {};
    const paymentLabel = payment.label ?? ({ bank: 'Bankkonto', swish: 'Swish', cash: 'Kontant', balance: 'Spara på saldo' }[payment.method]);
    const tax = snapshot.tax ?? {};
    const taxLabel = tax.mode === 'reverse' ? 'Omvänd betalningsskyldighet' : ['none', 'private'].includes(tax.mode) ? 'Ingen moms debiteras' : 'Momsbehandling ej verifierad';
    const actualPaid = receipt && payment.paidAt;
    const paymentBody = [
      { text: `Betalningssätt: ${show(paymentLabel)}`, bold: true },
      `Mottagare: ${show(payment.recipient ?? snapshot.customer?.name)}`,
      payment.maskedAccount ? `Konto / nummer: ${clean(payment.maskedAccount)}` : null,
      payment.plannedAt ? `Planerat datum: ${date(payment.plannedAt)}` : null,
      actualPaid ? `Registrerat betald: ${date(payment.paidAt, true)}` : payment.method === 'balance' ? 'Status: sparas på kundsaldo, ingen utbetalning.' : 'Status: inväntar utbetalning.',
      receipt && payment.reference ? `Betalningsreferens: ${clean(payment.reference)}` : null,
      { text: receipt ? 'Demoregistrering; ingen banktransaktion skickad.' : 'Inköpsunderlag, inte kvitto på genomförd betalning.', size: 8, color: C.muted },
    ].filter(Boolean);
    const totals = [
      { text: `Materialbelopp: ${money(materialTotal)} kr`, bold: false },
      num(snapshot.adjustment) ? `Prisjustering: ${money(snapshot.adjustment)} kr` : null,
      { text: `Avräkningsbelopp: ${money(gross)} kr`, bold: true },
      { text: taxLabel, size: 8, color: tax.mode === 'unverified' ? C.amber : C.muted },
      `Kvittning mot kundsaldo: ${money(-num(snapshot.offset))} kr`,
      snapshot.offsetReference ? { text: clean(snapshot.offsetReference), size: 8, color: C.muted } : null,
      { text: `${receipt ? 'Registrerad utbetalning' : payment.method === 'balance' ? 'Sparas på saldo' : final ? 'Att utbetala' : 'Beräknat att utbetala'}: ${money(snapshot.net ?? gross - num(snapshot.offset))} SEK`, bold: true, size: 11, color: C.green },
    ].filter(Boolean);
    cards([{ title: 'Utbetalningsuppgifter', body: paymentBody }, { title: 'Avräkning & kundsaldo', body: totals }]);
    const note = tax.mode === 'reverse' ? 'Omvänd betalningsskyldighet. Köparen redovisar moms på inköpet enligt tillämpliga regler.' : ['none', 'private'].includes(tax.mode) ? show(tax.label, 'Privatinköp. Ingen moms debiteras av säljaren.') : 'Momsbehandling har inte verifierats. Detta underlag anger inte någon momssats eller något momsbelopp.';
    paragraph(`${note}${snapshot.selfBilling?.agreed ? ' Självfaktureringsavtal finns registrerat. Utfärdad självfaktura upprättas i säljarens namn och för säljarens räkning.' : ' Något självfaktureringsavtal har inte registrerats.'}`, { size: 8 });
  }
  function transportDetails() {
    const t = snapshot.transport ?? {};
    cards([{ title: 'Transportör', body: partyLines(snapshot.carrier) }], 1, [C.buyer]);
    const fields = [['Förare', t.driver], ['Fordon / registrering', t.registration], [final && t.startAt ? 'Registrerad avfärd' : 'Planerad avfärd', date(t.startAt ?? t.requestedAt, true)]];
    if (t.requestedAt && t.startAt) fields.push(['Önskad hämtning / avfärd', date(t.requestedAt, true)]);
    facts(fields);
  }
  function signatures() {
    const input = snapshot.transport?.signatures;
    const signatures = Array.isArray(input) ? input : [];
    const roles = [['sender', 'Lämnare / företrädare'], ['carrier', 'Transportör / förare'], ['receiver', 'Mottagare / företrädare']];
    const chosen = roles.slice(0, signatures.some(item => item.role === 'receiver') ? 3 : 2);
    for (let i = 0; i < chosen.length; i += 2) {
      cards(chosen.slice(i, i + 2).map(([role, label]) => {
        const signature = signatures.find(item => item.role === role && item.at && item.method && (item.person || item.name) && item.version === snapshot.version);
        return { title: label, body: signature ? [show(signature.person ?? signature.name), `${show(signature.method)} · ${date(signature.at, true)}`, `Dokumentversion ${signature.version}`] : ['Inväntar underskrift', 'Ingen underskrift registrerad för denna version.'] };
      }), Math.min(2, chosen.length - i), ['#F7FAFE', '#F7FAFE']);
    }
  }
  function footers() {
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const top = H - 43;
      doc.moveTo(M, top).lineTo(W - M, top).lineWidth(.6).strokeColor(C.line).stroke();
      const stamp = `${show(snapshot.id)} · Version ${snapshot.version ?? '—'}`;
      // Footer strings have a bounded line box regardless of lengthy external IDs.
      const stampLines = lines(stamp, WIDTH - 100, 7).slice(0, 1);
      text(stampLines.join(''), M, top + 8, WIDTH - 100, 7, false, C.muted);
      text(`Sida ${i + 1} av ${range.count}`, W - M - 98, top + 8, 98, 7, false, C.muted, 'right');
      text('DEMO · Inga betalningar, bokföringsposter eller myndighetsrapporter har skickats.', M, top + 23, WIDTH, 7, false, C.muted);
    }
  }
  try {
    header();
    const fields = transport
      ? [['Transportdokument', snapshot.id], ['Arbetsorder / underlag', snapshot.sourceId], ['Dokumentdatum', date(snapshot.issuedAt)], ['Transporttyp', snapshot.transport?.direction === 'pickup' ? 'Upphämtning' : 'Utleverans'], ['Anläggning', site], ['Status', state]]
      : [['Avräkningsreferens', snapshot.id], [snapshot.selfBilling?.agreed ? 'Självfakturanummer' : 'Dokumentversion', snapshot.selfBilling?.agreed ? final && snapshot.selfBilling.number ? snapshot.selfBilling.number : 'Utfärdas efter attest' : `Version ${snapshot.version}`], ['Invägningsunderlag', snapshot.sourceId], [final ? 'Utfärdandedatum' : 'Förhandsvisningsdatum', date(snapshot.issuedAt)], ['Mottagningsdatum', date(snapshot.receivedAt ?? snapshot.deliveredAt)], ['Status', state]];
    facts(fields);
    if (transport) {
      cards([{ title: 'Lämnare · från plats', body: partyLines(snapshot.sender) }, { title: 'Mottagare · till plats', body: partyLines(snapshot.receiver) }]);
      transportDetails();
    } else cards([{ title: 'Köpare', body: partyLines(snapshot.company) }, { title: 'Säljare', body: partyLines(snapshot.customer) }]);
    facts([['Referens', snapshot.reference], [transport ? 'Ursprungsplats' : 'Mottagande anläggning', transport ? snapshot.origin : site], ['Dokumentversion', `Version ${snapshot.version}`]]);
    table();
    if (transport) {
      if (snapshot.transport?.handling) paragraph(clean(snapshot.transport.handling), { title: 'Hanteringsinstruktioner' });
      signatures();
      paragraph(final ? 'Registrerade transportuppgifter framgår av denna version. Eventuell avfallsrapportering och ADR-bedömning hanteras separat.' : 'Utkast inför transport. Vikt, transportuppgifter och underskrifter kontrolleras före avfärd. Ingen avfallsrapportering har skickats.', { size: 8 });
    } else {
      financialSummary();
      if (!receipt) approvalCards();
    }
    footers();
    doc.end();
  } catch (error) {
    doc.destroy(error);
  }
  return output;
}
