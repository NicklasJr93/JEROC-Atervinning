// Corrections after a credit note have their own history. Original HUS requests,
// decisions and payments remain intact; this module never submits anything.
import { assert, cents, validDate, nextId, addActivity, appendEntry, requireOpenPeriod, transact } from './core.js';
import { calculateLineAmounts } from './rot.js';
import { fiscalPeriodForDate } from './fiscal-periods.js';

const sum = values => values.reduce((a,b) => { assert(Number.isSafeInteger(a+b), 'ROT-beloppet är för stort.'); return a+b; },0);
const snapshot = value => JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key])=>key!=='snapshot')));
const text = (value,label,max=300) => { assert(typeof value==='string' && value.trim() && value.length<=max && !/[\u0000-\u001f]/.test(value),`Ange ${label}.`); return value.trim(); };
const whole = value => { cents(value); assert(value%100===0,'ROT-belopp anges i hela kronor.'); return value; };
const all = state => state.rotCreditEvents ?? [];
const eventsFor = (state,id) => all(state).filter(event=>event.invoiceId===id);
const invoiceFor = (state,id) => { const value=state.invoices.find(item=>item.id===id); assert(value?.rot && value.kind==='invoice' && value.status==='issued','Välj en utfärdad ROT-faktura.'); return value; };
const ratio = (amount,numerator,denominator) => Number((BigInt(amount)*BigInt(numerator)+BigInt(denominator)/2n)/BigInt(denominator));
const creditRecords = (state,id) => (state.settlements??[]).filter(item=>item.kind==='credit' && item.side==='customer' && item.documentId===id);
const entryIndex=(state,id)=>{const index=state.entries.findIndex(item=>item.id===id);assert(index>=0,'ROT-händelsens verifikation saknas.');return index;};
const gross = invoice => sum(invoice.lines.map(line=>calculateLineAmounts(line,invoice.vatMode,invoice.invoiceDiscountBps??0).grossCents));

export function getRotCreditState(state,invoiceId) {
  const events=eventsFor(state,invoiceId); if(!events.length)return null;
  let allowedCents=events[0].previousAllowedCents, version=0;
  for(const event of events) { if(event.kind==='credit'){allowedCents=event.allowedCents;version++;} if(event.kind==='decision')allowedCents-=event.deniedCents;if(event.kind==='recovery')allowedCents-=event.amountCents; }
  const latestCredit=events.filter(item=>item.kind==='credit').at(-1);
  const requests=events.filter(item=>item.kind==='request' && item.creditVersion===version);
  const invoice=invoiceFor(state,invoiceId);
  const repaidCents=events[0].original.rotRepaymentCents+sum(events.filter(item=>item.kind==='credit'||item.kind==='recovery').map(item=>item.kind==='credit'?item.taxRepaymentCents:item.amountCents));
  const netTaxPaidCents=sum(invoice.payments.filter(item=>item.payer==='tax').map(item=>item.amountCents))-repaidCents;
  return {events,allowedCents,creditVersion:version,latestCredit,requests,repaidCents,netTaxPaidCents,
    effectiveGrossCents:gross(invoice)-sum(creditRecords(state,invoiceId).map(item=>item.amountCents))};
}

export function getRotCreditClosingIssues(state){
  const issues=[];
  for(const invoiceId of new Set(all(state).map(item=>item.invoiceId))){
    const current=getRotCreditState(state,invoiceId),invoice=invoiceFor(state,invoiceId);
    if(current.allowedCents>current.netTaxPaidCents)issues.push({invoiceId,message:`${invoice.number}: korrigerat ROT-underlag har återstående anspråk eller beslut att hantera.`});
    for(const request of current.requests){
      const decision=current.events.find(item=>item.kind==='decision'&&item.requestId===request.id);
      const received=sum(current.events.filter(item=>item.kind==='receipt'&&item.requestId===request.id).map(item=>item.amountCents));
      if(!decision||received!==decision.approvedCents)issues.push({invoiceId,message:`${invoice.number}: rättelsebegäran ${request.reference} saknar slutligt beslut eller full registrerad utbetalning.`});
    }
  }
  return issues;
}

export function rotCreditHistoricalInvoice(state,invoice) {
  const first=eventsFor(state,invoice.id)[0]; if(!first)return invoice;
  const result={...invoice,rot:structuredClone(first.original.rot),payments:invoice.payments.filter(item=>first.original.paymentIds.includes(item.id)),rotRepaymentCents:first.original.rotRepaymentCents};
  for(const key of ['settlementCreditCents','settlementRefundCents','settlementOffsetInCents','settlementOffsetOutCents','settlementLastDate','rotCreditVersion'])delete result[key];
  return result;
}

export function rotCreditLimit(state,invoiceId) {
  const invoice=invoiceFor(state,invoiceId), credits=creditRecords(state,invoiceId);
  let labor=0;
  invoice.lines.forEach((line,index)=>{
    if(line.kind!=='labor'||line.rotEligible===false)return;
    const original=calculateLineAmounts(line,invoice.vatMode,invoice.invoiceDiscountBps??0);
    if(original.netCents===0)return;
    const credited=sum(credits.flatMap(item=>item.lines.filter(part=>part.index===index).map(part=>part.netCents)));
    assert(credited<=original.netCents,'Krediterad arbetskostnad överstiger originalet.');
    labor+=original.grossCents-ratio(original.grossCents,credited,original.netCents);
  });
  return Math.floor(Math.min(invoice.rot.reservedCents,Math.floor(labor*30/100))/100)*100;
}

export function syncRotCredit(state,invoiceId) {
  const invoice=invoiceFor(state,invoiceId), current=getRotCreditState(state,invoiceId);
  invoice.rot.approvedCents=current.allowedCents;
  invoice.rotRepaymentCents=current.repaidCents;
  invoice.rotCreditVersion=current.creditVersion;
  const balance=current.effectiveGrossCents-sum(invoice.payments.map(item=>item.amountCents))+current.repaidCents+(invoice.settlementRefundCents??0)+(invoice.settlementOffsetOutCents??0)-(invoice.settlementOffsetInCents??0);
  invoice.rot.status=balance===0?'settled':'awaiting-customer';
}
function appendEvent(state,event) {
  event.id=nextId(state,'rot-credit');event.snapshot=snapshot(event);(state.rotCreditEvents??=[]).push(event);syncRotCredit(state,event.invoiceId);return event;
}
function originalState(state,invoice) {
  return {rot:structuredClone(invoice.rot),paymentIds:invoice.payments.map(item=>item.id),rotRepaymentCents:invoice.rotRepaymentCents??0,
    plans:structuredClone((state.rotPlans??[]).filter(item=>item.invoiceId===invoice.id)),
    claims:structuredClone(state.rotClaims.filter(item=>item.invoiceId===invoice.id)),
    applications:structuredClone((state.rotApplications??[]).filter(item=>(state.rotPlans??[]).some(plan=>plan.id===item.planId&&plan.invoiceId===invoice.id))),
    repayments:structuredClone((state.rotRepayments??[]).filter(item=>item.invoiceId===invoice.id))};
}

// Called inside the same accounting transaction as the credit note. A tax
// repayment is recorded only when the user confirms that it actually occurred.
export function applyRotCreditDraft(state,invoice,credit,{rotCaseAdjusted=false,taxRefundConfirmed=false,taxReference='',reason='' }={}) {
  assert(rotCaseAdjusted===true,'Bekräfta att ROT-ärendet rättas hos Skatteverket och att det nya underlaget har granskats.');
  const current=getRotCreditState(state,invoice.id);
  const historical=current?.events[0].original??originalState(state,invoice);
  assert([...historical.plans,...historical.claims,...historical.applications,...historical.repayments].every(item=>item.date<=credit.date&&(!item.decisionDate||item.decisionDate<=credit.date)&&(!item.decision||item.decision.date<=credit.date)),'Krediten får inte dateras före befintligt ROT-underlag eller beslut.');
  assert(!current||credit.date>=current.events.at(-1).date,'Krediten får inte dateras före senaste ROT-rättelsen.');
  const previousAllowedCents=current?.allowedCents??invoice.rot.approvedCents??invoice.rot.reservedCents;
  const allowedCents=Math.min(previousAllowedCents,rotCreditLimit(state,invoice.id));
  const repaid=current?.repaidCents??invoice.rotRepaymentCents??0;
  const netTax=sum(invoice.payments.filter(item=>item.payer==='tax').map(item=>item.amountCents))-repaid;
  const taxRepaymentCents=Math.max(0,netTax-allowedCents);
  const event={kind:'credit',invoiceId:invoice.id,date:credit.date,settlementId:credit.id,previousAllowedCents,allowedCents,taxRepaymentCents,
    externalReference:text(taxReference,'referens till ROT-rättelsen',150),reason:text(reason,'orsak till ROT-rättelsen'),caseAdjusted:true,
    ...(current?{}:{original:historical})};
  if(taxRepaymentCents) {
    assert(taxRefundConfirmed===true,'Krediten kräver återbetalning till Skatteverket. Bekräfta att betalningen har genomförts.');
    const eventId=nextId(state,'rot-credit-repayment');
    const entry=appendEntry(state,{date:event.date,description:`Återbetalt ROT vid kredit ${credit.number}`,sourceType:'rot-credit-repayment',sourceId:eventId,
      rows:[{account:'1510',debitCents:taxRepaymentCents,creditCents:0},{account:'1930',debitCents:0,creditCents:taxRepaymentCents}]});
    event.repaymentId=eventId;event.entryId=entry.id;event.bankEventId=nextId(state,'bank');event.taxRefundConfirmed=true;
    state.bankTransactions.push({id:event.bankEventId,date:event.date,account:'1930',amountCents:-taxRepaymentCents,description:`ROT-rättelse ${invoice.number}`,matchedEntryId:entry.id});
  }
  appendEvent(state,event);
  addActivity(state,`ROT-underlag rättat efter ${credit.number}; tidigare ansökningar bevarade och ersatta av rättelseflödet.`,invoice.id);
}

function change(state,invoiceId,date,mutation) {
  validateRotCreditEvents(state);
  return transact(state,draft=>{
    requireOpenPeriod(draft,date);const invoice=invoiceFor(draft,invoiceId),current=getRotCreditState(draft,invoiceId);
    assert(current,'Kreditera först fakturan i det granskade ROT-rättelseflödet.');
    assert(date>=current.events.at(-1).date && invoice.payments.every(item=>item.date<=date),'ROT-rättelsen får inte dateras före senaste åtgärd eller betalning.');
    mutation(draft,invoice,current);syncRotCredit(draft,invoiceId);validateRotCreditEvents(draft);
  });
}

export function prepareCorrectedRotRequest(state,invoiceId,{date,workCompletedConfirmed=false,electronicPaymentConfirmed=false,reference=''}) {
  return change(state,invoiceId,date,(draft,invoice,current)=>{
    assert(workCompletedConfirmed===true&&electronicPaymentConfirmed===true,'Bekräfta utfört arbete och elektronisk kundbetalning.');
    assert((current.events[0].original.plans[0]?.participants.length??1)===1,'Efter kredit av flerpersonsfaktura krävs separat personvis rättelse hos Skatteverket; ny automatisk begäran är spärrad.');
    assert(date<=`${invoice.rot.paymentYear+1}-01-31`,'ROT-begäran ska lämnas senast 31 januari efter betalningsåret.');
    const active=current.requests.at(-1);
    if(active) {
      const decision=current.events.find(item=>item.kind==='decision'&&item.requestId===active.id);
      const received=sum(current.events.filter(item=>item.kind==='receipt'&&item.requestId===active.id).map(item=>item.amountCents));
      assert(decision&&received===decision.approvedCents,'Slutför föregående rättelsebegäran och utbetalning först.');
    }
    const customerPaid=sum(invoice.payments.filter(item=>item.payer==='customer').map(item=>item.amountCents))-(invoice.settlementRefundCents??0);
    assert(customerPaid>=current.effectiveGrossCents-current.allowedCents,'Kundens del av det korrigerade fakturabeloppet måste vara betald innan ny ROT-begäran.');
    const requestedCents=current.allowedCents-current.netTaxPaidCents;whole(requestedCents);assert(requestedCents>0,'Det finns inget återstående ROT-belopp att begära.');
    appendEvent(draft,{kind:'request',invoiceId,date,creditVersion:current.creditVersion,requestedCents,reference:text(reference,'unik referens',150),
      entryCount:draft.entries.length,basisPaymentIds:invoice.payments.filter(item=>item.payer==='customer'&&item.date.slice(0,4)===String(invoice.rot.paymentYear)).map(item=>item.id),basisRefundCents:invoice.settlementRefundCents??0,workCompletedConfirmed:true,electronicPaymentConfirmed:true});
    addActivity(draft,'Korrigerad ROT-begäran förberedd; inget skickat.',invoiceId);
  });
}

export function decideCorrectedRotRequest(state,invoiceId,{date,requestId,approvedCents,reference='',reason=''}) {
  return change(state,invoiceId,date,(draft,invoice,current)=>{
    const request=current.requests.find(item=>item.id===requestId);assert(request&&!current.events.some(item=>item.kind==='decision'&&item.requestId===requestId),'Välj en obesvarad rättelsebegäran.');
    whole(approvedCents);assert(approvedCents<=request.requestedCents,'Godkänt ROT överstiger begäran.');
    const deniedCents=request.requestedCents-approvedCents;if(deniedCents)text(reason,'orsak till avslaget');
    appendEvent(draft,{kind:'decision',invoiceId,date,requestId,creditVersion:current.creditVersion,approvedCents,deniedCents,reference:text(reference,'beslutsreferens',150),reason:String(reason).trim()});
    addActivity(draft,'Beslut registrerat för korrigerat ROT-underlag.',invoice.id);
  });
}

export function receiveCorrectedRotPayment(state,invoiceId,{date,requestId,amountCents,reference=''}) {
  return change(state,invoiceId,date,(draft,invoice,current)=>{
    const request=current.requests.find(item=>item.id===requestId),decision=current.events.find(item=>item.kind==='decision'&&item.requestId===requestId);
    assert(request&&decision,'Registrera beslut före ROT-utbetalningen.');cents(amountCents,false);
    const received=sum(current.events.filter(item=>item.kind==='receipt'&&item.requestId===requestId).map(item=>item.amountCents));
    assert(received+amountCents<=decision.approvedCents && current.netTaxPaidCents+amountCents<=current.allowedCents,'ROT-utbetalningen överstiger kvarvarande godkänt belopp.');
    reference=text(reference,'unik betalningsreferens',100);assert(!invoice.payments.some(item=>item.reference===reference),'Betalningsreferensen är redan registrerad.');
    const paymentId=nextId(draft,'customer-payment'),bankEventId=nextId(draft,'bank');
    const entry=appendEntry(draft,{date,description:`Korrigerat ROT ${invoice.number}`,sourceType:'customer-payment',sourceId:paymentId,
      rows:[{account:'1930',debitCents:amountCents,creditCents:0},{account:'1510',debitCents:0,creditCents:amountCents}]});
    invoice.payments.push({id:paymentId,date,amountCents,payer:'tax',entryId:entry.id,reference,bankEventId,rotCreditRequestId:requestId});
    draft.bankTransactions.push({id:bankEventId,date,account:'1930',amountCents,description:`Korrigerat ROT ${invoice.number}`,matchedEntryId:entry.id});
    appendEvent(draft,{kind:'receipt',invoiceId,date,requestId,creditVersion:current.creditVersion,amountCents,paymentId,entryId:entry.id,bankEventId,reference});
    addActivity(draft,'Utbetalning för korrigerad ROT-begäran registrerad.',invoice.id);
  });
}

export function repayCorrectedRot(state,invoiceId,{date,amountCents,reference,reason,paymentConfirmed=false}){
  return change(state,invoiceId,date,(draft,invoice,current)=>{
    assert(paymentConfirmed===true,'Bekräfta att återbetalningen till Skatteverket är genomförd.');
    amountCents=whole(amountCents);assert(amountCents>0&&amountCents<=current.netTaxPaidCents&&amountCents<=current.allowedCents,'Återkravet överstiger mottaget och tillåtet ROT-belopp.');
    assert(current.requests.every(request=>{const decision=current.events.find(item=>item.kind==='decision'&&item.requestId===request.id);return decision&&sum(current.events.filter(item=>item.kind==='receipt'&&item.requestId===request.id).map(item=>item.amountCents))===decision.approvedCents;}),'Slutför pågående rättelsebegäran före återkravet.');
    const id=nextId(draft,'rot-credit-repayment'),bankEventId=nextId(draft,'bank');
    const entry=appendEntry(draft,{date,description:`Återkrav ROT ${invoice.number}`,sourceType:'rot-credit-repayment',sourceId:id,rows:[{account:'1510',debitCents:amountCents,creditCents:0},{account:'1930',debitCents:0,creditCents:amountCents}]});
    draft.bankTransactions.push({id:bankEventId,date,account:'1930',amountCents:-amountCents,description:`Återkrav ROT ${invoice.number}`,matchedEntryId:entry.id});
    appendEvent(draft,{kind:'recovery',invoiceId,date,amountCents,entryId:entry.id,repaymentId:id,bankEventId,reference:text(reference,'återkravsreferens',150),reason:text(reason,'orsak till återkravet'),paymentConfirmed:true});
    addActivity(draft,'ROT-återkrav återbetalt; kundfordran återöppnad utan ny intäkt eller moms.',invoice.id);
  });
}

export function validateRotCreditEvents(state) {
  assert(state.rotCreditEvents===undefined||Array.isArray(state.rotCreditEvents)&&state.rotCreditEvents.length<=20000,'ROT-rättelsehistoriken är ogiltig.');
  const claimedEntryIds=new Set(),ids=new Set(),refs=new Set();let receivableAdjustmentCents=0;
  for(const credit of state.settlements??[])if(credit.kind==='credit'&&credit.side==='customer'&&state.invoices.find(item=>item.id===credit.documentId)?.rot)assert(all(state).filter(event=>event.kind==='credit'&&event.settlementId===credit.id&&event.invoiceId===credit.documentId).length===1,'ROT-krediten saknar unik rättelsehistorik.');
  for(const invoiceId of new Set(all(state).map(item=>item.invoiceId))) {
    const invoice=invoiceFor(state,invoiceId),events=eventsFor(state,invoiceId),first=events[0];
    assert(first.kind==='credit'&&first.original,'ROT-rättelsen saknar ursprungligt underlag.');
    for(const [key,source] of [['plans',state.rotPlans??[]],['claims',state.rotClaims],['applications',state.rotApplications??[]],['repayments',state.rotRepayments??[]]]) {
      for(const original of first.original[key])assert(JSON.stringify(source.find(item=>item.id===original.id))===JSON.stringify(original),'Ett tidigare ROT-ärende har ändrats efter krediteringen.');
    }
    assert(JSON.stringify((state.rotPlans??[]).filter(item=>item.invoiceId===invoiceId))===JSON.stringify(first.original.plans),'Ny gammal ROT-plan har lagts till efter rättelsen.');
    assert(JSON.stringify(state.rotClaims.filter(item=>item.invoiceId===invoiceId))===JSON.stringify(first.original.claims),'Ny gammal ROT-begäran har lagts till efter rättelsen.');
    assert(first.previousAllowedCents===(first.original.rot.approvedCents??first.original.rot.reservedCents),'Ursprungligt ROT-avdrag stämmer inte.');
    const originalPlanIds=new Set(first.original.plans.map(item=>item.id));
    assert(JSON.stringify((state.rotApplications??[]).filter(item=>originalPlanIds.has(item.planId)))===JSON.stringify(first.original.applications),'Ny äldre ROT-delbegäran efter rättelsen.');
    assert(JSON.stringify((state.rotRepayments??[]).filter(item=>item.invoiceId===invoiceId))===JSON.stringify(first.original.repayments),'Nytt äldre ROT-återkrav efter rättelsen.');
    assert(Array.isArray(first.original.paymentIds)&&new Set(first.original.paymentIds).size===first.original.paymentIds.length&&first.original.paymentIds.every(id=>invoice.payments.some(item=>item.id===id)),'Ursprungliga ROT-betalningar saknas.');
    assert([...first.original.plans,...first.original.claims,...first.original.applications,...first.original.repayments].every(item=>item.date<=first.date&&(!item.decisionDate||item.decisionDate<=first.date)&&(!item.decision||item.decision.date<=first.date)),'Krediteringen föregår dess ursprungliga ROT-underlag.');
    const initialCredit=(state.settlements??[]).find(item=>item.id===first.settlementId);
    assert(initialCredit&&JSON.stringify(first.original.paymentIds)===JSON.stringify(invoice.payments.filter(item=>entryIndex(state,item.entryId)<entryIndex(state,initialCredit.entryId)).map(item=>item.id)),'ROT-rättelsens ursprungliga betalningslista stämmer inte.');
    let allowed=first.previousAllowedCents,returned=first.original.rotRepaymentCents,version=0,previousDate=invoice.date;
    const seenCredits=[],requests=new Map(),decisions=new Map(),receipts=new Map(),receiptPayments=new Set();
    for(const event of events) {
      assert(typeof event.id==='string'&&!ids.has(event.id)&&event.snapshot===snapshot(event),'En ROT-rättelse har ändrats eller duplicerats.');ids.add(event.id);
      assert(validDate(event.date)&&fiscalPeriodForDate(state,event.date)&&event.date>=previousDate,'ROT-rättelser måste följa giltig datumordning.');previousDate=event.date;
      if(event.reference){const ref=`${invoiceId}:${event.kind}:${event.reference}`;assert(!refs.has(ref),'ROT-rättelsens referens är återanvänd.');refs.add(ref);}
      if(event.kind==='credit') {
        const credit=(state.settlements??[]).find(item=>item.id===event.settlementId);
        assert(credit?.kind==='credit'&&credit.side==='customer'&&credit.documentId===invoiceId&&credit.date===event.date&&!seenCredits.includes(credit.id),'ROT-rättelsen saknar en unik kreditnota.');seenCredits.push(credit.id);version++;
        const prefix={...state,settlements:(state.settlements??[]).filter(item=>item.side!=='customer'||item.documentId!==invoiceId||item.kind!=='credit'||seenCredits.includes(item.id))};
        assert(event.previousAllowedCents===allowed && event.allowedCents===Math.min(allowed,rotCreditLimit(prefix,invoiceId))&&event.caseAdjusted===true,'ROT-rättelsens avdrag stämmer inte med krediterad arbetskostnad.');
        const creditIndex=entryIndex(state,credit.entryId);
        const taxPaid=sum(invoice.payments.filter(item=>item.payer==='tax'&&entryIndex(state,item.entryId)<creditIndex).map(item=>item.amountCents));
        const repayment=Math.max(0,taxPaid-returned-event.allowedCents);assert(event.taxRepaymentCents===repayment,'ROT-rättelsens återbetalning är fel.');
        text(event.externalReference,'referens till ROT-rättelsen',150);text(event.reason,'orsak till ROT-rättelsen');
        if(repayment) {
          assert(event.taxRefundConfirmed===true,'ROT-återbetalningen saknar bekräftelse.');
          const entry=state.entries.find(item=>item.id===event.entryId),bank=state.bankTransactions.find(item=>item.id===event.bankEventId);
          assert(entry?.sourceType==='rot-credit-repayment'&&entry.sourceId===event.repaymentId&&entry.date===event.date&&JSON.stringify(entry.rows)===JSON.stringify([{account:'1510',debitCents:repayment,creditCents:0},{account:'1930',debitCents:0,creditCents:repayment}]),'ROT-kreditens återbetalningsverifikation är fel.');
          assert(bank?.matchedEntryId===entry.id&&bank.account==='1930'&&bank.date===event.date&&bank.amountCents===-repayment,'ROT-kreditens återbetalning saknar bankhändelse.');claimedEntryIds.add(entry.id);receivableAdjustmentCents+=repayment;
        } else assert(!event.entryId&&!event.bankEventId,'En ROT-rättelse utan återbetalning har oväntad bankbokning.');
        returned+=repayment;allowed=event.allowedCents;
      } else if(event.kind==='recovery') {
        assert([...requests.values()].filter(request=>request.creditVersion===version).every(request=>decisions.has(request.id)&&(receipts.get(request.id)??0)===decisions.get(request.id).approvedCents),'ROT-återkrav ligger före slutförd rättelsebegäran.');
        whole(event.amountCents);const paid=sum(invoice.payments.filter(item=>item.payer==='tax'&&entryIndex(state,item.entryId)<entryIndex(state,event.entryId)).map(item=>item.amountCents));
        assert(event.paymentConfirmed===true&&event.amountCents>0&&event.amountCents<=allowed&&event.amountCents<=paid-returned,'ROT-återkrav saknar verkligt mottaget belopp.');
        text(event.reference,'återkravsreferens',150);text(event.reason,'återkravsorsak');
        const entry=state.entries.find(item=>item.id===event.entryId),bank=state.bankTransactions.find(item=>item.id===event.bankEventId);
        assert(entry?.sourceType==='rot-credit-repayment'&&entry.sourceId===event.repaymentId&&entry.date===event.date&&JSON.stringify(entry.rows)===JSON.stringify([{account:'1510',debitCents:event.amountCents,creditCents:0},{account:'1930',debitCents:0,creditCents:event.amountCents}]),'ROT-återkravets verifikation är fel.');
        assert(bank?.matchedEntryId===entry.id&&bank.date===event.date&&bank.account==='1930'&&bank.amountCents===-event.amountCents,'ROT-återkravet saknar bankhändelse.');
        assert(!claimedEntryIds.has(entry.id),'ROT-återkravets bokning används flera gånger.');claimedEntryIds.add(entry.id);receivableAdjustmentCents+=event.amountCents;returned+=event.amountCents;allowed-=event.amountCents;
      } else if(event.kind==='request') {
        assert(event.creditVersion===version&&event.workCompletedConfirmed===true&&event.electronicPaymentConfirmed===true&&event.date<=`${invoice.rot.paymentYear+1}-01-31`,'Korrigerad ROT-begäran har fel underlag eller period.');
        text(event.reference,'begärans referens',150);assert(Number.isSafeInteger(event.entryCount)&&event.entryCount>0&&event.entryCount<=state.entries.length,'ROT-begärans bokföringsunderlag saknas.');
        whole(event.requestedCents);assert(event.requestedCents>0,'ROT-begäran måste vara positiv.');
        assert((first.original.plans[0]?.participants.length??1)===1,'Flerpersonsrättelse saknar personvis myndighetsunderlag.');
        const previousRequest=[...requests.values()].filter(item=>item.creditVersion===version).at(-1);
        if(previousRequest)assert(decisions.has(previousRequest.id)&&(receipts.get(previousRequest.id)??0)===decisions.get(previousRequest.id).approvedCents,'Tidigare ROT-rättelsebegäran är inte slutförd.');
        const requestTaxPaid=sum(invoice.payments.filter(item=>item.payer==='tax'&&(first.original.paymentIds.includes(item.id)||events.slice(0,events.indexOf(event)).some(e=>e.kind==='receipt'&&e.paymentId===item.id))).map(item=>item.amountCents));
        assert(event.requestedCents===allowed-requestTaxPaid+returned,'ROT-begäran stämmer inte med redan mottaget belopp.');
        const matchingRefunds=(state.settlements??[]).filter(item=>item.kind==='refund'&&item.side==='customer'&&item.documentId===invoiceId&&item.date<=event.date&&entryIndex(state,item.entryId)<event.entryCount);
        assert(event.basisRefundCents===sum(matchingRefunds.map(item=>item.amountCents)),'ROT-begärans återbetalningsunderlag stämmer inte.');
        const basis=event.basisPaymentIds.map(id=>invoice.payments.find(item=>item.id===id));assert(new Set(event.basisPaymentIds).size===basis.length&&basis.every(item=>item?.payer==='customer'&&item.date<=event.date&&item.date.slice(0,4)===String(invoice.rot.paymentYear)),'ROT-begärans betalningsunderlag är fel.');
        const netGross=gross(invoice)-sum((state.settlements??[]).filter(item=>seenCredits.includes(item.id)).map(item=>item.amountCents));
        assert(sum(basis.map(item=>item.amountCents))-event.basisRefundCents>=netGross-allowed,'ROT-begäran saknar betald kundandel.');
        requests.set(event.id,event);
      } else if(event.kind==='decision') {
        text(event.reference,'beslutsreferens',150);
        const request=requests.get(event.requestId);assert(request&&request.creditVersion===version&&event.creditVersion===version&&!decisions.has(request.id),'ROT-beslut saknar aktuell obesvarad begäran.');whole(event.approvedCents);
        assert(event.deniedCents===request.requestedCents-event.approvedCents&&event.deniedCents>=0,'ROT-beslutets belopp är fel.');if(event.deniedCents)text(event.reason,'orsak till avslaget');allowed-=event.deniedCents;assert(allowed>=0,'ROT-beslutet överstiger tillgängligt belopp.');decisions.set(request.id,event);
      } else if(event.kind==='receipt') {
        text(event.reference,'betalningsreferens',100);assert(!receiptPayments.has(event.paymentId),'Samma ROT-betalning är registrerad flera gånger.');receiptPayments.add(event.paymentId);
        const request=requests.get(event.requestId),decision=decisions.get(event.requestId);assert(request?.creditVersion===version&&event.creditVersion===version&&decision,'ROT-utbetalningen saknar aktuellt beslut.');cents(event.amountCents,false);
        const received=(receipts.get(request.id)??0)+event.amountCents;assert(received<=decision.approvedCents,'ROT-utbetalningen överstiger beslutet.');receipts.set(request.id,received);
        const payment=invoice.payments.find(item=>item.id===event.paymentId);assert(payment?.rotCreditRequestId===request.id&&payment.payer==='tax'&&payment.date===event.date&&payment.amountCents===event.amountCents&&payment.entryId===event.entryId&&payment.bankEventId===event.bankEventId&&payment.reference===event.reference,'ROT-rättelsens betalning har ändrats.');
        const entry=state.entries.find(item=>item.id===event.entryId),bank=state.bankTransactions.find(item=>item.id===event.bankEventId);
        assert(entry?.sourceType==='customer-payment'&&entry.sourceId===payment.id&&entry.date===event.date&&JSON.stringify(entry.rows)===JSON.stringify([{account:'1930',debitCents:event.amountCents,creditCents:0},{account:'1510',debitCents:0,creditCents:event.amountCents}]),'ROT-rättelsens inbetalningsverifikation stämmer inte.');
        assert(bank?.matchedEntryId===entry.id&&bank.date===event.date&&bank.account==='1930'&&bank.amountCents===event.amountCents,'ROT-rättelsens bankhändelse stämmer inte.');
      } else assert(false,'Okänd ROT-rättelsehändelse.');
    }
    assert(creditRecords(state,invoiceId).every(item=>seenCredits.includes(item.id)),'En ROT-kredit saknar rättelsehändelse.');
    assert(invoice.rot.approvedCents===allowed&&invoice.rotRepaymentCents===returned&&invoice.rotCreditVersion===version,'ROT-fakturans saldo stämmer inte med rättelsehistoriken.');
    const taxPayments=invoice.payments.filter(item=>item.payer==='tax');
    assert(taxPayments.every(item=>first.original.paymentIds.includes(item.id)||events.some(event=>event.kind==='receipt'&&event.paymentId===item.id)),'ROT-utbetalningen saknar rättelsebegäran.');
    assert(sum(taxPayments.map(item=>item.amountCents))-returned<=allowed,'ROT-belopp som måste återbetalas har inte reglerats.');
    const balance=gross(invoice)-sum(creditRecords(state,invoiceId).map(item=>item.amountCents))-sum(invoice.payments.map(item=>item.amountCents))+returned+(invoice.settlementRefundCents??0);
    assert(invoice.rot.status===(balance===0?'settled':'awaiting-customer'),'ROT-rättelsens status stämmer inte med betalningar och krediter.');
  }
  return {claimedEntryIds,receivableAdjustmentCents};
}
