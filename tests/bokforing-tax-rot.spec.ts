import { expect, test, type Page } from '@playwright/test';

const key = 'scrapplanner-bokforing-suite-v2';
const route = '/bokforing/index.html#tax-v2';
test.setTimeout(45000);
test.use({ viewport: { width: 1480, height: 1050 } });
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({page}) => { const messages:string[]=[];errors.set(page,messages);page.on('pageerror',error=>messages.push(error.message)); });
test.afterEach(({page}) => { expect(errors.get(page)).toEqual([]); });

async function seed(page:Page, withRot = false) {
  await page.goto('/bokforing/index.html');
  await page.evaluate(async({key,withRot})=>{
    const corePath='/bokforing/suite/core.js',salesPath='/bokforing/suite/sales.js';
    const core=await import(corePath),sales=await import(salesPath);
    let state=core.transact(core.createEmptyState(),(draft: {entries:unknown[]})=>core.appendEntry(draft,{date:'2026-01-01',description:'Ingående balans',sourceType:'opening',sourceId:'opening',rows:[{account:'1930',debitCents:100000000,creditCents:0},{account:'2081',debitCents:0,creditCents:100000000}]}));
    if(withRot){
      state=sales.createCustomer(state,{name:'Två testpersoner'});
      state=sales.createInvoice(state,{customerId:state.customers[0].id,date:'2026-10-01',dueDate:'2026-11-01',vatMode:'standard',lines:[{kind:'labor',description:'Arbete',quantity:1,unitCents:3200000,vatRate:25},{kind:'material',description:'Material',quantity:1,unitCents:1920000,vatRate:25}],rot:{personId:'LEGACY-TEST',property:'DEMO 1:1',paymentYear:2026,availableCents:5000000,eligibleConfirmed:true}});
      state=sales.issueInvoice(state,state.invoices[0].id);
      state=sales.receivePayment(state,state.invoices[0].id,{date:'2026-10-10',amountCents:3900000,reference:'DELPAY-1'});
    }
    localStorage.setItem(key,JSON.stringify(state));
  },{key,withRot});
  await page.goto(route);
  await page.reload();
  await expect(page.getByRole('heading',{name:'Moms & ROT',exact:true})).toBeVisible();
  await expect(page.locator('#suite-storage-notice')).toBeHidden();
}
const form=(page:Page,action:string)=>page.locator(`form[data-feature-form="tax-v2"][data-action="${action}"]`);
async function expand(page:Page,action:string){const target=form(page,action);await target.evaluate(element=>{const details=element.closest('details');if(details)(details as HTMLDetailsElement).open=true;});return target;}
async function state(page:Page){return page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),key);}

test('moms: EU-inköp med halv avdragsrätt bokförs, visas i deklarationsfält och återläses',async({page})=>{
  await seed(page);const entry=form(page,'post-tax');
  await entry.locator('[name="date"]').fill('2026-10-05');await entry.locator('[name="reference"]').fill('EU-UI-1');await entry.locator('[name="counterparty"]').fill('Test GmbH');await entry.locator('[name="netAmount"]').fill('1000');await entry.locator('[name="deductiblePercent"]').fill('50');await entry.locator('[name="conditionsConfirmed"]').check();
  await entry.getByRole('button',{name:'Granska och bokför affären'}).click();
  await expect.poll(async()=>(await state(page)).taxTransactions?.length).toBe(1);
  const saved=await state(page);expect(saved.taxTransactions[0].boxes['21']).toBe(100000);expect(saved.taxTransactions[0].boxes['48']).toBe(12500);expect(saved.taxTransactions[0].boxes['30']).toBe(25000);
  await expect(page.getByText('Avstämt',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('heading',{name:'Moms & ROT',exact:true})).toBeVisible();await expect(page.locator('#suite-storage-notice')).toBeHidden();await expect(page.getByText('EU-UI-1',{exact:true})).toBeVisible();
});

test('moms: fel EU-land stoppas och formulärets uppgifter behålls',async({page})=>{
  await seed(page);const entry=form(page,'post-tax');await entry.locator('[name="reference"]').fill('FAIL-EU');await entry.locator('[name="counterparty"]').fill('Test US');await entry.locator('[name="country"]').fill('US');await entry.locator('[name="netAmount"]').fill('1000');await entry.locator('[name="conditionsConfirmed"]').check();await entry.getByRole('button',{name:'Granska och bokför affären'}).click();
  await expect(page.locator('#suite-toast')).toContainText('EU-land');expect((await state(page)).taxTransactions??[]).toHaveLength(0);await expect(entry.locator('[name="reference"]')).toHaveValue('FAIL-EU');
});

test('ROT: två personer, delbegäran, avslag, utbetalning och återkrav sparas i samma fakturakedja',async({page})=>{
  await seed(page,true);const original=(await state(page)).invoices[0].bookingSnapshot;const plan=form(page,'create-rot-plan');await plan.locator('[name="date"]').fill('2026-10-01');
  for(const [index,name,id]of [[0,'Person A','PERSON-A'],[1,'Person B','PERSON-B']] as const){await plan.locator(`[name="name_${index}"]`).fill(name);await plan.locator(`[name="person_${index}"]`).fill(id);await plan.locator(`[name="allocation_${index}"]`).fill('6000');}
  await plan.locator('[name="eligibleConfirmed"]').check();await plan.getByRole('button',{name:'Spara personfördelning'}).click();await expect.poll(async()=>(await state(page)).rotPlans?.length).toBe(1);
  const request=await expand(page,'prepare-rot');await request.locator('[name="date"]').fill('2026-10-11');await request.locator('[name="workCompletedConfirmed"]').check();await request.locator('[name="electronicPaymentConfirmed"]').check();await request.getByRole('button',{name:'Beräkna och spara delbegäran'}).click();
  await expect.poll(async()=>(await state(page)).rotApplications?.length).toBe(1);expect((await state(page)).rotApplications[0].requestedCents).toBe(900000);
  const decision=form(page,'decide-rot');await decision.locator('[name="date"]').fill('2026-10-12');await decision.locator('[name="approved_0"]').fill('4000');await decision.locator('[name="reason"]').fill('Begränsat personutrymme');await decision.getByRole('button',{name:'Spara demobeslut'}).click();
  const receipt=await expand(page,'receive-rot');await receipt.locator('[name="date"]').fill('2026-10-13');await receipt.locator('[name="amount"]').fill('8500');await receipt.locator('[name="reference"]').fill('SKV-UI-1');await receipt.getByRole('button',{name:'Bokför mottagen utbetalning'}).click();await expect.poll(async()=>(await state(page)).invoices[0].payments.length).toBe(2);
  const repayment=await expand(page,'repay-rot');await repayment.locator('[name="date"]').fill('2026-10-14');await repayment.locator('[name="amount"]').fill('1000');await repayment.locator('[name="reference"]').fill('KRAV-UI-1');await repayment.locator('[name="reason"]').fill('Test av återkrav');await repayment.getByRole('button',{name:'Bokför återbetalning'}).click();
  await expect.poll(async()=>(await state(page)).rotRepayments?.length).toBe(1);const saved=await state(page);expect(saved.invoices[0].bookingSnapshot).toBe(original);expect(saved.invoices[0].rotRepaymentCents).toBe(100000);expect(saved.invoices[0].rot.approvedCents).toBe(1050000);
  await page.reload();await expect(page.getByRole('heading',{name:'Moms & ROT',exact:true})).toBeVisible();await expect(page.locator('#suite-storage-notice')).toBeHidden();await expect(page.getByText('Person A · PERSON-A',{exact:false})).toBeVisible();
});

test('momsarbetsyta ryms på mobil och visar formulär och deklarationsunderlag',async({page})=>{
  await page.setViewportSize({width:390,height:844});await seed(page);await expect(form(page,'post-tax')).toBeVisible();const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));expect(width.scroll).toBeLessThanOrEqual(width.width+1);
});
