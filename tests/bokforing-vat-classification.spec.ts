import { test, expect, type Page } from '@playwright/test';
const bookKey='scrapplanner-bokforing-suite-v2';
const form=(page:Page)=>page.locator('form[data-feature-form="tax-v2"][data-action="post-tax"]');
const read=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),bookKey);
async function open(page:Page){
  await page.goto('/bokforing/index.html');
  await page.evaluate(async key=>{const path='/bokforing/suite/core.js';const {createEmptyState}=await import(path);localStorage.setItem(key,JSON.stringify(createEmptyState()));},bookKey);
  await page.goto('/bokforing/index.html#tax-v2');await page.reload();
  await expect(page.getByRole('heading',{name:'Moms & ROT',exact:true})).toBeVisible();
}
async function fill(page:Page,rate:string){
 const target=form(page);await target.locator('[name="kind"]').selectOption('domestic-sale');await target.locator('[name="country"]').fill('SE');
 await target.locator('[name="date"]').fill('2026-10-12');await target.locator('[name="reference"]').fill('MOMS-UI');await target.locator('[name="counterparty"]').fill('Fiktiv kund');
 await target.locator('[name="netAmount"]').fill('500');await target.locator('[name="vatRate"]').selectOption(rate);await target.locator('[name="conditionsConfirmed"]').check();
 return target;
}
test('explicit domestic exemption is required, persisted and visible after reload',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await open(page);const target=await fill(page,'0');
 await target.getByRole('button',{name:'Granska och bokför affären'}).click();await expect(page.locator('#suite-toast')).toContainText('momsundantag');
 expect((await read(page)).taxTransactions).toHaveLength(0);await expect(target.locator('[name="reference"]')).toHaveValue('MOMS-UI');
 await target.locator('[name="vatExemptionCode"]').selectOption('education');await target.locator('[name="vatExemptionLegalBasis"]').fill('Utbildningens anordnare och villkor enligt 10 kap. ML är granskade');await target.locator('[name="vatExemptionConfirmed"]').check();
 await target.getByRole('button',{name:'Granska och bokför affären'}).click();await expect.poll(async()=>((await read(page)).taxTransactions??[]).length).toBe(1);
 const record=(await read(page)).taxTransactions[0];expect(record.boxes).toEqual({'42':50000});expect(record.vatExemption.code).toBe('education');
 await page.reload();await expect(page.locator('#suite-main')).toContainText('Undantag från skatteplikt: Utbildning');expect(errors).toEqual([]);
});
test('ordinary VAT remains usable with exemption fields empty on mobile',async({page})=>{
 await page.setViewportSize({width:390,height:844});await open(page);const target=await fill(page,'25');
 await target.getByRole('button',{name:'Granska och bokför affären'}).click();await expect.poll(async()=>((await read(page)).taxTransactions??[]).length).toBe(1);
 const record=(await read(page)).taxTransactions[0];expect(record.boxes).toEqual({'05':50000,'10':12500});expect(record.vatExemption).toBeUndefined();
 const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width+1);
});
