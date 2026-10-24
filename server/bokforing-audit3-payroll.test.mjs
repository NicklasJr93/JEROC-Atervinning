import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, accountBalance, transact, appendEntry } from '../public/bokforing/suite/core.js';
import { createEmployee, closeYear, lockPeriod } from '../public/bokforing/suite/finance.js';
import { savePayrollProfile, createPayrollBatch, postPayrollBatch, payPayrollBatch, reversePayrollBatch, settlePayrollBatchTaxes, createPayrollRecovery, reviewPayrollAnnualContributions, getPayrollDeclarationPeople, validatePayrollBatches } from '../public/bokforing/suite/payroll-engine.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { createDeclaration, getDeclarationFile } from '../public/bokforing/suite/declarations.js';
import { openNextYear, exportYearReview } from '../public/bokforing/suite/financial-years.js';
import { renderWorkspace } from '../public/bokforing/suite/payroll-workspace.js';

// Reproducible combinatorial integration cases, not random repetitions. The five
// families combine independent dimensions of the 2026 statutory contribution
// rates, annual threshold, taxable benefits, monthly cap, recovery and withholding.
// Expected amounts are integer arithmetic from the published rate/limit constants;
// the production calculator and annualContributionSchedule are never the oracle.
// Sources: SAL 2:14/24; SFL 10:4; Skatteverket's 2026 employer-contribution guidance.
// https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/socialavgiftslag-2000980_sfs-2000-980/
// https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/arbetsgivaravgifter.4.233f91f71260075abe8800020817.html
let number=0;
function audit(name,fn){const id=String(++number).padStart(3,'0');test(`AUDIT3-PAY-${id} ${name}`,fn);}
const rounded=(n,bps)=>Number((BigInt(n)*BigInt(bps)+5000n)/10000n);
function independentFee(n,birth,date){
  if(birth<=1937)return 0;
  if(birth<=1958)return rounded(n,1021);
  if(birth>=2003&&birth<=2007&&date>='2026-04-01')return rounded(Math.min(n,2500000),2081)+rounded(Math.max(0,n-2500000),3142);
  return rounded(n,3142);
}
const profile=(id,birth,forecast='below-1000')=>({employeeId:id,date:'2026-01-01',birthYear:birth,taxMode:'decision',taxDecisionReference:'Fiktivt manuellt skattebeslut',table:32,column:1,weeklyHoursHundredths:4000,deductionHourlyCents:1,vacationMethod:'same-pay',vacationSupplementBps:43,vacationPercentBps:1200,paidVacationDays:25,agreementNote:'Fiktivt granskat avtal',reviewed:true,domesticOrdinary:true,contributionAnnualExpectation:forecast,contributionAnnualReference:'Granskad prognos för testets uttryckliga belopp'});
function add(s,birth,forecast='below-1000'){s=createEmployee(s,{name:`Fiktiv person ${birth}-${s.employees.length}`,payType:'monthly',baseCents:1});return savePayrollProfile(s,profile(s.employees.at(-1).id,birth,forecast));}
function setup(birth,forecast){return add(createEmptyState(),birth,forecast);}
function post(s,date,{gross=1,benefit=0,reimbursement=0,manualTax=0,kind='regular',employeeId=s.employees[0].id,zero=false}={}){
  s=createPayrollBatch(s,{date,people:[{employeeId,scheduledHoursHundredths:16000,kind,additionalGrossCents:kind==='regular'?Math.max(0,gross-1):gross,benefitCents:benefit,reimbursementCents:reimbursement,manualTaxCents:manualTax,...(zero?{unpaidHoursHundredths:100}:{})}]});
  return postPayrollBatch(s,s.payrollBatches.at(-1).id,{reviewed:true});
}
function pay(s,date,row={}){s=post(s,date,row);return payPayrollBatch(s,s.payrollBatches.at(-1).id,{date});}
const declaration=(s,month,id=s.employees[0].id)=>getPayrollDeclarationPeople(s,month).find(p=>p.employeeId===id);
function restored(s){const copy=JSON.parse(JSON.stringify(s));validateSuiteState(copy);return copy;}
const years=[1937,1958,1985,2004];

// 001–060: just below/at/above the annual limit, with separately varied cash,
// benefits and excluded reimbursements; crossing occurs after the youth change.
for(const birth of years)for(let i=0;i<15;i++)audit(`annual three-period threshold birth${birth} total${99986+2*i} with benefits${i*203}`,()=>{
  const first=20001+71*i,second=31003+37*i,total=99986+2*i,third=total-first-second;
  const b1=11*i,b2=19*i,b3=173*i,g1=first-b1,g2=second-b2,g3=third-b3;
  let s=pay(setup(birth),'2026-01-25',{gross:g1,benefit:b1,reimbursement:30001+i});
  s=pay(s,'2026-02-25',{gross:g2,benefit:b2,reimbursement:70003+3*i});
  const before=JSON.stringify(s.payrollBatches);
  s=pay(s,'2026-04-25',{gross:g3,benefit:b3,reimbursement:90007+7*i});
  assert.equal(JSON.stringify(s.payrollBatches.slice(0,2)),before);
  const expected=total<100000?0:independentFee(total,birth,'2026-04-25');
  assert.equal(accountBalance(s,'7510'),expected);
  const p=declaration(s,'2026-04');assert.equal(p.employerCents,expected);
  assert.equal(p.grossCents,g3);assert.equal(p.benefitCents,b3);
  assert.equal(p.previouslyReportedCents,total<100000?0:first+second);
  assert.equal(p.contributionGrossCents,total<100000?0:g1+g2+g3);
  assert.equal(p.contributionBenefitCents,total<100000?0:b1+b2+b3);
  assert.equal(p.exemptGrossCents,total<100000?g3:0);
  assert.equal(accountBalance(s,'1930'),-(g1+g2+g3+30001+i+70003+3*i+90007+7*i));
  assert.equal(declaration(s,'2026-01').exemptGrossCents,g1);
  restored(s);
});

// 061–110: monthly accumulation around the 25,000 SEK youth cap. Cash and
// benefits jointly consume the cap; supplements use only its remaining portion.
for(const birth of [1937,1958,1985,2003,2008])for(let i=0;i<10;i++)audit(`monthly cap birth${birth} first${2499000+i*137} supplement${1057+i*29}`,()=>{
  const first=2499000+137*i,second=1057+29*i,b1=53*i,b2=17*i;
  let s=pay(setup(birth,'at-least-1000'),'2026-05-05',{gross:first-b1,benefit:b1});const original=JSON.stringify(s.payrollBatches[0]);
  s=pay(s,'2026-05-20',{gross:second-b2,benefit:b2,kind:'supplement'});
  const firstFee=independentFee(first,birth,'2026-05-05'),allFee=independentFee(first+second,birth,'2026-05-20');
  assert.equal(s.payrollBatches[0].people[0].employerCents,firstFee);
  assert.equal(s.payrollBatches[1].people[0].employerCents,allFee-firstFee);
  assert.equal(accountBalance(s,'7510'),allFee);
  assert.equal(JSON.stringify(s.payrollBatches[0]),original);
  const p=declaration(s,'2026-05');assert.equal(p.previouslyReportedCents,0);assert.equal(p.contributionGrossCents,first+second-b1-b2);assert.equal(p.contributionBenefitCents,b1+b2);assert.equal(p.employerCents,allFee);
  restored(s);
});

// 111–150: repayment reduces the year below the limit, then a later salary
// crosses it again at a potentially different contribution rate.
for(const birth of years)for(let i=0;i<10;i++)audit(`recovery and recross birth${birth} recovered${2000+i*53}`,()=>{
  const first=40000+17*i,second=61000+31*i,recovered=2000+53*i,remaining=first+second-recovered,third=1300+7*i;
  let s=pay(setup(birth),'2026-01-25',{gross:first});s=pay(s,'2026-02-25',{gross:second});
  assert.equal(accountBalance(s,'7510'),independentFee(first+second,birth,'2026-02-25'));
  const original=JSON.stringify(s.payrollBatches);
  s=createPayrollRecovery(s,{batchId:s.payrollBatches[1].id,employeeId:s.employees[0].id,date:'2026-03-02',grossCents:recovered,component:'salary',taxClass:'periodic',reason:'Fiktivt verifierat återkrav',reference:`RECROSS-${birth}-${i}`,reviewed:true,agiCorrectionConfirmed:true});
  assert.equal(accountBalance(s,'7510'),0);assert.equal(declaration(s,'2026-02').exemptGrossCents,second-recovered);
  s=pay(s,'2026-05-25',{gross:third});assert.equal(JSON.stringify(s.payrollBatches.slice(0,2)),original);
  const p=declaration(s,'2026-05'),expected=independentFee(remaining+third,birth,'2026-05-25');
  assert.equal(p.previouslyReportedCents,remaining);assert.equal(p.contributionGrossCents,remaining+third);assert.equal(p.employerCents,expected);assert.equal(accountBalance(s,'7510'),expected);
  assert.equal(s.payrollRecoveries[0].grossCents,recovered);restored(s);
});

// 151–180: final review gates payments even when the queued cash/benefit
// does not cross 1,000 SEK, and even for all-or-nothing multiple-person payouts.
for(const mode of ['cash','benefit-only','two-people'])for(let i=0;i<10;i++)audit(`final review ${mode} queued after salary${20001+i*113}`,()=>{
  const birth=i%2?2004:1985,first=20001+113*i,next=30007+59*i;
  let s=pay(setup(birth),'2026-01-25',{gross:first});
  const priorEntryCount=s.entries.length;
  if(mode==='two-people'){
    s=add(s,1958);s=createPayrollBatch(s,{date:'2026-02-25',people:[{employeeId:s.employees[0].id,scheduledHoursHundredths:16000,additionalGrossCents:next-1},{employeeId:s.employees[1].id,scheduledHoursHundredths:16000,additionalGrossCents:17000+47*i}]});
    s=postPayrollBatch(s,s.payrollBatches.at(-1).id,{reviewed:true});
  }else s=post(s,'2026-02-25',mode==='cash'?{gross:next}:{zero:true,gross:0,benefit:next});
  const id=s.payrollBatches.at(-1).id;
  if(mode==='benefit-only') {
    assert.equal(s.payrollBatches.at(-1).entryId,null);assert.equal(s.entries.length,priorEntryCount);
    assert.match(renderWorkspace(s),/Bekräfta förmån utan utbetalning/);
    assert.match(renderWorkspace(s),/utan verifikation/);
    if(i===0){
      const missingLog=structuredClone(s);missingLog.activity=missingLog.activity.filter(event=>event.id!==s.payrollBatches.at(-1).postingActivityId);assert.throws(()=>validatePayrollBatches(missingLog),/spårbara/);
      const orphan=transact(s,draft=>appendEntry(draft,{date:'2026-02-25',description:'Olovlig förmånspost',sourceType:'payroll-v2',sourceId:id,rows:[{account:'1930',debitCents:1,creditCents:0},{account:'2091',debitCents:0,creditCents:1}]}));assert.throws(()=>validatePayrollBatches(orphan),/saknar ett verifierbart/);
      const original=s.payrollBatches.at(-1).snapshot;const reversed=reversePayrollBatch(s,id,{date:'2026-02-26',reason:'Förmånen upphörde före rapportering'});assert.equal(reversed.entries.length,s.entries.length);assert.equal(reversed.payrollBatches.at(-1).reversal.entryId,null);assert.equal(reversed.payrollBatches.at(-1).snapshot,original);restored(reversed);assert.match(renderWorkspace(reversed),/Originalunderlaget finns kvar/);
      const missingReversal=structuredClone(reversed);missingReversal.payrollBatches.at(-1).reversal.activityId='missing-activity';assert.throws(()=>validatePayrollBatches(missingReversal),/spårbar händelse/);
    }
  } else if(mode==='cash' && i===0){const lost=structuredClone(s);lost.payrollBatches.at(-1).entryId=null;assert.throws(()=>validatePayrollBatches(lost),/verifikation/);}
  s=reviewPayrollAnnualContributions(s,{employeeId:s.employees[0].id,year:2026,date:'2026-02-01',reference:`FINAL-${mode}-${i}`,reviewed:true,finalBelowThreshold:true});
  const before=JSON.stringify(s),review=JSON.stringify(s.payrollContributionReviews.at(-1));
  assert.throws(()=>payPayrollBatch(s,id,{date:'2026-02-25'}),/slutligt/);assert.equal(JSON.stringify(s),before);
  s=reviewPayrollAnnualContributions(s,{employeeId:s.employees[0].id,year:2026,date:'2026-02-02',reference:`REOPEN-${mode}-${i}`,reviewed:true,finalBelowThreshold:false});
  s=payPayrollBatch(s,id,{date:'2026-02-25'});assert.equal(s.payrollBatches.at(-1).status,'paid');assert.equal(accountBalance(s,'7510'),0);assert.equal(JSON.stringify(s.payrollContributionReviews.find(x=>x.reference===`FINAL-${mode}-${i}`)),review);
  if(mode==='benefit-only'){
    assert.deepEqual(s.payrollBatches.at(-1).payments,[]);assert.equal(s.entries.length,priorEntryCount);
    assert.throws(()=>createPayrollRecovery(s,{batchId:id,employeeId:s.employees[0].id,date:'2026-03-01',grossCents:1,component:'salary',taxClass:'periodic',reason:'Inte ett kontant återkrav',reference:'INVALID',reviewed:true,agiCorrectionConfirmed:true}),/överstiger utbetalt/);
    if(i===0){
      s=createDeclaration(s,{kind:'agi',month:'2026-02',orgNumber:s.company.orgNumber,createdAt:'2026-03-01T12:00:00Z',contactName:'Fiktiv testkontakt',contactPhone:'0701234567',contactEmail:'audit@example.invalid',domesticOrdinary:true,reviewed:true,absenceReviewed:true,people:[{employeeId:s.employees[0].id,personalNumber:'198501011236',specification:1}]});
      const xml=getDeclarationFile(s,s.declarations.at(-1).id).value;assert.match(xml,/<agd:SkatteplOvrigaFormanerEjUlagSA[^>]*>300<\/agd:SkatteplOvrigaFormanerEjUlagSA>/);assert.ok(!xml.includes('<agd:KontantErsattningUlagAG'));
      const before=JSON.stringify(s.payrollBatches.at(-1));for(const batch of s.payrollBatches)s=settlePayrollBatchTaxes(s,batch.id,{date:'2026-03-01'});
      for(let m=1;m<=12;m++)s=lockPeriod(s,`2026-${String(m).padStart(2,'0')}`);s=closeYear(s,{date:'2026-12-31',confirmed:true});s=openNextYear(s,{confirmed:true});
      const archived=exportYearReview(s,'2026-01-01','2026-12-31').sourceExtensions.payrollBatches.find(item=>item.id===id);assert.equal(archived.entryId,null);assert.equal(archived.status,'paid');assert.equal(archived.snapshot,JSON.parse(before).snapshot);
    }
  }
  restored(s);
});

// 181–200: the 100 SEK payment rule uses taxable compensation, whereas the
// annual forecast is separate. Reimbursement must not activate withholding.
for(const forecast of ['below-1000','at-least-1000'])for(let i=0;i<10;i++)audit(`withholding ${forecast} taxable${9995+i} cash8000 reimbursement${60001+i*19}`,()=>{
  const gross=8000,benefit=1995+i,reimbursement=60001+19*i;
  let s=pay(setup(1985,forecast),'2026-01-25',{gross,benefit,reimbursement,manualTax:500});
  const firstTax=forecast==='at-least-1000'&&gross+benefit>=10000?500:0;
  assert.equal(s.payrollBatches[0].people[0].withholdingCents,firstTax);
  assert.equal(accountBalance(s,'1930'),-(gross+reimbursement-firstTax));
  s=pay(s,'2026-02-25',{gross:20000,manualTax:700});
  const secondTax=forecast==='at-least-1000'?700:0;
  assert.equal(s.payrollBatches[1].people[0].withholdingCents,secondTax);
  assert.equal(accountBalance(s,'2710'),-(firstTax+secondTax)||0);assert.equal(accountBalance(s,'7510'),0);
  assert.equal(declaration(s,'2026-01').exemptGrossCents,gross);assert.equal(declaration(s,'2026-01').exemptBenefitCents,benefit);
  restored(s);
});
assert.equal(number,200,'The audit matrix must contain exactly 200 uniquely numbered cases.');
