import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createEmptyState, transact, appendEntry } from '../public/bokforing/suite/core.js';
import { closeYear, lockPeriod, fileVatPeriod } from '../public/bokforing/suite/finance.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { buildAgiXml, buildVatXml, buildSruFiles, zipFiles, encodeLatin1, organisationNumber, personalNumber, createDeclaration, getDeclarationFile, suggestSruFields, buildAnnualReportHtml, validateDeclarations, SRU_FIELDS, getDeclarationRescontra } from '../public/bokforing/suite/declarations.js';
import { createCustomer, createInvoice, issueInvoice, receivePayment } from '../public/bokforing/suite/sales.js';
import { createBill, bookBill, payBill } from '../public/bokforing/suite/operations.js';
import { createCreditNote, refundCredit } from '../public/bokforing/suite/settlements.js';
import { createFxDocument, issueFxDocument, settleFxDocument, creditFxDocument, revalueFxDocument } from '../public/bokforing/suite/fx.js';
import { renderWorkspace, handleAction } from '../public/bokforing/suite/declarations-workspace.js';
const agi={kind:'agi',month:'2026-10',orgNumber:'5560269986',createdAt:'2026-10-23T12:00:00.000Z',contactName:'Kerstin Åström',contactPhone:'0101234567',contactEmail:'test@example.org',reviewed:true,domesticOrdinary:true,absenceReviewed:true,people:[]};
const agiPerson={employeeId:'employee-1',personalNumber:'198202252386',specification:1,grossCents:3200099,benefitCents:20000,withholdingCents:700009,employerCents:1012011};
function validateXsd(xml){const result=spawnSync('python',['-c',"from lxml import etree;import sys;s=etree.XMLSchema(etree.parse(sys.argv[1]));s.assertValid(etree.fromstring(sys.stdin.buffer.read()));print('valid')",'server/fixtures/bokforing-declarations/arbetsgivardeklaration_1.1.xsd'],{input:xml,encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
function initial(){return transact(createEmptyState(),draft=>appendEntry(draft,{date:'2026-01-01',description:'Aktiekapital',sourceType:'opening',sourceId:'initial',rows:[{account:'1930',debitCents:2500000,creditCents:0},{account:'2081',debitCents:0,creditCents:2500000}]}));}
function profitable(){return transact(initial(),draft=>{appendEntry(draft,{date:'2026-10-01',description:'Intäkt utan moms i testunderlag',sourceType:'manual',sourceId:'sale',rows:[{account:'1930',debitCents:500000,creditCents:0},{account:'3000',debitCents:0,creditCents:500000}]});appendEntry(draft,{date:'2026-12-31',description:'Beräknad skatt',sourceType:'manual',sourceId:'tax',rows:[{account:'8910',debitCents:103000,creditCents:0},{account:'2510',debitCents:0,creditCents:103000}]});});}
function sru(state=profitable()){return {kind:'sru',orgNumber:'5560269986',createdAt:agi.createdAt,start:'2026-01-01',end:'2026-12-31',name:'Åkes Hantverk AB',postalCode:'12345',city:'Örebro',forms:suggestSruFields(state).forms,reviewed:true,manualReconciliationConfirmed:true};}
function closed(state=profitable()){for(let m=1;m<=12;m++)state=lockPeriod(state,`2026-${String(m).padStart(2,'0')}`);return closeYear(state,{date:'2026-12-31',confirmed:true});}
const annual={kind:'annual',orgNumber:'5560269986',name:'Åkes Hantverk AB',start:'2026-01-01',end:'2026-12-31',createdAt:agi.createdAt,reviewed:true,firstYear:true,smallPrivateAB:true,scopeReviewed:true,registeredOffice:'Örebro',signaturePlace:'Örebro',signatureDate:'2027-02-01',managementReport:'Bolaget bedriver hantverksverksamhet.',events:'Inga väsentliga händelser.',postBalanceEvents:'Inga väsentliga händelser efter balansdagen.',equityNote:'Aktiekapital betalades in under året. Ingen utdelning.',accountingPolicies:'Belopp i kronor. Anskaffningsvärdemetoden används.',assetNote:'Inga anläggningstillgångar.',employeeNote:'Inga anställda.',securityNote:'Inga ställda säkerheter eller eventualförpliktelser.',debtNote:'Inga skulder förfaller senare än fem år.',relatedPartyNote:'Inga lån eller säkerheter till närstående.',taxNote:'Aktuell skatt 1 030 kr.',averageEmployees:0,dividendCents:0,dividendReviewed:true,allSignatoriesConfirmed:true,signatories:[{name:'Åke & Anna',role:'Styrelseledamot'}]};

test('official AGI schemas are pinned by SHA-256 and actual outputs validate against XSD',()=>{
 const files=[['arbetsgivardeklaration_1.1.xsd','821f4a5b896cb13bda1bb700f5ca3302f2a30b6e7446c5c96c9790c0690e4b4b'],['arbetsgivardeklaration_component_1.1.xsd','ed8926751d7691f34a1294e7fd623fbcb9f1ef2f831b414a3006910aead9b0cd']];
 for(const [name,checksum]of files)assert.equal(createHash('sha256').update(readFileSync(`server/fixtures/bokforing-declarations/${name}`)).digest('hex'),checksum);
 validateXsd(buildAgiXml(agi));
 const xml=buildAgiXml({...agi,people:[agiPerson],absences:[{employeeId:'employee-1',date:'2026-10-12',type:'FORALDRAPENNING',specification:1,hoursHundredths:800}]});validateXsd(xml);assert.match(xml,/>32000<\/agd:KontantErsattningUlagAG>/);assert.match(xml,/Åström/);assert.match(xml,/8.00<\/agd:FranvaroTimmarFP>/);
});
test('AGI rejects fictitious identity, wrong digits, duplicate specifications, unsafe scope and malformed absence',()=>{
 assert.equal(organisationNumber('165560269986'),'5560269986');assert.equal(personalNumber('19820225-2386'),'198202252386');
 for(const bad of [{orgNumber:'DEMO'},{orgNumber:'5560269987'},{reviewed:false},{domesticOrdinary:false},{absenceReviewed:false},{month:'2027-01'}])assert.throws(()=>buildAgiXml({...agi,...bad}));
 assert.throws(()=>buildAgiXml({...agi,people:[agiPerson,{...agiPerson}]}),/dubblerat/);
 assert.throws(()=>buildAgiXml({...agi,people:[{...agiPerson,personalNumber:'198202252387'}]}),/kontrollsiffra/);
 assert.throws(()=>buildAgiXml({...agi,people:[agiPerson],absences:[{employeeId:'employee-1',date:'2026-09-30',type:'FORALDRAPENNING',specification:1,hoursHundredths:800}]}),/valda redovisningsmånaden/);
 assert.throws(()=>buildAgiXml({...agi,people:[agiPerson],absences:{}}),/Frånvarolistan/);
});
test('VAT whole-krona total reconciles individually truncated fields including negative repayment',()=>{
 const xml=buildVatXml({orgNumber:'5560269986',from:'2026-10-01',to:'2026-12-31',reviewed:true,boxes:{'10':10099,'11':10099,'48':5000,'49':15198},note:'Åter & övrigt'});
 assert.match(xml,/<MomsBetala>150<\/MomsBetala>/);assert.match(xml,/<OrgNr>556026-9986<\/OrgNr>/);assert.match(xml,/&#197;ter &amp; &#246;vrigt/);assert.ok([...xml].every(c=>c.charCodeAt(0)<128));
 assert.match(buildVatXml({orgNumber:'5560269986',from:'2026-10-01',to:'2026-12-31',reviewed:true,boxes:{'48':10000,'49':-10000}}),/<MomsBetala>-100<\/MomsBetala>/);
 assert.throws(()=>buildVatXml({orgNumber:'5560269986',from:'2026-10-02',to:'2026-12-30',reviewed:true,boxes:{}}),/hela kalendermånader/);
});
test('VAT export enforces company reporting interval and does not modify the ledger',()=>{
 const base=initial();assert.throws(()=>createDeclaration(base,{kind:'vat',orgNumber:'5560269986',from:'2026-10-01',to:'2026-10-31',reviewed:true}),/registrerade/);
 const state=createDeclaration(base,{kind:'vat',orgNumber:'5560269986',from:'2026-10-01',to:'2026-12-31',reviewed:true});assert.deepEqual(state.entries,base.entries);assert.match(getDeclarationFile(state,state.declarations[0].id).value,/<Period>202612/);validateSuiteState(state);
});
test('SRU uses official 2026P4 fields, complete form identities and actual ISO-8859-1 ZIP members',()=>{
 const data=sru(),files=buildSruFiles(data);assert.match(files['INFO.SRU'],/#ORGNR 165560269986\r\n/);assert.match(files['BLANKETTER.SRU'],/#BLANKETT INK2R-2026P4/);assert.match(files['BLANKETTER.SRU'],/#UPPGIFT 7450 3970/);assert.match(files['BLANKETTER.SRU'],/#UPPGIFT 7104 5000/);assert.match(files['BLANKETTER.SRU'],/#UPPGIFT 7012 20261231/);
 for(const [form,fields]of Object.entries(SRU_FIELDS)){assert.ok(fields.length>10,form);assert.ok(fields.some(field=>field.code==='7011'));}
 const zipped=zipFiles(files);const decoded=spawnSync('python',['-c',"import sys,zipfile,io;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));assert z.namelist()==['INFO.SRU','BLANKETTER.SRU'];assert z.testzip()==None;print(z.read('INFO.SRU').decode('iso-8859-1'));print(z.read('BLANKETTER.SRU').decode('iso-8859-1'))"],{input:zipped,encoding:'utf8'});assert.equal(decoded.status,0,decoded.stderr);assert.match(decoded.stdout,/Åkes Hantverk AB/);assert.match(decoded.stdout,/Örebro/);
});
test('SRU rejects unknown field codes, control injection, wrong year, imbalances and incorrect taxable result',()=>{
 assert.throws(()=>buildSruFiles({...sru(),name:'Bolag\r\n#FIL_SLUT'}),/radbrytning/);assert.throws(()=>buildSruFiles({...sru(),end:'2027-12-31'}),/2026P4/);assert.throws(()=>encodeLatin1('😀'),/ISO-8859-1/);
 let data=sru();data.forms.INK2R['9999']='1';assert.throws(()=>buildSruFiles(data),/Okänd fältkod/);
 data=sru();data.forms.INK2R['7281']='1';assert.throws(()=>buildSruFiles(data),/balansera/);
 data=sru();data.forms.INK2R['7410']='6000';assert.throws(()=>buildSruFiles(data),/summer[a-z]* till årets resultat/);
 data=sru();data.forms.INK2S['7651']='0';assert.throws(()=>buildSruFiles(data),/Skattejusteringarna/);
 data=sru();data.forms.INK2['7104']='4999';assert.throws(()=>buildSruFiles(data),/Skattemässigt resultat/);
});
test('saved declarations cannot be overwritten and changed accounting invalidates download',()=>{
 const base=profitable(),state=createDeclaration(base,sru(base)),id=state.declarations[0].id;assert.equal(getDeclarationFile(state,id).type,'application/zip');assert.deepEqual(state.entries,base.entries);
 const tampered=structuredClone(state);tampered.declarations[0].payload.name='Nytt namn';assert.throws(()=>validateDeclarations(tampered),/ändrats/);
 const changed=transact(state,draft=>appendEntry(draft,{date:'2026-11-01',description:'Ny bankkostnad',sourceType:'manual',sourceId:'fee',rows:[{account:'6570',debitCents:10000,creditCents:0},{account:'1930',debitCents:0,creditCents:10000}]}));assert.throws(()=>getDeclarationFile(changed,id),/ny deklarationsversion/);
 assert.throws(()=>createDeclaration(base,{...sru(base),manualReconciliationConfirmed:false}),/Stäm av/);
});
test('K2 document requires closed year, mandatory notes, result appropriation and all signatories',()=>{
 assert.throws(()=>buildAnnualReportHtml(profitable(),annual),/Avsluta/);const state=closed();
 const html=buildAnnualReportHtml(state,annual);for(const title of ['Förvaltningsberättelse','Flerårsöversikt','Soliditet','Resultaträkning','Balansräkning','Förslag till resultatdisposition','Noter','Underskrifter','Långfristiga skulder'])assert.ok(html.includes(title),title);
 assert.match(html,/Åke &amp; Anna/);assert.match(html,/3\u00a0970,00/);assert.match(html,/Ingående eget kapital/);
 for(const field of ['assetNote','debtNote','postBalanceEvents','accountingPolicies'])assert.throws(()=>buildAnnualReportHtml(state,{...annual,[field]:''}),/upplysning/);
 assert.throws(()=>buildAnnualReportHtml(state,{...annual,dividendCents:397001}),/Resultatdispositionen/);assert.throws(()=>buildAnnualReportHtml(state,{...annual,allSignatoriesConfirmed:false}),/styrelseledamöter/);
 assert.throws(()=>buildAnnualReportHtml(state,{...annual,signatureDate:'2026-01-01'}),/Underskriftsdatum/);
 const archived=createDeclaration(state,annual);assert.match(getDeclarationFile(archived,archived.declarations[0].id).name,/arsredovisning/);validateSuiteState(archived);
});
test('workspace and handlers expose real exports and explicit review gates without fake identities',()=>{
 const state=initial(),html=renderWorkspace(state);assert.match(html,/Från bokföring till inlämningsfil/);assert.match(html,/data-action="create-agi"/);assert.match(html,/data-action="create-sru"/);assert.match(html,/data-action="create-annual"/);assert.doesNotMatch(html,/value="5560269986"/);
 const saved=handleAction(state,'create-agi',{...agi,domesticOrdinary:'on',absenceReviewed:'on',reviewed:'on',employerKronor:'',absences:''});assert.match(getDeclarationFile(saved,saved.declarations[0].id).value,/Arbetsgivardeklaration/);
});

test('unknown rescontra rows are blocked instead of presenting a misleading net balance',()=>{
 const state=transact(initial(),draft=>appendEntry(draft,{date:'2026-10-01',description:'Importerat nettosaldo utan reskontra',sourceType:'manual',sourceId:'unknown',rows:[{account:'1930',debitCents:100000,creditCents:0},{account:'1510',debitCents:0,creditCents:100000}]}));
 assert.equal(getDeclarationRescontra(state,'2026-12-31').unknown.length,1);
 assert.throws(()=>createDeclaration(state,sru(state)),/dokumentkoppling/);
 assert.throws(()=>buildAnnualReportHtml(closed(state),annual),/dokumentkoppling/);
});
function nativeMixed(side){
 let state=initial();
 for(let i=0;i<2;i++){
  let id;
  if(side==='customer'){
   state=createCustomer(state,{name:'Kund '+i,email:'test@example.org'});
   state=createInvoice(state,{customerId:state.customers.at(-1).id,date:'2026-10-01',dueDate:'2026-10-31',lines:[{description:'Arbete',kind:'labor',quantity:1,unitCents:80000,vatRate:25}]});id=state.invoices.at(-1).id;state=issueInvoice(state,id);
   if(i)state=receivePayment(state,id,{date:'2026-10-02',amountCents:100000,reference:'PAY'});
  }else{
   state=createBill(state,{supplier:'Leverantör '+i,number:'L'+i,date:'2026-10-01',dueDate:'2026-10-31',netCents:80000,vatRate:25,account:'4010'});id=state.bills.at(-1).id;state=bookBill(state,id);
   if(i)state=payBill(state,id,{date:'2026-10-02',amountCents:100000,reference:'PAY'});
  }
  if(i)state=createCreditNote(state,{side,documentId:id,date:'2026-10-03',reason:'Prisjustering',reference:'C1',lines:[{index:0,netCents:24000}]});
 }
 return state;
}
test('native customer and supplier credit balances are presented gross per document and at the historical date',()=>{
 for(const side of ['customer','supplier']){
  let state=nativeMixed(side);const control=side==='customer'?'1510':'2440';
  const positions=getDeclarationRescontra(state,'2026-12-31');assert.equal(positions.unknown.length,0);assert.equal(positions[side==='customer'?'customerCreditCents':'supplierCreditCents'],30000);
  const beforeCredit=getDeclarationRescontra(state,'2026-10-02');assert.equal(beforeCredit[side==='customer'?'customerCreditCents':'supplierCreditCents'],0);
  const forms=suggestSruFields(state).forms;assert.equal(forms.INK2R[side==='customer'?'7251':'7365'],'1000');assert.equal(forms.INK2R[side==='customer'?'7362':'7261'],side==='customer'?'300':'640');buildSruFiles(sru(state));
  state=fileVatPeriod(state,{from:'2026-10-01',to:'2026-12-31',date:'2026-12-31'});const html=buildAnnualReportHtml(closed(state),annual);assert.ok(html.includes(side==='customer'?'Förskott från kunder':'Övriga fordringar'));assert.match(html,/1\u00a0000,00/);assert.match(html,side==='customer'?/Förskott från kunder<\/th><td>300,00/:/Övriga fordringar<\/th><td>640,00/);
 }
});
test('mixed FX credits use each documents SEK carrying amount, not the net control account',()=>{
 for(const side of ['customer','supplier']){
  let state=initial();
  for(let i=0;i<2;i++){
   state=createFxDocument(state,{side,currency:'EUR',number:'FX-'+side+i,date:'2026-10-01',dueDate:'2026-10-31',partyName:'Part '+i,partyAddress:'Gatan 1',sellerName:'Test AB',sellerAddress:'Gatan 2',sellerOrgNumber:'DEMO',sellerVatNumber:'SE-DEMO',paymentReference:'FX',taxTreatment:'domestic',taxReviewed:true,rate:'10',rateSource:'Granskad kurs',lines:[{description:'Arbete',foreignNetMinor:8000,vatRate:25,account:side==='customer'?'3000':'4010'}]});
   const id=state.fxDocuments.at(-1).id;state=issueFxDocument(state,id);
   if(i){state=settleFxDocument(state,id,{date:'2026-10-02',foreignMinor:10000,bankCents:100000,reference:'FX-PAY'});state=creditFxDocument(state,id,{date:'2026-10-03',lines:[{index:0,foreignNetMinor:2400}],reason:'Retur',reference:'FX-CREDIT',rate:'10',rateSource:'Granskad kurs',rateReviewed:true});}
  }
  const positions=getDeclarationRescontra(state,'2026-12-31');assert.equal(positions.unknown.length,0);assert.equal(positions[side==='customer'?'customerCreditCents':'supplierCreditCents'],30000);
  const forms=suggestSruFields(state).forms;assert.equal(forms.INK2R[side==='customer'?'7251':'7365'],'1000');assert.equal(forms.INK2R[side==='customer'?'7362':'7261'],side==='customer'?'300':'640');buildSruFiles(sru(state));
 }
});
