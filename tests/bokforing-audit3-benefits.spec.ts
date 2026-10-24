import { expect, test, type Page } from '@playwright/test';
const storageKey='scrapplanner-bokforing-suite-v2';
const saved=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),storageKey);
async function fixture(page:Page){
  await page.goto('/bokforing/');
  await page.evaluate(async(key)=>{
    const cp='/bokforing/suite/core.js',fp='/bokforing/suite/finance.js',pp='/bokforing/suite/payroll-engine.js';
    const core=await import(cp),finance=await import(fp),payroll=await import(pp);
    let state=finance.createEmployee(core.createEmptyState(),{name:'Fiktiv förmånsperson',payType:'monthly',baseCents:20001});
    state=payroll.savePayrollProfile(state,{employeeId:state.employees[0].id,date:'2026-01-01',birthYear:1985,taxMode:'table',table:32,column:1,weeklyHoursHundredths:4000,deductionHourlyCents:20001,vacationMethod:'same-pay',vacationSupplementBps:43,vacationPercentBps:1200,paidVacationDays:25,agreementNote:'Fiktiva granskade villkor',reviewed:true,domesticOrdinary:true,contributionAnnualExpectation:'below-1000',contributionAnnualReference:'Tillfällig förmån'});
    state=payroll.createPayrollBatch(state,{date:'2026-02-25',people:[{employeeId:state.employees[0].id,scheduledHoursHundredths:16000,unpaidHoursHundredths:100,benefitCents:30007}]});
    localStorage.setItem(key,JSON.stringify(state));
  },storageKey);
  await page.goto('/bokforing/#payroll-v2');await page.reload();
  await expect(page.locator('form[data-action="post"]')).toBeVisible();
}
async function register(page:Page){
  const post=page.locator('form[data-action="post"]');await post.locator('[name="reviewed"]').check();await post.locator('button[type="submit"]').click();
  await expect(page.locator('form[data-action="pay"]')).toBeVisible();
  await expect(page.locator('.payroll-batch')).toContainText('utan verifikation');
  const state=await saved(page);expect(state.entries).toHaveLength(0);expect(state.payrollBatches[0].entryId).toBeNull();return state;
}
test('AUDIT3-UI-001 pure benefit below1000 registers, reports and restores without fake money or journal',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await fixture(page);await register(page);
  await page.locator('form[data-action="pay"] button[type="submit"]').click();
  await expect(page.locator('form[data-action="pay"]')).toHaveCount(0);
  const state=await saved(page);expect(state.payrollBatches[0].status).toBe('paid');expect(state.entries).toHaveLength(0);expect(state.bankTransactions).toHaveLength(0);expect(state.payrollBatches[0].payments).toHaveLength(0);
  const person=await page.evaluate(async(key)=>{const path='/bokforing/suite/payroll-engine.js';return (await import(path)).getPayrollDeclarationPeople(JSON.parse(localStorage.getItem(key)!), '2026-02')[0];},storageKey);
  expect(person.exemptBenefitCents).toBe(30007);expect(person.withholdingCents).toBe(0);
  await page.reload();await expect(page.locator('#suite-storage-notice')).toBeHidden();await expect(page.locator('.payroll-batch')).toContainText('utan verifikation');expect(errors).toEqual([]);
});
test('AUDIT3-UI-002 pure benefit reversal keeps the original and creates no empty reversal journal',async({page})=>{
  await fixture(page);const before=await register(page),snapshot=before.payrollBatches[0].snapshot;
  const form=page.locator('form[data-action="reverse"]');await form.locator('xpath=ancestor::details/summary').click();await form.locator('[name="date"]').fill('2026-02-26');await form.locator('[name="reason"]').fill('Felaktig fiktiv förmån');await form.locator('button[type="submit"]').click();
  await expect(page.locator('form[data-action="reverse"]')).toHaveCount(0);
  const state=await saved(page);expect(state.payrollBatches[0].status).toBe('reversed');expect(state.payrollBatches[0].snapshot).toBe(snapshot);expect(state.payrollBatches[0].reversal.entryId).toBeNull();expect(state.entries).toHaveLength(0);
  await page.reload();await expect(page.locator('#suite-storage-notice')).toBeHidden();await expect(page.locator('.payroll-batch')).toContainText('utan verifikation');
});
