import { expect, test, type Page } from '@playwright/test';
const key='scrapplanner-bokforing-suite-v2';
const read=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),key);
const form=(page:Page)=>page.locator('#invoice-page-form');
const issue=(page:Page)=>page.locator('#suite-main [data-action="issue-invoice"]');
test.use({viewport:{width:1440,height:1050},locale:'sv-SE'});

test('REVIEW2-UI unpaid incomplete draft stays blocked through assistant refresh, reload and a forced click',async({page})=>{
  await page.goto('/bokforing/#sales/new');
  await expect(form(page)).toBeVisible();
  await form(page).getByRole('button',{name:'Spara utkast',exact:true}).click();
  const before=await read(page);
  await expect(issue(page)).toBeDisabled();
  await page.locator('#suite-main').evaluate(()=>window.dispatchEvent(new Event('resize')));
  await page.locator('[data-action="toggle-assistant"]').first().click();
  await expect(issue(page)).toBeDisabled();
  await page.reload();await expect(issue(page)).toBeDisabled();
  // Changing a DOM attribute must not replace the model's bookkeeping checks.
  await issue(page).evaluate(button=>{(button as HTMLButtonElement).disabled=false;});
  await issue(page).click();
  await page.locator('#suite-dialog [name="reviewed"]').check();
  await page.locator('#suite-dialog button[type="submit"]').click();
  await expect(page.locator('#dialog-error')).toContainText('kompletteras');
  expect(await read(page)).toEqual(before);
});

test('REVIEW2-UI copied issued invoice requires a fresh performance review and preserves the original',async({page})=>{
  await page.goto('/bokforing/#sales/new');await expect(form(page)).toBeVisible();
  await form(page).locator('[name="performance.confirmed"]').check();
  await form(page).getByRole('button',{name:'Spara utkast',exact:true}).click();
  await issue(page).click();await page.locator('#suite-dialog [name="reviewed"]').check();await page.locator('#suite-dialog button[type="submit"]').click();
  await expect(page.locator('#suite-dialog')).not.toBeVisible();
  const before=await read(page),original=before.invoices.at(-1);
  await page.locator('#suite-main [data-action="copy-invoice"]').click();
  await expect(form(page)).toBeVisible();await expect(form(page).locator('[name="performance.confirmed"]')).not.toBeChecked();
  await form(page).getByRole('button',{name:'Spara utkast',exact:true}).click();
  await expect(issue(page)).toBeDisabled();
  await page.reload();await expect(issue(page)).toBeDisabled();
  const after=await read(page);
  expect(after.entries).toEqual(before.entries);
  expect(after.invoices.find((item:{id:string})=>item.id===original.id)).toEqual(original);
  expect(after.invoices.at(-1).status).toBe('draft');
  expect(after.invoices.at(-1).details.performance.confirmed).toBe(false);
});
