// Proportional correction of an invoice-wide revenue schedule. Credits apply
// over the original service period; the reviewer explicitly confirms this.
import { assert } from './core.js';
import { calculateLineAmounts } from './rot.js';
const sum=values=>values.reduce((a,b)=>{assert(Number.isSafeInteger(a+b),'Periodiseringens belopp är för stort.');return a+b;},0);
const rounded=(amount,n,d)=>Number((BigInt(amount)*BigInt(n)+BigInt(Math.floor(d/2)))/BigInt(d));
const credits=(state,invoiceId)=>(state.settlements??[]).filter(item=>item.kind==='credit'&&item.side==='customer'&&item.documentId===invoiceId);
const invoiceNet=invoice=>sum(invoice.lines.map(line=>calculateLineAmounts(line,invoice.vatMode,invoice.invoiceDiscountBps??0).netCents));

export function revenuePrincipal(state,plan,beforeEntryId=null) {
  const cutoff=beforeEntryId?state.entries.findIndex(item=>item.id===beforeEntryId):Infinity;
  const adjustments=credits(state,plan.invoiceId).filter(item=>state.entries.findIndex(entry=>entry.id===item.entryId)<cutoff)
    .flatMap(item=>(item.revenueAdjustments??[]).filter(value=>value.planId===plan.id));
  return {principalCents:plan.amountCents-sum(adjustments.map(item=>item.amountCents)),
    creditedCents:sum(adjustments.map(item=>item.amountCents)),
    recognizedCreditCents:sum(adjustments.map(item=>item.recognizedCents)),
    deferredCreditCents:sum(adjustments.map(item=>item.deferredCents))};
}
export function revenueTarget(amount,count,months){return rounded(amount,count,months);}

export function calculateRevenueCreditAdjustments(state,invoiceId,creditNetCents,beforeEntryId=null) {
  const cutoff=beforeEntryId?state.entries.findIndex(item=>item.id===beforeEntryId):Infinity;
  const plans=(state.revenueSchedules??[]).filter(item=>item.invoiceId===invoiceId);
  if(!plans.length)return [];
  const invoice=state.invoices.find(item=>item.id===invoiceId);
  const previous=credits(state,invoiceId);
  const remainingNet=invoiceNet(invoice)-sum(previous.flatMap(item=>item.lines.map(line=>line.netCents)));
  assert(remainingNet>0&&creditNetCents<=remainingNet,'Krediten överstiger kvarvarande intäkt.');
  const remaining=plans.map(plan=>revenuePrincipal(state,plan).principalCents);
  const weights=[...remaining,remainingNet-sum(remaining)];assert(weights.every(value=>value>=0),'Periodiserad intäkt överstiger kvarvarande faktura.');
  const allocations=weights.map(weight=>Number(BigInt(creditNetCents)*BigInt(weight)/BigInt(remainingNet)));
  let left=creditNetCents-sum(allocations);
  const order=weights.map((weight,index)=>({index,remainder:BigInt(creditNetCents)*BigInt(weight)%BigInt(remainingNet)})).sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1);
  for(const item of order)if(left>0&&allocations[item.index]<weights[item.index]){allocations[item.index]++;left--;}
  assert(left===0,'Kreditens periodisering kunde inte fördelas.');
  return plans.map((plan,index)=>{
    const amountCents=allocations[index],current=revenuePrincipal(state,plan);
    const postings=plan.postings.filter(item=>item.entryId?state.entries.findIndex(entry=>entry.id===item.entryId)<cutoff:(item.entryCount??0)<=cutoff);
    const recognized=sum(postings.map(item=>item.amountCents))-current.recognizedCreditCents;
    const desired=revenueTarget(current.principalCents-amountCents,postings.length,plan.months);
    const recognizedCents=recognized-desired,deferredCents=amountCents-recognizedCents;
    assert(recognizedCents>=0&&deferredCents>=0,'Kreditens redovisade/förutbetalda andel är ogiltig.');
    return {planId:plan.id,amountCents,recognizedCents,deferredCents};
  }).filter(item=>item.amountCents>0);
}
