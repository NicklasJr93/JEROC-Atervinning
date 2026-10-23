import { expect, test, type Page } from '@playwright/test';

async function harness(page:Page,prepaid=false){
  await page.goto('/bokforing/suite/payroll-workspace.js');
  await page.setContent('<link rel="stylesheet" href="/bokforing/suite/styles.css"><link rel="stylesheet" href="/bokforing/suite/payroll-workspace.css"><main id="workspace"></main><p role="alert"></p>');
  await page.evaluate(async(prepaid)=>{
    const corePath='/bokforing/suite/core.js',financePath='/bokforing/suite/finance.js',enginePath='/bokforing/suite/payroll-engine.js',viewPath='/bokforing/suite/payroll-workspace.js';
    const {createEmptyState}=await import(corePath),{createEmployee}=await import(financePath),engine=await import(enginePath),view=await import(viewPath);
    let state=createEmployee(createEmptyState(),{name:'Fiktiv liten lön',payType:'monthly',baseCents:prepaid?120000:50000});
    if(prepaid){state=engine.savePayrollProfile(state,{employeeId:state.employees[0].id,date:'2026-01-01',birthYear:1985,taxMode:'table',table:32,column:1,weeklyHoursHundredths:4000,deductionHourlyCents:100,vacationMethod:'same-pay',vacationSupplementBps:43,vacationPercentBps:1200,paidVacationDays:25,agreementNote:'Test',reviewed:true,domesticOrdinary:true,contributionAnnualExpectation:'below-1000',contributionAnnualReference:'Granskad prognos'});state=engine.createPayrollBatch(state,{date:'2026-01-25',people:[{employeeId:state.employees[0].id,scheduledHoursHundredths:16000}]});const id=state.payrollBatches[0].id;state=engine.postPayrollBatch(state,id,{reviewed:true});state=engine.payPayrollBatch(state,id,{date:'2026-01-25'});}
    const render=()=>{document.querySelector('#workspace')!.innerHTML=view.renderWorkspace(state);};
    Object.assign(window,{thresholdState:()=>state});
    document.addEventListener('submit',event=>{const f=event.target as HTMLFormElement;if(!f.matches('[data-feature-form="payroll-v2"]'))return;event.preventDefault();try{state=view.handleAction(state,f.dataset.action,Object.fromEntries(new FormData(f)));render();document.querySelector('[role="alert"]')!.textContent='';}catch(e){document.querySelector('[role="alert"]')!.textContent=(e as Error).message;}});render();
  },prepaid);
}
async function postAndPay(page:Page,date:string){const create=page.locator('form[data-action="create"]');await create.locator('[name="date"]').fill(date);await create.locator('[name^="include:"]').check();await create.getByRole('button',{name:'Beräkna individuella lönebesked'}).click();const post=page.locator('form[data-action="post"]');await post.locator('[name="reviewed"]').check();await post.getByRole('button',{name:'Bokför granskad lön'}).click();await page.locator('form[data-action="pay"]').getByRole('button',{name:'Registrera nettolöneutbetalning'}).click();await expect(page.locator('[role="alert"]')).toBeEmpty();}

test('small payroll UI records below-threshold salary and catches up when1000 is reached',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await harness(page);
  const profile=page.locator('form[data-action="profile"]');await profile.locator('xpath=ancestor::details/summary').click();await profile.locator('[name="birthYear"]').fill('1985');await profile.locator('[name="agreementNote"]').fill('Granskade villkor');await profile.locator('[name="contributionAnnualExpectation"]').selectOption('below-1000');await profile.locator('[name="contributionAnnualReference"]').fill('Tillfälligt uppdrag');await profile.locator('[name="domesticOrdinary"]').check();await profile.locator('[name="reviewed"]').check();await profile.getByRole('button',{name:'Spara granskad löneprofil'}).click();
  await postAndPay(page,'2026-01-25');await postAndPay(page,'2026-02-25');
  const values=await page.evaluate(()=>{const s=(window as any).thresholdState();return s.payrollBatches.map((b:any)=>b.people[0].employerCents);});expect(values).toEqual([0,31420]);await expect(page.getByRole('heading',{name:'Årsgräns och arbetsgivaravgifter'})).toBeVisible();expect(errors).toEqual([]);
});

test('annual review UI rejects exemption above1000 without losing entered reference',async({page})=>{
  await page.setViewportSize({width:390,height:844});await harness(page,true);const review=page.locator('form[data-action="annual-contribution-review"]');await review.locator('xpath=ancestor::details/summary').click();await review.locator('[name="reference"]').fill('Granskat men felaktigt test');await review.locator('[name="finalBelowThreshold"]').check();await review.locator('[name="reviewed"]').check();await review.getByRole('button',{name:'Bokför separat årsavstämning'}).click();await expect(page.locator('[role="alert"]')).toContainText('minst 1 000 kr');await expect(review.locator('[name="reference"]')).toHaveValue('Granskat men felaktigt test');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
