import {test,expect,type Page} from '@playwright/test';
const key='scrapplanner-bokforing-suite-v2';
test.use({viewport:{width:1440,height:1100}});
async function seed(page:Page,mode:'rot'|'revenue'){
 await page.goto('/bokforing/index.html');
 await page.evaluate(async ({key,mode})=>{
  const core=await import('/bokforing/suite/core.js' as string),sales=await import('/bokforing/suite/sales.js' as string),commercial=await import('/bokforing/suite/commercial.js' as string);
  let s=sales.createCustomer(core.createEmptyState(),{name:'Granskningskund'});
  s=sales.createInvoice(s,{details:{performance:{mode:'invoice-date',confirmed:true}},customerId:s.customers[0].id,date:'2026-10-01',dueDate:'2026-10-31',lines:[{description:'Avtalsarbete',kind:'labor',quantity:1,unitCents:100000,vatRate:25}],...(mode==='rot'?{rot:{personId:'DEMO-A',property:'DEMO 1:1',paymentYear:2026,availableCents:5000000,eligibleConfirmed:true}}:{})});s=sales.issueInvoice(s,s.invoices[0].id);
  if(mode==='revenue'){s=commercial.createRevenueSchedule(s,{invoiceId:s.invoices[0].id,name:'Fyra månader',date:'2026-10-01',startMonth:'2026-10',months:4,amountCents:100000});s=commercial.recognizeRevenueMonth(s,s.revenueSchedules[0].id,{date:'2026-10-02'});}
  localStorage.setItem(key,JSON.stringify(s));
 },{key,mode});
 await page.goto('/bokforing/index.html#settlements');await page.reload();
 await expect(page.getByRole('heading',{name:'Kreditera, återbetala och kvitta'})).toBeVisible();
 await expect(page.locator('#suite-storage-notice')).toBeHidden();
}
async function preview(page:Page){
 const form=page.locator('form[data-action="preview-special-credit"]');
 await form.locator('[name="line-0"]').fill('400,00');await form.locator('[name="date"]').fill('2026-10-15');await form.locator('[name="reference"]').fill('KREDIT-REVIEW');await form.locator('[name="reason"]').fill('Minskat uppdrag');await form.getByRole('button',{name:'Förhandsgranska kredit och följdändringar'}).click();
 await expect(page.getByRole('heading',{name:'Granska kreditens följdändringar'})).toBeVisible();
 expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).settlements??[],key)).toHaveLength(0);
}
test('ROT-credit shows accounting preview and requires explicit review before posting',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await seed(page,'rot');await preview(page);
 const form=page.locator('form[data-action="confirm-special-credit"]');
 await expect(page.locator('.settlement-preview')).toContainText('225,00');await form.locator('[name="specialReviewed"]').check();await form.locator('[name="rotCaseAdjusted"]').check();await form.locator('[name="taxReference"]').fill('SKV-AVSTAMNING');await form.getByRole('button',{name:'Bekräfta och bokför granskad kredit'}).click();
 await expect(form).toHaveCount(0);const state=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),key);expect(state.settlements).toHaveLength(1);expect(state.invoices[0].rot.approvedCents).toBe(22500);
 await page.goto('/bokforing/index.html#tax-v2');await expect(page.getByRole('heading',{name:/ROT efter kredit/})).toBeVisible();await expect(page.locator('form[data-action="prepare-corrected-rot"]')).toBeVisible();await page.reload();await expect(page.locator('#suite-storage-notice')).toBeHidden();expect(errors).toEqual([]);
});
test('revenue-credit preview separates earned and deferred portions and survives restore',async({page})=>{
 await seed(page,'revenue');await preview(page);await expect(page.locator('.settlement-preview')).toContainText('300,00');await expect(page.locator('.settlement-preview')).toContainText('100,00');const form=page.locator('form[data-action="confirm-special-credit"]');await form.locator('[name="specialReviewed"]').check();await form.getByRole('button',{name:'Bekräfta och bokför granskad kredit'}).click();await expect(form).toHaveCount(0);await page.reload();await expect(page.locator('#suite-storage-notice')).toBeHidden();const adjustments=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).settlements[0].revenueAdjustments,key);expect(adjustments[0]).toMatchObject({recognizedCents:10000,deferredCents:30000});
});
