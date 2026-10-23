// SIE 4C journal exchange, based on SIE-Gruppen's 2025-08-06 specification.
// SIE carries a ledger, not invoice PDFs or an invoice/payroll subledger.
import { ACCOUNTS, MAX_CENTS, assert, validDate, transact, appendEntry, nextId, addActivity, requireOpenPeriod } from './core.js';
import { fiscalPeriods } from './fiscal-periods.js';

export const SIE_SPEC = 'https://sie.se/wp-content/uploads/2026/02/SIE_filformat_ver_4C_2025-08-06.pdf';
export const SIE_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, vouchers: 5000, rows: 1000 });
const accountMap = new Map(ACCOUNTS.map(account => [account.number, account]));
const closedResultMessage = 'SIE-filen innehåller en resultatbokning på konto 8999. Import av redan resultatbokförda år stöds inte ännu. Välj en export före resultatbokningen eller importera nästa års ingående balans.';
const cp437High = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const cp437 = Array.from({ length: 128 }, (_, index) => String.fromCharCode(index)).join('') + cp437High;
const bytesByCharacter = new Map([...cp437].map((character, index) => [character, index]));
const sum = values => values.reduce((total, value) => { assert(Number.isSafeInteger(value) && Number.isSafeInteger(total + value), 'SIE-beloppet är för stort.'); return total + value; }, 0);
const org = value => String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
const iso = value => { assert(/^\d{8}$/.test(value ?? ''), 'SIE-datum ska ha formen ÅÅÅÅMMDD.'); const result = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`; assert(validDate(result), 'SIE-filen innehåller ett ogiltigt datum.'); return result; };
const compactDate = value => { assert(validDate(value), 'Ogiltigt datum i SIE-exporten.'); return value.replaceAll('-', ''); };
const safe = (value, max = 500) => { assert(typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value), 'En SIE-text är ogiltig eller för lång.'); return value; };
const label = (value, max = 500) => { safe(value, max); assert(value.trim(), 'SIE-texten får inte vara tom.'); return value; };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const money = value => `${value < 0 ? '-' : ''}${Math.floor(Math.abs(value) / 100)}.${String(Math.abs(value) % 100).padStart(2, '0')}`;
const normalizeTypography = value => value.replace(/[–—‑]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replaceAll('…', '...');
const quote = value => `"${normalizeTypography(safe(String(value), 1000)).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const amount = value => {
  assert(typeof value === 'string' && /^-?\d+(?:\.\d{1,2})?$/.test(value), 'SIE-belopp måste ha punkt och högst två decimaler.');
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  assert(cents <= BigInt(MAX_CENTS), 'SIE-beloppet är större än programmets beloppsgräns.');
  return Number(cents) * (negative ? -1 : 1);
};

// Synchronous SHA-256 permits deterministic duplicate and restore checks inside
// the existing atomic, synchronous accounting transaction.
export function sieFingerprint(value) {
  const input = new TextEncoder().encode(String(value));
  const words = [], bitLength = input.length * 8;
  for (let index = 0; index < input.length; index++) words[index >>> 2] = (words[index >>> 2] ?? 0) | input[index] << (24 - index % 4 * 8);
  words[input.length >>> 2] = (words[input.length >>> 2] ?? 0) | 0x80 << (24 - input.length % 4 * 8);
  words[((input.length + 8 >>> 6) + 1) * 16 - 1] = bitLength;
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (x, n) => x >>> n | x << 32 - n;
  for (let block = 0; block < words.length; block += 16) {
    const w = Array.from({ length: 64 }, (_, i) => words[block + i] ?? 0);
    for (let i = 16; i < 64; i++) { const a = w[i - 15], b = w[i - 2]; w[i] = (w[i - 16] + (rotate(a,7)^rotate(a,18)^a>>>3) + w[i - 7] + (rotate(b,17)^rotate(b,19)^b>>>10)) | 0; }
    let [a,b,c,d,e,f,g,j] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (j + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + (e&f ^ ~e&g) + k[i] + w[i]) | 0;
      const t2 = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + (a&b ^ a&c ^ b&c)) | 0;
      j=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    [a,b,c,d,e,f,g,j].forEach((value, i) => { h[i] = (h[i] + value) | 0; });
  }
  return h.map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
}

export function encodeSiePc8(text) {
  assert(typeof text === 'string', 'SIE-text saknas.');
  const output = [];
  const substitutions = new Map([['–','-'],['—','-'],['‑','-'],['‘',"'"],['’',"'"],['“','"'],['”','"'],['…','...']]);
  for (const character of text) {
    const normalized = substitutions.get(character) ?? character;
    for (const unit of normalized) { assert(bytesByCharacter.has(unit), `Tecknet ${JSON.stringify(character)} kan inte skrivas i SIE-standardens PC8. Ändra texten före export.`); output.push(bytesByCharacter.get(unit)); }
  }
  return new Uint8Array(output);
}

export function decodeSie(input, { encoding = 'pc8' } = {}) {
  if (typeof input === 'string') { assert(input.length <= SIE_LIMITS.bytes, 'SIE-filen är för stor.'); return input.replace(/^\uFEFF/, ''); }
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  assert(bytes && bytes.byteLength > 0 && bytes.byteLength <= SIE_LIMITS.bytes, 'Välj en SIE-fil på högst 2 MB.');
  if (encoding === 'utf8') return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  assert(encoding === 'pc8', 'Välj PC8 eller uttrycklig UTF-8-import.');
  assert(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), 'Filen är UTF-8. Välj UTF-8 i stället för PC8 innan du läser den.');
  return Array.from(bytes, byte => cp437[byte]).join('');
}

function tokensFor(line) {
  const tokens = []; let index = 0;
  while (index < line.length) {
    if (/[ \t]/.test(line[index])) { index++; continue; }
    if (line[index] === '{' || line[index] === '}') { tokens.push(line[index++]); continue; }
    if (line[index] === '"') {
      index++; let value = '', closed = false;
      while (index < line.length) {
        const char = line[index++];
        if (char === '\\' && ['"', '\\'].includes(line[index])) value += line[index++];
        else if (char === '"') { closed = true; break; }
        else value += char;
      }
      assert(closed && (index === line.length || /[ \t{}]/.test(line[index])), 'SIE-filen har ett ofullständigt citerat fält.');
      safe(value, 10000); tokens.push(value); continue;
    }
    const start = index;
    while (index < line.length && !/[ \t{}]/.test(line[index])) index++;
    const value = line.slice(start, index); safe(value, 10000); tokens.push(value);
  }
  return tokens;
}
const metadataTags = new Set(['#PROSA','#FNR','#FTYP','#ADRESS','#BKOD','#KPTYP','#TAXAR','#OMFATTN','#KTYP','#ENHET','#SRU']);
const dimensionTags = new Set(['#DIM','#UNDERDIM','#OBJEKT','#OIB','#OUB']);

export function parseSie4(input, options = {}) {
  const sourceText = decodeSie(input, options).replace(/\r\n?/g, '\n');
  assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(sourceText), 'SIE-filen innehåller otillåtna kontrolltecken.');
  const parsed = { type: 4, flag: null, program: [], generated: '', companyName: '', orgNumber: '', currency: 'SEK', years: [], accounts: [], balances: [], vouchers: [], ignoredCorrections: 0, warnings: [], sourceText };
  const single = new Set(), accounts = new Set(), balances = new Set(); let current = null, waitingBrace = false;
  const lines = sourceText.split('\n');
  assert(lines.length <= 100_000, 'SIE-filen innehåller för många rader.');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim(); if (!line) continue;
    const tokens = tokensFor(line), tag = tokens[0];
    const field = n => { assert(typeof tokens[n] === 'string', `SIE-rad ${index + 1} saknar ett fält.`); return tokens[n]; };
    if (line === '{') { assert(current && waitingBrace, 'Oväntad startklammer i SIE-filen.'); waitingBrace = false; continue; }
    if (line === '}') { assert(current && !waitingBrace, 'Oväntad slutklammer i SIE-filen.'); assert(current.rows.length >= 2 && current.rows.length <= SIE_LIMITS.rows && sum(current.rows.map(row => row.amountCents)) === 0, 'En SIE-verifikation balanserar inte eller saknar rader.'); parsed.vouchers.push(current); current = null; continue; }
    if (waitingBrace) throw new Error('En SIE-verifikation saknar startklammer.');
    if (tag === '#TRANS' || tag === '#BTRANS' || tag === '#RTRANS') {
      assert(current, 'SIE-transaktion måste ligga inuti en verifikation.');
      assert(/^\d{4}$/.test(field(1)) && field(2) === '{', 'En SIE-transaktion saknar konto eller objektlista.');
      const close = tokens.indexOf('}', 3); assert(close > -1, 'En SIE-objektlista saknar slutklammer.');
      assert(close === 3, 'SIE-import av dimensioner/objekt stöds inte ännu. Inga rader har importerats.');
      const value = amount(field(close + 1)), transactionDate = tokens[close + 2] ? iso(tokens[close + 2]) : current.date;
      assert(transactionDate === current.date, 'SIE-rader med annat transaktionsdatum än verifikationen behöver delas före import.');
      const description = tokens[close + 3] ? safe(tokens[close + 3]) : '';
      if (tag !== '#TRANS') { parsed.ignoredCorrections++; continue; }
      if (tokens[close + 4] && Number(tokens[close + 4]) !== 0) parsed.warnings.push('Kvantiteter bevaras i originalfilen men förs inte över till huvudbokens beloppsrader.');
      assert(value !== 0, 'En SIE-transaktionsrad med nollbelopp ska tas bort före import.');
      current.rows.push({ account: field(1), amountCents: value, text: description }); continue;
    }
    assert(!current, 'En SIE-verifikation innehåller en okänd post i stället för transaktioner.');
    assert(!dimensionTags.has(tag), 'SIE-import av dimensioner/objekt stöds inte ännu. Välj export utan dimensioner.');
    if (tag === '#VER') {
      assert(parsed.vouchers.length < SIE_LIMITS.vouchers, 'SIE-filen innehåller fler än 5 000 verifikationer.');
      const series = safe(field(1), 50), number = safe(field(2), 50);
      assert(!number || /^\d{1,20}$/.test(number), 'SIE-verifikationsnumret ska vara numeriskt.');
      current = { series, number: number ? BigInt(number).toString() : '', date: iso(field(3)), description: tokens[4] ? safe(tokens[4]) : 'Importerad SIE-verifikation', rows: [], registered: tokens[5] ? iso(tokens[5]) : '', sign: tokens[6] ? safe(tokens[6], 100) : '' };
      waitingBrace = true; continue;
    }
    if (['#FLAGGA','#PROGRAM','#FORMAT','#GEN','#SIETYP','#FNAMN','#ORGNR','#VALUTA'].includes(tag)) {
      assert(!single.has(tag), `SIE-filen har flera ${tag}-poster.`); single.add(tag);
      if (tag === '#FLAGGA') { assert(['0','1'].includes(field(1)), 'Ogiltig SIE-importflagga.'); parsed.flag = Number(field(1)); }
      if (tag === '#PROGRAM') parsed.program = [safe(field(1), 200), tokens[2] ? safe(tokens[2], 100) : ''];
      if (tag === '#FORMAT') assert(field(1).toUpperCase() === 'PC8', 'SIE 4-filen måste ange #FORMAT PC8.');
      if (tag === '#GEN') { parsed.generated = iso(field(1)); parsed.generatedBy = tokens[2] ? safe(tokens[2], 100) : ''; }
      if (tag === '#SIETYP') assert(field(1) === '4', 'Den här importen kräver SIE typ 4.');
      if (tag === '#FNAMN') parsed.companyName = label(field(1), 300);
      if (tag === '#ORGNR') parsed.orgNumber = label(field(1), 40);
      if (tag === '#VALUTA') { parsed.currency = field(1); assert(parsed.currency === 'SEK', 'SIE-filen använder annan redovisningsvaluta än SEK.'); }
      continue;
    }
    if (tag === '#RAR') {
      assert(/^(?:0|-\d+)$/.test(field(1)), 'SIE-räkenskapsårets index är ogiltigt.');
      const year = { index: Number(field(1)), start: iso(field(2)), end: iso(field(3)) };
      assert(year.start <= year.end && !parsed.years.some(item => item.index === year.index), 'SIE-filen har ett ogiltigt eller dubbelt räkenskapsår.'); parsed.years.push(year); continue;
    }
    if (tag === '#KONTO') {
      const number = field(1); assert(/^\d{4}$/.test(number) && !accounts.has(number), 'SIE-filen har ett ogiltigt eller dubbelt kontonummer.'); accounts.add(number); parsed.accounts.push({ number, name: label(field(2), 300) }); continue;
    }
    if (['#IB','#UB','#RES'].includes(tag)) {
      const year = Number(field(1)), account = field(2), value = amount(field(3));
      assert(/^(?:0|-\d+)$/.test(field(1)) && /^\d{4}$/.test(account), 'SIE-saldots år eller konto är ogiltigt.');
      assert(tag === '#RES' ? /^[3-9]/.test(account) : /^[12]/.test(account), 'SIE-saldot använder fel kontoklass.');
      const key = `${tag}:${year}:${account}`; assert(!balances.has(key), 'SIE-filen har dubbla saldoetiketter för ett konto.'); balances.add(key); parsed.balances.push({ kind: tag.slice(1), year, account, amountCents: value }); continue;
    }
    if (metadataTags.has(tag)) continue;
    if (tag === '#PSALDO' || tag === '#PBUDGET') { parsed.warnings.push('Period- och budgetsaldon bevaras i originalfilen; huvudboken importeras från verifikationerna.'); continue; }
    if (tag === '#KSUMMA') throw new Error('SIE-filer med kontrollsummeposter måste exporteras utan KSUMMA före import.');
    throw new Error(`SIE-posten ${safe(tag, 40)} stöds inte. Inga rader har importerats.`);
  }
  assert(!current && !waitingBrace, 'SIE-filen slutar mitt i en verifikation.');
  for (const tag of ['#FLAGGA','#PROGRAM','#FORMAT','#GEN','#SIETYP','#FNAMN']) assert(single.has(tag), `SIE-filen saknar ${tag}.`);
  assert(parsed.flag === 0, 'SIE-filen är redan markerad som importerad (#FLAGGA 1).');
  assert(parsed.years.length <= 20, 'SIE-filen innehåller för många jämförelseår.');
  assert(parsed.vouchers.length || parsed.balances.some(item => item.amountCents), 'SIE-filen innehåller ingen bokföring.');
  if (options.encoding === 'utf8') parsed.warnings.push('Filen lästes uttryckligen som UTF-8; standardexporten använder PC8.');
  if (parsed.ignoredCorrections) parsed.warnings.push('BTRANS/RTRANS bevaras i originalfilen; aktiva TRANS-rader används enligt SIE-specifikationen.');
  if (parsed.years.some(year => year.index !== 0)) parsed.warnings.push('Jämförelseår bevaras i originalfilen. Endast år 0 importeras i denna åtgärd.');
  const keys = new Set();
  for (const voucher of parsed.vouchers) if (voucher.series && voucher.number) { const key = `${voucher.series}:${voucher.number}`; assert(!keys.has(key), 'Samma SIE-verifikationsnummer finns flera gånger i filen.'); keys.add(key); }
  parsed.warnings = [...new Set(parsed.warnings)];
  parsed.fileHash = sieFingerprint(sourceText);
  return parsed;
}

function mapRows(rows, mapping, aggregate = true) {
  if (!aggregate) return rows.map(row => { const account = mapping[row.account] ?? row.account; assert(row.account !== '8999' && account !== '8999', closedResultMessage); assert(accountMap.has(account), `Konto ${row.account} behöver kopplas till ett konto i programmets kontoplan.`); return { account, debitCents: Math.max(0,row.amountCents), creditCents: Math.max(0,-row.amountCents) }; });
  const grouped = new Map();
  for (const row of rows) {
    const target = mapping[row.account] ?? row.account;
    assert(accountMap.has(target), `Konto ${row.account} behöver kopplas till ett konto i programmets kontoplan.`);
    grouped.set(target, sum([grouped.get(target) ?? 0, row.amountCents]));
  }
  return [...grouped].filter(([, value]) => value !== 0).sort(([a],[b]) => a.localeCompare(b)).map(([account, value]) => ({ account, debitCents: Math.max(0,value), creditCents: Math.max(0,-value) }));
}
function normalizeMapping(value = {}) {
  assert(record(value), 'Kontomappningen måste vara ett objekt.');
  const result = {};
  for (const [from, to] of Object.entries(value)) { assert(/^\d{4}$/.test(from) && accountMap.has(to), 'Kontomappningen innehåller ett ogiltigt konto.'); result[from] = to; }
  return Object.fromEntries(Object.entries(result).sort(([a],[b]) => a.localeCompare(b)));
}
const openingEntryIds = state => new Set((state.sieImports ?? []).flatMap(batch => batch.items.filter(item => item.kind === 'opening').map(item => item.entryId)));
function existingOpening(state, start) {
  const imported = openingEntryIds(state);
  return mapRows(state.entries.filter(entry => entry.date < start || entry.date === start && (entry.sourceType === 'opening' || imported.has(entry.id))).flatMap(entry => entry.rows.filter(row => /^[12]/.test(row.account)).map(row => ({ account: row.account, amountCents: row.debitCents-row.creditCents }))), {});
}
function sourceVoucherKey(parsed, voucher, index, year, targetOrgNumber) {
  // Missing source identity must not let a renamed export re-import numbered vouchers.
  return sieFingerprint(JSON.stringify([org(parsed.orgNumber) || org(targetOrgNumber) || 'current-company', year.start, year.end,
    voucher.series && voucher.number ? [voucher.series, voucher.number] : [parsed.fileHash, index]]));
}
function sourceRowsFor(parsed, year) {
  const current = parsed.vouchers.filter(voucher => voucher.date >= year.start && voucher.date <= year.end);
  assert(current.length === parsed.vouchers.length, 'Verifikationer från andra år måste importeras i ett separat räkenskapsår.');
  assert(!current.some(voucher => voucher.rows.some(row => row.account === '8999')), closedResultMessage);
  const opening = parsed.balances.filter(item => item.year === 0 && item.kind === 'IB');
  assert(sum(opening.map(item => item.amountCents)) === 0, 'SIE-filens ingående balans balanserar inte.');
  const totals = new Map();
  for (const row of [...opening, ...current.flatMap(voucher => voucher.rows)]) totals.set(row.account, sum([totals.get(row.account) ?? 0, row.amountCents]));
  const closing = parsed.balances.filter(item => item.year === 0 && ['UB','RES'].includes(item.kind));
  if (closing.length) {
    const declared = new Map(closing.map(row => [row.account, row.amountCents]));
    for (const account of new Set([...totals.keys(), ...declared.keys()])) assert((totals.get(account) ?? 0) === (declared.get(account) ?? 0), `SIE-saldot för konto ${account} stämmer inte med IB och verifikationer.`);
    assert(sum(closing.map(item => item.amountCents)) === 0, 'SIE-filens slutliga saldon balanserar inte.');
  } else if (parsed.balances.some(item => item.year === 0 && item.kind === 'IB') && !current.length) throw new Error('SIE-filen saknar utgående saldon att stämma av mot.');
  return opening;
}

export function previewSieImport(state, input, options = {}) {
  const parsed = parseSie4(input, options), mapping = normalizeMapping(options.mapping);
  const year = parsed.years.find(item => item.index === 0) ?? { start: state.company.fiscalYearStart, end: state.company.fiscalYearEnd };
  assert(year.start === state.company.fiscalYearStart && year.end === state.company.fiscalYearEnd, 'SIE-filens år 0 måste motsvara det öppna räkenskapsåret.');
  assert(!parsed.orgNumber || org(parsed.orgNumber) === org(state.company.orgNumber), 'SIE-filens organisationsnummer skiljer sig från bolaget. Kontrollera företagsinställningarna före import.');
  const fileOpening = sourceRowsFor(parsed, year), openingRows = mapRows(fileOpening, mapping), oldOpening = existingOpening(state, year.start);
  assert(openingRows.every(row => /^[12]/.test(row.account)), 'Ingående balans måste mappas till balanskonton i kontoklass 1 eller 2.');
  assert(sum(openingRows.map(row => row.debitCents)) <= MAX_CENTS, 'SIE-filens ingående balans överstiger programmets beloppsgräns.');
  const includeOpening = openingRows.length > 0 && oldOpening.length === 0;
  assert(!openingRows.length || !oldOpening.length || same(openingRows, oldOpening), 'SIE-filens ingående balans skiljer sig från bokföringen. Importen får inte lägga en andra ingående balans ovanpå den första.');
  const existing = new Map((state.sieImports ?? []).flatMap(batch => batch.items.filter(item => item.kind === 'voucher').map(item => [item.sourceKey, item.contentHash])));
  const vouchers = parsed.vouchers.map((voucher, index) => {
    const rows = mapRows(voucher.rows, mapping, false);
    assert(rows.length >= 2 && sum(rows.map(row => row.debitCents-row.creditCents)) === 0, 'Kontomappningen tömmer eller obalanserar en verifikation.');
    assert(sum(rows.map(row => row.debitCents)) <= MAX_CENTS, 'SIE-verifikationens omslutning överstiger programmets beloppsgräns.');
    const sourceKey = sourceVoucherKey(parsed, voucher, index, year, state.company.orgNumber), contentHash = sieFingerprint(JSON.stringify([voucher.date,voucher.description,rows]));
    assert(!existing.has(sourceKey) || existing.get(sourceKey) === contentHash, 'En tidigare importerad SIE-verifikation har ändrats i den nya filen. Rätta den med en spårbar rättelse.');
    return { index, sourceKey, contentHash, duplicate: existing.has(sourceKey), series: voucher.series, number: voucher.number,
      date: voucher.date, description: voucher.description, rows };
  });
  assert(!(state.sieImports ?? []).some(batch => batch.fileHash === parsed.fileHash), 'Den här SIE-filen har redan importerats.');
  const fresh = vouchers.filter(voucher => !voucher.duplicate);
  assert(!state.inventoryValuations.length || ![...(includeOpening ? openingRows : []), ...fresh.flatMap(voucher => voucher.rows)].some(row => row.account === '1460'),
    'Import som ändrar 1460 måste göras före första lagervärderingen. Annars behöver lagerregistret och huvudboken stämmas av tillsammans.');
  if (includeOpening) requireOpenPeriod(state, year.start);
  for (const voucher of fresh) requireOpenPeriod(state, voucher.date);
  const warnings = [...parsed.warnings];
  if (vouchers.some(voucher => !voucher.series || !voucher.number)) warnings.push('Verifikationer utan stabil serie/nummer identifieras med fil och radordning. Kontrollera särskilt att samma affärer inte finns i en annan fil.');
  if (parsed.orgNumber === '') warnings.push('Källfilen saknar organisationsnummer. Kontrollera att företagsnamnet avser rätt bolag.');
  if (fresh.some(voucher => voucher.rows.some(row => ['1220','1229','1460','1510','1790','2440','2650','2710','2731','2910'].includes(row.account)))) warnings.push('SIE-importen för över huvudbokens saldon. Kund-/leverantörsposter, inventarier, lön och bilagor måste kompletteras separat innan de kan hanteras i respektive register.');
  return { parsed, mapping, year, includeOpening, openingRows, vouchers, freshCount: fresh.length, duplicateCount: vouchers.length-fresh.length,
    debitCents: sum(fresh.flatMap(voucher => voucher.rows.map(row => row.debitCents))), warnings: [...new Set(warnings)],
    anonymous: vouchers.some(voucher => !voucher.series || !voucher.number) };
}

export function importSie4(state, input, options = {}) {
  assert(options.confirmed === true, 'Granska bolag, år, kontomappning och saldon och bekräfta före SIE-import.');
  const preview = previewSieImport(state, input, options);
  assert(!preview.anonymous || options.anonymousConfirmed === true, 'Bekräfta kontrollen av verifikationer utan serie/nummer före import.');
  assert(preview.freshCount || preview.includeOpening, 'Alla verifikationer finns redan importerade. Ingen bokföring har ändrats.');
  return transact(state, draft => {
    const id = nextId(draft,'sie-import');
    const batch = { id, version: 1, fileHash: preview.parsed.fileHash, sourceText: preview.parsed.sourceText, mapping: preview.mapping,
      targetOrgNumber: draft.company.orgNumber, year: clone(preview.year), importedAt: new Date().toISOString(), actor: 'Åke', items: [] };
    if (preview.includeOpening) {
      const sourceId = `sie-${batch.fileHash}-ib`, description = 'Ingående balans från SIE';
      const entry = appendEntry(draft, { date: preview.year.start, description, rows: preview.openingRows, sourceType: 'sie-import', sourceId });
      batch.items.push({ kind: 'opening', sourceKey: sieFingerprint(`${batch.fileHash}:IB`), contentHash: sieFingerprint(JSON.stringify(preview.openingRows)), entryId: entry.id, sourceId });
    }
    for (const voucher of preview.vouchers.filter(item => !item.duplicate)) {
      const sourceId = `sie-${batch.fileHash}-${voucher.index}`;
      const prefix = `${voucher.series || 'SIE'}${voucher.number || ''}`;
      const description = `${prefix} · ${voucher.description}`;
      assert(description.length <= 500, 'Verifikationens beskrivning är för lång efter ursprungsmärkning.');
      const entry = appendEntry(draft, { date: voucher.date, description, rows: voucher.rows, sourceType: 'sie-import', sourceId });
      batch.items.push({ kind: 'voucher', index: voucher.index, sourceKey: voucher.sourceKey, contentHash: voucher.contentHash, entryId: entry.id, sourceId });
    }
    draft.sieImports ??= []; draft.sieImports.push(batch);
    addActivity(draft, `SIE-import: ${preview.freshCount} verifikationer, ${preview.duplicateCount} dubbletter hoppades över.`, id);
  });
}

export function validateSieImports(state) {
  const batches = state.sieImports ?? []; assert(Array.isArray(batches) && batches.length <= 1000, 'SIE-importhistoriken är ogiltig.');
  const claimedEntryIds = new Set(), accountAdjustments = {}, keys = new Set(), contentByKey = new Map(), files = new Set();
  for (const batch of batches) {
    assert(batch && typeof batch.id === 'string' && batch.version === 1 && !files.has(batch.fileHash), 'SIE-importen är ogiltig eller dubblerad.'); files.add(batch.fileHash);
    assert(typeof batch.importedAt === 'string' && Number.isFinite(Date.parse(batch.importedAt)) && typeof batch.actor === 'string' && batch.actor.trim() && batch.actor.length <= 100, 'SIE-importens tidpunkt eller utförare saknas.');
    const parsed = parseSie4(batch.sourceText), mapping = normalizeMapping(batch.mapping);
    assert(parsed.fileHash === batch.fileHash && org(batch.targetOrgNumber) === org(state.company.orgNumber), 'SIE-importens original eller företagskoppling har ändrats.');
    assert(validDate(batch.year?.start) && validDate(batch.year?.end) && fiscalPeriods(state).some(year => year.start === batch.year.start && year.end === batch.year.end), 'SIE-importens räkenskapsår finns inte.');
    assert(!parsed.orgNumber || org(parsed.orgNumber) === org(batch.targetOrgNumber), 'SIE-importens organisationsnummer stämmer inte.');
    const sourceYear = parsed.years.find(year => year.index === 0);
    assert(!sourceYear || sourceYear.start === batch.year.start && sourceYear.end === batch.year.end, 'SIE-importens år har ändrats.');
    sourceRowsFor(parsed, batch.year);
    assert(Array.isArray(batch.items) && batch.items.length > 0 && batch.items.length <= SIE_LIMITS.vouchers+1, 'SIE-importens verifikationslista är ogiltig.');
    for (const item of batch.items) {
      let expectedRows, expectedDate, expectedDescription, expectedSource, expectedKey, expectedHash;
      if (item.kind === 'opening') {
        expectedRows = mapRows(parsed.balances.filter(row => row.kind === 'IB' && row.year === 0), mapping);
        assert(expectedRows.length >= 2 && expectedRows.every(row => /^[12]/.test(row.account)), 'SIE-importens ingående balans har ogiltiga konton.');
        expectedDate = batch.year.start; expectedDescription = 'Ingående balans från SIE'; expectedSource = `sie-${batch.fileHash}-ib`;
        expectedKey = sieFingerprint(`${batch.fileHash}:IB`); expectedHash = sieFingerprint(JSON.stringify(expectedRows));
      } else {
        assert(item.kind === 'voucher' && Number.isInteger(item.index) && parsed.vouchers[item.index], 'SIE-importen hänvisar till en okänd källverifikation.');
        const voucher = parsed.vouchers[item.index]; expectedRows = mapRows(voucher.rows, mapping, false); expectedDate = voucher.date;
        expectedDescription = `${voucher.series || 'SIE'}${voucher.number || ''} · ${voucher.description}`; expectedSource = `sie-${batch.fileHash}-${item.index}`;
        expectedKey = sourceVoucherKey(parsed,voucher,item.index,batch.year,batch.targetOrgNumber); expectedHash = sieFingerprint(JSON.stringify([voucher.date,voucher.description,expectedRows]));
      }
      assert(!keys.has(expectedKey) && item.sourceKey === expectedKey && item.contentHash === expectedHash && item.sourceId === expectedSource, 'SIE-importens verifikation har dubblerats eller ändrats.'); keys.add(expectedKey); contentByKey.set(expectedKey,expectedHash);
      const entry = state.entries.find(value => value.id === item.entryId);
      assert(entry && !claimedEntryIds.has(entry.id) && entry.sourceType === 'sie-import' && entry.sourceId === expectedSource && entry.date === expectedDate && entry.description === expectedDescription && same(entry.rows,expectedRows), 'SIE-importens bokföring stämmer inte med originalfilen.');
      claimedEntryIds.add(entry.id);
      for (const row of entry.rows) accountAdjustments[row.account] = sum([accountAdjustments[row.account] ?? 0, row.debitCents-row.creditCents]);
    }
    for (let index=0;index<parsed.vouchers.length;index++) { const voucher=parsed.vouchers[index]; const key=sourceVoucherKey(parsed,voucher,index,batch.year,batch.targetOrgNumber); const rows=mapRows(voucher.rows,mapping,false); assert(contentByKey.get(key)===sieFingerprint(JSON.stringify([voucher.date,voucher.description,rows])), 'SIE-importen saknar en verifikation från originalfilen.'); }
    const sourceOpening=mapRows(parsed.balances.filter(row=>row.kind==='IB'&&row.year===0),mapping);
    assert(!sourceOpening.length || same(sourceOpening,existingOpening(state,batch.year.start)), 'SIE-importens ingående balanser stämmer inte med huvudboken.');
  }
  for (const entry of state.entries.filter(item => item.sourceType === 'sie-import')) assert(claimedEntryIds.has(entry.id), 'En SIE-verifikation saknar importoriginal.');
  return { claimedEntryIds, accountAdjustments };
}

export function exportSie4Text(state, { start = state.company.fiscalYearStart, end = state.company.fiscalYearEnd, generated = new Date().toISOString().slice(0,10) } = {}) {
  assert(fiscalPeriods(state).some(year => year.start === start && year.end === end), 'Välj ett registrerat räkenskapsår för SIE-export.');
  const openingIds = openingEntryIds(state), openingRows = existingOpening(state,start);
  const entries = state.entries.filter(entry => entry.date >= start && entry.date <= end && entry.sourceType !== 'opening' && !openingIds.has(entry.id));
  assert(openingRows.length || entries.length, 'Räkenskapsåret saknar bokföring att exportera.');
  const balances = new Map(openingRows.map(row => [row.account,row.debitCents-row.creditCents]));
  for (const entry of entries) for (const row of entry.rows) balances.set(row.account,sum([balances.get(row.account) ?? 0,row.debitCents-row.creditCents]));
  const used = new Set([...balances.keys(),...entries.flatMap(entry => entry.rows.map(row => row.account))]);
  const lines = ['#FLAGGA 0', '#PROGRAM "ScrapPlanner Bokforing" "1.0"', '#FORMAT PC8', `#GEN ${compactDate(generated)} ${quote('ScrapPlanner')}`, '#SIETYP 4', `#FNAMN ${quote(state.company.name)}`];
  if (/^\d{10,12}$/.test(org(state.company.orgNumber))) lines.push(`#ORGNR ${quote(state.company.orgNumber)}`);
  lines.push(`#RAR 0 ${compactDate(start)} ${compactDate(end)}`, '#VALUTA SEK', '#KPTYP BAS2026');
  for (const account of ACCOUNTS.filter(account => used.has(account.number))) lines.push(`#KONTO ${account.number} ${quote(account.name)}`);
  for (const row of openingRows) lines.push(`#IB 0 ${row.account} ${money(row.debitCents-row.creditCents)}`);
  for (const [account,value] of [...balances].sort(([a],[b]) => a.localeCompare(b))) if (value) lines.push(`#${/^[12]/.test(account) ? 'UB' : 'RES'} 0 ${account} ${money(value)}`);
  for (const entry of entries) {
    const match = /^([A-Za-z]+)(\d+)$/.exec(entry.number); assert(match, 'Verifikationsnumret kan inte delas för SIE-export.');
    lines.push(`#VER ${quote(match[1])} ${quote(match[2])} ${compactDate(entry.date)} ${quote(entry.description)} ${compactDate(entry.createdAt.slice(0,10))} ${quote(entry.actor)}`, '{');
    for (const row of entry.rows) lines.push(`#TRANS ${row.account} {} ${money(row.debitCents-row.creditCents)}`);
    lines.push('}');
  }
  return lines.join('\r\n')+'\r\n';
}
export const exportSie4 = (state, options) => encodeSiePc8(exportSie4Text(state, options));
