// Export formats are based on the versioned official specifications listed in
// bokforing/deklarationer.md. Nothing here transmits or signs a declaration.
import { assert, validDate, transact, nextId, addActivity } from './core.js';
import { getYearReports } from './fiscal-reports.js';
import { getTaxDeclarationReport } from './tax-ledger.js';
import { getPayrollDeclarationPeople } from './payroll-engine.js';
import { getVatPeriodBounds } from './finance.js';
import { SRU_FIELDS } from './declarations-sru-fields.js';
export { SRU_FIELDS } from './declarations-sru-fields.js';
export const DECLARATION_VERSION = 'SE-2026-10-23.1';
export const DECLARATION_SOURCES = Object.freeze({
  agi: 'https://www.skatteverket.se/foretag/arbetsgivare/lamnaarbetsgivardeklaration/tekniskbeskrivningochtesttjanst/tekniskbeskrivning11182.4.7eada0316ed67d7282a791.html',
  sru: 'https://www.skatteverket.se/foretag/inkomstdeklaration/forredovisningsbyraer/tekniskinformationomfiloverforing.4.13948c0e18e810bfa0cca8.html',
  vat: 'https://www.skatteverket.se/foretag/moms/deklareramoms/lamnamomsdeklarationviafilietjansten.4.2fb39afe18dabf1e4d223cc.html',
  k2: 'https://www.bfn.se/wp-content/uploads/vl16-10-k2ar-kons2025.pdf',
});
const text = (value, name, max = 200, optional = false) => { assert(typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f<>]/.test(value) && (optional || value.trim()), `${name} saknas eller innehåller otillåtna tecken.`); return value.trim(); };
const sum = values => values.reduce((a, b) => { assert(Number.isSafeInteger(b) && Number.isSafeInteger(a + b), 'Beloppen är för stora.'); return a + b; }, 0);
const moneyValue = (value, name = 'Belopp') => { assert(Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000_000, `${name} måste vara hela ören.`); return value; };
const kronor = value => Math.trunc(moneyValue(value) / 100);
const compactDate = value => { assert(validDate(value), 'Datumet är ogiltigt.'); return value.replaceAll('-', ''); };
const cleanNumber = value => String(value ?? '').replace(/[- +]/g, '');
function luhn(value) { return value.length === 10 && /^\d+$/.test(value) && [...value].reduce((a, c, i) => { const n = Number(c) * (i % 2 ? 1 : 2); return a + (n > 9 ? n - 9 : n); }, 0) % 10 === 0; }
export function organisationNumber(value) {
  let number = cleanNumber(value); if (number.length === 12 && number.startsWith('16')) number = number.slice(2);
  assert(luhn(number) && Number(number[2]) >= 2, 'Ange ett svenskt organisationsnummer med korrekt kontrollsiffra.');
  return number;
}
export function personalNumber(value) {
  const number = cleanNumber(value);
  assert(/^\d{12}$/.test(number) && /^(19|20)/.test(number) && luhn(number.slice(2)), 'Ange person-/samordningsnummer med tolv siffror och korrekt kontrollsiffra.');
  const day = Number(number.slice(6, 8)); const actual = day > 60 ? day - 60 : day;
  assert(validDate(`${number.slice(0, 4)}-${number.slice(4, 6)}-${String(actual).padStart(2, '0')}`) && Number(number.slice(8, 11)) > 0, 'Person-/samordningsnumrets datum eller individnummer är ogiltigt.');
  return number;
}
const identity12 = value => `16${organisationNumber(value)}`;
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const xmlAscii = value => xml(value).replace(/[^\x00-\x7f]/gu, c => `&#${c.codePointAt(0)};`);
const cell = (name, value, code) => `<agd:${name}${code ? ` faltkod="${code}"` : ''}>${xml(value)}</agd:${name}>`;
const tag = (name, contents) => `<agd:${name}>${contents}</agd:${name}>`;
const period = value => { assert(/^2026-(0[1-9]|1[0-2])$/.test(value), 'Den versionerade deklarationsmodulen stödjer redovisningsmånader under 2026.'); return value.replace('-', ''); };
const timestamp = value => { assert(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value) && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)), 'Framställningstid saknas eller har ogiltigt kalenderdatum.'); return value.slice(0, 19); };
function contact(input) {
  const name = text(input.contactName, 'Kontaktperson', 50), phone = text(input.contactPhone, 'Telefon', 20), email = text(input.contactEmail, 'E-post', 254);
  assert(/^[A-Za-z0-9_]+([-+.'\u0026][A-Za-z0-9_]+)*@[A-Za-z0-9_]+([-.][A-Za-z0-9_]+)*\.[A-Za-z0-9_]+([-.][A-Za-z0-9_]+)*$/.test(email), 'Ange giltig e-postadress.');
  return { name, phone, email };
}
export function getAgiPeople(state, month) { period(month); return getPayrollDeclarationPeople(state, month); }
export function buildAgiXml(data) {
  const p = period(data.month), org = identity12(data.orgNumber), sender = identity12(data.senderOrgNumber || data.orgNumber), c = contact(data);
  assert(data.domesticOrdinary === true && data.reviewed === true && data.absenceReviewed === true, 'Granska svensk normal lön, personuppgifter och frånvaro före AGI-export.');
  assert(Array.isArray(data.people) && data.people.length <= 5000, 'AGI-personerna är ogiltiga.');
  const seen = new Set(), specs = new Set();
  const people = data.people.map(person => {
    const identity = personalNumber(person.personalNumber), specification = Number(person.specification);
    assert(!seen.has(identity) && Number.isInteger(specification) && specification >= 1 && specification <= 9999999999 && !specs.has(`${identity}:${specification}`), 'Person eller specifikationsnummer är dubblerat eller ogiltigt.'); seen.add(identity); specs.add(`${identity}:${specification}`);
    for (const key of ['grossCents', 'benefitCents', 'withholdingCents', 'employerCents']) assert(moneyValue(person[key]) >= 0, 'AGI-beloppen får inte vara negativa.');
    for (const key of ['grossCents', 'benefitCents', 'withholdingCents']) assert(kronor(person[key]) <= 9999999999, 'AGI-individbeloppet överskrider XSD-gränsen BELOPP10 (10 siffror).');
    return { ...person, identity, specification };
  });
  const employerKronor = data.employerKronor ?? kronor(sum(people.map(person => person.employerCents)));
  assert(Number.isSafeInteger(employerKronor) && employerKronor >= 0 && employerKronor <= 999999999999, 'Arbetsgivaravgiften ska vara ett granskat belopp i hela kronor.');
  const withholdingKronor = sum(people.map(person => kronor(person.withholdingCents)));
  assert(withholdingKronor <= 999999999999, 'AGI:s summerade skatteavdrag överskrider XSD-gränsen BELOPP12 (12 siffror).');
  const contactXml = cell('Namn', c.name) + cell('Telefon', c.phone) + cell('Epostadress', c.email);
  const envelope = content => tag('Blankett', tag('Arendeinformation', cell('Arendeagare', org) + cell('Period', p)) + tag('Blankettinnehall', content));
  const hu = tag('HU', tag('ArbetsgivareHUGROUP', cell('AgRegistreradId', org, '201')) + cell('RedovisningsPeriod', p, '006') + cell('SummaArbAvgSlf', employerKronor, '487') + cell('SummaSkatteavdr', withholdingKronor, '497'));
  const individuals = people.map(person => envelope(tag('IU', tag('ArbetsgivareIUGROUP', cell('AgRegistreradId', org, '201')) + tag('BetalningsmottagareIUGROUP', tag('BetalningsmottagareIDChoice', cell('BetalningsmottagarId', person.identity, '215'))) + cell('RedovisningsPeriod', p, '006') + cell('Specifikationsnummer', person.specification, '570') + cell('AvdrPrelSkatt', kronor(person.withholdingCents), '001') + cell('KontantErsattningUlagAG', kronor(person.grossCents), '011') + (person.benefitCents ? cell('SkatteplOvrigaFormanerUlagAG', kronor(person.benefitCents), '012') : '')))).join('\n');
  const absenceSeen = new Set();
  assert(data.absences === undefined || Array.isArray(data.absences) && data.absences.length <= 10000, 'Frånvarolistan är ogiltig eller för stor.');
  const absences = (data.absences ?? []).map(item => {
    const person = people.find(value => value.employeeId === item.employeeId); assert(person, 'Frånvaro saknar en deklarerad person.');
    assert(['FORALDRAPENNING', 'TILLFALLIG_FORALDRAPENNING'].includes(item.type) && validDate(item.date) && item.date.startsWith(data.month+'-'), 'Frånvaron ska gälla en giltig dag i den valda redovisningsmånaden.');
    const spec = Number(item.specification); assert(Number.isSafeInteger(spec) && spec >= 1 && spec <= 9999999999, 'Frånvarons specifikationsnummer är ogiltigt.');
    const key = `${person.identity}:${spec}`; assert(!absenceSeen.has(key), 'Frånvarouppgiftens specifikationsnummer är dubblerat.'); absenceSeen.add(key);
    const hasHours = item.hoursHundredths !== undefined, hasPercent = item.percentHundredths !== undefined;
    assert(hasHours !== hasPercent, 'Ange frånvaro antingen i timmar eller procent.');
    const quantity = hasHours ? item.hoursHundredths : item.percentHundredths;
    assert(Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= (hasHours ? 2400 : 10000), 'Frånvarons omfattning är ogiltig.');
    const fp = item.type === 'FORALDRAPENNING';
    return tag('Franvarouppgift', cell('AgRegistreradId', org, '201') + cell('BetalningsmottagarId', person.identity, '215') + cell('FranvaroDatum', item.date, '821') + cell('FranvaroTyp', item.type, '823') + cell('FranvaroSpecifikationsnummer', spec, '822') + cell(hasHours ? fp ? 'FranvaroTimmarFP' : 'FranvaroTimmarTFP' : fp ? 'FranvaroProcentFP' : 'FranvaroProcentTFP', (quantity / 100).toFixed(2), hasHours ? fp ? '827' : '825' : fp ? '826' : '824') + cell('RedovisningsPeriod', p, '006'));
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Skatteverket omrade="Arbetsgivardeklaration" xmlns="http://xmls.skatteverket.se/se/skatteverket/da/instans/schema/1.1" xmlns:agd="http://xmls.skatteverket.se/se/skatteverket/da/komponent/schema/1.1">\n${tag('Avsandare', cell('Programnamn', 'ScrapPlanner Bokforing') + cell('Organisationsnummer', sender) + tag('TekniskKontaktperson', contactXml) + cell('Skapad', timestamp(data.createdAt)))}\n${tag('Blankettgemensamt', tag('Arbetsgivare', cell('AgRegistreradId', org) + tag('Kontaktperson', contactXml)))}\n${envelope(hu)}\n${individuals}\n${absences}\n</Skatteverket>\n`;
}
export const VAT_XML_FIELDS = Object.freeze([
 ['05','ForsMomsEjAnnan'],['06','UttagMoms'],['07','UlagMargbesk'],['08','HyrinkomstFriv'],['10','MomsUtgHog'],['11','MomsUtgMedel'],['12','MomsUtgLag'],['20','InkopVaruAnnatEg'],['21','InkopTjanstAnnatEg'],['22','InkopTjanstUtomEg'],['23','InkopVaruSverige'],['24','InkopTjanstSverige'],['30','MomsInkopUtgHog'],['31','MomsInkopUtgMedel'],['32','MomsInkopUtgLag'],['35','ForsVaruAnnatEg'],['36','ForsVaruUtomEg'],['37','InkopVaruMellan3p'],['38','ForsVaruMellan3p'],['39','ForsTjSkskAnnatEg'],['40','ForsTjOvrUtomEg'],['41','ForsKopareSkskSverige'],['42','ForsOvrigt'],['50','MomsUlagImport'],['60','MomsImportUtgHog'],['61','MomsImportUtgMedel'],['62','MomsImportUtgLag'],['48','MomsIngAvdr'],['49','MomsBetala'],
]);
export function buildVatXml(data) {
  const org = organisationNumber(data.orgNumber); assert(validDate(data.from) && validDate(data.to) && data.from <= data.to && data.reviewed === true, 'Granska momsperioden före export.');
  const lastDay=new Date(Date.UTC(Number(data.to.slice(0,4)),Number(data.to.slice(5,7)),0)).toISOString().slice(0,10);
  assert(data.from.endsWith('-01')&&data.to===lastDay,'Momsdeklarationen måste omfatta hela kalendermånader.');
  const expected = Object.fromEntries(VAT_XML_FIELDS.map(([key]) => [key, kronor(data.boxes[key] ?? 0)]));
  assert(Object.keys(data.boxes).every(key => VAT_XML_FIELDS.some(([id]) => id === key)), 'Momsrapporten innehåller okända rutor.');
  const output = sum(['10','11','12','30','31','32','60','61','62'].map(key => expected[key]));
  const rawOutput = sum(['10','11','12','30','31','32','60','61','62'].map(key => data.boxes[key] ?? 0));
  assert((data.boxes['49'] ?? 0) === rawOutput - (data.boxes['48'] ?? 0), 'Ruta 49 stämmer inte med momsrapporten.');
  // Each declaration box is reported in whole kronor; recalculate the total
  // from those boxes so independent truncation cannot introduce a discrepancy.
  expected['49'] = output - expected['48'];
  const note = text(data.note ?? '', 'Momsupplysning', 300, true);
  return `<?xml version="1.0" encoding="ISO-8859-1"?>\n<eSKDUpload Version="6.0">\n<OrgNr>${org.slice(0,6)}-${org.slice(6)}</OrgNr>\n<Moms>\n<Period>${compactDate(data.to).slice(0,6)}</Period>\n${VAT_XML_FIELDS.filter(([key]) => key === '49' || expected[key] !== 0).map(([key,name]) => `<${name}>${expected[key]}</${name}>`).join('\n')}\n${note ? `<TextUpplysningMoms>${xmlAscii(note)}</TextUpplysningMoms>\n` : ''}</Moms>\n</eSKDUpload>\n`;
}

const BALANCE_MAP = { '1220':'7215','1229':'7215','1460':'7243','1510':'7251','1630':'7261','1680':'7261','1710':'7263','1790':'7263','1910':'7281','1930':'7281','2081':'7301','2091':'7302','2098':'7302','2099':'7302','2350':'7352','2440':'7365','2490':'7369','2510':'7368','2611':'7368','2614':'7368','2615':'7368','2621':'7368','2624':'7368','2625':'7368','2631':'7368','2634':'7368','2635':'7368','2641':'7368','2645':'7368','2647':'7368','2650':'7368','2710':'7368','2731':'7369','2910':'7370','2990':'7370' };
const RESULT_MAP = { '3000':'7410','3231':'7410','3960':'7413','3973':'7413','4010':'7511','4425':'7513','4960':'7511','5010':'7513','5410':'7513','5460':'7513','6110':'7513','6540':'7513','6570':'7513','6991':'7513','7010':'7514','7082':'7514','7331':'7514','7390':'7514','7510':'7514','7832':'7515','7960':'7517','7973':'7517','8310':'7417','8410':'7522','8910':'7528' };
const VAT_BALANCE_ACCOUNTS=['2611','2614','2615','2621','2624','2625','2631','2634','2635','2641','2645','2647','2650'];
// A control account can contain both debts and receivables. Classify the
// historical balance of each document rather than its net account balance.
export function getDeclarationRescontra(state,end) {
  const entries=new Map(state.entries.filter(item=>item.date<=end).map(item=>[item.id,item]));
  const claimed=new Set(),positions=[];
  const amount=(id,account)=>sum((entries.get(id)?.rows??[]).filter(row=>row.account===account).map(row=>row.debitCents-row.creditCents));
  for(const side of ['customer','supplier']){
    const account=side==='customer'?'1510':'2440',sign=side==='customer'?1:-1;
    for(const doc of (side==='customer'?state.invoices:state.bills).filter(item=>side==='supplier'||item.kind==='invoice')){
      if(!entries.has(doc.entryId))continue;
      const ids=new Set([doc.entryId,doc.creditEntryId,...(doc.payments??[]).map(item=>item.entryId)]);
      if(side==='customer'){
        for(const credit of state.invoices.filter(item=>item.originalInvoiceId===doc.id))ids.add(credit.entryId);
        for(const event of [...(state.rotCreditEvents??[]),...(state.rotRepayments??[])].filter(item=>item.invoiceId===doc.id))ids.add(event.entryId);
      }
      const settlements=(state.settlements??[]).filter(item=>item.side===side&&item.date<=end);
      for(const event of settlements.filter(item=>item.documentId===doc.id&&item.kind!=='offset'))ids.add(event.entryId);
      let balance=sum([...ids].map(id=>amount(id,account)))*sign;
      for(const id of ids)if(entries.has(id))claimed.add(`${account}:${id}`);
      for(const event of settlements.filter(item=>item.kind==='offset'&&(item.documentId===doc.id||item.targetDocumentId===doc.id))){balance+=event.documentId===doc.id?event.amountCents:-event.amountCents;claimed.add(`${account}:${event.entryId}`);}
      positions.push({side,id:doc.id,balanceCents:balance});
    }
    for(const doc of (state.fxDocuments??[]).filter(item=>item.side===side&&item.status==='issued')){
      const ids=(state.fxEvents??[]).filter(item=>item.documentId===doc.id&&item.date<=end).map(item=>item.entryId);
      if(!ids.some(id=>entries.has(id)))continue;
      positions.push({side,id:doc.id,balanceCents:sum(ids.map(id=>amount(id,account)))*sign});
      for(const id of ids)if(entries.has(id))claimed.add(`${account}:${id}`);
    }
  }
  const unknown=[];
  for(const entry of entries.values())for(const account of ['1510','2440'])if(amount(entry.id,account)!==0&&!claimed.has(`${account}:${entry.id}`)&&!['cash-year-end','cash-payment','cash-credit','cash-refund'].includes(entry.sourceType))unknown.push({entryId:entry.id,account});
  const customerCreditCents=-sum(positions.filter(item=>item.side==='customer'&&item.balanceCents<0).map(item=>item.balanceCents))||0;
  const supplierCreditCents=-sum(positions.filter(item=>item.side==='supplier'&&item.balanceCents<0).map(item=>item.balanceCents))||0;
  return {positions,customerCreditCents,supplierCreditCents,unknown};
}
const blankFields = form => Object.fromEntries(SRU_FIELDS[form].filter(field => !['7011','7012'].includes(field.code)).map(field => [field.code, field.type === 'Str_X' ? '' : '0']));
export function suggestSruFields(state, start = state.company.fiscalYearStart, end = state.company.fiscalYearEnd) {
  const report = getYearReports(state, { start, end }), resultAccounts = new Map();
  for (const entry of state.entries.filter(entry => entry.date >= start && entry.date <= end && entry.sourceType !== 'year-close')) for (const row of entry.rows) resultAccounts.set(row.account, (resultAccounts.get(row.account) ?? 0) + row.debitCents - row.creditCents);
  const raw = {}, unmapped = [];
  for (const account of report.accounts.filter(account => /^[12]/.test(account.number) && account.balanceCents)) {
    if(VAT_BALANCE_ACCOUNTS.includes(account.number))continue;
    let key = BALANCE_MAP[account.number], value=account.balanceCents * (account.number.startsWith('2') ? -1 : 1);
    if(['2510','2710','2731','2490'].includes(account.number)&&value<0){key='7261';value=-value;}
    if (!key) unmapped.push(account.number); else raw[key] = (raw[key] ?? 0) + value;
  }
  const vatDebt=-sum(report.accounts.filter(account=>VAT_BALANCE_ACCOUNTS.includes(account.number)).map(account=>account.balanceCents));
  raw[vatDebt>=0?'7368':'7261']=(raw[vatDebt>=0?'7368':'7261']??0)+Math.abs(vatDebt);
  const rescontra=getDeclarationRescontra(state,end);
  raw['7251']=(raw['7251']??0)+rescontra.customerCreditCents;
  raw['7362']=(raw['7362']??0)+rescontra.customerCreditCents;
  raw['7365']=(raw['7365']??0)+rescontra.supplierCreditCents;
  raw['7261']=(raw['7261']??0)+rescontra.supplierCreditCents;
  for (const [account, amount] of resultAccounts) if (/^[3-8]/.test(account) && account !== '8999' && amount) {
    const key = RESULT_MAP[account]; if (!key) unmapped.push(account); else raw[key] = (raw[key] ?? 0) + amount * (key.startsWith('74') ? -1 : 1);
  }
  const r = blankFields('INK2R'); for (const [key, value] of Object.entries(raw)) r[key] = String(kronor(value));
  r[report.resultCents >= 0 ? '7450' : '7550'] = String(Math.abs(kronor(report.resultCents)));
  // Include the current unallocated result in the free-equity presentation.
  r['7302'] = String(Number(r['7302']) + kronor(report.unallocatedResultCents));
  const s = blankFields('INK2S'); s[report.resultCents >= 0 ? '7650' : '7750'] = String(Math.abs(kronor(report.resultCents))); s['7651'] = r['7528'];
  const taxable = kronor(report.resultCents) + Number(s['7651']); s[taxable >= 0 ? '7670' : '7770'] = String(Math.abs(taxable));
  const i = blankFields('INK2'); i[taxable >= 0 ? '7104' : '7114'] = String(Math.abs(taxable));
  return { forms: { INK2: i, INK2R: r, INK2S: s }, unmapped, report, rescontra };
}
function normalizedSruForms(data) {
  assert(validDate(data.start) && validDate(data.end) && data.start <= data.end && data.end >= '2026-09-01' && data.end <= '2026-12-31', 'Denna SRU-fältspecifikation gäller beskattningsperiod 2026P4.');
  const out = {};
  for (const form of ['INK2','INK2R','INK2S']) {
    const fields = data.forms?.[form]; assert(fields && typeof fields === 'object' && !Array.isArray(fields), `${form} saknas.`);
    const catalog = new Map(SRU_FIELDS[form].map(field => [field.code,field])); out[form] = {};
    for (const [key, raw] of Object.entries(fields)) {
      assert(catalog.has(key), `Okänd fältkod ${form}:${key}.`); if (raw === '' || raw === undefined) continue;
      const field = catalog.get(key), value = String(raw).trim();
      if (field.type === 'Str_X') { assert(value === 'X', `${key} ska vara X eller tomt.`); out[form][key] = value; }
      else if (field.type.startsWith('Datum')) { assert(value === compactDate(key === '7011' ? data.start : data.end), 'SRU-räkenskapsåret stämmer inte.'); out[form][key] = value; }
      else { assert(/^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Math.abs(Number(value)) <= (field.type === 'Numeriskt_13' ? 9999999999999 : field.type === 'Numeriskt_10' ? 9999999999 : 999999999999) && (field.type === 'Numeriskt_A' || Number(value) >= 0), `${form} ruta ${key} har ogiltigt belopp.`); if (Number(value) !== 0) out[form][key] = String(Number(value)); }
    }
    out[form]['7011'] = compactDate(data.start); out[form]['7012'] = compactDate(data.end);
    for (const field of catalog.values()) {
      const forbidden = [...field.rule.matchAll(/\b\d{4}\b/g)].map(match => match[0]);
      if (out[form][field.code] && forbidden.some(key => out[form][key] && out[form][key] !== '0')) throw new Error(`Motstridiga fält på ${form}: ${field.code}.`);
    }
  }
  const value = (form,key) => Number(out[form][key] ?? 0);
  assert(value('INK2S','7672')===0,'Koncernbidragsspärrade underskott kräver en separat deklarationsbedömning och stöds inte i detta exportflöde.');
  assert(value('INK2R','7450') === value('INK2S','7650') && value('INK2R','7550') === value('INK2S','7750'), 'Årets resultat måste stämma mellan INK2R och INK2S.');
  assert(value('INK2','7104') === value('INK2S','7670') && value('INK2','7114') === value('INK2S','7770'), 'Skattemässigt resultat måste stämma mellan INK2 och INK2S.');
  const r = out.INK2R;
  const assets = sum(Object.keys(r).filter(key => Number(key)>=7200 && Number(key)<7300).map(key=>Number(r[key])));
  const financing = sum(Object.keys(r).filter(key => Number(key)>=7300 && Number(key)<7400).map(key=>Number(r[key])));
  assert(assets === financing, 'Tillgångar och eget kapital/skulder måste balansera i INK2R, i hela kronor.');
  const calculatedResult = sum(SRU_FIELDS.INK2R.filter(field=>['+','-'].includes(field.sign) && !['7450','7550'].includes(field.code)).map(field=>value('INK2R',field.code)*(field.sign==='+'?1:-1)));
  assert(calculatedResult===value('INK2R','7450')-value('INK2R','7550'),'Resultaträkningens rader måste summera till årets resultat i INK2R.');
  const calculatedTax = sum(SRU_FIELDS.INK2S.filter(field=>['+','-'].includes(field.sign) && !['7670','7770','7672'].includes(field.code)).map(field=>value('INK2S',field.code)*(field.sign==='+'?1:-1)));
  assert(calculatedTax===value('INK2S','7670')-value('INK2S','7770')-value('INK2S','7672'),'Skattejusteringarna måste summera till deklarerat överskott/underskott.');
  return out;
}
export function encodeLatin1(value) {
  assert(typeof value === 'string', 'Text saknas.'); const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) { const n = value.charCodeAt(i); assert(n <= 255, 'SRU-filen innehåller tecken utanför ISO-8859-1. Använd vanliga bokstäver i namn och adress.'); bytes[i] = n; } return bytes;
}
export function buildSruFiles(data) {
  assert(data.reviewed === true, 'Granska alla rutor före SRU-export.'); const forms = normalizedSruForms(data), org = identity12(data.orgNumber), created = timestamp(data.createdAt), date = compactDate(created.slice(0,10)), time = created.slice(11,19).replaceAll(':','');
  const name = text(data.name,'Företagsnamn',250), city = text(data.city,'Postort',250), postalCode = String(data.postalCode ?? '').replaceAll(' ','');
  assert(/^\d{5}$/.test(postalCode), 'Postnumret ska innehålla fem siffror.');
  for (const item of [name,city,data.address ?? '',data.contactName ?? '',data.contactEmail ?? '']) assert(!String(item).includes('#') && !/[\r\n]/.test(String(item)), 'SRU-fält får inte innehålla radbrytning eller #.');
  const info = ['#DATABESKRIVNING_START','#PRODUKT SRU',`#SKAPAD ${date} ${time}`,'#PROGRAM ScrapPlanner Bokforing', '#FILNAMN BLANKETTER.SRU','#DATABESKRIVNING_SLUT','#MEDIELEV_START',`#ORGNR ${org}`,`#NAMN ${name}`,...(data.address ? [`#ADRESS ${text(data.address,'Adress',250)}`] : []),`#POSTNR ${postalCode}`,`#POSTORT ${city}`,...(data.contactName ? [`#KONTAKT ${text(data.contactName,'Kontaktperson',250)}`] : []),...(data.contactEmail ? [`#EMAIL ${text(data.contactEmail,'E-post',250)}`] : []),'#MEDIELEV_SLUT',''].join('\r\n');
  const records = [];
  for (const form of ['INK2','INK2R','INK2S']) records.push(`#BLANKETT ${form}-2026P4`,`#IDENTITET ${org} ${date} ${time}`,`#NAMN ${name}`,...Object.entries(forms[form]).sort(([a],[b])=>Number(a)-Number(b)).map(([key,value])=>`#UPPGIFT ${key} ${value}`),'#BLANKETTSLUT');
  records.push('#FIL_SLUT',''); const blanketter = records.join('\r\n'); encodeLatin1(info); encodeLatin1(blanketter);
  return { 'INFO.SRU': info, 'BLANKETTER.SRU': blanketter };
}
// Small dependency-free ZIP container, STORE method. Each member keeps its
// specified ISO-8859-1 encoding; ZIP filenames are fixed ASCII constants.
export function zipFiles(files) {
  const chunks = [], central = []; let offset = 0;
  const push = (list, data) => list.push(data);
  const header = (size, write) => { const bytes = new Uint8Array(size); write(new DataView(bytes.buffer)); return bytes; };
  const crc = bytes => { let n = 0xffffffff; for (const byte of bytes) { n ^= byte; for (let i=0;i<8;i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  for (const [filename, content] of Object.entries(files)) {
    const name = new TextEncoder().encode(filename), data = typeof content === 'string' ? encodeLatin1(content) : content, checksum = crc(data);
    const local = header(30, view=>{view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint32(14,checksum,true);view.setUint32(18,data.length,true);view.setUint32(22,data.length,true);view.setUint16(26,name.length,true);});
    push(chunks,local);push(chunks,name);push(chunks,data);
    const entry = header(46,view=>{view.setUint32(0,0x02014b50,true);view.setUint16(4,20,true);view.setUint16(6,20,true);view.setUint32(16,checksum,true);view.setUint32(20,data.length,true);view.setUint32(24,data.length,true);view.setUint16(28,name.length,true);view.setUint32(42,offset,true);});
    push(central,entry);push(central,name); offset += local.length + name.length + data.length;
  }
  const centralSize = sum(central.map(x=>x.length));
  const end = header(22,view=>{view.setUint32(0,0x06054b50,true);view.setUint16(8,Object.keys(files).length,true);view.setUint16(10,Object.keys(files).length,true);view.setUint32(12,centralSize,true);view.setUint32(16,offset,true);});
  const all=[...chunks,...central,end], out=new Uint8Array(sum(all.map(x=>x.length)));let index=0;for(const chunk of all){out.set(chunk,index);index+=chunk.length;}return out;
}

const statementGroups = [
 ['fixed','Materiella anläggningstillgångar',['1220','1229']], ['inventory','Varulager',['1460']], ['receivables','Kundfordringar',['1510']], ['otherReceivables','Övriga fordringar',['1630','1680']], ['prepaid','Förutbetalda kostnader och upplupna intäkter',['1710','1790']], ['bank','Kassa och bank',['1910','1930']],
 ['shareCapital','Aktiekapital',['2081']], ['retained','Balanserat resultat',['2091','2098']], ['yearProfit','Årets resultat',['2099']], ['longDebt','Långfristiga skulder till kreditinstitut',['2350']], ['tradeDebt','Leverantörsskulder',['2440']], ['customerAdvances','Förskott från kunder',[]], ['taxDebt','Skatteskulder',['2510']], ['otherDebt','Övriga skulder',['2490','2611','2614','2615','2621','2624','2625','2631','2634','2635','2641','2645','2647','2650','2710','2731']], ['accrued','Upplupna kostnader och förutbetalda intäkter',['2910','2990']],
];
const incomeGroups = [
 ['turnover','Nettoomsättning',['3000','3231'],1],['otherIncome','Övriga rörelseintäkter',['3960','3973'],1],['material','Råvaror och förnödenheter',['4010','4425','4960'],-1],['external','Övriga externa kostnader',['5010','5410','5460','6110','6540','6570','6991'],-1],['staff','Personalkostnader',['7010','7082','7331','7390','7510'],-1],['depreciation','Avskrivningar',['7832'],-1],['otherCost','Övriga rörelsekostnader',['7960','7973'],-1],['interestIncome','Ränteintäkter',['8310'],1],['interestCost','Räntekostnader',['8410'],-1],['tax','Skatt på årets resultat',['8910'],-1],
];
const formatMoney = n => new Intl.NumberFormat('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n / 100);
function annualFinancials(state, start, end) {
  const report=getYearReports(state,{start,end}), balances=new Map(report.accounts.map(account=>[account.number,account.balanceCents])), movements=new Map();
  for(const entry of state.entries.filter(entry=>entry.date>=start&&entry.date<=end&&entry.sourceType!=='year-close')) for(const row of entry.rows) movements.set(row.account,(movements.get(row.account)??0)+row.debitCents-row.creditCents);
  const known=new Set([...statementGroups.flatMap(group=>group[2]),...incomeGroups.flatMap(group=>group[2]),'8999']);
  const unmapped=report.accounts.filter(account=>account.balanceCents&&!known.has(account.number)).map(account=>account.number);
  const balance=Object.fromEntries(statementGroups.map(([key,,accounts])=>[key,sum(accounts.map(account=>(balances.get(account)??0)*(account.startsWith('2')?-1:1)))]));
  const rescontra=getDeclarationRescontra(state,end);
  assert(rescontra.unknown.length===0,'Reskontran innehåller 1510/2440-poster utan dokumentkoppling. Stäm av och koppla dessa innan årsredovisning; nettosaldo kan dölja krediter.');
  let grossUp=rescontra.customerCreditCents+rescontra.supplierCreditCents;
  balance.receivables+=rescontra.customerCreditCents;balance.customerAdvances=rescontra.customerCreditCents;
  balance.tradeDebt+=rescontra.supplierCreditCents;balance.otherReceivables+=rescontra.supplierCreditCents;
  const reclassifiable=[-sum(report.accounts.filter(account=>VAT_BALANCE_ACCOUNTS.includes(account.number)).map(account=>account.balanceCents)),...['2490','2710','2731'].map(account=>-(balances.get(account)??0))];
  for(const debt of reclassifiable)if(debt<0){balance.otherDebt-=debt;balance.otherReceivables-=debt;grossUp-=debt;}
  for(const key of ['taxDebt','otherDebt'])if(balance[key]<0){const receivable=-balance[key];grossUp+=receivable;balance.otherReceivables+=receivable;balance[key]=0;}
  for(const key of ['fixed','inventory','otherReceivables','prepaid','bank','shareCapital','longDebt','accrued'])assert(balance[key]>=0,`Årsredovisningen kräver separat klassificering av negativ post: ${key}.`);
  const statementAssetsCents=report.assetsCents+grossUp,statementLiabilitiesCents=report.liabilitiesEquityCents+grossUp;
  const income=Object.fromEntries(incomeGroups.map(([key,,accounts,sign])=>[key,sum(accounts.map(account=>-(movements.get(account)??0)))*sign]));
  return {report,balance,income,unmapped,statementAssetsCents,statementLiabilitiesCents};
}
function annualParts(state,data) {
  const current=annualFinancials(state,data.start,data.end); assert(current.unmapped.length===0,`Konton behöver mappas i årsredovisningen: ${current.unmapped.join(', ')}.`);
  assert(current.report.balanced,'Balansräkningen stämmer inte.');
  const periods=(state.fiscalYears??[]).filter(item=>item.end<data.start).sort((a,b)=>a.end.localeCompare(b.end));const prior=periods.at(-1)??null;
  assert(prior||data.firstYear===true,'Föregående räkenskapsår saknas. Importera historiken eller bekräfta att detta är företagets första år.');
  const previous=prior?annualFinancials(state,prior.start,prior.end):null;
  if(previous&&previous.income.turnover!==0&&Math.abs(current.income.turnover-previous.income.turnover)/Math.abs(previous.income.turnover)>.3)text(data.turnoverChangeNote,'Kommentar till omsättningsförändring över 30 procent',12000);
  assert(data.smallPrivateAB===true&&data.scopeReviewed===true,'Bekräfta tillämpningen: mindre privat aktiebolag, K2, utan koncern och särskilda redovisningsfall.');
  assert(state.yearClosures.some(item=>item.fiscalYearStart===data.start&&item.fiscalYearEnd===data.end),'Avsluta och granska räkenskapsåret före den färdiga årsredovisningen.');
  assert(validDate(data.signatureDate)&&data.signatureDate>=data.end,'Underskriftsdatum får inte ligga före räkenskapsårets slut.');
  for(const key of ['managementReport','events','postBalanceEvents','equityNote','accountingPolicies','assetNote','employeeNote','securityNote','debtNote','relatedPartyNote','taxNote']) text(data[key],`Årsredovisningens upplysning ${key}`,12000);
  text(data.registeredOffice,'Styrelsens säte',100);text(data.signaturePlace,'Underskriftsort',100);
  assert(Array.isArray(data.signatories)&&data.signatories.length>=1&&data.signatories.length<=30,'Ange samtliga styrelseledamöter och eventuell VD för underskrift.');
  for(const signer of data.signatories){text(signer.name,'Undertecknare',100);assert(['Styrelseledamot','Styrelseordförande','VD'].includes(signer.role),'Ange styrelse- eller VD-roll.');}
  assert(data.allSignatoriesConfirmed===true,'Bekräfta att alla styrelseledamöter och eventuell VD finns med.');
  const distributable=sum([current.balance.retained,current.balance.yearProfit]);
  const dividend=moneyValue(data.dividendCents??0), carried=moneyValue(data.carriedCents??distributable-dividend);
  assert(dividend>=0&&dividend<=Math.max(0,distributable)&&dividend+carried===distributable,'Resultatdispositionen måste stämma med fritt eget kapital.');
  assert(data.dividendReviewed===true,'Granska utdelningsförslag och försiktighetsregel.');
  assert(Number.isFinite(data.averageEmployees)&&data.averageEmployees>=0&&data.averageEmployees<=100000,'Ange medelantal anställda.');
  const history=periods.slice(-3).reverse().map(item=>annualFinancials(state,item.start,item.end));
  for(const item of history) assert(item.unmapped.length===0&&item.report.balanced,'Historiska jämförelsetal behöver stämmas av.');
  return {current,previous,history,distributable,dividend,carried};
}
export function buildAnnualReportHtml(state,data) {
  organisationNumber(data.orgNumber);text(data.name,'Företagsnamn',200);assert(data.reviewed===true,'Årsredovisningen måste granskas före export.');
  const {current,previous,history,distributable,dividend,carried}=annualParts(state,data);
  const esc=xml;const paragraph=value=>`<p>${esc(value).replaceAll('\n','<br>')}</p>`;
  const row=(label,value,old)=>`<tr><th>${esc(label)}</th><td>${formatMoney(value)}</td><td>${old===undefined?'—':formatMoney(old)}</td></tr>`;
  const table=(title,rows)=>`<h2>${title}</h2><table><thead><tr><th>Belopp i kronor</th><th>${esc(data.start)}–${esc(data.end)}</th><th>${previous?`${esc(previous.report.start)}–${esc(previous.report.end)}`:'Första året'}</th></tr></thead><tbody>${rows}</tbody></table>`;
  const heading=label=>`<tr><th colspan="3"><strong>${esc(label)}</strong></th></tr>`;
  const resultLine=key=>{const [,label,,sign]=incomeGroups.find(group=>group[0]===key);return row(label,current.income[key]*sign,previous?previous.income[key]*sign:undefined);};
  const subtotal=(label,read)=>row(label,read(current),previous?read(previous):undefined);
  const operating=value=>value.income.turnover+value.income.otherIncome-value.income.material-value.income.external-value.income.staff-value.income.depreciation-value.income.otherCost;
  const beforeTax=value=>operating(value)+value.income.interestIncome-value.income.interestCost;
  const income=['turnover','otherIncome'].map(resultLine).join('')+subtotal('Summa rörelseintäkter',value=>value.income.turnover+value.income.otherIncome)+heading('Rörelsekostnader')+['material','external','staff','depreciation','otherCost'].map(resultLine).join('')+subtotal('Rörelseresultat',operating)+heading('Resultat från finansiella poster')+['interestIncome','interestCost'].map(resultLine).join('')+subtotal('Resultat efter finansiella poster',beforeTax)+subtotal('Resultat före skatt',beforeTax)+resultLine('tax')+row('Årets resultat',current.report.resultCents,previous?.report.resultCents);
  const balanceLine=(key,label)=>row(label??statementGroups.find(group=>group[0]===key)[1],current.balance[key],previous?.balance[key]);
  const balanceSum=(label,keys)=>subtotal(label,value=>sum(keys.map(key=>value.balance[key])));
  const currentAssets=['inventory','receivables','otherReceivables','prepaid','bank'],shortDebt=['tradeDebt','customerAdvances','taxDebt','otherDebt','accrued'];
  const balance=heading('TILLGÅNGAR')+heading('Anläggningstillgångar')+heading('Materiella anläggningstillgångar')+balanceLine('fixed','Inventarier, verktyg och installationer')+balanceSum('Summa anläggningstillgångar',['fixed'])+heading('Omsättningstillgångar')+heading('Varulager m.m.')+balanceLine('inventory','Färdiga varor och handelsvaror')+heading('Kortfristiga fordringar')+['receivables','otherReceivables','prepaid'].map(key=>balanceLine(key)).join('')+balanceSum('Summa kortfristiga fordringar',['receivables','otherReceivables','prepaid'])+balanceLine('bank')+balanceSum('Summa omsättningstillgångar',currentAssets)+subtotal('SUMMA TILLGÅNGAR',value=>value.statementAssetsCents)+heading('EGET KAPITAL OCH SKULDER')+heading('Eget kapital')+heading('Bundet eget kapital')+balanceLine('shareCapital')+heading('Fritt eget kapital')+['retained','yearProfit'].map(key=>balanceLine(key)).join('')+balanceSum('Summa eget kapital',['shareCapital','retained','yearProfit'])+heading('Långfristiga skulder')+balanceLine('longDebt')+balanceSum('Summa långfristiga skulder',['longDebt'])+heading('Kortfristiga skulder')+shortDebt.map(key=>balanceLine(key)).join('')+balanceSum('Summa kortfristiga skulder',shortDebt)+subtotal('SUMMA EGET KAPITAL OCH SKULDER',value=>value.statementLiabilitiesCents);
  const equityRows=['shareCapital','retained','yearProfit'].map(key=>row(statementGroups.find(group=>group[0]===key)[1],current.balance[key],previous?.balance[key])).join('');
  const years=[current,...history];
  const overview=`<h2>Flerårsöversikt</h2><table><thead><tr><th>Belopp i kronor</th>${years.map(year=>`<th>${esc(year.report.end)}</th>`).join('')}</tr></thead><tbody>${[['Nettoomsättning',year=>formatMoney(year.income.turnover)],['Resultat efter finansiella poster',year=>formatMoney(year.report.resultCents+year.income.tax)],['Balansomslutning',year=>formatMoney(year.statementAssetsCents)],['Soliditet, %',year=>year.statementAssetsCents?((year.balance.shareCapital+year.balance.retained+year.balance.yearProfit)/year.statementAssetsCents*100).toFixed(1):'—']].map(([label,read])=>`<tr><th>${esc(label)}</th>${years.map(year=>`<td>${read(year)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const eqAccounts=['2081','2091','2098','2099'];const eqOpening=-sum(current.report.accounts.filter(item=>eqAccounts.includes(item.number)).map(item=>item.openingCents));
  const eqClosing=sum([current.balance.shareCapital,current.balance.retained,current.balance.yearProfit]);
  const movementTable=`<table><tbody>${row('Ingående eget kapital',eqOpening)}${row('Årets resultat',current.report.resultCents)}${row('Övriga förändringar, specificerade nedan',eqClosing-eqOpening-current.report.resultCents)}${row('Utgående eget kapital',eqClosing)}</tbody></table>`;
  const policies=`Årsredovisningen har upprättats enligt årsredovisningslagen och BFNAR 2016:10 (K2) för den angivna tillämpningen. ${data.accountingPolicies}`;
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>Årsredovisning ${esc(data.name)} ${esc(data.end)}</title><style>body{font:14px Georgia,serif;color:#162536;max-width:900px;margin:32px auto;padding:0 24px}h1{font-size:30px}h2{margin-top:32px}table{width:100%;border-collapse:collapse}th,td{padding:7px;border-bottom:1px solid #ccd3db;text-align:left}td{text-align:right;font-variant-numeric:tabular-nums}p{line-height:1.6}.signature{display:inline-block;min-width:240px;margin:35px 24px 10px 0;padding-top:12px;border-top:1px solid #444}.note{color:#536172;font-size:12px}@media print{body{margin:0;max-width:none}h2,h3{break-after:avoid}tr,.signature{break-inside:avoid}}</style></head><body><h1>Årsredovisning</h1><h2>${esc(data.name)}</h2><p>Organisationsnummer ${esc(organisationNumber(data.orgNumber))}<br>Räkenskapsår ${esc(data.start)}–${esc(data.end)}<br>Säte ${esc(data.registeredOffice)}</p><h2>Förvaltningsberättelse</h2>${paragraph(data.managementReport)}<h3>Väsentliga händelser under räkenskapsåret</h3>${paragraph(data.events)}${overview}${data.turnoverChangeNote?paragraph(data.turnoverChangeNote):''}<h3>Förändringar i eget kapital</h3>${movementTable}${table('Eget kapital per post',equityRows)}${paragraph(data.equityNote)}<h3>Förslag till resultatdisposition</h3><p>Till årsstämmans förfogande står ${formatMoney(distributable)} kr. Styrelsen föreslår utdelning ${formatMoney(dividend)} kr och att ${formatMoney(carried)} kr balanseras i ny räkning.</p>${table('Resultaträkning',income)}${table('Balansräkning',balance)}<h2>Noter</h2><h3>1. Redovisningsprinciper</h3>${paragraph(policies)}<h3>2. Materiella anläggningstillgångar</h3>${paragraph(data.assetNote)}<h3>3. Anställda och personalkostnader</h3><p>Medelantal anställda: ${esc(data.averageEmployees)}.</p>${paragraph(data.employeeNote)}<h3>4. Ställda säkerheter och eventualförpliktelser</h3>${paragraph(data.securityNote)}<h3>5. Långfristiga skulder</h3>${paragraph(data.debtNote)}<h3>6. Lån och transaktioner med närstående</h3>${paragraph(data.relatedPartyNote)}<h3>7. Skatt på årets resultat</h3>${paragraph(data.taxNote)}<h3>8. Väsentliga händelser efter räkenskapsårets slut</h3>${paragraph(data.postBalanceEvents)}${data.otherNotes?`<h3>Övriga upplysningar</h3>${paragraph(data.otherNotes)}`:''}<h2>Underskrifter</h2><p>${esc(data.signaturePlace)} ${esc(data.signatureDate)}</p>${data.signatories.map(signer=>`<div class="signature">${esc(signer.name)}<br>${esc(signer.role)}</div>`).join('')}<p class="note">Undertecknas av samtliga styrelseledamöter och eventuell VD. Därefter tillkommer eventuell revisionsberättelse och fastställelseintyg vid inlämning. Genererad från granskat underlag; filen utgör inte en digital underskrift eller en inlämningskvittens.</p></body></html>`;
}

function sourceFor(state,payload) {
  if(payload.kind==='agi') return getAgiPeople(state,payload.month);
  if(payload.kind==='vat'){const r=getTaxDeclarationReport(state,{from:payload.from,to:payload.to});return {boxes:r.boxes,warnings:r.warnings,evidence:r.evidence};}
  if(payload.kind==='sru'||payload.kind==='annual') return {...getYearReports(state,{start:payload.start,end:payload.end}),rescontra:getDeclarationRescontra(state,payload.end)};
  throw new Error('Välj deklarationstyp.');
}
export function createDeclaration(state,input) {
  const payload=structuredClone(input);assert(['agi','vat','sru','annual'].includes(payload.kind),'Välj deklarationstyp.');assert(payload.reviewed===true,'Granska underlaget före sparande.');
  payload.createdAt=payload.createdAt??new Date().toISOString();payload.orgNumber=organisationNumber(payload.orgNumber);
  const source=sourceFor(state,payload);
  if(payload.kind==='agi') {
    assert(Array.isArray(payload.people)&&payload.people.length===source.length,'Alla personer i den utbetalda lönen ska ingå i AGI.');
    payload.people=source.map(row=>{const person=payload.people.find(item=>item.employeeId===row.employeeId);assert(person,'Personuppgifter saknas för en anställd.');return {...row,personalNumber:person.personalNumber,specification:person.specification};});
    for(const person of payload.people)for(const id of person.sourceBatchIds){const batch=state.payrollBatches.find(item=>item.id===id);const row=batch.people.find(item=>item.employeeId===person.employeeId);assert(Number(personalNumber(person.personalNumber).slice(0,4))===row.profile.birthYear,'Personnumrets födelseår stämmer inte med den avgiftsgrundande löneprofilen. Granska lönekörningen.');}
    const earlier=(state.declarations??[]).filter(item=>item.kind==='agi'&&item.payload.month===payload.month);
    for(const person of payload.people){const previous=earlier.flatMap(item=>item.payload.people).find(item=>item.employeeId===person.employeeId);if(previous)assert(personalNumber(previous.personalNumber)===personalNumber(person.personalNumber)&&Number(previous.specification)===Number(person.specification),'En rättelse måste behålla personnummer och specifikationsnummer. Identitetsbyte kräver separat borttagning hos Skatteverket.');}
    buildAgiXml(payload);
  } else if(payload.kind==='vat') {
    const bounds=getVatPeriodBounds(state,payload.from);assert(bounds.from===payload.from&&bounds.to===payload.to,'Momsperioden måste stämma med bolagets registrerade månad, kvartal eller räkenskapsår.');
    assert(source.warnings.length===0,'Momsrapporten innehåller oklassificerade eller oavstämda poster. Granska dem innan export.');payload.boxes=source.boxes;buildVatXml(payload);
  } else if(payload.kind==='sru') {
    assert(payload.manualReconciliationConfirmed===true,'Stäm av samtliga manuella SRU-rutor och eventuell omappad bokföring.');
    assert(getDeclarationRescontra(state,payload.end).unknown.length===0,'Reskontran innehåller 1510/2440-poster utan dokumentkoppling. Stäm av och koppla dem före SRU-export; nettosaldo kan dölja krediter.');buildSruFiles(payload);
  } else buildAnnualReportHtml(state,payload);
  const sourceSnapshot=JSON.stringify(source);
  return transact(state,draft=>{draft.declarations??=[];const record={id:nextId(draft,'declaration'),kind:payload.kind,date:payload.createdAt.slice(0,10),version:DECLARATION_VERSION,payload,payloadSnapshot:JSON.stringify(payload),source,sourceSnapshot};draft.declarations.push(record);addActivity(draft,`Granskat underlag sparat: ${payload.kind.toUpperCase()}. Ingen deklaration har lämnats.`,record.id);});
}
export function validateDeclarations(state) {
  assert(state.declarations===undefined||Array.isArray(state.declarations)&&state.declarations.length<=1000,'Deklarationsarkivet har fel format.');
  const ids=new Set();for(const item of state.declarations??[]){assert(item&&typeof item.id==='string'&&!ids.has(item.id)&&['agi','vat','sru','annual'].includes(item.kind)&&item.version===DECLARATION_VERSION,'Deklarationsposten är ogiltig.');ids.add(item.id);assert(JSON.stringify(item.payload)===item.payloadSnapshot&&JSON.stringify(item.source)===item.sourceSnapshot&&item.payload.reviewed===true,'Ett sparat deklarationsunderlag har ändrats.');organisationNumber(item.payload.orgNumber);timestamp(item.payload.createdAt);}
}
export function getDeclarationFile(state,id) {
  validateDeclarations(state);const record=(state.declarations??[]).find(item=>item.id===id);assert(record,'Deklarationen saknas.');
  assert(JSON.stringify(sourceFor(state,record.payload))===record.sourceSnapshot,'Bokföringsunderlaget har ändrats. Skapa och granska en ny deklarationsversion.');
  const data=record.payload;
  if(record.kind==='agi')return {name:`arbetsgivardeklaration-${data.month}.xml`,value:buildAgiXml(data),type:'application/xml;charset=utf-8'};
  if(record.kind==='vat')return {name:`momsdeklaration-${data.to}.xml`,value:buildVatXml(data),type:'application/xml;charset=iso-8859-1'};
  if(record.kind==='sru')return {name:`inkomstdeklaration-${data.end}.zip`,value:zipFiles(buildSruFiles(data)),type:'application/zip'};
  return {name:`arsredovisning-${data.end}.html`,value:buildAnnualReportHtml(state,data),type:'text/html;charset=utf-8'};
}
