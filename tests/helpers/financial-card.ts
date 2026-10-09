import { randomInt, randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { seedOffice, type OfficeCard, type OfficeCustomer, type OfficeData, type PaymentDetails } from '../../src/office/model';
import { recordPayment } from '../../src/office/customer-model';
import { approveCustomerCard } from './customer-approval';

const headers = {'X-Demo-Actor':'admin','X-Demo-User':'admin'};
export async function readOffice(request: APIRequestContext, actor = 'admin'): Promise<OfficeData> {
  const response=await request.get('/api/application/office',{headers:{'X-Demo-Actor':actor,'X-Demo-User':actor}});
  expect(response.ok(),await response.text()).toBeTruthy();return (await response.json()).data;
}
export async function saveOffice(request: APIRequestContext, base: OfficeData, next: OfficeData) {
  const response=await request.post('/api/application/office',{headers,data:{base,next}});
  expect(response.ok(),await response.text()).toBeTruthy();return (await response.json()).data as OfficeData;
}
/** Test records enter the same shared API as ordinary prepared cards. Financial
 * states are obtained through a real demo review, attest and payment journal. */
export async function createOfficeCard(request:APIRequestContext, options:{customer?:OfficeCustomer;customerId?:string;paymentDetails?:PaymentDetails;rows?:OfficeCard['rows'];date?:string}={}) {
  const seed=seedOffice(),base=await readOffice(request);
  const customer=options.customer ?? (options.customerId ? base.customers.find(c=>c.id===options.customerId)! : {...structuredClone(seed.customers.find(c=>c.id==='customer-erik')!),id:`financial-customer-${randomUUID()}`,customerNumber:`TEST-${randomInt(1e7)}`});
  const cardId=50_000_000+randomInt(9_000_000),card:OfficeCard={...structuredClone(seed.cards.find(c=>c.id===2053)!),id:cardId,sourceId:randomUUID(),customerId:customer.id,customerSnapshot:structuredClone(customer),siteId:'norrtalje',yard:'Norrtälje',date:options.date??'2026-10-09T08:41:00Z',origin:'Testgatan 12, 761 41 Norrtälje',status:'complement',idVerified:false,financialPending:false,paymentDetails:options.paymentDetails??{method:'cash'},payment:options.paymentDetails?.method==='balance'?'Spara på saldo':'Kontant',rows:options.rows??[{articleId:'iron',weight:124,tier:'C',price:1.92}],audit:[]};
  delete card.customerApproval;delete card.approvedBy;delete card.preparedBy;delete card.paidAt;delete card.pricingSnapshotId;delete card.pricingTotal;
  const next=structuredClone(base);if(!next.customers.some(c=>c.id===customer.id))next.customers.push(customer);next.cards.push(card);await saveOffice(request,base,next);
  return {cardId,customer,card};
}
export async function completedOfficeCard(request:APIRequestContext, options:Parameters<typeof createOfficeCard>[1]&{pay?:boolean}={}) {
  const fixture=await createOfficeCard(request,options),approval=await approveCustomerCard(request,fixture.card,{customer:fixture.customer});
  const attest=await request.post(`/api/terminal-demo/approvals/${approval.id}/attest`,{data:{}});expect(attest.ok(),await attest.text()).toBeTruthy();
  let state=await readOffice(request);
  if(options.pay!==false){const admin=state.users.find(u=>u.id==='admin')!,paid=recordPayment(state,fixture.cardId,{user:admin,actualUser:admin},{method:'cash'},`Fixture-${fixture.cardId}`);state=await saveOffice(request,state,paid);}
  const closed=await request.patch(`/api/terminal-demo/terminals/${approval.terminalId}`,{data:{active:false}});expect(closed.ok(),await closed.text()).toBeTruthy();
  return {...fixture,card:state.cards.find(c=>c.id===fixture.cardId)!,approval};
}
