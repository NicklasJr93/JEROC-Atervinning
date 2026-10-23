import { test, expect, type Page } from '@playwright/test';
const KEY='scrapplanner-bokforing-suite-v2';
const state=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),KEY);
const form=(page:Page,action:string)=>page.locator(`form[data-feature-form="cash"][data-action="${action}"]`).first();
test.use({viewport:{width:1450,height:1050}});
const errors=new WeakMap<Page,string[]>();
test.beforeEach(({page})=>{const list:string[]=[];errors.set(page,list);page.on('pageerror',error=>list.push(error.message));page.on('dialog',dialog=>dialog.accept());});
test.afterEach(({page})=>expect(errors.get(page)).toEqual([]));
async function start(page:Page){
 await page.goto('/bokforing/#cash');
 await expect(page.getByRole('heading',{name:'Kontantmetoden i ett eget övningsbolag'})).toBeVisible();
 const f=form(page,'start-cash');await f.locator('[name="eligibilityConfirmed"]').check();await f.locator('[name="resetConfirmed"]').check();await f.getByRole('button',{name:'Starta kontantmetodsexempel'}).click();
 await expect.poll(async()=> (await state(page))?.company?.method).toBe('cash');
 await expect(page.getByRole('heading',{name:'Fakturor, betalning och årsslut'})).toBeVisible();
}
async function issue(page:Page){
 const f=form(page,'save-document');
 await f.locator('[name="partyName"]').fill('Kund AB');await f.locator('[name="partyAddress"]').fill('Testgatan 1');await f.locator('[name="reference"]').fill('K-001');await f.locator('[name="date"]').fill('2026-10-01');await f.locator('[name="dueDate"]').fill('2026-10-31');
 await f.locator('[name="line-description-0"]').fill('Utfört arbete');await f.locator('[name="line-net-0"]').fill('1000');await f.locator('[name="supplyConfirmed"]').check();await f.locator('[name="partyPostalCode"]').fill('111 22');await f.locator('[name="partyCity"]').fill('Demostaden');await f.locator('[name="performanceConfirmed"]').check();await f.getByRole('button',{name:'Spara utkast'}).click();
 await expect.poll(async()=> (await state(page)).cashDocuments.length).toBe(1);
 await page.getByRole('button',{name:'Utfärda / registrera utan direkt bokföring'}).click();
 await expect.poll(async()=> (await state(page)).cashDocuments[0].status).toBe('issued');
}
async function action(page:Page,kind:string,amount:string,date:string,reference:string){const f=form(page,kind);await f.locator('[name="amount"]').fill(amount);await f.locator('[name="date"]').fill(date);await f.locator('[name="reference"]').fill(reference);if(kind==='credit')await f.locator('[name="reason"]').fill('Prisjustering');await f.locator('button[type="submit"]').click();}

test('cash setup requires explicit reset and issued documents wait for payment before booking',async({page})=>{
 await page.goto('/bokforing/#cash');
 const before=await page.evaluate(key=>localStorage.getItem(key),KEY);
 await form(page,'start-cash').getByRole('button',{name:'Starta kontantmetodsexempel'}).click();
 expect(await page.evaluate(key=>localStorage.getItem(key),KEY)).toBe(before);
 await start(page);await issue(page);expect((await state(page)).entries).toHaveLength(0);
 await action(page,'payment','500','2026-10-05','P-001');await expect.poll(async()=> (await state(page)).entries.length).toBe(1);
 const booked=await state(page);expect(booked.entries[0].rows.find((row:{account:string})=>row.account==='2611').creditCents).toBe(10000);expect(booked.cashDocuments[0].snapshot).toBeTruthy();
 await page.reload();await expect(page.locator('#suite-storage-notice')).toBeHidden();expect((await state(page)).cashEvents).toHaveLength(1);
});
test('paid cash invoice credit waits for refund and preserves the frozen original',async({page})=>{
 await start(page);await issue(page);await action(page,'payment','1250','2026-10-05','P-001');await expect.poll(async()=> (await state(page)).entries.length).toBe(1);const original=(await state(page)).cashDocuments[0].snapshot;
 await action(page,'credit','250','2026-10-06','C-001');await expect.poll(async()=> (await state(page)).cashEvents.length).toBe(2);expect((await state(page)).entries).toHaveLength(1);
 await action(page,'refund','250','2026-10-07','R-001');await expect.poll(async()=> (await state(page)).entries.length).toBe(2);expect((await state(page)).cashDocuments[0].snapshot).toBe(original);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Hämta kreditnota'}).click();expect((await download).suggestedFilename()).toBe('CK-0001.html');
});
test('year-end cash recognition carries a receivable that settles next year without VAT twice',async({page})=>{
 await start(page);await issue(page);const f=form(page,'year-end');await f.locator('[name="reviewed"]').check();await f.getByRole('button',{name:'Bokför återstående belopp per årsslut'}).click();await expect.poll(async()=> (await state(page)).entries.length).toBe(1);
 await page.evaluate(async key=>{
   const financePath='/bokforing/suite/finance.js',yearsPath='/bokforing/suite/financial-years.js';
   const finance=await import(financePath),years=await import(yearsPath);
   let s=JSON.parse(localStorage.getItem(key)!);s=finance.fileVatPeriod(s,{from:'2026-10-01',to:'2026-12-31',date:'2026-12-31'});
   for(let month=1;month<=12;month++)s=finance.lockPeriod(s,`2026-${String(month).padStart(2,'0')}`);
   s=finance.closeYear(s,{date:'2026-12-31',confirmed:true});s=years.openNextYear(s,{confirmed:true});localStorage.setItem(key,JSON.stringify(s));
 },KEY);
 await page.reload();await expect(page.locator('#suite-storage-notice')).toBeHidden();await action(page,'payment','1250','2027-01-05','P-2027');
 await expect.poll(async()=> (await state(page)).cashEvents.length).toBe(2);expect((await state(page)).entries.at(-1).rows.map((r:{account:string})=>r.account)).toEqual(['1510','1930']);
});
test('cash workspace fits a mobile screen and adds invoice rows',async({page})=>{
 await page.setViewportSize({width:390,height:844});await start(page);const f=form(page,'save-document');await f.getByRole('button',{name:'Lägg till rad'}).click();await expect(f.locator('[data-cash-line]')).toHaveCount(3);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('cash outgoing invoice remains a draft until postal details and performance are completed',async({page})=>{
 await start(page);
 let f=form(page,'save-document');
 await f.locator('[name="partyName"]').fill('Fiktiv köpare AB');await f.locator('[name="partyAddress"]').fill('Testvägen 7');await f.locator('[name="reference"]').fill('KRAV-BROWSER');
 await f.locator('[name="date"]').fill('2026-10-01');await f.locator('[name="dueDate"]').fill('2026-10-31');await f.locator('[name="line-description-0"]').fill('Utförd tjänst');await f.locator('[name="line-net-0"]').fill('1000');await f.locator('[name="supplyConfirmed"]').check();
 await f.getByRole('button',{name:'Spara utkast'}).click();await expect.poll(async()=> (await state(page)).cashDocuments.length).toBe(1);
 await page.getByRole('button',{name:'Utfärda / registrera utan direkt bokföring'}).click();await expect(page.locator('#suite-toast')).toContainText('kompletteras');
 expect((await state(page)).cashDocuments[0].status).toBe('draft');expect((await state(page)).entries).toHaveLength(0);
 f=page.locator('form[data-feature-form="cash"][data-action="save-document"]:has(input[name="id"])');
 await f.locator('[name="partyPostalCode"]').fill('111 22');await f.locator('[name="partyCity"]').fill('Demostaden');await f.locator('[name="performanceConfirmed"]').check();
 await f.getByRole('button',{name:'Spara utkast'}).click();await page.getByRole('button',{name:'Utfärda / registrera utan direkt bokföring'}).click();
 await expect.poll(async()=> (await state(page)).cashDocuments[0].status).toBe('issued');
 expect((await state(page)).cashDocuments[0].requirementsVersion).toBe(1);
});
